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
  migrationCapacityInspectionTarget,
  waitForMigrationLeaseRelease,
  migrationActionBudgetMs,
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
import { validateCoordinatorExitReceipt } from "./coordinator-exit-receipt.mjs";
import { createSupervisorControlRuntime } from "./supervisor-control-runtime.mjs";
import { createProtectedRoleLifecycle } from "./protected-role-lifecycle.mjs";
import { createCoordinatorIdentityReader, createCoordinatorInventory } from "./supervisor-inventory.mjs";
async function runtimeFixture(t, { withCollector = false, closeOnStop = false, failApiReadiness = false, apiExitPatch = {}, failSupervisorBeforeRegistration=false, withNormalHandoff=false, apiReadinessFailureCodes = [], entryApiHealthStatus = 200 } = {}) {
  const f = await fixture(t),
    events = [],
    preStopInventoryCalls = [],
    entryHealthRequests = [],
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
      entryHealthRequests.push(req.url);
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Web route not found</title>");
      return;
    }
    if (req.url === "/api/health") {
      entryHealthRequests.push(req.url);
      res.writeHead(entryApiHealthStatus);
      res.end(JSON.stringify({ status: entryApiHealthStatus === 200 ? "ok" : "unavailable" }));
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
      if (apiReadinessFailureCodes.length) {
        const code = apiReadinessFailureCodes[Math.min(
          events.filter(event => event.startsWith("api-readiness:")).length,
          apiReadinessFailureCodes.length - 1,
        )];
        events.push("api-readiness:" + code);
        res.writeHead(503); res.end(JSON.stringify({ code })); return;
      }
      if (failApiReadiness) {
        states.set(targetApi.containerId, { ...states.get(targetApi.containerId), running: false, hostPid: 0,
          exitCode: 1, ...apiExitPatch });
        res.writeHead(503); res.end("{}"); return;
      }
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
      adapter:{stableControl:{statePath:join(f.root,"supervisor.db")}},
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
    observeFailedSupervisorStart: async (record,expected) => {
      const actual=states.get(expected.containerId);
      assert.equal(record.kind,"control-supervisor");
      assert.equal(actual.running,false);assert.equal(actual.exitCode,1);assert.equal(actual.oomKilled,false);
      return {...actual,failedStartInert:true,normalExit:false,terminationDispatched:false,
        failedStartProof:{kind:"fixture-kernel-and-durable-proof",originalResultDigest:digest(expected)}};
    },
    terminate: async (r) => {
      events.push("stop:" + r.role);
      assert.notEqual(r.role, "owner");
      const old = states.get(r.containerId);
      const next = { ...old, running: false, hostPid: 0, exitCode: 0, finishedAt: new Date().toISOString() };
      states.set(r.containerId, next);
      if (r.role === "coordinator") {
        f.db
          .prepare(
            "UPDATE platform_role_leases SET expires_at=0 WHERE role='state-coordinator'",
          )
          .run();
        if (closeOnStop) {
          f.db.close();
          for (const suffix of ["-wal", "-shm"]) await assert.rejects(fs.stat(f.args.businessPath + suffix), { code: "ENOENT" });
          events.push("business-last-writer-closed");
        }
      }
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
        if (!f.db.open) { f.db = new Database(f.args.businessPath); t.after(() => f.db.open && f.db.close()); }
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
        if (!f.db.open) { f.db = new Database(f.args.businessPath); t.after(() => f.db.open && f.db.close()); }
        f.db
          .prepare(
            "UPDATE platform_role_leases SET holder_id='new-writer',generation=8,fence=8,expires_at=? WHERE role='state-coordinator'",
          )
          .run(Date.now() + 30000);
      }
      if (spec.kind === "api") targetApi = actual;
      if(spec.kind === "control-supervisor" && failSupervisorBeforeRegistration)
        states.set(actual.containerId,{...actual,running:false,hostPid:0,exitCode:1});
      if(spec.kind === 'control-supervisor' && withNormalHandoff){
        const path=join(input.runtime.adapter.stableControl.capacityTransitionRoot,'capacity-publication.db');
        await fs.mkdir(join(path,'..'),{recursive:true,mode:0o700});
        const mutex=new Database(path);mutex.exec('CREATE TABLE publication_mutex(singleton INTEGER PRIMARY KEY CHECK(singleton=1))');mutex.close();await fs.chmod(path,0o600);
      }
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
  let handoffRepairContext,handoffSupervisorReadiness;
  if(withNormalHandoff){
    const capacityRoot=join(f.root,'normal-capacity'),sdk=join(f.root,'explicit-sdk');await fs.mkdir(sdk,{mode:0o700});input.runtime.protectedRuntimeRoots=[sdk];
    Object.assign(input.runtime.adapter,{capacityStateRoot:capacityRoot});
    Object.assign(input.runtime.adapter.stableControl,{capacityPlanPath:join(capacityRoot,'plan.json'),capacityCollectorConfigPath:join(capacityRoot,'collector.json'),
      resourceObservationPath:join(capacityRoot,'observation.json'),capacityTransitionRoot:join(capacityRoot,'transitions'),
      capacityTemplates:{owner:{allocationId:'future-owner-template',resources:{...resources}}}});
    const identity=part=>({artifactDigest:part.artifactDigest,inputFingerprint:part.inputFingerprint}),
      targetParts={api:identity(targets.api.record),coordinator:identity(targets.coordinator.record),installer:identity(targets['control-agent'].record),
        web:{artifactDigest:digest('actual-bound-web'),inputFingerprint:digest('actual-bound-web-input')},
        owner:{artifactDigest:digest('future-owner'),inputFingerprint:digest('future-owner-input')}};
    const context={instanceId:'instance',manifestDigest:digest('explicit-verified-package-port'),
      sourceComponents:{web:targetParts.web,owner:{artifactDigest:owner.artifactDigest,inputFingerprint:digest('old-owner-input')}},targetComponents:targetParts,
      installedComponents:{api:targetParts.api,coordinator:targetParts.coordinator,installer:targetParts.installer},
      web:targetParts.web,owner:{artifactDigest:owner.artifactDigest,inputFingerprint:digest('old-owner-input')}};
    handoffRepairContext=async stage=>{events.push('handoff:'+stage);return structuredClone(context);};
    handoffSupervisorReadiness=async()=>{
      events.push('handoff:supervisor-ready');const ledger=new Database(f.controlPath,{readonly:true});
      try{assert.equal(ledger.prepare('SELECT mode FROM control_authority WHERE instance_id=?').get('instance').mode,'passive');}finally{ledger.close();}
      const db=new Database(join(f.root,'test-normal-supervisor.db')),stable=input.runtime.adapter.stableControl,
        consumer=await createSupervisorControlRuntime({instanceId:'instance',config:{capacityPlanPath:stable.capacityPlanPath,capacityCollectorConfigPath:stable.capacityCollectorConfigPath,
          resourceObservationPath:stable.resourceObservationPath,capacityTransitionRoot:stable.capacityTransitionRoot},supervisor:{assembly:{sqlite:db},journal:{lookup(){}}},Database,
          sample:capacitySample});
      try{return {...await consumer.capacityReadiness(),supervisorStartIdentity:targets['control-supervisor'].record.startIdentity};}
      finally{await consumer.close();db.close();}
    };
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
    handoffRepairContext,handoffSupervisorReadiness,
    preStopInventoryCalls,
    entryHealthRequests,
    preStopInventory: async ({ runtime, lease }) => {
      assert.equal(runtime, input.runtime);
      assert.equal(lease.generation, 7);
      assert.equal(states.get(source.coordinator.containerId).running, true);
      assert.ok(!events.some(event => event.startsWith("stop:")));
      preStopInventoryCalls.push({ lease, source: structuredClone(states.get(source.coordinator.containerId)) });
      return { kind: "explicit-local-test-inventory-port", sourceContainerId: source.coordinator.containerId };
    },
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
test("only the original writer stop receives its declared grace in the real runtime journal", async t => {
  const f = await runtimeFixture(t, { withCollector: true });
  f.input.runtime.actionBudgetMs = 2000;
  f.input.runtime.sourceCoordinatorStopBudgetMs = 300000;
  const terminate = f.adapter.terminate;
  const stopDeadlines = [];
  let originalWriterSignals = 0;
  f.adapter.terminate = async (record, options) => {
    const db = new Database(join(f.input.runtime.journalRoot, "migration.db"), { readonly: true });
    try {
      const row = db.prepare("SELECT * FROM control_commands WHERE state='executing'").get();
      const spec = JSON.parse(row.spec);
      assert.equal(options.deadline, Math.min(spec.deadline, row.created_at + spec.budget.maxDurationMs));
      stopDeadlines.push({ id: row.step_id, budget: spec.budget.maxDurationMs });
    } finally { db.close(); }
    if (record.containerId === f.source.coordinator.containerId) {
      originalWriterSignals++;
      await new Promise(done => setTimeout(done, 2200));
    }
    return terminate(record);
  };
  const runtime = await createControlMigrationRuntime(f.input, {
    Database, adapter: f.adapter, preStopInventory: f.preStopInventory, capacitySample: f.capacitySample,
  });
  t.after(() => runtime.close());
  assert.equal((await runtime.apply()).state, "migrated");
  const db = new Database(join(f.input.runtime.journalRoot, "migration.db"), { readonly: true });
  try {
    const rows = db.prepare("SELECT * FROM control_commands").all();
    const writer = rows.find(row => row.step_id === "stop-writer");
    assert.equal(JSON.parse(writer.spec).budget.maxDurationMs, 300000);
    assert.equal(JSON.parse(writer.result).migrationBudgetExceeded, false);
    assert.ok(rows.filter(row => row.step_id !== "stop-writer")
      .every(row => JSON.parse(row.spec).budget.maxDurationMs === 2000));
  } finally { db.close(); }
  assert.equal((await runtime.rollback()).state, "rolled-back");
  assert.equal(originalWriterSignals, 1);
  assert.equal(stopDeadlines.find(row => row.id === "stop-writer").budget, 300000);
  assert.ok(stopDeadlines.filter(row => row.id !== "stop-writer").every(row => row.budget === 2000));
  assert.deepEqual(f.states.get(f.owner.containerId), f.owner);
});

test("an undeclared writer grace keeps the original timeout and rollback reconciles its late normal exit", async t => {
  const f = await runtimeFixture(t, { withCollector: true });
  f.input.runtime.actionBudgetMs = 200;
  const terminate = f.adapter.terminate;
  let completed;
  const exited = new Promise(done => { completed = done; });
  f.adapter.terminate = async record => {
    if (record.role === "coordinator") await new Promise(done => setTimeout(done, 350));
    const result = await terminate(record);
    if (record.role === "coordinator") completed();
    return result;
  };
  const runtime = await createControlMigrationRuntime(f.input, {
    Database, adapter: f.adapter, preStopInventory: f.preStopInventory, capacitySample: f.capacitySample,
  });
  t.after(() => runtime.close());
  await assert.rejects(runtime.apply(), { code: "CONTROL_MIGRATION_COMMAND_UNKNOWN" });
  await exited;
  await new Promise(done => setTimeout(done, 0));
  assert.equal((await runtime.rollback()).state, "rolled-back");
  const db = new Database(join(f.input.runtime.journalRoot, "migration.db"), { readonly: true });
  try {
    const row = db.prepare("SELECT * FROM control_commands WHERE step_id='stop-writer'").get();
    assert.equal(JSON.parse(row.spec).budget.maxDurationMs, 200);
    assert.equal(JSON.parse(row.result).migrationBudgetExceeded, true);
    assert.equal(db.prepare("SELECT count(*) n FROM control_commands WHERE step_id LIKE 'start-%'").get().n, 0);
  } finally { db.close(); }
  assert.equal(f.events.filter(event => event === "stop:coordinator").length, 1);
  assert.deepEqual(f.states.get(f.owner.containerId), f.owner);
});

test("writer grace cannot extend the original primary deadline or other action budgets", async t => {
  const f = await runtimeFixture(t);
  f.input.runtime.actionBudgetMs = 200;
  f.input.runtime.sourceCoordinatorStopBudgetMs = 300000;
  f.input.runtime.deadline = Date.now() + 1000;
  const terminate = f.adapter.terminate;
  let completed;
  const exited = new Promise(done => { completed = done; });
  f.adapter.terminate = async record => {
    if (record.role === "coordinator") await new Promise(done => setTimeout(done, 1500));
    const result = await terminate(record);
    if (record.role === "coordinator") completed();
    return result;
  };
  const runtime = await createControlMigrationRuntime(f.input, { Database, adapter: f.adapter, preStopInventory: f.preStopInventory });
  t.after(() => runtime.close());
  await assert.rejects(runtime.apply(), { code: "CONTROL_MIGRATION_COMMAND_UNKNOWN" });
  await exited;
  await new Promise(done => setTimeout(done, 0));
  assert.equal(migrationActionBudgetMs(f.input.runtime, "start-coordinator"), 200);
  assert.equal(migrationActionBudgetMs(f.input.runtime, "rollback-coordinator"), 200);
  assert.equal(migrationActionBudgetMs(f.input.runtime, "validate-control-stabilization"), 200);
  const db = new Database(join(f.input.runtime.journalRoot, "migration.db"), { readonly: true });
  try {
    const row = db.prepare("SELECT * FROM control_commands WHERE step_id='stop-writer'").get();
    assert.equal(JSON.parse(row.spec).budget.maxDurationMs, 300000);
    assert.equal(JSON.parse(row.spec).deadline, f.input.runtime.deadline);
    assert.equal(row.state, "unknown");
  } finally { db.close(); }
});

test("invalid writer grace is refused before opening the migration journal", async t => {
  const f = await runtimeFixture(t);
  for (const value of [null, 0, 1999, 300001, 240000.5, "300000"]) {
    f.input.runtime.sourceCoordinatorStopBudgetMs = value;
    await assert.rejects(createControlMigrationRuntime(f.input, { Database, adapter: f.adapter, preStopInventory: f.preStopInventory }),
      { code: "CONTROL_MIGRATION_ACTION_BUDGET_INVALID" });
  }
  await assert.rejects(fs.stat(join(f.input.runtime.journalRoot, "migration.db")), { code: "ENOENT" });
  assert.deepEqual(f.events, []);
  assert.equal(migrationActionBudgetMs({ actionBudgetMs: 120000 }, "stop-writer"), 120000);
  assert.equal(migrationActionBudgetMs({ actionBudgetMs: 120000, sourceCoordinatorStopBudgetMs: 240000 }, "stop-writer"), 240000);
  assert.equal(migrationActionBudgetMs({ actionBudgetMs: 120000, sourceCoordinatorStopBudgetMs: 300000 }, "stop-writer"), 300000);
  assert.equal(migrationActionBudgetMs({ actionBudgetMs: 120000, sourceCoordinatorStopBudgetMs: 300000 }, "start-coordinator"), 120000);
  assert.throws(() => migrationActionBudgetMs({ actionBudgetMs: 300000 }, "stop-writer"),
    { code: "CONTROL_MIGRATION_ACTION_BUDGET_INVALID" });
});
test('normal repair headroom in the actual runtime rejects before the first source stop',async t=>{
  const f=await runtimeFixture(t,{withCollector:true,withNormalHandoff:true});
  f.input.runtime.adapter.stableControl.capacityTemplates.owner.resources.cpuMilliCores=2500;
  const runtime=await createControlMigrationRuntime(f.input,{Database,adapter:f.adapter,preStopInventory:f.preStopInventory,capacitySample:f.capacitySample,
    handoffRepairContext:f.handoffRepairContext,handoffSupervisorReadiness:f.handoffSupervisorReadiness});t.after(()=>runtime.close());
  await assert.rejects(runtime.apply(),/CAPACITY_BUDGET_INSUFFICIENT/);
  assert.deepEqual(f.events.filter(x=>x.startsWith('stop:')||x.startsWith('start:')),[]);
  assert(Object.values(f.source).every(r=>f.states.get(r.containerId).running));
});

test("a failed public inventory gate cannot create a first stop command or signal any source", async t => {
  const f = await runtimeFixture(t), failure = Object.assign(Error("Actual public receipt is absent"),
    { code: "CONTROL_MIGRATION_PUBLIC_INVENTORY_UNPROVEN" });
  let calls = 0;
  const runtime = await createControlMigrationRuntime(f.input, { Database, adapter: f.adapter,
    preStopInventory: async ({ lease, runtime }) => {
      calls++;
      assert.equal(lease.generation, 7);
      assert.equal(runtime, f.input.runtime);
      assert.ok(Object.values(f.source).every(row => f.states.get(row.containerId).running));
      throw failure;
    } });
  t.after(() => runtime.close());
  await assert.rejects(runtime.apply(), error => error === failure);
  assert.equal(calls, 1); assert.deepEqual(f.events, []);
  const db = new Database(join(f.input.runtime.journalRoot, "migration.db"), { readonly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) n FROM control_commands").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM control_migration_actor").get().n, 0);
  } finally { db.close(); }
});

test("the public inventory test port must be explicit and cannot be installed on the production path", async t => {
  const f = await runtimeFixture(t);
  await assert.rejects(createControlMigrationRuntime(f.input, { Database, adapter: f.adapter }),
    { code: "CONTROL_MIGRATION_PUBLIC_INVENTORY_PORT_REQUIRED" });
  await assert.rejects(createControlMigrationRuntime(f.input, { Database, preStopInventory: f.preStopInventory }),
    { code: "CONTROL_MIGRATION_TEST_PORT_FORBIDDEN" });
  await assert.rejects(fs.stat(join(f.input.runtime.journalRoot, "migration.db")), { code: "ENOENT" });
});

test('the actual migration runtime publishes normal capacity and obtains fresh Supervisor readiness before activate',async t=>{
  const f=await runtimeFixture(t,{withCollector:true,withNormalHandoff:true}),runtime=await createControlMigrationRuntime(f.input,{Database,
    adapter:f.adapter,preStopInventory:f.preStopInventory,capacitySample:f.capacitySample,handoffRepairContext:f.handoffRepairContext,handoffSupervisorReadiness:f.handoffSupervisorReadiness});
  t.after(()=>runtime.close());assert.equal((await runtime.apply()).state,'migrated');
  assert(f.events.indexOf('handoff:projected')<f.events.indexOf('stop:foundation'));
  assert(f.events.indexOf('handoff:actual')>f.events.indexOf('start:control-entry'));
  assert(f.events.indexOf('handoff:supervisor-ready')>f.events.indexOf('handoff:actual'));
  const db=new Database(join(f.input.runtime.journalRoot,'migration.db'),{readonly:true});
  try{const data=JSON.parse(db.prepare('SELECT data FROM control_migration_normal_handoff').get().data);assert.equal(data.ready.supervisor.qualified,true);}
  finally{db.close();}
});

test('failed normal readiness and conflicting normal files do not block the original runtime rollback',async t=>{
  const f=await runtimeFixture(t,{withCollector:true,withNormalHandoff:true}),runtime=await createControlMigrationRuntime(f.input,{Database,
    adapter:f.adapter,preStopInventory:f.preStopInventory,capacitySample:f.capacitySample,handoffRepairContext:f.handoffRepairContext,
    handoffSupervisorReadiness:async()=>{throw Error('explicit normal readiness failure');}});
  t.after(()=>runtime.close());await assert.rejects(runtime.apply(),/normal readiness failure/);
  const path=f.input.runtime.adapter.stableControl.capacityCollectorConfigPath;
  await fs.writeFile(path,JSON.stringify({foreign:true}),{mode:0o600});
  const checks=f.events.filter(x=>x.startsWith('handoff:')).length;
  assert.equal((await runtime.rollback()).state,'rolled-back');
  assert.equal(f.events.filter(x=>x.startsWith('handoff:')).length,checks);
  assert.deepEqual(JSON.parse(await fs.readFile(path)),{foreign:true});
  assert.equal(f.states.get(f.owner.containerId).running,true);
});
test("SQLite+HTTP with explicit Docker adapter fixture migrates without business DDL or protected lifecycle action, and source proof keeps original time", async (t) => {
  const f = await runtimeFixture(t),
    before = f.f.db
      .prepare("SELECT * FROM upgrade_attempts ORDER BY rowid")
      .all(),
    runtime = await createControlMigrationRuntime(f.input, {
      Database,
      adapter: f.adapter, preStopInventory: f.preStopInventory,
    });
  t.after(() => runtime.close());
  const webHealth = await fetch(f.input.runtime.entryOrigin + "/health");
  assert.equal(webHealth.status, 404);
  assert.match(webHealth.headers.get("content-type"), /^text\/html/);
  await webHealth.body?.cancel();
  const result = await runtime.apply();
  assert.equal(result.state, "migrated");
  assert.equal(result.pending.length, 0);
  assert.deepEqual(f.entryHealthRequests, ["/health", "/api/health"]);
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
test("Entry API health failure holds the real SQLite+HTTP migration before activation", async t => {
  const f = await runtimeFixture(t, { entryApiHealthStatus: 503 }),
    runtime = await createControlMigrationRuntime(f.input, {
      Database, adapter: f.adapter, preStopInventory: f.preStopInventory,
    });
  t.after(() => runtime.close());
  await assert.rejects(runtime.apply(), { code: "CONTROL_MIGRATION_ENTRY_HEALTH_UNPROVEN" });
  assert.deepEqual(f.entryHealthRequests, ["/api/health"]);
  const journal = new Database(join(f.input.runtime.journalRoot, "migration.db"), { readonly: true }),
    ledger = new Database(f.f.controlPath, { readonly: true });
  try {
    assert.equal(journal.prepare("SELECT count(*) n FROM control_commands WHERE step_id IN ('activate','validate-control-stabilization')").get().n, 0);
    const data = JSON.parse(journal.prepare("SELECT data FROM control_migration_run").get().data);
    assert.equal(data.activation, undefined);
    assert.equal(data.preActivationControl, undefined);
    assert.equal(ledger.prepare("SELECT mode FROM control_authority WHERE instance_id=?").get("instance").mode, "passive");
  } finally {
    journal.close();
    ledger.close();
  }
  assert.equal(f.states.get(f.owner.containerId).hostPid, f.owner.hostPid);
});
test("a lost create acknowledgement resumes only the original command and never launches a second role", async (t) => {
  const f = await runtimeFixture(t);
  f.setLoseAck("control-agent");
  const runtime = await createControlMigrationRuntime(f.input, {
    Database,
    adapter: f.adapter, preStopInventory: f.preStopInventory,
  });
  await assert.rejects(runtime.apply(), /fixture dropped acknowledgement/);
  assert.equal(runtime.status().pending.length, 1);
  const result = await runtime.resume();
  assert.equal(result.state, "migrated");
  assert.equal(f.events.filter((v) => v === "start:control-agent").length, 1);
  runtime.close();
});

test("an applied initial Supervisor that exited before admission closes its original start and stop in the real SQLite capacity consumer", async(t)=>{
  const f=await runtimeFixture(t,{withCollector:true,failSupervisorBeforeRegistration:true}),
    runtime=await createControlMigrationRuntime(f.input,{Database,adapter:f.adapter,preStopInventory:f.preStopInventory,capacitySample:f.capacitySample});
  t.after(()=>runtime.close());
  await assert.rejects(runtime.apply(),{code:"CONTROL_MIGRATION_CAPACITY_START_UNKNOWN"});
  const path=join(f.input.runtime.journalRoot,"migration.db"), read=()=>new Database(path,{readonly:true,fileMustExist:true});
  let db=read(), state=JSON.parse(db.prepare("SELECT data FROM control_migration_capacity").get().data);
  const peak=state.peak, original=db.prepare("SELECT * FROM control_commands WHERE command_id='migration:start-control-supervisor'").get();
  assert.equal(original.state,"applied");assert.equal(state.sequence,6);db.close();
  const planBefore=JSON.parse(await fs.readFile(f.input.runtime.capacity.planPath,"utf8"));
  assert.equal((await runtime.rollback()).state,"rolled-back");
  db=read();t.after(()=>db.close());
  state=JSON.parse(db.prepare("SELECT data FROM control_migration_capacity").get().data);
  assert.deepEqual(state.peak,peak);assert.deepEqual(db.prepare("SELECT * FROM control_commands WHERE command_id='migration:start-control-supervisor'").get(),original);
  const receipt=id=>JSON.parse(db.prepare("SELECT receipt FROM control_migration_capacity_receipts WHERE command_id=?").get(id).receipt),
    start=receipt("migration:start-control-supervisor"), stop=receipt("migration:rollback-stop-control-supervisor");
  assert.equal(start.classification,"applied-start-unregistered-at-original-stop");assert.equal(start.capacityRegistrationCompleted,false);
  assert.equal(start.currentInert,true);assert.equal(start.normalExit,false);assert.equal(stop.sequence,start.sequence+1);
  assert.equal(stop.classification,"original-stop-closes-unregistered-start");
  assert.equal(stop.physical.failedStartInert,true);assert.equal(stop.physical.terminationDispatched,false);
  assert.equal(f.events.filter(x=>x==="start:control-supervisor").length,1);
  assert.equal(f.events.includes("stop:control-supervisor"),false);assert.equal(f.events.includes("start:control-entry"),false);
  const after=JSON.parse(await fs.readFile(f.input.runtime.capacity.planPath,"utf8"));
  for(const [kind,rows] of Object.entries(planBefore.allocations))
    assert.deepEqual(after.allocations[kind].map(x=>({id:x.id,resources:x.resources})),rows.map(x=>({id:x.id,resources:x.resources})));
  for(const r of Object.values(f.source))assert.equal(f.states.get(r.containerId).running,true);
  assert.deepEqual(f.states.get(f.owner.containerId),f.owner);
  const count=f.events.length;assert.equal((await runtime.rollback()).state,"rolled-back");assert.equal(f.events.length,count);
});

test("Supervisor closure rejects acquired authority, side effects, later Entry and foreign pending before accounting writes",async(t)=>{
  for(const change of ["authority","side-effect","entry","pending"]){
    const f=await runtimeFixture(t,{withCollector:true,failSupervisorBeforeRegistration:true}),
      runtime=await createControlMigrationRuntime(f.input,{Database,adapter:f.adapter,preStopInventory:f.preStopInventory,capacitySample:f.capacitySample});
    t.after(()=>runtime.close());await assert.rejects(runtime.apply(),{code:"CONTROL_MIGRATION_CAPACITY_START_UNKNOWN"});
    const db=new Database(join(f.input.runtime.journalRoot,"migration.db"));
    if(change==="authority") {const ledger=new Database(f.input.controlPath);ledger.exec("UPDATE control_authority SET mode='active',revision=2");ledger.close();}
    if(change==="side-effect") {const state=new Database(f.input.runtime.adapter.stableControl.statePath);state.exec("CREATE TABLE supervisor_side_effect(singleton INTEGER);INSERT INTO supervisor_side_effect VALUES(1)");state.close();await fs.chmod(f.input.runtime.adapter.stableControl.statePath,0o600);}
    if(change==="entry") db.exec("UPDATE control_migration_run SET data=json_set(data,'$.entryProcess',json('{}'))");
    if(change==="pending") db.exec("UPDATE control_commands SET state='unknown' WHERE command_id='migration:bind-coordinator'");
    const before=db.prepare("SELECT * FROM control_migration_capacity").get(), events=f.events.length;
    await assert.rejects(runtime.rollback(),error=>/^CONTROL_MIGRATION_(FAILED_SUPERVISOR|FAILED_START_FOREIGN)/.test(error.code));
    assert.deepEqual(db.prepare("SELECT * FROM control_migration_capacity").get(),before);assert.equal(f.events.length,events);db.close();
  }
});

test("runtime dependency preflight rejects before source lifecycle dispatch",async(t)=>{
  const f=await runtimeFixture(t);f.adapter.preflightIndependentFoundation=async()=>{throw Object.assign(Error("missing runtime Docker"),{code:"CONTROL_RUNTIME_DOCKER_DEPENDENCY_UNPROVEN"});};
  const runtime=await createControlMigrationRuntime(f.input,{Database,adapter:f.adapter,preStopInventory:f.preStopInventory});t.after(()=>runtime.close());
  await assert.rejects(runtime.apply(),{code:"CONTROL_RUNTIME_DOCKER_DEPENDENCY_UNPROVEN"});assert.deepEqual(f.events,[]);
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
      adapter: f.adapter, preStopInventory: f.preStopInventory,
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
      adapter: f.adapter, preStopInventory: f.preStopInventory,
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
    adapter: f.adapter, preStopInventory: f.preStopInventory,
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
      adapter: f.adapter, preStopInventory: f.preStopInventory,
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

test("rollback publishes the registered Coordinator's exact normal stop for the next real public inventory, after restoring sources", async t => {
  const f = await runtimeFixture(t);
  await fs.writeFile(join(f.input.runtime.legacyProcessRoot, "original-coordinator.json"),
    JSON.stringify({ ...f.source.coordinator, kind: "coordinator", state: "started", instanceId: "instance",
      metadataPath: "/internal/application/identity" }), { mode: 0o600 });
  const runtime = await createControlMigrationRuntime(f.input, { Database, adapter: f.adapter, preStopInventory: f.preStopInventory });
  t.after(() => runtime.close());
  await runtime.apply();
  const target = [...f.states.values()].find(row => row.role === "coordinator" && row.containerId !== f.source.coordinator.containerId),
    receiptPath = join(f.input.runtime.retiredCoordinatorRoot, target.containerId + ".json");
  // Publication failure must not delay restoration. The same rollback can finish
  // publication from its applied stop without sending any signal a second time.
  await fs.mkdir(receiptPath);
  await assert.rejects(runtime.rollback());
  assert.ok(Object.values(f.source).every(row => f.states.get(row.containerId).running));
  const priorEvents = [...f.events];
  await fs.rmdir(receiptPath);
  assert.equal((await runtime.rollback()).state, "rolled-back");
  assert.deepEqual(f.events, priorEvents);
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  assert.equal(receipt.originalCommandId, "migration:rollback-stop-coordinator");
  assert.equal(receipt.migrationId, "migration");
  assert.equal(Object.hasOwn(receipt, "operationKind"), false);
  assert.equal(receipt.exitedAt, f.states.get(target.containerId).finishedAt);
  assert.equal(validateCoordinatorExitReceipt(receipt, { instanceId: "instance", target }), true);
  const inventory = await createCoordinatorInventory({ instanceId: "instance",
    processRoot: f.input.runtime.legacyProcessRoot,
    registryPath: join(f.input.runtime.installedRolesRoot, "installed-roles.json"),
    retiredRoot: f.input.runtime.retiredCoordinatorRoot,
    inspect: containerId => f.adapter.inspect({ containerId }),
    readIdentity: createCoordinatorIdentityReader({ instanceId: "instance",
      controlKey: f.input.runtime.keys.control, controllerKey: f.input.runtime.keys.controller }) })();
  assert.equal(inventory.complete, true);
  assert.equal(inventory.coordinators.length, 2);
  assert.equal(inventory.coordinators.filter(row => row.actualIdentity?.writerFenceValid).length, 1);
  assert.equal(inventory.coordinators.find(row => row.containerId === target.containerId).retiredPhysical.originalCommandId,
    "migration:rollback-stop-coordinator");
  const raw = await fs.readFile(receiptPath);
  assert.equal((await runtime.rollback()).state, "rolled-back");
  assert.deepEqual(await fs.readFile(receiptPath), raw);
  assert.deepEqual(f.events, priorEvents);
});

test("an abnormal Coordinator exit never becomes a public normal-exit receipt", async t => {
  const f = await runtimeFixture(t), runtime = await createControlMigrationRuntime(f.input,
    { Database, adapter: f.adapter, preStopInventory: f.preStopInventory });
  t.after(() => runtime.close());
  await runtime.apply();
  const target = [...f.states.values()].find(row => row.role === "coordinator" && row.containerId !== f.source.coordinator.containerId);
  f.states.set(target.containerId, { ...target, running: false, hostPid: 0, exitCode: 1 });
  await assert.rejects(runtime.rollback(), { code: "CONTROL_MIGRATION_NORMAL_EXIT_UNPROVEN" });
  await assert.rejects(fs.stat(join(f.input.runtime.retiredCoordinatorRoot, target.containerId + ".json")), { code: "ENOENT" });
  assert.equal(f.events.filter(event => event === "stop:coordinator").length, 1); // The original source only.
});

async function targetStopAdapter({ exitsAt = Infinity, terminal = {}, changed = {}, inspectMs = 0 } = {}) {
  let now = 0, signalled = false;
  const record = {
    containerId: "a".repeat(64), startIdentity: "original-control-agent-start",
    artifactDigest: digest("agent"), imageDigest: digest("runtime-image"),
    startedAt: "2026-11-06T00:00:00.000Z", hostPid: 1234, role: "control-agent",
    running: true, paused: false, restartPolicy: "no", restartCount: 0,
    oomKilled: false, exitCode: 0,
  }, signals = [];
  const adapter = await createMigrationDockerAdapter({
    actionBudgetMs: 120000, sourceCoordinatorStopBudgetMs: 300000,
    adapter: { docker: { cli: "docker", args: [] } },
  }, {
    clock: () => now,
    pause: async ms => { now += ms; },
    adapterFactory: async () => ({ inspect: async id => {
      assert.equal(id, record.containerId);
      now += inspectMs;
      return signalled && now >= exitsAt
        ? { ...record, running: false, hostPid: 0, ...terminal }
        : { ...record, ...(signalled ? changed : {}) };
    } }),
    run: async (_program, args) => { signals.push(args); signalled = true; return ""; },
  });
  return { adapter, record, signals, now: () => now };
}

test("target Docker stop waits for a slow normal exit within the original 120 second budget after exactly one SIGTERM", async () => {
  const f = await targetStopAdapter({ exitsAt: 90000 });
  const result = await f.adapter.terminate(f.record);
  assert.equal(result.running, false);
  assert.equal(result.exitCode, 0);
  assert.equal(f.now(), 90000);
  assert.deepEqual(f.signals, [["kill", "--signal", "SIGTERM", f.record.containerId]]);
});

test("target Docker stop cannot inherit the source writer's 300 second grace or reset an existing command deadline", async () => {
  const f = await targetStopAdapter();
  await assert.rejects(f.adapter.terminate(f.record), { code: "CONTROL_MIGRATION_EXIT_UNKNOWN" });
  assert.equal(f.now(), 120000);
  assert.deepEqual(f.signals, [["kill", "--signal", "SIGTERM", f.record.containerId]]);
  await assert.rejects(f.adapter.terminate(f.record, { deadline: 120000 }),
    { code: "CONTROL_MIGRATION_ACTION_BUDGET_EXCEEDED" });
  assert.equal(f.signals.length, 1);

  const remaining = await targetStopAdapter({ inspectMs: 100, exitsAt: 2000 });
  await assert.rejects(remaining.adapter.terminate(remaining.record, { deadline: 350 }),
    { code: "CONTROL_MIGRATION_EXIT_UNKNOWN" });
  assert.ok(remaining.now() <= 450); // An in-flight inspect cannot grant another grace.
  assert.equal(remaining.signals.length, 1);
});

test("target Docker stop rejects changed births, restarts and abnormal terminal outcomes without a second signal", async t => {
  for (const [name, options, code] of [
    ["birth changed while running", { changed: { startedAt: "2026-11-06T00:00:01.000Z" } }, "CONTROL_MIGRATION_PHYSICAL_CHANGED"],
    ["PID changed while running", { changed: { hostPid: 2345 } }, "CONTROL_MIGRATION_PHYSICAL_CHANGED"],
    ["automatic restart", { changed: { restartCount: 1 } }, "CONTROL_MIGRATION_PHYSICAL_CHANGED"],
    ["OOM terminal", { exitsAt: 100, terminal: { oomKilled: true } }, "CONTROL_MIGRATION_NORMAL_EXIT_UNPROVEN"],
    ["failed terminal", { exitsAt: 100, terminal: { exitCode: 1 } }, "CONTROL_MIGRATION_NORMAL_EXIT_UNPROVEN"],
  ]) await t.test(name, async () => {
    const f = await targetStopAdapter(options);
    await assert.rejects(f.adapter.terminate(f.record), { code });
    assert.deepEqual(f.signals, [["kill", "--signal", "SIGTERM", f.record.containerId]]);
  });
});

test("rollback reconciles a target's unknown stop by original CID lookup without dispatching SIGTERM again", async t => {
  const f = await runtimeFixture(t, { withCollector: true });
  const runtime = await createControlMigrationRuntime(f.input, { Database, adapter: f.adapter, preStopInventory: f.preStopInventory, capacitySample: f.capacitySample });
  t.after(() => runtime.close());
  await runtime.apply();
  const terminate = f.adapter.terminate;
  let agentSignals = 0;
  f.adapter.terminate = async (record, options) => {
    const result = await terminate(record, options);
    if (record.role === "control-agent") {
      agentSignals++;
      throw Object.assign(Error("Normal stop acknowledgement unavailable"), { code: "CONTROL_MIGRATION_EXIT_UNKNOWN" });
    }
    return result;
  };
  await assert.rejects(runtime.rollback(), { code: "CONTROL_MIGRATION_EXIT_UNKNOWN" });
  assert.equal((await runtime.rollback()).state, "rolled-back");
  assert.equal(agentSignals, 1);
  const db = new Database(join(f.input.runtime.journalRoot, "migration.db"), { readonly: true });
  try {
    const row = db.prepare("SELECT * FROM control_commands WHERE step_id='rollback-stop-control-agent'").get();
    assert.equal(row.state, "applied");
    assert.equal(JSON.parse(row.spec).budget.maxDurationMs, f.input.runtime.actionBudgetMs);
    assert.equal(JSON.parse(row.result).migrationBudgetExceeded, false);
  } finally { db.close(); }
  assert.deepEqual(f.states.get(f.owner.containerId), f.owner);
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
  const { codeFiles, commandDigest: omittedCommand, mountDigest: omittedMount, ...briefRecord } = expected,
    projection = { ...briefRecord, startedAt: new Date(Date.now()).toISOString(), hostPid: 2345 };
  row.State.StartedAt = projection.startedAt; row.State.Pid = projection.hostPid;
  await assert.rejects(adapter.inspect(projection), /CONTROL_MIGRATION_FOUNDATION_CODE_PROOF_REQUIRED/);
  const enriched = migrationCapacityInspectionTarget(projection, expected), inspected = await adapter.inspect(enriched);
  assert.equal(inspected.hostPid, 2345); assert.equal(inspected.startedAt, projection.startedAt);
  assert.deepEqual(enriched.codeFiles, codeFiles);
  assert.equal(migrationCapacityInspectionTarget({ ...projection, containerId: "9".repeat(64) }, expected).codeFiles, undefined);
  row.State.StartedAt = expected.startedAt; row.State.Pid = expected.hostPid;
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
test("runtime exports final lease and exact history after the actual last SQLite writer closes and removes both WAL sidecars", async (t) => {
  const f = await runtimeFixture(t, { closeOnStop: true }), runtime = await createControlMigrationRuntime(f.input, { Database, adapter: f.adapter, preStopInventory: f.preStopInventory });
  t.after(() => runtime.close());
  assert.equal((await runtime.apply()).state, "migrated");
  assert.ok(f.events.includes("business-last-writer-closed"));
  const journal = new Database(join(f.input.runtime.journalRoot, "migration.db"), { readonly: true });
  let state;
  try { state = JSON.parse(journal.prepare("SELECT data FROM control_migration_run").get().data); }
  finally { journal.close(); }
  assert.equal(state.readViewPreflight.closedWalProbe, "passed");
  const frozen = new Database(state.businessReadView.path, { readonly: true });
  try {
    assert.equal(frozen.prepare("SELECT expires_at FROM platform_role_leases WHERE role='state-coordinator'").get().expires_at, 0);
    assert.equal(frozen.prepare("SELECT count(*) n FROM upgrade_attempts").get().n, f.f.db.prepare("SELECT count(*) n FROM upgrade_attempts").get().n);
  } finally { frozen.close(); }
  // New-writer proof reads the real reopened database, not the expired view.
  assert.equal(f.f.db.prepare("SELECT generation FROM platform_role_leases WHERE role='state-coordinator'").get().generation, 8);
});
test("a failed closed-read-view preflight rejects before stopping any source", async (t) => {
  const f = await runtimeFixture(t), runtime = await createControlMigrationRuntime(f.input, { Database, adapter: f.adapter, preStopInventory: f.preStopInventory });
  t.after(() => runtime.close());
  await fs.chmod(f.input.runtime.journalRoot, 0o755);
  await assert.rejects(runtime.apply(), /CONTROL_MIGRATION_READ_VIEW_PRIVATE_DIRECTORY_REQUIRED/);
  assert.deepEqual(f.events, []);
});
test("release barrier waits for the real 28.5 second frozen expiry, bounded by the original action/deadline", async () => {
  let now = 1000, reads = 0;
  const lease = { instance_id: "instance", holder_id: "original", generation: 9, fence: 9, expires_at: now + 28500 },
    args = { readLease: () => { reads++; return lease; }, expected: lease, instanceId: "instance", deadline: 121000, clock: () => now, pause: async ms => { now += ms; } };
  assert.deepEqual(await waitForMigrationLeaseRelease(args), lease);
  assert.equal(now, lease.expires_at); assert.ok(reads > 120);
  now = 1000;
  await assert.rejects(waitForMigrationLeaseRelease({ ...args, deadline: 13000 }), /WRITER_LEASE_NOT_RELEASED/);
  assert.equal(now, 13000);
  now = lease.expires_at;
  await waitForMigrationLeaseRelease(args);
  await assert.rejects(waitForMigrationLeaseRelease({ ...args, readLease: () => ({ ...lease, generation: 10 }) }), /WRITER_CHANGED/);
});
function priorIncarnation(f, migrationId = "older-migration") {
  const source = f.source.coordinator, oldStart = Date.parse(source.startedAt) - 10000,
    facts = { schemaVersion: 1, kind: "coordinator-normal-exit", instanceId: f.input.instanceId, migrationId,
      originalCommandId: migrationId + ":stop-writer", target: { containerId: source.containerId, startIdentity: source.startIdentity,
        artifactDigest: source.artifactDigest, DockerStartedAt: new Date(oldStart).toISOString(), restartCount: source.restartCount },
      after: { running: false, hostPid: 0, restartPolicy: "no", restartCount: source.restartCount }, exitedAt: new Date(oldStart + 1000).toISOString() };
  return { ...facts, receiptDigest: digest(facts) };
}
test("same-CID prior incarnation is archived byte-for-byte before current exact-birth exit proof replaces its selector", async t => {
  const f = await runtimeFixture(t), prior = priorIncarnation(f), raw = JSON.stringify(prior, null, 2) + "\n  \n",
    currentPath = join(f.input.runtime.retiredCoordinatorRoot, f.source.coordinator.containerId + ".json");
  await fs.writeFile(currentPath, raw, { mode: 0o600 });
  const runtime = await createControlMigrationRuntime(f.input, { Database, adapter: f.adapter, preStopInventory: f.preStopInventory });
  t.after(() => runtime.close());
  assert.equal((await runtime.apply()).state, "migrated");
  assert.equal(await fs.readFile(join(f.input.runtime.retiredCoordinatorRoot, "history", f.source.coordinator.containerId, "older-migration.json"), "utf8"), raw);
  const current = JSON.parse(await fs.readFile(currentPath, "utf8"));
  assert.equal(current.migrationId, f.input.migrationId);
  assert.equal(current.target.DockerStartedAt, f.source.coordinator.startedAt);
  assert.equal(validateCoordinatorExitReceipt(current, { instanceId: f.input.instanceId, target: f.source.coordinator }), true);
  assert.equal(validateCoordinatorExitReceipt(prior, { instanceId: f.input.instanceId, target: f.source.coordinator }), false);
});
test("corrupt, same-operation changed-birth, or conflicting archived prior exits reject before any source stop", async t => {
  for (const mode of ["corrupt", "same-operation", "archive-conflict"]) {
    const f = await runtimeFixture(t), prior = priorIncarnation(f, mode === "same-operation" ? f.input.migrationId : "older-migration"),
      path = join(f.input.runtime.retiredCoordinatorRoot, f.source.coordinator.containerId + ".json");
    if (mode === "corrupt") prior.receiptDigest = digest("bad");
    await fs.writeFile(path, JSON.stringify(prior), { mode: 0o600 });
    if (mode === "archive-conflict") {
      const dir = join(f.input.runtime.retiredCoordinatorRoot, "history", f.source.coordinator.containerId);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(join(dir, "older-migration.json"), JSON.stringify(prior, null, 2), { mode: 0o600 });
    }
    const runtime = await createControlMigrationRuntime(f.input, { Database, adapter: f.adapter, preStopInventory: f.preStopInventory });
    try { await assert.rejects(runtime.apply(), /CONTROL_MIGRATION_EXIT_(RECEIPT_CONFLICT|HISTORY_CHANGED)/); }
    finally { runtime.close(); }
    assert.deepEqual(f.events, []);
  }
});
test("actual unsettled execution keeps the persistent actor barrier; no second runner or rollback can overlap", async (t) => {
  const f = await runtimeFixture(t);
  f.setHold("control-agent");
  const runtime = await createControlMigrationRuntime(f.input, {
    Database,
    adapter: f.adapter, preStopInventory: f.preStopInventory,
  });
  const first = runtime.apply();
  while (!f.events.includes("start:control-agent"))
    await new Promise((r) => setTimeout(r, 1));
  const other = await createControlMigrationRuntime(f.input, {
    Database,
    adapter: f.adapter, preStopInventory: f.preStopInventory,
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
      adapter: f.adapter, preStopInventory: f.preStopInventory,
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

async function undispatchedCapacityFailure(t, kind = "control-agent") {
  const f = await runtimeFixture(t, { withCollector: true });
  const db = new Database(join(f.input.runtime.journalRoot, "migration.db"));
  t.after(() => db.close());
  let overBudget = false, forcedClock;
  const runtime = await createControlMigrationRuntime(f.input, {
    Database,
    adapter: f.adapter, preStopInventory: f.preStopInventory,
    clock: () => forcedClock ?? Date.now(),
    capacitySample: async (...args) => {
      // Let the actual source stops and their collector receipts complete.
      // Exceed the resident host budget only inside the selected target command,
      // before the runtime can call adapter.launch(). Keep that excess during
      // rollback so restoring the reserved source cannot depend on readmission.
      if (db.prepare("SELECT state FROM control_commands WHERE command_id=?")
        .get("migration:start-" + kind)?.state === "executing") overBudget = true;
      const sample = await f.capacitySample(...args);
      return overBudget
        ? { ...sample, memory: { ...sample.memory, free: 800, available: 800 } }
        : sample;
    },
  });
  t.after(() => runtime.close());
  await assert.rejects(runtime.apply(), { code: "CAPACITY_RESIDENT_BUDGET_EXCEEDED" });
  assert.equal(overBudget, true);
  assert.equal(f.events.includes("start:" + kind), false);
  const command = () => db.prepare("SELECT * FROM control_commands WHERE command_id=?")
    .get("migration:start-" + kind);
  assert.equal(command().state, "unknown");
  assert.deepEqual(JSON.parse(command().result), { code: "CAPACITY_RESIDENT_BUDGET_EXCEEDED" });
  const capacity = () => JSON.parse(db.prepare("SELECT data FROM control_migration_capacity").get().data);
  const receipts = kind === "control-agent" ? 3 : 4;
  assert.equal(capacity().sequence, receipts);
  assert.equal(Boolean(capacity().pending), false);
  assert.equal(db.prepare("SELECT count(*) n FROM control_migration_capacity_receipts").get().n, receipts);
  return { ...f, runtime, db, command, capacity, expire: () => { forcedClock = f.input.runtime.rollbackDeadline + 1; } };
}

test("rollback closes a proven undispatched target under its original command ID without registering target capacity", async t => {
  const f = await undispatchedCapacityFailure(t);
  const original = f.command(), plan = JSON.parse(await fs.readFile(f.input.runtime.capacity.planPath, "utf8"));
  const lifecycle = createProtectedRoleLifecycle({ instanceId: "instance", registryRoot: join(f.f.root, "legacy") });
  f.adapter.lookupLaunch = async record => {
    assert.equal(record.commandId, "migration:start-control-agent");
    assert.equal(record.startIdentity, f.input.runtime.targets["control-agent"].record.startIdentity);
    return lifecycle.lookupStart(record);
  };
  const result = await f.runtime.rollback(), closed = f.command();
  assert.equal(result.state, "rolled-back");
  assert.deepEqual(result.pending, []);
  for (const field of ["operation_id", "command_id", "step_id", "spec", "spec_digest", "created_at"])
    assert.equal(closed[field], original[field]);
  assert.equal(closed.state, "definitely-not-applied");
  assert.deepEqual(JSON.parse(closed.result), {
    dispatched: false,
    originalState: "unknown",
    originalUnknownResult: JSON.parse(original.result),
  });
  assert.equal(f.db.prepare("SELECT count(*) n FROM control_commands WHERE command_id=?")
    .get("migration:start-control-agent").n, 1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM control_migration_capacity_receipts WHERE command_id=?")
    .get("migration:start-control-agent").n, 0);
  assert.equal(f.capacity().sequence, 6);
  assert.equal(Boolean(f.capacity().pending), false);
  assert.equal(f.events.some(e => e.startsWith("start:")), false);
  assert.equal(f.events.some(e => e.startsWith("stop:control-")), false);
  assert.ok(["coordinator", "installer", "foundation"].every(role => f.events.includes("restart:" + role)));
  assert.deepEqual(f.states.get(f.owner.containerId), f.owner);
  const restored = JSON.parse(await fs.readFile(f.input.runtime.capacity.planPath, "utf8"));
  const reservations = p => Object.values(p.allocations).flat().map(({ id, resources }) => [id, resources])
    .sort(([a], [b]) => a.localeCompare(b));
  assert.deepEqual(reservations(restored), reservations(plan));
  assert.deepEqual(restored.limits, plan.limits);
  const events = [...f.events];
  assert.equal((await f.runtime.rollback()).state, "rolled-back");
  assert.deepEqual(f.events, events);
});

test("the same negative-start reconciliation works for a later business-role target", async t => {
  const f = await undispatchedCapacityFailure(t, "coordinator"), lookup = f.adapter.lookupLaunch;
  const lifecycle = createProtectedRoleLifecycle({ instanceId: "instance", registryRoot: join(f.f.root, "legacy") });
  f.adapter.lookupLaunch = async record => record.kind === "coordinator"
    ? lifecycle.lookupStart(record)
    : lookup(record);
  assert.equal((await f.runtime.rollback()).state, "rolled-back");
  assert.equal(f.command().state, "definitely-not-applied");
  assert.equal(f.events.includes("start:coordinator"), false);
  assert.equal(f.events.filter(e => e === "start:control-agent").length, 1);
  assert.equal(f.events.filter(e => e === "stop:control-agent").length, 1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM control_migration_capacity_receipts WHERE command_id=?")
    .get("migration:start-coordinator").n, 0);
});

test("rollback retains an unknown start when lookup cannot prove that dispatch never occurred", async t => {
  for (const found of [
    { state: "unknown", result: { code: "target-or-dispatch-unknown" } },
    { state: "definitely-not-applied", result: { dispatched: true } },
    { state: "definitely-not-applied", result: {} },
  ]) await t.test(JSON.stringify(found), async t => {
    const f = await undispatchedCapacityFailure(t), command = f.command(), capacity = f.capacity(), events = [...f.events];
    f.adapter.lookupLaunch = async () => found;
    await assert.rejects(f.runtime.rollback(), { code: "CONTROL_MIGRATION_COMMAND_UNKNOWN" });
    assert.deepEqual(f.command(), command);
    assert.deepEqual(f.capacity(), capacity);
    assert.deepEqual(f.events, events);
    assert.equal(f.db.prepare("SELECT count(*) n FROM control_migration_capacity_receipts").get().n, 3);
  });
});

test("an existing launch intent and conflicting target physical identity cannot become a negative start", async t => {
  const f = await undispatchedCapacityFailure(t), command = f.command(), capacity = f.capacity(), events = [...f.events];
  const spec = f.input.runtime.targets["control-agent"], record = {
    ...spec.record, kind: "control-agent", instanceId: "instance", attemptId: "migration",
    operationId: "migration", commandId: "migration:start-control-agent", specDigest: digest(spec),
  };
  const lifecycle = createProtectedRoleLifecycle({
    instanceId: "instance", registryRoot: join(f.f.root, "legacy"),
    findByName: async () => "5".repeat(64),
    inspect: async containerId => ({ ...record, containerId, role: record.kind, running: true,
      artifactDigest: digest("a-conflicting-container-already-exists") }),
  });
  await lifecycle.prepareStart(record);
  f.adapter.lookupLaunch = lifecycle.lookupStart;
  await assert.rejects(f.runtime.rollback(), { code: "ROLE_START_PHYSICAL_IDENTITY_UNKNOWN" });
  assert.deepEqual(f.command(), command);
  assert.deepEqual(f.capacity(), capacity);
  assert.deepEqual(f.events, events);
});

test("an undispatched start cannot be reconciled after the original rollback deadline", async t => {
  const f = await undispatchedCapacityFailure(t), command = f.command(), events = [...f.events];
  // The persisted configuration stays identical; only the injected clock moves.
  f.expire();
  f.adapter.lookupLaunch = async () => ({ state: "definitely-not-applied", result: { dispatched: false } });
  await assert.rejects(f.runtime.rollback(), { code: "CONTROL_MIGRATION_DEADLINE_EXPIRED" });
  assert.deepEqual(f.command(), command);
  assert.deepEqual(f.events, events);
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
      adapter: f.adapter, preStopInventory: f.preStopInventory,
    });
    await assert.rejects(runtime.apply());
    assert.deepEqual(f.events, []);
    runtime.close();
  }
});


test("readiness timeout preserves the last actual RPC failure while keeping its original start budget", async t => {
  const f = await runtimeFixture(t, { apiReadinessFailureCodes: ["FIRST_READINESS_FAILURE", "LAST_READINESS_FAILURE"] });
  f.input.runtime.actionBudgetMs = 600;
  const runtime = await createControlMigrationRuntime(f.input, { Database, adapter: f.adapter, preStopInventory: f.preStopInventory });
  t.after(() => runtime.close());
  await assert.rejects(runtime.apply(), error => {
    assert.equal(error.code, "CONTROL_MIGRATION_READINESS_BUDGET_EXCEEDED");
    assert.equal(error.cause?.code, "LAST_READINESS_FAILURE");
    assert.equal(error.cause?.status, 503);
    return true;
  });
  assert.ok(f.events.filter(event => event.startsWith("api-readiness:")).length >= 2);
  assert.equal(f.events.filter(event => event === "start:api").length, 1);
  assert.equal(f.events.includes("start:control-supervisor"), false);
  assert.equal((await runtime.rollback()).state, "rolled-back");
});

test("an exited exact API candidate fails readiness promptly, never relaunches, and rolls back with its real failed-exit capacity receipt", async t => {
  const f = await runtimeFixture(t, { withCollector: true, failApiReadiness: true });
  const peak = JSON.parse(await fs.readFile(f.input.runtime.capacity.planPath, "utf8"));
  const runtime = await createControlMigrationRuntime(f.input, { Database, adapter: f.adapter, preStopInventory: f.preStopInventory, capacitySample: f.capacitySample });
  t.after(() => runtime.close());
  await assert.rejects(runtime.apply(), error => {
    assert.equal(error.code, "CONTROL_MIGRATION_ROLE_EXITED");
    assert.equal(error.role, "api"); assert.equal(error.exitCode, 1);
    assert.equal(error.cause?.code, "CONTROL_PRIVATE_RPC_FAILED");
    return true;
  });
  // On resume the collector first closes the changed resident inventory. It must
  // hold that original operation, never replay the applied API launch.
  await assert.rejects(runtime.resume(), { code: "CAPACITY_CONTAINER_INVENTORY_CHANGED" });
  assert.equal(f.events.filter(e => e === "start:api").length, 1);
  const result = await runtime.rollback();
  assert.equal(result.state, "rolled-back");
  assert.equal(f.events.filter(e => e === "start:api").length, 1);
  assert.equal(f.events.includes("stop:api"), false);
  assert.equal(f.events.includes("stop:owner"), false);
  assert.ok(["coordinator", "installer", "foundation"].every(role => f.events.includes("restart:" + role)));
  const db = new Database(join(f.input.runtime.journalRoot, "migration.db"), { readonly: true });
  try {
    const row = db.prepare("SELECT result FROM control_commands WHERE command_id=?").get("migration:rollback-stop-api");
    const observed = JSON.parse(row.result);
    assert.equal(observed.exitCode, 1);assert.equal(observed.exitDisposition, "failed-candidate");
    const capacity = JSON.parse(db.prepare("SELECT receipt FROM control_migration_capacity_receipts WHERE command_id=?").get("migration:rollback-stop-api").receipt);
    assert.equal(capacity.physical.exitCode, 1);assert.equal(capacity.physical.exitDisposition, "failed-candidate");
    assert.equal(db.prepare("SELECT count(*) n FROM control_commands WHERE command_id='migration:start-api'").get().n, 1);
  } finally { db.close(); }
  const restored = JSON.parse(await fs.readFile(f.input.runtime.capacity.planPath, "utf8"));
  assert.deepEqual(restored.limits, peak.limits);
  const reservations = plan => Object.values(plan.allocations).flat().map(r => [r.id, r.resources]).sort(([a], [b]) => a.localeCompare(b));
  assert.deepEqual(reservations(restored), reservations(peak));
  assert.equal(restored.allocations.candidate.every(r => !r.resident), true);
  assert.equal(f.states.get(f.owner.containerId).running, true);
});

test("failed API rollback still rejects changed birth, OOM, restart count, policy or unrecognized exit", async t => {
  for (const apiExitPatch of [{ startedAt: new Date(1).toISOString() }, { oomKilled: true }, { restartCount: 1 }, { restartPolicy: "always" }, { exitCode: 137 }]) {
    const f = await runtimeFixture(t, { failApiReadiness: true, apiExitPatch });
    const runtime = await createControlMigrationRuntime(f.input, { Database, adapter: f.adapter, preStopInventory: f.preStopInventory });
    try {
      await assert.rejects(runtime.apply());
      await assert.rejects(runtime.rollback(), /CONTROL_MIGRATION_(FAILED_CANDIDATE_EXIT_UNPROVEN|NORMAL_EXIT_UNPROVEN)/);
      assert.equal(f.events.filter(e => e === "start:api").length, 1);
      assert.equal(f.events.some(e => e.startsWith("restart:")), false);
      assert.equal(f.events.includes("stop:api"), false);
    } finally { runtime.close(); }
  }
});
