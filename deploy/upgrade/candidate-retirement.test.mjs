import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { digest } from './trust.mjs';
import { createControlCommandJournal } from './control-command-journal.mjs';
import { planCandidateRetirement, createCandidateRetirementExecutor } from './candidate-retirement.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const Database = require('better-sqlite3');
const epoch = Date.parse('2026-10-20T10:00:00.000Z');
const identity = () => ({ instanceId: 'retirement-instance', role: 'coordinator', containerId: 'a'.repeat(64), startIdentity: 'candidate-start-identity', hostPid: 2091, startedAt: '2026-10-20T09:00:00.123456789Z', artifactDigest: digest('signed-candidate-artifact'), attemptId: 'failed-attempt-1' });
const state = () => ({
  known: true, instanceId: 'retirement-instance', revision: 8, observedAt: new Date(epoch).toISOString(), target: identity(),
  running: true, paused: false, restartPolicy: 'no', attemptTerminal: true, authorityReleased: true, controllerLeaseExpiresAt: epoch - 1, legacyInstaller: false,
  references: { entry: 0, http: 0, ws: 0, writer: 0, handoff: 0, activeCommands: 0, fallback: 0, owners: 0, guests: 0, recovery: 0, workers: 0, userOperations: 0 },
});
function planned(current = state(), patch = {}) {
  return planCandidateRetirement({ instanceId: 'retirement-instance', target: identity(), state: current, deadline: epoch + 60_000, budget: { maxDurationMs: 10_000 }, maxObservationAgeMs: 5000, now: epoch, ...patch });
}

// Real file SQLite/control journal; the narrow Supervisor is a contract double.
// These tests do not claim real Docker signals or Native/Guest qualification.
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'candidate-retirement-'));
  const env = { root, now: epoch, current: state(), authority: { epoch: 1, executorId: 'controller-1', expiresAt: epoch + 120_000 }, calls: { requests: 0, signals: 0, lookups: 0 }, sql: null, beforeDispatch: null, afterSignal: null, responseTransform: value => value };
  const plan = planned(env.current, options);
  assert.equal(plan.qualified, true);
  const assertAuthority = authorization => {
    if (authorization.epoch !== env.authority.epoch || authorization.executorId !== env.authority.executorId) throw Object.assign(new Error('STALE_AUTHORITY'), { code: 'STALE_AUTHORITY' });
  };
  function open() {
    env.sql = new Database(join(root, 'control.db'));
    env.journal = createControlCommandJournal({ sqlite: env.sql, instanceId: 'retirement-instance', assertAuthority, clock: () => env.now });
    const adapter = {
      async terminate(command) {
        env.calls.requests++;
        await env.beforeDispatch?.(command);
        assertAuthority(command.authorization);
        // The adapter rechecks under its protected reference/CAS boundary.
        const fresh = planCandidateRetirement({ instanceId: 'retirement-instance', target: command.target, state: env.current, deadline: command.deadline, budget: command.budget, maxObservationAgeMs: plan.spec.maxObservationAgeMs, now: env.now });
        if (!fresh.qualified || fresh.spec.expectedRevision !== command.expectedRevision || fresh.spec.expectedStateDigest !== command.expectedStateDigest) {
          const absent = { ...receipt(command), state: 'definitely-not-applied', definitelyNotApplied: true };
          await fs.writeFile(join(root, 'supervisor-result.json'), JSON.stringify(absent));
          throw Object.assign(new Error('SUPERVISOR_CAS_REFUSED'), { code: 'SUPERVISOR_CAS_REFUSED' });
        }
        assert.equal(command.signal, 'SIGTERM');
        assert.equal(command.target.role, 'coordinator');
        assert.equal(env.journal.lookup(command).state, 'executing');
        assert.equal(env.journal.lookup(command).specDigest, command.specDigest);
        assert.equal(Object.hasOwn(command, 'shell'), false);
        env.calls.signals++;
        const result = { ...receipt(command), state: 'applied', signal: 'SIGTERM', forced: false, removed: false, volumesRemoved: false, normalExit: true, exit: { running: false, hostPid: 0, oomKilled: false, exitCode: 143 } };
        await fs.writeFile(join(root, 'supervisor-result.json'), JSON.stringify(result));
        if (env.afterSignal) await env.afterSignal(command);
        return env.responseTransform(result);
      },
      async lookupCommand(command) {
        env.calls.lookups++;
        return env.responseTransform(JSON.parse(await fs.readFile(join(root, 'supervisor-result.json'), 'utf8')));
      },
      forceKill() { assert.fail('force kill is not a retirement capability'); },
      prune() { assert.fail('prune is not a retirement capability'); },
      removeVolume() { assert.fail('volume removal is not a retirement capability'); },
    };
    env.executor = createCandidateRetirementExecutor({ instanceId: 'retirement-instance', journal: env.journal, adapter, getState: async () => structuredClone(env.current), clock: () => env.now, readTimeoutMs: 1000 });
  }
  function receipt(command) {
    return { instanceId: 'retirement-instance', operationId: command.operationId, commandId: command.commandId, specDigest: command.specDigest, target: command.target };
  }
  open();
  t.after(async () => { env.sql?.close(); await fs.rm(root, { recursive: true, force: true }); });
  env.input = () => ({ operationId: 'parent-operation', commandId: 'retire-one-candidate', stepId: 'retire-candidate', plan, authorization: { ...env.authority } });
  env.reopen = () => { env.sql.close(); open(); };
  return env;
}

test('only exact terminal unreferenced roles qualify; no Owner, Guest, control agent, short ID or unknown birth', () => {
  assert.equal(planned().qualified, true);
  for (const role of ['owner', 'guest', 'control-agent', 'foundation']) {
    assert.equal(planned(state(), { target: { ...identity(), role } }).reason, 'RETIREMENT_TARGET_FORBIDDEN');
  }
  for (const patch of [{ containerId: 'a'.repeat(12) }, { hostPid: 0 }, { startedAt: 'unknown' }, { artifactDigest: null }, { attemptId: null }]) {
    assert.equal(planned(state(), { target: { ...identity(), ...patch } }).qualified, false);
  }
  for (const key of ['containerId', 'startIdentity', 'startedAt', 'hostPid', 'artifactDigest', 'attemptId']) {
    const current = state();
    current.target[key] = key === 'hostPid' ? 2092 : key === 'containerId' ? 'b'.repeat(64) : key === 'artifactDigest' ? digest('another-artifact') : key === 'startedAt' ? '2026-10-20T09:01:00.000Z' : 'another-valid-identity';
    assert.equal(planned(current).reason, 'RETIREMENT_IDENTITY_CHANGED');
  }
});

test('every current, connection, writer, handoff, command, fallback and user resource reference blocks independently', () => {
  for (const reference of Object.keys(state().references)) {
    const current = state(); current.references[reference] = 1;
    const result = planned(current);
    assert.equal(result.reason, 'RETIREMENT_ROLE_REFERENCED', reference);
    assert.deepEqual(result.referenced, [reference]);
    current.references[reference] = null;
    assert.equal(planned(current).reason, 'RETIREMENT_REFERENCES_UNKNOWN');
  }
  const extra = state(); extra.references.unrecognised = 0;
  assert.equal(planned(extra).qualified, false);
});

test('unreleased authority, live controller lease, automatic restart, freezer state and stale proof do not qualify', () => {
  for (const patch of [
    { attemptTerminal: false }, { authorityReleased: false }, { controllerLeaseExpiresAt: epoch + 1 },
    { paused: true }, { restartPolicy: 'always' }, { observedAt: new Date(epoch - 5001).toISOString() },
    { observedAt: new Date(epoch + 1).toISOString() }, { known: false }, { legacyInstaller: undefined },
  ]) assert.equal(planned({ ...state(), ...patch }).qualified, false);
  const target = { ...identity(), role: 'installer' }, current = { ...state(), target };
  assert.equal(planned(current, { target }).qualified, false);
  current.legacyInstaller = true;
  assert.equal(planned(current, { target }).qualified, true);
});

test('persists immutable command before SIGTERM and records only confirmed normal exit; a repeated call is read-only', async t => {
  const f = await fixture(t);
  const result = await f.executor.execute(f.input());
  assert.equal(result.state, 'applied');
  assert.equal(result.result.exit.hostPid, 0);
  assert.equal(f.calls.signals, 1);
  assert.deepEqual(await f.executor.execute(f.input()), result);
  assert.deepEqual(f.calls, { requests: 1, signals: 1, lookups: 0 });
});

test('new references or a new physical birth between planning and execution block with zero adapter calls', async t => {
  for (const change of [current => { current.references.http = 1; }, current => { current.target.startedAt = '2026-10-20T09:02:00Z'; }, current => { current.revision++; }]) {
    await t.test(change.toString(), async sub => {
      const f = await fixture(sub); change(f.current);
      const result = await f.executor.execute(f.input());
      assert.equal(result.state, 'blocked');
      assert.equal(result.result.dispatched, false);
      assert.equal(f.calls.requests, 0);
      assert.equal(f.calls.signals, 0);
    });
  }
});

test('Supervisor CAS closes the race after the last getState instead of trusting a prior zero-reference snapshot', async t => {
  const f = await fixture(t);
  f.beforeDispatch = () => { f.current.references.ws = 1; f.current.revision++; };
  assert.equal((await f.executor.execute(f.input())).state, 'unknown');
  assert.equal(f.calls.requests, 1);
  assert.equal(f.calls.signals, 0);
  assert.equal((await f.executor.execute(f.input())).state, 'definitely-not-applied');
  assert.equal(f.calls.requests, 1);
  assert.equal(f.calls.lookups, 1);
});

test('ACK loss plus real SQLite close/reopen and a new epoch reconciles the original command without another signal', async t => {
  const f = await fixture(t);
  f.afterSignal = () => { throw Object.assign(new Error('response lost'), { code: 'ACK_LOST' }); };
  const input = f.input();
  assert.equal((await f.executor.execute(input)).state, 'unknown');
  f.reopen();
  f.now += 2000;
  f.authority = { epoch: 2, executorId: 'controller-2', expiresAt: f.now + 120_000 };
  const restored = await f.executor.execute({ ...input, authorization: { ...f.authority } });
  assert.equal(restored.state, 'applied');
  assert.equal(restored.commandId, input.commandId);
  assert.equal(restored.specDigest, input.plan.specDigest);
  assert.equal(restored.spec.deadline, input.plan.spec.deadline);
  assert.deepEqual(f.calls, { requests: 1, signals: 1, lookups: 1 });
});

test('executing durable state after a controller crash requires lookup even if it never sent the command', async t => {
  const f = await fixture(t), input = f.input();
  f.journal.prepare({ ...input, spec: input.plan.spec });
  f.journal.begin(input);
  f.reopen();
  const row = await f.executor.execute(input);
  assert.equal(row.state, 'unknown');
  assert.equal(f.calls.requests, 0);
  assert.equal(f.calls.signals, 0);
  assert.equal(f.calls.lookups, 1);
});

test('a second command ID cannot bypass a still-unknown command reference to the same candidate', async t => {
  const f = await fixture(t);
  f.afterSignal = () => { throw Object.assign(new Error('lost'), { code: 'ACK_LOST' }); };
  await f.executor.execute(f.input());
  f.current.references.activeCommands = 1;
  f.current.revision++;
  const next = { ...f.input(), commandId: 'copied-unknown-action' };
  assert.equal((await f.executor.execute(next)).state, 'blocked');
  assert.equal(f.calls.requests, 1);
  assert.equal(f.calls.signals, 1);
});

test('changed spec under the same command ID is rejected, while new authorization never changes the original deadline or budget', async t => {
  const f = await fixture(t), input = f.input();
  f.journal.prepare({ ...input, spec: input.plan.spec });
  const changed = structuredClone(input.plan);
  changed.spec.deadline++;
  changed.specDigest = digest(changed.spec);
  await assert.rejects(f.executor.execute({ ...input, plan: changed }), { code: 'CONTROL_COMMAND_SPEC_CONFLICT' });
  assert.equal(f.calls.requests, 0);
  f.now += 10_001;
  f.current.observedAt = new Date(f.now).toISOString();
  f.authority = { epoch: 2, executorId: 'controller-2', expiresAt: f.now + 120_000 };
  const result = await f.executor.execute({ ...input, authorization: { ...f.authority } });
  assert.equal(result.state, 'unknown');
  assert.equal(result.result.code, 'RETIREMENT_STATE_TIMEOUT');
  assert.equal(f.calls.requests, 0);
  assert.equal(result.spec.deadline, input.plan.spec.deadline);
  assert.deepEqual(result.spec.budget, input.plan.spec.budget);
});

test('an expired original command may be reconciled but never dispatched again', async t => {
  const f = await fixture(t), input = f.input();
  f.afterSignal = () => { throw Object.assign(new Error('lost'), { code: 'ACK_LOST' }); };
  await f.executor.execute(input);
  f.now = input.plan.spec.deadline + 1;
  f.authority = { epoch: 2, executorId: 'controller-2', expiresAt: f.now + 1000 };
  const row = await f.executor.reconcile({ ...input, authorization: { ...f.authority } });
  assert.equal(row.state, 'applied');
  assert.equal(f.calls.signals, 1);
  assert.equal(f.calls.requests, 1);
});

test('an original planned command whose deadline passed is not dispatched under a fresh authorization', async t => {
  const f = await fixture(t), input = f.input();
  f.journal.prepare({ ...input, spec: input.plan.spec });
  f.now = input.plan.spec.deadline + 1;
  f.authority = { epoch: 2, executorId: 'controller-2', expiresAt: f.now + 1000 };
  await assert.rejects(f.executor.execute({ ...input, authorization: { ...f.authority } }), { code: 'CONTROL_COMMAND_DEADLINE_EXPIRED' });
  assert.equal(f.calls.requests, 0);
  assert.equal(f.calls.signals, 0);
});

test('a real request timeout remains unknown and later queries the original applied receipt without another signal', async t => {
  const f = await fixture(t, { budget: { maxDurationMs: 20 } });
  f.afterSignal = () => new Promise(() => {});
  const row = await f.executor.execute(f.input());
  assert.equal(row.state, 'unknown');
  assert.equal(row.result.code, 'RETIREMENT_ADAPTER_TIMEOUT');
  assert.equal((await f.executor.execute(f.input())).state, 'applied');
  assert.deepEqual(f.calls, { requests: 1, signals: 1, lookups: 1 });
});

test('stale authority at the actual dispatch boundary cannot stop a candidate', async t => {
  const f = await fixture(t);
  f.beforeDispatch = () => { f.authority = { epoch: 2, executorId: 'controller-2', expiresAt: f.now + 120_000 }; };
  await assert.rejects(f.executor.execute(f.input()), { code: 'STALE_AUTHORITY' });
  assert.equal(f.calls.signals, 0);
});

test('forced, removed, wrong-incarnation and unconfirmed exit receipts cannot become an applied retirement', async t => {
  for (const change of [value => ({ ...value, forced: true }), value => ({ ...value, removed: true }), value => ({ ...value, target: { ...value.target, hostPid: 3091 } }), value => ({ ...value, exit: { ...value.exit, running: true } })]) {
    await t.test(change.toString(), async sub => {
      const f = await fixture(sub); f.responseTransform = change;
      assert.equal((await f.executor.execute(f.input())).state, 'unknown');
      assert.equal(f.calls.signals, 1);
      assert.equal((await f.executor.execute(f.input())).state, 'unknown');
      assert.equal(f.calls.requests, 1);
    });
  }
});

test('a forged Owner/SIGKILL plan is refused before any control ledger mutation or adapter call', async t => {
  for (const change of [spec => { spec.target.role = 'owner'; }, spec => { spec.signal = 'SIGKILL'; }]) {
    const f = await fixture(t), input = f.input(), plan = structuredClone(input.plan);
    change(plan.spec); plan.specDigest = digest(plan.spec);
    await assert.rejects(f.executor.execute({ ...input, plan }), { code: 'RETIREMENT_COMMAND_INVALID' });
    assert.equal(f.sql.prepare('SELECT count(*) n FROM control_commands').get().n, 0);
    assert.equal(f.calls.requests, 0);
  }
});
