import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ARCHIVE_FILES,
  collectMonitor,
  elapsedSeconds,
  projectLaunchctl,
  redactLog,
  renderHtml,
  writeMonitor,
} from "./jenkins-monitor.mjs";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const PASSCODE = "fixture-access-only";
const COOKIE_SECRET = "fixture-cookie-only";
const MASTER_KEY = "fixture-master-only";
const DEPLOYMENT = {
  ready: true,
  draining: false,
  idle: false,
  readiness: { database: true, provider: true, image: true },
  inFlightHTTP: 0,
  activeWS: 2,
  credentialAuth: 0,
  blockers: {
    sandboxes: 1,
    agentTasks: 0,
    automationRuns: 0,
    enabledAutomations: 0,
    resourceAllocations: 1,
    cloningProjects: 0,
    projectCleanupJobs: 0,
  },
};

async function fixture(t, { passcode = PASSCODE } = {}) {
  const temp = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "jenkins-monitor-")),
  );
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = join(temp, "production");
  await fs.mkdir(root, { mode: 0o700 });
  await fs.mkdir(join(root, "logs"), { mode: 0o700 });
  await fs.mkdir(join(root, "releases", SHA), { recursive: true, mode: 0o700 });
  const config = {
    repository: "Xeonice/agent-platform-api",
    branch: "feat/design-v2-migration",
    ciProvider: "jenkins",
    jenkinsJob: "agent-platform-api",
    launchdDomain: `gui/${process.getuid()}`,
    root,
    uid: process.getuid(),
    node: process.execPath,
    corepack: join(temp, "corepack.js"),
    runtimeEnvFile: join(root, "runtime.env"),
    runtimePlist: join(temp, "api.plist"),
    deployEnabled: true,
    minimumCommit: SHA,
    channelStartedAt: "2026-10-06T00:00:00.000Z",
  };
  const write = (path, value) =>
    fs.writeFile(
      path,
      typeof value === "string" ? value : JSON.stringify(value),
      { mode: 0o600 },
    );
  const configPath = join(root, "config.json");
  await write(configPath, config);
  await write(
    config.runtimeEnvFile,
    `HOST=127.0.0.1\nPORT=3101\nACCESS_PASSCODE=${passcode}\nPASSCODE_COOKIE_SECRET=${COOKIE_SECRET}\nMASTER_KEY=${MASTER_KEY}\n`,
  );
  await write(join(root, "status.json"), {
    state: "deployed",
    sha: SHA,
    runId: 42,
    updatedAt: "2026-10-06T02:00:00.000Z",
    error: null,
    token: "should-never-be-projected",
  });
  await write(join(root, "runtime-state.json"), {
    pid: 123,
    supervisorPid: 122,
    sha: SHA,
    startedAt: "2026-10-06T02:00:00.000Z",
    environment: { secret: PASSCODE },
  });
  await write(join(root, "releases", SHA, ".macmini-release.json"), {
    sha: SHA,
    builtAt: "2026-10-06T01:00:00.000Z",
    schemaHash: "c".repeat(64),
    boxliteVersion: "0.9.7",
    databaseUrl: "private-data-path",
    dataRoot: "private-data-path",
    boxliteHome: "private-data-path",
    cookie: COOKIE_SECRET,
  });
  await fs.symlink(join(root, "releases", SHA), join(root, "current"));
  for (const name of ["api", "tunnel", "cicd", `build-${SHA}`])
    await write(
      join(root, "logs", `${name}.log`),
      `normal ${name} started\nAuthorization: Bearer ${passcode}\nCookie: ap_session=${COOKIE_SECRET}\nkey value ${MASTER_KEY}\n`,
    );
  await write(join(root, "cloudflared.token"), "must-not-read-this-token-file");
  const calls = [];
  const requests = [];
  const operations = {
    metadata: {
      BUILD_NUMBER: "12",
      JOB_NAME: "agent-platform-monitor",
      BUILD_URL: "http://127.0.0.1:8080/job/monitor/12/?access=private",
      GH_TOKEN: "never-inherit",
      NODE_OPTIONS: "never-inherit",
    },
    kill: (pid, signal) => {
      assert.equal(pid, 123);
      assert.equal(signal, 0);
    },
    execute: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "/bin/ps") return { stdout: "1-02:03:04\n" };
      assert.equal(command, "/bin/launchctl");
      assert.equal(args[0], "print");
      return {
        stdout: `${args[1]} = {\n\tstate = running\n\tpid = 122\n\truns = 3\n\tlast exit code = 0\n\tenvironment = {\n\t\tACCESS_PASSCODE = ${passcode}\n\t\tpid = 99999\n\t}\n}\n`,
      };
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      const value = url.endsWith("/health")
        ? { status: "ok", uptimeSec: 120, cookie: COOKIE_SECRET }
        : url.endsWith("/version")
          ? {
              version: SHA.slice(0, 12),
              commit: SHA,
              builtAt: "2026-10-06T01:00:00.000Z",
              passcode,
            }
          : { ...DEPLOYMENT, rawEnvironment: { passcode } };
      return Response.json(value);
    },
  };
  return { temp, root, config, configPath, write, operations, calls, requests };
}

test("trusted monitor verifies authenticated production probes and preserves real non-idle blockers without leaking inputs", async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(f.config.runtimeEnvFile, "utf8");
  const snapshot = await collectMonitor(f.configPath, f.operations);
  assert.equal(snapshot.report.health, "healthy");
  assert.equal(snapshot.report.api.deployment.idle, false);
  assert.equal(snapshot.report.api.deployment.activeWS, 2);
  assert.equal(snapshot.report.api.deployment.blockers.sandboxes, 1);
  assert.equal(snapshot.report.runtime.uptimeSec, 93784);
  assert.equal(snapshot.report.services[0].pid, 122);
  assert.equal(snapshot.report.release.sha, SHA);
  assert.equal(
    snapshot.report.jenkins.buildUrl,
    "http://127.0.0.1:8080/job/monitor/12/",
  );
  for (const { url, options } of f.requests) {
    assert.match(url, /^http:\/\/127\.0\.0\.1:3101\/api\//);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.equal(
      options.headers.authorization,
      url.endsWith("/health") ? undefined : `Bearer ${PASSCODE}`,
    );
  }
  for (const call of f.calls) {
    assert.deepEqual(Object.keys(call.options.env).sort(), ["LANG", "PATH"]);
    assert.doesNotMatch(
      JSON.stringify(call),
      /fixture-access-only|never-inherit|Cookie|NODE_OPTIONS|GH_TOKEN/,
    );
  }
  const all = JSON.stringify(snapshot);
  for (const forbidden of [
    PASSCODE,
    COOKIE_SECRET,
    MASTER_KEY,
    "private-data-path",
    "rawEnvironment",
    "should-never-be-projected",
    "must-not-read-this-token-file",
  ])
    assert.equal(all.includes(forbidden), false);
  assert.equal(await fs.readFile(f.config.runtimeEnvFile, "utf8"), before);
});

test("HTTP liveness alone cannot mark protected readiness/version as verified", async (t) => {
  const f = await fixture(t);
  f.operations.fetch = async (url) =>
    url.endsWith("/health")
      ? Response.json({ status: "ok", uptimeSec: 12 })
      : new Response(JSON.stringify({ passcode: PASSCODE }), { status: 401 });
  const { report } = await collectMonitor(f.configPath, f.operations);
  assert.equal(report.health, "unhealthy");
  assert.equal(report.api.health.ok, true);
  assert.equal(report.api.deployment.reason, "unauthorized");
  assert.equal(report.api.version.reason, "unauthorized");
  assert.equal(JSON.stringify(report).includes(PASSCODE), false);
});

test("wrong API SHA, false readiness and nonrunning persistent tunnel fail required checks", async (t) => {
  const f = await fixture(t);
  const fetch = f.operations.fetch;
  f.operations.fetch = async (url, options) =>
    url.endsWith("/version")
      ? Response.json({
          commit: OTHER_SHA,
          version: OTHER_SHA.slice(0, 12),
          builtAt: null,
        })
      : url.endsWith("/status")
        ? Response.json({
            ...DEPLOYMENT,
            ready: false,
            readiness: { ...DEPLOYMENT.readiness, image: false },
          })
        : fetch(url, options);
  const execute = f.operations.execute;
  f.operations.execute = async (command, args, options) =>
    command === "/bin/launchctl" && args[1].endsWith(".tunnel")
      ? { stdout: "service = {\n\tstate = waiting\n}" }
      : execute(command, args, options);
  const { report } = await collectMonitor(f.configPath, f.operations);
  assert.equal(report.health, "unhealthy");
  assert.ok(report.problems.includes("api-release-sha-unverified"));
  assert.ok(report.problems.includes("api-readiness-unverified"));
  assert.ok(report.problems.includes("tunnel-launchd-not-running"));
});

test("dead or unverifiable PID cannot be presented as running; only signal zero is used", async (t) => {
  const f = await fixture(t);
  for (const [code, expected] of [
    ["ESRCH", "dead"],
    ["EPERM", "unknown"],
  ]) {
    f.operations.kill = (_pid, signal) => {
      assert.equal(signal, 0);
      throw Object.assign(new Error("native detail must not leak"), { code });
    };
    const { report } = await collectMonitor(f.configPath, f.operations);
    assert.equal(report.runtime.processState, expected);
    assert.equal(report.runtime.uptimeSec, null);
    assert.ok(report.problems.includes("api-process-unverified"));
    assert.equal(JSON.stringify(report).includes("native detail"), false);
  }
});

test("failed launchctl, malformed probes and arbitrary HTTP error bodies are projected as safe diagnostics", async (t) => {
  const f = await fixture(t);
  f.operations.execute = async () => {
    throw new Error(`Authorization: ${PASSCODE}`);
  };
  f.operations.fetch = async (url) =>
    url.endsWith("/health")
      ? new Response(`cookie=${COOKIE_SECRET}`, { status: 503 })
      : Response.json({ ...DEPLOYMENT, ready: "true", apiKey: MASTER_KEY });
  const { report } = await collectMonitor(f.configPath, f.operations);
  assert.equal(report.api.health.httpStatus, 503);
  assert.equal(report.api.health.reason, "http-error");
  assert.equal(report.api.deployment.reason, "unavailable");
  assert.equal(
    report.services.every((service) => !service.loaded),
    true,
  );
  assert.equal(JSON.stringify(report).includes(PASSCODE), false);
  assert.equal(JSON.stringify(report).includes(COOKIE_SECRET), false);
  assert.equal(JSON.stringify(report).includes(MASTER_KEY), false);
});

test("oversized streamed HTTP responses are cancelled before parsing or recording arbitrary bytes", async (t) => {
  const f = await fixture(t);
  let cancelled = false;
  const original = f.operations.fetch;
  f.operations.fetch = async (url, options) => {
    if (!url.endsWith("/status")) return original(url, options);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(40000));
          controller.enqueue(new Uint8Array(40000));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  };
  const { report } = await collectMonitor(f.configPath, f.operations);
  assert.equal(cancelled, true);
  assert.equal(report.api.deployment.ok, false);
  assert.equal(report.health, "unhealthy");
});

test("private configuration boundaries reject alternate runtime files, symlinks, broad permissions and preview ports before probes", async (t) => {
  const f = await fixture(t);
  await f.write(f.configPath, {
    ...f.config,
    runtimeEnvFile: join(f.temp, "other.env"),
  });
  await assert.rejects(collectMonitor(f.configPath, f.operations), /boundary/);
  await f.write(f.configPath, f.config);
  await fs.chmod(f.config.runtimeEnvFile, 0o644);
  await assert.rejects(
    collectMonitor(f.configPath, f.operations),
    /unsafe-file/,
  );
  await fs.chmod(f.config.runtimeEnvFile, 0o600);
  const original = await fs.readFile(f.config.runtimeEnvFile, "utf8");
  await f.write(
    f.config.runtimeEnvFile,
    original.replace("PORT=3101", "PORT=3100"),
  );
  await assert.rejects(
    collectMonitor(f.configPath, f.operations),
    /production loopback/,
  );
  await fs.rename(f.config.runtimeEnvFile, join(f.temp, "real.env"));
  await fs.symlink(join(f.temp, "real.env"), f.config.runtimeEnvFile);
  await assert.rejects(collectMonitor(f.configPath, f.operations));
  assert.equal(f.calls.length, 0);
  assert.equal(f.requests.length, 0);
});

test("escaped current-release target and malicious status fields never escape projection into reports or build-log paths", async (t) => {
  const f = await fixture(t);
  await fs.unlink(join(f.root, "current"));
  await fs.symlink(f.temp, join(f.root, "current"));
  await f.write(join(f.root, "status.json"), {
    state: "../../runtime.env",
    sha: "../../runtime.env",
    runId: -1,
    error: `ACCESS_PASSCODE=${PASSCODE}`,
    rawConfig: f.config,
  });
  const snapshot = await collectMonitor(f.configPath, f.operations);
  assert.equal(snapshot.report.release.available, false);
  assert.equal(snapshot.report.controller.state, "unknown");
  assert.equal(snapshot.report.controller.sha, null);
  assert.equal(snapshot.logs.build.available, false);
  assert.equal(JSON.stringify(snapshot).includes(PASSCODE), false);
  assert.equal(
    JSON.stringify(snapshot).includes(f.config.runtimeEnvFile),
    false,
  );
});

test("log tails are bounded by bytes and lines, and discard partial leading/trailing secret fragments", async (t) => {
  const f = await fixture(t);
  await f.write(
    join(f.root, "logs", "api.log"),
    `${"initial-partial-secret".repeat(5000)}\n${Array.from({ length: 250 }, (_, index) => `normal row ${index}`).join("\n")}\n${PASSCODE.slice(0, 12)}`,
  );
  const { logs } = await collectMonitor(f.configPath, f.operations);
  assert.equal(logs.api.truncated, true);
  assert.ok(logs.api.sourceBytes > 65536);
  assert.ok(logs.api.content.split("\n").length <= 201);
  assert.ok(Buffer.byteLength(logs.api.content) <= 65536);
  assert.equal(logs.api.content.includes("initial-partial-secret"), false);
  assert.equal(logs.api.content.includes(PASSCODE.slice(0, 12)), false);
  assert.ok(logs.api.content.includes("normal row 249"));
});

test("symlinked log files and directories are unavailable instead of following arbitrary private targets", async (t) => {
  const f = await fixture(t);
  const target = join(f.temp, "private-source");
  await f.write(target, "unlabelled-private-material\n");
  await fs.unlink(join(f.root, "logs", "api.log"));
  await fs.symlink(target, join(f.root, "logs", "api.log"));
  let snapshot = await collectMonitor(f.configPath, f.operations);
  assert.equal(snapshot.logs.api.available, false);
  await fs.rename(join(f.root, "logs"), join(f.temp, "external-logs"));
  await fs.symlink(join(f.temp, "external-logs"), join(f.root, "logs"));
  snapshot = await collectMonitor(f.configPath, f.operations);
  assert.equal(
    Object.values(snapshot.logs).every((log) => !log.available),
    true,
  );
  assert.equal(
    JSON.stringify(snapshot).includes("unlabelled-private-material"),
    false,
  );
});

test("log redaction covers labelled credentials, opaque provider tokens, cookie dumps and credential-bearing URLs", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const gh = "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const tunnel = Buffer.from(
    JSON.stringify({
      a: "mockaccount",
      t: "mocktunnel",
      s: "mock-provider-secret",
    }),
  ).toString("base64");
  const output = redactLog(
    `normal started\ncommit ${SHA}\nAuthorization: Basic tiny\n{\"cookies\": [\"tiny\"]}\nrefresh_token=tiny\nHOST=127.0.0.1\nURL https://user:tiny@example.com/path?code=tiny\n${jwt}\n${gh}\n${tunnel}\nvalue ${PASSCODE}\nvalue ${encodeURIComponent(PASSCODE)}\nvalue ${Buffer.from(PASSCODE).toString("base64")}\n\x1b[31mred\x1b[0m`,
    [PASSCODE],
    [SHA],
  );
  assert.ok(output.includes("normal started"));
  assert.ok(output.includes(`commit ${SHA}`));
  for (const value of [
    "Basic tiny",
    "tiny",
    "127.0.0.1",
    jwt,
    gh,
    tunnel,
    PASSCODE,
    encodeURIComponent(PASSCODE),
    Buffer.from(PASSCODE).toString("base64"),
    "\x1b",
  ])
    assert.equal(output.includes(value), false);
  assert.ok(output.includes("https://example.com/path?redacted"));
});

test("launchctl projection takes only top-level service fields and elapsed parser retains multi-day uptime", () => {
  const result = projectLaunchctl(
    `service = {\n\tenvironment = {\n\t\tpid = 99999\n\t\tstate = secret\n\t}\n\tstate = running\n\tpid = 123\n\truns = 4\n\tlast exit code = -9\n}`,
    "gui/501",
    "safe-label",
  );
  assert.equal(result.pid, 123);
  assert.equal(result.state, "running");
  assert.equal(result.lastExitCode, -9);
  assert.equal(elapsedSeconds("3-04:05:06"), 273906);
  assert.equal(elapsedSeconds("12:34"), 754);
  assert.equal(elapsedSeconds("not available"), null);
});

test("final string redaction cannot corrupt boolean/null JSON when a passcode resembles a JSON keyword", async (t) => {
  const f = await fixture(t, { passcode: "true" });
  f.operations.metadata.JOB_NAME = "true-monitor";
  const { report } = await collectMonitor(f.configPath, f.operations);
  assert.equal(report.api.deployment.ready, true);
  assert.equal(report.health, "healthy");
  assert.equal(report.jenkins.jobName, "[REDACTED]-monitor");
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));
});

test("system launchd domain is respected and retired CI LaunchAgent is diagnostic only", async (t) => {
  const f = await fixture(t);
  await f.write(f.configPath, {
    ...f.config,
    launchdDomain: "system",
    serviceHelper:
      "/Library/PrivilegedHelperTools/com.douglasdong.agent-platform-service",
    runtimePlist:
      "/Library/LaunchDaemons/com.douglasdong.agent-platform.api.plist",
  });
  const original = f.operations.execute;
  f.operations.execute = async (command, args, options) => {
    if (command === "/bin/launchctl" && args[1].endsWith(".cicd"))
      throw new Error("retired");
    return original(command, args, options);
  };
  const { report } = await collectMonitor(f.configPath, f.operations);
  assert.equal(report.health, "healthy");
  assert.equal(report.services[0].domain, "system");
  assert.equal(report.services[2].domain, "system");
  assert.equal(report.services[1].loaded, false);
  assert.equal(report.services[1].required, false);
});

test("fresh reports may use the designated Jenkins workspace without writing into production inputs", async (t) => {
  const f = await fixture(t);
  const snapshot = await collectMonitor(f.configPath, f.operations);
  const workspace = join(f.root, "jenkins-agent", "workspace", "monitor");
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  await writeMonitor(join(workspace, "runtime-report-12"), snapshot, f.root);
  assert.deepEqual(
    (await fs.readdir(join(workspace, "runtime-report-12"))).sort(),
    [...ARCHIVE_FILES].sort(),
  );
  await assert.rejects(
    writeMonitor(join(f.root, "logs", "report"), snapshot, f.root),
    /separate/,
  );
});

test("archive output is a fresh private directory containing exactly the whitelist and escaped inert HTML", async (t) => {
  const f = await fixture(t);
  const snapshot = await collectMonitor(f.configPath, f.operations);
  snapshot.report.controller.error = '<script>alert("x")</script>';
  const output = join(f.temp, "monitor-12");
  await writeMonitor(output, snapshot, f.root);
  assert.deepEqual(
    (await fs.readdir(output)).sort(),
    [...ARCHIVE_FILES].sort(),
  );
  assert.equal((await fs.stat(output)).mode & 0o777, 0o700);
  for (const name of ARCHIVE_FILES) {
    assert.equal((await fs.stat(join(output, name))).mode & 0o777, 0o600);
    const content = await fs.readFile(join(output, name), "utf8");
    for (const value of [PASSCODE, COOKIE_SECRET, MASTER_KEY])
      assert.equal(content.includes(value), false);
  }
  const html = renderHtml(snapshot.report);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.equal(html.includes("<script>"), false);
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes("<table>"));
  await assert.rejects(writeMonitor(output, snapshot, f.root), {
    code: "EEXIST",
  });
  await assert.rejects(
    writeMonitor(join(f.root, "reports"), snapshot, f.root),
    /separate/,
  );
  const symlink = join(f.temp, "output-link");
  await fs.symlink(output, symlink);
  await assert.rejects(writeMonitor(symlink, snapshot, f.root), {
    code: "EEXIST",
  });
});
