import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../deploy/upgrade/trust.mjs';
import {
  upgradePrefersAsync, readN01Admission, assertN01Lookup, resolveN01TechnicalAttempt,
  assertN01Pending, assertN01DurableAdmission, n01ObservedProgress, n01UpgradeConfirmed,
} from './upgrade-admission-contract.mjs';

// Public shapes from API 61ff5e9 UpgradeOperationSchema/UpgradeAttemptSchema,
// UpgradeOperationStore.accept + UpgradeService.advanceOperation, and Web17e's
// version-one pending format. These are contract fixtures, not a fake execution
// of the old API, SQLite migrations, Installer or a Native upgrade.
const instanceId = 'n01-admission-contract';
const userRequestId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
const technicalRequestId = '44444444-4444-4444-8444-444444444444';
const otherId = '55555555-5555-4555-8555-555555555555';
const targetDigest = 'sha256:' + 'a'.repeat(64), planDigest = 'sha256:' + 'b'.repeat(64);
const targetReleaseId = 'v0.3.16-n01-contract';
const acceptedAt = '2026-11-07T09:00:00.000Z', technicalAcceptedAt = '2026-11-07T09:00:01.000Z';
const command = { requestId: userRequestId, targetReleaseId, targetDigest, expectedActivationGeneration: 1 };
const input = { command, instanceId, targetReleaseId, targetDigest, activationGeneration: 1 };
const copy = value => structuredClone(value);
function operation() {
  return { instanceId, operationId, requestId: userRequestId, finalTargetReleaseId: targetReleaseId,
    finalTargetDigest: targetDigest, sequence: 0, state: 'accepted', acceptedAt, observedAt: acceptedAt,
    currentStageIndex: 0, stages: [{ releaseId: targetReleaseId, targetDigest, attemptId: null, state: 'pending' }],
    percent: null, reason: null, defaultImageUpdate: null };
}
function attempt(requestId = technicalRequestId) {
  return { instanceId, attemptId, requestId, targetReleaseId, targetDigest, generation: 2, sequence: 0,
    state: 'accepted', stage: 'accepted', percent: null, completedWork: 0, totalWork: null, planDigest,
    acceptedAt: technicalAcceptedAt, observedAt: technicalAcceptedAt, reason: null };
}
function acceptedOperation() {
  return readN01Admission(operation(), { ...input, headers: { Prefer: 'respond-async' } });
}
function statusFor(admission, technical = attempt()) {
  const op = admission.kind === 'operation' ? copy(admission.response) : null;
  if (op) {
    op.sequence = 2; op.state = 'running'; op.stages[0] = { ...op.stages[0], attemptId, state: 'running' };
  }
  return { instanceId, operation: op, attempt: technical,
    currentStageProgress: null, serviceState: 'confirmed', confirmedServiceRelease: null, recovery: null };
}
function ledgerFor(admission, technical, status) {
  const plan = { planDigest, sourceActivationGeneration: 1, steps: [{ stepId: 'download', totalWork: null }] };
  const technicalCommand = { ...command, requestId: technical.requestId };
  return {
    intent: { attempt_id: attemptId, actor_id: 'instance-administrator', request_id: technical.requestId,
      request_digest: digest(technicalCommand), target_release_id: targetReleaseId, target_digest: targetDigest,
      plan: JSON.stringify(plan), accepted_at: Date.parse(technical.acceptedAt) },
    operationRow: admission.kind === 'attempt' ? null : { operation_id: operationId,
      actor_id: 'instance-administrator', request_digest: digest(command), created_at: Date.parse(acceptedAt),
      command: JSON.stringify(command), operation: JSON.stringify(status.operation), chain_length: 1,
      technical_request_id: technicalRequestId, technical_target_digest: targetDigest,
      technical_target_release_id: targetReleaseId },
  };
}
const fails = (fn, code) => assert.throws(fn, error => error.code === code);

test('actual respond-async shape is retained as an operation, without inventing attempt fields', () => {
  const body = operation();
  const before = copy(body);
  const admission = readN01Admission(body, { ...input, headers: { pReFeR: 'wait=1, Respond-Async' } });
  assert.equal(admission.kind, 'operation');
  assert.equal(admission.response, body);
  assert.equal(body.targetDigest, undefined);
  assert.equal(body.attemptId, undefined);
  assert.equal(body.completedWork, undefined);
  assert.deepEqual(body, before);
  assert.equal(upgradePrefersAsync({ Prefer: 'wait=1' }), false);
});

test('a missing or wrong final target never falls back to the submitted target', () => {
  for (const change of [{ finalTargetDigest: undefined }, { finalTargetDigest: 'sha256:' + 'c'.repeat(64) },
    { finalTargetReleaseId: 'another-release' }, { requestId: otherId }, { instanceId: 'another-instance' }]) {
    fails(() => readN01Admission({ ...operation(), ...change }, { ...input, headers: { Prefer: 'respond-async' } }),
      'N01_OPERATION_TARGET_BINDING');
  }
  fails(() => readN01Admission(operation(), { ...input, targetDigest: 'sha256:' + 'd'.repeat(64),
    headers: { Prefer: 'respond-async' } }), 'N01_USER_COMMAND_TARGET_BINDING');
});

test('protocol negotiation is preserved; an attempt response cannot stand in for an async operation', () => {
  fails(() => readN01Admission(attempt(userRequestId), { ...input, headers: { Prefer: 'respond-async' } }),
    'N01_OPERATION_TARGET_BINDING');
  fails(() => readN01Admission(operation(), input), 'N01_TECHNICAL_ATTEMPT_TARGET_BINDING');
  fails(() => readN01Admission({ ...operation(), targetDigest }, { ...input, headers: { Prefer: 'respond-async' } }),
    'N01_OPERATION_TARGET_BINDING');
});

test('N01 rejects a multi-stage chain instead of silently counting it as one technical attempt', () => {
  const body = operation(); body.stages.push(copy(body.stages[0]));
  fails(() => readN01Admission(body, { ...input, headers: { Prefer: 'respond-async' } }),
    'N01_REQUIRES_ONE_DIRECT_TARGET_STAGE');
});

test('unknown ACK retains only the original user ID and async preference across reload', () => {
  const admission = acceptedOperation();
  const raw = JSON.stringify({ version: 1, requestId: userRequestId, preferAsync: true });
  assert.equal(assertN01Pending(raw, admission).requestId, userRequestId);
  for (const value of [{ version: 1, requestId: technicalRequestId, preferAsync: true },
    { version: 1, requestId: userRequestId }, { version: 1, requestId: userRequestId, preferAsync: false },
    { version: 1, requestId: userRequestId, preferAsync: true, targetDigest }])
    fails(() => assertN01Pending(JSON.stringify(value), admission), 'N01_PENDING_ORIGINAL_PROTOCOL_CHANGED');
});

test('readonly original-ID lookup remains an operation; technical fallback is not accepted', () => {
  const admission = acceptedOperation(), status = statusFor(admission);
  assert.equal(assertN01Lookup(admission, status.operation), status.operation);
  fails(() => assertN01Lookup(admission, status.attempt), 'N01_OPERATION_TARGET_BINDING');
  fails(() => assertN01Lookup(admission, { ...status.operation, operationId: otherId }), 'N01_ORIGINAL_OPERATION_CHANGED');
});

test('pending operation does not invent a technical attempt before real stage assignment', () => {
  const admission = acceptedOperation();
  assert.equal(resolveN01TechnicalAttempt(admission, { instanceId, operation: operation(), attempt: null }), null);
  const status = statusFor(admission);
  assert.equal(resolveN01TechnicalAttempt(admission, status), status.attempt);
  assert.notEqual(status.operation.requestId, status.attempt.requestId);
  assert.equal(status.operation.stages[0].attemptId, status.attempt.attemptId);
});

test('readonly stage mapping refuses another attempt, user-ID substitution, lost assignment and target mutation', () => {
  const admission = acceptedOperation(), status = statusFor(admission), bound = status.attempt;
  fails(() => resolveN01TechnicalAttempt(admission, { ...status, attempt: { ...bound, attemptId: otherId } }),
    'N01_OPERATION_TECHNICAL_MAPPING');
  fails(() => resolveN01TechnicalAttempt(admission, { ...status, attempt: { ...bound, requestId: userRequestId } }),
    'N01_OPERATION_TECHNICAL_MAPPING');
  fails(() => resolveN01TechnicalAttempt(admission, { instanceId, operation: operation(), attempt: null }, bound),
    'N01_OPERATION_ATTEMPT_DISAPPEARED');
  fails(() => resolveN01TechnicalAttempt(admission, { ...status, attempt: { ...bound, requestId: otherId } }, bound),
    'N01_BOUND_TECHNICAL_ATTEMPT_CHANGED');
  const changed = copy(status); changed.operation.stages[0].targetDigest = 'sha256:' + 'c'.repeat(64);
  fails(() => resolveN01TechnicalAttempt(admission, changed), 'N01_OPERATION_STAGE_BINDING');
});

test('durable original operation and derived technical command are checked independently', () => {
  const admission = acceptedOperation(), status = statusFor(admission), technical = status.attempt;
  const { intent, operationRow } = ledgerFor(admission, technical, status);
  assert.notEqual(intent.request_id, command.requestId);
  assert.notEqual(intent.request_digest, operationRow.request_digest);
  assert.notEqual(intent.accepted_at, operationRow.created_at);
  assert.equal(assertN01DurableAdmission(admission, technical, intent, operationRow).sourceActivationGeneration, 1);
  fails(() => assertN01DurableAdmission(admission, technical, { ...intent, request_digest: digest(command) }, operationRow),
    'N01_TECHNICAL_COMMAND_DIGEST_CHANGED');
  fails(() => assertN01DurableAdmission(admission, technical, intent, { ...operationRow, technical_request_id: otherId }),
    'N01_FROZEN_CHAIN_TECHNICAL_BINDING');
});

test('ledger rejects actor, original command, chain target, timestamp, source and plan tampering', () => {
  const admission = acceptedOperation(), status = statusFor(admission), technical = status.attempt;
  const { intent, operationRow } = ledgerFor(admission, technical, status);
  for (const change of [{ actor_id: 'another-actor' }, { created_at: Date.parse(technicalAcceptedAt) },
    { command: JSON.stringify({ ...command, expectedActivationGeneration: 2 }) }, { request_digest: 'wrong-digest' }])
    fails(() => assertN01DurableAdmission(admission, technical, intent, { ...operationRow, ...change }),
      'N01_USER_OPERATION_LEDGER_BINDING');
  fails(() => assertN01DurableAdmission(admission, technical, { ...intent, actor_id: 'another-actor' }, operationRow),
    'N01_TECHNICAL_LEDGER_BINDING');
  fails(() => assertN01DurableAdmission(admission, technical, intent,
    { ...operationRow, technical_target_digest: 'sha256:' + 'c'.repeat(64) }), 'N01_FROZEN_CHAIN_TECHNICAL_BINDING');
  for (const change of [{ sourceActivationGeneration: 8 }, { planDigest: 'sha256:' + 'c'.repeat(64) }])
    fails(() => assertN01DurableAdmission(admission, technical,
      { ...intent, plan: JSON.stringify({ ...JSON.parse(intent.plan), ...change }) }, operationRow),
    'N01_TECHNICAL_SOURCE_GENERATION_CHANGED');
});

test('async technical progress may already have advanced when the original user ACK is reconciled', () => {
  const admission = acceptedOperation(), technical = { ...attempt(), state: 'downloading', stage: 'package-download',
    sequence: 7, completedWork: 50, totalWork: null, percent: null };
  const status = statusFor(admission, technical), { intent, operationRow } = ledgerFor(admission, technical, status);
  assert.equal(admission.response.state, 'accepted');
  assert.equal(resolveN01TechnicalAttempt(admission, status), technical);
  assert.equal(assertN01DurableAdmission(admission, technical, intent, operationRow).sourceActivationGeneration, 1);
  assert.equal(technical.completedWork, 50, 'no fictitious zero-work acceptance replaces the real observation');
});

test('async progress is the actual current technical stage while overall remains unknown', () => {
  const admission = acceptedOperation(), status = statusFor(admission);
  status.attempt = { ...status.attempt, stage: 'download', state: 'downloading', percent: null };
  status.currentStageProgress = { stage: 'download', completedWork: 50, totalWork: 100, percent: 50 };
  assert.deepEqual(n01ObservedProgress(admission, status, status.attempt),
    { scope: 'current-technical-stage', stage: 'download', percent: 50 });
  assert.equal(status.operation.percent, null);
  const changed = copy(status); changed.operation.percent = 50;
  fails(() => n01ObservedProgress(admission, changed, status.attempt), 'N01_OPERATION_PROGRESS_CONTRACT');
  status.currentStageProgress.stage = 'another-stage';
  fails(() => n01ObservedProgress(admission, status, status.attempt), 'N01_CURRENT_STAGE_PROGRESS_UNBOUND');
});

test('unknown current-stage work stays null, not an invented zero or operation percentage', () => {
  const admission = acceptedOperation(), status = statusFor(admission);
  assert.equal(n01ObservedProgress(admission, status, status.attempt).percent, null);
  status.currentStageProgress = { stage: 'accepted', completedWork: 0, totalWork: null, percent: null };
  assert.equal(n01ObservedProgress(admission, status, status.attempt).percent, null);
});

test('technical 100 is insufficient until the same user operation and physical release complete', () => {
  const admission = acceptedOperation(), status = statusFor(admission);
  status.attempt = { ...status.attempt, state: 'activation-confirmed', percent: 100 };
  status.confirmedServiceRelease = { releaseId: targetReleaseId };
  assert.equal(n01UpgradeConfirmed(admission, status, status.attempt), false);
  status.operation.state = 'completed'; status.operation.percent = 100; status.operation.stages[0].state = 'confirmed';
  assert.equal(n01UpgradeConfirmed(admission, status, status.attempt), true);
  status.recovery = { triggeringAttemptId: attemptId, state: 'recovering' };
  assert.equal(n01UpgradeConfirmed(admission, status, status.attempt), false);
  status.recovery = null; status.confirmedServiceRelease.releaseId = 'another-release';
  assert.equal(n01UpgradeConfirmed(admission, status, status.attempt), false);
});

test('failed or deferred original operation cannot become a successful technical mapping', () => {
  const admission = acceptedOperation();
  for (const state of ['failed', 'deferred']) {
    const status = statusFor(admission); status.operation.state = state;
    fails(() => resolveN01TechnicalAttempt(admission, status), 'N01_OPERATION_TERMINATED');
  }
});

test('legacy attempt acceptance, lookup, durable command, pending and completion remain exact', () => {
  const body = attempt(userRequestId), admission = readN01Admission(body, input);
  const status = statusFor(admission, body), { intent } = ledgerFor(admission, body, status);
  assert.equal(admission.kind, 'attempt');
  assert.equal(admission.response, body);
  assert.equal(assertN01Lookup(admission, body), body);
  assert.equal(resolveN01TechnicalAttempt(admission, status), body);
  assert.equal(assertN01DurableAdmission(admission, body, intent).sourceActivationGeneration, 1);
  for (const value of [{ version: 1, requestId: userRequestId }, { version: 1, requestId: userRequestId, preferAsync: false }])
    assert.equal(assertN01Pending(JSON.stringify(value), admission).requestId, userRequestId);
  assert.deepEqual(n01ObservedProgress(admission, status, body), { scope: 'technical-attempt', percent: null, stage: 'accepted' });
  status.attempt = { ...body, state: 'activation-confirmed', percent: 100 };
  status.confirmedServiceRelease = { releaseId: targetReleaseId };
  assert.equal(n01UpgradeConfirmed(admission, status, body), true);
  fails(() => readN01Admission({ ...body, targetDigest: undefined }, input), 'N01_TECHNICAL_ATTEMPT_TARGET_BINDING');
  fails(() => assertN01Lookup(admission, { ...body, requestId: technicalRequestId }), 'N01_ORIGINAL_ATTEMPT_CHANGED');
  fails(() => assertN01Pending(JSON.stringify({ version: 1, requestId: userRequestId, preferAsync: true }), admission),
    'N01_PENDING_ORIGINAL_PROTOCOL_CHANGED');
  fails(() => assertN01DurableAdmission(admission, body, intent, {}), 'N01_LEGACY_LEDGER_BINDING');
});

test('legacy known and unknown work denominators keep their original distinct contracts', () => {
  const body = { ...attempt(userRequestId), percent: 0, totalWork: 100 };
  const admission = readN01Admission(body, input), status = statusFor(admission, body);
  const { intent } = ledgerFor(admission, body, status);
  fails(() => assertN01DurableAdmission(admission, body, intent), 'N01_LEGACY_UNKNOWN_WORK_FABRICATED');
  intent.plan = JSON.stringify({ ...JSON.parse(intent.plan), steps: [{ stepId: 'download', totalWork: 100 }] });
  assert.equal(assertN01DurableAdmission(admission, body, intent).steps[0].totalWork, 100);
  const unknown = readN01Admission(attempt(userRequestId), input);
  fails(() => assertN01DurableAdmission(unknown, unknown.response, intent), 'N01_LEGACY_KNOWN_WORK_MISSING');
});
