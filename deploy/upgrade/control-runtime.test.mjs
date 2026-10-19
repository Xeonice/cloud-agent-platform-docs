import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleControlRuntime } from './control-runtime.mjs';

const Database = createRequire(new URL('../../api/package.json', import.meta.url))('better-sqlite3');
const sha = char => 'sha256:' + char.repeat(64);
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'control-runtime-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const before = process.env.PLATFORM_PROCESS_ROLE; process.env.PLATFORM_PROCESS_ROLE = 'upgrade-control';
  t.after(() => { if (before === undefined) delete process.env.PLATFORM_PROCESS_ROLE; else process.env.PLATFORM_PROCESS_ROLE = before; });
  const opened = []; function TrackedDatabase(path) { const db = new Database(path); opened.push(db); return db; }
  const args = { config: { instanceId: 'runtime-test', controlRoot: join(root, 'private'), controlLedgerRoot: join(root, 'ledger'),
    controllerKey: 'c'.repeat(32), businessKey: 'b'.repeat(32), accessAuthorityKey: 'a'.repeat(32), privateEntryKey: 'p'.repeat(32),
    coordinatorOrigin: 'http://127.0.0.1:1', allowedOrigins: ['http://test.invalid'], controlPort: 0 },
    verifiedPackage: { artifactRoot: root, apiRoot: fileURLToPath(new URL('../../api/', import.meta.url)), version: '1.0.0', protocolVersion: 1,
      packageDigest: sha('b'), executionEngineDigest: sha('c') },
    engineIdentity: { instanceId: 'runtime-test', artifactDigest: sha('c'), startIdentity: 'control-test', role: 'installer', pid: process.pid },
    Database: TrackedDatabase, participantsFactory: () => ({ admit: async () => {} }),
    executionFactory: async () => ({ runOnce: async () => {}, sample: async () => [], close: async () => {} }) };
  return { root, opened, args };
}

test('the actual pure API factory opens only separate control and access databases and remains passive', async t => {
  const f = await fixture(t); let starts = 0, closes = 0;
  f.args.executionFactory = async () => ({ runOnce: async () => { starts++; }, sample: async () => [], close: async () => { closes++; } });
  const runtime = await assembleControlRuntime(f.args); t.after(() => runtime.close());
  assert.equal(f.opened.length, 2); assert.equal(runtime.authority.observe().mode, 'passive');
  assert.equal(f.opened[0].prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('projects','sandboxes','credentials')").get().n, 0);
  assert.deepEqual(f.opened[1].prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(), [{ name: 'control_access' }, { name: 'control_access_environment' }]);
  assert.equal(f.opened[0].prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='control_access'").get().n, 0);
  await runtime.tick(); assert.equal(starts, 0);
  const response = await fetch(runtime.origin + '/metadata', { headers: { 'x-platform-internal-key': f.args.config.controllerKey, 'x-platform-instance-id': 'runtime-test' } });
  assert.equal(response.status, 200); assert.equal((await response.json()).controlSystem.version, '1.0.0');
  await runtime.close(); await runtime.close(); assert.equal(closes, 1); assert.ok(f.opened.every(db => !db.open));
});

test('assembly failure after binding a real HTTP listener closes listeners and both database handles', async t => {
  const f = await fixture(t); let origin;
  f.args.executionFactory = async args => { origin = args.controlOrigin; throw Object.assign(Error('assembly fixture failed'), { code: 'TEST_ASSEMBLY_FAILURE' }); };
  await assert.rejects(assembleControlRuntime(f.args), { code: 'TEST_ASSEMBLY_FAILURE' });
  assert.ok(f.opened.every(db => !db.open));
  await assert.rejects(fetch(origin + '/metadata', { signal: AbortSignal.timeout(1000) }));
});
