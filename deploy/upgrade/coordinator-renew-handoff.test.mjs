import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson } from './io.mjs';
import { createCoordinatorClient } from './coordinator-client.mjs';

const scope = { instanceId: 'renew-handoff', attemptId: 'same-attempt', generation: 2 };
const command = { controllerId: 'same-controller', fence: 7 };
const rejected = { code: 'APPLICATION_WRITER_QUIESCED', sideEffectFree: true, retryable: true };
async function receiver(t, handle, options = {}) {
  const calls = [], accepted = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const call = { path: req.url, raw, body: raw ? JSON.parse(raw) : null, kind: req.headers['x-platform-control-request-kind'] };
    calls.push(call); res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/pending')) return res.end(JSON.stringify({ attempt: scope, controllerCapabilities: options.fast ? { controlFastPath: 1 } : {} }));
    await handle({ req, res, call, calls, accepted });
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  t.after(async () => { server.closeAllConnections(); await new Promise(ok => server.close(ok)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, calls, accepted };
}
async function client(t, f, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'renew-handoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bindingPath = join(root, 'coordinator.json');
  const binding = { instanceId: scope.instanceId, generation: 2, state: 'ready', origin: f.origin };
  await atomicJson(bindingPath, binding);
  const value = createCoordinatorClient({ origin: f.origin, instanceId: scope.instanceId, key: 'k'.repeat(32), bindingPath, ...options });
  await value.pending(); return { value, binding, bindingPath };
}

test('completed side-effect-free 425 waits for the same original HTTP renew without changing its command', async t => {
  const input = { ...command };
  const f = await receiver(t, async ({ res, call, calls, accepted }) => {
    if (calls.length === 2) { input.fence = 99; input.controllerId = 'changed'; res.writeHead(425); return res.end(JSON.stringify(rejected)); }
    accepted.push(call); res.end(JSON.stringify({ ...scope, fence: 7 }));
  });
  const c = await client(t, f);
  await c.value.renew(scope.attemptId, input);
  assert.equal(f.accepted.length, 1);
  assert.deepEqual(f.calls.slice(1).map(c => c.body), [command, command]);
  assert.ok(f.calls.slice(1).every(c => c.path === '/internal/upgrades/same-attempt/renew' && c.kind === 'lease-renew'));
});

test('fast-path renew fixes its attempt generation and body across the same HTTP gate', async t => {
  const f = await receiver(t, async ({ res, call, calls, accepted }) => {
    if (calls.length === 2) { res.writeHead(425); return res.end(JSON.stringify(rejected)); }
    accepted.push(call); res.end(JSON.stringify({ ...scope, fence: 7 }));
  }, { fast: true });
  const c = await client(t, f); await c.value.renew(scope.attemptId, command);
  assert.deepEqual(f.calls.slice(1).map(c => c.body), [{ ...command, generation: 2 }, { ...command, generation: 2 }]);
  assert.ok(f.calls.slice(1).every(c => c.path.endsWith('/lease-renew')));
});

test('only exact top-level 425 code and both actual boolean flags permit another request', async t => {
  for (const [name, status, payload] of [
    ['5xx', 503, rejected], ['other code', 425, { ...rejected, code: 'UPGRADE_FENCE_EXPIRED' }],
    ['false', 425, { ...rejected, sideEffectFree: false }], ['missing', 425, { code: rejected.code }],
    ['string flag', 425, { ...rejected, retryable: 'true' }],
    ['nested error', 425, { error: rejected, sideEffectFree: true, retryable: true }],
  ]) await t.test(name, async st => {
    const f = await receiver(st, async ({ res }) => { res.writeHead(status); res.end(JSON.stringify(payload)); });
    const c = await client(st, f); await assert.rejects(c.value.renew(scope.attemptId, command));
    assert.equal(f.calls.length, 2);
  });
});

test('business mutations still reject the same side-effect-free gate without replay', async t => {
  const f = await receiver(t, async ({ res }) => { res.writeHead(425); res.end(JSON.stringify(rejected)); });
  const c = await client(t, f);
  await assert.rejects(c.value.commit(scope.attemptId, { ...command, kind: 'progress' }), e => e.code === rejected.code && e.status === 425 && e.sideEffectFree === true && e.retryable === true);
  assert.equal(f.calls.length, 2);
});

test('a lost actual HTTP response never replays renewal', async t => {
  const f = await receiver(t, async ({ req }) => req.socket.destroy());
  const c = await client(t, f); await assert.rejects(c.value.renew(scope.attemptId, command));
  assert.equal(f.calls.length, 2);
});

test('a fence rejection after a known harmless gate is terminal', async t => {
  const f = await receiver(t, async ({ res, calls }) => {
    res.writeHead(calls.length === 2 ? 425 : 409);
    res.end(JSON.stringify(calls.length === 2 ? rejected : { code: 'UPGRADE_FENCE_EXPIRED' }));
  });
  const c = await client(t, f);
  await assert.rejects(c.value.renew(scope.attemptId, command), { code: 'UPGRADE_FENCE_EXPIRED' });
  assert.equal(f.calls.length, 3);
});

test('the original total deadline includes all 425 responses and does not refresh', async t => {
  const f = await receiver(t, async ({ res }) => { await delay(35); res.writeHead(425); res.end(JSON.stringify(rejected)); });
  let deadline = Infinity;
  const c = await client(t, f, { requestContext: () => ({ deadline }), timeoutMs: 5000 });
  deadline = Date.now() + 125;
  const start = performance.now();
  await assert.rejects(c.value.renew(scope.attemptId, command));
  assert.ok(performance.now() - start < 250, 'a retry must not obtain a new deadline');
  assert.ok(f.calls.length >= 3, 'exercise actual known-425 continuation before original expiry');
});


test('a quiescing route advances once to the new ready HTTP receiver with the original lease tuple', async t => {
  let current;
  const target = await receiver(t, async ({ res, call, accepted }) => { accepted.push(call); res.end(JSON.stringify({ ...scope, fence: 7 })); });
  const source = await receiver(t, async ({ res }) => {
    await atomicJson(current.bindingPath, { ...current.binding, state: 'quiescing', attemptId: scope.attemptId, fence: 7 });
    res.writeHead(425); res.end(JSON.stringify(rejected));
    await delay(25);
    await atomicJson(current.bindingPath, { ...current.binding, generation: 3, state: 'ready', origin: target.origin });
  });
  current = await client(t, source);
  await current.value.renew(scope.attemptId, command);
  assert.equal(source.calls.length, 2); assert.equal(target.accepted.length, 1);
  assert.deepEqual(target.accepted[0].body, command);
  assert.equal(target.accepted[0].kind, 'lease-renew');
});

test('a changed binding fence or regressed route generation cannot dispatch another renewal', async t => {
  for (const [name, changed, code] of [
    ['fence', { fence: 8, attemptId: scope.attemptId }, 'COORDINATOR_RENEW_SCOPE_CHANGED'],
    ['attempt', { fence: 7, attemptId: 'different-attempt' }, 'COORDINATOR_RENEW_SCOPE_CHANGED'],
    ['generation', { generation: 1 }, 'COORDINATOR_BINDING_UNKNOWN'],
  ]) await t.test(name, async st => {
    let current;
    const f = await receiver(st, async ({ res }) => { await atomicJson(current.bindingPath, { ...current.binding, ...changed }); res.writeHead(425); res.end(JSON.stringify(rejected)); });
    current = await client(st, f);
    await assert.rejects(current.value.renew(scope.attemptId, command), { code });
    assert.equal(f.calls.length, 2);
  });
});

test('the known no-effect retry window never extends the original two-second route budget', async t => {
  const f = await receiver(t, async ({ res }) => { await delay(120); res.writeHead(425); res.end(JSON.stringify(rejected)); });
  const c = await client(t, f, { timeoutMs: 5000 });
  const started = performance.now();
  await assert.rejects(c.value.renew(scope.attemptId, command), e => e.code === 'COORDINATOR_HANDOFF_WAIT_EXCEEDED' || e.name === 'TimeoutError');
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 1850 && elapsed < 2400, 'all harmless responses share one two-second window');
  assert.ok(f.calls.length > 3);
});


test('a timed-out real HTTP renewal remains unknown and is not sent again', async t => {
  const f = await receiver(t, async ({ res }) => { await delay(250); res.end(JSON.stringify({ ...scope, fence: 7 })); });
  const c = await client(t, f, { timeoutMs: 75 });
  await assert.rejects(c.value.renew(scope.attemptId, command), e => e.name === 'TimeoutError');
  assert.equal(f.calls.length, 2);
});

test('a generation change in a continuation acknowledgement is not accepted or retried', async t => {
  const f = await receiver(t, async ({ res, calls }) => {
    if (calls.length === 2) { res.writeHead(425); return res.end(JSON.stringify(rejected)); }
    res.end(JSON.stringify({ ...scope, generation: 3, fence: 7 }));
  });
  const c = await client(t, f);
  await assert.rejects(c.value.renew(scope.attemptId, command), { code: 'COORDINATOR_RENEW_SCOPE_CHANGED' });
  assert.equal(f.calls.length, 3);
});


test('an actual in-flight snapshot changing the generation while routing waits prevents first renewal dispatch', async t => {
  let snapshotResponse, seen;
  const snapshotSeen = new Promise(ok => { seen = ok; });
  const f = await receiver(t, async ({ res }) => { snapshotResponse = res; seen(); });
  const c = await client(t, f);
  const snapshot = c.value.snapshot(scope.attemptId); await snapshotSeen;
  await atomicJson(c.bindingPath, { ...c.binding, state: 'quiescing', attemptId: scope.attemptId, fence: 7 });
  const renewal = assert.rejects(c.value.renew(scope.attemptId, command), { code: 'COORDINATOR_RENEW_SCOPE_CHANGED' });
  snapshotResponse.end(JSON.stringify({ ...scope, generation: 3 })); await snapshot;
  await atomicJson(c.bindingPath, c.binding);
  await renewal;
  assert.equal(f.calls.length, 2, 'only original pending and in-flight snapshot reached HTTP');
});


test('a continuation ACK cannot explicitly change instance or attempt scope at any supported envelope level', async t => {
  for (const [name, ack] of [
    ['top attempt', { ...scope, attemptId: 'foreign-attempt', fence: 7 }],
    ['top instance', { ...scope, instanceId: 'foreign-instance', fence: 7 }],
    ['snapshot attempt', { snapshot: { ...scope, attempt: { ...scope, attemptId: 'foreign-attempt' }, fence: 7 } }],
    ['nested controller', { ...scope, attempt: { ...scope, controllerId: 'foreign-controller', fence: 7 } }],
  ]) await t.test(name, async st => {
    const f = await receiver(st, async ({ res, calls }) => {
      if (calls.length === 2) { res.writeHead(425); return res.end(JSON.stringify(rejected)); }
      res.end(JSON.stringify(ack));
    });
    const c = await client(st, f);
    await assert.rejects(c.value.renew(scope.attemptId, command), { code: 'COORDINATOR_RENEW_SCOPE_CHANGED' });
    assert.equal(f.calls.length, 3, 'the conflicting ACK is terminal, without a third lease request');
  });
});
