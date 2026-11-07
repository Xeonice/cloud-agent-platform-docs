import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { createSupervisorControl } from "../upgrade/supervisor-control.mjs";
import { createSupervisorControlRuntime } from "../upgrade/supervisor-control-runtime.mjs";
import { createCandidateSupervisor } from "../upgrade/candidate-supervisor.mjs";
import {
  createControlMaintenanceClient,
  runControlMaintenanceClient,
} from "../upgrade/control-maintenance-client.mjs";
import { createControlAuthority } from "../upgrade/control-authority.mjs";
import { createControlRecoveryStore } from "../upgrade/control-recovery-store.mjs";
import { createControlCommandJournal } from "../upgrade/control-command-journal.mjs";
import {
  freezeCapacityBudget,
  evaluateCapacityAdmission,
} from "../upgrade/capacity-admission.mjs";
import {
  capacityResidentIdentity,
  capacityHostIdentity,
} from "../upgrade/control-capacity-collector.mjs";
import { digest, canonical } from "../upgrade/trust.mjs";
import { atomicJson, treeManifest, fileDigest } from "../upgrade/io.mjs";
const requireApi = createRequire(
    new URL("../../api/package.json", import.meta.url),
  ),
  Database = requireApi("better-sqlite3");
const vector = (memoryBytes, cpuMilliCores, ioBytesPerSecond) => ({
  memoryBytes,
  cpuMilliCores,
  ioBytesPerSecond,
  disks: { data: 0 },
});

export async function fixture(
  t,
  withMaintenance = false,
  withReservations = false,
  options = {},
) {
  const root = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), "supervisor-runtime-")),
    ),
    cleanup = [];
  let supervisor, runtime, controlDb;
  t.after(async () => {
    for (const close of cleanup) await close();
    await runtime?.close();
    supervisor?.close();
    controlDb?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const now = options.now ?? Date.parse("2026-10-20T12:00:00Z"),
    instanceId = options.instanceId ?? "runtime-instance";
  const physical = (n, role, memoryBytes) => ({
    containerId: String(n).repeat(64),
    pid: 100 + n,
    hostPid: 100 + n,
    birthTicks: String(1000 + n),
    cgroupDigest: digest("cg-" + n),
    startedAt: new Date(now - 10000).toISOString(),
    restartCount: 0,
    instanceId,
    role,
    startIdentity: "original-birth-" + n,
    artifactDigest: digest("artifact-" + n),
    running: true,
    paused: false,
    restartPolicy: "no",
    oomKilled: false,
    exitCode: 0,
    memoryBytes,
  });
  const source = physical(1, "coordinator", 1000),
    agent = physical(2, "control-agent", 500),
    running = new Map([
      [source.containerId, source],
      [agent.containerId, agent],
    ]);
  let calls = 0,
    starts = 0,
    stops = 0,
    releaseStop = null,
    stopReached;
  const stopped = new Promise((ok) => {
    stopReached = ok;
  });
  // Explicit state/counter fixtures. No test here claims Linux/Docker or IO
  // qualification. The runtime still invokes the actual collector and journal.
  const sample = async () => {
    const n = ++calls;
    return {
      vmBootId: "00112233-4455-6677-8899-aabbccddeeff",
      procIdentity: { path: "/host/proc", dev: "11", ino: "2" },
      cpu: { cpus: 4, total: 1000 + n * 400, idle: 500 + n * 300 },
      memory: {
        total: 10000,
        free:
          8500 - [...running.values()].reduce((s, r) => s + r.memoryBytes, 0),
        available:
          8500 - [...running.values()].reduce((s, r) => s + r.memoryBytes, 0),
      },
      devices: [
        {
          id: "data",
          dev: "2049",
          majorMinor: "8:1",
          capacityBytes: 100000,
          freeBytes: 80000,
          availableBytes: 80000,
          readBytes: 1000 + n * 500,
          writeBytes: 1000,
        },
      ],
      containers: [...running.values()].map((row) => ({
        ...row,
        cpuNs: 100000000 + n * 5000000,
        ioBytes: 1000 + n * 100,
        monotonic: n * 250,
      })),
      startedAt: now - 500,
      finishedAt: now - 50,
      monotonic: n * 250,
    };
  };
  const baseline = await sample(),
    config = {
      schemaVersion: 1,
      instanceId,
      sourceDigest: digest("base-source"),
      hostProcRoot: "/host/proc",
      dockerSocketPath: "/test/docker.sock",
      devices: [{ id: "data", path: "/data", dev: "2049", majorMinor: "8:1" }],
      residents: [
        { id: "source", containers: [source] },
        { id: "agent", containers: [agent] },
      ],
      ioEffectiveBudgetBytesPerSecond: 10000,
      ioQualificationPath: join(root, "io.json"),
      ioQualificationRawDigest: digest("pending"),
      observationPath: join(root, "observation.json"),
      sampleIntervalMs: 250,
      timeoutMs: 2000,
    };
  const io = {
    schemaVersion: 1,
    kind: "control-io-qualification",
    instanceId,
    vmBootId: baseline.vmBootId,
    devices: [{ id: "data", dev: "2049", majorMinor: "8:1" }],
    effectiveBudgetBytesPerSecond: 10000,
    windowMs: 60000,
    observedAt: new Date(now - 60000).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    qualified: true,
    measurement: {
      readBytes: 600000,
      writeBytes: 0,
      maxLatencyMs: 1,
      samples: 600,
      unexpectedErrors: 0,
    },
  };
  const ioRaw = JSON.stringify({ ...io, receiptDigest: digest(io) });
  config.ioQualificationRawDigest = digest(ioRaw);
  await fs.writeFile(config.ioQualificationPath, ioRaw, { mode: 0o600 });
  const reserve = (id, resources) => ({
    id,
    resources,
    resident: false,
    identityDigest: digest(id),
  });
  const resident = (id, row, resources) => ({
    id,
    resources,
    resident: true,
    identityDigest: capacityResidentIdentity([row]),
  });
  const plan = freezeCapacityBudget({
    instanceId,
    sourceDigest: config.sourceDigest,
    maxObservationAgeMs: 5000,
    limits: { ...vector(10000, 4000, 10000), disks: { data: 100000 } },
    allocations: {
      source: [
        resident("source", source, vector(1200, 100, 500)),
        {
          id: "host-overhead",
          resident: true,
          identityDigest: capacityHostIdentity(baseline, instanceId),
          resources: { ...vector(2000, 1500, 2000), disks: { data: 25000 } },
        },
      ],
      retainedOwners: [],
      retainedGuests: [],
      existingCandidates: [],
      candidate: [reserve("new-api", vector(1000, 500, 1000))],
      verification: [],
      control: [resident("agent", agent, vector(700, 100, 500))],
      recovery: [reserve("recovery", vector(1000, 500, 500))],
    },
  });
  const stable = {
    origin: "http://127.0.0.1:1",
    key: "c".repeat(32),
    accessKey: "a".repeat(32),
    maintenanceKey: "m".repeat(32),
    statePath: join(root, "supervisor.db"),
    controlDbPath: join(root, "ledger/control.db"),
    capacityPlanPath: join(root, "plan.json"),
    capacityCollectorConfigPath: join(root, "collector.json"),
    capacityTransitionRoot: join(root, "transitions"),
    resourceObservationPath: config.observationPath,
    referenceStatePath: join(root, "references.json"),
    agentStartIdentity: agent.startIdentity,
  };
  await atomicJson(stable.capacityPlanPath, plan);
  await atomicJson(stable.capacityCollectorConfigPath, config);
  await atomicJson(stable.referenceStatePath, { instanceId, candidates: [] });
  let authority, packages, lifecycle;
  if (withMaintenance) {
    await fs.mkdir(join(root, "ledger"));
    controlDb = new Database(stable.controlDbPath);
    await fs.chmod(stable.controlDbPath, 0o600);
    requireApi(
      resolve("api/apps/api/dist/platform/upgrade/control-store-factory.js"),
    ).createUpgradeControlStores({
      sqlite: controlDb,
      instanceId,
      clock: { now: () => new Date(now) },
      ids: { next: randomUUID },
    });
    authority = createControlAuthority({
      sqlite: controlDb,
      instanceId,
      epochFloor: 5,
      clock: () => now,
    });
    authority.activate({
      expectedRevision: 1,
      sourceBindingDigest: plan.sourceDigest,
    });
    createControlRecoveryStore({
      sqlite: controlDb,
      instanceId,
      clock: () => now,
    });
    createControlCommandJournal({
      sqlite: controlDb,
      instanceId,
      assertAuthority: () => {},
      clock: () => now,
    });
    const keys = generateKeyPairSync("ed25519"),
      trust = join(root, "trust.json");
    await atomicJson(trust, {
      schemaVersion: 1,
      keys: [
        {
          id: "test",
          publicKey: keys.publicKey.export({ format: "pem", type: "spki" }),
        },
      ],
    });
    packages = {};
    for (const which of ["old", "new"]) {
      const artifactRoot = join(root, which),
        dist = join(artifactRoot, "api/apps/api/dist/platform/upgrade");
      await fs.mkdir(dist, { recursive: true });
      await fs.mkdir(join(artifactRoot, "installer"));
      await fs.writeFile(
        join(dist, "control-store-factory.js"),
        "exports.fixture=true;",
      );
      await fs.writeFile(
        join(dist, "control-store-schema.js"),
        "exports.UPGRADE_CONTROL_SCHEMA_VERSION=1;",
      );
      await fs.writeFile(
        join(artifactRoot, "api/apps/api/package.json"),
        '{"type":"commonjs"}',
      );
      await fs.writeFile(
        join(artifactRoot, "installer/control-main.mjs"),
        "export const fixture=" + JSON.stringify(which),
      );
      const files = await treeManifest(artifactRoot),
        engine = digest(
          files.filter((row) => row.path.startsWith("installer/")),
        ),
        version = which === "old" ? "v1.0.0" : "v1.0.1";
      const manifest = {
          schemaVersion: 1,
          kind: "upgrade-control",
          protocolVersion: 1,
          apiRevision: "a".repeat(40),
          projectRevision: "b".repeat(40),
          executionEngineDigest: engine,
          treeDigest: digest(files),
          version,
        },
        manifestPath = join(root, which + ".signed.json");
      await atomicJson(manifestPath, {
        manifest,
        manifestDigest: digest(manifest),
        signature: {
          algorithm: "Ed25519",
          keyId: "test",
          value: sign(
            null,
            Buffer.from(canonical(manifest)),
            keys.privateKey,
          ).toString("base64"),
        },
      });
      const configPath = join(root, which + ".config.json");
      await atomicJson(configPath, {
        instanceId,
        startIdentity:
          which === "old" ? agent.startIdentity : "new-control-birth",
        controlArtifactRoot: artifactRoot,
        controlManifestPath: manifestPath,
        trustRootPath: trust,
        controlLedgerRoot: join(root, "ledger"),
        controlRoot: join(root, "auth"),
        controlPort: 32123,
      });
      packages[which] = {
        artifactRoot,
        manifestPath,
        trustRootPath: trust,
        configPath,
        configDigest: (await fileDigest(configPath)).digest,
        packageDigest: digest(manifest),
      };
      if (which === "old") agent.artifactDigest = engine;
    }
    config.residents[1].containers[0].artifactDigest = agent.artifactDigest;
    const nextPlan = structuredClone(plan);
    nextPlan.allocations.control[0].identityDigest = capacityResidentIdentity([
      agent,
    ]);
    await atomicJson(stable.capacityPlanPath, freezeCapacityBudget(nextPlan));
    await atomicJson(stable.capacityCollectorConfigPath, config);
    stable.maintenance = {
      executorId: "supervisor-own-birth",
      packages,
      capacityAllocation: {
        id: "agent",
        resources: plan.allocations.control[0].resources,
      },
    };
    const receipts = new Map(),
      scope = (r) => ({
        instanceId,
        maintenanceId: r.maintenanceId,
        commandId: r.commandId,
        specDigest: r.specDigest,
      });
    lifecycle = {
      inspect: async (id) => {
        const live = running.get(id);
        return live ? { ...live } : receipts.get(id);
      },
      inventory: async () => ({
        instanceId,
        complete: true,
        observedAt: new Date(now).toISOString(),
        agents: [...running.values()]
          .filter((row) => row.role === "control-agent")
          .map((row) => ({ ...row })),
      }),
      stop: async (request) => {
        stopReached();
        if (releaseStop) await releaseStop;
        request.assertBeforeDispatch();
        const old = running.get(request.target.containerId);
        running.delete(old.containerId);
        stops++;
        const result = {
          ...old,
          ...scope(request),
          running: false,
          hostPid: 0,
          exitCode: 143,
          finishedAt: new Date(now).toISOString(),
          normalExit: true,
          signal: "SIGTERM",
          forced: false,
          removed: false,
        };
        receipts.set(old.containerId, result);
        receipts.set(request.commandId, result);
        return result;
      },
      start: async (request) => {
        request.assertBeforeDispatch();
        starts++;
        const row = {
          ...physical(3, "control-agent", 500),
          startIdentity: request.startIdentity,
          artifactDigest:
            request.packageDigest === packages.new.packageDigest
              ? digest(
                  (await treeManifest(packages.new.artifactRoot)).filter(
                    (row) => row.path.startsWith("installer/"),
                  ),
                )
              : agent.artifactDigest,
          ...scope(request),
        };
        running.set(row.containerId, row);
        receipts.set(request.commandId, row);
        return row;
      },
      lookup: async (request) => ({
        ...scope(request),
        state: receipts.has(request.commandId) ? "applied" : "unknown",
        result: receipts.get(request.commandId),
      }),
      health: async (actual) => ({
        instanceId,
        role: "installer",
        pid: 1,
        startIdentity: actual.startIdentity,
        artifactDigest: actual.artifactDigest,
        observedAt: new Date(now).toISOString(),
        controlSystem: {
          packageDigest: packages.new.packageDigest,
          protocolVersion: 1,
          version: "v1.0.1",
        },
      }),
    };
  }
  if (withReservations) {
    stable.capacityTemplates = {
      api: {
        allocationId: "new-api",
        resources: plan.allocations.candidate[0].resources,
      },
    };
    if (!controlDb) {
      await fs.mkdir(join(root, "ledger"));
      controlDb = new Database(stable.controlDbPath);
      await fs.chmod(stable.controlDbPath, 0o600);
      requireApi(
        resolve("api/apps/api/dist/platform/upgrade/control-store-factory.js"),
      ).createUpgradeControlStores({
        sqlite: controlDb,
        instanceId,
        clock: { now: () => new Date(now) },
        ids: { next: randomUUID },
      });
      authority = createControlAuthority({
        sqlite: controlDb,
        instanceId,
        epochFloor: 0,
        clock: () => now,
      });
      createControlCommandJournal({
        sqlite: controlDb,
        instanceId,
        assertAuthority: () => {},
        clock: () => now,
      });
    }
  }
  let activeScope = { operationId: "upgrade", epoch: 1 };
  supervisor = await createSupervisorControl({
    root,
    instanceId,
    config: stable,
    Database,
    readers: {
      verifyAuthority: async () => ({
        instanceId,
        mode: "active",
        epoch: activeScope.epoch,
        operationId: activeScope.operationId,
        holderId: "agent",
        kind: "upgrade",
        leaseExpiresAt: now + 60000,
      }),
    },
    clock: () => now,
  });
  runtime = await createSupervisorControlRuntime({
    instanceId,
    config: stable,
    supervisor,
    Database,
    lifecycle,
    sample,
    clock: () => now,
    monotonic: () => 1e9,
  });
  return {
    setScope(operationId, epoch) {
      activeScope = { operationId, epoch };
    },
    controlDb,
    root,
    cleanup,
    now,
    instanceId,
    plan,
    config,
    stable,
    running,
    sample,
    supervisor,
    runtime,
    authority,
    agent,
    counts: () => ({ starts, stops }),
    stopped,
    holdStop() {
      releaseStop = new Promise((ok) => {
        this.releaseStop = ok;
      });
    },
    maintenanceInput: {
      maintenanceId: "maintenance-1",
      expectedControlEpoch: 5,
      sourceAgent: structuredClone(agent),
      deadline: now + 30000,
      rollbackDeadline: now + 60000,
    },
  };
}
async function finished(runtime, id) {
  for (let i = 0; i < 100; i++) {
    const value = runtime.maintenanceRequest("status", { maintenanceId: id });
    if (!value.pending) return value;
    await new Promise((ok) => setTimeout(ok, 5));
  }
  throw Error("Fixture did not settle");
}
