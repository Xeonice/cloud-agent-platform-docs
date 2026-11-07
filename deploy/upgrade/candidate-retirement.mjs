import { canonical, digest, invariant } from './trust.mjs';

const ID = /^[a-zA-Z0-9._:-]{1,200}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const ROLES = new Set(['api', 'coordinator', 'web', 'installer']);
const REFERENCES = ['entry', 'http', 'ws', 'writer', 'handoff', 'activeCommands', 'fallback', 'owners', 'guests', 'recovery', 'workers', 'userOperations'];
const IDENTITY_KEYS = ['instanceId', 'role', 'containerId', 'startIdentity', 'hostPid', 'startedAt', 'artifactDigest', 'attemptId'];
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const sameKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const clone = value => structuredClone(value);

function identity(value) {
  return sameKeys(value, IDENTITY_KEYS) && ID.test(value.instanceId) && ROLES.has(value.role) && /^[a-f0-9]{64}$/.test(value.containerId) && ID.test(value.startIdentity) && value.startIdentity.length >= 16 && integer(value.hostPid) && value.hostPid > 1 && typeof value.startedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value.startedAt) && Number.isFinite(Date.parse(value.startedAt)) && HASH.test(value.artifactDigest) && ID.test(value.attemptId);
}

function stateFacts(state) {
  return {
    instanceId: state.instanceId, revision: state.revision, target: state.target,
    running: state.running, paused: state.paused, restartPolicy: state.restartPolicy,
    attemptTerminal: state.attemptTerminal, authorityReleased: state.authorityReleased,
    controllerLeaseExpiresAt: state.controllerLeaseExpiresAt,
    legacyInstaller: state.legacyInstaller, references: state.references,
  };
}

/**
 * Pure, fail-closed eligibility. startedAt is the Docker birth timestamp, paired
 * with full immutable container ID, host PID and the application's start ID.
 * `revision` is the protected role/reference index revision, not a wall clock
 * or the control journal's unrelated sequence. No observation time is refreshed.
 */
export function planCandidateRetirement({ instanceId, target, state, deadline, budget, maxObservationAgeMs, now = Date.now() }) {
  const refuse = (reason, status = 'blocked') => ({ qualified: false, status, reason, spec: null, specDigest: null });
  try {
    if (!identity(target) || target.instanceId !== instanceId) return refuse('RETIREMENT_TARGET_FORBIDDEN');
    if (!Number.isFinite(now) || !Number.isSafeInteger(deadline) || deadline <= now || !sameKeys(budget, ['maxDurationMs']) || !integer(budget.maxDurationMs) || budget.maxDurationMs === 0 || !integer(maxObservationAgeMs) || maxObservationAgeMs === 0) return refuse('RETIREMENT_BUDGET_INVALID', 'unknown');
    if (!object(state) || state.known !== true || state.instanceId !== instanceId || !integer(state.revision) || !identity(state.target)) return refuse('RETIREMENT_STATE_UNKNOWN', 'unknown');
    if (canonical(state.target) !== canonical(target)) return refuse('RETIREMENT_IDENTITY_CHANGED');
    const age = now - Date.parse(state.observedAt);
    if (!Number.isFinite(age) || age < 0 || age > maxObservationAgeMs) return refuse('RETIREMENT_STATE_STALE', 'unknown');
    if (state.running !== true || state.paused !== false || state.restartPolicy !== 'no') return refuse('RETIREMENT_PROCESS_NOT_RETIRABLE');
    if (state.attemptTerminal !== true || state.authorityReleased !== true || !Number.isSafeInteger(state.controllerLeaseExpiresAt) || state.controllerLeaseExpiresAt > now) return refuse('RETIREMENT_AUTHORITY_NOT_RELEASED');
    if (state.legacyInstaller !== (target.role === 'installer')) return refuse('RETIREMENT_ROLE_SCOPE_UNKNOWN', 'unknown');
    if (!sameKeys(state.references, REFERENCES) || !REFERENCES.every(key => integer(state.references[key]))) return refuse('RETIREMENT_REFERENCES_UNKNOWN', 'unknown');
    const referenced = REFERENCES.filter(key => state.references[key] > 0);
    if (referenced.length) return { ...refuse('RETIREMENT_ROLE_REFERENCED'), referenced };
    const spec = {
      schemaVersion: 1, kind: 'retire-candidate', instanceId, target: clone(target),
      expectedRevision: state.revision, expectedStateDigest: digest(stateFacts(state)),
      maxObservationAgeMs, signal: 'SIGTERM', deadline, budget: clone(budget),
    };
    return { qualified: true, status: 'qualified', reason: null, spec, specDigest: digest(spec) };
  } catch {
    return refuse('RETIREMENT_STATE_UNKNOWN', 'unknown');
  }
}

function validSpec(spec, instanceId) {
  return sameKeys(spec, ['schemaVersion', 'kind', 'instanceId', 'target', 'expectedRevision', 'expectedStateDigest', 'maxObservationAgeMs', 'signal', 'deadline', 'budget']) && spec.schemaVersion === 1 && spec.kind === 'retire-candidate' && spec.instanceId === instanceId && identity(spec.target) && spec.target.instanceId === instanceId && integer(spec.expectedRevision) && HASH.test(spec.expectedStateDigest) && integer(spec.maxObservationAgeMs) && spec.maxObservationAgeMs > 0 && spec.signal === 'SIGTERM' && Number.isSafeInteger(spec.deadline) && sameKeys(spec.budget, ['maxDurationMs']) && integer(spec.budget.maxDurationMs) && spec.budget.maxDurationMs > 0;
}

async function bounded(work, milliseconds, code) {
  invariant(Number.isFinite(milliseconds) && milliseconds > 0, code);
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error(code), { code })); }, milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function safeCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'RETIREMENT_OUTCOME_UNKNOWN';
}

/**
 * The injected adapter is a narrow, trusted Supervisor boundary, NOT Docker or
 * a shell. terminate MUST atomically compare its role/reference revision and
 * digest plus authorization before issuing one SIGTERM. It must never use a
 * stop timeout which escalates to KILL, remove a container, or prune a volume.
 * lookupCommand is read-only and returns the original command's durable result.
 * The Control Agent supplies its independent createControlCommandJournal.
 */
export function createCandidateRetirementExecutor({ instanceId, getState, journal, adapter, clock = Date.now, readTimeoutMs }) {
  invariant(ID.test(instanceId) && typeof getState === 'function' && ['prepare', 'lookup', 'begin', 'record'].every(key => typeof journal?.[key] === 'function') && typeof adapter?.terminate === 'function' && typeof adapter?.lookupCommand === 'function' && integer(readTimeoutMs) && readTimeoutMs > 0, 'RETIREMENT_EXECUTOR_CONFIG_INVALID');

  function request(input) {
    const { operationId, commandId, stepId, plan, authorization } = input;
    invariant(ID.test(operationId) && ID.test(commandId) && ID.test(stepId) && plan?.qualified === true && validSpec(plan.spec, instanceId) && plan.specDigest === digest(plan.spec), 'RETIREMENT_COMMAND_INVALID');
    return { operationId, commandId, stepId, spec: clone(plan.spec), authorization: clone(authorization) };
  }

  function adapterInput(command, row) {
    return { instanceId, operationId: command.operationId, commandId: command.commandId, stepId: command.stepId, specDigest: row.specDigest, authorization: clone(command.authorization), target: clone(row.spec.target), expectedRevision: row.spec.expectedRevision, expectedStateDigest: row.spec.expectedStateDigest, signal: 'SIGTERM', deadline: row.spec.deadline, budget: clone(row.spec.budget) };
  }

  function checkedResult(response, command, row) {
    invariant(object(response) && response.instanceId === instanceId && response.operationId === command.operationId && response.commandId === command.commandId && response.specDigest === row.specDigest && identity(response.target) && canonical(response.target) === canonical(row.spec.target), 'RETIREMENT_RESULT_IDENTITY_UNKNOWN');
    const base = { instanceId, operationId: command.operationId, commandId: command.commandId, specDigest: row.specDigest, target: clone(row.spec.target) };
    if (response.state === 'applied') {
      invariant(response.signal === 'SIGTERM' && response.forced === false && response.removed === false && response.volumesRemoved === false && response.normalExit === true && response.exit?.running === false && response.exit.hostPid === 0 && response.exit.oomKilled === false && [0, 143].includes(response.exit.exitCode), 'RETIREMENT_NORMAL_EXIT_UNCONFIRMED');
      return { state: 'applied', result: { ...base, signal: 'SIGTERM', forced: false, removed: false, volumesRemoved: false, normalExit: true, exit: { running: false, hostPid: 0, oomKilled: false, exitCode: response.exit.exitCode } } };
    }
    if (response.state === 'definitely-not-applied') {
      invariant(response.definitelyNotApplied === true, 'RETIREMENT_NOT_APPLIED_UNPROVEN');
      return { state: 'definitely-not-applied', result: { ...base, definitelyNotApplied: true } };
    }
    invariant(['unknown', 'pending'].includes(response.state), 'RETIREMENT_RESULT_UNKNOWN');
    return { state: 'unknown', result: { ...base, code: 'RETIREMENT_OUTCOME_UNKNOWN' } };
  }

  async function reconcileCommand(command, row) {
    if (['applied', 'planned', 'definitely-not-applied', 'blocked'].includes(row.state)) return row;
    try {
      const response = await bounded(signal => adapter.lookupCommand({ ...adapterInput(command, row), abortSignal: signal }), readTimeoutMs, 'RETIREMENT_LOOKUP_TIMEOUT');
      const result = checkedResult(response, command, row);
      return journal.record({ operationId: command.operationId, commandId: command.commandId, authorization: command.authorization, ...result });
    } catch (error) {
      return journal.record({ operationId: command.operationId, commandId: command.commandId, authorization: command.authorization, state: 'unknown', result: { code: safeCode(error) } });
    }
  }

  async function reconcile(input) {
    const command = request(input), row = journal.lookup(command);
    invariant(row && row.stepId === command.stepId && row.specDigest === digest(command.spec), 'RETIREMENT_COMMAND_NOT_FOUND_OR_CHANGED');
    return reconcileCommand(command, row);
  }

  async function execute(input) {
    const command = request(input);
    let row = journal.prepare(command);
    if (row.state === 'applied' || row.state === 'blocked') return row;
    if (row.state === 'executing' || row.state === 'unknown') return reconcileCommand(command, row);
    // Persist executing BEFORE any potentially mutating adapter call. A process
    // death from here onward requires result reconciliation, never blind retry.
    row = journal.begin(command);
    try {
      invariant(Number.isSafeInteger(row.createdAt), 'RETIREMENT_BUDGET_ORIGIN_UNKNOWN');
      const budgetDeadline = Math.min(row.spec.deadline, row.createdAt + row.spec.budget.maxDurationMs);
      const remaining = () => budgetDeadline - clock();
      const state = await bounded(signal => getState({ instanceId, target: clone(row.spec.target), command: { operationId: command.operationId, commandId: command.commandId, specDigest: row.specDigest }, abortSignal: signal }), Math.min(readTimeoutMs, remaining()), 'RETIREMENT_STATE_TIMEOUT');
      const qualified = planCandidateRetirement({ instanceId, target: row.spec.target, state, deadline: row.spec.deadline, budget: row.spec.budget, maxObservationAgeMs: row.spec.maxObservationAgeMs, now: clock() });
      if (!qualified.qualified || qualified.spec.expectedRevision !== row.spec.expectedRevision || qualified.spec.expectedStateDigest !== row.spec.expectedStateDigest) {
        return journal.record({ operationId: command.operationId, commandId: command.commandId, authorization: command.authorization, state: 'blocked', result: { code: qualified.reason || 'RETIREMENT_STATE_CAS_CHANGED', dispatched: false } });
      }
      const response = await bounded(signal => adapter.terminate({ ...adapterInput(command, row), abortSignal: signal }), remaining(), 'RETIREMENT_ADAPTER_TIMEOUT');
      const result = checkedResult(response, command, row);
      return journal.record({ operationId: command.operationId, commandId: command.commandId, authorization: command.authorization, ...result });
    } catch (error) {
      // Aborting a request does NOT prove that the Supervisor did not apply it.
      return journal.record({ operationId: command.operationId, commandId: command.commandId, authorization: command.authorization, state: 'unknown', result: { code: safeCode(error) } });
    }
  }

  return { execute, reconcile };
}
