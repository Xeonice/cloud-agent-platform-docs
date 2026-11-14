import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { canonical, digest, invariant } from '../upgrade/trust.mjs';
import { persistedBinding, verifyOperatorRecovery } from './recover-failed-source-route.mjs';
import { validateOwnerKernelContinuityProof } from './owner-kernel-continuity-proof.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_JSON = 32 * 1024 * 1024, MAX_READ = 128 * 1024 * 1024;
const REQUIRED = ['authorization', 'before-proof', 'expected-authority-update', 'authority-granted', 'route-applied', 'after-proof', 'complete'];
const ROW = ['attempt_id', 'instance_id', 'controller_id', 'fence', 'lease_expires_at', 'state', 'sequence', 'generation'];
const same = (a, b, code) => invariant(canonical(a) === canonical(b), code);
const exact = (x, fields, code) => invariant(x && Object.getPrototypeOf(x) === Object.prototype &&
  canonical(Object.keys(x).sort()) === canonical([...fields].sort()), code);
const at = value => { const n = Date.parse(value); invariant(Number.isFinite(n), 'LEGACY_SOURCE_ROUTE_TIME_INVALID'); return n; };
const identity = s => [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeMs, s.ctimeMs];

async function privateDirectory(path, instanceRoot = false) {
  invariant(isAbsolute(path) && resolve(path) === path && await fs.realpath(path) === path, 'LEGACY_SOURCE_ROUTE_DIRECTORY_REQUIRED');
  const s = await fs.lstat(path);
  invariant(s.isDirectory() && !s.isSymbolicLink() && (s.mode & (instanceRoot ? 0o022 : 0o077)) === 0 &&
    (!process.getuid || s.uid === 0 || s.uid === process.getuid()), 'LEGACY_SOURCE_ROUTE_DIRECTORY_INSECURE');
}
async function read(path, budget) {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await handle.stat();
    invariant(s.isFile() && s.nlink === 1 && (s.mode & 0o077) === 0 &&
      (!process.getuid || s.uid === 0 || s.uid === process.getuid()), 'LEGACY_SOURCE_ROUTE_FILE_INSECURE');
    invariant(s.size <= MAX_JSON && budget.bytes + s.size <= MAX_READ, 'LEGACY_SOURCE_ROUTE_READ_BYTE_LIMIT');
    budget.bytes += s.size;
    const raw = Buffer.alloc(s.size);
    let offset = 0;
    while (offset < raw.length) {
      const { bytesRead } = await handle.read(raw, offset, raw.length - offset, offset);
      invariant(bytesRead > 0, 'LEGACY_SOURCE_ROUTE_FILE_CHANGED');
      offset += bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset), after = await handle.stat();
    invariant(extra.bytesRead === 0, 'LEGACY_SOURCE_ROUTE_FILE_CHANGED');
    same(identity(s), identity(after), 'LEGACY_SOURCE_ROUTE_FILE_CHANGED');
    return { path, rawDigest: digest(raw), bytes: raw.length, identity: identity(s), value: JSON.parse(raw.toString('utf8')) };
  } finally { await handle.close(); }
}
async function chain(root, operationId) {
  const parent = join(root, 'operator-maintenance'), dir = join(parent, operationId);
  // The trusted instance root is a normal deployed 0755 directory. Only the
  // maintenance evidence directories require private traversal permissions.
  await privateDirectory(root, true); await privateDirectory(parent); await privateDirectory(dir);
  const budget = { bytes: 0 }, files = {};
  files.authorization = await read(join(dir, 'authorization.json'), budget);
  const names = [...REQUIRED, ...(files.authorization.value?.plan?.expected?.schema === 29
    ? ['entry-fence-dispatch', 'entry-binding-dispatch'] : [])].sort();
  same((await fs.readdir(dir)).sort(), names.map(n => n + '.json').sort(), 'LEGACY_SOURCE_ROUTE_CHAIN_INCOMPLETE_OR_UNKNOWN');
  for (const name of names) if (name !== 'authorization') files[name] = await read(join(dir, name + '.json'), budget);
  return { files, bytes: budget.bytes };
}
function proof(value, p) {
  invariant(value && value.writerFenceValid === true && value.sourceAuthenticationWorking === true &&
    value.schema === p.expected.schema && value.journalDigest === p.expected.journalDigest &&
    value.columnsDigest === p.expected.columnsDigest && value.ownerBindingDigest === p.ownerBindingDigest &&
    value.resourceProofDigest === p.resourceProofDigest, 'LEGACY_SOURCE_ROUTE_PROOF_CHANGED');
  same(value.sourceApi, p.sourceApi, 'LEGACY_SOURCE_ROUTE_SOURCE_CHANGED');
  same(value.coordinator, p.coordinator, 'LEGACY_SOURCE_ROUTE_WRITER_CHANGED');
  if (p.expected.schema === 29) {
    validateOwnerKernelContinuityProof(value.ownerKernelProof);
    same(value.ownerKernelProof.rows, p.resources, 'LEGACY_SOURCE_ROUTE_OWNER_PROOF_CHANGED');
    invariant(value.resourceProofMode === p.resourceProofMode && value.ownerKernelProof.instanceId === p.instanceId &&
      value.ownerKernelProof.instanceRoot === p.instanceRoot && value.ownerKernelProof.stableDigest === p.resourceProofDigest &&
      value.guestProcessContinuityQualified === false && value.SDKCalls === 0 && value.GuestExecCalls === 0,
    'LEGACY_SOURCE_ROUTE_OWNER_PROOF_CHANGED');
  }
  const f = value.freshIdentity;
  invariant(f && f.sourceStartIdentity === p.sourceApi.startIdentity && f.coordinatorStartIdentity === p.coordinator.startIdentity &&
    f.writerFenceValid === true && Number.isFinite(f.identityStartedAt) && Number.isFinite(f.identityCompletedAt) &&
    f.identityCompletedAt >= f.identityStartedAt && f.identityCompletedAt - f.identityStartedAt <= 2000 &&
    f.identityStartedAt >= at(p.issuedAt) && f.identityCompletedAt <= at(value.observedAt), 'LEGACY_SOURCE_ROUTE_HISTORICAL_IDENTITY_INVALID');
}
function validateHistory(files, options) {
  const v = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, file.value]));
  const complete = v.complete, completedAt = at(complete?.at);
  // Historical execution is checked at its original completion, never at now as a renewed authorization.
  const p = verifyOperatorRecovery(v.authorization, options.trustRoot, completedAt);
  invariant(p.instanceId === options.instanceId && p.instanceRoot === options.instanceRoot && p.operationId === options.operationId &&
    p.expected.attemptId === options.attemptId, 'LEGACY_SOURCE_ROUTE_ORIGINAL_SCOPE_CHANGED');
  proof(v['before-proof'], p); proof(v['after-proof'], p);
  const sourceArtifact = v['before-proof'].sourceArtifact;
  invariant(sourceArtifact?.packageDigest === p.sourceArtifact.packageDigest && sourceArtifact.treeDigest === p.sourceArtifact.treeDigest &&
    Number.isSafeInteger(sourceArtifact.files) && sourceArtifact.files > 0, 'LEGACY_SOURCE_ROUTE_SOURCE_ARTIFACT_PROOF_REQUIRED');
  const before = persistedBinding(v['before-proof'].binding), target = { ...before, attemptId: options.attemptId,
    fence: p.newFence, routeGeneration: before.routeGeneration + 1, weight: 0 };
  invariant(digest(before) === p.expected.bindingDigest && before.instanceId === p.instanceId &&
    Number.isSafeInteger(target.routeGeneration), 'LEGACY_SOURCE_ROUTE_BEFORE_CHANGED');
  same(before.oldApi, p.target.oldApi, 'LEGACY_SOURCE_ROUTE_TARGET_CHANGED');
  const update = v['expected-authority-update'];
  exact(update, ['table', 'columns', 'attemptId', 'before', 'after'], 'LEGACY_SOURCE_ROUTE_AUTHORITY_CHAIN_INVALID');
  same(update.columns, ['controller_id', 'fence', 'lease_expires_at'], 'LEGACY_SOURCE_ROUTE_AUTHORITY_COLUMNS_CHANGED');
  invariant(update.table === 'upgrade_attempts' && update.attemptId === options.attemptId, 'LEGACY_SOURCE_ROUTE_AUTHORITY_SCOPE_CHANGED');
  same(update.before, { controllerId: p.expected.controllerId, fence: p.expected.fence,
    leaseExpiresAt: p.expected.leaseExpiresAt }, 'LEGACY_SOURCE_ROUTE_AUTHORITY_CAS_CHANGED');
  const grant = update.after;
  exact(grant, ['controllerId', 'fence', 'leaseExpiresAt'], 'LEGACY_SOURCE_ROUTE_GRANT_INVALID');
  invariant(grant.controllerId === p.controllerId && grant.fence === p.newFence && grant.leaseExpiresAt > completedAt &&
    grant.leaseExpiresAt <= at(p.expiresAt) && grant.leaseExpiresAt <= completedAt + p.leaseMs,
  'LEGACY_SOURCE_ROUTE_GRANT_EXPIRED');
  const cas = v['authority-granted'];
  exact(cas, ['before', 'after'], 'LEGACY_SOURCE_ROUTE_CAS_REQUIRED'); exact(cas.before, ROW, 'LEGACY_SOURCE_ROUTE_CAS_ROW_INVALID');
  same(cas.before, { attempt_id: options.attemptId, instance_id: p.instanceId, controller_id: p.expected.controllerId,
    fence: p.expected.fence, lease_expires_at: p.expected.leaseExpiresAt, state: p.expected.state,
    sequence: p.expected.sequence, generation: p.expected.attemptGeneration }, 'LEGACY_SOURCE_ROUTE_ORIGINAL_ROW_CHANGED');
  same(cas.after, { ...cas.before, controller_id: grant.controllerId, fence: grant.fence,
    lease_expires_at: grant.leaseExpiresAt }, 'LEGACY_SOURCE_ROUTE_CAS_CHANGED_EXTRA_COLUMNS');
  const route = v['route-applied'];
  invariant(route.manualMaintenance === true && route.automaticFallbackQualified === false,
    'LEGACY_SOURCE_ROUTE_NOT_MANUAL');
  same(persistedBinding(route.binding), target, 'LEGACY_SOURCE_ROUTE_APPLIED_BINDING_CHANGED');
  same(persistedBinding(v['after-proof'].binding), target, 'LEGACY_SOURCE_ROUTE_AFTER_BINDING_CHANGED');
  invariant(at(v['before-proof'].observedAt) <= at(route.at) && at(route.at) <= at(v['after-proof'].observedAt) &&
    at(v['after-proof'].observedAt) <= completedAt, 'LEGACY_SOURCE_ROUTE_RECEIPT_ORDER_INVALID');
  if (p.expected.schema === 29) for (const [name, value] of [
    ['entry-fence', { instanceId: p.instanceId, attemptId: options.attemptId, fence: grant.fence }], ['entry-binding', target],
  ]) same(v[name + '-dispatch'], { kind: name, attemptId: options.attemptId, planDigest: v.authorization.planDigest,
    valueDigest: digest(value), automaticReplay: false }, 'LEGACY_SOURCE_ROUTE_DISPATCH_CHANGED');
  invariant(complete.state === 'manual-source-route-recovered' && complete.operationId === p.operationId &&
    complete.planDigest === v.authorization.planDigest && complete.authorityReleased === true && complete.newFenceRetained === p.newFence &&
    complete.upgradeStillFailed === true && complete.automaticFallbackQualified === false && complete.activationConfirmed === false &&
    complete.readyNotChanged === true, 'LEGACY_SOURCE_ROUTE_COMPLETION_INVALID');
  same(complete.after, v['after-proof'], 'LEGACY_SOURCE_ROUTE_COMPLETION_PROOF_CHANGED');
  return { plan: p, target, completedAt };
}
function validateFresh(f, p, target, start, end) {
  invariant(f && Number.isFinite(f.observedAt) && f.observedAt >= start && f.observedAt <= end &&
    end - start <= 5000, 'LEGACY_SOURCE_ROUTE_FRESH_BINDINGS_REQUIRED');
  same(persistedBinding(f.entryBinding), target, 'LEGACY_SOURCE_ROUTE_CURRENT_BINDING_CHANGED');
  same(f.entryAdmission, { instanceId: p.instanceId, attemptId: p.expected.attemptId, fence: p.newFence },
    'LEGACY_SOURCE_ROUTE_CURRENT_ADMISSION_CHANGED');
  same(f.attempt, { attempt_id: p.expected.attemptId, instance_id: p.instanceId, controller_id: null, fence: p.newFence,
    lease_expires_at: 0, state: p.expected.state, sequence: p.expected.sequence, generation: p.expected.attemptGeneration },
  'LEGACY_SOURCE_ROUTE_CURRENT_FAILED_ROW_CHANGED');
  invariant(f.instance?.activationGeneration === p.expected.activationGeneration &&
    f.instance.confirmedReleaseDigest === p.expected.confirmedReleaseDigest &&
    (p.expected.schema !== 29 || f.instance.serviceState === 'transitioning' && f.instance.ready === false),
  'LEGACY_SOURCE_ROUTE_CURRENT_ACTIVATION_CHANGED');
  same(f.coordinatorBinding, { state: 'ready', origin: p.coordinator.origin, generation: p.coordinator.generation,
    artifactDigest: p.coordinator.artifactDigest }, 'LEGACY_SOURCE_ROUTE_CURRENT_WRITER_BINDING_CHANGED');
  invariant(f.writer?.instance_id === p.instanceId && f.writer.holder_id === p.coordinator.writerHolderId &&
    f.writer.generation === p.coordinator.generation && f.writer.fence === p.coordinator.writerFence &&
    Number.isFinite(f.writer.expires_at) && f.writer.expires_at > end && f.ownerBindingDigest === p.ownerBindingDigest,
  'LEGACY_SOURCE_ROUTE_CURRENT_WRITER_OR_OWNER_CHANGED');
  const source = f.sourceIdentity, coor = f.coordinatorIdentity;
  invariant(source?.instanceId === p.instanceId && source.artifactDigest === p.sourceApi.artifactDigest &&
    source.inputFingerprint === p.sourceApi.inputFingerprint && source.startIdentity === p.sourceApi.startIdentity &&
    source.controlOnly === true && source.noRuntimeSideEffects === true && source.writerFenceValid === true &&
    source.actualCoordinatorArtifactDigest === p.coordinator.artifactDigest &&
    source.actualCoordinatorInputFingerprint === p.coordinator.inputFingerprint && source.coordinatorGeneration === p.coordinator.generation &&
    coor?.instanceId === p.instanceId && coor.startIdentity === p.coordinator.startIdentity,
  'LEGACY_SOURCE_ROUTE_CURRENT_PROCESS_CHANGED');
  const { observedAt, writer, ...stable } = f;
  return { ...stable, writer: { ...writer, expires_at: null } };
}
async function freshRead(readFreshBindings, scope, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => readFreshBindings(scope, { signal: controller.signal, timeoutMs, maxBytes: MAX_JSON })),
      new Promise((_, reject) => { timer = setTimeout(() => {
        reject(Object.assign(new Error('LEGACY_SOURCE_ROUTE_OBSERVATION_EXPIRED'), { code: 'LEGACY_SOURCE_ROUTE_OBSERVATION_EXPIRED' }));
        controller.abort();
      }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Only observes a manually completed route repair. No settlement/admission consumer is wired.
 * readFreshBindings is a mandatory TRUSTED production read port, not an input JSON or default
 * fixture. It must honour signal, timeoutMs and maxBytes; its actual Entry/DB writer/Owner
 * binding transport still needs production wiring. Racing a read never authorizes a write.
 * Old signatures verify historical execution only. Neither this result nor stable source0
 * proves an older unknown RPC completed, cancels in-flight work, or authorizes any command. */
export async function observeLegacySourceRouteRecovery(options) {
  const result = { schemaVersion: 1, kind: 'readonly-legacy-source-route-recovery-observation',
    manualRecoveryOutcome: { state: 'unknown' }, originalActionsNotClassified: true,
    adoptionAuthorized: false, qualificationEvidence: false, freshReadPortRequiresProductionWiring: true,
    SDKCalls: 0, sourceSQLiteConnections: 0, lifecycleCalls: 0, legacyRPCs: 0, databaseWrites: 0, journalWrites: 0 };
  try {
    invariant(options && typeof options.instanceId === 'string' && options.instanceId.length > 0 &&
      typeof options.instanceRoot === 'string' && isAbsolute(options.instanceRoot) && resolve(options.instanceRoot) === options.instanceRoot &&
      UUID.test(options.operationId ?? '') && UUID.test(options.attemptId ?? '') &&
      typeof options.readFreshBindings === 'function', 'LEGACY_SOURCE_ROUTE_INPUT_REQUIRED');
    const clock = options.clock ?? Date.now;
    invariant(typeof clock === 'function', 'LEGACY_SOURCE_ROUTE_CLOCK_REQUIRED');
    const first = await chain(options.instanceRoot, options.operationId), { plan, target, completedAt } = validateHistory(first.files, options);
    invariant(clock() >= completedAt, 'LEGACY_SOURCE_ROUTE_FUTURE_HISTORY');
    const scope = Object.freeze({ instanceId: options.instanceId, instanceRoot: options.instanceRoot,
      operationId: options.operationId, attemptId: options.attemptId });
    const started = clock(), a = await freshRead(options.readFreshBindings, scope, 5000), observed = clock();
    const stableA = validateFresh(a, plan, target, started, observed);
    const second = await chain(options.instanceRoot, options.operationId);
    same(Object.keys(first.files), Object.keys(second.files), 'LEGACY_SOURCE_ROUTE_CHAIN_CHANGED');
    for (const name of Object.keys(first.files)) same({ raw: first.files[name].rawDigest, identity: first.files[name].identity },
      { raw: second.files[name].rawDigest, identity: second.files[name].identity }, 'LEGACY_SOURCE_ROUTE_CHAIN_CHANGED');
    const lastStarted = clock();
    invariant(lastStarted >= observed && lastStarted - started < 5000, 'LEGACY_SOURCE_ROUTE_OBSERVATION_EXPIRED');
    const b = await freshRead(options.readFreshBindings, scope, 5000 - (lastStarted - started)), finished = clock();
    same(stableA, validateFresh(b, plan, target, lastStarted, finished), 'LEGACY_SOURCE_ROUTE_BINDINGS_CHANGED_DURING_READ');
    invariant(finished - started <= 5000, 'LEGACY_SOURCE_ROUTE_OBSERVATION_EXPIRED');
    result.manualRecoveryOutcome = { state: 'source-route-recovered', operationId: options.operationId,
      originalAttemptId: options.attemptId, planDigest: first.files.authorization.value.planDigest,
      completedAt: new Date(completedAt).toISOString(), observedAt: finished, upgradeStillFailed: true,
      activationConfirmed: false, automaticFallbackQualified: false, authorityReleased: true,
      bindingDigest: digest(target), writerAndOwnerBindingDigest: digest(stableA) };
    result.originalChain = Object.values(first.files).map(({ path, rawDigest, bytes }) => ({ path, rawDigest, bytes }));
    result.readLimits = { maxJsonBytes: MAX_JSON, maxReadBytesPerRound: MAX_READ, inputBytes: first.bytes,
      verificationBytes: second.bytes, fixedFilesOnly: true };
  } catch (error) {
    result.manualRecoveryOutcome = { state: 'unknown', code: /^(?:LEGACY_SOURCE_ROUTE_|MAINTENANCE_|OWNER_)[A-Z0-9_]{1,80}$/.test(error?.code ?? '')
      ? error.code : 'LEGACY_SOURCE_ROUTE_OBSERVATION_UNKNOWN' };
  }
  return Object.freeze(result);
}
