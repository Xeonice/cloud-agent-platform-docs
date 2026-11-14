import { invariant, digest, canonical } from './trust.mjs';

const ID = /^[a-zA-Z0-9._:-]{1,200}$/;
const STATES = new Set(['planned', 'executing', 'applied', 'definitely-not-applied', 'unknown', 'blocked', 'reconciled']);
const HASH = /^sha256:[a-f0-9]{64}$/;

/** One local control ledger. It owns no business DB or execution capability. */
export function createControlCommandJournal({ sqlite, instanceId, assertAuthority, verifyRecoveryConfirmation, clock = Date.now, maxSpecBytes = 16384, maxResultBytes = 65536 }) {
  invariant(sqlite && ID.test(instanceId) && typeof assertAuthority === 'function', 'CONTROL_JOURNAL_CONFIG_REQUIRED');
  sqlite.exec(`CREATE TABLE IF NOT EXISTS control_commands (
    instance_id TEXT NOT NULL, operation_id TEXT NOT NULL, command_id TEXT NOT NULL,
    step_id TEXT NOT NULL, spec TEXT NOT NULL, spec_digest TEXT NOT NULL,
    state TEXT NOT NULL, epoch INTEGER NOT NULL, executor_id TEXT NOT NULL,
    result TEXT, result_digest TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(instance_id,operation_id,command_id)
  ); CREATE INDEX IF NOT EXISTS control_commands_pending ON control_commands(instance_id,state,updated_at);`);
  function key(input) {
    invariant(ID.test(input.operationId) && ID.test(input.commandId), 'CONTROL_COMMAND_ID_INVALID');
    return [instanceId, input.operationId, input.commandId];
  }
  function authorize(input, journalAction) {
    const a = input.authorization, now = clock();
    invariant(a && Number.isSafeInteger(a.epoch) && a.epoch > 0 && ID.test(a.executorId) && Number.isFinite(a.expiresAt) && a.expiresAt > now, 'CONTROL_COMMAND_AUTHORITY_EXPIRED');
    const checked = assertAuthority(a, { ...input, journalAction });
    invariant(!checked || typeof checked.then !== 'function', 'CONTROL_AUTHORITY_CHECK_MUST_BE_SYNCHRONOUS');
    return a;
  }
  function decode(row) {
    if (!row) return null;
    invariant(STATES.has(row.state) && digest(JSON.parse(row.spec)) === row.spec_digest, 'CONTROL_COMMAND_JOURNAL_CORRUPT');
    invariant(row.result === null || digest(JSON.parse(row.result)) === row.result_digest, 'CONTROL_COMMAND_RESULT_CORRUPT');
    return { instanceId: row.instance_id, operationId: row.operation_id, commandId: row.command_id, stepId: row.step_id,
      spec: JSON.parse(row.spec), specDigest: row.spec_digest, state: row.state, epoch: row.epoch, executorId: row.executor_id,
      result: row.result === null ? null : JSON.parse(row.result), createdAt: row.created_at, updatedAt: row.updated_at };
  }
  function lookup(input) {
    return decode(sqlite.prepare('SELECT * FROM control_commands WHERE instance_id=? AND operation_id=? AND command_id=?').get(...key(input)));
  }
  function prepare(input) {
    key(input);
    invariant(ID.test(input.stepId) && input.spec && typeof input.spec === 'object' && !Array.isArray(input.spec), 'CONTROL_COMMAND_SPEC_REQUIRED');
    const spec = canonical(input.spec), specDigest = digest(input.spec);
    invariant(Buffer.byteLength(spec) <= maxSpecBytes && Number.isFinite(input.spec.deadline), 'CONTROL_COMMAND_SPEC_INVALID_OR_TOO_LARGE');
    return sqlite.transaction(() => {
      const a = authorize(input, 'prepare'), prior = lookup(input);
      if (prior) {
        invariant(prior.specDigest === specDigest && prior.stepId === input.stepId, 'CONTROL_COMMAND_SPEC_CONFLICT');
        return prior;
      }
      const now = clock();
      invariant(input.spec.deadline > now, 'CONTROL_COMMAND_DEADLINE_EXPIRED');
      sqlite.prepare('INSERT INTO control_commands VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(...key(input), input.stepId, spec, specDigest, 'planned', a.epoch, a.executorId, null, null, now, now);
      return lookup(input);
    }).immediate();
  }
  function begin(input) {
    return sqlite.transaction(() => {
      const a = authorize(input, 'begin'), row = lookup(input);
      invariant(row, 'CONTROL_COMMAND_NOT_FOUND');
      invariant(row.spec.deadline > clock(), 'CONTROL_COMMAND_DEADLINE_EXPIRED');
      invariant(['planned', 'definitely-not-applied'].includes(row.state), 'CONTROL_COMMAND_RECONCILIATION_REQUIRED');
      invariant(a.epoch >= row.epoch, 'CONTROL_COMMAND_STALE_EPOCH');
      sqlite.prepare("UPDATE control_commands SET state='executing',epoch=?,executor_id=?,updated_at=? WHERE instance_id=? AND operation_id=? AND command_id=?")
        .run(a.epoch, a.executorId, clock(), ...key(input));
      return lookup(input);
    }).immediate();
  }
  function record(input) {
    invariant(['applied', 'definitely-not-applied', 'unknown', 'blocked'].includes(input.state), 'CONTROL_COMMAND_RESULT_STATE_INVALID');
    const result = canonical(input.result ?? null), resultDigest = digest(input.result ?? null);
    invariant(Buffer.byteLength(result) <= maxResultBytes, 'CONTROL_COMMAND_RESULT_TOO_LARGE');
    return sqlite.transaction(() => {
      const a = authorize(input, 'record'), row = lookup(input);
      invariant(row && a.epoch >= row.epoch, 'CONTROL_COMMAND_STALE_OR_MISSING');
      if (row.state === 'applied') {
        invariant(input.state === 'applied' && digest(row.result) === resultDigest, 'CONTROL_COMMAND_ALREADY_APPLIED');
        return row;
      }
      invariant(row.state !== 'reconciled', 'CONTROL_COMMAND_RESOLVED_BY_RECOVERY');
      invariant(row.state !== 'planned', 'CONTROL_COMMAND_NOT_STARTED');
      sqlite.prepare('UPDATE control_commands SET state=?,epoch=?,executor_id=?,result=?,result_digest=?,updated_at=? WHERE instance_id=? AND operation_id=? AND command_id=?')
        .run(input.state, a.epoch, a.executorId, result, resultDigest, clock(), ...key(input));
      return lookup(input);
    }).immediate();
  }
  function reconcile(input) {
    invariant(ID.test(input.recoveryId) && HASH.test(input.confirmationReceiptDigest) && typeof verifyRecoveryConfirmation === 'function', 'CONTROL_RECOVERY_CONFIRMATION_REQUIRED');
    return sqlite.transaction(() => {
      const a = authorize(input, 'reconcile'), row = lookup(input);
      invariant(row && a.kind === 'recovery' && a.operationId === input.recoveryId && a.epoch >= row.epoch, 'CONTROL_RECOVERY_COMMAND_SCOPE_INVALID');
      const proof = verifyRecoveryConfirmation({ ...input, command: row });
      invariant(proof && typeof proof.then !== 'function', 'CONTROL_RECOVERY_CONFIRMATION_MUST_BE_SYNCHRONOUS');
      const { receiptDigest, ...facts } = proof;
      invariant(proof.qualified === true && proof.instanceId === instanceId && proof.recoveryId === input.recoveryId && proof.epoch === a.epoch &&
        proof.triggeringAttemptId === row.operationId && receiptDigest === input.confirmationReceiptDigest && digest(facts) === receiptDigest &&
        Array.isArray(proof.closedUnknownCommands) && proof.closedUnknownCommands.length <= 100, 'CONTROL_RECOVERY_CONFIRMATION_SCOPE_INVALID');
      const matches = proof.closedUnknownCommands.filter(item => item.operationId === row.operationId && item.commandId === row.commandId && item.specDigest === row.specDigest);
      const closure = matches[0];
      invariant(matches.length === 1 && row.spec.method === 'coordinatorHandoff' && ['prepare', 'quiesce'].includes(row.spec.body?.action) &&
        closure.method === row.spec.method && closure.action === row.spec.body.action && ['prepared', 'quiesced'].includes(closure.stage) &&
        closure.actualRunning === false && closure.admissionClosed === true && closure.participantState === 'settled' && HASH.test(closure.participantReceiptDigest) &&
        canonical(closure.participant) === canonical(row.spec.participant), 'CONTROL_RECOVERY_COMMAND_CLOSURE_INVALID');
      const result = { originalOutcome: 'unknown', recoveryId: input.recoveryId, confirmationReceiptDigest: receiptDigest };
      if (row.state === 'reconciled') {
        invariant(canonical(row.result) === canonical(result), 'CONTROL_COMMAND_RECOVERY_CONFLICT'); return row;
      }
      invariant(['executing', 'unknown'].includes(row.state), 'CONTROL_COMMAND_NOT_UNKNOWN');
      const encoded = canonical(result);
      sqlite.prepare("UPDATE control_commands SET state='reconciled',epoch=?,executor_id=?,result=?,result_digest=?,updated_at=? WHERE instance_id=? AND operation_id=? AND command_id=?")
        .run(a.epoch, a.executorId, encoded, digest(result), clock(), ...key(input));
      return lookup(input);
    }).immediate();
  }
  function pending() {
    return sqlite.prepare("SELECT operation_id AS operationId,command_id AS commandId,step_id AS stepId,state,epoch,updated_at AS updatedAt FROM control_commands WHERE instance_id=? AND state IN ('executing','unknown','blocked') ORDER BY updated_at,command_id LIMIT 101").all(instanceId);
  }
  return { prepare, lookup, begin, record, reconcile, pending };
}
