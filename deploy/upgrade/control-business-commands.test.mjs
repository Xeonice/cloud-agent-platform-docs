import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlAuthority } from './control-authority.mjs';
import { createControlRecoveryStore } from './control-recovery-store.mjs';
import { createControlCommandJournal } from './control-command-journal.mjs';
import { createControlBusinessCommands } from './control-business-commands.mjs';
import { digest } from './trust.mjs';

const Database = createRequire(new URL('../../api/package.json', import.meta.url))('better-sqlite3');
const attemptId = '22222222-2222-4222-8222-222222222222', recoveryId = '11111111-1111-4111-8111-111111111111';
const instanceId = 'business-command-test', planDigest = 'sha256:' + 'a'.repeat(64);
const identity = { artifactDigest: 'sha256:' + 'b'.repeat(64), startIdentity: 'source-incarnation' };
const candidate = { artifactDigest: 'sha256:' + 'c'.repeat(64), startIdentity: 'candidate-incarnation', origin: 'http://127.0.0.1:34999' };
const deferred = () => { let resolve; const promise = new Promise(ok => { resolve = ok; }); return { promise, resolve }; };

// Real authority, intent and command SQLite, with explicit transport/physical
// receipt fixtures. These tests do not qualify a Native process or Guest.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'control-business-test-'));
  let sqlite, now = 1000, authority, recoveryStore, journal, commands;
  const path = join(directory, 'control.db'), context = new AsyncLocalStorage(), calls = [], lookups = [];
  const handlers = {}, statuses = { semantic: () => ({ state: 'unknown' }), participant: () => ({ state: 'unknown' }) };
  const business = Object.fromEntries(['coordinatorHandoff', 'ownerCandidate', 'migration', 'coordinatorRecovery', 'coordinatorResume'].map(method => [method, (id, body, options) => {
    calls.push({ method, id, body, options, context: context.getStore() });
    return handlers[method]?.(id, body, options) ?? { commitKnown: true, stage: body.action === 'prepare' ? 'prepared' : 'adopted' };
  }]));
  business.recoveryActions = () => handlers.recoveryActions?.() ?? [];
  const inspector = {
    commandStatus: input => { lookups.push({ kind: 'semantic', input }); return statuses.semantic(input); },
    participantCommandStatus: input => { lookups.push({ kind: 'participant', input }); return statuses.participant(input); },
  };
  const open = () => {
    sqlite = new Database(path);
    recoveryStore = createControlRecoveryStore({ sqlite, instanceId, clock: () => now });
    authority = createControlAuthority({ sqlite, instanceId, clock: () => now, validateRecovery: input => {
      const intent = recoveryStore.read(input.operationId);
      assert.equal(intent.triggeringAttemptId, input.supersedes);
      assert.equal(intent.epoch, input.epoch);
    } });
    if (authority.observe().mode === 'passive') {
      authority.activate({ expectedRevision: 1, sourceBindingDigest: planDigest });
      authority.grant({ operationId: attemptId, epoch: 7, executorId: 'upgrade-seven', leaseMs: 120000 });
    }
    journal = createControlCommandJournal({ sqlite, instanceId, clock: () => now, assertAuthority: authorization => authority.assert(authorization) });
    commands = createControlBusinessCommands({ journal, authority, recoveryStore, business, inspector, clock: () => now,
      participantIdentity: () => handlers.identity ? handlers.identity() : identity,
      withCommandContext: (value, work) => context.run(value, work) });
  };
  open();
  statuses.participant = value => {
    const row = journal.lookup({ operationId: attemptId, commandId: value.commandId });
    const fact = { state: 'settled', outcome: 'rejected', instanceId, ...value, specDigest: row.specDigest, participant: row.spec.participant, startedAt: 1000, settledAt: 1100, code: 'BUSINESS_ACTION_REJECTED' };
    fact.receiptDigest = digest(fact);
    return { instanceId, ...value, specDigest: row.specDigest, participant: row.spec.participant,
      state: 'settled', actualRunning: false, admissionClosed: true, receipt: fact };
  };
  t.after(async () => { sqlite.close(); await rm(directory, { recursive: true, force: true }); });
  return { calls, lookups, handlers, statuses, get commands() { return commands; }, get journal() { return journal; }, get authority() { return authority; },
    advance(value) { now = value; }, restart() { sqlite.close(); open(); },
    recovery({ restoring = false } = {}) {
      let intent = recoveryStore.latest(attemptId) ?? recoveryStore.create({ recoveryId, triggeringAttemptId: attemptId, authorizationPlan: { componentScope: ['coordinator'], acceptedPlanDigest: planDigest }, reason: 'RPC_ACK_LOST', deadline: 200000 });
      const epoch = authority.observe().epoch + 1;
      intent = recoveryStore.claim({ recoveryId, epoch });
      authority.grant({ operationId: recoveryId, epoch, executorId: `recovery-${epoch}`, kind: 'recovery', supersedes: attemptId, leaseMs: 120000 });
      if (intent.phase === 'created') intent = recoveryStore.transition({ recoveryId, epoch, expectedSequence: intent.sequence, phase: 'reconciling' });
      if (restoring && intent.phase === 'reconciling') {
        const plan = { schemaVersion: 1, triggeringAttemptId: attemptId, coordinator: { ...identity }, componentScope: ['coordinator'] };
        plan.planDigest = digest(plan);
        intent = recoveryStore.freezePlan({ recoveryId, epoch, plan, qualifies: () => true });
        intent = recoveryStore.transition({ recoveryId, epoch, expectedSequence: intent.sequence, phase: 'restoring' });
      }
      const current = authority.observe();
      return { intent, authorization: { operationId: recoveryId, kind: 'recovery', epoch, executorId: current.holderId, expiresAt: current.leaseExpiresAt } };
    },
  };
}
function input(action = 'prepare', method = 'coordinatorHandoff', extra = {}) {
  return { method, args: [attemptId, { fence: 7, operationId: 'original-role-operation', action, planDigest, ...(method === 'migration' ? { checkpoint: null } : { candidate: structuredClone(candidate) }), ...extra }, ...(action === 'prepare' ? [{ timeoutMs: 120000 }] : [])] };
}
function originalReceipt(inputValue, extra = {}) {
  return { instanceId, attemptId, commandKind: inputValue.commandKind, operationId: inputValue.operationId, planDigest, stage: 'prepared', state: 'unknown', actionsCompleted: ['prepare'], candidate, ...extra };
}

test('normal command freezes effect/participant/deadline, propagates scoped context and preserves the actual receipt', async t => {
  const f = await fixture(t), receipt = { commitKnown: true, stage: 'prepared', evidence: { prepared: true } };
  f.handlers.coordinatorHandoff = () => receipt;
  const request = input();
  assert.deepEqual(await f.commands.executeCommand(request), receipt);
  const key = { operationId: attemptId, commandId: 'original-role-operation:prepare' }, row = f.journal.lookup(key);
  assert.deepEqual(row.spec.participant, identity);
  assert.equal(row.spec.path, `/internal/upgrades/${attemptId}/coordinator-handoff`);
  assert.equal(row.spec.body.fence, undefined); assert.equal(row.spec.originalFence, 7); assert.equal(row.spec.deadline, 121000);
  assert.deepEqual(f.calls[0].context, { ...key, specDigest: row.specDigest, deadline: row.spec.deadline });
  assert.equal(f.calls[0].options.timeoutMs, 120000);
  f.advance(2000);
  assert.deepEqual(await f.commands.executeCommand({ ...request, args: [attemptId, { ...request.args[1] }, { timeoutMs: 120000 }] }), receipt);
  assert.equal(f.calls.length, 1); assert.equal(f.journal.lookup(key).spec.deadline, 121000);
  await assert.rejects(f.commands.executeCommand(input('prepare', 'coordinatorHandoff', { planDigest: 'sha256:' + 'f'.repeat(64) })), { code: 'CONTROL_COMMAND_SPEC_CONFLICT' });
  assert.equal(f.calls.length, 1);
});

test('participant is mandatory and coordinator adoption is bound to the target identity', async t => {
  const f = await fixture(t); f.handlers.identity = () => null;
  await assert.rejects(f.commands.executeCommand(input()), { code: 'CONTROL_BUSINESS_PARTICIPANT_UNKNOWN' });
  assert.equal(f.calls.length, 0); assert.equal(f.journal.pending().length, 0);
  await f.commands.executeCommand(input('adopt'));
  assert.deepEqual(f.journal.lookup({ operationId: attemptId, commandId: 'original-role-operation:adopt' }).spec.participant,
    { artifactDigest: candidate.artifactDigest, startIdentity: candidate.startIdentity });
});

test('unknown normal quiesce marker is held and cannot produce a repeated business invocation', async t => {
  const f = await fixture(t); let mutationCalls = 0;
  f.handlers.coordinatorHandoff = (_id, body) => {
    if (body.action === 'status') return { commitKnown: true, stage: 'quiesced', applied: false, resumeAction: 'release' };
    mutationCalls++; throw Object.assign(new Error('ACK lost'), { code: 'ACK_UNKNOWN' });
  };
  await assert.rejects(f.commands.executeCommand(input('quiesce')), { code: 'ACK_UNKNOWN' });
  f.restart();
  await assert.rejects(f.commands.executeCommand(input('quiesce')), { code: 'CONTROL_COMMAND_RESULT_UNKNOWN' });
  assert.equal(mutationCalls, 1);
  assert.equal(f.journal.pending()[0].state, 'unknown');
  assert.equal(f.journal.lookup({ operationId: attemptId, commandId: 'original-role-operation:quiesce' }).spec.deadline, 6000);
});

test('recovery only records scoped original action completions, and quiesce remains HOLD after prepare alone', async t => {
  const f = await fixture(t);
  f.handlers.coordinatorHandoff = () => { throw Object.assign(new Error('ACK lost'), { code: 'ACK_UNKNOWN' }); };
  await assert.rejects(f.commands.executeCommand(input('prepare')), { code: 'ACK_UNKNOWN' });
  await assert.rejects(f.commands.executeCommand(input('quiesce')), { code: 'ACK_UNKNOWN' });
  const recovery = f.recovery();
  f.statuses.semantic = request => originalReceipt(request);
  const result = await f.commands.reconcilePending(recovery);
  assert.equal(result.known, false); assert.equal(result.pendingCommands, 1);
  assert.equal(result.closedUnknownCommands.length, 1);
  assert.equal(result.closedUnknownCommands[0].action, 'quiesce');
  assert.equal(result.closedUnknownCommands[0].stage, 'prepared');
  assert.equal(result.closedUnknownCommands[0].actualRunning, false);
  assert.equal(result.closedUnknownCommands[0].admissionClosed, true);
  assert.equal(f.journal.lookup({ operationId: attemptId, commandId: 'original-role-operation:prepare' }).state, 'applied');
  assert.equal(f.journal.lookup({ operationId: attemptId, commandId: 'original-role-operation:quiesce' }).state, 'unknown');
  assert.equal(f.calls.length, 2, 'reconciliation only reads original IDs');
  f.statuses.semantic = request => originalReceipt(request, { stage: 'adopted', state: 'applied', actionsCompleted: ['prepare', 'quiesce', 'release', 'adopt'], result: { qualified: true } });
  assert.equal((await f.commands.reconcilePending(recovery)).known, true);
  assert.equal(f.calls.length, 2);
});

test('migration reconciliation uses the exact original request digest; absent special global receipts remain unknown', async t => {
  const f = await fixture(t);
  f.handlers.migration = () => { throw Object.assign(new Error('ACK lost'), { code: 'ACK_UNKNOWN' }); };
  const request = input('batch', 'migration', { checkpoint: { cursor: 37 } });
  await assert.rejects(f.commands.executeCommand(request), { code: 'ACK_UNKNOWN' });
  const recovery = f.recovery();
  f.statuses.semantic = value => {
    assert.equal(value.expectedRequestDigest, digest({ attemptId, action: 'batch', planDigest, checkpoint: { cursor: 37 } }));
    return originalReceipt(value, { state: 'unknown', stage: 'absent' });
  };
  assert.equal((await f.commands.reconcilePending(recovery)).known, false);
  f.statuses.semantic = value => originalReceipt(value, { state: 'applied', requestDigest: value.expectedRequestDigest, result: { commitKnown: true, checkpoint: { cursor: 38 } } });
  assert.equal((await f.commands.reconcilePending(recovery)).known, true);
  assert.equal(f.calls.length, 1);
});

test('wrong original receipt scope cannot close a pending command or mint a new command', async t => {
  const f = await fixture(t);
  f.handlers.coordinatorHandoff = () => { throw Object.assign(new Error('ACK lost'), { code: 'ACK_UNKNOWN' }); };
  await assert.rejects(f.commands.executeCommand(input()), { code: 'ACK_UNKNOWN' });
  const recovery = f.recovery();
  f.statuses.semantic = value => originalReceipt(value, { operationId: 'substitute-operation' });
  await assert.rejects(f.commands.reconcilePending(recovery), { code: 'CONTROL_BUSINESS_ORIGINAL_RECEIPT_SCOPE_MISMATCH' });
  assert.equal(f.journal.pending().length, 1); assert.equal(f.calls.length, 1);
});

test('running, foreign-process and open-admission participant receipts remain HOLD before any semantic marker is read', async t => {
  const f = await fixture(t);
  f.handlers.coordinatorHandoff = () => { throw Object.assign(new Error('ACK lost'), { code: 'ACK_UNKNOWN' }); };
  await assert.rejects(f.commands.executeCommand(input()), { code: 'ACK_UNKNOWN' });
  const recovery = f.recovery(), pending = f.journal.pending()[0], row = f.journal.lookup(pending);
  const fact = { state: 'settled', outcome: 'rejected', instanceId, attemptId, commandId: pending.commandId, specDigest: row.specDigest, participant: row.spec.participant, startedAt: 1000, settledAt: 1100, code: 'BUSINESS_ACTION_REJECTED' };
  fact.receiptDigest = digest(fact);
  const base = { instanceId, attemptId, commandId: pending.commandId, specDigest: row.specDigest, participant: row.spec.participant,
    state: 'settled', actualRunning: false, admissionClosed: true, receipt: fact };
  for (const changed of [{ state: 'running', actualRunning: true }, { actualRunning: null }, { admissionClosed: false }, { state: 'not-started', admissionClosed: false }, { state: 'unknown' }]) {
    f.statuses.participant = () => ({ ...base, ...changed });
    assert.equal((await f.commands.reconcilePending(recovery)).known, false);
  }
  assert.equal(f.lookups.filter(value => value.kind === 'semantic').length, 0);
  assert.equal(f.calls.length, 1);
});

test('new recovery actions reconcile the fixed API command/spec under a new epoch and never resend an unknown effect', async t => {
  const f = await fixture(t); let mutationCalls = 0;
  let recovery = f.recovery({ restoring: true });
  f.handlers.coordinatorRecovery = () => { mutationCalls++; throw Object.assign(new Error('ACK lost'), { code: 'ACK_UNKNOWN' }); };
  const request = () => ({ method: 'coordinatorRecovery', args: [attemptId, { fence: recovery.intent.epoch, recoveryPlanDigest: recovery.intent.planDigest }] });
  await assert.rejects(f.commands.executeCommand(request()), { code: 'ACK_UNKNOWN' });
  const commandId = `${recoveryId}:coordinator-recovery`, saved = f.journal.lookup({ operationId: recoveryId, commandId });
  f.advance(122000); recovery = f.recovery(); f.restart();
  f.handlers.recoveryActions = () => [{ commandId, epoch: 8, specDigest: digest({ attemptId, action: 'coordinator-recovery', input: { recoveryPlanDigest: recovery.intent.planDigest } }), state: 'unknown', result: null }];
  await assert.rejects(f.commands.executeCommand(request()), { code: 'CONTROL_COMMAND_RESULT_UNKNOWN' });
  assert.equal(mutationCalls, 1);
  f.handlers.recoveryActions = () => [{ commandId, epoch: 8, specDigest: digest({ attemptId, action: 'coordinator-recovery', input: { recoveryPlanDigest: recovery.intent.planDigest } }), state: 'completed', result: { commitKnown: true, qualified: true } }];
  assert.deepEqual(await f.commands.executeCommand(request()), { commitKnown: true, qualified: true });
  assert.equal(mutationCalls, 1); assert.equal(f.journal.lookup({ operationId: recoveryId, commandId }).spec.deadline, saved.spec.deadline);
  assert.equal(f.journal.lookup({ operationId: recoveryId, commandId }).spec.originalFence, 8);
});

test('async participant lookup and mutable caller args cannot replace the frozen effect', async t => {
  const f = await fixture(t), pending = deferred(), entered = deferred();
  f.handlers.identity = () => { entered.resolve(); return pending.promise; };
  const request = input(), running = f.commands.executeCommand(request);
  await entered.promise;
  request.args[1].candidate.startIdentity = 'caller-replaced-identity';
  request.args[1].planDigest = 'sha256:' + 'd'.repeat(64);
  pending.resolve(identity);
  await running;
  assert.equal(f.calls[0].body.planDigest, planDigest);
  assert.equal(f.calls[0].body.candidate.startIdentity, 'candidate-incarnation');
});

test('a completed participant fact restores the exact lost ACK after deadline without another effect or a marker guess', async t => {
  const f = await fixture(t), receipt = { commitKnown: true, stage: 'quiesced', quiescedAt: 1030 };
  f.handlers.coordinatorHandoff = () => { throw Object.assign(new Error('lost response'), { code: 'ACK_UNKNOWN' }); };
  const request = input('quiesce');
  await assert.rejects(f.commands.executeCommand(request), { code: 'ACK_UNKNOWN' });
  const row = f.journal.lookup({ operationId: attemptId, commandId: 'original-role-operation:quiesce' });
  const fact = { state: 'settled', outcome: 'resolved', instanceId, attemptId, commandId: row.commandId,
    specDigest: row.specDigest, participant: row.spec.participant, startedAt: 1000, settledAt: 1100,
    result: receipt, resultDigest: digest(receipt) };
  fact.receiptDigest = digest(fact);
  f.statuses.participant = () => ({ instanceId, attemptId, commandId: row.commandId, specDigest: row.specDigest,
    participant: row.spec.participant, state: 'settled', actualRunning: false, admissionClosed: true, receipt: fact });
  f.advance(7000); f.restart();
  assert.deepEqual(await f.commands.executeCommand(request), receipt);
  assert.equal(f.calls.length, 1);
  assert.equal(f.journal.lookup(row).spec.deadline, 6000);
});

test('corrupt or substituted participant facts cannot close the original command', async t => {
  const f = await fixture(t);
  f.handlers.coordinatorHandoff = () => { throw Object.assign(new Error('lost response'), { code: 'ACK_UNKNOWN' }); };
  await assert.rejects(f.commands.executeCommand(input()), { code: 'ACK_UNKNOWN' });
  const recovery = f.recovery(), row = f.journal.lookup({ operationId: attemptId, commandId: 'original-role-operation:prepare' });
  const result = { commitKnown: true }, fact = { state: 'settled', outcome: 'resolved', instanceId, attemptId,
    commandId: row.commandId, specDigest: row.specDigest, participant: row.spec.participant, startedAt: 1000, settledAt: 1100,
    result, resultDigest: digest(result) };
  fact.receiptDigest = digest(fact);
  const base = { instanceId, attemptId, commandId: row.commandId, specDigest: row.specDigest, participant: row.spec.participant,
    state: 'settled', actualRunning: false, admissionClosed: true, receipt: fact };
  f.statuses.participant = () => ({ ...base, receipt: { ...fact, result: { commitKnown: true, tampered: true } } });
  await assert.rejects(f.commands.reconcilePending(recovery), { code: 'CONTROL_BUSINESS_PARTICIPANT_FACT_INVALID' });
  f.statuses.participant = () => ({ ...base, specDigest: 'sha256:' + 'f'.repeat(64) });
  await assert.rejects(f.commands.reconcilePending(recovery), { code: 'CONTROL_BUSINESS_PARTICIPANT_RECEIPT_SCOPE_MISMATCH' });
  assert.equal(f.journal.lookup(row).state, 'unknown'); assert.equal(f.calls.length, 1);
});

test('participant lookup is single flight and a superseded scope cannot dispatch after its async identity read', async t => {
  const f = await fixture(t), pending = deferred(), entered = deferred();
  f.handlers.identity = () => { entered.resolve(); return pending.promise; };
  const request = input(), running = f.commands.executeCommand(request);
  await entered.promise;
  await assert.rejects(f.commands.executeCommand(request), { code: 'CONTROL_COMMAND_IN_FLIGHT' });
  f.recovery();
  pending.resolve(identity);
  await assert.rejects(running, { code: 'CONTROL_AUTHORITY_EXPIRED_OR_SUPERSEDED' });
  assert.equal(f.calls.length, 0); assert.equal(f.journal.pending().length, 0);
});

test('closed unknown stabilization candidates never expand to Owner, migration, release, adopt or later handoff markers', async t => {
  for (const [method, action, stage] of [
    ['ownerCandidate', 'prepare', 'prepared'], ['migration', 'prepare', 'prepared'],
    ['coordinatorHandoff', 'release', 'quiesced'], ['coordinatorHandoff', 'adopt', 'prepared'],
    ['coordinatorHandoff', 'quiesce', 'adopting'],
  ]) {
    const f = await fixture(t);
    f.handlers[method] = () => { throw Object.assign(new Error('ACK lost'), { code: 'ACK_UNKNOWN' }); };
    await assert.rejects(f.commands.executeCommand(input(action, method)), { code: 'ACK_UNKNOWN' });
    const recovery = f.recovery();
    f.statuses.semantic = value => originalReceipt(value, { stage, actionsCompleted: [], state: 'unknown' });
    const held = await f.commands.reconcilePending(recovery);
    assert.equal(held.known, false); assert.equal(held.pendingCommands, 1);
    assert.deepEqual(held.closedUnknownCommands, []);
    assert.equal(f.calls.length, 1);
  }
});
