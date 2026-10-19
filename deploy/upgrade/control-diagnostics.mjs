import * as filesystem from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const MiB = 1024 * 1024;
export const CONTROL_DIAGNOSTIC_BUDGETS = Object.freeze({
  maxRoleBytes: MiB, maxFaultBytes: 8 * MiB, maxInstanceBytes: 64 * MiB,
  maxFiles: 32, retentionMs: 7 * 24 * 60 * 60 * 1000, maxRoles: 16,
  maxEventsPerRole: 2048, maxEventBytes: 2048, maxQueue: 128, maxQueuedBytes: 256 * 1024,
  activeIntervalMs: 1000, idleIntervalMs: 10000, sampleDeadlineMs: 100,
  ioDeadlineMs: 250, maxProcessingMs: 5, maxSampleCpuMicros: 5000,
  maxWriteBytesPerSecond: 8 * MiB, minFreeBytes: 256 * MiB,
  maxConsecutiveSampleFailures: 3,
});
const ROLES = new Set(['control', 'control-agent', 'entry', 'stable-entry', 'supervisor', 'foundation-supervisor', 'installer', 'coordinator', 'state-coordinator', 'api', 'web', 'owner', 'runtime-owner', 'runtime', 'verification', 'observer', 'worker', 'system', 'unknown']);
const PHASES = new Set(['accepted', 'created', 'reconciling', 'restoring', 'verifying', 'recovered', 'blocked', 'artifact-verify', 'spawn', 'prepared-warm', 'prepared-ready', 'source-baseline', 'quiesce', 'release', 'adopt', 'route', 'observe', 'recover', 'activate', 'activation', 'confirmed', 'lease-renew', 'fence-check', 'progress-checkpoint', 'event-commit', 'control-read', 'snapshot', 'status', 'observation', 'prepared-probe', 'handoff', 'prepare', 'ready', 'migration', 'cleanup', 'capacity', 'sample', 'diagnostics', 'authentication', 'serialize', 'queue', 'sqlite', 'owner-rpc', 'worker']);
const REQUEST_KINDS = new Set(['lease-renew', 'fence-check', 'progress-checkpoint', 'event-commit', 'control-read', 'snapshot', 'status', 'observation', 'prepared-probe', 'handoff-prepare', 'handoff-quiesce', 'handoff-release', 'handoff-adopt', 'route-cas', 'recovery-eligibility', 'recovery-execute', 'recovery-confirm']);
const OUTCOMES = new Set(['ok', 'failed', 'timeout', 'aborted', 'unknown', 'rejected', 'dropped']);
const METRICS = ['rssBytes', 'heapUsedBytes', 'externalBytes', 'cpuUserMicros', 'cpuSystemMicros', 'eventLoopDelayMs', 'gcPauseMs', 'cgroupMemoryBytes', 'cgroupMemoryPeakBytes', 'cgroupCpuThrottledMicros', 'cgroupOomCount', 'vmMemAvailableBytes', 'memoryPsiAvg10', 'ioPsiAvg10', 'readBytes', 'writeBytes', 'fdCount', 'dbBytes', 'walBytes', 'probeRequests', 'probeErrors'];
const TIMINGS = ['elapsedMs', 'timeoutMs', 'bindingMs', 'serializationMs', 'firstResponseMs', 'decodeMs', 'queueMs', 'sqliteMs', 'ownerRpcMs', 'workerMs', 'remainingMs'];
const COUNTERS = ['requestBytes', 'responseBytes', 'rows', 'controlEpoch', 'generation', 'fence', 'businessGeneration', 'businessFence', 'routeGeneration'];
const IDENTIFIERS = ['traceId', 'spanId', 'parentSpanId', 'operationId', 'attemptId', 'recoveryId', 'commandId', 'stepId', 'executorId', 'specDigest', 'startIdentity'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^sha256:[a-f0-9]{64}$/;
const FAULT = /^(?:fault-)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$|^fault-[a-f0-9]{32}$/i;
const FILE = /^((?:fault-)?[a-f0-9-]{32,42})\.jsonl$/i;
const CODE = /^[A-Z][A-Z0-9_]{0,99}$/;
const own = (value, key) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
// Unknown bounded identifiers remain correlatable without persisting arbitrary
// strings accidentally put in identity fields. No input toJSON/getter is called.
function identifier(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.length || value.length > 200) return undefined;
  return UUID.test(value) || HASH.test(value) || /^[a-f0-9]{16}$|^[a-f0-9]{32}$/i.test(value) ? value : hash(value);
}
function sanitize(input, kind) {
  const role = own(input, 'role');
  if (!ROLES.has(role)) return null;
  const out = { kind, role };
  for (const key of IDENTIFIERS) {
    const value = identifier(own(input, key));
    if (value !== undefined) out[key] = value;
  }
  const phase = own(input, 'phase');
  if (PHASES.has(phase)) out.phase = phase;
  const requestKind = own(input, 'requestKind');
  if (REQUEST_KINDS.has(requestKind)) out.requestKind = requestKind;
  const outcome = own(input, 'outcome');
  if (OUTCOMES.has(outcome)) out.outcome = outcome;
  const code = own(input, 'code');
  if (typeof code === 'string' && CODE.test(code)) out.code = code;
  for (const key of [...TIMINGS, ...COUNTERS, ...(kind === 'sample' ? METRICS : [])]) {
    const value = own(input, key);
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) out[key] = value;
  }
  if (kind === 'sample') {
    const state = own(input, 'state');
    out.state = ['alive', 'dead', 'blocked', 'unknown'].includes(state) ? state : 'unknown';
    // A dead/unknown target never gains invented zero-valued process readings.
    if (out.state !== 'alive') for (const key of METRICS) delete out[key];
  }
  return out;
}
function faultInput(input, instanceId) {
  const attemptId = identifier(own(input, 'attemptId'));
  const recoveryId = identifier(own(input, 'recoveryId'));
  const operationId = identifier(own(input, 'operationId'));
  const scope = attemptId ?? recoveryId ?? operationId;
  if (!scope) return null;
  const supplied = own(input, 'faultId');
  const faultId = supplied === undefined ? 'fault-' + hash(instanceId + ':' + scope).slice(7, 39) : supplied;
  if (typeof faultId !== 'string' || !FAULT.test(faultId)) return null;
  const phase = own(input, 'phase'), code = own(input, 'code');
  if (!PHASES.has(phase) || typeof code !== 'string' || !CODE.test(code)) return null;
  const receiptIds = own(input, 'receiptIds');
  if (receiptIds !== undefined && (!Array.isArray(receiptIds) || receiptIds.length > 32)) return null;
  const receipts = (receiptIds ?? []).map(identifier);
  if (receipts.some(value => !value)) return null;
  return { faultId, scope, attemptId: attemptId ?? null, recoveryId: recoveryId ?? null, operationId: operationId ?? null, phase, code, receiptIds: [...new Set(receipts)] };
}
function boundedBudgets(input) {
  const result = { ...CONTROL_DIAGNOSTIC_BUDGETS };
  for (const key of Object.keys(result)) {
    if (input[key] === undefined) continue;
    if (!Number.isSafeInteger(input[key]) || input[key] < (key === 'minFreeBytes' ? 0 : 1)) throw new Error('DIAGNOSTIC_BUDGET_INVALID');
    result[key] = input[key];
  }
  if (result.maxRoleBytes > MiB || result.maxFaultBytes > 8 * MiB || result.maxInstanceBytes > 1024 * MiB || result.maxRoles > 128 || result.maxQueue > 128 || result.maxEventBytes > 8192 || result.maxFiles > 1024 || result.maxEventsPerRole > 8192) throw new Error('DIAGNOSTIC_BUDGET_INVALID');
  return Object.freeze(result);
}

/**
 * Diagnostic state is not an execution journal or readiness proof. The injected
 * provider must be a bounded/cancellable Supervisor read, outside business PID
 * namespaces; a synchronous arbitrary provider cannot be preempted by JS.
 * Persist returned faultId in the authority journal. After diagnostic retention,
 * callers reconcile that identity rather than requesting another automatic pack.
 */
export async function createControlDiagnostics({ directory, instanceId, sampleProvider, isActive = () => false, budgets = {}, wallClock = Date.now, monotonicClock = () => performance.now(), io = {} }) {
  if (typeof directory !== 'string' || !directory || typeof instanceId !== 'string' || instanceId.length > 200) throw new Error('DIAGNOSTIC_CONFIG_INVALID');
  const root = resolve(directory), limits = boundedBudgets(budgets), fs = { ...filesystem, ...io };
  const rings = new Map(), inventory = new Map(), scopes = new Map(), protectedFaults = new Set();
  const counters = { recorded: 0, evicted: 0, dropped: 0, droppedTargets: 0, invalid: 0, sampleTimeouts: 0, sampleErrors: 0, sampleBusy: 0, ioTimeouts: 0, ioErrors: 0, quotaDrops: 0, clockJumps: 0, cpuDrops: 0 };
  let initialized = false, initializationReason = null, closed = false, sampling = false, sampleInFlight = null, sampleTimer = null;
  let sampleFailureStreak = 0;
  let running = null, queuedBytes = 0, reservedBytes = 0, reservedFiles = 0, writeWindow = monotonicClock(), writeBytes = 0;
  let lastWall = wallClock(), lastMono = monotonicClock(), clockUncertain = false;
  const jobs = [];
  function stamp() {
    const wall = wallClock(), mono = monotonicClock();
    if (Number.isFinite(wall) && Number.isFinite(lastWall) && Number.isFinite(mono) && Number.isFinite(lastMono) && Math.abs((wall - lastWall) - (mono - lastMono)) > 5000) {
      counters.clockJumps++; clockUncertain = true;
    }
    lastWall = wall; lastMono = mono;
    return { recordedAt: Number.isFinite(wall) && Math.abs(wall) <= 8.64e15 ? new Date(wall).toISOString() : null, monotonicMs: Number.isFinite(mono) && mono >= 0 ? mono : null };
  }
  function dropped(reason, faultId = null, unknown = false) {
    counters.dropped++;
    return { state: unknown ? 'unknown' : 'dropped', faultId, reason };
  }
  function push(input, kind) {
    if (closed) return false;
    let event;
    try { event = sanitize(input, kind); } catch { event = null; }
    if (!event) { counters.invalid++; counters.dropped++; return false; }
    Object.assign(event, stamp());
    const line = JSON.stringify(event) + '\n', bytes = Buffer.byteLength(line);
    if (bytes > limits.maxEventBytes || bytes > limits.maxRoleBytes) { counters.dropped++; return false; }
    let ring = rings.get(event.role);
    if (!ring) {
      if (rings.size >= limits.maxRoles) { counters.dropped++; return false; }
      ring = { records: new Map(), bytes: 0, sequence: 0 }; rings.set(event.role, ring);
    }
    while (ring.bytes + bytes > limits.maxRoleBytes || ring.records.size >= limits.maxEventsPerRole) {
      const [key, first] = ring.records.entries().next().value;
      ring.records.delete(key); ring.bytes -= first.bytes; counters.evicted++;
    }
    ring.records.set(++ring.sequence, { line, bytes }); ring.bytes += bytes; counters.recorded++;
    return true;
  }
  function status() {
    return {
      initialized, initializationReason, closed, sampling, sampleInFlight: sampleInFlight !== null,
      clockUncertain, limits, counters: { ...counters }, queued: jobs.length, queuedBytes,
      sampleFailureStreak, sampleCircuitOpen: sampleFailureStreak >= limits.maxConsecutiveSampleFailures,
      ioInFlight: running !== null, reservedBytes, reservedFiles,
      usedBytes: [...inventory.values()].reduce((sum, row) => sum + row.bytes, 0), files: inventory.size,
      roles: [...rings].map(([role, ring]) => ({ role, bytes: ring.bytes, events: ring.records.size })),
    };
  }
  function enqueue(run, inputBytes = 0, faultId = null) {
    if (closed || !initialized) return Promise.resolve(dropped(closed ? 'DIAGNOSTICS_CLOSED' : initializationReason ?? 'DIAGNOSTICS_UNAVAILABLE', faultId));
    if (jobs.length >= limits.maxQueue || queuedBytes + inputBytes > limits.maxQueuedBytes) return Promise.resolve(dropped('DIAGNOSTIC_BACKPRESSURE', faultId));
    return new Promise(accept => {
      const job = { run, inputBytes, faultId, accept, started: false, expired: false, settled: false, abort: new AbortController() };
      queuedBytes += inputBytes; jobs.push(job);
      job.timer = setTimeout(() => {
        job.expired = true; job.abort.abort(); counters.ioTimeouts++;
        if (!job.settled) { job.settled = true; accept(dropped('DIAGNOSTIC_IO_DEADLINE', faultId, job.started)); }
      }, limits.ioDeadlineMs);
      pump();
    });
  }
  function pump() {
    if (running) return;
    while (jobs.length) {
      const job = jobs.shift(); queuedBytes -= job.inputBytes;
      if (job.expired || closed) { clearTimeout(job.timer); if (!job.settled) { job.settled = true; job.accept(dropped('DIAGNOSTIC_QUEUE_EXPIRED', job.faultId)); } continue; }
      running = job; job.started = true;
      Promise.resolve().then(() => job.run(job.abort.signal)).then(result => {
        if (!job.settled) { job.settled = true; job.accept(result); }
      }, () => {
        counters.ioErrors++;
        if (!job.settled) { job.settled = true; job.accept(dropped('DIAGNOSTIC_IO_FAILED', job.faultId, true)); }
      }).finally(() => { clearTimeout(job.timer); running = null; pump(); });
      return;
    }
  }
  function check(signal) { if (signal.aborted || closed) throw new Error('DIAGNOSTIC_CANCELLED'); }
  async function inspect(name, signal, includeDigest = false) {
    check(signal);
    const file = join(root, name), info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limits.maxFaultBytes || (info.mode & 0o077) !== 0) return { state: 'unknown', faultId: name.replace(/\.jsonl$/, ''), reason: 'DIAGNOSTIC_FILE_UNSAFE' };
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const head = Buffer.alloc(Math.min(info.size, 16384)), tail = Buffer.alloc(Math.min(info.size, 4096));
      await handle.read(head, 0, head.length, 0); check(signal);
      await handle.read(tail, 0, tail.length, info.size - tail.length); check(signal);
      const newline = head.indexOf(10), end = tail.length - 1, footerStart = tail.lastIndexOf(10, end - 1) + 1;
      if (newline < 0 || tail[end] !== 10) return { state: 'unknown', reason: 'DIAGNOSTIC_INCOMPLETE' };
      let header, footer;
      try { header = JSON.parse(head.subarray(0, newline).toString()); footer = JSON.parse(tail.subarray(footerStart, end).toString()); } catch { return { state: 'unknown', reason: 'DIAGNOSTIC_INCOMPLETE' }; }
      if (header.kind !== 'control-diagnostic-fault' || header.schemaVersion !== 1 || header.instanceId !== identifier(instanceId) || !FAULT.test(header.faultId) || name !== header.faultId + '.jsonl' || footer.kind !== 'end' || !HASH.test(footer.contentDigest) || !Array.isArray(header.receiptIds) || header.receiptIds.length > 32 || header.receiptIds.some(value => identifier(value) !== value)) return { state: 'unknown', reason: 'DIAGNOSTIC_INCOMPLETE' };
      if (!includeDigest) return { state: 'persisted', faultId: header.faultId, header, bytes: info.size };
      const full = createHash('sha256'), prefix = createHash('sha256'), prefixBytes = info.size - tail.length + footerStart;
      const buffer = Buffer.alloc(65536); let offset = 0;
      while (offset < info.size) {
        check(signal); const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - offset), offset);
        if (!bytesRead) return { state: 'unknown', reason: 'DIAGNOSTIC_INCOMPLETE' };
        full.update(buffer.subarray(0, bytesRead));
        if (offset < prefixBytes) prefix.update(buffer.subarray(0, Math.min(bytesRead, prefixBytes - offset)));
        offset += bytesRead;
      }
      if ('sha256:' + prefix.digest('hex') !== footer.contentDigest) return { state: 'unknown', reason: 'DIAGNOSTIC_DIGEST_MISMATCH' };
      check(signal); await handle.sync();
      const dir = await fs.open(root, 'r'); try { await dir.sync(); } finally { await dir.close(); }
      check(signal);
      return { state: 'persisted', faultId: header.faultId, diagnosticId: header.faultId, recordedAt: header.recordedAt, digest: 'sha256:' + full.digest('hex'), bytes: info.size, truncated: footer.truncated === true, dropped: header.counters?.dropped ?? null };
    } finally { await handle.close(); }
  }
  async function refresh(signal) {
    const names = await fs.readdir(root); check(signal);
    inventory.clear(); scopes.clear();
    // The dedicated directory itself is quota-bounded. Foreign entries are
    // counted and never deleted; overflowing inventory disables further writes.
    if (names.length > limits.maxFiles) { initializationReason = 'DIAGNOSTIC_DIRECTORY_OVER_QUOTA'; }
    for (const name of names.slice(0, limits.maxFiles + 1)) {
      check(signal); const info = await fs.lstat(join(root, name));
      inventory.set(name, { bytes: info.size, known: false });
      const pin = name.match(/^(.*)\.pin(?:\.|$)/); if (pin && FAULT.test(pin[1])) protectedFaults.add(pin[1]);
      if (!FILE.test(name)) continue;
      const row = await inspect(name, signal);
      if (row.state === 'persisted') {
        inventory.set(name, { bytes: info.size, known: true, header: row.header });
        scopes.set(row.header.scope, row.faultId);
        if (row.header.receiptIds.length) protectedFaults.add(row.faultId);
      }
    }
  }
  async function measureUsage(signal) {
    const names = await fs.readdir(root); check(signal);
    if (names.length > limits.maxFiles) return { files: names.length, bytes: Infinity };
    let bytes = 0;
    for (const name of names) {
      check(signal); const info = await fs.lstat(join(root, name)); bytes += info.size;
      const previous = inventory.get(name);
      inventory.set(name, { ...previous, bytes: info.size, known: previous?.known === true });
      const pin = name.match(/^(.*)\.pin(?:\.|$)/);
      if (pin && FAULT.test(pin[1])) protectedFaults.add(pin[1]);
    }
    for (const name of inventory.keys()) if (!names.includes(name)) inventory.delete(name);
    return { files: names.length, bytes };
  }
  async function init() {
    const signal = AbortSignal.timeout(limits.ioDeadlineMs);
    let timer;
    const initialization = (async () => {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const info = await fs.lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('DIAGNOSTIC_DIRECTORY_UNSAFE');
      await refresh(signal); initialized = !signal.aborted;
    })();
    try {
      await Promise.race([initialization, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DIAGNOSTIC_INIT_DEADLINE')), limits.ioDeadlineMs); })]);
    } catch (error) { initializationReason = error?.message === 'DIAGNOSTIC_DIRECTORY_UNSAFE' ? error.message : 'DIAGNOSTIC_INITIALIZATION_FAILED'; }
    finally { clearTimeout(timer); }
    initialization.catch(() => {});
  }
  await init();
  async function sampleOnce() {
    if (closed || typeof sampleProvider !== 'function') return { state: 'dropped', reason: 'DIAGNOSTIC_SAMPLE_UNAVAILABLE' };
    if (sampleInFlight) { counters.sampleBusy++; counters.dropped++; return { state: 'dropped', reason: 'DIAGNOSTIC_SAMPLE_BUSY' }; }
    if (sampleFailureStreak >= limits.maxConsecutiveSampleFailures) return dropped('DIAGNOSTIC_SAMPLE_CIRCUIT_OPEN');
    const controller = new AbortController(), start = monotonicClock(), cpu = process.cpuUsage(); let timer;
    const task = Promise.resolve().then(() => sampleProvider({ signal: controller.signal, maxTargets: limits.maxRoles, cpuBudgetMicros: limits.maxSampleCpuMicros }));
    sampleInFlight = task;
    task.then(() => { if (sampleInFlight === task) sampleInFlight = null; }, () => { if (sampleInFlight === task) sampleInFlight = null; });
    try {
      const rows = await Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('DIAGNOSTIC_SAMPLE_DEADLINE')); }, limits.sampleDeadlineMs); })]);
      if (!Array.isArray(rows)) throw new Error('DIAGNOSTIC_SAMPLE_INVALID');
      const spent = process.cpuUsage(cpu);
      if (spent.user + spent.system > limits.maxSampleCpuMicros || monotonicClock() - start > limits.sampleDeadlineMs) { counters.cpuDrops++; counters.dropped++; sampleFailureStreak++; return { state: 'dropped', reason: 'DIAGNOSTIC_SAMPLE_BUDGET' }; }
      sampleFailureStreak = 0;
      const omitted = Math.max(0, rows.length - limits.maxRoles);
      counters.droppedTargets += omitted; counters.dropped += omitted;
      let recorded = 0;
      for (let index = 0; index < Math.min(rows.length, limits.maxRoles); index++) if (push(rows[index], 'sample')) recorded++;
      if (omitted) push({ role: 'observer', phase: 'sample', code: 'DIAGNOSTIC_TARGET_QUOTA', outcome: 'dropped', rows: omitted }, 'span');
      return { state: 'sampled', recorded, droppedTargets: omitted, elapsedMs: Math.max(0, monotonicClock() - start) };
    } catch (error) {
      sampleFailureStreak++;
      if (error?.message === 'DIAGNOSTIC_SAMPLE_DEADLINE') counters.sampleTimeouts++; else counters.sampleErrors++;
      counters.dropped++;
      push({ role: 'observer', phase: 'sample', code: error?.message === 'DIAGNOSTIC_SAMPLE_DEADLINE' ? 'DIAGNOSTIC_SAMPLE_TIMEOUT' : 'DIAGNOSTIC_SAMPLE_FAILED', outcome: 'unknown' }, 'span');
      return { state: 'unknown', reason: error?.message === 'DIAGNOSTIC_SAMPLE_DEADLINE' ? 'DIAGNOSTIC_SAMPLE_DEADLINE' : 'DIAGNOSTIC_SAMPLE_FAILED' };
    } finally { clearTimeout(timer); }
  }
  function schedule() {
    if (!sampling || closed) return;
    if (sampleFailureStreak >= limits.maxConsecutiveSampleFailures) { stopSampling(); return; }
    let active = false; try { active = isActive() === true; } catch { counters.invalid++; }
    sampleTimer = setTimeout(() => { void sampleOnce().finally(schedule); }, active ? limits.activeIntervalMs : limits.idleIntervalMs);
    sampleTimer.unref?.();
  }
  function startSampling() { if (sampling || closed) return; sampleFailureStreak = 0; sampling = true; void sampleOnce().finally(schedule); }
  function stopSampling() { sampling = false; clearTimeout(sampleTimer); sampleTimer = null; }
  function lookupFault(faultId) {
    if (typeof faultId !== 'string' || !FAULT.test(faultId)) return Promise.resolve(dropped('DIAGNOSTIC_FAULT_ID_INVALID'));
    return enqueue(async signal => {
      try { return await inspect(faultId + '.jsonl', signal, true); }
      catch (error) { if (error?.code === 'ENOENT') return { state: 'missing', faultId }; throw error; }
    }, 200, faultId);
  }
  function captureFault(input) {
    let facts;
    try { facts = faultInput(input, instanceId); } catch { facts = null; }
    if (!facts) return Promise.resolve(dropped('DIAGNOSTIC_FAULT_INVALID'));
    return enqueue(async signal => {
      check(signal);
      if (scopes.has(facts.scope)) return inspect(scopes.get(facts.scope) + '.jsonl', signal, true);
      try { const existing = await inspect(facts.faultId + '.jsonl', signal, true); return existing; }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      const timestamp = stamp();
      if (timestamp.recordedAt === null) return dropped('DIAGNOSTIC_CLOCK_UNKNOWN', facts.faultId);
      const processingStart = monotonicClock();
      const header = { schemaVersion: 1, kind: 'control-diagnostic-fault', instanceId: identifier(instanceId), ...facts, ...timestamp, counters: { ...counters } };
      const lines = [JSON.stringify(header) + '\n']; let bytes = Buffer.byteLength(lines[0]), eventCount = 0, truncated = false;
      for (const ring of rings.values()) {
        for (const row of ring.records.values()) {
          if (bytes + row.bytes + 512 > limits.maxFaultBytes || monotonicClock() - processingStart > limits.maxProcessingMs) { truncated = true; break; }
          lines.push(row.line); bytes += row.bytes; eventCount++;
        }
        if (truncated) break;
      }
      const prefix = createHash('sha256'); for (const line of lines) prefix.update(line);
      lines.push(JSON.stringify({ kind: 'end', eventCount, truncated, contentDigest: 'sha256:' + prefix.digest('hex') }) + '\n');
      bytes += Buffer.byteLength(lines.at(-1));
      if (bytes > limits.maxFaultBytes) return dropped('DIAGNOSTIC_FAULT_TOO_LARGE', facts.faultId);
      const usage = await measureUsage(signal);
      const space = await fs.statfs(root); check(signal);
      const free = Number(space.bavail) * Number(space.bsize);
      const now = monotonicClock(); if (now - writeWindow >= 1000) { writeWindow = now; writeBytes = 0; }
      if (initializationReason === 'DIAGNOSTIC_DIRECTORY_OVER_QUOTA' || usage.files + reservedFiles + 1 > limits.maxFiles || usage.bytes + reservedBytes + bytes > limits.maxInstanceBytes || !Number.isFinite(free) || free - bytes < limits.minFreeBytes || writeBytes + bytes > limits.maxWriteBytesPerSecond) { counters.quotaDrops++; return dropped('DIAGNOSTIC_QUOTA', facts.faultId); }
      reservedBytes += bytes; reservedFiles++; writeBytes += bytes;
      let handle;
      const path = join(root, facts.faultId + '.jsonl');
      try {
        handle = await fs.open(path, 'wx', 0o600);
        // Account partial files too. Unknown I/O never releases its reservation
        // or allows another writer until the actual filesystem call settles.
        inventory.set(facts.faultId + '.jsonl', { bytes, known: false });
        let batch = '', batchBytes = 0;
        for (const line of lines) {
          check(signal); batch += line; batchBytes += Buffer.byteLength(line);
          if (batchBytes >= 65536) { await handle.writeFile(batch, { signal }); batch = ''; batchBytes = 0; }
        }
        if (batch) await handle.writeFile(batch, { signal });
        check(signal); await handle.sync(); await handle.close(); handle = null;
        const dir = await fs.open(root, 'r'); try { await dir.sync(); } finally { await dir.close(); }
        check(signal);
        inventory.set(facts.faultId + '.jsonl', { bytes, known: true, header }); scopes.set(facts.scope, facts.faultId);
        if (facts.receiptIds.length) protectedFaults.add(facts.faultId);
        const full = createHash('sha256'); for (const line of lines) full.update(line);
        return { state: 'persisted', faultId: facts.faultId, diagnosticId: facts.faultId, recordedAt: timestamp.recordedAt, digest: 'sha256:' + full.digest('hex'), bytes, truncated, dropped: counters.dropped };
      } catch (error) {
        if (error?.code === 'EEXIST') return inspect(facts.faultId + '.jsonl', signal, true);
        throw error;
      } finally {
        if (handle) await handle.close().catch(() => {});
        reservedBytes -= bytes; reservedFiles--;
      }
    }, Buffer.byteLength(JSON.stringify(facts)), facts.faultId);
  }
  function pinReceipt(faultId, receiptId) {
    const receipt = identifier(receiptId);
    if (typeof faultId !== 'string' || !FAULT.test(faultId) || !receipt) return Promise.resolve(dropped('DIAGNOSTIC_REFERENCE_INVALID', faultId));
    return enqueue(async signal => {
      const pack = await inspect(faultId + '.jsonl', signal); check(signal);
      if (pack.state !== 'persisted') return { state: 'unknown', faultId, reason: 'DIAGNOSTIC_REFERENCE_UNCONFIRMED' };
      protectedFaults.add(faultId);
      const name = faultId + '.pin.json';
      // Pins are monotonic. One durable pin is enough to protect the immutable
      // fault; the full reference set belongs to the authority journal.
      if (inventory.has(name)) {
        try {
          const pinInfo = await fs.lstat(join(root, name));
          if (!pinInfo.isFile() || pinInfo.isSymbolicLink() || pinInfo.size > 4096 || (pinInfo.mode & 0o077) !== 0) return { state: 'unknown', faultId, reason: 'DIAGNOSTIC_REFERENCE_UNCONFIRMED' };
          const prior = JSON.parse(await fs.readFile(join(root, name), 'utf8'));
          if (prior.faultId !== faultId || !identifier(prior.receiptId)) return { state: 'unknown', faultId, reason: 'DIAGNOSTIC_REFERENCE_UNCONFIRMED' };
          const existing = await fs.open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
          try { await existing.sync(); } finally { await existing.close(); }
          const dir = await fs.open(root, 'r'); try { await dir.sync(); } finally { await dir.close(); }
          check(signal); return { state: 'persisted', faultId };
        } catch { return { state: 'unknown', faultId, reason: 'DIAGNOSTIC_REFERENCE_UNCONFIRMED' }; }
      }
      const data = JSON.stringify({ faultId, receiptId: receipt }) + '\n', bytes = Buffer.byteLength(data);
      const usage = await measureUsage(signal);
      const space = await fs.statfs(root); check(signal);
      const now = monotonicClock(); if (now - writeWindow >= 1000) { writeWindow = now; writeBytes = 0; }
      if (usage.files + 1 > limits.maxFiles || usage.bytes + bytes > limits.maxInstanceBytes || Number(space.bavail) * Number(space.bsize) - bytes < limits.minFreeBytes || writeBytes + bytes > limits.maxWriteBytesPerSecond) return dropped('DIAGNOSTIC_REFERENCE_QUOTA', faultId);
      writeBytes += bytes;
      const handle = await fs.open(join(root, name), 'wx', 0o600);
      inventory.set(name, { bytes, known: false });
      try { await handle.writeFile(data, { signal }); check(signal); await handle.sync(); }
      finally { await handle.close(); }
      const dir = await fs.open(root, 'r'); try { await dir.sync(); } finally { await dir.close(); }
      check(signal); inventory.set(name, { bytes, known: true });
      return { state: 'persisted', faultId };
    }, 400, faultId);
  }
  function collectGarbage() {
    return enqueue(async signal => {
      const timestamp = stamp();
      if (clockUncertain || timestamp.recordedAt === null) return { state: 'blocked', reason: 'DIAGNOSTIC_CLOCK_UNCERTAIN', removed: 0 };
      await refresh(signal); let removed = 0;
      for (const [name, row] of inventory) {
        check(signal);
        if (!row.known || !row.header || protectedFaults.has(row.header.faultId) || row.header.receiptIds.length) continue;
        const age = wallClock() - Date.parse(row.header.recordedAt);
        if (!Number.isFinite(age) || age < limits.retentionMs) continue;
        await fs.unlink(join(root, name)); inventory.delete(name); removed++;
      }
      return { state: 'collected', removed };
    });
  }
  function close() {
    closed = true; stopSampling();
    for (const job of jobs.splice(0)) { clearTimeout(job.timer); queuedBytes -= job.inputBytes; if (!job.settled) { job.settled = true; job.accept(dropped('DIAGNOSTICS_CLOSED', job.faultId)); } }
    // An already submitted filesystem call is reconciled under its original ID.
    running?.abort.abort();
  }
  return { recordSpan: input => push(input, 'span'), sampleOnce, startSampling, stopSampling, captureFault, lookupFault, pinReceipt, collectGarbage, status, close };
}
