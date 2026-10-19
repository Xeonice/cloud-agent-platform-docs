import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, rm, realpath, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIndependentFoundation } from './control-foundation.mjs';
import { createEntryContextVerifier } from './control-entry-context.mjs';
import { atomicJson } from './io.mjs';

const Database = createRequire(new URL('../../api/package.json', import.meta.url))('better-sqlite3');
const sha = char => 'sha256:' + char.repeat(64);
async function serve(t, handler) {
  const server = http.createServer(handler); await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  let closing; const close = () => closing ??= new Promise(ok => { server.closeAllConnections(); server.close(ok); });
  t.after(close); return { origin: `http://127.0.0.1:${server.address().port}`, close };
}

test('independent Foundation restores its listeners with zero business lifecycle actions and routes control to Agent', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'control-foundation-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const instanceId = 'foundation-test', keys = Object.fromEntries(['owner', 'control', 'controller', 'upgradeControl', 'entry', 'sticky', 'supervisor', 'privateEntry', 'businessProbe', 'accessAuthority'].map((name, i) => [name, String(i).repeat(32)]));
  const verifier = createEntryContextVerifier({ instanceId, key: keys.privateEntry }), calls = [];
  const agent = await serve(t, async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/')) { const context = verifier.verify(req); calls.push({ path: req.url, context }); res.end(JSON.stringify({ agent: true })); return; }
    assert.equal(req.headers['x-platform-internal-key'], keys.upgradeControl); assert.equal(req.headers['x-platform-instance-id'], instanceId);
    if (req.url === '/metadata') { res.end(JSON.stringify({ instanceId, role: 'installer', startIdentity: 'control-birth-0001', artifactDigest: sha('e'), observedAt: new Date().toISOString(), controlSystem: { version: '1.0.0' } })); return; }
    res.writeHead(404); res.end('{}');
  });
  const business = await serve(t, (req, res) => { res.end('business'); });
  const paths = Object.fromEntries(['installer', 'entry', 'futureOwners', 'web'].map(name => [name, join(root, name)]));
  await mkdir(paths.web); await writeFile(join(paths.web, 'index.html'), 'web');
  const ledger = join(root, 'ledger'); await mkdir(ledger);
  const capacityPlanPath = join(root, 'capacity.json'), referenceStatePath = join(root, 'references.json'), resourceObservationPath = join(root, 'resources.json');
  for (const file of [capacityPlanPath, referenceStatePath, resourceObservationPath]) await atomicJson(file, {});
  const stableControl = { origin: agent.origin, key: keys.upgradeControl, accessKey: keys.accessAuthority, statePath: join(root, 'supervisor-private/state.db'),
    capacityPlanPath, referenceStatePath, resourceObservationPath, controlDbPath: join(ledger, 'control.db'), agentStartIdentity: 'control-birth-0001' };
  const c = { root, instanceId, artifactRoot: join(root, 'business-code'), controlArtifactRoot: join(root, 'control-code'), controlLedgerRoot: ledger,
    stableControl, trustRootPath: join(root, 'trust.json'), catalogFile: join(root, 'catalog.json'), publicOrigin: 'http://test.invalid',
    ports: { apiB: 39101, webB: 39102, coordinatorB: 39103, coordinatorAppB: 39104, ownerB: 39105, supervisor: 0, entry: 0, entryControl: 0 } };
  const initialBinding = { instanceId, attemptId: 'historical', fence: 26, routeGeneration: 34, weight: 0,
    oldApi: { origin: business.origin, digest: sha('a') }, candidateApi: null,
    web: { root: paths.web, digest: sha('b'), treeDigest: sha('c') }, retainedWeb: [] };
  let lifecycleActions = 0;
  const foundation = await createIndependentFoundation(c, { paths, keys, initialBinding, origin: () => business.origin,
    bindingPath: join(root, 'bindings/coordinator.json'), ownerBindingPath: join(root, 'bindings/owners.json'), installedReleasePath: join(root, 'bindings/installed.json'), Database,
    adapterFactory: async () => ({ inspect: () => { lifecycleActions++; throw Error('No role inspection expected during listener construction'); }, launch: () => { lifecycleActions++; }, signal: () => { lifecycleActions++; } }) });
  t.after(() => foundation.close());
  assert.equal(lifecycleActions, 0); assert.equal(foundation.controllerConfig, undefined);
  for (const env of [foundation.controlEnv, foundation.coordinatorEnv]) {
    for (const secret of ['ACCESS_PASSCODE', 'PASSCODE_COOKIE_SECRET', 'UPGRADE_SESSION_SECRET', 'UPGRADE_ADMIN_KEY']) assert.equal(env[secret], undefined);
    assert.equal(env.UPGRADE_ACCESS_AUTHORITY_KEY, keys.accessAuthority);
  }
  assert.equal(foundation.controlEnv.UPGRADE_BUSINESS_PROBE_KEY, undefined);
  assert.equal(foundation.coordinatorEnv.UPGRADE_CONTROL_DATABASE_PATH, stableControl.controlDbPath);
  assert.equal(foundation.coordinatorEnv.UPGRADE_BUSINESS_PROBE_KEY, keys.businessProbe);
  assert.equal(foundation.coordinatorEnv.PLATFORM_ENTRY_CONTROL_KEY, keys.controller);
  assert.equal(foundation.coordinatorEnv.PLATFORM_INSTALLER_SUPERVISOR_KEY, keys.controller);
  for (const env of [foundation.controlEnv, foundation.ownerEnv, foundation.coordinatorEnv]) for (const secret of [keys.upgradeControl, keys.entry, keys.supervisor, keys.privateEntry]) assert.equal(Object.values(env).includes(secret), false);
  const observed = await fetch(foundation.entry.controlOrigin + '/binding', { headers: { 'x-platform-internal-key': keys.controller } });
  assert.equal(observed.status, 200); assert.equal((await observed.json()).fence, 26);
  assert.equal((await fetch(foundation.entry.controlOrigin + '/metadata', { headers: { 'x-platform-internal-key': keys.controller } })).status, 403);
  const observerMetadata = await fetch(foundation.supervisor.origin + '/metadata', { headers: { 'x-platform-internal-key': keys.controller, 'x-platform-instance-id': instanceId } });
  assert.equal(observerMetadata.status, 200);
  assert.equal((await fetch(foundation.supervisor.origin + '/coordinator-inventory', { method: 'POST', headers: { 'x-platform-internal-key': keys.controller, 'x-platform-instance-id': instanceId }, body: '{}' })).status, 403);
  const metadata = await fetch(foundation.supervisor.origin + '/metadata', { headers: { 'x-platform-internal-key': keys.supervisor, 'x-platform-instance-id': instanceId } });
  assert.equal(metadata.status, 200); assert.equal((await metadata.json()).startIdentity, stableControl.agentStartIdentity);
  await business.close();
  const response = await fetch(foundation.entry.origin + '/api/system/upgrade/status');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { agent: true });
  assert.equal(calls.length, 1); assert.equal(calls[0].context.clientIp, '127.0.0.1');
  await foundation.close(); await foundation.close(); assert.equal(lifecycleActions, 0);
});

test('Foundation rejects an Agent global key reused by any business or listener credential before constructing roles', async () => {
  const keys = Object.fromEntries(['owner', 'control', 'controller', 'upgradeControl', 'entry', 'sticky', 'supervisor', 'privateEntry', 'businessProbe', 'accessAuthority'].map((name, i) => [name, String(i).repeat(32)]));
  for (const shared of ['owner', 'control', 'controller', 'entry', 'sticky', 'supervisor', 'privateEntry', 'businessProbe', 'accessAuthority']) {
    const actual = { ...keys, upgradeControl: keys[shared] };
    await assert.rejects(() => createIndependentFoundation({ instanceId: 'foundation-test', stableControl: { key: actual.upgradeControl, accessKey: keys.accessAuthority } }, {
      keys: actual, initialBinding: { instanceId: 'foundation-test', weight: 0 }, adapterFactory: () => { throw Error('Unexpected role construction'); },
    }), { code: 'CONTROL_FOUNDATION_ROLE_KEYS_REQUIRED' }, shared);
  }
});
