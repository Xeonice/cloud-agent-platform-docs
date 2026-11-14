import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const excluded = new Set(["node_modules", "dist", ".git", ".env", ".next"]);

describe(
  "real docs checker contract inputs in an isolated source copy",
  { concurrency: false },
  () => {
    let root;
    before(async () => {
      root = await fs.mkdtemp(join(tmpdir(), "docs-required-contracts-"));
      // Copy public documentation/source inputs, never installed dependencies or
      // runtime data. The checker still runs its real thirteen checks and imports
      // the real deployment pure functions; no checker results are stubbed.
      for (const path of [
        "docs",
        "deploy",
        "scripts",
        "README.md",
        "CHANGELOG.md",
        "CONTRIBUTING.md",
        "IMPLEMENTATION-STATUS.md",
        "api/apps",
        "api/packages",
        "api/openapi.json",
        "api/acceptance",
        "api/scripts",
        "api/README.md",
        "api/images/README.md",
        "api/eslint.config.mjs",
        "web/src",
        "web/openapi.json",
        "web/eslint.config.js",
      ]) {
        await fs.cp(join(source, path), join(root, path), {
          recursive: true,
          filter: (path) => !excluded.has(basename(path)),
        });
      }
    });
    after(async () => {
      if (root) await fs.rm(root, { recursive: true, force: true });
    });

    function run(args = [], ci = "false") {
      const result = spawnSync(
        process.execPath,
        [join(root, "scripts/docs-check.mjs"), ...args],
        {
          cwd: root,
          env: { ...process.env, CI: ci },
          encoding: "utf8",
          timeout: 20_000,
          maxBuffer: 2_000_000,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.signal, null, result.stderr);
      return result;
    }
    async function without(path, check) {
      const original = join(root, path),
        held = join(root, ".held-contract-input");
      await fs.rename(original, held);
      try {
        await check();
      } finally {
        await fs.rename(held, original);
      }
    }
    async function changed(path, transform, check) {
      const file = join(root, path),
        original = await fs.readFile(file, "utf8");
      await fs.writeFile(file, transform(original));
      try {
        await check();
      } finally {
        await fs.writeFile(file, original);
      }
    }

    test("complete input passes locally, under the explicit flag and with CI=true, with thirteen checks", () => {
      for (const [args, ci] of [
        [[], "false"],
        [["--require-contracts"], "false"],
        [["--", "--require-contracts"], "false"],
        [[], "true"],
      ]) {
        const result = run(args, ci);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /13 项检查全绿/);
        assert.doesNotMatch(result.stdout, /⚠ /);
      }
    });

    for (const [path, ids, independentFailures = []] of [
      ["api/openapi.json", ["B1", "B3", "B6"]],
      ["web/openapi.json", ["B3"]],
      ["api/packages/contracts/src/ws-protocol.ts", ["B4"], ["A5"]],
      ["web/src/types/ws-protocol.ts", ["B4"]],
      ["api/packages/contracts/src/sse-protocol.ts", ["B5"], ["A5"]],
      ["web/src/types/sse-protocol.ts", ["B5"]],
      ["api/packages/shared-kernel/src/domain/reserved-env.ts", ["B7"]],
      ["web/src/lib/image/validateEnvVar.ts", ["B7"]],
      ["api/apps/api/src", ["A5", "B2"], ["A1"]],
      ["api/packages/contracts/src", ["A5", "B2"]],
    ]) {
      test(`missing ${path} fails both strict entrances and remains a visible local skip`, async () => {
        await without(path, () => {
          const local = run();
          assert.equal(
            local.status,
            independentFailures.length ? 1 : 0,
            local.stdout + local.stderr,
          );
          // Optional B checks may skip; unrelated real failures still block locally.
          for (const id of independentFailures)
            assert.match(local.stdout, new RegExp(`✗ ${id} `));
          if (!independentFailures.length)
            assert.match(local.stdout, /项 skip/);
          for (const id of ids)
            assert.match(local.stdout, new RegExp(`⚠ ${id} `));
          for (const result of [
            run(["--require-contracts"]),
            run([], "true"),
          ]) {
            assert.equal(result.status, 1, result.stdout + result.stderr);
            assert.match(
              result.stdout,
              new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
            );
            for (const id of ids)
              assert.match(result.stdout, new RegExp(`✗ ${id} `));
            assert.doesNotMatch(result.stdout, /⚠ /);
          }
        });
      });
    }

    test("a misspelled strict flag fails instead of silently running local mode", () => {
      const result = run(["--require-contract"]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /不支持的参数.*--require-contract/);
    });

    test("different OpenAPI bytes and WS/SSE canonicals fail with all inputs present", async () => {
      for (const [path, transform, id] of [
        ["web/openapi.json", (text) => text + "\n", "B3"],
        [
          "web/src/types/ws-protocol.ts",
          (text) =>
            text.replace(/(WS_PROTOCOL_CANONICAL\s*=\s*)/, "$1't07.extra|' + "),
          "B4",
        ],
        [
          "web/src/types/sse-protocol.ts",
          (text) =>
            text.replace(
              /(SSE_PROTOCOL_CANONICAL\s*=\s*)/,
              "$1't07.extra|' + ",
            ),
          "B5",
        ],
      ]) {
        await changed(path, transform, () => {
          const result = run(["--require-contracts"]);
          assert.equal(result.status, 1, result.stdout + result.stderr);
          assert.match(result.stdout, new RegExp(`✗ ${id} `));
        });
      }
    });

    test("SQL primitives stay out of the catalog, while a new returned error code still fails A5", async () => {
      const file = join(root, "api/apps/api/src/docs-check-return-fixture.ts");
      try {
        await fs.writeFile(
          file,
          "export function sqlValue() { return 'NULL'; }\nexport function yes() { return 'TRUE'; }\nexport function no() { return 'FALSE'; }\n",
        );
        const allowed = run(["--require-contracts"]);
        assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
        await fs.appendFile(
          file,
          "export function failure() { return 'T07_NEW_FAILURE'; }\n",
        );
        const rejected = run(["--require-contracts"]);
        assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
        assert.match(rejected.stdout, /✗ A5 /);
        assert.match(rejected.stdout, /源码有、文档表无：T07_NEW_FAILURE/);
      } finally {
        await fs.rm(file, { force: true });
      }
      await changed(
        "docs/shared/10-接口契约与类型共享.md",
        (text) =>
          text.replace(
            "#### ★ 错误码全量表",
            "#### ★ 错误码全量表\n| `NULL` | fixture | 500 | false | false | forbidden SQL primitive |",
          ),
        () => {
          const result = run(["--require-contracts"]);
          assert.equal(result.status, 1, result.stdout + result.stderr);
          assert.match(result.stdout, /码表不能登记SQL原语：NULL/);
        },
      );
    });
  },
);
