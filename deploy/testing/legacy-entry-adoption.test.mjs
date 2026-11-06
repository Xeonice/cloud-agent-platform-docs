import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createStableEntry as createHistoricalEntry } from './legacy-entry-208342/stable-entry.mjs';
import { createStableEntry as createInnerEntry } from '../upgrade/stable-entry.mjs';
import { digest, runInputFingerprint, signQualificationManifest } from '../upgrade/trust.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));
const appRequire = createRequire(new URL('../../api/apps/api/package.json', import.meta.url));
const socketIoRequire = createRequire(appRequire.resolve('socket.io'));
const engineIoRequire = createRequire(socketIoRequire.resolve('engine.io'));
const { WebSocket, WebSocketServer } = engineIoRequire('ws');
const { createConnection, runMigrations } = apiRequire('./apps/api/dist/platform/persistence/drizzle.connection.js');
const { UpgradeStore } = apiRequire('./apps/api/dist/platform/upgrade/upgrade-store.js');
const { UpgradeService } = apiRequire('./apps/api/dist/platform/upgrade/upgrade-service.js');
const { UpgradeInspector } = apiRequire('./apps/api/dist/platform/upgrade/upgrade-inspector.js');
const { freezeUpgradePlan, verifyUpgradeEnvelope } = apiRequire('./apps/api/dist/platform/upgrade/upgrade-trust.js');
const { ConfirmedServiceReleaseSchema } = apiRequire('./packages/contracts/dist/index.js');

const instanceId = 'historical-entry-dataplane-poc';
const key = 'isolated-legacy-entry-controller-key-32';
const unused = label => new Proxy({}, { get(_target, name) { throw Error(label + '.' + String(name) + ' is outside this data-plane experiment'); } });

async function backend(name, closes) {
  const sockets = new Set(), upgraded = new Set();
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ backend: name }));
  });
  server.on('connection', socket => { sockets.add(socket);socket.once('close', () => sockets.delete(socket)); });
  const ws = new WebSocketServer({ noServer: true });
  ws.on('connection', socket => {
    upgraded.add(socket);socket.once('close', () => upgraded.delete(socket));
    socket.on('message', bytes => socket.send(name + ':' + bytes.toString()));
  });
  server.on('upgrade', (req, socket, head) => ws.handleUpgrade(req, socket, head, peer => ws.emit('connection', peer, req)));
  await new Promise((ok, fail) => { server.once('error', fail);server.listen(0, '127.0.0.1', ok); });
  closes.push(async () => {
    for (const peer of upgraded) peer.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise(ok => ws.close(ok));
    await new Promise(ok => server.close(ok));
  });
  return { origin: 'http://127.0.0.1:' + server.address().port };
}

function binding(root, oldApi, instance = instanceId) {
  return { instanceId: instance, attemptId: 'initial-source-binding', fence: 1, routeGeneration: 1,
    weight: 0, oldApi, candidateApi: null,
    web: { root, digest: digest({ localWebFixture: true }), treeDigest: digest({ localWebTree: true }) }, retainedWeb: [] };
}

async function fixture(t) {
  const closes = [];
  t.after(async () => { for (const close of closes.reverse()) await close(); });
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'historical-entry-poc-')));
  closes.push(() => fs.rm(root, { recursive: true, force: true }));
  const values = { PLATFORM_INSTANCE_ID: instanceId, MIGRATIONS_DIR: join(repository, 'api/drizzle'),
    UPGRADE_CONTROL_DATABASE_PATH: undefined, PLATFORM_ENTRY_CONTROL_ORIGIN: undefined, PLATFORM_ENTRY_CONTROL_KEY: key };
  const prior = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];else process.env[name] = value;
  }
  closes.push(() => { for (const [name, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[name];else process.env[name] = value;
  } });
  const connection = createConnection(join(root, 'platform.db'));
  runMigrations(connection.db, connection.sqlite);
  closes.push(() => { connection.sqlite.close(); });
  const clock = { now: () => new Date() }, store = new UpgradeStore(connection.sqlite, clock, { next: randomUUID }, { instanceId });
  const checks = [];
  const verifyFence = async value => {
    // This is the real accepted SQLite authority. No boolean fixture can grant a fence.
    const result = store.renew(value.attemptId, value.fence, null, true);
    checks.push({ attemptId: value.attemptId, fence: result.fence });
    return result;
  };
  const oldApi = await backend('old', closes), newApi = await backend('new', closes);
  const web = join(root, 'web');await fs.mkdir(web);await fs.writeFile(join(web, 'index.html'), 'original local fixture web');
  const oldDigest = digest({ localBackend: 'old', origin: oldApi.origin });
  const inner = await createInnerEntry({ root: join(root, 'inner'), instanceId, controlKey: key,
    stickyKey: 's'.repeat(32), verifyFence,
    initialBinding: binding(web, { origin: newApi.origin, digest: digest({ localBackend: 'new', origin: newApi.origin }) }) });
  closes.push(() => inner.close());
  // Deliberately no controlOrigin/privateEntryKey/ControlAgent: inner data plane
  // is real, but independent control routing/adoption is not being qualified.
  const innerMetadata = await (await fetch(inner.controlOrigin + '/metadata', { headers: { 'x-platform-internal-key': key } })).json();
  const outer = await createHistoricalEntry({ root: join(root, 'outer'), instanceId, controlKey: key,
    stickyKey: 's'.repeat(32), verifyFence, initialBinding: binding(web, { origin: oldApi.origin, digest: oldDigest }) });
  closes.push(() => outer.close());
  process.env.PLATFORM_ENTRY_CONTROL_ORIGIN = outer.controlOrigin;
  const component = { artifactDigest: oldDigest, inputFingerprint: oldDigest, sourceRevision: 'a'.repeat(40), protocol: { min: 1, max: 2 } };
  const schema = connection.sqlite.prepare('SELECT count(*) n FROM __drizzle_migrations').get().n;
  const source = ConfirmedServiceReleaseSchema.parse({ releaseId: 'v0.0.1', activationGeneration: 1,
    activatedAt: clock.now().toISOString(), schema, channel: 'local-dataplane-contract',
    components: { api: component, coordinator: component, installer: component,
      web: { ...component, webRevision: 'a'.repeat(40) } },
    commits: { project: 'a'.repeat(40), api: 'a'.repeat(40), web: 'a'.repeat(40) }, productionWebBinding: outer.origin });
  store.bootstrap(source);
  // Synthetic local release identities exercise the real state/crypto contract.
  // The gateway digest is its actual computed metadata, never a forged API digest.
  // No package is installed and no artifact/native qualification is claimed.
  const manifest = { schemaVersion: 2, purpose: 'qualification', releaseId: 'v0.0.2-local.dataplane',
    channel: source.channel, publishedAt: clock.now().toISOString(), commits: source.commits,
    components: { ...source.components, api: { ...component, artifactDigest: innerMetadata.artifactDigest, inputFingerprint: innerMetadata.inputFingerprint } },
    packages: [{ platform: process.platform, arch: process.arch, name: 'not-an-installable-package',
      url: 'https://local-fixture.invalid/not-installed', digest: digest({ stateContractOnly: true }), bytes: 1, format: 'native-tar' }],
    upgradePaths: [{ fromRelease: source.releaseId, minSchema: schema, maxSchema: schema, targetSchema: schema, bridgeReleases: [], migrationPlanDigest: null }],
    policy: { id: 'dataplane-poc-only', weights: [1, 5, 25, 100], stageDurationMs: 60000, minRequests: 100,
      observationFreshnessMs: 5000, probeHz: 10, requestDeadlineMs: 2000, attachDeadlineMs: 5000,
      softErrorDelta: 0.01, p95Ratio: 2, p95FloorMs: 1000, evaluationIntervalMs: 10000, consecutiveEvaluations: 2,
      retentionMs: 60000, migrationBatchMs: 500, maxWalBytes: 1000000, minFreeBytes: 1000000,
      fallbacks: [{ releaseId: source.releaseId, apiDigest: oldDigest, webDigest: source.components.web.artifactDigest, rehearsed: false }],
      stopUserResources: false, restoreLiveVolume: false, contractInUpgrade: false }, evidence: [] };
  manifest.qualification = { instanceId, inputFingerprint: runInputFingerprint(manifest) };
  const keys = generateKeyPairSync('ed25519');
  const envelope = signQualificationManifest(manifest, 'local-only', keys.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const roots = { schemaVersion: 1, purpose: 'qualification', qualificationInstanceId: instanceId, channel: source.channel,
    distributionOrigins: ['https://local-fixture.invalid'], keys: [{ id: 'local-only', publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }) }] };
  const trusted = verifyUpgradeEnvelope(envelope, roots, clock.now().getTime());
  const accepted = store.accept('explicit-local-actor', { requestId: randomUUID(), targetReleaseId: manifest.releaseId,
    targetDigest: trusted.manifestDigest, expectedActivationGeneration: source.activationGeneration }, trusted, freezeUpgradePlan(trusted, source));
  const inspector = new UpgradeInspector(store, clock, unused('providers'), unused('migration'), unused('security'),
    unused('passcodes'), unused('job receipts'), unused('exec'), unused('probe evidence'));
  const service = new UpgradeService(store, unused('catalog'), unused('security'), inspector, clock);
  closes.push(() => service.onModuleDestroy());
  // Actual service reads the Entry over HTTP, claims the original attempt in
  // SQLite, and POSTs /fence. The historical Entry verifies that exact live lease.
  const claim = await service.claim(accepted.attemptId, 'local-controller', 120000);
  const initial = outer.observe();
  const next = { instanceId, attemptId: accepted.attemptId, fence: claim.fence, routeGeneration: initial.routeGeneration + 1,
    weight: 100, oldApi: initial.oldApi, candidateApi: { origin: inner.origin, digest: innerMetadata.artifactDigest },
    web: initial.web, retainedWeb: initial.retainedWeb };
  const post = async (path, body, presentedKey = key) => {
    const response = await fetch(outer.controlOrigin + path, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-platform-internal-key': presentedKey }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000) });
    return { status: response.status, body: await response.json() };
  };
  return { root, outer, inner, store, accepted, claim, next, post, checks, closes };
}

async function websocket(origin, closes) {
  const socket = new WebSocket(origin.replace(/^http:/, 'ws:') + '/socket.io/');
  closes.push(() => { socket.terminate(); });
  await new Promise((ok, fail) => { socket.once('open', ok);socket.once('error', fail); });
  return socket;
}
function echo(socket, text) {
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => finish(Error('WebSocket response deadline exceeded')), 3000);
    const finish = error => { clearTimeout(timer);socket.off('message', message);socket.off('close', closed);if (error) fail(error); };
    const closed = () => finish(Error('Existing WebSocket closed unexpectedly'));
    const message = bytes => { finish();ok(bytes.toString()); };
    socket.once('message', message);socket.once('close', closed);socket.send(text);
  });
}
function read(origin, agent) {
  return new Promise((ok, fail) => {
    const request = http.get(origin + '/api/health', { agent }, response => {
      let bytes = '';response.on('data', chunk => { bytes += chunk; });
      response.on('end', () => { try { ok({ status: response.statusCode, body: JSON.parse(bytes), socket: request.socket }); } catch (error) { fail(error); } });
    });
    request.once('error', fail);request.setTimeout(3000, () => request.destroy(Error('HTTP response deadline exceeded')));
  });
}

test('historical runtime source closure is exact, self-contained and outside the production installer copy root', async () => {
  const folder = new URL('./legacy-entry-208342/', import.meta.url);
  const provenance = JSON.parse(await fs.readFile(new URL('provenance.json', folder), 'utf8'));
  assert.equal(provenance.sourceCommit, '208342ea994555c12c3ba42ce3b6aabd0afe9df1');
  assert.equal(provenance.files.find(file => file.path === 'stable-entry.mjs').sha256, 'eac771a268b4e1be2a39f9ca16f71f2a747dba7795ce09c9d27582f7364a483a');
  for (const file of provenance.files) {
    const bytes = await fs.readFile(new URL(file.path, folder));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    if (file.use !== 'loaded-original-runtime') continue;
    for (const match of bytes.toString().matchAll(/\bfrom\s+['"](\.\/?[^'"]+)['"]/g)) {
      assert.ok(provenance.runtimeClosure.includes(match[1].replace(/^\.\//, '')), 'Every executed relative import stays in the original closure');
    }
  }
  const fixturePath = fileURLToPath(folder), production = resolve(repository, 'deploy/upgrade');
  assert.ok(relative(production, fixturePath).startsWith('..'));
  const packaging = await fs.readFile(new URL('../jenkins/instance-package.mjs', import.meta.url), 'utf8');
  assert.match(packaging, /fs\.cp\(join\(project,'deploy\/upgrade'\),join\(built,'installer'\)/);
});

test('real accepted lease routes new HTTP through a nested Entry on the same public socket while the original WebSocket stays on its old backend', { timeout: 20000 }, async t => {
  const f = await fixture(t), listener = f.outer.server, address = listener.address();
  const agent = new http.Agent({ keepAlive: true });f.closes.push(() => agent.destroy());
  const before = await read(f.outer.origin, agent);
  assert.deepEqual(before.body, { backend: 'old' });
  const oldSocket = await websocket(f.outer.origin, f.closes);
  assert.equal(await echo(oldSocket, 'before'), 'old:before');
  assert.ok(f.checks.some(check => check.attemptId === f.accepted.attemptId && check.fence === f.claim.fence));
  assert.equal(f.store.snapshot(f.accepted.attemptId).fence, f.claim.fence);
  const switched = await f.post('/binding', f.next);
  assert.equal(switched.status, 200);
  const after = await read(f.outer.origin, agent);
  assert.deepEqual(after.body, { backend: 'new' });
  assert.equal(after.socket, before.socket, 'An existing HTTP keep-alive TCP connection also uses the new binding on its next request');
  assert.equal(f.outer.server, listener);assert.equal(listener.listening, true);assert.deepEqual(listener.address(), address);
  assert.equal(oldSocket.readyState, WebSocket.OPEN);
  assert.equal(await echo(oldSocket, 'after'), 'old:after');
  const newSocket = await websocket(f.outer.origin, f.closes);
  assert.equal(await echo(newSocket, 'new'), 'new:new');
  assert.deepEqual(f.outer.observe().wsByDigest, { [f.next.oldApi.digest]: 1, [f.next.candidateApi.digest]: 1 });
  assert.deepEqual(f.inner.observe().wsByDigest, { [f.inner.observe().oldApi.digest]: 1 });
  const unsupported = await fetch(f.outer.controlOrigin + '/control-epoch', { headers: { 'x-platform-internal-key': key } });
  assert.equal(unsupported.status, 409, 'A successful nested data route does not add independent epoch/adoption support to the old Entry');
});

test('wrong credentials, fabricated authority and conflicting route generations cannot alter the historical binding', { timeout: 20000 }, async t => {
  const f = await fixture(t), initial = f.outer.observe();
  assert.equal((await f.post('/binding', f.next, 'wrong-controller-key')).status, 403);
  const forged = await f.post('/fence', { instanceId, attemptId: randomUUID(), fence: f.claim.fence + 100 });
  assert.equal(forged.status, 409);
  assert.equal(forged.body.code, 'UPGRADE_ATTEMPT_NOT_FOUND');
  assert.equal((await f.post('/binding', { ...f.next, attemptId: randomUUID() })).status, 409);
  const conflict = await f.post('/binding', { ...f.next, routeGeneration: initial.routeGeneration });
  assert.equal(conflict.status, 409);assert.equal(conflict.body.code, 'ROUTE_GENERATION_CONFLICT');
  assert.deepEqual(f.outer.observe().oldApi, initial.oldApi);assert.equal(f.outer.observe().routeGeneration, initial.routeGeneration);
  assert.deepEqual((await read(f.outer.origin)).body, { backend: 'old' });
});

test('revoking the actual accepted controller lease prevents a later route change without closing old data-plane sockets', { timeout: 20000 }, async t => {
  const f = await fixture(t), oldSocket = await websocket(f.outer.origin, f.closes);
  assert.equal((await f.post('/binding', f.next)).status, 200);
  f.store.transferController(f.accepted.attemptId, f.claim.fence);
  const expired = await f.post('/binding', { ...f.next, routeGeneration: f.next.routeGeneration + 1, weight: 0 });
  assert.equal(expired.status, 409);assert.equal(expired.body.code, 'UPGRADE_FENCE_EXPIRED');
  assert.equal(f.outer.observe().routeGeneration, f.next.routeGeneration);
  assert.deepEqual((await read(f.outer.origin)).body, { backend: 'new' });
  assert.equal(await echo(oldSocket, 'still-running'), 'old:still-running');
});
