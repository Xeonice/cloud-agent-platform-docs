import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LINUX_CI,
  ciContext,
  ciChildEnvironment,
  assertBuildSystem,
  browserVerificationScript,
} from "./ci-platform.mjs";
import { agentArguments, AGENT_SECRET_FILE } from "./ci-agent-entrypoint.mjs";

const linux = (arch = "arm64") => ({
  platform: "linux",
  arch,
  nodeMajor: 22,
  node: LINUX_CI.node,
});
const account = () => ({
  username: "jenkins",
  uid: 1000,
  gid: 1000,
  homedir: "/home/jenkins",
});
const connection = () => ({
  JENKINS_URL: "http://controller:8080",
  JENKINS_AGENT_NAME: "linux-ci",
  JENKINS_AGENT_SECRET_FILE: AGENT_SECRET_FILE,
});

test("fixed Linux ARM64 and AMD64 agents retain one isolated identity and separate caches", () => {
  for (const arch of ["arm64", "x64"]) {
    const context = ciContext(account(), linux(arch));
    assert.equal(context.arch, arch);
    assert.equal(context.home, LINUX_CI.home);
    assert.equal(context.cli, LINUX_CI.cli);
    assert.equal(context.browsers, LINUX_CI.browsers);
  }
  for (const patch of [
    { uid: 0 },
    { gid: 0 },
    { username: "root" },
    { homedir: "/var/jenkins_home" },
    { homedir: "/Users/douglasdong" },
  ])
    assert.throws(
      () => ciContext({ ...account(), ...patch }, linux()),
      /Isolated CI/,
    );
  for (const patch of [
    { nodeMajor: 26 },
    { node: "/mounted/mac/node" },
    { arch: "ia32" },
    { platform: "win32" },
  ])
    assert.throws(() => assertBuildSystem({ ...linux(), ...patch }));
});

test("legacy isolated Mac CI remains accepted while the production owner cannot become CI", () => {
  const system = {
    platform: "darwin",
    arch: "arm64",
    nodeMajor: 22,
    node: "/native/node",
  };
  assert.equal(
    ciContext(
      {
        username: "_agentplatformci",
        homedir: "/Users/Shared/agent-platform-ci",
      },
      system,
    ).browsers,
    null,
  );
  assert.throws(() =>
    ciContext(
      { username: "douglasdong", homedir: "/Users/douglasdong" },
      system,
    ),
  );
});

test("Linux children receive fixed Chromium/cache paths without secret or loader environment inheritance", () => {
  const context = ciContext(account(), linux());
  const env = ciChildEnvironment(LINUX_CI.node, context);
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, LINUX_CI.browsers);
  assert.equal(env.HOME, "/home/jenkins");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.npm_config_store_dir, "/home/jenkins/pnpm-store");
  assert.equal(env.COREPACK_HOME, "/opt/agent-platform/corepack");
  assert.equal(env.COREPACK_DEFAULT_TO_LATEST, "0");
  for (const key of [
    "ACCESS_PASSCODE",
    "PASSCODE_COOKIE_SECRET",
    "VERCEL_TOKEN",
    "GH_TOKEN",
    "JENKINS_AGENT_SECRET_FILE",
    "JENKINS_SECRET",
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "JAVA_TOOL_OPTIONS",
    "JENKINS_HOME",
  ])
    assert.equal(Object.hasOwn(env, key), false);
});

test("agent uses the Remoting secret-file argument and fixed names without embedding the secret", () => {
  const args = agentArguments(connection());
  assert.equal(args[args.indexOf("-secret") + 1], "@" + AGENT_SECRET_FILE);
  assert.equal(args.includes("-webSocket"), true);
  assert.equal(args[args.indexOf("-workDir") + 1], "/home/jenkins/agent");
  assert.equal(
    agentArguments({
      ...connection(),
      JENKINS_AGENT_NAME: "linux-web-amd64",
    }).includes("linux-web-amd64"),
    true,
  );
  for (const patch of [
    { JENKINS_URL: "http://user:password@controller:8080" },
    { JENKINS_URL: "http://controller:8080/?token=private" },
    { JENKINS_URL: "file:///private/runtime.env" },
    { JENKINS_AGENT_NAME: "mac-deploy" },
    { JENKINS_AGENT_SECRET_FILE: "/private/runtime.env" },
    { JENKINS_SECRET: "never-inherit-this-secret" },
    { JAVA_TOOL_OPTIONS: "-javaagent:/untrusted.jar" },
  ])
    assert.throws(() => agentArguments({ ...connection(), ...patch }));
});

test("immutable browser verification uses each project's direct dependency and refuses missing, escaped or incompatible revisions", async (t) => {
  const work = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "ci-browser-cache-")),
  );
  t.after(() => fs.rm(work, { recursive: true, force: true }));
  const cache = join(work, "cache");
  const executable = join(cache, "chromium-1234", "chrome");
  await fs.mkdir(join(cache, "chromium-1234"), { recursive: true });
  await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  for (const name of ["playwright", "@playwright/test"]) {
    const project = join(work, name === "playwright" ? "web" : "contract");
    const pkg = join(project, "node_modules", name);
    await fs.mkdir(pkg, { recursive: true });
    const writeModule = async (version, path = executable) => {
      await fs.writeFile(
        join(pkg, "package.json"),
        JSON.stringify({ name, version, main: "index.cjs" }),
      );
      await fs.writeFile(
        join(pkg, "index.cjs"),
        "exports.chromium={executablePath:()=>" + JSON.stringify(path) + "};",
      );
    };
    const run = () =>
      spawnSync(
        process.execPath,
        ["--input-type=module", "-e", browserVerificationScript(cache)],
        { cwd: project, encoding: "utf8" },
      );
    await writeModule("1.62.1");
    assert.equal(run().status, 0, name + " direct dependency must work");
    await writeModule("1.61.0");
    assert.match(run().stderr, /match the pinned CI image/);
    const outside = join(work, "outside-chrome");
    await fs.writeFile(outside, "#!/bin/sh\n", { mode: 0o755 });
    await writeModule("1.62.1", outside);
    assert.match(run().stderr, /fixed image cache/);
    await writeModule("1.62.1", join(cache, "chromium-9999", "chrome"));
    assert.notEqual(
      run().status,
      0,
      "an absent project browser revision must fail",
    );
    await writeModule("1.62.1");
    await fs.chmod(executable, 0o644);
    assert.notEqual(run().status, 0, "a nonexecutable browser must fail");
    await fs.chmod(executable, 0o755);
  }
});
