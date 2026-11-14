import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlAgentLifecycle } from './control-agent-lifecycle.mjs';
import { digest } from './trust.mjs';

// Fixed Docker transport fixtures exercise dispatch/CAS/durable lookup here.
// These tests do not qualify physical Native/Guest maintenance.
async function fixture(t, { lostAck = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'control-agent-lifecycle-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = { containerId: 'a'.repeat(64), startIdentity: 'control-first', hostPid: 100, birthTicks: '200',
    cgroupDigest: digest('cgroup'), startedAt: new Date().toISOString(), artifactDigest: digest('code'), role: 'control-agent',
    running: true, paused: false, restartCount: 0, restartPolicy: 'no', oomKilled: false, exitCode: 0 };
  let actual = { ...target }, dispatches = 0;
  const lifecycle = await createControlAgentLifecycle({ config: { instanceId: 'instance', stableControl: {}, controlFoundationRoot: root, docker: { cli: 'docker', args: [] } },
    packages: { old: {}, new: {} }, adapter: { inspect: async () => ({ ...actual }) },
    run: async (_cli, args) => {
      if (args[0] === 'ps') return target.containerId + '\n';
      assert.deepEqual(args, ['kill', '--signal', 'SIGTERM', target.containerId]); dispatches++;
      actual = { ...actual, running: false, hostPid: 0, exitCode: 143, finishedAt: new Date().toISOString() };
      if (lostAck) throw Object.assign(Error('lost ACK'), { code: 'TRANSPORT_UNKNOWN' });
      return '';
    } });
  const request = { instanceId: 'instance', maintenanceId: 'maintenance-one', commandId: 'maintenance-one:stop-old', specDigest: digest('command'),
    deadline: Date.now() + 5000, kind: 'stop-control-agent', target, signal: 'SIGTERM', assertBeforeDispatch() {} };
  return { lifecycle, request, dispatches: () => dispatches, change: value => { actual = { ...actual, ...value }; } };
}
test('maintenance stops only its original Agent and reconciles the original receipt without redispatch', async t => {
  const f = await fixture(t);
  assert.equal((await f.lifecycle.inventory()).agents.length, 1);
  const stopped = await f.lifecycle.stop(f.request);
  assert.equal(stopped.normalExit, true); assert.equal(stopped.forced, false);
  const found = await f.lifecycle.lookup(f.request);
  assert.equal(found.state, 'applied'); assert.equal(f.dispatches(), 1);
  await assert.rejects(f.lifecycle.stop(f.request)); assert.equal(f.dispatches(), 1);
});
test('lost stop ACK is reconciled from real exit state under the same command', async t => {
  const f = await fixture(t, { lostAck: true });
  await assert.rejects(f.lifecycle.stop(f.request), { code: 'TRANSPORT_UNKNOWN' });
  assert.equal((await f.lifecycle.lookup(f.request)).state, 'applied'); assert.equal(f.dispatches(), 1);
  f.change({ finishedAt: 'unknown' }); assert.equal((await f.lifecycle.lookup(f.request)).state, 'unknown');
});
test('an exact crashed Agent is observed terminated without claiming a signal or stopping another process', async t => {
  const f = await fixture(t); f.change({ running: false, hostPid: 0, exitCode: 1, finishedAt: new Date().toISOString() });
  const result = await f.lifecycle.stop(f.request);
  assert.equal(result.terminationObserved, true); assert.equal(result.normalExit, false); assert.equal(result.signal, null);
  assert.equal(result.exitCode, 1); assert.equal(f.dispatches(), 0);
  assert.equal((await f.lifecycle.lookup(f.request)).state, 'applied');
});
test('PID birth change, foreign role and changed original command cannot acquire dispatch authority', async t => {
  const f = await fixture(t); f.change({ birthTicks: '201' });
  await assert.rejects(f.lifecycle.stop(f.request), { code: 'CONTROL_AGENT_STOP_BIRTH_CHANGED' });
  assert.equal(f.dispatches(), 0);
  await assert.rejects(f.lifecycle.stop({ ...f.request, target: { ...f.request.target, role: 'owner' } }), { code: 'CONTROL_AGENT_STOP_FORBIDDEN' });
  f.change({ birthTicks: '200' }); await f.lifecycle.stop(f.request);
  await assert.rejects(f.lifecycle.lookup({ ...f.request, target: { ...f.request.target, startedAt: new Date(1).toISOString() } }), { code: 'CONTROL_AGENT_STOP_COMMAND_CHANGED' });
});
