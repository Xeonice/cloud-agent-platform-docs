import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createControlAdoptionAttachment } from '../upgrade/control-adoption-attachment.mjs';
import { digest, signQualificationManifest, runInputFingerprint } from '../upgrade/trust.mjs';
import { atomicJson } from '../upgrade/io.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
require('reflect-metadata');
const Database = require('better-sqlite3'), { Test } = require('@nestjs/testing');
const { drizzle } = require('drizzle-orm/better-sqlite3'), { migrate } = require('drizzle-orm/better-sqlite3/migrator');
const api = name => require('./apps/api/dist/platform/' + name + '.js');
const { UpgradeStore } = api('upgrade/upgrade-store'), { UpgradeLedgerConnection } = api('upgrade/upgrade-ledger-connection');
const { UpgradeControlAttachment } = api('upgrade/upgrade-control-attachment');
const { UpgradeControlAttachmentController } = api('upgrade/upgrade-control-attachment.controller');
const { UpgradeSecurity } = api('access-passcode/upgrade-security.service');
const { fenceCoordinatorConnection, coordinatorWriterControl } = api('persistence/coordinator-lease');
const { createUpgradeControlStores } = api('upgrade/control-store-factory');
const { map } = createRequire(new URL('../../api/apps/api/package.json', import.meta.url))('rxjs/operators');

function manifests(instanceId, schema) {
  const artifact = label => ({ artifactDigest: digest(label), inputFingerprint: digest(label), sourceRevision: 'a'.repeat(40), protocol: { min: 1, max: 2 } });
  const source = { releaseId: '0.2.0', activationGeneration: 1, activatedAt: new Date().toISOString(), schema, channel: 'isolated-attachment',
    productionWebBinding: 'http://127.0.0.1:31991', commits: { project: 'a'.repeat(40), api: 'a'.repeat(40), web: 'a'.repeat(40) },
    components: { api: artifact('api'), coordinator: artifact('coordinator'), installer: artifact('installer'), web: { ...artifact('web'), webRevision: 'a'.repeat(40) } } };
  const control = { schemaVersion: 1, kind: 'upgrade-control', version: '0.2.1', protocolVersion: 1, apiRevision: source.commits.api,
    projectRevision: source.commits.project, treeDigest: digest('isolated-control-tree'), executionEngineDigest: source.components.installer.artifactDigest };
  const pack = { platform: process.platform, arch: process.arch, name: 'isolated-api', url: 'https://distribution.invalid/fixture.tgz', digest: digest('isolated-tar'), bytes: 1000, format: 'native-tar' };
  const manifest = { schemaVersion: 2, purpose: 'qualification', releaseId: '0.2.1', channel: source.channel, publishedAt: new Date().toISOString(),
    commits: source.commits, components: source.components, packages: [pack],
    controlPackage: { manifest: control, manifestDigest: digest(control), package: { ...pack, name: 'isolated-control' } },
    upgradePaths: [{ fromRelease: source.releaseId, minSchema: schema, maxSchema: schema, targetSchema: schema, bridgeReleases: [], migrationPlanDigest: null }],
    policy: { id: 'isolated-attachment', weights: [1, 5, 25, 100], stageDurationMs: 60000, minRequests: 100, observationFreshnessMs: 5000,
      probeHz: 10, requestDeadlineMs: 2000, attachDeadlineMs: 5000, softErrorDelta: 0.01, p95Ratio: 2, p95FloorMs: 1000,
      evaluationIntervalMs: 10000, consecutiveEvaluations: 2, retentionMs: 60000, migrationBatchMs: 500, maxWalBytes: 1048576,
      minFreeBytes: 1048576, fallbacks: [{ releaseId: source.releaseId, apiDigest: source.components.api.artifactDigest, webDigest: source.components.web.artifactDigest, rehearsed: false }],
      stopUserResources: false, restoreLiveVolume: false, contractInUpgrade: false }, evidence: [] };
  manifest.qualification = { instanceId, inputFingerprint: runInputFingerprint(manifest) };
  const keys = generateKeyPairSync('ed25519'), signedManifest = signQualificationManifest(manifest, 'isolated-attachment', keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const trustRoot = { schemaVersion: 1, purpose: 'qualification', qualificationInstanceId: instanceId, channel: source.channel,
    distributionOrigins: ['https://distribution.invalid'], keys: [{ id: 'isolated-attachment', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) }] };
  return { source, signedManifest, trustRoot, control };
}

/** Actual Nest controller/service, file SQLite+migrations and real writer lease.
 * The export callback below is deliberately a CONTROL EXPORT PORT FIXTURE: it
 * copies the actual confirmed source into an actual private independent store.
 * It does not claim the full production export/custody procedure. The mandatory
 * legacy settlement observer is likewise an explicit external boundary, not a
 * claim that real old Supervisor/Entry processes or Native resources were closed.
 */
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'adoption-attachment-')));
  const instanceId = 'attachment-local', key = 'isolated-attachment-private-rpc-key-32';
  const envKeys = ['PLATFORM_INSTANCE_ID', 'PLATFORM_PROCESS_ROLE', 'PLATFORM_CONTROLLER_RPC_KEY', 'UPGRADE_CONTROL_DATABASE_PATH',
    'UPGRADE_CONTROL_ATTACH_FREEZE_PLAN_PATH', 'UPGRADE_CONTROL_ATTACH_SPEC_PATH', 'UPGRADE_CONTROL_ATTACH_SPEC_RAW_DIGEST',
    'UPGRADE_CONTROL_ATTACH_FREEZE_PLAN_RAW_DIGEST', 'UPGRADE_TRUST_ROOT_PATH', 'COORDINATOR_GENERATION', 'COORDINATOR_WRITER_FENCE_VALID'];
  const oldEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  for (const k of envKeys) delete process.env[k];
  Object.assign(process.env, { PLATFORM_INSTANCE_ID: instanceId, PLATFORM_CONTROLLER_RPC_KEY: key,
    UPGRADE_CONTROL_ATTACH_FREEZE_PLAN_PATH: join(root, 'freeze.json'), UPGRADE_CONTROL_ATTACH_SPEC_PATH: join(root, 'attach.json'), UPGRADE_TRUST_ROOT_PATH: join(root, 'trust.json') });
  let now = Date.now(), app, control;
  const clock = { now: () => new Date(now) }, businessPath = join(root, 'business.sqlite');
  const business = fenceCoordinatorConnection(new Database(businessPath), instanceId, clock, { next: randomUUID });
  migrate(drizzle(business), { migrationsFolder: resolve('api/drizzle') });
  business.exec('CREATE TABLE business_probe(value TEXT)'); business.prepare("INSERT INTO business_probe VALUES('before')").run();
  const connection = new UpgradeLedgerConnection(clock), store = new UpgradeStore(business, clock, { next: randomUUID }, connection.options());
  const schema = business.prepare('SELECT count(*) n FROM __drizzle_migrations').get().n;
  const signed = manifests(instanceId, schema); store.bootstrap(signed.source);
  const writer = coordinatorWriterControl(business), operationId = randomUUID();
  const plan = { schemaVersion: 1, kind: 'legacy-control-admission-freeze', instanceId, operationId, commandId: 'fixed-freeze', deadline: now + 20000,
    source: { activationGeneration: 1, confirmedDigest: digest(signed.source), businessWriterGeneration: writer.generation, businessWriterFence: writer.fence, schema },
    target: { signedManifestDigest: signed.signedManifest.manifestDigest, apiArtifactDigest: signed.source.components.api.artifactDigest,
      coordinatorArtifactDigest: signed.source.components.coordinator.artifactDigest, projectRevision: signed.source.commits.project, controlPackageDigest: digest(signed.control) } };
  const freezeConfiguration = { spec: plan, signedManifest: signed.signedManifest };
  await atomicJson(join(root, 'freeze.json'), freezeConfiguration); await atomicJson(join(root, 'trust.json'), signed.trustRoot);
  const service = new UpgradeControlAttachment(store, connection, business, clock);
  const module = await Test.createTestingModule({ controllers: [UpgradeControlAttachmentController], providers: [
    { provide: UpgradeControlAttachment, useValue: service }, { provide: UpgradeSecurity, useValue: { internal: UpgradeSecurity.prototype.internal } },
  ] }).compile();
  app = module.createNestApplication({ logger: false });
  // Production private RPC accepts the application's normal {data} envelope.
  app.useGlobalInterceptors({ intercept: (_context, next) => next.handle().pipe(map(data => ({ data }))) });
  await app.listen(0, '127.0.0.1');
  const coordinatorOrigin = await app.getUrl(), counts = { freeze: 0, attach: 0, get: 0, exports: 0, settlements: 0 };
  const options = { coordinatorOrigin, internalKey: key, instanceId, freezeConfiguration, trustRoot: signed.trustRoot,
    statePath: join(root, 'private', 'dispatch.json'), clock: () => now,
    fetcher: async (url, init) => { counts[init.method === 'GET' ? 'get' : url.endsWith('/freeze') ? 'freeze' : 'attach']++; return fetch(url, init); },
    async exportPassive({ freezeReceipt }) {
      counts.exports++;
      const actual = JSON.parse(business.prepare('SELECT confirmed_release FROM upgrade_instances WHERE instance_id=?').get(instanceId).confirmed_release);
      assert.equal(digest(actual), plan.source.confirmedDigest);
      const path = join(root, 'control.sqlite'); control = new Database(path); await fs.chmod(path, 0o600);
      createUpgradeControlStores({ sqlite: control, instanceId, clock, ids: { next: randomUUID } }).store.bootstrap(actual);
      const stat = await fs.lstat(path, { bigint: true });
      const spec = { schemaVersion: 1, kind: 'legacy-control-ledger-attach', instanceId, operationId, commandId: 'fixed-attach',
        epoch: 1, executorId: 'isolated-executor', deadline: plan.deadline, source: plan.source, target: plan.target,
        freezeReceiptDigest: freezeReceipt.receiptDigest, controlDatabase: { path, dev: String(stat.dev), ino: String(stat.ino) },
        settlement: { operationId, commandId: 'fixed-settlement' } };
      const attachConfiguration = { spec, signedManifest: signed.signedManifest };
      // This deployment fixture writes the startup input. The orchestrator cannot.
      await atomicJson(join(root, 'attach.json'), attachConfiguration);
      return { sqlite: control, attachConfiguration };
    },
    async settlementObserver({ spec, freezeReceipt }) {
      counts.settlements++;
      const facts = { schemaVersion: 1, kind: 'legacy-control-settlement', instanceId, operationId,
        freezeReceiptDigest: freezeReceipt.receiptDigest, sourceConfirmedDigest: spec.source.confirmedDigest,
        localAdmissionClosed: true, legacyCallersClosed: true, originalDispatchesSettled: true, qualified: true, observedAt: now };
      return { ...facts, receiptDigest: digest(facts) };
    } };
  t.after(async () => {
    await app?.close(); connection.onModuleDestroy(); control?.close(); business.close();
    for (const k of envKeys) oldEnv[k] === undefined ? delete process.env[k] : process.env[k] = oldEnv[k];
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, options, counts, business, writer, connection, service, plan, get control() { return control; }, advance: ms => { now += ms; } };
}

test('fixed orchestration reaches actual Nest readonly attach and completes only the passive reservation', async t => {
  const f = await fixture(t), executor = createControlAdoptionAttachment(f.options);
  const result = await executor.run(); assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.equal(result.controlActivated, false); assert.equal(result.authorizesEntryMutation, false);
  assert.equal(f.connection.readonly, true); f.writer.assert();
  f.business.prepare("INSERT INTO business_probe VALUES('after')").run();
  assert.equal(f.business.prepare('SELECT count(*) n FROM business_probe').get().n, 2);
  const authority = f.control.prepare('SELECT * FROM control_authority').get(); assert.equal(authority.mode, 'passive'); assert.equal(authority.holder_id, null);
  assert.deepEqual(f.control.prepare('SELECT state FROM control_commands ORDER BY command_id').all(), [{ state: 'applied' }, { state: 'applied' }]);
  assert.equal(f.control.prepare('SELECT count(*) n FROM upgrade_attempts').get().n, 0);
  assert.deepEqual({ freeze: f.counts.freeze, attach: f.counts.attach, exports: f.counts.exports }, { freeze: 1, attach: 1, exports: 1 });
  assert.deepEqual(await executor.run(), result); assert.equal(f.counts.attach, 1);
});

test('a missing real external closure proof keeps the original reservation and never attaches', async t => {
  const f = await fixture(t);
  const executor = createControlAdoptionAttachment({ ...f.options, settlementObserver: async () => ({ qualified: true }) });
  const result = await executor.run(); assert.equal(result.state, 'manual-review'); assert.equal(result.reason, 'CONTROL_ADOPTION_ACTUAL_SETTLEMENT_REQUIRED');
  assert.equal(f.counts.attach, 0); assert.equal(f.connection.readonly, false); f.writer.assert();
  assert.equal(f.control.prepare('SELECT state FROM control_adoption_reservations').get().state, 'reserved');
  assert.equal(f.control.prepare("SELECT state FROM control_commands WHERE command_id='fixed-settlement'").get().state, 'executing');
  assert.throws(() => createControlAdoptionAttachment({ ...f.options, settlementObserver: undefined }), /CONFIG_REQUIRED/);
});

test('unknown freeze ACK survives a new session, never exports and never repeats its POST', async t => {
  const f = await fixture(t), fetcher = f.options.fetcher;
  const options = { ...f.options, fetcher: async (url, init) => {
    const response = await fetcher(url, init);
    if (init.method === 'POST') { await response.text(); throw Object.assign(Error('ACK lost after actual handler'), { code: 'FIXTURE_ACK_LOST' }); }
    return response;
  } };
  const first = await createControlAdoptionAttachment(options).run(); assert.equal(first.state, 'manual-review');
  assert.equal(f.connection.frozen, true); assert.equal(f.counts.exports, 0);
  const second = await createControlAdoptionAttachment(options).run(); assert.equal(second.reason, 'CONTROL_ADOPTION_FREEZE_ACK_UNKNOWN');
  assert.equal(f.counts.freeze, 1); assert.equal(f.counts.exports, 0);
  const before = JSON.parse(await fs.readFile(f.options.statePath, 'utf8'));
  const changed = { ...f.options, freezeConfiguration: { ...f.options.freezeConfiguration, spec: { ...f.plan, commandId: 'replacement' } } };
  assert.equal((await createControlAdoptionAttachment(changed).run()).reason, 'CONTROL_ADOPTION_ORIGINAL_STATE_CONFLICT');
  assert.deepEqual(JSON.parse(await fs.readFile(f.options.statePath, 'utf8')), before);
  f.advance(20001); const executor = createControlAdoptionAttachment(options);
  assert.equal((await executor.run()).reason, 'CONTROL_ADOPTION_ORIGINAL_DEADLINE_EXPIRED');
  assert.equal((await executor.observe()).admissionClosed, true); assert.equal(f.counts.freeze, 1);
});

test('unknown attach ACK reconciles by actual GET on a new session without a second attach POST', async t => {
  const f = await fixture(t), fetcher = f.options.fetcher;
  const options = { ...f.options, fetcher: async (url, init) => {
    const response = await fetcher(url, init);
    if (url.endsWith('/attach')) { await response.text(); throw Object.assign(Error('ACK lost'), { code: 'FIXTURE_ACK_LOST' }); }
    return response;
  } };
  assert.equal((await createControlAdoptionAttachment(options).run()).state, 'manual-review');
  assert.equal(f.connection.readonly, true); assert.equal(f.counts.attach, 1);
  const result = await createControlAdoptionAttachment(options).run(); assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.equal(f.counts.attach, 1); assert.equal(f.counts.exports, 1);
  assert.equal(f.control.prepare('SELECT mode,holder_id FROM control_authority').get().holder_id, null);
});

test('expiry after the original observer promise cannot record settlement, attach or renew its passive lease', async t => {
  const f = await fixture(t), observer = f.options.settlementObserver;
  const executor = createControlAdoptionAttachment({ ...f.options, settlementObserver: async input => { const proof = await observer(input); f.advance(20001); return proof; } });
  const result = await executor.run(); assert.equal(result.reason, 'CONTROL_ADOPTION_ORIGINAL_DEADLINE_EXPIRED');
  assert.equal(f.counts.attach, 0); assert.equal(f.control.prepare("SELECT state FROM control_commands WHERE command_id='fixed-settlement'").get().state, 'executing');
  assert.equal(f.control.prepare('SELECT lease_expires_at FROM control_authority').get().lease_expires_at, f.plan.deadline);
  assert.equal((await executor.observe()).readonly, false);
});

test('exclusive durable custody serializes separate executors and a symlink state cannot dispatch', async t => {
  const f = await fixture(t), fetcher = f.options.fetcher;
  let unblock, entered; const gate = new Promise(ok => { unblock = ok; }), started = new Promise(ok => { entered = ok; });
  t.after(() => unblock());
  const options = { ...f.options, fetcher: async (url, init) => { if (url.endsWith('/freeze')) { entered(); await gate; } return fetcher(url, init); } };
  const first = createControlAdoptionAttachment(options), running = first.run(); assert.equal(first.run(), running); await started;
  assert.equal((await createControlAdoptionAttachment(options).run()).reason, 'CONTROL_ADOPTION_STATE_LOCKED');
  unblock(); assert.equal((await running).state, 'completed'); assert.equal(f.counts.freeze, 1);
  const target = join(f.root, 'not-the-state.json'); await atomicJson(target, {}); await fs.unlink(f.options.statePath); await fs.symlink(target, f.options.statePath);
  await assert.rejects(createControlAdoptionAttachment(f.options).run(), /STATE_CUSTODY_INVALID/); assert.equal(f.counts.freeze, 1);
});

test('a known rejected original freeze POST consumes its durable dispatch permission too', async t => {
  const f = await fixture(t), fetcher = f.options.fetcher;
  const options = { ...f.options, fetcher: (url, init) => fetcher(url, url.endsWith('/freeze') ? {
    ...init, headers: { ...init.headers, 'x-platform-internal-key': 'wrong-fixture-private-rpc-key-32' },
  } : init) };
  const first = await createControlAdoptionAttachment(options).run(); assert.equal(first.state, 'manual-review');
  assert.equal(f.connection.frozen, false); assert.equal(f.counts.exports, 0);
  assert.equal((await createControlAdoptionAttachment(f.options).run()).reason, 'CONTROL_ADOPTION_FREEZE_ACK_UNKNOWN');
  assert.equal(f.counts.freeze, 1); assert.equal(f.counts.exports, 0);
});

test('a partial GET receipt never becomes an applied attach command; a later intact GET can reconcile it', async t => {
  const f = await fixture(t), fetcher = f.options.fetcher;
  const options = { ...f.options, fetcher: async (url, init) => {
    const response = await fetcher(url, init);
    if (init.method !== 'GET') return response;
    const payload = await response.json();
    if (payload.data?.readonly) {
      delete payload.data.attachment.attachedReceipt.controlActivated;
      payload.data.attachment.resultDigest = digest(payload.data.attachment.attachedReceipt);
    }
    return new Response(JSON.stringify(payload), { status: response.status, headers: { 'content-type': 'application/json' } });
  } };
  assert.equal((await createControlAdoptionAttachment(options).run()).reason, 'CONTROL_ADOPTION_ATTACH_ACK_UNKNOWN');
  assert.equal(f.control.prepare("SELECT state FROM control_commands WHERE command_id='fixed-attach'").get().state, 'executing');
  assert.equal(f.control.prepare('SELECT state FROM control_adoption_reservations').get().state, 'reserved');
  assert.equal((await createControlAdoptionAttachment(f.options).run()).state, 'completed');
  assert.equal(f.counts.attach, 1);
});

test('packaged installer reopens the actual pinned DB through its sibling API package, never an invalid-package fallback', async t => {
  const f = await fixture(t), fetcher = f.options.fetcher;
  const options = { ...f.options, fetcher: async (url, init) => {
    const response = await fetcher(url, init);
    if (url.endsWith('/attach')) { await response.text(); throw Object.assign(Error('ACK lost'), { code: 'FIXTURE_ACK_LOST' }); }
    return response;
  } };
  assert.equal((await createControlAdoptionAttachment(options).run()).state, 'manual-review');
  const installer = join(f.root, 'artifact', 'installer'), packageRoot = join(f.root, 'artifact', 'api');
  await fs.mkdir(installer, { recursive: true }); await fs.mkdir(packageRoot, { recursive: true });
  // Match packagePinnedInstance: deploy package.json stays at api/, while only
  // dist moves to api/apps/api/dist. createRequire's old introspection filename
  // is virtual and is deliberately absent from this actual-layout fixture.
  await fs.mkdir(join(packageRoot, 'apps', 'api', 'dist'), { recursive: true });
  await assert.rejects(fs.stat(join(packageRoot, 'apps', 'api', 'package.json')), { code: 'ENOENT' });
  for (const name of ['control-adoption-attachment.mjs', 'control-adoption-reservation.mjs', 'control-authority.mjs', 'control-command-journal.mjs',
    'control-rpc.mjs', 'io.mjs', 'trust.mjs', 'control-package-manifest.mjs', 'additive-migration-recipe.mjs'])
    await fs.copyFile(resolve('deploy/upgrade', name), join(installer, name));
  // A valid development alternative exists, but cannot rescue an invalid
  // packaged location. These links supply installed dependency bytes only.
  await fs.mkdir(join(f.root, 'api'), { recursive: true }); await fs.writeFile(join(f.root, 'api', 'package.json'), '{}');
  await fs.symlink(resolve('api/node_modules'), join(f.root, 'api', 'node_modules'), 'dir');
  await fs.symlink(resolve('api/apps/api/package.json'), join(packageRoot, 'package.json'));
  const packaged = await import(pathToFileURL(join(installer, 'control-adoption-attachment.mjs')));
  assert.equal((await packaged.createControlAdoptionAttachment(options).run()).reason, 'CONTROL_ADOPTION_API_PACKAGE_INVALID');
  await fs.unlink(join(packageRoot, 'package.json')); await fs.writeFile(join(packageRoot, 'package.json'), '{"type":"commonjs"}');
  await fs.symlink(resolve('api/node_modules'), join(packageRoot, 'node_modules'), 'dir');
  const result = await packaged.createControlAdoptionAttachment(options).run(); assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.equal(f.counts.attach, 1); assert.equal(f.control.prepare('SELECT state FROM control_adoption_reservations').get().state, 'attached');
});

test('an exported attach deadline beyond the original freeze plan is rejected before any passive holder exists', async t => {
  const f = await fixture(t), exportPassive = f.options.exportPassive;
  const result = await createControlAdoptionAttachment({ ...f.options, exportPassive: async input => {
    const output = await exportPassive(input); output.attachConfiguration.spec.deadline += 1; return output;
  } }).run();
  assert.equal(result.reason, 'CONTROL_ADOPTION_EXPORTED_SCOPE_CHANGED'); assert.equal(f.counts.attach, 0);
  assert.equal(f.control.prepare("SELECT 1 FROM sqlite_master WHERE name='control_authority'").get(), undefined);
  assert.equal(f.control.prepare("SELECT 1 FROM sqlite_master WHERE name='control_adoption_reservations'").get(), undefined);
  f.writer.assert();
});

test('completed replay requires intact completion digest and the actual original full GET receipt, including after expiry', async t => {
  const f = await fixture(t), executor = createControlAdoptionAttachment(f.options), completed = await executor.run();
  assert.equal(completed.state, 'completed'); const state = JSON.parse(await fs.readFile(f.options.statePath, 'utf8'));
  f.advance(20001); assert.deepEqual(await createControlAdoptionAttachment(f.options).run(), completed);
  await atomicJson(f.options.statePath, { ...state, completion: { ...state.completion, receiptDigest: digest('corrupt-completion') } });
  assert.equal((await createControlAdoptionAttachment(f.options).run()).reason, 'CONTROL_ADOPTION_COMPLETION_UNCONFIRMED');
  await atomicJson(f.options.statePath, state);
  // Explicit durable corruption stage input. The real HTTP service now observes
  // this loss; no fake status implementation supplies the negative receipt.
  f.business.prepare("UPDATE upgrade_control_attachment SET phase='frozen',attach_config=NULL,attached_receipt=NULL WHERE instance_id=?").run(f.plan.instanceId);
  assert.equal((await createControlAdoptionAttachment(f.options).run()).reason, 'CONTROL_ADOPTION_ATTACH_ACK_UNKNOWN');
  assert.equal(f.counts.freeze, 1); assert.equal(f.counts.attach, 1);
});
