import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { lstatSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BLOCKER_NAMES,
  cutoverStatus,
  readCutoverStatus,
  operatorPreflight,
  safeWorkerFailure,
  cutoverAfterPreflight,
  holdCutoverAdmission,
  waitCutoverQuiet,
  recoverUnstoppedApi,
  validateGuiTunnelPlist,
  dedicatedTunnelExited,
  waitDedicatedTunnelExit,
  tunnelListenerMetadata,
  tunnelJobMetadata,
  restoreTunnelAfterExit,
} from "./install-system-services.mjs";
import { DEPLOY_ROOT, servicePlist } from "./system-services.mjs";
import { releaseMaintenanceBarrier } from "./lib.mjs";
const sha = "a".repeat(40);
const status = () => ({
  ready: true,
  idle: true,
  draining: false,
  readiness: { database: true, provider: true, image: true },
  activeWS: 0,
  inFlightHTTP: 0,
  credentialAuth: 0,
  blockers: Object.fromEntries(BLOCKER_NAMES.map((name) => [name, 0])),
});

const tunnelMetadata = {
  tunnelId: "b59b8cc0-571a-46ec-bf21-1a01b78670a4",
  hostname: "agent-api.douglasdong.com",
  service: "http://127.0.0.1:3101",
};
const tunnelConfig = {
  uid: 501,
  root: DEPLOY_ROOT,
  runtimeEnvFile: join(DEPLOY_ROOT, "runtime.env"),
  node: process.execPath,
};
// Actual GUI plist's safe public fields captured read-only on 2026-10-06.
// It predates the generator's explicit EnvironmentVariables/ProcessType.
const historicalTunnelPlist = {
  KeepAlive: true,
  Umask: 63,
  ExitTimeOut: 30,
  ThrottleInterval: 20,
  StandardOutPath: join(DEPLOY_ROOT, "logs/tunnel.log"),
  StandardErrorPath: join(DEPLOY_ROOT, "logs/tunnel.log"),
  ProgramArguments: [
    "/opt/homebrew/bin/cloudflared",
    "tunnel",
    "--no-autoupdate",
    "--metrics",
    "127.0.0.1:20241",
    "run",
    "--token-file",
    join(DEPLOY_ROOT, "cloudflared.token"),
  ],
  WorkingDirectory: DEPLOY_ROOT,
  RunAtLoad: true,
  Label: "com.douglasdong.agent-platform.tunnel",
};

test("actual historical dedicated GUI plist and current generated plist both validate without changing service/config/token", () => {
  assert.equal(
    validateGuiTunnelPlist(historicalTunnelPlist, tunnelConfig, tunnelMetadata),
    true,
  );
  const generated = spawnSync(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", "--", "-"],
    { input: servicePlist("tunnel", tunnelConfig), encoding: "utf8" },
  );
  assert.equal(generated.status, 0);
  const plist = JSON.parse(generated.stdout);
  assert.equal(
    validateGuiTunnelPlist(plist, tunnelConfig, tunnelMetadata),
    true,
  );
  assert.equal(plist.EnvironmentVariables.HOME, "/Users/douglasdong");
  assert.equal(plist.ProcessType, "Background");
});

test("legacy compatibility never permits changed executable, UID/home, token-file, label, extra launchd directives, UUID or production target", () => {
  for (const altered of [
    { Label: "other.tunnel" },
    { ProgramArguments: ["/bin/sh", "-c", "command"] },
    {
      ProgramArguments: [
        ...historicalTunnelPlist.ProgramArguments,
        "b59b8cc0-571a-46ec-bf21-1a01b78670a4",
      ],
    },
    {
      ProgramArguments: historicalTunnelPlist.ProgramArguments.map((value) =>
        value.endsWith("cloudflared.token") ? "/tmp/other.token" : value,
      ),
    },
    { WorkingDirectory: "/tmp" },
    { UserName: "root" },
    { EnvironmentVariables: { HOME: "/var/root" } },
    { ProcessType: "Interactive" },
    { Program: "/bin/sh" },
    { toString: "unknown directive" },
    { StandardOutPath: "/tmp/tunnel.log" },
    { Umask: 0 },
    { ExitTimeOut: 300 },
  ])
    assert.throws(
      () =>
        validateGuiTunnelPlist(
          { ...historicalTunnelPlist, ...altered },
          tunnelConfig,
          tunnelMetadata,
        ),
      /fixed dedicated production service/,
    );
  for (const altered of [
    { tunnelId: "00000000-0000-0000-0000-000000000000" },
    { hostname: "cap-api.douglasdong.com" },
    { service: "http://127.0.0.1:3100" },
    { secret: "unapproved metadata" },
  ])
    assert.throws(
      () =>
        validateGuiTunnelPlist(historicalTunnelPlist, tunnelConfig, {
          ...tunnelMetadata,
          ...altered,
        }),
      /fixed dedicated production service/,
    );
  assert.throws(
    () =>
      validateGuiTunnelPlist(
        historicalTunnelPlist,
        { ...tunnelConfig, uid: 0 },
        tunnelMetadata,
      ),
    /UID501/,
  );
});

test("preflight uses only authenticated GET snapshots and returns counts/readiness without runtime secrets or payload extras", async () => {
  const source = {
    ...status(),
    idle: false,
    activeWS: 2,
    accessPasscode: "must-not-appear",
    details: { token: "must-not-appear" },
  };
  const calls = [];
  const headers = { authorization: "Bearer fixture-only-value" };
  const snapshot = await readCutoverStatus(
    "http://127.0.0.1:3101",
    headers,
    sha,
    async (url, options) => {
      calls.push({ url, options });
      return Response.json(url.endsWith("/status") ? source : { commit: sha });
    },
  );
  assert.equal(snapshot.activeWS, 2);
  assert.equal(snapshot.idle, false);
  assert.equal(snapshot.ready, true);
  assert.deepEqual(snapshot.blockers, status().blockers);
  assert.equal(JSON.stringify(snapshot).includes("must-not-appear"), false);
  assert.equal(JSON.stringify(snapshot).includes("fixture-only-value"), false);
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "http://127.0.0.1:3101/api/deployment/status",
      "http://127.0.0.1:3101/api/system/version",
    ],
  );
  assert.equal(
    calls.every(
      (call) =>
        call.options.method === undefined &&
        call.options.body === undefined &&
        call.options.headers === headers,
    ),
    true,
  );
});

test("work preflight refuses before real config/poller mutation or rollback trace even when residual sockets could be disconnected", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "cutover-preflight-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = join(root, "config.json"),
    poller = join(root, "poller.plist"),
    trace = join(root, "transition.json");
  await fs.writeFile(config, '{"deployEnabled":true}\n');
  await fs.writeFile(poller, "unchanged poller");
  const before = await fs.readFile(config);
  await assert.rejects(
    () =>
      cutoverAfterPreflight(
        async () => ({
          ...status(),
          sha,
          idle: false,
          activeWS: 2,
          inFlightHTTP: 1,
        }),
        true,
        async () => {
          await fs.writeFile(config, '{"deployEnabled":false}');
          await fs.unlink(poller);
          await fs.writeFile(trace, "changed");
        },
      ),
    (error) =>
      /activeWS=2/.test(error.message) &&
      /inFlightHTTP=1/.test(error.message) &&
      /credentialAuth=0/.test(error.message) &&
      /blockers=sandboxes:0/.test(error.message) &&
      /no configuration or services were changed/.test(error.message),
  );
  assert.deepEqual(await fs.readFile(config), before);
  assert.equal(await fs.readFile(poller, "utf8"), "unchanged poller");
  await assert.rejects(fs.access(trace));
});

test("operator preflight checks every blocker, HTTP/auth and readiness; only reviewed Tunnel sockets are eligible", async () => {
  for (const field of ["inFlightHTTP", "credentialAuth"])
    await assert.rejects(
      operatorPreflight(async () => ({ ...status(), sha, [field]: 1 }), true),
      /busy/,
    );
  for (const name of BLOCKER_NAMES)
    await assert.rejects(
      operatorPreflight(
        async () => ({
          ...status(),
          sha,
          blockers: { ...status().blockers, [name]: 1 },
        }),
        true,
      ),
      new RegExp(name + ":1"),
    );
  await assert.rejects(
    operatorPreflight(
      async () => ({
        ...status(),
        sha,
        readiness: { ...status().readiness, image: false },
      }),
      true,
    ),
    /ready=false/,
  );
  await assert.rejects(
    operatorPreflight(async () => ({ ...status(), sha, draining: true }), true),
    /already draining/,
  );
  assert.equal(
    (await operatorPreflight(async () => ({ ...status(), sha }), false)).idle,
    true,
  );
  const sockets = { ...status(), sha, idle: false, activeWS: 2 };
  assert.equal(
    (await operatorPreflight(async () => sockets, true)).activeWS,
    2,
  );
  await assert.rejects(
    operatorPreflight(async () => sockets, false),
    /validated dedicated GUI Tunnel/,
  );
  for (const bad of [
    { ...status(), activeWS: -1 },
    { ...status(), credentialAuth: 0.2 },
    { ...status(), inFlightHTTP: undefined },
    { ...status(), blockers: {} },
    { ...status(), blockers: { ...status().blockers, newUnknownWork: 0 } },
  ])
    assert.throws(() => cutoverStatus(bad, sha), /invalid status/);
  await assert.rejects(
    readCutoverStatus(
      "http://127.0.0.1:3101",
      {},
      sha,
      async () => new Response("", { status: 401 }),
    ),
    /status failed \(401\)/,
  );
  await assert.rejects(
    readCutoverStatus("http://127.0.0.1:3101", {}, sha, async (url) =>
      Response.json(
        url.endsWith("/status") ? status() : { commit: "b".repeat(40) },
      ),
    ),
    /current release/,
  );
});

async function barrierFixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "operator-cutover-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const path = join(root, "maintenance"),
    heldPath = join(root, "held.json");
  const owns = () => {
    try {
      const stat = lstatSync(path);
      return (
        stat.isFile() &&
        stat.dev === held.dev &&
        stat.ino === held.ino &&
        readFileSync(path, "utf8") === held.contents
      );
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  };
  let held;
  return {
    root,
    path,
    heldPath,
    owns,
    setHeld: (value) => {
      held = value;
    },
  };
}

test("operator admission holds a real private owner barrier while sockets remain; backup can proceed only after ten continuous seconds of full idle", async (t) => {
  const f = await barrierFixture(t);
  let draining = false;
  const held = await holdCutoverAdmission(f.path, f.heldPath, async () => {
    draining = Boolean(await fs.lstat(f.path).catch(() => null));
    return { ...status(), sha, draining, idle: false, activeWS: 2 };
  });
  f.setHeld(held);
  assert.equal(f.owns(), true);
  assert.equal((await fs.stat(f.path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await fs.readFile(f.heldPath, "utf8")), held);
  const events = ["hold-admission", "dedicated-tunnel-stopped"];
  let clock = 0;
  const result = await waitCutoverQuiet(
    async () => ({
      ...status(),
      sha,
      draining,
      idle: clock >= 2000,
      activeWS: clock >= 2000 ? 0 : 2,
    }),
    f.owns,
    {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
  );
  events.push("full-idle-ten-seconds");
  await fs.writeFile(join(f.root, "backup-started"), String(clock));
  events.push("backup");
  assert.equal(clock, 12_000);
  assert.equal(result.idle, true);
  assert.equal(f.owns(), true);
  assert.deepEqual(events, [
    "hold-admission",
    "dedicated-tunnel-stopped",
    "full-idle-ten-seconds",
    "backup",
  ]);
});

test("work appearing during admission refuses and removes only the exact barrier it created", async (t) => {
  const f = await barrierFixture(t);
  let attempts = 0;
  await assert.rejects(
    holdCutoverAdmission(f.path, f.heldPath, async () => {
      attempts++;
      return {
        ...status(),
        sha,
        draining: attempts > 1,
        credentialAuth: attempts > 1 ? 1 : 0,
      };
    }),
    /became busy/,
  );
  await assert.rejects(fs.access(f.path));
  assert.equal(JSON.parse(await fs.readFile(f.heldPath, "utf8")).owned, true);
});

test("admission refuses existing manual maintenance and preserves operator replacement even on its error path", async (t) => {
  const f = await barrierFixture(t);
  await fs.writeFile(f.path, "manual", { mode: 0o600 });
  await assert.rejects(
    holdCutoverAdmission(f.path, f.heldPath, async () => ({
      ...status(),
      sha,
    })),
    /already exists/,
  );
  assert.equal(await fs.readFile(f.path, "utf8"), "manual");
  await assert.rejects(fs.access(f.heldPath));
  await fs.unlink(f.path);
  let attempts = 0;
  await assert.rejects(
    holdCutoverAdmission(f.path, f.heldPath, async () => {
      if (++attempts > 1) {
        await fs.unlink(f.path);
        await fs.writeFile(f.path, "operator replacement", { mode: 0o600 });
      }
      return {
        ...status(),
        sha,
        draining: attempts > 1,
        inFlightHTTP: attempts > 1 ? 1 : 0,
      };
    }),
    /became busy/,
  );
  assert.equal(await fs.readFile(f.path, "utf8"), "operator replacement");
});

test("quiet interval resets on returning sockets and rejects real work, unknown tables or loss of owner without stopping API", async (t) => {
  const f = await barrierFixture(t);
  const held = await holdCutoverAdmission(f.path, f.heldPath, async () => ({
    ...status(),
    sha,
    draining: Boolean(await fs.lstat(f.path).catch(() => null)),
  }));
  f.setHeld(held);
  let clock = 0;
  await waitCutoverQuiet(
    async () => ({
      ...status(),
      sha,
      draining: true,
      idle: clock !== 5000,
      activeWS: clock === 5000 ? 1 : 0,
    }),
    f.owns,
    {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
  );
  assert.equal(clock, 16_000);
  for (const changed of [
    { credentialAuth: 1 },
    { inFlightHTTP: 1 },
    { blockers: { ...status().blockers, agentTasks: 1 } },
    { blockers: { ...status().blockers, unknownTable: 0 } },
    { ready: false },
  ]) {
    await assert.rejects(
      waitCutoverQuiet(
        async () => ({ ...status(), sha, draining: true, ...changed }),
        f.owns,
      ),
      /busy|invalid status/,
    );
    assert.equal(f.owns(), true);
  }
  await fs.unlink(f.path);
  await fs.writeFile(f.path, "manual replacement", { mode: 0o600 });
  await assert.rejects(
    waitCutoverQuiet(
      async () => ({ ...status(), sha, draining: true }),
      f.owns,
    ),
    /ownership changed/,
  );
  assert.equal(await fs.readFile(f.path, "utf8"), "manual replacement");
});

test("persistent sockets time out with admission still held and no backup/API stop", async (t) => {
  const f = await barrierFixture(t);
  const held = await holdCutoverAdmission(f.path, f.heldPath, async () => ({
    ...status(),
    sha,
    draining: Boolean(await fs.lstat(f.path).catch(() => null)),
    idle: false,
    activeWS: 2,
  }));
  f.setHeld(held);
  let clock = 0;
  await assert.rejects(
    waitCutoverQuiet(
      async () => ({
        ...status(),
        sha,
        draining: true,
        idle: false,
        activeWS: 2,
      }),
      f.owns,
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        timeoutMs: 12_000,
      },
    ),
    /ten seconds/,
  );
  assert.equal(f.owns(), true);
  await assert.rejects(fs.access(join(f.root, "backup-started")));
});

const tunnelIdentity = {
  pid: 12345,
  uid: 501,
  command: "/opt/homebrew/bin/cloudflared",
};
const liveTunnelSnapshot = () => ({
  process: { ...tunnelIdentity },
  listeners: [{ pid: tunnelIdentity.pid, uid: 501, command: "cloudflared" }],
  job: null,
});

test("actual macOS lsof process fields include mandatory fd records; ownership parser keeps all process owners and rejects malformed records", () => {
  assert.deepEqual(
    tunnelListenerMetadata("p58098\nccloudflared\nu501\nf10\n"),
    [{ pid: 58098, command: "cloudflared", uid: 501 }],
  );
  assert.deepEqual(
    tunnelListenerMetadata(
      "p12345\nccloudflared\nu501\nf10\nf11\np9999\ncother-service\nu0\nf12\n",
    ),
    [
      { pid: 12345, command: "cloudflared", uid: 501 },
      { pid: 9999, command: "other-service", uid: 0 },
    ],
  );
  assert.deepEqual(tunnelListenerMetadata(""), []);
  for (const bad of [
    "f10\n",
    "p123\nu501\nunknown\n",
    "p123\nu501\nfnot-a-descriptor\n",
  ])
    assert.throws(() => tunnelListenerMetadata(bad), /Cannot inspect/);
});

test("launchd job metadata keeps the original PID while printable, and missing PID still requires registry removal", () => {
  const running = tunnelJobMetadata(
    "gui/501/com.douglasdong.agent-platform.tunnel = {\n\tstate = running\n\tprogram = /opt/homebrew/bin/cloudflared\n\tpid = 12345\n}\n",
  );
  assert.deepEqual(running, {
    pid: 12345,
    program: tunnelIdentity.command,
    state: "running",
  });
  assert.equal(
    dedicatedTunnelExited(tunnelIdentity, {
      ...liveTunnelSnapshot(),
      job: running,
    }),
    false,
  );
  const pending = tunnelJobMetadata(
    "gui/501/com.douglasdong.agent-platform.tunnel = {\n\tstate = not running\n\tprogram = /opt/homebrew/bin/cloudflared\n}\n",
  );
  assert.equal(pending.pid, null);
  assert.equal(
    dedicatedTunnelExited(tunnelIdentity, {
      process: null,
      listeners: [],
      job: pending,
    }),
    false,
  );
  assert.equal(
    dedicatedTunnelExited(tunnelIdentity, {
      process: null,
      listeners: [],
      job: null,
    }),
    true,
  );
  assert.throws(
    () =>
      tunnelJobMetadata("state = running\nprogram = /bin/other\npid = 12345\n"),
    /ownership changed/,
  );
});

test("dedicated Tunnel's real thirty-second graceful boundary is allowed; original PID and metrics must both release before quiet/backup", async (t) => {
  const f = await barrierFixture(t);
  f.setHeld(
    await holdCutoverAdmission(f.path, f.heldPath, async () => ({
      ...status(),
      sha,
      draining: Boolean(await fs.lstat(f.path).catch(() => null)),
    })),
  );
  let clock = 0;
  const sampled = [];
  await waitDedicatedTunnelExit(
    tunnelIdentity,
    async () => {
      sampled.push(clock);
      return {
        process: clock < 30_250 ? { ...tunnelIdentity } : null,
        listeners: clock < 30_000 ? liveTunnelSnapshot().listeners : [],
        job:
          clock < 32_000
            ? {
                pid: tunnelIdentity.pid,
                program: tunnelIdentity.command,
                state: "running",
              }
            : null,
      };
    },
    f.owns,
    {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
  );
  assert.equal(clock, 32_000);
  assert.equal(sampled.includes(30_000), true);
  assert.equal(f.owns(), true);
  await fs.writeFile(join(f.root, "quiet-gate-can-begin"), String(clock));
  assert.equal(
    await fs.readFile(join(f.root, "quiet-gate-can-begin"), "utf8"),
    "32000",
  );
});

test("metrics closing first never permits replacing a still-live PID; PID exiting first still waits for the metrics release", async () => {
  for (const [pidEnds, metricsEnd, expected] of [
    [3500, 1000, 4000],
    [1000, 5000, 5000],
  ]) {
    let clock = 0;
    await waitDedicatedTunnelExit(
      tunnelIdentity,
      async () => ({
        process: clock < pidEnds ? { ...tunnelIdentity } : null,
        listeners: clock < metricsEnd ? liveTunnelSnapshot().listeners : [],
        job: null,
      }),
      async () => true,
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    );
    assert.equal(clock, expected);
  }
  assert.equal(
    dedicatedTunnelExited(tunnelIdentity, {
      process: null,
      listeners: [],
      job: null,
    }),
    true,
  );
});

test("unknown listener, changed PID ownership/executable or reloaded GUI job refuses without signaling any process", async () => {
  for (const altered of [
    { listeners: [{ pid: 9999, uid: 501, command: "cloudflared" }] },
    {
      listeners: [{ pid: tunnelIdentity.pid, uid: 0, command: "cloudflared" }],
    },
    {
      listeners: [
        { pid: tunnelIdentity.pid, uid: 501, command: "other-service" },
      ],
    },
    { process: { ...tunnelIdentity, uid: 0 } },
    { process: { ...tunnelIdentity, command: "/bin/other" } },
    { process: { ...tunnelIdentity, pid: 9999 } },
    { job: { pid: 9999, program: tunnelIdentity.command, state: "running" } },
    {
      job: { pid: tunnelIdentity.pid, program: "/bin/other", state: "running" },
    },
  ])
    await assert.rejects(
      waitDedicatedTunnelExit(
        tunnelIdentity,
        async () => ({ ...liveTunnelSnapshot(), ...altered }),
        async () => true,
      ),
      /ownership changed/,
    );
});

test("ninety-second exit timeout or barrier replacement preserves admission; a still-exiting original prevents duplicate Tunnel recovery", async (t) => {
  const f = await barrierFixture(t);
  f.setHeld(
    await holdCutoverAdmission(f.path, f.heldPath, async () => ({
      ...status(),
      sha,
      draining: Boolean(await fs.lstat(f.path).catch(() => null)),
    })),
  );
  let clock = 0;
  await assert.rejects(
    waitDedicatedTunnelExit(
      tunnelIdentity,
      async () => liveTunnelSnapshot(),
      f.owns,
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    ),
    /ninety seconds/,
  );
  assert.equal(clock, 91_000);
  assert.equal(f.owns(), true);
  assert.equal(
    dedicatedTunnelExited(tunnelIdentity, liveTunnelSnapshot()),
    false,
  );
  await assert.rejects(fs.access(join(f.root, "quiet-gate-can-begin")));
  await fs.unlink(f.path);
  await fs.writeFile(f.path, "manual replacement", { mode: 0o600 });
  await assert.rejects(
    waitDedicatedTunnelExit(
      tunnelIdentity,
      async () => ({ process: null, listeners: [], job: null }),
      f.owns,
    ),
    /ownership changed/,
  );
  assert.equal(await fs.readFile(f.path, "utf8"), "manual replacement");
});

test("recovery waits for the same old terminating job/process/listener removal before bootstrap and readiness, and never bootstraps over an unknown replacement", async (t) => {
  const f = await barrierFixture(t);
  f.setHeld(
    await holdCutoverAdmission(f.path, f.heldPath, async () => ({
      ...status(),
      sha,
      draining: Boolean(await fs.lstat(f.path).catch(() => null)),
    })),
  );
  let clock = 0;
  const events = [];
  await restoreTunnelAfterExit({
    waitForExit: () =>
      waitDedicatedTunnelExit(
        tunnelIdentity,
        async () => ({
          process: clock < 30_000 ? { ...tunnelIdentity } : null,
          listeners: clock < 30_000 ? liveTunnelSnapshot().listeners : [],
          job:
            clock < 31_000
              ? {
                  pid: tunnelIdentity.pid,
                  program: tunnelIdentity.command,
                  state: "running",
                }
              : null,
        }),
        f.owns,
        {
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
        },
      ),
    bootstrap: async () => {
      assert.equal(clock, 31_000);
      events.push("bootstrap-fixed-gui");
      await fs.writeFile(join(f.root, "restored"), String(clock));
    },
    ready: async () => {
      assert.equal(
        await fs.readFile(join(f.root, "restored"), "utf8"),
        "31000",
      );
      events.push("ready");
    },
  });
  assert.deepEqual(events, ["bootstrap-fixed-gui", "ready"]);
  assert.equal(f.owns(), true);
  events.length = 0;
  await assert.rejects(
    restoreTunnelAfterExit({
      waitForExit: () =>
        waitDedicatedTunnelExit(
          tunnelIdentity,
          async () => ({
            ...liveTunnelSnapshot(),
            job: {
              pid: 9999,
              program: tunnelIdentity.command,
              state: "running",
            },
          }),
          f.owns,
        ),
      bootstrap: async () => {
        events.push("unexpected bootstrap");
      },
      ready: async () => {
        events.push("unexpected ready");
      },
    }),
    /ownership changed/,
  );
  assert.deepEqual(events, []);
  assert.equal(f.owns(), true);
});

test("pre-API failure restores only an originally loaded/stopped Tunnel before readiness and exact-owner admission release", async (t) => {
  const f = await barrierFixture(t);
  let held = await holdCutoverAdmission(f.path, f.heldPath, async () => ({
    ...status(),
    sha,
    draining: Boolean(await fs.lstat(f.path).catch(() => null)),
  }));
  f.setHeld(held);
  const events = [];
  const recover = (
    wasLoaded,
    wasStopped,
    ready = async () => {
      events.push("api-ready");
    },
  ) =>
    recoverUnstoppedApi({
      tunnelWasLoaded: wasLoaded,
      tunnelWasStopped: wasStopped,
      restartTunnel: async () => {
        events.push("restore-old-gui-tunnel");
      },
      hasBarrier: true,
      ready,
      release: async () => {
        events.push("release-owned-barrier");
        if (!(await releaseMaintenanceBarrier(f.path, held)))
          throw new Error("owner changed");
      },
    });
  await assert.rejects(
    recover(true, true, async () => {
      throw new Error("not ready");
    }),
    /not ready/,
  );
  assert.deepEqual(events, ["restore-old-gui-tunnel"]);
  assert.equal(f.owns(), true);
  events.length = 0;
  await recover(true, true);
  assert.deepEqual(events, [
    "restore-old-gui-tunnel",
    "api-ready",
    "release-owned-barrier",
  ]);
  await assert.rejects(fs.access(f.path));
  for (const flags of [
    [false, true],
    [true, false],
    [false, false],
  ]) {
    const untouched = [];
    await recoverUnstoppedApi({
      tunnelWasLoaded: flags[0],
      tunnelWasStopped: flags[1],
      restartTunnel: async () => {
        untouched.push("unexpected restart");
      },
      hasBarrier: false,
      ready: async () => {
        untouched.push("unexpected ready");
      },
      release: async () => {
        untouched.push("unexpected release");
      },
    });
    assert.deepEqual(untouched, []);
  }
  held = await holdCutoverAdmission(f.path, f.heldPath, async () => ({
    ...status(),
    sha,
    draining: Boolean(await fs.lstat(f.path).catch(() => null)),
  }));
  f.setHeld(held);
  await fs.unlink(f.path);
  await fs.writeFile(f.path, "operator replaced during recovery", {
    mode: 0o600,
  });
  events.length = 0;
  await assert.rejects(recover(true, true), /owner changed/);
  assert.deepEqual(events, [
    "restore-old-gui-tunnel",
    "api-ready",
    "release-owned-barrier",
  ]);
  assert.equal(
    await fs.readFile(f.path, "utf8"),
    "operator replaced during recovery",
  );
});

test("worker stderr exposes only complete allowlisted constant reasons, never arbitrary exception text or appended credentials", () => {
  assert.equal(
    safeWorkerFailure(
      "file.js:1\n throw new Error();\nError: Production is busy; no service has been stopped\n at worker (file.js:4)",
    ),
    "Production is busy; no service has been stopped",
  );
  assert.equal(
    safeWorkerFailure(
      "Error: Authenticated deployment status failed (403)\n at worker",
    ),
    "Authenticated deployment status failed (403)",
  );
  assert.equal(safeWorkerFailure("Error: Bearer private-token"), null);
  assert.equal(
    safeWorkerFailure(
      "Error: Production is busy; no service has been stopped Bearer private-token",
    ),
    null,
  );
  assert.equal(
    safeWorkerFailure('SyntaxError: {"ACCESS_PASSCODE":"private-token"}'),
    null,
  );
});
