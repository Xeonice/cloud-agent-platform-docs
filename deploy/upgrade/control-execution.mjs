import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { invariant, canonical, digest, DIGEST } from './trust.mjs';
import { readSupervisorFact } from './supervisor-control.mjs';
import { createPrivateControlRpc } from './control-rpc.mjs';
import { createControlPlaneClient } from './control-plane-client.mjs';
import { createControlBusinessCommands } from './control-business-commands.mjs';
import { createControlCommandExecutor } from './control-command-executor.mjs';
import { createControlContractAuthority } from './control-contract-authority.mjs';
import { createControlContractBusiness } from './control-contract-client.mjs';
import { createControlRecoveryDriver } from './control-recovery-driver.mjs';
import { createControlStabilization } from './control-stabilization.mjs';
import { createNativeExecutor } from './native-executor.mjs';
import { createInstanceController } from './instance-controller.mjs';
import { persistedEntryBinding } from './control-entry-context.mjs';
import { inspectObservation } from './circuit-breaker.mjs';
import { requiredCapacityRoles } from './capacity-reservation.mjs';
import { createNormalRetirement } from './normal-retirement.mjs';

const ID = /^[a-zA-Z0-9._:-]{1,200}$/;
const absolute = value => typeof value === 'string' && isAbsolute(value);
const sameIdentity = (a, b) => a?.startIdentity === b?.startIdentity && a?.artifactDigest === b?.artifactDigest;
const safeCode = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : error?.name === 'TimeoutError' ? 'UPGRADE_RPC_TIMEOUT' : 'UPGRADE_EXECUTION_UNKNOWN';
const envelope = grant => ({ epoch: grant.epoch, operationId: grant.operationId, executorId: grant.holderId, kind: grant.kind,
  ...(grant.kind === 'recovery' ? { recoveryId: grant.operationId } : {}) });
function cancelled() { return Object.assign(Error('Control execution stopped'), { code: 'CONTROL_EXECUTION_STOPPED' }); }
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    const finish = () => { signal.removeEventListener('abort', stop); resolve(); };
    const timer = setTimeout(finish, ms);
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(cancelled()); };
    signal.addEventListener('abort', stop, { once: true });
  });
}

/** Runtime constructs the remote semantic port before constructing its execution
 * loop. This factory opens no business database and instantiates no SDK. */
export function createControlContractBusinessFactory({ c, business, authority, withCommandContext }) {
  return createControlContractBusiness({ instanceId: c.instanceId, business, authority, withCommandContext });
}

/** Production assembly. All durable effects retain their original command ID,
 * immutable spec and deadline. Physical observations are private fixed RPCs. */
export async function createControlExecution({ c, engineIdentity, sqlite, stores, authority, recoveryStore, journal,
  inspector, business, requestContext, withCommandContext, participants, diagnostics, controlOrigin, signal, onEvent },
  { fetcher = fetch, clock = Date.now } = {}) {
  invariant(c && typeof c.instanceId === 'string' && ID.test(c.instanceId) && absolute(c.root) && absolute(c.downloadRoot) && absolute(c.trustRootPath) && absolute(c.capacityPlanPath) && typeof engineIdentity?.startIdentity === 'string' && engineIdentity.startIdentity.length > 0 &&
    c.privateEntryKey?.length >= 32 && c.controllerKey?.length >= 32 && c.businessKey?.length >= 32 && c.businessKey !== c.controllerKey && c.supervisorKey?.length >= 32 && c.entryKey?.length >= 32 &&
    sqlite && stores?.store && stores?.contracts && authority && recoveryStore && journal && inspector && business && participants && typeof withCommandContext === 'function', 'CONTROL_EXECUTION_CONFIG_INVALID');
  const instanceId = c.instanceId, stopped = new AbortController();
  if (signal?.aborted) stopped.abort();
  const stop = () => stopped.abort(); signal?.addEventListener('abort', stop, { once: true });
  let closed = false, running = null;
  const supervise = createPrivateControlRpc({ origin: c.supervisorOrigin, key: c.supervisorKey, instanceId, fetcher, timeoutMs: 2000 });
  const superSample = createPrivateControlRpc({ origin: c.supervisorOrigin, key: c.supervisorKey, instanceId, fetcher, timeoutMs: 100, maxBytes: 65536 });
  sqlite.exec('CREATE TABLE IF NOT EXISTS control_execution_faults(attempt_id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,fault_id TEXT NOT NULL,code TEXT NOT NULL,phase TEXT NOT NULL,recorded_at TEXT,state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS control_capacity_deferrals(attempt_id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,reservation_spec_digest TEXT NOT NULL,command TEXT NOT NULL,command_digest TEXT NOT NULL,result TEXT NOT NULL,result_digest TEXT NOT NULL)');
  function grant(expected) {
    invariant(!closed && !stopped.signal.aborted, 'CONTROL_EXECUTION_STOPPED');
    const current = expected ?? authority.observe();
    return authority.assert({ operationId: current.operationId, epoch: current.epoch, executorId: current.holderId ?? current.executorId, kind: current.kind });
  }
  function authorization(scope) { const current = grant(scope); return { operationId: current.operationId, epoch: current.epoch, executorId: current.holderId, expiresAt: current.leaseExpiresAt, kind: current.kind }; }
  async function ensureAdmission(scope = authority.observe()) {
    const current = grant(scope);
    const intent = current.kind === 'recovery' ? recoveryStore.read(current.operationId) : null;
    return participants.admit(current, { attemptId: intent?.triggeringAttemptId ?? current.operationId,
      ...(current.kind !== 'recovery' ? { intentFence: current.kind === 'contract' ? stores.contracts.snapshot(current.operationId).fence : current.epoch } : {}) });
  }
  const physicalExecutor = createControlCommandExecutor({ journal, clock, authorization: input => authorization(input.scope) });
  async function foundationCommand({ path, input, commandId, stepId, spec, scope }) {
    const current = grant(scope); await ensureAdmission(current);
    const key = { operationId: current.operationId, commandId };
    const prior = journal.lookup(key), frozen = prior?.spec ?? spec;
    invariant(!prior || prior.stepId === stepId && canonical(prior.spec) === canonical(spec), 'CONTROL_SUPERVISOR_SPEC_CHANGED');
    return physicalExecutor.execute({ ...key, stepId, spec: frozen, scope: current,
      invoke: async context => {
        const a = authorization(current), remaining = frozen.deadline - clock(); invariant(remaining > 0, 'CONTROL_COMMAND_DEADLINE_EXPIRED');
        const rpc = createPrivateControlRpc({ origin: c.supervisorOrigin, key: c.supervisorKey, instanceId, fetcher,
          timeoutMs: Math.min(120000, remaining, frozen.budget.maxDurationMs), maxBytes: 65536 });
        const row = await rpc(path, { ...input, command: { ...key, stepId, spec: frozen, authorization: a } });
        invariant(row?.operationId === key.operationId && row.commandId === commandId && row.specDigest === context.specDigest, 'CONTROL_SUPERVISOR_RECEIPT_SCOPE_INVALID');
        return row;
      },
      inspect: () => supervise('/command-result', key),
      classify: (row, context) => {
        invariant(row && row.operationId === key.operationId && row.commandId === commandId && row.specDigest === context.command.specDigest, 'CONTROL_SUPERVISOR_RECEIPT_SCOPE_INVALID');
        return { state: row.state === 'applied' ? 'applied' : row.state === 'definitely-not-applied' ? 'definitely-not-applied' : 'unknown', result: row.result };
      } });
  }
  async function reserveCapacity(attempt, current, timeoutMs) {
    invariant(Array.isArray(attempt.plan.steps), 'CONTROL_CAPACITY_REQUIRED_ROLES_UNKNOWN');
    const roles = requiredCapacityRoles(attempt.plan);
    const commandId = `${attempt.attemptId}:supervisor:capacity-reservation`, key = { operationId: current.operationId, commandId };
    const prior = journal.lookup(key), capacity = prior ? null : (await readSupervisorFact(c.capacityPlanPath)).value;
    if (capacity) invariant(capacity.instanceId === instanceId && DIGEST.test(capacity.planDigest) && DIGEST.test(capacity.sourceDigest), 'CONTROL_CAPACITY_PLAN_UNKNOWN');
    const request = { attemptId: attempt.attemptId, planDigest: attempt.plan.planDigest, packageDigest: attempt.plan.package.digest, roles };
    const spec = prior?.spec ?? { schemaVersion: 1, kind: 'capacity-reservation', instanceId, request,
      capacityPlanDigest: capacity.planDigest, sourceDigest: capacity.sourceDigest, deadline: clock() + timeoutMs, budget: { maxDurationMs: timeoutMs } };
    invariant(spec.kind === 'capacity-reservation' && canonical(spec.request) === canonical(request), 'CONTROL_CAPACITY_RESERVATION_PLAN_CHANGED');
    const receipt = await foundationCommand({ path: '/capacity-reservation', input: { attemptId: attempt.attemptId, fence: current.epoch },
      commandId, stepId: 'supervisor:capacity-reservation', spec, scope: current });
    invariant(receipt?.instanceId === instanceId && receipt.attemptId === attempt.attemptId && receipt.operationId === key.operationId && receipt.commandId === commandId &&
      receipt.specDigest === digest(spec) && receipt.sourceDigest === spec.sourceDigest && DIGEST.test(receipt.planDigest) && DIGEST.test(receipt.templateDigest) &&
      receipt.allocationIds && Object.getPrototypeOf(receipt.allocationIds) === Object.prototype, 'CONTROL_CAPACITY_RESERVATION_INVALID');
    if (receipt.qualified === false) {
      invariant(['deferred', 'unknown'].includes(receipt.state) && receipt.planDigest === spec.capacityPlanDigest && Object.keys(receipt.allocationIds).length === 0, 'CONTROL_CAPACITY_RESERVATION_INVALID');
      throw Object.assign(Error('Capacity admission did not permit this upgrade'), { code: receipt.state === 'deferred' ? 'CONTROL_CAPACITY_DEFERRED' : 'CONTROL_CAPACITY_UNKNOWN' });
    }
    invariant(receipt.qualified === true && receipt.state === 'admitted' && canonical(Object.keys(receipt.allocationIds).sort()) === canonical(roles) &&
      Object.values(receipt.allocationIds).every(id => typeof id === 'string' && ID.test(id)) && new Set(Object.values(receipt.allocationIds)).size === roles.length,
      'CONTROL_CAPACITY_RESERVATION_INVALID');
    return receipt;
  }
  const supervisor = {
    async request({ path, attempt, fence, kind, timeoutMs = 120000 }) {
      const current = grant(); invariant(current.kind === 'upgrade' && current.operationId === attempt.attemptId && current.epoch === fence || current.kind === 'recovery' && recoveryStore.read(current.operationId)?.triggeringAttemptId === attempt.attemptId && current.epoch === fence, 'CONTROL_SUPERVISOR_ATTEMPT_SCOPE_INVALID');
      if (path === '/current-installer') return supervise(path, {});
      if (path === '/observe') return supervise(path, { attemptId: attempt.attemptId, fence, kind });
      invariant(current.kind === 'upgrade' && ['/start', '/publish'].includes(path) && (path === '/publish' ? kind === 'package' : ['api', 'web', 'coordinator', 'owner'].includes(kind)), 'BUSINESS_RELEASE_CANNOT_REPLACE_CONTROL');
      invariant(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, 'CONTROL_SUPERVISOR_BUDGET_INVALID');
      const commandId = `${attempt.attemptId}:supervisor:${path.slice(1)}:${kind}`, key = { operationId: current.operationId, commandId };
      const prior = journal.lookup(key), reservation = prior ? null : await reserveCapacity(attempt, current, timeoutMs);
      const capacity = prior ? null : (await readSupervisorFact(c.capacityPlanPath)).value;
      if (capacity) invariant(capacity.instanceId === instanceId && DIGEST.test(capacity.planDigest) && DIGEST.test(capacity.sourceDigest) && capacity.sourceDigest === reservation.sourceDigest, 'CONTROL_CAPACITY_PLAN_UNKNOWN');
      let allocation;
      if (!prior && path === '/start') {
        const allocationId = reservation.allocationIds[kind];
        const matches = Object.values(capacity.allocations ?? {}).flat().filter(item => item?.id === allocationId && item.resident === false);
        invariant(typeof allocationId === 'string' && matches.length === 1, 'CONTROL_CAPACITY_ALLOCATION_UNKNOWN');
        allocation = { capacityAllocationId: allocationId, resources: structuredClone(matches[0].resources) };
      }
      const spec = prior?.spec ?? { schemaVersion: 1, kind: path === '/start' ? 'supervisor-start' : 'supervisor-publish', instanceId,
        request: { attemptId: attempt.attemptId, kind }, deadline: clock() + timeoutMs, budget: { maxDurationMs: timeoutMs },
        planDigest: attempt.plan.planDigest, packageDigest: attempt.plan.package.digest, capacityPlanDigest: capacity.planDigest, sourceDigest: capacity.sourceDigest, ...allocation };
      invariant(spec.planDigest === attempt.plan.planDigest && spec.packageDigest === attempt.plan.package.digest && canonical(spec.request) === canonical({ attemptId: attempt.attemptId, kind }), 'CONTROL_SUPERVISOR_PLAN_CHANGED');
      return foundationCommand({ path, input: { attemptId: attempt.attemptId, fence, kind }, commandId, stepId: `supervisor:${path.slice(1)}:${kind}`, spec, scope: current });
    },
  };
  function baseline(attemptId) {
    const row = sqlite.prepare('SELECT snapshot,digest FROM upgrade_continuity_baselines WHERE attempt_id=?').get(attemptId);
    invariant(row && digest(JSON.parse(row.snapshot)) === row.digest, 'CONTROL_SOURCE_PARTICIPANT_UNKNOWN');
    return JSON.parse(row.snapshot);
  }
  async function participantCommandStatus(input) {
    const row = journal.lookup({ operationId: input.attemptId, commandId: input.commandId });
    invariant(row?.spec?.participant && ['coordinatorHandoff', 'ownerCandidate', 'migration'].includes(row.spec.method), 'CONTROL_PARTICIPANT_COMMAND_UNKNOWN');
    const inventory = await supervise('/coordinator-inventory');
    const age = clock() - Date.parse(inventory.observedAt);
    invariant(inventory.instanceId === instanceId && inventory.complete === true && Array.isArray(inventory.coordinators) && inventory.coordinators.length <= 128 && age >= 0 && age <= 5000, 'CONTROL_PARTICIPANT_INVENTORY_UNKNOWN');
    const matches = inventory.coordinators.filter(record => sameIdentity(record, row.spec.participant));
    invariant(matches.length === 1 && matches[0].physical?.running === true && matches[0].physical.startIdentity === row.spec.participant.startIdentity, 'CONTROL_ORIGINAL_PARTICIPANT_UNAVAILABLE');
    const record = matches[0], actual = record.actualIdentity;
    invariant(actual?.instanceId === instanceId && sameIdentity(actual, row.spec.participant), 'CONTROL_ORIGINAL_PARTICIPANT_IDENTITY_CHANGED');
    const prepared = row.spec.method === 'coordinatorHandoff' && row.spec.body.action === 'adopt';
    const rpc = createPrivateControlRpc({ origin: prepared ? record.managementOrigin ?? record.origin : record.applicationOrigin ?? record.origin, key: c.businessKey, instanceId, fetcher });
    if (prepared) return rpc('/internal/coordinator/participant-command-status', input);
    const receipt = await rpc('/internal/upgrades/inspection', { action: 'participantCommandStatus', ...input }, recoveryHeaders());
    invariant(receipt.instanceId === instanceId && receipt.action === 'participantCommandStatus', 'CONTROL_PARTICIPANT_INSPECTION_INVALID');
    return receipt.result;
  }
  const commandInspector = { ...inspector, participantCommandStatus };
  const commands = createControlBusinessCommands({ journal, authority, recoveryStore, business, inspector: commandInspector, clock, withCommandContext,
    participantIdentity: ({ args }) => baseline(args[0]).coordinator });
  const coordinator = createControlPlaneClient({ controlOrigin, controlKey: c.controllerKey, coordinatorOrigin: c.coordinatorOrigin, coordinatorKey: c.businessKey,
    coordinatorBindingPath: c.coordinatorBindingPath, instanceId, requestContext, executeCommand: commands.executeCommand, fetcher });
  const native = createNativeExecutor({ ...c, instanceId, coordinator, supervisorClient: supervisor, fetcher, entryControllerKey: c.privateEntryKey,
    ensureControlAdmission: ensureAdmission, controlContext: () => envelope(grant()) });
  const contractAuthority = createControlContractAuthority({ sqlite, instanceId, authority, contracts: stores.contracts, participants, clock });
  const stabilization = createControlStabilization({ sqlite, instanceId, supervisorOrigin: c.supervisorOrigin, supervisorKey: c.supervisorKey, controllerKey: c.businessKey, trustRootPath: c.trustRootPath, fetcher, clock });
  function recoveryHeaders() {
    const context = requestContext?.();
    return context?.recoveryId ? { 'x-platform-recovery-id': context.recoveryId, 'x-platform-recovery-epoch': String(context.epoch), 'x-platform-control-epoch': String(context.epoch) } : {};
  }
  async function withinRecovery(context, work) {
    const current = grant({ ...context.authorization, holderId: context.authorization.executorId });
    invariant(current.kind === 'recovery' && current.operationId === context.intent.recoveryId && current.epoch === context.intent.epoch, 'CONTROL_RECOVERY_EXECUTION_SCOPE_INVALID');
    const actual = await native.actual();
    const receipt = context.intent.authorizationPlan.businessBinding, { receiptDigest, ...facts } = receipt ?? {}, frozen = receipt?.binding;
    invariant(receipt?.instanceId === instanceId && digest(facts) === receiptDigest && frozen?.instanceId === instanceId &&
      actual.instanceId === instanceId && actual.attemptId === frozen.attemptId && actual.fence === frozen.fence &&
      Number.isSafeInteger(actual.routeGeneration) && actual.routeGeneration >= frozen.routeGeneration, 'CONTROL_RECOVERY_BUSINESS_BINDING_UNKNOWN');
    const selected = actual.weight === 100 ? actual.candidateApi : actual.oldApi;
    const allowed = [frozen.oldApi, frozen.candidateApi, context.intent.plan?.api].filter(Boolean);
    invariant(selected && allowed.some(api => api.digest === selected.digest && api.origin === selected.origin), 'CONTROL_RECOVERY_SELECTED_COMPONENT_CHANGED');
    return withCommandContext({ recoveryId: current.operationId, epoch: current.epoch, businessAttemptId: actual.attemptId, businessFence: actual.fence, deadline: context.intent.deadline }, work);
  }
  async function reconcileSupervisor(context) {
    let active = 0;
    for (const pending of journal.pending()) {
      const row = journal.lookup(pending);
      if (!['capacity-reservation', 'supervisor-start', 'supervisor-publish', 'contract-retire-reader'].includes(row.spec?.kind)) continue;
      invariant(row.operationId === context.intent.triggeringAttemptId, 'CONTROL_RECOVERY_FOREIGN_SUPERVISOR_COMMAND');
      let observed;
      try { observed = await supervise('/command-result', { operationId: row.operationId, commandId: row.commandId }); }
      catch (error) { if (error.status === 409 && error.code === 'SUPERVISOR_SINGLE_FLIGHT_BLOCKED') { active++; continue; } throw error; }
      if (observed === null) continue;
      invariant(observed?.specDigest === row.specDigest && observed.operationId === row.operationId && observed.commandId === row.commandId, 'CONTROL_SUPERVISOR_RECONCILIATION_SCOPE_INVALID');
      if (['applied', 'definitely-not-applied'].includes(observed.state)) journal.record({ ...pending, state: observed.state, result: observed.result, authorization: authorization({ ...context.authorization, holderId: context.authorization.executorId }) });
    }
    return active;
  }
  async function confirm(context) {
    return withinRecovery(context, async () => {
      const before = persistedEntryBinding(await native.actual()), continuity = await coordinator.continuity(context.attempt.attemptId, { fence: context.intent.epoch });
      invariant(continuity.qualified === true && canonical(before) === canonical(persistedEntryBinding(await native.actual())), 'CONTROL_RECOVERY_FINAL_CONTINUITY_UNKNOWN');
      await inspector.refreshMetadata();
      const sourceActual = await inspector.sourceActual(true), snapshot = stores.store.snapshot(context.intent.triggeringAttemptId);
      let confirmedRelease, installedProof = null;
      if (sourceActual) {
        const { proofDigest, ...facts } = sourceActual;
        invariant(sourceActual.qualified === true && sourceActual.partial === true && sourceActual.instanceId === instanceId && digest(facts) === proofDigest, 'CONTROL_RECOVERY_ACTUAL_SOURCE_UNKNOWN');
      } else {
        confirmedRelease = { ...snapshot.sourceActivation, activationGeneration: stores.store.instance().activation_generation + 1,
          activatedAt: new Date(clock()).toISOString(), schema: inspector.schema(), productionWebBinding: before.web.origin };
        installedProof = await inspector.installedProof(confirmedRelease, before);
        invariant(installedProof.qualified === true, 'CONTROL_RECOVERY_INSTALLED_COMBINATION_UNKNOWN');
      }
      const after = persistedEntryBinding(await native.actual());
      invariant(canonical(before) === canonical(after), 'CONTROL_RECOVERY_FINAL_BINDING_CHANGED');
      invariant(digest(context.observation) === context.observationDigest, 'CONTROL_RECOVERY_FINAL_OBSERVATION_CHANGED');
      // Artifact/source verification may take longer than a probe's freshness
      // budget. Read the actual collector again; never re-date its old proof.
      const scopeKeys = ['instanceId','attemptId','recoveryId','controlEpoch','businessAttemptId','businessFence','routeGeneration','routeWeight','coordinatorGeneration','observerEpoch','artifactDigest','startIdentity','origin'];
      grant({ ...context.authorization, holderId: context.authorization.executorId });
      invariant(context.intent.deadline > clock(), 'CONTROL_RECOVERY_DEADLINE_EXPIRED');
      const finalObservation = await native.observe({ attempt: context.attempt, fence: context.intent.epoch, weight: after.weight });
      invariant(scopeKeys.every(key => finalObservation.scope?.[key] === context.observation.scope?.[key] &&
          (key === 'origin' || [finalObservation.recoveryProbes?.scope, finalObservation.probes?.scope, finalObservation.baseline?.source].every(scope => scope?.[key] === finalObservation.scope?.[key]))) &&
        finalObservation.baseline?.source?.origin === finalObservation.scope?.origin &&
        inspectObservation({ ...finalObservation, candidate: finalObservation.recoveryProbes }, context.attempt.plan.policy, clock()).qualified === true &&
        canonical(after) === canonical(persistedEntryBinding(await native.actual())), 'CONTROL_RECOVERY_FINAL_OBSERVATION_STALE');
      const confirmation = { qualified: true, instanceId, recoveryId: context.intent.recoveryId, triggeringAttemptId: context.intent.triggeringAttemptId,
        epoch: context.intent.epoch, planDigest: context.intent.planDigest, actual: after, continuity: finalObservation.continuity, initialContinuity: continuity, sourceActual, installedProof,
        observation: finalObservation, observationDigest: digest(finalObservation), initialObservationDigest: context.observationDigest,
        closedUnknownCommands: context.closedUnknownCommands ?? [], observedAt: new Date(clock()).toISOString() };
      confirmation.receiptDigest = digest(confirmation);
      sqlite.transaction(() => {
        grant({ ...context.authorization, holderId: context.authorization.executorId });
        stores.store.confirmIndependentRecovery({ recoveryId: context.intent.recoveryId, epoch: context.intent.epoch, expectedRecoverySequence: context.intent.sequence,
          ...(confirmedRelease ? { confirmedRelease } : { restoredPartial: true }), confirmation });
        for (const row of confirmation.closedUnknownCommands) journal.reconcile({ operationId: row.operationId, commandId: row.commandId,
          authorization: { ...context.authorization, operationId: context.intent.recoveryId }, recoveryId: context.intent.recoveryId, confirmationReceiptDigest: confirmation.receiptDigest });
      }).immediate();
      return { qualified: true, recoveryId: context.intent.recoveryId, epoch: context.intent.epoch, receiptDigest: confirmation.receiptDigest };
    });
  }
  const adapter = {
    async captureBusinessBinding() {
      const observedAt = new Date(clock()).toISOString(), binding = persistedEntryBinding(await native.actual());
      const receipt = { instanceId, binding, observedAt }; return { ...receipt, receiptDigest: digest(receipt) };
    },
    captureStabilizationWitness: context => stabilization.capture(context),
    admitAuthority: context => withinRecovery(context, () => ensureAdmission({ ...context.authorization, holderId: context.authorization.executorId })),
    reconcile: context => withinRecovery(context, async () => { const supervisorActive = await reconcileSupervisor(context); const result = await commands.reconcilePending(context); return { ...result, inFlightMutations: result.inFlightMutations === null ? null : result.inFlightMutations + Math.max(supervisorActive, physicalExecutor.activeCount()) }; }),
    admitBusinessAuthority: context => withinRecovery(context, async () => {
      const result = await commands.reconcilePending(context);
      invariant(result.inFlightMutations === 0 && physicalExecutor.activeCount() === 0, 'CONTROL_RECOVERY_LIFETIME_STILL_ACTIVE');
      const closed = context.closedUnknownCommands ?? [];
      invariant(result.pendingCommands === closed.length && canonical(result.closedUnknownCommands) === canonical(closed), 'CONTROL_RECOVERY_LIFETIME_CLOSURE_CHANGED');
      return participants.admit(grant(), { attemptId: context.intent.triggeringAttemptId, businessWriter: true });
    }),
    stabilizeCurrentWriter: context => withinRecovery(context, async () => {
      await stabilization.refresh(context.intent);
      const commandId = `${context.intent.recoveryId}:stabilize-current-writer`, key = { operationId: context.intent.recoveryId, commandId };
      const body = { operationId: commandId }, spec = journal.lookup(key)?.spec ?? { schemaVersion: 1, kind: 'business-stabilization', attemptId: context.intent.triggeringAttemptId, body, deadline: Math.min(clock() + 5000, context.intent.deadline) };
      return physicalExecutor.execute({ ...key, stepId: 'stabilize-current-writer', spec, scope: grant(),
        invoke: () => business.stabilizeCurrentWriter(context.intent.triggeringAttemptId, { ...body, fence: context.intent.epoch }),
        inspect: () => business.recoveryActions(context.intent.triggeringAttemptId),
        classify: (receipt, info) => {
          if (!info.lookup) return { state: receipt?.commitKnown === true ? 'applied' : 'unknown', result: receipt };
          const row = Array.isArray(receipt) ? receipt.find(value => value.commandId === commandId) : null;
          invariant(row?.specDigest === digest({ attemptId: context.intent.triggeringAttemptId, action: 'stabilize-current-writer', input: body }), 'CONTROL_STABILIZATION_COMMAND_SCOPE_INVALID');
          return { state: row.state === 'completed' && row.result?.commitKnown === true ? 'applied' : 'unknown', result: row.result };
        } });
    }),
    qualify: context => withinRecovery(context, () => native.fallbackEligibility({ attempt: context.attempt, fence: context.intent.epoch,
      fault: { code: context.intent.authorizationPlan.faultCode, componentScope: context.intent.authorizationPlan.componentScope, shared: context.intent.authorizationPlan.sharedFault } })),
    restore: context => withinRecovery(context, async () => {
      const actual = await native.recover({ attempt: context.attempt, fence: context.intent.epoch, recoveryPlan: context.recoveryPlan });
      const plan = context.recoveryPlan, selected = actual.weight === 100 ? actual.candidateApi : actual.oldApi;
      const frozen = context.intent.authorizationPlan.businessBinding.binding;
      invariant(actual.attemptId === frozen.attemptId && actual.fence === frozen.fence && actual.routeGeneration >= frozen.routeGeneration && (!plan.api || actual.weight === 0 && selected?.digest === plan.api.digest && selected.origin === plan.api.origin) && (!plan.web || actual.web.digest === plan.web.digest), 'CONTROL_RECOVERY_RESTORE_BINDING_MISMATCH');
      const continuity = await coordinator.continuity(context.attempt.attemptId, { fence: context.intent.epoch });
      invariant(continuity.qualified === true, 'CONTROL_RECOVERY_RESTORE_CONTINUITY_UNKNOWN');
      return { commitKnown: true, qualified: true, originalResourcesPreserved: true, actual, continuity };
    }),
    observe: context => withinRecovery(context, async () => { const actual = await native.actual(); return native.observe({ attempt: context.attempt, fence: context.intent.epoch, weight: actual.weight }); }),
    confirm,
  };
  const recoveryDriver = createControlRecoveryDriver({ sqlite, instanceId, store: stores.store, recoveryStore, authority, adapter, diagnostics,
    executorId: c.controllerId ?? `control-recovery-${randomUUID()}`, clock, signal: stopped.signal, sleep: ms => pause(ms, stopped.signal) });
  function deferKnownCapacity(session, error) {
    if (!['CONTROL_CAPACITY_DEFERRED', 'CONTROL_CAPACITY_UNKNOWN'].includes(error.code) || typeof stores.store.commitReceipt !== 'function') return null;
    invariant(stores.store.ledgerSqlite === sqlite, 'CONTROL_CAPACITY_DEFERRAL_LEDGER_CHANGED');
    const id = session.attempt.attemptId, commandId = `${id}:supervisor:capacity-reservation`;
    return sqlite.transaction(() => {
      const row = journal.lookup({ operationId: id, commandId }), decision = row?.result;
      if (row?.state !== 'applied' || row.spec.kind !== 'capacity-reservation' || row.spec.instanceId !== instanceId || row.spec.request?.attemptId !== id ||
        decision?.qualified !== false || !['deferred', 'unknown'].includes(decision.state) || decision.instanceId !== instanceId || decision.attemptId !== id ||
        decision.operationId !== id || decision.commandId !== commandId || decision.specDigest !== row.specDigest || decision.sourceDigest !== row.spec.sourceDigest ||
        !DIGEST.test(decision.templateDigest) || decision.planDigest !== row.spec.capacityPlanDigest || !decision.allocationIds || Object.getPrototypeOf(decision.allocationIds) !== Object.prototype || Object.keys(decision.allocationIds).length !== 0) return null;
      const previous = sqlite.prepare('SELECT * FROM control_capacity_deferrals WHERE attempt_id=?').get(id);
      if (previous) {
        const command = JSON.parse(previous.command), result = JSON.parse(previous.result), snapshot = stores.store.snapshot(id);
        invariant(previous.instance_id === instanceId && previous.reservation_spec_digest === row.specDigest && digest(command) === previous.command_digest && digest(result) === previous.result_digest &&
          snapshot.attempt.state === 'deferred', 'CONTROL_CAPACITY_DEFERRAL_CORRUPT');
        const replay = stores.store.commitReceipt(id, command);
        invariant(digest(replay) === previous.result_digest, 'CONTROL_CAPACITY_DEFERRAL_RECEIPT_CHANGED');
        return { state: 'deferred', attemptId: id, receipt: result };
      }
      const current = grant(), snapshot = stores.store.snapshot(id), generation = session.generation ?? session.attempt.generation;
      if (current.kind !== 'upgrade' || current.operationId !== id || current.epoch !== session.fence || snapshot.fence !== session.fence ||
        !Number.isSafeInteger(generation) || snapshot.attempt.generation !== generation || snapshot.controllerId !== current.holderId ||
        !['accepted', 'downloading'].includes(snapshot.attempt.state) || snapshot.plan.planDigest !== row.spec.request.planDigest || snapshot.plan.package.digest !== row.spec.request.packageDigest || canonical(requiredCapacityRoles(snapshot.plan)) !== canonical(row.spec.request.roles) ||
        !Array.isArray(snapshot.appliedSteps) || snapshot.appliedSteps.some(step => snapshot.plan.steps.find(item => item.stepId === step.stepId)?.kind !== 'download') ||
        sqlite.prepare('SELECT 1 FROM control_commands WHERE instance_id=? AND operation_id=? AND command_id<>? LIMIT 1').get(instanceId, id, commandId)) return null;
      stores.store.assertControllerFence(id, session.fence, generation);
      const command = { fence: session.fence, generation, expectedSequence: snapshot.attempt.sequence,
        eventId: 'capacity-deferred:' + digest({ instanceId, attemptId: id, reservationSpecDigest: row.specDigest }).slice(7), kind: 'deferred',
        payload: { reason: decision.state === 'deferred' ? '实例容量不足，升级已延后' : '实例容量待确认，升级已延后',
          capacityReservation: { commandId, specDigest: row.specDigest, resultDigest: digest(decision), state: decision.state } } };
      const receipt = stores.store.commitReceipt(id, command);
      invariant(receipt.instanceId === instanceId && receipt.attemptId === id && receipt.state === 'deferred' && receipt.eventDigest === digest(command), 'CONTROL_CAPACITY_DEFERRAL_RECEIPT_CHANGED');
      sqlite.prepare('INSERT INTO control_capacity_deferrals VALUES(?,?,?,?,?,?,?)').run(id, instanceId, row.specDigest, canonical(command), digest(command), canonical(receipt), digest(receipt));
      return { state: 'deferred', attemptId: id, receipt };
    }).immediate();
  }
  async function onFault({ session, error }) {
    if (closed || stopped.signal.aborted || safeCode(error) === 'CONTROL_EXECUTION_STOPPED') return { state: 'stopped' };
    const deferred = deferKnownCapacity(session, error); if (deferred) return deferred;
    const id = session.attempt.attemptId, code = safeCode(error);
    let row = sqlite.prepare('SELECT * FROM control_execution_faults WHERE attempt_id=? AND instance_id=?').get(id, instanceId);
    if (!row) { sqlite.prepare('INSERT INTO control_execution_faults VALUES(?,?,?,?,?,NULL,?)').run(id, instanceId, randomUUID(), code, 'recover', 'unknown'); row = sqlite.prepare('SELECT * FROM control_execution_faults WHERE attempt_id=?').get(id); }
    const captured = await Promise.resolve().then(() => diagnostics?.captureFault({ faultId: row.fault_id, attemptId: id, operationId: id, phase: 'recover', code: row.code })).catch(() => null);
    const pinned = captured?.state === 'persisted' ? await Promise.resolve().then(() => diagnostics.pinReceipt(row.fault_id, id)).catch(() => null) : null;
    if (pinned?.state === 'persisted' && captured.recordedAt) sqlite.prepare("UPDATE control_execution_faults SET recorded_at=?,state='persisted' WHERE attempt_id=? AND fault_id=?").run(captured.recordedAt, id, row.fault_id);
    const snapshot = stores.store.snapshot(id), componentScope = Array.isArray(error.componentScope) && error.componentScope.every(value => ['api', 'web', 'coordinator', 'owner'].includes(value)) ? error.componentScope : null;
    return recoveryDriver.start({ snapshot, fault: { code: row.code, componentScope, shared: error.shared === true, ...(pinned?.state === 'persisted' ? { diagnosticId: row.fault_id } : {}) } });
  }
  const controller = createInstanceController({ ...c, controllerId: c.controllerId ?? `control-${randomUUID()}`, startIdentity: engineIdentity.startIdentity,
    coordinator, executor: { ...native, installerCandidate: () => { throw Object.assign(Error('Independent control maintenance is explicit'), { code: 'BUSINESS_RELEASE_CANNOT_REPLACE_CONTROL' }); } }, signal: stopped.signal, onEvent, onFault, fetcher });
  const normalRetirements=createNormalRetirement({sqlite,instanceId,executorId:`normal-retirement-${randomUUID()}`,store:stores.store,authority,journal,participants,recoveryStore,clock,
    canRun:()=>!running&&!closed&&!stopped.signal.aborted&&stores.contracts.active().length===0,
    references:async target=>{
      const result=await supervise('/candidate-references');
      invariant(result?.instanceId===instanceId && Array.isArray(result.candidates) && result.candidates.length<=128,'NORMAL_RETIREMENT_REFERENCE_UNKNOWN');
      const matches=result.candidates.filter(row=>canonical(row.target)===canonical(target));
      invariant(matches.length===1,'NORMAL_RETIREMENT_REFERENCE_UNKNOWN');return matches[0];
    },
    participant:async target=>{
      const result=await supervise('/coordinator-inventory');
      invariant(result?.instanceId===instanceId && result.complete===true && Array.isArray(result.coordinators)&&result.coordinators.length<=128,
        'NORMAL_RETIREMENT_PARTICIPANT_UNKNOWN');
      const rows=result.coordinators.filter(row=>row.containerId===target.containerId);
      invariant(rows.length===1 && rows[0].applicationOrigin,'NORMAL_RETIREMENT_PARTICIPANT_UNKNOWN');return rows[0];
    },
    census:record=>createPrivateControlRpc({origin:record.managementOrigin??record.applicationOrigin,instanceId,key:c.businessKey,fetcher,maxBytes:65536,timeoutMs:2000})(record.managementOrigin?'/internal/coordinator/retirement':'/internal/application/retirement'),
    drain:(record,body)=>createPrivateControlRpc({origin:record.managementOrigin??record.applicationOrigin,instanceId,key:c.businessKey,fetcher,maxBytes:65536,timeoutMs:2000})(record.managementOrigin?'/internal/coordinator/retirement-drain':'/internal/application/retirement-drain',body),
    supervisor:supervise,
  });
  return {
    coordinator, executor: native, commands, recoveryDriver, adapter, controller, normalRetirements,
    ensureContractAuthority: record => contractAuthority.ensure(record),
    async retireContractReader(body) {
      const record = stores.contracts.snapshot(body.contractAttemptId), current = await contractAuthority.ensure(record);
      invariant(body.fence === record.fence && body.operationId === `${body.contractAttemptId}:retire:${body.readerId}`, 'CONTROL_CONTRACT_READER_SCOPE_INVALID');
      const key = { operationId: current.operationId, commandId: body.operationId }, spec = journal.lookup(key)?.spec ?? { schemaVersion: 1, kind: 'contract-retire-reader', instanceId,
        request: { ...body }, deadline: clock() + 5000, budget: { maxDurationMs: 5000 } };
      return foundationCommand({ path: '/retire-reader', input: body, commandId: body.operationId, stepId: 'contract-retire-reader', spec, scope: current });
    },
    async tickContracts(contracts) {
      for (const record of stores.contracts.active()) await contractAuthority.ensure(record);
      return contracts.tick();
    },
    runOnce() {
      if (closed) return Promise.resolve({ state: 'stopped' });
      if (running) return Promise.resolve({ state: 'busy' });
      const current = authority.observe();
      if (current.kind === 'contract' && current.holderId && current.leaseExpiresAt > clock()) return Promise.resolve({ state: 'contract-active' });
      running = Promise.resolve().then(() => { const active = recoveryStore.active(); return active ? recoveryDriver.resume(active.recoveryId) : controller.runOnce(); }).finally(() => { running = null; });
      return running;
    },
    async sample() {
      const rows = await superSample('/diagnostics/sample'); invariant(Array.isArray(rows) && rows.length <= 128, 'CONTROL_SAMPLE_PROVIDER_INVALID');
      return [{ role: 'control', startIdentity: engineIdentity.startIdentity, state: 'alive', rssBytes: process.memoryUsage().rss }, ...rows];
    },
    diagnosticStatus() {
      const row = sqlite.prepare("SELECT fault_id,code,phase,recorded_at FROM control_execution_faults WHERE instance_id=? AND state='persisted' AND recorded_at IS NOT NULL ORDER BY recorded_at DESC LIMIT 1").get(instanceId);
      return row ? { correlationId: row.fault_id, code: row.code, phase: row.phase, recordedAt: row.recorded_at } : null;
    },
    async close() { if (closed) return; closed = true; stopped.abort(); signal?.removeEventListener('abort', stop); contractAuthority.close(); await running?.catch(() => {}); await normalRetirements.close(); },
  };
}
