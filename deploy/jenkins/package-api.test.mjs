import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { atomicJson, migrationsHash } from "../macmini/lib.mjs";
import {
  inspectArchiveTree,
  packageApi,
  relocateSelfReferences,
} from "./package-api.mjs";

const SHA = "a".repeat(40);

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "api-package-test-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = join(root, "releases", SHA);
  const folders = [
    "apps/api",
    "packages/contracts",
    "packages/shared-kernel",
    "packages/modules/sandbox",
  ];
  for (const folder of folders) {
    await fs.mkdir(join(source, folder, "dist"), { recursive: true });
    await atomicJson(join(source, folder, "package.json"), {
      name:
        folder === "apps/api"
          ? "@platform/api"
          : `@platform/${folder.split("/").at(-1)}`,
      version: "0.0.1",
      main: "dist/index.js",
      scripts: { prepare: "must-not-run" },
    });
    await fs.writeFile(
      join(source, folder, "dist/index.js"),
      "// compiled fixture\n",
    );
  }
  await fs.writeFile(
    join(source, "apps/api/dist/main.js"),
    "throw new Error('packaging must not start the API');\n",
  );
  await atomicJson(join(source, "package.json"), {
    name: "api-fixture",
    packageManager: "pnpm@9.12.0",
    scripts: { prepare: "must-not-run" },
  });
  await fs.writeFile(
    join(source, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n",
  );
  await fs.writeFile(
    join(source, "pnpm-workspace.yaml"),
    "packages:\n  - apps/*\n  - packages/*\n  - packages/modules/*\n",
  );
  await fs.mkdir(join(source, "drizzle"));
  await fs.writeFile(
    join(source, "drizzle/0001.sql"),
    "CREATE TABLE test(id TEXT);\n",
  );
  await atomicJson(join(source, "openapi.json"), { openapi: "3.0.0" });
  const manifest = {
    sha: SHA,
    builtAt: new Date().toISOString(),
    platform: "darwin",
    arch: "arm64",
    nodeMajor: 22,
    boxliteVersion: "0.9.7",
    schemaHash: await migrationsHash(source),
    dataRoot: join(root, "private-data"),
    databaseUrl: join(root, "private-data/platform.db"),
    boxliteHome: join(root, "private-data/boxlite"),
  };
  await atomicJson(join(source, ".macmini-release.json"), manifest);
  await fs.writeFile(join(source, ".env"), "PRIVATE_FIXTURE=do-not-copy\n");
  await fs.mkdir(join(source, "src"));
  await fs.writeFile(
    join(source, "src/not-a-runtime-file.ts"),
    "// never package source\n",
  );
  return {
    root,
    source,
    manifest,
    output: join(root, "artifacts/api-macos-arm64.tgz"),
  };
}

async function execute(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (errors += chunk));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve(output) : reject(new Error(errors)),
    );
  });
}

function dependencyFixture({ wrongArch = false, outsideLibrary = false } = {}) {
  const probes = [];
  const run = async (command, args, options) => {
    if (command === "/usr/bin/tar") return execute(command, args, options);
    if (command === "/usr/bin/file")
      return wrongArch
        ? "ELF 64-bit ARM aarch64"
        : "Mach-O 64-bit bundle arm64";
    if (command === "/usr/bin/otool" && args[0] === "-D")
      return "fixture.node:\n";
    if (command === "/usr/bin/otool")
      return `fixture.node:\n\t${outsideLibrary ? "/Users/build-only/libsqlite.dylib" : "/usr/lib/libSystem.B.dylib"} (compatibility version 1.0.0)\n`;
    if (args.includes("--version")) return "9.12.0\n";
    if (args.includes("deploy")) {
      assert.equal(args.includes("--prod"), true);
      assert.equal(args.includes("--package-import-method=copy"), true);
      assert.equal(options.env.ACCESS_PASSCODE, undefined);
      const target = args.at(-1);
      const input = JSON.parse(
        await fs.readFile(join(options.cwd, "apps/api/package.json"), "utf8"),
      );
      assert.deepEqual(input.files, ["dist"]);
      assert.deepEqual(input.scripts, {});
      const rootInput = JSON.parse(
        await fs.readFile(join(options.cwd, "package.json"), "utf8"),
      );
      assert.deepEqual(rootInput.scripts, {});
      await fs.mkdir(join(target, "dist"), { recursive: true });
      await fs.copyFile(
        join(options.cwd, "apps/api/dist/main.js"),
        join(target, "dist/main.js"),
      );
      await atomicJson(join(target, "package.json"), { name: "@platform/api" });
      const native = join(target, "node_modules/.pnpm/native");
      await fs.mkdir(native, { recursive: true });
      await fs.writeFile(join(native, "sqlite.node"), "native-fixture");
      await fs.writeFile(join(native, "boxlite.node"), "native-fixture");
      await fs.symlink(".pnpm/native", join(target, "node_modules/native"));
      return "";
    }
    if (args[0] === "-e") {
      probes.push(options.cwd);
      assert.match(options.cwd, /relocated\/agent-platform-api\/application$/);
      assert.match(args[1], /better-sqlite3/);
      assert.match(args[1], /@boxlite-ai\/boxlite/);
      assert.doesNotMatch(args[1], /dist\/main.js/);
      return "native-ok\n";
    }
    assert.fail(`Unexpected build command: ${command}`);
  };
  return { run, probes };
}

test("archive inspection preserves relative pnpm links and rejects escaped, broken or private entries", async (t) => {
  const { root } = await fixture(t);
  const tree = join(root, "tree");
  await fs.mkdir(join(tree, "node_modules/.pnpm/module"), { recursive: true });
  await fs.writeFile(
    join(tree, "node_modules/.pnpm/module/index.js"),
    "module.exports={}\n",
  );
  const link = join(tree, "node_modules/module");
  await fs.symlink(".pnpm/module", link);
  assert.equal((await inspectArchiveTree(tree)).files, 1);
  await fs.rm(link);
  await fs.symlink(root, link);
  await assert.rejects(inspectArchiveTree(tree), /symlink escapes/);
  await fs.rm(link);
  await fs.writeFile(join(tree, "platform.db-wal"), "private fixture");
  await assert.rejects(inspectArchiveTree(tree), /Private state/);
  await fs.rm(join(tree, "platform.db-wal"));
  await fs.writeFile(join(tree, ".env"), "private fixture");
  await assert.rejects(inspectArchiveTree(tree), /Private state/);
});

test("packaging rejects active releases, current symlinks and persistent-data outputs before invoking any build", async (t) => {
  const { root, source, output, manifest } = await fixture(t);
  const run = () =>
    assert.fail("unsafe input cannot run pnpm or native probes");
  await fs.symlink(source, join(root, "current"));
  await assert.rejects(
    packageApi(source, output, SHA, { run }),
    /active release/,
  );
  await assert.rejects(
    packageApi(join(root, "current"), output, SHA, { run }),
    /source symlink/,
  );
  await fs.rm(join(root, "current"));
  await assert.rejects(
    packageApi(source, join(manifest.dataRoot, "archive.tgz"), SHA, { run }),
    /outside persistent data/,
  );
  await assert.rejects(
    packageApi(source, join(source, "archive.tgz"), SHA, { run }),
    /build tree/,
  );
});

test("pnpm9's exact API self-reference is rebound inside the archive while another escaped dependency still fails", async (t) => {
  const { root } = await fixture(t);
  const application = join(root, "bundle/application");
  const workspaceApplication = join(root, "workspace/apps/api");
  await fs.mkdir(workspaceApplication, { recursive: true });
  const scope = join(application, "node_modules/.pnpm/node_modules/@platform");
  await fs.mkdir(scope, { recursive: true });
  await fs.symlink(workspaceApplication, join(scope, "api"));
  await relocateSelfReferences(application, workspaceApplication);
  assert.equal(await fs.realpath(join(scope, "api")), application);
  await inspectArchiveTree(join(root, "bundle"));
  await fs.symlink(root, join(scope, "unrelated"));
  await relocateSelfReferences(application, workspaceApplication);
  await assert.rejects(
    inspectArchiveTree(join(root, "bundle")),
    /symlink escapes/,
  );
});

test("a real tar roundtrip excludes source, private env and data identities and probes its relocated production tree", async (t) => {
  const { root, source, output, manifest } = await fixture(t);
  const { run, probes } = dependencyFixture();
  const result = await packageApi(source, output, SHA, { run });
  assert.equal(result.state, "packaged");
  assert.equal(probes.length, 1);
  assert(result.sizeBytes > 0);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  const extracted = join(root, "check");
  await fs.mkdir(extracted);
  await execute("/usr/bin/tar", ["-xzf", output, "-C", extracted]);
  const bundle = join(extracted, "agent-platform-api");
  const release = JSON.parse(
    await fs.readFile(join(bundle, "release.json"), "utf8"),
  );
  assert.equal(release.sha, SHA);
  assert.equal(release.schemaHash, manifest.schemaHash);
  assert.equal(release.databaseUrl, undefined);
  assert.equal(release.dataRoot, undefined);
  assert.equal(release.boxliteHome, undefined);
  assert.deepEqual(await fs.readdir(join(bundle, "application")), [
    "dist",
    "node_modules",
    "package.json",
  ]);
  const env = await fs.readFile(join(bundle, ".env.example"), "utf8");
  assert.match(env, /^ACCESS_PASSCODE=$/m);
  assert.doesNotMatch(env, /PRIVATE_FIXTURE|do-not-copy/);
  assert.match(
    await fs.readFile(join(bundle, "README.md"), "utf8"),
    /existing installation until its schema changes/,
  );
  assert.match(
    await fs.readFile(join(bundle, "bin/start.mjs"), "utf8"),
    /MIGRATIONS_DIR/,
  );
  await assert.rejects(
    packageApi(source, output, SHA, { run }),
    /overwrite an immutable package/,
  );
});

test("Linux native addons and build-host-only dylib dependencies fail packaging without leaving a publishable tarball", async (t) => {
  const { source, output } = await fixture(t);
  await assert.rejects(
    packageApi(source, output, SHA, dependencyFixture({ wrongArch: true })),
    /not macOS ARM64/,
  );
  await assert.rejects(fs.stat(output), { code: "ENOENT" });
  await assert.rejects(
    packageApi(
      source,
      output,
      SHA,
      dependencyFixture({ outsideLibrary: true }),
    ),
    /build-host library/,
  );
  await assert.rejects(fs.stat(output), { code: "ENOENT" });
});
