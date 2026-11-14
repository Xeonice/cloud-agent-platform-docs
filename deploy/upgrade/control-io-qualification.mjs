import { spawn } from 'node:child_process';
import { readFile, stat, statfs, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { secureDirectory, atomicJson } from './io.mjs';
import { invariant, digest } from './trust.mjs';
import { linuxDevice } from './control-capacity-collector.mjs';

// Direct aligned IO avoids crediting page-cache throughput as physical disk
// capacity. Only a new, bounded private scratch file is ever written/removed.
const PROGRAM = String.raw`
import os,sys,time,json,mmap,hashlib
path,duration,budget=sys.argv[1],int(sys.argv[2]),int(sys.argv[3])
size=262144; total=size*64
flags=os.O_CREAT|os.O_EXCL|os.O_RDWR|os.O_NOFOLLOW|os.O_DIRECT
fd=os.open(path,flags,0o600)
write=mmap.mmap(-1,size);read=mmap.mmap(-1,size)
write[:]=bytes(range(256))*(size//256)
expected=hashlib.sha256(write).digest()
try:
 os.posix_fallocate(fd,0,total);os.fsync(fd)
 start=time.monotonic();samples=0;read_bytes=0;write_bytes=0;maximum=0
 while time.monotonic()-start<duration/1000:
  offset=(samples%64)*size;began=time.monotonic()
  n=os.pwritev(fd,[write],offset);assert n==size
  os.fsync(fd)
  n=os.preadv(fd,[read],offset);assert n==size
  assert hashlib.sha256(read).digest()==expected
  maximum=max(maximum,(time.monotonic()-began)*1000)
  samples+=1;read_bytes+=size;write_bytes+=size
  # Measure at twice the explicitly requested effective budget, leaving a
  # measured margin. This is not a claim about a device's maximum bandwidth.
  due=start+(read_bytes+write_bytes)/(budget*2)
  time.sleep(max(0,min(.1,due-time.monotonic())))
 elapsed=int((time.monotonic()-start)*1000)
 print(json.dumps(dict(windowMs=elapsed,measurement=dict(readBytes=read_bytes,writeBytes=write_bytes,maxLatencyMs=maximum,samples=samples,unexpectedErrors=0))))
finally:
 read.close();write.close();os.close(fd);os.unlink(path)
`;

/** Measures one fixed filesystem. No service, role, Guest, cache or live data is
 * stopped, opened or replaced. This qualifies an effective IO budget only;
 * business/Agent continuity still requires its own native acceptance window. */
export async function qualifyControlIo({ root, instanceId, deviceId, effectiveBudgetBytesPerSecond,
  windowMs = 60000, maxLatencyMs = 2000, minFreeBytes = 4 * 1024 ** 3, python = '/usr/bin/python3', signal }) {
  invariant(process.platform === 'linux' && /^[a-zA-Z0-9._:-]{1,200}$/.test(instanceId) && /^[a-zA-Z0-9._:-]{1,200}$/.test(deviceId) &&
    Number.isSafeInteger(effectiveBudgetBytesPerSecond) && effectiveBudgetBytesPerSecond >= 262144 && effectiveBudgetBytesPerSecond <= 128 * 1024 ** 2 &&
    Number.isSafeInteger(windowMs) && windowMs >= 60000 && windowMs <= 120000 && maxLatencyMs > 0 && maxLatencyMs <= 2000 && Number.isSafeInteger(minFreeBytes) && minFreeBytes >= 256 * 1024 ** 2 &&
    ['/usr/bin/python3', '/usr/bin/python3.11'].includes(python) && !signal?.aborted, 'CONTROL_IO_QUALIFICATION_CONFIG_INVALID');
  root = await secureDirectory(root);
  const before = await stat(root, { bigint: true }), space = await statfs(root);
  invariant(space.bavail * space.bsize >= minFreeBytes + 16 * 1024 ** 2, 'CONTROL_IO_QUALIFICATION_DISK_RESERVE_REQUIRED');
  const vmBootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  invariant(/^[a-f0-9-]{36}$/.test(vmBootId), 'CONTROL_IO_QUALIFICATION_VM_UNKNOWN');
  const startedAt = Date.now(), monotonic = performance.now(), scratch = join(root, '.io-probe-' + randomUUID());
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const child = spawn(python, ['-c', PROGRAM, scratch, String(windowMs), String(effectiveBudgetBytesPerSecond)], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '', bytes = 0, timedOut = false, workerError, escalation;
      const terminate = () => { child.kill('SIGTERM'); escalation ??= setTimeout(() => { child.kill('SIGKILL'); }, 2000); };
      const timer = setTimeout(() => { timedOut = true; terminate(); }, windowMs + 10000);
      const abort = () => terminate(); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) terminate();
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 8192) terminate(); else output += chunk; });
      child.once('error', error => { workerError = error; });
      // Wait for actual close, including after an abort/timeout. This module
      // never declares its worker stopped merely because a kill was sent.
      child.once('close', code => {
        clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener('abort', abort);
        if (workerError || signal?.aborted || code !== 0 || timedOut || bytes > 8192) reject(Object.assign(Error('Direct IO qualification did not complete'), { code: signal?.aborted ? 'CONTROL_IO_QUALIFICATION_ABORTED' : 'CONTROL_IO_QUALIFICATION_INCOMPLETE' }));
        else { try { resolve(JSON.parse(output)); } catch { reject(Object.assign(Error('IO qualification output invalid'), { code: 'CONTROL_IO_QUALIFICATION_INCOMPLETE' })); } }
      });
    });
  } finally { await rm(scratch, { force: true }); }
  const after = await stat(root, { bigint: true }), actualBoot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  invariant(before.dev === after.dev && before.ino === after.ino && vmBootId === actualBoot && result.windowMs >= windowMs && performance.now() - monotonic >= windowMs &&
    result.measurement.unexpectedErrors === 0 && result.measurement.samples >= 2 && result.measurement.maxLatencyMs <= maxLatencyMs &&
    (result.measurement.readBytes + result.measurement.writeBytes) * 1000 / result.windowMs >= effectiveBudgetBytesPerSecond, 'CONTROL_IO_QUALIFICATION_NOT_PASSED');
  const proof = { schemaVersion: 1, kind: 'control-io-qualification', instanceId, vmBootId,
    devices: [{ id: deviceId, dev: String(after.dev), majorMinor: linuxDevice(after.dev) }], effectiveBudgetBytesPerSecond,
    windowMs: result.windowMs, observedAt: new Date(Date.now()).toISOString(), expiresAt: new Date(startedAt + 24 * 60 * 60 * 1000).toISOString(),
    qualified: true, measurement: result.measurement };
  proof.receiptDigest = digest(proof);
  const reportPath = join(root, 'io-qualification-' + randomUUID() + '.json'); await atomicJson(reportPath, proof);
  return { reportPath, proof };
}
