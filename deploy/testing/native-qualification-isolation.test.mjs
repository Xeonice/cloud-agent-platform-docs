import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { digest, runInputFingerprint, signQualificationManifest } from '../upgrade/trust.mjs';
import { assertQualificationIsolation, qualificationInstanceAllowed, validateSameInstanceQualification } from '../../e2e-contract/server/qualification-isolation.mjs';
import { startUpgradeHarness } from '../../e2e-contract/server/start-upgrade.mjs';
import { createSameSignedUpgradeFixture } from '../../e2e-contract/server/upgrade-fixture.mjs';
import { startQualificationModel } from '../../e2e-contract/server/qualification-model.mjs';
import { atomicJson, fileDigest, treeManifest } from '../upgrade/io.mjs';
import { command } from '../upgrade/artifacts.mjs';

const H = n => 'sha256:' + String(n).repeat(64);
function fixture() {
  // Real Ed25519 signatures, but explicit Docker observations are fixture
  // ports. These contracts do not claim an actual Linux/KVM qualification.
  const instanceId = 'agent-platform-online-experiment-20261014-r1', base = '/var/lib/agent-independent-control-qa-20261107';
  const component = { artifactDigest: H(1), inputFingerprint: H(2), sourceRevision: 'a'.repeat(40), protocol: { min: 1, max: 1 } };
  const manifest = { schemaVersion: 2, purpose: 'qualification', releaseId: 'v0.3.99-compat.fixture', channel: 'existing-instance-domain',
    publishedAt: '2026-11-07T00:00:00.000Z', commits: { project: 'a'.repeat(40), api: 'b'.repeat(40), web: 'c'.repeat(40) },
    components: { api: component, coordinator: component, installer: component, web: { ...component, webRevision: 'c'.repeat(40) } },
    packages: [{ platform: 'linux', arch: 'arm64', name: 'compat.tgz', url: 'https://example.invalid/compat.tgz', digest: H(3), bytes: 123, format: 'native-tar' }],
    upgradePaths: [{ fromRelease: 'v0.3.15', minSchema: 29, maxSchema: 29, targetSchema: 29, bridgeReleases: [], migrationPlanDigest: null }],
    policy: { id: 'compat', weights: [1, 5, 25, 100], stageDurationMs: 60000, minRequests: 100, observationFreshnessMs: 5000,
      probeHz: 10, requestDeadlineMs: 2000, attachDeadlineMs: 5000, softErrorDelta: 0.01, p95Ratio: 2, p95FloorMs: 1000,
      evaluationIntervalMs: 10000, consecutiveEvaluations: 2, retentionMs: 60000, migrationBatchMs: 500, maxWalBytes: 1048576,
      minFreeBytes: 1048576, fallbacks: [{ releaseId: 'v0.3.15', apiDigest: H(1), webDigest: H(1), rehearsed: false }],
      stopUserResources: false, restoreLiveVolume: false, contractInUpgrade: false }, evidence: [] };
  manifest.qualification = { instanceId, inputFingerprint: runInputFingerprint(manifest) };
  manifest.runInputFingerprint = manifest.qualification.inputFingerprint;
  const keys = generateKeyPairSync('ed25519'), privatePem = keys.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const envelope = signQualificationManifest(manifest, 'fixture-public-domain', privatePem);
  const input = { isolated: true, instanceId, root: join(base, 'instances', instanceId), initialRoot: join(base, 'inputs/initial'),
    targetRoot: join(base, 'inputs/target'), archiveRoot: join(base, 'inputs/archives'), trustRootPath: join(base, 'inputs/trust.json'),
    catalogFile: join(base, 'inputs/catalog.json'), qualificationInstallationPath: join(base, 'inputs/qualification.json'),
    docker: { dedicated: true, args: ['--host', 'unix:///run/qualification-docker/docker.sock'] }, targetManifest: manifest,
    sameInstanceQa: { schemaVersion: 1, kind: 'same-signed-instance-isolated-qualification', manifestDigest: envelope.manifestDigest, daemonId: 'fixture-private-daemon' } };
  const facts = { trustRoot: { schemaVersion: 1, purpose: 'qualification', qualificationInstanceId: instanceId, channel: manifest.channel,
    distributionOrigins: ['https://example.invalid'], keys: [{ id: 'fixture-public-domain', publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }) }] },
    catalog: { schemaVersion: 1, channel: manifest.channel, releases: [{ releaseId: manifest.releaseId, manifestDigest: envelope.manifestDigest, envelope }] },
    daemonInfo: { ID: 'fixture-private-daemon', DockerRootDir: '/var/lib/qualification-docker', OSType: 'linux' }, containers: [] };
  return { input, facts, base, privatePem };
}

test('same original signed instance and body are accepted only with explicit private QA observations', () => {
  const { input, facts } = fixture(), before = structuredClone({ input, facts });
  const actual = validateSameInstanceQualification(input, facts);
  assert.equal(actual.manifestDigest, input.sameInstanceQa.manifestDigest);
  assert.equal(actual.sameSignedBody, true);assert.equal(actual.adoptionAuthorized, false);
  assert.deepEqual({ input, facts }, before);assert.equal(qualificationInstanceAllowed(input), true);
});

test('existing QA names retain their original gate and do not query Docker', async () => {
  const actual = await assertQualificationIsolation({ isolated: true, instanceId: 'upgrade-acceptance-existing' },
    { run: async () => { throw Error('Docker must not be called'); } });
  assert.equal(actual.kind, 'synthetic-qualification-instance');
  assert.equal(qualificationInstanceAllowed({ instanceId: 'real-instance' }), false);
});

test('production ID cannot bypass startup using a boolean or create any intent', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'same-instance-denied-'));t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(startUpgradeHarness({ isolated: true, instanceId: 'real-instance', root, initialRoot: root,
    initialRelease: { activationGeneration: 1 } }),
    { code: 'ISOLATED_INSTANCE_REQUIRED' });
  assert.deepEqual(await fs.readdir(root), []);
});

test('same signed legacy run cannot silently select the new repository Foundation',async()=>{
  await assert.rejects(startUpgradeHarness({isolated:true,instanceId:'existing-instance',root:'/var/lib/qa/instance',initialRoot:'/var/lib/qa/initial',
    initialRelease:{activationGeneration:1},sameInstanceQa:{},legacyProvided:false}),{code:'SAME_SIGNED_LEGACY_RUNTIME_REQUIRED'});
});

for (const [name, change, code] of [
  ['production Docker socket', f => { f.input.docker.args = ['--host', 'unix:///var/run/docker.sock']; }, 'SAME_INSTANCE_QA_DAEMON_REQUIRED'],
  ['different daemon ID', f => { f.facts.daemonInfo.ID = 'production-daemon'; }, 'SAME_INSTANCE_QA_DAEMON_REQUIRED'],
  ['ordinary Docker data root', f => { f.facts.daemonInfo.DockerRootDir = '/var/lib/docker'; }, 'SAME_INSTANCE_QA_DAEMON_REQUIRED'],
  ['production installation root', f => { f.input.root = '/var/lib/production/instances/' + f.input.instanceId; }, 'SAME_INSTANCE_QA_ROOT_REQUIRED'],
  ['production artifact input', f => { f.input.initialRoot = '/var/lib/docker/volumes/production/_data/artifact'; }, 'SAME_INSTANCE_QA_INPUT_SCOPE_REQUIRED'],
  ['another qualification instance', f => { f.facts.trustRoot.qualificationInstanceId = 'upgrade-acceptance-another'; }, 'SAME_INSTANCE_QA_TRUST_REQUIRED'],
  ['different target body', f => { f.input.sameInstanceQa.manifestDigest = H(9); }, 'SAME_INSTANCE_QA_SIGNED_TARGET_REQUIRED'],
  ['changed caller target', f => { f.input.targetManifest = { ...f.input.targetManifest, publishedAt: '2026-11-07T01:00:00.000Z' }; }, 'SAME_INSTANCE_QA_SIGNED_TARGET_REQUIRED'],
  ['forged signature', f => { f.facts.catalog.releases[0].envelope.signature.value = Buffer.alloc(64).toString('base64'); }, 'SIGNATURE_OR_MANIFEST_DIGEST_INVALID'],
  ['rebound unsigned catalog row', f => { f.facts.catalog.releases[0].manifestDigest = H(9); }, 'SAME_INSTANCE_QA_CATALOG_REQUIRED'],
  ['unowned foreign container', f => { f.facts.containers = [{ Id: 'f'.repeat(64), Labels: {}, Mounts: [] }]; }, 'SAME_INSTANCE_QA_FOREIGN_CONTAINER'],
  ['production mount on labelled QA role', f => { f.facts.containers = [{ Id: 'f'.repeat(64), Labels: { 'agent-platform.instance': f.input.instanceId,
    'agent-platform.installation': digest(f.input.root) }, Mounts: [{ Source: '/var/lib/docker/volumes/production/_data', Destination: '/data' }] }]; }, 'SAME_INSTANCE_QA_FOREIGN_MOUNT'],
]) test('same-instance isolation rejects ' + name, () => {
  const f = fixture();change(f);assert.throws(() => validateSameInstanceQualification(f.input, f.facts), { code });
});

test('QA-owned existing role mounts remain allowed; duplicate census identities are rejected', () => {
  const f = fixture();f.facts.containers = [{ Id: 'e'.repeat(64), Labels: { 'agent-platform.instance': f.input.instanceId,
    'agent-platform.installation': digest(f.input.root) }, Mounts: [{ Source: join(f.input.root, 'business'), Destination: '/data' }] }];
  assert.equal(validateSameInstanceQualification(f.input, f.facts).sameSignedBody, true);
  f.facts.containers.push(structuredClone(f.facts.containers[0]));
  assert.throws(() => validateSameInstanceQualification(f.input, f.facts), { code: 'SAME_INSTANCE_QA_CONTAINER_CENSUS_REQUIRED' });
});

async function sameBodyFixture(t) {
  const f=fixture(),root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'same-signed-native-fixture-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const initialRoot=join(root,'initial'),archiveRoot=join(root,'archives');
  await fs.mkdir(join(initialRoot,'api/drizzle/meta'),{recursive:true,mode:0o700});
  await fs.mkdir(join(initialRoot,'installer'),{mode:0o700});await fs.mkdir(join(initialRoot,'web'),{mode:0o700});
  await atomicJson(join(initialRoot,'api/drizzle/meta/_journal.json'),{entries:[{idx:0}]});
  await fs.writeFile(join(initialRoot,'installer/readme'),'actual isolated initial payload\n',{mode:0o600});
  await fs.writeFile(join(initialRoot,'web/server.js'),'// fixture payload, never launched\n',{mode:0o600});
  const payload=await treeManifest(initialRoot),initial=structuredClone(f.input.targetManifest);
  initial.releaseId='v0.3.15-legacy.fixture';
  for(const [kind,folder] of [['api','api'],['coordinator','api'],['installer','installer'],['web','web']])
    initial.components[kind].artifactDigest=digest(payload.filter(row=>row.path.startsWith(folder+'/')));
  initial.qualification.inputFingerprint=runInputFingerprint(initial);initial.runInputFingerprint=initial.qualification.inputFingerprint;
  await atomicJson(join(initialRoot,'upgrade-artifact.json'),{schemaVersion:1,releaseId:initial.releaseId,platform:'linux',arch:'arm64',
    components:initial.components,files:payload,treeDigest:digest(payload)});
  await fs.mkdir(archiveRoot,{mode:0o700});const archive=join(archiveRoot,'compat.tgz');
  await command('tar',['-czf',archive,'-C',initialRoot,'.']);
  const target=structuredClone(f.input.targetManifest);Object.assign(target.packages[0],await fileDigest(archive));
  target.qualification.inputFingerprint=runInputFingerprint(target);target.runInputFingerprint=target.qualification.inputFingerprint;
  const envelope=signQualificationManifest(target,'fixture-public-domain',f.privatePem),
    trustRootPath=join(root,'public-trust.json'),catalogFile=join(root,'catalog.json'),initialManifestPath=join(root,'initial.signed.json');
  await atomicJson(trustRootPath,f.facts.trustRoot);await atomicJson(initialManifestPath,signQualificationManifest(initial,'fixture-public-domain',f.privatePem));
  await atomicJson(catalogFile,{schemaVersion:1,channel:target.channel,releases:[{releaseId:target.releaseId,manifestDigest:envelope.manifestDigest,envelope}]});
  return {input:{...f.input,root:join(root,'installation'),initialRoot,archiveRoot,trustRootPath,catalogFile,initialManifestPath,
    legacyProvided:true,targetManifest:target,sameInstanceQa:{...f.input.sameInstanceQa,manifestDigest:envelope.manifestDigest}},archive,envelope,
    // Deliberately explicit external observation fixture; this is not a claim
    // that a macOS contract ran the real Linux private-daemon guard.
    ports:{assertIsolation:async()=>({kind:'fixture-only-isolation-port',actualNative:false,adoptionAuthorized:false})}};
}

test('same-body fixture preserves actual signed bytes, URLs and tar while observing real installer files',async t=>{
  const f=await sameBodyFixture(t),before={trust:await fs.readFile(f.input.trustRootPath),catalog:await fs.readFile(f.input.catalogFile),archive:await fileDigest(f.archive)};
  const actual=await createSameSignedUpgradeFixture(f.input,f.ports);
  assert.deepEqual(actual.envelope,f.envelope);assert.deepEqual(actual.config.targetManifest,f.envelope.manifest);
  assert.equal(actual.config.catalogFile,f.input.catalogFile);assert.equal(actual.config.trustRootPath,f.input.trustRootPath);
  assert.equal(actual.config.legacyProvided,true);assert.equal(actual.config.initialRelease.releaseId,'v0.3.15-legacy.fixture');
  assert.equal(actual.downloadObservationSource,'actual-installer-download-files');assert.deepEqual(await actual.requestLog(),[]);
  const download=join(actual.config.root,'installer/downloads');await fs.mkdir(download,{recursive:true,mode:0o700});
  await fs.writeFile(join(download,'a'.repeat(64)+'.tgz.partial'),'real partial bytes');
  assert.deepEqual((await actual.requestLog()).map(row=>[row.kind,row.bytes]),[['installer-download-file-observation',18]]);
  const proof=JSON.parse(await fs.readFile(actual.installationProofPath));
  assert.equal(proof.sameSignedBody,true);assert.equal(proof.independentControlQualified,false);
  assert.deepEqual(await fs.readFile(f.input.trustRootPath),before.trust);assert.deepEqual(await fs.readFile(f.input.catalogFile),before.catalog);
  assert.deepEqual(await fileDigest(f.archive),before.archive);assert.equal((await actual.close()).sdkCachePreserved,true);
  assert.throws(()=>actual.helpers.setPackageDownloadFault('http-503'),{code:'SAME_SIGNED_BODY_DOWNLOAD_FAULT_UNAVAILABLE'});
  await assert.rejects(createSameSignedUpgradeFixture(f.input,f.ports),{code:'EEXIST'});
});

test('same-body fixture rejects altered tar before creating installation or intent',async t=>{
  const f=await sameBodyFixture(t);await fs.appendFile(f.archive,'changed bytes');
  await assert.rejects(createSameSignedUpgradeFixture(f.input,f.ports),{code:'FIXTURE_PACKAGE_CHANGED'});
  await assert.rejects(fs.lstat(f.input.root),{code:'ENOENT'});
});

test('same-body fixture requires the actual initial signature and unchanged whole initial tree',async t=>{
  const f=await sameBodyFixture(t),original=await fs.readFile(f.input.initialManifestPath);
  const changed=JSON.parse(original);changed.signature.value=Buffer.alloc(64).toString('base64');await atomicJson(f.input.initialManifestPath,changed);
  await assert.rejects(createSameSignedUpgradeFixture(f.input,f.ports),{code:'SIGNATURE_OR_MANIFEST_DIGEST_INVALID'});
  await fs.writeFile(f.input.initialManifestPath,original,{mode:0o600});await fs.appendFile(join(f.input.initialRoot,'installer/readme'),'changed');
  await assert.rejects(createSameSignedUpgradeFixture(f.input,f.ports),{code:'INITIAL_FIXTURE_ARTIFACT_CHANGED'});
  await assert.rejects(fs.lstat(f.input.root),{code:'ENOENT'});
});

test('local model does not accept a real instance name without the private QA gate',async()=>{
  await assert.rejects(startQualificationModel({isolated:true,instanceId:'real-existing-instance'}),/DEDICATED_QUALIFICATION_INSTANCE_REQUIRED/);
  await assert.rejects(startQualificationModel({isolated:true,instanceId:'real-existing-instance',
    qualificationInput:{isolated:true,instanceId:'different',sameInstanceQa:{}}}),/DEDICATED_QUALIFICATION_INSTANCE_REQUIRED/);
});
