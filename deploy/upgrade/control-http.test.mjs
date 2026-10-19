import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlAccessAuthority } from './control-access-authority.mjs';
import { createControlSecurity } from './control-security.mjs';
import { createControlHttpServer } from './control-http.mjs';
import { createStableEntry } from './stable-entry.mjs';
import { createEntryContextVerifier, signEntryContext } from './control-entry-context.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const Database = require('better-sqlite3');
const schemas = { ...require('./packages/contracts/dist/upgrade.contract.js'), ...require('./packages/contracts/dist/schemas/system.schema.js') };
const instanceId = 'independent-http-fixture', key = 'k'.repeat(32), entryKey = 'e'.repeat(32);
const sha = letter => 'sha256:' + letter.repeat(64);
const requestId = '11111111-1111-4111-8111-111111111111';

async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'control-http-test-'))), webRoot = join(directory, 'web');
  await fs.mkdir(webRoot); await fs.writeFile(join(webRoot, 'index.html'), 'transport fixture');
  const sqlite = new Database(join(directory, 'control.db'));
  const access = createControlAccessAuthority({ sqlite, instanceId, envPasscode: 'fixture-private-passcode', sessionSecretOverride: '' });
  await access.importState({ source: 'none', sessionSecret: 'original-cookie-signing-secret', upgradeSessionSecretBase64: Buffer.alloc(32, 11).toString('base64') });
  const security = createControlSecurity({ instanceId, access }), requests = new Map(), spans = [], controlCalls = [];
  const service = {
    security,
    status: (req, res) => {
      const principal = security.principal(req, res, instanceId);
      return { instanceId, userScope: principal.userScope, activationGeneration: 3,
        confirmedServiceRelease: null, lastConfirmedServiceRelease: null, serviceState: 'unknown',
        catalog: { state: 'unavailable', observedAt: null, reason: 'BUSINESS_DOWN', availableRelease: null },
        capabilities: { canUpgradeInstance: principal.canUpgrade, canAuthenticate: false }, csrfToken: principal.csrfToken,
        attempt: null, recovery: null, availableWeb: null, observedAt: '2026-10-20T00:00:00.000Z' };
    },
    request: (req, res, body) => {
      security.mutation(req, security.principal(req, res, instanceId));
      if (!requests.has(body.requestId)) requests.set(body.requestId, { requestId: body.requestId, state: 'unknown' });
      return requests.get(body.requestId);
    },
    lookup: (req, res, id) => { security.principal(req, res, instanceId); return requests.get(id) ?? { requestId: id, state: 'not-found' }; },
  };
  const verifier = createEntryContextVerifier({ instanceId, key: entryKey });
  const agent = await createControlHttpServer({ instanceId, key, businessKey: 'b'.repeat(32), access, service, store: { instanceId }, authority: { assert: input => { assert.equal(input.operationId, requestId); assert.equal(input.epoch, 4); return input; } }, schemas,
    verifyEntryRequest: req => verifier.verify(req), claim: () => { controlCalls.push('claim'); }, renew: () => { controlCalls.push('renew'); },
    criticalAuthority: (_id, body) => { controlCalls.push('critical-authority'); return body; },
    normalRetirements:{submit:body=>{controlCalls.push('retirement-submit');return {operationId:requestId,body};},read:id=>({operationId:id}),reconcile:async id=>{controlCalls.push('retirement-lookup');return {operationId:id};}},
    controlStatus: () => ({ version: 'control-protocol-fixture', protocolVersion: 1, state: 'ready', observedAt: new Date().toISOString() }),
    onSpan: value => spans.push(value) });
  const business = http.createServer((_req, res) => { res.writeHead(200); res.end('business'); });
  await new Promise(ok => business.listen(0, '127.0.0.1', ok));
  const businessOrigin = `http://127.0.0.1:${business.address().port}`;
  const entry = await createStableEntry({ root: join(directory, 'entry'), instanceId, controlKey: key, stickyKey: 's'.repeat(32), controlOrigin: agent.origin, privateEntryKey: entryKey,
    verifyControlAuthority: async () => ({ leaseExpiresAt: Date.now() + 60000 }), verifyFence: async () => {},
    initialBinding: { instanceId, attemptId: 'original-attempt', fence: 3, routeGeneration: 3, weight: 0,
      oldApi: { origin: businessOrigin, digest: sha('a') }, candidateApi: null,
      web: { digest: sha('b'), treeDigest: sha('c'), root: webRoot }, retainedWeb: [] } });
  await new Promise(ok => business.close(ok));
  t.after(async () => { await entry.close(); await agent.close(); sqlite.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const challenge = access.challenge({ legacyBaseline: false });
  return { entry, agent, access, requests, spans, controlCalls, cookie: challenge.cookie,
    directHeaders(method, path, extra = {}) { return { host: 'public.example.test', origin: 'http://public.example.test', ...signEntryContext({ instanceId, key: entryKey, remoteAddress: '198.51.100.8', method, path }), ...extra }; } };
}

test('retirement maintenance stays on the existing private Agent capability and never grants business/browser keys maintenance authority',async t=>{
  const f=await fixture(t),headers=secret=>({'x-platform-internal-key':secret,'x-platform-instance-id':instanceId,'content-type':'application/json'});
  const root='/internal/control/retirements',body={acceptedUpgradeId:requestId,target:{}};
  for(const secret of ['b'.repeat(32),entryKey,'']) {
    assert.equal((await fetch(f.agent.origin+root,{method:'POST',headers:headers(secret),body:JSON.stringify(body)})).status,403);
    assert.equal((await fetch(f.agent.origin+root+'/'+requestId,{headers:headers(secret)})).status,403);
    assert.equal((await fetch(f.agent.origin+root+'/'+requestId+'/reconcile',{method:'POST',headers:headers(secret),body:'{}'})).status,403);
  }
  assert.deepEqual(f.controlCalls,[]);
  assert.equal((await fetch(f.agent.origin+root,{method:'POST',headers:headers(key),body:JSON.stringify(body)})).status,202);
  assert.equal((await fetch(f.agent.origin+root+'/'+requestId,{headers:headers(key)})).status,200);
  assert.equal((await fetch(f.agent.origin+root+'/'+requestId+'/reconcile',{method:'POST',headers:headers(key),body:'{}'})).status,200);
  assert.deepEqual(f.controlCalls,['retirement-submit','retirement-lookup']);
});

test('real Entry to independent HTTP keeps original session, CSRF, status and same-request lookup available with business listener closed', async t => {
  const f = await fixture(t), origin = f.entry.origin;
  assert.equal((await fetch(origin + '/api/projects')).status, 502);
  const response = await fetch(origin + '/api/system/upgrade/status', { headers: { cookie: f.cookie } });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(schemas.UpgradeStatusSchema.safeParse(status).success, true);
  assert.equal(status.controlSystem.version, 'control-protocol-fixture'); assert.equal(status.serviceState, 'unknown');
  const body = { requestId, targetReleaseId: '1.2.3', targetDigest: sha('d'), expectedActivationGeneration: 3 };
  const post = headers => fetch(origin + '/api/system/upgrade/requests', { method: 'POST', headers: { cookie: f.cookie, origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({})).status, 403);
  assert.equal(f.requests.size, 0);
  assert.equal((await post({ 'x-upgrade-csrf': status.csrfToken, origin: 'http://untrusted.example.test' })).status, 403);
  assert.equal(f.requests.size, 0);
  const accepted = await post({ 'x-upgrade-csrf': status.csrfToken }); assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).state, 'unknown');
  for (let i = 0; i < 3; i++) {
    const lookup = await fetch(origin + '/api/system/upgrade/requests/' + requestId, { headers: { cookie: f.cookie } });
    assert.equal(lookup.status, 200); assert.deepEqual(await lookup.json(), { requestId, state: 'unknown' });
  }
  assert.equal(f.requests.size, 1, 'read-only unknown lookup cannot create another request');
  assert.equal((await fetch(origin + '/api/system/upgrade/probe')).status, 502, 'physical business probe must not be answered by the control service');
  assert.ok(f.spans.every(value => value.role === 'control' && Number.isFinite(value.elapsedMs) && !Object.hasOwn(value, 'headers')));
});

test('business management key reaches only the frozen critical callback and cannot claim, renew, commit or read global control state', async t => {
  const f = await fixture(t), headers = { 'x-platform-internal-key': 'b'.repeat(32), 'x-platform-instance-id': instanceId, 'content-type': 'application/json' };
  const critical = await fetch(f.agent.origin + '/internal/upgrades/' + requestId + '/critical-authority', { method: 'POST', headers, body: JSON.stringify({ fence: 4, generation: 1, phase: 'quiesce' }) });
  assert.equal(critical.status, 200); assert.deepEqual(f.controlCalls, ['critical-authority']);
  for (const action of ['claim', 'lease-renew', 'commit-receipt', 'authority-check']) {
    const response = await fetch(f.agent.origin + '/internal/upgrades/' + requestId + '/' + action, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 403, action + ' cannot use the business key');
  }
  for (const path of ['/internal/control/authority', '/internal/upgrades/pending', '/metadata']) assert.equal((await fetch(f.agent.origin + path, { headers })).status, 403);
  assert.deepEqual(f.controlCalls, ['critical-authority']);
});

test('signed external source remains external; forged context and missing original session cannot gain loopback operator access', async t => {
  const f = await fixture(t), path = '/api/system/upgrade/status';
  const unauthenticated = await fetch(f.agent.origin + path, { headers: f.directHeaders('GET', path) });
  assert.equal(unauthenticated.status, 401); assert.equal((await unauthenticated.json()).code, 'PASSCODE_REQUIRED');
  const authenticated = await fetch(f.agent.origin + path, { headers: f.directHeaders('GET', path, { cookie: f.cookie }) });
  assert.equal(authenticated.status, 200);
  const forged = await fetch(f.agent.origin + path, { headers: { ...f.directHeaders('GET', path, { cookie: f.cookie }), 'x-platform-entry-signature': '0'.repeat(64) } });
  assert.equal(forged.status, 403);
  const internal = await fetch(f.agent.origin + '/internal/upgrades/pending', { headers: { 'x-platform-internal-key': 'wrong', 'x-platform-instance-id': instanceId } });
  assert.equal(internal.status, 403);
  assert.equal((await fetch(f.entry.origin + '/api/system/upgrade/probe/other', { headers: { cookie: f.cookie } })).status, 404);
});
