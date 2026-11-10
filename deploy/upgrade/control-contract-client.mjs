import { invariant, digest } from './trust.mjs';

/** Every contract mutation is addressed by its original durable business command.
 * Lookup may recover a lost ACK; it never repeats an irreversible mutation. */
export function createControlContractBusiness({ instanceId, business, authority, withCommandContext, clock = Date.now }) {
  invariant(typeof business?.contractBusiness === 'function' && authority && typeof withCommandContext === 'function', 'CONTROL_CONTRACT_BUSINESS_PORT_REQUIRED');
  let metadataTask = null;
  async function rpc(body, mutation = false) {
    const run = async () => {
      const receipt = await business.contractBusiness(body, { timeoutMs: mutation ? 5000 : 2000 });
      invariant(receipt?.instanceId === instanceId && receipt.action === body.action && Number.isFinite(Date.parse(receipt.completedAt)), 'CONTROL_CONTRACT_BUSINESS_RECEIPT_INVALID');
      return receipt.result;
    };
    if (!mutation) return run();
    const current = authority.observe();
    invariant(current.kind === 'contract' && current.operationId === body.contractAttemptId, 'CONTROL_CONTRACT_AUTHORITY_SCOPE_INVALID');
    authority.assert({ operationId: current.operationId, epoch: current.epoch, executorId: current.holderId, kind: 'contract' });
    return withCommandContext({ contractId: current.operationId, epoch: current.epoch }, run);
  }
  async function metadata(expandPlanDigest) {
    if (expandPlanDigest) return rpc({ action: 'metadata', expandPlanDigest });
    metadataTask ??= rpc({ action: 'metadata' }).finally(() => { metadataTask = null; });
    return metadataTask;
  }
  function verifyMutation(receipt, record, body) {
    const { receiptDigest, ...facts } = receipt ?? {};
    const specDigest = digest({ action: body.action, contractAttemptId: body.contractAttemptId, fence: body.fence, expectedSequence: body.expectedSequence, commandId: body.commandId, planDigest: record.plan.planDigest });
    const age = clock() - Date.parse(receipt?.observedAt);
    // A historical committed receipt may be old: it must still bind the exact
    // immutable command and is never used as a new physical qualification.
    invariant(receipt?.instanceId === instanceId && receipt.contractAttemptId === body.contractAttemptId && receipt.commandId === body.commandId && receipt.fence === body.fence && receipt.action === body.action && receipt.specDigest === specDigest && receiptDigest === digest(facts) && Number.isFinite(age) && age >= -1000, 'CONTROL_CONTRACT_COMMAND_RECEIPT_INVALID');
    return receipt.result;
  }
  async function mutate(action, record, commit) {
    const id = record.attempt.contractAttemptId, commandId = action === 'activate' ? id + ':activate' : id + ':clear:' + record.attempt.sequence;
    const body = { action, contractAttemptId: id, fence: record.fence, expectedSequence: record.attempt.sequence, commandId };
    let receipt;
    try { receipt = await rpc(body, true); }
    catch (error) {
      receipt = await rpc({ action: 'lookup', contractAttemptId: id, commandId }).catch(() => null);
      if (!receipt) throw Object.assign(Error('Contract command requires original-result reconciliation'), { code: 'CONTROL_CONTRACT_RESULT_UNKNOWN', cause: error });
    }
    const result = verifyMutation(receipt, record, body);
    if (action === 'activate') { invariant(Number.isSafeInteger(result?.totalRows) && result.totalRows >= 0, 'CONTROL_CONTRACT_COMMAND_RECEIPT_INVALID'); commit(result.totalRows); }
    else { invariant(Number.isSafeInteger(result?.cleared) && result.cleared >= 0 && typeof result.complete === 'boolean', 'CONTROL_CONTRACT_COMMAND_RECEIPT_INVALID'); commit(result); }
  }
  return {
    projectNameAuthoritative: async () => (await metadata()).projectNameAuthoritative,
    expandAttemptId: async expandPlanDigest => (await metadata(expandPlanDigest)).expandAttemptId,
    currentStartIdentity: async () => (await metadata()).currentStartIdentity,
    ownerRoutes: async () => (await metadata()).ownerRoutes,
    contractFacts: plan => rpc({ action: 'facts', plan }),
    budget: async plan => { const value = await rpc({ action: 'budget', plan }); invariant(value?.qualified === true, 'CONTROL_CONTRACT_BUDGET_UNKNOWN'); },
    activate: (record, commit) => mutate('activate', record, commit),
    clear: (record, commit) => mutate('clear', record, commit),
  };
}
