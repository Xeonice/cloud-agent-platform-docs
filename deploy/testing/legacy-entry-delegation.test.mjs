import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createControlAuthority } from '../upgrade/control-authority.mjs';
import { createControlCommandJournal } from '../upgrade/control-command-journal.mjs';
import { createLegacyEntryDelegationAdapter, validateLegacyEntryDelegation } from '../upgrade/legacy-entry-delegation.mjs';
import { createStableEntry as historicalEntry } from './legacy-entry-208342/stable-entry.mjs';
import { createStableEntry as gatewayEntry } from '../upgrade/stable-entry.mjs';
import { canonical, digest } from '../upgrade/trust.mjs';
import { persistedEntryBinding } from '../upgrade/control-entry-context.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const appRequire = createRequire(new URL('../../api/apps/api/package.json', import.meta.url));
const ioRequire = createRequire(appRequire.resolve('socket.io'));
const { WebSocket, WebSocketServer } = createRequire(ioRequire.resolve('engine.io'))('ws');
const Database = require('better-sqlite3');
const deferred = () => { let resolve;const promise = new Promise(ok => { resolve = ok; });return { promise, resolve }; };
const instanceId = 'legacy-entry-delegation-local-protocol';
const entryKey = 'isolated-exclusive-old-entry-key-32';
const gatewayKey = 'isolated-gateway-metadata-key-32';
const clone = value => JSON.parse(JSON.stringify(value));

async function backend(closes, label) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ label, routeGeneration: req.headers['x-platform-route-generation'] ?? null }));
  });
  const ws = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => ws.handleUpgrade(req, socket, head, peer => ws.emit('connection', peer, req)));
  ws.on('connection', peer => peer.on('message', bytes => peer.send(label + ':' + bytes.toString())));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  closes.push(async () => { for (const peer of ws.clients) peer.terminate();await new Promise(ok => ws.close(ok));server.closeAllConnections();await new Promise(ok => server.close(ok)); });
  return { origin: 'http://127.0.0.1:' + server.address().port, digest: digest({ explicitSyntheticBusinessArtifact: label }) };
}
async function fixture(t, { wrongGatewayBusiness = false } = {}) {
  const closes = [];t.after(async () => { for (const close of closes.reverse()) await close(); });
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'legacy-entry-delegation-')));
  closes.push(() => fs.rm(root, { recursive: true, force: true }));
  const web = join(root, 'web');await fs.mkdir(web);await fs.writeFile(join(web, 'index.html'), 'unchanged original web');
  const business = await backend(closes, 'same-original-business'), other = await backend(closes, 'different-business');
  const before = { instanceId, attemptId: 'original-serving', fence: 7, routeGeneration: 12, weight: 0,
    oldApi: business, candidateApi: null, web: { root: web, digest: digest('original-web'), treeDigest: digest('original-web-tree') }, retainedWeb: [] };
  let now = Date.now(), sqlite, authority, journal, spec;
  const clock = () => now, databasePath = join(root, 'control.sqlite');
  function open() {
    sqlite = new Database(databasePath);
    authority = createControlAuthority({ sqlite, instanceId, clock });
    journal = createControlCommandJournal({ sqlite, instanceId, clock, assertAuthority: a =>
      authority.assert({ operationId: a.operationId, epoch: a.epoch, executorId: a.executorId, kind: 'maintenance' }) });
  }
  open();closes.push(() => sqlite.close());
  const grants = new Map(), checks = [], requests = [];
  // Actual old Entry calls only this tuple-only port: it has NO command body.
  // In this isolated fixture its key is freshly owned and no old Installer,
  // Supervisor, watcher or outside writer exists. These facts are NOT proof for
  // a deployed installation. The current production API's renew remains closed.
  const outer = await historicalEntry({ root: join(root, 'old-entry'), instanceId, controlKey: entryKey, stickyKey: 's'.repeat(32),
    initialBinding: before, verifyFence: async value => {
      const row = journal.lookup(spec);checks.push(clone(value));
      assert.equal(value.instanceId, instanceId);assert.equal(value.attemptId, spec.operationId);assert.equal(value.fence, spec.epoch);
      assert.equal(row.state, 'executing');assert.equal(row.specDigest, digest(spec));
      return authority.assert({ operationId: spec.operationId, epoch: spec.epoch, executorId: spec.executorId, kind: 'maintenance' });
    } });
  closes.push(() => outer.close());
  const innerBinding = { ...before, attemptId: 'gateway-original-serving', routeGeneration: 101,
    oldApi: wrongGatewayBusiness ? other : business };
  const inner = await gatewayEntry({ root: join(root, 'gateway'), instanceId, controlKey: gatewayKey,
    stickyKey: 'g'.repeat(32), verifyFence: async () => {}, initialBinding: innerBinding });
  closes.push(() => inner.close());
  async function runtime(entry, key) {
    const { observedAt, ...value } = await (await fetch(entry.controlOrigin + '/metadata', { headers: { 'x-platform-internal-key': key } })).json();
    return value;
  }
  const oldRuntime = await runtime(outer, entryKey), gatewayRuntime = await runtime(inner, gatewayKey);
  const operationId = 'delegation-' + randomUUID();
  spec = { schemaVersion: 1, kind: 'legacy-entry-binding', instanceId, operationId, commandId: 'delegate-api', epoch: 8,
    executorId: 'isolated-maintenance-executor', deadline: now + 10000,
    entry: { controlOrigin: outer.controlOrigin, runtime: oldRuntime }, before,
    after: { ...before, attemptId: operationId, fence: 8, routeGeneration: 13, weight: 100,
      candidateApi: { origin: inner.origin, digest: gatewayRuntime.artifactDigest } },
    gateway: { origin: inner.origin, controlOrigin: inner.controlOrigin, runtime: gatewayRuntime },
    business: { releaseId: 'fixture-current-business', confirmedDigest: digest({ explicitSyntheticConfirmedRelease: true, api: business }), api: business },
    controlPackageDigest: digest('explicit-fixture-control-package-not-installed'),
    settlementReceiptDigest: digest('fixture-closed-actors-no-upgrade-intent'), custodyReceiptDigest: digest('fixture-exclusive-key') };
  authority.activate({ expectedRevision: 1, sourceBindingDigest: digest(before) });
  authority.grant({ operationId, epoch: spec.epoch, executorId: spec.executorId, kind: 'maintenance', leaseMs: 120000 });
  function register(value) { grants.set(digest(value), clone(value)); }
  register(spec);
  const trusted = value => {
    // Mandatory future production port, explicitly a FIXTURE grant here.
    // No persisted, signed or current deployment custody/settlement is claimed.
    assert.equal(canonical(grants.get(digest(value))), canonical(value), 'fixture has no grant for this fixed spec');
    const facts = { schemaVersion: 1, kind: 'legacy-entry-delegation-grant', instanceId,
      operationId: value.operationId, commandId: value.commandId, epoch: value.epoch, executorId: value.executorId,
      specDigest: digest(value), deadline: value.deadline, controlPackageDigest: value.controlPackageDigest,
      settlementReceiptDigest: value.settlementReceiptDigest, custodyReceiptDigest: value.custodyReceiptDigest,
      confirmedDigest: value.business.confirmedDigest, legacyEntryKeyExclusive: true,
      legacyActorsClosed: true, legacyActionsSettled: true };
    return { ...facts, receiptDigest: digest(facts) };
  };
  const tracked = async (url, init) => { requests.push({ method: init.method, origin: new URL(url).origin,
    path: new URL(url).pathname, ...(init.body ? { body: JSON.parse(init.body) } : {}) });return fetch(url, init); };
  const adapter = (overrides = {}) => createLegacyEntryDelegationAdapter({ instanceId, authority, journal,
    entryKey, gatewayKey, assertDelegation: trusted, fetcher: tracked, clock, ...overrides });
  return { root, spec, outer, inner, business, other, requests, checks, clock, trusted, tracked, register, adapter,
    get journal() { return journal; }, get authority() { return authority; },
    advance(ms) { now += ms; }, reopen() { sqlite.close();open(); },
    posts: () => requests.filter(r => r.method === 'POST' && r.origin === outer.controlOrigin) };
}
async function socket(origin) {
  const peer = new WebSocket(origin.replace('http:', 'ws:') + '/socket.io/');
  await new Promise((ok, fail) => { peer.once('open', ok);peer.once('error', fail); });return peer;
}
async function echo(peer, text) { const received = new Promise(ok => peer.once('message', bytes => ok(bytes.toString())));peer.send(text);return received; }

test('real Authority/journal/executor and historical Entry perform exactly two fixed POSTs with distinct gateway/business identities', async t => {
  const f = await fixture(t), oldSocket = await socket(f.outer.origin);t.after(() => oldSocket.terminate());
  assert.equal(await echo(oldSocket, 'before'), 'same-original-business:before');
  const receipt = await f.adapter().execute(f.spec);
  assert.equal(receipt.kind, 'legacy-entry-binding-receipt');assert.equal(receipt.specDigest, digest(f.spec));
  assert.equal(receipt.admissionAuthorized, false);assert.equal(receipt.fullAdoptionQualified, false);
  assert.deepEqual(f.posts().map(p => p.path), ['/fence', '/binding']);
  assert.deepEqual(f.posts()[0].body, { instanceId, attemptId: f.spec.operationId, fence: f.spec.epoch });
  assert.deepEqual(f.posts()[1].body, f.spec.after);assert.equal(f.checks.length, 2);
  assert.deepEqual(persistedEntryBinding(f.outer.observe()), f.spec.after);
  assert.equal((await (await fetch(f.outer.origin + '/api/health')).json()).routeGeneration, '101', 'new HTTP actually crosses the inner gateway');
  assert.equal(await echo(oldSocket, 'after'), 'same-original-business:after');
  assert.equal(f.inner.observe().activeWS, 0, 'existing WebSocket was not moved');
  const newSocket = await socket(f.outer.origin);t.after(() => newSocket.terminate());
  assert.equal(await echo(newSocket, 'new'), 'same-original-business:new');assert.equal(f.inner.observe().activeWS, 1);
  assert.equal(await (await fetch(f.outer.origin + '/')).text(), 'unchanged original web');
  assert.equal(f.journal.lookup(f.spec).state, 'applied');
  assert.deepEqual(await f.adapter().execute(f.spec), receipt);assert.equal(f.posts().length, 2);
});

test('v1 rejects Web mutation, old-route mutation, non-next generation and gateway/API identity conflation before dispatch', async t => {
  const f = await fixture(t);
  for (const mutate of [s => { s.after.web.digest = digest('changed-web'); },
    s => { s.after.oldApi = { ...s.after.oldApi, origin: 'http://127.0.0.1:1' }; },
    s => { s.after.routeGeneration++; }, s => { s.after.fence++; },
    s => { s.gateway.runtime.artifactDigest = s.business.api.digest;s.after.candidateApi.digest = s.business.api.digest; }]) {
    const changed = clone(f.spec);mutate(changed);
    assert.throws(() => validateLegacyEntryDelegation(changed));
  }
  assert.equal(f.posts().length, 0);assert.equal(f.journal.lookup(f.spec), null);
});

test('actual gateway binding to a different business blocks before the first POST', async t => {
  const f = await fixture(t, { wrongGatewayBusiness: true });
  await assert.rejects(f.adapter().execute(f.spec), { code: 'LEGACY_ENTRY_GATEWAY_BUSINESS_CHANGED' });
  assert.equal(f.posts().length, 0);assert.equal(f.journal.lookup(f.spec).state, 'unknown');
});

test('mandatory trusted receipt has no default grant and binds custody, settlement, confirmed release and spec exactly', async t => {
  const f = await fixture(t);
  assert.throws(() => createLegacyEntryDelegationAdapter({ instanceId, authority: f.authority, journal: f.journal, entryKey, gatewayKey }),
    { code: 'LEGACY_ENTRY_DELEGATION_CONFIG_REQUIRED' });
  for (const field of ['custodyReceiptDigest', 'settlementReceiptDigest', 'confirmedDigest', 'specDigest', 'legacyEntryKeyExclusive', 'legacyActorsClosed']) {
    await assert.rejects(f.adapter({ assertDelegation: spec => {
      const proof = clone(f.trusted(spec));proof[field] = typeof proof[field] === 'boolean' ? false : digest('not-original');return proof;
    } }).execute(f.spec), { code: 'LEGACY_ENTRY_DELEGATION_RECEIPT_MISMATCH' });
  }
  await assert.rejects(f.adapter({ assertDelegation: async spec => f.trusted(spec) }).execute(f.spec),
    { code: 'LEGACY_ENTRY_DELEGATION_CHECK_MUST_BE_SYNCHRONOUS' });
  assert.equal(f.posts().length, 0);assert.equal(f.journal.lookup(f.spec), null);
});

test('lost binding ACK survives actual SQLite reopen; exact after may be recorded past original deadline without a new POST', async t => {
  const f = await fixture(t);let lose = true;
  const adapter = f.adapter({ fetcher: async (url, init) => {
    const response = await f.tracked(url, init);
    if (url === f.outer.controlOrigin + '/binding' && init.method === 'POST' && lose) {
      lose = false;await response.arrayBuffer();throw Object.assign(Error('fixture dropped ACK'), { code: 'FIXTURE_ACK_LOST' });
    }
    return response;
  } });
  await assert.rejects(adapter.execute(f.spec), { code: 'FIXTURE_ACK_LOST' });
  assert.equal(f.journal.lookup(f.spec).state, 'unknown');const original = clone(f.journal.lookup(f.spec).spec);
  f.reopen();f.advance(10001);
  const afterDeadline = await f.adapter().inspectOriginal(f.spec);
  assert.equal(afterDeadline.observedApplied, true);assert.equal(afterDeadline.authorityValid, true);
  assert.equal(afterDeadline.deadlineExpired, true);assert.equal(f.journal.lookup(f.spec).state, 'unknown');
  const receipt = await f.adapter().execute(f.spec);
  assert.equal(receipt.lookup, true);assert.equal(receipt.originalDeadline, f.spec.deadline);
  assert.equal(f.posts().length, 2);assert.equal(f.journal.lookup(f.spec).state, 'applied');
  assert.deepEqual(f.journal.lookup(f.spec).spec, original);
});

test('a fence ACK loss with original before binding stays unknown; neither another command nor deadline refresh can dispatch', async t => {
  const f = await fixture(t);
  await assert.rejects(f.adapter({ fetcher: async (url, init) => {
    const response = await f.tracked(url, init);
    if (url === f.outer.controlOrigin + '/fence' && init.method === 'POST') {
      await response.arrayBuffer();throw Object.assign(Error('fixture fence ACK lost'), { code: 'FIXTURE_ACK_LOST' });
    }
    return response;
  } }).execute(f.spec), { code: 'FIXTURE_ACK_LOST' });
  f.advance(10001);
  const observation = await f.adapter().inspectOriginal(f.spec);
  assert.equal(observation.observedBinding, 'before');assert.equal(observation.observedApplied, false);
  await assert.rejects(f.adapter().execute(f.spec), { code: 'CONTROL_COMMAND_RESULT_UNKNOWN' });
  const another = { ...clone(f.spec), commandId: 'different-command', deadline: f.clock() + 10000 };f.register(another);
  await assert.rejects(f.adapter().execute(another), { code: 'LEGACY_ENTRY_OTHER_COMMAND_UNSETTLED' });
  const refreshed = { ...clone(f.spec), deadline: f.clock() + 10000 };f.register(refreshed);
  await assert.rejects(f.adapter().execute(refreshed), { code: 'CONTROL_COMMAND_SPEC_CONFLICT' });
  assert.equal(f.posts().length, 1);assert.equal(f.journal.lookup(f.spec).state, 'unknown');
});

test('authority expiry during an awaited read prevents the first POST and leaves the original command for read-only diagnosis', async t => {
  const f = await fixture(t);let expired = false;
  await assert.rejects(f.adapter({ fetcher: async (url, init) => {
    const response = await f.tracked(url, init);
    if (!expired) { expired = true;f.advance(120001); }
    return response;
  } }).execute(f.spec), { code: 'CONTROL_AUTHORITY_EXPIRED_OR_SUPERSEDED' });
  assert.equal(f.posts().length, 0);assert.equal(f.journal.lookup(f.spec).state, 'executing');
  const observed = await f.adapter().inspectOriginal(f.spec);
  assert.equal(observed.observedApplied, false);assert.equal(observed.authorityValid, false);
  assert.equal(f.journal.lookup(f.spec).state, 'executing');
});

test('an expired authority can observe exact after but cannot commit a receipt or refresh the original spec', async t => {
  const f = await fixture(t);
  await assert.rejects(f.adapter({ fetcher: async (url, init) => {
    const response = await f.tracked(url, init);
    if (url === f.outer.controlOrigin + '/binding' && init.method === 'POST') {
      await response.arrayBuffer();throw Object.assign(Error('fixture ACK loss'), { code: 'FIXTURE_ACK_LOST' });
    }
    return response;
  } }).execute(f.spec));
  const before = clone(f.journal.lookup(f.spec));f.advance(120001);
  const observed = await f.adapter().inspectOriginal(f.spec);
  assert.equal(observed.observedApplied, true);assert.equal(observed.authorityValid, false);
  assert.equal(observed.journalWrites, 0);assert.deepEqual(f.journal.lookup(f.spec), before);
  await assert.rejects(f.adapter().execute(f.spec), { code: 'CONTROL_AUTHORITY_EXPIRED_OR_SUPERSEDED' });
  assert.deepEqual(f.journal.lookup(f.spec), before);assert.equal(f.posts().length, 2);
});

test('caller mutation while the first real read awaits cannot change the frozen command, Web or routing target', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), input = clone(f.spec);let held = false;
  const run = f.adapter({ fetcher: async (url, init) => {
    if (!held) { held = true;entered.resolve();await release.promise; }
    return f.tracked(url, init);
  } }).execute(input);
  await entered.promise;
  input.after.web.digest = digest('async mutation');input.after.candidateApi.origin = f.other.origin;
  input.business.api.digest = digest('async business mutation');input.deadline += 999999;
  release.resolve();const receipt = await run;
  assert.equal(receipt.specDigest, digest(f.spec));assert.deepEqual(f.posts()[1].body, f.spec.after);
  assert.deepEqual(f.journal.lookup(f.spec).spec, f.spec);
});

test('revoking the trusted custody proof after one awaited GET prevents all POSTs', async t => {
  const f = await fixture(t);let grant = true;
  await assert.rejects(f.adapter({ assertDelegation: value => {
    const receipt = f.trusted(value);return grant ? receipt : { ...receipt, legacyEntryKeyExclusive: false };
  }, fetcher: async (url, init) => { const response = await f.tracked(url, init);grant = false;return response; } }).execute(f.spec),
  { code: 'LEGACY_ENTRY_DELEGATION_RECEIPT_MISMATCH' });
  assert.equal(f.posts().length, 0);assert.equal(f.journal.lookup(f.spec).state, 'executing');
});

test('two adapter objects cannot dispatch different commands while the original real journal row is executing', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();let held = false;
  const run = f.adapter({ fetcher: async (url, init) => {
    if (!held) { held = true;entered.resolve();await release.promise; }
    return f.tracked(url, init);
  } }).execute(f.spec);
  await entered.promise;
  const other = { ...clone(f.spec), commandId: 'other-command' };f.register(other);
  await assert.rejects(f.adapter().execute(other), { code: 'LEGACY_ENTRY_OTHER_COMMAND_UNSETTLED' });
  assert.equal(f.posts().length, 0);release.resolve();await run;
  assert.equal(f.posts().length, 2);
});

test('deadline expiry during an awaited GET cannot become another POST even while original authority remains valid', async t => {
  const f = await fixture(t);let expired = false;
  await assert.rejects(f.adapter({ fetcher: async (url, init) => {
    const response = await f.tracked(url, init);
    if (!expired) { expired = true;f.advance(10001); }
    return response;
  } }).execute(f.spec), { code: 'CONTROL_COMMAND_DEADLINE_EXPIRED' });
  assert.equal(f.posts().length, 0);assert.equal(f.journal.lookup(f.spec).state, 'unknown');
  assert.equal((await f.adapter().inspectOriginal(f.spec)).observedBinding, 'before');
  assert.equal(f.journal.lookup(f.spec).spec.deadline, f.spec.deadline);
});

test('an expired fresh command creates no row; a planned or definitely-not-applied row is not an unknown-dispatch retry permission', async t => {
  const f = await fixture(t);f.advance(10001);
  await assert.rejects(f.adapter().execute(f.spec), { code: 'CONTROL_COMMAND_DEADLINE_EXPIRED' });
  assert.equal(f.journal.lookup(f.spec), null);assert.equal(f.posts().length, 0);
  const fresh = { ...clone(f.spec), deadline: f.clock() + 10000 };f.register(fresh);
  const a = f.authority.assert({ operationId: fresh.operationId, epoch: fresh.epoch, executorId: fresh.executorId, kind: 'maintenance' });
  const authorization = { operationId: fresh.operationId, epoch: fresh.epoch, executorId: fresh.executorId,
    expiresAt: a.leaseExpiresAt, kind: 'maintenance' };
  // Real journal transitions, explicit isolated adapter-result port, no SQL
  // fabrication and no network dispatch. v1 never emits definitely-not-applied.
  f.journal.prepare({ ...fresh, stepId: 'delegate-api', spec: fresh, authorization });
  await assert.rejects(f.adapter().inspectOriginal(fresh), { code: 'LEGACY_ENTRY_ORIGINAL_DISPATCH_REQUIRED' });
  f.journal.begin({ ...fresh, authorization });
  f.journal.record({ ...fresh, state: 'definitely-not-applied', result: { explicitFixtureResult: true }, authorization });
  await assert.rejects(f.adapter().execute(fresh), { code: 'LEGACY_ENTRY_ORIGINAL_DISPATCH_NOT_REPEATABLE' });
  assert.equal(f.posts().length, 0);
});
