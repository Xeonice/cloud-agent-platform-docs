import { canonical, digest, invariant } from "./trust.mjs";
import { atomicJson } from "./io.mjs";
import { readSupervisorFact } from "./supervisor-control.mjs";
import {
  capacityHostIdentity,
  capacityResidentIdentity,
  createControlCapacityCollector,
  sampleLinuxCapacity,
} from "./control-capacity-collector.mjs";
import { freezeCapacityBudget } from "./capacity-admission.mjs";
const physicalKeys = [
  "containerId",
  "pid",
  "birthTicks",
  "cgroupDigest",
  "startedAt",
  "restartCount",
  "instanceId",
  "role",
  "startIdentity",
  "artifactDigest",
];
const physical = (x) => Object.fromEntries(physicalKeys.map((k) => [k, x[k]]));
const inventory = (rows) =>
  rows.map(physical).sort((a, b) => a.containerId.localeCompare(b.containerId));
const same = (a, b) => canonical(a) === canonical(b);
const stopped = (p, target) =>
  p?.containerId === target.containerId &&
  p.startIdentity === target.startIdentity &&
  p.artifactDigest === target.artifactDigest &&
  p.startedAt === target.startedAt &&
  p.running === false &&
  p.paused === false &&
  p.hostPid === 0 &&
  p.restartPolicy === "no" &&
  p.restartCount === target.restartCount &&
  p.oomKilled === false &&
  [0, 143].includes(p.exitCode);
const limits = (plan) => ({
  limits: plan.limits,
  sourceDigest: plan.sourceDigest,
  maxObservationAgeMs: plan.maxObservationAgeMs,
  allocations: Object.fromEntries(
    Object.entries(plan.allocations).map(([category, rows]) => [
      category,
      rows.map(({ id, resources }) => ({ id, resources })),
    ]),
  ),
});

/** Migration-only accounting. Commands/targets are installed fixed data, never
 * caller-provided physical claims. Old reservations survive normal exits. */
export function createMigrationCapacity({
  sqlite,
  journal,
  instanceId,
  migrationId,
  initialPlanDigest,
  planPath,
  configPath,
  observationPath,
  deadline,
  actions,
  inspect,
  sample = sampleLinuxCapacity,
  clock = Date.now,
  write = atomicJson,
}) {
  invariant(
    sqlite &&
      journal?.lookup &&
      typeof inspect === "function" &&
      Array.isArray(actions) &&
      actions.length > 0 &&
      new Set(actions.map((a) => a.commandId)).size === actions.length,
    "CONTROL_MIGRATION_CAPACITY_CONFIG_INVALID",
  );
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS control_migration_capacity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),instance_id TEXT NOT NULL,migration_id TEXT NOT NULL,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS control_migration_capacity_receipts(command_id TEXT PRIMARY KEY,spec_digest TEXT NOT NULL,receipt TEXT NOT NULL)",
  );
  const load = () => {
    const row = sqlite
      .prepare("SELECT * FROM control_migration_capacity WHERE singleton=1")
      .get();
    if (!row) return null;
    invariant(
      row.instance_id === instanceId && row.migration_id === migrationId,
      "CONTROL_MIGRATION_CAPACITY_SCOPE_CHANGED",
    );
    return JSON.parse(row.data);
  };
  const save = (data) =>
    sqlite
      .prepare(
        "INSERT OR REPLACE INTO control_migration_capacity VALUES(1,?,?,?)",
      )
      .run(instanceId, migrationId, canonical(data));
  const files = async () => {
    const [p, c] = await Promise.all([
      readSupervisorFact(planPath, 1048576),
      readSupervisorFact(configPath, 1048576),
    ]);
    return { plan: p.value, config: c.value };
  };
  const signal = (config) => {
    invariant(clock() < deadline, "CONTROL_MIGRATION_DEADLINE_EXPIRED");
    return AbortSignal.timeout(
      Math.max(1, Math.min(config.timeoutMs, deadline - clock())),
    );
  };
  function fresh(actual) {
    invariant(
      actual &&
        Array.isArray(actual.containers) &&
        actual.containers.length <= 128 &&
        clock() >= actual.startedAt &&
        clock() - actual.startedAt <= 5000,
      "CONTROL_MIGRATION_CAPACITY_SAMPLE_STALE",
    );
  }
  function validateResidents(plan, config, actual) {
    fresh(actual);
    invariant(
      config.instanceId === instanceId &&
        config.observationPath === observationPath &&
        config.sourceDigest === plan.sourceDigest,
      "CONTROL_MIGRATION_CAPACITY_SCOPE_CHANGED",
    );
    createControlCapacityCollector({ config, sample, clock });
    const buckets = config.residents.flatMap((r) => r.containers);
    invariant(
      same(
        inventory(buckets),
        inventory(actual.containers.filter((r) => r.instanceId === instanceId)),
      ),
      "CONTROL_MIGRATION_CAPACITY_INVENTORY_CHANGED",
    );
    const allocations = Object.values(plan.allocations).flat();
    for (const r of config.residents) {
      const a = allocations.find((x) => x.id === r.id);
      invariant(
        a?.resident === true &&
          a.identityDigest === capacityResidentIdentity(r.containers),
        "CONTROL_MIGRATION_CAPACITY_RESIDENT_CHANGED",
      );
    }
    const overhead = allocations.find((a) => a.id === "host-overhead");
    invariant(
      overhead?.resident === true &&
        overhead.identityDigest === capacityHostIdentity(actual, instanceId),
      "CONTROL_MIGRATION_CAPACITY_HOST_CHANGED",
    );
    invariant(
      allocations.filter((a) => a.resident).length ===
        config.residents.length + 1,
      "CONTROL_MIGRATION_CAPACITY_RESIDENT_CHANGED",
    );
  }
  async function ensure() {
    const state = load();
    if (state) {
      if (state.pending) await finish(state);
      const current = load(),
        f = await files();
      invariant(
        digest(f.plan) === current.planHash &&
          digest(f.config) === current.configHash,
        "CONTROL_MIGRATION_CAPACITY_CHAIN_CHANGED",
      );
      return current;
    }
    const { plan, config } = await files();
    invariant(
      plan.planDigest === initialPlanDigest &&
        freezeCapacityBudget(plan).planDigest === initialPlanDigest,
      "CONTROL_MIGRATION_CAPACITY_PLAN_CHANGED",
    );
    const actual = await sample(config, { signal: signal(config), clock });
    validateResidents(plan, config, actual);
    const current = {
      schemaVersion: 1,
      initialPlanDigest,
      initialConfigDigest: digest(config),
      peak: limits(plan),
      planHash: digest(plan),
      configHash: digest(config),
      planDigest: plan.planDigest,
      inventory: inventory(actual.containers),
      sampleScope: {
        vmBootId: actual.vmBootId,
        procIdentity: actual.procIdentity,
        devices: actual.devices.map(({ id, dev, majorMinor }) => ({
          id,
          dev,
          majorMinor,
        })),
      },
      sequence: 0,
      chainDigest: digest({
        migrationId,
        initialPlanDigest,
        configDigest: digest(config),
        inventory: inventory(actual.containers),
      }),
    };
    save(current);
    return current;
  }
  async function finish(state) {
    const p = state.pending,
      { plan, config } = await files();
    invariant(
      [p.oldPlanHash, digest(p.nextPlan)].includes(digest(plan)) &&
        [p.oldConfigHash, digest(p.nextConfig)].includes(digest(config)),
      "CONTROL_MIGRATION_CAPACITY_PUBLICATION_CHANGED",
    );
    const before = await inspect(p.target),
      current = await sample(p.nextConfig, {
        signal: signal(p.nextConfig),
        clock,
      }),
      after = await inspect(p.target);
    fresh(current);
    invariant(
      p.direction === "stop"
        ? [before, after].every((x) => stopped(x, p.target))
        : [before, after].every(
            (x) =>
              x.running === true &&
              x.paused === false &&
              [
                "containerId",
                "startIdentity",
                "artifactDigest",
                "startedAt",
                "hostPid",
              ].every((k) => x[k] === p.target[k]),
          ),
      "CONTROL_MIGRATION_CAPACITY_PHYSICAL_CHANGED",
    );
    invariant(
      same(inventory(current.containers), p.nextInventory) &&
        same(
          {
            vmBootId: current.vmBootId,
            procIdentity: current.procIdentity,
            devices: current.devices.map(({ id, dev, majorMinor }) => ({
              id,
              dev,
              majorMinor,
            })),
          },
          state.sampleScope,
        ),
      "CONTROL_MIGRATION_CAPACITY_INVENTORY_CHANGED",
    );
    if (!same(plan, p.nextPlan)) await write(planPath, p.nextPlan);
    if (!same(config, p.nextConfig)) await write(configPath, p.nextConfig);
    const receipt = {
      instanceId,
      migrationId,
      operationId: migrationId,
      commandId: p.commandId,
      specDigest: p.specDigest,
      oldPlanDigest: state.planDigest,
      planDigest: p.nextPlan.planDigest,
      sequence: state.sequence + 1,
      physical: p.physical,
      observedAt: new Date(current.startedAt).toISOString(),
    };
    const next = {
      ...state,
      planHash: digest(p.nextPlan),
      configHash: digest(p.nextConfig),
      planDigest: p.nextPlan.planDigest,
      inventory: p.nextInventory,
      sequence: receipt.sequence,
      chainDigest: digest({ prior: state.chainDigest, receipt }),
    };
    delete next.pending;
    sqlite
      .transaction(() => {
        sqlite
          .prepare(
            "INSERT OR REPLACE INTO control_migration_capacity_receipts VALUES(?,?,?)",
          )
          .run(p.commandId, p.specDigest, canonical(receipt));
        save(next);
      })
      .immediate();
    return receipt;
  }
  async function register({ operationId, commandId }) {
    invariant(
      operationId === migrationId,
      "CONTROL_MIGRATION_CAPACITY_SCOPE_CHANGED",
    );
    let state = await ensure();
    const action = actions.find((a) => a.commandId === commandId),
      row = journal.lookup({ operationId, commandId });
    invariant(
      action &&
        row?.state === "applied" &&
        row.specDigest === digest(row.spec) &&
        row.spec.targetDigest ===
          (action.targetDigest ??
            digest(
              journal.lookup({ operationId, commandId: action.startCommandId })
                ?.result,
            )) &&
        row.spec.deadline === action.deadline,
      "CONTROL_MIGRATION_CAPACITY_APPLIED_COMMAND_REQUIRED",
    );
    const prior = sqlite
      .prepare(
        "SELECT * FROM control_migration_capacity_receipts WHERE command_id=?",
      )
      .get(commandId);
    if (prior) {
      invariant(
        prior.spec_digest === row.specDigest,
        "CONTROL_MIGRATION_CAPACITY_COMMAND_CHANGED",
      );
      return JSON.parse(prior.receipt);
    }
    const { plan, config } = await files(),
      nextPlan = structuredClone(plan),
      nextConfig = structuredClone(config),
      target =
        action.direction === "stop"
          ? (action.target ??
            journal.lookup({ operationId, commandId: action.startCommandId })
              ?.result)
          : row.result;
    invariant(
      [
        "foundation",
        "installer",
        "coordinator",
        "api",
        "control-agent",
        "control-entry",
        "control-supervisor",
      ].includes(action.role) && target?.role === action.role,
      "CONTROL_MIGRATION_CAPACITY_ROLE_FORBIDDEN",
    );
    const first = await inspect(target),
      actual = await sample(config, { signal: signal(config), clock }),
      second = await inspect(target);
    fresh(actual);
    let nextInventory, observed;
    const all = Object.values(nextPlan.allocations).flat(),
      allocation = all.find((a) => a.id === action.allocationId),
      bucket = nextConfig.residents.find((r) => r.id === action.allocationId);
    invariant(
      (allocation && action.allocationId !== "host-overhead") ||
        (action.role === "foundation" &&
          (action.direction === "stop" || action.restore === true) &&
          allocation),
      "CONTROL_MIGRATION_CAPACITY_ALLOCATION_CHANGED",
    );
    if (action.direction === "stop") {
      invariant(
        stopped(first, target) &&
          stopped(second, target) &&
          stopped(row.result, target),
        "CONTROL_MIGRATION_CAPACITY_STOP_UNKNOWN",
      );
      const before = state.inventory.find(
        (x) => x.containerId === target.containerId,
      );
      invariant(
        before &&
          before.pid === target.hostPid &&
          before.startedAt === target.startedAt &&
          !actual.containers.some((x) => x.containerId === target.containerId),
        "CONTROL_MIGRATION_CAPACITY_STOP_UNKNOWN",
      );
      if (action.allocationId !== "host-overhead") {
        invariant(
          allocation.resident === true &&
            bucket?.containers.some(
              (x) => x.containerId === target.containerId,
            ),
          "CONTROL_MIGRATION_CAPACITY_ALLOCATION_CHANGED",
        );
        bucket.containers = bucket.containers.filter(
          (x) => x.containerId !== target.containerId,
        );
        if (bucket.containers.length)
          allocation.identityDigest = capacityResidentIdentity(
            bucket.containers,
          );
        else {
          nextConfig.residents = nextConfig.residents.filter(
            (x) => x.id !== bucket.id,
          );
          allocation.resident = false;
        }
      } else
        invariant(
          before.instanceId !== instanceId,
          "CONTROL_MIGRATION_CAPACITY_ALLOCATION_CHANGED",
        );
      nextInventory = state.inventory.filter(
        (x) => x.containerId !== target.containerId,
      );
      observed = first;
    } else {
      const found = actual.containers.find(
        (x) => x.containerId === target.containerId,
      );
      const legacyFoundation =
        action.role === "foundation" &&
        action.restore === true &&
        action.allocationId === "host-overhead";
      invariant(
        found &&
          (legacyFoundation
            ? found.instanceId !== instanceId
            : found.instanceId === instanceId &&
              found.role === action.role &&
              found.startIdentity === target.startIdentity &&
              found.artifactDigest === target.artifactDigest) &&
          found.pid === target.hostPid &&
          found.startedAt === target.startedAt &&
          [first, second].every(
            (x) =>
              x.running === true &&
              x.paused === false &&
              x.containerId === found.containerId &&
              x.hostPid === found.pid &&
              x.startIdentity ===
                (legacyFoundation
                  ? target.startIdentity
                  : found.startIdentity) &&
              x.artifactDigest ===
                (legacyFoundation
                  ? target.artifactDigest
                  : found.artifactDigest) &&
              x.startedAt === found.startedAt,
          ) &&
          !state.inventory.some((x) => x.containerId === target.containerId),
        "CONTROL_MIGRATION_CAPACITY_START_UNKNOWN",
      );
      if (legacyFoundation) {
      } else if (bucket) {
        invariant(
          action.restore === true && allocation.resident === true,
          "CONTROL_MIGRATION_CAPACITY_ALLOCATION_CHANGED",
        );
        bucket.containers.push(physical(found));
      } else {
        invariant(
          allocation.resident === false,
          "CONTROL_MIGRATION_CAPACITY_ALLOCATION_CHANGED",
        );
        nextConfig.residents.push({
          id: allocation.id,
          containers: [physical(found)],
        });
        allocation.resident = true;
      }
      if (!legacyFoundation)
        allocation.identityDigest = capacityResidentIdentity(
          nextConfig.residents.find((r) => r.id === allocation.id).containers,
        );
      nextInventory = inventory([...state.inventory, physical(found)]);
      observed = physical(found);
    }
    invariant(
      same(inventory(actual.containers), nextInventory),
      "CONTROL_MIGRATION_CAPACITY_INVENTORY_CHANGED",
    );
    const overhead = all.find((a) => a.id === "host-overhead");
    overhead.identityDigest = capacityHostIdentity(actual, instanceId);
    const frozen = freezeCapacityBudget(nextPlan);
    invariant(
      same(limits(frozen), state.peak),
      "CONTROL_MIGRATION_CAPACITY_PEAK_CHANGED",
    );
    validateResidents(frozen, nextConfig, actual);
    state = {
      ...state,
      pending: {
        commandId,
        specDigest: row.specDigest,
        oldPlanHash: digest(plan),
        oldConfigHash: digest(config),
        nextPlan: frozen,
        nextConfig,
        nextInventory,
        physical: observed,
        target,
        direction: action.direction,
      },
    };
    save(state);
    return finish(state);
  }
  async function collect() {
    const state = await ensure(),
      { plan, config } = await files();
    const old = await readSupervisorFact(observationPath, 1048576).catch(
      (e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      },
    );
    const revision = old?.value?.revision ?? 0;
    const observation = await createControlCapacityCollector({
      config,
      sample,
      clock,
    }).collect({ plan, expectedRevision: revision, signal: signal(config) });
    invariant(
      observation.known === true,
      observation.reason ?? "CONTROL_MIGRATION_CAPACITY_UNKNOWN",
    );
    return { planDigest: state.planDigest, sequence: state.sequence };
  }
  return { initialize: ensure, register, collect, status: () => load() };
}
