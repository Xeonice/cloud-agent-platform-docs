import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import {
  BRANCH,
  CI_CHECKS,
  JENKINS_JOB,
  REPOSITORY,
  SERVICE_CONTROL_HELPER,
  activateRelease,
  attestArtifact,
  atomicJson,
  assertNoLiveApi,
  buildArtifactPath,
  buildEnvironment,
  canRollback,
  createMaintenanceBarrier,
  migrationsHash,
  jenkinsInvocation,
  jenkinsReceiptPath,
  privateFile,
  readyManifest,
  readJenkinsReceipt,
  recoverMaintenanceBarrier,
  releaseMaintenanceBarrier,
  runCycle,
  runJenkinsBuild,
  runtimeEnvironment,
  trustedRun,
  validateConfig,
  verifiedArtifact,
  writeJenkinsReceipt,
  withLock,
} from "./lib.mjs";
import { runNativeChecks, serviceCommand } from "./controller.mjs";
import {
  ACCOUNTS,
  DEPLOY_ROOT,
  SECRET_HANDOFFS,
  assertNativeServiceIdentity,
  serviceControlScript,
  servicePlist,
  serviceSudoers,
  validateExtraPlist,
  validateSecretHandoffs,
} from "./system-services.mjs";

const HEAD = "a".repeat(40);
const PREVIOUS = "b".repeat(40);
const NEW_HEAD = "c".repeat(40);
const nativeRuntimeOnly =
  process.platform === "darwin" &&
  process.arch === "arm64" &&
  process.versions.node.split(".")[0] === "22"
    ? false
    : "runtime-wrapper fixture requires macOS ARM64 and Node 22";
const identity = {
  schemaHash: "unchanged-migration-hash",
  dataRoot: "/service/data",
  databaseUrl: "/service/data/platform.db",
  boxliteHome: "/service/boxlite",
  boxliteVersion: "0.9.7",
};
function config(overrides = {}) {
  return {
    repository: REPOSITORY,
    branch: BRANCH,
    ciProvider: "jenkins",
    jenkinsJob: JENKINS_JOB,
    launchdDomain: `gui/${process.getuid()}`,
    root: "/service",
    node: process.execPath,
    corepack: "/service/tools/corepack.cjs",
    runtimeEnvFile: "/service/runtime.env",
    runtimePlist: "/service/runtime.plist",
    uid: process.getuid(),
    deployEnabled: true,
    channelStartedAt: "2026-10-05T00:00:00Z",
    minimumCommit: null,
    ...overrides,
  };
}
function greenRun(overrides = {}) {
  return {
    version: 1,
    provider: "jenkins",
    buildNumber: 17,
    sha: HEAD,
    branch: BRANCH,
    job: JENKINS_JOB,
    repository: REPOSITORY,
    result: "success",
    channelStartedAt: "2026-10-05T00:00:00Z",
    completedAt: "2026-10-06T00:00:00Z",
    ...overrides,
  };
}
function runtimeText(overrides = {}) {
  const values = {
    HOST: "127.0.0.1",
    PORT: "3101",
    DATA_ROOT: "/service/data",
    DATABASE_URL: "/service/data/platform.db",
    BOXLITE_HOME: "/service/boxlite",
    API_ALLOWED_ORIGINS:
      "https://agent.douglasdong.com,https://agent-api.douglasdong.com",
    API_TRUST_PROXY: "cloudflare-loopback",
    ACCESS_PASSCODE: "fixture-passcode",
    PASSCODE_COOKIE_SECRET: "fixture-cookie-secret",
    ACCESS_PASSCODE_ALLOW_LOOPBACK: "false",
    PASSCODE_COOKIE_SECURE: "true",
    DEPLOYMENT_DRAIN_FILE: "/service/maintenance",
    ...overrides,
  };
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}
function cycle(overrides = {}) {
  const calls = [];
  const previous = { sha: PREVIOUS, ...identity };
  const candidate = { sha: HEAD, ...identity };
  const operations = {
    request: jenkinsInvocation(config(), "deploy", HEAD, "17"),
    head: async () => {
      calls.push("head");
      return HEAD;
    },
    current: async () => {
      calls.push("current");
      return previous;
    },
    healthy: async () => {
      calls.push("healthy");
      return true;
    },
    descendsFrom: async () => {
      calls.push("descendsFrom");
      return true;
    },
    ci: async (sha) => {
      calls.push("ci");
      assert.equal(sha, HEAD);
      return greenRun();
    },
    build: async (sha) => {
      calls.push("build");
      assert.equal(sha, HEAD);
      return candidate;
    },
    idle: async (draining = false) => {
      calls.push(draining ? "idle-draining" : "idle");
      return true;
    },
    drain: async () => {
      calls.push("drain");
    },
    activate: async (built, old) => {
      calls.push("activate");
      assert.equal(built, candidate);
      assert.equal(old, previous);
    },
    resume: async () => {
      calls.push("resume");
    },
    ...overrides,
  };
  return { calls, operations, previous, candidate };
}
async function temporary(t) {
  const folder = await fs.mkdtemp(join(tmpdir(), "agent-deploy-test-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  return folder;
}

test("manual and legacy maintenance files are preserved without readiness or approval calls", async (t) => {
  const path = join(await temporary(t), "maintenance");
  for (const contents of ["operator maintenance\n", "deployment\n"]) {
    await fs.writeFile(path, contents, { mode: 0o600 });
    const result = await recoverMaintenanceBarrier(path, {
      deployEnabled: true,
      stillApproved: async () => assert.fail("manual barrier is not ours"),
      isReady: async () => assert.fail("manual barrier is not ours"),
    });
    assert.deepEqual(result, { state: "manual-maintenance" });
    assert.equal(await fs.readFile(path, "utf8"), contents);
  }
});

test("disabled deployment preserves its existing controller barrier even when the API could be ready", async (t) => {
  const path = join(await temporary(t), "maintenance");
  const held = await createMaintenanceBarrier(path);
  const result = await recoverMaintenanceBarrier(path, {
    deployEnabled: false,
    stillApproved: async () => assert.fail("disabled channel cannot approve"),
    isReady: async () => assert.fail("disabled channel cannot recover"),
  });
  assert.deepEqual(result, { state: "maintenance-preserved" });
  assert.equal(await fs.readFile(path, "utf8"), held.contents);
});

test("enabled recovery removes only a controller barrier after readiness and renewed approval", async (t) => {
  const path = join(await temporary(t), "maintenance");
  await createMaintenanceBarrier(path);
  const calls = [];
  const result = await recoverMaintenanceBarrier(path, {
    deployEnabled: true,
    stillApproved: async () => {
      calls.push("approved");
      return true;
    },
    isReady: async () => {
      calls.push("ready");
      return true;
    },
  });
  assert.deepEqual(result, { state: "maintenance-recovered" });
  assert.deepEqual(calls, ["approved", "ready", "approved"]);
  await assert.rejects(fs.stat(path), { code: "ENOENT" });
});

test("an unready API keeps its controller maintenance barrier for operator recovery", async (t) => {
  const path = join(await temporary(t), "maintenance");
  const held = await createMaintenanceBarrier(path);
  await assert.rejects(
    recoverMaintenanceBarrier(path, {
      deployEnabled: true,
      stillApproved: async () => true,
      isReady: async () => false,
    }),
    /Interrupted deployment needs operator recovery/,
  );
  assert.equal(await fs.readFile(path, "utf8"), held.contents);
});

test("withdrawing approval during readiness preserves the real controller barrier", async (t) => {
  const path = join(await temporary(t), "maintenance");
  const held = await createMaintenanceBarrier(path);
  let enabled = true;
  const result = await recoverMaintenanceBarrier(path, {
    deployEnabled: true,
    stillApproved: async () => enabled,
    isReady: async () => {
      enabled = false;
      return true;
    },
  });
  assert.deepEqual(result, { state: "maintenance-preserved" });
  assert.equal(await fs.readFile(path, "utf8"), held.contents);
});

test("resume preserves an operator's in-place rewrite of the barrier", async (t) => {
  const path = join(await temporary(t), "maintenance");
  const held = await createMaintenanceBarrier(path);
  const contents = "operator needs the API to remain in maintenance\n";
  await fs.writeFile(path, contents);
  assert.equal(await releaseMaintenanceBarrier(path, held), false);
  assert.equal(await fs.readFile(path, "utf8"), contents);
});

test("resume preserves a replaced barrier even when its token and contents were copied", async (t) => {
  const root = await temporary(t);
  const path = join(root, "maintenance");
  const held = await createMaintenanceBarrier(path);
  const replacement = join(root, "operator-replacement");
  await fs.writeFile(replacement, held.contents, { mode: 0o600 });
  const replacementStat = await fs.stat(replacement);
  assert.notEqual(replacementStat.ino, held.ino);
  await fs.rename(replacement, path);
  assert.equal(await releaseMaintenanceBarrier(path, held), false);
  assert.equal((await fs.stat(path)).ino, replacementStat.ino);
  assert.equal(await fs.readFile(path, "utf8"), held.contents);
});

test("operator replacement during readiness is retained rather than recovered", async (t) => {
  const path = join(await temporary(t), "maintenance");
  await createMaintenanceBarrier(path);
  const result = await recoverMaintenanceBarrier(path, {
    deployEnabled: true,
    stillApproved: async () => true,
    isReady: async () => {
      await fs.unlink(path);
      await createMaintenanceBarrier(path);
      return true;
    },
  });
  assert.deepEqual(result, { state: "maintenance-changed" });
  assert.equal((await fs.stat(path)).isFile(), true);
});

test("resume removes its own unchanged barrier once and leaves absent files alone", async (t) => {
  const path = join(await temporary(t), "maintenance");
  const held = await createMaintenanceBarrier(path);
  assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
  assert.equal(await releaseMaintenanceBarrier(path, held), true);
  assert.equal(await releaseMaintenanceBarrier(path, held), false);
  await assert.rejects(fs.stat(path), { code: "ENOENT" });
});

async function release(t) {
  const folder = await temporary(t);
  await fs.mkdir(join(folder, "drizzle"), { recursive: true });
  await fs.mkdir(join(folder, "apps/api/dist"), { recursive: true });
  await fs.writeFile(
    join(folder, "drizzle/0001.sql"),
    "CREATE TABLE tasks (id TEXT PRIMARY KEY);\n",
  );
  await fs.writeFile(
    join(folder, "apps/api/dist/main.js"),
    "// isolated artifact; never executed\n",
  );
  const manifest = {
    sha: HEAD,
    platform: "darwin",
    arch: "arm64",
    nodeMajor: 22,
    ...identity,
    schemaHash: await migrationsHash(folder),
  };
  await fs.writeFile(
    join(folder, ".macmini-release.json"),
    JSON.stringify(manifest),
  );
  return { folder, manifest };
}

async function until(read, description) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await pause(10);
  }
  assert.fail(`Timed out: ${description}`);
}

async function runtimeFixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "agent-runtime-test-")),
  );
  const dataRoot = join(root, "data");
  const path = join(root, "releases", HEAD);
  const startsFile = join(dataRoot, "starts.jsonl");
  const wrappers = [];
  const children = new Set();
  const starts = async () => {
    const content = await fs.readFile(startsFile, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const entries = content.trim()
      ? content
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
    for (const entry of entries) children.add(entry.pid);
    return entries;
  };
  t.after(async () => {
    await starts();
    for (const wrapper of wrappers) {
      if (
        wrapper.handle.exitCode === null &&
        wrapper.handle.signalCode === null
      )
        wrapper.handle.kill("SIGKILL");
    }
    for (const pid of children) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await Promise.allSettled(wrappers.map((wrapper) => wrapper.exited));
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(join(path, "drizzle"), { recursive: true });
  await fs.mkdir(join(path, "apps/api/dist"), { recursive: true });
  await fs.mkdir(dataRoot);
  await fs.writeFile(
    join(path, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  await fs.writeFile(
    join(path, "apps/api/dist/main.js"),
    `import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
await appendFile(join(process.env.DATA_ROOT, 'starts.jsonl'), JSON.stringify({ pid: process.pid }) + '\\n');
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`,
  );
  const manifest = {
    sha: HEAD,
    platform: "darwin",
    arch: "arm64",
    nodeMajor: 22,
    schemaHash: await migrationsHash(path),
    boxliteVersion: "0.9.7",
    dataRoot,
    databaseUrl: join(dataRoot, "platform.db"),
    boxliteHome: join(root, "boxlite"),
  };
  await fs.writeFile(
    join(path, ".macmini-release.json"),
    JSON.stringify(manifest),
  );
  await fs.symlink(path, join(root, "current"));
  const fixtureConfig = config({
    root,
    runtimeEnvFile: join(root, "runtime.env"),
    runtimePlist: join(root, "unused.plist"),
  });
  const configPath = join(root, "config.json");
  await fs.writeFile(configPath, JSON.stringify(fixtureConfig), {
    mode: 0o600,
  });
  await fs.writeFile(
    fixtureConfig.runtimeEnvFile,
    runtimeText({
      DATA_ROOT: manifest.dataRoot,
      DATABASE_URL: manifest.databaseUrl,
      BOXLITE_HOME: manifest.boxliteHome,
      DEPLOYMENT_DRAIN_FILE: join(root, "maintenance"),
    }),
    { mode: 0o600 },
  );
  const spawnWrapper = () => {
    const handle = spawn(
      process.execPath,
      [fileURLToPath(new URL("./runtime.mjs", import.meta.url)), configPath],
      {
        env: buildEnvironment(process.execPath),
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    handle.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const wrapper = {
      handle,
      exited: once(handle, "exit"),
      stderr: () => stderr,
    };
    wrappers.push(wrapper);
    return wrapper;
  };
  const waitStarted = (wrapper, count) =>
    until(async () => {
      assert.equal(wrapper.handle.exitCode, null, wrapper.stderr());
      assert.equal(wrapper.handle.signalCode, null, wrapper.stderr());
      const records = await starts();
      return records.length >= count ? records.at(-1) : null;
    }, "isolated dummy child startup");
  return { root, path, manifest, starts, spawnWrapper, waitStarted };
}

test("only the configured repository, branch and fixed Jenkins job form a production channel", () => {
  assert.equal(validateConfig(config()).branch, BRANCH);
  for (const changes of [
    { repository: "attacker/agent-platform-api" },
    { branch: "pull-request-branch" },
    { ciProvider: "github-actions" },
    { jenkinsJob: "untrusted-pr" },
    { launchdDomain: "gui/0" },
    { launchdDomain: "user/501" },
    { launchdDomain: "system", serviceHelper: "/tmp/arbitrary-helper" },
    { node: "./node" },
    { runtimeEnvFile: "./runtime.env" },
    { root: "/" },
    { uid: -1 },
    { minimumCommit: "HEAD" },
    { deployEnabled: "true" },
    { channelStartedAt: "invalid-date" },
  ])
    assert.throws(() => validateConfig(config(changes)));
});

test("CI requires the controller's same-SHA same-build Jenkins receipt, never GitHub green evidence", () => {
  assert.equal(trustedRun(greenRun(), HEAD, config(), 17), true);
  const rejected = [
    ["GitHub provider", { provider: "github-actions" }],
    ["old green SHA", { sha: PREVIOUS }],
    ["wrong branch", { branch: "main" }],
    ["wrong job", { job: "untrusted-pr" }],
    ["wrong repository", { repository: "attacker/agent-platform-api" }],
    ["wrong build", { buildNumber: 18 }],
    ["unfinished run", { result: "running" }],
    ["failed run", { result: "failure" }],
    ["different channel", { channelStartedAt: "2026-10-04T00:00:00Z" }],
    ["green predates channel", { completedAt: "2026-10-04T23:59:59Z" }],
    ["invalid evidence time", { completedAt: "invalid-date" }],
  ];
  for (const [name, changes] of rejected)
    assert.equal(
      trustedRun(greenRun(changes), HEAD, config(), 17),
      false,
      name,
    );
  assert.equal(trustedRun(greenRun(), "HEAD", config(), 17), false);
  assert.equal(trustedRun(greenRun(), HEAD, config(), 18), false);
  assert.equal(
    trustedRun({ head_sha: HEAD, conclusion: "success" }, HEAD, config(), 17),
    false,
  );
});

async function jenkinsArtifact(t, activeSha) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "jenkins-release-test-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configuration = config({ root });
  const path = buildArtifactPath(configuration, HEAD, activeSha);
  await fs.mkdir(join(path, "drizzle"), { recursive: true });
  await fs.mkdir(join(path, "apps/api/dist"), { recursive: true });
  await fs.writeFile(
    join(path, "drizzle/0001.sql"),
    "CREATE TABLE tasks(id TEXT);\n",
  );
  await fs.writeFile(
    join(path, "apps/api/dist/main.js"),
    "// never executed\n",
  );
  const manifest = {
    sha: HEAD,
    platform: "darwin",
    arch: "arm64",
    nodeMajor: 22,
    ...identity,
    schemaHash: await migrationsHash(path),
  };
  await atomicJson(join(path, ".macmini-release.json"), manifest);
  const request = jenkinsInvocation(
    configuration,
    "build",
    HEAD,
    "17",
    `http://127.0.0.1:8080/job/${JENKINS_JOB}/17/`,
  );
  return { configuration, path, manifest, request };
}

test("the stage API pins full SHA, numeric build identity and local fixed-job links", () => {
  assert.deepEqual(jenkinsInvocation(config(), "build", HEAD, "17"), {
    action: "build",
    sha: HEAD,
    buildNumber: 17,
    buildUrl: null,
  });
  for (const [action, sha, number, url] of [
    ["reconcile", HEAD, "17"],
    ["build", "HEAD", "17"],
    ["deploy", HEAD, "../17"],
    ["deploy", HEAD, "017"],
    ["deploy", HEAD, "0"],
    [
      "deploy",
      HEAD,
      "17",
      "https://attacker.example/job/agent-platform-api/17/",
    ],
    ["deploy", HEAD, "17", "http://127.0.0.1:8080/job/untrusted-pr/17/"],
    ["deploy", HEAD, "17", "http://127.0.0.1:8080/job/agent-platform-api/18/"],
  ])
    assert.throws(() => jenkinsInvocation(config(), action, sha, number, url));
});

test("system service operations use only the fixed privileged helper while GUI operations retain their configured UID", () => {
  const system = validateConfig(
    config({
      launchdDomain: "system",
      serviceHelper: SERVICE_CONTROL_HELPER,
      runtimePlist:
        "/Library/LaunchDaemons/com.douglasdong.agent-platform.api.plist",
    }),
  );
  assert.deepEqual(serviceCommand(system, "start"), [
    "/usr/bin/sudo",
    ["-n", SERVICE_CONTROL_HELPER, "api", "start"],
  ]);
  assert.deepEqual(serviceCommand(system, "stop"), [
    "/usr/bin/sudo",
    ["-n", SERVICE_CONTROL_HELPER, "api", "stop"],
  ]);
  assert.deepEqual(serviceCommand(config(), "start"), [
    "/bin/launchctl",
    ["bootstrap", `gui/${process.getuid()}`, "/service/runtime.plist"],
  ]);
  assert.throws(() => serviceCommand(system, "arbitrary-command"));
  assert.throws(() =>
    validateConfig({ ...system, runtimePlist: "/tmp/arbitrary.plist" }),
  );
});

test("system installer identity accepts only the dedicated UID501 home and runtime config", () => {
  const production = config({
    uid: 501,
    root: DEPLOY_ROOT,
    runtimeEnvFile: join(DEPLOY_ROOT, "runtime.env"),
  });
  assert.doesNotThrow(() => assertNativeServiceIdentity(production));
  for (const changes of [
    { uid: 0 },
    { root: "/tmp/staging" },
    { runtimeEnvFile: "/tmp/runtime.env" },
    { node: "node" },
  ])
    assert.throws(
      () => assertNativeServiceIdentity({ ...production, ...changes }),
      /dedicated.*installation/,
    );
});

test("actual generated system plists declare non-root identity, fixed execution and persistent logs", async (t) => {
  const folder = await fs.mkdtemp(join(tmpdir(), "system-plist-test-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const production = config({
    uid: 501,
    root: DEPLOY_ROOT,
    runtimeEnvFile: join(DEPLOY_ROOT, "runtime.env"),
  });
  for (const kind of ["api", "tunnel"]) {
    const path = join(folder, `${kind}.plist`);
    await fs.writeFile(path, servicePlist(kind, production, { system: true }));
    const child = spawn(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", path],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
    const parsed = JSON.parse(output);
    assert.equal(parsed.UserName, "douglasdong");
    assert.equal(parsed.GroupName, "staff");
    assert.equal(parsed.KeepAlive, true);
    assert.equal(parsed.RunAtLoad, true);
    assert.equal(parsed.EnvironmentVariables.HOME, "/Users/douglasdong");
    assert.equal(parsed.StandardOutPath, join(DEPLOY_ROOT, `logs/${kind}.log`));
    assert.equal(parsed.EnvironmentVariables.ACCESS_PASSCODE, undefined);
    if (kind === "api")
      assert.deepEqual(parsed.ProgramArguments, [
        process.execPath,
        join(DEPLOY_ROOT, "tools/runtime.mjs"),
        join(DEPLOY_ROOT, "config.json"),
      ]);
    else assert.equal(parsed.ProgramArguments.at(-2), "--token-file");
  }
});

test("isolated Jenkins CI plists reject production identity, leaked secrets and an outside working directory", () => {
  const label = "com.douglasdong.agent-platform.jenkins-ci-agent";
  const home = ACCOUNTS._agentplatformci;
  const plist = {
    Label: label,
    UserName: "_agentplatformci",
    GroupName: "staff",
    RunAtLoad: true,
    ProgramArguments: [
      "/opt/homebrew/bin/java",
      "-secret",
      `@${home}/agent.secret`,
    ],
    WorkingDirectory: `${home}/agent`,
    EnvironmentVariables: { HOME: home },
    StandardOutPath: `${home}/logs/agent.log`,
    StandardErrorPath: `${home}/logs/agent.log`,
  };
  assert.equal(validateExtraPlist(plist, label), plist);
  for (const changes of [
    { UserName: "root" },
    { UserName: "douglasdong" },
    { WorkingDirectory: DEPLOY_ROOT },
    { EnvironmentVariables: { HOME: home, GH_TOKEN: "fixture-not-real" } },
    {
      ProgramArguments: ["/opt/homebrew/bin/java", "-secret", "literal-secret"],
    },
  ])
    assert.throws(() => validateExtraPlist({ ...plist, ...changes }, label));
});

test("Jenkins secret handoff admits only fixed distinct source, destination and owner metadata", () => {
  assert.equal(validateSecretHandoffs(SECRET_HANDOFFS), SECRET_HANDOFFS);
  const first = SECRET_HANDOFFS[0];
  for (const items of [
    [{ ...first, source: "/tmp/arbitrary.secret" }],
    [{ ...first, destination: "/etc/arbitrary.secret" }],
    [{ ...first, owner: "root" }],
    [first, first],
  ])
    assert.throws(
      () => validateSecretHandoffs(items),
      /fixed Jenkins-to-agent/,
    );
});

test("the privileged helper is valid shell and sudoers grants fixed service commands without root Node or generic launchctl", async (t) => {
  const folder = await fs.mkdtemp(join(tmpdir(), "service-helper-test-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const script = join(folder, "helper.sh");
  await fs.writeFile(script, serviceControlScript());
  const child = spawn("/bin/sh", ["-n", script]);
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  const grants = serviceSudoers().split("NOPASSWD: ")[1].trim().split(", ");
  assert.deepEqual(
    grants,
    ["api", "tunnel"].flatMap((kind) =>
      ["start", "stop", "restart", "status"].map(
        (action) => `${SERVICE_CONTROL_HELPER} ${kind} ${action}`,
      ),
    ),
  );
  assert(!grants.some((grant) => /launchctl|node|\*/.test(grant)));
  assert.match(
    serviceControlScript(),
    /Only|Root-owned narrow launchd control/,
  );
});

test("native CI executes every gate including fixture capability and native SDK checks without runtime secrets", async () => {
  const calls = [];
  const phases = [];
  const env = buildEnvironment(process.execPath, {
    HOME: "/fixture",
    ACCESS_PASSCODE: "never-forward",
    BUILD_URL: "never-forward",
  });
  await runNativeChecks(
    config(),
    "/ci/checkout",
    env,
    "/ci/build.log",
    async (...phase) => phases.push(phase),
    async (command, args, options) => calls.push({ command, args, options }),
  );
  assert.deepEqual(
    phases,
    CI_CHECKS.flatMap((stage) => [
      [stage, "running"],
      [stage, "passed"],
    ]),
  );
  assert.deepEqual(calls[6].args, ["scripts/check-fake-provider-caps.mjs"]);
  assert.equal(calls[9].command, "/usr/bin/git");
  assert.match(calls[10].args[1], /better-sqlite3/);
  assert.match(calls[11].args[1], /@boxlite-ai\/boxlite/);
  assert.equal(calls[11].options.cwd, "/ci/checkout/packages/modules/sandbox");
  assert.equal(calls.length, 12);
  assert(
    calls.every(
      (call) =>
        call.options.env === env &&
        call.options.env.ACCESS_PASSCODE === undefined,
    ),
  );
});

test("a provider fixture failure aborts native CI before build or attestation", async () => {
  const phases = [];
  const calls = [];
  await assert.rejects(
    runNativeChecks(
      config(),
      "/ci/checkout",
      {},
      "/ci/build.log",
      async (...phase) => phases.push(phase),
      async (_command, args) => {
        calls.push(args);
        if (args[0] === "scripts/check-fake-provider-caps.mjs")
          throw new Error("fixture capability mismatch");
      },
    ),
    /fixture capability mismatch/,
  );
  assert.equal(calls.length, 7);
  assert.deepEqual(phases.at(-1), ["provider-fixtures", "failed"]);
  assert(!phases.some(([stage]) => stage === "build"));
});

test("successful CI writes an owner-only same-build receipt bound to the complete real artifact manifest", async (t) => {
  const { configuration, path, request } = await jenkinsArtifact(t);
  const operations = {
    request,
    head: async () => HEAD,
    build: async () => attestArtifact(configuration, path, HEAD),
    receipt: (candidate) =>
      writeJenkinsReceipt(configuration, request, candidate),
  };
  const result = await runJenkinsBuild(configuration, operations);
  assert.equal(result.state, "ci-passed");
  assert.equal(result.artifactPath, path);
  assert.equal(result.receiptPath, jenkinsReceiptPath(configuration, request));
  assert.equal(
    result.acceptanceReport,
    join(path, "acceptance/execution-report.json"),
  );
  const record = await readJenkinsReceipt(configuration, request);
  assert.equal(record.sha, HEAD);
  assert.equal(record.buildNumber, 17);
  assert.equal(record.candidate.path, path);
  assert.equal((await fs.stat(result.receiptPath)).mode & 0o077, 0);
  assert.equal((await fs.stat(join(path, ".macmini-ci.json"))).mode & 0o077, 0);
  assert.equal(
    await readJenkinsReceipt(configuration, { ...request, buildNumber: 18 }),
    null,
  );
});

test("a legacy ready artifact cannot issue a Jenkins success receipt without the new native CI attestation", async (t) => {
  const { configuration, path, request } = await jenkinsArtifact(t);
  await assert.rejects(writeJenkinsReceipt(configuration, request, { path }), {
    code: "ENOENT",
  });
  assert.equal(await readJenkinsReceipt(configuration, request), null);
  await assert.rejects(
    runJenkinsBuild(configuration, {
      request,
      head: async () => HEAD,
      build: async () => {
        throw new Error("checks failed");
      },
      receipt: () => assert.fail("failed CI cannot issue a receipt"),
    }),
    /checks failed/,
  );
  assert.equal(await readJenkinsReceipt(configuration, request), null);
});

test("first Jenkins verification of the active SHA builds separately and leaves the active release bytes untouched", async (t) => {
  const { configuration, path, request } = await jenkinsArtifact(t, HEAD);
  const active = join(configuration.root, "releases", HEAD);
  await fs.mkdir(active, { recursive: true });
  await fs.writeFile(join(active, "active-sentinel"), "running user service\n");
  assert.equal(path, join(configuration.root, "ci-workspaces", HEAD));
  assert.notEqual(path, active);
  const verified = await attestArtifact(configuration, path, HEAD);
  await writeJenkinsReceipt(configuration, request, verified);
  assert.equal(
    await fs.readFile(join(active, "active-sentinel"), "utf8"),
    "running user service\n",
  );
  assert.deepEqual(await fs.readdir(active), ["active-sentinel"]);
  assert.equal(
    (await readJenkinsReceipt(configuration, request)).candidate.path,
    path,
  );
});

test("an already-current SHA still needs matching Jenkins verification before deployment can report current", async () => {
  const scenario = cycle({
    current: async () => ({ sha: HEAD, ...identity }),
    ci: async () => null,
    healthy: () => assert.fail("no CI proof cannot become current"),
  });
  assert.equal(
    (await runCycle(config(), scenario.operations)).state,
    "waiting-ci",
  );
});

test("a stale requested SHA or an advancing remote cannot issue CI evidence or change admission", async (t) => {
  const { configuration, request } = await jenkinsArtifact(t);
  const stale = { ...request, sha: PREVIOUS };
  assert.equal(
    (
      await runJenkinsBuild(configuration, {
        request: stale,
        head: async () => HEAD,
        build: () => assert.fail("stale request cannot build"),
      })
    ).state,
    "superseded",
  );
  let reads = 0;
  const result = await runJenkinsBuild(configuration, {
    request,
    head: async () => (++reads === 1 ? HEAD : NEW_HEAD),
    build: async () => ({}),
    receipt: () => assert.fail("superseded build cannot attest a run"),
  });
  assert.equal(result.state, "superseded");
  assert.equal(await readJenkinsReceipt(configuration, request), null);
  const deployment = cycle({
    request: stale,
    current: () =>
      assert.fail("stale deployment cannot inspect or change active release"),
  });
  assert.equal(
    (await runCycle(configuration, deployment.operations)).state,
    "superseded",
  );
});

test("changing verified metadata, checks, or the production channel invalidates cached Jenkins evidence", async (t) => {
  const { configuration, path, request } = await jenkinsArtifact(t);
  const verified = await attestArtifact(configuration, path, HEAD);
  await writeJenkinsReceipt(configuration, request, verified);
  assert.equal(
    await readJenkinsReceipt(
      { ...configuration, channelStartedAt: "2026-10-07T00:00:00Z" },
      request,
    ),
    null,
  );
  const proof = JSON.parse(await privateFile(join(path, ".macmini-ci.json")));
  await atomicJson(join(path, ".macmini-ci.json"), {
    ...proof,
    checks: CI_CHECKS.filter((stage) => stage !== "provider-fixtures"),
  });
  await assert.rejects(
    readJenkinsReceipt(configuration, request),
    /no matching complete Jenkins verification/,
  );
  await atomicJson(join(path, ".macmini-ci.json"), {
    ...proof,
    completedAt: "2099-01-01T00:00:00Z",
  });
  await assert.rejects(
    readJenkinsReceipt(configuration, request),
    /verification changed after receipt/,
  );
  await atomicJson(join(path, ".macmini-ci.json"), proof);
  const manifest = JSON.parse(
    await privateFile(join(path, ".macmini-release.json")),
  );
  await atomicJson(join(path, ".macmini-release.json"), {
    ...manifest,
    boxliteVersion: "different-version",
  });
  await assert.rejects(
    readJenkinsReceipt(configuration, request),
    /no matching complete Jenkins verification/,
  );
});

test("receipts reject public files, symlinks and arbitrary artifact paths even with successful metadata", async (t) => {
  const { configuration, path, request } = await jenkinsArtifact(t);
  const verified = await attestArtifact(configuration, path, HEAD);
  const record = await writeJenkinsReceipt(configuration, request, verified);
  const receiptPath = jenkinsReceiptPath(configuration, request);
  await fs.chmod(receiptPath, 0o644);
  await assert.rejects(
    readJenkinsReceipt(configuration, request),
    /owner-only regular file/,
  );
  await fs.chmod(receiptPath, 0o600);
  await atomicJson(receiptPath, {
    ...record,
    artifactPath: "/tmp/untrusted-output",
  });
  await assert.rejects(
    readJenkinsReceipt(configuration, request),
    /Invalid CI artifact path/,
  );
  const target = join(configuration.root, "receipt-target.json");
  await atomicJson(target, record);
  await fs.rm(receiptPath);
  await fs.symlink(target, receiptPath);
  await assert.rejects(
    readJenkinsReceipt(configuration, request),
    /owner-only regular file/,
  );
});

test("approved same-SHA CI builds, checks quiet admission twice, and activates only after drain", async () => {
  const { calls, operations } = cycle();
  assert.deepEqual(await runCycle(config(), operations), {
    state: "deployed",
    sha: HEAD,
    runId: 17,
  });
  assert.deepEqual(calls, [
    "head",
    "current",
    "ci",
    "build",
    "head",
    "idle",
    "drain",
    "head",
    "idle-draining",
    "activate",
    "resume",
  ]);
});

test("an already-active SHA is a no-op only after authenticated readiness", async () => {
  const { calls, operations } = cycle({
    current: async () => ({ sha: HEAD, ...identity }),
  });
  assert.deepEqual(await runCycle(config(), operations), {
    state: "current",
    sha: HEAD,
    runId: 17,
  });
  assert.deepEqual(calls, ["head", "ci", "healthy"]);
});

test("a failed first installation's same-SHA symlink cannot masquerade as an active release", async () => {
  const { calls, operations } = cycle({
    current: async () => ({ sha: HEAD, ...identity }),
    healthy: async () => false,
  });
  assert.deepEqual(await runCycle(config(), operations), {
    state: "unhealthy-current-needs-recovery",
    sha: HEAD,
    runId: 17,
  });
  assert.deepEqual(calls, ["head", "ci"]);
});

test("channel minimum ancestry and rejected CI prevent all build or admission side effects", async () => {
  const rejectedAncestor = cycle({ descendsFrom: async () => false });
  assert.equal(
    (
      await runCycle(
        config({ minimumCommit: PREVIOUS }),
        rejectedAncestor.operations,
      )
    ).state,
    "waiting-channel-commit",
  );
  assert.deepEqual(rejectedAncestor.calls, ["head", "current"]);
  for (const invalid of [
    greenRun({ job: "untrusted-pr" }),
    greenRun({ sha: PREVIOUS }),
  ]) {
    const scenario = cycle({ ci: async () => invalid });
    assert.equal(
      (await runCycle(config(), scenario.operations)).state,
      "waiting-ci",
    );
    assert.deepEqual(scenario.calls, ["head", "current"]);
  }
});

test("remote branch advancing during build discards the candidate before drain or activation", async () => {
  let reads = 0;
  const scenario = cycle({
    head: async () => (++reads === 1 ? HEAD : NEW_HEAD),
  });
  assert.equal(
    (await runCycle(config(), scenario.operations)).state,
    "superseded",
  );
  assert.deepEqual(scenario.calls, ["current", "ci", "build"]);
});

test("remote branch advancing after drain releases the barrier and never activates stale code", async () => {
  let reads = 0;
  const scenario = cycle({ head: async () => (++reads < 3 ? HEAD : NEW_HEAD) });
  assert.equal(
    (await runCycle(config(), scenario.operations)).state,
    "superseded",
  );
  assert.deepEqual(scenario.calls, [
    "current",
    "ci",
    "build",
    "idle",
    "drain",
    "resume",
  ]);
});

test("disabled deployment still verifies/builds but does not drain or activate", async () => {
  const scenario = cycle();
  assert.deepEqual(
    await runCycle(config({ deployEnabled: false }), scenario.operations),
    {
      state: "built",
      sha: HEAD,
      runId: 17,
    },
  );
  assert.deepEqual(scenario.calls, ["head", "current", "ci", "build", "head"]);
});

test("withdrawing deployment approval during build or the quiet interval never activates the candidate", async () => {
  for (const timing of ["build", "quiet"]) {
    for (const change of [
      "disable",
      "minimum-commit",
      "channel-date",
      "runtime-data",
      "runtime-env",
    ]) {
      const live = { config: config(), runtime: runtimeText() };
      const approvedSnapshot = JSON.stringify(live);
      const withdraw = () => {
        if (change === "disable") live.config.deployEnabled = false;
        if (change === "minimum-commit") live.config.minimumCommit = NEW_HEAD;
        if (change === "channel-date")
          live.config.channelStartedAt = "2026-10-07T00:00:00Z";
        if (change === "runtime-data")
          live.runtime = runtimeText({ DATA_ROOT: "/another/data" });
        if (change === "runtime-env")
          live.runtime = runtimeText({
            API_ALLOWED_ORIGINS: "https://other.example.com",
          });
      };
      const approvalReads = [];
      const scenario = cycle({
        stillApproved: async () => {
          approvalReads.push(
            scenario.calls.includes("drain") ? "after-drain" : "after-build",
          );
          return JSON.stringify(live) === approvedSnapshot;
        },
      });
      const build = scenario.operations.build;
      scenario.operations.build = async (sha) => {
        const candidate = await build(sha);
        if (timing === "build") withdraw();
        return candidate;
      };
      const idle = scenario.operations.idle;
      scenario.operations.idle = async (draining) => {
        const result = await idle(draining);
        if (timing === "quiet" && draining) withdraw();
        return result;
      };
      assert.equal(
        (await runCycle(config(), scenario.operations)).state,
        "built",
        `${timing}/${change}`,
      );
      assert.equal(
        scenario.calls.includes("activate"),
        false,
        `${timing}/${change}`,
      );
      assert.equal(scenario.calls.includes("drain"), timing === "quiet");
      assert.equal(scenario.calls.includes("resume"), timing === "quiet");
      assert.deepEqual(
        approvalReads,
        timing === "build" ? ["after-build"] : ["after-build", "after-drain"],
      );
    }
  }
});

test("approval is checked again after quiet admission before a still-approved release activates", async () => {
  const reads = [];
  const scenario = cycle({
    stillApproved: async () => {
      reads.push(
        scenario.calls.includes("idle-draining")
          ? "quiet-complete"
          : "build-complete",
      );
      return true;
    },
  });
  assert.equal(
    (await runCycle(config(), scenario.operations)).state,
    "deployed",
  );
  assert.deepEqual(reads, ["build-complete", "quiet-complete"]);
  assert.equal(scenario.calls.at(-1), "resume");
});

test("approval read failure after drain preserves the original ready release and removes its barrier", async () => {
  let reads = 0;
  const scenario = cycle({
    stillApproved: async () => {
      if (++reads === 2) throw new Error("approval file unavailable");
      return true;
    },
  });
  await assert.rejects(
    runCycle(config(), scenario.operations),
    /approval file unavailable/,
  );
  assert.equal(scenario.calls.includes("activate"), false);
  assert.equal(scenario.calls.at(-1), "resume");
});

test("failed build never drains, activates or treats the candidate as a successful release", async () => {
  const scenario = cycle({
    build: async () => {
      throw new Error("isolated build failed");
    },
  });
  await assert.rejects(
    runCycle(config(), scenario.operations),
    /isolated build failed/,
  );
  assert.deepEqual(scenario.calls, ["head", "current", "ci"]);
});

test("active tasks defer cutover, including a task appearing between the first idle read and the barrier", async () => {
  const initiallyBusy = cycle({ idle: async () => false });
  assert.equal(
    (await runCycle(config(), initiallyBusy.operations)).state,
    "waiting-idle",
  );
  assert.deepEqual(initiallyBusy.calls, [
    "head",
    "current",
    "ci",
    "build",
    "head",
  ]);
  const changed = cycle({ idle: async (draining) => !draining });
  assert.equal(
    (await runCycle(config(), changed.operations)).state,
    "waiting-idle",
  );
  assert.deepEqual(changed.calls, [
    "head",
    "current",
    "ci",
    "build",
    "head",
    "drain",
    "head",
    "resume",
  ]);
});

test("activation failure keeps the admission barrier unless a ready rollback is verified", async () => {
  const scenario = cycle({
    activate: async () => {
      throw new Error("candidate readiness failed");
    },
  });
  await assert.rejects(
    runCycle(config(), scenario.operations),
    /candidate readiness failed/,
  );
  assert.equal(scenario.calls.includes("resume"), false);
  assert.equal(scenario.calls.includes("drain"), true);
});

test("pre-cutover lookup failure releases the barrier without starting any candidate", async () => {
  let reads = 0;
  const scenario = cycle({
    head: async () => {
      if (++reads === 3) throw new Error("remote lookup failed after drain");
      return HEAD;
    },
  });
  await assert.rejects(
    runCycle(config(), scenario.operations),
    /remote lookup failed after drain/,
  );
  assert.equal(scenario.calls.includes("activate"), false);
  assert.equal(scenario.calls.at(-1), "resume");
});

test("first-install readiness failure stops the candidate and preserves recovery admission", async () => {
  const transitions = [];
  const failure = new Error("first install readiness failed");
  const scenario = cycle({ current: async () => null });
  scenario.operations.activate = (candidate, previous) =>
    activateRelease(candidate, previous, {
      prepare: async (old) => {
        assert.equal(old, null);
        transitions.push("prepare-empty-data");
      },
      stop: async () => {
        transitions.push("stop-failed-candidate");
      },
      start: async (value) => {
        transitions.push(`start-${value.sha}`);
        throw failure;
      },
    });
  await assert.rejects(
    runCycle(config(), scenario.operations),
    (error) => error === failure,
  );
  assert.deepEqual(transitions, [
    "prepare-empty-data",
    `start-${HEAD}`,
    "stop-failed-candidate",
  ]);
  assert.equal(failure.rollbackReady, undefined);
  assert.equal(scenario.calls.includes("resume"), false);
});

test("candidate readiness failure rolls back only the matching schema/storage release and resumes after old readiness", async () => {
  const transitions = [];
  const failure = new Error("candidate readiness failed");
  const scenario = cycle();
  scenario.operations.activate = (candidate, previous) =>
    activateRelease(candidate, previous, {
      prepare: async (old) => {
        assert.equal(old, scenario.previous);
        transitions.push("backup");
      },
      stop: async () => {
        transitions.push("stop");
      },
      start: async (value) => {
        transitions.push(`start-${value.sha}`);
        if (value.sha === HEAD) throw failure;
        assert.equal(value, scenario.previous);
      },
    });
  await assert.rejects(
    runCycle(config(), scenario.operations),
    (error) => error === failure,
  );
  assert.deepEqual(transitions, [
    "backup",
    "stop",
    `start-${HEAD}`,
    "stop",
    `start-${PREVIOUS}`,
  ]);
  assert.equal(failure.rollbackReady, true);
  assert.equal(scenario.calls.at(-1), "resume");
});

test("failed rollback readiness never reopens admission or claims a ready previous release", async () => {
  const scenario = cycle();
  const rollbackFailure = new Error("previous release also failed readiness");
  const started = [];
  scenario.operations.activate = (candidate, previous) =>
    activateRelease(candidate, previous, {
      prepare: async () => undefined,
      stop: async () => undefined,
      start: async (value) => {
        started.push(value.sha);
        if (value.sha === HEAD) throw new Error("candidate readiness failed");
        throw rollbackFailure;
      },
    });
  await assert.rejects(
    runCycle(config(), scenario.operations),
    (error) => error === rollbackFailure,
  );
  assert.deepEqual(started, [HEAD, PREVIOUS]);
  assert.equal(rollbackFailure.rollbackReady, undefined);
  assert.equal(scenario.calls.includes("resume"), false);
});

test("activation itself refuses unsafe rollback when migration/storage fingerprints differ", async () => {
  for (const field of [
    "schemaHash",
    "dataRoot",
    "databaseUrl",
    "boxliteHome",
    "boxliteVersion",
  ]) {
    const candidate = { sha: HEAD, ...identity, [field]: `changed-${field}` };
    const previous = { sha: PREVIOUS, ...identity };
    const started = [];
    const failure = new Error("candidate readiness failed");
    await assert.rejects(
      activateRelease(candidate, previous, {
        prepare: async () => undefined,
        stop: async () => undefined,
        start: async (value) => {
          started.push(value.sha);
          throw failure;
        },
      }),
      (error) => error === failure,
    );
    assert.deepEqual(started, [HEAD], field);
    assert.equal(failure.rollbackReady, undefined);
  }
});

test("backup or old-process stop failure prevents candidate startup", async () => {
  for (const stage of ["prepare", "stop"]) {
    const started = [];
    const failure = new Error(`${stage} failed`);
    const operations = {
      prepare: async () => {
        if (stage === "prepare") throw failure;
      },
      stop: async () => {
        if (stage === "stop") throw failure;
      },
      start: async (value) => {
        started.push(value.sha);
      },
    };
    await assert.rejects(
      activateRelease(
        { sha: HEAD, ...identity },
        { sha: PREVIOUS, ...identity },
        operations,
      ),
      (error) => error === failure,
    );
    assert.deepEqual(started, []);
  }
});

test("schema or persistent storage identity change blocks cutover and rollback", async () => {
  const previous = { sha: PREVIOUS, ...identity };
  assert.equal(canRollback(previous, { sha: HEAD, ...identity }), true);
  assert.equal(canRollback(null, { sha: HEAD, ...identity }), false);
  for (const field of [
    "schemaHash",
    "dataRoot",
    "databaseUrl",
    "boxliteHome",
    "boxliteVersion",
  ]) {
    const candidate = { sha: HEAD, ...identity, [field]: `changed-${field}` };
    assert.equal(canRollback(previous, candidate), false, field);
    const scenario = cycle({ build: async () => candidate });
    assert.equal(
      (await runCycle(config(), scenario.operations)).state,
      "schema-or-data-change-needs-review",
    );
    assert.equal(scenario.calls.includes("idle"), false);
    assert.equal(scenario.calls.includes("drain"), false);
    assert.equal(scenario.calls.includes("activate"), false);
  }
});

test("only a complete native Node 22 release with matching migration content is reusable", async (t) => {
  const { folder, manifest } = await release(t);
  assert.deepEqual(await readyManifest(folder, HEAD), manifest);
  await fs.rm(join(folder, ".macmini-release.json"));
  await assert.rejects(readyManifest(folder, HEAD), { code: "ENOENT" });
  for (const changes of [
    { sha: PREVIOUS },
    { platform: "linux" },
    { arch: "x64" },
    { nodeMajor: 26 },
    { boxliteVersion: undefined },
    { boxliteVersion: "" },
  ]) {
    await fs.writeFile(
      join(folder, ".macmini-release.json"),
      JSON.stringify({ ...manifest, ...changes }),
    );
    await assert.rejects(
      readyManifest(folder, HEAD),
      /Invalid release manifest/,
    );
  }
  await fs.writeFile(
    join(folder, ".macmini-release.json"),
    JSON.stringify(manifest),
  );
  await fs.rm(join(folder, "apps/api/dist/main.js"));
  await assert.rejects(readyManifest(folder, HEAD), { code: "ENOENT" });
});

test("editing an existing migration changes the content hash, invalidates cache and blocks rollback", async (t) => {
  const { folder, manifest } = await release(t);
  await fs.writeFile(
    join(folder, "drizzle/0001.sql"),
    "CREATE TABLE tasks (id TEXT, incompatible INTEGER);\n",
  );
  const changed = await migrationsHash(folder);
  assert.notEqual(changed, manifest.schemaHash);
  await assert.rejects(readyManifest(folder, HEAD), /Invalid release manifest/);
  assert.equal(
    canRollback(manifest, { ...manifest, schemaHash: changed }),
    false,
  );
});

test("migration symlinks cannot escape the isolated release or masquerade as a stable hash", async (t) => {
  const { folder } = await release(t);
  await fs.symlink(
    join(folder, "apps/api/dist/main.js"),
    join(folder, "drizzle/external.sql"),
  );
  await assert.rejects(
    migrationsHash(folder),
    /Migrations cannot contain symlinks/,
  );
});

test("build subprocess environment excludes ambient credentials and executable injection", () => {
  const source = {
    HOME: "/fixture-user",
    TMPDIR: "/fixture-temp",
    PATH: "/untrusted/bin",
    GH_TOKEN: "fixture-only",
    GITHUB_TOKEN: "fixture-only",
    ACCESS_PASSCODE: "fixture-only",
    PASSCODE_COOKIE_SECRET: "fixture-only",
    ENCRYPTION_KEY: "fixture-only",
    NODE_OPTIONS: "--require=/untrusted/preload.cjs",
    DYLD_INSERT_LIBRARIES: "/untrusted/library",
    BASH_ENV: "/untrusted/profile",
    ENV: "/untrusted/profile",
    DATABASE_URL: "/production/data/platform.db",
    DATA_ROOT: "/production/data",
  };
  const actual = buildEnvironment("/trusted/node22/bin/node", source);
  assert.deepEqual(
    Object.keys(actual).sort(),
    [
      "CI",
      "GIT_TERMINAL_PROMPT",
      "HOME",
      "HUSKY",
      "LANG",
      "PATH",
      "TMPDIR",
    ].sort(),
  );
  assert.equal(
    actual.PATH,
    "/trusted/node22/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  );
  assert.equal(actual.CI, "true");
  assert.equal(actual.HUSKY, "0");
  assert.equal(actual.HOME, source.HOME);
  assert.equal(actual.TMPDIR, source.TMPDIR);
});

test("runtime accepts explicit API settings but rejects inherited tooling credentials or executable hooks", () => {
  const actual = runtimeEnvironment(runtimeText(), config());
  assert.equal(actual.HOST, "127.0.0.1");
  assert.equal(actual.ACCESS_PASSCODE, "fixture-passcode");
  assert.equal(actual.DEPLOYMENT_DRAIN_FILE, "/service/maintenance");
  for (const key of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "NODE_OPTIONS",
    "NODE_ENV",
    "PATH",
    "DYLD_INSERT_LIBRARIES",
    "LD_PRELOAD",
    "BASH_ENV",
    "ENV",
  ]) {
    assert.throws(
      () =>
        runtimeEnvironment(runtimeText({ [key]: "fixture-only" }), config()),
      /Unsupported runtime environment key/,
      key,
    );
  }
  const build = buildEnvironment(process.execPath, actual);
  assert.equal("ACCESS_PASSCODE" in build, false);
  assert.equal("PASSCODE_COOKIE_SECRET" in build, false);
  assert.equal("DATABASE_URL" in build, false);
});

test("runtime rejects exposed listeners, insecure cookies, invalid ports and changed drain ownership", () => {
  for (const changes of [
    { HOST: "0.0.0.0" },
    { PORT: "80" },
    { PORT: "65536" },
    { PORT: "3101;evil" },
    { DATA_ROOT: "./data" },
    { DATABASE_URL: "./data.db" },
    { BOXLITE_HOME: "./boxlite" },
    { ACCESS_PASSCODE_ALLOW_LOOPBACK: "true" },
    { PASSCODE_COOKIE_SECURE: "false" },
    { ACCESS_PASSCODE: "" },
    { PASSCODE_COOKIE_SECRET: "" },
    { DEPLOYMENT_DRAIN_FILE: "/another-deployment/maintenance" },
  ])
    assert.throws(
      () => runtimeEnvironment(runtimeText(changes), config()),
      /Invalid production runtime configuration/,
    );
});

test("runtime/config files must be owner-only regular files, never public files or symlinks", async (t) => {
  const folder = await temporary(t);
  const path = join(folder, "config.json");
  await fs.writeFile(path, "{}", { mode: 0o600 });
  assert.equal(await privateFile(path), "{}");
  await fs.chmod(path, 0o644);
  await assert.rejects(privateFile(path), /Expected owner-only regular file/);
  await fs.chmod(path, 0o600);
  await fs.symlink(path, join(folder, "config-link.json"));
  await assert.rejects(
    privateFile(join(folder, "config-link.json")),
    /Expected owner-only regular file/,
  );
});

test("a real live process is refused before spawning a second API, while its exited PID is accepted", async (t) => {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
  });
  await once(child, "spawn");
  assert.throws(
    () => assertNoLiveApi({ pid: child.pid }),
    /Previous API still exists/,
  );
  const exited = once(child, "exit");
  child.stdin.end();
  await exited;
  assert.doesNotThrow(() => assertNoLiveApi({ pid: child.pid }));
});

test("unknown previous process state fails closed and only explicit no-previous-state permits first installation", () => {
  assert.doesNotThrow(() => assertNoLiveApi(null));
  for (const state of [
    undefined,
    {},
    { pid: 0 },
    { pid: -1 },
    { pid: "42" },
    { pid: 1.5 },
  ]) {
    assert.throws(() => assertNoLiveApi(state), /Unknown previous API process/);
  }
});

test(
  "SIGKILL of the actual runtime wrapper leaves its live child protected by both the stale lock and process guard",
  { skip: nativeRuntimeOnly },
  async (t) => {
    const fixture = await runtimeFixture(t);
    const first = fixture.spawnWrapper();
    const child = await fixture.waitStarted(first, 1);
    const statePath = join(fixture.root, "runtime-state.json");
    await until(async () => {
      const state = await fs
        .readFile(statePath, "utf8")
        .then(JSON.parse)
        .catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      return state?.pid === child.pid;
    }, "wrapper records tracked child PID");
    const lockPath = join(fixture.root, "runtime.lock");
    const owner = JSON.parse(
      await fs.readFile(join(lockPath, "owner.json"), "utf8"),
    );
    assert.equal(owner.pid, first.handle.pid);
    first.handle.kill("SIGKILL");
    assert.deepEqual(await first.exited, [null, "SIGKILL"]);
    assert.throws(() => assertNoLiveApi(child), /Previous API still exists/);

    const second = fixture.spawnWrapper();
    assert.deepEqual(await second.exited, [1, null]);
    assert.match(second.stderr(), /stale-lock-needs-recovery/);
    assert.deepEqual(await fixture.starts(), [child]);
    assert.deepEqual(
      JSON.parse(await fs.readFile(join(lockPath, "owner.json"), "utf8")),
      owner,
    );
    assert.equal(
      JSON.parse(await fs.readFile(statePath, "utf8")).pid,
      child.pid,
    );

    // Even accidental operator lock removal must not admit another child beside this one.
    await fs.rm(lockPath, { recursive: true });
    const third = fixture.spawnWrapper();
    assert.deepEqual(await third.exited, [1, null]);
    assert.match(third.stderr(), /Previous API still exists/);
    assert.deepEqual(await fixture.starts(), [child]);
    assert.throws(() => assertNoLiveApi(child), /Previous API still exists/);
  },
);

test(
  "normal child exit releases the actual wrapper's runtime lock and permits one subsequent child",
  { skip: nativeRuntimeOnly },
  async (t) => {
    const fixture = await runtimeFixture(t);
    const first = fixture.spawnWrapper();
    const child = await fixture.waitStarted(first, 1);
    process.kill(child.pid, "SIGTERM");
    assert.deepEqual(await first.exited, [0, null]);
    await assert.rejects(fs.stat(join(fixture.root, "runtime.lock")), {
      code: "ENOENT",
    });
    assert.doesNotThrow(() => assertNoLiveApi(child));
    const second = fixture.spawnWrapper();
    const subsequent = await fixture.waitStarted(second, 2);
    assert.notEqual(subsequent.pid, child.pid);
    assert.equal((await fixture.starts()).length, 2);
    second.handle.kill("SIGTERM");
    assert.deepEqual(await second.exited, [0, null]);
    await assert.rejects(fs.stat(join(fixture.root, "runtime.lock")), {
      code: "ENOENT",
    });
    assert.doesNotThrow(() => assertNoLiveApi(subsequent));
  },
);

test(
  "actual runtime wrapper refuses every persistent-path mismatch before spawning its dummy API",
  { skip: nativeRuntimeOnly },
  async (t) => {
    const fixture = await runtimeFixture(t);
    for (const field of ["dataRoot", "databaseUrl", "boxliteHome"]) {
      await fs.writeFile(
        join(fixture.path, ".macmini-release.json"),
        JSON.stringify({
          ...fixture.manifest,
          [field]: join(fixture.root, `unapproved-${field}`),
        }),
      );
      const wrapper = fixture.spawnWrapper();
      assert.deepEqual(await wrapper.exited, [1, null]);
      assert.match(
        wrapper.stderr(),
        /Runtime data differs from the approved release/,
      );
      assert.deepEqual(await fixture.starts(), []);
      await assert.rejects(fs.stat(join(fixture.root, "runtime-state.json")), {
        code: "ENOENT",
      });
      await assert.rejects(fs.stat(join(fixture.root, "runtime.lock")), {
        code: "ENOENT",
      });
    }
  },
);

test("one live controller owns the lock, rejects competitors, and releases after failure", async (t) => {
  const folder = await temporary(t);
  const path = join(folder, "controller.lock");
  let entered;
  let releaseOwner;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise((resolve) => {
    releaseOwner = resolve;
  });
  const first = withLock(path, async () => {
    entered();
    await barrier;
    return { state: "first" };
  });
  await ready;
  assert.deepEqual(
    await withLock(path, async () =>
      assert.fail("Competitor entered live lock"),
    ),
    { state: "locked" },
  );
  releaseOwner();
  assert.deepEqual(await first, { state: "first" });
  await assert.rejects(
    withLock(path, async () => {
      throw new Error("isolated failure");
    }),
    /isolated failure/,
  );
  assert.deepEqual(await withLock(path, async () => ({ state: "retry" })), {
    state: "retry",
  });
});

test("an incomplete or malformed lock owner is never stolen", async (t) => {
  const folder = await temporary(t);
  const path = join(folder, "controller.lock");
  await fs.mkdir(path);
  assert.deepEqual(
    await withLock(path, async () => assert.fail("Incomplete lock entered")),
    { state: "locked" },
  );
  for (const owner of [
    "invalid-json",
    JSON.stringify({ pid: -1 }),
    JSON.stringify({ pid: "42" }),
  ]) {
    await fs.writeFile(join(path, "owner.json"), owner);
    assert.deepEqual(
      await withLock(path, async () => assert.fail("Malformed lock entered")),
      { state: "locked" },
    );
  }
});

test("lock release cannot remove a replacement ownership token", async (t) => {
  const folder = await temporary(t);
  const path = join(folder, "controller.lock");
  await withLock(path, async () => {
    await fs.writeFile(
      join(path, "owner.json"),
      JSON.stringify({ pid: process.pid, token: "replacement" }),
    );
  });
  assert.equal(
    JSON.parse(await fs.readFile(join(path, "owner.json"), "utf8")).token,
    "replacement",
  );
});

test("concurrent stale-lock detection preserves the dead owner until operator recovery, without admitting a compiler", async (t) => {
  const folder = await temporary(t);
  const path = join(folder, "controller.lock");
  await fs.mkdir(path);
  // Positive impossible process identifier: probes existence only, never sends a signal.
  await fs.writeFile(
    join(path, "owner.json"),
    JSON.stringify({ pid: 2147483647, token: "dead-owner" }),
  );
  const outcomes = await Promise.all(
    Array.from({ length: 16 }, () =>
      withLock(path, async () => {
        assert.fail(
          "A dead controller may have left a live compiler; its lock must not be stolen",
        );
      }),
    ),
  );
  for (const result of outcomes)
    assert.deepEqual(result, {
      state: "stale-lock-needs-recovery",
      pid: 2147483647,
    });
  assert.deepEqual(
    JSON.parse(await fs.readFile(join(path, "owner.json"), "utf8")),
    {
      pid: 2147483647,
      token: "dead-owner",
    },
  );
});
