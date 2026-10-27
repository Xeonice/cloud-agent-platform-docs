import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlInspectorClient } from './control-inspector-client.mjs';

const instanceId = 'inspector-test', initial = Date.parse('2026-10-20T00:00:00.000Z');
const metadata = now => ({ schema: 17, requiredDataFormats: ['project-name-v2-authority'], defaultImagesSnapshot: [{ alias: 'standard' }], observedAt: new Date(now).toISOString() });
const deferred = () => { let resolve; const promise = new Promise(ok => { resolve = ok; }); return { promise, resolve }; };
function receipt(action, result, extra = {}) { return { instanceId, action, startedAt: new Date(initial).toISOString(), completedAt: new Date(initial).toISOString(), result, ...extra }; }

test('metadata is single-flight, retains physical observedAt and rejects stale or clock-reversed cached proof', async () => {
  let now = initial, calls = 0;
  const pending = deferred(), source = metadata(initial);
  const port = createControlInspectorClient({ instanceId, clock: () => now,
    client: { inspection: (body, options) => { calls++; assert.equal(body.action, 'metadata'); assert.equal(options.timeoutMs, 2000); return pending.promise; } } });
  assert.throws(() => port.schema(), { code: 'BUSINESS_METADATA_UNKNOWN_OR_STALE' });
  const first = port.refreshMetadata(), second = port.refreshMetadata();
  assert.equal(calls, 1); pending.resolve(receipt('metadata', source));
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, source); assert.deepEqual(b, source);
  a.defaultImagesSnapshot[0].alias = 'caller-mutated'; source.requiredDataFormats.length = 0;
  assert.equal(port.defaultImagesSnapshot()[0].alias, 'standard'); assert.equal(port.requiresProjectNameV2(), true);
  now += 5001; assert.throws(() => port.schema(), { code: 'BUSINESS_METADATA_UNKNOWN_OR_STALE' });
  now = initial - 1; assert.throws(() => port.metadata(), { code: 'BUSINESS_METADATA_UNKNOWN_OR_STALE' });
});

test('unknown, foreign, mismatched or stale metadata never becomes a freshly dated observation', async () => {
  for (const value of [
    receipt('metadata', metadata(initial), { instanceId: 'other' }),
    receipt('capture', metadata(initial)),
    receipt('metadata', metadata(initial), { completedAt: 'unknown' }),
    receipt('metadata', metadata(initial - 5001)),
    receipt('metadata', { ...metadata(initial), requiredDataFormats: ['unrecognized-format'] }),
  ]) {
    const port = createControlInspectorClient({ instanceId, clock: () => initial, client: { inspection: async () => value } });
    await assert.rejects(port.refreshMetadata());
    assert.throws(() => port.metadata(), { code: 'BUSINESS_METADATA_UNKNOWN_OR_STALE' });
  }
});

test('fixed original-command and participant lookups preserve exact IDs and transport time budget without minting proof', async () => {
  const calls = [], physical = { observedAt: '2026-10-19T23:59:00.000Z', state: 'unknown' };
  const port = createControlInspectorClient({ instanceId, clock: () => initial, proofTimeoutMs: 2000,
    client: { inspection: async (body, options) => { calls.push({ body, options }); return receipt(body.action, physical); } } });
  const attemptId = '22222222-2222-4222-8222-222222222222';
  assert.deepEqual(await port.commandStatus({ attemptId, commandKind: 'migration', operationId: 'original-operation' }), physical);
  assert.deepEqual(await port.participantCommandStatus({ attemptId, commandId: 'original-command' }), physical);
  assert.deepEqual(calls, [
    { body: { action: 'commandStatus', attemptId, commandKind: 'migration', operationId: 'original-operation' }, options: { timeoutMs: 2000 } },
    { body: { action: 'participantCommandStatus', attemptId, commandId: 'original-command' }, options: { timeoutMs: 2000 } },
  ]);
  assert.equal(physical.observedAt, '2026-10-19T23:59:00.000Z');
});
