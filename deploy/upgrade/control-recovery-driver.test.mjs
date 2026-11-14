import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createControlAuthority } from './control-authority.mjs';
import { createControlRecoveryStore } from './control-recovery-store.mjs';
import { createControlRecoveryDriver } from './control-recovery-driver.mjs';
import { digest } from './trust.mjs';

const Database = createRequire(new URL('../../api/package.json', import.meta.url))('better-sqlite3');
const instanceId = 'recovery-driver-test', attemptId = '22222222-2222-4222-8222-222222222222', recoveryId = '11111111-1111-4111-8111-111111111111';
const sha = letter => 'sha256:' + letter.repeat(64);
const policy = { stageDurationMs: 60000, probeHz: 10, minRequests: 100, observationFreshnessMs: 5000,
  requestDeadlineMs: 2000, attachDeadlineMs: 5000, evaluationIntervalMs: 1000,
  softErrorDelta: 0.01, p95Ratio: 2, p95FloorMs: 1000, consecutiveEvaluations: 2,
  fallbacks: [{ releaseId: '1.0.0', apiDigest: sha('a'), webDigest: sha('b') }] };

// Driver/authority/intent are production modules and actual SQLite. Physical
// observation and UpgradeStore ports are explicit fixtures, not qualification.
function fixture(t, { verifying = false, executorId = 'recovery-controller', overrides = {}, sleep, signal } = {}) {
  const sqlite = new Database(':memory:'); t.after(() => sqlite.close());
  let now = 1000; const clock = () => now, calls = [];
  sqlite.exec("CREATE TABLE original_history(state TEXT,percent INTEGER,fence INTEGER,lease_expires_at INTEGER);INSERT INTO original_history VALUES('failed',42,7,0),('activation-confirmed',100,6,0)");
  const snapshot = { attempt: { instanceId, attemptId, targetDigest: sha('d'), planDigest: sha('c'), fence: 7, leaseExpiresAt: 0, state: 'failed' },
    plan: { planDigest: sha('c'), policy, sourceActivationGeneration: 1 },
    signedManifest: { manifestDigest: sha('d'), manifest: { components: { api: { artifactDigest: sha('d') } } } },
    sourceActivation: { releaseId: '1.0.0' } };
  const recoveryStore = createControlRecoveryStore({ sqlite, instanceId, clock });
  const authority = createControlAuthority({ sqlite, instanceId, clock, validateRecovery: value => {
    assert.equal(recoveryStore.read(value.operationId).triggeringAttemptId, value.supersedes);
  } });
  authority.activate({ expectedRevision: 1, sourceBindingDigest: sha('e') });
  authority.grant({ operationId: attemptId, epoch: 7, executorId: 'failed-controller', leaseMs: 15000 });
  const store = { instanceId, latest: () => snapshot.attempt, snapshot: () => snapshot,
    freezeAttemptForRecovery: value => { calls.push({ action: 'freeze', value }); assert.notEqual(value.epoch, snapshot.attempt.fence); } };
  if (verifying) {
    const proof = { instanceId, binding: { instanceId, attemptId, fence: 7, routeGeneration: 9, weight: 0, oldApi: { origin: 'http://127.0.0.1:39001', digest: sha('a') },
      candidateApi: null, web: { root: '/explicit-fixture/web', digest: sha('b'), treeDigest: sha('b') }, retainedWeb: [] }, observedAt: new Date(now).toISOString() };
    const businessBinding = { ...proof, receiptDigest: digest(proof) };
    let record = recoveryStore.create({ recoveryId, triggeringAttemptId: attemptId, reason: 'ACK_TIMEOUT', deadline: 200000,
      authorizationPlan: { targetDigest: snapshot.attempt.targetDigest, acceptedPlanDigest: snapshot.plan.planDigest, fallbacksDigest: digest(policy.fallbacks), faultDigest: sha('f'), componentScope: ['api'], sharedFault: false, businessBinding } });
    record = recoveryStore.claim({ recoveryId, epoch: 7 });
    record = recoveryStore.transition({ recoveryId, epoch: 7, expectedSequence: record.sequence, phase: 'reconciling' });
    const plan = { schemaVersion: 1, triggeringAttemptId: attemptId, api: { origin: 'http://127.0.0.1:39001', digest: sha('a') }, componentScope: ['api'], faultDigest: sha('f') };
    plan.planDigest = digest(plan);
    record = recoveryStore.freezePlan({ recoveryId, epoch: 7, plan, qualifies: () => true });
    record = recoveryStore.transition({ recoveryId, epoch: 7, expectedSequence: record.sequence, phase: 'restoring' });
    recoveryStore.transition({ recoveryId, epoch: 7, expectedSequence: record.sequence, phase: 'verifying' });
  }
  const adapter = Object.fromEntries(['captureBusinessBinding', 'admitAuthority', 'admitBusinessAuthority', 'reconcile', 'qualify', 'restore', 'observe', 'confirm', 'stabilizeCurrentWriter', 'captureStabilizationWitness'].map(action => [action, async context => {
    calls.push({ action, context });
    if (overrides[action]) return overrides[action](context);
    if (['admitAuthority', 'admitBusinessAuthority'].includes(action)) return;
    if (action === 'captureStabilizationWitness') return null;
    if (action === 'captureBusinessBinding') {
      const proof = { instanceId, binding: { instanceId, attemptId, fence: 7, routeGeneration: 9, weight: 0, oldApi: { origin: 'http://127.0.0.1:39001', digest: sha('a') },
        candidateApi: null, web: { root: '/explicit-fixture/web', digest: sha('b'), treeDigest: sha('b') }, retainedWeb: [] }, observedAt: new Date(now).toISOString() };
      return { ...proof, receiptDigest: digest(proof) };
    }
    if (action === 'reconcile') return { known: true, pendingCommands: 0, inFlightMutations: 0 };
    throw Object.assign(new Error('Unexpected phase'), { code: 'UNEXPECTED_TEST_PHASE' });
  }]));
  const driver = createControlRecoveryDriver({ sqlite, instanceId, store, recoveryStore, authority, adapter, executorId, clock,
    signal, sleep: sleep ?? (async ms => { now += ms; throw Object.assign(new Error('Stop after observing incomplete coverage'), { code: 'TEST_STOP_AFTER_PENDING' }); }) });
  return { driver, sqlite, recoveryStore, authority, snapshot, calls, original: () => sqlite.prepare('SELECT * FROM original_history').all() };
}
function observation(context, extra = {}) {
  const scope = { instanceId, attemptId, recoveryId: context.intent.recoveryId, controlEpoch: context.intent.epoch,
    businessAttemptId: attemptId, businessFence: 7, routeGeneration: 9, routeWeight: 0, coordinatorGeneration: 3, observerEpoch: 'new-observer-epoch',
    artifactDigest: sha('a'), startIdentity: 'actual-restored-api', origin: 'http://127.0.0.1:39001' };
  const lane = { scope, known: true, requests: 590, samples: 590, hz: 10, failures: 0, errorRate: 0, p95Ms: 1, maxLatencyMs: 1, windowMs: 59000 };
  return { scope, observedAt: new Date(1000).toISOString(), fenceValid: true, ownerGenerationsValid: true, routeGenerationValid: true,
    sharedStateHealthy: true, continuity: { qualified: true }, web: { qualified: true }, windowMs: 59000,
    invariants: Object.fromEntries(['unauthorizedStops', 'resourceRebuilds', 'duplicateCommands', 'duplicateOccurrences', 'writerConflicts', 'migrationDifferences', 'integrityFailures'].map(key => [key, 0])),
    probes: { ...lane, attachMaxMs: 1 }, recoveryProbes: lane, baseline: { ...lane, source: scope, qualified: true }, ...extra };
}

test('unknown original command blocks under a fresh independent epoch without changing failed lease or successful history', async t => {
  const f = fixture(t, { overrides: { reconcile: () => ({ known: false, pendingCommands: 1, inFlightMutations: 0 }) } });
  const before = f.original();
  const result = await f.driver.start({ snapshot: f.snapshot, fault: { code: 'ORIGINAL_ACK_UNKNOWN' } });
  assert.equal(result.state, 'blocked'); assert.equal(result.code, 'CONTROL_RECOVERY_OLD_ACTION_UNKNOWN');
  assert.equal(result.intent.epoch, 8); assert.equal(result.intent.phase, 'blocked');
  assert.deepEqual(f.original(), before);
  assert.equal(f.calls.find(value => value.action === 'admitAuthority').context.authorization.epoch, 8);
  assert.equal(f.calls.some(value => ['qualify', 'restore', 'confirm'].includes(value.action)), false);
  assert.equal(f.calls.some(value => value.action === 'admitBusinessAuthority'), false);
});

test('closed unknown quiesce permits only independent stabilization after physical reconciliation', async t => {
  const closed = { operationId: attemptId, commandId: 'original:quiesce', specDigest: sha('2'), method: 'coordinatorHandoff',
    action: 'quiesce', stage: 'quiesced', participant: { startIdentity: 'same-source', artifactDigest: sha('a') },
    participantState: 'settled', participantReceiptDigest: sha('3'), actualRunning: false, admissionClosed: true };
  const f = fixture(t, { overrides: {
    captureStabilizationWitness: () => ({ writer: { startIdentity: 'same-source' }, inventoryDigest: sha('4') }),
    reconcile: () => ({ known: false, pendingCommands: 1, inFlightMutations: 0, closedUnknownCommands: [closed] }),
    stabilizeCurrentWriter: context => ({ commitKnown: true, writerUnchanged: true, requiresFreshQualification: true, recoveryId: context.intent.recoveryId, epoch: context.intent.epoch }),
    qualify: context => { assert.deepEqual(context.closedUnknownCommands, [closed]); throw Object.assign(Error('fixture qualification unavailable'), { code: 'NO_PHYSICAL_QUALIFICATION' }); },
  } });
  const result = await f.driver.start({ snapshot: f.snapshot, fault: { code: 'ORIGINAL_ACK_UNKNOWN' } });
  assert.equal(result.code, 'NO_PHYSICAL_QUALIFICATION');
  const calls = f.calls.map(row => row.action);
  assert.ok(calls.indexOf('reconcile') < calls.indexOf('admitBusinessAuthority'));
  assert.ok(calls.indexOf('admitBusinessAuthority') < calls.indexOf('stabilizeCurrentWriter'));
  assert.ok(calls.indexOf('stabilizeCurrentWriter') < calls.indexOf('qualify'));
  assert.equal(calls.includes('confirm'), false);
});

test('an unsettled, foreign, or incomplete pending set cannot open the business recovery entrance', async t => {
  for (const bad of ['running', 'foreign', 'missing', 'release', 'not-started']) {
    const closed = { operationId: bad === 'foreign' ? 'foreign-attempt' : attemptId, commandId: 'original:quiesce', specDigest: sha('2'), method: 'coordinatorHandoff',
      action: bad === 'release' ? 'release' : 'quiesce', stage: 'quiesced', participant: { startIdentity: 'same-source', artifactDigest: sha('a') },
      participantState: bad === 'not-started' ? 'not-started' : 'settled', participantReceiptDigest: sha('3'), actualRunning: bad === 'running', admissionClosed: true };
    const f = fixture(t, { overrides: {
      captureStabilizationWitness: () => ({ writer: { startIdentity: 'same-source' }, inventoryDigest: sha('4') }),
      reconcile: () => ({ known: false, pendingCommands: bad === 'missing' ? 2 : 1, inFlightMutations: 0, closedUnknownCommands: [closed] }),
    } });
    const result = await f.driver.start({ snapshot: f.snapshot, fault: { code: 'ORIGINAL_ACK_UNKNOWN' } });
    assert.equal(result.code, 'CONTROL_RECOVERY_OLD_ACTION_UNKNOWN');
    assert.equal(f.calls.some(row => ['admitBusinessAuthority', 'stabilizeCurrentWriter', 'qualify', 'restore', 'confirm'].includes(row.action)), false);
  }
});

test('a known live old participant is awaited with read-only lookups before business recovery admission', async t => {
  let lookups = 0, pauses = 0;
  const f = fixture(t, { overrides: {
    reconcile: () => { lookups++; return lookups === 1 ? { known: false, pendingCommands: 1, inFlightMutations: 1 } : { known: true, pendingCommands: 0, inFlightMutations: 0 }; },
    qualify: () => { throw Object.assign(Error('explicit physical qualification fixture'), { code: 'NO_PHYSICAL_QUALIFICATION' }); },
  }, sleep: async ms => { pauses++; assert.ok(ms > 0 && ms <= 250); } });
  const original = f.original();
  const result = await f.driver.start({ snapshot: f.snapshot, fault: { code: 'ORIGINAL_ACK_UNKNOWN' } });
  assert.equal(result.code, 'NO_PHYSICAL_QUALIFICATION'); assert.equal(lookups, 2); assert.equal(pauses, 1);
  const calls = f.calls.map(row => row.action);
  assert.ok(calls.lastIndexOf('reconcile') < calls.indexOf('admitBusinessAuthority'));
  assert.deepEqual(f.original(), original);
});

test('shutdown while waiting for physical work preserves a resumable intent and does not mark recovery failed', async t => {
  const stop = new AbortController();
  const f = fixture(t, { signal: stop.signal, overrides: { reconcile: () => ({ known: false, pendingCommands: 1, inFlightMutations: 1 }) },
    sleep: async () => { stop.abort(); throw Object.assign(Error('shutdown'), { code: 'CONTROL_EXECUTION_STOPPED' }); } });
  const result = await f.driver.start({ snapshot: f.snapshot, fault: { code: 'ORIGINAL_ACK_UNKNOWN' } });
  assert.equal(result.state, 'stopped');
  const intent = f.recoveryStore.read(result.recoveryId);
  assert.equal(intent.phase, 'reconciling'); assert.equal(intent.reason, 'ORIGINAL_ACK_UNKNOWN'); assert.equal(intent.confirmedAt, null);
  assert.notEqual(f.authority.observe().holderId, null);
  assert.equal(f.calls.some(row => row.action === 'admitBusinessAuthority'), false);
});

test('another live recovery holder is observed without stealing its epoch or changing its durable intent', async t => {
  const f = fixture(t, { verifying: true });
  f.recoveryStore.claim({ recoveryId, epoch: 8 });
  f.authority.grant({ operationId: recoveryId, epoch: 8, executorId: 'other-live-process', kind: 'recovery', supersedes: attemptId, leaseMs: 15000 });
  const before = f.recoveryStore.read(recoveryId);
  assert.deepEqual(await f.driver.resume(recoveryId), { state: 'waiting', recoveryId });
  assert.deepEqual(f.recoveryStore.read(recoveryId), before);
  assert.equal(f.authority.observe().holderId, 'other-live-process'); assert.equal(f.calls.length, 0);
});

test('foreign recovery scope and mixed actual-API cohorts fail before confirmation', async t => {
  for (const wrong of ['scope', 'cohort', 'target']) {
    const f = fixture(t, { verifying: true, overrides: { observe: context => {
      const value = observation(context);
      if (wrong === 'scope') value.scope = { ...value.scope, recoveryId: '33333333-3333-4333-8333-333333333333' };
      if (wrong === 'cohort') value.baseline.source = { ...value.scope, startIdentity: 'different-incarnation' };
      if (wrong === 'target') { const changed = { ...value.scope, artifactDigest: sha('9') }; value.scope = changed; value.probes.scope = changed; value.recoveryProbes.scope = changed; value.baseline.source = changed; }
      return value;
    } } });
    const result = await f.driver.resume(recoveryId);
    assert.equal(result.state, 'blocked');
    assert.equal(result.code, wrong === 'scope' ? 'CONTROL_RECOVERY_OBSERVATION_SCOPE_MISMATCH' : wrong === 'cohort' ? 'CONTROL_RECOVERY_PROBE_COHORT_MISMATCH' : 'CONTROL_RECOVERY_TARGET_API_MISMATCH');
    assert.equal(f.calls.some(value => value.action === 'confirm'), false);
  }
});

test('a 59-second recovery window cannot confirm even with old candidate statistics and otherwise healthy receipts', async t => {
  const f = fixture(t, { verifying: true, overrides: { observe: context => observation(context, {
    candidate: { known: true, requests: 1000000, windowMs: 600000, errorRate: 0, p95Ms: 0 },
  }) } });
  const result = await f.driver.resume(recoveryId);
  assert.equal(result.state, 'blocked'); assert.equal(result.code, 'TEST_STOP_AFTER_PENDING');
  assert.equal(f.calls.filter(value => value.action === 'observe').length, 1);
  assert.equal(f.calls.some(value => value.action === 'confirm'), false);
});
