import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { digest, canonical, runInputFingerprint, signQualificationManifest } from '../upgrade/trust.mjs';
import { atomicJson, fileDigest } from '../upgrade/io.mjs';
import { collectLegacySettlementInventory, validateLegacySettlement, observeLegacySettlement } from '../upgrade/legacy-settlement.mjs';
import { observeControlAdoptionEntry, planControlAdoption } from '../upgrade/control-adoption-preflight.mjs';
import { createStableEntry } from '../upgrade/stable-entry.mjs';

const api = createRequire(new URL('../../api/package.json', import.meta.url));
const contractsRequire = createRequire(new URL('../../api/packages/contracts/package.json', import.meta.url));
api('reflect-metadata');
const ts = api('typescript'), Database = api('better-sqlite3');
const historicalRoot = fileURLToPath(new URL('./legacy-settlement-17e2/', import.meta.url));
const provenance = JSON.parse(await fs.readFile(join(historicalRoot, 'provenance.json'), 'utf8'));
for (const row of provenance.files) assert.deepEqual(await fileDigest(join(historicalRoot, row.path)),
  { digest: row.rawDigest, bytes: row.bytes }, 'historical source changed: ' + row.path);
const instanceId = 'legacy-settlement-local-protocol';

// The original TS factories and schemas are transpiled unchanged. Only DI
// tokens/instance identity are ports; no current UpgradeStore implementation is
// substituted and accepted intent rows are never inserted by test SQL.
const modules = new Map();
function historical(path) {
  if (modules.has(path)) return modules.get(path).exports;
  const row = provenance.files.find(r => r.path === path);assert(row, path);
  const source = fsSync(path), module = { exports: {} };modules.set(path, module);
  const generated = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, experimentalDecorators: true, emitDecoratorMetadata: true } }).outputText;
  const require = name => {
    if (name === '@platform/contracts') return historical('packages/contracts/src/upgrade.contract.ts');
    if (name === '@platform/sandbox') return { platformInstanceId: () => instanceId };
    if (name === '@platform/shared-kernel') return { CLOCK: Symbol.for('fixture-clock'), ID_GENERATOR: Symbol.for('fixture-ids'), fromEpochMs: n => new Date(n) };
    if (name === '../persistence/platform.module') return { PLATFORM_SQLITE: Symbol.for('fixture-database') };
    if (name === './upgrade-inspector') return { loopbackOrigin: value => new URL(value).origin };
    if (name === '../config/env') return { env: { host: '127.0.0.1', port: 1 } };
    if (['@platform/project', '@platform/automation', '@platform/terminal', '../events/events.gateway',
      '../control-rpc/control-rpc.module', '../persistence/coordinator-lease'].includes(name)) return {};
    if (name === 'zod') return contractsRequire(name);
    if (name.startsWith('./')) return historical(join(dirname(path), name + '.ts'));
    if (name.startsWith('../time/')) return historical(join(dirname(path), name + '.ts'));
    return api(name);
  };
  new Function('require', 'module', 'exports', generated)(require, module, module.exports);
  return module.exports;
}
// Synchronous reads are only for compiling this pinned test source closure.
import { readFileSync } from 'node:fs';
const fsSync = path => readFileSync(join(historicalRoot, path), 'utf8');
const { UpgradeStore } = historical('apps/api/src/platform/upgrade/upgrade-store.ts');
const { UpgradeContractStore } = historical('apps/api/src/platform/upgrade/upgrade-contract-store.ts');
const { UpgradeRoleHandoffs } = historical('apps/api/src/platform/upgrade/upgrade-role-handoffs.ts');
const { CoordinatorHandoff } = historical('apps/api/src/platform/upgrade/coordinator-handoff.ts');
const oldTrust = historical('apps/api/src/platform/upgrade/upgrade-trust.ts');

async function fixture(t, { installerChange = false, coordinatorChange = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'legacy-settlement-'))),
    installerRoot = join(root, 'installer'), publicationRoot = join(root, 'publication');
  for (const path of [join(installerRoot, 'journals'), join(installerRoot, 'processes'), publicationRoot])
    await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const databasePath = join(root, 'business.sqlite'), db = new Database(databasePath);
  db.pragma('foreign_keys = ON');db.pragma('journal_mode = WAL');
  for (const row of provenance.files.filter(r => r.path.endsWith('.sql')))
    db.exec(await fs.readFile(join(historicalRoot, row.path), 'utf8'));
  t.after(async () => { db.close();await fs.rm(root, { recursive: true, force: true }); });
  const now = Date.now(), clock = { now: () => new Date(now) },
    store = new UpgradeStore(db, clock, { next: randomUUID }), component = label => ({ artifactDigest: digest(label),
      inputFingerprint: digest('input-' + label), sourceRevision: 'a'.repeat(40), protocol: { min: 1, max: 2 } });
  const source = { releaseId: 'v0.0.1', activationGeneration: 1, activatedAt: clock.now().toISOString(), schema: 28,
    channel: 'settlement-fixture', commits: { project: 'a'.repeat(40), api: 'b'.repeat(40), web: 'c'.repeat(40) },
    components: { api: component('api'), coordinator: component('coordinator'), owner: component('owner'),
      installer: component('installer'), web: { ...component('web'), webRevision: 'a'.repeat(40) } },
    productionWebBinding: 'http://127.0.0.1:12345' };
  store.bootstrap(source);
  const manifest = { schemaVersion: 2, releaseId: 'v0.0.2-fixture', channel: source.channel,
    publishedAt: clock.now().toISOString(), commits: source.commits,
    components: { ...source.components, web: { ...component('new-web'), webRevision: 'b'.repeat(40) },
      ...(installerChange ? { installer: component('new-installer') } : {}),
      ...(coordinatorChange ? { coordinator: component('new-coordinator') } : {}) },
    packages: [{ platform: process.platform, arch: process.arch, name: 'not-an-installed-native-package', bytes: 10,
      digest: digest('package-fixture'), url: 'https://example.invalid/not-a-native-qualification', format: 'native-tar' }],
    upgradePaths: [{ fromRelease: source.releaseId, minSchema: 28, maxSchema: 28, targetSchema: 28, bridgeReleases: [], migrationPlanDigest: null }],
    policy: { id: 'fixture-only', weights: [1, 5, 25, 100], stageDurationMs: 60000, minRequests: 100,
      observationFreshnessMs: 5000, probeHz: 10, requestDeadlineMs: 2000, attachDeadlineMs: 5000,
      softErrorDelta: 0.01, p95Ratio: 2, p95FloorMs: 1000, evaluationIntervalMs: 10000, consecutiveEvaluations: 2,
      retentionMs: 60000, migrationBatchMs: 500, maxWalBytes: 1000000, minFreeBytes: 1000000,
      fallbacks: [{ releaseId: source.releaseId, apiDigest: source.components.api.artifactDigest,
        webDigest: source.components.web.artifactDigest, rehearsed: false }], stopUserResources: false,
      restoreLiveVolume: false, contractInUpgrade: false }, evidence: [], purpose: 'qualification' };
  manifest.qualification = { instanceId, inputFingerprint: runInputFingerprint(manifest) };
  const keys = generateKeyPairSync('ed25519'), envelope = signQualificationManifest(manifest, 'local-fixture', keys.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const roots = { schemaVersion: 1, channel: manifest.channel, purpose: 'qualification', qualificationInstanceId: instanceId,
    distributionOrigins: ['https://example.invalid'], keys: [{ id: 'local-fixture', publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }) }] };
  const priorInstance = process.env.PLATFORM_INSTANCE_ID;let verified;
  try { process.env.PLATFORM_INSTANCE_ID = instanceId;verified = oldTrust.verifyUpgradeEnvelope(envelope, roots, now); }
  finally { if (priorInstance === undefined) delete process.env.PLATFORM_INSTANCE_ID;else process.env.PLATFORM_INSTANCE_ID = priorInstance; }
  const plan = oldTrust.freezeUpgradePlan(verified, source);
  // Only physical role observation is a synthetic port. This test never stops
  // an installer, launches a role/Guest, or claims actual Native qualification.
  const installerIdentity = { instanceId, containerId: 'synthetic-original-installer', startIdentity: 'synthetic-original-start', artifactDigest: source.components.installer.artifactDigest },
    observationsPath = join(root, 'process-observations.json');
  await atomicJson(observationsPath, { schemaVersion: 1, kind: 'legacy-settlement-process-observations', instanceId,
    observedAt: clock.now().toISOString(), installer: { ...installerIdentity, running: false, pid: 0, exitCode: 0,
      oomKilled: false, restartCount: 0, startedAt: new Date(now - 1000).toISOString(), finishedAt: new Date(now - 1).toISOString() }, processes: [] });
  const settlementConfig = { instanceId, databasePath, installerRoot, publicationRoot,
    processObservationsPath: observationsPath, installerIdentity };
  const ports = { Database, clock: () => now };
  const collect = () => collectLegacySettlementInventory({ ...settlementConfig, ...ports });
  let accepted;
  const accept = () => accepted ??= store.accept('local-admin', { requestId: randomUUID(), targetReleaseId: manifest.releaseId,
    targetDigest: envelope.manifestDigest, expectedActivationGeneration: 1 }, envelope, plan, 0);
  const commit = (kind, payload, confirmed) => {
    const current = store.snapshot(accepted.attemptId);
    return store.commit(accepted.attemptId, { fence: current.fence, generation: current.attempt.generation,
      expectedSequence: current.attempt.sequence, eventId: randomUUID(), kind, payload }, confirmed);
  };
  const complete = async () => {
    accept();store.claim(accepted.attemptId, 'original-controller', 15000);
    const journal = { attemptId: accepted.attemptId, planDigest: plan.planDigest, steps: {} };
    for (const step of plan.steps) {
      const evidence = { explicitSyntheticResultPort: true, stepId: step.stepId }, receiptDigest = digest(evidence);
      commit('step-applied', { stepId: step.stepId, receiptDigest, completedWork: step.totalWork, evidence });
      journal.steps[step.stepId] = { state: 'applied', receiptDigest, completedWork: step.totalWork, evidence };
      const kind = { candidate: 'api', web: 'web', 'coordinator-handoff': 'coordinator',
        'owner-candidate': 'owner', 'installer-handoff': 'installer' }[step.kind];
      if (kind) {
        const record = { ...manifest.components[kind], state: 'started', kind, instanceId, attemptId: accepted.attemptId,
          containerId: 'synthetic-candidate-' + kind, startIdentity: 'synthetic-start-' + kind, pid: 123 };
        await atomicJson(join(installerRoot, 'processes', accepted.attemptId + '-' + kind + '.json'), record);
        const observations = JSON.parse(await fs.readFile(observationsPath, 'utf8'));
        observations.processes.push({ ...record, running: true });await atomicJson(observationsPath, observations);
      }
    }
    commit('activation-confirmed', { explicitSyntheticActivationPort: true }, { ...source, releaseId: manifest.releaseId,
      components: manifest.components, activationGeneration: 2 });
    const path = join(installerRoot, 'journals', accepted.attemptId + '.json');await atomicJson(path, journal);
    return { journal, path };
  };
  return { root, db, store, source, manifest, plan, clock, collect, accept, complete, commit, observationsPath, installerRoot,
    settlementConfig, ports,
    validate: inventory => validateLegacySettlement(inventory, { clock: () => now }),
    contracts: new UpgradeContractStore(store, clock, { next: randomUUID }) };
}
const has = (result, code) => result.blockers.some(row => row.code === code);

test('original 17e2 migrations/Store bootstrap is the empty-intent fast path; collection stays read-only', async t => {
  const f = await fixture(t), before = f.db.prepare('SELECT total_changes() n').get().n;
  const inventory = await f.collect(), result = f.validate(inventory);
  assert.equal(result.settled, true, JSON.stringify(result));assert.equal(result.mode, 'bootstrap-empty');
  assert.equal(result.adoptionAuthorized, false);assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
  assert.equal(inventory.database.queryOnly, true);assert.equal(inventory.databaseWrites, 0);
});

test('normal exit alone and missing physical result sources cannot settle even an empty pending list', async t => {
  const f = await fixture(t), inventory = await f.collect();inventory.observations = null;
  const result = f.validate(inventory);assert.equal(result.settled, false);
  assert(has(result, 'LEGACY_PROCESS_OBSERVATIONS_REQUIRED'));
  assert(has(result, 'LEGACY_INSTALLER_NORMAL_EXIT_UNPROVEN'));
});

test('an intent accepted by the actual old factory blocks until original receipts and terminal state exist', async t => {
  const f = await fixture(t);f.accept();
  const result = f.validate(await f.collect());assert.equal(result.settled, false);
  assert(has(result, 'LEGACY_UPGRADE_NOT_TERMINAL'));assert(has(result, 'LEGACY_INSTALLER_JOURNAL_REQUIRED'));
});

test('original Store receipts settle a complete local protocol history and reject a mismatched Installer receipt', async t => {
  const f = await fixture(t), { journal, path } = await f.complete();
  const result = f.validate(await f.collect());assert.equal(result.settled, true, JSON.stringify(result));
  assert.equal(result.mode, 'original-results');
  journal.steps[Object.keys(journal.steps)[0]].receiptDigest = digest('different-original-result');
  await atomicJson(path, journal);assert(has(f.validate(await f.collect()), 'LEGACY_STEP_RECEIPT_MISMATCH'));
});

test('a lost local commit ACK is resolved only by the same original Store step result, without rewriting the journal', async t => {
  const f = await fixture(t), { journal, path } = await f.complete(), stepId = Object.keys(journal.steps)[0];
  journal.steps[stepId] = { state: 'applying', operationId: randomUUID(), fence: 1 };await atomicJson(path, journal);
  const before = await fileDigest(path), result = f.validate(await f.collect());
  assert.equal(result.settled, true, JSON.stringify(result));assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0].by, 'original-upgrade-step-receipt');assert.deepEqual(await fileDigest(path), before);
});

test('unknown recovery generated by old commit factory remains blocked although original pending is empty and all steps are applied', async t => {
  const f = await fixture(t);await f.complete();
  f.commit('ready-revoked', { reason: 'fixture-response-lost' });
  const recovery = { schemaVersion: 1, triggeringAttemptId: f.store.latest().attemptId, eligibilityDigest: digest('fixture'),
    api: null, web: null, coordinator: null, owner: null, componentScope: ['web'], faultDigest: digest('original-fault') };
  recovery.planDigest = digest(recovery);
  f.commit('recovery-started', { recoveryAttemptId: randomUUID(), recoveryPlan: recovery, reason: 'fixture' });
  f.commit('recovery-failed', { reason: 'ORIGINAL_RPC_RESULT_UNKNOWN', actual: {} });
  assert.equal(f.store.pending().attempts.length, 0);
  assert(has(f.validate(await f.collect()), 'LEGACY_RECOVERY_NOT_CONFIRMED'));
});

test('monitor faultCommit and independent recovery flags are checked separately from all-applied steps', async t => {
  const f = await fixture(t), { journal, path } = await f.complete();
  journal.circuitBroken = true;journal.faultRecordingComplete = true;journal.monitorStopped = 'recovery-unknown';
  journal.faultCommit = { eventId: randomUUID(), kind: 'ready-revoked', payload: { reason: 'fixture' } };
  await atomicJson(path, journal);
  const result = f.validate(await f.collect());assert(has(result, 'LEGACY_FAULT_COMMIT_UNKNOWN'));
  assert(has(result, 'LEGACY_MONITOR_ORIGINAL_RESULT_UNKNOWN'));
});

test('old contract factory intents block independently of pending; completed alone cannot replace the original expand result', async t => {
  const f = await fixture(t), facts = { schemaVersion: 1, kind: 'project-name-contract', expandPlanDigest: digest('expand'),
    targetTable: 'upg_shadow_fixture', nameColumn: 'name', artifactInputFingerprint: digest('artifact'), rollbackWindowMs: 60000,
    maxValidationRows: 100, maxBatchRows: 10, batchBudgetMs: 100, minFreeBytes: 1, maxWalBytes: 1000000,
    preserveUserResources: true, rollbackToLegacy: false }, plan = { ...facts, planDigest: digest(facts) };
  const record = f.contracts.accept('local-admin', { requestId: randomUUID(), targetPlanDigest: plan.planDigest,
    expectedActivationGeneration: 1, acknowledgeRollbackClosure: true }, { plan, signedManifest: {}, expandAttemptId: randomUUID(),
    readers: [], eligibility: {} }, 0);
  assert.equal(f.store.pending().attempts.length, 0);
  assert(has(f.validate(await f.collect()), 'LEGACY_CONTRACT_UNSETTLED'));
  f.contracts.save(record, { state: 'completed', stage: 'explicit synthetic contract result' });
  assert(has(f.validate(await f.collect()), 'LEGACY_CONTRACT_EXPAND_RESULT_REQUIRED'));
});

test('Supervisor starting records and missing original dispatch results cannot be settled by normal Installer exit', async t => {
  const f = await fixture(t), accepted = f.accept(), file = join(f.installerRoot, 'processes', accepted.attemptId + '-api.json');
  await atomicJson(file, { instanceId, attemptId: accepted.attemptId, kind: 'api', state: 'starting',
    containerId: 'explicit-synthetic-candidate', startIdentity: 'candidate', artifactDigest: digest('candidate') });
  const result = f.validate(await f.collect());assert(has(result, 'LEGACY_SUPERVISOR_START_UNKNOWN'));
  assert(has(result, 'LEGACY_SUPERVISOR_DISPATCH_RESULT_MISSING'));
  assert(has(result, 'LEGACY_SUPERVISOR_PROCESS_STATE_UNPROVEN'));
});

async function metadata(t, value) {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json');res.end(JSON.stringify(value)); });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise(ok => server.close(ok)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('the original Installer handoff factory can mark adopted after steps applied, but absent Supervisor activation still blocks', async t => {
  const f = await fixture(t, { installerChange: true });await f.complete();
  const candidate = { ...f.manifest.components.installer, kind: 'installer', instanceId,
    containerId: 'synthetic-candidate-installer', startIdentity: 'new-installer', pid: 123,
    origin: await metadata(t, { ...f.manifest.components.installer, startIdentity: 'new-installer', readyForHandoff: true }) };
  const factory = new UpgradeRoleHandoffs(f.store, { processObserve: async () => ({ qualified: true }) }, {}, f.clock),
    snapshot = f.store.snapshot(f.store.latest().attemptId);
  await factory.execute(snapshot.attempt.attemptId, 'installer', { operationId: randomUUID(), planDigest: f.plan.planDigest,
    fence: snapshot.fence, candidate, action: 'adopt' });
  assert.equal(f.db.prepare("SELECT stage FROM upgrade_role_handoffs WHERE kind='installer'").get().stage, 'adopted');
  assert.equal(f.store.pending().attempts.length, 0);
  const result = f.validate(await f.collect());assert(has(result, 'LEGACY_INSTALLER_ACTIVATION_RESULT_MISSING'));
});

test('the original prepared Coordinator factory leaves a durable prepared intent which cannot be discarded after an old failure', async t => {
  const f = await fixture(t, { coordinatorChange: true }), accepted = f.accept(),
    claim = f.store.claim(accepted.attemptId, 'original-controller', 15000),
    candidate = { ...f.manifest.components.coordinator, startIdentity: 'prepared-candidate',
      artifactRoot: join(f.installerRoot, 'artifacts', f.plan.package.digest.slice(7)) };
  candidate.origin = await metadata(t, { instanceId, startIdentity: candidate.startIdentity,
    artifactDigest: candidate.artifactDigest, role: 'coordinator-prepared', prepared: true,
    writerFenceValid: false, workersStarted: false });
  const unused = new Proxy({}, { get(_o, name) { throw Error('outside prepared fixture: ' + String(name)); } });
  const factory = new CoordinatorHandoff(f.store, { verifyArtifact: async () => undefined }, unused, unused, unused,
    unused, unused, unused, unused, unused, unused, f.clock, unused);
  const priorRoot = process.env.UPGRADE_INSTALLER_ROOT, priorGeneration = process.env.COORDINATOR_GENERATION;
  try {
    process.env.UPGRADE_INSTALLER_ROOT = f.installerRoot;process.env.COORDINATOR_GENERATION = '1';
    await factory.execute(accepted.attemptId, { operationId: randomUUID(), planDigest: f.plan.planDigest,
      fence: claim.fence, candidate, action: 'prepare' });
  } finally {
    if (priorRoot === undefined) delete process.env.UPGRADE_INSTALLER_ROOT;else process.env.UPGRADE_INSTALLER_ROOT = priorRoot;
    if (priorGeneration === undefined) delete process.env.COORDINATOR_GENERATION;else process.env.COORDINATOR_GENERATION = priorGeneration;
  }
  f.commit('failed', { reason: 'original-controller-error' });
  assert.equal(f.store.pending().attempts.length, 0);
  assert(has(f.validate(await f.collect()), 'LEGACY_COORDINATOR_HANDOFF_UNSETTLED'));
});

test('actual read-only collection is a required adoption precondition, never admission authority', async t => {
  const f = await fixture(t), web = join(f.root, 'web');await fs.mkdir(web);await fs.writeFile(join(web, 'index.html'), 'fixture');
  // This is an actual isolated Entry factory. Only the role inspector source in
  // settlementConfig is a declared synthetic port; no deployed drain is claimed.
  const entry = await createStableEntry({ root: join(f.root, 'entry'), instanceId, controlKey: 'e'.repeat(32),
    stickyKey: 's'.repeat(32), verifyFence: async () => {}, initialBinding: { instanceId, attemptId: 'original-fixture',
      fence: 1, routeGeneration: 1, weight: 0, oldApi: { origin: 'http://127.0.0.1:12345', digest: digest('api') },
      candidateApi: null, web: { root: web, digest: digest('web'), treeDigest: digest('tree') }, retainedWeb: [] } });
  t.after(() => entry.close());
  const headers = { 'x-platform-internal-key': 'e'.repeat(32) },
    expectedRuntime = await (await fetch(entry.controlOrigin + '/metadata', { headers })).json(),
    observed = await observeControlAdoptionEntry({ instanceId, entryControlOrigin: entry.controlOrigin,
      entryKey: 'e'.repeat(32), expectedRuntime });
  assert(planControlAdoption(observed).blockers.includes('CONTROL_ADOPTION_LEGACY_SETTLEMENT_REQUIRED'));
  const before = f.db.prepare('SELECT total_changes() n').get().n,
    settlementObservation = await observeLegacySettlement(f.settlementConfig, f.ports),
    plan = planControlAdoption(observed, { settlementObservation, clock: f.ports.clock });
  assert.equal(plan.legacySettlement.settled, true);assert.equal(plan.legacySettlement.mode, 'bootstrap-empty');
  assert.equal(plan.blockers.some(code => code.includes('SETTLEMENT')), false);
  assert.equal(plan.admissionAuthorized, false);assert.equal(plan.authorizesMutation, false);assert.equal(plan.state, 'blocked');
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
  assert(planControlAdoption(observed, { settlementObservation, clock: () => f.ports.clock() + 5001 })
    .legacySettlement.blockers.some(row => row.code === 'LEGACY_SETTLEMENT_OBSERVATION_EXPIRED'));
  assert(planControlAdoption(observed, { settlementObservation: JSON.parse(JSON.stringify(settlementObservation)) })
    .blockers.includes('CONTROL_ADOPTION_LEGACY_SETTLEMENT_OBSERVATION_REQUIRED'));
  f.accept();
  const active = await observeLegacySettlement(f.settlementConfig, f.ports),
    blocked = planControlAdoption(observed, { settlementObservation: active, clock: f.ports.clock });
  assert.equal(blocked.legacySettlement.settled, false);
  assert(blocked.blockers.includes('CONTROL_ADOPTION_LEGACY_SETTLEMENT_BLOCKED'));
  assert.equal(blocked.admissionAuthorized, false);
});
