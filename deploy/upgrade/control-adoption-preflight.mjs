import { canonical, DIGEST, invariant } from './trust.mjs';
import { validateBinding } from './stable-entry.mjs';
import { persistedEntryBinding } from './control-entry-context.mjs';
import { legacySettlementPrecondition } from './legacy-settlement.mjs';

const observations = new WeakSet();
const ID = /^[a-zA-Z0-9._:-]{1,200}$/;

function loopbackOrigin(value) {
  const url = new URL(value);
  invariant(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash,
  'CONTROL_ADOPTION_LOOPBACK_REQUIRED');
  return url.origin;
}

function runtimeIdentity(value, instanceId) {
  invariant(value?.instanceId === instanceId && value.role === 'gateway' &&
    Number.isSafeInteger(value.pid) && value.pid > 0 &&
    typeof value.startIdentity === 'string' && value.startIdentity.length > 0 &&
    DIGEST.test(value.artifactDigest ?? '') && typeof value.loadedAt === 'string' &&
    Number.isFinite(Date.parse(value.loadedAt)), 'CONTROL_ADOPTION_ENTRY_IDENTITY_UNPROVEN');
  return Object.fromEntries(['instanceId', 'role', 'pid', 'startIdentity', 'artifactDigest', 'loadedAt']
    .map(key => [key, value[key]]));
}

function epochCapability(value, instanceId) {
  return value?.schemaVersion === 1 && value.instanceId === instanceId &&
    Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    Number.isSafeInteger(value.epoch) && value.epoch >= 0 &&
    Number.isSafeInteger(value.leaseExpiresAt) && value.leaseExpiresAt >= 0;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Read the running listener, rather than infer its capabilities from disk code.
 * The injected fetch/clock ports are for isolated protocol tests. This is not a
 * physical identity observation or a signed qualification of a deployed binary.
 * No mutation probe, authority import, retry, bridge or lifecycle call is made.
 */
export async function observeControlAdoptionEntry({ instanceId, entryControlOrigin, entryKey,
  expectedRuntime = null }, { fetcher = fetch, clock = Date.now } = {}) {
  invariant(ID.test(instanceId ?? '') && typeof entryKey === 'string' && entryKey.length >= 32 &&
    typeof fetcher === 'function' && typeof clock === 'function', 'CONTROL_ADOPTION_CONFIG_REQUIRED');
  const origin = loopbackOrigin(entryControlOrigin), startedAt = clock();
  const requests = [];
  async function read(path, required = true) {
    const response = await fetcher(origin + path, { method: 'GET', redirect: 'error',
      headers: { 'x-platform-internal-key': entryKey }, signal: AbortSignal.timeout(2000) });
    let size = 0;
    const chunks = [];
    invariant(response.body, 'CONTROL_ADOPTION_RPC_BODY_REQUIRED');
    for await (const chunk of response.body) {
      size += chunk.length;
      invariant(size <= 65536, 'CONTROL_ADOPTION_RPC_TOO_LARGE');
      chunks.push(chunk);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { invariant(false, 'CONTROL_ADOPTION_RPC_JSON_REQUIRED'); }
    requests.push({ method: 'GET', path, status: response.status });
    invariant(!required || response.status === 200, 'CONTROL_ADOPTION_RPC_REJECTED');
    return { status: response.status, value };
  }
  const before = runtimeIdentity((await read('/metadata')).value, instanceId);
  if (expectedRuntime !== null) {
    invariant(canonical(before) === canonical(runtimeIdentity(expectedRuntime, instanceId)),
      'CONTROL_ADOPTION_ENTRY_IDENTITY_CHANGED');
  }
  const beforeBinding = persistedEntryBinding(validateBinding((await read('/binding')).value));
  invariant(beforeBinding.instanceId === instanceId, 'CONTROL_ADOPTION_WRONG_INSTANCE');
  const epoch = await read('/control-epoch', false);
  // An authentication failure is not evidence of a missing protocol.
  invariant(![401, 403].includes(epoch.status), 'CONTROL_ADOPTION_RPC_REJECTED');
  const epochSupported = epoch.status === 200 && epochCapability(epoch.value, instanceId);
  const unsupported = [404, 405].includes(epoch.status) ||
    epoch.status === 409 && epoch.value?.code === 'ENTRY_BUSY_OR_METHOD';
  invariant(epochSupported || unsupported, 'CONTROL_ADOPTION_ENTRY_EPOCH_UNPROVEN');
  const afterBinding = persistedEntryBinding(validateBinding((await read('/binding')).value));
  const after = runtimeIdentity((await read('/metadata')).value, instanceId);
  invariant(canonical(before) === canonical(after), 'CONTROL_ADOPTION_ENTRY_IDENTITY_CHANGED');
  invariant(canonical(beforeBinding) === canonical(afterBinding), 'CONTROL_ADOPTION_ENTRY_BINDING_CHANGED');
  const result = freeze({ schemaVersion: 1, kind: 'running-entry-control-adoption-observation',
    instanceId, entryControlOrigin: origin, startedAt, observedAt: clock(), runtime: after,
    runtimeAnchorMatched: expectedRuntime !== null, binding: afterBinding,
    entryControlEpoch: { supported: epochSupported, status: epoch.status,
      value: epochSupported ? epoch.value : null }, requests,
    mutationRequests: 0, lifecycleCalls: 0, signingKeyReads: 0 });
  observations.add(result);
  return result;
}

/** This phase establishes capability gaps; it never authorizes adoption.
 * Even a real independent Entry response does not prove public signed routing,
 * delegation of an original legacy fence, or revocation of every old Supervisor
 * mutation (including historical /activate-installer). Those need a subsequent
 * tested implementation, not JSON supportingProtocol/passive flags.
 */
export function planControlAdoption(observation, { settlementObservation = null, clock = Date.now } = {}) {
  invariant(observations.has(observation), 'CONTROL_ADOPTION_OBSERVATION_REQUIRED');
  const blockers = [];
  if (!observation.runtimeAnchorMatched) blockers.push('CONTROL_ADOPTION_ENTRY_RUNTIME_ANCHOR_REQUIRED');
  if (!observation.entryControlEpoch.supported) blockers.push('CONTROL_ADOPTION_ENTRY_EPOCH_UNSUPPORTED');
  if (![0, 100].includes(observation.binding.weight)) blockers.push('CONTROL_ADOPTION_ENTRY_ROUTE_NOT_STABLE');
  blockers.push('CONTROL_ADOPTION_PUBLIC_CONTROL_ROUTE_UNPROVEN',
    'CONTROL_ADOPTION_LEGACY_FENCE_DELEGATION_UNPROVEN',
    'CONTROL_ADOPTION_SUPERVISOR_REVOCATION_UNPROVEN');
  let legacySettlement = null;
  if (settlementObservation === null) blockers.push('CONTROL_ADOPTION_LEGACY_SETTLEMENT_REQUIRED');
  else {
    try {
      legacySettlement = legacySettlementPrecondition(settlementObservation, { instanceId: observation.instanceId, clock });
      if (!legacySettlement.settled) blockers.push('CONTROL_ADOPTION_LEGACY_SETTLEMENT_BLOCKED');
    } catch (error) {
      blockers.push(error.code || 'CONTROL_ADOPTION_LEGACY_SETTLEMENT_OBSERVATION_REQUIRED');
    }
  }
  return freeze({ schemaVersion: 1, kind: 'control-adoption-preflight', instanceId: observation.instanceId,
    state: 'blocked', qualified: false, authorizesMutation: false, admissionAuthorized: false,
    entryProtocol: observation.entryControlEpoch.supported ? 'independent-epoch-observed' : 'legacy-or-unsupported',
    retainedEntryRuntime: observation.runtime, retainedBinding: observation.binding, legacySettlement, blockers,
    requiredLegacyMutationRevocations: ['/start', '/publish', '/activate-installer', '/retire-reader'],
    originalRecoveryMustRemainAvailable: true });
}

export function assertControlAdoptionPreflight(observation, options) {
  const plan = planControlAdoption(observation, options);
  const error = Object.assign(new Error(plan.blockers[0]), { code: plan.blockers[0],
    blockers: plan.blockers, preflight: plan });
  throw error;
}
