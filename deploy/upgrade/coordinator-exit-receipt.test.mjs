import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "../test-support/supervisor-runtime-fixture.mjs";
import {
  publishCandidateCoordinatorExit,
  validateCoordinatorExitReceipt,
} from "./coordinator-exit-receipt.mjs";
import { createCoordinatorInventory } from "./supervisor-inventory.mjs";
import { digest, canonical } from "./trust.mjs";
import { atomicJson } from "./io.mjs";

test("real Supervisor applied receipt keeps its durable barrier until typed retirement publication and capacity cleanup; cached replay is unchanged", async (t) => {
  const f = await fixture(t),
    old = [...f.running.values()].find((r) => r.role === "coordinator");
  f.setScope("retire-operation", 1);
  await f.supervisor.admit({
    operationId: "retire-operation",
    epoch: 1,
    executorId: "agent",
  });
  const target = {
      instanceId: f.instanceId,
      role: "coordinator",
      containerId: old.containerId,
      startIdentity: old.startIdentity,
      artifactDigest: old.artifactDigest,
      hostPid: old.hostPid,
      startedAt: old.startedAt,
      attemptId: "old-attempt",
    },
    command = {
      operationId: "retire-operation",
      commandId: "retire-coordinator",
      stepId: "retire",
      authorization: f.supervisor.currentAuthorization(),
      spec: {
        kind: "retire-candidate",
        instanceId: f.instanceId,
        target,
        deadline: f.now + 10000,
        budget: { maxDurationMs: 10000 },
      },
    };
  f.supervisor.journal.prepare(command);
  f.supervisor.journal.begin(command);
  const row = f.supervisor.journal.record({
      ...command,
      state: "applied",
      result: {
        instanceId: f.instanceId,
        operationId: command.operationId,
        commandId: command.commandId,
        specDigest: digest(command.spec),
        target,
        signal: "SIGTERM",
        forced: false,
        removed: false,
        volumesRemoved: false,
        normalExit: true,
        exit: { running: false, hostPid: 0, oomKilled: false, exitCode: 143 },
      },
    }),
    before = canonical(await fs.readFile(f.stable.capacityPlanPath, "utf8"));
  let physical = { ...old, running: false, hostPid: 0, exitCode: 143 };
  f.running.delete(old.containerId);
  const retiredRoot = join(f.root, "retired"),
    options = {
      instanceId: f.instanceId,
      row,
      retiredRoot,
      inspect: async () => physical,
      clock: () => f.now,
    };
  await assert.rejects(
    publishCandidateCoordinatorExit(options),
    /COORDINATOR_RETIREMENT_EXIT_UNKNOWN/,
  );
  assert(
    f.supervisor.assembly.sqlite
      .prepare("SELECT 1 FROM supervisor_side_effect")
      .get(),
  );
  assert.equal(
    canonical(await fs.readFile(f.stable.capacityPlanPath, "utf8")),
    before,
  );
  physical = { ...physical, finishedAt: new Date(f.now - 1).toISOString() };
  const receipt = await publishCandidateCoordinatorExit(options);
  assert.equal(receipt.operationId, command.operationId);
  assert.equal(Object.hasOwn(receipt, "migrationId"), false);
  assert.equal(receipt.exitedAt, physical.finishedAt);
  assert(
    f.supervisor.assembly.sqlite
      .prepare("SELECT 1 FROM supervisor_side_effect")
      .get(),
  );
  await f.runtime.appliedStart(row);
  assert.equal(
    f.supervisor.assembly.sqlite
      .prepare("SELECT 1 FROM supervisor_side_effect")
      .get(),
    undefined,
  );
  assert.deepEqual(await publishCandidateCoordinatorExit(options), receipt);
  await f.runtime.appliedStart(row);
  assert.deepEqual(f.supervisor.lookup(command), row);
  const proc = join(f.root, "coordinator-processes"),
    registry = join(f.root, "registry.json");
  await fs.mkdir(proc);
  await atomicJson(registry, [{ ...old, kind: "coordinator" }]);
  const collect = createCoordinatorInventory({
    instanceId: f.instanceId,
    processRoot: proc,
    registryPath: registry,
    retiredRoot,
    inspect: async () => physical,
    clock: () => f.now,
    readIdentity: () => {
      throw Error("Stopped process has no live metadata");
    },
  });
  const inventory = await collect();
  assert.equal(inventory.complete, true);
  assert.equal(
    inventory.coordinators[0].retiredPhysical.operationKind,
    "candidate-retirement",
  );
  physical = { ...physical, restartCount: 1 };
  assert.equal((await collect()).complete, false);
});
test("typed exit validation rejects forced/OOM/restarted/future/mismatched physical retirement proof without signalling", async (t) => {
  const f = await fixture(t),
    old = [...f.running.values()].find((r) => r.role === "coordinator"),
    target = {
      instanceId: f.instanceId,
      role: "coordinator",
      containerId: old.containerId,
      startIdentity: old.startIdentity,
      artifactDigest: old.artifactDigest,
      hostPid: old.hostPid,
      startedAt: old.startedAt,
      attemptId: "old-attempt",
    },
    spec = { kind: "retire-candidate", instanceId: f.instanceId, target },
    row = {
      state: "applied",
      operationId: "operation",
      commandId: "command",
      spec,
      specDigest: digest(spec),
      result: {
        instanceId: f.instanceId,
        operationId: "operation",
        commandId: "command",
        specDigest: digest(spec),
        target,
        signal: "SIGTERM",
        forced: false,
        removed: false,
        volumesRemoved: false,
        normalExit: true,
        exit: { running: false, hostPid: 0, oomKilled: false, exitCode: 143 },
      },
    };
  const good = {
      ...old,
      running: false,
      hostPid: 0,
      exitCode: 143,
      finishedAt: new Date(f.now - 1).toISOString(),
    },
    options = {
      instanceId: f.instanceId,
      row,
      retiredRoot: join(f.root, "retired"),
      clock: () => f.now,
    };
  for (const change of [
    { oomKilled: true },
    { restartCount: 1 },
    { paused: true },
    { restartPolicy: "always" },
    { finishedAt: new Date(f.now + 1).toISOString() },
    { startIdentity: "replacement" },
  ])
    await assert.rejects(
      publishCandidateCoordinatorExit({
        ...options,
        inspect: async () => ({ ...good, ...change }),
      }),
      /COORDINATOR_RETIREMENT_EXIT_UNKNOWN/,
    );
  let count = 0;
  await assert.rejects(
    publishCandidateCoordinatorExit({
      ...options,
      inspect: async () => ({
        ...good,
        finishedAt: new Date(f.now - 1 - count++).toISOString(),
      }),
    }),
    /COORDINATOR_RETIREMENT_EXIT_CHANGED/,
  );
  const receipt = await publishCandidateCoordinatorExit({
    ...options,
    inspect: async () => good,
  });
  assert(
    validateCoordinatorExitReceipt(receipt, {
      instanceId: f.instanceId,
      target: { ...good, DockerStartedAt: good.startedAt },
      now: f.now,
    }),
  );
  assert.equal(
    validateCoordinatorExitReceipt(
      { ...receipt, operationId: "other" },
      { instanceId: f.instanceId, target: good, now: f.now },
    ),
    false,
  );
});
