import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStableEntry } from './stable-entry.mjs';
import { createStableEntry as createHistoricalEntry } from '../testing/legacy-entry-208342/stable-entry.mjs';
import { createEntryContextVerifier } from './control-entry-context.mjs';
import { createControlAccessAuthority } from './control-access-authority.mjs';
import { createControlSecurity } from './control-security.mjs';
import { createControlHttpServer } from './control-http.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const Database = require('better-sqlite3');
const schemas = { ...require('./packages/contracts/dist/upgrade.contract.js'), ...require('./packages/contracts/dist/schemas/system.schema.js') };
const instanceId = 'nested-legacy-entry-http';
const key = 'c'.repeat(32), entryKey = 'e'.repeat(32), probeKey = 'p'.repeat(32);
const sha = letter => 'sha256:' + letter.repeat(64);
const requestId = '11111111-1111-4111-8111-111111111111';

async function fixture(t, options = { nestedLegacyOuter: true }) {
  const close = [];
  t.after(async () => { for (const release of close.reverse()) await release(); });
  const home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'entry-nested-http-')));
  close.push(() => fs.rm(home, { recursive: true, force: true }));
  const webRoot = join(home, 'web');
  await fs.mkdir(webRoot);
  await fs.writeFile(join(webRoot, 'index.html'), 'isolated nested HTTP transport fixture');
  const sqlite = new Database(join(home, 'access.sqlite'));
  close.push(() => sqlite.close());
  // Deliberately misconfigured true: an unknown signed source must still require
  // authentication, regardless of the Agent's real loopback TCP peer.
  const access = createControlAccessAuthority({
    sqlite, instanceId, allowLoopback: true, envPasscode: 'isolated-nested-passcode',
    sessionSecretOverride: '', retainEnvironment: true,
  });
  await access.importState({
    source: 'none', sessionSecret: 'isolated-nested-cookie-secret',
    upgradeSessionSecretBase64: Buffer.alloc(32, 17).toString('base64'),
  });
  assert.equal(access.status().enabled, true);
  const security = createControlSecurity({ instanceId, access });
  const seen = [], mutations = new Map();
  // Explicit application port, not upgrade/Guest qualification. Actual access,
  // signed context verification, Origin and CSRF checks surround this port.
  const service = {
    security,
    status(req, res) {
      const principal = security.principal(req, res, instanceId);
      return {
        instanceId, userScope: principal.userScope, activationGeneration: 3,
        confirmedServiceRelease: null, lastConfirmedServiceRelease: null, serviceState: 'unknown',
        catalog: { state: 'unavailable', observedAt: null, reason: 'EXTERNAL_HTTP_FIXTURE', availableRelease: null },
        capabilities: { canUpgradeInstance: principal.canUpgrade, canAuthenticate: false },
        csrfToken: principal.csrfToken, attempt: null, recovery: null, availableWeb: null,
        observedAt: new Date().toISOString(),
      };
    },
    request(req, res, body) {
      security.mutation(req, security.principal(req, res, instanceId));
      mutations.set(body.requestId, body);
      return { requestId: body.requestId, state: 'unknown' };
    },
  };
  const verifier = createEntryContextVerifier({ instanceId, key: entryKey });
  const forbidden = () => { throw new Error('Private control mutation is outside this HTTP authentication fixture'); };
  const agent = await createControlHttpServer({
    instanceId, key, access, service, store: { instanceId }, schemas,
    authority: { assert: forbidden }, claim: forbidden, renew: forbidden,
    verifyEntryRequest(req) {
      const context = verifier.verify(req);
      seen.push({ headers: req.headers, context });
      return context;
    },
  });
  close.push(() => agent.close());
  const businessSeen = [];
  const business = http.createServer((req, res) => {
    businessSeen.push({ path: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ externalHttpFixture: true }));
  });
  business.on('upgrade', (req, socket) => {
    businessSeen.push({ path: req.url, headers: req.headers });
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise(ok => business.listen(0, '127.0.0.1', ok));
  close.push(() => new Promise(ok => { business.closeAllConnections(); business.close(ok); }));
  const businessOrigin = `http://127.0.0.1:${business.address().port}`;
  const binding = {
    instanceId, attemptId: 'explicit-transport-fixture', fence: 1, routeGeneration: 1, weight: 0,
    oldApi: { origin: businessOrigin, digest: sha('a') }, candidateApi: null,
    web: { origin: businessOrigin, root: webRoot, digest: sha('b'), treeDigest: sha('c') }, retainedWeb: [],
  };
  const createOptions = {
    root: join(home, 'entry'), instanceId, controlKey: key, stickyKey: 's'.repeat(32),
    controlOrigin: agent.origin, privateEntryKey: entryKey, businessProbeKey: probeKey,
    verifyFence: forbidden, verifyControlAuthority: forbidden, initialBinding: binding, ...options,
  };
  const entry = await createStableEntry(createOptions);
  close.push(() => entry.close());
  const outer = await createHistoricalEntry({
    root: join(home, 'historical-outer'), instanceId, controlKey: 'o'.repeat(32), stickyKey: 's'.repeat(32),
    verifyFence: forbidden,
    initialBinding: { ...binding, oldApi: { origin: entry.origin, digest: sha('d') }, web: { ...binding.web, origin: entry.origin } },
  });
  close.push(() => outer.close());
  return { home, entry, outer, access, seen, mutations, businessSeen, createOptions, cookie: access.challenge({ legacyBaseline: false }).cookie };
}

const spoofed = {
  forwarded: 'for=127.0.0.1;proto=https', 'forwarded-host': 'localhost',
  'x-forwarded': '127.0.0.1', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https',
  'x-real-ip': '127.0.0.1', 'x-platform': 'local-operator',
  'x-platform-internal-key': probeKey, 'x-platform-instance-id': instanceId,
  'x-platform-entry-context': 'forged-loopback-context', 'x-platform-entry-signature': '0'.repeat(64),
  'x-platform-control-epoch': '99', 'x-platform-recovery-epoch': '99',
  'x-platform-recovery-id': '00000000-0000-4000-8000-000000000001',
};
function assertUnknown(headers) {
  assert.equal(headers['x-forwarded-for'], 'unknown');
  for (const name of ['forwarded', 'forwarded-host', 'x-forwarded', 'x-real-ip', 'x-platform',
    'x-platform-internal-key', 'x-platform-instance-id', 'x-platform-control-epoch',
    'x-platform-recovery-id', 'x-platform-recovery-epoch']) assert.equal(headers[name], undefined, name);
}

test('nested historical outer cannot turn its loopback peer or spoofed headers into local access, even with allowLoopback enabled', async t => {
  const f = await fixture(t);
  for (const headers of [{}, spoofed]) {
    const response = await fetch(f.outer.origin + '/api/system/upgrade/status', { headers });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'PASSCODE_REQUIRED');
  }
  assert.equal(f.seen.length, 2);
  for (const request of f.seen) {
    assert.equal(request.context.remoteAddress, null);
    assert.equal(request.context.clientIp, 'unknown');
    assertUnknown(request.headers);
    assert.notEqual(request.headers['x-platform-entry-context'], spoofed['x-platform-entry-context']);
  }
  const authenticated = await fetch(f.outer.origin + '/api/system/upgrade/status', { headers: { ...spoofed, cookie: f.cookie, origin: f.outer.origin } });
  assert.equal(authenticated.status, 200);
  assert.equal((await authenticated.json()).capabilities.canUpgradeInstance, true);
  assert.equal(f.seen.at(-1).headers.cookie, f.cookie);
  assert.equal(f.seen.at(-1).headers.origin, f.outer.origin);
});

test('nested Entry preserves actual Cookie, Origin and CSRF enforcement for an authenticated control request', async t => {
  const f = await fixture(t);
  const status = await (await fetch(f.outer.origin + '/api/system/upgrade/status', { headers: { cookie: f.cookie } })).json();
  const body = { requestId, targetReleaseId: '1.2.3', targetDigest: sha('e'), expectedActivationGeneration: 3 };
  const post = headers => fetch(f.outer.origin + '/api/system/upgrade/requests', {
    method: 'POST', headers: { cookie: f.cookie, origin: f.outer.origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ 'x-upgrade-csrf': status.csrfToken, origin: 'http://untrusted.invalid' })).status, 403);
  assert.equal(f.mutations.size, 0);
  assert.equal((await post({ 'x-upgrade-csrf': status.csrfToken })).status, 202);
  assert.equal(f.mutations.size, 1);
});

test('nested business HTTP, Web and upgrade paths remove outer identity and never restore private probe headers', async t => {
  const f = await fixture(t);
  for (const path of ['/api/projects', '/api/system/upgrade/probe', '/web-fixture']) {
    assert.equal((await fetch(f.outer.origin + path, { headers: spoofed })).status, 200);
    const actual = f.businessSeen.at(-1);
    assert.equal(actual.path, path);
    assertUnknown(actual.headers);
    assert.equal(actual.headers['x-platform-entry-context'], undefined);
    assert.equal(actual.headers['x-platform-entry-signature'], undefined);
    assert.equal(actual.headers['x-platform-route-generation'], '1');
  }
  const upgradeStatus = await new Promise((ok, fail) => {
    const request = http.request(f.outer.origin + '/ws', {
      headers: { ...spoofed, connection: 'Upgrade', upgrade: 'websocket' },
    }, response => { response.resume(); ok(response.statusCode); });
    request.on('error', fail);
    request.end();
  });
  assert.equal(upgradeStatus, 400);
  assert.equal(f.businessSeen.at(-1).path, '/ws');
  assertUnknown(f.businessSeen.at(-1).headers);
});

test('default direct mode keeps its actual local source and separately authenticated private business probe', async t => {
  const f = await fixture(t, {});
  const status = await fetch(f.entry.origin + '/api/system/upgrade/status');
  assert.equal(status.status, 200);
  assert.equal(f.seen.at(-1).context.remoteAddress, '127.0.0.1');
  assert.equal(f.seen.at(-1).context.clientIp, '127.0.0.1');
  await fetch(f.entry.origin + '/api/system/upgrade/probe', { headers: spoofed });
  const actual = f.businessSeen.at(-1).headers;
  assert.equal(actual['x-forwarded-for'], '127.0.0.1');
  assert.equal(actual['x-platform-internal-key'], probeKey);
  assert.equal(actual['x-platform-recovery-epoch'], '99');
});

test('nested legacy outer is an explicit boolean restricted to independent Entry configuration', async t => {
  const f = await fixture(t);
  for (const nestedLegacyOuter of ['true', 1, null])
    await assert.rejects(() => createStableEntry({ ...f.createOptions, root: join(f.home, 'invalid-type'), nestedLegacyOuter }), { code: 'ENTRY_NESTED_LEGACY_OUTER_CONFIGURATION_INVALID' });
  await assert.rejects(() => createStableEntry({
    ...f.createOptions, root: join(f.home, 'not-independent'), controlOrigin: null,
    privateEntryKey: null, verifyControlAuthority: undefined, nestedLegacyOuter: true,
  }), { code: 'ENTRY_NESTED_LEGACY_OUTER_CONFIGURATION_INVALID' });
});
