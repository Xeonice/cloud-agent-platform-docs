import { join } from "node:path";
import { canonical, digest, invariant } from "./trust.mjs";
import { readSupervisorFact } from "./supervisor-control.mjs";
import { createCoordinatorIdentityReader, createCoordinatorInventory } from "./supervisor-inventory.mjs";

/** Read the same public roots, physical identities and receipts as the target
 * Supervisor before any original source stop. No private preparation proof is
 * a substitute for this fresh consumer. */
export async function assertMigrationPreStopInventory({ runtime: c, instanceId, lease, inspect, clock = Date.now }) {
  const started = clock(),
    config = (await readSupervisorFact(c.adapter.controlFoundationEntries.supervisor.configPath, 262144)).value,
    foundation = config.c, context = config.context,
    // These are the exact projections constructed by createIndependentFoundation
    // and passed to createCandidateSupervisor, not the target role's Env.
    root = context?.paths?.installer,
    controlEnv = { PLATFORM_CONTROL_RPC_KEY: context?.keys?.control },
    coordinatorEnv = { PLATFORM_CONTROLLER_RPC_KEY: context?.keys?.controller,
      UPGRADE_TRUST_ROOT_PATH: foundation?.trustRootPath };
  invariant(foundation?.instanceId === instanceId && foundation.foundationMode === "supervisor" &&
    foundation.root === c.adapter.root &&
    join(root ?? "", "processes") === c.legacyProcessRoot &&
    c.installedRolesRoot === join(foundation.root, "supervisor-publication/installed-roles") &&
    c.retiredCoordinatorRoot === join(foundation.root, "supervisor-publication/retired-coordinators") &&
    context?.keys?.control === c.keys.control && context?.keys?.controller === c.keys.controller &&
    foundation.trustRootPath === c.adapter.trustRootPath &&
    lease?.instance_id === instanceId && Number.isSafeInteger(lease.generation),
  "CONTROL_MIGRATION_PUBLIC_INVENTORY_CONFIG_CHANGED");
  const inventory = await createCoordinatorInventory({
    instanceId,
    processRoot: join(root, "processes"),
    registryPath: join(c.installedRolesRoot, "installed-roles.json"),
    retiredRoot: c.retiredCoordinatorRoot,
    legacyTrustRootPath: coordinatorEnv.UPGRADE_TRUST_ROOT_PATH ?? null,
    inspect: containerId => inspect({ containerId, role: "coordinator" }),
    readIdentity: createCoordinatorIdentityReader({ instanceId,
      controlKey: controlEnv.PLATFORM_CONTROL_RPC_KEY,
      controllerKey: coordinatorEnv.PLATFORM_CONTROLLER_RPC_KEY, clock }),
    clock,
    timeoutMs: 2000,
  })();
  invariant(Buffer.byteLength(canonical(inventory)) <= 262144,
    "CONTROL_MIGRATION_PUBLIC_INVENTORY_LIMIT");
  const expected = c.knownCoordinators?.map(row => row.containerId),
    actual = inventory.coordinators?.map(row => row.containerId);
  invariant(inventory.instanceId === instanceId && inventory.complete === true &&
    clock() - started >= 0 && clock() - started <= 2000 &&
    clock() - Date.parse(inventory.observedAt) >= 0 && clock() - Date.parse(inventory.observedAt) <= 2000 &&
    Array.isArray(expected) && expected.length > 0 && new Set(expected).size === expected.length &&
    Array.isArray(actual) && new Set(actual).size === actual.length &&
    canonical([...actual].sort()) === canonical([...expected].sort()),
  "CONTROL_MIGRATION_PUBLIC_INVENTORY_UNPROVEN");
  const source = c.source.coordinator,
    live = inventory.coordinators.filter(row => row.physical?.running === true),
    writer = live[0];
  invariant(live.length === 1 && writer.containerId === source.containerId &&
    writer.startIdentity === source.startIdentity && writer.artifactDigest === source.artifactDigest &&
    writer.physical.hostPid === source.hostPid && writer.physical.startedAt === source.startedAt &&
    writer.actualIdentity?.writerFenceValid === true && writer.actualIdentity.generation === lease.generation &&
    inventory.coordinators.every(row => row === writer ||
      (row.physical?.running === false && row.physical.hostPid === 0 && row.retiredPhysical)),
  "CONTROL_MIGRATION_PUBLIC_WRITER_UNPROVEN");
  return { kind: "control-migration-pre-stop-public-inventory", instanceId,
    observedAt: inventory.observedAt, coordinatorCount: actual.length,
    inventoryDigest: digest(inventory), sourceContainerId: source.containerId,
    sourceStartIdentity: source.startIdentity, writerGeneration: lease.generation,
    publicRoots: { processRoot: c.legacyProcessRoot,
      registryPath: join(c.installedRolesRoot, "installed-roles.json"), retiredRoot: c.retiredCoordinatorRoot } };
}
