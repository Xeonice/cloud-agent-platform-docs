import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import {
  createCandidateSupervisor,
  createSupervisorClient,
} from "./candidate-supervisor.mjs";
import { createControlPlaneClient } from "./control-plane-client.mjs";
import { freezeCapacityBudget } from "./capacity-admission.mjs";
import { createCoordinatorInventory } from "./supervisor-inventory.mjs";
import { digest } from "./trust.mjs";
import { treeManifest } from "./io.mjs";
const Database = createRequire(
  new URL("../../api/package.json", import.meta.url),
)("better-sqlite3");
async function fixture(t) {
  const base = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "supervisor-integration-")),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = join(base, "installer"),
    key = "k".repeat(32),
    instanceId = "instance",
    agentStartIdentity = "stable-agent-start-identity";
  await fs.mkdir(root, { mode: 0o700 });
  const pkg = { digest: digest("package"), format: "native-tar" },
    artifactRoot = join(root, "artifacts", pkg.digest.slice(7));
  await fs.mkdir(join(artifactRoot, "web"), { recursive: true });
  await fs.writeFile(
    join(artifactRoot, "web", "server.js"),
    "// small fixture web\n",
  );
  const files = await treeManifest(artifactRoot),
    components = Object.fromEntries(
      ["api", "web", "coordinator", "owner", "installer"].map((kind) => [
        kind,
        {
          artifactDigest: digest(kind === "web" ? files : []),
          inputFingerprint: digest("input-" + kind),
        },
      ]),
    );
  const plan = {
    planDigest: digest("fixed-plan"),
    package: pkg,
    steps: [{ kind: "web" }],
  };
  const snapshot = {
    attempt: { instanceId, actorId: "admin", requestId: "request" },
    plan,
    manifest: { components },
  };
  await fs.writeFile(
    join(artifactRoot, "installed.json"),
    JSON.stringify({ packageDigest: pkg.digest, treeDigest: digest(files), components }),
    { mode: 0o600 },
  );
  await fs.writeFile(
    join(artifactRoot, "upgrade-artifact.json"),
    JSON.stringify({ treeDigest: digest(files), components, files }),
    { mode: 0o600 },
  );
  let authority = {
    instanceId,
    mode: "active",
    epoch: 1,
    operationId: "operation",
    holderId: "engine",
    kind: "upgrade",
    leaseExpiresAt: Date.now() + 120000,
  };
  const controls = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null;
    controls.push({ path: req.url, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/internal/control/authority/verify") {
      if (
        body.epoch !== authority.epoch ||
        body.operationId !== authority.operationId ||
        body.executorId !== authority.holderId
      ) {
        res.writeHead(409);
        res.end("{}");
      } else res.end(JSON.stringify(authority));
      return;
    }
    if (req.url === "/metadata") {
      res.end(
        JSON.stringify({
          instanceId,
          role: "installer",
          startIdentity: agentStartIdentity,
          artifactDigest: components.installer.artifactDigest,
          observedAt: new Date().toISOString(),
          controlSystem: { version: "fixture-control-1" },
        }),
      );
      return;
    }
    if (req.url === "/internal/upgrades/attempt/renew") {
      res.end("{}");
      return;
    }
    if (req.url === "/internal/upgrades/attempt") {
      res.end(JSON.stringify(snapshot));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const origin = "http://127.0.0.1:" + server.address().port;
  const resource = {
      memoryBytes: 100,
      cpuMilliCores: 100,
      ioBytesPerSecond: 100,
      disks: { artifacts: 100 },
    },
    item = (id, resident) => ({
      id,
      resident,
      identityDigest: digest(id),
      resources: resource,
    });
  const budget = freezeCapacityBudget({
    instanceId,
    sourceDigest: digest("source"),
    maxObservationAgeMs: 5000,
    limits: {
      memoryBytes: 1000,
      cpuMilliCores: 1000,
      ioBytesPerSecond: 1000,
      disks: { artifacts: 1000 },
    },
    allocations: {
      source: [item("source", true)],
      control: [item("control", true)],
      recovery: [item("recovery", false)],
      candidate: [item("new-web", false)],
      verification: [],
      existingCandidates: [],
      retainedOwners: [],
      retainedGuests: [],
    },
  });
  const observation = {
    known: true,
    exclusiveAccounting: true,
    instanceId,
    sourceDigest: budget.sourceDigest,
    revision: 1,
    observedAt: new Date().toISOString(),
    limits: budget.limits,
    available: {
      memoryBytes: 800,
      cpuMilliCores: 800,
      ioBytesPerSecond: 800,
      disks: { artifacts: 800 },
    },
    residents: [item("source", true), item("control", true)].map(
      ({ id, identityDigest, resources }) => ({
        id,
        identityDigest,
        resources,
      }),
    ),
  };
  const stableControl = {
    origin,
    key,
    accessKey: "a".repeat(32),
    statePath: join(base, "foundation", "supervisor.db"),
    controlDbPath: join(base, "control", "ledger", "control.db"),
    capacityPlanPath: join(base, "capacity.json"),
    resourceObservationPath: join(base, "resources.json"),
    referenceStatePath: join(base, "references.json"),
    agentStartIdentity,
  };
  for (const [path, value] of [
    [stableControl.capacityPlanPath, budget],
    [stableControl.resourceObservationPath, observation],
    [stableControl.referenceStatePath, { instanceId, candidates: [] }],
  ])
    await fs.writeFile(path, JSON.stringify(value), { mode: 0o600 });
  let launches = 0,
    gate = null,
    notifyLaunch;
  const launchStarted = new Promise((resolve) => {
    notifyLaunch = resolve;
  });
  const physical = new Map();
  const launchAdapter = {
    inspect: async (id) => physical.get(id),
    launch: async (spec) => {
      await spec.assertBeforeDispatch();
      launches++;
      notifyLaunch();
      if (gate) await gate;
      const proof = {
        containerId: "a".repeat(64),
        role: spec.kind,
        running: true,
        startIdentity: spec.record.startIdentity,
        artifactDigest: spec.record.artifactDigest,
        attemptId: spec.record.attemptId,
        commandId: spec.record.commandId,
        operationId: spec.record.operationId,
        hostPid: 1234,
        startedAt: new Date().toISOString(),
      };
      physical.set(proof.containerId, proof);
      return proof;
    },
    lookupStart: async (record) => ({
      state: "applied",
      result: { ...record, ...physical.get("a".repeat(64)) },
    }),
  };
  const coordinator = createControlPlaneClient({
    controlOrigin: origin,
    controlKey: key,
    coordinatorOrigin: "http://127.0.0.1:1",
    coordinatorKey: key,
    instanceId,
  });
  const supervisorOptions = {
    root,
    instanceId,
    key,
    coordinator,
    controlEnv: {
      PLATFORM_CONTROL_RPC_KEY: key,
      PLATFORM_INSTANCE_ID: instanceId,
    },
    webPort: 45492,
    launchAdapter,
    businessObserverKey: "b".repeat(32),
    stableControl,
    Database,
  };
  let supervisor = await createCandidateSupervisor(supervisorOptions);
  t.after(() => supervisor.close());
  const client = createSupervisorClient({
    origin: supervisor.origin,
    key,
    instanceId,
  });
  const command = (id = "command", maxDurationMs = 10000) => ({
    operationId: "operation",
    commandId: id,
    stepId: "web",
    authorization: {
      epoch: 1,
      executorId: "engine",
      expiresAt: authority.leaseExpiresAt,
    },
    spec: {
      schemaVersion: 1,
      kind: "supervisor-start",
      instanceId,
      request: { attemptId: "attempt", kind: "web" },
      deadline: Date.now() + 30000,
      budget: { maxDurationMs },
      planDigest: plan.planDigest,
      packageDigest: pkg.digest,
      capacityPlanDigest: budget.planDigest,
      capacityAllocationId: "new-web",
      resources: budget.allocations.candidate[0].resources,
      sourceDigest: budget.sourceDigest,
    },
  });
  const post = (path, input) =>
    fetch(supervisor.origin + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-platform-internal-key": key,
        "x-platform-instance-id": instanceId,
      },
      body: JSON.stringify(input),
    });
  return {
    root,
    base,
    client,
    command,
    supervisor,
    post,
    controls,
    stableControl,
    observation,
    launchStarted,
    lostAckClient: () =>
      createSupervisorClient({
        origin: supervisor.origin,
        key,
        instanceId,
        fetcher: async (url, options) => {
          const response = fetch(url, options);
          response
            .then(
              (value) => value.body?.cancel(),
              () => {},
            )
            .catch(() => {});
          return Promise.race([
            response,
            launchStarted.then(() => {
              throw Object.assign(
                Error("fixture lost acknowledgement after launch"),
                { name: "TimeoutError" },
              );
            }),
          ]);
        },
      }),
    get launches() {
      return launches;
    },
    setGate: (p) => {
      gate = p;
    },
    setAuthority: (change) => {
      authority = { ...authority, ...change };
    },
    artifactRoot,
    async reopen() {
      await supervisor.close();
      supervisor = await createCandidateSupervisor(supervisorOptions);
      return createSupervisorClient({ origin: supervisor.origin, key, instanceId });
    },
  };
}
test("publication completed before journal acknowledgement is recovered only by original read-only command lookup after Supervisor restart", async (t) => {
  const f=await fixture(t);
  await f.client.admitControl({epoch:1,operationId:'operation',executorId:'engine'});
  const command=f.command('publish-window');command.spec.kind='supervisor-publish';command.spec.request.kind='package';
  f.supervisor.stableControl.journal.prepare(command);
  f.supervisor.stableControl.journal.begin(command);
  const before=f.supervisor.stableControl.lookup(command);
  assert.equal(before.state,'executing');
  const client=await f.reopen(),row=await client.lookupCommand({operationId:command.operationId,commandId:command.commandId});
  assert.equal(row.state,'applied');assert.equal(row.result.root,f.artifactRoot);assert.equal(row.result.packageDigest,command.spec.packageDigest);
  assert.deepEqual(row.spec,before.spec);assert.equal(row.spec.deadline,before.spec.deadline);assert.equal(f.launches,0);
  assert.deepEqual(await client.lookupCommand({operationId:command.operationId,commandId:command.commandId}),row);
});
test("unknown publication with a changed installed tree stays unknown and is never unpacked or replayed by lookup", async (t) => {
  const f=await fixture(t);await f.client.admitControl({epoch:1,operationId:'operation',executorId:'engine'});
  const command=f.command('unknown-publish');command.spec.kind='supervisor-publish';command.spec.request.kind='package';
  const journal=f.supervisor.stableControl.journal;journal.prepare(command);journal.begin(command);journal.record({...command,state:'unknown',result:{code:'LOST_ACK'}});
  await fs.appendFile(join(f.artifactRoot,'web/server.js'),'// changed\n');
  const client=await f.reopen(),row=await client.lookupCommand({operationId:command.operationId,commandId:command.commandId});
  assert.equal(row.state,'unknown');assert.equal(row.result.code,'SUPERVISOR_PUBLICATION_PROOF_UNKNOWN');assert.equal(f.launches,0);
  assert.match(await fs.readFile(join(f.artifactRoot,'web/server.js'),'utf8'),/changed/);
});
test("real Supervisor HTTP joins global/local admission, control-only ledger, frozen capacity and process launch", async (t) => {
  const f = await fixture(t),
    command = f.command();
  await assert.rejects(
    f.client.start({ attemptId: "attempt", fence: 1, kind: "web" }, command),
  );
  assert.equal(f.launches, 0);
  await f.client.admitControl({
    epoch: 1,
    operationId: "operation",
    executorId: "engine",
  });
  const record = await f.client.start(
    { attemptId: "attempt", fence: 1, kind: "web" },
    command,
  );
  assert.equal(record.commandId, command.commandId);
  assert.equal(f.launches, 1);
  await f.client.start(
    { attemptId: "attempt", fence: 1, kind: "web" },
    command,
  );
  assert.equal(f.launches, 1);
  assert.ok(f.controls.some((v) => v.path === "/internal/upgrades/attempt"));
  assert.ok(
    f.controls.some((v) => v.path === "/internal/upgrades/attempt/renew"),
  );
  const identity = await f.client.currentInstaller();
  assert.equal(identity.controlSystem.version, "fixture-control-1");
  await assert.rejects(
    f.supervisor.restartCurrentInstaller(),
    /STABLE_INSTALLER_UPDATE_FORBIDDEN/,
  );
});
test("capacity shortage and installer bypass are rejected by real RPC before launch", async (t) => {
  const f = await fixture(t);
  await f.client.admitControl({
    epoch: 1,
    operationId: "operation",
    executorId: "engine",
  });
  await fs.writeFile(
    f.stableControl.resourceObservationPath,
    JSON.stringify({
      ...f.observation,
      available: { ...f.observation.available, memoryBytes: 1 },
    }),
  );
  const response = await f.post("/start", {
    attemptId: "attempt",
    fence: 1,
    kind: "web",
    command: f.command(),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "CAPACITY_BUDGET_INSUFFICIENT");
  assert.equal(f.launches, 0);
  assert.equal(
    (
      await f.post("/activate-installer", {
        attemptId: "attempt",
        fence: 1,
        kind: "installer",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.post("/start", {
        attemptId: "attempt",
        fence: 1,
        kind: "installer",
        command: f.command(),
      })
    ).status,
    409,
  );
});
test("actual late launch stays single-flight after a lost HTTP acknowledgement; only original readonly result lookup resolves it", async (t) => {
  const f = await fixture(t);
  await f.client.admitControl({
    epoch: 1,
    operationId: "operation",
    executorId: "engine",
  });
  let release;
  f.setGate(
    new Promise((r) => {
      release = r;
    }),
  );
  const command = f.command("late-command");
  await assert.rejects(
    f
      .lostAckClient()
      .start({ attemptId: "attempt", fence: 1, kind: "web" }, command),
    { code: "SUPERVISOR_COMMAND_RESULT_UNKNOWN" },
  );
  assert.equal(f.launches, 1);
  await assert.rejects(
    f.client.start({ attemptId: "attempt", fence: 1, kind: "web" }, command),
    { code: "SUPERVISOR_COMMAND_RESULT_UNKNOWN" },
  );
  assert.equal(f.launches, 1);
  release();
  // Wait for the actual server-side journal completion, not an assumed 20ms
  // scheduling window. Looking up while the original Promise is still live is
  // correctly rejected by the production single-flight guard.
  const settledDeadline=Date.now()+5000;
  while(f.supervisor.stableControl.lookup(command)?.state==='executing'&&Date.now()<settledDeadline)await new Promise(r=>setTimeout(r,5));
  assert.equal(f.supervisor.stableControl.lookup(command)?.state,'applied');
  const row = await f.client.lookupCommand({
    operationId: "operation",
    commandId: "late-command",
  });
  assert.equal(row.state, "applied");
  assert.equal(row.commandId, "late-command");
  assert.equal(f.launches, 1);
});
test("inventory includes persisted registered and pre-restart process Coordinators; missing physical state refuses complete", async (t) => {
  const base = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "coordinator-inventory-")),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const proc = join(base, "processes");
  await fs.mkdir(proc);
  const record = (n) => ({
    instanceId: "instance",
    kind: "coordinator",
    containerId: String(n).repeat(64),
    startIdentity: "start-identity-" + n + "-long",
    artifactDigest: digest("coor" + n),
    origin: "http://127.0.0.1:" + String(45000 + n),
    managementOrigin: "http://127.0.0.1:" + String(45100 + n),
  });
  const first = record(1),
    second = record(2),
    registryPath = join(base, "registry.json");
  await fs.writeFile(registryPath, JSON.stringify([first]), { mode: 0o600 });
  await fs.writeFile(
    join(proc, "old-coordinator.json"),
    JSON.stringify(second),
    { mode: 0o600 },
  );
  let unknown = false;
  const inventory = createCoordinatorInventory({
    instanceId: "instance",
    processRoot: proc,
    registryPath,
    readIdentity: async (r) => ({
      instanceId: r.instanceId,
      startIdentity: r.startIdentity,
      artifactDigest: r.artifactDigest,
      generation: 7,
      pid: 1,
      writerFenceValid: false,
      observedAt: new Date().toISOString(),
    }),
    inspect: async (id) => {
      if (unknown) throw Error("unknown");
      const r = id === first.containerId ? first : second;
      return {
        containerId: id,
        startIdentity: r.startIdentity,
        artifactDigest: r.artifactDigest,
        hostPid: 1234,
        startedAt: "2026-10-20T12:00:00Z",
        running: true,
        paused: false,
      };
    },
  });
  const complete = await inventory();
  assert.equal(complete.complete, true);
  assert.equal(complete.coordinators.length, 2);
  unknown = true;
  const failed = await inventory();
  assert.equal(failed.complete, false);
  assert.ok(
    failed.missing.includes("COORDINATOR_PHYSICAL_OR_LIVE_IDENTITY_UNKNOWN"),
  );
});
test("inventory deadline is bounded and cannot start another inspect pass while original readonly work remains pending", async (t) => {
  const base = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "coordinator-inventory-")),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const proc = join(base, "processes");
  await fs.mkdir(proc);
  const r = {
      instanceId: "instance",
      kind: "coordinator",
      containerId: "a".repeat(64),
      startIdentity: "fixed-start-identity",
      artifactDigest: digest("coor"),
      origin: "http://127.0.0.1:45000",
    },
    registryPath = join(base, "registry.json");
  await fs.writeFile(registryPath, JSON.stringify([r]), { mode: 0o600 });
  let finish,
    calls = 0;
  const inventory = createCoordinatorInventory({
    instanceId: "instance",
    processRoot: proc,
    registryPath,
    timeoutMs: 10,
    inspect: async () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  assert.equal((await inventory()).complete, false);
  const busy = await inventory();
  assert.deepEqual(busy.missing, ["COORDINATOR_INVENTORY_BUSY"]);
  assert.equal(calls, 1);
  finish({});
  await new Promise((r) => setImmediate(r));
});


test("the business Coordinator observer key reads metadata and cannot acquire authority, query commands or dispatch lifecycle actions", async (t) => {
  const f=await fixture(t), headers={"x-platform-internal-key":"b".repeat(32),"x-platform-instance-id":"instance"};
  const metadata=await fetch(f.supervisor.origin+"/metadata",{headers}); assert.equal(metadata.status,200); assert.equal((await metadata.json()).instanceId,"instance");
  for(const [method,path] of [["GET","/retained-readers"],["GET","/coordinator-inventory"],["POST","/start"],["POST","/control-admission"],["POST","/command-result"],["POST","/private/control-maintenance/submit"]]){
    const response=await fetch(f.supervisor.origin+path,{method,headers,...(method==='POST'?{body:'{}'}:{})});assert.equal(response.status,403);
  }
  assert.equal(f.launches,0);
});
