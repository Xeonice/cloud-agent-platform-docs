import { invariant, digest } from './trust.mjs';

/** A timeout never becomes a second mutation. Only a completed, scoped lookup
 * may prove the original command applied or definitely did not apply. */
export function createControlCommandExecutor({ journal, authorization, clock = Date.now }) {
  invariant(journal && typeof authorization === 'function', 'CONTROL_COMMAND_EXECUTOR_CONFIG_REQUIRED');
  const inFlight = new Map();
  async function execute(input) {
    const key = `${input.operationId}/${input.commandId}`;
    invariant(!inFlight.has(key), 'CONTROL_COMMAND_IN_FLIGHT');
    const running = Promise.resolve().then(() => perform(input)); inFlight.set(key, running);
    try { return await running; } finally { if (inFlight.get(key) === running) inFlight.delete(key); }
  }
  async function perform(input) {
    invariant(typeof input.invoke === 'function' && typeof input.inspect === 'function' && typeof input.classify === 'function', 'CONTROL_COMMAND_ADAPTER_REQUIRED');
    const base = { operationId: input.operationId, commandId: input.commandId }, getAuth = () => authorization(input);
    let row = journal.lookup(base);
    if (row) invariant(row.specDigest === digest(input.spec) && row.stepId === input.stepId, 'CONTROL_COMMAND_SPEC_CONFLICT');
    else row = journal.prepare({ ...base, stepId: input.stepId, spec: input.spec, authorization: getAuth() });
    if (row.state === 'applied') return row.result;
    invariant(row.state !== 'reconciled', 'CONTROL_COMMAND_RESOLVED_BY_RECOVERY');
    if (['executing', 'unknown', 'blocked'].includes(row.state)) {
      const receipt = await input.inspect({ ...base, specDigest: row.specDigest, spec: row.spec });
      const outcome = input.classify(receipt, { lookup: true, command: row });
      invariant(outcome && ['applied', 'definitely-not-applied', 'unknown', 'blocked'].includes(outcome.state), 'CONTROL_COMMAND_LOOKUP_INVALID');
      row = journal.record({ ...base, state: outcome.state, result: outcome.result ?? receipt, authorization: getAuth() });
      if (row.state === 'applied') return row.result;
      invariant(row.state === 'definitely-not-applied', 'CONTROL_COMMAND_RESULT_UNKNOWN');
    }
    invariant(row.spec.deadline > clock(), 'CONTROL_COMMAND_DEADLINE_EXPIRED');
    journal.begin({ ...base, authorization: getAuth() });
    try {
      const receipt = await input.invoke({ ...base, specDigest: row.specDigest, spec: row.spec });
      const outcome = input.classify(receipt, { lookup: false, command: row });
      invariant(outcome && ['applied', 'definitely-not-applied', 'unknown', 'blocked'].includes(outcome.state), 'CONTROL_COMMAND_RECEIPT_INVALID');
      row = journal.record({ ...base, state: outcome.state, result: outcome.result ?? receipt, authorization: getAuth() });
      invariant(row.state === 'applied', row.state === 'definitely-not-applied' ? 'CONTROL_COMMAND_NOT_APPLIED' : 'CONTROL_COMMAND_RESULT_UNKNOWN');
      return row.result;
    } catch (error) {
      // If another epoch already fenced us, the executing row remains for that
      // epoch to reconcile. No stale executor can replace the result with a guess.
      if (journal.lookup(base)?.state === 'executing') {
        try { journal.record({ ...base, state: 'unknown', result: { code: typeof error.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'CONTROL_COMMAND_ACK_UNKNOWN' }, authorization: getAuth() }); } catch { /* fenced; preserved as executing */ }
      }
      throw error;
    }
  }
  return { execute, activeCount: () => inFlight.size };
}
