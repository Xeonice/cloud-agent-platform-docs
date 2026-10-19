import nativeTest from 'node:test';
const test = (name, work) => nativeTest(name, { timeout: 60000 }, work);
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createControlExecution, createControlContractBusinessFactory } from './control-execution.mjs';
import { createControlAuthority } from './control-authority.mjs';
import { createControlRecoveryStore } from './control-recovery-store.mjs';
import { createControlCommandJournal } from './control-command-journal.mjs';
import { createControlParticipants } from './control-participants.mjs';
import { createControlInspectorClient } from './control-inspector-client.mjs';
import { createCoordinatorClient } from './coordinator-client.mjs';
import { createPrivateControlRpc } from './control-rpc.mjs';
import { createStableEntry } from './stable-entry.mjs';
import { freezeCapacityBudget, evaluateCapacityAdmission } from './capacity-admission.mjs';
import { createControlDiagnostics } from './control-diagnostics.mjs';
import { canonical, digest, invariant } from './trust.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url)), Database = require('better-sqlite3');
const { withBusinessAction, readBusinessActionStatus } = require('./apps/api/dist/platform/upgrade/upgrade-business-action.js');
const { UpgradeError } = require('./apps/api/dist/platform/upgrade/upgrade-trust.js');
const instanceId = 'execution-test', attemptId = '22222222-2222-4222-8222-222222222222', recoveryId = '11111111-1111-4111-8111-111111111111';
const sha = letter => 'sha256:' + letter.repeat(64), identity = { startIdentity: 'source-participant-incarnation', artifactDigest: sha('a') };
const key = 'k'.repeat(32), businessKey = 'b'.repeat(32), supervisorKey = 's'.repeat(32), entryKey = 'e'.repeat(32), privateEntryKey = 'p'.repeat(32);
async function listen(handler) { const server = http.createServer((req, res) => { void handler(req, res).catch(error => { if (!res.destroyed) { res.writeHead(409); res.end(JSON.stringify({ code: error.code ?? 'TEST_HTTP_FAILURE' })); } }); }); await new Promise(ok => server.listen(0, '127.0.0.1', ok)); return { server, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(ok => { server.closeAllConnections(); server.close(ok); }) }; }
async function body(req) { const parts = []; for await (const part of req) parts.push(part); return parts.length ? JSON.parse(Buffer.concat(parts).toString()) : undefined; }
function reply(res, value) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); }

// Actual HTTP listeners, Entry, Root/participant SQLite and production API fact
// writer. Launch/effect and UpgradeStore semantic ports are explicit fixtures;
// none of these tests is a Native qualification or a sandbox continuity proof.
async function fixture(t, { earlyFailure = false } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'control-execution-test-'))); await fs.chmod(directory, 0o700);
  const web = join(directory, 'web'); await fs.mkdir(web); await fs.writeFile(join(web, 'index.html'), 'fixture');
  const sqlite = new Database(join(directory, 'control.db'));
  sqlite.exec('CREATE TABLE supervisor_commands(operation_id TEXT,command_id TEXT,spec_digest TEXT,spec TEXT,result TEXT,PRIMARY KEY(operation_id,command_id));CREATE TABLE upgrade_continuity_baselines(attempt_id TEXT PRIMARY KEY,snapshot TEXT,digest TEXT)');
  const baseline = { coordinator: identity }; sqlite.prepare('INSERT INTO upgrade_continuity_baselines VALUES(?,?,?)').run(attemptId, canonical(baseline), digest(baseline));
  const savedEnv = Object.fromEntries(['PLATFORM_COORDINATOR_BINDING_PATH', 'PLATFORM_PROCESS_START_IDENTITY', 'PLATFORM_ARTIFACT_DIGEST'].map(name => [name, process.env[name]]));
  process.env.PLATFORM_COORDINATOR_BINDING_PATH = join(directory, 'coordinator.json'); process.env.PLATFORM_PROCESS_START_IDENTITY = identity.startIdentity; process.env.PLATFORM_ARTIFACT_DIGEST = identity.artifactDigest;
  const recoveryStore = createControlRecoveryStore({ sqlite, instanceId });
  const authority = createControlAuthority({ sqlite, instanceId, validateRecovery: value => assert.equal(recoveryStore.read(value.operationId).triggeringAttemptId, value.supersedes) });
  authority.activate({ expectedRevision: 1, sourceBindingDigest: sha('d') }); authority.grant({ operationId: attemptId, epoch: 7, executorId: 'upgrade-seven', leaseMs: 120000 });
  const journal = createControlCommandJournal({ sqlite, instanceId, assertAuthority: value => authority.assert(value) });
  const calls = [], activeBusiness = new Set(), controls = { lostSupervisorAck: false, lostBusinessAck: false, loseAckWhileRunning: false, workDelay: 0, available: true, businessEffects: 0, supervisorEffects: 0, wrongWriterReads: 0 };
  const plan = { planDigest: sha('b'), package: { digest: sha('c'), format: 'native-tar' }, policy: { candidateStartupMs: 120000, observationFreshnessMs: 5000 } };
  const snapshot = { attempt: { instanceId, attemptId, generation: 1, targetDigest: sha('f'), planDigest: plan.planDigest }, plan, manifest: { components: {} } };
  const contractRecords = new Map();
  const stores = { store: { instanceId, snapshot: () => snapshot, latest: () => snapshot.attempt }, contracts: { snapshot: id => contractRecords.get(id), active: () => [...contractRecords.values()].filter(record => ['accepted', 'retiring-readers', 'authority-active', 'clearing'].includes(record.attempt.state)) } };
  const apiStore = { instanceId, ledgerReadonly: true, ledgerSqlite: sqlite, sqlite, assertControllerFence: (id, fence) => { try { authority.assert({ operationId: id, epoch: fence, kind: 'upgrade' }); } catch { throw new UpgradeError('CONTROL_AUTHORITY_EXPIRED_OR_SUPERSEDED'); } } };
  const business = await listen(async (req, res) => {
    assert.equal(req.headers['x-platform-internal-key'], businessKey);
    const input = await body(req); calls.push({ peer: 'business', url: req.url, input, headers: req.headers });
    if (req.url === '/internal/upgrades/inspection') {
      let result;
      if (input.action === 'participantCommandStatus') result = readBusinessActionStatus(apiStore, { now: () => new Date() }, input.attemptId, input.commandId);
      else if (input.action === 'metadata') result = { schema: 29, requiredDataFormats: [], defaultImagesSnapshot: [], observedAt: new Date().toISOString() };
      else throw Object.assign(Error('Unexpected semantic inspection'), { code: 'UNEXPECTED_INSPECTION' });
      reply(res, { instanceId, action: input.action, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), result }); return;
    }
    if (req.url === `/internal/upgrades/${attemptId}/coordinator-handoff`) {
      let markEntered; const entered = new Promise(ok => { markEntered = ok; });
      const work = withBusinessAction(apiStore, { now: () => new Date() }, req.headers, attemptId, 'coordinatorHandoff', input, async () => { controls.businessEffects++; markEntered(); if (controls.workDelay) await new Promise(ok => setTimeout(ok, controls.workDelay)); return { commitKnown: true, stage: input.action === 'prepare' ? 'prepared' : 'quiesced' }; });
      activeBusiness.add(work); work.then(() => activeBusiness.delete(work), () => activeBusiness.delete(work));
      if (controls.loseAckWhileRunning) { controls.loseAckWhileRunning = false; await Promise.race([entered, work]); res.destroy(); await work; return; }
      const result = await work;
      if (controls.lostBusinessAck) { controls.lostBusinessAck = false; res.destroy(); return; }
      reply(res, result); return;
    }
    if (req.url === '/internal/upgrades/contract-business') {
      const { action, ...command } = input;
      if (action === 'activate') {
        const record = contractRecords.get(input.contractAttemptId), specDigest = digest({ ...input, planDigest: record.plan.planDigest });
        const proof = { instanceId, contractAttemptId: input.contractAttemptId, commandId: input.commandId, action, fence: input.fence, specDigest, observedAt: new Date().toISOString(), result: { totalRows: 17 } };
        reply(res, { instanceId, action, completedAt: new Date().toISOString(), result: { ...proof, receiptDigest: digest(proof) } }); return;
      }
      throw Object.assign(Error('Unexpected contract fixture operation'), { code: 'CONTRACT_FIXTURE_UNSUPPORTED' });
    }
    throw Object.assign(Error('Business route unavailable'), { code: 'BUSINESS_ROUTE_UNKNOWN' });
  });
  const wrongWriter = await listen(async (_req, res) => { controls.wrongWriterReads++; reply(res, { forbidden: true }); });
  const control = await listen(async (req, res) => {
    assert.equal(req.headers['x-platform-internal-key'], key);
    const input = await body(req); calls.push({ peer: 'control', url: req.url, input });
    if (req.url === '/internal/upgrades/pending') { reply(res, { attempts: [] }); return; }
    if (req.url === `/internal/upgrades/${attemptId}/renew`) { authority.assert({ operationId: attemptId, epoch: input.fence }); reply(res, { leaseExpiresAt: authority.observe().leaseExpiresAt }); return; }
    if (req.url === `/internal/upgrades/${attemptId}`) { reply(res, snapshot); return; }
    throw Object.assign(Error('Control fixture path unknown'), { code: 'CONTROL_PATH_UNKNOWN' });
  });
  const resources = value => ({ memoryBytes: value, cpuMilliCores: value, ioBytesPerSecond: value, disks: { data: value } });
  const item = (id, resident) => ({ id, resident, identityDigest: digest(id), resources: resources(10) });
  const capacity = freezeCapacityBudget({ instanceId, sourceDigest: sha('e'), maxObservationAgeMs: 5000, limits: resources(1000), allocations: {
    source: [item('source', true)], retainedOwners: [], retainedGuests: [], existingCandidates: [], candidate: [item('candidate', false)], verification: [], control: [item('control', true)], recovery: [item('recovery', false)] } });
  const capacityPath = join(directory, 'capacity.json'); await fs.writeFile(capacityPath, canonical(capacity), { mode: 0o600 });
  const supervisor = await listen(async (req, res) => {
    const input = await body(req); calls.push({ peer: 'supervisor', url: req.url, input });
    if (req.url === '/control-admission') { const current = authority.assert(input); reply(res, { instanceId, ...input, leaseExpiresAt: current.leaseExpiresAt, admitted: true }); return; }
    if (req.url === '/coordinator-inventory') { reply(res, { instanceId, complete: true, observedAt: new Date().toISOString(), coordinators: [{ instanceId, ...identity, origin: business.origin, applicationOrigin: business.origin, managementOrigin: business.origin, physical: { running: true, startIdentity: identity.startIdentity }, actualIdentity: { instanceId, ...identity, generation: 1, writerFenceValid: true } }] }); return; }
    if (req.url === '/diagnostics/sample') { reply(res, [{ role: 'coordinator', ...identity, state: 'alive', rssBytes: 1024 }]); return; }
    if (req.url === '/command-result') {
      const row = sqlite.prepare('SELECT * FROM supervisor_commands WHERE operation_id=? AND command_id=?').get(input.operationId, input.commandId);
      reply(res, row ? { operationId: row.operation_id, commandId: row.command_id, specDigest: row.spec_digest, state: 'applied', result: JSON.parse(row.result) } : null); return;
    }
    const command = input.command; authority.assert(command.authorization);
    assert.equal(command.spec.instanceId, instanceId); assert.deepEqual(command.spec.request, req.url === '/retire-reader' ? Object.fromEntries(Object.entries(input).filter(([name]) => name !== 'command')) : { attemptId, kind: input.kind });
    if (req.url !== '/retire-reader') {
      assert.equal(command.spec.capacityPlanDigest, capacity.planDigest); assert.equal(command.spec.sourceDigest, capacity.sourceDigest);
      const observation = { known: true, exclusiveAccounting: true, instanceId, sourceDigest: capacity.sourceDigest, revision: 1, observedAt: new Date().toISOString(), limits: resources(1000), available: resources(controls.available ? 970 : 0), residents: [item('source', true), item('control', true)].map(({ id, identityDigest, resources: usage }) => ({ id, identityDigest, resources: usage })) };
      const admitted = evaluateCapacityAdmission({ plan: capacity, observation });
      invariant(admitted.qualified, 'SUPERVISOR_CAPACITY_SHORTAGE');
    }
    const result = req.url === '/retire-reader' ? { qualified: true, retired: true, originalResourcesPreserved: true, ...input } : { root: join(directory, 'verified-artifact'), packageDigest: plan.package.digest };
    controls.supervisorEffects++; sqlite.prepare('INSERT INTO supervisor_commands VALUES(?,?,?,?,?)').run(command.operationId, command.commandId, digest(command.spec), canonical(command.spec), canonical(result));
    if (controls.lostSupervisorAck) { controls.lostSupervisorAck = false; res.destroy(); return; }
    reply(res, { operationId: command.operationId, commandId: command.commandId, specDigest: digest(command.spec), state: 'applied', result });
  });
  const entry = await createStableEntry({ root: join(directory, 'entry'), instanceId, controlKey: entryKey, stickyKey: 'z'.repeat(32), controlOrigin: control.origin, privateEntryKey,
    verifyFence: async () => {}, verifyContractFence: async () => {}, verifyControlAuthority: async input => authority.assert(input),
    initialBinding: { instanceId, attemptId: earlyFailure ? 'previous-serving-attempt' : attemptId, fence: earlyFailure ? 6 : 7, routeGeneration: 1, weight: 0, oldApi: { origin: business.origin, digest: identity.artifactDigest }, candidateApi: null,
      web: { root: web, origin: 'http://127.0.0.1:39999', digest: sha('1'), treeDigest: sha('2') }, retainedWeb: [] } });
  const coorBinding = { instanceId, state: 'ready', generation: 1, origin: business.origin, attemptId: earlyFailure ? 'previous-serving-attempt' : attemptId, fence: earlyFailure ? 6 : 7 };
  await fs.writeFile(process.env.PLATFORM_COORDINATOR_BINDING_PATH, canonical(coorBinding), { mode: 0o600 });
  const context = new AsyncLocalStorage(), requestContext = () => context.getStore(), withCommandContext = (value, work) => context.run({ ...context.getStore(), ...value }, work);
  const rawBusiness = createCoordinatorClient({ origin: business.origin, instanceId, key: businessKey, bindingPath: process.env.PLATFORM_COORDINATOR_BINDING_PATH, requestContext, independentControl: true });
  const supervisorRpc = createPrivateControlRpc({ origin: supervisor.origin, key: supervisorKey, instanceId });
  const participants = createControlParticipants({ instanceId, authority, entryOrigin: entry.controlOrigin, entryKey, entryControllerKey: privateEntryKey,
    supervisor: { admitControl: input => supervisorRpc('/control-admission', input) }, business: rawBusiness });
  const c = { instanceId, root: join(directory, 'agent'), downloadRoot: join(directory, 'downloads'), trustRootPath: join(directory, 'trust.json'), capacityPlanPath: capacityPath,
    supervisorOrigin: supervisor.origin, supervisorKey, entryOrigin: entry.controlOrigin, entryKey, privateEntryKey, controllerKey: key, businessKey, coordinatorOrigin: business.origin,
    coordinatorBindingPath: process.env.PLATFORM_COORDINATOR_BINDING_PATH, controllerId: 'execution-process' };
  const diagnostics = await createControlDiagnostics({ directory: join(directory, 'diagnostics'), instanceId });
  const args = { c, engineIdentity: { startIdentity: 'control-process' }, sqlite, stores, authority, recoveryStore, journal, diagnostics,
    inspector: createControlInspectorClient({ client: rawBusiness, instanceId }), business: rawBusiness, requestContext, withCommandContext, participants, controlOrigin: control.origin };
  let execution = await createControlExecution(args);
  t.after(async () => { await execution.close(); await Promise.allSettled([...activeBusiness]); await diagnostics.close(); await entry.close(); await supervisor.close(); await control.close(); await business.close(); await wrongWriter.close(); sqlite.close(); for (const [name, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } await fs.rm(directory, { recursive: true, force: true }); });
  return { c, args, controls, calls, plan, journal, authority, sqlite, entry, contractRecords, rawBusiness, withCommandContext,
    get execution() { return execution; }, async restart() { await execution.close(); execution = await createControlExecution(args); },
    async pointAtWrongWriter() { await fs.writeFile(c.coordinatorBindingPath, canonical({ ...coorBinding, generation: 2, origin: wrongWriter.origin }), { mode: 0o600 }); },
    async recovery() { const businessBinding = await execution.adapter.captureBusinessBinding(); let intent = recoveryStore.create({ recoveryId, triggeringAttemptId: attemptId, authorizationPlan: { componentScope: ['coordinator'], businessBinding }, reason: 'ACK_UNKNOWN', deadline: Date.now() + 200000 }); intent = recoveryStore.claim({ recoveryId, epoch: authority.observe().epoch + 1 }); authority.grant({ operationId: recoveryId, epoch: intent.epoch, executorId: 'recovery-process', kind: 'recovery', supersedes: attemptId, leaseMs: 120000 }); const current = authority.observe(); return { intent, authorization: { operationId: recoveryId, epoch: intent.epoch, executorId: current.holderId, expiresAt: current.leaseExpiresAt, kind: 'recovery' } }; } };
}

test('production factory uses ControlAPI for authority, durable capacity-bound Supervisor commands and original-result lookup after ACK loss', async t => {
  const f = await fixture(t); f.controls.lostSupervisorAck = true;
  const input = { attempt: { instanceId, attemptId, plan: f.plan }, fence: 7, download: {} };
  await assert.rejects(f.execution.executor.prepare(input));
  const pending = f.journal.pending(); assert.equal(pending.length, 1);
  const saved = f.journal.lookup(pending[0]); assert.equal(saved.spec.capacityPlanDigest, JSON.parse(await fs.readFile(f.c.capacityPlanPath, 'utf8')).planDigest);
  await f.restart();
  assert.equal((await f.execution.executor.prepare(input)).packageDigest, f.plan.package.digest);
  assert.equal(f.controls.supervisorEffects, 1); assert.equal(f.journal.lookup(saved).state, 'applied');
  assert.equal(f.journal.lookup(saved).spec.deadline, saved.spec.deadline);
  assert.ok(f.calls.some(call => call.peer === 'control' && call.url.endsWith('/renew')));
  assert.equal(f.calls.some(call => call.peer === 'business' && call.url.endsWith('/renew')), false);
  assert.equal((await f.execution.runOnce()).state, 'idle');
  const sample = await f.execution.sample(); assert.equal(sample[0].role, 'control'); assert.equal(sample[1].startIdentity, identity.startIdentity);
});

test('production factory preserves missing/short capacity as failure before a process effect and forbids installer replacement', async t => {
  const f = await fixture(t), input = { attempt: { instanceId, attemptId, plan: f.plan }, fence: 7, download: {} };
  const budget = await fs.readFile(f.c.capacityPlanPath);
  await fs.rm(f.c.capacityPlanPath);
  await assert.rejects(f.execution.executor.prepare(input), { code: 'ENOENT' }); assert.equal(f.controls.supervisorEffects, 0);
  await fs.writeFile(f.c.capacityPlanPath, budget, { mode: 0o600 }); f.controls.available = false;
  await assert.rejects(f.execution.executor.prepare(input), { code: 'SUPERVISOR_CAPACITY_SHORTAGE' });
  assert.equal(f.controls.supervisorEffects, 0);
  await assert.rejects(f.execution.executor.installerCandidate({ ...input, artifact: {} }), { code: 'BUSINESS_RELEASE_CANNOT_REPLACE_CONTROL' });
  assert.equal(f.controls.supervisorEffects, 0);
});

test('actual participant reconciliation stays on the original physical source after the current business writer binding changes', async t => {
  const f = await fixture(t); f.controls.lostBusinessAck = true;
  await assert.rejects(f.execution.coordinator.coordinatorHandoff(attemptId, { fence: 7, operationId: 'original-quiesce', planDigest: f.plan.planDigest, action: 'quiesce', candidate: identity }));
  assert.equal(f.controls.businessEffects, 1); assert.equal(f.journal.pending().length, 1);
  const recovery = await f.recovery(); await f.pointAtWrongWriter();
  await f.execution.adapter.admitAuthority(recovery);
  const result = await f.execution.adapter.reconcile(recovery);
  assert.equal(result.known, true); assert.equal(result.pendingCommands, 0); assert.equal(result.inFlightMutations, 0);
  assert.equal(f.controls.wrongWriterReads, 0); assert.equal(f.controls.businessEffects, 1);
  assert.ok(f.calls.some(call => call.peer === 'business' && call.input?.action === 'participantCommandStatus'));
  assert.equal(f.journal.lookup({ operationId: attemptId, commandId: 'original-quiesce:quiesce' }).epoch, recovery.intent.epoch);
});

test('contract assembly keeps original intent fence in the body and uses its separate execution epoch in private authority headers', async t => {
  const f = await fixture(t), contractId = '33333333-3333-4333-8333-333333333333';
  const current = f.authority.observe(); f.authority.release({ operationId: current.operationId, epoch: current.epoch, executorId: current.holderId });
  const record = { attempt: { instanceId, contractAttemptId: contractId, state: 'retiring-readers', sequence: 3 }, fence: 20, plan: { planDigest: sha('f') } };
  f.contractRecords.set(contractId, record);
  const first = await f.execution.ensureContractAuthority(record); assert.equal(first.epoch, 20);
  f.authority.release({ operationId: contractId, epoch: first.epoch, executorId: first.holderId });
  const next = await f.execution.ensureContractAuthority(record); assert.equal(next.epoch, 21); assert.equal(record.fence, 20);
  const port = createControlContractBusinessFactory({ c: f.c, business: f.rawBusiness, authority: f.authority, withCommandContext: f.withCommandContext });
  let committed; await port.activate(record, count => { committed = count; }); assert.equal(committed, 17);
  const request = f.calls.find(call => call.peer === 'business' && call.url === '/internal/upgrades/contract-business');
  assert.equal(request.input.fence, 20); assert.equal(request.headers['x-platform-control-epoch'], '21'); assert.equal(request.headers['x-platform-contract-id'], contractId);
});

test('recovery client selects the original quiescing business binding while only sending the new independent epoch as authority', async t => {
  const f = await fixture(t), recovery = await f.recovery();
  await fs.writeFile(f.c.coordinatorBindingPath, canonical({ instanceId, generation: 1, state: 'quiescing', origin: f.c.coordinatorOrigin, attemptId, fence: 7 }), { mode: 0o600 });
  const result = await f.withCommandContext({ recoveryId, epoch: recovery.intent.epoch, businessAttemptId: attemptId, businessFence: 7 }, () => f.rawBusiness.inspection({ action: 'metadata' }));
  assert.equal(result.result.schema, 29);
  const request = f.calls.find(call => call.peer === 'business' && call.input?.action === 'metadata');
  assert.equal(request.headers['x-platform-recovery-id'], recoveryId);
  assert.equal(request.headers['x-platform-recovery-epoch'], String(recovery.intent.epoch));
  assert.equal(request.headers['x-platform-control-epoch'], String(recovery.intent.epoch));
  assert.equal(request.headers['x-platform-business-fence'], undefined);
  const before = f.calls.length;
  await assert.rejects(f.withCommandContext({ recoveryId, epoch: recovery.intent.epoch, businessAttemptId: attemptId, businessFence: '7' }, () => f.rawBusiness.inspection({ action: 'metadata' })), { code: 'CONTROL_RECOVERY_BINDING_SCOPE_INVALID' });
  assert.equal(f.calls.length, before);
});

test('production fault handling persists a real whitelisted diagnostic and pins its original receipt before publishing the diagnostic ID', async t => {
  const f = await fixture(t);
  await assert.rejects(f.execution.controller.handleFault({ attempt: { attemptId } }, Object.assign(Error('untrusted error text must not enter diagnostics'), { code: 'HTTP_RPC_UNKNOWN' })), { code: 'CONTROL_RECOVERY_SOURCE_SCOPE_INVALID' });
  const row = f.sqlite.prepare('SELECT * FROM control_execution_faults WHERE attempt_id=?').get(attemptId);
  assert.equal(row.phase, 'recover'); assert.equal(row.state, 'persisted'); assert.ok(row.recorded_at);
  const actual = await f.args.diagnostics.lookupFault(row.fault_id);
  assert.equal(actual.state, 'persisted'); assert.equal(actual.recordedAt, row.recorded_at);
  assert.deepEqual(f.execution.diagnosticStatus(), { correlationId: row.fault_id, code: 'HTTP_RPC_UNKNOWN', phase: 'recover', recordedAt: row.recorded_at });
  const pins = (await fs.readdir(join(f.c.root, '..', 'diagnostics'))).filter(name => name.endsWith('.pin.json'));
  assert.equal(pins.length, 1, 'diagnostic must have a durable receipt pin');
});

test('a real API operation that outlives its lost HTTP acknowledgement remains physically pending then closes by original-ID lookup', async t => {
  const f = await fixture(t); f.controls.loseAckWhileRunning = true; f.controls.workDelay = 180;
  await assert.rejects(f.execution.coordinator.coordinatorHandoff(attemptId, { fence: 7, operationId: 'late-quiesce', planDigest: f.plan.planDigest, action: 'quiesce', candidate: identity }));
  const startedDeadline = Date.now() + 500;
  while (f.controls.businessEffects === 0 && Date.now() < startedDeadline) await new Promise(ok => setTimeout(ok, 1));
  assert.equal(f.controls.businessEffects, 1, 'actual API work must enter before its old authority is revoked');
  const recovery = await f.recovery(); await f.execution.adapter.admitAuthority(recovery);
  const held = await f.execution.adapter.reconcile(recovery);
  assert.equal(held.known, false); assert.equal(held.pendingCommands, 1); assert.equal(held.inFlightMutations, 1);
  assert.equal(f.controls.businessEffects, 1);
  await new Promise(ok => setTimeout(ok, 220));
  const done = await f.execution.adapter.reconcile(recovery);
  assert.equal(done.known, true); assert.equal(done.inFlightMutations, 0); assert.equal(done.pendingCommands, 0);
  assert.equal(f.controls.businessEffects, 1);
  assert.deepEqual(f.journal.lookup({ operationId: attemptId, commandId: 'late-quiesce:quiesce' }).result, { commitKnown: true, stage: 'quiesced' });
});


test('early failed upgrade captures the prior serving binding without borrowing its old upgrade authority', async t => {
  const f = await fixture(t, { earlyFailure: true }), recovery = await f.recovery();
  const receipt = recovery.intent.authorizationPlan.businessBinding, { receiptDigest, ...facts } = receipt;
  assert.equal(receipt.binding.attemptId, 'previous-serving-attempt'); assert.equal(receipt.binding.fence, 6);
  assert.equal(digest(facts), receiptDigest); assert.ok(Date.now() - Date.parse(receipt.observedAt) < 5000);
  await f.execution.adapter.admitAuthority(recovery);
  await fs.writeFile(f.c.coordinatorBindingPath, canonical({ instanceId, generation: 1, state: 'quiescing', origin: f.c.coordinatorOrigin, attemptId: 'previous-serving-attempt', fence: 6 }), { mode: 0o600 });
  const metadata = await f.withCommandContext({ recoveryId, epoch: recovery.intent.epoch, businessAttemptId: 'previous-serving-attempt', businessFence: 6 }, () => f.rawBusiness.inspection({ action: 'metadata' }));
  assert.equal(metadata.result.schema, 29);
  const result = await f.execution.adapter.reconcile(recovery);
  assert.equal(result.known, true); assert.equal(result.inFlightMutations, 0);
  const actual = await (await fetch(f.entry.controlOrigin + '/binding', { headers: { 'x-platform-internal-key': entryKey } })).json();
  assert.equal(actual.attemptId, 'previous-serving-attempt'); assert.equal(actual.fence, 6);
  assert.equal(recovery.intent.triggeringAttemptId, attemptId); assert.equal(recovery.intent.epoch, 8);
  const changed = { ...recovery.intent, authorizationPlan: { ...recovery.intent.authorizationPlan,
    businessBinding: { ...receipt, binding: { ...receipt.binding, attemptId }, receiptDigest } } };
  await assert.rejects(f.execution.adapter.reconcile({ ...recovery, intent: changed }), { code: 'CONTROL_RECOVERY_BUSINESS_BINDING_UNKNOWN' });
});

test('a physical candidate start requires a unique explicit capacity allocation frozen in its original command', async t => {
  const f = await fixture(t), input = { attempt: { instanceId, attemptId, plan: f.plan }, fence: 7, artifact: {}, operationId: 'candidate-coordinator' };
  await assert.rejects(f.execution.executor.coordinatorHandoff(input), { code: 'CONTROL_CAPACITY_ALLOCATION_UNKNOWN' });
  assert.equal(f.controls.supervisorEffects, 0);
  f.c.capacityAllocationIds = { coordinator: 'candidate' };
  // This fixture intentionally has no physical /observe adapter. The actual
  // launch acknowledgement is persisted before that unavailable next port.
  await assert.rejects(f.execution.executor.coordinatorHandoff(input));
  const row = f.journal.lookup({ operationId: attemptId, commandId: `${attemptId}:supervisor:start:coordinator` });
  assert.equal(row.state, 'applied'); assert.equal(row.spec.capacityAllocationId, 'candidate');
  const plan = JSON.parse(await fs.readFile(f.c.capacityPlanPath, 'utf8'));
  assert.deepEqual(row.spec.resources, plan.allocations.candidate[0].resources);
  assert.equal(row.spec.capacityPlanDigest, plan.planDigest); assert.equal(f.controls.supervisorEffects, 1);
});
