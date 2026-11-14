import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStableEntry } from './stable-entry.mjs';
import { createCoordinatorClient } from './coordinator-client.mjs';
import { observeControlAdoptionEntry, planControlAdoption, assertControlAdoptionPreflight } from './control-adoption-preflight.mjs';

const instanceId = 'adoption-local-protocol-fixture';
const key = 'e'.repeat(32), coordinatorKey = 'c'.repeat(32);
const sha = value => 'sha256:' + value.repeat(64);

async function listener(t, name) {
  const sockets = new Set();
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ backend: name })); });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    // Raw upgraded TCP peers test routing/retention, not browser frame semantics.
    socket.on('data', bytes => socket.write(name + ':' + bytes.toString()));
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(ok => server.close(ok)); });
  return { origin: 'http://127.0.0.1:' + server.address().port };
}

async function fixture(t, independent = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'control-adoption-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const web = join(root, 'web'); await mkdir(web); await writeFile(join(web, 'index.html'), 'existing web');
  const oldApi = await listener(t, 'old'), candidate = await listener(t, 'candidate');
  // Explicit local authority receiver. It checks one fixture authority and is
  // not a production ledger import, Native proof or deployed-binary claim.
  const authority = { attemptId: 'local-original-authorized-attempt', fence: 7, live: true };
  const verifier = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const valid = req.headers['x-platform-internal-key'] === coordinatorKey &&
      req.url === '/internal/upgrades/' + authority.attemptId + '/renew' &&
      body.checkOnly === true && body.controllerId === null && body.fence === authority.fence && authority.live;
    res.writeHead(valid ? 200 : 409, { 'content-type': 'application/json' });
    res.end(JSON.stringify(valid ? { fence: authority.fence } : { code: 'LOCAL_ORIGINAL_AUTHORITY_REQUIRED' }));
  });
  await new Promise(ok => verifier.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise(ok => { verifier.closeAllConnections(); verifier.close(ok); }));
  const coordinator = createCoordinatorClient({ instanceId, origin: 'http://127.0.0.1:' + verifier.address().port, key: coordinatorKey });
  const initialBinding = { instanceId, attemptId: authority.attemptId, fence: authority.fence, routeGeneration: 1,
    weight: 0, oldApi: { origin: oldApi.origin, digest: sha('a') }, candidateApi: null,
    web: { root: web, digest: sha('c'), treeDigest: sha('d') }, retainedWeb: [] };
  const entry = await createStableEntry({ root: join(root, 'entry'), instanceId, controlKey: key,
    stickyKey: 's'.repeat(32), initialBinding, verifyFence: value => coordinator.assertFence(value.attemptId, value.fence),
    ...(independent ? { controlOrigin: oldApi.origin, privateEntryKey: 'p'.repeat(32), verifyControlAuthority: async () => ({ leaseExpiresAt: Date.now() + 60000 }) } : {}) });
  t.after(() => entry.close());
  const metadata = await (await fetch(entry.controlOrigin + '/metadata', { headers: { 'x-platform-internal-key': key } })).json();
  const config = { instanceId, entryControlOrigin: entry.controlOrigin, entryKey: key, expectedRuntime: metadata };
  const request = (path, body) => fetch(entry.controlOrigin + path, { method: 'POST',
    headers: { 'x-platform-internal-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { root, entry, oldApi, candidate, authority, config, metadata, request, initialBinding };
}

test('actual legacy-mode listener lacks epoch admission despite metadata self-description; preflight only makes GETs', async t => {
  const f = await fixture(t), requests = [];
  assert.equal(f.metadata.independentFoundation, true, 'metadata label alone does not establish protocol support');
  const observation = await observeControlAdoptionEntry(f.config, { fetcher: (url, init) => { requests.push([new URL(url).pathname, init.method]); return fetch(url, init); } });
  assert.equal(observation.entryControlEpoch.supported, false);
  assert.equal(observation.entryControlEpoch.status, 409);
  assert.deepEqual(requests, ['/metadata', '/binding', '/control-epoch', '/binding', '/metadata'].map(path => [path, 'GET']));
  const plan = planControlAdoption(observation);
  assert.equal(plan.state, 'blocked'); assert.equal(plan.authorizesMutation, false);
  assert.equal(plan.blockers[0], 'CONTROL_ADOPTION_ENTRY_EPOCH_UNSUPPORTED');
  assert.ok(plan.requiredLegacyMutationRevocations.includes('/activate-installer'));
  assert.throws(() => assertControlAdoptionPreflight(observation), { code: 'CONTROL_ADOPTION_ENTRY_EPOCH_UNSUPPORTED' });
  assert.deepEqual(f.entry.observe().oldApi, f.initialBinding.oldApi);
});

test('new disk configuration and arbitrary JSON capability claims cannot upgrade a running legacy listener', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'new-independent-control-config.json'), JSON.stringify({ controlOrigin: f.candidate.origin, supportingProtocol: true, oldSupervisorPassive: true }));
  const observation = await observeControlAdoptionEntry(f.config);
  assert.equal(planControlAdoption(observation).entryProtocol, 'legacy-or-unsupported');
  const copied = JSON.parse(JSON.stringify(observation)); copied.entryControlEpoch.supported = true;
  assert.throws(() => planControlAdoption(copied), { code: 'CONTROL_ADOPTION_OBSERVATION_REQUIRED' });
  assert.throws(() => planControlAdoption({ supportingProtocol: true, oldSupervisorPassive: true }), { code: 'CONTROL_ADOPTION_OBSERVATION_REQUIRED' });
});

test('actual independent-mode endpoint is distinguished but cannot self-prove public routing or legacy revocation', async t => {
  const f = await fixture(t, true), observation = await observeControlAdoptionEntry(f.config);
  assert.equal(observation.entryControlEpoch.supported, true);
  const plan = planControlAdoption(observation);
  assert.equal(plan.entryProtocol, 'independent-epoch-observed'); assert.equal(plan.qualified, false);
  assert.deepEqual(plan.blockers, ['CONTROL_ADOPTION_PUBLIC_CONTROL_ROUTE_UNPROVEN',
    'CONTROL_ADOPTION_LEGACY_FENCE_DELEGATION_UNPROVEN', 'CONTROL_ADOPTION_SUPERVISOR_REVOCATION_UNPROVEN',
    'CONTROL_ADOPTION_LEGACY_SETTLEMENT_REQUIRED']);
  assert.equal(plan.admissionAuthorized, false);
});

test('wrong credentials and changed runtime anchors are rejected rather than classified as missing protocol', async t => {
  const f = await fixture(t);
  await assert.rejects(observeControlAdoptionEntry({ ...f.config, entryKey: 'x'.repeat(32) }), { code: 'CONTROL_ADOPTION_RPC_REJECTED' });
  await assert.rejects(observeControlAdoptionEntry({ ...f.config, expectedRuntime: { ...f.metadata, startIdentity: 'different-runtime' } }), { code: 'CONTROL_ADOPTION_ENTRY_IDENTITY_CHANGED' });
});

test('route changes during the read sequence prevent a stable observation', async t => {
  const f = await fixture(t); let bindingReads = 0;
  await assert.rejects(observeControlAdoptionEntry(f.config, { fetcher: async (url, init) => {
    if (new URL(url).pathname === '/binding' && ++bindingReads === 2)
      assert.equal((await f.request('/binding', { ...f.initialBinding, routeGeneration: 2 })).status, 200);
    return fetch(url, init);
  } }), { code: 'CONTROL_ADOPTION_ENTRY_BINDING_CHANGED' });
});

test('an unavailable or foreign epoch response is unknown rather than evidence of a legacy protocol', async t => {
  const f = await fixture(t);
  // Explicit response ports exercise rejection; the remaining real HTTP reads
  // still come from the unchanged Entry. Neither case creates an observation.
  for (const [status, value] of [[503, { code: 'CONTROL_HTTP_BUSY' }],
    [200, { schemaVersion: 1, instanceId: 'foreign-instance', revision: 0, epoch: 0, leaseExpiresAt: 0 }]]) {
    await assert.rejects(observeControlAdoptionEntry(f.config, { fetcher: (url, init) =>
      new URL(url).pathname === '/control-epoch'
        ? Promise.resolve(new Response(JSON.stringify(value), { status })) : fetch(url, init) }),
    { code: 'CONTROL_ADOPTION_ENTRY_EPOCH_UNPROVEN' });
  }
});

function upgraded(origin) {
  return new Promise((ok, fail) => {
    const request = http.request(origin + '/socket.io/', { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' } });
    request.once('upgrade', (_response, socket) => ok(socket)); request.once('error', fail); request.end();
  });
}
function echo(socket, text) { return new Promise(ok => { socket.once('data', bytes => ok(bytes.toString())); socket.write(text); }); }

test('existing binding protocol can route new HTTP and upgraded TCP without moving the old connection or accepting a fabricated authority', async t => {
  const f = await fixture(t), oldSocket = await upgraded(f.entry.origin); t.after(() => oldSocket.destroy());
  assert.equal(await echo(oldSocket, 'before'), 'old:before');
  const next = { ...f.initialBinding, routeGeneration: 2, weight: 100, candidateApi: { origin: f.candidate.origin, digest: sha('b') } };
  assert.equal((await f.request('/binding', next)).status, 200);
  assert.deepEqual(await (await fetch(f.entry.origin + '/api/health')).json(), { backend: 'candidate' });
  assert.equal(await echo(oldSocket, 'after'), 'old:after');
  const newSocket = await upgraded(f.entry.origin); t.after(() => newSocket.destroy());
  assert.equal(await echo(newSocket, 'new'), 'candidate:new');
  const forged = await f.request('/fence', { instanceId, attemptId: 'new-control-attempt-with-no-legacy-authority', fence: 900 });
  assert.equal(forged.status, 409); assert.equal((await forged.json()).code, 'LOCAL_ORIGINAL_AUTHORITY_REQUIRED');
  assert.equal(f.entry.observe().fence, f.authority.fence);
  assert.equal(planControlAdoption(await observeControlAdoptionEntry(f.config)).qualified, false);
});
