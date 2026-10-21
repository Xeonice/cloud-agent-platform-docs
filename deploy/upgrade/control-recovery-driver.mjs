import { randomUUID } from 'node:crypto';
import { invariant, digest, canonical, DIGEST } from './trust.mjs';
import { inspectObservation, qualifiedFallback } from './circuit-breaker.mjs';
import { validateBinding } from './stable-entry.mjs';

const codeOf = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : error?.name === 'TimeoutError' ? 'RECOVERY_RPC_TIMEOUT' : 'RECOVERY_RESULT_UNKNOWN';
const wait = ms => new Promise(ok => setTimeout(ok, ms));

/** An independent intent/epoch owns recovery. The failed attempt's lease and
 * success percentage are never extended, replaced or reused as permission. */
export function createControlRecoveryDriver({ sqlite, instanceId, store, recoveryStore, authority, adapter, diagnostics,
  executorId = `recovery-${randomUUID()}`, clock = Date.now, sleep = wait, signal, leaseMs = 15000, maxRecoveryDurationMs = 600000 }) {
  invariant(sqlite && instanceId === store?.instanceId && recoveryStore && authority && adapter && ['captureBusinessBinding', 'admitAuthority', 'admitBusinessAuthority', 'reconcile', 'qualify', 'restore', 'observe', 'confirm'].every(name => typeof adapter[name] === 'function') && leaseMs >= 5000 && leaseMs <= 120000 && maxRecoveryDurationMs >= 180000 && maxRecoveryDurationMs <= 900000, 'CONTROL_RECOVERY_DRIVER_CONFIG_INVALID');
  let busy = false;
  function authorization(intent) {
    invariant(!signal?.aborted, 'CONTROL_EXECUTION_STOPPED');
    const current = authority.assert({ operationId: intent.recoveryId, epoch: intent.epoch, executorId, kind: 'recovery' });
    invariant(intent.deadline > clock(), 'CONTROL_RECOVERY_DEADLINE_EXPIRED');
    return { operationId: current.operationId, epoch: current.epoch, executorId: current.holderId, expiresAt: current.leaseExpiresAt, kind: 'recovery', recoveryId: intent.recoveryId };
  }
  function transition(intent, phase, extra = {}) {
    authorization(intent);
    return recoveryStore.transition({ recoveryId: intent.recoveryId, epoch: intent.epoch, expectedSequence: intent.sequence, phase, ...extra });
  }
  async function start({ snapshot, fault, triggeringOperationId = null }) {
    invariant(!signal?.aborted, 'CONTROL_EXECUTION_STOPPED');
    invariant(snapshot?.attempt?.instanceId === instanceId && snapshot.plan?.planDigest === snapshot.attempt.planDigest && snapshot.signedManifest?.manifestDigest === snapshot.attempt.targetDigest, 'CONTROL_RECOVERY_SOURCE_SCOPE_INVALID');
    invariant(fault && typeof fault.code === 'string', 'CONTROL_RECOVERY_FAULT_REQUIRED');
    const existing = recoveryStore.latest(snapshot.attempt.attemptId);
    if (existing) return ['blocked', 'recovered'].includes(existing.phase) ? existing : resume(existing.recoveryId);
    const current = authority.observe();
    // A stale Controller cannot trip a newer upgrade or an already running recovery.
    invariant(current.mode === 'active' && current.kind === 'upgrade' && current.holderId !== null && current.operationId === snapshot.attempt.attemptId && store.latest()?.attemptId === snapshot.attempt.attemptId, 'CONTROL_RECOVERY_SOURCE_SUPERSEDED');
    const recoveryId = randomUUID();
    const businessBinding = await adapter.captureBusinessBinding({ snapshot, recoveryId });
    const { receiptDigest, ...bindingFacts } = businessBinding ?? {};
    const bindingAge = clock() - Date.parse(businessBinding?.observedAt);
    invariant(businessBinding?.instanceId === instanceId && DIGEST.test(receiptDigest) && digest(bindingFacts) === receiptDigest && Number.isFinite(bindingAge) && bindingAge >= 0 && bindingAge <= 5000 && validateBinding(businessBinding.binding).instanceId === instanceId, 'CONTROL_RECOVERY_BUSINESS_BINDING_PROOF_REQUIRED');
    const stabilization = typeof adapter.captureStabilizationWitness === 'function'
      ? await Promise.resolve().then(() => adapter.captureStabilizationWitness({ snapshot, recoveryId })).catch(() => null) : null;
    const authorizationPlan = {
      schemaVersion: 1, instanceId, triggeringAttemptId: snapshot.attempt.attemptId,
      triggeringOperationId, acceptedPlanDigest: snapshot.plan.planDigest, targetDigest: snapshot.attempt.targetDigest,
      sourceActivationGeneration: snapshot.plan.sourceActivationGeneration,
      sourceReleaseId: snapshot.sourceActivation.releaseId,
      fallbacksDigest: digest(snapshot.plan.policy.fallbacks),
      faultDigest: digest(fault), faultCode: fault.code,
      businessBinding,
      componentScope: fault.componentScope ?? null, sharedFault: fault.shared === true,
      stabilizeCurrentWriter: Boolean(stabilization), ...(stabilization ? { stabilization } : {}),
    };
    const intent = recoveryStore.create({ recoveryId, triggeringAttemptId: snapshot.attempt.attemptId, triggeringOperationId,
      authorizationPlan, reason: fault.code, deadline: clock() + maxRecoveryDurationMs });
    return resume(intent.recoveryId);
  }
  async function resume(recoveryId) {
    if (signal?.aborted) return { state: 'stopped', recoveryId };
    if (busy) return { state: 'busy', recoveryId };
    busy = true; let intent = recoveryStore.read(recoveryId), timer, renewing = null, renewalError = null;
    try {
      invariant(intent && intent.instanceId === instanceId, 'CONTROL_RECOVERY_INTENT_REQUIRED');
      if (['blocked', 'recovered'].includes(intent.phase)) return intent;
      const current = authority.observe();
      // A new process waits for a live recovery holder to expire. It never steals
      // an unconfirmed in-flight action merely because its PID disappeared.
      invariant(!(current.kind === 'recovery' && current.operationId === recoveryId && current.holderId !== executorId && current.leaseExpiresAt > clock()), 'CONTROL_RECOVERY_HOLDER_STILL_LIVE');
      intent = sqlite.transaction(() => {
        const nextEpoch = authority.observe().epoch + 1;
        const next = recoveryStore.claim({ recoveryId, epoch: nextEpoch });
        authority.grant({ operationId: recoveryId, epoch: nextEpoch, executorId, leaseMs, kind: 'recovery', supersedes: intent.triggeringAttemptId });
        return next;
      }).immediate();
      timer = setInterval(() => {
        if (renewing || renewalError || signal?.aborted) return;
        renewing = Promise.resolve().then(() => {
          invariant(intent.deadline > clock(), 'CONTROL_RECOVERY_DEADLINE_EXPIRED');
          return authority.renew({ operationId: recoveryId, epoch: intent.epoch, executorId, leaseMs });
        }).catch(error => { renewalError = error; }).finally(() => { renewing = null; });
      }, Math.min(1000, Math.floor(leaseMs / 3))); timer.unref();
      const assert = () => { if (renewalError) throw renewalError; return authorization(intent); };
      const snapshot = store.snapshot(intent.triggeringAttemptId);
      invariant(snapshot.attempt.targetDigest === intent.authorizationPlan.targetDigest && snapshot.plan.planDigest === intent.authorizationPlan.acceptedPlanDigest && digest(snapshot.plan.policy.fallbacks) === intent.authorizationPlan.fallbacksDigest, 'CONTROL_RECOVERY_AUTHORIZATION_CHANGED');
      const frozenBinding = intent.authorizationPlan.businessBinding, { receiptDigest: frozenDigest, ...frozenFacts } = frozenBinding ?? {};
      const captureAge = intent.createdAt - Date.parse(frozenBinding?.observedAt);
      invariant(frozenBinding?.instanceId === instanceId && DIGEST.test(frozenDigest) && digest(frozenFacts) === frozenDigest &&
        Number.isFinite(captureAge) && captureAge >= 0 && captureAge <= 5000 && validateBinding(frozenBinding.binding).instanceId === instanceId, 'CONTROL_RECOVERY_BUSINESS_BINDING_PROOF_REQUIRED');
      const attempt = { ...snapshot.attempt, instanceId, manifest: snapshot.signedManifest.manifest, plan: snapshot.plan };
      let closedUnknownCommands = intent.plan?.closedUnknownCommands ?? [];
      const context = () => ({ intent, attempt, authorization: assert(), closedUnknownCommands });
      await adapter.admitAuthority(context()); assert();
      store.freezeAttemptForRecovery({ recoveryId, epoch: intent.epoch, reason: intent.reason, diagnosticId: intent.diagnosticId });
      if (intent.phase === 'created') intent = transition(intent, 'reconciling');
      let reconciled;
      do {
        reconciled = await adapter.reconcile(context()); assert();
        invariant(Number.isSafeInteger(reconciled?.inFlightMutations) && reconciled.inFlightMutations >= 0, 'CONTROL_RECOVERY_LIFETIME_PROOF_INVALID');
        if (reconciled.inFlightMutations > 0) await sleep(Math.min(250, Math.max(1, intent.deadline - clock())));
      } while (reconciled.inFlightMutations > 0);
      const closed = reconciled?.closedUnknownCommands ?? [];
      const safeClosed = Array.isArray(closed) && closed.length > 0 && closed.length <= 100 &&
        new Set(closed.map(row => `${row.operationId}/${row.commandId}`)).size === closed.length &&
        closed.every(row => row.operationId === intent.triggeringAttemptId && typeof row.commandId === 'string' && DIGEST.test(row.specDigest) &&
          row.method === 'coordinatorHandoff' && ['prepare', 'quiesce'].includes(row.action) && ['prepared', 'quiesced'].includes(row.stage) &&
          row.participantState === 'settled' && DIGEST.test(row.participantReceiptDigest) && row.actualRunning === false && row.admissionClosed === true &&
          row.participant?.startIdentity && DIGEST.test(row.participant.artifactDigest));
      const known = reconciled?.known === true && reconciled.pendingCommands === 0;
      invariant(reconciled?.inFlightMutations === 0 && (known || intent.authorizationPlan.stabilizeCurrentWriter === true && safeClosed && reconciled.pendingCommands === closed.length), 'CONTROL_RECOVERY_OLD_ACTION_UNKNOWN');
      if (!known) {
        if (intent.plan) invariant(canonical(closedUnknownCommands) === canonical(closed), 'CONTROL_RECOVERY_ORIGINAL_CLOSURE_CHANGED');
        else closedUnknownCommands = structuredClone(closed);
      }
      // Independent epoch admission to Entry/Supervisor closes their old
      // entrances first. The business writer is admitted only after the actual
      // old participant work, including work outliving an HTTP timeout, closed.
      await adapter.admitBusinessAuthority(context()); assert();
      if (intent.phase === 'reconciling' && intent.authorizationPlan.stabilizeCurrentWriter) {
        invariant(typeof adapter.stabilizeCurrentWriter === 'function', 'CONTROL_STABILIZATION_ADAPTER_REQUIRED');
        const stabilized = await adapter.stabilizeCurrentWriter(context()); assert();
        invariant(stabilized?.commitKnown === true && stabilized.writerUnchanged === true && stabilized.requiresFreshQualification === true && stabilized.recoveryId === recoveryId && stabilized.epoch === intent.epoch, 'CONTROL_STABILIZATION_UNCONFIRMED');
      }
      invariant(intent.authorizationPlan.sharedFault !== true, 'CONTROL_RECOVERY_SHARED_FAULT_REQUIRES_REVIEW');
      if (intent.phase === 'reconciling') {
        const eligibility = await adapter.qualify(context()); assert();
        invariant(qualifiedFallback(eligibility, { attempt, fence: intent.epoch, now: clock() }), 'CONTROL_RECOVERY_NO_QUALIFIED_FALLBACK');
        const plan = { schemaVersion: 1, triggeringAttemptId: intent.triggeringAttemptId, eligibilityDigest: digest(eligibility),
          api: eligibility.api ?? null, web: eligibility.web ?? null, coordinator: eligibility.coordinator ?? null, owner: eligibility.owner ?? null,
          componentScope: eligibility.componentScope, faultDigest: intent.authorizationPlan.faultDigest,
          closedUnknownCommands };
        plan.planDigest = digest(plan);
        intent = recoveryStore.freezePlan({ recoveryId, epoch: intent.epoch, plan, qualifies: (scope, proposed) =>
          scope.triggeringAttemptId === proposed.triggeringAttemptId && scope.faultDigest === proposed.faultDigest &&
          (scope.componentScope === null || proposed.componentScope.every(component => scope.componentScope.includes(component))) &&
          canonical(proposed.componentScope) === canonical(eligibility.componentScope) && proposed.eligibilityDigest === digest(eligibility) });
        intent = transition(intent, 'restoring');
      }
      if (intent.phase === 'restoring') {
        const currentEligibility = await adapter.qualify(context()); assert();
        invariant(qualifiedFallback(currentEligibility, { attempt, fence: intent.epoch, now: clock() }) && ['api', 'web', 'coordinator', 'owner', 'componentScope'].every(key => canonical(currentEligibility[key] ?? null) === canonical(intent.plan[key] ?? null)), 'CONTROL_RECOVERY_FIXED_TARGET_NO_LONGER_QUALIFIED');
        // Adapter commands use recoveryId + immutable step IDs and the original
        // deadline. A restart may query them, never invent another rollback ID.
        const restored = await adapter.restore({ ...context(), recoveryPlan: intent.plan }); assert();
        invariant(restored?.commitKnown === true && restored.qualified === true && restored.originalResourcesPreserved === true, 'CONTROL_RECOVERY_RESTORE_UNCONFIRMED');
        intent = transition(intent, 'verifying');
      }
      invariant(intent.phase === 'verifying', 'CONTROL_RECOVERY_PHASE_INVALID');
      let previous = {}, observation;
      while (true) {
        assert(); observation = await adapter.observe(context()); assert();
        const scope = observation?.scope;
        invariant(scope?.instanceId === instanceId && scope.attemptId === intent.triggeringAttemptId && scope.recoveryId === intent.recoveryId && scope.controlEpoch === intent.epoch && Number.isSafeInteger(scope.routeGeneration) && scope.routeGeneration > 0 && Number.isSafeInteger(scope.coordinatorGeneration) && scope.coordinatorGeneration > 0 && typeof scope.observerEpoch === 'string' && scope.observerEpoch.length > 0, 'CONTROL_RECOVERY_OBSERVATION_SCOPE_MISMATCH');
        const lane = observation.recoveryProbes;
        const keys = ['instanceId', 'attemptId', 'recoveryId', 'controlEpoch', 'businessAttemptId', 'businessFence', 'routeGeneration', 'routeWeight', 'coordinatorGeneration', 'observerEpoch', 'artifactDigest', 'startIdentity'];
        const originalBinding = frozenBinding.binding;
        invariant(scope.businessAttemptId === originalBinding.attemptId && scope.businessFence === originalBinding.fence && scope.routeGeneration >= originalBinding.routeGeneration, 'CONTROL_RECOVERY_BUSINESS_BINDING_CHANGED');
        invariant(lane?.scope && observation.probes?.scope && observation.baseline?.source && keys.every(key => [lane.scope, observation.probes.scope, observation.baseline.source].every(value => value[key] === scope[key])) && typeof scope.startIdentity === 'string' && scope.startIdentity.length > 0 && Number.isSafeInteger(scope.businessFence) && scope.businessFence > 0 && [0, 100].includes(scope.routeWeight), 'CONTROL_RECOVERY_PROBE_COHORT_MISMATCH');
        const targetApi = intent.plan.api ?? { digest: attempt.manifest.components.api.artifactDigest };
        invariant(scope.artifactDigest === targetApi.digest && (!targetApi.origin || scope.origin === targetApi.origin), 'CONTROL_RECOVERY_TARGET_API_MISMATCH');
        const inspection = inspectObservation({ ...observation, candidate: lane }, attempt.plan.policy, clock(), previous); previous = inspection;
        invariant(!inspection.fault, inspection.fault || 'CONTROL_RECOVERY_OBSERVATION_UNKNOWN');
        if (inspection.qualified) break;
        await sleep(Math.min(attempt.plan.policy.evaluationIntervalMs, Math.max(1, intent.deadline - clock())));
      }
      const confirmed = await adapter.confirm({ ...context(), observation, observationDigest: digest(observation) });
      // confirm atomically updates the control instance and this intent. Only an
      // actual physical/continuity receipt can produce recovered/ready status.
      intent = recoveryStore.read(recoveryId);
      invariant(confirmed?.qualified === true && intent.phase === 'recovered' && intent.epoch === confirmed.epoch && intent.recoveryId === confirmed.recoveryId && intent.confirmedAt !== null, 'CONTROL_RECOVERY_CONFIRMATION_NOT_COMMITTED');
      authority.release({ operationId: recoveryId, epoch: intent.epoch, executorId });
      return intent;
    } catch (error) {
      const code = codeOf(error);
      // Process shutdown is not a failed recovery. Its immutable intent and
      // original command identities remain available to the next holder after
      // this holder's lease expires and physical work has been reconciled.
      if (signal?.aborted) return { state: 'stopped', recoveryId };
      // A live other holder is not our failure to record. Preserve its intent.
      if (code === 'CONTROL_RECOVERY_HOLDER_STILL_LIVE') return { state: 'waiting', recoveryId };
      let diagnosticId = null;
      if (intent?.epoch > 0 && diagnostics) {
        const captured = await diagnostics.captureFault({ faultId: randomUUID(), attemptId: intent.triggeringAttemptId, operationId: intent.triggeringOperationId, recoveryId, phase: intent.phase, code }).catch(() => null);
        if (captured?.state === 'persisted' && typeof diagnostics.pinReceipt === 'function') {
          const pinned = await diagnostics.pinReceipt(captured.faultId, recoveryId).catch(() => null);
          if (pinned?.state === 'persisted') diagnosticId = captured.faultId;
        }
      }
      if (intent?.epoch > 0) {
        try { const fresh = recoveryStore.read(recoveryId); if (fresh.epoch === intent.epoch && !['blocked', 'recovered'].includes(fresh.phase)) intent = transition(fresh, 'blocked', { reason: code, diagnosticId }); } catch { /* newer authority owns reconciliation */ }
      }
      return { state: 'blocked', recoveryId, code, intent };
    } finally { clearInterval(timer); await renewing?.catch(() => {}); busy = false; }
  }
  return { start, resume, busy: () => busy };
}
