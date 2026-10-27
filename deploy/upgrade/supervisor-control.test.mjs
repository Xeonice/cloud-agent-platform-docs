import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSupervisorControl,
  readSupervisorFact,
} from "./supervisor-control.mjs";
import { freezeCapacityBudget } from "./capacity-admission.mjs";
import { createControlAuthority } from "./control-authority.mjs";
import { digest } from "./trust.mjs";
const Database = createRequire(
  new URL("../../api/package.json", import.meta.url),
)("better-sqlite3");
const vector = (memoryBytes) => ({
  memoryBytes,
  cpuMilliCores: 100,
  ioBytesPerSecond: 100,
  disks: { artifacts: 100 },
});
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "supervisor-control-")),
  );
  let now = 1000000;
  const db = new Database(":memory:");
  const authority = createControlAuthority({
    sqlite: db,
    instanceId: "instance",
    clock: () => now,
    validateRecovery: () => true,
  });
  authority.activate({
    expectedRevision: 1,
    sourceBindingDigest: digest("source"),
  });
  t.after(async () => {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const item = (id, resident) => ({
      id,
      resident,
      identityDigest: digest(id),
      resources: vector(100),
    }),
    plan = freezeCapacityBudget({
      instanceId: "instance",
      sourceDigest: digest("source"),
      maxObservationAgeMs: 5000,
      limits: {
        memoryBytes: 1000,
        cpuMilliCores: 1000,
        ioBytesPerSecond: 1000,
        disks: { artifacts: 1000 },
      },
      allocations: {
        source: [item("source", true)],
        control: [item("control", true)],
        recovery: [item("recovery", false)],
        candidate: [item("candidate", false)],
        retainedOwners: [],
        retainedGuests: [],
        existingCandidates: [],
        verification: [],
      },
    });
  const observation = {
    known: true,
    exclusiveAccounting: true,
    instanceId: "instance",
    sourceDigest: plan.sourceDigest,
    revision: 1,
    observedAt: new Date(now).toISOString(),
    limits: plan.limits,
    available: {
      memoryBytes: 800,
      cpuMilliCores: 800,
      ioBytesPerSecond: 800,
      disks: { artifacts: 800 },
    },
    residents: [item("source", true), item("control", true)].map(
      ({ id, identityDigest, resources }) => ({
        id,
        identityDigest,
        resources,
      }),
    ),
  };
  const config = {
    origin: "http://127.0.0.1:1",
    key: "k".repeat(32),
    accessKey: "a".repeat(32),
    statePath: join(root, "supervisor.db"),
    capacityPlanPath: join(root, "budget.json"),
    resourceObservationPath: join(root, "resources.json"),
    referenceStatePath: join(root, "references.json"),
    controlDbPath: join(root, "ledger", "control.db"),
    agentStartIdentity: "fixture-agent-start-identity",
  };
  for (const [path, value] of [
    [config.capacityPlanPath, plan],
    [config.resourceObservationPath, observation],
    [config.referenceStatePath, { instanceId: "instance", candidates: [] }],
  ])
    await fs.writeFile(path, JSON.stringify(value), { mode: 0o600 });
  const open = () =>
    createSupervisorControl({
      instanceId: "instance",
      root,
      config,
      Database,
      clock: () => now,
      readers: { verifyAuthority: (input) => authority.assert(input) },
    });
  let control = await open();
  t.after(() => control.close());
  const grant = (epoch = 1, operationId = "operation", kind = "upgrade") =>
    authority.grant({
      epoch,
      operationId,
      executorId: "engine",
      kind,
      supersedes: kind === "recovery" ? authority.observe().operationId : null,
      leaseMs: 10000,
    });
  const command = (id = "command", op = "operation", epoch = 1) => ({
    operationId: op,
    commandId: id,
    stepId: "candidate",
    authorization: { epoch, executorId: "engine", expiresAt: now + 9000 },
    spec: {
      schemaVersion: 1,
      kind: "supervisor-start",
      instanceId: "instance",
      request: { attemptId: "attempt", kind: "api" },
      deadline: now + 5000,
      budget: { maxDurationMs: 5000 },
      planDigest: digest("plan"),
      packageDigest: digest("package"),
      capacityPlanDigest: plan.planDigest,
      capacityAllocationId: "candidate",
      resources: plan.allocations.candidate[0].resources,
      sourceDigest: plan.sourceDigest,
    },
  });
  return {
    root,
    config,
    plan,
    observation,
    authority,
    grant,
    command,
    get control() {
      return control;
    },
    advance: (ms) => {
      now += ms;
    },
    reopen: async () => {
      control.close();
      control = await open();
    },
    now: () => now,
  };
}
const noReconcile = () => assert.fail("unexpected reconciliation");
test("stable Supervisor rejects absent or shared business-access key before opening authority state", async (t) => {
  const f = await fixture(t);
  for (const accessKey of [undefined, "short", f.config.key]) {
    await assert.rejects(
      createSupervisorControl({
        instanceId: "instance",
        root: f.root,
        config: { ...f.config, accessKey },
        Database,
      }),
      /SUPERVISOR_STABLE_CONTROL_CONFIG_INVALID/,
    );
  }
});
test("global authority alone cannot dispatch before local admission; local epoch is persisted and rejects stale writer", async (t) => {
  const f = await fixture(t);
  f.grant();
  let actions = 0;
  const work = {
    execute: () => {
      actions++;
      return {};
    },
    reconcile: noReconcile,
  };
  await assert.rejects(
    f.control.run(f.command(), work),
    /SUPERVISOR_CONTROL_NOT_ADMITTED/,
  );
  assert.equal(actions, 0);
  await f.control.admit({
    epoch: 1,
    operationId: "operation",
    executorId: "engine",
  });
  await f.reopen();
  const row = await f.control.run(f.command(), work);
  assert.equal(row.state, "applied");
  assert.equal(actions, 1);
  await f.control.run(f.command(), work);
  assert.equal(actions, 1);
  await assert.rejects(
    f.control.admit({
      epoch: 0,
      operationId: "operation",
      executorId: "engine",
    }),
  );
});
test("all mutation kinds share one long-action barrier, including across independent connections", async (t) => {
  const f = await fixture(t);
  f.grant();
  await f.control.admit({
    epoch: 1,
    operationId: "operation",
    executorId: "engine",
  });
  let release, started;
  const entered = new Promise((r) => {
    started = r;
  });
  const first = f.control.run(f.command(), {
    execute: async () => {
      started();
      await new Promise((r) => {
        release = r;
      });
      return { created: true };
    },
    reconcile: noReconcile,
  });
  await entered;
  await assert.rejects(
    f.control.run(f.command("other"), {
      execute: () => assert.fail("second mutation"),
      reconcile: noReconcile,
    }),
    /SUPERVISOR_SINGLE_FLIGHT_BLOCKED/,
  );
  release();
  assert.equal((await first).state, "applied");
});
test("executing on process restart is queried under same command, never replayed; new recovery can only reconcile old action", async (t) => {
  const f = await fixture(t);
  f.grant();
  await f.control.admit({
    epoch: 1,
    operationId: "operation",
    executorId: "engine",
  });
  const original = f.command();
  f.control.journal.prepare(original);
  f.control.journal.begin(original);
  await f.reopen();
  f.grant(2, "recovery", "recovery");
  await f.control.admit({
    epoch: 2,
    operationId: "recovery",
    executorId: "engine",
  });
  const recovered = {
    ...original,
    authorization: {
      epoch: 2,
      executorId: "engine",
      expiresAt: f.now() + 9000,
    },
  };
  let reads = 0;
  const row = await f.control.run(recovered, {
    execute: () => assert.fail("must not redispatch"),
    reconcile: ({ command }) => {
      reads++;
      assert.equal(command.commandId, original.commandId);
      assert.equal(command.spec.deadline, original.spec.deadline);
      return { state: "applied", result: { original: true } };
    },
  });
  assert.equal(reads, 1);
  assert.equal(row.state, "applied");
  assert.equal(row.specDigest, digest(original.spec));
  await assert.rejects(
    f.control.run(
      { ...recovered, commandId: "new-old-action" },
      {
        execute: () => assert.fail("old action copied"),
        reconcile: noReconcile,
      },
    ),
    /SUPERVISOR_RECONCILE_ONLY/,
  );
});
test("expired original budget is lookup-only; unknown keeps barrier and blocks next command", async (t) => {
  const f = await fixture(t);
  f.grant();
  await f.control.admit({
    epoch: 1,
    operationId: "operation",
    executorId: "engine",
  });
  const command = f.command();
  f.control.journal.prepare(command);
  f.control.journal.begin(command);
  await f.reopen();
  f.advance(6000);
  const row = await f.control.run(command, {
    execute: () => assert.fail("expired dispatch"),
    reconcile: () => ({ state: "unknown", result: { code: "STILL_UNKNOWN" } }),
  });
  assert.equal(row.state, "unknown");
  f.grant();
  await f.control.admit({
    epoch: 1,
    operationId: "operation",
    executorId: "engine",
  });
  await assert.rejects(
    f.control.run(f.command("other"), {
      execute: () => assert.fail("barrier bypass"),
      reconcile: noReconcile,
    }),
    /SUPERVISOR_SINGLE_FLIGHT_BLOCKED/,
  );
});
test("fresh frozen budget admits; one changed measurement or inode refuses final launch CAS", async (t) => {
  const f = await fixture(t),
    command = f.command(),
    proof = await f.control.capacity(command.spec);
  assert.equal(proof.result.qualified, true);
  await fs.writeFile(
    f.config.resourceObservationPath,
    JSON.stringify({ ...f.observation, revision: 2 }),
  );
  await assert.rejects(
    f.control.assertCapacity(command.spec, proof),
    /SUPERVISOR_CAPACITY_CAS_CHANGED/,
  );
  await fs.writeFile(
    f.config.resourceObservationPath,
    JSON.stringify({
      ...f.observation,
      available: { ...f.observation.available, memoryBytes: 1 },
    }),
  );
  await assert.rejects(
    f.control.capacity(command.spec),
    /CAPACITY_BUDGET_INSUFFICIENT/,
  );
});
test("unknown cpu/io and stale snapshots never become guessed zero or fresh evidence", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    f.config.resourceObservationPath,
    JSON.stringify({
      ...f.observation,
      available: { ...f.observation.available, ioBytesPerSecond: null },
    }),
  );
  await assert.rejects(
    f.control.capacity(f.command().spec),
    /CAPACITY_RESOURCE_UNKNOWN/,
  );
  await fs.writeFile(
    f.config.resourceObservationPath,
    JSON.stringify(f.observation),
  );
  f.advance(5001);
  await assert.rejects(
    f.control.capacity(f.command().spec),
    /CAPACITY_OBSERVATION_STALE/,
  );
});
test("file readers reject symlinks and writable authority facts", async (t) => {
  const f = await fixture(t),
    link = join(f.root, "alias");
  await fs.symlink(f.config.capacityPlanPath, link);
  await assert.rejects(readSupervisorFact(link));
  await fs.chmod(f.config.capacityPlanPath, 0o666);
  await assert.rejects(
    readSupervisorFact(f.config.capacityPlanPath),
    /SUPERVISOR_FACT_INSECURE/,
  );
});

test("HTTP deadline does not release the actual unsettled execution; late work is never overlapped or retried", async (t) => {
  const f = await fixture(t);
  f.grant();
  await f.control.admit({
    epoch: 1,
    operationId: "operation",
    executorId: "engine",
  });
  const command = f.command();
  command.spec.budget.maxDurationMs = 10;
  let finish, started;
  const entered = new Promise((r) => {
    started = r;
  });
  let actions = 0;
  const pending = f.control.run(command, {
    execute: async () => {
      started();
      await new Promise((r) => {
        finish = r;
      });
      actions++;
      return { created: true };
    },
    reconcile: () => assert.fail("no lookup while original is live"),
  });
  await entered;
  const timedOut = await pending;
  assert.equal(timedOut.state, "unknown");
  await assert.rejects(
    f.control.run(command, {
      execute: () => assert.fail("duplicate"),
      reconcile: () => assert.fail("premature absence lookup"),
    }),
    /SUPERVISOR_SINGLE_FLIGHT_BLOCKED/,
  );
  finish();
  await new Promise((r) => setImmediate(r));
  const proof = await f.control.run(command, {
    execute: () => assert.fail("must reconcile"),
    reconcile: () => ({ state: "applied", result: { created: true } }),
  });
  assert.equal(proof.state, "applied");
  assert.equal(actions, 1);
});

test("contract authority is limited to its fixed semantic reader retirement and cannot launch candidates", async (t) => {
  const f = await fixture(t);
  f.grant(1, "operation", "contract");
  await f.control.admit({
    epoch: 1,
    operationId: "operation",
    executorId: "engine",
  });
  await assert.rejects(
    f.control.run(f.command(), {
      execute: () => assert.fail("contract starts candidate"),
      reconcile: noReconcile,
    }),
    /SUPERVISOR_CONTRACT_SIDE_EFFECT_FORBIDDEN/,
  );
  const command = f.command("reader-retire");
  command.spec.kind = "contract-retire-reader";
  command.spec.request = {
    contractAttemptId: "operation",
    fence: 17,
    operationId: "operation:retire:reader",
    readerId: "reader",
  };
  const result = await f.control.run(command, {
    execute: () => ({ retired: true }),
    reconcile: noReconcile,
  });
  assert.equal(result.state, "applied");
  assert.equal(result.spec.request.fence, 17);
});
test("local admission database cannot point at an existing business database", async (t) => {
  const f = await fixture(t);
  f.control.close();
  const file = join(f.root, "platform.db"),
    business = new Database(file);
  business.exec("CREATE TABLE system_settings(id TEXT)");
  business.close();
  await fs.chmod(file, 0o600);
  await assert.rejects(
    createSupervisorControl({
      instanceId: "instance",
      root: f.root,
      config: { ...f.config, statePath: file },
      Database,
      readers: { verifyAuthority: (input) => f.authority.assert(input) },
    }),
    /SUPERVISOR_STATE_DB_WRONG_SCOPE/,
  );
  const proof = new Database(file, { readonly: true });
  assert.deepEqual(
    proof.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
    [{ name: "system_settings" }],
  );
  proof.close();
  await f.reopen();
});
