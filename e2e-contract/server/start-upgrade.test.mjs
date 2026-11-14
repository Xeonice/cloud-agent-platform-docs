import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import * as startup from './start-upgrade.mjs';

for (const generation of [undefined, null, 0, 2, 8, '1']) {
  test(`fresh harness rejects initial generation ${JSON.stringify(generation)} before filesystem or legacy loading`, async (t) => {
    const parent = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'upg-fresh-generation-')));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const root = join(parent, 'instance');
    let initialRootReads = 0;
    await assert.rejects(startup.startUpgradeHarness({
      isolated: true,
      instanceId: 'upgrade-acceptance-fresh-generation',
      root,
      initialRelease: { activationGeneration: generation },
      legacyProvided: true,
      get initialRoot() {
        initialRootReads++;
        return join(parent, 'absent-legacy-artifact');
      },
    }), { code: 'FRESH_INITIAL_ACTIVATION_REQUIRED' });
    assert.equal(initialRootReads, 0, 'no path inspection or legacy loader has begun');
    assert.equal(await fs.lstat(root).catch(() => null), null);
    assert.equal(await fs.lstat(join(root, 'startup-intent.json')).catch(() => null), null);
    assert.deepEqual(await fs.readdir(parent), []);
  });
}

test('generation one reaches the real legacy loader without creating a startup home', async (t) => {
  const parent = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'upg-fresh-generation-one-')));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'instance');
  await assert.rejects(startup.startUpgradeHarness({
    isolated: true,
    instanceId: 'upgrade-acceptance-fresh-generation',
    root,
    initialRoot: join(parent, 'absent-legacy-artifact'),
    initialRelease: { activationGeneration: 1, components: {} },
    legacyProvided: true,
  }), { code: 'LEGACY_RUNTIME_FILE_REQUIRED' });
  assert.equal(await fs.lstat(root).catch(() => null), null);
  assert.deepEqual(await fs.readdir(parent), []);
});

async function bootstrapServer(t, handle) {
  const server = createServer(handle);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return 'http://127.0.0.1:' + server.address().port;
}

function safeFailure(error, status, bootstrapCode) {
  assert.equal(error.code, 'INITIAL_PHYSICAL_BOOTSTRAP_FAILED');
  assert.equal(error.httpStatus, status);
  assert.equal(error.bootstrapCode, bootstrapCode);
  assert.equal(error.message, 'INITIAL_PHYSICAL_BOOTSTRAP_FAILED (HTTP ' + status +
    (bootstrapCode ? '; ' + bootstrapCode : '') + ')');
  assert.deepEqual(Object.keys(error).sort(),
    ['code', 'httpStatus', ...(bootstrapCode ? ['bootstrapCode'] : [])].sort());
  assert.equal(String(error.stack).includes('SYNTHETIC_PRIVATE_VALUE'), false);
  assert.equal(JSON.stringify(error).includes('SYNTHETIC_PRIVATE_VALUE'), false);
  return true;
}

test('real bootstrap HTTP failure preserves only status and a known machine code', async (t) => {
  const origin = await bootstrapServer(t, (_req, res) => {
    res.writeHead(409, { 'content-type': 'application/json', 'x-private-test': 'SYNTHETIC_PRIVATE_VALUE' });
    res.end(JSON.stringify({ code: 'INVALID_INITIAL_GENERATION', message: 'SYNTHETIC_PRIVATE_VALUE',
      url: 'https://SYNTHETIC_PRIVATE_VALUE.invalid/', headers: { authorization: 'SYNTHETIC_PRIVATE_VALUE' } }));
  });
  const response = await fetch(origin + '/internal/upgrades/bootstrap', { method: 'POST' });
  await assert.rejects(startup.assertInitialBootstrapResponse(response), error =>
    safeFailure(error, 409, 'INVALID_INITIAL_GENERATION'));
});

for (const shape of ['unlisted-code', 'nested-code', 'html', 'oversized']) {
  test(`real bootstrap HTTP ${shape} body cannot escape the bounded diagnostic`, async (t) => {
    const origin = await bootstrapServer(t, (_req, res) => {
      res.writeHead(503, { 'content-type': shape === 'html' ? 'text/html' : 'application/json' });
      res.end(shape === 'html' ? '<html>SYNTHETIC_PRIVATE_VALUE</html>' : JSON.stringify({
        ...(shape === 'nested-code' ? { error: { code: 'INVALID_INITIAL_GENERATION' } } : {
          code: shape === 'unlisted-code' ? 'SYNTHETIC_PRIVATE_VALUE' : 'INVALID_INITIAL_GENERATION',
        }),
        message: 'SYNTHETIC_PRIVATE_VALUE',
        ...(shape === 'oversized' ? { padding: 'x'.repeat(5000) } : {}),
      }));
    });
    await assert.rejects(startup.assertInitialBootstrapResponse(await fetch(origin)), error =>
      safeFailure(error, 503, undefined));
  });
}

for (const bytes of [4096, 4097]) {
  test(`real HTTP error diagnostic enforces the ${bytes}-byte boundary`, async (t) => {
    const base = { code: 'INVALID_INITIAL_GENERATION', padding: '' };
    const body = JSON.stringify({ ...base, padding: 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(base))) });
    assert.equal(Buffer.byteLength(body), bytes);
    const origin = await bootstrapServer(t, (_req, res) => {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(body);
    });
    await assert.rejects(startup.assertInitialBootstrapResponse(await fetch(origin)), error =>
      safeFailure(error, 409, bytes === 4096 ? 'INVALID_INITIAL_GENERATION' : undefined));
  });
}

test('a locked real HTTP response cannot replace the original HTTP failure with a reader error', async (t) => {
  const origin = await bootstrapServer(t, (_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'UPGRADE_INTERNAL_AUTH' }));
  });
  const response = await fetch(origin), reader = response.body.getReader();
  try {
    await assert.rejects(startup.assertInitialBootstrapResponse(response), error =>
      safeFailure(error, 403, undefined));
  } finally { await reader.cancel(); reader.releaseLock(); }
});

test('an unfinished real HTTP error body times out and cancels without hiding its status', async (t) => {
  let requestClosed;
  const closed = new Promise(resolve => { requestClosed = resolve; });
  const origin = await bootstrapServer(t, (_req, res) => {
    res.once('close', requestClosed);
    res.writeHead(409, { 'content-type': 'application/json' });
    res.write('{"code":"INVALID_INITIAL_GENERATION","message":"SYNTHETIC_PRIVATE_VALUE');
  });
  const start = Date.now();
  await assert.rejects(startup.assertInitialBootstrapResponse(await fetch(origin)), error =>
    safeFailure(error, 409, undefined));
  assert.ok(Date.now() - start < 3000, 'diagnostic reading has its own bounded deadline');
  let timer;
  try {
    await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() =>
      reject(Error('bootstrap response body was not cancelled')), 2000); })]);
  } finally { clearTimeout(timer); }
});

test('successful real bootstrap response remains readable by the frozen migration driver', async (t) => {
  const activation = { activationGeneration: 1, releaseId: 'v1.0.0' };
  const origin = await bootstrapServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(activation));
  });
  const response = await fetch(origin);
  assert.equal(await startup.assertInitialBootstrapResponse(response), response);
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(await response.json(), activation);
});
