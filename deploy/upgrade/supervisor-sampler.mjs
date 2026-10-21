import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { digest, invariant } from "./trust.mjs";
const CID = /^[a-f0-9]{64}$/,
  HASH = /^sha256:[a-f0-9]{64}$/;
async function boundedFile(path, maximum, signal) {
  signal?.throwIfAborted();
  const file = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const bytes = Buffer.alloc(maximum + 1),
      { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    signal?.throwIfAborted();
    invariant(bytesRead <= maximum, "SUPERVISOR_SAMPLE_FILE_TOO_LARGE");
    return bytes.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}
export function parseProcessBirth(stat) {
  const end = stat.lastIndexOf(")");
  invariant(end > 0, "SUPERVISOR_SAMPLE_STAT_UNKNOWN");
  const fields = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  invariant(
    fields.length >= 22 && /^\d+$/.test(fields[19]),
    "SUPERVISOR_SAMPLE_STAT_UNKNOWN",
  );
  return fields[19];
}
/** Capture actual kernel birth once, paired with exact Docker physical identity. */
export async function captureProcessIdentity({
  hostPid,
  containerId,
  procRoot = "/proc",
}) {
  invariant(
    Number.isSafeInteger(hostPid) && hostPid > 1 && CID.test(containerId),
    "SUPERVISOR_SAMPLE_IDENTITY_UNKNOWN",
  );
  const home = join(procRoot, String(hostPid)),
    stat = await boundedFile(join(home, "stat"), 16384),
    cgroup = await boundedFile(join(home, "cgroup"), 16384);
  invariant(cgroup.includes(containerId), "SUPERVISOR_SAMPLE_CGROUP_UNKNOWN");
  return { birthTicks: parseProcessBirth(stat), cgroupDigest: digest(cgroup) };
}
/** Only frozen exact IDs/PIDs. No Docker exec, process-tree discovery or directory scan. */
export function createBoundedRoleSampler({
  targets,
  procRoot = "/proc",
  cgroupRoot = "/sys/fs/cgroup",
  clock = Date.now,
}) {
  invariant(
    typeof targets === "function" &&
      resolve(procRoot) === procRoot &&
      resolve(cgroupRoot) === cgroupRoot,
    "SUPERVISOR_SAMPLER_CONFIG_INVALID",
  );
  let live = false;
  return async ({ signal, maxTargets = 16 } = {}) => {
    invariant(!live, "SUPERVISOR_SAMPLE_BUSY");
    live = true;
    try {
      const list = await targets();
      invariant(
        Array.isArray(list) &&
          list.length <= 16 &&
          Number.isInteger(maxTargets) &&
          maxTargets > 0 &&
          maxTargets <= 16,
        "SUPERVISOR_SAMPLE_TARGET_LIMIT",
      );
      return await Promise.all(
        list.slice(0, maxTargets).map(async (target) => {
          const base = {
            role: target.kind || target.role,
            startIdentity: target.startIdentity,
            observedAt: new Date(clock()).toISOString(),
          };
          try {
            invariant(
              CID.test(target.containerId) &&
                Number.isSafeInteger(target.hostPid) &&
                target.hostPid > 1 &&
                typeof target.startIdentity === "string" &&
                /^\d+$/.test(target.birthTicks) &&
                HASH.test(target.cgroupDigest),
              "SUPERVISOR_SAMPLE_IDENTITY_UNKNOWN",
            );
            const home = join(procRoot, String(target.hostPid));
            const [stat, cgroup, status, io] = await Promise.all([
              boundedFile(join(home, "stat"), 16384, signal),
              boundedFile(join(home, "cgroup"), 16384, signal),
              boundedFile(join(home, "status"), 65536, signal),
              boundedFile(join(home, "io"), 16384, signal),
            ]);
            invariant(
              parseProcessBirth(stat) === target.birthTicks &&
                digest(cgroup) === target.cgroupDigest &&
                cgroup.includes(target.containerId),
              "SUPERVISOR_SAMPLE_BIRTH_CHANGED",
            );
            const metrics = {};
            const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
            if (rss) metrics.rssBytes = Number(rss[1]) * 1024;
            for (const [key, out] of [
              ["read_bytes", "readBytes"],
              ["write_bytes", "writeBytes"],
            ]) {
              const value = new RegExp("^" + key + ":\\s+(\\d+)$", "m").exec(
                io,
              );
              if (value) metrics[out] = Number(value[1]);
            }
            const group = /^0::(.+)$/m.exec(cgroup)?.[1];
            if (
              group &&
              group.startsWith("/") &&
              !group.split("/").includes("..")
            ) {
              const root = join(cgroupRoot, group);
              const read = async (name) => {
                try {
                  return await boundedFile(join(root, name), 16384, signal);
                } catch {
                  return null;
                }
              };
              const [memory, peak, cpu, events] = await Promise.all(
                [
                  "memory.current",
                  "memory.peak",
                  "cpu.stat",
                  "memory.events",
                ].map(read),
              );
              if (memory && /^\d+\s*$/.test(memory))
                metrics.cgroupMemoryBytes = Number(memory.trim());
              if (peak && /^\d+\s*$/.test(peak))
                metrics.cgroupMemoryPeakBytes = Number(peak.trim());
              const throttled = /^throttled_usec\s+(\d+)$/m.exec(cpu || "");
              if (throttled)
                metrics.cgroupCpuThrottledMicros = Number(throttled[1]);
              const oom = /^oom_kill\s+(\d+)$/m.exec(events || "");
              if (oom) metrics.cgroupOomCount = Number(oom[1]);
            }
            // Re-read kernel birth after the fixed files, so PID reuse never earns a valid sample.
            invariant(
              parseProcessBirth(
                await boundedFile(join(home, "stat"), 16384, signal),
              ) === target.birthTicks,
              "SUPERVISOR_SAMPLE_BIRTH_CHANGED",
            );
            for (const value of Object.values(metrics))
              invariant(
                Number.isSafeInteger(value) && value >= 0,
                "SUPERVISOR_SAMPLE_METRIC_UNKNOWN",
              );
            return { ...base, state: "alive", ...metrics };
          } catch {
            return { ...base, state: "unknown" };
          }
        }),
      );
    } finally {
      live = false;
    }
  };
}
