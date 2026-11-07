import { invariant, canonical, digest, DIGEST } from './trust.mjs';
import { createControlCommandExecutor } from './control-command-executor.mjs';

const ID = /^[a-zA-Z0-9._:-]{1,200}$/;
const METHODS = {
  coordinatorHandoff: { kind: 'coordinator-handoff', actions: ['prepare', 'quiesce', 'release', 'adopt'], fields: ['operationId', 'action', 'planDigest', 'candidate'] },
  ownerCandidate: { kind: 'owner-candidate', actions: ['prepare', 'adopt'], fields: ['operationId', 'action', 'planDigest', 'candidate'] },
  migration: { kind: 'migration', actions: ['prepare', 'batch', 'repair'], fields: ['operationId', 'action', 'planDigest', 'checkpoint', 'policy'] },
  coordinatorRecovery: { kind: 'coordinator-recovery', fields: ['recoveryPlanDigest'] },
  coordinatorResume: { kind: 'coordinator-resume', fields: ['recoveryPlanDigest'] },
};

// This is a fixed private command boundary, never a general body/logging sink.
// Copy data descriptors only, bound traversal and omit optional undefined fields.
function copy(value, depth = 0, budget = { nodes: 0 }) {
  invariant(++budget.nodes <= 4096 && depth <= 16, 'CONTROL_BUSINESS_BODY_TOO_COMPLEX');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') { invariant(Number.isFinite(value), 'CONTROL_BUSINESS_BODY_INVALID'); return value; }
  invariant(value && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype), 'CONTROL_BUSINESS_BODY_INVALID');
  if (Array.isArray(value)) {
    invariant(value.length <= 4096 && Object.keys(value).length === value.length, 'CONTROL_BUSINESS_BODY_INVALID');
    return Array.from({ length: value.length }, (_, index) => {
      const field = Object.getOwnPropertyDescriptor(value, String(index));
      invariant(field && Object.hasOwn(field, 'value'), 'CONTROL_BUSINESS_BODY_ACCESSOR_FORBIDDEN');
      return copy(field.value, depth + 1, budget);
    });
  }
  const result = {};
  for (const key of Object.keys(value)) {
    invariant(!['__proto__', 'constructor', 'prototype'].includes(key), 'CONTROL_BUSINESS_BODY_INVALID');
    const field = Object.getOwnPropertyDescriptor(value, key);
    invariant(field && Object.hasOwn(field, 'value'), 'CONTROL_BUSINESS_BODY_ACCESSOR_FORBIDDEN');
    if (field.value !== undefined) result[key] = copy(field.value, depth + 1, budget);
  }
  return result;
}
const state = (value, result) => ({ state: value, ...(result === undefined ? {} : { result }) });
const stableId = value => value.length <= 200 ? value : 'business-' + digest(value).slice(7);
const recoveryMethod = method => ['coordinatorRecovery', 'coordinatorResume'].includes(method);

/** Durable fixed business effects. A lost acknowledgement is read by its original
 * operation/command ID; neither a new epoch nor a caller retry renews its deadline. */
export function createControlBusinessCommands({ journal, authority, recoveryStore, business, inspector,
  clock = Date.now, participantIdentity = () => null, withCommandContext = (_context, work) => work() }) {
  invariant(journal && authority && recoveryStore && business && inspector && typeof withCommandContext === 'function', 'CONTROL_BUSINESS_COMMAND_CONFIG_INVALID');
  const reservations = new Map();
  let reconciling = false;
  const executor = createControlCommandExecutor({ journal, clock, authorization: input => authorize(input.authorizationScope) });

  function authorize(scope) {
    const current = authority.assert(scope);
    if (scope.kind === 'recovery') {
      const intent = recoveryStore.read(scope.operationId);
      invariant(intent && intent.instanceId === current.instanceId && intent.epoch === scope.epoch && intent.deadline > clock() && !['blocked', 'recovered'].includes(intent.phase), 'CONTROL_BUSINESS_RECOVERY_SCOPE_INVALID');
    }
    return { operationId: current.operationId, epoch: current.epoch, executorId: current.holderId,
      expiresAt: current.leaseExpiresAt, kind: current.kind, ...(current.kind === 'recovery' ? { recoveryId: current.operationId } : {}) };
  }
  function acquiredScope(attemptId, fence, method) {
    const current = authority.observe();
    invariant(current.instanceId && current.mode === 'active' && ['upgrade', 'recovery'].includes(current.kind) && current.epoch === fence, 'CONTROL_BUSINESS_AUTHORITY_SCOPE_INVALID');
    const scope = { operationId: current.operationId, epoch: current.epoch, executorId: current.holderId, kind: current.kind };
    authorize(scope);
    if (current.kind === 'upgrade') invariant(current.operationId === attemptId && !recoveryMethod(method), 'CONTROL_BUSINESS_ATTEMPT_SCOPE_INVALID');
    else {
      const intent = recoveryStore.read(current.operationId);
      invariant(intent?.triggeringAttemptId === attemptId && intent.phase === 'restoring' && recoveryMethod(method), 'CONTROL_BUSINESS_RECOVERY_ACTION_REQUIRED');
    }
    return scope;
  }
  function descriptor(method, args) {
    const definition = METHODS[method];
    invariant(definition && typeof business[method] === 'function' && Array.isArray(args) && args.length >= 2 && args.length <= 3 && typeof args[0] === 'string' && ID.test(args[0]), 'CONTROL_BUSINESS_COMMAND_INVALID');
    const body = copy(args[1]);
    invariant(body && !Array.isArray(body) && Number.isSafeInteger(body.fence) && body.fence > 0 && Object.keys(body).every(key => key === 'fence' || definition.fields.includes(key)), 'CONTROL_BUSINESS_BODY_INVALID');
    if (definition.actions) invariant(definition.actions.includes(body.action) && typeof body.operationId === 'string' && ID.test(body.operationId) && DIGEST.test(body.planDigest), 'CONTROL_BUSINESS_INTENT_REQUIRED');
    else invariant(DIGEST.test(body.recoveryPlanDigest), 'CONTROL_BUSINESS_RECOVERY_PLAN_REQUIRED');
    const { fence, ...immutable } = body;
    const timeoutMs = args[2]?.timeoutMs ?? 5000;
    invariant(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000 && (args[2] === undefined || body.action === 'prepare') && (!args[2] || Object.keys(args[2]).every(key => key === 'timeoutMs')), 'CONTROL_BUSINESS_TIMEOUT_INVALID');
    const scope = acquiredScope(args[0], fence, method);
    if (scope.kind === 'recovery') invariant(recoveryStore.read(scope.operationId).plan?.planDigest === immutable.recoveryPlanDigest, 'CONTROL_BUSINESS_RECOVERY_PLAN_MISMATCH');
    const commandId = recoveryMethod(method) ? `${scope.operationId}:${definition.kind}` : stableId(`${immutable.operationId}:${immutable.action}`);
    return { method, attemptId: args[0], body: immutable, originalFence: fence, requestTimeoutMs: timeoutMs, startedAt: clock(),
      operationId: scope.operationId, commandId, stepId: `${definition.kind}:${body.action ?? 'restore'}`, scope };
  }
  function knownRoleLookup(receipt, spec, recovery = false) {
    const action = spec.body.action;
    if (recovery) {
      const expected = spec.body.candidate, actual = receipt.candidate;
      if (expected && actual) invariant(expected.artifactDigest === actual.artifactDigest && expected.startIdentity === actual.startIdentity, 'CONTROL_BUSINESS_CANDIDATE_RECEIPT_MISMATCH');
      if (receipt.state === 'definitely-not-applied' && receipt.stage === 'absent') return state('definitely-not-applied', receipt);
      // Quiesced/releasing/adopting are durable pre-effect markers. Only the
      // explicit completion list, not commitKnown or a stage name, closes them.
      if (Array.isArray(receipt.actionsCompleted) && receipt.actionsCompleted.includes(action))
        return state('applied', { commitKnown: true, stage: receipt.stage, ...(receipt.result ? { evidence: receipt.result } : {}) });
      return state('unknown', { code: 'ORIGINAL_BUSINESS_ACTION_UNCONFIRMED' });
    }
    if (receipt?.definitelyNotApplied === true && receipt.stage === 'absent') return state('definitely-not-applied', receipt);
    if (receipt?.commitKnown === true && (action === 'prepare' && receipt.stage === 'prepared' || receipt.applied === true && receipt.stage === 'adopted')) return state('applied', receipt);
    return state('unknown', { code: 'BUSINESS_ACTION_COMPLETION_UNKNOWN' });
  }
  function classify(receipt, spec, lookup, operationId) {
    if (!lookup) return receipt?.commitKnown === true ? state('applied', receipt) : state('unknown', { code: 'BUSINESS_COMMIT_UNKNOWN' });
    if (recoveryMethod(spec.method)) {
      invariant(Array.isArray(receipt), 'CONTROL_BUSINESS_RECOVERY_ACTIONS_INVALID');
      const action = METHODS[spec.method].kind, commandId = `${operationId}:${action}`;
      const record = receipt.find(value => value.commandId === commandId);
      if (!record) return state('unknown', { code: 'RECOVERY_ACTION_ABSENT_OR_UNKNOWN' });
      const expected = digest({ attemptId: spec.attemptId, action, input: spec.body });
      invariant(record.specDigest === expected, 'CONTROL_BUSINESS_RECOVERY_SPEC_MISMATCH');
      return record.state === 'completed' && record.result?.commitKnown === true ? state('applied', record.result) : state('unknown', { code: 'RECOVERY_ACTION_COMPLETION_UNKNOWN' });
    }
    if (!receipt?.participantKnown) return state('unknown', { code: 'BUSINESS_PARTICIPANT_OUTCOME_UNKNOWN' });
    if (receipt.originalResult?.commitKnown === true) return state('applied', receipt.originalResult);
    if (spec.method === 'migration') return state('unknown', { code: 'MIGRATION_ORIGINAL_COMMAND_STATUS_REQUIRED' });
    const outcome = knownRoleLookup(receipt.semantic, spec);
    return outcome.state === 'definitely-not-applied' && !receipt.admissionClosed ? state('unknown', { code: 'BUSINESS_PARTICIPANT_ADMISSION_OPEN' }) : outcome;
  }
  function invoke(spec, scope) {
    authorize(scope);
    invariant(spec.deadline > clock(), 'CONTROL_COMMAND_DEADLINE_EXPIRED');
    const options = spec.body.action === 'prepare' ? { timeoutMs: Math.min(120000, Math.max(1, Math.ceil(spec.deadline - clock()))) } : undefined;
    return business[spec.method](spec.attemptId, { ...structuredClone(spec.body), fence: scope.epoch }, options);
  }
  async function participantStatus(row) {
    invariant(typeof inspector.participantCommandStatus === 'function', 'CONTROL_BUSINESS_PARTICIPANT_LOOKUP_REQUIRED');
    const receipt = await inspector.participantCommandStatus({ attemptId: row.spec.attemptId, commandId: row.commandId });
    invariant(receipt?.instanceId === authority.observe().instanceId && receipt.attemptId === row.spec.attemptId && receipt.commandId === row.commandId && receipt.specDigest === row.specDigest && canonical(receipt.participant) === canonical(row.spec.participant), 'CONTROL_BUSINESS_PARTICIPANT_RECEIPT_SCOPE_MISMATCH');
    if (receipt.state === 'settled' && receipt.receipt) {
      const fact = receipt.receipt, { receiptDigest, ...facts } = fact;
      invariant(DIGEST.test(receiptDigest) && digest(facts) === receiptDigest && fact.state === 'settled' &&
        fact.instanceId === receipt.instanceId && fact.attemptId === receipt.attemptId && fact.commandId === receipt.commandId && fact.specDigest === receipt.specDigest && canonical(fact.participant) === canonical(receipt.participant) &&
        (!Object.hasOwn(fact, 'result') || DIGEST.test(fact.resultDigest) && digest(fact.result) === fact.resultDigest), 'CONTROL_BUSINESS_PARTICIPANT_FACT_INVALID');
    }
    const known = receipt.actualRunning === false && receipt.admissionClosed === true && (receipt.state === 'settled' && receipt.receipt !== null && typeof receipt.receipt === 'object' || receipt.state === 'not-started');
    return { known, admissionClosed: receipt.admissionClosed === true, fact: receipt.receipt, state: receipt.state,
      actualRunning: typeof receipt.actualRunning === 'boolean' ? receipt.actualRunning : null };
  }
  async function lookupNormal(spec, scope, row) {
    authorize(scope);
    if (recoveryMethod(spec.method)) return business.recoveryActions(spec.attemptId);
    const participant = await participantStatus(row);
    authorize(scope);
    if (!participant.known) return { participantKnown: false };
    if (participant.fact?.outcome === 'resolved' && participant.fact.result?.commitKnown === true) return { participantKnown: true, admissionClosed: participant.admissionClosed, originalResult: participant.fact.result };
    // A migration status action has a different request digest. It must not
    // impersonate the original prepare/batch/repair operation ID.
    if (spec.method === 'migration') return { participantKnown: true, semantic: { state: 'unknown' } };
    return { participantKnown: true, admissionClosed: participant.admissionClosed,
      semantic: await business[spec.method](spec.attemptId, { ...structuredClone(spec.body), fence: scope.epoch, action: 'status' }) };
  }
  async function executeCommand({ method, args }) {
    const input = descriptor(method, args), key = `${input.operationId}/${input.commandId}`;
    invariant(!reservations.has(key), 'CONTROL_COMMAND_IN_FLIGHT');
    reservations.set(key, true);
    try {
      const prior = journal.lookup(input);
      let spec;
      if (prior) {
        spec = prior.spec;
        invariant(spec.schemaVersion === 1 && spec.method === method && spec.attemptId === input.attemptId && canonical(spec.body) === canonical(input.body), 'CONTROL_COMMAND_SPEC_CONFLICT');
      } else {
        const intent = input.scope.kind === 'recovery' ? recoveryStore.read(input.scope.operationId) : null;
        const identity = intent ? null : method === 'coordinatorHandoff' && input.body.action === 'adopt' ? input.body.candidate : await participantIdentity({ method, args: [input.attemptId, { ...structuredClone(input.body), fence: input.scope.epoch }, ...(args[2] ? [structuredClone(args[2])] : [])] });
        invariant(intent || identity && typeof identity.startIdentity === 'string' && identity.startIdentity.length > 0 && identity.startIdentity.length <= 180 && DIGEST.test(identity.artifactDigest), 'CONTROL_BUSINESS_PARTICIPANT_UNKNOWN');
        authorize(input.scope);
        spec = { schemaVersion: 1, method, path: `/internal/upgrades/${input.attemptId}/${METHODS[method].kind}`, attemptId: input.attemptId,
          ...(identity ? { participant: { startIdentity: identity.startIdentity, artifactDigest: identity.artifactDigest } } : {}),
          body: input.body, originalFence: input.originalFence,
          deadline: Math.min(input.startedAt + input.requestTimeoutMs, intent?.deadline ?? Infinity) };
      }
      return await executor.execute({ operationId: input.operationId, commandId: input.commandId, stepId: input.stepId, spec,
        authorizationScope: input.scope,
        invoke: context => withCommandContext({ operationId: input.operationId, commandId: input.commandId, specDigest: context.specDigest, deadline: spec.deadline }, () => invoke(spec, input.scope)),
        inspect: context => lookupNormal(spec, input.scope, { ...context, spec }),
        classify: (receipt, context) => classify(receipt, spec, context.lookup, input.operationId) });
    } finally { reservations.delete(key); }
  }
  async function inspectOriginal(row, intent) {
    const spec = row.spec, kind = METHODS[spec.method]?.kind;
    invariant(spec.schemaVersion === 1 && spec.attemptId === intent.triggeringAttemptId && kind, 'CONTROL_BUSINESS_PENDING_SCOPE_INVALID');
    if (recoveryMethod(spec.method)) {
      invariant(row.operationId === intent.recoveryId, 'CONTROL_BUSINESS_PENDING_RECOVERY_MISMATCH');
      return classify(await business.recoveryActions(spec.attemptId), spec, true, row.operationId);
    }
    invariant(row.operationId === intent.triggeringAttemptId && typeof inspector.commandStatus === 'function', 'CONTROL_BUSINESS_ORIGINAL_LOOKUP_REQUIRED');
    const participant = await participantStatus(row);
    if (!participant.known || !participant.admissionClosed) return { ...state('unknown', { code: 'ORIGINAL_BUSINESS_PARTICIPANT_UNKNOWN' }), actualInFlight: participant.actualRunning };
    if (participant.fact?.outcome === 'resolved' && participant.fact.result?.commitKnown === true) return state('applied', participant.fact.result);
    const expectedRequestDigest = spec.method === 'migration' ? digest({ attemptId: spec.attemptId, action: spec.body.action, planDigest: spec.body.planDigest, checkpoint: spec.body.checkpoint ?? null }) : undefined;
    const receipt = await inspector.commandStatus({ attemptId: spec.attemptId, commandKind: kind,
      operationId: spec.body.operationId, ...(expectedRequestDigest ? { expectedRequestDigest } : {}) });
    invariant(receipt?.instanceId === intent.instanceId && receipt.attemptId === spec.attemptId && receipt.commandKind === kind && receipt.operationId === spec.body.operationId && receipt.planDigest === spec.body.planDigest, 'CONTROL_BUSINESS_ORIGINAL_RECEIPT_SCOPE_MISMATCH');
    if (spec.method === 'migration') return receipt.state === 'applied' && receipt.requestDigest === expectedRequestDigest && receipt.result?.commitKnown === true ? state('applied', receipt.result) : state('unknown', { code: 'MIGRATION_ORIGINAL_COMMAND_UNKNOWN' });
    const outcome = knownRoleLookup(receipt, spec, true);
    if (outcome.state === 'unknown' && participant.state === 'settled' && DIGEST.test(participant.fact?.receiptDigest) && spec.method === 'coordinatorHandoff' && ['prepare', 'quiesce'].includes(spec.body.action) && ['prepared', 'quiesced'].includes(receipt.stage)) {
      // This is permission to consider a separately authorized stabilization,
      // never an action-success receipt. Root must still prove the sole source
      // writer. Other roles, stages and unknown physical work remain HOLD.
      return { ...outcome, closedUnknown: { operationId: row.operationId, commandId: row.commandId,
        specDigest: row.specDigest, method: spec.method, action: spec.body.action, stage: receipt.stage,
        participant: structuredClone(spec.participant), participantState: participant.state,
        participantReceiptDigest: participant.fact?.receiptDigest ?? null, actualRunning: false, admissionClosed: true } };
    }
    return outcome;
  }
  async function reconcilePending({ intent, authorization }) {
    invariant(!reconciling && intent?.recoveryId && authorization?.kind === 'recovery' && authorization.operationId === intent.recoveryId && authorization.epoch === intent.epoch, 'CONTROL_BUSINESS_RECONCILIATION_SCOPE_INVALID');
    const scope = { operationId: intent.recoveryId, epoch: intent.epoch, executorId: authorization.executorId, kind: 'recovery' };
    authorize(scope);
    const persisted = recoveryStore.read(intent.recoveryId);
    invariant(persisted.instanceId === intent.instanceId && persisted.triggeringAttemptId === intent.triggeringAttemptId && persisted.authorizationDigest === intent.authorizationDigest, 'CONTROL_BUSINESS_RECONCILIATION_INTENT_CHANGED');
    reconciling = true;
    try {
      const closedUnknownCommands = [];
      const active = new Set(reservations.keys());
      let unknownLifetime = false;
      for (const pending of journal.pending()) {
        // Unrelated or unsupported pending work is a HOLD, never silently GC'd.
        if (![intent.triggeringAttemptId, intent.recoveryId].includes(pending.operationId)) continue;
        const row = journal.lookup(pending);
        if (!METHODS[row?.spec?.method]) continue;
        const outcome = await inspectOriginal(row, intent);
        authorize(scope);
        if (outcome.actualInFlight === true) active.add(`${row.operationId}/${row.commandId}`);
        if (outcome.actualInFlight === null) unknownLifetime = true;
        if (['applied', 'definitely-not-applied'].includes(outcome.state)) journal.record({ ...pending, state: outcome.state, result: outcome.result, authorization: authorize(scope) });
        else if (outcome.closedUnknown) closedUnknownCommands.push(outcome.closedUnknown);
      }
      const pendingCommands = journal.pending().length, inFlightMutations = unknownLifetime ? null : active.size;
      return { known: pendingCommands === 0 && inFlightMutations === 0, pendingCommands, inFlightMutations, closedUnknownCommands };
    } finally { reconciling = false; }
  }
  return Object.freeze({ executeCommand, reconcilePending });
}
