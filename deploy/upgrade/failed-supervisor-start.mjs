import * as fs from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { digest, invariant } from "./trust.mjs";
import { readSupervisorFact } from "./supervisor-control.mjs";
import { parseProcessBirth } from "./supervisor-sampler.mjs";

const same = (a, b, keys) => keys.every((key) => a?.[key] === b?.[key]);
const birth = [
  "containerId",
  "startIdentity",
  "artifactDigest",
  "startedAt",
  "imageDigest",
  "role",
  "restartCount",
];
const physical = [
  ...birth,
  "hostPid",
  "running",
  "paused",
  "restartPolicy",
  "oomKilled",
  "exitCode",
];
const command = [
  "kind",
  "instanceId",
  "attemptId",
  "operationId",
  "commandId",
  "specDigest",
  "startIdentity",
  "artifactDigest",
];
const need = (value) =>
  invariant(value, "CONTROL_MIGRATION_FAILED_SUPERVISOR_UNPROVEN");

// A recorded cgroup path is required. Guessing a Docker cgroup layout could
// incorrectly treat an unrelated missing directory as proof of termination.
export async function observeSupervisorKernelExit(config, original) {
  const procRoot = config.procRoot || "/proc",
    cgroupRoot = config.cgroupRoot || "/sys/fs/cgroup";
  need(
    isAbsolute(procRoot) &&
      isAbsolute(cgroupRoot) &&
      (await fs.lstat(procRoot)).isDirectory() &&
      (await fs.lstat(cgroupRoot)).isDirectory() &&
      isAbsolute(original.cgroupPath || "") &&
      original.cgroupPath !== "/" &&
      !original.cgroupPath.split("/").includes("..") &&
      original.cgroupPath.includes(original.containerId) &&
      /^\d+$/.test(original.birthTicks),
  );
  const group = join(cgroupRoot, original.cgroupPath);
  try {
    const stat = await fs.lstat(group);
    need(stat.isDirectory() && !stat.isSymbolicLink());
    const [procs, threads, events] = await Promise.all(
      ["cgroup.procs", "cgroup.threads", "cgroup.events"].map((name) =>
        fs.readFile(join(group, name), "utf8"),
      ),
    );
    need(!procs.trim() && !threads.trim() && /^populated 0$/m.test(events));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // ENOENT from a child file is not evidence that the cgroup is absent.
    await fs.lstat(group).then(
      () => need(false),
      (missing) => {
        if (missing.code !== "ENOENT") throw missing;
      },
    );
  }
  const home = join(procRoot, String(original.hostPid));
  try {
    const [stat, group] = await Promise.all([
      fs.readFile(join(home, "stat"), "utf8"),
      fs.readFile(join(home, "cgroup"), "utf8"),
    ]);
    need(
      parseProcessBirth(stat) !== original.birthTicks &&
        !group.includes(original.containerId),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.lstat(home).then(
      () => need(false),
      (missing) => {
        if (missing.code !== "ENOENT") throw missing;
      },
    );
  }
}

/** Only an unconfirmed initial Supervisor is eligible. Entry traffic, writer
 * authority, access authority and all retained/source roles remain excluded. */
export async function observeFailedSupervisorStart({
  config,
  registryRoot,
  record,
  expected,
  inspect,
  clock = Date.now,
  readFact = readSupervisorFact,
  kernel = observeSupervisorKernelExit,
}) {
  need(
    record.kind === "control-supervisor" &&
      expected.kind === record.kind &&
      expected.role === record.kind &&
      record.instanceId === config.instanceId &&
      /^[a-zA-Z0-9._:-]{1,200}$/.test(record.operationId || "") &&
      record.commandId === record.operationId + ":start-control-supervisor" &&
      record.attemptId === record.operationId &&
      /^[a-f0-9]{64}$/.test(expected.containerId || "") &&
      same(record, expected, command) &&
      expected.running === true &&
      expected.hostPid > 1 &&
      expected.exitCode === 0 &&
      expected.restartCount === 0 &&
      expected.paused === false &&
      expected.restartPolicy === "no" &&
      expected.oomKilled === false &&
      /^sha256:[a-f0-9]{64}$/.test(expected.imageDigest || "") &&
      Number.isFinite(Date.parse(expected.startedAt)),
  );
  const paths = [
    join(
      registryRoot,
      "start-" + record.operationId + "-" + record.commandId + ".json",
    ),
    join(registryRoot, expected.containerId + ".json"),
  ];
  const facts = await Promise.all(paths.map((path) => readFact(path, 65536)));
  const [intent, metadata] = facts.map((fact) => fact.value);
  need(
    intent.state === "applied" &&
      same(intent.record, record, command) &&
      same(intent.record, expected, physical) &&
      same(metadata, expected, physical) &&
      same(intent.record, metadata, [
        "birthTicks",
        "cgroupDigest",
        "cgroupPath",
      ]) &&
      metadata.instanceId === config.instanceId &&
      metadata.kind === record.kind,
  );
  const before = await inspect(expected.containerId);
  await kernel(config, metadata);
  const after = await inspect(expected.containerId);
  await kernel(config, metadata);
  const repeated = await Promise.all(
    paths.map((path) => readFact(path, 65536)),
  );
  need(
    facts.every((fact, index) => fact.digest === repeated[index].digest) &&
      same(before, after, [...physical, "finishedAt"]) &&
      same(before, expected, birth) &&
      before.running === false &&
      before.hostPid === 0 &&
      before.paused === false &&
      before.restartPolicy === "no" &&
      before.restartCount === 0 &&
      before.oomKilled === false &&
      before.exitCode === 1 &&
      Number.isFinite(Date.parse(before.finishedAt)) &&
      Date.parse(before.finishedAt) >= Date.parse(expected.startedAt) &&
      Date.parse(before.finishedAt) <= clock(),
  );
  return {
    ...before,
    failedStartInert: true,
    normalExit: false,
    terminationDispatched: false,
    failedStartProof: {
      kind: "unregistered-supervisor-start-terminated",
      originalCommandId: record.commandId,
      originalResultDigest: digest(expected),
      originalSpecDigest: record.specDigest,
      startIntentDigest: facts[0].digest,
      startRecordDigest: facts[1].digest,
      terminalDigest: digest(
        Object.fromEntries(
          [...physical, "finishedAt"].map((key) => [key, before[key]]),
        ),
      ),
      kernelInert: true,
    },
  };
}
