import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createControlStabilization } from "./control-stabilization.mjs";
import { digest } from "./trust.mjs";
const Database = createRequire(
  new URL("../../api/package.json", import.meta.url),
)("better-sqlite3");
function fixture(t) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  let now = 100000,
    writerReads = 0;
  const peer = {
    instanceId: "instance",
    startIdentity: "coordinator-start-identity",
    artifactDigest: digest("coordinator"),
    generation: 8,
    writerFenceValid: true,
    observedAt: new Date(now - 3000).toISOString(),
  };
  const writer = {
    ...peer,
    accepting: false,
    lease: {
      instanceId: "instance",
      generation: 8,
      fence: 8,
      holderId: "holder",
      expiresAt: now + 10000,
    },
    observedAt: new Date(now - 1000).toISOString(),
  };
  const record = {
    containerId: "a".repeat(64),
    startIdentity: peer.startIdentity,
    artifactDigest: peer.artifactDigest,
    origin: "http://127.0.0.1:45001",
    physical: {
      running: true,
      paused: false,
      startIdentity: peer.startIdentity,
    },
    actualIdentity: peer,
  };
  const inventory = {
    instanceId: "instance",
    observedAt: new Date(now).toISOString(),
    complete: true,
    coordinators: [record],
  };
  const client = createControlStabilization({
    sqlite: db,
    instanceId: "instance",
    supervisorOrigin: "http://127.0.0.1:45000",
    supervisorKey: "s".repeat(32),
    controllerKey: "c".repeat(32),
    clock: () => now,
    fetcher: async (url) => {
      if (url.endsWith("/coordinator-inventory"))
        return new Response(JSON.stringify(inventory));
      assert.ok(url.endsWith("/internal/upgrades/inspection"));
      writerReads++;
      return new Response(
        JSON.stringify({
          instanceId: "instance",
          action: "writerIdentity",
          result: writer,
        }),
      );
    },
  });
  return {
    db,
    peer,
    writer,
    record,
    inventory,
    client,
    advance: (ms) => {
      now += ms;
    },
    get writerReads() {
      return writerReads;
    },
  };
}
test("persisted witness retains the actual oldest sample time and valid writer receipt", async (t) => {
  const f = fixture(t),
    result = await f.client.capture({ recoveryId: "recovery" });
  assert.equal(result.writer.generation, 8);
  const proof = JSON.parse(
    f.db.prepare("SELECT proof FROM control_stabilization_witnesses").get()
      .proof,
  );
  assert.equal(proof.coordinators[0].observedAt, f.peer.observedAt);
  assert.equal(proof.observedAt, f.peer.observedAt);
  assert.equal(f.writerReads, 1);
});
test("fresh inventory cannot refresh a stale or unknown actual peer identity", async (t) => {
  for (const change of [
    (r) => {
      r.actualIdentity.observedAt = new Date(94999).toISOString();
    },
    (r) => {
      delete r.actualIdentity;
    },
  ]) {
    const f = fixture(t);
    change(f.record);
    await assert.rejects(
      f.client.capture({ recoveryId: "recovery" }),
      /CONTROL_STABILIZATION_PEER_IDENTITY_CHANGED/,
    );
    assert.equal(f.writerReads, 0);
    assert.equal(
      f.db
        .prepare("SELECT count(*) n FROM control_stabilization_witnesses")
        .get().n,
      0,
    );
  }
});
test("stopped or paused coordinator never becomes an inferred non-writer proof", async (t) => {
  for (const physical of [
    { running: false, paused: false },
    { running: true, paused: true },
  ]) {
    const f = fixture(t);
    Object.assign(f.record.physical, physical);
    await assert.rejects(
      f.client.capture({ recoveryId: "recovery" }),
      /CONTROL_STABILIZATION_(PHYSICAL_PROCESS|RETIRED_PROOF)_UNKNOWN/,
    );
    assert.equal(f.writerReads, 0);
  }
});
test("stale writer lease proof fails, and elapsed time does not extend the original peer budget", async (t) => {
  const f = fixture(t);
  f.writer.observedAt = new Date(94999).toISOString();
  await assert.rejects(
    f.client.capture({ recoveryId: "recovery" }),
    /CONTROL_STABILIZATION_WRITER_UNKNOWN/,
  );
  f.writer.observedAt = new Date(100000).toISOString();
  f.advance(2001);
  f.inventory.observedAt = new Date(102001).toISOString();
  await assert.rejects(
    f.client.capture({ recoveryId: "recovery" }),
    /CONTROL_STABILIZATION_PEER_IDENTITY_CHANGED/,
  );
});

test("explicit fresh normal-exit physical proof preserves exitedAt and is included in the inventory witness digest", async (t) => {
  const f = fixture(t),
    target = {
      containerId: "b".repeat(64),
      startIdentity: "retired-coordinator-start",
      artifactDigest: digest("old"),
      DockerStartedAt: "2026-10-20T00:00:00Z",
      restartCount: 0,
    };
  const facts = {
    schemaVersion: 1,
    kind: "coordinator-normal-exit",
    instanceId: "instance",
    migrationId: "migration",
    originalCommandId: "migration:stop-writer",
    target,
    after: { running: false, hostPid: 0, restartPolicy: "no", restartCount: 0 },
    exitedAt: new Date(50000).toISOString(),
  };
  f.inventory.coordinators.push({
    ...target,
    physical: {
      running: false,
      hostPid: 0,
      paused: false,
      startIdentity: target.startIdentity,
      DockerStartedAt: target.DockerStartedAt,
      restartPolicy: "no",
      restartCount: 0,
    },
    retiredPhysical: {
      ...facts,
      receiptDigest: digest(facts),
      observedAt: new Date(99000).toISOString(),
    },
  });
  const result = await f.client.capture({ recoveryId: "recovery" });
  const proof = JSON.parse(
      f.db.prepare("SELECT proof FROM control_stabilization_witnesses").get()
        .proof,
    ),
    retired = proof.coordinators.find((c) => c.kind === "retired-physical");
  assert.equal(retired.exitedAt, facts.exitedAt);
  assert.equal(retired.writerFenceValid, false);
  assert.equal(retired.observedAt, new Date(99000).toISOString());
  f.inventory.coordinators[1].retiredPhysical.observedAt = new Date(
    94000,
  ).toISOString();
  await assert.rejects(
    f.client.capture({ recoveryId: "another" }),
    /CONTROL_STABILIZATION_RETIRED_PROOF_UNKNOWN/,
  );
});
