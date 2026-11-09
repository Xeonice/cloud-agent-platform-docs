import { digest, invariant, DIGEST } from './trust.mjs';

export const COORDINATOR_PHASED_PROFILE = 'coordinator-phased-v1';

// This is an explicit signed preparation contract, not a replacement for the
// legacy cumulative deadline or the source's two-second writer handoff budget.
export function coordinatorPreparationBudget(policy) {
  if (policy?.coordinatorPreparationProfile === undefined) return null;
  invariant(policy.coordinatorPreparationProfile === COORDINATOR_PHASED_PROFILE,
    'COORDINATOR_PREPARATION_PROFILE_UNSUPPORTED');
  const budget = policy.candidateStartupMs === undefined ? 120000 : policy.candidateStartupMs;
  invariant(Number.isSafeInteger(budget) && budget > 0 && budget <= 120000,
    'COORDINATOR_PREPARATION_BUDGET_INVALID');
  return budget;
}

function safeScope(scope) {
  const { instanceId, attemptId, operationId, planDigest, targetDigest, fence } = scope;
  invariant([instanceId, attemptId, operationId].every(v => typeof v === 'string' &&
    /^[a-zA-Z0-9._:-]{1,200}$/.test(v)) && DIGEST.test(planDigest) &&
    DIGEST.test(targetDigest) && Number.isSafeInteger(fence) && fence > 0,
  'COORDINATOR_PREPARATION_SCOPE_INVALID');
  return { instanceId, attemptId, operationId, planDigest, targetDigest, fence };
}

const preparedStatus = status => status?.stage === 'prepared' &&
  status.commitKnown === true && status.applied === false &&
  status.resumeAction === 'quiesce' && status.unknown !== true &&
  status.definitelyNotApplied !== true;
const classification = status => preparedStatus(status) ? 'prepared' :
  status?.stage === 'absent' && status.definitelyNotApplied === true ? 'absent-not-proof' :
    ['quiesced', 'releasing', 'adopting', 'adopted'].includes(status?.stage) ? status.stage : 'unknown';
function assertStatusScope(value, scope) {
  invariant(value && typeof value === 'object' &&
    [value, value.attempt, value.snapshot, value.snapshot?.attempt].every(row =>
      row === undefined || row === null || typeof row === 'object' &&
      ['instanceId', 'attemptId', 'operationId', 'planDigest', 'fence'].every(key =>
        row[key] === undefined || row[key] === scope[key])),
  'COORDINATOR_PREPARATION_STATUS_SCOPE_CHANGED');
}
const reasonCode = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code)
  ? error.code : error?.name === 'TimeoutError' ? 'UPGRADE_RPC_TIMEOUT' : 'UPGRADE_RPC_UNKNOWN';
function preparationTiming(error) {
  const rpc = error?.rpcContext;
  if (!rpc || rpc.action !== 'prepare') return null;
  const metric = name => rpc[name] === null ? null :
    typeof rpc[name] === 'number' && Number.isFinite(rpc[name]) ? rpc[name] : null;
  return { path: '/internal/upgrades/:attemptId/coordinator-handoff', method: 'POST', action: 'prepare',
    traceId: typeof rpc.traceId === 'string' && /^[a-f0-9-]{36}$/i.test(rpc.traceId) ? rpc.traceId : null,
    startedAt: typeof rpc.startedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(rpc.startedAt) ? rpc.startedAt : null,
    ...Object.fromEntries(['timeoutMs', 'elapsedMs', 'bindingMs', 'serializationMs', 'firstResponseMs', 'decodeMs'].map(key => [key, metric(key)])),
    requestDispatched: typeof error.preparationOutcome?.requestDispatched === 'boolean' ? error.preparationOutcome.requestDispatched : null,
    responseDecoded: typeof error.preparationOutcome?.responseDecoded === 'boolean' ? error.preparationOutcome.responseDecoded : null };
}

/** Runs only in the original Controller incarnation. checkpoint is the existing
 * step's fsynced journal, never a second operation ledger. No SDK is opened. */
export async function prepareCoordinatorPhased({ scope: inputScope, budgetMs, checkpoint,
  start, ready, baseline, assertFence, prepare, status, quiesce, release, adopt,
  clock = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const scope = safeScope(inputScope);
  invariant(typeof checkpoint === 'function' && Number.isSafeInteger(budgetMs) &&
    budgetMs > 0 && budgetMs <= 120000, 'COORDINATOR_PREPARATION_JOURNAL_REQUIRED');
  const startupBegan = clock();
  let record = { schemaVersion: 1, profile: COORDINATOR_PHASED_PROFILE, ...scope,
    state: 'starting', startupStartedAt: startupBegan, startupDeadline: startupBegan + budgetMs,
    prepareStartedAt: null, prepareDeadline: null, prepareSent: false,
    candidate: null, candidateDigest: null, statusClassification: null };
  const save = async patch => {
    record = { ...record, ...patch };
    await checkpoint(structuredClone(record));
  };
  const remaining = deadline => {
    const left = deadline - clock();
    invariant(Number.isFinite(left) && left > 0, 'COORDINATOR_PREPARATION_EXPIRED');
    return Math.min(120000, Math.ceil(left));
  };
  const fenced = async deadline => { remaining(deadline); await assertFence(); remaining(deadline); };
  const held = async (error, state = 'prepare-unknown') => {
    await save({ state, lastFailureCode: reasonCode(error), heldAt: clock() });
    throw Object.assign(new Error('Coordinator preparation requires original-operation inspection'), {
      code: 'COORDINATOR_PREPARATION_HELD', suppressRecovery: true, cause: error,
      faultEvidence: { coordinatorPreparation: { scopeDigest: digest(scope), profile: record.profile,
        state: record.state, startupStartedAt: record.startupStartedAt,
        startupDeadline: record.startupDeadline, prepareStartedAt: record.prepareStartedAt,
        prepareDeadline: record.prepareDeadline, prepareSent: record.prepareSent,
        statusClassification: record.statusClassification, lastFailureCode: record.lastFailureCode,
        prepareRpc: record.prepareRpc ?? null } },
    });
  };
  const originalBody = action => ({ fence: scope.fence, operationId: scope.operationId,
    planDigest: scope.planDigest, candidate: structuredClone(record.candidate), action });
  const read = async deadline => {
    await assertFence();
    remaining(deadline);
    // The local candidate is frozen. Old Source status checks operation/plan
    // and live authority, but cannot attest candidate equality. Quiesce still
    // performs that original server-side equality/identity check.
    invariant(digest(record.candidate) === record.candidateDigest,
      'COORDINATOR_PREPARATION_CANDIDATE_CHANGED');
    const observed = await status(originalBody('status'), { statusRead: { deadline } });
    remaining(deadline);
    assertStatusScope(observed, scope);
    await save({ statusClassification: classification(observed), statusObservedAt: clock() });
    return observed;
  };
  await save({}); // Before Supervisor start, including the crash-before-send gap.
  try {
    await fenced(record.startupDeadline);
    const candidate = structuredClone(await start(remaining(record.startupDeadline)));
    remaining(record.startupDeadline);
    await save({ candidate, candidateDigest: digest(candidate) });
    await ready(record.startupDeadline); remaining(record.startupDeadline);
    await baseline(record.startupDeadline); await fenced(record.startupDeadline);
  } catch (error) { return held(error, 'startup-held'); }

  const began = clock();
  await save({ state: 'preparing', prepareStartedAt: began, prepareDeadline: began + budgetMs });
  try {
    await fenced(record.prepareDeadline);
    // Conservatively means "may have been sent". A crash between this fsync
    // and fetch never permits another prepare, even if status says absent.
    await save({ prepareSent: true, prepareSentAt: clock() });
    await fenced(record.prepareDeadline);
    let receipt;
    try {
      receipt = await prepare(originalBody('prepare'), { timeoutMs: remaining(record.prepareDeadline) });
      remaining(record.prepareDeadline);
      assertStatusScope(receipt, scope);
      invariant(receipt?.commitKnown === true && receipt.stage === 'prepared' &&
        receipt.unknown !== true && receipt.definitelyNotApplied !== true && receipt.applied !== true,
        'COORDINATOR_PREPARATION_ACK_INVALID');
      await save({ state: 'prepared-known', statusClassification: 'prepared', prepareAcknowledgedAt: clock() });
    } catch (error) {
      await save({ state: 'prepare-unknown', lastFailureCode: reasonCode(error), prepareRpc: preparationTiming(error) });
      // Completed hard rejections and lost authority must stop immediately.
      if (Number.isInteger(error?.status) || /FENCE|SCOPE|IDENTITY|INTENT|CANDIDATE|PLAN|ACK_INVALID/.test(reasonCode(error)))
        return held(error);
      if (clock() >= record.prepareDeadline) {
        // One bounded classification read after expiry grants no mutation.
        try { await read(clock() + 5000); } catch { /* retain unknown */ }
        return held(error, 'expired-held');
      }
      while (true) {
        const observed = await read(record.prepareDeadline);
        if (preparedStatus(observed)) {
          await save({ state: 'prepared-known', prepareReconciledAt: clock() });
          break;
        }
        invariant(classification(observed) === 'absent-not-proof',
          'COORDINATOR_PREPARATION_STATUS_UNKNOWN');
        await pause(Math.min(100, remaining(record.prepareDeadline)));
      }
    }
    await fenced(record.prepareDeadline);
    await save({ state: 'quiesce-sent', quiesceSentAt: clock() });
    await fenced(record.prepareDeadline);
    receipt = await quiesce(originalBody('quiesce'), record.prepareDeadline);
    invariant(receipt?.commitKnown === true, 'ROLE_TRANSITION_COMMIT_UNKNOWN');
    // No disk fsync or preparation-budget reset inside the source's existing
    // critical window. Its original release/adopt path enforces the hard SLO.
    await assertFence(); receipt = await release(originalBody('release'));
    invariant(receipt?.commitKnown === true, 'ROLE_TRANSITION_COMMIT_UNKNOWN');
    await assertFence(); receipt = await adopt(originalBody('adopt'));
    invariant(receipt?.commitKnown === true, 'ROLE_TRANSITION_COMMIT_UNKNOWN');
    await save({ state: 'adopted-known', adoptedAt: clock() });
    return receipt;
  } catch (error) {
    if (error?.code === 'COORDINATOR_PREPARATION_HELD') throw error;
    return held(error, clock() >= record.prepareDeadline ? 'expired-held' : 'prepare-unknown');
  }
}

/** A restart has a new fence. It may classify the original operation using
 * current read authority, but cannot resume old commands or refresh clocks. */
export async function inspectHeldCoordinatorPreparation({ scope: inputScope, local,
  checkpoint, status, assertFence, clock = Date.now }) {
  const scope = safeScope(inputScope), record = local?.preparation;
  const immutable = ['instanceId', 'attemptId', 'operationId', 'planDigest', 'targetDigest'];
  invariant(record?.profile === COORDINATOR_PHASED_PROFILE && record.schemaVersion === 1 &&
    immutable.every(key => record[key] === scope[key]) && Number.isSafeInteger(record.fence) &&
    record.fence > 0 && scope.fence >= record.fence &&
    Number.isSafeInteger(record.startupStartedAt) && Number.isSafeInteger(record.startupDeadline) &&
    record.startupDeadline > record.startupStartedAt && record.startupDeadline - record.startupStartedAt <= 120000 &&
    (record.candidate === null || digest(record.candidate) === record.candidateDigest),
  'COORDINATOR_PREPARATION_HISTORY_REQUIRED');
  let observed = 'not-sent-or-unknown';
  if (record.prepareSent === true) {
    invariant(record.candidate && Number.isSafeInteger(record.prepareStartedAt) &&
      Number.isSafeInteger(record.prepareDeadline) && record.prepareDeadline > record.prepareStartedAt &&
      record.prepareDeadline - record.prepareStartedAt <= 120000,
    'COORDINATOR_PREPARATION_HISTORY_REQUIRED');
    await assertFence();
    try {
      const deadline = clock() + 5000;
      const result = await status({ fence: scope.fence, operationId: scope.operationId,
        planDigest: scope.planDigest, candidate: structuredClone(record.candidate), action: 'status' },
      { statusRead: { deadline } });
      assertStatusScope(result, scope);
      observed = classification(result);
    } catch { observed = 'unknown'; }
  }
  await checkpoint({ ...structuredClone(record), state: 'restart-held',
    statusClassification: observed, statusObservedAt: clock(), inspectionFence: scope.fence });
  throw Object.assign(new Error('Restart cannot resume an uncertain Coordinator preparation'), {
    code: 'COORDINATOR_PREPARATION_HELD', suppressRecovery: true,
    faultEvidence: { coordinatorPreparation: { scopeDigest: digest(scope), originalFence: record.fence,
      profile: record.profile, state: 'restart-held', prepareSent: record.prepareSent,
      statusClassification: observed, startupDeadline: record.startupDeadline,
      prepareDeadline: record.prepareDeadline } },
  });
}
