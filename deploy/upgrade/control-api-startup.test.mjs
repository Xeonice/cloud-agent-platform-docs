import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationCoordinatorBinding } from './control-migration-runtime.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const entry = resolve(repository, 'api/apps/api/dist/roles/control-api-main.js');
const key = 'synthetic-startup-key-never-print-this-value';
const instanceId = 'synthetic-api-startup-instance';
const digest = 'sha256:' + 'a'.repeat(64);

async function bounded(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function port() {
  const server = createServer();
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const value = server.address().port;
  await new Promise(ok => server.close(ok));
  return value;
}
async function fixture(t, { binding: patch = value => value, env: extraEnv = {}, rawBinding, catalog } = {}) {
  await fs.access(entry); // The actual compiled role is required; no substitute or skip.
  const root = await fs.mkdtemp(join(tmpdir(), 'control-api-actual-main-'));
  let catalogCalls = 0, invokeCalls = 0;
  const coordinator = createServer(async (req, res) => {
    if (req.headers['x-platform-internal-key'] !== key || req.headers['x-platform-instance-id'] !== instanceId) {
      res.writeHead(403);res.end();return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/internal/application/catalog') {
      catalogCalls++;
      res.end(JSON.stringify(catalog ?? { protocol: { min: 1, max: 2 }, tools: [], routes: [
        { operation: 'synthetic-health', path: '/api/health', verb: 'GET', status: 200, args: [] },
      ] }));
    } else if (req.url === '/internal/application/invoke') {
      let body = '';for await (const bytes of req) body += bytes;
      if (JSON.parse(body).operation !== 'synthetic-health') {res.writeHead(400);res.end();return;}
      invokeCalls++;
      res.end([{ type: 'headers', status: 200, headers: {} }, { type: 'result', value: { ok: true } }, { type: 'complete' }]
        .map(value => JSON.stringify(value) + '\n').join(''));
    } else if (req.url === '/internal/application/identity') {
      res.end(JSON.stringify({ artifactDigest: digest, coordinatorGeneration: 1, writerFenceValid: true }));
    } else {res.writeHead(404);res.end();}
  });
  await new Promise(ok => coordinator.listen(0, '127.0.0.1', ok));
  const bindingPath = join(root, 'coordinator.json');
  const published = migrationCoordinatorBinding({ instanceId, origin: 'http://127.0.0.1:' + coordinator.address().port, artifactDigest: digest, generation: 1 });
  await fs.writeFile(bindingPath, rawBinding ?? JSON.stringify(patch(published)), { mode: 0o600 });
  const apiPort = await port();
  // Clean environment and synthetic authority only. This is a transport regression,
  // not native release qualification; the separate archive smoke verifies that tree.
  const child = spawn(process.execPath, [entry], { cwd: root, env: {
    NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(apiPort),
    PLATFORM_INSTANCE_ID: instanceId, PLATFORM_CONTROL_RPC_KEY: key,
    PLATFORM_PROCESS_START_IDENTITY: 'synthetic-startup-birth',
    PLATFORM_COORDINATOR_BINDING_PATH: bindingPath, COORDINATOR_RPC_URL: 'http://127.0.0.1:1',
    ...extraEnv,
  }, stdio: 'pipe' });
  let stderr = '';
  child.stderr.on('data', bytes => stderr += bytes);
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await bounded(exited, 2000, 'API child cleanup timed out').catch(() => child.kill('SIGKILL'));
      await exited;
    }
    coordinator.closeAllConnections();
    await new Promise(ok => coordinator.close(ok));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    child, exited, origin: 'http://127.0.0.1:' + apiPort,
    stderr: () => stderr, counts: () => ({ catalogCalls, invokeCalls }),
    failure: async () => {
      const [code, signal] = await bounded(exited, 10000, 'API main did not exit');
      assert.equal(code, 1);assert.equal(signal, null);
      assert.ok(!stderr.includes(key), 'startup logs must not contain authority or input values');
      const match = /^CONTROL_API_BOOT_FAILED (.+)$/m.exec(stderr);
      assert.ok(match, 'actual main must report a structured failure');
      return JSON.parse(match[1]);
    },
  };
}

test('actual API main starts HTTP from the migration producer binding and reports stage timing', async t => {
  const f = await fixture(t);
  const health = await bounded((async () => {
    while (f.child.exitCode === null) {
      try {const response = await fetch(f.origin + '/api/health', { signal: AbortSignal.timeout(200) });
        if (response.ok) return response.json();
      } catch {}
      await new Promise(ok => setTimeout(ok, 20));
    }
    throw new Error('API exited before HTTP readiness: ' + f.stderr());
  })(), 10000, 'API HTTP readiness timed out');
  assert.deepEqual(health, { ok: true });
  const response = await fetch(f.origin + '/internal/control/identity', { headers: {
    'x-platform-internal-key': key, 'x-platform-instance-id': instanceId,
  } });
  const identity = await response.json();
  assert.equal(identity.controlOnly, true);assert.equal(identity.noRuntimeSideEffects, true);
  assert.equal(identity.startIdentity, 'synthetic-startup-birth');
  assert.equal(identity.writerFenceValid, true);assert.equal(identity.applicationOperations, 1);
  assert.deepEqual(f.counts(), { catalogCalls: 1, invokeCalls: 1 });
  const stages = [...f.stderr().matchAll(/^CONTROL_API_BOOT_STAGE (.+)$/gm)].map(match => JSON.parse(match[1]));
  assert.deepEqual(stages.map(value => value.stage), ['installed-artifact', 'role-config', 'coordinator-binding', 'application-catalog', 'public-network', 'http-transport', 'listener', 'ready']);
  assert.ok(stages.every(value => Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0 && value.previousStageMs >= 0));
  assert.ok(!f.stderr().includes(key));
});

test('actual API main rejects the old producer binding before catalog and identifies the missing state safely', async t => {
  const f = await fixture(t, { binding: value => { delete value.state;return value; } });
  const failure = await f.failure();
  assert.equal(failure.stage, 'coordinator-binding');
  assert.equal(failure.reason, 'STARTUP_INPUT_INVALID');assert.deepEqual(failure.fields, ['state']);
  assert.deepEqual(f.counts(), { catalogCalls: 0, invokeCalls: 0 });
});

test('actual API main never logs malformed binding content or URL credentials', async t => {
  const f = await fixture(t, { rawBinding: key });
  const failure = await f.failure();
  assert.equal(failure.stage, 'coordinator-binding');assert.equal(failure.reason, 'STARTUP_ERROR');
  assert.deepEqual(f.counts(), { catalogCalls: 0, invokeCalls: 0 });
});

test('actual API main distinguishes installed-tree failure before consulting coordinator binding', async t => {
  const f = await fixture(t, { env: { PLATFORM_ARTIFACT_DIGEST: digest } });
  const failure = await f.failure();
  assert.equal(failure.stage, 'installed-artifact');assert.equal(failure.reason, 'INSTALLED_API_ARTIFACT_REQUIRED');
  assert.deepEqual(f.counts(), { catalogCalls: 0, invokeCalls: 0 });
});

test('actual API main rejects a credential-bearing coordinator URL without logging it', async t => {
  const f = await fixture(t, { env: { COORDINATOR_RPC_URL: 'http://user:' + key + '@127.0.0.1:1' } });
  const failure = await f.failure();
  assert.equal(failure.stage, 'role-config');assert.equal(failure.reason, 'CONTROL_COORDINATOR_ORIGIN_REQUIRED');
  assert.deepEqual(f.counts(), { catalogCalls: 0, invokeCalls: 0 });
});

test('actual API main identifies invalid catalog shape without logging its data', async t => {
  const f = await fixture(t, { catalog: { protocol: { min: 1, max: 2 }, routes: key, tools: [] } });
  const failure = await f.failure();
  assert.equal(failure.stage, 'application-catalog');assert.equal(failure.reason, 'STARTUP_INPUT_INVALID');
  assert.deepEqual(failure.fields, ['routes']);
  assert.deepEqual(f.counts(), { catalogCalls: 1, invokeCalls: 0 });
});
