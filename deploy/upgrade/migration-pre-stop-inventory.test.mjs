import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { assertMigrationPreStopInventory } from "./migration-pre-stop-inventory.mjs";
import { digest } from "./trust.mjs";

async function inventoryFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "migration-public-inventory-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const processRoot = join(root, "installer/processes"),
    installed = join(root, "supervisor-publication/installed-roles"),
    retiredRoot = join(root, "supervisor-publication/retired-coordinators");
  for (const directory of [processRoot, installed, retiredRoot])
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const records = [1, 2].map(n => ({ kind: "coordinator", instanceId: "instance",
    containerId: String(n).repeat(64), startIdentity: "coordinator-start-identity-" + n,
    artifactDigest: digest("coordinator-" + n) }));
  let writerValid = true, generation = 7, oversized = false;
  const requests = [], server = createServer((req, res) => {
    const management = req.url === "/internal/coordinator/identity", r = records[management ? 1 : 0];
    requests.push({ path: req.url, key: req.headers["x-platform-internal-key"] });
    if (req.headers["x-platform-internal-key"] !== (management ? "b" : "a").repeat(32) ||
        req.headers["x-platform-instance-id"] !== "instance") {
      res.writeHead(403); res.end("{}"); return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ instanceId: "instance", role: management ? "coordinator-prepared" : "coordinator",
      startIdentity: r.startIdentity, artifactDigest: r.artifactDigest, pid: 1,
      ...(management ? { generation } : { coordinatorGeneration: generation }), writerFenceValid: writerValid,
      ...(oversized ? { ignored: "x".repeat(17000) } : {}) }));
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise(done => server.close(done)));
  const origin = "http://127.0.0.1:" + server.address().port;
  Object.assign(records[0], { origin, metadataPath: "/internal/application/identity" });
  Object.assign(records[1], { origin, managementOrigin: origin });
  const states = new Map(records.map((r, i) => [r.containerId, {
    containerId: r.containerId, startIdentity: r.startIdentity, artifactDigest: r.artifactDigest,
    hostPid: i === 0 ? 1234 : 0, pid: 1, running: i === 0, paused: false, restartPolicy: "no",
    restartCount: 0, oomKilled: false, exitCode: 0, startedAt: "2026-10-20T00:00:00.000Z",
  }]));
  const registryPath = join(installed, "installed-roles.json"), configPath = join(root, "supervisor.json"),
    receiptPath = join(retiredRoot, records[1].containerId + ".json"),
    keys = { control: "a".repeat(32), controller: "b".repeat(32) },
    foundation = { c: { root, instanceId: "instance", foundationMode: "supervisor", trustRootPath: join(root, "trust.json") },
      context: { paths: { installer: join(root, "installer") }, keys: structuredClone(keys) } };
  const facts = { schemaVersion: 1, kind: "coordinator-normal-exit", instanceId: "instance",
    migrationId: "original-migration", originalCommandId: "original-migration:stop-writer",
    target: { containerId: records[1].containerId, startIdentity: records[1].startIdentity,
      artifactDigest: records[1].artifactDigest, DockerStartedAt: states.get(records[1].containerId).startedAt, restartCount: 0 },
    after: { running: false, hostPid: 0, restartPolicy: "no", restartCount: 0 },
    exitedAt: "2026-10-20T00:01:00.000Z" };
  await fs.writeFile(registryPath, JSON.stringify(records), { mode: 0o600 });
  for (const [i, record] of records.entries())
    await fs.writeFile(join(processRoot, i + "-coordinator.json"), JSON.stringify(record), { mode: 0o600 });
  await fs.writeFile(receiptPath, JSON.stringify({ ...facts, receiptDigest: digest(facts) }), { mode: 0o600 });
  await fs.writeFile(configPath, JSON.stringify(foundation), { mode: 0o600 });
  const c = { adapter: { root, trustRootPath: foundation.c.trustRootPath,
    controlFoundationEntries: { supervisor: { configPath } } }, keys,
    legacyProcessRoot: processRoot, installedRolesRoot: installed, retiredCoordinatorRoot: retiredRoot,
    knownCoordinators: records, source: { coordinator: states.get(records[0].containerId) } },
    lease = { instance_id: "instance", generation: 7 };
  const args = { runtime: c, instanceId: "instance", lease,
    inspect: async record => {
      assert.equal(record.role, "coordinator");
      return structuredClone(states.get(record.containerId));
    } };
  return { args, records, states, requests, registryPath, receiptPath, configPath, foundation,
    collect: () => assertMigrationPreStopInventory(args),
    writerValid: value => { writerValid = value; }, generation: value => { generation = value; },
    oversized: () => { oversized = true; } };
}

test("pre-stop gate consumes actual public process/registry/retirement bytes and a real authenticated identity GET", async t => {
  const f = await inventoryFixture(t), result = await f.collect();
  assert.equal(result.coordinatorCount, 2);
  assert.equal(result.sourceContainerId, f.records[0].containerId);
  assert.equal(result.writerGeneration, 7);
  assert.deepEqual(f.requests, [{ path: "/internal/application/identity", key: "a".repeat(32) }]);
  assert.equal(result.publicRoots.registryPath, f.registryPath);
  assert.ok(!JSON.stringify(result).includes("a".repeat(32)));
  assert.ok(!JSON.stringify(result).includes("b".repeat(32)));
});

test("private-only or corrupt historical receipts cannot satisfy the real public-root consumer", async t => {
  for (const corrupt of [false, true]) await t.test(corrupt ? "corrupt public receipt" : "public receipt missing", async t => {
    const f = await inventoryFixture(t);
    if (corrupt) await fs.writeFile(f.receiptPath, "{}", { mode: 0o600 });
    else await fs.rename(f.receiptPath, f.receiptPath + ".private-preparation-only");
    await assert.rejects(f.collect(), { code: "CONTROL_MIGRATION_PUBLIC_INVENTORY_UNPROVEN" });
  });
});

test("pre-stop public inventory rejects missing/extra known CIDs, a different source birth, and competing live writers", async t => {
  for (const mutation of ["missing-known", "extra-known", "birth", "two-live", "generation", "fence"]) await t.test(mutation, async t => {
    const f = await inventoryFixture(t);
    if (mutation === "missing-known") f.args.runtime.knownCoordinators = [f.records[0]];
    if (mutation === "extra-known") f.args.runtime.knownCoordinators = [...f.records, { containerId: "3".repeat(64) }];
    if (mutation === "birth") f.args.runtime.source.coordinator = { ...f.args.runtime.source.coordinator, hostPid: 9999 };
    if (mutation === "two-live") Object.assign(f.states.get(f.records[1].containerId), { running: true, hostPid: 2345 });
    if (mutation === "generation") f.generation(8);
    if (mutation === "fence") f.writerValid(false);
    await assert.rejects(f.collect(), { code: ["missing-known", "extra-known"].includes(mutation)
      ? "CONTROL_MIGRATION_PUBLIC_INVENTORY_UNPROVEN" : "CONTROL_MIGRATION_PUBLIC_WRITER_UNPROVEN" });
  });
});

test("pre-stop gate cannot guess different Supervisor roots, keys or trust path", async t => {
  for (const mutation of ["root", "installer", "control-key", "controller-key", "trust"]) await t.test(mutation, async t => {
    const f = await inventoryFixture(t);
    if (mutation === "root") f.foundation.c.root += "-other";
    if (mutation === "installer") f.foundation.context.paths.installer += "-other";
    if (mutation === "control-key") f.foundation.context.keys.control = "c".repeat(32);
    if (mutation === "controller-key") f.foundation.context.keys.controller = "c".repeat(32);
    if (mutation === "trust") f.foundation.c.trustRootPath += "-other";
    await fs.writeFile(f.configPath, JSON.stringify(f.foundation), { mode: 0o600 });
    await assert.rejects(f.collect(), { code: "CONTROL_MIGRATION_PUBLIC_INVENTORY_CONFIG_CHANGED" });
    assert.deepEqual(f.requests, []);
  });
});

test("pre-stop inventory retains the original identity response bound and two-second consumer timeout", async t => {
  await t.test("oversized real identity response", async t => {
    const f = await inventoryFixture(t); f.oversized();
    await assert.rejects(f.collect(), { code: "CONTROL_MIGRATION_PUBLIC_INVENTORY_UNPROVEN" });
  });
  await t.test("blocked inspect", async t => {
    const f = await inventoryFixture(t);
    f.args.inspect = async () => new Promise(() => {});
    const started = Date.now();
    await assert.rejects(f.collect(), { code: "CONTROL_MIGRATION_PUBLIC_INVENTORY_UNPROVEN" });
    assert.ok(Date.now() - started >= 1900);
    assert.ok(Date.now() - started < 3000);
  });
});

test("pre-stop inventory refuses a public response larger than 256 KiB without enlarging per-receipt limits", async t => {
  const f = await inventoryFixture(t),
    template = JSON.parse(await fs.readFile(f.receiptPath, "utf8"));
  for (let n = 4; n < 24; n++) {
    const record = { ...f.records[1], containerId: n.toString(16).padStart(64, "0"),
      startIdentity: "retired-coordinator-start-" + n };
    const physical = { ...f.states.get(f.records[1].containerId),
      containerId: record.containerId, startIdentity: record.startIdentity };
    f.records.push(record); f.states.set(record.containerId, physical);
    const { receiptDigest, ...facts } = template;
    facts.target = { ...facts.target, containerId: record.containerId, startIdentity: record.startIdentity };
    facts.publicEvidence = "x".repeat(13000);
    await fs.writeFile(join(f.args.runtime.retiredCoordinatorRoot, record.containerId + ".json"),
      JSON.stringify({ ...facts, receiptDigest: digest(facts) }), { mode: 0o600 });
  }
  await fs.writeFile(f.registryPath, JSON.stringify(f.records), { mode: 0o600 });
  await assert.rejects(f.collect(), { code: "CONTROL_MIGRATION_PUBLIC_INVENTORY_LIMIT" });
});
