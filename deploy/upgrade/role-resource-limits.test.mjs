import test from 'node:test';
import assert from 'node:assert/strict';
import { roleResourceFlags } from './role-resource-limits.mjs';

test('per-device read and write quotas never multiply the single admitted aggregate IO budget', () => {
  const resources = { memoryBytes: 256 * 1024 ** 2, cpuMilliCores: 750, ioBytesPerSecond: 1000003, disks: { data: 100, artifacts: 200 } };
  const flags = roleResourceFlags({ resources, pidsLimit: 128, ioDevices: [{ id: 'data', path: '/dev/vda', majorMinor: '253:0' }, { id: 'artifacts', path: '/dev/vdb', majorMinor: '253:16' }] });
  let total = 0;
  for (let i = 0; i < flags.length; i += 2) if (flags[i].startsWith('--device-')) total += Number(flags[i + 1].split(':').at(-1));
  assert.ok(total > 0 && total <= resources.ioBytesPerSecond);
  assert.equal(flags[flags.indexOf('--memory') + 1], flags[flags.indexOf('--memory-swap') + 1]);
  assert.equal(flags[flags.indexOf('--cpus') + 1], '0.75');
});

test('missing allocation limits, non-filesystem devices, and an unbudgeted device fail before Docker dispatch', () => {
  const input = { resources: { memoryBytes: 128 * 1024 ** 2, cpuMilliCores: 500, ioBytesPerSecond: 1000000, disks: { data: 100 } }, pidsLimit: 128,
    ioDevices: [{ id: 'data', path: '/dev/vda', majorMinor: '253:0' }] };
  for (const change of [ { resources: undefined }, { pidsLimit: undefined }, { ioDevices: [] },
    { ioDevices: [{ id: 'data', path: '/dev/kvm', majorMinor: '10:232' }] },
    { ioDevices: [{ id: 'other-filesystem', path: '/dev/vdb', majorMinor: '253:16' }] },
    { resources: { ...input.resources, memoryBytes: '134217728' } } ]) {
    assert.throws(() => roleResourceFlags({ ...input, ...change }), /ROLE_ADMITTED_RESOURCE_LIMITS_REQUIRED/);
  }
});
