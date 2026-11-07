import { isAbsolute } from 'node:path';
import { canonical, digest, DIGEST, invariant } from './trust.mjs';
import { validateBinding } from './stable-entry.mjs';
import { persistedEntryBinding } from './control-entry-context.mjs';
import { createControlCommandExecutor } from './control-command-executor.mjs';

const ID = /^[a-zA-Z0-9._:-]{1,200}$/;
const fields = ['schemaVersion', 'kind', 'instanceId', 'operationId', 'commandId', 'epoch', 'executorId', 'deadline',
  'entry', 'before', 'after', 'gateway', 'business', 'controlPackageDigest', 'settlementReceiptDigest', 'custodyReceiptDigest'];
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
const keys = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(k => Object.hasOwn(value, k));
const same = (a, b) => canonical(a) === canonical(b);
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child);Object.freeze(value); }
  return value;
};
function snapshot(value) {
  let copy;
  try { copy = JSON.parse(canonical(structuredClone(value))); }
  catch { invariant(false, 'LEGACY_ENTRY_SPEC_INVALID'); }
  return freeze(copy);
}
function origin(value) {
  let url;
  try { url = new URL(value); } catch { invariant(false, 'LEGACY_ENTRY_LOOPBACK_REQUIRED'); }
  invariant(typeof value === 'string' && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    url.origin === value && !url.username && !url.password, 'LEGACY_ENTRY_LOOPBACK_REQUIRED');
  return value;
}
function runtime(value, instanceId) {
  invariant(object(value) && !Object.hasOwn(value, 'observedAt') && value.instanceId === instanceId && value.role === 'gateway' &&
    Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.startIdentity === 'string' && value.startIdentity.length > 0 &&
    typeof value.programRoot === 'string' && isAbsolute(value.programRoot) && DIGEST.test(value.artifactDigest ?? '') &&
    DIGEST.test(value.inputFingerprint ?? '') && Number.isFinite(Date.parse(value.loadedAt)) &&
    keys(value.protocol, ['min', 'max']) && Number.isSafeInteger(value.protocol.min) && value.protocol.min > 0 &&
    Number.isSafeInteger(value.protocol.max) && value.protocol.max >= value.protocol.min &&
    value.independentFoundation === true && value.preservesExistingSockets === true, 'LEGACY_ENTRY_RUNTIME_ANCHOR_REQUIRED');
}
const servingApi = binding => binding.weight === 100 ? binding.candidateApi : binding.oldApi;

/** v1 delegates the API route only. Web resources and every original connection
 * remain owned by the historical Entry. There is no reverse/rollback command. */
export function validateLegacyEntryDelegation(value) {
  const spec = snapshot(value);
  invariant(keys(spec, fields) && spec.schemaVersion === 1 && spec.kind === 'legacy-entry-binding' &&
    ['instanceId', 'operationId', 'commandId', 'executorId'].every(k => ID.test(spec[k] ?? '')) &&
    Number.isSafeInteger(spec.epoch) && spec.epoch > 0 && Number.isSafeInteger(spec.deadline) && spec.deadline > 0 &&
    ['controlPackageDigest', 'settlementReceiptDigest', 'custodyReceiptDigest'].every(k => DIGEST.test(spec[k] ?? '')),
  'LEGACY_ENTRY_SPEC_INVALID');
  invariant(keys(spec.entry, ['controlOrigin', 'runtime']) && keys(spec.gateway, ['origin', 'controlOrigin', 'runtime']) &&
    keys(spec.business, ['releaseId', 'confirmedDigest', 'api']) && ID.test(spec.business.releaseId ?? '') &&
    DIGEST.test(spec.business.confirmedDigest ?? '') && keys(spec.business.api, ['origin', 'digest']) &&
    DIGEST.test(spec.business.api.digest ?? ''), 'LEGACY_ENTRY_SPEC_INVALID');
  for (const value of [spec.entry.controlOrigin, spec.gateway.origin, spec.gateway.controlOrigin, spec.business.api.origin]) origin(value);
  runtime(spec.entry.runtime, spec.instanceId);runtime(spec.gateway.runtime, spec.instanceId);
  invariant(spec.entry.controlOrigin !== spec.gateway.controlOrigin && spec.gateway.origin !== spec.business.api.origin &&
    spec.gateway.runtime.startIdentity !== spec.entry.runtime.startIdentity &&
    spec.gateway.runtime.artifactDigest !== spec.business.api.digest, 'LEGACY_ENTRY_GATEWAY_AND_BUSINESS_MUST_DIFFER');
  validateBinding(spec.before);validateBinding(spec.after);
  invariant(same(spec.before, persistedEntryBinding(spec.before)) && same(spec.after, persistedEntryBinding(spec.after)) &&
    spec.before.instanceId === spec.instanceId && [0, 100].includes(spec.before.weight) &&
    same(servingApi(spec.before), spec.business.api), 'LEGACY_ENTRY_SOURCE_BUSINESS_CHANGED');
  const expected = { ...spec.before, attemptId: spec.operationId, fence: spec.epoch,
    routeGeneration: spec.before.routeGeneration + 1, weight: 100,
    candidateApi: { origin: spec.gateway.origin, digest: spec.gateway.runtime.artifactDigest } };
  invariant(Number.isSafeInteger(expected.routeGeneration) && spec.epoch > spec.before.fence && same(spec.after, expected),
    'LEGACY_ENTRY_FIXED_API_DELEGATION_REQUIRED');
  return spec;
}

/** This adapter does NOT prove real custody, drain, settlement, a signed release
 * or adoption. assertDelegation is a mandatory synchronous trusted port for the
 * eventual actual API/runtime-closure producer. No boolean/default grant exists.
 *
 * The grant must contain exactly grantFacts(spec) below plus receiptDigest.
 * In particular, an executing command alone cannot authorize the old Entry's
 * payload-free checkOnly RPC. Exclusive old-key custody AND closed/settled old
 * actors must be independently established. The current API does not reopen that
 * old renew RPC. Isolated tests explicitly provide this not-yet-wired port.
 */
export function createLegacyEntryDelegationAdapter({ instanceId, authority, journal, entryKey, gatewayKey,
  assertDelegation, fetcher = fetch, clock = Date.now }) {
  invariant(ID.test(instanceId ?? '') && typeof authority?.assert === 'function' &&
    ['lookup', 'prepare', 'begin', 'record', 'pending'].every(k => typeof journal?.[k] === 'function') &&
    [entryKey, gatewayKey].every(k => typeof k === 'string' && k.length >= 32) &&
    typeof assertDelegation === 'function' && typeof fetcher === 'function' && typeof clock === 'function',
  'LEGACY_ENTRY_DELEGATION_CONFIG_REQUIRED');

  function grantFacts(spec) {
    return { schemaVersion: 1, kind: 'legacy-entry-delegation-grant', instanceId,
      operationId: spec.operationId, commandId: spec.commandId, epoch: spec.epoch, executorId: spec.executorId,
      specDigest: digest(spec), deadline: spec.deadline, controlPackageDigest: spec.controlPackageDigest,
      settlementReceiptDigest: spec.settlementReceiptDigest, custodyReceiptDigest: spec.custodyReceiptDigest,
      confirmedDigest: spec.business.confirmedDigest, legacyEntryKeyExclusive: true,
      legacyActorsClosed: true, legacyActionsSettled: true };
  }
  function delegation(spec) {
    const proof = assertDelegation(spec);
    invariant(proof && typeof proof.then !== 'function', 'LEGACY_ENTRY_DELEGATION_CHECK_MUST_BE_SYNCHRONOUS');
    const facts = grantFacts(spec), expected = { ...facts, receiptDigest: digest(facts) };
    invariant(same(proof, expected), 'LEGACY_ENTRY_DELEGATION_RECEIPT_MISMATCH');
    return expected;
  }
  function authorized(spec) {
    const current = authority.assert({ operationId: spec.operationId, epoch: spec.epoch,
      executorId: spec.executorId, kind: 'maintenance' });
    invariant(current?.instanceId === instanceId && current.operationId === spec.operationId && current.epoch === spec.epoch &&
      current.holderId === spec.executorId && current.kind === 'maintenance' && current.leaseExpiresAt > clock(),
    'CONTROL_AUTHORITY_EXPIRED_OR_SUPERSEDED');
    delegation(spec);
    return { operationId: spec.operationId, epoch: spec.epoch, executorId: spec.executorId,
      expiresAt: current.leaseExpiresAt, kind: 'maintenance' };
  }
  function exclusive(spec) {
    const pending = journal.pending();
    invariant(pending.length <= 100 && !pending.some(row => row.operationId !== spec.operationId || row.commandId !== spec.commandId),
      'LEGACY_ENTRY_OTHER_COMMAND_UNSETTLED');
  }
  function mutationGuard(spec) {
    const current = authorized(spec);exclusive(spec);
    invariant(spec.deadline > clock(), 'CONTROL_COMMAND_DEADLINE_EXPIRED');
    const row = journal.lookup(spec);
    invariant(row?.instanceId === instanceId && row.state === 'executing' && row.specDigest === digest(spec) && row.epoch === spec.epoch &&
      row.executorId === spec.executorId, 'LEGACY_ENTRY_EXECUTING_COMMAND_REQUIRED');
    return current;
  }
  function original(spec) {
    const row = journal.lookup(spec);
    invariant(row?.instanceId === instanceId && row.specDigest === digest(spec) && row.stepId === 'delegate-api', 'CONTROL_COMMAND_SPEC_CONFLICT');
    invariant(['executing', 'unknown', 'blocked', 'applied'].includes(row.state), 'LEGACY_ENTRY_ORIGINAL_DISPATCH_REQUIRED');
    return row;
  }
  async function rpc(spec, base, path, key, guard, body) {
    guard();
    const ms = body === undefined ? 2000 : Math.min(2000, spec.deadline - clock());
    invariant(Number.isSafeInteger(ms) && ms > 0, 'CONTROL_COMMAND_DEADLINE_EXPIRED');
    const response = await fetcher(base + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { 'x-platform-internal-key': key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: canonical(body) }), signal: AbortSignal.timeout(ms) });
    guard();
    invariant(response.status === 200 && response.body, 'LEGACY_ENTRY_RPC_UNPROVEN');
    const chunks = [];let bytes = 0;
    for await (const chunk of response.body) {
      guard();bytes += chunk.length;invariant(bytes <= 65536, 'LEGACY_ENTRY_RPC_TOO_LARGE');chunks.push(chunk);
    }
    guard();
    let value;try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { invariant(false, 'LEGACY_ENTRY_RPC_JSON_REQUIRED'); }
    return value;
  }
  async function metadata(spec, target, key, guard) {
    const value = await rpc(spec, target.controlOrigin, '/metadata', key, guard);guard();
    const { observedAt, ...actual } = value;
    invariant(same(actual, target.runtime), 'LEGACY_ENTRY_RUNTIME_CHANGED');
  }
  async function gateway(spec, guard) {
    await metadata(spec, spec.gateway, gatewayKey, guard);guard();
    const value = await rpc(spec, spec.gateway.controlOrigin, '/binding', gatewayKey, guard);guard();
    const binding = persistedEntryBinding(validateBinding(value));
    invariant(binding.instanceId === instanceId && [0, 100].includes(binding.weight) &&
      same(servingApi(binding), spec.business.api), 'LEGACY_ENTRY_GATEWAY_BUSINESS_CHANGED');
    await metadata(spec, spec.gateway, gatewayKey, guard);guard();
    return binding;
  }
  function receipt(spec, grant, observedAt, lookup) {
    const facts = { schemaVersion: 1, kind: 'legacy-entry-binding-receipt', instanceId,
      operationId: spec.operationId, commandId: spec.commandId, epoch: spec.epoch, specDigest: digest(spec),
      originalDeadline: spec.deadline,
      beforeBindingDigest: digest(spec.before), afterBindingDigest: digest(spec.after),
      entryRuntimeDigest: digest(spec.entry.runtime), gatewayRuntimeDigest: digest(spec.gateway.runtime),
      business: spec.business, controlPackageDigest: spec.controlPackageDigest,
      settlementReceiptDigest: spec.settlementReceiptDigest, custodyReceiptDigest: spec.custodyReceiptDigest,
      delegationGrantDigest: grant.receiptDigest, observedAt, lookup,
      admissionAuthorized: false, fullAdoptionQualified: false };
    return { ...facts, receiptDigest: digest(facts) };
  }
  async function inspect(spec) {
    original(spec);delegation(spec);
    // The original deadline never changes. After it (or its authority expires),
    // original GETs remain observational; they cannot create a new POST. Only a
    // still-valid ORIGINAL authority can subsequently record this exact result.
    let authorityValid = true;
    const guard = () => {
      delegation(spec);
      try { authorized(spec); } catch (error) {
        if (error.code !== 'CONTROL_AUTHORITY_EXPIRED_OR_SUPERSEDED') throw error;
        authorityValid = false;
      }
    };
    guard();await metadata(spec, spec.entry, entryKey, guard);guard();
    const actual = persistedEntryBinding(validateBinding(await rpc(spec, spec.entry.controlOrigin, '/binding', entryKey, guard)));guard();
    await gateway(spec, guard);guard();await metadata(spec, spec.entry, entryKey, guard);guard();
    const observedApplied = same(actual, spec.after), state = observedApplied ? 'after' : same(actual, spec.before) ? 'before' : 'other';
    const observedAt = new Date(clock()).toISOString();
    return { schemaVersion: 1, kind: 'legacy-entry-original-observation', instanceId,
      operationId: spec.operationId, commandId: spec.commandId, specDigest: digest(spec),
      observedApplied, observedBinding: state, authorityValid, deadlineExpired: clock() >= spec.deadline,
      observedAt, originalDeadline: spec.deadline, journalWrites: 0, postRequests: 0, admissionAuthorized: false,
      ...(observedApplied ? { routingReceipt: receipt(spec, delegation(spec), observedAt, true) } : {}) };
  }
  const executor = createControlCommandExecutor({ journal, clock, authorization: input => {
    const value = authorized(input.spec), prior = journal.lookup(input);
    invariant(!prior || prior.instanceId === instanceId, 'LEGACY_ENTRY_JOURNAL_INSTANCE_CHANGED');
    if (!prior || ['planned', 'definitely-not-applied'].includes(prior.state)) exclusive(input.spec);
    return value;
  } });
  return {
    async execute(value) {
      const spec = validateLegacyEntryDelegation(value);
      invariant(spec.instanceId === instanceId, 'LEGACY_ENTRY_WRONG_INSTANCE');
      invariant(journal.lookup(spec)?.state !== 'definitely-not-applied', 'LEGACY_ENTRY_ORIGINAL_DISPATCH_NOT_REPEATABLE');
      return executor.execute({ operationId: spec.operationId, commandId: spec.commandId, stepId: 'delegate-api', spec,
        invoke: async () => {
          const guard = () => mutationGuard(spec);guard();
          await metadata(spec, spec.entry, entryKey, guard);guard();
          const before = persistedEntryBinding(validateBinding(await rpc(spec, spec.entry.controlOrigin, '/binding', entryKey, guard)));guard();
          invariant(same(before, spec.before), 'LEGACY_ENTRY_BEFORE_CHANGED');
          await gateway(spec, guard);guard();
          const expectedFence = { instanceId, attemptId: spec.operationId, fence: spec.epoch };
          const fence = await rpc(spec, spec.entry.controlOrigin, '/fence', entryKey, guard, expectedFence);guard();
          invariant(same(fence, expectedFence), 'LEGACY_ENTRY_FENCE_UNPROVEN');
          await gateway(spec, guard);guard();
          await metadata(spec, spec.entry, entryKey, guard);guard();
          const result = persistedEntryBinding(validateBinding(await rpc(spec, spec.entry.controlOrigin, '/binding', entryKey, guard, spec.after)));guard();
          invariant(same(result, spec.after), 'LEGACY_ENTRY_AFTER_UNPROVEN');
          const actual = persistedEntryBinding(validateBinding(await rpc(spec, spec.entry.controlOrigin, '/binding', entryKey, guard)));guard();
          invariant(same(actual, spec.after), 'LEGACY_ENTRY_AFTER_UNPROVEN');
          await metadata(spec, spec.entry, entryKey, guard);guard();await gateway(spec, guard);guard();
          return { state: 'applied', result: receipt(spec, delegation(spec), new Date(clock()).toISOString(), false) };
        },
        inspect: async () => {
          const observed = await inspect(spec);
          return observed.observedApplied && observed.authorityValid
            ? { state: 'applied', result: observed.routingReceipt } : { state: 'unknown', result: observed };
        },
        classify: value => value });
    },
    async inspectOriginal(value) {
      const spec = validateLegacyEntryDelegation(value);
      invariant(spec.instanceId === instanceId, 'LEGACY_ENTRY_WRONG_INSTANCE');
      return inspect(spec);
    },
  };
}

export const createLegacyEntryDelegation = createLegacyEntryDelegationAdapter;
