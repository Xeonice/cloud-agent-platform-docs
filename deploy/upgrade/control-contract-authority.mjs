import { randomUUID } from 'node:crypto';
import { invariant } from './trust.mjs';
const ACTIVE = new Set(['accepted', 'retiring-readers', 'authority-active', 'clearing']);
export function createControlContractAuthority({ sqlite, instanceId, authority, contracts, participants, clock = Date.now, executorId = `contract-${randomUUID()}` }) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS control_contract_authority(
    contract_attempt_id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,intent_fence INTEGER NOT NULL,
    epoch INTEGER NOT NULL,executor_id TEXT NOT NULL,sequence INTEGER NOT NULL,claimed_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`);
  let renewing = false, closed = false;
  function current(record) {
    const row = sqlite.prepare('SELECT * FROM control_contract_authority WHERE contract_attempt_id=? AND instance_id=?').get(record.attempt.contractAttemptId, instanceId);
    invariant(row?.intent_fence === record.fence, 'CONTROL_CONTRACT_SCOPE_CHANGED');
    return authority.assert({ operationId: record.attempt.contractAttemptId, epoch: row.epoch, executorId: row.executor_id, kind: 'contract' });
  }
  function claim(record) {
    invariant(record.attempt.instanceId === instanceId && ACTIVE.has(record.attempt.state), 'CONTROL_CONTRACT_INTENT_NOT_ACTIVE');
    return sqlite.transaction(() => {
      const old = authority.observe(), id = record.attempt.contractAttemptId;
      if (old.kind === 'contract' && old.operationId === id && old.holderId === executorId && old.leaseExpiresAt > clock()) return authority.renew({ operationId: id, epoch: old.epoch, executorId, leaseMs: 30000 });
      invariant(!old.holderId || old.leaseExpiresAt <= clock(), 'CONTROL_AUTHORITY_BUSY');
      const binding = sqlite.prepare('SELECT * FROM control_contract_authority WHERE contract_attempt_id=? AND instance_id=?').get(id, instanceId);
      invariant(!binding || binding.intent_fence === record.fence, 'CONTROL_CONTRACT_INTENT_FENCE_CHANGED');
      const epoch = Math.max(old.epoch + 1, record.fence), now = clock();
      authority.grant({ operationId: id, epoch, executorId, leaseMs: 30000, kind: 'contract' });
      sqlite.prepare('INSERT INTO control_contract_authority VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(contract_attempt_id) DO UPDATE SET epoch=excluded.epoch,executor_id=excluded.executor_id,sequence=control_contract_authority.sequence+1,claimed_at=excluded.claimed_at,updated_at=excluded.updated_at')
        .run(id, instanceId, record.fence, epoch, executorId, now, now);
      return authority.observe();
    }).immediate();
  }
  async function ensure(record) {
    invariant(!closed, 'CONTROL_CONTRACT_EXECUTOR_STOPPED');
    const granted = claim(record);
    await participants.admit(granted, { attemptId: record.attempt.contractAttemptId, intentFence: record.fence });
    return current(record);
  }
  const timer = setInterval(() => {
    if (closed || renewing) return;
    const grant = authority.observe();
    if (grant.kind !== 'contract' || grant.holderId !== executorId || grant.leaseExpiresAt <= clock()) return;
    renewing = true;
    try {
      const record = contracts.snapshot(grant.operationId);
      if (ACTIVE.has(record.attempt.state)) authority.renew({ operationId: grant.operationId, epoch: grant.epoch, executorId, leaseMs: 30000 });
      else authority.release({ operationId: grant.operationId, epoch: grant.epoch, executorId });
    } catch { /* Expired/superseded authority is never resurrected by this timer. */ }
    finally { renewing = false; }
  }, 1000); timer.unref();
  return { ensure, current, executorId, close() { closed = true; clearInterval(timer); } };
}
