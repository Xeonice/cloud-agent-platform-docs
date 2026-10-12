import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { command } from "../../deploy/upgrade/artifacts.mjs";
import { digest, invariant } from "../../deploy/upgrade/trust.mjs";

const physicalFields =
  '{"containerId":{{json .Id}},"imageDigest":{{json .Image}},"running":{{json .State.Running}},"instanceId":{{json (index .Config.Labels "agent-platform.instance")}},"installationDigest":{{json (index .Config.Labels "agent-platform.installation")}},"role":{{json (index .Config.Labels "agent-platform.role")}},"startIdentity":{{json (index .Config.Labels "agent-platform.start")}}}';

/** Cleanup follows observed business deletion; no SDK construction or extra kill. */
export async function closeQualifiedInstallation({
  harness,
  fixture,
  resourcesCleaned = false,
}) {
  let rolesStopped = false,
    roleStops = [];
  try {
    await harness?.close({ resourcesCleaned });
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
        const rows = (
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
        invariant(
          rows.length === ids.length &&
            new Set(rows.map((row) => row.containerId)).size === ids.length &&
            rows.every(
              (row) =>
                ids.includes(row.containerId) &&
                row.instanceId === config.instanceId &&
                row.installationDigest === digest(resolve(config.root)) &&
                records.some(
                  (record) =>
                    record.containerId === row.containerId &&
                    record.imageDigest === row.imageDigest,
                ) &&
                typeof row.running === "boolean",
            ),
          "CLEANUP_PHYSICAL_IDENTITY_CHANGED",
        );
        if (rows.every((row) => row.running === false)) {
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
    preserved: !resourcesCleaned,
  };
}
