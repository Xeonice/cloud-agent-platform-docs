import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { projectCI, projectCiContext } from "./project-ci.mjs";

const commits = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
const linuxSystem = {
  platform: "linux",
  arch: "arm64",
  nodeMajor: 22,
  node: "/usr/local/bin/node",
};
const linuxIdentity = {
  username: "jenkins",
  uid: 1000,
  gid: 1000,
  homedir: "/home/jenkins",
};

async function fixture(t, platform = "linux") {
  const work = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "project-ci-boundary-")),
  );
  t.after(() => fs.rm(work, { recursive: true, force: true }));
  const source = join(work, "source");
  for (const name of ["api", "web", "deploy/jenkins", "deploy/containers"])
    await fs.mkdir(join(source, name), { recursive: true });
  for (const name of [
    "deploy/jenkins/public.test.mjs",
    "deploy/containers/docker.test.mjs",
  ])
    await fs.writeFile(join(source, name), "import 'node:test';");
  const calls = [];
  const options = {
    workspace: work,
    home: join(work, "home"),
    identity:
      platform === "linux"
        ? linuxIdentity
        : {
            username: "_agentplatformci",
            homedir: "/Users/Shared/agent-platform-ci",
          },
    system:
      platform === "linux"
        ? linuxSystem
        : { ...linuxSystem, platform: "darwin", node: process.execPath },
    execute: async (command, args, cwd, env) => {
      calls.push({ command, args, cwd, env });
      if (command === "/usr/bin/git" && args[0] === "rev-parse") {
        const name = relative(source, cwd);
        return commits[name === "api" ? 1 : name === "web" ? 2 : 0];
      }
      return "";
    },
  };
  const invoke = (phase) => projectCI(phase, ...commits, options);
  return { work, source, calls, invoke, options };
}

test("Linux docs executes only the real docs gate, not skipped native deployment tests", async (t) => {
  const f = await fixture(t);
  await f.invoke("docs");
  const commands = f.calls.filter((x) => x.command !== "/usr/bin/git");
  assert.deepEqual(
    commands.map((x) => x.args),
    [["scripts/docs-check.mjs"]],
  );
  assert.equal(commands[0].command, "/usr/local/bin/node");
  assert.equal(
    commands[0].env.PLAYWRIGHT_BROWSERS_PATH,
    "/opt/agent-platform/playwright",
  );
});

test("Linux deployment regression executes every deployment source directory", async (t) => {
  const f = await fixture(t);
  await f.invoke("deployment-tests");
  const command = f.calls.find((x) => x.args[0] === "--test");
  assert.deepEqual(command.args, [
    "--test",
    "deploy/containers/docker.test.mjs",
    "deploy/jenkins/public.test.mjs",
  ]);
  assert.equal(command.command, "/usr/local/bin/node");
  assert.equal(
    projectCiContext("deployment-tests", linuxIdentity, linuxSystem).platform,
    "linux",
  );
});

test("Mac development executes the same current deployment tests and refuses an empty suite", async (t) => {
  const f = await fixture(t, "darwin");
  await f.invoke("deployment-tests");
  const command = f.calls.find((x) => x.args[0] === "--test");
  assert.deepEqual(command.args, [
    "--test",
    "deploy/containers/docker.test.mjs",
    "deploy/jenkins/public.test.mjs",
  ]);
  assert.equal(command.command, process.execPath);
  assert.equal(command.env.PLAYWRIGHT_BROWSERS_PATH, undefined);
  for (const directory of ["jenkins", "containers"])
    await fs.rm(join(f.source, "deploy", directory), { recursive: true });
  await assert.rejects(f.invoke("deployment-tests"), /sources are missing/);
});

test("Linux installation preserves locked installs for each repository and fixed Chromium", async (t) => {
  const f = await fixture(t);
  await f.invoke("install");
  const calls = f.calls.filter((x) => x.args.includes("pnpm"));
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.slice(0, 3).map((x) => relative(f.source, x.cwd)),
    ["api", "web", "e2e-contract"],
  );
  for (const call of calls.slice(0, 3)) {
    assert.equal(call.args.includes("--frozen-lockfile"), true);
    assert.equal(
      call.args[0],
      "/usr/local/lib/node_modules/corepack/dist/corepack.js",
    );
  }
  const verification = f.calls.find((x) => x.args[0] === "--input-type=module");
  assert.equal(verification.cwd, join(f.source, "e2e-contract"));
  assert.match(verification.args[2], /chromium\.executablePath\(\)/);
  assert.equal(
    f.calls.some((x) => x.args.includes("chromium")),
    false,
  );
});

test("Mac retains its writable per-account browser installation", async (t) => {
  const f = await fixture(t, "darwin");
  await f.invoke("install");
  assert.equal(
    f.calls.some(
      (x) => x.args.slice(-4).join(" ") === "exec playwright install chromium",
    ),
    true,
  );
  assert.equal(
    f.calls.some((x) => x.args[0] === "--input-type=module"),
    false,
  );
});

test("a moved pinned checkout blocks Linux docs before running repository code", async (t) => {
  const f = await fixture(t);
  const previous = f.options.execute;
  f.options.execute = (command, args, cwd, env) =>
    command === "/usr/bin/git" && args[0] === "rev-parse"
      ? Promise.resolve("d".repeat(40))
      : previous(command, args, cwd, env);
  await assert.rejects(f.invoke("docs"), /Pinned repository changed/);
  assert.equal(
    f.calls.some((x) => x.args.includes("scripts/docs-check.mjs")),
    false,
  );
});
