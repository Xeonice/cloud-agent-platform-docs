import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readControlConfig, validateControlConfig } from './control-main.mjs';

function config() {
  return { instanceId: 'instance', startIdentity: 'control-start', controlArtifactRoot: '/fixed/code', controlManifestPath: '/fixed/metadata/control.json',
    trustRootPath: '/fixed/metadata/trust.json', catalogFile: '/fixed/metadata/catalog.json', controlRoot: '/fixed/private', controlLedgerRoot: '/fixed/ledger',
    downloadRoot: '/fixed/downloads', coordinatorBindingPath: '/fixed/bindings/coordinator.json', capacityPlanPath: '/fixed/capacity/plan.json', capacityStateRoot: '/fixed/capacity',
    controllerKey: 'c'.repeat(32), businessKey: 'b'.repeat(32), supervisorKey: 's'.repeat(32), entryKey: 'e'.repeat(32), privateEntryKey: 'p'.repeat(32), accessAuthorityKey: 'a'.repeat(32),
    coordinatorOrigin: 'http://127.0.0.1:3001', supervisorOrigin: 'http://127.0.0.1:3002', entryOrigin: 'http://127.0.0.1:3003', controlPort: 3004,
    allowedOrigins: ['http://100.73.71.22:3000'] };
}
test('Agent config admits only isolated absolute roots, independent keys, fixed loopback peers and public origins', () => {
  assert.equal(validateControlConfig(config()).root, '/fixed/private');
  for (const patch of [{ businessDatabasePath: '/data/platform.db' }, { docker: {} }, { ownerHome: '/owner' }, { authEnv: {} },
    { controlLedgerRoot: '/fixed/private/ledger' }, { capacityPlanPath: '/outside/plan.json' }, { coordinatorOrigin: 'http://example.com:3001' },
    { accessAuthorityKey: 'c'.repeat(32) }, { businessKey: 'c'.repeat(32) }, { controlManifestPath: '/fixed/code/control.json' }, { allowedOrigins: ['http://localhost/path'] }]) {
    assert.throws(() => validateControlConfig({ ...config(), ...patch }));
  }
});
test('private config rejects world-readable bytes and symlinks before runtime assembly', async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'control-main-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const path = join(root, 'config.json'); await fs.writeFile(path, JSON.stringify(config()), { mode: 0o600 });
  assert.equal((await readControlConfig(path)).instanceId, 'instance');
  await fs.chmod(path, 0o644); await assert.rejects(readControlConfig(path), { code: 'CONTROL_CONFIG_INSECURE' });
  await fs.chmod(path, 0o600); const link = join(root, 'link.json'); await fs.symlink(path, link);
  await assert.rejects(readControlConfig(link), { code: 'CONTROL_CONFIG_INSECURE' });
});
