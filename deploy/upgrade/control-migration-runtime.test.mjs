import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  fixture,
  Database,
  apiRoot,
} from "../test-support/control-migration-fixtures.mjs";
import {
  createControlMigrationRuntime,
  createMigrationDockerAdapter,
} from "./control-migration-runtime.mjs";
import { createControlCommandJournal } from "./control-command-journal.mjs";
import { freezeCapacityBudget } from "./capacity-admission.mjs";
import { digest } from "./trust.mjs";
import { performance } from "node:perf_hooks";
import {
  capacityResidentIdentity,
  capacityHostIdentity,
} from "./control-capacity-collector.mjs";
import { treeManifest } from "./io.mjs";
async function runtimeFixture(t, { withCollector = false } = {}) {
  const f = await fixture(t),
    events = [],
    states = new Map(),
    started = new Map();
  const now = Date.now(),
    imageDigest = digest("image");
  const record = (n, role) => ({
    containerId: n.repeat(64),
    startIdentity: role + "-start-identity",
    artifactDigest: digest(role),
    startedAt: new Date(now - 100000).toISOString(),
    hostPid: 100 + parseInt(n, 16),
    running: true,
    paused: false,
    restartPolicy: "no",
    restartCount: 0,
    oomKilled: false,
    exitCode: 0,
    imageDigest,
    role,
  });
  const source = {
    foundation: record("1", "foundation"),
    installer: record("2", "installer"),
    coordinator: {
      ...record("3", "coordinator"),
      startIdentity: f.sourceCoordinator.startIdentity,
      artifactDigest: f.sourceCoordinator.artifactDigest,
    },
  };
  const owner = record("4", "owner");
  for (const r of [...Object.values(source), owner])
    states.set(r.containerId, structuredClone(r));
  const procRoot = join(f.root, "proc"),
    proc = join(procRoot, "105");
  await fs.mkdir(proc, { recursive: true });
  const fields = Array(25).fill("0");
  fields[19] = "999";
  const group = "0::/docker/" + owner.containerId + "\n";
  await fs.writeFile(
    join(proc, "stat"),
    "105 (fixture-vmm) " + fields.join(" "),
  );
  await fs.writeFile(join(proc, "cgroup"), group);
  for (const name of ["legacy", "journal", "retired", "bindings"])
    await fs.mkdir(join(f.root, name), { mode: 0o700 });
  const coordinatorPath = join(f.root, "bindings/coordinator.json"),
    oldBinding = {
      instanceId: "instance",
      origin: "http://127.0.0.1:1",
      artifactDigest: source.coordinator.artifactDigest,
      generation: 7,
    };
  await fs.writeFile(coordinatorPath, JSON.stringify(oldBinding), {
    mode: 0o600,
  });
  const originalCoordinatorSnapshotPath = join(
    f.root,
    "bindings/coordinator-original.json",
  );
  await fs.writeFile(
    originalCoordinatorSnapshotPath,
    JSON.stringify(oldBinding),
    { mode: 0o600 },
  );
  let targetCoordinator = null,
    targetApi = null,
    targetAgent = null,
    inventoryUnknown = false,
    entryBinding;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    res.setHeader("content-type", "application/json");
    if (req.url === "/metadata") {
      if (req.headers["x-platform-internal-key"] !== "u".repeat(32)) {
        res.writeHead(403);
        res.end("{}");
        return;
      }
      res.end(
        JSON.stringify({
          ...targetAgent,
          instanceId: "instance",
          role: "installer",
          controlSystem: { version: "fixture-control" },
          observedAt: new Date().toISOString(),
        }),
      );
      return;
    }
    if (req.url === "/binding") {
      res.end(
        JSON.stringify({
          ...entryBinding,
          inFlight: 0,
          activeWS: 0,
          httpByDigest: {},
          wsByDigest: {},
        }),
      );
      return;
    }
    if (req.url === "/health") {
      res.end("{}");
      return;
    }
    if (req.url === "/internal/application/identity") {
      const actual =
          targetCoordinator &&
          states.get(targetCoordinator.containerId)?.running
            ? states.get(targetCoordinator.containerId)
            : states.get(source.coordinator.containerId),
        lease = f.db
          .prepare(
            "SELECT * FROM platform_role_leases WHERE role='state-coordinator'",
          )
          .get();
      res.end(
        JSON.stringify({
          ...actual,
          pid: 1,
          role: "coordinator",
          instanceId: "instance",
          coordinatorGeneration: lease.generation,
          writerFenceValid: true,
        }),
      );
      return;
    }
    if (req.url === "/internal/upgrades/inspection") {
      if (req.headers["x-platform-internal-key"] !== "c".repeat(32)) {
        res.writeHead(403);
        res.end("{}");
        return;
      }
      const lease = f.db
        .prepare(
          "SELECT * FROM platform_role_leases WHERE role='state-coordinator'",
        )
        .get();
      res.end(
        JSON.stringify({
          instanceId: "instance",
          action: "writerIdentity",
          result: {
            instanceId: "instance",
            writerFenceValid: true,
            startIdentity: targetCoordinator.startIdentity,
            artifactDigest: targetCoordinator.artifactDigest,
            generation: lease.generation,
            accepting: true,
            observedAt: new Date().toISOString(),
            lease: {
              instanceId: "instance",
              holderId: lease.holder_id,
              generation: lease.generation,
              fence: lease.fence,
              expiresAt: lease.expires_at,
            },
          },
        }),
      );
      return;
    }
    if (req.url === "/internal/control/identity") {
      res.end(
        JSON.stringify({
          ...targetApi,
          instanceId: "instance",
          controlOnly: true,
          noRuntimeSideEffects: true,
        }),
      );
      return;
    }
    if (req.url === "/coordinator-inventory") {
      const receipt = JSON.parse(
        await fs.readFile(
          join(f.root, "retired", source.coordinator.containerId + ".json"),
          "utf8",
        ),
      );
      res.end(
        JSON.stringify({
          instanceId: "instance",
          complete: !inventoryUnknown,
          observedAt: new Date().toISOString(),
          coordinators: [
            {
              ...source.coordinator,
              retiredPhysical: {
                ...receipt,
                observedAt: new Date().toISOString(),
              },
            },
            {
              ...targetCoordinator,
              actualIdentity: {
                instanceId: "instance",
                startIdentity: targetCoordinator.startIdentity,
                artifactDigest: targetCoordinator.artifactDigest,
                generation: 8,
                writerFenceValid: true,
                observedAt: new Date().toISOString(),
              },
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const origin = "http://127.0.0.1:" + server.address().port;
  source.coordinator.origin = origin;
  const artifactRoot = join(f.root, "qualified-fixture-artifact");
  await fs.mkdir(join(artifactRoot, "api/apps/api/dist/roles"), {
    recursive: true,
  });
  await fs.writeFile(
    join(artifactRoot, "api/apps/api/dist/roles/coordinator-main.js"),
    "// own fixture bytes\n",
  );
  const files = await treeManifest(artifactRoot),
    component = {
      artifactDigest: digest(files),
      inputFingerprint: digest("fixture-coordinator-input"),
    };
  await fs.writeFile(
    join(artifactRoot, "installed.json"),
    JSON.stringify({ components: { coordinator: component } }),
  );
  await fs.writeFile(
    join(artifactRoot, "upgrade-artifact.json"),
    JSON.stringify({ files, treeDigest: digest(files) }),
  );
  const resources = {
      memoryBytes: 10,
      cpuMilliCores: 10,
      ioBytesPerSecond: 10,
      disks: { data: 10 },
    },
    item = (id, resident) => ({
      id,
      resident,
      identityDigest: digest(id),
      resources,
    });
  const targets = Object.fromEntries(
    [
      "control-agent",
      "coordinator",
      "api",
      "control-supervisor",
      "control-entry",
    ].map((kind, i) => [
      kind,
      {
        kind,
        origin,
        entry:
          kind === "coordinator"
            ? join(artifactRoot, "api/apps/api/dist/roles/coordinator-main.js")
            : "/qualified-fixture/" + kind + ".mjs",
        artifactRoot,
        args: [],
        cwd: artifactRoot,
        resources,
        capacityAllocationId: "target-" + kind,
        env: {
          SANDBOX_RECONCILE_ON_BOOT: "false",
          UPGRADE_CONTROL_DATABASE_PATH: f.controlPath,
        },
        record: {
          startIdentity: kind + "-new-start-identity",
          ...(kind === "coordinator"
            ? component
            : {
                artifactDigest: digest("new-" + kind),
                inputFingerprint: digest("input-" + kind),
              }),
        },
      },
    ]),
  );
  const targetAllocation = (kind) => ({
    ...item("target-" + kind, false),
    identityDigest: digest({
      kind,
      startIdentity: targets[kind].record.startIdentity,
      artifactDigest: targets[kind].record.artifactDigest,
    }),
  });
  const plan = freezeCapacityBudget({
    instanceId: "instance",
    sourceDigest: digest("source"),
    maxObservationAgeMs: 5000,
    limits: {
      memoryBytes: 1000,
      cpuMilliCores: 1000,
      ioBytesPerSecond: 1000,
      disks: { data: 1000 },
    },
    allocations: {
      source: [item("source", true)],
      retainedOwners: [],
      retainedGuests: [],
      existingCandidates: [],
      candidate: ["api", "coordinator"].map(targetAllocation),
      verification: [],
      control: [
        item("control", true),
        ...["control-agent", "control-supervisor", "control-entry"].map(
          targetAllocation,
        ),
      ],
      recovery: [item("recovery", false)],
    },
  });
  const observation = {
    known: true,
    exclusiveAccounting: true,
    instanceId: "instance",
    sourceDigest: plan.sourceDigest,
    revision: 1,
    observedAt: new Date().toISOString(),
    limits: plan.limits,
    available: {
      memoryBytes: 900,
      cpuMilliCores: 900,
      ioBytesPerSecond: 900,
      disks: { data: 900 },
    },
    residents: [item("source", true), item("control", true)].map(
      ({ id, identityDigest, resources }) => ({
        id,
        identityDigest,
        resources,
      }),
    ),
  };
  const planPath = join(f.root, "capacity.json"),
    observationPath = join(f.root, "resources.json");
  await fs.writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
  await fs.writeFile(observationPath, JSON.stringify(observation), {
    mode: 0o600,
  });
  entryBinding = {
    instanceId: "instance",
    weight: 100,
    oldApi: { origin: "http://127.0.0.1:1", digest: digest("old-api") },
    candidateApi: { origin, digest: targets.api.record.artifactDigest },
  };
  const input = {
    ...f.args,
    controlPath: f.controlPath,
    runtime: {
      schemaVersion: 1,
      instanceId: "instance",
      migrationId: "migration",
      journalRoot: join(f.root, "journal"),
      deadline: now + 60000,
      rollbackDeadline: now + 120000,
      actionBudgetMs: 2000,
      source,
      targets,
      knownCoordinators: [source.coordinator],
      protectedRuntimeRoots: ["/fixture-only-sdk"],
      protectedOwners: [owner],
      protectedProcesses: [
        {
          hostPid: 105,
          containerId: owner.containerId,
          birthTicks: "999",
          cgroupDigest: digest(group),
        },
      ],
      procRoot,
      legacyProcessRoot: join(f.root, "legacy"),
      installedRolesRoot: join(f.root, "installed-roles"),
      retiredCoordinatorRoot: join(f.root, "retired"),
      capacity: { planPath, observationPath, planDigest: plan.planDigest },
      bindings: {
        coordinatorPath,
        originalCoordinatorDigest: digest(oldBinding),
        originalCoordinatorSnapshotPath,
      },
      keys: {
        entry: "e".repeat(32),
        controller: "c".repeat(32),
        upgradeControl: "u".repeat(32),
        control: "a".repeat(32),
        supervisor: "s".repeat(32),
      },
      supervisorOrigin: origin,
      entryControlOrigin: origin,
      entryOrigin: origin,
      entryBindingDigest: digest(entryBinding),
    },
  };
  let loseAck = null,
    holdKind = null,
    release;
  const gate = new Promise((r) => {
    release = r;
  });
  const adapter = {
    inspect: async (r) => structuredClone(states.get(r.containerId)),
    terminate: async (r) => {
      events.push("stop:" + r.role);
      assert.notEqual(r.role, "owner");
      const old = states.get(r.containerId);
      const next = { ...old, running: false, hostPid: 0, exitCode: 0 };
      states.set(r.containerId, next);
      if (r.role === "coordinator")
        f.db
          .prepare(
            "UPDATE platform_role_leases SET expires_at=0 WHERE role='state-coordinator'",
          )
          .run();
      return next;
    },
    restart: async (r) => {
      events.push("restart:" + r.role);
      const next = {
        ...states.get(r.containerId),
        running: true,
        hostPid: r.hostPid + 1000,
        startedAt: new Date(Date.now() + 1).toISOString(),
      };
      states.set(r.containerId, next);
      if (r.role === "coordinator")
        f.db
          .prepare(
            "UPDATE platform_role_leases SET holder_id='restored',generation=generation+1,fence=fence+1,expires_at=? WHERE role='state-coordinator'",
          )
          .run(Date.now() + 30000);
      return next;
    },
    launch: async (spec) => {
      events.push("start:" + spec.kind);
      await spec.assertBeforeDispatch();
      if (holdKind === spec.kind) await gate;
      const n =
        [
          "control-agent",
          "coordinator",
          "api",
          "control-supervisor",
          "control-entry",
        ].indexOf(spec.kind) + 5;
      const actual = {
        ...record(n.toString(16), spec.kind),
        ...spec.record,
        role: spec.kind,
        running: true,
        hostPid: 200 + n,
        startedAt: new Date().toISOString(),
      };
      states.set(actual.containerId, actual);
      started.set(spec.record.commandId, actual);
      if (spec.kind === "control-agent") {
        targetAgent = actual;
        const ledger = new Database(f.controlPath);
        createControlCommandJournal({
          sqlite: ledger,
          instanceId: "instance",
          assertAuthority: () => {},
        });
        ledger.close();
      }
      if (spec.kind === "coordinator") {
        targetCoordinator = actual;
        f.db
          .prepare(
            "UPDATE platform_role_leases SET holder_id='new-writer',generation=8,fence=8,expires_at=? WHERE role='state-coordinator'",
          )
          .run(Date.now() + 30000);
      }
      if (spec.kind === "api") targetApi = actual;
      if (loseAck === spec.kind) {
        loseAck = null;
        throw Object.assign(Error("fixture dropped acknowledgement"), {
          code: "DOCKER_ACK_UNKNOWN",
        });
      }
      return actual;
    },
    lookupLaunch: async (r) =>
      started.has(r.commandId)
        ? { state: "applied", result: started.get(r.commandId) }
        : { state: "unknown", result: { code: "fixture-pending" } },
  };
  let capacitySample;
  if (withCollector) {
    const physical = (r) => ({
      containerId: r.containerId,
      pid: r.hostPid,
      birthTicks: String(r.hostPid) + "99",
      cgroupDigest: digest("cgroup:" + r.containerId),
      startedAt: r.startedAt,
      restartCount: r.restartCount,
      instanceId: r.role === "foundation" ? null : "instance",
      role: r.role === "foundation" ? null : r.role,
      startIdentity: r.role === "foundation" ? null : r.startIdentity,
      artifactDigest: r.role === "foundation" ? null : r.artifactDigest,
    });
    capacitySample = async () => {
      const ms = performance.now(),
        total = Math.floor(ms * 1000);
      return {
        vmBootId: "00112233-4455-6677-8899-aabbccddeeff",
        procIdentity: { path: "/host/proc", dev: "1", ino: "1" },
        cpu: { cpus: 1, total, idle: Math.floor(total * 0.999) },
        memory: { total: 1000, free: 980, available: 980 },
        devices: [
          {
            id: "data",
            dev: "2049",
            majorMinor: "8:1",
            capacityBytes: 1000,
            freeBytes: 900,
            availableBytes: 900,
            readBytes: Math.floor(ms / 1000) * 10,
            writeBytes: 0,
          },
        ],
        containers: [...states.values()]
          .filter((r) => r.running)
          .map((r) => ({
            ...physical(r),
            memoryBytes: 1,
            cpuNs: total,
            ioBytes: Math.floor(ms / 1000),
            monotonic: ms,
          })),
        startedAt: Date.now(),
        finishedAt: Date.now(),
        monotonic: ms,
      };
    };
    const initial = await capacitySample(),
      sourceRows = [source.installer, source.coordinator].map(physical),
      ownerRows = [physical(owner)],
      configPath = join(f.root, "collector-config.json");
    const ioFacts = {
        schemaVersion: 1,
        kind: "control-io-qualification",
        instanceId: "instance",
        vmBootId: initial.vmBootId,
        devices: initial.devices.map(({ id, dev, majorMinor }) => ({
          id,
          dev,
          majorMinor,
        })),
        effectiveBudgetBytesPerSecond: 1000,
        windowMs: 60000,
        observedAt: new Date(now - 120000).toISOString(),
        expiresAt: new Date(now + 120000).toISOString(),
        qualified: true,
        measurement: {
          readBytes: 60000,
          writeBytes: 0,
          maxLatencyMs: 1,
          samples: 600,
          unexpectedErrors: 0,
        },
      },
      io = { ...ioFacts, receiptDigest: digest(ioFacts) },
      raw = JSON.stringify(io),
      ioPath = join(f.root, "io-fixture.json");
    await fs.writeFile(ioPath, raw, { mode: 0o600 });
    const config = {
      schemaVersion: 1,
      instanceId: "instance",
      sourceDigest: plan.sourceDigest,
      hostProcRoot: "/host/proc",
      devices: [
        { id: "data", path: "/fixture-data", dev: "2049", majorMinor: "8:1" },
      ],
      residents: [
        { id: "source", containers: sourceRows },
        { id: "owner", containers: ownerRows },
      ],
      ioEffectiveBudgetBytesPerSecond: 1000,
      ioQualificationPath: ioPath,
      ioQualificationRawDigest: digest(raw),
      observationPath,
      dockerSocketPath: "/fixture.sock",
      sampleIntervalMs: 250,
      timeoutMs: 2000,
    };
    const next = structuredClone(plan);
    next.allocations.source = [
      {
        id: "source",
        resident: true,
        identityDigest: capacityResidentIdentity(sourceRows),
        resources: {
          ...resources,
          memoryBytes: 50,
          cpuMilliCores: 50,
          ioBytesPerSecond: 50,
        },
      },
      {
        id: "host-overhead",
        resident: true,
        identityDigest: capacityHostIdentity(initial, "instance"),
        resources: {
          ...resources,
          memoryBytes: 100,
          cpuMilliCores: 100,
          ioBytesPerSecond: 100,
          disks: { data: 100 },
        },
      },
    ];
    next.allocations.retainedOwners = [
      {
        id: "owner",
        resident: true,
        identityDigest: capacityResidentIdentity(ownerRows),
        resources,
      },
    ];
    next.allocations.control = next.allocations.control.filter(
      (x) => !x.resident,
    );
    const nativePlan = freezeCapacityBudget(next);
    await fs.writeFile(planPath, JSON.stringify(nativePlan), { mode: 0o600 });
    await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    input.runtime.capacity.planDigest = nativePlan.planDigest;
    input.runtime.capacity.configPath = configPath;
    source.foundation.capacityAllocationId = "host-overhead";
    source.installer.capacityAllocationId = "source";
    source.coordinator.capacityAllocationId = "source";
  }
  return {
    f,
    input,
    adapter,
    events,
    source,
    owner,
    states,
    observation,
    observationPath,
    release,
    capacitySample,
    setLoseAck: (k) => {
      loseAck = k;
    },
    setHold: (k) => {
      holdKind = k;
    },
    setInventoryUnknown: (v) => {
      inventoryUnknown = v;
    },
  };
}
test("SQLite+HTTP with explicit Docker adapter fixture migrates without business DDL or protected lifecycle action, and source proof keeps original time", async (t) => {
  const f = await runtimeFixture(t),
    before = f.f.db
      .prepare("SELECT * FROM upgrade_attempts ORDER BY rowid")
      .all(),
    runtime = await createControlMigrationRuntime(f.input, {
      Database,
      adapter: f.adapter,
    });
  t.after(() => runtime.close());
  const result = await runtime.apply();
  assert.equal(result.state, "migrated");
  assert.equal(result.pending.length, 0);
  assert.deepEqual(f.events.slice(0, 3), [
    "stop:foundation",
    "stop:installer",
    "stop:coordinator",
  ]);
  assert.deepEqual(f.events.slice(3), [
    "start:control-agent",
    "start:coordinator",
    "start:api",
    "start:control-supervisor",
    "start:control-entry",
  ]);
  assert.deepEqual(
    f.f.db.prepare("SELECT * FROM upgrade_attempts ORDER BY rowid").all(),
    before,
  );
  assert.equal(
    f.f.db.prepare("SELECT count(*) n FROM __drizzle_migrations").get().n,
    29,
  );
  assert.equal(f.states.get(f.owner.containerId).hostPid, f.owner.hostPid);
  assert.equal((await runtime.resume()).state, "migrated");
  assert.equal(f.events.length, 8);
  const processRecord = JSON.parse(
      await fs.readFile(
        join(f.f.root, "legacy/migration-coordinator.json"),
        "utf8",
      ),
    ),
    registry = JSON.parse(
      await fs.readFile(
        join(f.f.root, "installed-roles/installed-roles.json"),
        "utf8",
      ),
    );
  assert.equal(processRecord.state, "started");
  assert.equal(processRecord.containerId, registry[0].containerId);
  assert.equal(registry[0].readerId.startsWith("reader-"), true);
});
test("a lost create acknowledgement resumes only the original command and never launches a second role", async (t) => {
  const f = await runtimeFixture(t);
  f.setLoseAck("control-agent");
  const runtime = await createControlMigrationRuntime(f.input, {
    Database,
    adapter: f.adapter,
  });
  await assert.rejects(runtime.apply(), /fixture dropped acknowledgement/);
  assert.equal(runtime.status().pending.length, 1);
  const result = await runtime.resume();
  assert.equal(result.state, "migrated");
  assert.equal(f.events.filter((v) => v === "start:control-agent").length, 1);
  runtime.close();
});
test("unknown resource dimensions or changed protected birth hold before any stop/start", async (t) => {
  for (const kind of ["capacity", "owner"]) {
    const f = await runtimeFixture(t);
    if (kind === "capacity")
      await fs.writeFile(
        f.observationPath,
        JSON.stringify({ ...f.observation, known: false }),
      );
    else f.states.get(f.owner.containerId).hostPid++;
    const runtime = await createControlMigrationRuntime(f.input, {
      Database,
      adapter: f.adapter,
    });
    await assert.rejects(runtime.apply());
    assert.deepEqual(f.events, []);
    runtime.close();
  }
});
test("each migration role has its own exact frozen allocation; borrowed or modified resources refuse before any lifecycle action", async (t) => {
  for (const mutation of ["resources", "allocation", "identity"]) {
    const f = await runtimeFixture(t),
      target = f.input.runtime.targets.coordinator;
    if (mutation === "resources")
      target.resources = {
        ...target.resources,
        memoryBytes: target.resources.memoryBytes + 1,
      };
    if (mutation === "allocation")
      target.capacityAllocationId =
        f.input.runtime.targets.api.capacityAllocationId;
    if (mutation === "identity")
      target.record.artifactDigest = digest("changed-code");
    const runtime = await createControlMigrationRuntime(f.input, {
      Database,
      adapter: f.adapter,
    });
    await assert.rejects(runtime.apply(), {
      code: "CONTROL_MIGRATION_CAPACITY_ALLOCATION_CHANGED",
    });
    assert.deepEqual(f.events, []);
    runtime.close();
  }
});
test("capacity observation replaced during create is rejected by the final physical dispatch CAS", async (t) => {
  const f = await runtimeFixture(t),
    original = f.adapter.launch;
  f.adapter.launch = async (spec) => {
    if (spec.kind === "control-agent")
      await fs.writeFile(
        f.observationPath,
        JSON.stringify({ ...f.observation, revision: 2 }),
      );
    return original(spec);
  };
  const runtime = await createControlMigrationRuntime(f.input, {
    Database,
    adapter: f.adapter,
  });
  await assert.rejects(runtime.apply(), {
    code: "CONTROL_MIGRATION_CAPACITY_CAS_CHANGED",
  });
  assert.equal(
    [...f.states.values()].filter((r) => r.role === "control-agent").length,
    0,
  );
  runtime.close();
});
test("explicit rollback stops only newly introduced control roles, preserves histories and reclaims original source normally", async (t) => {
  const f = await runtimeFixture(t),
    runtime = await createControlMigrationRuntime(f.input, {
      Database,
      adapter: f.adapter,
    });
  t.after(() => runtime.close());
  await runtime.apply();
  const result = await runtime.rollback();
  assert.equal(result.state, "rolled-back");
  assert.ok(f.events.includes("restart:coordinator"));
  assert.ok(f.events.includes("restart:installer"));
  assert.ok(f.events.includes("restart:foundation"));
  assert.equal(f.states.get(f.owner.containerId).running, true);
});

test("default fixed Docker migration adapter verifies real code bytes/full birth and sends SIGTERM only to the exact Foundation", async (t) => {
  const f = await fixture(t),
    path = join(f.root, "foundation-source.mjs");
  await fs.writeFile(path, "// exact own fixture source\n");
  const { fileDigest } = await import("./io.mjs"),
    file = { path, ...(await fileDigest(path)) };
  const row = {
    Id: "a".repeat(64),
    Image: digest("image"),
    Config: {
      Entrypoint: ["node"],
      Cmd: ["bootstrap-upgrade-instance.mjs", "resume", "/private/config.json"],
      WorkingDir: "/fixture",
      Labels: {},
    },
    HostConfig: {
      PidMode: "",
      Privileged: false,
      Devices: [],
      RestartPolicy: { Name: "no" },
    },
    State: {
      StartedAt: "2026-10-20T00:00:00Z",
      Pid: 1234,
      Running: true,
      Paused: false,
      OOMKilled: false,
      ExitCode: 0,
    },
    RestartCount: 0,
    Mounts: [{ Source: "/fixture", Destination: "/fixture", RW: true }],
  };
  const commandDigest = digest({
      entrypoint: row.Config.Entrypoint,
      command: row.Config.Cmd,
      workingDirectory: row.Config.WorkingDir,
    }),
    mountDigest = digest(
      row.Mounts.map((m) => ({
        source: m.Source,
        destination: m.Destination,
        rw: m.RW,
      })),
    ),
    expected = {
      containerId: row.Id,
      startIdentity: digest({ containerId: row.Id, commandDigest }),
      artifactDigest: digest([file]),
      startedAt: row.State.StartedAt,
      hostPid: 1234,
      running: true,
      paused: false,
      restartPolicy: "no",
      restartCount: 0,
      oomKilled: false,
      exitCode: 0,
      imageDigest: row.Image,
      role: "foundation",
      codeFiles: [file],
      commandDigest,
      mountDigest,
    };
  const effects = [],
    adapter = await createMigrationDockerAdapter(
      {
        adapter: { docker: { cli: "docker", args: [] } },
        protectedRuntimeRoots: ["/sdk"],
      },
      {
        adapterFactory: async () => ({}),
        run: async (_program, args) => {
          if (args[0] === "inspect") return JSON.stringify([row]);
          effects.push(args);
          if (args[0] === "kill") {
            row.State.Running = false;
            row.State.Pid = 0;
          }
          return "";
        },
      },
    );
  assert.equal((await adapter.inspect(expected)).hostPid, 1234);
  const actual = await adapter.terminate(expected);
  assert.equal(actual.running, false);
  assert.deepEqual(effects, [["kill", "--signal", "SIGTERM", row.Id]]);
  await assert.rejects(
    adapter.terminate({ ...expected, role: "owner" }),
    /CONTROL_MIGRATION_PROTECTED_STOP_FORBIDDEN/,
  );
  row.State.Running = true;
  row.State.Pid = 1234;
  await fs.writeFile(path, "// changed code\n");
  await assert.rejects(
    adapter.terminate(expected),
    /CONTROL_MIGRATION_FOUNDATION_CODE_CHANGED/,
  );
  assert.equal(effects.length, 1);
});
test("actual unsettled execution keeps the persistent actor barrier; no second runner or rollback can overlap", async (t) => {
  const f = await runtimeFixture(t);
  f.setHold("control-agent");
  const runtime = await createControlMigrationRuntime(f.input, {
    Database,
    adapter: f.adapter,
  });
  const first = runtime.apply();
  while (!f.events.includes("start:control-agent"))
    await new Promise((r) => setTimeout(r, 1));
  const other = await createControlMigrationRuntime(f.input, {
    Database,
    adapter: f.adapter,
  });
  await assert.rejects(other.resume(), /CONTROL_MIGRATION_ACTOR_STILL_RUNNING/);
  await assert.rejects(first, { code: "CONTROL_MIGRATION_COMMAND_UNKNOWN" });
  await assert.rejects(
    other.rollback(),
    /CONTROL_MIGRATION_ACTOR_STILL_RUNNING/,
  );
  assert.equal(f.events.filter((e) => e === "start:control-agent").length, 1);
  f.release();
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(
    runtime.resume(),
    /CONTROL_MIGRATION_ACTION_BUDGET_EXCEEDED/,
  );
  assert.equal(f.events.filter((e) => e === "start:control-agent").length, 1);
  assert.equal((await runtime.rollback()).state, "rolled-back");
  other.close();
  runtime.close();
});

test("migration runtime joins actual command journal with capacity collector transitions through all starts, normal exits and rollback", async (t) => {
  const f = await runtimeFixture(t, { withCollector: true }),
    runtime = await createControlMigrationRuntime(f.input, {
      Database,
      adapter: f.adapter,
      capacitySample: f.capacitySample,
    });
  t.after(() => runtime.close());
  const migrated = await runtime.apply();
  assert.equal(migrated.state, "migrated");
  const plan = JSON.parse(
    await fs.readFile(f.input.runtime.capacity.planPath, "utf8"),
  );
  assert.equal(
    plan.allocations.source.find((x) => x.id === "source").resident,
    false,
  );
  assert.equal(
    plan.allocations.candidate.every((x) => x.resident),
    true,
  );
  assert.equal((await runtime.rollback()).state, "rolled-back");
  const restored = JSON.parse(
    await fs.readFile(f.input.runtime.capacity.planPath, "utf8"),
  );
  assert.equal(
    restored.allocations.source.find((x) => x.id === "source").resident,
    true,
  );
  assert.equal(
    restored.allocations.candidate.every((x) => !x.resident),
    true,
  );
  assert.equal(
    f.events.some((x) => x === "stop:owner"),
    false,
  );
});

test("migration rejects missing/shared global authority or its exposure to business roles before any lifecycle action", async (t) => {
  for (const bad of ["missing", "shared", "env", "entry", "supervisor"]) {
    const f = await runtimeFixture(t);
    if (bad === "missing") delete f.input.runtime.keys.upgradeControl;
    if (bad === "shared")
      f.input.runtime.keys.upgradeControl = f.input.runtime.keys.controller;
    if (bad === "env")
      f.input.runtime.targets.coordinator.env.LEAKED_GLOBAL_KEY =
        f.input.runtime.keys.upgradeControl;
    if (bad === "entry")
      f.input.runtime.targets.coordinator.env.PLATFORM_ENTRY_CONTROL_KEY =
        f.input.runtime.keys.entry;
    if (bad === "supervisor")
      f.input.runtime.targets.coordinator.env.PLATFORM_INSTALLER_SUPERVISOR_KEY =
        f.input.runtime.keys.supervisor;
    const runtime = await createControlMigrationRuntime(f.input, {
      Database,
      adapter: f.adapter,
    });
    await assert.rejects(runtime.apply());
    assert.deepEqual(f.events, []);
    runtime.close();
  }
});
