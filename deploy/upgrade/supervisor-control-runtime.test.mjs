import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { createSupervisorControl } from './supervisor-control.mjs';
import { createSupervisorControlRuntime } from './supervisor-control-runtime.mjs';
import { createCandidateSupervisor } from './candidate-supervisor.mjs';
import { createControlMaintenanceClient, runControlMaintenanceClient } from './control-maintenance-client.mjs';
import { createControlAuthority } from './control-authority.mjs';
import { createControlRecoveryStore } from './control-recovery-store.mjs';
import { createControlCommandJournal } from './control-command-journal.mjs';
import { freezeCapacityBudget, evaluateCapacityAdmission } from './capacity-admission.mjs';
import { capacityResidentIdentity, capacityHostIdentity } from './control-capacity-collector.mjs';
import { digest, canonical } from './trust.mjs';
import { atomicJson, treeManifest, fileDigest } from './io.mjs';
const requireApi = createRequire(new URL('../../api/package.json', import.meta.url)), Database = requireApi('better-sqlite3');
const vector = (memoryBytes, cpuMilliCores, ioBytesPerSecond) => ({ memoryBytes, cpuMilliCores, ioBytesPerSecond, disks: { data: 0 } });

async function fixture(t, withMaintenance = false) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'supervisor-runtime-'))), cleanup = []; let supervisor, runtime, controlDb; t.after(async () => { for (const close of cleanup) await close(); await runtime?.close(); supervisor?.close(); controlDb?.close(); await fs.rm(root, { recursive: true, force: true }); });
  const now = Date.parse('2026-10-20T12:00:00Z'), instanceId = 'runtime-instance';
  const physical = (n, role, memoryBytes) => ({ containerId: String(n).repeat(64), pid: 100 + n, hostPid: 100 + n, birthTicks: String(1000 + n), cgroupDigest: digest('cg-' + n), startedAt: new Date(now - 10000).toISOString(), restartCount: 0, instanceId,
    role, startIdentity: 'original-birth-' + n, artifactDigest: digest('artifact-' + n), running: true, paused: false, restartPolicy:'no', oomKilled:false, exitCode:0, memoryBytes });
  const source = physical(1, 'coordinator', 1000), agent = physical(2, 'control-agent', 500), running = new Map([[source.containerId, source], [agent.containerId, agent]]);
  let calls = 0, starts = 0, stops = 0, releaseStop = null, stopReached;
  const stopped = new Promise(ok => { stopReached = ok; });
  // Explicit state/counter fixtures. No test here claims Linux/Docker or IO
  // qualification. The runtime still invokes the actual collector and journal.
  const sample = async () => { const n = ++calls; return { vmBootId: '00112233-4455-6677-8899-aabbccddeeff', procIdentity: { path: '/host/proc', dev: '11', ino: '2' },
    cpu: { cpus: 4, total: 1000 + n * 400, idle: 500 + n * 300 }, memory: { total: 10000, free: 8500 - [...running.values()].reduce((s, r) => s + r.memoryBytes, 0), available: 8500 - [...running.values()].reduce((s, r) => s + r.memoryBytes, 0) },
    devices: [{ id: 'data', dev: '2049', majorMinor: '8:1', capacityBytes: 100000, freeBytes: 80000, availableBytes: 80000, readBytes: 1000 + n * 500, writeBytes: 1000 }],
    containers: [...running.values()].map(row => ({ ...row, cpuNs: 100000000 + n * 5000000, ioBytes: 1000 + n * 100, monotonic: n * 250 })),
    startedAt: now - 500, finishedAt: now - 50, monotonic: n * 250 }; };
  const baseline = await sample(), config = { schemaVersion: 1, instanceId, sourceDigest: digest('base-source'), hostProcRoot: '/host/proc', dockerSocketPath: '/test/docker.sock',
    devices: [{ id: 'data', path: '/data', dev: '2049', majorMinor: '8:1' }], residents: [{ id: 'source', containers: [source] }, { id: 'agent', containers: [agent] }],
    ioEffectiveBudgetBytesPerSecond: 10000, ioQualificationPath: join(root, 'io.json'), ioQualificationRawDigest: digest('pending'), observationPath: join(root, 'observation.json'), sampleIntervalMs: 250, timeoutMs: 2000 };
  const io = { schemaVersion: 1, kind: 'control-io-qualification', instanceId, vmBootId: baseline.vmBootId, devices: [{ id: 'data', dev: '2049', majorMinor: '8:1' }], effectiveBudgetBytesPerSecond: 10000, windowMs: 60000,
    observedAt: new Date(now - 60000).toISOString(), expiresAt: new Date(now + 60000).toISOString(), qualified: true, measurement: { readBytes: 600000, writeBytes: 0, maxLatencyMs: 1, samples: 600, unexpectedErrors: 0 } };
  const ioRaw = JSON.stringify({ ...io, receiptDigest: digest(io) }); config.ioQualificationRawDigest = digest(ioRaw); await fs.writeFile(config.ioQualificationPath, ioRaw, { mode: 0o600 });
  const reserve = (id, resources) => ({ id, resources, resident: false, identityDigest: digest(id) });
  const resident = (id, row, resources) => ({ id, resources, resident: true, identityDigest: capacityResidentIdentity([row]) });
  const plan = freezeCapacityBudget({ instanceId, sourceDigest: config.sourceDigest, maxObservationAgeMs: 5000, limits: { ...vector(10000, 4000, 10000), disks: { data: 100000 } }, allocations: {
    source: [resident('source', source, vector(1200, 100, 500)), { id: 'host-overhead', resident: true, identityDigest: capacityHostIdentity(baseline, instanceId), resources: { ...vector(2000, 1500, 2000), disks: { data: 25000 } } }],
    retainedOwners: [], retainedGuests: [], existingCandidates: [], candidate: [reserve('new-api', vector(1000, 500, 1000))], verification: [], control: [resident('agent', agent, vector(700, 100, 500))], recovery: [reserve('recovery', vector(1000, 500, 500))] } });
  const stable = { origin: 'http://127.0.0.1:1', key: 'c'.repeat(32), accessKey: 'a'.repeat(32), maintenanceKey: 'm'.repeat(32), statePath: join(root, 'supervisor.db'), controlDbPath: join(root, 'ledger/control.db'),
    capacityPlanPath: join(root, 'plan.json'), capacityCollectorConfigPath: join(root, 'collector.json'), capacityTransitionRoot: join(root, 'transitions'), resourceObservationPath: config.observationPath, referenceStatePath: join(root, 'references.json'), agentStartIdentity: agent.startIdentity };
  await atomicJson(stable.capacityPlanPath, plan); await atomicJson(stable.capacityCollectorConfigPath, config); await atomicJson(stable.referenceStatePath, { instanceId, candidates: [] });
  let authority, packages, lifecycle;
  if (withMaintenance) {
    await fs.mkdir(join(root, 'ledger')); controlDb = new Database(stable.controlDbPath); await fs.chmod(stable.controlDbPath, 0o600);
    requireApi(resolve('api/apps/api/dist/platform/upgrade/control-store-factory.js')).createUpgradeControlStores({ sqlite: controlDb, instanceId, clock: { now: () => new Date(now) }, ids: { next: randomUUID } });
    authority = createControlAuthority({ sqlite: controlDb, instanceId, epochFloor: 5, clock: () => now }); authority.activate({ expectedRevision: 1, sourceBindingDigest: plan.sourceDigest });
    createControlRecoveryStore({ sqlite: controlDb, instanceId, clock: () => now }); createControlCommandJournal({ sqlite: controlDb, instanceId, assertAuthority: () => {}, clock: () => now });
    const keys = generateKeyPairSync('ed25519'), trust = join(root, 'trust.json'); await atomicJson(trust, { schemaVersion: 1, keys: [{ id: 'test', publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }) }] });
    packages = {};
    for (const which of ['old', 'new']) {
      const artifactRoot = join(root, which), dist = join(artifactRoot, 'api/apps/api/dist/platform/upgrade'); await fs.mkdir(dist, { recursive: true }); await fs.mkdir(join(artifactRoot, 'installer'));
      await fs.writeFile(join(dist, 'control-store-factory.js'), 'exports.fixture=true;'); await fs.writeFile(join(dist, 'control-store-schema.js'), 'exports.UPGRADE_CONTROL_SCHEMA_VERSION=1;'); await fs.writeFile(join(artifactRoot, 'api/apps/api/package.json'), '{"type":"commonjs"}');
      await fs.writeFile(join(artifactRoot, 'installer/control-main.mjs'), 'export const fixture=' + JSON.stringify(which)); const files = await treeManifest(artifactRoot), engine = digest(files.filter(row => row.path.startsWith('installer/'))), version = which === 'old' ? 'v1.0.0' : 'v1.0.1';
      const manifest = { schemaVersion: 1, kind: 'upgrade-control', protocolVersion: 1, apiRevision: 'a'.repeat(40), projectRevision: 'b'.repeat(40), executionEngineDigest: engine, treeDigest: digest(files), version }, manifestPath = join(root, which + '.signed.json');
      await atomicJson(manifestPath, { manifest, manifestDigest: digest(manifest), signature: { algorithm: 'Ed25519', keyId: 'test', value: sign(null, Buffer.from(canonical(manifest)), keys.privateKey).toString('base64') } });
      const configPath = join(root, which + '.config.json'); await atomicJson(configPath, { instanceId, startIdentity: which === 'old' ? agent.startIdentity : 'new-control-birth', controlArtifactRoot: artifactRoot, controlManifestPath: manifestPath, trustRootPath: trust, controlLedgerRoot: join(root, 'ledger'), controlRoot: join(root, 'auth'), controlPort: 32123 });
      packages[which] = { artifactRoot, manifestPath, trustRootPath: trust, configPath, configDigest: (await fileDigest(configPath)).digest, packageDigest: digest(manifest) };
      if (which === 'old') agent.artifactDigest = engine;
    }
    config.residents[1].containers[0].artifactDigest = agent.artifactDigest; const nextPlan = structuredClone(plan); nextPlan.allocations.control[0].identityDigest = capacityResidentIdentity([agent]); await atomicJson(stable.capacityPlanPath, freezeCapacityBudget(nextPlan)); await atomicJson(stable.capacityCollectorConfigPath, config);
    stable.maintenance = { executorId: 'supervisor-own-birth', packages, capacityAllocation: { id: 'agent', resources: plan.allocations.control[0].resources } };
    const receipts = new Map(), scope = r => ({ instanceId, maintenanceId: r.maintenanceId, commandId: r.commandId, specDigest: r.specDigest });
    lifecycle = {
      inspect: async id => { const live = running.get(id); return live ? { ...live } : receipts.get(id); },
      inventory: async () => ({ instanceId, complete: true, observedAt: new Date(now).toISOString(), agents: [...running.values()].filter(row => row.role === 'control-agent').map(row => ({ ...row })) }),
      stop: async request => { stopReached(); if (releaseStop) await releaseStop; request.assertBeforeDispatch(); const old = running.get(request.target.containerId); running.delete(old.containerId); stops++; const result = { ...old, ...scope(request), running: false, hostPid: 0, exitCode:143, finishedAt:new Date(now).toISOString(), normalExit:true, signal:'SIGTERM', forced:false, removed:false }; receipts.set(old.containerId, result); receipts.set(request.commandId, result); return result; },
      start: async request => { request.assertBeforeDispatch(); starts++; const row = { ...physical(3, 'control-agent', 500), startIdentity: request.startIdentity, artifactDigest: request.packageDigest === packages.new.packageDigest ? digest((await treeManifest(packages.new.artifactRoot)).filter(row => row.path.startsWith('installer/'))) : agent.artifactDigest, ...scope(request) }; running.set(row.containerId, row); receipts.set(request.commandId, row); return row; },
      lookup: async request => ({ ...scope(request), state: receipts.has(request.commandId) ? 'applied' : 'unknown', result: receipts.get(request.commandId) }),
      health: async actual => ({ instanceId, role: 'installer', pid: 1, startIdentity: actual.startIdentity, artifactDigest: actual.artifactDigest, observedAt: new Date(now).toISOString(), controlSystem: { packageDigest: packages.new.packageDigest, protocolVersion: 1, version: 'v1.0.1' } }),
    };
  }
  supervisor = await createSupervisorControl({ root, instanceId, config: stable, Database, readers: { verifyAuthority: async () => ({ instanceId, mode: 'active', epoch: 1, operationId: 'upgrade', holderId: 'agent', kind: 'upgrade', leaseExpiresAt: now + 60000 }) }, clock: () => now });
  runtime = await createSupervisorControlRuntime({ instanceId, config: stable, supervisor, Database, lifecycle, sample, clock: () => now, monotonic: () => 1e9 });
  return { root, cleanup, now, instanceId, plan, config, stable, running, sample, supervisor, runtime, authority, agent, counts: () => ({ starts, stops }), stopped, holdStop() { releaseStop = new Promise(ok => { this.releaseStop = ok; }); },
    maintenanceInput: { maintenanceId: 'maintenance-1', expectedControlEpoch: 5, sourceAgent: structuredClone(agent), deadline: now + 30000, rollbackDeadline: now + 60000 } };
}
async function finished(runtime, id) { for (let i = 0; i < 100; i++) { const value = runtime.maintenanceRequest('status', { maintenanceId: id }); if (!value.pending) return value; await new Promise(ok => setTimeout(ok, 5)); } throw Error('Fixture did not settle'); }

test('actual Supervisor journal receipt rebinds capacity, rereads the new config, and replay never changes the original command', async t => {
  const f = await fixture(t), before = await f.runtime.collect(); assert.equal(before.known, true); assert.equal(evaluateCapacityAdmission({ plan: f.plan, observation: before, now: f.now }).qualified, true);
  await f.supervisor.admit({ epoch: 1, operationId: 'upgrade', executorId: 'agent' });
  const command = { operationId: 'upgrade', commandId: 'start-api', stepId: 'candidate', authorization: f.supervisor.currentAuthorization(), spec: { kind: 'supervisor-start', instanceId: f.instanceId, capacityPlanDigest: f.plan.planDigest, sourceDigest: f.plan.sourceDigest, capacityAllocationId: 'new-api', resources: f.plan.allocations.candidate[0].resources, request: { kind: 'api', attemptId: 'upgrade' }, deadline: f.now + 10000, budget: { maxDurationMs: 10000 } } };
  f.supervisor.journal.prepare(command); f.supervisor.journal.begin(command);
  const actual = { ...f.agent, containerId: '4'.repeat(64), pid: 104, hostPid: 104, birthTicks: '1004', cgroupDigest: digest('new-cg'), role: 'api', startIdentity: 'new-api-birth', memoryBytes: 800, operationId: 'upgrade', commandId: 'start-api' }; f.running.set(actual.containerId, actual);
  const row = f.supervisor.journal.record({ ...command, state: 'applied', result: { ...actual, pid: 1 } }), original = f.supervisor.assembly.sqlite.prepare('SELECT * FROM control_commands').get();
  assert(f.supervisor.assembly.sqlite.prepare('SELECT 1 FROM supervisor_side_effect').get());
  assert.throws(() => f.supervisor.journal.begin({ ...command, commandId: 'duplicate-allocation' }), /SUPERVISOR_SINGLE_FLIGHT_BLOCKED/);
  assert.equal((await f.runtime.collect()).known, false); await f.runtime.appliedStart(row);
  const nextPlan = JSON.parse(await fs.readFile(f.stable.capacityPlanPath)); assert.equal(nextPlan.allocations.candidate[0].resident, true); assert.notEqual(nextPlan.planDigest, f.plan.planDigest); assert.equal(f.runtime.capacityState().known, true);
  assert.equal(f.supervisor.assembly.sqlite.prepare('SELECT 1 FROM supervisor_side_effect').get(), undefined);
  await f.runtime.appliedStart(row); assert.deepEqual(f.supervisor.assembly.sqlite.prepare('SELECT * FROM control_commands').get(), original); assert.equal(JSON.parse(await fs.readFile(f.stable.capacityCollectorConfigPath)).residents.length, 3);
  await fs.unlink(f.config.ioQualificationPath); assert.equal((await f.runtime.collect()).known, false);
});

test('background maintenance is durable before actual stop and uses the real capacity collector for stopped/new physical births', async t => {
  const f = await fixture(t, true); f.holdStop(); const receipt = f.runtime.maintenanceRequest('submit', f.maintenanceInput); assert.equal(receipt.pending, true); assert.equal(receipt.durable, false);
  await f.stopped; assert.equal(f.authority.observe().mode, 'passive'); assert.equal(f.runtime.maintenanceRequest('status', { maintenanceId: 'maintenance-1' }).durable, true); assert.deepEqual(f.counts(), { starts: 0, stops: 0 });
  f.releaseStop(); const result = await finished(f.runtime, 'maintenance-1'); assert.equal(result.state, 'completed'); assert.deepEqual(f.counts(), { starts: 1, stops: 1 }); assert.equal(f.authority.observe().mode, 'active');
  const resident = JSON.parse(await fs.readFile(f.stable.capacityCollectorConfigPath)).residents.find(row => row.id === 'agent'); assert.equal(resident.containers[0].startIdentity, 'new-control-birth'); assert.equal(f.runtime.agentStartIdentity(), 'new-control-birth');
  f.runtime.maintenanceRequest('advance', { maintenanceId: 'maintenance-1' }); await finished(f.runtime, 'maintenance-1'); assert.deepEqual(f.counts(), { starts: 1, stops: 1 });
});

test('missing real IO evidence holds maintenance after normal source stop and preserves its reservation without dispatching a replacement', async t => {
  const f = await fixture(t, true); await fs.unlink(f.config.ioQualificationPath); f.runtime.maintenanceRequest('submit', f.maintenanceInput); const result = await finished(f.runtime, 'maintenance-1');
  assert.equal(result.state, 'blocked'); assert.deepEqual(f.counts(), { starts: 0, stops: 1 }); assert.equal(f.authority.observe().mode, 'passive');
  const plan = JSON.parse(await fs.readFile(f.stable.capacityPlanPath)); assert.equal(plan.allocations.control[0].resident, false); assert.deepEqual(plan.allocations.control[0].resources, f.plan.allocations.control[0].resources);
});

test('fixed maintenance HTTP namespace rejects ordinary Supervisor/Agent credentials and permits only the private maintenance key', async t => {
  const f = await fixture(t, true); await f.runtime.close(); f.supervisor.close();
  const supervisor = await createCandidateSupervisor({ root: join(f.root, 'installer'), instanceId: f.instanceId, key: 's'.repeat(32), coordinator: { origin: 'http://127.0.0.1:2' }, controlEnv: { PLATFORM_CONTROL_RPC_KEY: 'x'.repeat(32) }, stableControl: f.stable, Database,
    launchAdapter: { inspect: f.sample }, controlMaintenanceLifecycle: { inspect: async () => { throw Error('No metadata needed'); }, inventory: async () => { throw Error('No inventory needed'); }, start: async () => { throw Error('No launch allowed'); }, stop: async () => { throw Error('No stop allowed'); }, lookup: async () => { throw Error('No lookup needed'); }, health: async () => { throw Error('No health needed'); } } });
  f.cleanup.push(() => supervisor.close());
  for (const key of ['s'.repeat(32), f.stable.key, f.stable.accessKey]) { const res = await fetch(supervisor.origin + '/private/control-maintenance/status', { method: 'POST', headers: { 'x-platform-internal-key': key, 'x-platform-instance-id': f.instanceId }, body: '{"maintenanceId":"absent"}' }); assert.equal(res.status, 403); }
  const valid = await fetch(supervisor.origin + '/private/control-maintenance/status', { method: 'POST', headers: { 'x-platform-internal-key': f.stable.maintenanceKey, 'x-platform-instance-id': f.instanceId }, body: '{"maintenanceId":"absent"}' }); assert.equal(valid.status, 200); assert.equal((await valid.json()).state, 'not-found');
  const client = createControlMaintenanceClient({ instanceId: f.instanceId, origin: supervisor.origin, maintenanceKey: f.stable.maintenanceKey });
  const received = await client.submit(f.maintenanceInput); assert.equal(received.pending, true); assert.equal(received.durable, false);
  const configPath = join(f.root, 'operator.json'), requestPath = join(f.root, 'query.json'); await atomicJson(configPath, { schemaVersion: 1, instanceId: f.instanceId, origin: supervisor.origin, maintenanceKey: f.stable.maintenanceKey }); await atomicJson(requestPath, { maintenanceId: 'absent' });
  assert.equal((await runControlMaintenanceClient(configPath, 'status', requestPath)).state, 'not-found'); await fs.chmod(configPath, 0o644); await assert.rejects(runControlMaintenanceClient(configPath, 'status', requestPath), /CONTROL_MAINTENANCE_CLIENT_PRIVATE_CONFIG_REQUIRED/);
});
