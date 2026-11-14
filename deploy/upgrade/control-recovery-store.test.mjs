import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createControlRecoveryStore } from './control-recovery-store.mjs';
import { digest } from './trust.mjs';
const Database = createRequire(new URL('../../api/package.json', import.meta.url))('better-sqlite3');
const recoveryId = '11111111-1111-4111-8111-111111111111', attemptId = '22222222-2222-4222-8222-222222222222';

test('recovery uses a new durable authority and preserves the original failure and successful history', () => {
  const db = new Database(':memory:'); let now = 1000;
  try {
    db.exec("CREATE TABLE history(state TEXT,percent INTEGER);INSERT INTO history VALUES('failed',42),('activation-confirmed',100)");
    const store = createControlRecoveryStore({ sqlite: db, instanceId: 'one', clock: () => now });
    const original = { recoveryId, triggeringAttemptId: attemptId, authorizationPlan: { componentScope: ['api'], apiDigest: 'sha256:' + 'a'.repeat(64) }, reason: 'SLO_PROBE_FAILED', deadline: 60000 };
    let record = store.create(original);
    assert.equal(store.create(original).recoveryId, recoveryId);
    record = store.claim({ recoveryId, epoch: 27 });
    record = store.transition({ recoveryId, epoch: 27, expectedSequence: record.sequence, phase: 'reconciling' });
    assert.throws(() => store.transition({ recoveryId, epoch: 27, expectedSequence: record.sequence, phase: 'restoring' }), /FIXED_PLAN_REQUIRED/);
    const plan = { schemaVersion: 1, triggeringAttemptId: attemptId, api: { digest: original.authorizationPlan.apiDigest }, componentScope: ['api'] };
    plan.planDigest = digest(plan);
    assert.throws(() => store.freezePlan({ recoveryId, epoch: 27, plan, qualifies: () => false }), /PLAN_UNQUALIFIED/);
    record = store.freezePlan({ recoveryId, epoch: 27, plan, qualifies: (scope, candidate) => { assert.equal(scope.apiDigest, candidate.api.digest); return true; } });
    record = store.transition({ recoveryId, epoch: 27, expectedSequence: record.sequence, phase: 'restoring' });
    record = store.claim({ recoveryId, epoch: 28 });
    assert.equal(record.phase, 'restoring');
    assert.equal(record.deadline, original.deadline);
    record = store.transition({ recoveryId, epoch: 28, expectedSequence: record.sequence, phase: 'verifying' });
    assert.throws(() => store.transition({ recoveryId, epoch: 28, expectedSequence: record.sequence, phase: 'recovered' }), /CONFIRMATION_REQUIRED/);
    now = 2000;
    record = store.transition({ recoveryId, epoch: 28, expectedSequence: record.sequence, phase: 'recovered', confirmation: { qualified: true, recoveryId, epoch: 28, receiptDigest: digest({ actual: 'independently-verified-in-this-domain-test' }) } });
    assert.equal(store.view(record).state, 'recovery-confirmed');
    assert.equal(store.view(record).confirmedAt, new Date(now).toISOString());
    assert.equal(store.active(), null);
    assert.deepEqual(db.prepare('SELECT * FROM history').all(), [{ state: 'failed', percent: 42 }, { state: 'activation-confirmed', percent: 100 }]);
  } finally { db.close(); }
});

test('unknown/expired recovery stops without a retry loop, plan substitution, or deadline renewal', () => {
  const db = new Database(':memory:'); let now = 1000;
  try {
    const store = createControlRecoveryStore({ sqlite: db, instanceId: 'one', clock: () => now });
    const input = { recoveryId, triggeringAttemptId: attemptId, authorizationPlan: { scope: ['api'] }, reason: 'UNKNOWN', deadline: 2000 };
    store.create(input); let row = store.claim({ recoveryId, epoch: 5 });
    assert.throws(() => store.create({ ...input, recoveryId: '33333333-3333-4333-8333-333333333333' }), /ALREADY_ACTIVE/);
    assert.throws(() => store.create({ ...input, deadline: 3000 }), /INTENT_CONFLICT/);
    now = 2500;
    row = store.transition({ recoveryId, epoch: 5, expectedSequence: row.sequence, phase: 'blocked', reason: 'ORIGINAL_DEADLINE_EXHAUSTED' });
    assert.equal(store.view(row).state, 'failed');
    assert.throws(() => store.claim({ recoveryId, epoch: 6 }), /CLAIM_INVALID/);
    assert.throws(() => store.transition({ recoveryId, epoch: 5, expectedSequence: row.sequence, phase: 'reconciling' }), /TRANSITION_CONFLICT/);
  } finally { db.close(); }
});
