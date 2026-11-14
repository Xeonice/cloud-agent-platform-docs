import { invariant } from './trust.mjs';
import { entryControlHeaders } from './control-entry-context.mjs';

export function controlEnvelope(value) {
  return { schemaVersion: 1, epoch: value.epoch, operationId: value.operationId, executorId: value.holderId ?? value.executorId, kind: value.kind,
    ...(value.kind === 'recovery' ? { recoveryId: value.operationId } : {}) };
}
export function createControlParticipants({ instanceId, authority, entryOrigin, entryKey, entryControllerKey, supervisor, business, fetcher = fetch }) {
  invariant(authority && supervisor && business && entryKey?.length >= 32 && entryControllerKey?.length >= 32, 'CONTROL_PARTICIPANTS_CONFIG_INVALID');
  let tail = Promise.resolve();
  async function entry(path, body, context) {
    const response = await fetcher(entryOrigin + path, { method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-platform-internal-key': entryKey, ...(body ? entryControlHeaders({ key: entryControllerKey, context }) : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(2000), redirect: 'error' });
    let bytes = 0; const chunks = [];
    invariant(response.body, 'ENTRY_CONTROL_RECEIPT_UNKNOWN');
    for await (const chunk of response.body) { bytes += chunk.length; invariant(bytes <= 65536, 'ENTRY_CONTROL_RECEIPT_TOO_LARGE'); chunks.push(chunk); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok) throw Object.assign(Error('Entry rejected admission'), { code: result.code || 'ENTRY_CONTROL_REJECTED', status: response.status });
    return result;
  }
  function current(scope) {
    const value = authority.assert({ epoch: scope.epoch, operationId: scope.operationId, executorId: scope.executorId ?? scope.holderId, kind: scope.kind });
    return { ...value, executorId: value.holderId };
  }
  function same(actual, scope) { return actual?.instanceId === instanceId && actual.epoch === scope.epoch && actual.operationId === scope.operationId && actual.executorId === scope.executorId && actual.kind === scope.kind; }
  async function admitEntryOnce(scope) {
    scope = current(scope);
    const before = await entry('/control-epoch');
    invariant(before.instanceId === instanceId && Number.isSafeInteger(before.revision) && before.epoch <= scope.epoch, 'ENTRY_CONTROL_ADMISSION_CHANGED');
    if (same(before, scope) && before.leaseExpiresAt >= scope.leaseExpiresAt) return before;
    const request = { instanceId, expectedRevision: before.revision, epoch: scope.epoch, operationId: scope.operationId, executorId: scope.executorId,
      kind: scope.kind, leaseExpiresAt: scope.leaseExpiresAt, ...(scope.kind === 'recovery' ? { recoveryId: scope.operationId } : {}) };
    try {
      const applied = await entry('/control-epoch', request, controlEnvelope(scope));
      invariant(same(applied, scope) && applied.leaseExpiresAt >= request.leaseExpiresAt, 'ENTRY_CONTROL_ADMISSION_UNKNOWN'); return applied;
    } catch (error) {
      // An ambiguous ACK is resolved with the original epoch/identity. It is
      // never translated into another POST carrying a new revision.
      const actual = await entry('/control-epoch').catch(() => null);
      if (same(actual, scope) && actual.leaseExpiresAt >= request.leaseExpiresAt) return actual;
      throw error;
    }
  }
  async function admitEntry(scope) {
    const deadline = Math.min(Date.now() + 2000, scope.leaseExpiresAt ?? Infinity);
    while (true) {
      try { return await admitEntryOnce(scope); }
      catch (error) {
        // A completed busy rejection proves this admission did not start. The
        // same identity/epoch may retry after rereading the original local CAS;
        // a lost/timeout acknowledgement is never retried here.
        if (error.status !== 409 || error.code !== 'ENTRY_BUSY_OR_METHOD' || Date.now() + 25 >= deadline) throw error;
        current(scope); await new Promise(ok => setTimeout(ok, 25));
      }
    }
  }
  function serialize(work) { const next = tail.then(work); tail = next.catch(() => {}); return next; }
  async function admit(scope, { attemptId, intentFence, businessWriter = false } = {}) {
    return serialize(async () => {
      scope = current(scope);
      const admittedEntry = await admitEntry(scope);
      const admittedSupervisor = await supervisor.admitControl({ epoch: scope.epoch, operationId: scope.operationId, executorId: scope.executorId });
      invariant(admittedSupervisor.instanceId === instanceId && admittedSupervisor.epoch === scope.epoch && admittedSupervisor.operationId === scope.operationId && admittedSupervisor.executorId === scope.executorId && admittedSupervisor.admitted === true, 'SUPERVISOR_CONTROL_ADMISSION_UNKNOWN');
      if (scope.kind === 'upgrade') {
        invariant(attemptId === scope.operationId && intentFence === scope.epoch, 'UPGRADE_PARTICIPANT_SCOPE_INVALID');
        await entry('/fence', { instanceId, attemptId, fence: intentFence }, controlEnvelope(scope));
      } else if (scope.kind === 'contract') {
        invariant(attemptId === scope.operationId && Number.isSafeInteger(intentFence) && intentFence > 0, 'CONTRACT_PARTICIPANT_SCOPE_INVALID');
        await entry('/contract-fence', { instanceId, contractAttemptId: attemptId, fence: intentFence }, controlEnvelope(scope));
      } else if (scope.kind === 'recovery' && businessWriter) {
        const admittedBusiness = await business.recoveryAdmission(attemptId, { fence: scope.epoch });
        invariant(admittedBusiness?.instanceId === instanceId && admittedBusiness.recoveryId === scope.operationId && admittedBusiness.triggeringAttemptId === attemptId && admittedBusiness.epoch === scope.epoch && admittedBusiness.admitted === true, 'BUSINESS_RECOVERY_ADMISSION_UNKNOWN');
      }
      current(scope);
      return { instanceId, epoch: scope.epoch, operationId: scope.operationId, admitted: true, entryRevision: admittedEntry.revision };
    });
  }
  return { admit, admitEntry: scope => serialize(() => admitEntry(scope)), entry };
}
