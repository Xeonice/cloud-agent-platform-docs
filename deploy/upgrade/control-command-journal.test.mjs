import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlCommandJournal } from './control-command-journal.mjs';
import { createControlCommandExecutor } from './control-command-executor.mjs';
import { digest } from './trust.mjs';
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const Database = require('better-sqlite3');

test('crash after dispatch reconciles the original command under a new epoch without repeating it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'control-journal-'));
  let now = 1000, epoch = 1;
  const factory = sqlite => createControlCommandJournal({ sqlite, instanceId: 'test-instance', clock: () => now,
    assertAuthority: a => assert.equal(a.epoch, epoch) });
  const spec = { action: 'retire-role', target: { role: 'api', startIdentity: 'birth-1' }, deadline: 9000, budget: { maxActions: 1 } };
  const key = { operationId: 'op-1', commandId: 'cmd-1' };
  const authorization = { epoch, executorId: 'controller-1', expiresAt: 8000 };
  let sqlite = new Database(join(root, 'control.db')), journal = factory(sqlite);
  try {
    journal.prepare({ ...key, stepId: 'retire', spec, authorization });
    journal.begin({ ...key, authorization });
    sqlite.close();
    epoch = 2;
    sqlite = new Database(join(root, 'control.db')); journal = factory(sqlite);
    const next = { epoch, executorId: 'controller-2', expiresAt: 8000 };
    assert.equal(journal.pending()[0].commandId, key.commandId);
    assert.equal(journal.prepare({ ...key, stepId: 'retire', spec, authorization: next }).state, 'executing');
    assert.throws(() => journal.begin({ ...key, authorization: next }), /CONTROL_COMMAND_RECONCILIATION_REQUIRED/);
    journal.record({ ...key, authorization: next, state: 'applied', result: { stopped: true, startIdentity: 'birth-1' } });
    assert.equal(journal.lookup(key).state, 'applied');
    assert.throws(() => journal.record({ ...key, authorization: next, state: 'unknown' }), /CONTROL_COMMAND_ALREADY_APPLIED/);
    assert.throws(() => journal.prepare({ ...key, stepId: 'retire', spec: { ...spec, deadline: 10000 }, authorization: next }), /CONTROL_COMMAND_SPEC_CONFLICT/);
    assert.throws(() => journal.begin({ ...key, authorization }), /Expected values/);
    now = 10000;
    assert.equal(journal.lookup(key).state, 'applied');
  } finally { sqlite.close(); await rm(root, { recursive: true, force: true }); }
});

test('an expired original deadline permits result lookup but never another dispatch', () => {
  let now = 1000;
  const sqlite = new Database(':memory:');
  try {
    const journal = createControlCommandJournal({ sqlite, instanceId: 'test-instance', clock: () => now, assertAuthority: () => {} });
    const input = { operationId: 'op-1', commandId: 'cmd-1', stepId: 'prepare', spec: { action: 'prepare', deadline: 2000, budget: { maxActions: 1 } }, authorization: { epoch: 1, executorId: 'a', expiresAt: 5000 } };
    journal.prepare(input); journal.begin(input);
    journal.record({ ...input, state: 'definitely-not-applied', result: { authoritative: true } });
    now = 2500;
    assert.equal(journal.prepare(input).state, 'definitely-not-applied');
    assert.throws(() => journal.begin(input), /CONTROL_COMMAND_DEADLINE_EXPIRED/);
    assert.throws(() => journal.prepare({ ...input, commandId: 'cmd-2' }), /CONTROL_COMMAND_DEADLINE_EXPIRED/);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM control_commands').get().n, 1);
  } finally { sqlite.close(); }
});

test('an unknown quiesce closes only with the real recovered confirmation and never becomes action success', async () => {
  const sqlite = new Database(':memory:');
  try {
    const instanceId = 'test-instance', recoveryId = 'recovery-1', participant = { startIdentity: 'source-birth', artifactDigest: 'sha256:' + 'a'.repeat(64) };
    sqlite.exec('CREATE TABLE confirmations(id TEXT PRIMARY KEY, receipt TEXT, recovered INTEGER)');
    let currentEpoch = 1;
    const journal = createControlCommandJournal({ sqlite, instanceId, clock: () => 1000,
      assertAuthority: a => assert.equal(a.epoch, currentEpoch),
      verifyRecoveryConfirmation: input => {
        const persisted = sqlite.prepare('SELECT * FROM confirmations WHERE id=?').get(input.recoveryId);
        assert.equal(persisted?.recovered, 1, 'must be recovered in the persisted transaction');
        return JSON.parse(persisted.receipt);
      } });
    const originalAuth = { epoch: 1, operationId: 'attempt-1', executorId: 'old', expiresAt: 2000, kind: 'upgrade' };
    const command = { operationId: 'attempt-1', commandId: 'handoff-1:quiesce', stepId: 'coordinator-handoff:quiesce',
      spec: { method: 'coordinatorHandoff', participant, body: { action: 'quiesce' }, deadline: 2000 }, authorization: originalAuth };
    journal.prepare(command); journal.begin(command); journal.record({ ...command, state: 'unknown', result: { code: 'ACK_UNKNOWN' } });
    currentEpoch = 2;
    const authorization = { epoch: 2, operationId: recoveryId, recoveryId, executorId: 'new', kind: 'recovery', expiresAt: 9000 };
    const closed = { operationId: command.operationId, commandId: command.commandId, specDigest: journal.lookup(command).specDigest,
      method: 'coordinatorHandoff', action: 'quiesce', stage: 'quiesced', participant,
      participantState: 'settled', participantReceiptDigest: 'sha256:' + 'b'.repeat(64), actualRunning: false, admissionClosed: true };
    const facts = { instanceId, qualified: true, recoveryId, epoch: 2, triggeringAttemptId: command.operationId, closedUnknownCommands: [closed] };
    const proof = { ...facts, receiptDigest: digest(facts) }, input = { ...command, authorization, recoveryId, confirmationReceiptDigest: proof.receiptDigest };
    assert.throws(() => journal.record({ ...input, state: 'reconciled', result: {} }), /CONTROL_COMMAND_RESULT_STATE_INVALID/);
    assert.throws(() => journal.reconcile(input), /must be recovered/);
    sqlite.prepare('INSERT INTO confirmations VALUES(?,?,0)').run(recoveryId, JSON.stringify(proof));
    assert.throws(() => journal.reconcile(input), /must be recovered/);
    assert.equal(journal.pending().length, 1);
    assert.throws(() => sqlite.transaction(() => {
      sqlite.prepare('UPDATE confirmations SET recovered=1').run(); journal.reconcile(input); throw Error('rollback');
    })(), /rollback/);
    assert.equal(journal.lookup(command).state, 'unknown');
    sqlite.transaction(() => { sqlite.prepare('UPDATE confirmations SET recovered=1').run(); journal.reconcile(input); })();
    assert.equal(journal.lookup(command).state, 'reconciled');
    assert.deepEqual(journal.lookup(command).result, { originalOutcome: 'unknown', recoveryId, confirmationReceiptDigest: proof.receiptDigest });
    assert.equal(journal.pending().length, 0); assert.equal(journal.reconcile(input).state, 'reconciled');
    assert.throws(() => journal.record({ ...input, state: 'applied', result: { commitKnown: true } }), /CONTROL_COMMAND_RESOLVED_BY_RECOVERY/);
    let mutations = 0;
    const executor = createControlCommandExecutor({ journal, authorization: () => authorization, clock: () => 1000 });
    await assert.rejects(executor.execute({ ...command, invoke: () => { mutations++; }, inspect: () => { mutations++; }, classify: () => ({ state: 'applied' }) }), /CONTROL_COMMAND_RESOLVED_BY_RECOVERY/);
    assert.equal(mutations, 0);
  } finally { sqlite.close(); }
});

test('recovery cannot reconcile release/adopt or an unclosed, foreign, or corrupt physical proof', () => {
  for (const bad of ['release', 'adopt', 'running', 'foreign', 'digest', 'not-started']) {
    const sqlite = new Database(':memory:');
    try {
      const participant = { startIdentity: 'source', artifactDigest: 'sha256:' + 'a'.repeat(64) };
      let proof;
      const journal = createControlCommandJournal({ sqlite, instanceId: 'test-instance', clock: () => 1000, assertAuthority: () => {}, verifyRecoveryConfirmation: () => proof });
      const action = ['release', 'adopt'].includes(bad) ? bad : 'quiesce';
      const input = { operationId: 'attempt-1', commandId: 'cmd', stepId: action, spec: { method: 'coordinatorHandoff', body: { action }, participant, deadline: 2000 },
        authorization: { epoch: 1, executorId: 'old', expiresAt: 8000 } };
      journal.prepare(input); journal.begin(input);
      const closure = { operationId: 'attempt-1', commandId: 'cmd', specDigest: journal.lookup(input).specDigest, method: 'coordinatorHandoff', action,
        stage: 'quiesced', participant: bad === 'foreign' ? { ...participant, startIdentity: 'foreign' } : participant,
        participantState: bad === 'not-started' ? 'not-started' : 'settled', participantReceiptDigest: 'sha256:' + 'b'.repeat(64), actualRunning: bad === 'running', admissionClosed: true };
      const facts = { instanceId: 'test-instance', qualified: true, recoveryId: 'recovery', epoch: 2, triggeringAttemptId: 'attempt-1', closedUnknownCommands: [closure] };
      proof = { ...facts, receiptDigest: bad === 'digest' ? 'sha256:' + '0'.repeat(64) : digest(facts) };
      assert.throws(() => journal.reconcile({ ...input, recoveryId: 'recovery', confirmationReceiptDigest: proof.receiptDigest,
        authorization: { kind: 'recovery', operationId: 'recovery', epoch: 2, executorId: 'new', expiresAt: 9000 } }), /CONTROL_RECOVERY_(COMMAND_CLOSURE|CONFIRMATION_SCOPE)_INVALID/);
      assert.equal(journal.lookup(input).state, 'executing');
    } finally { sqlite.close(); }
  }
});
