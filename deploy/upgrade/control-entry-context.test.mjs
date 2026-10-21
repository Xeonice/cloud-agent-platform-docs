import test from 'node:test';
import assert from 'node:assert/strict';
import { signEntryContext, createEntryContextVerifier, stripEntryForwardingHeaders, entryControlHeaders, decodeEntryControlContext, entryBindingDigest } from './control-entry-context.mjs';
const key = 'e'.repeat(32), instanceId = 'test-instance';
const input = { instanceId, key, remoteAddress: '100.73.71.22', method: 'GET', path: '/api/system/upgrade/status', clock: () => 1000 };
const request = headers => ({ method: input.method, url: input.path, headers, socket: { remoteAddress: '127.0.0.1' } });
test('signed public context binds exact instance, client address, method and original path', () => {
  const headers = signEntryContext(input), verifier = createEntryContextVerifier({ instanceId, key, clock: () => 1000 });
  assert.equal(verifier.verify(request(headers)).clientIp, '100.73.71.22');
  assert.throws(() => verifier.verify(request(headers)), { code: 'ENTRY_CONTEXT_REPLAY' });
  assert.throws(() => createEntryContextVerifier({ instanceId, key, clock: () => 1000 }).verify({ ...request(headers), method: 'POST' }), { code: 'ENTRY_CONTEXT_REQUEST_MISMATCH' });
  assert.throws(() => createEntryContextVerifier({ instanceId, key, clock: () => 1000 }).verify({ ...request(headers), url: input.path + '?other=1' }), { code: 'ENTRY_CONTEXT_REQUEST_MISMATCH' });
  assert.throws(() => verifier.verify({ ...request(headers), socket: { remoteAddress: '100.97.190.45' } }), { code: 'ENTRY_CONTEXT_PEER_INVALID' });
});
test('forged signatures, old timestamps and cross-instance contexts fail', () => {
  const headers = signEntryContext(input);
  assert.throws(() => createEntryContextVerifier({ instanceId, key, clock: () => 1000 }).verify(request({ ...headers, 'x-platform-entry-signature': 'a'.repeat(64) })), { code: 'ENTRY_CONTEXT_SIGNATURE_INVALID' });
  assert.throws(() => createEntryContextVerifier({ instanceId, key, clock: () => 12000 }).verify(request(headers)), { code: 'ENTRY_CONTEXT_EXPIRED' });
  assert.throws(() => createEntryContextVerifier({ instanceId: 'other-instance', key, clock: () => 1000 }).verify(request(headers)), { code: 'ENTRY_CONTEXT_REQUEST_MISMATCH' });
});
test('a full nonce cache refuses overload without removing an unexpired replay guard', () => {
  let wall = 1000, mono = 0;
  const verifier = createEntryContextVerifier({ instanceId, key, clock: () => wall, monotonicClock: () => mono, maxNonces: 1 });
  const one = signEntryContext(input), two = signEntryContext(input);
  verifier.verify(request(one));
  assert.throws(() => verifier.verify(request(two)), { code: 'ENTRY_CONTEXT_REPLAY_CAPACITY' });
  assert.throws(() => verifier.verify(request(one)), { code: 'ENTRY_CONTEXT_REPLAY' });
  wall = 12001; mono = 11001;
  const next = signEntryContext({ ...input, clock: () => wall });
  assert.equal(verifier.verify(request(next)).issuedAt, wall); assert.equal(verifier.size(), 1);
});
test('forwarding sanitization removes spoofed context and private headers while preserving cookie Origin and CSRF', () => {
  const value = stripEntryForwardingHeaders({ forwarded: 'for=127.0.0.1', 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-platform-entry-context': 'spoofed', 'x-platform-internal-key': 'private', 'x-platform-control-epoch': '99', cookie: 'session-fixture', origin: 'http://instance.test', 'x-upgrade-csrf': 'csrf-fixture' });
  assert.deepEqual(value, { cookie: 'session-fixture', origin: 'http://instance.test', 'x-upgrade-csrf': 'csrf-fixture' });
});
test('private control envelope is independent of business fence and canonical digest ignores only live observer counters', () => {
  const context = { schemaVersion: 1, epoch: 7, operationId: 'recovery-one', executorId: 'control-one', kind: 'recovery', recoveryId: 'recovery-one', expectedBindingDigest: 'sha256:' + 'a'.repeat(64) };
  const headers = entryControlHeaders({ key, context });
  assert.deepEqual(decodeEntryControlContext(headers['x-platform-entry-control-context']), context);
  assert.equal(headers['x-platform-entry-controller-key'], key);
  assert.throws(() => entryControlHeaders({ key, context: { ...context, fence: 9 } }), { code: 'ENTRY_CONTROL_CONTEXT_INVALID' });
  assert.throws(() => entryControlHeaders({ key, context: { ...context, recoveryId: undefined } }), { code: 'ENTRY_CONTROL_CONTEXT_INVALID' });
  const binding = { instanceId, attemptId: 'old-attempt', fence: 26, routeGeneration: 34, weight: 0 };
  assert.equal(entryBindingDigest(binding), entryBindingDigest({ ...binding, inFlight: 1, activeWS: 10, httpByDigest: { old: 7 }, wsByDigest: {}, controlAdmission: { epoch: 7 } }));
  assert.notEqual(entryBindingDigest(binding), entryBindingDigest({ ...binding, routeGeneration: 35 }));
});
