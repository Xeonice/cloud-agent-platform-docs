import { invariant } from './trust.mjs';
const id = value => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,200}$/.test(value);

/** Independent deployment authority; never grants the business writer lease. */
export function createControlAuthority({ sqlite, instanceId, epochFloor = 0, clock = Date.now, validateRecovery, validateGrant }) {
  invariant(sqlite && id(instanceId) && Number.isSafeInteger(epochFloor) && epochFloor >= 0, 'CONTROL_AUTHORITY_CONFIG_INVALID');
  sqlite.exec(`CREATE TABLE IF NOT EXISTS control_authority (
    instance_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, operation_id TEXT,
    kind TEXT, holder_id TEXT, lease_expires_at INTEGER NOT NULL,
    mode TEXT NOT NULL, revision INTEGER NOT NULL, source_binding_digest TEXT,
    updated_at INTEGER NOT NULL
  )`);
  if (!sqlite.prepare('SELECT 1 FROM control_authority WHERE instance_id=?').get(instanceId))
    sqlite.prepare("INSERT INTO control_authority VALUES(?,?,NULL,NULL,NULL,0,'passive',1,NULL,?)").run(instanceId, epochFloor, clock());
  function observe() {
    const row = sqlite.prepare('SELECT * FROM control_authority WHERE instance_id=?').get(instanceId);
    invariant(row && ['passive', 'active'].includes(row.mode) && Number.isSafeInteger(row.epoch) && row.epoch >= epochFloor, 'CONTROL_AUTHORITY_STATE_UNKNOWN');
    return { instanceId, epoch: row.epoch, operationId: row.operation_id, kind: row.kind, holderId: row.holder_id,
      leaseExpiresAt: row.lease_expires_at, mode: row.mode, revision: row.revision, sourceBindingDigest: row.source_binding_digest, updatedAt: row.updated_at };
  }
  function activate({ expectedRevision, sourceBindingDigest }) {
    invariant(/^sha256:[a-f0-9]{64}$/.test(sourceBindingDigest), 'CONTROL_MIGRATION_PROOF_REQUIRED');
    return sqlite.transaction(() => {
      const old = observe();
      invariant(old.revision === expectedRevision && old.mode === 'passive' && old.holderId === null, 'CONTROL_ACTIVATION_PRECONDITION_CHANGED');
      sqlite.prepare("UPDATE control_authority SET mode='active',source_binding_digest=?,revision=revision+1,updated_at=? WHERE instance_id=?")
        .run(sourceBindingDigest, clock(), instanceId);
      return observe();
    }).immediate();
  }
  function assert(input) {
    const current = observe();
    invariant(current.mode === 'active' && current.leaseExpiresAt > clock() && current.epoch === input.epoch && current.operationId === input.operationId && (!input.executorId || input.executorId === current.holderId) && (!input.kind || input.kind === current.kind), 'CONTROL_AUTHORITY_EXPIRED_OR_SUPERSEDED');
    return current;
  }
  function grant({ operationId, epoch, executorId, leaseMs = 15000, kind = 'upgrade', supersedes = null }) {
    invariant(id(operationId) && id(executorId) && Number.isSafeInteger(epoch) && epoch > 0 && ['upgrade', 'recovery', 'maintenance', 'contract'].includes(kind) && Number.isSafeInteger(leaseMs) && leaseMs >= 500 && leaseMs <= 120000, 'CONTROL_AUTHORITY_CLAIM_INVALID');
    return sqlite.transaction(() => {
      if(validateGrant) {
        invariant(typeof validateGrant==='function','CONTROL_AUTHORITY_GRANT_GUARD_REQUIRED');
        const checked=validateGrant({operationId,epoch,executorId,leaseMs,kind,supersedes});
        invariant(!checked||typeof checked.then!=='function','CONTROL_AUTHORITY_GRANT_CHECK_MUST_BE_SYNCHRONOUS');
      }
      const old = observe(), now = clock();
      invariant(old.mode === 'active' && epoch >= old.epoch, 'CONTROL_AUTHORITY_NOT_ACTIVE');
      if (epoch === old.epoch) {
        invariant(old.operationId === operationId && old.holderId === executorId && old.kind === kind && old.leaseExpiresAt > now, 'CONTROL_AUTHORITY_STALE_EPOCH');
      } else if (old.leaseExpiresAt > now && old.holderId !== null) {
        invariant(kind === 'recovery' && supersedes === old.operationId && typeof validateRecovery === 'function', 'CONTROL_AUTHORITY_BUSY');
      }
      if (kind === 'recovery') {
        invariant(typeof validateRecovery === 'function', 'CONTROL_RECOVERY_INTENT_REQUIRED');
        const checked = validateRecovery({ operationId, supersedes, epoch, executorId });
        invariant(!checked || typeof checked.then !== 'function', 'CONTROL_RECOVERY_CHECK_MUST_BE_SYNCHRONOUS');
      }
      sqlite.prepare('UPDATE control_authority SET epoch=?,operation_id=?,kind=?,holder_id=?,lease_expires_at=?,revision=revision+1,updated_at=? WHERE instance_id=?')
        .run(epoch, operationId, kind, executorId, now + leaseMs, now, instanceId);
      return observe();
    }).immediate();
  }
  function renew({ operationId, epoch, executorId, leaseMs = 30000 }) {
    invariant(Number.isSafeInteger(leaseMs) && leaseMs >= 500 && leaseMs <= 120000, 'CONTROL_AUTHORITY_LEASE_INVALID');
    return sqlite.transaction(() => {
      assert({ operationId, epoch, executorId });
      sqlite.prepare('UPDATE control_authority SET lease_expires_at=?,updated_at=? WHERE instance_id=?').run(clock() + leaseMs, clock(), instanceId);
      return observe();
    }).immediate();
  }
  function release(input) {
    return sqlite.transaction(() => {
      assert(input);
      sqlite.prepare('UPDATE control_authority SET holder_id=NULL,lease_expires_at=0,revision=revision+1,updated_at=? WHERE instance_id=?').run(clock(), instanceId);
      return observe();
    }).immediate();
  }
  return { observe, activate, assert, grant, renew, release };
}
