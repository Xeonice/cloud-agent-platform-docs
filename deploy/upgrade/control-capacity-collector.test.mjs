import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { digest } from './trust.mjs';
import { atomicJson } from './io.mjs';
import { freezeCapacityBudget, evaluateCapacityAdmission } from './capacity-admission.mjs';
import { parseHostCpu, parseHostMemory, parseHostDiskstats, linuxDevice, capacityResidentIdentity, capacityHostIdentity,
  validateIoQualification, deriveCapacityObservation, createControlCapacityCollector, transitionCapacityAfterStart, createCapacityStartBookkeeper, createCapacityMaintenanceBookkeeper, transitionCapacityAfterMaintenance, knownControlAgentTermination } from './control-capacity-collector.mjs';
import { createControlAuthority } from './control-authority.mjs';
import { createControlCommandJournal } from './control-command-journal.mjs';

const vector = (memoryBytes, cpuMilliCores, ioBytesPerSecond, disks = { data: 0 }) => ({ memoryBytes, cpuMilliCores, ioBytesPerSecond, disks });
function fixture(directory = '/fixture-private') {
  // State/arithmetic fixtures only: these counters do not establish real Native
  // IO qualification. The production collector reads Linux and Docker directly.
  const instanceId = 'capacity-native-instance', now = Date.parse('2026-10-20T12:00:01.000Z');
  const container = (n, role, memoryBytes) => ({ containerId: String(n).repeat(64), pid: 100 + n, birthTicks: String(1000 + n), cgroupDigest: digest('cgroup-' + n), startedAt: new Date(now - 60000).toISOString(), restartCount: 0,
    instanceId, role, startIdentity: 'birth-' + n, artifactDigest: digest('code-' + n), memoryBytes, cpuNs: 100000000, ioBytes: 1000, monotonic: 1000 });
  const source = container(1, 'coordinator', 1000), owner = container(2, 'owner', 2000), foundation = container(3, 'foundation', 500), outside = { ...container(4, 'other-workload', 100), instanceId: null };
  const before = { vmBootId: '00112233-4455-6677-8899-aabbccddeeff', procIdentity: { path: '/host/proc', dev: '11', ino: '2' }, cpu: { cpus: 4, total: 1000, idle: 500 }, memory: { total: 10000, free: 6000, available: 7000 },
    devices: [{ id: 'data', dev: '2049', majorMinor: '8:1', capacityBytes: 100000, freeBytes: 80000, availableBytes: 80000, readBytes: 1000, writeBytes: 1000 }],
    containers: [source, owner, foundation, outside], startedAt: now - 500, finishedAt: now - 450, monotonic: 1000 };
  const after = structuredClone(before); after.monotonic = 1250; after.startedAt = now - 250; after.finishedAt = now - 50;
  after.cpu.total += 400; after.cpu.idle += 300; after.devices[0].readBytes += 500;
  for (const [i, row] of after.containers.entries()) { row.cpuNs += [10000000, 20000000, 5000000, 5000000][i]; row.ioBytes += 100; row.monotonic += 250; }
  const config = { schemaVersion: 1, instanceId, sourceDigest: digest('actual-source-tuple'), hostProcRoot: '/host/proc', devices: [{ id: 'data', path: '/data', dev: '2049', majorMinor: '8:1' }],
    residents: [{ id: 'source-coordinator', containers: [source] }, { id: 'retained-owner-with-guests', containers: [owner] }, { id: 'foundation', containers: [foundation] }],
    ioEffectiveBudgetBytesPerSecond: 10000, ioQualificationPath: join(directory, 'native-io.json'), ioQualificationRawDigest: digest('pending'), observationPath: join(directory, 'resource-observation.json'), dockerSocketPath: '/fixture/docker.sock', sampleIntervalMs: 250, timeoutMs: 2000 };
  const ioFacts = { schemaVersion: 1, kind: 'control-io-qualification', instanceId, vmBootId: before.vmBootId,
    devices: before.devices.map(({ id, dev, majorMinor }) => ({ id, dev, majorMinor })), effectiveBudgetBytesPerSecond: 10000, windowMs: 60000,
    observedAt: new Date(now - 120000).toISOString(), expiresAt: new Date(now + 60000).toISOString(), qualified: true,
    measurement: { readBytes: 600000, writeBytes: 0, maxLatencyMs: 1.5, samples: 600, unexpectedErrors: 0 } };
  const qualification = { ...ioFacts, receiptDigest: digest(ioFacts) }, rawQualificationDigest = digest(JSON.stringify(qualification)); config.ioQualificationRawDigest = rawQualificationDigest;
  const resident = (id, resources) => ({ id, resident: true, identityDigest: capacityResidentIdentity(config.residents.find(row => row.id === id).containers), resources });
  const plan = freezeCapacityBudget({ instanceId, sourceDigest: config.sourceDigest, maxObservationAgeMs: 5000, limits: vector(10000, 4000, 10000, { data: 100000 }), allocations: {
    source: [resident('source-coordinator', vector(1200, 100, 600)), { id: 'host-overhead', resident: true, identityDigest: capacityHostIdentity(after, instanceId), resources: vector(1000, 1000, 1000, { data: 25000 }) }],
    retainedOwners: [resident('retained-owner-with-guests', vector(2500, 200, 600))], retainedGuests: [], existingCandidates: [],
    candidate: [{ id: 'new-api-and-coordinator', resident: false, identityDigest: digest('new-candidate'), resources: vector(1000, 500, 1500, { data: 10000 }) }], verification: [],
    control: [resident('foundation', vector(700, 100, 600))], recovery: [{ id: 'recovery-reserve', resident: false, identityDigest: digest('recovery'), resources: vector(1000, 500, 500, { data: 5000 }) }],
  } });
  return { config, before, after, qualification, rawQualificationDigest, now, plan, derive(change = {}) { return deriveCapacityObservation({ config, before, after, qualification, rawQualificationDigest, now, plan, revision: 1, ...change }); } };
}

test('parses actual Linux counter formats without double counting guest CPU or inferring MemAvailable/IO', () => {
  assert.deepEqual(parseHostCpu('cpu 100 10 20 500 5 2 3 4 90 9\ncpu0 0\ncpu1 0\n'), { cpus: 2, total: 644, idle: 500 });
  assert.deepEqual(parseHostMemory('MemTotal: 10000 kB\nMemFree: 1000 kB\nMemAvailable: 2000 kB\n'), { total: 10240000, free: 1024000, available: 2048000 });
  assert.throws(() => parseHostMemory('MemTotal: 10000 kB\nMemFree: 1000 kB\n'), /CAPACITY_MEMORY_UNKNOWN/);
  assert.deepEqual(parseHostDiskstats('8 1 sda1 10 0 100 2 20 0 200 3 0 4 5\n').get('8:1'), { readBytes: 51200, writeBytes: 102400 });
  assert.equal(linuxDevice(2049), '8:1');
});
test('counts Owner+Guest once, includes all host overhead and actual disk occupancy, and admits only qualified remaining budgets', () => {
  const f = fixture(), value = f.derive();
  assert.equal(value.residents.length, 4);
  const owner = value.residents.find(row => row.id === 'retained-owner-with-guests');
  assert.equal(owner.resources.memoryBytes, 2000);
  const overhead = value.residents.find(row => row.id === 'host-overhead');
  assert.equal(overhead.resources.memoryBytes, 500); assert.equal(overhead.resources.disks.data, 20000);
  assert(value.residents.filter(row => row.id !== 'host-overhead').every(row => row.resources.disks.data === 0));
  assert.deepEqual(value.available, vector(6000, 3000, 8000, { data: 80000 }));
  assert.equal(value.observedAt, new Date(f.before.startedAt).toISOString());
  assert.equal(evaluateCapacityAdmission({ plan: f.plan, observation: value, now: f.now }).state, 'admitted');
  assert.equal(value.scope.ioAvailabilityMeaning, 'remaining-qualified-effective-budget');
});
test('no new candidate is admitted when an actual retained Owner or host baseline has exhausted its frozen budget', () => {
  const f = fixture(); f.after.containers[1].memoryBytes = 2600; f.after.memory.free = 5400;
  const result = evaluateCapacityAdmission({ plan: f.plan, observation: f.derive(), now: f.now });
  assert.equal(result.state, 'deferred'); assert.equal(result.allocationId, 'retained-owner-with-guests');
});
test('birth, source inventory, filesystem, counter resets and overlapping accounting fail closed', () => {
  for (const mutate of [
    f => { f.after.containers[0].birthTicks = 'new'; },
    f => { f.after.containers.push({ ...f.after.containers[0], containerId: 'e'.repeat(64) }); },
    f => { f.after.vmBootId = 'other-boot'; },
    f => { f.after.devices[0].dev = '2050'; },
    f => { f.after.devices[0].readBytes = 1; },
    f => { f.after.memory.free = 9999; },
    f => { f.config.residents.push(structuredClone(f.config.residents[0])); },
    f => { f.config.devices.push({ ...f.config.devices[0], id: 'same-filesystem-again' }); },
  ]) { const f = fixture(); mutate(f); assert.throws(() => f.derive(), /CAPACITY_/); }
});
test('a new external workload changes host-overhead physical scope, rather than earning the former free observation', () => {
  const f = fixture(); for (const snapshot of [f.before, f.after]) snapshot.containers[3].containerId = 'e'.repeat(64);
  const result = evaluateCapacityAdmission({ plan: f.plan, observation: f.derive(), now: f.now });
  assert.equal(result.state, 'deferred'); assert.equal(result.reason, 'CAPACITY_RESIDENT_INVENTORY_CHANGED');
});
test('IO budget requires the pinned real-run receipt for this VM, device, full measured window and unexpired policy', () => {
  for (const mutate of [
    f => { f.rawQualificationDigest = digest('other-bytes'); },
    f => { f.qualification.vmBootId = 'other-boot'; },
    f => { f.qualification.devices[0].dev = '2050'; },
    f => { f.qualification.expiresAt = new Date(f.now).toISOString(); },
    f => { f.qualification.observedAt = new Date(f.now + 1).toISOString(); },
    f => { f.qualification.windowMs = 59999; },
    f => { f.qualification.measurement.readBytes = 1; },
    f => { f.qualification.measurement.unexpectedErrors = 1; },
    f => { f.qualification.receiptDigest = digest('forged'); },
    f => { f.qualification.qualified = false; },
  ]) { const f = fixture(); mutate(f); assert.throws(() => validateIoQualification({ value: f.qualification, rawDigest: f.rawQualificationDigest, config: f.config, sample: f.after, now: f.now }), /CAPACITY_IO_/); }
});
test('publishes an own private observation with revision CAS; missing evidence persists unknown instead of retaining a fresh success', async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'capacity-collector-cas-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const f = fixture(root), raw = JSON.stringify(f.qualification); await fs.writeFile(f.config.ioQualificationPath, raw, { mode: 0o600 });
  let calls = 0;
  const collector = createControlCapacityCollector({ config: f.config, clock: () => f.now, monotonic: () => 1e9, sample: async () => structuredClone(++calls % 2 ? f.before : f.after) });
  const good = await collector.collect({ plan: f.plan, expectedRevision: 0 }); assert.equal(good.known, true); assert.equal(good.revision, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(f.config.observationPath, 'utf8')), good);
  await assert.rejects(collector.collect({ plan: f.plan, expectedRevision: 0 }), /CAPACITY_OBSERVATION_CAS_CHANGED/);
  await fs.unlink(f.config.ioQualificationPath);
  const unknown = await collector.collect({ plan: f.plan, expectedRevision: 1 }); assert.equal(unknown.known, false); assert.equal(unknown.revision, 2);
  assert.equal(evaluateCapacityAdmission({ plan: f.plan, observation: unknown, now: f.now }).qualified, false);
  assert.deepEqual(JSON.parse(await fs.readFile(f.config.observationPath, 'utf8')), unknown);
  assert.equal((await fs.stat(f.config.observationPath)).mode & 0o077, 0);
  await fs.writeFile(f.config.observationPath + '.collector-lock', 'owned-by-other-collector', { mode: 0o600 });
  await assert.rejects(collector.collect({ plan: f.plan, expectedRevision: 2 }), /CAPACITY_COLLECTOR_BUSY/);
});
test('does not overwrite an observation whose inode/revision changed while sampling was in flight', async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'capacity-collector-race-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const f = fixture(root); await fs.writeFile(f.config.ioQualificationPath, JSON.stringify(f.qualification), { mode: 0o600 });
  let reached, release, count = 0;
  const paused = new Promise(ok => { reached = ok; }), wait = new Promise(ok => { release = ok; });
  const collector = createControlCapacityCollector({ config: f.config, clock: () => f.now, monotonic: () => 1e9, sample: async () => { if (++count === 1) return structuredClone(f.before); reached(); await wait; return structuredClone(f.after); } });
  const running = collector.collect({ plan: f.plan, expectedRevision: 0 });
  await paused; const concurrent = { revision: 1, known: false, reason: 'CAPACITY_EXTERNAL_REPLAN' }; await atomicJson(f.config.observationPath, concurrent); release();
  await assert.rejects(running, /CAPACITY_OBSERVATION_CAS_CHANGED/);
  assert.deepEqual(JSON.parse(await fs.readFile(f.config.observationPath, 'utf8')), concurrent);
});

test('real fractional monotonic timer windows never sample before the fixed 250ms minimum', async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'capacity-real-timer-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const f = fixture(root); await fs.writeFile(f.config.ioQualificationPath, JSON.stringify(f.qualification), { mode: 0o600 });
  const windows = []; let first, count = 0;
  const collector = createControlCapacityCollector({ config: f.config, clock: () => f.now, sample: async () => {
    const value = structuredClone(++count % 2 ? f.before : f.after), actual = performance.now();
    value.monotonic = actual; value.containers.forEach(row => { row.monotonic = actual; });
    if (count % 2) first = actual; else windows.push(actual - first); return value;
  } });
  for (let revision = 0; revision < 3; revision++) {
    const value = await collector.collect({ plan: f.plan, expectedRevision: revision });
    assert.equal(value.known, true); assert(value.scope.sampleIntervalMs >= 250); assert.equal(value.observedAt, new Date(f.before.startedAt).toISOString());
  }
  assert.equal(windows.length, 3); assert(windows.every(window => window >= 250));
});

test('only an applied real SQLite start receipt consumes its frozen allocation; partial publication resumes the same receipt without changing old commands', async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'capacity-resident-transition-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const f = fixture(root), Database = createRequire(new URL('../../api/package.json', import.meta.url))('better-sqlite3'), db = new Database(join(root, 'supervisor.db')); t.after(() => db.close());
  const authority = createControlAuthority({ sqlite: db, instanceId: f.config.instanceId, clock: () => f.now });
  authority.activate({ expectedRevision: 1, sourceBindingDigest: f.plan.sourceDigest });
  authority.grant({ operationId: 'attempt-1', epoch: 1, executorId: 'supervisor', leaseMs: 30000 });
  const journal = createControlCommandJournal({ sqlite: db, instanceId: f.config.instanceId, clock: () => f.now, assertAuthority: (a, command) => authority.assert({ operationId: command.operationId, epoch: a.epoch, executorId: a.executorId }) });
  const allocation = f.plan.allocations.candidate[0], key = { operationId: 'attempt-1', commandId: 'candidate-start-1' };
  const input = { ...key, stepId: 'candidate-api', authorization: { epoch: 1, executorId: 'supervisor', expiresAt: f.now + 10000 }, spec: {
    schemaVersion: 1, kind: 'supervisor-start', instanceId: f.config.instanceId, request: { attemptId: 'attempt-1', kind: 'api' }, deadline: f.now + 5000, budget: { maxDurationMs: 5000 }, capacityPlanDigest: f.plan.planDigest,
    sourceDigest: f.plan.sourceDigest, capacityAllocationId: allocation.id, resources: allocation.resources,
  } };
  journal.prepare(input); journal.begin(input);
  const actual = { ...structuredClone(f.after.containers[0]), containerId: 'f'.repeat(64), pid: 105, birthTicks: '2000', cgroupDigest: digest('new-cgroup'), role: 'api', startIdentity: 'new-api-birth', artifactDigest: digest('new-api-code'), memoryBytes: 800 };
  f.after.containers.push(actual);
  const result = { ...actual, pid: 1, hostPid: 105, ...key };
  assert.throws(() => transitionCapacityAfterStart({ plan: f.plan, config: f.config, record: journal.lookup(key), sample: f.after, now: f.now }), /CAPACITY_APPLIED_START_REQUIRED/);
  journal.record({ ...input, state: 'applied', result });
  const original = db.prepare('SELECT * FROM control_commands').get(), record = journal.lookup(key);
  const next = transitionCapacityAfterStart({ plan: f.plan, config: f.config, record, sample: f.after, now: f.now });
  assert.equal(next.physical.pid, 105); assert.equal(next.plan.sourceDigest, f.plan.sourceDigest); assert.notEqual(next.plan.planDigest, f.plan.planDigest);
  assert.equal(next.plan.allocations.candidate[0].resident, true); assert.equal(next.config.residents.at(-1).containers[0].pid, 105);
  assert.deepEqual(next.plan.allocations.candidate[0].resources, allocation.resources);
  for (const mutate of [r => { r.spec.resources.memoryBytes++; }, r => { r.spec.capacityAllocationId = 'not-reserved'; }, r => { r.result.hostPid = 999; }]) {
    const bad = structuredClone(record); mutate(bad); bad.specDigest = digest(bad.spec);
    assert.throws(() => transitionCapacityAfterStart({ plan: f.plan, config: f.config, record: bad, sample: f.after, now: f.now }), /CAPACITY_/);
  }
  const planPath = join(root, 'plan.json'), configPath = join(root, 'collector.json'), transitionRoot = join(root, 'transitions');
  await atomicJson(planPath, f.plan); await atomicJson(configPath, f.config);
  let failConfigOnce = true;
  const ports = { journal, instanceId: f.config.instanceId, planPath, configPath, transitionRoot, clock: () => f.now, sample: async () => structuredClone(f.after) };
  const broken = createCapacityStartBookkeeper({ ...ports, write: async (path, value) => { if (path === configPath && failConfigOnce) { failConfigOnce = false; throw Error('fixture loss after plan publication'); } await atomicJson(path, value); } });
  await assert.rejects(broken.register(key), /fixture loss after plan publication/);
  assert.equal(JSON.parse(await fs.readFile(planPath, 'utf8')).planDigest, next.plan.planDigest);
  assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).residents.length, f.config.residents.length);
  // Existing successful observations contain the former resident set. They
  // cannot authorize another launch during the half-published transition.
  const oldObservation = f.derive({ before: { ...f.before, containers: f.before.containers }, after: { ...f.after, containers: f.after.containers.filter(row => row.containerId !== actual.containerId) } });
  assert.equal(evaluateCapacityAdmission({ plan: next.plan, observation: oldObservation, now: f.now }).qualified, false);
  const recovered = createCapacityStartBookkeeper(ports), receipt = await recovered.register(key);
  assert.equal(receipt.planDigest, next.plan.planDigest); assert.equal(receipt.physical.pid, 105);
  assert.deepEqual(await recovered.register(key), receipt);
  assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).residents.length, f.config.residents.length + 1);
  assert.deepEqual(db.prepare('SELECT * FROM control_commands').get(), original);
});
test('maintenance releases only a known stopped control birth and rebinds the same reserved budget to its real applied replacement receipt', async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'capacity-maintenance-rebind-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const f = fixture(root); for (const rows of [f.before.containers, f.after.containers]) rows[2].role = 'control-agent'; f.config.residents[2].containers[0].role = 'control-agent';
  const originalPlan = structuredClone(f.plan); originalPlan.allocations.control[0].identityDigest = capacityResidentIdentity(f.config.residents[2].containers); const plan = freezeCapacityBudget(originalPlan);
  const planPath = join(root, 'plan.json'), configPath = join(root, 'collector.json'); await atomicJson(planPath, plan); await atomicJson(configPath, f.config);
  const Database = createRequire(new URL('../../api/package.json', import.meta.url))('better-sqlite3'), db = new Database(join(root, 'maintenance-commands.db')); t.after(() => db.close());
  const journal = createControlCommandJournal({ sqlite: db, instanceId: f.config.instanceId, clock: () => f.now, assertAuthority: () => {} });
  const maintenanceId = 'fixed-control-maintenance', allocation = plan.allocations.control[0], old = f.config.residents[2].containers[0];
  const put = (commandId, extra, result) => {
    const input = { operationId: maintenanceId, commandId, stepId: commandId, authorization: { epoch: 2, executorId: 'supervisor', expiresAt: f.now + 10000 }, spec: {
      schemaVersion: 1, instanceId: f.config.instanceId, maintenanceId, commandId, deadline: f.now + 10000, capacityAllocationId: allocation.id, resources: allocation.resources, ...extra } };
    journal.prepare(input); journal.begin(input); const specDigest = digest(input.spec);
    return { input, finish: () => journal.record({ ...input, state: 'applied', result: { ...result, instanceId: f.config.instanceId, maintenanceId, commandId, specDigest } }) };
  };
  const stop = put('stop-old-control', { kind: 'stop-control-agent', target: { ...old, hostPid: old.pid } }, { ...old, pid: 1, hostPid: 0, running: false, paused:false, restartCount:0, restartPolicy:'no', oomKilled:false, exitCode:143, finishedAt:new Date(f.now).toISOString(), normalExit:true, signal:'SIGTERM', forced:false, removed:false });
  let actual = structuredClone(f.after); actual.containers = actual.containers.filter(row => row.containerId !== old.containerId);
  const ports = { journal: { lookup: key => { const row = journal.lookup(key); return row ? { ...row, maintenanceId: row.operationId } : row; } }, instanceId: f.config.instanceId, planPath, configPath, transitionRoot: join(root, 'transitions'), clock: () => f.now, sample: async () => structuredClone(actual) };
  const bookkeeper = createCapacityMaintenanceBookkeeper(ports);
  await assert.rejects(bookkeeper.register({ operationId: maintenanceId, commandId: stop.input.commandId }), /CAPACITY_APPLIED_MAINTENANCE_REQUIRED/);
  stop.finish(); const released = await bookkeeper.register({ operationId: maintenanceId, commandId: stop.input.commandId });
  let updated = JSON.parse(await fs.readFile(planPath, 'utf8')); assert.equal(updated.allocations.control[0].resident, false); assert.deepEqual(updated.allocations.control[0].resources, allocation.resources);
  assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).residents.length, 2);
  assert.deepEqual(await bookkeeper.register({ operationId: maintenanceId, commandId: stop.input.commandId }), released);
  const next = { ...old, containerId: 'f'.repeat(64), pid: 210, birthTicks: '2100', startIdentity: 'replacement-control', artifactDigest: digest('replacement-control-code'), cgroupDigest: digest('replacement-cgroup') };
  actual.containers.push(next);
  const start = put('start-new-control', { kind: 'start-control-agent', startIdentity: next.startIdentity, packageDigest: digest('signed-control-package') }, { ...next, hostPid: 210, pid: 1, running: true }); start.finish();
  const commandsBefore = db.prepare('SELECT * FROM control_commands ORDER BY command_id').all();
  const rebound = await bookkeeper.register({ operationId: maintenanceId, commandId: start.input.commandId });
  updated = JSON.parse(await fs.readFile(planPath, 'utf8')); assert.equal(updated.allocations.control[0].resident, true); assert.equal(updated.allocations.control[0].identityDigest, capacityResidentIdentity([next]));
  assert.deepEqual(updated.allocations.control[0].resources, allocation.resources); assert.equal(updated.sourceDigest, plan.sourceDigest); assert.equal(rebound.physical.pid, 210);
  assert.deepEqual(db.prepare('SELECT * FROM control_commands ORDER BY command_id').all(), commandsBefore);
});
test('an exact already-terminated control birth releases only its reservation and is never relabeled as normal SIGTERM', () => {
  const f = fixture(), old = f.config.residents[2].containers[0]; old.role = 'control-agent';
  const plan = structuredClone(f.plan); plan.allocations.control[0].identityDigest = capacityResidentIdentity([old]);
  const spec = { instanceId:f.config.instanceId, maintenanceId:'maintenance', commandId:'stop-original', kind:'stop-control-agent', capacityAllocationId:'foundation', resources:plan.allocations.control[0].resources, target:{...old,hostPid:old.pid} };
  const result = { ...old, instanceId:f.config.instanceId,maintenanceId:'maintenance',commandId:'stop-original',specDigest:digest(spec),running:false,hostPid:0,paused:false,restartCount:0,restartPolicy:'no',oomKilled:false,exitCode:1,finishedAt:new Date(f.now).toISOString(),normalExit:false,terminationObserved:true,signal:null,forced:false,removed:false };
  const record = { instanceId:f.config.instanceId,maintenanceId:'maintenance',commandId:'stop-original',spec,specDigest:digest(spec),state:'applied',result }, sample = structuredClone(f.after); sample.containers = sample.containers.filter(row=>row.containerId!==old.containerId);
  const next=transitionCapacityAfterMaintenance({plan:freezeCapacityBudget(plan),config:f.config,record,sample,now:f.now});
  assert.equal(next.plan.allocations.control[0].resident,false); assert.deepEqual(next.plan.allocations.control[0].resources,plan.allocations.control[0].resources); assert.equal(result.normalExit,false); assert.equal(result.signal,null);
  for(const patch of [{normalExit:true},{terminationObserved:false},{oomKilled:null},{exitCode:null},{finishedAt:null},{running:true},{paused:true},{restartCount:1},{restartPolicy:'always'},{forced:true}]){
    const bad={...result,...patch}; assert.equal(knownControlAgentTermination(bad),false); assert.throws(()=>transitionCapacityAfterMaintenance({plan:freezeCapacityBudget(plan),config:f.config,record:{...record,result:bad},sample,now:f.now}),/CAPACITY_MAINTENANCE_STOP_UNKNOWN/);
  }
});
