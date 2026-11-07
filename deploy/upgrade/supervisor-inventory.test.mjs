import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCoordinatorIdentityReader,
  createCoordinatorInventory,
} from "./supervisor-inventory.mjs";
import { digest } from "./trust.mjs";

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "coordinator-live-inventory-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const retiredRoot = join(root, "retired");
  await fs.mkdir(retiredRoot);
  const processRoot = join(root, "processes"),
    registryPath = join(root, "installed-roles.json");
  await fs.mkdir(processRoot);
  const keys = { controlKey: "a".repeat(32), controllerKey: "b".repeat(32) };
  const requests = [];
  let alter = (value) => value;
  const records = [1, 2].map((n) => ({
    instanceId: "instance",
    kind: "coordinator",
    containerId: String(n).repeat(64),
    startIdentity: `coordinator-start-identity-${n}`,
    artifactDigest: digest(`coordinator-${n}`),
  }));
  const server = createServer((req, res) => {
    const management = req.url === "/internal/coordinator/identity";
    const r = records[management ? 1 : 0];
    requests.push({
      path: req.url,
      key: req.headers["x-platform-internal-key"],
    });
    if (
      req.headers["x-platform-internal-key"] !==
      (management ? keys.controllerKey : keys.controlKey)
    ) {
      res.writeHead(403);
      res.end("{}");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        alter({
          instanceId: "instance",
          role: management ? "coordinator-prepared" : "coordinator",
          pid: 1,
          startIdentity: r.startIdentity,
          artifactDigest: r.artifactDigest,
          ...(management
            ? { generation: 0 }
            : { coordinatorGeneration: 7, accepting: true }),
          writerFenceValid: !management,
        }),
      ),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const origin = "http://127.0.0.1:" + server.address().port;
  Object.assign(records[0], {
    origin,
    metadataPath: "/internal/application/identity",
  });
  Object.assign(records[1], { origin, managementOrigin: origin });
  await fs.writeFile(registryPath, JSON.stringify([records[0]]), {
    mode: 0o600,
  });
  await fs.writeFile(
    join(processRoot, "new-coordinator.json"),
    JSON.stringify(records[1]),
    { mode: 0o600 },
  );
  let physicalAlter = (value) => value;
  const inspect = async (id) => {
    const r = records.find((r) => r.containerId === id);
    return physicalAlter({
      ...r,
      pid: 1,
      hostPid: 1234,
      startedAt: "2026-10-20T12:00:00.000Z",
      running: true,
      paused: false,
    });
  };
  const readIdentity = createCoordinatorIdentityReader({
    instanceId: "instance",
    ...keys,
  });
  return {
    keys,
    requests,
    records,
    readIdentity,
    root,
    processRoot,
    registryPath,
    retiredRoot,
    collect: () =>
      createCoordinatorInventory({
        instanceId: "instance",
        processRoot,
        registryPath,
        retiredRoot,
        inspect,
        readIdentity,
      })(),
    alter: (fn) => {
      alter = fn;
    },
    physicalAlter: (fn) => {
      physicalAlter = fn;
    },
  };
}

test("real fixed identity GETs use separate legacy and prepared keys, preserving real writer/generation proof without secrets", async (t) => {
  const f = await fixture(t),
    result = await f.collect();
  assert.equal(result.complete, true);
  assert.deepEqual(f.requests, [
    { path: "/internal/application/identity", key: f.keys.controlKey },
    { path: "/internal/coordinator/identity", key: f.keys.controllerKey },
  ]);
  assert.deepEqual(
    result.coordinators.map((r) => [
      r.actualIdentity.generation,
      r.actualIdentity.writerFenceValid,
    ]),
    [
      [7, true],
      [0, false],
    ],
  );
  assert.equal(result.coordinators[0].actualIdentity.accepting, true);
  assert.ok(
    result.coordinators.every(
      (r) => Date.now() - Date.parse(r.actualIdentity.observedAt) < 2000,
    ),
  );
  const text = JSON.stringify(result);
  assert.equal(text.includes(f.keys.controlKey), false);
  assert.equal(text.includes(f.keys.controllerKey), false);
});
test("identity mismatch, unknown writer and Docker birth change never claim a complete inventory", async (t) => {
  const f = await fixture(t);
  for (const alter of [
    (v) => ({ ...v, startIdentity: "other-start-identity" }),
    (v) => ({ ...v, writerFenceValid: undefined }),
    (v) => ({ ...v, artifactDigest: digest("other") }),
  ]) {
    f.alter(alter);
    assert.equal((await f.collect()).complete, false);
  }
  f.alter((v) => v);
  let count = 0;
  f.physicalAlter((v) => ({ ...v, hostPid: 1234 + count++ }));
  assert.equal((await f.collect()).complete, false);
});
test("unsupported path or non-loopback origin rejects before HTTP; missing Controller key cannot fall back to application key", async (t) => {
  const f = await fixture(t),
    signal = new AbortController().signal;
  await assert.rejects(
    f.readIdentity({ ...f.records[0], metadataPath: "/anything" }, { signal }),
    /COORDINATOR_METADATA_PATH_UNKNOWN/,
  );
  await assert.rejects(
    f.readIdentity(
      { ...f.records[0], origin: "http://example.com" },
      { signal },
    ),
    /COORDINATOR_INVENTORY_ORIGIN_UNKNOWN/,
  );
  const noController = createCoordinatorIdentityReader({
    instanceId: "instance",
    controlKey: f.keys.controlKey,
  });
  await assert.rejects(
    noController(f.records[1], { signal }),
    /COORDINATOR_METADATA_AUTHORITY_UNKNOWN/,
  );
  assert.equal(f.requests.length, 0);
});
test("large response or identity timeout remains unknown within original inventory budget", async (t) => {
  const f = await fixture(t);
  f.alter((v) => ({ ...v, extra: "x".repeat(20000) }));
  assert.equal((await f.collect()).complete, false);
  let calls = 0;
  const reader = createCoordinatorIdentityReader({
    instanceId: "instance",
    ...f.keys,
    fetcher: async (_url, { signal }) => {
      calls++;
      await new Promise((resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  const collect = createCoordinatorInventory({
    instanceId: "instance",
    processRoot: f.processRoot,
    registryPath: f.registryPath,
    timeoutMs: 30,
    inspect: async (id) => ({
      ...f.records.find((r) => r.containerId === id),
      pid: 1,
      hostPid: 1,
      startedAt: "2026-10-20T12:00:00Z",
      running: true,
      paused: false,
    }),
    readIdentity: reader,
  });
  const at = performance.now(),
    result = await collect();
  assert.equal(result.complete, false);
  assert.ok(performance.now() - at < 300);
  assert.equal(calls, 1);
});

test("normal-exit receipt requires current stopped full birth twice; receipt alone never substitutes for live metadata", async (t) => {
  const f = await fixture(t),
    r = f.records[0],
    target = {
      containerId: r.containerId,
      startIdentity: r.startIdentity,
      artifactDigest: r.artifactDigest,
      DockerStartedAt: "2026-10-20T12:00:00.000Z",
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
    exitedAt: new Date(Date.now() - 10000).toISOString(),
  };
  const receipt = { ...facts, receiptDigest: digest(facts) };
  await fs.writeFile(
    join(f.retiredRoot, r.containerId + ".json"),
    JSON.stringify(receipt),
    { mode: 0o600 },
  );
  f.physicalAlter((v) =>
    v.containerId === r.containerId
      ? {
          ...v,
          running: false,
          hostPid: 0,
          paused: false,
          restartPolicy: "no",
          restartCount: 0,
        }
      : v,
  );
  const result = await f.collect();
  assert.equal(result.complete, true);
  const stopped = result.coordinators.find(
    (c) => c.containerId === r.containerId,
  );
  assert.equal(stopped.actualIdentity, undefined);
  assert.equal(stopped.retiredPhysical.exitedAt, receipt.exitedAt);
  f.physicalAlter((v) =>
    v.containerId === r.containerId
      ? {
          ...v,
          running: false,
          hostPid: 0,
          paused: false,
          restartPolicy: "always",
          restartCount: 0,
        }
      : v,
  );
  assert.equal((await f.collect()).complete, false);
  f.physicalAlter((v) =>
    v.containerId === r.containerId
      ? {
          ...v,
          running: false,
          hostPid: 0,
          paused: false,
          restartPolicy: "no",
          restartCount: 1,
        }
      : v,
  );
  assert.equal((await f.collect()).complete, false);
  await fs.rm(join(f.retiredRoot, r.containerId + ".json"));
  assert.equal((await f.collect()).complete, false);
});
