import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlCommandJournal } from './control-command-journal.mjs';
import { createControlCommandExecutor } from './control-command-executor.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const Database = require('better-sqlite3');
const deferred = () => { let resolve; const promise = new Promise(ok => { resolve = ok; }); return { promise, resolve }; };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'control-executor-test-'));
  let sqlite, epoch = 1, now = 1000;
  const path = join(directory, 'control.db');
  const open = () => {
    sqlite = new Database(path);
    const acquiredEpoch = epoch;
    const authorization = () => ({ epoch: acquiredEpoch, executorId: `controller-${acquiredEpoch}`, expiresAt: 20000 });
    const journal = createControlCommandJournal({ sqlite, instanceId: 'executor-test', clock: () => now,
      assertAuthority: value => assert.equal(value.epoch, epoch, 'stale authority cannot record a guess') });
    return { journal, executor: createControlCommandExecutor({ journal, authorization, clock: () => now }) };
  };
  let ports = open();
  t.after(async () => { sqlite.close(); await rm(directory, { recursive: true, force: true }); });
  return { get journal() { return ports.journal; }, get executor() { return ports.executor; },
    advance(value) { now = value; }, nextEpoch() { epoch++; },
    restart() { sqlite.close(); ports = open(); } };
}
function command(overrides = {}) {
  return { operationId: 'operation-one', commandId: 'command-one', stepId: 'restore-route',
    spec: { action: 'route', deadline: 9000, target: { routeGeneration: 17 }, budget: { maxActions: 1 } },
    invoke: () => ({ state: 'applied', result: { routeGeneration: 17 } }),
    inspect: () => ({ state: 'unknown', result: { code: 'UNCONFIRMED' } }), classify: receipt => receipt,
    ...overrides };
}

test('synchronous adapter reentry cannot inspect or dispatch before the original single-flight slot exists', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  let invocations = 0, lookups = 0, nested;
  const input = command({
    inspect: () => { lookups++; return { state: 'definitely-not-applied' }; },
    invoke: () => {
      invocations++;
      if (invocations === 1) {
        nested = f.executor.execute(input).then(value => ({ value }), error => ({ code: error.code }));
        entered.resolve();
        return release.promise;
      }
      return { state: 'applied', result: { routeGeneration: 17 } };
    },
  });
  const original = f.executor.execute(input);
  try {
    await entered.promise;
    assert.deepEqual(await nested, { code: 'CONTROL_COMMAND_IN_FLIGHT' });
    assert.equal(invocations, 1);
    assert.equal(lookups, 0);
    assert.equal(f.executor.activeCount(), 1);
  } finally {
    release.resolve({ state: 'applied', result: { routeGeneration: 17 } });
    await original;
  }
  assert.equal(f.executor.activeCount(), 0);
});

test('unknown ACK survives file SQLite restart and a new epoch looks up the original command without dispatch', async t => {
  const f = await fixture(t); let invocations = 0, lookups = 0;
  const input = command({ invoke: () => { invocations++; throw Object.assign(new Error('private transport detail'), { code: 'RPC_ACK_LOST' }); } });
  await assert.rejects(f.executor.execute(input), { code: 'RPC_ACK_LOST' });
  assert.equal(f.journal.lookup(input).state, 'unknown');
  f.nextEpoch(); f.restart();
  const result = await f.executor.execute({ ...input, inspect: scope => {
    lookups++;
    assert.equal(scope.commandId, input.commandId);
    assert.equal(scope.operationId, input.operationId);
    assert.equal(scope.spec.deadline, 9000);
    return { state: 'applied', result: { routeGeneration: 17 } };
  } });
  assert.deepEqual(result, { routeGeneration: 17 });
  assert.equal(invocations, 1); assert.equal(lookups, 1);
  assert.equal(f.journal.lookup(input).epoch, 2);
  assert.equal(f.journal.lookup(input).state, 'applied');
});

test('unknown lookup remains unknown and expired original deadline cannot be renewed for another mutation', async t => {
  const f = await fixture(t); let invocations = 0;
  const input = command({ invoke: () => { invocations++; throw Object.assign(new Error('timeout'), { code: 'RPC_TIMEOUT' }); } });
  await assert.rejects(f.executor.execute(input), { code: 'RPC_TIMEOUT' });
  await assert.rejects(f.executor.execute(input), { code: 'CONTROL_COMMAND_RESULT_UNKNOWN' });
  assert.equal(invocations, 1);
  f.advance(10000);
  await assert.rejects(f.executor.execute({ ...input, inspect: () => ({ state: 'definitely-not-applied' }) }), { code: 'CONTROL_COMMAND_DEADLINE_EXPIRED' });
  assert.equal(invocations, 1);
  await assert.rejects(f.executor.execute({ ...input, spec: { ...input.spec, deadline: 19000 } }), { code: 'CONTROL_COMMAND_SPEC_CONFLICT' });
  assert.equal(invocations, 1);
});

test('a fenced in-flight completion preserves the executing row for its successor to reconcile', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); let invocations = 0;
  const input = command({ invoke: () => { invocations++; entered.resolve(); return release.promise; } });
  const pending = f.executor.execute(input); await entered.promise;
  f.nextEpoch();
  release.resolve({ state: 'applied', result: { routeGeneration: 17 } });
  await assert.rejects(pending, /stale authority/);
  assert.equal(f.journal.lookup(input).state, 'executing');
  f.restart();
  assert.deepEqual(await f.executor.execute({ ...input, inspect: () => ({ state: 'applied', result: { routeGeneration: 17 } }) }), { routeGeneration: 17 });
  assert.equal(invocations, 1);
});
