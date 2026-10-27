import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { command } from "../../deploy/upgrade/artifacts.mjs";
import { readJson } from "../../deploy/upgrade/io.mjs";
import { digest, invariant } from "../../deploy/upgrade/trust.mjs";

const physicalFields =
  '{"containerId":{{json .Id}},"imageDigest":{{json .Image}},"running":{{json .State.Running}},"hostPid":{{json .State.Pid}},"startedAt":{{json .State.StartedAt}},"instanceId":{{json (index .Config.Labels "agent-platform.instance")}},"installationDigest":{{json (index .Config.Labels "agent-platform.installation")}},"role":{{json (index .Config.Labels "agent-platform.role")}},"startIdentity":{{json (index .Config.Labels "agent-platform.start")}}}';

async function inspectContainers(config, ids) {
  return (
    await command(config.docker.cli || "docker", [
      ...config.docker.args,
      "inspect",
      "--format",
      physicalFields,
      ...ids,
    ])
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function matchesPhysicalRecord(row, record, config) {
  return (
    row.containerId === record.containerId &&
    row.imageDigest === record.imageDigest &&
    row.startIdentity === record.startIdentity &&
    row.startedAt === record.startedAt &&
    row.role === (record.role || record.kind) &&
    row.instanceId === config.instanceId &&
    row.installationDigest === digest(resolve(config.root)) &&
    typeof row.running === "boolean" &&
    Number.isSafeInteger(row.hostPid) &&
    row.hostPid >= 0
  );
}

// Mirror the harness's currentController selection, while refusing an authority
// or owned record that cannot bind the precise Docker incarnation.
async function currentControllerIncarnation(harness, config) {
  invariant(
    harness.instanceId === config.instanceId &&
      resolve(harness.root) === resolve(config.root) &&
      config.docker?.dedicated === true,
    "CLEANUP_CONTROLLER_SCOPE_UNKNOWN",
  );
  const authority = await readJson(
    join(config.root, "installer", "controller-authority.json"),
    null,
  );
  let record;
  if (!authority?.attemptId) {
    // Initial metadata is a cache: startController replaces this owned record
    // before currentInstaller refreshes that cache after a genuine restart.
    record = harness.roleContainers?.controller;
    invariant(
      record &&
        (!authority ||
          (authority.instanceId === config.instanceId &&
            authority.role === "installer" &&
            authority.artifactDigest ===
              config.initialRelease?.components.installer.artifactDigest &&
            authority.inputFingerprint ===
              config.initialRelease?.components.installer.inputFingerprint)),
      "CLEANUP_CONTROLLER_AUTHORITY_UNKNOWN",
    );
  } else {
    const owned = harness.supervisor
      .ownedProcesses()
      .filter(
        (row) =>
          row.kind === "installer" &&
          row.startIdentity === authority.startIdentity,
      );
    invariant(owned.length === 1, "CLEANUP_CONTROLLER_AUTHORITY_UNKNOWN");
    record = owned[0];
    invariant(
      authority.kind === "installer" &&
        authority.instanceId === config.instanceId &&
        record.instanceId === config.instanceId &&
        record.attemptId === authority.attemptId &&
        [
          "containerId",
          "imageDigest",
          "startedAt",
          "artifactDigest",
          "inputFingerprint",
        ].every(
          (key) =>
            typeof authority[key] === "string" &&
            authority[key] === record[key],
        ),
      "CLEANUP_CONTROLLER_AUTHORITY_UNKNOWN",
    );
  }
  invariant(
    /^[a-f0-9]{64}$/.test(record.containerId) &&
      /^sha256:[a-f0-9]{64}$/.test(record.imageDigest) &&
      typeof record.startIdentity === "string" &&
      record.startIdentity.length > 0 &&
      typeof record.startedAt === "string" &&
      Number.isFinite(Date.parse(record.startedAt)) &&
      (record.role || record.kind) === "installer",
    "CLEANUP_CONTROLLER_IDENTITY_UNKNOWN",
  );
  return {
    containerId: record.containerId,
    imageDigest: record.imageDigest,
    startIdentity: record.startIdentity,
    startedAt: record.startedAt,
    role: "installer",
    attemptId: authority?.attemptId || null,
    artifactDigest:
      authority?.artifactDigest ||
      config.initialRelease?.components.installer.artifactDigest ||
      null,
    inputFingerprint:
      authority?.inputFingerprint ||
      config.initialRelease?.components.installer.inputFingerprint ||
      null,
  };
}

function harnessListenersOpen(harness) {
  return (
    harness.supervisor?.server?.listening === true &&
    harness.entry?.server?.listening === true &&
    harness.entry?.control?.listening === true
  );
}

async function observeCurrentController(harness, config, expected) {
  const current = await currentControllerIncarnation(harness, config);
  invariant(
    digest(current) === digest(expected),
    "CLEANUP_CONTROLLER_INCARNATION_CHANGED",
  );
  const rows = await inspectContainers(config, [current.containerId]);
  invariant(
    rows.length === 1 && matchesPhysicalRecord(rows[0], current, config),
    "CLEANUP_CONTROLLER_PHYSICAL_IDENTITY_CHANGED",
  );
  // Authority could change while Docker is responding; it is not a lease.
  invariant(
    digest(await currentControllerIncarnation(harness, config)) ===
      digest(expected),
    "CLEANUP_CONTROLLER_INCARNATION_CHANGED",
  );
  return rows[0];
}

async function closeHarness(harness, config, resourcesCleaned) {
  if (harness?.isolation !== "containers") {
    await harness?.close({ resourcesCleaned });
    return null;
  }
  const current = await currentControllerIncarnation(harness, config);
  await observeCurrentController(harness, config, current);
  const listenersWereOpen = harnessListenersOpen(harness);
  try {
    await harness.close({ resourcesCleaned });
    return null;
  } catch (error) {
    // Only the first stop failed. Later failures must not rerun earlier stops.
    if (
      error.code !== "OWNED_CONTAINER_STOP_UNCONFIRMED" ||
      !/\bstopCurrentController\s*\([^\n]*e2e-contract[/\\]server[/\\]start-upgrade\.mjs:/.test(
        error.stack || "",
      ) ||
      !listenersWereOpen ||
      !harnessListenersOpen(harness)
    )
      throw error;
    const started = Date.now(),
      deadline = started + 30000;
    let row;
    try {
      while (true) {
        invariant(
          harnessListenersOpen(harness),
          "CLEANUP_HARNESS_CLOSE_ALREADY_ADVANCED",
        );
        row = await observeCurrentController(harness, config, current);
        if (row.running === false && row.hostPid === 0) {
          invariant(
            harnessListenersOpen(harness),
            "CLEANUP_HARNESS_CLOSE_ALREADY_ADVANCED",
          );
          break;
        }
        invariant(Date.now() < deadline, "CLEANUP_CONTROLLER_EXIT_UNCONFIRMED");
        await delay(50); // Read-only observation after the already issued TERM.
      }
    } catch (observationError) {
      error.cleanupObservation = {
        preserved: true,
        code: observationError.code || "CLEANUP_CONTROLLER_OBSERVATION_FAILED",
      };
      throw error;
    }
    // Docker adapter.signal returns immediately for this physically off record.
    // The remaining harness steps have not run; no extra signal or SDK teardown
    // is performed here. Unclean business resources keep every other role alive.
    await harness.close({ resourcesCleaned });
    return {
      ...row,
      observedAt: new Date().toISOString(),
      waitMs: Date.now() - started,
      priorCode: error.code,
      signalAlreadySent: "SIGTERM",
    };
  }
}

/** Cleanup follows observed business deletion; no SDK construction or extra kill. */
export async function closeQualifiedInstallation({
  harness,
  fixture,
  resourcesCleaned = false,
}) {
  let rolesStopped = false,
    roleStops = [],
    controllerExitObservation = null;
  try {
    controllerExitObservation = await closeHarness(
      harness,
      fixture?.config,
      resourcesCleaned,
    );
    if (resourcesCleaned) {
      const config = fixture.config;
      invariant(
        harness?.isolation === "containers" &&
          config.docker?.dedicated === true,
        "ACTUAL_OWNED_CONTAINER_CLEANUP_REQUIRED",
      );
      const records = [
        ...Object.values(harness.roleContainers),
        ...harness.supervisor.ownedProcesses(),
      ];
      const ids = [...new Set(records.map((record) => record.containerId))];
      invariant(
        ids.length > 0 && ids.every((id) => /^[a-f0-9]{64}$/.test(id)),
        "CLEANUP_CONTAINER_IDENTITY_UNKNOWN",
      );
      const deadline = Date.now() + 10000;
      while (true) {
        const rows = await inspectContainers(config, ids);
        invariant(
          rows.length === ids.length &&
            new Set(rows.map((row) => row.containerId)).size === ids.length &&
            rows.every(
              (row) =>
                ids.includes(row.containerId) &&
                records.some((record) =>
                  matchesPhysicalRecord(row, record, config),
                ),
            ),
          "CLEANUP_PHYSICAL_IDENTITY_CHANGED",
        );
        if (rows.every((row) => row.running === false && row.hostPid === 0)) {
          rolesStopped = true;
          roleStops = rows.map(
            ({ installationDigest, instanceId, ...row }) => ({
              ...row,
              observedAt: new Date().toISOString(),
            }),
          );
          break;
        }
        invariant(Date.now() < deadline, "OWNED_ROLE_EXIT_UNCONFIRMED");
        await delay(50); // Observation only: no repeated stop or forced signal.
      }
    }
  } finally {
    // Unknown/failed stopping preserves the loop mount. The filesystem helper
    // independently checks actual bindings before it can unmount a successful case.
    await fixture?.close({
      resourcesCleaned: resourcesCleaned && rolesStopped,
    });
  }
  return {
    resourcesCleaned,
    rolesStopped,
    roleStops,
    controllerExitObservation,
    preserved: !resourcesCleaned,
  };
}
