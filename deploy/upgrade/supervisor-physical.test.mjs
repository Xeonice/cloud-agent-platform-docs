import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProtectedRoleLifecycle,
  fixedRoleName,
} from "./protected-role-lifecycle.mjs";
import {
  createBoundedRoleSampler,
  captureProcessIdentity,
} from "./supervisor-sampler.mjs";
import { roleMounts } from "./production-role-adapter.mjs";
import { digest } from "./trust.mjs";
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "supervisor-physical-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = {
    instanceId: "instance",
    role: "api",
    containerId: "a".repeat(64),
    startIdentity: "fixed-start-identity",
    hostPid: 1234,
    startedAt: "2026-10-20T12:00:00.000Z",
    artifactDigest: digest("api"),
    attemptId: "attempt",
  };
  let physical = {
    ...target,
    running: true,
    paused: false,
    restartPolicy: "no",
    restartCount: 0,
    oomKilled: false,
    exitCode: 0,
    operationId: "operation",
    commandId: "command",
  };
  const signals = [];
  const lifecycle = createProtectedRoleLifecycle({
    instanceId: "instance",
    registryRoot: root,
    inspect: async () => structuredClone(physical),
    signalTerm: async (id, signal) => {
      signals.push({ id, signal });
      physical = { ...physical, running: false, hostPid: 0, exitCode: 143 };
      return physical;
    },
    findByName: async () => physical.containerId,
  });
  const request = {
    instanceId: "instance",
    operationId: "operation",
    commandId: "command",
    specDigest: digest("spec"),
    target,
    signal: "SIGTERM",
    deadline: Date.now() + 5000,
    budget: { maxDurationMs: 5000 },
    assertBeforeDispatch: async () => {},
  };
  return {
    root,
    target,
    signals,
    lifecycle,
    request,
    get physical() {
      return physical;
    },
    set: (changes) => {
      physical = { ...physical, ...changes };
    },
  };
}
test("normal exact candidate retirement sends one SIGTERM and confirms exit; lookup never sends it again", async (t) => {
  const f = await fixture(t);
  const result = await f.lifecycle.retireCandidate(f.request);
  assert.equal(result.state, "applied");
  assert.deepEqual(f.signals, [
    { id: f.target.containerId, signal: "SIGTERM" },
  ]);
  assert.equal(result.normalExit, true);
  assert.equal(
    (await f.lifecycle.lookupRetirement(f.request)).state,
    "applied",
  );
  assert.equal(f.signals.length, 1);
});
test("Owner role, changed birth and active restart policy reject before any signal", async (t) => {
  for (const changes of [
    { role: "owner" },
    { startedAt: "2026-10-20T12:00:01.000Z" },
    { restartPolicy: "always" },
    { hostPid: 1235 },
    { paused: true },
  ]) {
    const f = await fixture(t);
    if (changes.role) f.request.target.role = changes.role;
    else f.set(changes);
    await assert.rejects(f.lifecycle.retireCandidate(f.request));
    assert.deepEqual(f.signals, []);
  }
});
test("reference CAS changes after durable intent but before dispatch do not signal; original lookup remains unknown", async (t) => {
  const f = await fixture(t);
  f.request.assertBeforeDispatch = async () => {
    throw Object.assign(Error("refs changed"), { code: "REFERENCES_CHANGED" });
  };
  await assert.rejects(f.lifecycle.retireCandidate(f.request), /refs changed/);
  assert.equal(f.signals.length, 0);
  assert.equal(
    (await f.lifecycle.lookupRetirement(f.request)).state,
    "unknown",
  );
});
test("late Docker create absence cannot prove not-applied once original launch intent exists", async (t) => {
  const f = await fixture(t),
    record = {
      ...f.target,
      kind: "api",
      operationId: "operation",
      commandId: "command",
      specDigest: digest("spec"),
    };
  delete record.containerId;
  await f.lifecycle.prepareStart(record);
  f.set({ running: false });
  await assert.rejects(f.lifecycle.lookupStart(record));
  await assert.rejects(f.lifecycle.prepareStart(record), { code: "EEXIST" });
  assert.equal(f.signals.length, 0);
});
test("stable container name is derived from original command and cannot multiply on restart or identity refresh", () => {
  const r = {
    kind: "api",
    startIdentity: "old",
    operationId: "operation",
    commandId: "command",
  };
  assert.equal(
    fixedRoleName("instance", r),
    fixedRoleName("instance", { ...r, startIdentity: "new" }),
  );
  assert.notEqual(
    fixedRoleName("instance", r),
    fixedRoleName("instance", { ...r, commandId: "other" }),
  );
});
test("business Coordinator mounts only dedicated ledger dir RO, never the private access DB directory", () => {
  const c = {
    root: "/fixture",
    businessHostPath: "/business",
    kind: "production",
    controlPrivateRoot: "/control/private",
    controlLedgerRoot: "/control/ledger",
    stableControl: { controlDbPath: "/control/ledger/control.db" },
    trustRootPath: "/trust/root.json",
    catalogFile: "/catalog/releases.json",
  };
  const spec = {
    kind: "coordinator",
    artifactRoot: "/artifacts/v1",
    env: { UPGRADE_CONTROL_DATABASE_PATH: "/control/ledger/control.db" },
  };
  const mounts = roleMounts(c, spec);
  assert.ok(
    mounts.some((m) => m.source === "/control/ledger" && m.rw === false),
  );
  assert.equal(
    mounts.some(
      (m) => m.source.startsWith("/control/private") || m.source === "/control",
    ),
    false,
  );
  assert.throws(
    () =>
      roleMounts(
        {
          ...c,
          controlLedgerRoot: "/control",
          stableControl: { controlDbPath: "/control/control.db" },
        },
        {
          ...spec,
          env: { UPGRADE_CONTROL_DATABASE_PATH: "/control/control.db" },
        },
      ),
    /CONTROL_LEDGER_MOUNT_SCOPE_REQUIRED/,
  );
});
test("Control Agent has separate control code/access/ledger mounts; no business, Owner SDK or Docker socket", () => {
  const c = {
    root: "/fixture",
    businessHostPath: "/business",
    kind: "production",
    controlPrivateRoot: "/control/private",
    controlLedgerRoot: "/control/ledger",
    controlAgentArtifactRoot: "/control/releases/v1",
    controlDownloadRoot: "/fixture/installer/downloads",
    capacityStateRoot: "/control/capacity",
    runtimeRoots: ["/sdk", "/owners"],
    trustRootPath: "/trust/root.json",
  };
  const mounts = roleMounts(c, {
    kind: "control-agent",
    artifactRoot: c.controlAgentArtifactRoot,
    env: {},
  });
  assert.equal(
    mounts.some(
      (m) =>
        m.source.startsWith("/business") ||
        m.source.includes("docker.sock") ||
        m.source.includes("runtime-owner"),
    ),
    false,
  );
  assert.ok(mounts.some((m) => m.source === c.controlPrivateRoot && m.rw));
  assert.ok(mounts.some((m) => m.source === c.controlLedgerRoot && m.rw));
  assert.ok(mounts.some((m) => m.source === c.capacityStateRoot && !m.rw));
  assert.throws(
    () =>
      roleMounts(c, {
        kind: "control-agent",
        artifactRoot: c.controlAgentArtifactRoot,
        env: { DATABASE_URL: "/business/platform.db" },
      }),
    /CONTROL_AGENT_EXCESS_AUTHORITY/,
  );
});

test('Entry and Supervisor have separate fixed mount capabilities without current Owner homes or Agent access state', () => {
  const c = { root: '/fixture', businessHostPath: '/business', controlArtifactRoot: '/control/releases/v1', controlPrivateRoot: '/control/agent-private',
    controlLedgerRoot: '/control/ledger', controlFoundationRoot: '/control/foundation', controlEntryRoot: '/fixture/entry',
    controlFutureOwnerRoot: '/fixture/new-owners', existingRuntimeRoots: ['/fixture/original-owner', '/fixture/old-owners'],
    controlEntryWebRoots: ['/fixture/initial-web-code', '/fixture/installer/artifacts'], capacityStateRoot: '/control/capacity',
    catalogFile: '/catalog/catalog.json', trustRootPath: '/trust/root.json', procRoot: '/host/proc', cgroupRoot: '/host/cgroup',
    controlFoundationEntries: { entry: { configPath: '/control/foundation/entry.json' }, supervisor: { configPath: '/control/foundation/supervisor.json' } } };
  const entry = roleMounts(c, { kind: 'control-entry', artifactRoot: c.controlArtifactRoot, env: {} });
  assert.ok(entry.some(m => m.source === c.controlEntryRoot && m.rw));
  assert.equal(entry.some(m => m.source === '/var/run/docker.sock' || m.source === '/business' || m.source === '/proc'), false);
  const supervisor = roleMounts(c, { kind: 'control-supervisor', artifactRoot: c.controlArtifactRoot, env: {} });
  assert.ok(supervisor.some(m => m.source === '/var/run/docker.sock' && m.rw));
  assert.ok(supervisor.some(m => m.source === '/proc' && m.destination === '/host/proc' && !m.rw));
  assert.ok(supervisor.some(m => m.source === '/sys/fs/cgroup' && !m.rw));
  assert.ok(supervisor.some(m => m.source === '/business' && !m.rw));
  for (const mounts of [entry, supervisor]) {
    assert.equal(mounts.some(m => m.source === c.controlPrivateRoot || m.source === c.controlLedgerRoot || c.existingRuntimeRoots.includes(m.source)), false);
  }
  assert.throws(() => roleMounts({ ...c, controlFutureOwnerRoot: '/fixture/old-owners' }, { kind: 'control-supervisor', artifactRoot: c.controlArtifactRoot, env: {} }), /CONTROL_SUPERVISOR_MOUNT_SCOPE_REQUIRED/);
  assert.throws(() => roleMounts({ ...c, controlEntryWebRoots: ['/control/agent-private/auth'] }, { kind: 'control-entry', artifactRoot: c.controlArtifactRoot, env: {} }), /CONTROL_ENTRY_MOUNT_SCOPE_REQUIRED/);
});
async function procFixture(t) {
  const f = await fixture(t),
    home = join(f.root, "proc", "1234");
  await fs.mkdir(home, { recursive: true });
  const fields = Array(25).fill("0");
  fields[19] = "999";
  const stat = "1234 (fixture command with spaces) " + fields.join(" ");
  await fs.writeFile(join(home, "stat"), stat);
  await fs.writeFile(join(home, "status"), "VmRSS: 123 kB\n");
  await fs.writeFile(join(home, "io"), "read_bytes: 41\nwrite_bytes: 42\n");
  await fs.writeFile(
    join(home, "cgroup"),
    "0::/docker/" + f.target.containerId + "\n",
  );
  return { ...f, home, stat, procRoot: join(f.root, "proc") };
}
test("bounded sampler binds actual PID birth and cgroup, records only fixed metadata, and rejects reincarnation", async (t) => {
  const f = await procFixture(t),
    birth = await captureProcessIdentity({
      hostPid: 1234,
      containerId: f.target.containerId,
      procRoot: f.procRoot,
    });
  const sampler = createBoundedRoleSampler({
    targets: () => [{ ...f.target, kind: "api", ...birth }],
    procRoot: f.procRoot,
    cgroupRoot: join(f.root, "cgroup"),
  });
  const [sample] = await sampler();
  assert.equal(sample.state, "alive");
  assert.equal(sample.startIdentity, f.target.startIdentity);
  assert.equal(sample.rssBytes, 123 * 1024);
  assert.equal(sample.readBytes, 41);
  assert.equal(sample.writeBytes, 42);
  assert.equal(sample.heapUsedBytes, undefined);
  await fs.writeFile(join(f.home, "stat"), f.stat.replace("999", "1000"));
  assert.deepEqual(
    (await sampler()).map((s) => s.state),
    ["unknown"],
  );
  assert.equal((await sampler())[0].rssBytes, undefined);
});
test("sampler rejects excessive target lists and aborted reads without scanning any process tree", async (t) => {
  const f = await procFixture(t);
  const sampler = createBoundedRoleSampler({
    targets: () => Array(17).fill(f.target),
    procRoot: f.procRoot,
  });
  await assert.rejects(sampler(), /SUPERVISOR_SAMPLE_TARGET_LIMIT/);
  const abort = new AbortController();
  abort.abort();
  const one = createBoundedRoleSampler({
    targets: () => [
      { ...f.target, birthTicks: "999", cgroupDigest: digest("wrong") },
    ],
    procRoot: f.procRoot,
  });
  assert.equal((await one({ signal: abort.signal }))[0].state, "unknown");
});
