import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadLegacyUpgradeRuntime } from '../../e2e-contract/server/legacy-upgrade-runtime.mjs';
import { treeManifest, atomicJson } from '../upgrade/io.mjs';
import { digest } from '../upgrade/trust.mjs';

const commit = '208342ea994555c12c3ba42ce3b6aabd0afe9df1';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const files = ['stable-entry.mjs', 'candidate-supervisor.mjs', 'coordinator-client.mjs', 'docker-role-adapter.mjs',
  'io.mjs', 'trust.mjs', 'installer-identity.mjs', 'artifacts.mjs', 'contract-retirement.mjs', 'controller-main.mjs'];

/** Exact git-object historical installer bytes, cross-checked against existing
 * immutable provenance fixtures (the adapter's original blob is separately
 * pinned below). No current factory is copied into the test artifact. This is
 * a loader/HTTP/environment contract, not a full built business package or
 * evidence of actual Docker mounts, old process custody, Guest or Native QA.
 */
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'legacy-runtime-'))), initialRoot = join(root, 'artifact');
  await fs.mkdir(join(initialRoot, 'installer'), { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const provenance = new Map();
  for (const directory of ['legacy-entry-208342', 'legacy-supervisor-208342']) {
    const p = JSON.parse(await fs.readFile(resolve('deploy/testing', directory, 'provenance.json'), 'utf8'));
    assert.equal(p.sourceCommit, commit);
    for (const row of p.files) provenance.set(row.path, row);
  }
  for (const name of files) {
    // Deliberately no working-tree fallback if historical git custody is absent.
    const bytes = execFileSync('git', ['show', commit + ':deploy/upgrade/' + name], { cwd: resolve('.'), maxBuffer: 2 * 1024 * 1024 });
    if (name === 'docker-role-adapter.mjs') {
      assert.equal(bytes.length, 11095); assert.equal(sha256(bytes), '58f2d55176e93317201a6f00c29859b4c6bb6f7d2f02dfa49ea85899e23237a8');
    } else {
      const p = provenance.get(name); assert.ok(p); assert.equal(bytes.length, p.bytes); assert.equal(sha256(bytes), p.sha256);
    }
    await fs.writeFile(join(initialRoot, 'installer', name), bytes, { mode: 0o644 });
  }
  let input;
  async function seal() {
    const payload = (await treeManifest(initialRoot)).filter(f => !['upgrade-artifact.json', 'installed.json'].includes(f.path));
    const code = payload.filter(f => f.path.startsWith('installer/') && f.path.endsWith('.mjs') && !f.path.endsWith('.test.mjs'));
    const identity = digest(code), component = { artifactDigest: identity, inputFingerprint: identity, sourceRevision: commit, protocol: { min: 1, max: 2 } };
    const components = { installer: component };
    const bundle = { schemaVersion: 1, releaseId: '0.3.15-historical-byte-contract', components, files: payload, treeDigest: digest(payload) };
    await atomicJson(join(initialRoot, 'upgrade-artifact.json'), bundle);
    input = { initialRoot, initialRelease: { components }, initialTreeDigest: bundle.treeDigest, legacyProvided: true };
    return input;
  }
  await seal(); return { root, initialRoot, seal, get input() { return input; } };
}
async function serve(t, handler) {
  const server = http.createServer(handler); await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise(ok => { server.closeAllConnections(); server.close(ok); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('explicit legacy loading runs actual old Entry, client and Supervisor and preserves their old environment limits', async t => {
  const f = await fixture(t), runtime = await loadLegacyUpgradeRuntime(f.input), instanceId = 'legacy-loader-local';
  assert.deepEqual(Object.keys(runtime).sort(), ['createCandidateSupervisor', 'createCoordinatorClient', 'createDockerRoleAdapter', 'createStableEntry']);
  for (const [name, file] of Object.entries({ createStableEntry: 'stable-entry.mjs', createCandidateSupervisor: 'candidate-supervisor.mjs',
    createCoordinatorClient: 'coordinator-client.mjs', createDockerRoleAdapter: 'docker-role-adapter.mjs' }))
    assert.equal(runtime[name], (await import(pathToFileURL(join(f.initialRoot, 'installer', file)).href))[name]);
  const rpcCalls = [], key = 'historical-private-controller-key-32';
  const coordinatorOrigin = await serve(t, async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    rpcCalls.push({ path: req.url, key: req.headers['x-platform-internal-key'], instance: req.headers['x-platform-instance-id'], body: body ? JSON.parse(body) : null });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: { fence: 7, qualified: true } }));
  });
  const coordinator = runtime.createCoordinatorClient({ origin: coordinatorOrigin, instanceId, key });
  await coordinator.assertFence('original', 7);
  assert.deepEqual(rpcCalls[0], { path: '/internal/upgrades/original/renew', key, instance: instanceId, body: { fence: 7, controllerId: null, checkOnly: true } });
  const businessOrigin = await serve(t, (_req, res) => res.end('historical-business-route'));
  const entry = await runtime.createStableEntry({ root: join(f.root, 'entry-state'), instanceId, controlKey: key, stickyKey: 'historical-entry-sticky-key-at-least-32',
    verifyFence: ({ attemptId, fence }) => coordinator.assertFence(attemptId, fence),
    initialBinding: { instanceId, attemptId: 'initial', fence: 1, routeGeneration: 1, weight: 0,
      oldApi: { origin: businessOrigin, digest: digest('original-api') }, candidateApi: null,
      web: { origin: businessOrigin, root: f.initialRoot, digest: digest('original-web'), treeDigest: f.input.initialTreeDigest }, retainedWeb: [] } });
  t.after(() => entry.close());
  assert.equal(await (await fetch(entry.origin + '/api/probe')).text(), 'historical-business-route');
  const metadata = await (await fetch(entry.controlOrigin + '/metadata', { headers: { 'x-platform-internal-key': key } })).json();
  assert.equal(metadata.programRoot, join(f.initialRoot, 'installer')); assert.equal(metadata.artifactDigest, f.input.initialRelease.components.installer.artifactDigest);
  const options = { root: join(f.root, 'supervisor-state'), instanceId, key, coordinator, controlEnv: { PLATFORM_CONTROL_RPC_KEY: key } };
  await assert.rejects(runtime.createCandidateSupervisor({ ...options, coordinatorEnv: { UPGRADE_CONTROL_DATABASE_PATH: '/new-only/control.db' } }),
    { code: 'FORBIDDEN_COORDINATOR_INSTALLATION_ENV' });
  const supervisor = await runtime.createCandidateSupervisor(options); t.after(() => supervisor.close());
  const retained = await (await fetch(supervisor.origin + '/retained-readers', { headers: { 'x-platform-internal-key': key } })).json();
  assert.deepEqual(retained, { instanceId, readers: [] });
  // The actual adapter factory is the historical one, including its original
  // RO installer/artifacts mount expression. No host platform is spoofed and
  // no Docker/Native operation is invoked by this local byte contract.
  assert.ok(runtime.createDockerRoleAdapter.toString().includes("mount(join(c.installerRoot,'artifacts'))"));
  if (process.platform !== 'linux' || process.arch !== 'arm64')
    await assert.rejects(runtime.createDockerRoleAdapter({}), { code: 'CONTAINER_ADAPTER_LINUX_ARM64_REQUIRED' });
  assert.equal(await loadLegacyUpgradeRuntime(f.input), runtime);
});

test('missing historical factory or file fails explicitly without using a current checkout replacement', async t => {
  const absent = await fixture(t); await fs.unlink(join(absent.initialRoot, 'installer', 'docker-role-adapter.mjs')); await absent.seal();
  await assert.rejects(loadLegacyUpgradeRuntime(absent.input), { code: 'LEGACY_RUNTIME_FILE_REQUIRED' });
  const missingExport = await fixture(t), file = join(missingExport.initialRoot, 'installer', 'docker-role-adapter.mjs');
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('export async function createDockerRoleAdapter(', 'export async function unavailableHistoricalAdapter('));
  await missingExport.seal(); await assert.rejects(loadLegacyUpgradeRuntime(missingExport.input), { code: 'LEGACY_RUNTIME_FACTORY_REQUIRED' });
});

test('changed tree, source identity and external import closure are rejected before module loading', async t => {
  const changed = await fixture(t); await fs.appendFile(join(changed.initialRoot, 'installer', 'io.mjs'), '\n// changed fixture copy\n');
  await assert.rejects(loadLegacyUpgradeRuntime(changed.input), { code: 'LEGACY_RUNTIME_ARTIFACT_CHANGED' });
  const identity = await fixture(t);
  await assert.rejects(loadLegacyUpgradeRuntime({ ...identity.input, initialRelease: { components: { installer: { artifactDigest: digest('wrong-source') } } } }),
    { code: 'LEGACY_RUNTIME_ARTIFACT_CHANGED' });
  const escape = await fixture(t);
  await fs.writeFile(join(escape.initialRoot, 'outside.mjs'), 'export const externalFactory = true;\n');
  await fs.appendFile(join(escape.initialRoot, 'installer', 'docker-role-adapter.mjs'), "\nexport { externalFactory } from '../outside.mjs';\n");
  await escape.seal(); await assert.rejects(loadLegacyUpgradeRuntime(escape.input), { code: 'LEGACY_RUNTIME_IMPORT_OUTSIDE_INSTALLER' });
});

test('an immutable module path cannot be rebound to new bytes after Node cached the old dependency graph', async t => {
  const f = await fixture(t); await loadLegacyUpgradeRuntime(f.input);
  await fs.appendFile(join(f.initialRoot, 'installer', 'io.mjs'), '\n// deliberately rebound fixture copy\n'); await f.seal();
  await assert.rejects(loadLegacyUpgradeRuntime(f.input), { code: 'LEGACY_RUNTIME_MODULE_CACHE_CONFLICT' });
});

test('caller fixture mode is unchanged unless legacyProvided is explicitly true', async () => {
  assert.equal(await loadLegacyUpgradeRuntime(), null);
  assert.equal(await loadLegacyUpgradeRuntime({ initialRoot: '/does-not-exist', legacyProvided: false }), null);
  await assert.rejects(loadLegacyUpgradeRuntime({ legacyProvided: 'true' }), { code: 'LEGACY_RUNTIME_SELECTION_INVALID' });
});
