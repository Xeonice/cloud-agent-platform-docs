import * as fs from "node:fs/promises";
import { join } from "node:path";
import { invariant, digest } from "./trust.mjs";
import { readSupervisorFact } from "./supervisor-control.mjs";
const CID = /^[a-f0-9]{64}$/,
  HASH = /^sha256:[a-f0-9]{64}$/;
const safeOrigin = (value) => {
  if (value === undefined) return undefined;
  const u = new URL(value);
  invariant(
    u.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) &&
      u.pathname === "/" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash,
    "COORDINATOR_INVENTORY_ORIGIN_UNKNOWN",
  );
  return u.origin;
};
/** Keys stay in Foundation RAM. Only the two existing role identity routes are allowed. */
export function createCoordinatorIdentityReader({
  instanceId,
  controllerKey,
  controlKey,
  fetcher = fetch,
  clock = Date.now,
}) {
  return async (record, { signal }) => {
    const metadataPath =
      record.metadataPath ??
      (record.managementOrigin
        ? "/internal/coordinator/identity"
        : "/internal/application/identity");
    invariant(
      [
        "/internal/coordinator/identity",
        "/internal/application/identity",
      ].includes(metadataPath),
      "COORDINATOR_METADATA_PATH_UNKNOWN",
    );
    const management = metadataPath === "/internal/coordinator/identity";
    const origin = safeOrigin(
      management
        ? (record.managementOrigin ?? record.origin)
        : (record.applicationOrigin ?? record.origin),
    );
    const key = management ? controllerKey : controlKey;
    invariant(
      origin && typeof key === "string" && key.length >= 32,
      "COORDINATOR_METADATA_AUTHORITY_UNKNOWN",
    );
    signal.throwIfAborted();
    // This is the time of a fresh direct GET, not a refreshed cached projection timestamp.
    const observedAt = new Date(clock()).toISOString();
    const response = await fetcher(origin + metadataPath, {
      method: "GET",
      headers: {
        "x-platform-internal-key": key,
        "x-platform-instance-id": instanceId,
      },
      redirect: "error",
      signal,
    });
    invariant(response.ok, "COORDINATOR_METADATA_UNAVAILABLE");
    const reader = response.body?.getReader();
    invariant(reader, "COORDINATOR_METADATA_UNKNOWN");
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        invariant(bytes <= 16384, "COORDINATOR_METADATA_LIMIT");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    signal.throwIfAborted();
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const generation = management
      ? value.generation
      : value.coordinatorGeneration;
    invariant(
      value.instanceId === instanceId &&
        (value.role === "coordinator" ||
          (management && value.role === "coordinator-prepared")) &&
        value.startIdentity === record.startIdentity &&
        value.artifactDigest === record.artifactDigest &&
        Number.isSafeInteger(generation) &&
        generation >= 0 &&
        Number.isSafeInteger(value.pid) &&
        value.pid > 0 &&
        typeof value.writerFenceValid === "boolean" &&
        (value.accepting === undefined || typeof value.accepting === "boolean"),
      "COORDINATOR_METADATA_IDENTITY_MISMATCH",
    );
    return {
      instanceId,
      startIdentity: value.startIdentity,
      artifactDigest: value.artifactDigest,
      generation,
      pid: value.pid,
      writerFenceValid: value.writerFenceValid,
      ...(value.accepting === undefined ? {} : { accepting: value.accepting }),
      observedAt,
    };
  };
}
/** Enumerates only two installation-owned record locations; never scans code or runtime state. */
export function createCoordinatorInventory({
  instanceId,
  processRoot,
  registryPath,
  retiredRoot,
  inspect,
  readIdentity,
  clock = Date.now,
  timeoutMs = 2000,
}) {
  invariant(
    Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2000,
    "COORDINATOR_INVENTORY_BUDGET_INVALID",
  );
  let active = null;
  async function collect(signal) {
    const missing = [],
      byId = new Map();
    let dropped = 0;
    const add = (r) => {
      if (r.kind !== "coordinator") return;
      if (
        r.instanceId !== instanceId ||
        !CID.test(r.containerId) ||
        typeof r.startIdentity !== "string" ||
        r.startIdentity.length < 16 ||
        !HASH.test(r.artifactDigest)
      ) {
        missing.push("COORDINATOR_RECORD_IDENTITY_UNKNOWN");
        return;
      }
      const prior = byId.get(r.containerId);
      if (
        prior &&
        ["startIdentity", "artifactDigest", "instanceId"].some(
          (k) => prior[k] !== r[k],
        )
      ) {
        missing.push("COORDINATOR_RECORD_CONFLICT");
        return;
      }
      byId.set(r.containerId, { ...prior, ...r });
    };
    try {
      const rows = (await readSupervisorFact(registryPath, 1048576)).value;
      invariant(
        Array.isArray(rows) && rows.length <= 256,
        "COORDINATOR_REGISTRY_LIMIT",
      );
      rows.forEach(add);
    } catch {
      missing.push("COORDINATOR_REGISTRY_UNKNOWN");
    }
    try {
      const names = await fs.readdir(processRoot, { withFileTypes: true });
      invariant(names.length <= 4096, "COORDINATOR_PROCESS_RECORD_LIMIT");
      const records = names.filter((n) => n.name.endsWith("-coordinator.json"));
      if (records.length > 128) {
        dropped += records.length - 128;
        missing.push("COORDINATOR_PROCESS_RECORD_LIMIT");
      } else
        for (const name of records) {
          signal.throwIfAborted();
          if (!name.isFile() || name.isSymbolicLink()) {
            missing.push("COORDINATOR_PROCESS_RECORD_UNKNOWN");
            continue;
          }
          try {
            add(
              (await readSupervisorFact(join(processRoot, name.name), 16384))
                .value,
            );
          } catch {
            missing.push("COORDINATOR_PROCESS_RECORD_UNKNOWN");
          }
        }
    } catch {
      missing.push("COORDINATOR_PROCESS_DIRECTORY_UNKNOWN");
    }
    if (byId.size > 128)
      return {
        instanceId,
        observedAt: new Date(clock()).toISOString(),
        coordinators: [],
        complete: false,
        dropped: byId.size - 128,
        missing: [...new Set([...missing, "COORDINATOR_INVENTORY_LIMIT"])],
      };
    const coordinators = [];
    for (const r of byId.values()) {
      signal.throwIfAborted();
      try {
        const physical = await inspect(r.containerId);
        signal.throwIfAborted();
        invariant(
          physical.containerId === r.containerId &&
            physical.startIdentity === r.startIdentity &&
            physical.artifactDigest === r.artifactDigest &&
            typeof physical.startedAt === "string" &&
            Number.isFinite(Date.parse(physical.startedAt)) &&
            typeof physical.running === "boolean" &&
            Number.isSafeInteger(physical.hostPid) &&
            physical.hostPid >= 0,
          "COORDINATOR_PHYSICAL_IDENTITY_UNKNOWN",
        );
        if (physical.running === false) {
          invariant(
            retiredRoot &&
              physical.hostPid === 0 &&
              physical.paused === false &&
              physical.restartPolicy === "no",
            "COORDINATOR_PROCESS_UNAVAILABLE",
          );
          const receipt = (
            await readSupervisorFact(
              join(retiredRoot, r.containerId + ".json"),
              16384,
            )
          ).value;
          const { receiptDigest, ...facts } = receipt;
          invariant(
            receipt.schemaVersion === 1 &&
              receipt.kind === "coordinator-normal-exit" &&
              receipt.instanceId === instanceId &&
              typeof receipt.migrationId === "string" &&
              receipt.migrationId.length > 0 &&
              typeof receipt.originalCommandId === "string" &&
              receipt.originalCommandId.length > 0 &&
              receiptDigest === digest(facts) &&
              Number.isFinite(Date.parse(receipt.exitedAt)) &&
              clock() - Date.parse(receipt.exitedAt) >= 0 &&
              receipt.target?.containerId === r.containerId &&
              receipt.target.startIdentity === r.startIdentity &&
              receipt.target.artifactDigest === r.artifactDigest &&
              receipt.target.DockerStartedAt === physical.startedAt &&
              Number.isSafeInteger(physical.restartCount) &&
              receipt.target.restartCount === physical.restartCount &&
              receipt.after?.running === false &&
              receipt.after.hostPid === 0 &&
              receipt.after.restartPolicy === "no" &&
              receipt.after.restartCount === physical.restartCount,
            "COORDINATOR_EXIT_RECEIPT_UNKNOWN",
          );
          const after = await inspect(r.containerId);
          signal.throwIfAborted();
          invariant(
            [
              "containerId",
              "startIdentity",
              "artifactDigest",
              "hostPid",
              "startedAt",
              "restartCount",
            ].every((k) => after[k] === physical[k]) &&
              after.running === false &&
              after.paused === false &&
              after.restartPolicy === "no",
            "COORDINATOR_EXIT_PHYSICAL_CHANGED",
          );
          coordinators.push({
            containerId: r.containerId,
            startIdentity: r.startIdentity,
            artifactDigest: r.artifactDigest,
            physical: {
              containerId: r.containerId,
              startIdentity: r.startIdentity,
              hostPid: 0,
              DockerStartedAt: physical.startedAt,
              startedAt: physical.startedAt,
              running: false,
              paused: false,
              restartCount: physical.restartCount,
              restartPolicy: "no",
            },
            retiredPhysical: {
              ...receipt,
              observedAt: new Date(clock()).toISOString(),
            },
          });
          continue;
        }
        invariant(
          physical.running === true &&
            physical.paused === false &&
            physical.hostPid > 0,
          "COORDINATOR_PROCESS_UNAVAILABLE",
        );
        const actualIdentity = await readIdentity(r, { signal });
        signal.throwIfAborted();
        invariant(
          actualIdentity.instanceId === instanceId &&
            actualIdentity.startIdentity === physical.startIdentity &&
            actualIdentity.artifactDigest === physical.artifactDigest &&
            Number.isSafeInteger(actualIdentity.generation) &&
            actualIdentity.generation >= 0 &&
            typeof actualIdentity.writerFenceValid === "boolean" &&
            Number.isFinite(Date.parse(actualIdentity.observedAt)) &&
            clock() - Date.parse(actualIdentity.observedAt) >= 0 &&
            clock() - Date.parse(actualIdentity.observedAt) <= 2000 &&
            (physical.pid === undefined || actualIdentity.pid === physical.pid),
          "COORDINATOR_LIVE_IDENTITY_UNKNOWN",
        );
        // A Docker restart preserves its labels. Compare birth before/after the identity GET.
        const after = await inspect(r.containerId);
        signal.throwIfAborted();
        invariant(
          [
            "containerId",
            "startIdentity",
            "artifactDigest",
            "hostPid",
            "startedAt",
          ].every((k) => after[k] === physical[k]) &&
            after.running === true &&
            after.paused === false,
          "COORDINATOR_PHYSICAL_IDENTITY_CHANGED",
        );
        coordinators.push({
          containerId: r.containerId,
          startIdentity: r.startIdentity,
          artifactDigest: r.artifactDigest,
          actualIdentity,
          origin: safeOrigin(r.origin),
          ...(r.managementOrigin
            ? { managementOrigin: safeOrigin(r.managementOrigin) }
            : {}),
          ...(r.applicationOrigin
            ? { applicationOrigin: safeOrigin(r.applicationOrigin) }
            : {}),
          physical: {
            containerId: physical.containerId,
            startIdentity: physical.startIdentity,
            hostPid: physical.hostPid,
            DockerStartedAt: physical.startedAt,
            startedAt: physical.startedAt,
            running: physical.running,
            paused: physical.paused ?? null,
            ...(physical.birthTicks ? { birthTicks: physical.birthTicks } : {}),
          },
        });
      } catch {
        missing.push("COORDINATOR_PHYSICAL_OR_LIVE_IDENTITY_UNKNOWN");
      }
    }
    return {
      instanceId,
      observedAt: new Date(clock()).toISOString(),
      coordinators,
      complete:
        missing.length === 0 &&
        dropped === 0 &&
        coordinators.length === byId.size,
      missing: [...new Set(missing)],
      dropped,
    };
  }
  return async () => {
    if (active)
      return {
        instanceId,
        observedAt: new Date(clock()).toISOString(),
        coordinators: [],
        complete: false,
        missing: ["COORDINATOR_INVENTORY_BUSY"],
        dropped: 0,
      };
    const abort = new AbortController();
    let timer;
    const task = collect(abort.signal);
    active = task;
    task.then(
      () => {
        if (active === task) active = null;
      },
      () => {
        if (active === task) active = null;
      },
    );
    try {
      return await Promise.race([
        task,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            abort.abort();
            resolve({
              instanceId,
              observedAt: new Date(clock()).toISOString(),
              coordinators: [],
              complete: false,
              missing: ["COORDINATOR_INVENTORY_TIMEOUT"],
              dropped: 0,
            });
          }, timeoutMs);
        }),
      ]);
    } catch {
      return {
        instanceId,
        observedAt: new Date(clock()).toISOString(),
        coordinators: [],
        complete: false,
        missing: ["COORDINATOR_INVENTORY_UNKNOWN"],
        dropped: 0,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
