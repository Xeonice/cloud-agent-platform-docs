import { invariant } from './trust.mjs';

/** Resources come from the admitted allocation, never a public request. Device
 * paths are fixed installation configuration tied to its native IO receipt. */
export function roleResourceFlags({ resources, pidsLimit, ioDevices }) {
  invariant(resources && Number.isSafeInteger(resources.memoryBytes) && resources.memoryBytes >= 16 * 1024 * 1024 &&
    Number.isSafeInteger(resources.cpuMilliCores) && resources.cpuMilliCores > 0 &&
    Number.isSafeInteger(resources.ioBytesPerSecond) && resources.ioBytesPerSecond > 0 &&
    Number.isSafeInteger(pidsLimit) && pidsLimit >= 16 && pidsLimit <= 65536 && Array.isArray(ioDevices) && ioDevices.length > 0 && ioDevices.length <= 8 &&
    new Set(ioDevices.map(device => device.path)).size === ioDevices.length && ioDevices.every(device => typeof device.id === 'string' &&
      Object.hasOwn(resources.disks ?? {}, device.id) && /^\d+:\d+$/.test(device.majorMinor) &&
      /^\/dev\/(?:[sv]d[a-z][0-9]*|nvme[0-9]+n[0-9]+(?:p[0-9]+)?)$/.test(device.path)), 'ROLE_ADMITTED_RESOURCE_LIMITS_REQUIRED');
  const perDirection = Math.floor(resources.ioBytesPerSecond / (2 * ioDevices.length));
  invariant(perDirection > 0, 'ROLE_IO_BUDGET_TOO_SMALL');
  return ['--memory', String(resources.memoryBytes), '--memory-swap', String(resources.memoryBytes),
    '--cpus', String(resources.cpuMilliCores / 1000), '--pids-limit', String(pidsLimit),
    ...ioDevices.flatMap(device => ['--device-read-bps', device.path + ':' + perDirection, '--device-write-bps', device.path + ':' + perDirection])];
}
