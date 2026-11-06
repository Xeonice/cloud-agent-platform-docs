import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, sign } from 'node:crypto';
import { atomicJson, fileDigest, treeManifest } from './io.mjs';
import { canonical, digest, runInputFingerprint, validateManifest, signManifest, signQualificationManifest } from './trust.mjs';
import { verifyControlPackageSignature } from './control-package.mjs';
import { command } from './artifacts.mjs';
import { buildSignedDistribution } from './build-distribution.mjs';
import { publishDistribution } from './publish-distribution.mjs';
import { releaseControlPackage } from '../jenkins/project-release.mjs';
import { validateCurrentNativeEvidence } from '../jenkins/upgrade-evidence.mjs';
import { verifyIndependentQualificationConfigs, verifyNativeControlArtifact } from '../../e2e-contract/native/verify-upgrade.mjs';

const H = n => 'sha256:' + String(n).repeat(64);
const scenarios = ['normal', 'agent-restart', 'business-fault', 'unknown-ack'];
function business(controlPackage) {
  const component = { artifactDigest: H(1), inputFingerprint: H(1), sourceRevision: 'b'.repeat(40), protocol: { min: 1, max: 1 } };
  const value = { schemaVersion: 2, releaseId: 'v0.0.2-release.fixture', channel: 'isolated-fixture',
    publishedAt: '2026-11-01T00:00:00.000Z', commits: { api: 'b'.repeat(40), project: 'a'.repeat(40), web: 'c'.repeat(40) },
    components: { api: component, coordinator: component,
      installer: { ...component, artifactDigest: controlPackage?.manifest.executionEngineDigest ?? H(3), inputFingerprint: controlPackage?.manifest.executionEngineDigest ?? H(3) },
      web: { ...component, webRevision: 'c'.repeat(40) } },
    packages: [{ platform: 'linux', arch: 'arm64', name: 'business-fixture.tgz', url: 'https://example.invalid/business-fixture.tgz', digest: H(2), bytes: 10, format: 'native-tar' }],
    upgradePaths: [{ fromRelease: 'v0.0.1', minSchema: 1, maxSchema: 1, targetSchema: 1, bridgeReleases: [], migrationPlanDigest: null }],
    policy: { id: 'fixture', weights: [1, 5, 25, 100], stageDurationMs: 60000, minRequests: 100, observationFreshnessMs: 5000,
      probeHz: 10, requestDeadlineMs: 2000, attachDeadlineMs: 5000, softErrorDelta: 0.01, p95Ratio: 2, p95FloorMs: 1000,
      evaluationIntervalMs: 10000, consecutiveEvaluations: 2, retentionMs: 60000, migrationBatchMs: 500,
      maxWalBytes: 1000000, minFreeBytes: 1000000, fallbacks: [{ releaseId: 'v0.0.1', apiDigest: H(1), webDigest: H(1), rehearsed: true }],
      stopUserResources: false, restoreLiveVolume: false, contractInUpgrade: false },
    ...(controlPackage ? { controlPackage } : {}) };
  return completeEvidence(value);
}
function completeEvidence(value) {
  value.runInputFingerprint = runInputFingerprint(value);
  value.evidence = ['build', 'contracts', 'four-combinations', 'native-continuity', 'fault-recovery',
    ...(value.controlPackage ? ['independent-control'] : [])].map(kind => ({ kind, result: 'passed',
      inputFingerprint: value.runInputFingerprint, reportDigest: H(4), runId: 'isolated-fixture', recordedAt: '2026-11-01T00:00:00.000Z',
      ...(kind === 'independent-control' ? { controlPackageDigest: value.controlPackage.manifestDigest,
        executionEngineDigest: value.controlPackage.manifest.executionEngineDigest,
        controlArchiveDigest: value.controlPackage.package.digest } : {}) }));
  return value;
}
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'release-control-contract-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifactRoot = join(root, 'artifact');
  for (const [name, bytes] of Object.entries({ 'installer/controller-main.mjs': 'export default 1;\n',
    'installer/control-main.mjs': 'export default 2;\n', 'api/apps/api/dist/platform/upgrade/control-store-factory.js': 'exports.fixture=true;\n' })) {
    await fs.mkdir(join(artifactRoot, name, '..'), { recursive: true, mode: 0o700 });
    await fs.writeFile(join(artifactRoot, name), bytes, { mode: 0o600 });
  }
  const files = await treeManifest(artifactRoot), manifest = { schemaVersion: 1, kind: 'upgrade-control', version: 'v0.0.1-control.fixture',
    protocolVersion: 1, apiRevision: 'b'.repeat(40), projectRevision: 'a'.repeat(40), treeDigest: digest(files),
    executionEngineDigest: digest(files.filter(f => f.path.startsWith('installer/'))) };
  const key = generateKeyPairSync('ed25519'), pem = key.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKey = key.publicKey.export({ format: 'pem', type: 'spki' });
  const controlEnvelope = { manifest, manifestDigest: digest(manifest), signature: { algorithm: 'Ed25519', keyId: 'fixture',
    value: sign(null, Buffer.from(canonical(manifest)), key.privateKey).toString('base64') } };
  const controlManifestPath = join(root, 'control-package.signed.json');await atomicJson(controlManifestPath, controlEnvelope);
  const archivePath = join(root, 'control-fixture.tgz');await fs.writeFile(archivePath, 'isolated fixture archive bytes', { mode: 0o600 });
  const control = { manifest, manifestDigest: digest(manifest), package: { name: 'control-fixture.tgz', platform: 'linux', arch: 'arm64',
    url: 'https://example.invalid/control-fixture.tgz', format: 'native-tar', ...await fileDigest(archivePath) } };
  return { root, artifactRoot, controlManifestPath, controlEnvelope, control, pem, publicKey };
}

test('legacy fingerprint stays exact while complete release binds Control body, archive and qualified reports', async t => {
  const f = await fixture(t), legacy = business();
  const oldFormula = digest({ commits: legacy.commits, components: legacy.components,
    packages: legacy.packages.map(({ platform, arch, digest, bytes, format }) => ({ platform, arch, digest, bytes, format })),
    upgradePaths: legacy.upgradePaths, policy: { ...legacy.policy, fallbacks: legacy.policy.fallbacks.map(({ rehearsed, ...identity }) => identity) } });
  assert.equal(runInputFingerprint(legacy), oldFormula);assert.equal(validateManifest(legacy), legacy);
  const current = business(f.control);assert.equal(validateManifest(current), current);
  const wrongArchiveReport = structuredClone(current);
  wrongArchiveReport.evidence.find(e => e.kind === 'independent-control').controlArchiveDigest = H(8);
  assert.throws(() => validateManifest(wrongArchiveReport), /INDEPENDENT_CONTROL_GATES_MISSING/);
  for (const mutate of [m => m.controlPackage.package.digest = H(8), m => { m.controlPackage.manifest.version = 'v0.0.2-control.fixture';m.controlPackage.manifestDigest = digest(m.controlPackage.manifest); }]) {
    const wrong = structuredClone(current);mutate(wrong);
    assert.notEqual(runInputFingerprint(wrong), current.runInputFingerprint);
    assert.throws(() => validateManifest(wrong), /INDEPENDENT_CONTROL_GATES_MISSING/);
  }
  const wrongEngine = structuredClone(current);wrongEngine.controlPackage.manifest.executionEngineDigest = H(9);
  wrongEngine.controlPackage.manifestDigest = digest(wrongEngine.controlPackage.manifest);
  assert.throws(() => validateManifest(wrongEngine), /RELEASE_CONTROL_ENGINE_MISMATCH/);
  const receipt = { commits: current.commits, components: current.components, package: current.packages[0],
    control: { kind: 'control-package-unsigned-stage', signed: false, privateKeyAccessed: false, ...f.control,
      archive: { path: join(f.root, f.control.package.name), digest: f.control.package.digest, bytes: f.control.package.bytes } } };
  assert.deepEqual(releaseControlPackage(receipt), f.control);
  assert.throws(() => releaseControlPackage({ ...receipt, control: undefined }), /COMPLETE_RELEASE_CONTROL_PACKAGE_REQUIRED/);
  const old = structuredClone(receipt);old.control.archive.digest = H(9);
  assert.throws(() => releaseControlPackage(old), /RELEASE_CONTROL_INPUT_CHANGED/);
  await assert.rejects(buildSignedDistribution({ manifest: legacy, outputRoot: f.root, privateKeyPath: join(f.root, 'never-read') }),
    /COMPLETE_RELEASE_CONTROL_PACKAGE_REQUIRED/);
});

test('production publication verifies actual Control Ed25519 and tar before making any HTTP call', async t => {
  const f = await fixture(t), manifest = business(f.control), roots = { schemaVersion: 1, channel: manifest.channel,
    distributionOrigins: ['https://example.invalid'], keys: [{ id: 'fixture', publicKey: f.publicKey }] };
  assert.deepEqual(verifyControlPackageSignature(f.controlEnvelope, roots), f.control.manifest);
  const trustRootPath = join(f.root, 'trust.json');await atomicJson(trustRootPath, roots);
  const catalog = value => ({ schemaVersion: 1, releases: [{ releaseId: value.releaseId,
    ...(() => { const envelope = signManifest(value, 'fixture', f.pem);return { manifestDigest: envelope.manifestDigest, envelope }; })() }] });
  let requests = 0;const publish = () => publishDistribution({ root: f.root, trustRootPath, token: 'isolated-fixture',
    fetcher: async () => { requests++;throw Error('network must not be reached'); } });
  await atomicJson(join(f.root, 'catalog.json'), catalog(business()));
  await assert.rejects(publish(), /COMPLETE_RELEASE_CONTROL_PACKAGE_REQUIRED/);
  await atomicJson(join(f.root, 'catalog.json'), catalog(manifest));
  const forged = structuredClone(f.controlEnvelope);forged.signature.value = Buffer.alloc(64).toString('base64');
  await atomicJson(f.controlManifestPath, forged);await assert.rejects(publish(), /CONTROL_PACKAGE_SIGNATURE_INVALID/);
  await atomicJson(f.controlManifestPath, f.controlEnvelope);await fs.appendFile(join(f.root, f.control.package.name), 'changed');
  await assert.rejects(publish(), /PUBLISHED_CONTROL_PACKAGE_CHANGED/);assert.equal(requests, 0);
});

test('Native evidence cannot reuse prior Control, business or input fingerprints', async t => {
  const f = await fixture(t), m = business(f.control), config = { controlPackage: f.control, commits: m.commits,
    packageDigest: m.packages[0].digest, runInputFingerprint: m.runInputFingerprint };
  const result = { result: 'passed', skipped: 0, substituted: false, native: true, commits: m.commits,
    packageDigest: config.packageDigest, runInputFingerprint: config.runInputFingerprint,
    controlPackageDigest: f.control.manifestDigest, executionEngineDigest: f.control.manifest.executionEngineDigest,
    controlArchiveDigest: f.control.package.digest, assertions: ['N01', 'N02', 'N03', ...Array.from({ length: 14 }, (_, i) => 'X' + String(i + 1).padStart(2, '0')),
      'WebA-APIA', 'WebA-APIB', 'WebB-APIB', 'WebB-APIA'].map(id => ({ id, result: 'passed', expectLocation: 'explicit-fixture', actualEvidence: { fixture: true } })) };
  assert.equal(validateCurrentNativeEvidence(result, config), result);
  for (const key of ['controlPackageDigest', 'executionEngineDigest', 'controlArchiveDigest', 'packageDigest', 'runInputFingerprint']) {
    assert.throws(() => validateCurrentNativeEvidence({ ...result, [key]: H(9) }, config), /NATIVE_(CONTROL_)?EVIDENCE_NOT_CURRENT/);
  }
});

test('Native Control qualification binds actual Ed25519 tree, tar content and exact byte count', async t => {
  const f = await fixture(t), archivePath = join(f.root, f.control.package.name),
    tarOptions = { env: { PATH: process.env.PATH || '/usr/bin:/bin', COPYFILE_DISABLE: '1' } };
  await command('tar', ['--no-xattrs', '-czf', archivePath, '-C', f.artifactRoot, '.'], tarOptions);
  Object.assign(f.control.package, await fileDigest(archivePath));
  const trustRootPath = join(f.root, 'trust.json');
  await atomicJson(trustRootPath, { schemaVersion: 1, keys: [{ id: 'fixture', publicKey: f.publicKey }] });
  const config = { target: { controlArtifactRoot: f.artifactRoot, controlManifestPath: f.controlManifestPath,
    controlArchivePath: archivePath }, qa: { trustRootPath } };
  assert.equal((await verifyNativeControlArtifact(config, f.control)).controlArchiveDigest, f.control.package.digest);
  await assert.rejects(verifyNativeControlArtifact(config, { ...f.control,
    package: { ...f.control.package, bytes: f.control.package.bytes + 1 } }), /NATIVE_CONTROL_ARCHIVE_CHANGED/);
  const original = await fs.readFile(archivePath);await fs.appendFile(archivePath, 'changed');
  await assert.rejects(verifyNativeControlArtifact(config, f.control), /CONTROL_STAGED_ARCHIVE_CHANGED/);
  await fs.writeFile(archivePath, original);
  const other = join(f.root, 'other');await fs.mkdir(other);await fs.writeFile(join(other, 'not-the-signed-tree'), 'x');
  await command('tar', ['--no-xattrs', '-czf', archivePath, '-C', other, '.'], tarOptions);
  await assert.rejects(verifyNativeControlArtifact(config, { ...f.control,
    package: { ...f.control.package, ...await fileDigest(archivePath) } }), /CONTROL_STAGED_TREE_CHANGED/);
});

test('five isolated config catalogs bind real signed current business bodies, Control and instance identities', async t => {
  const f = await fixture(t), current = business(f.control), configs = {}, catalogs = {};
  for (const [i, name] of ['migration', ...scenarios].entries()) {
    const instanceId = 'upgrade-acceptance-fixture-' + name, trustRootPath = join(f.root, name + '-trust.json'), catalogFile = join(f.root, name + '-catalog.json');
    const roots = { schemaVersion: 1, purpose: 'qualification', qualificationInstanceId: instanceId, channel: current.channel,
      distributionOrigins: ['https://example.invalid'], keys: [{ id: 'fixture', publicKey: f.publicKey }] };
    await atomicJson(trustRootPath, roots);
    const qualified = { ...current, purpose: 'qualification', qualification: { instanceId, inputFingerprint: current.runInputFingerprint }, evidence: [] },
      envelope = signQualificationManifest(qualified, 'fixture', f.pem);
    catalogs[name] = { schemaVersion: 1, releases: [{ releaseId: current.releaseId, manifestDigest: envelope.manifestDigest, envelope }] };
    await atomicJson(catalogFile, catalogs[name]);
    configs[name] = { isolated: true, docker: { dedicated: true }, root: '/var/lib/agent-independent-control-qa-1/instances/' + instanceId,
      instanceId, controlArtifactRoot: f.artifactRoot, controlManifestPath: f.controlManifestPath, trustRootPath, catalogFile };
  }
  const migration = { ...configs.migration, target: { controlArtifactRoot: f.artifactRoot, controlManifestPath: f.controlManifestPath,
    catalogFile: configs.migration.catalogFile }, qa: { trustRootPath: configs.migration.trustRootPath } },
    independent = { isolated: true, docker: { dedicated: true }, scenarios: Object.fromEntries(scenarios.map(name => [name, configs[name]])) },
    config = { migrationAcceptanceConfigPath: join(f.root, 'migration.json'), independentAcceptanceConfigPath: join(f.root, 'independent.json') };
  await atomicJson(config.migrationAcceptanceConfigPath, migration);await atomicJson(config.independentAcceptanceConfigPath, independent);
  const actual = await verifyIndependentQualificationConfigs(config, f.control, current);
  assert.equal(actual.businessTargetReleaseId, current.releaseId);assert.equal(Object.keys(actual.businessTargetDigests).length, 5);
  assert.equal(actual.businessTargetDigests.normal, catalogs.normal.releases[0].manifestDigest);
  assert.notEqual(actual.businessTargetDigests.normal, current.packages[0].digest);
  const wrong = structuredClone(catalogs.normal), old = wrong.releases[0].envelope.manifest;
  old.components.api = { ...old.components.api, artifactDigest: H(8) };old.qualification.inputFingerprint = runInputFingerprint(old);
  wrong.releases[0].envelope = signQualificationManifest(old, 'fixture', f.pem);wrong.releases[0].manifestDigest = wrong.releases[0].envelope.manifestDigest;
  await atomicJson(configs.normal.catalogFile, wrong);
  await assert.rejects(verifyIndependentQualificationConfigs(config, f.control, current), /NATIVE_BUSINESS_TARGET_CHANGED/);
  await atomicJson(configs.normal.catalogFile, catalogs.normal);
  const sharedRoot = structuredClone(independent);sharedRoot.scenarios.normal.root = migration.root;
  await atomicJson(config.independentAcceptanceConfigPath, sharedRoot);
  await assert.rejects(verifyIndependentQualificationConfigs(config, f.control, current), /INDEPENDENT_ACCEPTANCE_ISOLATION_REQUIRED/);
  await atomicJson(config.independentAcceptanceConfigPath, independent);
  const badSignature = structuredClone(catalogs['unknown-ack']);badSignature.releases[0].envelope.signature.value = Buffer.alloc(64).toString('base64');
  await atomicJson(configs['unknown-ack'].catalogFile, badSignature);
  await assert.rejects(verifyIndependentQualificationConfigs(config, f.control, current), /SIGNATURE_OR_MANIFEST_DIGEST_INVALID/);
});
