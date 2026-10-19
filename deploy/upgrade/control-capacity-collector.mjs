import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { canonical, digest, invariant, DIGEST } from './trust.mjs';
import { atomicJson, secureDirectory } from './io.mjs';
import { parseProcessBirth } from './supervisor-sampler.mjs';
import { freezeCapacityBudget } from './capacity-admission.mjs';

const CID = /^[a-f0-9]{64}$/, DEVICE = /^\d+:\d+$/, ID = /^[a-zA-Z0-9._:-]{1,200}$/;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const positive = n => integer(n) && n > 0;
const physicalKeys = ['containerId', 'pid', 'birthTicks', 'cgroupDigest', 'startedAt', 'restartCount', 'instanceId', 'role', 'startIdentity', 'artifactDigest'];
const physical = row => Object.fromEntries(physicalKeys.map(key => [key, row[key]]));
const own = rows => [...rows].sort((a, b) => a.containerId.localeCompare(b.containerId)).map(physical);

async function boundedFile(path, maximum, signal, privateFile = false) {
  signal?.throwIfAborted();
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (privateFile) invariant(stat.isFile() && (stat.mode & 0o077) === 0 && (!process.getuid || stat.uid === process.getuid()), 'CAPACITY_FILE_INSECURE');
    const bytes = Buffer.alloc(maximum + 1), result = await file.read(bytes, 0, bytes.length, 0);
    signal?.throwIfAborted();
    invariant(result.bytesRead <= maximum, 'CAPACITY_FILE_TOO_LARGE');
    return { text: bytes.subarray(0, result.bytesRead).toString('utf8'), identity: { dev: String(stat.dev), ino: String(stat.ino), mtimeMs: stat.mtimeMs } };
  } finally { await file.close(); }
}

export function parseHostCpu(source) {
  const values = /^cpu\s+(.+)$/m.exec(source)?.[1].trim().split(/\s+/).slice(0, 8).map(Number);
  const cpus = (source.match(/^cpu\d+\s/gm) || []).length;
  invariant(values?.length === 8 && values.every(integer) && cpus > 0, 'CAPACITY_CPU_UNKNOWN');
  const total = values.reduce((sum, n) => sum + n, 0); invariant(integer(total), 'CAPACITY_CPU_UNKNOWN');
  return { total, idle: values[3], cpus };
}
export function parseHostMemory(source) {
  const read = key => { const value = Number(new RegExp('^' + key + ':\\s+(\\d+) kB$', 'm').exec(source)?.[1]) * 1024; invariant(integer(value), 'CAPACITY_MEMORY_UNKNOWN'); return value; };
  const total = read('MemTotal'), free = read('MemFree'), available = read('MemAvailable');
  invariant(total > 0 && free <= total && available <= total && available >= free, 'CAPACITY_MEMORY_UNKNOWN');
  return { total, free, available };
}
export function parseHostDiskstats(source) {
  const result = new Map();
  for (const line of source.trim().split('\n')) {
    const fields = line.trim().split(/\s+/);
    invariant(fields.length >= 14 && fields.slice(0, 2).every(n => /^\d+$/.test(n)), 'CAPACITY_DISKSTATS_UNKNOWN');
    const readBytes = Number(fields[5]) * 512, writeBytes = Number(fields[9]) * 512;
    invariant(integer(readBytes) && integer(writeBytes), 'CAPACITY_DISKSTATS_UNKNOWN');
    const key = fields[0] + ':' + fields[1];
    invariant(!result.has(key), 'CAPACITY_DISKSTATS_UNKNOWN'); result.set(key, { readBytes, writeBytes });
  }
  return result;
}
export function linuxDevice(dev) {
  const value = BigInt(dev), major = ((value >> 8n) & 0xfffn) | ((value >> 32n) & ~0xfffn), minor = (value & 0xffn) | ((value >> 12n) & ~0xffn);
  return major + ':' + minor;
}
function validPhysical(row) {
  return CID.test(row.containerId) && positive(row.pid) && /^\d+$/.test(row.birthTicks) && DIGEST.test(row.cgroupDigest) && Number.isFinite(Date.parse(row.startedAt)) && integer(row.restartCount) &&
    [row.instanceId, row.role, row.startIdentity, row.artifactDigest].every(value => value === null || typeof value === 'string');
}
export function capacityResidentIdentity(containers) {
  invariant(Array.isArray(containers) && containers.length > 0 && containers.every(validPhysical), 'CAPACITY_CONTAINER_IDENTITY_UNKNOWN');
  return digest(own(containers));
}
export function capacityHostIdentity(sample, instanceId) {
  return digest({ vmBootId: sample.vmBootId, proc: sample.procIdentity, devices: sample.devices.map(({ id, dev, majorMinor }) => ({ id, dev, majorMinor })),
    nonInstanceInventory: own(sample.containers.filter(row => row.instanceId !== instanceId)) });
}
function validateConfig(c) {
  invariant(c?.schemaVersion === 1 && ID.test(c.instanceId) && DIGEST.test(c.sourceDigest) && isAbsolute(c.hostProcRoot) && resolve(c.hostProcRoot) === c.hostProcRoot &&
    Array.isArray(c.devices) && c.devices.length > 0 && c.devices.length <= 8 && c.devices.every(row => ID.test(row.id) && isAbsolute(row.path) && /^\d+$/.test(row.dev) && DEVICE.test(row.majorMinor)) &&
    new Set(c.devices.map(row => row.id)).size === c.devices.length && new Set(c.devices.map(row => row.dev)).size === c.devices.length && new Set(c.devices.map(row => row.majorMinor)).size === c.devices.length &&
    Array.isArray(c.residents) && c.residents.length > 0 && c.residents.length <= 128 && c.residents.every(row => ID.test(row.id) && row.id !== 'host-overhead' && Array.isArray(row.containers) && row.containers.length > 0 && row.containers.every(validPhysical)) &&
    new Set(c.residents.map(row => row.id)).size === c.residents.length && positive(c.ioEffectiveBudgetBytesPerSecond) && isAbsolute(c.ioQualificationPath) && DIGEST.test(c.ioQualificationRawDigest) &&
    isAbsolute(c.observationPath) && isAbsolute(c.dockerSocketPath) && integer(c.sampleIntervalMs) && c.sampleIntervalMs >= 250 && c.sampleIntervalMs <= 500 && integer(c.timeoutMs) && c.timeoutMs >= 1000 && c.timeoutMs <= 2000, 'CAPACITY_COLLECTOR_CONFIG_INVALID');
  const containers = c.residents.flatMap(row => row.containers);
  invariant(containers.length <= 128 && containers.every(row => row.instanceId === c.instanceId) && new Set(containers.map(row => row.containerId)).size === containers.length, 'CAPACITY_ACCOUNTING_OVERLAP');
}

// A selected CLI template never requests Config.Env, command arguments, keys or
// business data. Docker stats itself contains only resource counters.
const INSPECT = '{"containerId":{{json .Id}},"pid":{{json .State.Pid}},"startedAt":{{json .State.StartedAt}},"restartCount":{{json .RestartCount}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"instanceId":{{json (index .Config.Labels "agent-platform.instance")}},"role":{{json (index .Config.Labels "agent-platform.role")}},"startIdentity":{{json (index .Config.Labels "agent-platform.start")}},"artifactDigest":{{json (index .Config.Labels "agent-platform.artifact")}}}';
async function selectedInspect(c, ids, signal) {
  if (!ids.length) return [];
  return await new Promise((ok, fail) => {
    const child = spawn(c.dockerCli || 'docker', ['--host', 'unix://' + c.dockerSocketPath, 'inspect', '--format', INSPECT, ...ids], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', bytes = 0;
    const abort = () => { child.kill('SIGKILL'); fail(Object.assign(Error('CAPACITY_DOCKER_INSPECT_TIMEOUT'), { code: 'CAPACITY_DOCKER_INSPECT_TIMEOUT' })); };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 256 * 1024) abort(); else output += chunk; }); child.stderr.resume();
    child.once('error', () => { signal.removeEventListener('abort', abort); fail(Error('CAPACITY_DOCKER_INSPECT_FAILED')); });
    child.once('close', code => { signal.removeEventListener('abort', abort); if (code !== 0) { fail(Error('CAPACITY_DOCKER_INSPECT_FAILED')); return; }
      try { ok(output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))); } catch { fail(Error('CAPACITY_DOCKER_INSPECT_INVALID')); }
    });
    if (signal.aborted) abort();
  });
}
async function dockerJson(socketPath, path, signal) {
  return await new Promise((ok, fail) => {
    const req = http.get({ socketPath, path, signal }, response => {
      let bytes = 0; const chunks = [];
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 512 * 1024) response.destroy(Error('CAPACITY_DOCKER_RESPONSE_TOO_LARGE')); else chunks.push(chunk); });
      response.once('error', fail); response.once('end', () => { try { invariant(response.statusCode === 200, 'CAPACITY_DOCKER_UNAVAILABLE'); ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { fail(error); } });
    }); req.once('error', fail);
  });
}

/** Native Linux collector; never Docker execs a role or enters an Owner/Guest. */
export async function sampleLinuxCapacity(c, { signal, clock = Date.now, monotonic = () => performance.now() } = {}) {
  invariant(process.platform === 'linux' && isAbsolute(c.dockerSocketPath), 'CAPACITY_LINUX_HOST_REQUIRED');
  signal.throwIfAborted(); const startedAt = clock(), startedMono = monotonic();
  invariant(await fs.realpath(c.hostProcRoot) === c.hostProcRoot, 'CAPACITY_PROC_ROOT_INVALID');
  const [procStat, meminfo, diskstats, boot, procStatIdentity, listed] = await Promise.all([
    boundedFile(join(c.hostProcRoot, 'stat'), 65536, signal), boundedFile(join(c.hostProcRoot, 'meminfo'), 65536, signal),
    boundedFile(join(c.hostProcRoot, 'diskstats'), 262144, signal), boundedFile(join(c.hostProcRoot, 'sys/kernel/random/boot_id'), 128, signal), fs.stat(c.hostProcRoot),
    dockerJson(c.dockerSocketPath, '/containers/json?all=false', signal),
  ]);
  invariant(Array.isArray(listed) && listed.length <= 128 && listed.every(row => CID.test(row.Id)), 'CAPACITY_CONTAINER_LIMIT');
  const ids = listed.map(row => row.Id).sort(); invariant(new Set(ids).size === ids.length, 'CAPACITY_CONTAINER_INVENTORY_UNKNOWN');
  const metadata = await selectedInspect(c, ids, signal);
  invariant(metadata.length === ids.length && metadata.every(row => ids.includes(row.containerId) && row.running === true && row.paused === false), 'CAPACITY_CONTAINER_STATE_UNKNOWN');
  const containers = await Promise.all(metadata.map(async row => {
    const home = join(c.hostProcRoot, String(row.pid));
    const [birthBefore, group, stats] = await Promise.all([boundedFile(join(home, 'stat'), 16384, signal), boundedFile(join(home, 'cgroup'), 16384, signal), dockerJson(c.dockerSocketPath, '/containers/' + row.containerId + '/stats?stream=false&one-shot=true', signal)]);
    invariant(group.text.includes(row.containerId) && stats.id === row.containerId && positive(stats.memory_stats?.usage) && integer(stats.cpu_stats?.cpu_usage?.total_usage), 'CAPACITY_CGROUP_COUNTER_UNKNOWN');
    const birthTicks = parseProcessBirth(birthBefore.text), birthAfter = parseProcessBirth((await boundedFile(join(home, 'stat'), 16384, signal)).text);
    invariant(birthTicks === birthAfter, 'CAPACITY_CONTAINER_BIRTH_CHANGED');
    let ioBytes = 0;
    invariant(Array.isArray(stats.blkio_stats?.io_service_bytes_recursive), 'CAPACITY_CGROUP_IO_UNKNOWN');
    for (const counter of stats.blkio_stats.io_service_bytes_recursive) if (['Read', 'Write'].includes(counter.op)) { invariant(integer(counter.value), 'CAPACITY_CGROUP_IO_UNKNOWN'); ioBytes += counter.value; }
    const result = { ...physical({ ...row, birthTicks, cgroupDigest: digest(group.text) }), memoryBytes: stats.memory_stats.usage, cpuNs: stats.cpu_stats.cpu_usage.total_usage, ioBytes, monotonic: monotonic() };
    invariant(validPhysical(result) && integer(ioBytes), 'CAPACITY_CONTAINER_IDENTITY_UNKNOWN'); return result;
  }));
  const counters = parseHostDiskstats(diskstats.text), devices = await Promise.all(c.devices.map(async device => {
    invariant(await fs.realpath(device.path) === device.path, 'CAPACITY_FILESYSTEM_CHANGED');
    const [stat, space] = await Promise.all([fs.stat(device.path), fs.statfs(device.path)]), actual = counters.get(device.majorMinor);
    invariant(String(stat.dev) === device.dev && linuxDevice(stat.dev) === device.majorMinor && actual, 'CAPACITY_FILESYSTEM_CHANGED');
    const capacityBytes = space.blocks * space.bsize, freeBytes = space.bfree * space.bsize, availableBytes = space.bavail * space.bsize;
    invariant([capacityBytes, freeBytes, availableBytes].every(integer) && capacityBytes > 0 && freeBytes <= capacityBytes && availableBytes <= freeBytes, 'CAPACITY_FILESYSTEM_UNKNOWN');
    return { id: device.id, dev: device.dev, majorMinor: device.majorMinor, capacityBytes, freeBytes, availableBytes, ...actual };
  }));
  signal.throwIfAborted();
  const vmBootId = boot.text.trim(); invariant(/^[a-f0-9-]{36}$/.test(vmBootId), 'CAPACITY_BOOT_ID_UNKNOWN');
  return { vmBootId, procIdentity: { path: c.hostProcRoot, dev: String(procStatIdentity.dev), ino: String(procStatIdentity.ino) }, cpu: parseHostCpu(procStat.text), memory: parseHostMemory(meminfo.text), devices,
    containers: containers.sort((a, b) => a.containerId.localeCompare(b.containerId)), startedAt, monotonic: startedMono, finishedAt: clock() };
}

export function validateIoQualification({ value, rawDigest, config: c, sample, now }) {
  invariant(rawDigest === c.ioQualificationRawDigest && value?.schemaVersion === 1 && value.kind === 'control-io-qualification' && value.instanceId === c.instanceId && value.vmBootId === sample.vmBootId && value.qualified === true &&
    value.effectiveBudgetBytesPerSecond === c.ioEffectiveBudgetBytesPerSecond && value.windowMs >= 60000 && integer(value.windowMs) &&
    Number.isFinite(Date.parse(value.observedAt)) && Date.parse(value.observedAt) <= sample.startedAt && Number.isFinite(Date.parse(value.expiresAt)) && Date.parse(value.expiresAt) > now &&
    canonical(value.devices) === canonical(sample.devices.map(({ id, dev, majorMinor }) => ({ id, dev, majorMinor }))), 'CAPACITY_IO_QUALIFICATION_INVALID');
  const m = value.measurement;
  invariant(m && integer(m.readBytes) && integer(m.writeBytes) && Number.isFinite(m.maxLatencyMs) && m.maxLatencyMs >= 0 && integer(m.samples) && m.samples >= 2 && m.unexpectedErrors === 0 &&
    (m.readBytes + m.writeBytes) / (value.windowMs / 1000) >= c.ioEffectiveBudgetBytesPerSecond, 'CAPACITY_IO_QUALIFICATION_UNMEASURED');
  const { receiptDigest, ...facts } = value; invariant(DIGEST.test(receiptDigest) && digest(facts) === receiptDigest, 'CAPACITY_IO_QUALIFICATION_DIGEST_INVALID');
  return receiptDigest;
}

/** The arithmetic accepts only two complete, birth-bound snapshots. Guest
 * processes are already charged to their Owner's cgroup and are never summed. */
export function deriveCapacityObservation({ config: c, before, after, plan, qualification, rawQualificationDigest, revision, now = Date.now() }) {
  validateConfig(c);
  invariant(plan?.instanceId === c.instanceId && plan.sourceDigest === c.sourceDigest && integer(revision) && plan.maxObservationAgeMs > 0 && plan.maxObservationAgeMs <= 5000, 'CAPACITY_PLAN_SCOPE_INVALID');
  const { planDigest, ...planFacts } = plan; invariant(digest(planFacts) === planDigest, 'CAPACITY_PLAN_SCOPE_INVALID');
  invariant(before.vmBootId === after.vmBootId && canonical(before.procIdentity) === canonical(after.procIdentity) && canonical(own(before.containers)) === canonical(own(after.containers)) &&
    after.monotonic > before.monotonic && now >= before.startedAt && now - before.startedAt <= plan.maxObservationAgeMs && after.finishedAt <= now, 'CAPACITY_SNAPSHOT_CHANGED');
  const interval = after.monotonic - before.monotonic;
  invariant(interval >= c.sampleIntervalMs && interval <= c.timeoutMs && before.cpu.cpus === after.cpu.cpus && before.memory.total === after.memory.total, 'CAPACITY_SAMPLE_WINDOW_UNKNOWN');
  const expected = c.residents.flatMap(row => row.containers), actual = after.containers.filter(row => row.instanceId === c.instanceId);
  invariant(canonical(own(expected)) === canonical(own(actual)), 'CAPACITY_CONTAINER_INVENTORY_CHANGED');
  invariant(plan.limits.memoryBytes > 0 && plan.limits.memoryBytes <= after.memory.total && plan.limits.cpuMilliCores > 0 && plan.limits.cpuMilliCores <= after.cpu.cpus * 1000 && plan.limits.ioBytesPerSecond === c.ioEffectiveBudgetBytesPerSecond, 'CAPACITY_EFFECTIVE_LIMITS_CHANGED');
  const ioReceiptDigest = validateIoQualification({ value: qualification, rawDigest: rawQualificationDigest, config: c, sample: after, now });
  const disks = Object.fromEntries(after.devices.map(device => [device.id, 0]));
  invariant(Object.keys(plan.limits.disks).sort().join() === Object.keys(disks).sort().join() && after.devices.every(device => plan.limits.disks[device.id] === device.capacityBytes), 'CAPACITY_EFFECTIVE_LIMITS_CHANGED');
  const delta = (a, b) => { const n = a - b; invariant(integer(n), 'CAPACITY_COUNTER_RESET'); return n; };
  const cpuTotalDelta = delta(after.cpu.total, before.cpu.total), idleDelta = delta(after.cpu.idle, before.cpu.idle);
  invariant(cpuTotalDelta > 0 && idleDelta <= cpuTotalDelta, 'CAPACITY_CPU_UNKNOWN');
  let hostCpu = Math.ceil((cpuTotalDelta - idleDelta) / cpuTotalDelta * after.cpu.cpus * 1000), hostMemory = after.memory.total - after.memory.free, hostIo = 0;
  const usedDisks = {}, availableDisks = {};
  for (const device of after.devices) {
    const old = before.devices.find(row => row.id === device.id);
    invariant(old && old.dev === device.dev && old.majorMinor === device.majorMinor && old.capacityBytes === device.capacityBytes, 'CAPACITY_FILESYSTEM_CHANGED');
    hostIo += Math.ceil((delta(device.readBytes, old.readBytes) + delta(device.writeBytes, old.writeBytes)) / interval * 1000);
    usedDisks[device.id] = device.capacityBytes - device.freeBytes; availableDisks[device.id] = device.availableBytes;
  }
  const residents = c.residents.map(resident => {
    let memoryBytes = 0, cpuMilliCores = 0, ioBytesPerSecond = 0;
    for (const target of resident.containers) {
      const current = after.containers.find(row => row.containerId === target.containerId), previous = before.containers.find(row => row.containerId === target.containerId);
      invariant(validPhysical(current) && previous && current.monotonic > previous.monotonic && integer(current.memoryBytes), 'CAPACITY_CGROUP_COUNTER_UNKNOWN');
      memoryBytes += current.memoryBytes;
      cpuMilliCores += Math.ceil(delta(current.cpuNs, previous.cpuNs) / (current.monotonic - previous.monotonic) / 1000);
      ioBytesPerSecond += Math.ceil(delta(current.ioBytes, previous.ioBytes) / (current.monotonic - previous.monotonic) * 1000);
    }
    return { id: resident.id, identityDigest: capacityResidentIdentity(resident.containers), resources: { memoryBytes, cpuMilliCores, ioBytesPerSecond, disks: { ...disks } } };
  });
  const measured = residents.reduce((sum, row) => { for (const key of ['memoryBytes', 'cpuMilliCores', 'ioBytesPerSecond']) sum[key] += row.resources[key]; return sum; }, { memoryBytes: 0, cpuMilliCores: 0, ioBytesPerSecond: 0 });
  // CPU/IO counter endpoints have bounded sampling skew. Taking the higher
  // actual aggregate is conservative; it never credits negative overhead/free.
  invariant(measured.memoryBytes <= hostMemory, 'CAPACITY_MEMORY_ACCOUNTING_UNKNOWN');
  hostCpu = Math.max(hostCpu, measured.cpuMilliCores); hostIo = Math.max(hostIo, measured.ioBytesPerSecond);
  residents.push({ id: 'host-overhead', identityDigest: capacityHostIdentity(after, c.instanceId), resources: { memoryBytes: hostMemory - measured.memoryBytes, cpuMilliCores: hostCpu - measured.cpuMilliCores, ioBytesPerSecond: hostIo - measured.ioBytesPerSecond, disks: usedDisks } });
  return { known: true, exclusiveAccounting: true, instanceId: c.instanceId, sourceDigest: c.sourceDigest, revision, observedAt: new Date(before.startedAt).toISOString(), limits: structuredClone(plan.limits),
    available: { memoryBytes: Math.max(0, Math.min(after.memory.available, plan.limits.memoryBytes - hostMemory)), cpuMilliCores: Math.max(0, plan.limits.cpuMilliCores - hostCpu), ioBytesPerSecond: Math.max(0, plan.limits.ioBytesPerSecond - hostIo), disks: availableDisks }, residents,
    scope: { vmBootId: after.vmBootId, inventoryDigest: digest(own(after.containers)), procIdentity: after.procIdentity, devices: after.devices.map(({ id, dev, majorMinor }) => ({ id, dev, majorMinor })), ioReceiptDigest, sampleIntervalMs: interval, sampledThrough: new Date(after.finishedAt).toISOString(), ownerIncludesGuestCgroups: true, diskUsageAccount: 'host-overhead', ioAvailabilityMeaning: 'remaining-qualified-effective-budget' } };
}

/** Sole-writer revision lock plus Supervisor's inode/digest CAS protects the
 * observation publication. Unknown observations are persisted, never fabricated. */
export function createControlCapacityCollector({ config: c, clock = Date.now, monotonic = () => performance.now(), sample = sampleLinuxCapacity }) {
  validateConfig(c);
  return { async collect({ plan, expectedRevision, signal: parentSignal } = {}) {
    invariant(integer(expectedRevision), 'CAPACITY_REVISION_REQUIRED');
    const parent = await secureDirectory(dirname(c.observationPath)); invariant(join(parent, c.observationPath.slice(parent.length + 1)) === c.observationPath, 'CAPACITY_OBSERVATION_PATH_INVALID');
    const lock = await fs.open(c.observationPath + '.collector-lock', 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') throw Error('CAPACITY_COLLECTOR_BUSY'); throw error; });
    const signal = AbortSignal.any([AbortSignal.timeout(c.timeoutMs), ...(parentSignal ? [parentSignal] : [])]);
    const start = clock(); let previous;
    try {
      previous = await boundedFile(c.observationPath, 1024 * 1024, signal, true).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      invariant((previous ? JSON.parse(previous.text).revision : 0) === expectedRevision, 'CAPACITY_OBSERVATION_CAS_CHANGED');
      let observation;
      try {
        const before = await sample(c, { signal, clock, monotonic });
        const sampleDue = before.monotonic + c.sampleIntervalMs;
        while (monotonic() < sampleDue) {
          // Timers truncate fractional delays and may wake before the actual
          // monotonic window. Recheck the deadline; do not weaken the 250ms
          // minimum or fabricate sample timestamps to cover an early wakeup.
          const delay = Math.max(1, Math.ceil(sampleDue - monotonic()) + 1);
          await new Promise((ok, fail) => { const abort = () => { clearTimeout(timer); fail(signal.reason); }, timer = setTimeout(() => { signal.removeEventListener('abort', abort); ok(); }, delay); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
        }
        const after = await sample(c, { signal, clock, monotonic });
        const raw = await boundedFile(c.ioQualificationPath, 65536, signal, true);
        observation = deriveCapacityObservation({ config: c, before, after, plan, qualification: JSON.parse(raw.text), rawQualificationDigest: digest(raw.text), revision: expectedRevision + 1, now: clock() });
      } catch (error) {
        const code = error.code || error.message;
        observation = { known: false, exclusiveAccounting: false, instanceId: c.instanceId, sourceDigest: c.sourceDigest, revision: expectedRevision + 1, observedAt: new Date(start).toISOString(), reason: typeof code === 'string' && /^CAPACITY_[A-Z0-9_]{1,90}$/.test(code) ? code : 'CAPACITY_COLLECTION_UNKNOWN' };
      }
      const current = await boundedFile(c.observationPath, 1024 * 1024, undefined, true).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      invariant(canonical(current) === canonical(previous), 'CAPACITY_OBSERVATION_CAS_CHANGED');
      await atomicJson(c.observationPath, observation); return observation;
    } finally { await lock.close(); await fs.unlink(c.observationPath + '.collector-lock'); }
  } };
}

function appliedStart(record, instanceId) {
  invariant(record?.instanceId === instanceId && record.state === 'applied' && record.specDigest === digest(record.spec) && record.spec?.kind === 'supervisor-start' && record.spec.instanceId === instanceId &&
    ID.test(record.spec.capacityAllocationId) && ['api', 'coordinator', 'owner', 'web'].includes(record.spec.request?.kind), 'CAPACITY_APPLIED_START_REQUIRED');
  return record.result?.physical ?? record.result;
}
function receiptPhysical(value) {
  return physical({ ...value, pid: value.hostPid ?? value.pid });
}
/** A completed real start consumes exactly one pre-reserved physical-role
 * allocation. The old command/spec is immutable; only future commands use the
 * new plan digest. A missing/unknown start receipt never earns resident credit. */
export function transitionCapacityAfterStart({ plan, config, record, sample, now = Date.now() }) {
  validateConfig(config);
  const result = appliedStart(record, config.instanceId);
  invariant(plan.instanceId === config.instanceId && record.spec.capacityPlanDigest === plan.planDigest && record.spec.sourceDigest === plan.sourceDigest && config.sourceDigest === plan.sourceDigest, 'CAPACITY_START_PLAN_CHANGED');
  // Validate the actual frozen plan, retaining all other reservations verbatim.
  invariant(freezeCapacityBudget(plan).planDigest === plan.planDigest, 'CAPACITY_START_PLAN_CHANGED');
  const matches = Object.entries(plan.allocations).flatMap(([category, entries]) => entries.filter(row => row.id === record.spec.capacityAllocationId).map(row => ({ category, row })));
  invariant(matches.length === 1 && matches[0].category === 'candidate' && !matches[0].row.resident && canonical(matches[0].row.resources) === canonical(record.spec.resources), 'CAPACITY_START_ALLOCATION_CHANGED');
  const expected = receiptPhysical(result), actual = sample.containers.find(row => row.containerId === expected.containerId);
  invariant(validPhysical(expected) && actual && canonical(physical(actual)) === canonical(expected) && expected.instanceId === config.instanceId && expected.role === record.spec.request.kind &&
    result.commandId === record.commandId && result.operationId === record.operationId && now >= sample.startedAt && now - sample.startedAt <= 5000, 'CAPACITY_START_PHYSICAL_UNKNOWN');
  const old = config.residents.flatMap(row => row.containers), all = sample.containers.filter(row => row.instanceId === config.instanceId);
  invariant(!old.some(row => row.containerId === expected.containerId) && canonical(own([...old, expected])) === canonical(own(all)), 'CAPACITY_CONTAINER_INVENTORY_CHANGED');
  const nextConfig = structuredClone(config), nextPlan = structuredClone(plan), id = record.spec.capacityAllocationId;
  nextConfig.residents.push({ id, containers: [expected] });
  const allocation = nextPlan.allocations.candidate.find(row => row.id === id);
  allocation.resident = true; allocation.identityDigest = capacityResidentIdentity([expected]);
  return { plan: freezeCapacityBudget(nextPlan), config: nextConfig, physical: expected };
}

function appliedMaintenance(record, instanceId) {
  invariant(record?.instanceId === instanceId && record.state === 'applied' && record.specDigest === digest(record.spec) && record.spec.instanceId === instanceId && record.spec.maintenanceId === record.maintenanceId && record.spec.commandId === record.commandId &&
    ['start-control-agent', 'stop-control-agent'].includes(record.spec.kind) && ID.test(record.spec.capacityAllocationId), 'CAPACITY_APPLIED_MAINTENANCE_REQUIRED');
  invariant(record.result?.instanceId === instanceId && record.result.maintenanceId === record.maintenanceId && record.result.commandId === record.commandId && record.result.specDigest === record.specDigest, 'CAPACITY_MAINTENANCE_RECEIPT_CHANGED');
}
/** A process which already exited is a different fact from an observed normal
 * SIGTERM. Both release a reservation only after the exact container is absent
 * from the new running inventory; neither authorizes a signal or forced stop. */
export function knownControlAgentTermination(value, receipt = true) {
  const physical = value?.running === false && value.hostPid === 0 && value.paused === false && value.restartCount === 0 && value.restartPolicy === 'no' &&
    typeof value.oomKilled === 'boolean' && Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255 &&
    Number.isFinite(Date.parse(value.finishedAt)) && Date.parse(value.finishedAt) >= Date.parse(value.startedAt);
  if (!receipt) return physical;
  return physical && value.forced === false && value.removed === false && (value.normalExit === true ? value.signal === 'SIGTERM' && value.oomKilled === false && [0, 143].includes(value.exitCode) :
    value.normalExit === false && value.terminationObserved === true && value.signal === null);
}
/** The control budget is retained while its old birth is stopped. It is only
 * rebound to a new birth after the same maintenance's actual applied start. */
export function transitionCapacityAfterMaintenance({ plan, config, record, sample, now = Date.now() }) {
  validateConfig(config); appliedMaintenance(record, config.instanceId);
  invariant(plan.instanceId === config.instanceId && plan.sourceDigest === config.sourceDigest && freezeCapacityBudget(plan).planDigest === plan.planDigest && now >= sample.startedAt && now - sample.startedAt <= 5000, 'CAPACITY_MAINTENANCE_PLAN_CHANGED');
  const matches = Object.entries(plan.allocations).flatMap(([category, rows]) => rows.filter(row => row.id === record.spec.capacityAllocationId).map(row => ({ category, row })));
  invariant(matches.length === 1 && matches[0].category === 'control' && canonical(matches[0].row.resources) === canonical(record.spec.resources), 'CAPACITY_MAINTENANCE_ALLOCATION_CHANGED');
  const nextPlan = structuredClone(plan), nextConfig = structuredClone(config), allocation = nextPlan.allocations.control.find(row => row.id === record.spec.capacityAllocationId), bucket = config.residents.find(row => row.id === allocation.id);
  let target;
  if (record.spec.kind === 'stop-control-agent') {
    target = receiptPhysical({ ...record.spec.target, instanceId: config.instanceId, restartCount: 0 });
    invariant(validPhysical(target) && target.role === 'control-agent' && knownControlAgentTermination(record.result) && ['containerId', 'startIdentity', 'artifactDigest', 'startedAt'].every(key => record.result[key] === target[key]) &&
      !sample.containers.some(row => row.containerId === target.containerId), 'CAPACITY_MAINTENANCE_STOP_UNKNOWN');
    invariant(!allocation.resident && !bucket || allocation.resident && bucket?.containers.length === 1 && canonical(physical(bucket.containers[0])) === canonical(target), 'CAPACITY_MAINTENANCE_BINDING_CHANGED');
    nextConfig.residents = nextConfig.residents.filter(row => row.id !== allocation.id); allocation.resident = false;
  } else {
    target = receiptPhysical(record.result);
    const actual = sample.containers.find(row => row.containerId === target.containerId);
    invariant(!allocation.resident && !bucket && validPhysical(target) && target.role === 'control-agent' && actual && canonical(physical(actual)) === canonical(target) &&
      record.result.running === true && target.startIdentity === record.spec.startIdentity, 'CAPACITY_MAINTENANCE_START_UNKNOWN');
    nextConfig.residents.push({ id: allocation.id, containers: [target] }); allocation.resident = true; allocation.identityDigest = capacityResidentIdentity([target]);
  }
  invariant(canonical(own(sample.containers.filter(row => row.instanceId === config.instanceId))) === canonical(own(nextConfig.residents.flatMap(row => row.containers))), 'CAPACITY_MAINTENANCE_INVENTORY_CHANGED');
  return { plan: freezeCapacityBudget(nextPlan), config: nextConfig, physical: target };
}

/** Supervisor-owned files and the real Supervisor journal are injected at
 * assembly. Callers submit only the original command IDs, never resource facts.
 * Between the two file publications old observations cannot match the new
 * resident set, so admission stays closed until a fresh collection completes. */
function createCapacityBookkeeper({ journal, instanceId, planPath, configPath, transitionRoot, clock = Date.now,
  sample = sampleLinuxCapacity, write = atomicJson, maintenance = false }) {
  invariant(typeof journal?.lookup === 'function' && ID.test(instanceId) && [planPath, configPath, transitionRoot].every(isAbsolute) && planPath !== configPath, 'CAPACITY_BOOKKEEPER_CONFIG_INVALID');
  return { async register({ operationId, commandId, signal } = {}) {
    invariant(ID.test(operationId) && ID.test(commandId), 'CAPACITY_START_COMMAND_REQUIRED');
    await secureDirectory(transitionRoot);
    const lock = await fs.open(join(transitionRoot, 'publication.lock'), 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') throw Error('CAPACITY_BOOKKEEPER_BUSY'); throw error; });
    try {
      const record = journal.lookup({ operationId, commandId }); if (maintenance) appliedMaintenance(record, instanceId); else appliedStart(record, instanceId);
      const path = join(transitionRoot, digest({ instanceId, operationId, commandId }).slice(7) + '.json');
      const previous = await boundedFile(path, 1024 * 1024, signal, true).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      let intent = previous ? JSON.parse(previous.text) : null;
      if (intent) {
        const { intentDigest, ...facts } = intent;
        invariant(intentDigest === digest(facts) && intent.maintenance === maintenance && intent.instanceId === instanceId && intent.operationId === operationId && intent.commandId === commandId && intent.specDigest === record.specDigest, 'CAPACITY_TRANSITION_CORRUPT');
        if (intent.state === 'applied') return intent.receipt;
        invariant(intent.state === 'pending', 'CAPACITY_TRANSITION_CORRUPT');
      } else {
        const config = JSON.parse((await boundedFile(configPath, 1024 * 1024, signal, true)).text), plan = JSON.parse((await boundedFile(planPath, 1024 * 1024, signal, true)).text);
        const boundedSignal = AbortSignal.any([AbortSignal.timeout(config.timeoutMs), ...(signal ? [signal] : [])]);
        const actual = await sample(config, { signal: boundedSignal, clock });
        const next = (maintenance ? transitionCapacityAfterMaintenance : transitionCapacityAfterStart)({ config, plan, record, sample: actual, now: clock() });
        const facts = { schemaVersion: 1, state: 'pending', maintenance, instanceId, operationId, commandId, specDigest: record.specDigest, originalPlanDigest: plan.planDigest,
          oldPlanDigest: digest(plan), oldConfigDigest: digest(config), nextPlan: next.plan, nextConfig: next.config, physical: next.physical };
        intent = { ...facts, intentDigest: digest(facts) }; await write(path, intent);
      }
      const fresh = await sample(intent.nextConfig, { signal: AbortSignal.any([AbortSignal.timeout(intent.nextConfig.timeoutMs), ...(signal ? [signal] : [])]), clock });
      invariant(clock() >= fresh.startedAt && clock() - fresh.startedAt <= 5000 && canonical(own(fresh.containers.filter(row => row.instanceId === instanceId))) === canonical(own(intent.nextConfig.residents.flatMap(row => row.containers))), 'CAPACITY_TRANSITION_PHYSICAL_CHANGED');
      for (const [target, oldDigest, next] of [[planPath, intent.oldPlanDigest, intent.nextPlan], [configPath, intent.oldConfigDigest, intent.nextConfig]]) {
        const current = JSON.parse((await boundedFile(target, 1024 * 1024, signal, true)).text), hash = digest(current);
        invariant(hash === oldDigest || hash === digest(next), 'CAPACITY_TRANSITION_CAS_CHANGED');
        if (hash !== digest(next)) await write(target, next);
      }
      const receipt = { instanceId, operationId, commandId, specDigest: record.specDigest, sourceDigest: intent.nextPlan.sourceDigest,
        oldPlanDigest: intent.originalPlanDigest, planDigest: intent.nextPlan.planDigest, configDigest: digest(intent.nextConfig), allocationId: record.spec.capacityAllocationId, physical: intent.physical, appliedAt: new Date(clock()).toISOString() };
      const { intentDigest: _old, ...facts } = intent, done = { ...facts, state: 'applied', receipt };
      await write(path, { ...done, intentDigest: digest(done) }); return receipt;
    } finally { await lock.close(); await fs.unlink(join(transitionRoot, 'publication.lock')); }
  } };
}
export const createCapacityStartBookkeeper = options => createCapacityBookkeeper({ ...options, maintenance: false });
export const createCapacityMaintenanceBookkeeper = options => createCapacityBookkeeper({ ...options, maintenance: true });
