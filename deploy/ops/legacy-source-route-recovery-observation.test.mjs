import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { canonical, digest } from '../upgrade/trust.mjs';
import { signOperatorRecovery } from './recover-failed-source-route.mjs';
import { collectOwnerKernelContinuityProof } from './owner-kernel-continuity-proof.mjs';
import { observeLegacySourceRouteRecovery } from './legacy-source-route-recovery-observation.mjs';

const sha = c => 'sha256:' + c.repeat(64), clone = v => structuredClone(v);
const iso = n => new Date(n).toISOString();
const write = (path, value) => fs.writeFile(path, canonical(value) + '\n', { mode: 0o600 });

// A receipt-reader fixture: real private files and Ed25519, explicitly not an
// actual maintenance execution or production trusted transport qualification.
async function fixture(t, schema = 29) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'legacy-route-observation-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.chmod(root, 0o700);
  const operationId = randomUUID(), attemptId = randomUUID(), instanceId = 'observer-test';
  const parent = join(root, 'operator-maintenance'), dir = join(parent, operationId);
  await fs.mkdir(parent, { mode: 0o700 }); await fs.mkdir(dir, { mode: 0o700 });
  const pair = generateKeyPairSync('ed25519'), issued = Date.now() - 2000, completed = issued + 1500;
  const roots = { schemaVersion: 1, channel: 'test', keys: [{ id: 'test-publisher',
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    notBefore: iso(issued - 1000), notAfter: iso(issued + 100000),
  }], distributionOrigins: ['https://example.test'] };
  const binding = { instanceId, attemptId, fence: 10, routeGeneration: 7, weight: 25,
    oldApi: { origin: 'http://127.0.0.1:3100', digest: sha('a') },
    candidateApi: { origin: 'http://127.0.0.1:3200', digest: sha('b') },
    web: { root: root + '/web', digest: sha('c'), treeDigest: sha('d') }, retainedWeb: [] };
  let ownerProof, resources = [{ ownerId: 'original-owner', ownerHome: root + '/original-owner',
    sandboxId: 'historical-helper', providerId: 'private-provider-id', handleDigest: sha('1'),
    bootId: randomUUID(), kernelRelease: 'fixture-kernel', initStartTime: '100' }];
  if (schema === 29) {
    const row = { ownerId: 'original-owner', ownerHome: root + '/original-owner', containerId: '1'.repeat(64),
      artifactDigest: sha('a'), inputFingerprint: sha('b'), startIdentity: 'original-owner-start' };
    const boot = randomUUID();
    const stdout = [1, 2].map(round => `H\t${round}\t${boot}\t999\n` +
      `P\t${round}\t1\t0\t100\tnode\tlive\n` +
      `P\t${round}\t11\t1\t125\tlibkrun (vmm)\tlive\n` +
      `P\t${round}\t999\t0\t900\tsh\tlive\nE\t${round}\t3\n`).join('');
    ownerProof = await collectOwnerKernelContinuityProof({ instanceId, instanceRoot: root, ownerRows: [row], transport: {
      async inspectOwner() { return { containerId: row.containerId, startIdentity: row.startIdentity, image: sha('c'), instanceId, role: 'runtime-owner',
        state: { status: 'running', running: true, pid: 401, startedAt: iso(issued - 10000),
          restartCount: 0, oomKilled: false, dead: false, restarting: false },
        mounts: [{ type: 'bind', source: row.ownerHome, destination: row.ownerHome, rw: true }] }; },
      async readAssignments() { return []; },
      async readOwnerProc() { return { exitCode: 0, stdout }; },
    } });
    resources = ownerProof.rows;
  }
  const plan = { schemaVersion: 1, purpose: 'operator-maintenance', action: 'recover-failed-source-route',
    operationId, controllerId: 'operator-recovery-' + operationId, issuedAt: iso(issued), expiresAt: iso(issued + 90000),
    instanceId, channel: 'test', instanceRoot: root, foundationContainerId: 'f'.repeat(64), trustRootDigest: digest(roots),
    expected: { attemptId, state: 'failed', sequence: 506, fence: 10, attemptGeneration: 4, activationGeneration: 8,
      schema, journalDigest: sha('2'), columnsDigest: sha('3'), bindingDigest: digest(binding),
      admissionDigest: digest({ instanceId, attemptId, fence: 10 }), controllerId: 'failed-controller',
      leaseExpiresAt: issued - 1000, confirmedReleaseDigest: sha('4') },
    newFence: 13, leaseMs: 120000,
    sourceApi: { origin: binding.oldApi.origin, artifactDigest: sha('a'), inputFingerprint: sha('e'),
      startIdentity: 'original-api-start', protocol: { min: 1, max: 1 }, sourceRevision: 'a'.repeat(40) },
    sourceArtifact: { root: root + '/source', envelopeFile: root + '/signed-source.json', envelopeDigest: sha('5'),
      packageDigest: sha('6'), treeDigest: sha('7') },
    coordinator: { origin: 'http://127.0.0.1:3300', artifactDigest: sha('b'), inputFingerprint: sha('8'),
      startIdentity: 'current-coordinator-start', generation: 2, writerFence: 2, writerHolderId: 'current-writer' },
    ownerBindingDigest: sha('9'), resources, resourceProofDigest: digest(resources), target: { weight: 0, oldApi: binding.oldApi },
    ...(ownerProof ? { resourceProofMode: ownerProof.proofMode } : {}),
  };
  const envelope = signOperatorRecovery(plan, 'test-publisher', pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const target = { ...binding, fence: plan.newFence, routeGeneration: binding.routeGeneration + 1, weight: 0 };
  const proof = (b, time) => ({ observedAt: iso(time), binding: b, sourceApi: plan.sourceApi, coordinator: plan.coordinator,
    writerFenceValid: true, sourceAuthenticationWorking: true, schema, journalDigest: plan.expected.journalDigest,
    columnsDigest: plan.expected.columnsDigest, ownerBindingDigest: plan.ownerBindingDigest,
    resourceProofDigest: plan.resourceProofDigest, freshIdentity: { identityStartedAt: time - 20, identityCompletedAt: time - 1,
      sourceStartIdentity: plan.sourceApi.startIdentity, coordinatorStartIdentity: plan.coordinator.startIdentity, writerFenceValid: true },
    ...(ownerProof ? { resourceProofMode: ownerProof.proofMode, ownerKernelProof: ownerProof,
      guestProcessContinuityQualified: false, SDKCalls: 0, GuestExecCalls: 0 } : {}),
  });
  const beforeProof = { ...proof(binding, issued + 400), sourceArtifact: {
    packageDigest: plan.sourceArtifact.packageDigest, treeDigest: plan.sourceArtifact.treeDigest, files: 3 } };
  const afterProof = proof(target, issued + 1100);
  const originalRow = { attempt_id: attemptId, instance_id: instanceId, controller_id: plan.expected.controllerId,
    fence: 10, lease_expires_at: plan.expected.leaseExpiresAt, state: 'failed', sequence: 506, generation: 4 };
  // The real producer constructs grant after before-proof, not at its timestamp.
  const grant = { controllerId: plan.controllerId, fence: plan.newFence, leaseExpiresAt: completed + 30000 };
  const records = { authorization: envelope, 'before-proof': beforeProof,
    'expected-authority-update': { table: 'upgrade_attempts', columns: ['controller_id', 'fence', 'lease_expires_at'], attemptId,
      before: { controllerId: originalRow.controller_id, fence: 10, leaseExpiresAt: originalRow.lease_expires_at }, after: grant },
    'authority-granted': { before: originalRow, after: { ...originalRow, controller_id: grant.controllerId,
      fence: grant.fence, lease_expires_at: grant.leaseExpiresAt } },
    'route-applied': { at: iso(issued + 800), binding: target, automaticFallbackQualified: false, manualMaintenance: true },
    'after-proof': afterProof, complete: { state: 'manual-source-route-recovered', operationId, planDigest: envelope.planDigest,
      at: iso(completed), after: afterProof, authorityReleased: true, newFenceRetained: plan.newFence, upgradeStillFailed: true,
      automaticFallbackQualified: false, activationConfirmed: false, readyNotChanged: true },
  };
  if (schema === 29) for (const [name, value] of [['entry-fence', { instanceId, attemptId, fence: plan.newFence }], ['entry-binding', target]])
    records[name + '-dispatch'] = { kind: name, attemptId, planDigest: envelope.planDigest, valueDigest: digest(value), automaticReplay: false };
  for (const [name, value] of Object.entries(records)) await write(join(dir, name + '.json'), value);
  const now = issued + 200000; // Authorization has expired NOW; execution was inside its original validity.
  const fresh = () => ({ observedAt: now, entryBinding: clone(target), entryAdmission: { instanceId, attemptId, fence: plan.newFence },
    attempt: { ...originalRow, controller_id: null, fence: plan.newFence, lease_expires_at: 0 },
    instance: { activationGeneration: 8, confirmedReleaseDigest: plan.expected.confirmedReleaseDigest, serviceState: 'transitioning', ready: false },
    coordinatorBinding: { state: 'ready', origin: plan.coordinator.origin, generation: 2, artifactDigest: plan.coordinator.artifactDigest },
    writer: { instance_id: instanceId, holder_id: plan.coordinator.writerHolderId, generation: 2, fence: 2, expires_at: now + 60000 },
    ownerBindingDigest: plan.ownerBindingDigest,
    sourceIdentity: { ...plan.sourceApi, instanceId, controlOnly: true, noRuntimeSideEffects: true, writerFenceValid: true,
      actualCoordinatorArtifactDigest: plan.coordinator.artifactDigest,
      actualCoordinatorInputFingerprint: plan.coordinator.inputFingerprint, coordinatorGeneration: 2 },
    coordinatorIdentity: { instanceId, startIdentity: plan.coordinator.startIdentity },
  });
  const options = { instanceId, instanceRoot: root, operationId, attemptId, trustRoot: roots, clock: () => now,
    readFreshBindings: async (scope, budget) => {
      assert.deepEqual(scope, { instanceId, instanceRoot: root, operationId, attemptId });
      assert.ok(Object.isFrozen(scope)); assert.ok(budget.signal instanceof AbortSignal);
      assert.ok(budget.timeoutMs > 0 && budget.timeoutMs <= 5000); assert.equal(budget.maxBytes, 32 * 1024 * 1024);
      return fresh();
    } };
  const rewrite = async (name, change) => { change(records[name]); await write(join(dir, name + '.json'), records[name]); };
  return { root, dir, plan, records, options, fresh, now, rewrite };
}
function unknown(value, code) {
  assert.equal(value.manualRecoveryOutcome.state, 'unknown');
  if (code) assert.equal(value.manualRecoveryOutcome.code, code);
  assert.equal(value.adoptionAuthorized, false); assert.equal(value.qualificationEvidence, false);
  assert.equal(value.originalActionsNotClassified, true); assert.equal('resolved' in value, false);
}

test('schema28 and schema29 observe only signed manual recovery, leaving original UNKNOWN and all file bytes unchanged', async t => {
  for (const schema of [28, 29]) await t.test('schema' + schema, async t => {
    const f = await fixture(t, schema), originalUnknown = { state: 'UNKNOWN', receiptDigest: null, exitCode: 1 };
    const journal = join(f.root, 'original-unknown.json'); await write(journal, originalUnknown);
    const files = [...Object.keys(f.records).map(n => join(f.dir, n + '.json')), journal];
    const before = await Promise.all(files.map(p => fs.readFile(p)));
    const result = await observeLegacySourceRouteRecovery(f.options);
    assert.equal(result.manualRecoveryOutcome.state, 'source-route-recovered');
    assert.equal(result.manualRecoveryOutcome.originalAttemptId, f.plan.expected.attemptId);
    assert.equal(result.manualRecoveryOutcome.upgradeStillFailed, true);
    assert.equal(result.manualRecoveryOutcome.activationConfirmed, false);
    assert.equal(result.manualRecoveryOutcome.automaticFallbackQualified, false);
    assert.equal(result.originalChain.length, schema === 29 ? 9 : 7);
    assert.equal(result.freshReadPortRequiresProductionWiring, true);
    assert.equal(result.originalActionsNotClassified, true); assert.equal(result.adoptionAuthorized, false);
    assert.equal(result.qualificationEvidence, false); assert.equal('resolved' in result, false);
    for (const name of ['SDKCalls', 'sourceSQLiteConnections', 'lifecycleCalls', 'legacyRPCs', 'databaseWrites', 'journalWrites']) assert.equal(result[name], 0);
    assert.deepEqual(await Promise.all(files.map(p => fs.readFile(p))), before);
    assert.deepEqual(JSON.parse(await fs.readFile(journal, 'utf8')), originalUnknown);
  });
});

test('deployed instance root 0755 is trusted, while writable root and public maintenance directories remain unknown', async t => {
  for (const kind of ['root-0755', 'root-0775', 'maintenance-0755', 'operation-0755']) await t.test(kind, async t => {
    const f = await fixture(t);
    await fs.chmod(f.root, kind === 'root-0775' ? 0o775 : 0o755);
    if (kind === 'maintenance-0755') await fs.chmod(join(f.root, 'operator-maintenance'), 0o755);
    if (kind === 'operation-0755') await fs.chmod(f.dir, 0o755);
    const value = await observeLegacySourceRouteRecovery(f.options);
    if (kind === 'root-0755') assert.equal(value.manualRecoveryOutcome.state, 'source-route-recovered');
    else unknown(value, 'LEGACY_SOURCE_ROUTE_DIRECTORY_INSECURE');
  });
});

test('missing or serialized fresh-read port cannot self-attest production trust', async t => {
  const f = await fixture(t);
  for (const value of [undefined, f.fresh()]) unknown(await observeLegacySourceRouteRecovery({ ...f.options, readFreshBindings: value }), 'LEGACY_SOURCE_ROUTE_INPUT_REQUIRED');
});

test('missing receipt, unknown chain member, missing dispatch and invalid private file are unknown', async t => {
  for (const kind of ['missing', 'extra', 'dispatch', 'mode', 'symlink', 'oversize']) await t.test(kind, async t => {
    const f = await fixture(t), path = join(f.dir, kind === 'dispatch' ? 'entry-binding-dispatch.json' : 'authority-granted.json');
    if (kind === 'missing' || kind === 'dispatch') await fs.unlink(path);
    if (kind === 'extra') await write(join(f.dir, 'new-unknown-receipt.json'), {});
    if (kind === 'mode') await fs.chmod(path, 0o644);
    if (kind === 'symlink') { await fs.rename(path, join(f.root, 'external.json')); await fs.symlink(join(f.root, 'external.json'), path); }
    if (kind === 'oversize') { const h = await fs.open(path, 'r+'); try { await h.truncate(32 * 1024 * 1024 + 1); } finally { await h.close(); } }
    let calls = 0;
    unknown(await observeLegacySourceRouteRecovery({ ...f.options, readFreshBindings: async () => { calls++; return f.fresh(); } }));
    assert.equal(calls, 0);
  });
});

test('wrong attempt, untrusted key, altered signature and execution outside signature validity are unknown', async t => {
  for (const kind of ['attempt', 'trust', 'signature', 'expired']) await t.test(kind, async t => {
    const f = await fixture(t), options = { ...f.options };
    if (kind === 'attempt') options.attemptId = randomUUID();
    if (kind === 'trust') options.trustRoot = { ...f.options.trustRoot, keys: [] };
    if (kind === 'signature') await f.rewrite('authorization', v => { v.signature.value = Buffer.alloc(64).toString('base64'); });
    if (kind === 'expired') await f.rewrite('complete', v => { v.at = f.plan.expiresAt; });
    unknown(await observeLegacySourceRouteRecovery(options));
  });
});

test('CAS, route, source tree, before/after Owner proof and completion cannot be relabelled', async t => {
  for (const kind of ['extra-column', 'before-row', 'route', 'after', 'artifact', 'owner', 'completion', 'dispatch']) await t.test(kind, async t => {
    const f = await fixture(t);
    const mutations = {
      'extra-column': ['expected-authority-update', v => v.columns.push('state')],
      'before-row': ['authority-granted', v => { v.before.sequence++; }],
      route: ['route-applied', v => { v.binding.weight = 100; }],
      after: ['after-proof', v => { v.binding.candidateApi.digest = sha('0'); }],
      artifact: ['before-proof', v => { v.sourceArtifact.treeDigest = sha('0'); }],
      owner: ['before-proof', v => { v.ownerKernelProof.rows[0].container.hostPid++; }],
      completion: ['complete', v => { v.upgradeStillFailed = false; }],
      dispatch: ['entry-binding-dispatch', v => { v.automaticReplay = true; }],
    };
    await f.rewrite(...mutations[kind]); unknown(await observeLegacySourceRouteRecovery(f.options));
  });
});

test('stale proof, active old authority, changed Entry, writer, Owner and incarnation are unknown', async t => {
  for (const kind of ['stale', 'authority', 'entry', 'writer', 'owner', 'incarnation', 'ready']) await t.test(kind, async t => {
    const f = await fixture(t), value = f.fresh();
    if (kind === 'stale') value.observedAt -= 5001;
    if (kind === 'authority') value.attempt.controller_id = f.plan.controllerId;
    if (kind === 'entry') value.entryBinding.routeGeneration++;
    if (kind === 'writer') value.writer.expires_at = f.now;
    if (kind === 'owner') value.ownerBindingDigest = sha('0');
    if (kind === 'incarnation') value.coordinatorIdentity.startIdentity = 'replaced';
    if (kind === 'ready') value.instance.ready = true;
    unknown(await observeLegacySourceRouteRecovery({ ...f.options, readFreshBindings: async () => value }));
  });
});

test('second read detects receipt replacement or binding changes, and a >5s observation is not fresh', async t => {
  for (const kind of ['chain', 'binding', 'elapsed']) await t.test(kind, async t => {
    const f = await fixture(t); let calls = 0, current = f.now;
    const result = await observeLegacySourceRouteRecovery({ ...f.options, clock: () => current, readFreshBindings: async () => {
      calls++;
      if (kind === 'chain' && calls === 1) await f.rewrite('complete', v => { v.at = iso(Date.parse(v.at) + 1); });
      if (kind === 'elapsed') current += 5001;
      const value = f.fresh(); value.observedAt = current;
      if (kind === 'binding' && calls === 2) value.writer.fence++;
      return value;
    } });
    unknown(result); assert.ok(calls <= 2);
  });
});

test('port exceptions are unknown and never include response, credential or handle text', async t => {
  const f = await fixture(t), secret = 'private-token-handle-and-body';
  const value = await observeLegacySourceRouteRecovery({ ...f.options, readFreshBindings: async () => { throw Object.assign(new Error(secret), { code: 'PRIVATE_CREDENTIAL' }); } });
  unknown(value); assert.equal(JSON.stringify(value).includes(secret), false);
  assert.equal(JSON.stringify(value).includes('PRIVATE_CREDENTIAL'), false);
});

test('a never-finishing trusted read aborts after the real five-second budget and cannot qualify late', async t => {
  const f = await fixture(t); let aborted = false, calls = 0;
  const began = performance.now();
  const result = await observeLegacySourceRouteRecovery({ ...f.options, readFreshBindings: async (_scope, { signal }) => {
    calls++;
    return new Promise(resolve => { signal.addEventListener('abort', () => { aborted = true; resolve(f.fresh()); }, { once: true }); });
  } });
  unknown(result, 'LEGACY_SOURCE_ROUTE_OBSERVATION_EXPIRED');
  assert.equal(aborted, true); assert.equal(calls, 1); assert.ok(performance.now() - began >= 4900);
});
