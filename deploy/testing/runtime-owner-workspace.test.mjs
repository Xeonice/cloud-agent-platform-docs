import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ownerWorkspaceEnvironment, roleMounts, bootstrapDataRoot } from '../upgrade/production-role-adapter.mjs';
import { createCandidateSupervisor } from '../upgrade/candidate-supervisor.mjs';

const key = 'RUNTIME_OWNER_WORKSPACE_ROOT';
const c = {
  root: '/instance', businessHostPath: '/host/business', kind: 'idle-first-bootstrap',
};
const spec = {
  kind: 'owner', artifactRoot: '/packages/verified', cwd: '/packages/verified/api',
  ownerHome: '/instance/future-owners/artifact/start', env: { PLATFORM_COORDINATOR_RPC_KEY: 'fixture' },
};

test('initial and candidate production Owner descriptors expose exactly their actual workspace bind destination', () => {
  for (const ownerHome of ['/instance/original-owner', spec.ownerHome]) {
    const mounts = roleMounts(c, { ...spec, ownerHome });
    const env = ownerWorkspaceEnvironment(spec.env, mounts, {
      source: join(c.businessHostPath, 'workspaces'),
      destination: join(bootstrapDataRoot(c), 'workspaces'),
    });
    assert.equal(env[key], '/data/workspaces');
    assert.deepEqual(mounts.find(m => m.destination === env[key]), {
      source: '/host/business/workspaces', destination: '/data/workspaces', rw: true,
    });
    assert.equal(mounts.some(m => m.source === c.businessHostPath), false);
    assert.equal(Object.hasOwn(env, 'DATA_ROOT'), false);
    assert.equal(Object.hasOwn(env, 'DATABASE_URL'), false);
    assert.equal(Object.hasOwn(spec.env, key), false);
  }
});

test('experimental production aliases select the actual trusted alias, rather than assuming /data', () => {
  const config = { ...c, kind: 'idle-first-bootstrap-experiment' };
  const mounts = roleMounts(config, spec);
  const env = ownerWorkspaceEnvironment({}, mounts, {
    source: join(c.businessHostPath, 'workspaces'),
    destination: join(bootstrapDataRoot(config), 'workspaces'),
  });
  assert.equal(env[key], '/instance/business/workspaces');
  assert.ok(mounts.some(m => m.source === '/host/business/workspaces' && m.destination === env[key] && m.rw));
});

test('Native same-path workspace descriptors retain their real absolute destination and do not mutate caller environment', () => {
  const workspace = '/qa/instances/example/business/workspaces';
  const mounts = [
    { source: '/qa/instances/example/original-owner', destination: '/qa/instances/example/original-owner', rw: true },
    { source: workspace, destination: workspace, rw: true },
    { source: '/packages/verified', destination: '/packages/verified', rw: false },
  ];
  const supplied = Object.freeze({ PLATFORM_COORDINATOR_RPC_KEY: 'fixture' });
  const env = ownerWorkspaceEnvironment(supplied, mounts, { source: workspace, destination: workspace });
  assert.equal(env[key], workspace);
  assert.equal(Object.hasOwn(supplied, key), false);
  assert.equal(mounts.some(m => m.destination === '/data/workspaces'), false);
});

test('wrong, missing, read-only, duplicate or noncanonical workspace binds remain rejected', () => {
  const source = '/host/business/workspaces', destination = '/data/workspaces';
  const bind = { source, destination, rw: true };
  for (const mounts of [[], [{ ...bind, rw: false }], [{ ...bind, source: '/host/other/workspaces' }], [bind, bind]]) {
    assert.throws(() => ownerWorkspaceEnvironment({}, mounts, { source, destination }), { code: 'OWNER_WORKSPACE_BIND_REQUIRED' });
  }
  // A later fixed runtime bind (for example SSL_CERT_DIR) may replace the Map
  // entry. Capacity must be derived from the final descriptor, never an earlier RW value.
  const finalMounts = new Map([[destination, bind]]);
  finalMounts.set(destination, { source, destination, rw: false });
  assert.throws(() => ownerWorkspaceEnvironment({}, [...finalMounts.values()], { source, destination }), { code: 'OWNER_WORKSPACE_BIND_REQUIRED' });
  for (const path of ['/data', '/data/platform.db', '/data/../data/workspaces', '/data/workspaces,readonly', 'workspaces']) {
    assert.throws(() => ownerWorkspaceEnvironment({}, [{ source, destination: path, rw: true }], { source, destination: path }), { code: 'OWNER_WORKSPACE_BIND_REQUIRED' });
  }
});

test('a supplied reserved value cannot point capacity at the database, Owner SDK, or an unbound directory', () => {
  const source = '/host/business/workspaces', destination = '/data/workspaces';
  const mounts = [{ source, destination, rw: true }];
  for (const path of ['/data', '/data/platform.db', spec.ownerHome, spec.ownerHome + '/boxlite', '/unmounted/workspaces', undefined]) {
    assert.throws(() => ownerWorkspaceEnvironment({ [key]: path }, mounts, { source, destination }), { code: 'OWNER_WORKSPACE_ENV_MISMATCH' });
  }
  assert.equal(ownerWorkspaceEnvironment({ [key]: destination }, mounts, { source, destination })[key], destination);
});

test('the reserved launch value is not added to Supervisor configuration or its legacy Owner allowlist', async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'owner-workspace-scope-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const secret = 'fixture-controller-key-at-least-32-characters';
  await assert.rejects(createCandidateSupervisor({
    root: join(root, 'installer'), instanceId: 'fixture', key: secret,
    coordinator: { origin: 'http://127.0.0.1:1' },
    controlEnv: { PLATFORM_CONTROL_RPC_KEY: secret }, ownerEnv: { [key]: '/data/workspaces' },
  }), { code: 'FORBIDDEN_OWNER_INSTALLATION_ENV' });
});
