import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createMigrationCapacity } from "./control-migration-capacity.mjs";
import { createControlCommandJournal } from "./control-command-journal.mjs";
import { freezeCapacityBudget } from "./capacity-admission.mjs";
import {
  capacityHostIdentity,
  capacityResidentIdentity,
} from "./control-capacity-collector.mjs";
import { digest } from "./trust.mjs";
import { atomicJson } from "./io.mjs";
const Database = createRequire(
  new URL("../../api/package.json", import.meta.url),
)("better-sqlite3");
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "migration-capacity-")),
  );
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = 1000000;
  const vector = (n, disks = 0) => ({
    memoryBytes: n,
    cpuMilliCores: n,
    ioBytesPerSecond: n,
    disks: { data: disks },
  });
  const raw = (n, role, own = true) => ({
    containerId: n.repeat(64),
    pid: 100 + parseInt(n, 16),
    birthTicks: "900" + n,
    cgroupDigest: digest("group" + n),
    startedAt: new Date(now - 10000).toISOString(),
    restartCount: 0,
    instanceId: own ? "instance" : null,
    role: own ? role : null,
    startIdentity: own ? role + "-original-identity" : null,
    artifactDigest: own ? digest(role) : null,
    memoryBytes: 10,
    cpuNs: 1,
    ioBytes: 1,
    monotonic: 1000,
  });
  const coor = raw("1", "coordinator"),
    owner = raw("2", "owner"),
    foundation = raw("3", "foundation", false),
    target = raw("4", "api");
  let containers = [coor, owner, foundation];
  const physical = (r) => ({
    ...r,
    hostPid: r.pid,
    running: true,
    paused: false,
    restartPolicy: "no",
    oomKilled: false,
    exitCode: 0,
    role: r.role ?? "foundation",
    startIdentity: r.startIdentity ?? "exact-legacy-code-start",
    artifactDigest: r.artifactDigest ?? digest("actual-legacy-code"),
  });
  const states = new Map(
    [coor, owner, foundation, target].map((r) => [r.containerId, physical(r)]),
  );
  const snapshot = () => ({
    vmBootId: "00112233-4455-6677-8899-aabbccddeeff",
    procIdentity: { path: "/host/proc", dev: "1", ino: "1" },
    cpu: { cpus: 1, total: 10000, idle: 9000 },
    memory: { total: 1000, free: 800, available: 800 },
    devices: [
      {
        id: "data",
        dev: "2049",
        majorMinor: "8:1",
        capacityBytes: 10000,
        freeBytes: 9000,
        availableBytes: 9000,
        readBytes: 10,
        writeBytes: 10,
      },
    ],
    containers: structuredClone(containers),
    startedAt: now,
    finishedAt: now,
    monotonic: 1000,
  });
  const source = physical(coor),
    oldFoundation = physical(foundation),
    newApi = physical(target);
  const config = {
    schemaVersion: 1,
    instanceId: "instance",
    sourceDigest: digest("frozen-source"),
    hostProcRoot: "/host/proc",
    devices: [
      { id: "data", path: "/fixture-data", dev: "2049", majorMinor: "8:1" },
    ],
    residents: [
      { id: "source", containers: [coor] },
      { id: "owner", containers: [owner] },
    ],
    ioEffectiveBudgetBytesPerSecond: 1000,
    ioQualificationPath: join(root, "io.json"),
    ioQualificationRawDigest: digest("io"),
    observationPath: join(root, "observation.json"),
    dockerSocketPath: "/fixture.sock",
    sampleIntervalMs: 250,
    timeoutMs: 1000,
  };
  const resident = (id, categoryRows, resources) => ({
    id,
    resident: true,
    identityDigest: capacityResidentIdentity(categoryRows),
    resources,
  });
  const plan = freezeCapacityBudget({
    instanceId: "instance",
    sourceDigest: config.sourceDigest,
    maxObservationAgeMs: 5000,
    limits: vector(1000, 10000),
    allocations: {
      source: [
        resident("source", [coor], vector(100)),
        {
          id: "host-overhead",
          resident: true,
          identityDigest: capacityHostIdentity(snapshot(), "instance"),
          resources: vector(100, 2000),
        },
      ],
      retainedOwners: [resident("owner", [owner], vector(200))],
      retainedGuests: [],
      existingCandidates: [],
      candidate: [
        {
          id: "api",
          resident: false,
          identityDigest: digest("api"),
          resources: vector(100, 1000),
        },
      ],
      control: [
        {
          id: "control",
          resident: false,
          identityDigest: digest("control"),
          resources: vector(100, 1000),
        },
      ],
      verification: [],
      recovery: [
        {
          id: "recovery",
          resident: false,
          identityDigest: digest("recovery"),
          resources: vector(100, 1000),
        },
      ],
    },
  });
  const planPath = join(root, "plan.json"),
    configPath = join(root, "config.json");
  await atomicJson(planPath, plan);
  await atomicJson(configPath, config);
  const db = new Database(join(root, "migration.db"));
  t.after(() => db.close());
  const journal = createControlCommandJournal({
    sqlite: db,
    instanceId: "instance",
    clock: () => now,
    assertAuthority: () => {},
  });
  const actions = [
    {
      commandId: "migration:stop-writer",
      direction: "stop",
      role: "coordinator",
      target: source,
      targetDigest: digest(source),
      allocationId: "source",
      deadline: now + 10000,
    },
    {
      commandId: "migration:start-api",
      direction: "start",
      role: "api",
      targetDigest: digest({ kind: "api" }),
      allocationId: "api",
      deadline: now + 10000,
    },
    {
      commandId: "migration:stop-foundation",
      direction: "stop",
      role: "foundation",
      target: oldFoundation,
      targetDigest: digest(oldFoundation),
      allocationId: "host-overhead",
      deadline: now + 10000,
    },
  ];
  const commit = (commandId, result, state = "applied") => {
    const a = actions.find((x) => x.commandId === commandId),
      cmd = {
        operationId: "migration",
        commandId,
        stepId: commandId,
        spec: {
          kind: "migration-action",
          targetDigest: a.targetDigest,
          deadline: a.deadline,
          budget: { maxDurationMs: 1000 },
        },
        authorization: {
          epoch: 1,
          executorId: "own-fixture",
          expiresAt: now + 20000,
        },
      };
    journal.prepare(cmd);
    journal.begin(cmd);
    journal.record({ ...cmd, state, result });
  };
  const options = {
    sqlite: db,
    journal,
    instanceId: "instance",
    migrationId: "migration",
    initialPlanDigest: plan.planDigest,
    planPath,
    configPath,
    observationPath: config.observationPath,
    deadline: now + 20000,
    actions,
    inspect: async (r) => structuredClone(states.get(r.containerId)),
    sample: async () => snapshot(),
    clock: () => now,
  };
  const stop = (r) => {
    containers = containers.filter((x) => x.containerId !== r.containerId);
    const p = {
      ...states.get(r.containerId),
      running: false,
      hostPid: 0,
      exitCode: 0,
    };
    states.set(r.containerId, p);
    return p;
  };
  return {
    options,
    book: createMigrationCapacity(options),
    plan,
    config,
    source,
    newApi,
    oldFoundation,
    states,
    commit,
    stop,
    start: () => {
      containers.push(target);
      return states.get(target.containerId);
    },
    addUnknown: () => {
      containers.push(raw("5", "unknown"));
    },
    advance: (n) => {
      now += n;
    },
    readPlan: async () => JSON.parse(await fs.readFile(planPath, "utf8")),
  };
}
test("real command journal normal exits preserve peak budgets; exact starts consume only the reserved allocation and retain original command IDs", async (t) => {
  const f = await fixture(t);
  await f.book.initialize();
  const source = structuredClone(f.source);
  f.commit("migration:stop-writer", f.stop(source));
  const one = await f.book.register({
    operationId: "migration",
    commandId: "migration:stop-writer",
  });
  const stopped = await f.readPlan();
  assert.equal(stopped.allocations.source[0].resident, false);
  assert.deepEqual(
    stopped.allocations.source[0].resources,
    f.plan.allocations.source[0].resources,
  );
  f.commit("migration:start-api", f.start());
  const two = await f.book.register({
    operationId: "migration",
    commandId: "migration:start-api",
  });
  assert.equal(two.sequence, 2);
  assert.equal((await f.readPlan()).allocations.candidate[0].resident, true);
  assert.deepEqual(
    await f.book.register({
      operationId: "migration",
      commandId: "migration:stop-writer",
    }),
    one,
  );
  assert.equal(f.book.status().initialPlanDigest, f.plan.planDigest);
});
test("the unlabeled legacy Foundation may change only its exact measured host-overhead membership, retaining that whole reservation", async (t) => {
  const f = await fixture(t);
  await f.book.initialize();
  f.commit("migration:stop-foundation", f.stop(f.oldFoundation));
  await f.book.register({
    operationId: "migration",
    commandId: "migration:stop-foundation",
  });
  const p = await f.readPlan(),
    old = f.plan.allocations.source[1];
  assert.notEqual(p.allocations.source[1].identityDigest, old.identityDigest);
  assert.deepEqual(p.allocations.source[1].resources, old.resources);
  assert.equal(p.allocations.source[1].resident, true);
});
test("unknown command, changed full birth, unbudgeted workload, expired deadline and altered budget remain closed", async (t) => {
  for (const bad of ["unknown", "birth", "outside", "deadline", "budget"]) {
    const f = await fixture(t);
    await f.book.initialize();
    const result = f.stop(f.source);
    f.commit(
      "migration:stop-writer",
      result,
      bad === "unknown" ? "unknown" : "applied",
    );
    if (bad === "birth")
      f.states.get(f.source.containerId).startedAt = new Date(1).toISOString();
    if (bad === "outside") f.addUnknown();
    if (bad === "deadline") f.advance(20001);
    if (bad === "budget") {
      const p = await f.readPlan();
      p.allocations.source[0].resources.memoryBytes++;
      await atomicJson(f.options.planPath, freezeCapacityBudget(p));
    }
    await assert.rejects(
      f.book.register({
        operationId: "migration",
        commandId: "migration:stop-writer",
      }),
    );
    assert.equal(f.book.status().sequence, 0);
  }
});
test("a crash between plan and collector publications resumes the same pending receipt and cannot accept a replaced physical birth", async (t) => {
  const f = await fixture(t);
  let failed = false;
  const book = createMigrationCapacity({
    ...f.options,
    write: async (path, value) => {
      if (path === f.options.configPath && !failed) {
        failed = true;
        throw Error("own fixture lost publication ACK");
      }
      await atomicJson(path, value);
    },
  });
  await book.initialize();
  f.commit("migration:stop-writer", f.stop(f.source));
  await assert.rejects(
    book.register({
      operationId: "migration",
      commandId: "migration:stop-writer",
    }),
  );
  assert.ok(book.status().pending);
  const resumed = createMigrationCapacity(f.options);
  await resumed.initialize();
  assert.equal(resumed.status().sequence, 1);
  assert.equal(resumed.status().pending, undefined);
  assert.equal((await f.readPlan()).allocations.source[0].resident, false);
});
