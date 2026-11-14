import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDockerIoBytes, kernelIoPath, parseKernelZeroIo } from './control-capacity-collector.mjs';

const cid = 'a'.repeat(64);
test('Docker cgroup-v1 and cgroup-v2 operations retain actual read and write bytes without double-counting totals', () => {
  assert.equal(parseDockerIoBytes([{ op: 'Read', value: 4096 }, { op: 'Write', value: 8192 }, { op: 'Total', value: 12288 }]), 12288);
  assert.equal(parseDockerIoBytes([{ op: 'read', value: 8192 }, { op: 'write', value: 4096 }]), 12288);
  assert.equal(parseDockerIoBytes([]), 0);
  assert.equal(parseDockerIoBytes(null), null);
});
test('missing, malformed, negative, non-integer and overflowing Docker counters stay unknown', () => {
  for (const value of [undefined, {}, [{ op: 'read', value: -1 }], [{ op: 'write', value: 1.5 }], [{ op: 'read', value: '0' }], [{ op: 'unknown', value: 0 }], [null], [{ op: 'Total', value: 4096 }], [{ op: 'Sync', value: 4096 }], [{ op: 'Discard', value: 4096 }], [{ op: 'read', value: Number.MAX_SAFE_INTEGER }, { op: 'write', value: 1 }]])
    assert.throws(() => parseDockerIoBytes(value), /CAPACITY_CGROUP_IO_UNKNOWN/);
});
test('only the full container cgroup leaf may supply missing Docker zero evidence', () => {
  assert.equal(kernelIoPath('/host/cgroup', cid, '0::/system.slice/docker-' + cid + '.scope\n'), '/host/cgroup/system.slice/docker-' + cid + '.scope/io.stat');
  assert.equal(kernelIoPath('/host/cgroup', cid, '0::/docker/' + cid + '\n'), '/host/cgroup/docker/' + cid + '/io.stat');
  for (const source of ['0::/\n', '0::/docker/' + cid.slice(0, 12) + '\n', '0::/docker/' + 'b'.repeat(64) + '\n', '0::/docker/' + cid + '/child\n', '0::/docker/../' + cid + '\n', '0::/docker/./' + cid + '\n', '1:blkio:/docker/' + cid + '\n', '0::/docker/' + cid + '\n1:cpu:/x\n'])
    assert.throws(() => kernelIoPath('/host/cgroup', cid, source), /CAPACITY_CGROUP_IO_UNKNOWN/);
  assert.throws(() => kernelIoPath('/host/../cgroup', cid, '0::/docker/' + cid), /CAPACITY_CGROUP_IO_UNKNOWN/);
});
test('empty and explicit all-zero unified kernel IO records are actual zero evidence', () => {
  assert.equal(parseKernelZeroIo(''), 0);
  assert.equal(parseKernelZeroIo('\n'), 0);
  assert.equal(parseKernelZeroIo('253:16 rbytes=0 wbytes=0 rios=0 wios=0 dbytes=0 dios=0\n'), 0);
  assert.equal(parseKernelZeroIo('253:16 rbytes=0 wbytes=0\n8:0 rbytes=0 wbytes=0\n'), 0);
});
test('nonzero bytes, IOPS or discard, incomplete records and malformed kernel evidence never become zero', () => {
  for (const source of ['253:16 rbytes=1 wbytes=0', '253:16 rbytes=0 wbytes=1', '253:16 rbytes=0 wbytes=0 rios=1', '253:16 rbytes=0 wbytes=0 wios=1', '253:16 rbytes=0 wbytes=0 dbytes=4096 dios=1', '253:16 rbytes=0', '253:16 rbytes=0 wbytes=-1', '253:16 rbytes=0 wbytes=0 x=0', '253:16 rbytes=0 wbytes=0 wbytes=0', '253:16 rbytes=0 wbytes=0\n253:16 rbytes=0 wbytes=0', '253:16 rbytes=0 wbytes=9007199254740992', 'not-an-io-stat'])
    assert.throws(() => parseKernelZeroIo(source), /CAPACITY_CGROUP_IO_UNKNOWN/);
});
