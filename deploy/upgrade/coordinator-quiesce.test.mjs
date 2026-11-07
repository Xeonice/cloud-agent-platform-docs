import test from 'node:test';
import assert from 'node:assert/strict';
import { quiesceCoordinator } from './coordinator-quiesce.mjs';

const busy = () => Object.assign(new Error('BACKGROUND_WORK_PENDING'), { code: 'BACKGROUND_WORK_PENDING', status: 409 });
const prepared = () => ({ stage: 'prepared', applied: false, commitKnown: true, resumeAction: 'quiesce' });
const body = () => ({ action: 'quiesce', fence: 7, operationId: 'same-operation',
  planDigest: 'sha256:' + 'a'.repeat(64), candidate: { origin: 'http://127.0.0.1:1', startIdentity: 'same-process' } });

function fixture({ call, fenceCheck, advance = 0 } = {}) {
  let now = 1000;
  const calls = [], waits = [], fences = [];
  const input = body();
  const coordinator = {
    async assertFence(id, fence) {
      fences.push({ id, fence });
      await fenceCheck?.({ fences, tick: ms => { now += ms; } });
    },
    async coordinatorHandoff(id, value) {
      calls.push({ id, value: structuredClone(value) });
      return call({ id, value, calls, input, tick: ms => { now += ms; } });
    },
  };
  const run = () => quiesceCoordinator({ coordinator, attemptId: 'same-attempt', body: input,
    deadline: 1500, clock: () => now, pause: async ms => { waits.push(ms); now += ms + advance; } });
  return { run, calls, waits, fences };
}

test('busy is observed to its original prepared row before one bounded wait and fixed continuation', async () => {
  const f = fixture({ call: ({ value, calls, input }) => {
    if (value.action === 'status') {
      // A caller/receiver cannot change the command while it is waiting.
      input.fence = 99; input.operationId = 'other'; input.candidate.startIdentity = 'other-process';
      value.candidate.startIdentity = 'receiver-modified';
      return prepared();
    }
    if (calls.length === 1) throw busy();
    return { commitKnown: true, stage: 'quiesced' };
  } });
  assert.deepEqual(await f.run(), { commitKnown: true, stage: 'quiesced' });
  assert.deepEqual(f.calls.map(c => c.value.action), ['quiesce', 'status', 'quiesce']);
  for (const call of f.calls) {
    assert.equal(call.id, 'same-attempt');
    assert.deepEqual(call.value, { ...body(), action: call.value.action });
  }
  assert.deepEqual(f.waits, [100]);
  assert.ok(f.fences.every(f => f.id === 'same-attempt' && f.fence === 7));
});

test('successful quiesce at the startup boundary returns immediately for release/adopt', async () => {
  const f = fixture({ call: ({ tick }) => { tick(501); return { commitKnown: true, stage: 'quiesced' }; } });
  assert.equal((await f.run()).stage, 'quiesced');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.waits, []);
});

test('busy rejection after original startup deadline cannot start even a status read', async () => {
  const f = fixture({ call: ({ tick }) => { tick(500); throw busy(); } });
  await assert.rejects(f.run(), { code: 'ROLE_PREPARATION_STARTUP_EXCEEDED' });
  assert.deepEqual(f.calls.map(c => c.value.action), ['quiesce']);
  assert.deepEqual(f.waits, []);
});

test('a status read which consumes original startup budget cannot authorize another mutation', async () => {
  const f = fixture({ call: ({ value, tick }) => {
    if (value.action === 'quiesce') throw busy();
    tick(500); return prepared();
  } });
  await assert.rejects(f.run(), { code: 'ROLE_PREPARATION_STARTUP_EXCEEDED' });
  assert.deepEqual(f.calls.map(c => c.value.action), ['quiesce', 'status']);
  assert.deepEqual(f.waits, []);
});

test('bounded backoff cannot extend original startup budget or dispatch late', async () => {
  const f = fixture({ advance: 400, call: ({ value }) => {
    if (value.action === 'quiesce') throw busy();
    return prepared();
  } });
  await assert.rejects(f.run(), { code: 'ROLE_PREPARATION_STARTUP_EXCEEDED' });
  assert.deepEqual(f.calls.map(c => c.value.action), ['quiesce', 'status']);
  assert.deepEqual(f.waits, [100]);
});

test('status transport loss, foreign intent or fence expiry never starts another quiesce', async t => {
  for (const error of [new DOMException('Timed out', 'TimeoutError'),
    Object.assign(new Error('HANDOFF_INTENT_CONFLICT'), { code: 'HANDOFF_INTENT_CONFLICT', status: 409 }),
    Object.assign(new Error('UPGRADE_FENCE_EXPIRED'), { code: 'UPGRADE_FENCE_EXPIRED', status: 409 }),
  ]) await t.test(error.message, async () => {
    const f = fixture({ call: ({ value }) => { if (value.action === 'quiesce') throw busy(); throw error; } });
    await assert.rejects(f.run(), actual => actual === error);
    assert.deepEqual(f.calls.map(c => c.value.action), ['quiesce', 'status']);
    assert.deepEqual(f.waits, []);
  });
});

test('a fence changing during the ready backoff prevents subsequent dispatch', async () => {
  const f = fixture({ fenceCheck: ({ fences }) => {
    if (fences.length === 4) throw Object.assign(new Error('UPGRADE_FENCE_EXPIRED'), { code: 'UPGRADE_FENCE_EXPIRED' });
  }, call: ({ value }) => { if (value.action === 'quiesce') throw busy(); return prepared(); } });
  await assert.rejects(f.run(), { code: 'UPGRADE_FENCE_EXPIRED' });
  assert.deepEqual(f.calls.map(c => c.value.action), ['quiesce', 'status']);
  assert.deepEqual(f.waits, [100]);
});
