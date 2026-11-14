import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson } from './io.mjs';
import { createCoordinatorClient } from './coordinator-client.mjs';

async function receiver(t, capable) {
  const calls = [];
  const attempt = { instanceId: 'fast-test', attemptId: 'attempt-1', generation: 2 };
  const server = http.createServer(async (req, res) => {
    let bytes = ''; for await (const c of req) bytes += c;
    const body = bytes ? JSON.parse(bytes) : null;
    calls.push({ path: req.url, body, kind: req.headers['x-platform-control-request-kind'] });
    res.setHeader('content-type', 'application/json');
    const caps = capable ? { controlFastPath: 1, progressEvidenceReference: 1 } : {};
    const snapshot = { controllerCapabilities: caps, attempt, fence: 7, generation: 2 };
    if (req.url === '/internal/upgrades/pending') res.end(JSON.stringify(snapshot));
    else if (req.url.endsWith('/claim')) res.end(JSON.stringify({ generation: 2, fence: 7, snapshot }));
    else if (!capable && req.url.endsWith('/renew')) res.end(JSON.stringify({ fence: 7, generation: 2, snapshot }));
    else if (!capable && req.url.endsWith('/commit')) res.end(JSON.stringify(snapshot));
    else if (capable && ['/authority-check', '/lease-renew', '/commit-receipt'].some(p => req.url.endsWith(p))) res.end(JSON.stringify({ ...attempt, fence: 7, generation: 2, sequence: 4 }));
    else if (capable && req.url.includes('/progress-checkpoint?')) res.end(JSON.stringify({ ...attempt, step: { evidenceDigest: 'sha256:' + 'a'.repeat(64) } }));
    else { res.writeHead(404); res.end(JSON.stringify({ code: 'UNKNOWN_METHOD' })); }
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  t.after(async () => { server.closeAllConnections(); await new Promise(ok => server.close(ok)); });
  return { origin: `http://127.0.0.1:${server.address().port}`, calls };
}

test('actual source capabilities select small authority/renew/checkpoint/commit contracts', async t => {
  const f = await receiver(t, true);
  const client = createCoordinatorClient({ origin: f.origin, instanceId: 'fast-test', key: 'k'.repeat(32) });
  await client.pending(); await client.claim('attempt-1', { controllerId: 'controller-1', leaseMs: 15000 });
  await client.assertFence('attempt-1', 7);
  await client.renew('attempt-1', { fence: 7, controllerId: 'controller-1' });
  await client.progressCheckpoint('attempt-1', { fence: 7, generation: 2 });
  await client.commit('attempt-1', { fence: 7, generation: 2, expectedSequence: 3, eventId: 'event-1', kind: 'progress', payload: {} });
  assert.deepEqual(f.calls.map(c => c.path.split('?')[0]), ['/internal/upgrades/pending', '/internal/upgrades/attempt-1/claim', '/internal/upgrades/attempt-1/authority-check', '/internal/upgrades/attempt-1/lease-renew', '/internal/upgrades/attempt-1/progress-checkpoint', '/internal/upgrades/attempt-1/commit-receipt']);
  assert.equal(f.calls[2].kind, 'fence-check'); assert.equal(f.calls[3].kind, 'lease-renew');
  assert.deepEqual(f.calls[3].body, { fence: 7, controllerId: 'controller-1', generation: 2 });
});

test('handoff to an older actual source drops cached capabilities and preserves its old request body', async t => {
  const modern = await receiver(t, true), legacy = await receiver(t, false);
  const root = await mkdtemp(join(tmpdir(), 'fast-binding-')); t.after(() => rm(root, { recursive: true, force: true }));
  const bindingPath = join(root, 'coordinator.json');
  await atomicJson(bindingPath, { instanceId: 'fast-test', generation: 1, state: 'ready', origin: modern.origin });
  const client = createCoordinatorClient({ origin: modern.origin, instanceId: 'fast-test', key: 'k'.repeat(32), bindingPath });
  await client.pending(); await client.assertFence('attempt-1', 7);
  await atomicJson(bindingPath, { instanceId: 'fast-test', generation: 2, state: 'ready', origin: legacy.origin });
  await client.assertFence('attempt-1', 7);
  await client.renew('attempt-1', { fence: 7, controllerId: 'controller-1' });
  assert.deepEqual(legacy.calls.map(c => c.path), ['/internal/upgrades/attempt-1/renew', '/internal/upgrades/attempt-1/renew']);
  assert.deepEqual(legacy.calls[0].body, { fence: 7, controllerId: null, checkOnly: true });
  assert.deepEqual(legacy.calls[1].body, { fence: 7, controllerId: 'controller-1' });
  assert.equal(await client.progressCheckpoint('attempt-1', { fence: 7, generation: 2 }), null);
});
