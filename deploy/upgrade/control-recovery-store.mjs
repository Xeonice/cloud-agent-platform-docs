import { randomUUID } from 'node:crypto';
import { invariant, canonical, digest } from './trust.mjs';
const PHASES = new Set(['created', 'reconciling', 'restoring', 'verifying', 'recovered', 'blocked']);
const NEXT = { created: ['reconciling', 'blocked'], reconciling: ['restoring', 'blocked'], restoring: ['verifying', 'blocked'], verifying: ['recovered', 'blocked'], recovered: [], blocked: [] };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/** Independent recovery intent. Original upgrade success/failure rows are immutable here. */
export function createControlRecoveryStore({ sqlite, instanceId, clock = Date.now }) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS control_recovery_intents (
    recovery_id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,triggering_attempt_id TEXT NOT NULL,
    triggering_operation_id TEXT,authorization_plan TEXT NOT NULL,authorization_digest TEXT NOT NULL,
    plan TEXT,plan_digest TEXT,phase TEXT NOT NULL,epoch INTEGER NOT NULL,sequence INTEGER NOT NULL,
    reason TEXT NOT NULL,deadline INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
    confirmed_at INTEGER,diagnostic_id TEXT
  ); CREATE UNIQUE INDEX IF NOT EXISTS control_recovery_one_active ON control_recovery_intents(instance_id)
    WHERE phase IN ('created','reconciling','restoring','verifying');`);
  function read(recoveryId) {
    const row = sqlite.prepare('SELECT * FROM control_recovery_intents WHERE recovery_id=? AND instance_id=?').get(recoveryId, instanceId);
    if (!row) return null;
    invariant(PHASES.has(row.phase) && digest(JSON.parse(row.authorization_plan)) === row.authorization_digest && (row.plan === null || digest(withoutPlanDigest(JSON.parse(row.plan))) === row.plan_digest), 'CONTROL_RECOVERY_JOURNAL_CORRUPT');
    return { recoveryId: row.recovery_id, instanceId: row.instance_id, triggeringAttemptId: row.triggering_attempt_id,
      triggeringOperationId: row.triggering_operation_id, authorizationPlan: JSON.parse(row.authorization_plan), authorizationDigest: row.authorization_digest,
      plan: row.plan === null ? null : JSON.parse(row.plan), planDigest: row.plan_digest, phase: row.phase, epoch: row.epoch, sequence: row.sequence,
      reason: row.reason, deadline: row.deadline, createdAt: row.created_at, updatedAt: row.updated_at, confirmedAt: row.confirmed_at, diagnosticId: row.diagnostic_id };
  }
  function active() {
    const row = sqlite.prepare("SELECT recovery_id FROM control_recovery_intents WHERE instance_id=? AND phase IN ('created','reconciling','restoring','verifying') ORDER BY created_at DESC LIMIT 1").get(instanceId);
    return row ? read(row.recovery_id) : null;
  }
  function latest(attemptId) {
    const row = sqlite.prepare('SELECT recovery_id FROM control_recovery_intents WHERE instance_id=? AND triggering_attempt_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(instanceId, attemptId);
    return row ? read(row.recovery_id) : null;
  }
  function create({ recoveryId = randomUUID(), triggeringAttemptId, triggeringOperationId = null, authorizationPlan, reason, deadline }) {
    invariant(UUID.test(recoveryId) && UUID.test(triggeringAttemptId) && authorizationPlan && typeof authorizationPlan === 'object' && typeof reason === 'string' && reason.length <= 200 && deadline > clock() && Number.isSafeInteger(deadline), 'CONTROL_RECOVERY_INTENT_INVALID');
    const serialized = canonical(authorizationPlan), hash = digest(authorizationPlan);
    invariant(Buffer.byteLength(serialized) <= 262144, 'CONTROL_RECOVERY_AUTHORIZATION_TOO_LARGE');
    return sqlite.transaction(() => {
      const old = read(recoveryId);
      if (old) { invariant(old.authorizationDigest === hash && old.triggeringAttemptId === triggeringAttemptId && old.deadline === deadline && old.triggeringOperationId === triggeringOperationId, 'CONTROL_RECOVERY_INTENT_CONFLICT'); return old; }
      invariant(active() === null, 'CONTROL_RECOVERY_ALREADY_ACTIVE');
      const now = clock();
      sqlite.prepare("INSERT INTO control_recovery_intents VALUES(?,?,?,?,?,?,NULL,NULL,'created',0,0,?,?,?,?,NULL,NULL)")
        .run(recoveryId, instanceId, triggeringAttemptId, triggeringOperationId, serialized, hash, reason, deadline, now, now);
      return read(recoveryId);
    }).immediate();
  }
  function claim({ recoveryId, epoch }) {
    return sqlite.transaction(() => {
      const old = read(recoveryId);
      invariant(old && !['blocked', 'recovered'].includes(old.phase) && old.deadline > clock() && Number.isSafeInteger(epoch) && epoch > old.epoch, 'CONTROL_RECOVERY_CLAIM_INVALID');
      sqlite.prepare('UPDATE control_recovery_intents SET epoch=?,sequence=sequence+1,updated_at=? WHERE recovery_id=? AND instance_id=?').run(epoch, clock(), recoveryId, instanceId);
      return read(recoveryId);
    }).immediate();
  }
  function freezePlan({ recoveryId, epoch, plan, qualifies }) {
    const original = withoutPlanDigest(plan), hash = digest(original);
    invariant(plan?.planDigest === hash && Buffer.byteLength(canonical(plan)) <= 262144 && typeof qualifies === 'function', 'CONTROL_RECOVERY_PLAN_INVALID');
    return sqlite.transaction(() => {
      const old = read(recoveryId);
      invariant(old && old.epoch === epoch && old.deadline > clock() && old.phase === 'reconciling' && plan.triggeringAttemptId === old.triggeringAttemptId, 'CONTROL_RECOVERY_PLAN_SCOPE_CHANGED');
      invariant(qualifies(old.authorizationPlan, plan) === true, 'CONTROL_RECOVERY_PLAN_UNQUALIFIED');
      invariant(old.planDigest === null || old.planDigest === hash, 'CONTROL_RECOVERY_PLAN_IMMUTABLE');
      sqlite.prepare('UPDATE control_recovery_intents SET plan=?,plan_digest=?,sequence=sequence+1,updated_at=? WHERE recovery_id=? AND instance_id=?').run(canonical(plan), hash, clock(), recoveryId, instanceId);
      return read(recoveryId);
    }).immediate();
  }
  function transition({ recoveryId, epoch, expectedSequence, phase, reason, diagnosticId = null, confirmation = null }) {
    invariant(PHASES.has(phase), 'CONTROL_RECOVERY_PHASE_INVALID');
    return sqlite.transaction(() => {
      const old = read(recoveryId);
      invariant(old && old.epoch === epoch && old.sequence === expectedSequence && NEXT[old.phase].includes(phase), 'CONTROL_RECOVERY_TRANSITION_CONFLICT');
      if (phase !== 'blocked') invariant(old.deadline > clock(), 'CONTROL_RECOVERY_DEADLINE_EXPIRED');
      if (phase === 'restoring') invariant(old.plan !== null, 'CONTROL_RECOVERY_FIXED_PLAN_REQUIRED');
      if (phase === 'recovered') invariant(confirmation?.qualified === true && confirmation.recoveryId === recoveryId && confirmation.epoch === epoch && /^sha256:[a-f0-9]{64}$/.test(confirmation.receiptDigest), 'CONTROL_RECOVERY_CONFIRMATION_REQUIRED');
      const now = clock();
      sqlite.prepare('UPDATE control_recovery_intents SET phase=?,reason=?,diagnostic_id=?,confirmed_at=?,sequence=sequence+1,updated_at=? WHERE recovery_id=? AND instance_id=?')
        .run(phase, reason ?? old.reason, diagnosticId ?? old.diagnosticId, phase === 'recovered' ? now : null, now, recoveryId, instanceId);
      return read(recoveryId);
    }).immediate();
  }
  function view(record) {
    if (!record) return null;
    return { recoveryAttemptId: record.recoveryId, triggeringAttemptId: record.triggeringAttemptId, generation: record.epoch, sequence: record.sequence,
      state: record.phase === 'recovered' ? 'recovery-confirmed' : record.phase === 'blocked' ? 'failed' : 'recovering',
      // Public correlation binds the immutable authorization scope from creation.
      // The later qualified execution plan has its own private planDigest.
      planDigest: record.authorizationDigest, reason: record.reason, observedAt: new Date(record.updatedAt).toISOString(), phase: record.phase,
      confirmedAt: record.confirmedAt === null ? null : new Date(record.confirmedAt).toISOString(),
      ...(record.triggeringOperationId ? { triggeringOperationId: record.triggeringOperationId } : {}), ...(record.diagnosticId ? { diagnosticId: record.diagnosticId } : {}) };
  }
  return { create, read, active, latest, claim, freezePlan, transition, view };
}
function withoutPlanDigest(plan) { const result = { ...plan }; delete result.planDigest; return result; }
