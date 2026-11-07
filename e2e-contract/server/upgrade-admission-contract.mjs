import { digest } from '../../deploy/upgrade/trust.mjs';

// These assertions describe the public rolling API, not a replacement executor.
// In particular, an operation response is never converted into an invented
// attempt. N01 exercises one direct target; signed multi-stage chains need their
// own continuity fixture rather than silently being counted as one attempt.
function requireFact(value, code) {
  if (!value) throw Object.assign(new Error(code), { code });
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const attemptStates = new Set(['accepted', 'downloading', 'package-verified', 'migrating', 'prepared', 'candidate-ready', 'routing-switched', 'observing', 'api-activated', 'activation-confirmed', 'deferred', 'candidate-rejected', 'failed', 'reverted']);

export function upgradePrefersAsync(headers = {}) {
  const values = Object.entries(headers).filter(([name]) => name.toLowerCase() === 'prefer');
  return values.some(([, value]) => String(value).split(',').some(token => token.trim().toLowerCase() === 'respond-async'));
}

function operationFacts(value, admission) {
  const { command, instanceId } = admission;
  requireFact(object(value) && value.instanceId === instanceId && uuid(value.operationId) &&
    value.requestId === command.requestId && value.finalTargetReleaseId === command.targetReleaseId &&
    value.finalTargetDigest === command.targetDigest && !Object.hasOwn(value, 'attemptId') &&
    !Object.hasOwn(value, 'targetDigest'), 'N01_OPERATION_TARGET_BINDING');
  requireFact(Array.isArray(value.stages) && value.stages.length === 1 && value.currentStageIndex === 0,
    'N01_REQUIRES_ONE_DIRECT_TARGET_STAGE');
  const stage = value.stages[0];
  requireFact(object(stage) && stage.releaseId === command.targetReleaseId &&
    stage.targetDigest === command.targetDigest && (stage.attemptId === null || uuid(stage.attemptId)) &&
    ['pending', 'running', 'confirmed', 'failed', 'deferred'].includes(stage.state), 'N01_OPERATION_STAGE_BINDING');
  requireFact(integer(value.sequence) && time(value.acceptedAt) && time(value.observedAt) &&
    ['accepted', 'preparing', 'running', 'completed', 'failed', 'deferred'].includes(value.state) &&
    value.percent === (value.state === 'completed' ? 100 : null), 'N01_OPERATION_PROGRESS_CONTRACT');
  requireFact(value.state !== 'completed' || (stage.state === 'confirmed' && uuid(stage.attemptId)),
    'N01_OPERATION_COMPLETION_UNCONFIRMED');
  return value;
}

function attemptFacts(value, admission) {
  requireFact(object(value) && value.instanceId === admission.instanceId && uuid(value.attemptId) &&
    uuid(value.requestId) && value.targetReleaseId === admission.command.targetReleaseId &&
    value.targetDigest === admission.command.targetDigest && !Object.hasOwn(value, 'operationId'),
  'N01_TECHNICAL_ATTEMPT_TARGET_BINDING');
  // Pinned .15 UpgradeStore.attempt validates work <= each known total before
  // summing it; an unknown total resolves only to the proven completed work.
  requireFact(integer(value.generation) && integer(value.sequence) && attemptStates.has(value.state) &&
    typeof value.stage === 'string' && time(value.acceptedAt) && time(value.observedAt) &&
    Number.isFinite(value.completedWork) && value.completedWork >= 0 &&
    (value.totalWork === null || (Number.isFinite(value.totalWork) && value.totalWork >= value.completedWork)) &&
    (value.percent === null || (Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100)),
  'N01_TECHNICAL_ATTEMPT_PROGRESS_CONTRACT');
  return value;
}

export function readN01Admission(body, { command, instanceId, headers, targetReleaseId, targetDigest, activationGeneration }) {
  requireFact(object(command) && Object.keys(command).sort().join(',') ===
    'expectedActivationGeneration,requestId,targetDigest,targetReleaseId' && uuid(command.requestId) &&
    command.targetReleaseId === targetReleaseId && command.targetDigest === targetDigest &&
    command.expectedActivationGeneration === activationGeneration && integer(activationGeneration),
  'N01_USER_COMMAND_TARGET_BINDING');
  const preferAsync = upgradePrefersAsync(headers);
  const admission = { kind: preferAsync ? 'operation' : 'attempt', instanceId, command, preferAsync, response: body };
  if (preferAsync) {
    operationFacts(body, admission);
    requireFact(body.stages[0].attemptId === null && body.stages[0].state === 'pending', 'N01_FRESH_OPERATION_STAGE_ALREADY_ASSIGNED');
  } else {
    attemptFacts(body, admission);
    requireFact(body.requestId === command.requestId && body.completedWork === 0 &&
      (body.percent === null || body.percent < 100), 'N01_LEGACY_ACCEPTANCE_BINDING');
  }
  requireFact(body.state === 'accepted' && body.sequence === 0, 'N01_FRESH_ADMISSION_REQUIRED');
  return admission;
}

export function assertN01Lookup(admission, value) {
  const original = admission.response;
  if (admission.kind === 'operation') {
    operationFacts(value, admission);
    requireFact(value.operationId === original.operationId && value.acceptedAt === original.acceptedAt &&
      value.sequence >= original.sequence, 'N01_ORIGINAL_OPERATION_CHANGED');
    if (original.stages[0].attemptId !== null)
      requireFact(value.stages[0].attemptId === original.stages[0].attemptId, 'N01_OPERATION_ATTEMPT_CHANGED');
  } else {
    attemptFacts(value, admission);
    requireFact(value.requestId === admission.command.requestId && value.attemptId === original.attemptId &&
      value.acceptedAt === original.acceptedAt && value.generation === original.generation &&
      value.planDigest === original.planDigest && value.sequence >= original.sequence, 'N01_ORIGINAL_ATTEMPT_CHANGED');
  }
  return value;
}

export function resolveN01TechnicalAttempt(admission, status, boundAttempt = null) {
  requireFact(object(status) && status.instanceId === admission.instanceId, 'N01_STATUS_INSTANCE_CHANGED');
  if (admission.kind === 'operation') {
    const operation = assertN01Lookup(admission, status.operation);
    requireFact(!['failed', 'deferred'].includes(operation.state), 'N01_OPERATION_TERMINATED');
    const stage = operation.stages[0];
    if (stage.attemptId === null) {
      requireFact(boundAttempt === null, 'N01_OPERATION_ATTEMPT_DISAPPEARED');
      return null;
    }
    if (status.attempt == null && boundAttempt === null) return null;
    attemptFacts(status.attempt, admission);
    requireFact(status.attempt.attemptId === stage.attemptId &&
      status.attempt.requestId !== admission.command.requestId, 'N01_OPERATION_TECHNICAL_MAPPING');
  } else {
    assertN01Lookup(admission, status.attempt);
    requireFact(status.operation == null, 'N01_UNEXPECTED_USER_OPERATION');
  }
  const attempt = status.attempt;
  if (boundAttempt !== null) {
    requireFact(attempt.attemptId === boundAttempt.attemptId && attempt.requestId === boundAttempt.requestId &&
      attempt.acceptedAt === boundAttempt.acceptedAt && attempt.planDigest === boundAttempt.planDigest &&
      attempt.generation === boundAttempt.generation, 'N01_BOUND_TECHNICAL_ATTEMPT_CHANGED');
  }
  return attempt;
}

export function assertN01Pending(raw, admission) {
  let value;
  try { value = JSON.parse(raw); } catch { /* Unknown storage is not an acknowledgement. */ }
  requireFact(object(value) && value.version === 1 && value.requestId === admission.command.requestId &&
    Object.keys(value).every(key => ['version', 'requestId', 'preferAsync'].includes(key)) &&
    (admission.preferAsync ? value.preferAsync === true : value.preferAsync === undefined || value.preferAsync === false),
  'N01_PENDING_ORIGINAL_PROTOCOL_CHANGED');
  return value;
}

// Only bounded, explicitly selected ledger columns are supplied by the harness.
// The technical request ID comes from the real frozen operation chain; it is
// never guessed from the user ID or copied into the observed HTTP response.
export function assertN01DurableAdmission(admission, technicalAttempt, intent, operationRow = null) {
  requireFact(object(intent) && intent.attempt_id === technicalAttempt.attemptId &&
    intent.actor_id === 'instance-administrator' && intent.request_id === technicalAttempt.requestId &&
    intent.target_release_id === admission.command.targetReleaseId && intent.target_digest === admission.command.targetDigest &&
    intent.accepted_at === Date.parse(technicalAttempt.acceptedAt), 'N01_TECHNICAL_LEDGER_BINDING');
  const plan = JSON.parse(intent.plan);
  requireFact(plan.sourceActivationGeneration === admission.command.expectedActivationGeneration &&
    plan.planDigest === technicalAttempt.planDigest,
    'N01_TECHNICAL_SOURCE_GENERATION_CHANGED');
  let technicalCommand = admission.command;
  if (admission.kind === 'operation') {
    requireFact(object(operationRow) && operationRow.operation_id === admission.response.operationId &&
      operationRow.actor_id === intent.actor_id && operationRow.request_digest === digest(admission.command) &&
      operationRow.created_at === Date.parse(admission.response.acceptedAt) &&
      digest(JSON.parse(operationRow.command)) === digest(admission.command), 'N01_USER_OPERATION_LEDGER_BINDING');
    const operation = assertN01Lookup(admission, JSON.parse(operationRow.operation));
    requireFact(operation.stages[0].attemptId === technicalAttempt.attemptId &&
      operationRow.chain_length === 1 && operationRow.technical_request_id === technicalAttempt.requestId &&
      operationRow.technical_target_digest === admission.command.targetDigest &&
      operationRow.technical_target_release_id === admission.command.targetReleaseId,
    'N01_FROZEN_CHAIN_TECHNICAL_BINDING');
    technicalCommand = { ...admission.command, requestId: operationRow.technical_request_id };
  } else {
    requireFact(operationRow === null && intent.request_id === admission.command.requestId,
      'N01_LEGACY_LEDGER_BINDING');
    if (plan.steps.some(step => step.totalWork === null))
      requireFact(admission.response.percent === null && admission.response.totalWork === null,
        'N01_LEGACY_UNKNOWN_WORK_FABRICATED');
    else requireFact(Number.isFinite(admission.response.percent) && admission.response.percent < 100 &&
      Number.isFinite(admission.response.totalWork), 'N01_LEGACY_KNOWN_WORK_MISSING');
  }
  requireFact(intent.request_digest === digest(technicalCommand), 'N01_TECHNICAL_COMMAND_DIGEST_CHANGED');
  return plan;
}

export function n01ObservedProgress(admission, status, boundAttempt) {
  const attempt = resolveN01TechnicalAttempt(admission, status, boundAttempt);
  requireFact(attempt !== null, 'N01_PROGRESS_ATTEMPT_MISSING');
  if (admission.kind === 'attempt') return { scope: 'technical-attempt', percent: attempt.percent, stage: attempt.stage };
  const stage = status.currentStageProgress;
  if (stage == null) return { scope: 'current-technical-stage', percent: null, stage: null };
  // Store.stageProgress finds plan.steps by row.stage and returns that stepId;
  // the public attempt.stage is the same row.stage, not the broader state enum.
  requireFact(object(stage) && stage.stage === attempt.stage &&
    Number.isFinite(stage.completedWork) && stage.completedWork >= 0 &&
    (stage.totalWork === null || (Number.isFinite(stage.totalWork) && stage.totalWork >= stage.completedWork)) &&
    (stage.percent === null || (Number.isFinite(stage.percent) && stage.percent >= 0 && stage.percent <= 100)),
  'N01_CURRENT_STAGE_PROGRESS_UNBOUND');
  return { scope: 'current-technical-stage', percent: stage.percent, stage: stage.stage };
}

export function n01UpgradeConfirmed(admission, status, boundAttempt) {
  const attempt = resolveN01TechnicalAttempt(admission, status, boundAttempt);
  const operationComplete = admission.kind === 'attempt' ||
    (status.operation.state === 'completed' && status.operation.percent === 100 && status.operation.stages[0].state === 'confirmed');
  return operationComplete && attempt?.state === 'activation-confirmed' && attempt.percent === 100 &&
    status.serviceState === 'confirmed' && status.confirmedServiceRelease?.releaseId === admission.command.targetReleaseId &&
    !(status.recovery?.triggeringAttemptId === attempt.attemptId && status.recovery.state !== 'recovery-confirmed');
}
