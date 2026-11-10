import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createControlDiagnostics, CONTROL_DIAGNOSTIC_BUDGETS } from './control-diagnostics.mjs';

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const span = over => ({ role: 'coordinator', phase: 'fence-check', requestKind: 'fence-check', traceId: id(1), spanId: id(2), operationId: id(3), attemptId: id(4), commandId: id(5), startIdentity: 'pid:42:born:1729', elapsedMs: 12.5, ...over });
const fault = number => ({ faultId: 'fault-' + id(number), attemptId: id(number + 100), operationId: id(3), phase: 'prepared-ready', code: 'UPGRADE_RPC_TIMEOUT' });
const wait = ms => new Promise(accept => setTimeout(accept, ms));
function gate() { let release; const promise = new Promise(accept => { release = accept; }); return { promise, release }; }
async function fixture(t, over = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'control-diagnostics-'));
  const diagnostics = await createControlDiagnostics({ directory, instanceId: 'test-instance', budgets: { minFreeBytes: 0, maxSampleCpuMicros: 1_000_000, maxProcessingMs: 100, ...over.budgets }, ...over, ...(over.budgets ? { budgets: { minFreeBytes: 0, maxSampleCpuMicros: 1_000_000, maxProcessingMs: 100, ...over.budgets } } : {}) });
  t.after(async () => { diagnostics.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { diagnostics, directory };
}
async function readPack(directory, faultId) { return (await fs.readFile(join(directory, faultId + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }

test('default budgets are finite and invalid expansions cannot create unbounded event buffers', async t => {
  assert.equal(CONTROL_DIAGNOSTIC_BUDGETS.maxRoleBytes, 1024 * 1024);
  assert.equal(CONTROL_DIAGNOSTIC_BUDGETS.maxFaultBytes, 8 * 1024 * 1024);
  assert.equal(CONTROL_DIAGNOSTIC_BUDGETS.activeIntervalMs, 1000);
  assert.equal(CONTROL_DIAGNOSTIC_BUDGETS.idleIntervalMs, 10000);
  await assert.rejects(() => createControlDiagnostics({ directory: tmpdir(), instanceId: 'test', budgets: { maxRoleBytes: 2 * 1024 * 1024 } }), /DIAGNOSTIC_BUDGET_INVALID/);
  const { diagnostics } = await fixture(t);
  assert.equal(diagnostics.status().initialized, true);
});

test('write entrance removes secrets, arbitrary objects/getters and unsafe identity strings before persistence', async t => {
  const { diagnostics, directory } = await fixture(t);
  const secret = 'sk-private-do-not-store-123456'; let getterRead = false, jsonRead = false;
  const input = span({ operationId: secret, headers: { authorization: secret }, env: secret, body: secret, terminal: secret, model: secret, command: secret, stack: secret, message: secret, toJSON() { jsonRead = true; return { token: secret }; } });
  Object.defineProperty(input, 'responseBytes', { get() { getterRead = true; return secret; } });
  assert.equal(diagnostics.recordSpan(input), true);
  assert.equal(diagnostics.recordSpan(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(secret); } })), false);
  const receipt = await diagnostics.captureFault({ ...fault(10), headers: secret, error: new Error(secret) });
  assert.equal(receipt.state, 'persisted');
  const text = await fs.readFile(join(directory, receipt.faultId + '.jsonl'), 'utf8');
  assert.equal(text.includes(secret), false); assert.equal(getterRead, false); assert.equal(jsonRead, false);
  const events = await readPack(directory, receipt.faultId);
  assert.match(events[1].operationId, /^sha256:/);
  assert.equal(events[1].elapsedMs, 12.5);
  assert.equal(events[1].requestKind, 'fence-check');
  assert.equal(events[1].commandId, id(5));
  assert.equal(events[1].headers, undefined);
  assert.equal((await fs.stat(join(directory, receipt.faultId + '.jsonl'))).mode & 0o777, 0o600);
});

test('per-role rings evict explicitly and individual oversized events are dropped', async t => {
  const { diagnostics, directory } = await fixture(t, { budgets: { maxRoleBytes: 1400, maxEventsPerRole: 3, maxEventBytes: 600 } });
  for (let index = 0; index < 20; index++) diagnostics.recordSpan(span({ elapsedMs: index }));
  const status = diagnostics.status();
  assert.ok(status.roles[0].bytes <= 1400); assert.ok(status.roles[0].events <= 3); assert.ok(status.counters.evicted >= 17);
  const result = await diagnostics.captureFault(fault(11));
  const records = await readPack(directory, result.faultId);
  assert.ok(records[0].counters.evicted >= 17);
  assert.equal(records.at(-2).elapsedMs, 19);
});

test('fault byte cap truncates honestly without replacing prior immutable bytes or creating a second automatic pack', async t => {
  const { diagnostics, directory } = await fixture(t, { budgets: { maxFaultBytes: 1800 } });
  for (let index = 0; index < 30; index++) diagnostics.recordSpan(span({ elapsedMs: index }));
  const first = await diagnostics.captureFault(fault(12));
  assert.equal(first.state, 'persisted'); assert.equal(first.truncated, true); assert.ok(first.bytes <= 1800);
  const second = await diagnostics.captureFault({ ...fault(13), attemptId: fault(12).attemptId });
  assert.equal(second.faultId, first.faultId); assert.equal(second.digest, first.digest);
  assert.equal((await fs.readdir(directory)).length, 1);
  assert.equal((await diagnostics.lookupFault(first.faultId)).digest, first.digest);
});

test('cumulative bytes, file count, free-space reservation and write rate independently reject extra diagnostics', async t => {
  const one = await fixture(t, { budgets: { maxFiles: 1 } });
  assert.equal((await one.diagnostics.captureFault(fault(20))).state, 'persisted');
  assert.equal((await one.diagnostics.captureFault(fault(21))).reason, 'DIAGNOSTIC_QUOTA');
  const bytes = await fixture(t, { budgets: { maxInstanceBytes: 1100 } });
  assert.equal((await bytes.diagnostics.captureFault(fault(22))).state, 'persisted');
  assert.equal((await bytes.diagnostics.captureFault(fault(23))).reason, 'DIAGNOSTIC_QUOTA');
  const free = await fixture(t, { io: { statfs: async () => ({ bavail: 0, bsize: 4096 }) } });
  assert.equal((await free.diagnostics.captureFault(fault(24))).reason, 'DIAGNOSTIC_QUOTA');
  const rate = await fixture(t, { budgets: { maxWriteBytesPerSecond: 1100 }, monotonicClock: () => 1 });
  assert.equal((await rate.diagnostics.captureFault(fault(25))).state, 'persisted');
  assert.equal((await rate.diagnostics.captureFault(fault(26))).reason, 'DIAGNOSTIC_QUOTA');
});

test('receipt references survive retention and restart; ordinary GC only removes unreferenced complete packs', async t => {
  let wall = Date.parse('2026-10-20T00:00:00Z'), mono = 1000;
  const { diagnostics, directory } = await fixture(t, { wallClock: () => wall, monotonicClock: () => mono });
  const referenced = await diagnostics.captureFault({ ...fault(30), receiptIds: [id(300)] });
  const pinned = await diagnostics.captureFault(fault(31));
  assert.equal((await diagnostics.pinReceipt(pinned.faultId, id(301))).state, 'persisted');
  const ordinary = await diagnostics.captureFault(fault(32));
  diagnostics.close();
  const reopened = await createControlDiagnostics({ directory, instanceId: 'test-instance', budgets: { minFreeBytes: 0 }, wallClock: () => wall, monotonicClock: () => mono });
  t.after(() => reopened.close());
  wall += 8 * 24 * 60 * 60 * 1000; mono += 8 * 24 * 60 * 60 * 1000;
  assert.deepEqual(await reopened.collectGarbage(), { state: 'collected', removed: 1 });
  assert.equal((await reopened.lookupFault(referenced.faultId)).state, 'persisted');
  assert.equal((await reopened.lookupFault(pinned.faultId)).state, 'persisted');
  assert.equal((await reopened.lookupFault(ordinary.faultId)).state, 'missing');
});

test('a slow submitted fsync returns unknown, retains a single I/O slot and reconciles the same faultId after ACK loss', async t => {
  const held = gate(); let writing = 0;
  const { diagnostics, directory } = await fixture(t, { budgets: { ioDeadlineMs: 25, maxQueue: 2 }, io: {
    open: async (path, flags, mode) => {
      const handle = await fs.open(path, flags, mode);
      if (flags !== 'wx' || !path.endsWith('.jsonl')) return handle;
      writing++;
      return { writeFile: (...args) => handle.writeFile(...args), close: () => handle.close(), sync: async () => { await handle.sync(); await held.promise; } };
    },
  } });
  const unknown = await diagnostics.captureFault(fault(40));
  assert.equal(unknown.state, 'unknown'); assert.equal(unknown.faultId, fault(40).faultId);
  assert.equal(diagnostics.status().ioInFlight, true);
  const overflow = await Promise.all(Array.from({ length: 10 }, (_, index) => diagnostics.captureFault(fault(41 + index))));
  assert.ok(overflow.every(row => row.state === 'dropped'));
  assert.ok(overflow.some(row => row.reason === 'DIAGNOSTIC_BACKPRESSURE'));
  assert.ok(diagnostics.status().queued <= 2); assert.equal(writing, 1);
  held.release();
  for (let index = 0; index < 50 && diagnostics.status().ioInFlight; index++) await wait(2);
  const actual = await diagnostics.lookupFault(fault(40).faultId);
  assert.equal(actual.state, 'persisted'); assert.equal(actual.faultId, fault(40).faultId); assert.equal(writing, 1);
  assert.equal((await fs.readdir(directory)).filter(name => name.endsWith('.jsonl')).length, 1);
});

test('disk-full failure has no automatic retry, no raw error leakage, and does not disable in-memory spans', async t => {
  let attempts = 0;
  const { diagnostics } = await fixture(t, { io: { open: async (path, flags, mode) => {
    if (flags === 'wx') { attempts++; throw Object.assign(new Error('secret disk path and token'), { code: 'ENOSPC' }); }
    return fs.open(path, flags, mode);
  } } });
  const result = await diagnostics.captureFault(fault(60));
  assert.equal(result.state, 'unknown'); assert.equal(result.reason, 'DIAGNOSTIC_IO_FAILED');
  await wait(30); assert.equal(attempts, 1);
  assert.equal(diagnostics.recordSpan(span()), true);
  assert.equal(diagnostics.status().reservedBytes, 0);
});

test('uncooperative sample provider times out once and cannot create overlapping provider calls', async t => {
  const held = gate(); let calls = 0;
  const { diagnostics } = await fixture(t, { budgets: { sampleDeadlineMs: 15 }, sampleProvider: async () => { calls++; await held.promise; return []; } });
  const first = await diagnostics.sampleOnce(); assert.equal(first.state, 'unknown');
  const results = await Promise.all(Array.from({ length: 20 }, () => diagnostics.sampleOnce()));
  assert.ok(results.every(row => row.reason === 'DIAGNOSTIC_SAMPLE_BUSY'));
  assert.equal(calls, 1); assert.equal(diagnostics.status().counters.sampleTimeouts, 1);
  held.release(); await wait(2);
  assert.equal((await diagnostics.sampleOnce()).state, 'sampled');
});

test('provider exit opens a finite failure circuit rather than retrying forever', async t => {
  let calls = 0;
  const { diagnostics } = await fixture(t, { sampleProvider: async () => { calls++; throw new Error('private provider failure'); } });
  for (let index = 0; index < 3; index++) assert.equal((await diagnostics.sampleOnce()).state, 'unknown');
  assert.equal((await diagnostics.sampleOnce()).reason, 'DIAGNOSTIC_SAMPLE_CIRCUIT_OPEN');
  assert.equal(calls, 3); assert.equal(diagnostics.status().sampleCircuitOpen, true);
});

test('20 actual targets explicitly record four unsampled targets under the frozen 16-target budget', async t => {
  const { diagnostics, directory } = await fixture(t, { sampleProvider: async () => Array.from({ length: 20 }, (_, index) => ({ role: 'api', state: 'alive', startIdentity: 'pid:' + index, rssBytes: 100 + index, env: 'secret' })) });
  const result = await diagnostics.sampleOnce();
  assert.equal(result.state, 'sampled'); assert.equal(result.recorded, 16); assert.equal(result.droppedTargets, 4);
  const receipt = await diagnostics.captureFault(fault(70));
  const records = await readPack(directory, receipt.faultId);
  assert.equal(records[0].counters.droppedTargets, 4);
  assert.ok(records.some(row => row.code === 'DIAGNOSTIC_TARGET_QUOTA' && row.rows === 4));
});

test('a real target child dying retains its pre-fault window and records dead without invented metrics', async t => {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { if (child.exitCode === null && !child.killed) child.kill('SIGTERM'); });
  await once(child.stdout, 'data');
  const execute = promisify(execFile);
  const { diagnostics, directory } = await fixture(t, { sampleProvider: async ({ signal }) => {
    if (child.exitCode !== null || child.signalCode !== null) return [{ role: 'coordinator', startIdentity: 'pid:' + child.pid, state: 'dead', rssBytes: 0 }];
    const { stdout } = await execute('/bin/ps', ['-o', 'rss=', '-p', String(child.pid)], { signal });
    return [{ role: 'coordinator', startIdentity: 'pid:' + child.pid, state: 'alive', rssBytes: Number(stdout.trim()) * 1024 }];
  } });
  assert.equal((await diagnostics.sampleOnce()).state, 'sampled');
  child.kill('SIGTERM'); await once(child, 'exit');
  assert.equal((await diagnostics.sampleOnce()).state, 'sampled');
  const receipt = await diagnostics.captureFault(fault(71));
  const records = (await readPack(directory, receipt.faultId)).filter(row => row.kind === 'sample');
  assert.ok(records.some(row => row.state === 'alive' && row.rssBytes > 0));
  const dead = records.find(row => row.state === 'dead'); assert.ok(dead); assert.equal(dead.rssBytes, undefined);
});

test('wall-clock jumps do not alter caller monotonic durations or trigger unsafe retention cleanup', async t => {
  let wall = Date.parse('2026-10-20T00:00:00Z'), mono = 1000;
  const { diagnostics, directory } = await fixture(t, { wallClock: () => wall, monotonicClock: () => mono });
  diagnostics.recordSpan(span());
  wall += 30 * 24 * 60 * 60 * 1000; mono += 10;
  diagnostics.recordSpan(span({ elapsedMs: 9 }));
  const receipt = await diagnostics.captureFault(fault(80));
  const records = await readPack(directory, receipt.faultId);
  assert.equal(records[1].elapsedMs, 12.5); assert.equal(records[2].elapsedMs, 9);
  assert.ok(diagnostics.status().counters.clockJumps >= 1);
  assert.equal((await diagnostics.collectGarbage()).reason, 'DIAGNOSTIC_CLOCK_UNCERTAIN');
});

test('symlinked directories and corrupt fault bytes are never accepted as a persisted receipt', async t => {
  const { diagnostics, directory } = await fixture(t);
  const receipt = await diagnostics.captureFault(fault(90));
  const path = join(directory, receipt.faultId + '.jsonl');
  const content = await fs.readFile(path, 'utf8');
  await fs.writeFile(path, content.replace('UPGRADE_RPC_TIMEOUT', 'UPGRADE_RPC_UNKNOWN'), { mode: 0o600 });
  assert.equal((await diagnostics.lookupFault(receipt.faultId)).reason, 'DIAGNOSTIC_DIGEST_MISMATCH');
  const link = directory + '-symlink'; await fs.symlink(directory, link); t.after(() => fs.rm(link, { force: true }));
  const unsafe = await createControlDiagnostics({ directory: link, instanceId: 'test-instance' }); t.after(() => unsafe.close());
  assert.equal(unsafe.status().initialized, false);
  assert.equal(unsafe.status().initializationReason, 'DIAGNOSTIC_DIRECTORY_UNSAFE');
});

test('a bounded scheduler uses the active and idle intervals and close stops new work', async t => {
  let calls = 0, active = true;
  const { diagnostics } = await fixture(t, { budgets: { activeIntervalMs: 10, idleIntervalMs: 60 }, isActive: () => active, sampleProvider: async () => { calls++; return []; } });
  diagnostics.startSampling(); await wait(35); assert.ok(calls >= 2);
  active = false; await wait(20); const beforeIdle = calls;
  await wait(25); assert.equal(calls, beforeIdle);
  diagnostics.close(); await wait(65); assert.equal(calls, beforeIdle);
  assert.equal(diagnostics.recordSpan(span()), false);
});
