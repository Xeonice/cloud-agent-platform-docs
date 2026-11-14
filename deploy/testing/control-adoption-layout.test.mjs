import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { roleMounts } from '../upgrade/production-role-adapter.mjs';
import { legacyControlAttachmentLedgerRoot, assertLegacyControlAttachmentLedgerDirectory,
  observeLegacyControlAttachmentMount } from '../upgrade/control-adoption-layout.mjs';

const operationId = 'd4549000-1a36-4af5-8137-93a792562536';
const coordinator = { containerId: 'a'.repeat(64), startIdentity: 'original-coordinator', artifactDigest: 'sha256:' + 'b'.repeat(64) };
function config() {
  const root = '/instance';
  return { root, legacyControlAttachmentOperationId: operationId, controlLedgerRoot: legacyControlAttachmentLedgerRoot(root, operationId),
    controlAgentArtifactRoot: '/control/code', controlPrivateRoot: '/control/private', controlDownloadRoot: join(root, 'installer/downloads'),
    businessHostPath: '/business', runtimeRoots: ['/owners/original'], capacityStateRoot: '/control/capacity', trustRootPath: '/public/trust.json' };
}
const mounts = c => roleMounts(c, { kind: 'control-agent', artifactRoot: c.controlAgentArtifactRoot, env: {} });

test('legacy compatibility grants the Agent only the fixed ledger leaf, never its installer parent', () => {
  const c = config(), result = mounts(c), ledger = result.find(m => m.destination === c.controlLedgerRoot);
  assert.deepEqual(ledger, { source: c.controlLedgerRoot, destination: c.controlLedgerRoot, rw: true });
  for (const target of ['/instance/installer', '/instance/installer/artifacts', '/instance/installer/artifacts/.control-adoption'])
    assert.equal(result.some(m => m.destination === target), false);
  assert.equal(result.find(m => m.destination === '/instance/bindings').rw, false);
  assert.equal(c.controlLedgerRoot.includes('/' + 'b'.repeat(64) + '/'), false);
});

test('marker, namespace, operation and all other Agent roots keep their original mount restrictions', () => {
  for (const patch of [{ legacyControlAttachmentOperationId: undefined }, { legacyControlAttachmentOperationId: '../escape' },
    { controlLedgerRoot: '/instance/installer/artifacts' }, { controlLedgerRoot: '/instance/installer/artifacts/' + 'a'.repeat(64) + '/ledger' },
    { controlLedgerRoot: '/instance/installer/artifacts/.control-adoption/' + operationId + '/ledger/../ledger' },
    { controlPrivateRoot: '/instance/installer/private' }, { controlAgentArtifactRoot: '/instance/installer/code' },
    { businessHostPath: '/instance/installer/artifacts/.control-adoption' }]) {
    assert.throws(() => mounts({ ...config(), ...patch }), /CONTROL_/);
  }
  const normal = { ...config(), legacyControlAttachmentOperationId: undefined, controlLedgerRoot: '/control/ledger' };
  assert.ok(mounts(normal).find(m => m.destination === normal.controlLedgerRoot));
});

test('the compatibility leaf must actually be private and canonical, including every symlink ancestor', async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'adoption-layout-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const controlLedgerRoot = legacyControlAttachmentLedgerRoot(root, operationId);
  await fs.mkdir(controlLedgerRoot, { recursive: true, mode: 0o700 });
  const input = { root, operationId, controlLedgerRoot };
  assert.equal((await assertLegacyControlAttachmentLedgerDirectory(input)).path, controlLedgerRoot);
  await fs.chmod(controlLedgerRoot, 0o755);
  await assert.rejects(assertLegacyControlAttachmentLedgerDirectory(input), /DIRECTORY_INSECURE/);
  await fs.chmod(controlLedgerRoot, 0o700);
  const moved = controlLedgerRoot + '-actual';
  await fs.rename(controlLedgerRoot, moved);await fs.symlink(moved, controlLedgerRoot);
  await assert.rejects(assertLegacyControlAttachmentLedgerDirectory(input), /DIRECTORY_INSECURE/);
});

test('actual Inspector projection rejects deeper writable overmounts and changed original births', async () => {
  const c = config(), parent = '/instance/installer/artifacts';let calls = 0;
  const row = { id: coordinator.containerId, running: true, paused: false, restartCount: 0, artifactDigest: coordinator.artifactDigest,
    labels: { 'agent-platform.instance': 'fixture', 'agent-platform.role': 'coordinator',
      'agent-platform.start': coordinator.startIdentity, 'agent-platform.artifact': coordinator.artifactDigest },
    mounts: [{ Type: 'bind', Source: parent, Destination: parent, RW: false }] };
  const run = async (program, argv) => {
    calls++;assert.equal(program, '/docker');assert.equal(argv[0], '--host');
    assert.equal(argv.at(-1), coordinator.containerId);assert.ok(argv.includes('--format'));
    return JSON.stringify(row);
  };
  const input = { root: c.root, operationId, instanceId: 'fixture', coordinator, docker: { cli: '/docker', args: ['--host', 'unix:///qa.sock'] } };
  const result = await observeLegacyControlAttachmentMount(input, { run, clock: () => 1000 });
  assert.equal(result.mount.readonly, true);assert.equal(result.authorizesAdoption, false);
  assert.equal(Object.hasOwn(result, 'labels'), false);
  row.mounts.push({ Type: 'bind', Source: c.controlLedgerRoot, Destination: c.controlLedgerRoot, RW: true });
  await assert.rejects(observeLegacyControlAttachmentMount(input, { run }), /READONLY_MOUNT_REQUIRED/);
  row.mounts.pop();
  for (const name of ['control.db', 'control.db-wal', 'control.db-shm']) {
    row.mounts.push({ Type: 'bind', Source: '/writable/' + name, Destination: join(c.controlLedgerRoot, name), RW: true });
    await assert.rejects(observeLegacyControlAttachmentMount(input, { run }), /READONLY_MOUNT_REQUIRED/);
    row.mounts.pop();
  }
  row.labels['agent-platform.start'] = 'different-birth';
  await assert.rejects(observeLegacyControlAttachmentMount(input, { run }), /IDENTITY_CHANGED/);
  assert.equal(calls, 6);
});
