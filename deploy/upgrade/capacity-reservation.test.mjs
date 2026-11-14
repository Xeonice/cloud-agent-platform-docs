import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fixture } from "../test-support/supervisor-runtime-fixture.mjs";
import { createAttemptCapacityReservations } from "./capacity-reservation.mjs";
import { freezeCapacityBudget } from "./capacity-admission.mjs";
import { digest, canonical } from "./trust.mjs";
import { atomicJson } from "./io.mjs";
import { createControlCommandJournal } from "./control-command-journal.mjs";
async function read(path) {
  return JSON.parse(await fs.readFile(path, "utf8"));
}
async function reserve(f, attemptId, epoch) {
  if (f.authority) {
    let old = f.authority.observe();
    if (old.mode === "passive")
      old = f.authority.activate({
        expectedRevision: old.revision,
        sourceBindingDigest: f.plan.sourceDigest,
      });
    if (old.holderId)
      f.authority.release({
        operationId: old.operationId,
        epoch: old.epoch,
        executorId: old.holderId,
      });
    f.authority.grant({
      operationId: attemptId,
      epoch,
      executorId: "agent",
      leaseMs: 60000,
    });
  }
  f.setScope(attemptId, epoch);
  await f.supervisor.admit({
    operationId: attemptId,
    epoch,
    executorId: "agent",
  });
  const plan = await read(f.stable.capacityPlanPath),
    business = {
      planDigest: digest("business-" + attemptId),
      package: { digest: digest("package-" + attemptId) },
      steps: [{ kind: "candidate" }],
    };
  const command = {
    operationId: attemptId,
    commandId: attemptId + ":reserve",
    stepId: "reservation",
    authorization: f.supervisor.currentAuthorization(),
    spec: {
      schemaVersion: 1,
      kind: "capacity-reservation",
      instanceId: f.instanceId,
      request: {
        attemptId,
        planDigest: business.planDigest,
        packageDigest: business.package.digest,
        roles: ["api"],
      },
      capacityPlanDigest: plan.planDigest,
      sourceDigest: plan.sourceDigest,
      deadline: f.now + 10000,
      budget: { maxDurationMs: 10000 },
    },
  };
  const snapshot = {
    attempt: { instanceId: f.instanceId, attemptId },
    plan: business,
  };
  const row = await f.supervisor.run(command, {
    execute: () => f.runtime.reserve(command, snapshot),
    reconcile: () => {
      throw Error("No retry needed");
    },
  });
  return { row, command, snapshot };
}
function attempt(f, id, state, fence) {
  f.controlDb
    .prepare(
      "INSERT INTO upgrade_attempts(attempt_id,instance_id,actor_id,request_id,request_digest,target_release_id,target_digest,manifest,plan,source_activation,generation,state,stage,fence,accepted_at,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      id,
      f.instanceId,
      "fixture-actor",
      id,
      digest(id),
      "v0.0.1",
      digest("target"),
      "{}",
      "{}",
      "{}",
      fence,
      state,
      state,
      fence,
      f.now,
      f.now,
    );
}
async function start(f, reservation, n) {
  const attemptId = reservation.command.operationId,
    plan = await read(f.stable.capacityPlanPath),
    id = reservation.row.result.allocationIds.api,
    allocation = plan.allocations.candidate.find((row) => row.id === id);
  const command = {
    operationId: attemptId,
    commandId: attemptId + ":start",
    stepId: "candidate",
    authorization: f.supervisor.currentAuthorization(),
    spec: {
      kind: "supervisor-start",
      instanceId: f.instanceId,
      request: { attemptId, kind: "api" },
      capacityAllocationId: id,
      resources: allocation.resources,
      capacityPlanDigest: plan.planDigest,
      sourceDigest: plan.sourceDigest,
      deadline: f.now + 10000,
      budget: { maxDurationMs: 10000 },
    },
  };
  f.supervisor.journal.prepare(command);
  f.supervisor.journal.begin(command);
  const physical = {
    ...f.agent,
    containerId: String(n).repeat(64),
    pid: 100 + n,
    hostPid: 100 + n,
    birthTicks: String(1000 + n),
    cgroupDigest: digest("cgroup-" + n),
    role: "api",
    startIdentity: "api-birth-" + n,
    artifactDigest: digest("api-code-" + n),
    memoryBytes: 800,
    operationId: attemptId,
    commandId: command.commandId,
  };
  f.running.set(physical.containerId, physical);
  const row = f.supervisor.journal.record({
    ...command,
    state: "applied",
    result: { ...physical, pid: 1 },
  });
  await f.runtime.appliedStart(row);
  return { row, physical };
}
test("two consecutive real SQLite attempts retain the first resident and reserve a distinct second role; replay keeps old specifications", async (t) => {
  const f = await fixture(t, false, true),
    b = await reserve(f, "attempt-b", 1);
  assert.equal(b.row.state, "applied");
  assert.equal(b.row.result.qualified, true);
  const first = await start(f, b, 3),
    before = f.supervisor.assembly.sqlite
      .prepare("SELECT * FROM control_commands WHERE command_id=?")
      .get(b.command.commandId);
  const c = await reserve(f, "attempt-c", 2);
  assert.equal(c.row.result.qualified, true);
  assert.notEqual(
    c.row.result.allocationIds.api,
    b.row.result.allocationIds.api,
  );
  let plan = await read(f.stable.capacityPlanPath);
  assert.equal(
    plan.allocations.candidate.find(
      (row) => row.id === b.row.result.allocationIds.api,
    ).resident,
    true,
  );
  assert.equal(
    plan.allocations.candidate.find(
      (row) => row.id === c.row.result.allocationIds.api,
    ).resident,
    false,
  );
  await start(f, c, 4);
  plan = await read(f.stable.capacityPlanPath);
  assert.equal(
    plan.allocations.candidate.filter((row) => row.resident).length,
    2,
  );
  assert(f.running.has(first.physical.containerId));
  assert.deepEqual(await f.runtime.reserve(b.command, null), b.row.result);
  assert.deepEqual(
    f.supervisor.assembly.sqlite
      .prepare("SELECT * FROM control_commands WHERE command_id=?")
      .get(b.command.commandId),
    before,
  );
  const capacityBefore = canonical(plan),
    retireTarget = {
      instanceId: f.instanceId,
      role: "api",
      containerId: first.physical.containerId,
      startIdentity: first.physical.startIdentity,
      hostPid: first.physical.hostPid,
      startedAt: first.physical.startedAt,
      artifactDigest: first.physical.artifactDigest,
      attemptId: "attempt-b",
    };
  const retire = {
    operationId: "attempt-c",
    commandId: "attempt-c:retire-b",
    stepId: "retire",
    authorization: f.supervisor.currentAuthorization(),
    spec: {
      kind: "retire-candidate",
      instanceId: f.instanceId,
      target: retireTarget,
      deadline: f.now + 10000,
      budget: { maxDurationMs: 10000 },
    },
  };
  f.supervisor.journal.prepare(retire);
  f.supervisor.journal.begin(retire);
  const unknown = f.supervisor.journal.record({
    ...retire,
    state: "unknown",
    result: { code: "LOST_ACK" },
  });
  await f.runtime.appliedStart(unknown);
  assert.equal(
    canonical(await read(f.stable.capacityPlanPath)),
    capacityBefore,
  );
  const result = {
    instanceId: f.instanceId,
    operationId: retire.operationId,
    commandId: retire.commandId,
    specDigest: digest(retire.spec),
    target: retireTarget,
    normalExit: true,
    signal: "SIGTERM",
    forced: false,
    removed: false,
    volumesRemoved: false,
    exit: { running: false, hostPid: 0, oomKilled: false, exitCode: 143 },
  };
  const applied = f.supervisor.journal.record({
    ...retire,
    state: "applied",
    result,
  });
  await assert.rejects(
    f.runtime.appliedStart(applied),
    /CAPACITY_RETIREMENT_PHYSICAL_UNKNOWN/,
  );
  assert(
    f.supervisor.assembly.sqlite
      .prepare("SELECT 1 FROM supervisor_side_effect")
      .get(),
  );
  f.running.delete(first.physical.containerId);
  await f.runtime.appliedStart(applied);
  plan = await read(f.stable.capacityPlanPath);
  assert.equal(
    plan.allocations.candidate.some(
      (row) => row.id === b.row.result.allocationIds.api,
    ),
    false,
  );
  assert.equal(
    plan.allocations.candidate.find(
      (row) => row.id === c.row.result.allocationIds.api,
    ).resident,
    true,
  );
  assert.equal(
    f.supervisor.assembly.sqlite
      .prepare("SELECT 1 FROM supervisor_side_effect")
      .get(),
    undefined,
  );
  await f.runtime.appliedStart(applied);
});
test("insufficient next-attempt budget is a durable deferred result with no plan publication or process effect", async (t) => {
  const f = await fixture(t, false, true),
    b = await reserve(f, "attempt-b", 1);
  await start(f, b, 3);
  const plan = await read(f.stable.capacityPlanPath);
  plan.limits.memoryBytes = 6000;
  await atomicJson(f.stable.capacityPlanPath, freezeCapacityBudget(plan));
  const before = await fs.readFile(f.stable.capacityPlanPath, "utf8");
  const c = await reserve(f, "attempt-c", 2);
  assert.equal(c.row.state, "applied");
  assert.equal(c.row.result.state, "deferred");
  assert.equal(c.row.result.qualified, false);
  assert.equal(await fs.readFile(f.stable.capacityPlanPath, "utf8"), before);
  assert.equal(f.running.size, 3);
  assert.deepEqual(await f.runtime.reserve(c.command, null), c.row.result);
});
test("half-published reservation restarts from the same own SQLite intent without a new command, deadline or reservation", async (t) => {
  const f = await fixture(t, false, true);
  await f.runtime.collect();
  f.setScope("attempt-b", 1);
  await f.supervisor.admit({
    operationId: "attempt-b",
    epoch: 1,
    executorId: "agent",
  });
  const plan = await read(f.stable.capacityPlanPath),
    business = {
      planDigest: digest("business"),
      package: { digest: digest("package") },
      steps: [{ kind: "candidate" }],
    },
    command = {
      operationId: "attempt-b",
      commandId: "reservation",
      stepId: "reservation",
      authorization: f.supervisor.currentAuthorization(),
      spec: {
        schemaVersion: 1,
        kind: "capacity-reservation",
        instanceId: f.instanceId,
        request: {
          attemptId: "attempt-b",
          planDigest: business.planDigest,
          packageDigest: business.package.digest,
          roles: ["api"],
        },
        capacityPlanDigest: plan.planDigest,
        sourceDigest: plan.sourceDigest,
        deadline: f.now + 10000,
        budget: { maxDurationMs: 10000 },
      },
    };
  f.supervisor.journal.prepare(command);
  f.supervisor.journal.begin(command);
  let interrupted = true;
  const port = {
    sqlite: f.supervisor.assembly.sqlite,
    instanceId: f.instanceId,
    templates: f.stable.capacityTemplates,
    planPath: f.stable.capacityPlanPath,
    configPath: f.stable.capacityCollectorConfigPath,
    clock: () => f.now,
  };
  const broken = createAttemptCapacityReservations({
    ...port,
    write: async (path, value) => {
      await atomicJson(path, value);
      if (interrupted) {
        interrupted = false;
        throw Error("Fixture ACK lost after publication");
      }
    },
  });
  await assert.rejects(
    broken.prepare(
      command,
      {
        attempt: { instanceId: f.instanceId, attemptId: "attempt-b" },
        plan: business,
      },
      await f.runtime.collect(),
    ),
    /Fixture ACK lost/,
  );
  const original = f.supervisor.assembly.sqlite
      .prepare("SELECT * FROM control_commands WHERE command_id=?")
      .get("reservation"),
    restored = createAttemptCapacityReservations(port);
  await restored.prepare(command, null, null);
  const receipt = await restored.confirm(command, await f.runtime.collect());
  assert.equal(receipt.qualified, true);
  assert.equal(
    receipt.allocationIds.api,
    (await read(f.stable.capacityPlanPath)).allocations.candidate[0].id,
  );
  assert.deepEqual(
    f.supervisor.assembly.sqlite
      .prepare("SELECT * FROM control_commands WHERE command_id=?")
      .get("reservation"),
    original,
  );
  assert.throws(
    () =>
      createAttemptCapacityReservations({
        ...port,
        templates: {
          api: {
            ...f.stable.capacityTemplates.api,
            resources: {
              ...f.stable.capacityTemplates.api.resources,
              memoryBytes: 1,
            },
          },
        },
      }),
    /CAPACITY_TEMPLATES_CHANGED/,
  );
});
test("actual process death releases only the separate publication mutex; ordinary Supervisor journal admission remains writable throughout", async (t) => {
  const f = await fixture(t, false, true),
    path = join(f.stable.capacityTransitionRoot, "capacity-publication.db"),
    requireApi = createRequire(
      new URL("../../api/package.json", import.meta.url),
    ),
    Database = requireApi("better-sqlite3");
  await f.runtime.collect();
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const Database=require(${JSON.stringify(requireApi.resolve("better-sqlite3"))});const db=new Database(process.argv[1]);db.exec('BEGIN IMMEDIATE');process.stdout.write('locked');setInterval(()=>{},1000);`,
      path,
    ],
    { stdio: ["ignore", "pipe", "pipe"], shell: false },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });
  await once(child.stdout, "data");
  const blocked = new Database(path);
  blocked.pragma("busy_timeout=50");
  try {
    assert.throws(() => blocked.exec("BEGIN IMMEDIATE"), /locked/);
    f.setScope("next-operation", 2);
    await f.supervisor.admit({
      operationId: "next-operation",
      epoch: 2,
      executorId: "agent",
    });
    assert.equal(f.supervisor.currentAuthorization().epoch, 2);
    const died = once(child, "exit");
    child.kill("SIGKILL");
    await died;
    blocked.exec("BEGIN IMMEDIATE");
    blocked.exec("COMMIT");
    assert.equal(
      await fs
        .lstat(f.stable.resourceObservationPath + ".collector-lock")
        .catch((error) => error.code),
      "ENOENT",
    );
  } finally {
    blocked.close();
  }
});
test("reservation cannot introduce caller resource ceilings or an unbound request member", async (t) => {
  const f = await fixture(t, false, true),
    b = await reserve(f, "attempt-b", 1),
    before = await fs.readFile(f.stable.capacityPlanPath, "utf8");
  const command = structuredClone(b.command);
  command.operationId = "other-attempt";
  command.commandId = "other-reservation";
  command.spec.request.attemptId = "other-attempt";
  command.spec.request.resources = { memoryBytes: 1 };
  const port = createAttemptCapacityReservations({
    sqlite: f.supervisor.assembly.sqlite,
    instanceId: f.instanceId,
    templates: f.stable.capacityTemplates,
    planPath: f.stable.capacityPlanPath,
    configPath: f.stable.capacityCollectorConfigPath,
    clock: () => f.now,
  });
  await assert.rejects(
    port.prepare(
      command,
      {
        attempt: { instanceId: f.instanceId, attemptId: "other-attempt" },
        plan: b.snapshot.plan,
      },
      await f.runtime.collect(),
    ),
    /CAPACITY_RESERVATION_SPEC_INVALID/,
  );
  assert.equal(await fs.readFile(f.stable.capacityPlanPath, "utf8"), before);
  assert.equal(
    f.supervisor.assembly.sqlite
      .prepare(
        "SELECT 1 FROM supervisor_capacity_reservations WHERE attempt_id=?",
      )
      .get("other-attempt"),
    undefined,
  );
});
test("a web-only accepted plan removes every unassigned installation template and reserves only its actual role", async (t) => {
  const f = await fixture(t, false, true),
    plan = await read(f.stable.capacityPlanPath),
    templates = { ...f.stable.capacityTemplates };
  for (const role of ["web", "coordinator", "owner"]) {
    const resources = structuredClone(plan.allocations.candidate[0].resources),
      id = "template-" + role;
    plan.allocations.candidate.push({
      id,
      resources,
      resident: false,
      identityDigest: digest(id),
    });
    templates[role] = { allocationId: id, resources };
  }
  const frozen = freezeCapacityBudget(plan);
  await atomicJson(f.stable.capacityPlanPath, frozen);
  f.setScope("web-only", 1);
  await f.supervisor.admit({
    operationId: "web-only",
    epoch: 1,
    executorId: "agent",
  });
  const business = {
      planDigest: digest("web-plan"),
      package: { digest: digest("web-package") },
      steps: [{ kind: "web" }],
    },
    command = {
      operationId: "web-only",
      commandId: "web-only:reserve",
      stepId: "reservation",
      authorization: f.supervisor.currentAuthorization(),
      spec: {
        schemaVersion: 1,
        kind: "capacity-reservation",
        instanceId: f.instanceId,
        request: {
          attemptId: "web-only",
          planDigest: business.planDigest,
          packageDigest: business.package.digest,
          roles: ["web"],
        },
        capacityPlanDigest: frozen.planDigest,
        sourceDigest: frozen.sourceDigest,
        deadline: f.now + 10000,
        budget: { maxDurationMs: 10000 },
      },
    };
  // The installed template table is immutable; this is a fresh private fixture
  // with an explicit four-role template configuration, not a production update.
  f.supervisor.assembly.sqlite
    .prepare("DELETE FROM supervisor_capacity_templates")
    .run();
  const real = createAttemptCapacityReservations({
    sqlite: f.supervisor.assembly.sqlite,
    instanceId: f.instanceId,
    templates,
    planPath: f.stable.capacityPlanPath,
    configPath: f.stable.capacityCollectorConfigPath,
    clock: () => f.now,
  });
  await real.prepare(
    command,
    {
      attempt: { instanceId: f.instanceId, attemptId: "web-only" },
      plan: business,
    },
    await f.runtime.collect(),
  );
  const result = await read(f.stable.capacityPlanPath);
  assert.equal(result.allocations.candidate.length, 1);
  assert.equal(
    result.allocations.candidate[0].id,
    "attempt-" +
      digest({
        instanceId: f.instanceId,
        attemptId: "web-only",
        role: "web",
      }).slice(7),
  );
  assert.equal(f.running.size, 2);
  assert.equal(real.templateDigest, digest(templates));
});
test("failed-before-start reservation is released with actual terminal/global/local/journal proof, while an unknown original start remains charged", async (t) => {
  const f = await fixture(t, false, true),
    b = await reserve(f, "attempt-b", 1);
  attempt(f, "attempt-b", "failed", 1);
  const original = f.supervisor.assembly.sqlite
    .prepare(
      "SELECT * FROM supervisor_capacity_reservations WHERE attempt_id=?",
    )
    .get("attempt-b");
  const c = await reserve(f, "attempt-c", 2),
    after = await read(f.stable.capacityPlanPath);
  assert.equal(
    after.allocations.candidate.some(
      (row) => row.id === b.row.result.allocationIds.api,
    ),
    false,
  );
  assert.deepEqual(
    f.supervisor.assembly.sqlite
      .prepare(
        "SELECT * FROM supervisor_capacity_reservations WHERE attempt_id=?",
      )
      .get("attempt-b"),
    original,
  );
  const intent = JSON.parse(
    f.supervisor.assembly.sqlite
      .prepare(
        "SELECT intent FROM supervisor_capacity_reservations WHERE attempt_id=?",
      )
      .get("attempt-c").intent,
  );
  assert.equal(intent.releasedReservations[0].attempt.attempt_id, "attempt-b");
  assert.equal(intent.releasedReservations[0].revokingAuthority.epoch, 2);
  attempt(f, "attempt-c", "failed", 2);
  const journal = createControlCommandJournal({
      sqlite: f.controlDb,
      instanceId: f.instanceId,
      clock: () => f.now,
      assertAuthority: () => {},
    }),
    command = {
      operationId: "attempt-c",
      commandId: "root-unknown-start",
      stepId: "candidate",
      authorization: f.supervisor.currentAuthorization(),
      spec: {
        kind: "supervisor-start",
        instanceId: f.instanceId,
        request: { attemptId: "attempt-c", kind: "api" },
        capacityAllocationId: c.row.result.allocationIds.api,
        deadline: f.now + 10000,
        budget: { maxDurationMs: 10000 },
      },
    };
  journal.prepare(command);
  journal.begin(command);
  journal.record({
    ...command,
    state: "unknown",
    result: { code: "LOST_ACK" },
  });
  const d = await reserve(f, "attempt-d", 3),
    held = await read(f.stable.capacityPlanPath);
  assert(d.row.result.qualified);
  assert.equal(
    held.allocations.candidate.some(
      (row) => row.id === c.row.result.allocationIds.api,
    ),
    true,
  );
  assert.equal(f.running.size, 2);
});
