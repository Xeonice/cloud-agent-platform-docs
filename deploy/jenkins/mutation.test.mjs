import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  mutableFiles,
  mutationRequest,
  mutationForCheckout,
  mutationRun,
  mutationEnvironment,
} from "./mutation.mjs";
import { REPOSITORY } from "./jenkins-ci.mjs";

const exec = promisify(execFile);
const ref = "refs/heads/feat/design-v2-migration";
const baseRef = "refs/heads/base";

test("mutation uses the isolated ARM64 Linux CI account and clean fixed tools/cache environment without deployment credentials", () => {
  const identity = {
    username: "jenkins",
    uid: 1000,
    gid: 1000,
    homedir: "/home/jenkins",
  };
  const system = {
    platform: "linux",
    arch: "arm64",
    nodeMajor: 22,
    node: "/usr/local/bin/node",
  };
  const previous = { ...process.env };
  process.env.HOME = "/srv/agent-platform/deploy";
  process.env.GH_TOKEN = "private-test-value";
  process.env.ACCESS_PASSCODE = "private-test-value";
  process.env.NODE_OPTIONS = "--require=/untrusted.js";
  try {
    const { home, env } = mutationEnvironment(identity, system);
    assert.equal(home, "/home/jenkins");
    assert.equal(env.TMPDIR, "/home/jenkins/tmp");
    assert.equal(env.npm_config_store_dir, "/home/jenkins/pnpm-store");
    assert.equal(env.COREPACK_HOME, "/opt/agent-platform/corepack");
    assert.equal(env.COREPACK_DEFAULT_TO_LATEST, "0");
    assert.equal(env.LANG, "C.UTF-8");
    for (const name of [
      "GH_TOKEN",
      "ACCESS_PASSCODE",
      "NODE_OPTIONS",
      "DOCKER_HOST",
    ])
      assert.equal(env[name], undefined);
    assert.throws(
      () => mutationEnvironment({ ...identity, uid: 0 }, system),
      /Isolated CI/,
    );
    assert.throws(
      () =>
        mutationEnvironment(
          { ...identity, homedir: "/srv/agent-platform/deploy" },
          system,
        ),
      /Isolated CI/,
    );
    assert.throws(
      () => mutationEnvironment(identity, { ...system, arch: "x64" }),
      /ARM64/,
    );
    assert.throws(
      () => mutationEnvironment(identity, { ...system, node: "/tmp/node" }),
      /fixed Node/,
    );
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
async function fixture(t, sourceChanged = true) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "mutation-test-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = join(root, "remote");
  const source = join(root, "source");
  await fs.mkdir(remote);
  const git = async (args, cwd = remote) =>
    (
      await exec("/usr/bin/git", args, {
        cwd,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      })
    ).stdout.trim();
  await git(["init", "--initial-branch=base"]);
  await git(["config", "user.name", "fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await fs.mkdir(join(remote, "packages/modules/automation/src"), {
    recursive: true,
  });
  await fs.writeFile(
    join(remote, "packages/modules/automation/src/rule.ts"),
    "export const count = 1;\n",
  );
  await fs.writeFile(join(remote, "README.md"), "base\n");
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
  const baseSha = await git(["rev-parse", "HEAD"]);
  await git(["switch", "-c", "feat/design-v2-migration"]);
  await fs.writeFile(join(remote, "README.md"), "changed documentation\n");
  if (sourceChanged) {
    await fs.writeFile(
      join(remote, "packages/modules/automation/src/rule.ts"),
      "export const count = 2;\n",
    );
    await fs.writeFile(
      join(remote, "packages/modules/automation/src/automation.module.ts"),
      "// assembly\n",
    );
    await fs.writeFile(
      join(remote, "packages/modules/automation/src/index.ts"),
      "// export\n",
    );
  }
  await git(["add", "."]);
  await git(["commit", "-m", "head"]);
  const sha = await git(["rev-parse", "HEAD"]);
  await git(["clone", "--quiet", remote, source], root);
  return { root, source, remote, sha, baseSha, git };
}

test("mutation request pins source/base and excludes assembly/generated/path-injection inputs", () => {
  assert.throws(
    () => mutationRequest("a".repeat(40), "refs/pull/2/head", "changed"),
    /base/,
  );
  assert.throws(
    () =>
      mutationRequest(
        "a".repeat(40),
        ref,
        "changed",
        "b".repeat(40),
        "refs/pull/3/head",
      ),
    /base/,
  );
  assert.deepEqual(
    mutableFiles([
      "packages/modules/automation/src/rule.ts",
      "packages/modules/automation/src/rule.ts",
      "apps/api/src/main.ts",
      "packages/modules/automation/src/a.module.ts",
      "packages/modules/automation/src/index.ts",
      "packages/modules/automation/src/x.d.ts",
      "packages/modules/automation/src/../rule.ts",
      "packages/modules/automation/src/a,b.ts",
      "README.md",
    ]),
    ["packages/modules/automation/src/rule.ts"],
  );
});

test("changed mutation uses real merge-base/diff and the fixed repository; report records only mutable changes", async (t) => {
  const f = await fixture(t);
  const calls = [];
  const files = ["packages/modules/automation/src/rule.ts"];
  const label =
    "changed-" +
    createHash("sha1").update(files.join("\n")).digest("hex").slice(0, 8);
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "/usr/bin/git") {
      if (args[0] === "fetch") {
        assert.equal(args[1], REPOSITORY);
        return f.git(["fetch", f.remote, ...args.slice(2)], f.source);
      }
      return (await exec(command, args, { cwd: options.cwd })).stdout.trim();
    }
    assert.equal(args[2], "test:mutation");
    assert.equal(options.env.STRYKER_MUTATE_FILES, files[0]);
    assert.equal(options.env.STRYKER_CONCURRENCY, "2");
    await fs.writeFile(
      join(f.source, "reports/mutation", label + ".json"),
      JSON.stringify({ files: { [files[0]]: { mutants: [] } } }),
    );
    return "";
  };
  const result = await mutationForCheckout(
    { sha: f.sha, ref, mode: "changed", baseSha: f.baseSha, baseRef },
    f.source,
    f.root,
    { CI: "true" },
    run,
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.changedFiles, files);
  assert.equal(result.sha, f.sha);
  assert.equal(result.baseSha, f.baseSha);
  assert.equal(result.report, "source/reports/mutation/" + label + ".json");
  assert.equal(
    (await fs.stat(join(f.root, "mutation-result.json"))).mode & 0o777,
    0o600,
  );
  assert.equal(
    calls.filter((call) => call.command === process.execPath).length,
    1,
  );
});

test("documentation-only changed mode skips Stryker and never reuses a stale report", async (t) => {
  const f = await fixture(t, false);
  const runner = async (command, args, options) => {
    assert.equal(command, "/usr/bin/git");
    return (
      await exec(
        command,
        args[0] === "fetch" ? ["fetch", f.remote, ...args.slice(2)] : args,
        { cwd: options.cwd },
      )
    ).stdout.trim();
  };
  const result = await mutationForCheckout(
    { sha: f.sha, ref, mode: "changed", baseSha: f.baseSha, baseRef },
    f.source,
    f.root,
    {},
    runner,
  );
  assert.equal(result.status, "no-source-changes");
  assert.equal(result.report, null);
});

test("failed/no-related-tests run is nonblocking but cannot publish an old success report; wrong SHA fails before Stryker", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(join(f.source, "reports/mutation"), { recursive: true });
  const report = join(f.source, "reports/mutation/full.json");
  for (const classification of ["no-unit-tests", "failed"]) {
    await fs.writeFile(report, '{"files": {"old":{}}}');
    const runner = async (command, args, options) => {
      if (command === "/usr/bin/git")
        return (await exec(command, args, { cwd: options.cwd })).stdout.trim();
      throw Object.assign(new Error("fixture Stryker failure"), {
        classification,
      });
    };
    const result = await mutationForCheckout(
      { sha: f.sha, ref, mode: "full" },
      f.source,
      f.root,
      {},
      runner,
    );
    assert.equal(result.status, classification);
    assert.equal(result.nonblocking, true);
    assert.equal(result.report, null);
    await assert.rejects(fs.access(report));
  }
  await assert.rejects(
    mutationForCheckout(
      { sha: "a".repeat(40), ref, mode: "full" },
      f.source,
      f.root,
      {},
      async (command, args, options) =>
        (await exec(command, args, { cwd: options.cwd })).stdout.trim(),
    ),
    /differs/,
  );
  await assert.rejects(
    mutationRun("invalid-SHA", ref, "full"),
    /Invalid pinned mutation request/,
  );
});
