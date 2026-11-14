import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  chmod,
  readFile,
  rm,
  realpath,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import {
  createProductionCandidateReferenceCollector,
  createCandidateReferenceCollector,
  deriveCandidateReferenceState,
  readControlReferenceFacts,
  readCandidateReferenceHttp,
  REFERENCE_ATTEMPT_TERMINAL_STATES,
  REFERENCE_ATTEMPT_ACTIVE_STATES,
  REFERENCE_RECOVERY_STATES,
  REFERENCE_RECOVERY_PHASES,
} from "./candidate-reference-collector.mjs";
import { planCandidateRetirement } from "./candidate-retirement.mjs";
import { digest } from "./trust.mjs";
const Database = createRequire(
  new URL("../../api/package.json", import.meta.url),
)("better-sqlite3");
const now = Date.now(),
  stamp = new Date(now).toISOString(),
  hash = "sha256:" + "a".repeat(64);
const target = {
  instanceId: "fixture-instance",
  role: "api",
  containerId: "a".repeat(64),
  startIdentity: "own-fixture-start-identity",
  hostPid: 420,
  startedAt: stamp,
  artifactDigest: hash,
  attemptId: "failed-attempt",
};
function proof() {
  return {
    instanceId: target.instanceId,
    target,
    record: { ...target, kind: "api", origin: "http://127.0.0.1:1" },
    before: {
      ...target,
      pid: 1,
      role: "api",
      birthTicks: "98765",
      cgroupDigest: digest("own-cgroup"),
      running: true,
      paused: false,
      restartPolicy: "no",
      restartCount: 0,
    },
    entry: {
      known: true,
      instanceId: target.instanceId,
      observedAt: stamp,
      value: {
        oldApi: { digest: "sha256:" + "b".repeat(64) },
        candidateApi: null,
        retainedWeb: [],
        httpByDigest: {},
        wsByDigest: {},
      },
    },
    binding: {
      known: true,
      instanceId: target.instanceId,
      observedAt: stamp,
      value: { artifactDigest: "sha256:" + "b".repeat(64) },
    },
    control: {
      known: true,
      instanceId: target.instanceId,
      observedAt: stamp,
      attempts: [
        {
          attemptId: target.attemptId,
          state: "failed",
          leaseExpiresAt: now - 100,
        },
      ],
      authority: {
        operation_id: "new-admin-intent",
        holder_id: "controller",
        lease_expires_at: now + 10000,
      },
      fallbacks: [],
      pending: [],
      recovery: 0,
      userOperations: 0,
    },
    census: {
      schemaVersion: 1,
      instanceId: target.instanceId,
      role: "api",
      pid: 1,
      startIdentity: target.startIdentity,
      artifactDigest: hash,
      observedAt: stamp,
      complete: true,
      writer: false,
      counts: {
        http: 0,
        ws: 0,
        streams: 0,
        workers: 0,
        owners: 0,
        guests: 0,
        handoff: 0,
        recovery: 0,
        userOperations: 0,
      },
    },
  };
}
function derive(p) {
  return deriveCandidateReferenceState({
    ...p,
    after: p.after ?? structuredClone(p.before),
    now,
  });
}
function plan(state) {
  return planCandidateRetirement({
    instanceId: target.instanceId,
    target,
    state,
    deadline: now + 10000,
    budget: { maxDurationMs: 5000 },
    maxObservationAgeMs: 5000,
    now,
  });
}
test("actual idle API can qualify; every actual dependency independently blocks SIGTERM", () => {
  assert.equal(
    plan(derive(proof())).qualified,
    true,
    JSON.stringify(derive(proof())),
  );
  for (const ref of [
    "entry",
    "http",
    "ws",
    "writer",
    "handoff",
    "activeCommands",
    "fallback",
    "owners",
    "guests",
    "recovery",
    "workers",
    "userOperations",
  ]) {
    const p = proof();
    if (ref === "entry") p.entry.value.candidateApi = { digest: hash };
    else if (ref === "http" || ref === "ws")
      p.entry.value[ref + "ByDigest"][hash] = 1;
    else if (ref === "activeCommands")
      p.control.pending = [{ commandId: "other" }];
    else if (ref === "fallback")
      p.control.fallbacks = [{ artifactDigest: hash }];
    else if (ref === "writer") p.census.writer = true;
    else p.census.counts[ref] = 1;
    assert.equal(plan(derive(p)).qualified, false, ref);
  }
});
test("missing counters, stale role stamp, Owner/Guest role, process replacement and unknown worker proof are never zero", () => {
  for (const mutate of [
    (p) => delete p.census.counts.workers,
    (p) => (p.census.observedAt = new Date(now - 5001).toISOString()),
    (p) => (p.target = { ...p.target, role: "owner" }),
    (p) => (p.after = { ...p.before, birthTicks: "replacement" }),
    (p) => (p.census.complete = false),
  ]) {
    const p = proof();
    mutate(p);
    assert.equal(plan(derive(p)).qualified, false);
    assert.equal(derive(p).known, false);
  }
});
test("Entry digest counters remain conservative for another physical process with identical bytes; retained web/fallback is protected", () => {
  const p = proof();
  p.entry.value.httpByDigest[hash] = 1;
  assert.equal(derive(p).references.http, 1);
  p.entry.value.httpByDigest = {};
  p.entry.value.retainedWeb = [{ digest: hash, root: "/retained" }];
  assert.equal(derive(p).references.entry, 1);
});
async function collectorFixture() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "candidate-reference-")),
  );
  await chmod(directory, 0o700);
  const p = proof();
  const readers = {
    inventory: async () => ({
      instanceId: target.instanceId,
      complete: true,
      records: [p.record],
    }),
    entry: async () => p.entry,
    binding: async () => p.binding,
    control: async () => p.control,
    inspect: async () => p.before,
    census: async () => p.census,
  };
  return {
    directory,
    p,
    readers,
    collector: createCandidateReferenceCollector({
      instanceId: target.instanceId,
      observationPath: join(directory, "refs.json"),
      readers,
      clock: () => now,
      timeoutMs: 100,
    }),
  };
}
test("sole publication preserves reference revision across clock-only sampling and increments on actual dependency change", async () => {
  const f = await collectorFixture();
  try {
    const first = await f.collector.collect(),
      second = await f.collector.collect();
    assert.equal(first.candidates[0].known, true);
    assert.equal(second.candidates[0].revision, first.candidates[0].revision);
    f.p.census.counts.workers = 1;
    const third = await f.collector.collect();
    assert.equal(
      third.candidates[0].revision,
      second.candidates[0].revision + 1,
    );
    assert.equal(third.candidates[0].references.workers, 1);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
test("reference changes during collection invalidate prior idle fact and are durably unknown", async () => {
  const f = await collectorFixture();
  let reads = 0;
  f.readers.entry = async () => {
    const value = structuredClone(f.p.entry);
    if (++reads > 1) value.value.candidateApi = { digest: hash };
    return value;
  };
  try {
    const value = await f.collector.collect();
    assert.equal(value.complete, false);
    assert.equal(value.reason, "REFERENCE_SOURCE_CHANGED");
    assert.equal(
      JSON.parse(await readFile(join(f.directory, "refs.json"))).candidates[0]
        .known,
      false,
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
test("timeout is not completion: late census Promise keeps single-flight and cannot overwrite unknown publication", async () => {
  const f = await collectorFixture();
  let release;
  f.readers.census = () =>
    new Promise((ok) => {
      release = () => ok(f.p.census);
    });
  try {
    const value = await f.collector.collect();
    assert.equal(value.reason, "REFERENCE_COLLECTION_TIMEOUT");
    assert.equal(f.collector.pending(), true);
    await assert.rejects(
      f.collector.collect(),
      /REFERENCE_COLLECTION_IN_PROGRESS/,
    );
    release();
    await new Promise((ok) => setTimeout(ok, 30));
    assert.equal(f.collector.pending(), false);
    assert.equal(
      JSON.parse(await readFile(join(f.directory, "refs.json"))).complete,
      false,
    );
  } finally {
    release?.();
    await rm(f.directory, { recursive: true, force: true });
  }
});
test("fixed read-only HTTP endpoint checks auth and streamed response bound without redirect", async () => {
  let path;
  const server = createServer((req, res) => {
    path = req.url;
    assert.equal(
      req.headers["x-platform-internal-key"],
      "synthetic-private-key-32-characters",
    );
    res.end(JSON.stringify({ actual: true }));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const value = await readCandidateReferenceHttp({
      instanceId: target.instanceId,
      origin: "http://127.0.0.1:" + server.address().port,
      path: "/internal/control/retirement",
      key: "synthetic-private-key-32-characters",
      signal: AbortSignal.timeout(1000),
    });
    assert.deepEqual(value, { actual: true });
    assert.equal(path, "/internal/control/retirement");
    await assert.rejects(
      readCandidateReferenceHttp({
        instanceId: target.instanceId,
        origin: "http://127.0.0.1:1",
        path: "/runtime/create",
        key: "synthetic-private-key-32-characters",
      }),
      /REFERENCE_HTTP_SCOPE_UNKNOWN/,
    );
  } finally {
    await new Promise((ok) => server.close(ok));
  }
});
test("real SQLite snapshots exclude only exact current retirement command; unrelated and digest-changed commands block", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reference-ledger-"));
  const path = join(directory, "control.db"),
    db = new Database(path),
    sup = new Database(":memory:");
  try {
    db.exec(
      `CREATE TABLE control_authority(instance_id,operation_id,holder_id,lease_expires_at,mode);CREATE TABLE upgrade_attempts(instance_id,attempt_id,state,controller_id,lease_expires_at,plan,source_activation,source_actual,manifest,observed_at,target_release_id,generation);CREATE TABLE upgrade_instances(instance_id,confirmed_release);CREATE TABLE control_recovery_intents(instance_id,recovery_id,phase,authorization_plan,plan);CREATE TABLE upgrade_recoveries(instance_id,recovery_attempt_id,state);CREATE TABLE platform_operations(instance_id,operation_id,role,state);CREATE TABLE control_commands(instance_id,operation_id,command_id,spec_digest,state,spec);`,
    );
    sup.exec(
      "CREATE TABLE control_commands(instance_id,operation_id,command_id,spec_digest,state,spec)",
    );
    db.prepare("INSERT INTO control_authority VALUES(?,?,?,?,?)").run(
      target.instanceId,
      "new-op",
      "holder",
      now + 5000,
      "active",
    );
    db.prepare(
      "INSERT INTO upgrade_attempts(instance_id,attempt_id,state,controller_id,lease_expires_at,plan,source_activation,source_actual) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      target.instanceId,
      target.attemptId,
      "failed",
      null,
      now - 10,
      "{}",
      "{}",
      null,
    );
    db.prepare("INSERT INTO upgrade_instances VALUES(?,?)").run(
      target.instanceId,
      null,
    );
    const command = {
      operationId: "new-op",
      commandId: "retire-one",
      specDigest: digest({ kind: "retire-candidate" }),
    };
    sup
      .prepare("INSERT INTO control_commands VALUES(?,?,?,?,?,?)")
      .run(
        target.instanceId,
        command.operationId,
        command.commandId,
        command.specDigest,
        "executing",
        JSON.stringify({ kind: "retire-candidate" }),
      );
    const ro = new Database(path, { readonly: true });
    try {
      const opts = {
        sqlite: ro,
        supervisorSqlite: sup,
        instanceId: target.instanceId,
        targets: [target, { ...target, role: "coordinator" }],
        command,
        clock: () => now,
      };
      const facts = readControlReferenceFacts(opts);
      assert.equal(facts.attempts.length, 1);
      assert.equal(facts.pending.length, 0);
      const mixed = readControlReferenceFacts({
        ...opts,
        targets: [
          target,
          {
            ...target,
            attemptId: "migration-source-without-fabricated-attempt",
          },
        ],
      });
      assert.equal(mixed.attempts.length, 2);
      assert.equal(
        mixed.attempts.find((r) => r.attemptId === target.attemptId).state,
        "failed",
      );
      assert.deepEqual(
        mixed.attempts.find(
          (r) => r.attemptId === "migration-source-without-fabricated-attempt",
        ),
        {
          attemptId: "migration-source-without-fabricated-attempt",
          known: false,
          state: null,
          controllerId: null,
          leaseExpiresAt: null,
        },
      );
      const original = proof();
      original.control = mixed;
      assert.equal(derive(original).known, true);
      const migrated = proof();
      migrated.control = mixed;
      migrated.target = {
        ...target,
        attemptId: "migration-source-without-fabricated-attempt",
      };
      assert.equal(derive(migrated).known, false);

      assert.equal(
        readControlReferenceFacts({
          ...opts,
          command: { ...command, specDigest: "sha256:" + "f".repeat(64) },
        }).pending.length,
        1,
      );
      sup
        .prepare("INSERT INTO control_commands VALUES(?,?,?,?,?,?)")
        .run(
          target.instanceId,
          "old-op",
          "unknown-other",
          "hash",
          "unknown",
          "{}",
        );
      assert.equal(readControlReferenceFacts(opts).pending.length, 1);
      db.exec("DROP TABLE control_recovery_intents");
      assert.throws(() => readControlReferenceFacts(opts));
    } finally {
      ro.close();
    }
  } finally {
    db.close();
    sup.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production assembly reads fixed real files/HTTP/RO ledger, uses death-safe private SQLite mutex, and publishes no keys", async () => {
  const directory = await realpath(
      await mkdtemp(join(tmpdir(), "reference-production-")),
    ),
    root = join(directory, "installer"),
    publicationRoot = join(directory, "publication"),
    dbPath = join(directory, "control.db");
  await mkdir(join(root, "processes"), { recursive: true, mode: 0o700 });
  await mkdir(join(publicationRoot, "installed-roles"), {
    recursive: true,
    mode: 0o700,
  });
  const p = proof(),
    record = { ...p.record, kind: "api" };
  await writeFile(
    join(root, "processes", target.attemptId + "-api.json"),
    JSON.stringify(record),
    { mode: 0o600 },
  );
  await writeFile(
    join(publicationRoot, "installed-roles", "installed-roles.json"),
    "[]",
    { mode: 0o600 },
  );
  const bindingPath = join(directory, "coordinator.json");
  await writeFile(bindingPath, JSON.stringify(p.binding.value), {
    mode: 0o600,
  });
  const db = new Database(dbPath),
    sup = new Database(":memory:");
  db.exec(
    `CREATE TABLE control_authority(instance_id,operation_id,holder_id,lease_expires_at,mode);CREATE TABLE upgrade_attempts(instance_id,attempt_id,state,controller_id,lease_expires_at,plan,source_activation,source_actual,manifest,observed_at,target_release_id,generation);CREATE TABLE upgrade_instances(instance_id,confirmed_release);CREATE TABLE control_recovery_intents(instance_id,recovery_id,phase,authorization_plan,plan);CREATE TABLE upgrade_recoveries(instance_id,recovery_attempt_id,state);CREATE TABLE platform_operations(instance_id,operation_id,role,state);CREATE TABLE control_commands(instance_id,operation_id,command_id,spec_digest,state,spec);`,
  );
  sup.exec(
    "CREATE TABLE control_commands(instance_id,operation_id,command_id,spec_digest,state,spec)",
  );
  db.prepare("INSERT INTO control_authority VALUES(?,?,?,?,?)").run(
    target.instanceId,
    "new-op",
    "holder",
    now + 5000,
    "active",
  );
  db.prepare(
    "INSERT INTO upgrade_attempts(instance_id,attempt_id,state,controller_id,lease_expires_at,plan,source_activation,source_actual) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    target.instanceId,
    target.attemptId,
    "failed",
    null,
    now - 10,
    "{}",
    "{}",
    null,
  );
  db.prepare("INSERT INTO upgrade_instances VALUES(?,?)").run(
    target.instanceId,
    null,
  );
  await chmod(dbPath, 0o600);
  const key = "synthetic-production-reference-key-32";
  let release,
    hold = false;
  const server = createServer((req, res) => {
    assert.equal(req.headers["x-platform-internal-key"], key);
    if (req.url === "/binding") res.end(JSON.stringify(p.entry.value));
    else {
      const answer = () => res.end(JSON.stringify(p.census));
      if (hold) release = answer;
      else answer();
    }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  record.origin = "http://127.0.0.1:" + server.address().port;
  await writeFile(
    join(root, "processes", target.attemptId + "-api.json"),
    JSON.stringify(record),
    { mode: 0o600 },
  );
  let one, two;
  try {
    const options = {
      root,
      publicationRoot,
      instanceId: target.instanceId,
      controlDbPath: dbPath,
      coordinatorBindingPath: bindingPath,
      entryOrigin: "http://127.0.0.1:" + server.address().port,
      entryKey: key,
      apiKey: key,
      coordinatorKey: key,
      adapter: {
        inspect: async () => ({
          ...p.before,
          cgroupDigest: digest("own-cgroup"),
        }),
      },
      Database,
      supervisorSqlite: sup,
      observationPath: join(directory, "refs.json"),
    };
    one = await createProductionCandidateReferenceCollector(options);
    two = await createProductionCandidateReferenceCollector(options);
    const value = await one.collect();
    assert.equal(value.candidates[0].known, true, JSON.stringify(value));
    assert.equal(plan(value.candidates[0]).qualified, true);
    const sourceActivationDigest = digest("real-fixture-bootstrap-activation");
    const initialRoles = ["api", "coordinator", "web", "installer"].map(
      (kind, i) => ({
        instanceId: target.instanceId,
        kind,
        containerId: String(i + 1).repeat(64),
        startIdentity: "actual-initial-fixture-" + kind,
        hostPid: 600 + i,
        startedAt: stamp,
        birthTicks: String(1000 + i),
        cgroupDigest: digest("initial-cgroup-" + i),
        artifactDigest: digest("initial-" + kind),
        inputFingerprint: digest("initial-input-" + kind),
        artifactRoot: "/own/initial-artifact",
        origin: "http://127.0.0.1:" + (40000 + i),
        pid: 1,
        attemptId: null,
        retirementScope: "bootstrap-activation",
        sourceActivationDigest,
      }),
    );
    const initialFacts = {
      schemaVersion: 1,
      kind: "initial-role-inventory",
      instanceId: target.instanceId,
      activation: {
        releaseId: "v0.0.1-fixture",
        activationGeneration: 1,
        activatedAt: stamp,
        activationDigest: sourceActivationDigest,
      },
      roles: initialRoles,
    };
    await writeFile(
      join(publicationRoot, "initial-role-inventory.json"),
      JSON.stringify({
        ...initialFacts,
        inventoryDigest: digest(initialFacts),
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(publicationRoot, "installed-roles", "installed-roles.json"),
      JSON.stringify([{ ...initialRoles[1], attemptId: "cold-install" }]),
      { mode: 0o600 },
    );
    const mixed = await one.collect();
    assert.equal(mixed.candidates.length, 1);
    assert.equal(mixed.candidates[0].known, true);
    assert.equal(mixed.protectedSources.length, 4);
    assert.equal(
      mixed.protectedSources.every(
        (row) => row.retirementAllowed === false && row.attemptId === null,
      ),
      true,
    );
    const written = await readFile(options.observationPath, "utf8");
    assert.equal(written.includes(key), false);
    assert.equal(written.includes("ownerKey"), false);
    hold = true;
    const pending = one.collect();
    while (!release) await new Promise((ok) => setImmediate(ok));
    await assert.rejects(two.collect(), /REFERENCE_COLLECTOR_BUSY/);
    release();
    await pending;
    await one.idle();
    assert.equal(one.pending(), false);
    const mutex = new Database(join(directory, "reference-publication.db"), {
      readonly: true,
    });
    try {
      assert.equal(
        mutex
          .prepare("SELECT COUNT(*) AS n FROM reference_publication_guard")
          .get().n,
        1,
      );
    } finally {
      mutex.close();
    }
  } finally {
    release?.();
    await one?.closeWhenIdle();
    await two?.closeWhenIdle();
    await new Promise((ok) => server.close(ok));
    db.close();
    sup.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a rejected reader does not release single-flight while another read is genuinely pending", async () => {
  const f = await collectorFixture();
  let release;
  f.readers.entry = async () => {
    throw Error("offline");
  };
  f.readers.binding = () =>
    new Promise((ok) => {
      release = () => ok(f.p.binding);
    });
  try {
    const value = await f.collector.collect();
    assert.equal(value.complete, false);
    assert.equal(f.collector.pending(), true);
    release();
    await f.collector.idle();
    assert.equal(f.collector.pending(), false);
  } finally {
    release?.();
    await f.collector.idle();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("dedicated SQLite publication lock is released by actual owner-process death, without a stale wx marker", async () => {
  const directory = await realpath(
      await mkdtemp(join(tmpdir(), "reference-mutex-death-")),
    ),
    path = join(directory, "reference-publication.db");
  await writeFile(path, "", { mode: 0o600 });
  const db = new Database(path);
  db.exec(
    "CREATE TABLE reference_publication_guard(instance_id,publication_digest)",
  );
  db.pragma("busy_timeout=0");
  const modulePath = createRequire(
    new URL("../../api/package.json", import.meta.url),
  ).resolve("better-sqlite3");
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const Database=require(process.argv[1]);const db=new Database(process.argv[2]);db.pragma('busy_timeout=0');db.exec('BEGIN IMMEDIATE');console.log('LOCKED');setInterval(()=>{},1000);`,
      modulePath,
      path,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await new Promise((ok, fail) => {
      const timer = setTimeout(
        () => fail(Error("own mutex child not ready")),
        2000,
      );
      child.stdout.once("data", () => {
        clearTimeout(timer);
        ok();
      });
      child.once("error", fail);
    });
    assert.throws(() => db.exec("BEGIN IMMEDIATE"), /locked/);
    child.kill("SIGKILL");
    await new Promise((ok) => child.once("exit", ok));
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retirement state domains exactly match public contracts; real success/reverted/rejected/deferred are terminal, active states never are", () => {
  const contract = createRequire(
    new URL("../../api/apps/api/package.json", import.meta.url),
  )("@platform/contracts");
  assert.deepEqual(
    [
      ...REFERENCE_ATTEMPT_ACTIVE_STATES,
      ...REFERENCE_ATTEMPT_TERMINAL_STATES,
    ].sort(),
    [...contract.UpgradeAttemptStateSchema.options].sort(),
  );
  assert.deepEqual(
    [...REFERENCE_RECOVERY_STATES].sort(),
    [...contract.UpgradeRecoverySchema.shape.state.options].sort(),
  );
  assert.deepEqual(
    [...REFERENCE_RECOVERY_PHASES].sort(),
    [...contract.UpgradeRecoverySchema.shape.phase.unwrap().options].sort(),
  );
  for (const state of contract.UpgradeAttemptStateSchema.options) {
    const p = proof();
    p.control.attempts[0].state = state;
    assert.equal(
      plan(derive(p)).qualified,
      REFERENCE_ATTEMPT_TERMINAL_STATES.includes(state),
      state,
    );
  }
});
test("actual independent schema retains successful source during policy window and explicit current fallback without making expired terminal history active", async () => {
  const directory = await realpath(
      await mkdtemp(join(tmpdir(), "reference-real-schema-")),
    ),
    path = join(directory, "control.db"),
    db = new Database(path),
    sup = new Database(":memory:");
  const requireApi = createRequire(
    new URL("../../api/apps/api/package.json", import.meta.url),
  );
  const schema = requireApi(
    "./dist/platform/upgrade/control-store-schema.js",
  ).UPGRADE_CONTROL_SCHEMA_SQL;
  try {
    db.exec(schema);
    db.exec(
      "CREATE TABLE control_authority(instance_id,operation_id,holder_id,lease_expires_at,mode);CREATE TABLE control_recovery_intents(instance_id,recovery_id,phase,authorization_plan,plan);CREATE TABLE control_commands(instance_id,operation_id,command_id,spec_digest,state,spec)",
    );
    sup.exec(
      "CREATE TABLE control_commands(instance_id,operation_id,command_id,spec_digest,state,spec)",
    );
    db.prepare("INSERT INTO control_authority VALUES(?,?,?,?,?)").run(
      target.instanceId,
      "new-op",
      "holder",
      now + 5000,
      "active",
    );
    db.prepare(
      "INSERT INTO upgrade_instances VALUES(?,1,NULL,'confirmed',1,?)",
    ).run(target.instanceId, now);
    const insert = db.prepare(
      "INSERT INTO upgrade_attempts(attempt_id,instance_id,actor_id,request_id,request_digest,target_release_id,target_digest,manifest,plan,source_activation,generation,state,accepted_at,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const source = JSON.stringify({
        components: { api: { artifactDigest: hash } },
      }),
      manifest = JSON.stringify({
        manifest: {
          policy: {
            retentionMs: 10000,
            fallbacks: [{ apiDigest: "sha256:" + "c".repeat(64) }],
          },
        },
      });
    for (const state of REFERENCE_ATTEMPT_TERMINAL_STATES)
      insert.run(
        state,
        target.instanceId,
        "actor",
        "request-" + state,
        "digest",
        "v-test-" + state,
        "digest",
        manifest,
        "{}",
        source,
        1,
        state,
        now - 500,
        now - 500,
      );
    let ro = new Database(path, { readonly: true });
    const options = () => ({
      sqlite: ro,
      supervisorSqlite: sup,
      instanceId: target.instanceId,
      targets: [{ ...target, attemptId: "activation-confirmed" }],
      clock: () => now,
    });
    let fact = readControlReferenceFacts(options());
    assert.equal(
      fact.fallbacks.some((v) => JSON.stringify(v).includes(hash)),
      true,
    );
    db.prepare("UPDATE upgrade_attempts SET observed_at=? WHERE state=?").run(
      now - 10001,
      "activation-confirmed",
    );
    fact = readControlReferenceFacts(options());
    assert.equal(fact.fallbacks.length, 0);
    // 150 old successes must not hit the active-plan/retention bound.
    for (let i = 0; i < 150; i++)
      insert.run(
        "old-" + i,
        target.instanceId,
        "actor",
        "old-request-" + i,
        "digest",
        "old-release-" + i,
        "digest",
        manifest,
        "{}",
        source,
        1,
        "activation-confirmed",
        now - 20000,
        now - 20000,
      );
    assert.equal(readControlReferenceFacts(options()).fallbacks.length, 0);
    db.prepare("UPDATE upgrade_instances SET confirmed_release=?").run(
      JSON.stringify({
        releaseId: "v-test-activation-confirmed",
        components: { api: { artifactDigest: "sha256:" + "d".repeat(64) } },
      }),
    );
    fact = readControlReferenceFacts(options());
    assert.equal(
      fact.fallbacks.some((v) =>
        JSON.stringify(v).includes("sha256:" + "c".repeat(64)),
      ),
      true,
    );
    db.prepare("UPDATE upgrade_attempts SET state=? WHERE attempt_id=?").run(
      "invented-state",
      "activation-confirmed",
    );
    assert.throws(
      () => readControlReferenceFacts(options()),
      /REFERENCE_ATTEMPT_UNKNOWN/,
    );
    ro.close();
  } finally {
    db.close();
    sup.close();
    await rm(directory, { recursive: true, force: true });
  }
});
