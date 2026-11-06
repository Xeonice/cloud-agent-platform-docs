import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync, sign } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildQualificationDistribution } from './build-distribution.mjs';
import { canonical, digest, runInputFingerprint } from './trust.mjs';
import { fileDigest, treeManifest } from './io.mjs';
import { command } from './artifacts.mjs';

// This is the real compiled API trust boundary, not a second copy of its formula.
// As with other deployment tests using compiled participants, run `tsc -b` in api first.
const requireApi = createRequire(new URL('../../api/package.json', import.meta.url));
const api = requireApi('./apps/api/dist/platform/upgrade/upgrade-trust.js');
const contracts = requireApi('./packages/contracts/dist/index.js');
const instanceId = 'api-control-package-boundary';
const at = '2026-11-06T00:00:00.000Z';

async function fixture(t, withControl = true) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'api-control-boundary-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const oldInstance = process.env.PLATFORM_INSTANCE_ID;
  process.env.PLATFORM_INSTANCE_ID = instanceId;
  t.after(() => {
    if (oldInstance === undefined) delete process.env.PLATFORM_INSTANCE_ID;
    else process.env.PLATFORM_INSTANCE_ID = oldInstance;
  });
  const tree = join(root, 'control-tree');
  await fs.mkdir(join(tree, 'installer'), { recursive: true });
  await fs.writeFile(join(tree, 'installer/controller-main.mjs'), 'export const isolatedCryptoFixture = true;\n');
  const files = await treeManifest(tree), engine = digest(files);
  const controlManifest = { schemaVersion: 1, kind: 'upgrade-control', version: 'v0.0.1-control.fixture',
    protocolVersion: 1, apiRevision: 'b'.repeat(40), projectRevision: 'a'.repeat(40),
    treeDigest: digest(files), executionEngineDigest: engine };
  const archive = async name => {
    await command('tar', ['-czf', join(root, name), '-C', tree, '.'], {
      env: { PATH: process.env.PATH || '/usr/bin:/bin', COPYFILE_DISABLE: '1' },
    });
    return { platform: process.platform, arch: process.arch, name,
      url: 'https://boundary.invalid/' + name, ...await fileDigest(join(root, name)), format: 'native-tar' };
  };
  const component = { artifactDigest: engine, inputFingerprint: engine, sourceRevision: 'b'.repeat(40), protocol: { min: 1, max: 2 } };
  const manifest = { schemaVersion: 2, releaseId: 'v0.0.2-api.control.fixture', channel: 'api-control-boundary', publishedAt: at,
    commits: { project: 'a'.repeat(40), api: 'b'.repeat(40), web: 'c'.repeat(40) },
    components: { api: component, coordinator: component, installer: component, web: { ...component, webRevision: 'c'.repeat(40) } },
    packages: [await archive('business-fixture.tgz')],
    upgradePaths: [{ fromRelease: 'v0.0.1', minSchema: 1, maxSchema: 1, targetSchema: 1, bridgeReleases: [], migrationPlanDigest: null }],
    policy: { id: 'crypto-boundary-only', weights: [1, 5, 25, 100], stageDurationMs: 60000, minRequests: 100,
      observationFreshnessMs: 5000, probeHz: 10, requestDeadlineMs: 2000, attachDeadlineMs: 5000,
      softErrorDelta: 0.01, p95Ratio: 2, p95FloorMs: 1000, evaluationIntervalMs: 10000, consecutiveEvaluations: 2,
      retentionMs: 60000, migrationBatchMs: 500, maxWalBytes: 1000000, minFreeBytes: 1000000,
      fallbacks: [{ releaseId: 'v0.0.1', apiDigest: engine, webDigest: engine, rehearsed: false }],
      stopUserResources: false, restoreLiveVolume: false, contractInUpgrade: false },
    ...(withControl ? { controlPackage: { manifest: controlManifest, manifestDigest: digest(controlManifest), package: await archive('control-fixture.tgz') } } : {}) };
  // The actual JS producer hashes both real tar files and creates isolated Ed25519
  // trust + all not-run gates. Nothing here claims a deployable release or Native pass.
  const qualified = await buildQualificationDistribution({ manifest, outputRoot: root, instanceId, runId: 'api-boundary-only' });
  return { root, manifest, ...qualified };
}

function signedMutation(f, mutate, refreshInput = true) {
  const manifest = structuredClone(f.envelope.manifest);
  mutate(manifest);
  if (refreshInput) {
    const fp = runInputFingerprint(manifest);
    if (manifest.qualification) manifest.qualification.inputFingerprint = fp;
    manifest.runInputFingerprint = fp;
    for (const gate of manifest.evidence) gate.inputFingerprint = fp;
  }
  // Re-sign malformed bodies with a trusted isolated key so the API must reject
  // the semantic mismatch, rather than merely detecting a broken signature.
  const keys = generateKeyPairSync('ed25519');
  const envelope = { manifest, manifestDigest: digest(manifest), signature: { algorithm: 'Ed25519', keyId: 'negative-only',
    value: sign(null, Buffer.from(canonical(manifest)), keys.privateKey).toString('base64') } };
  const roots = { ...f.trustRoot, keys: [{ id: 'negative-only', publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }) }] };
  if (manifest.purpose === undefined) {
    delete roots.purpose;delete roots.qualificationInstanceId;
  }
  return () => api.verifyUpgradeEnvelope(envelope, roots, Date.parse(at));
}

test('actual JS qualification with Control round-trips through compiled API schema, signature and identical fingerprint', async t => {
  const f = await fixture(t);
  const verified = api.verifyUpgradeEnvelope(f.envelope, f.trustRoot, Date.parse(at));
  assert.deepEqual(verified, f.envelope);
  assert.equal(api.upgradeRunInputFingerprint(verified.manifest), f.inputFingerprint);
  assert.equal(contracts.UpgradeControlPackageManifestSchema.parse(f.manifest.controlPackage.manifest).kind, 'upgrade-control');
});

test('legacy JS qualification without Control keeps its exact old fingerprint and still verifies in compiled API', async t => {
  const f = await fixture(t, false);
  const verified = api.verifyUpgradeEnvelope(f.envelope, f.trustRoot, Date.parse(at));
  assert.equal(verified.manifest.controlPackage, undefined);
  assert.equal(api.upgradeRunInputFingerprint(verified.manifest), f.inputFingerprint);
});

test('API and Web consume the same complete explicit upgrade manifest schema', async () => {
  const [apiSchema, webSchema] = await Promise.all([
    fs.readFile(new URL('../../api/packages/contracts/src/upgrade.contract.ts', import.meta.url)),
    fs.readFile(new URL('../../web/src/types/upgrade-contract.ts', import.meta.url)),
  ]);
  assert.deepEqual(webSchema, apiSchema, 'The API/Web shared manifest contract must be synchronized');
});

test('compiled API rejects trusted signed wrong Control descriptors, identity bindings, platform, origins and stale fingerprints', async t => {
  const f = await fixture(t);
  for (const mutate of [
    m => { m.controlPackage.manifest.extraCapability = true; },
    m => { m.controlPackage.unverifiedControl = true; },
  ]) assert.throws(signedMutation(f, mutate), /unrecognized_keys/);
  for (const mutate of [
    m => { m.controlPackage.manifestDigest = digest({ wrong: true }); },
    m => { m.controlPackage.manifest.executionEngineDigest = digest({ foreignEngine: true });m.controlPackage.manifestDigest = digest(m.controlPackage.manifest); },
    m => { m.controlPackage.manifest.apiRevision = 'd'.repeat(40);m.controlPackage.manifestDigest = digest(m.controlPackage.manifest); },
    m => { m.controlPackage.manifest.projectRevision = 'd'.repeat(40);m.controlPackage.manifestDigest = digest(m.controlPackage.manifest); },
  ]) assert.throws(signedMutation(f, mutate), /RELEASE_CONTROL_ENGINE_MISMATCH/);
  assert.throws(signedMutation(f, m => { m.controlPackage.package.arch = m.packages[0].arch === 'arm64' ? 'x64' : 'arm64'; }), /RELEASE_CONTROL_PACKAGE_INVALID/);
  assert.throws(signedMutation(f, m => { m.controlPackage.package.url = 'https://foreign.invalid/control.tgz'; }), /UNTRUSTED_DISTRIBUTION_ORIGIN/);
  assert.throws(signedMutation(f, m => { m.controlPackage.package.url = 'https://boundary.invalid/control.tgz#untrusted'; }), /UNTRUSTED_DISTRIBUTION_ORIGIN/);
  assert.throws(signedMutation(f, m => { m.controlPackage.package.digest = digest({ changedArchive: true }); }, false), /QUALIFICATION_INPUT_MISMATCH/);
  assert.throws(signedMutation(f, m => { m.evidence[0].inputFingerprint = digest({ staleGate: true }); }, false), /GATE_INPUT_FINGERPRINT_MISMATCH/);
});

test('compiled API requires production independent-Control evidence bound to this descriptor, engine and archive', async t => {
  const f = await fixture(t);
  const release = m => {
    delete m.purpose;delete m.qualification;
    m.policy.fallbacks.forEach(fallback => { fallback.rehearsed = true; });
    m.evidence.forEach(gate => { gate.result = 'passed'; });
  };
  assert.throws(signedMutation(f, release), /INDEPENDENT_CONTROL_GATES_MISSING/);
  const complete = m => {
    release(m);
    // Explicit synthetic cryptographic boundary facts, never real release evidence.
    m.evidence.push({ ...m.evidence[0], kind: 'independent-control', controlPackageDigest: m.controlPackage.manifestDigest,
      executionEngineDigest: m.controlPackage.manifest.executionEngineDigest, controlArchiveDigest: m.controlPackage.package.digest });
  };
  assert.equal(signedMutation(f, complete)().manifest.purpose, undefined);
  for (const field of ['controlPackageDigest', 'executionEngineDigest', 'controlArchiveDigest']) {
    assert.throws(signedMutation(f, m => { complete(m);m.evidence.at(-1)[field] = digest({ foreign: field }); }), /INDEPENDENT_CONTROL_GATES_MISSING/);
  }
});
