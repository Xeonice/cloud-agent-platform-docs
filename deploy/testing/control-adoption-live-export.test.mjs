import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
  fixture as migrationFixture,
  apiRoot,
  Database,
} from "../test-support/control-migration-fixtures.mjs";
import {
  createControlAdoptionLiveExporter,
  createLiveControlAdoptionAttachment,
} from "../ops/control-adoption-live-export.mjs";
import { legacyControlAttachmentLedgerRoot } from "../upgrade/control-adoption-layout.mjs";
import { createPrivateControlRpc } from "../upgrade/control-rpc.mjs";
import {
  canonical,
  digest,
  signQualificationManifest,
  runInputFingerprint,
} from "../upgrade/trust.mjs";
import { atomicJson } from "../upgrade/io.mjs";
import { controlMigrationExecutionPolicy } from "../upgrade/control-migration-policy.mjs";

const require = createRequire(
  new URL("../../api/package.json", import.meta.url),
);
require("reflect-metadata");
const api = (name) => require("./apps/api/dist/platform/" + name + ".js");
const { UpgradeStore } = api("upgrade/upgrade-store");
const { UpgradeLedgerConnection } = api("upgrade/upgrade-ledger-connection");
const { UpgradeControlAttachment } = api("upgrade/upgrade-control-attachment");
const { fenceCoordinatorConnection, coordinatorWriterControl } = api(
  "persistence/coordinator-lease",
);

function signedSource(instanceId) {
  const artifact = (name) => ({
    artifactDigest: digest(name),
    inputFingerprint: digest("input-" + name),
    sourceRevision: "a".repeat(40),
    protocol: { min: 1, max: 2 },
  });
  const source = {
    releaseId: "0.2.0",
    activationGeneration: 6,
    activatedAt: new Date().toISOString(),
    schema: 29,
    channel: "isolated-live-export",
    commits: {
      project: "a".repeat(40),
      api: "a".repeat(40),
      web: "a".repeat(40),
    },
    productionWebBinding: "http://127.0.0.1:31991",
    components: {
      api: artifact("api"),
      coordinator: artifact("coordinator"),
      installer: artifact("installer"),
      web: { ...artifact("web"), webRevision: "a".repeat(40) },
    },
  };
  source.components.installer.inputFingerprint =
    source.components.installer.artifactDigest;
  const control = {
    schemaVersion: 1,
    kind: "upgrade-control",
    version: "0.2.1",
    protocolVersion: 1,
    apiRevision: "a".repeat(40),
    projectRevision: "a".repeat(40),
    treeDigest: digest("test-control-tree"),
    executionEngineDigest: source.components.installer.artifactDigest,
  };
  const pack = {
    platform: process.platform,
    arch: process.arch,
    name: "isolated.tgz",
    url: "https://distribution.invalid/isolated.tgz",
    digest: digest("isolated"),
    bytes: 1000,
    format: "native-tar",
  };
  const manifest = {
    schemaVersion: 2,
    purpose: "qualification",
    releaseId: "0.2.1",
    channel: source.channel,
    publishedAt: new Date().toISOString(),
    commits: source.commits,
    components: source.components,
    packages: [pack],
    controlPackage: {
      manifest: control,
      manifestDigest: digest(control),
      package: { ...pack, name: "control.tgz" },
    },
    upgradePaths: [
      {
        fromRelease: source.releaseId,
        minSchema: 29,
        maxSchema: 29,
        targetSchema: 29,
        bridgeReleases: [],
        migrationPlanDigest: null,
      },
    ],
    policy: {
      id: "isolated-live-export",
      weights: [1, 5, 25, 100],
      stageDurationMs: 60000,
      minRequests: 100,
      observationFreshnessMs: 5000,
      probeHz: 10,
      requestDeadlineMs: 2000,
      attachDeadlineMs: 5000,
      softErrorDelta: 0.01,
      p95Ratio: 2,
      p95FloorMs: 1000,
      evaluationIntervalMs: 10000,
      consecutiveEvaluations: 2,
      retentionMs: 60000,
      migrationBatchMs: 500,
      maxWalBytes: 1048576,
      minFreeBytes: 1048576,
      fallbacks: [
        {
          releaseId: source.releaseId,
          apiDigest: source.components.api.artifactDigest,
          webDigest: source.components.web.artifactDigest,
          rehearsed: false,
        },
      ],
      stopUserResources: false,
      restoreLiveVolume: false,
      contractInUpgrade: false,
    },
    evidence: [],
  };
  manifest.qualification = {
    instanceId,
    inputFingerprint: runInputFingerprint(manifest),
  };
  const keys = generateKeyPairSync("ed25519");
  return {
    source,
    signedManifest: signQualificationManifest(
      manifest,
      "live-export-test",
      keys.privateKey.export({ type: "pkcs8", format: "pem" }),
    ),
    trustRoot: {
      schemaVersion: 1,
      purpose: "qualification",
      qualificationInstanceId: instanceId,
      channel: source.channel,
      distributionOrigins: ["https://distribution.invalid"],
      keys: [
        {
          id: "live-export-test",
          publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
        },
      ],
    },
  };
}

/** Actual original29 migrations/SQLite, business-writer guard and API freeze
 * service behind authenticated loopback HTTP. All identities/keys are synthetic
 * fixture data; this is not a package, deployment or legacy-settlement proof. */
async function fixture(t, { durationMs = 20000 } = {}) {
  const f = await migrationFixture(t),
    instanceId = "instance",
    signed = signedSource(instanceId);
  const envNames = [
    "PLATFORM_INSTANCE_ID",
    "PLATFORM_PROCESS_ROLE",
    "COORDINATOR_GENERATION",
    "COORDINATOR_WRITER_FENCE_VALID",
    "UPGRADE_CONTROL_DATABASE_PATH",
    "UPGRADE_CONTROL_ATTACH_FREEZE_PLAN_PATH",
    "UPGRADE_CONTROL_ATTACH_FREEZE_PLAN_RAW_DIGEST",
    "UPGRADE_CONTROL_ATTACH_SPEC_PATH",
    "UPGRADE_CONTROL_ATTACH_SPEC_RAW_DIGEST",
    "UPGRADE_TRUST_ROOT_PATH",
  ];
  const prior = Object.fromEntries(envNames.map((k) => [k, process.env[k]]));
  for (const k of envNames) delete process.env[k];
  process.env.PLATFORM_INSTANCE_ID = instanceId;
  const clock = { now: () => new Date() };
  f.db
    .prepare(
      "UPDATE platform_role_leases SET expires_at=0 WHERE role='state-coordinator'",
    )
    .run();
  const business = fenceCoordinatorConnection(f.db, instanceId, clock, {
      next: randomUUID,
    }),
    writer = coordinatorWriterControl(business);
  business
    .prepare(
      "UPDATE upgrade_instances SET confirmed_release=?,service_state='confirmed',ready=1 WHERE instance_id=?",
    )
    .run(canonical(signed.source), instanceId);
  business.exec("CREATE TABLE private_business(payload TEXT)");
  business
    .prepare("INSERT INTO private_business VALUES(?)")
    .run("never-export-this-business-secret");
  const connection = new UpgradeLedgerConnection(clock),
    store = new UpgradeStore(
      business,
      clock,
      { next: randomUUID },
      connection.options(),
    );
  const operationId = randomUUID(),
    plan = {
      schemaVersion: 1,
      kind: "legacy-control-admission-freeze",
      instanceId,
      operationId,
      commandId: "freeze-original",
      deadline: Date.now() + durationMs,
      source: {
        activationGeneration: 6,
        confirmedDigest: digest(signed.source),
        businessWriterGeneration: writer.generation,
        businessWriterFence: writer.fence,
        schema: 29,
      },
      target: {
        signedManifestDigest: signed.signedManifest.manifestDigest,
        apiArtifactDigest: signed.source.components.api.artifactDigest,
        coordinatorArtifactDigest:
          signed.source.components.coordinator.artifactDigest,
        projectRevision: signed.source.commits.project,
        controlPackageDigest:
          signed.signedManifest.manifest.controlPackage.manifestDigest,
      },
    };
  const freezeConfiguration = {
    spec: plan,
    signedManifest: signed.signedManifest,
  };
  const freezePath = join(f.root, "freeze.json"),
    trustPath = join(f.root, "trust.json");
  await atomicJson(freezePath, freezeConfiguration);
  await atomicJson(trustPath, signed.trustRoot);
  process.env.UPGRADE_CONTROL_ATTACH_FREEZE_PLAN_PATH = freezePath;
  process.env.UPGRADE_TRUST_ROOT_PATH = trustPath;
  const service = new UpgradeControlAttachment(
    store,
    connection,
    business,
    clock,
  );
  const internalKey = "actual-freeze-fixture-private-key-32",
    sourceMetadataKey = "actual-metadata-fixture-private-key-32",
    startIdentity = randomUUID(),
    requests = [];
  let beforeMetadata = async () => {};
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, path: req.url });
    try {
      const metadata = req.url === "/internal/application/identity";
      assert.equal(
        req.headers["x-platform-internal-key"],
        metadata ? sourceMetadataKey : internalKey,
      );
      assert.equal(req.headers["x-platform-instance-id"], instanceId);
      let value;
      if (metadata) {
        await beforeMetadata();
        writer.assert();
        value = {
          instanceId,
          role: "coordinator",
          startIdentity,
          artifactDigest: signed.source.components.coordinator.artifactDigest,
          inputFingerprint:
            signed.source.components.coordinator.inputFingerprint,
          coordinatorGeneration: writer.generation,
          writerFenceValid: true,
        };
      } else if (
        req.method === "GET" &&
        req.url === "/internal/upgrade-control-attachment"
      )
        value = service.status();
      else if (
        req.method === "POST" &&
        req.url === "/internal/upgrade-control-attachment/freeze"
      ) {
        let text = "";
        for await (const chunk of req) text += chunk;
        value = await service.freeze(JSON.parse(text));
      } else {
        res.statusCode = 404;
        value = { code: "FIXTURE_NO_SUCH_MUTATION" };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: value }));
    } catch (error) {
      res.statusCode = 409;
      res.end(JSON.stringify({ code: error.code ?? "FIXTURE_SCOPE_REJECTED" }));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const coordinatorOrigin = "http://127.0.0.1:" + server.address().port;
  const ledgerRoot = legacyControlAttachmentLedgerRoot(f.root, operationId),
    exportRoot = join(f.root, "live-export"),
    privateRoot = join(f.root, "live-private");
  for (const p of [ledgerRoot, exportRoot, privateRoot])
    await fs.mkdir(p, { recursive: true, mode: 0o700 });
  const accessEnvironmentPath = join(f.root, "environment.json");
  await atomicJson(accessEnvironmentPath, f.environment);
  const config = {
    root: f.root,
    apiRoot,
    businessPath: f.args.businessPath,
    exportRoot,
    privateRoot,
    accessEnvironmentPath,
    instanceId,
    coordinatorOrigin,
    internalKey,
    sourceMetadataKey,
    sourceCoordinator: {
      startIdentity,
      generation: writer.generation,
      artifactDigest: signed.source.components.coordinator.artifactDigest,
      metadataPath: "/internal/application/identity",
    },
    freezeConfiguration,
    trustRoot: signed.trustRoot,
    epoch: 40,
    executorId: "fixed-export-worker",
    attachCommandId: "attach-original",
    settlementCommandId: "settle-original",
    statePath: join(privateRoot, "attachment.json"),
    limits: {
      maxRowBytes: 8 * 1024 * 1024,
      maxRows: 100000,
      maxBytes: 64 * 1024 * 1024,
      maxDurationMs: 20000,
    },
  };
  const rpc = createPrivateControlRpc({
    origin: coordinatorOrigin,
    instanceId,
    key: internalKey,
  });
  const freeze = async () =>
    rpc("/internal/upgrade-control-attachment/freeze", {
      operationId,
      commandId: plan.commandId,
      specDigest: digest(plan),
    });
  t.after(async () => {
    await new Promise((r) => server.close(r));
    connection.onModuleDestroy();
    for (const k of envNames) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  });
  return {
    ...f,
    config,
    connection,
    writer,
    requests,
    ledgerRoot,
    privateRoot,
    freeze,
    setBeforeMetadata: (hook) => {
      beforeMetadata = hook;
    },
    input: (receipt) => ({
      freezeReceipt: receipt,
      freezeConfiguration,
      deadline: plan.deadline,
    }),
  };
}

test("real authenticated freeze exports original29 metadata and 4MB receipt into passive stores while business writes continue", async (t) => {
  const f = await fixture(t),
    evidence = canonical({ actualFixtureReceipt: "x".repeat(4053536) });
  f.db
    .prepare("UPDATE upgrade_steps SET evidence=? WHERE attempt_id='failed-1'")
    .run(evidence);
  const originalHistory = f.db
    .prepare("SELECT count(*) n FROM upgrade_events")
    .get().n;
  let writes = 0;
  f.setBeforeMetadata(async () => {
    f.writer.assert();
    f.db
      .prepare("UPDATE private_business SET payload=?")
      .run("business-still-live-" + ++writes);
  });
  let writesDuringReadonlySnapshot = 0;
  function ConcurrentDatabase(...args) {
    const db = new Database(...args),
      prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (
        args[0] === f.config.businessPath &&
        db.readonly &&
        sql.includes("coalesce(max(fence)")
      ) {
        const get = statement.get.bind(statement);
        statement.get = (...values) => {
          const row = get(...values);
          assert.equal(db.inTransaction, true);
          assert.equal(db.pragma("query_only", { simple: true }), 1);
          f.writer.assert();
          f.db
            .prepare("UPDATE private_business SET payload=?")
            .run(
              "concurrent-WAL-business-write-" + ++writesDuringReadonlySnapshot,
            );
          return row;
        };
      }
      return statement;
    };
    return db;
  }
  const receipt = await f.freeze(),
    exporter = createControlAdoptionLiveExporter(f.config, {
      Database: ConcurrentDatabase,
    }),
    result = await exporter(f.input(receipt));
  t.after(() => {
    if (result.sqlite.open) result.sqlite.close();
  });
  assert.equal(result.receipt.mode, "passive");
  assert.equal(result.receipt.onlineAdoptionImplemented, false);
  assert.equal(result.receipt.settlementQualified, false);
  assert.ok(writes >= 3);
  f.writer.assert();
  assert.equal(f.connection.readonly, false);
  assert.ok(writesDuringReadonlySnapshot >= 1);
  assert.equal(
    result.sqlite
      .prepare("SELECT evidence FROM upgrade_steps WHERE attempt_id=?")
      .get("failed-1").evidence,
    evidence,
  );
  assert.equal(
    result.sqlite.prepare("SELECT count(*) n FROM upgrade_events").get().n,
    originalHistory,
  );
  assert.equal(
    result.sqlite
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE name IN ('private_business','sandboxes','system_settings','upgrade_probe_records')",
      )
      .get().n,
    0,
  );
  assert.equal(
    result.sqlite.prepare("SELECT mode FROM control_authority").get().mode,
    "passive",
  );
  assert.equal(
    result.sqlite
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE name='control_commands'",
      )
      .get().n,
    0,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM __drizzle_migrations").get().n,
    29,
  );
  assert.equal(
    f.db
      .prepare("SELECT evidence FROM upgrade_steps WHERE attempt_id=?")
      .get("failed-1").evidence,
    evidence,
  );
  const observation = JSON.stringify(result.receipt);
  assert.equal(
    observation.includes("never-export-this-business-secret"),
    false,
  );
  assert.equal(observation.includes("original-cookie-signing-secret"), false);
  assert.deepEqual(
    f.requests.filter((x) => x.method === "POST").map((x) => x.path),
    ["/internal/upgrade-control-attachment/freeze"],
  );
});

test("operator composition installs the real exporter but an UNKNOWN settlement never attaches or claims", async (t) => {
  const f = await fixture(t);
  let settlements = 0;
  const attachment = createLiveControlAdoptionAttachment({
    ...f.config,
    settlementObserver: async () => {
      settlements++;
      throw Object.assign(Error("unknown"), {
        code: "LEGACY_ORIGINAL_RESULT_UNKNOWN",
      });
    },
  });
  const result = await attachment.run();
  assert.equal(result.state, "manual-review");
  assert.equal(settlements, 1);
  assert.equal(result.controlActivated, false);
  assert.equal(f.requests.filter((x) => x.path.endsWith("/attach")).length, 0);
  const db = new Database(join(f.ledgerRoot, "control.db"));
  t.after(() => db.close());
  assert.equal(
    db.prepare("SELECT mode FROM control_authority").get().mode,
    "passive",
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM upgrade_attempts").get().n,
    2,
  );
  assert.equal(f.connection.readonly, false);
  f.writer.assert();
  assert.equal(controlMigrationExecutionPolicy("apply").state, "blocked");
  assert.equal(
    controlMigrationExecutionPolicy("resume").onlineAdoptionImplemented,
    false,
  );
});

test("completed exact export reopens without truncating or inventing a new deadline; altered retained history refuses", async (t) => {
  const f = await fixture(t),
    receipt = await f.freeze();
  const first = await createControlAdoptionLiveExporter(f.config)(
    f.input(receipt),
  );
  const ino = (await fs.stat(join(f.ledgerRoot, "control.db"))).ino;
  first.sqlite.close();
  const second = await createControlAdoptionLiveExporter(f.config)(
    f.input(receipt),
  );
  assert.equal((await fs.stat(join(f.ledgerRoot, "control.db"))).ino, ino);
  second.sqlite.close();
  const altered = new Database(join(f.ledgerRoot, "control.db"));
  altered
    .prepare(
      "UPDATE upgrade_attempts SET reason='changed' WHERE attempt_id='failed-1'",
    )
    .run();
  altered.close();
  await assert.rejects(
    createControlAdoptionLiveExporter(f.config)(f.input(receipt)),
    /CONTROL_MIGRATION_IMPORTED_HISTORY_CHANGED/,
  );
  assert.throws(
    () =>
      createControlAdoptionLiveExporter(f.config)({
        ...f.input(receipt),
        deadline: f.config.freezeConfiguration.spec.deadline + 1,
      }),
    /ORIGINAL_CONFIGURATION_CHANGED/,
  );
});

test("wrong freeze scope and changed persisted source refuse without a successful attach configuration", async (t) => {
  for (const change of ["receipt", "source", "writer"]) {
    const f = await fixture(t),
      receipt = await f.freeze();
    if (change === "receipt") receipt.operationId = randomUUID();
    if (change === "source")
      f.db
        .prepare(
          "UPDATE upgrade_instances SET service_state='transitioning',ready=0",
        )
        .run();
    if (change === "writer")
      f.db
        .prepare("UPDATE platform_role_leases SET generation=generation+1")
        .run();
    await assert.rejects(
      createControlAdoptionLiveExporter(f.config)(f.input(receipt)),
    );
    assert.equal(
      await fs.stat(join(f.ledgerRoot, "control.db")).catch(() => null),
      null,
    );
  }
});

test("original deadline/abort and a mid-export source replacement fail closed, retaining incomplete artifacts for review", async (t) => {
  const f = await fixture(t),
    receipt = await f.freeze(),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createControlAdoptionLiveExporter(f.config)({
      ...f.input(receipt),
      signal: controller.signal,
    }),
    /ORIGINAL_DEADLINE_EXPIRED/,
  );
  const g = await fixture(t),
    rg = await g.freeze();
  let calls = 0;
  g.setBeforeMetadata(async () => {
    if (++calls === 2) {
      await fs.rename(
        g.config.businessPath,
        g.config.businessPath + ".original",
      );
      const wrong = new Database(g.config.businessPath);
      wrong.close();
    }
  });
  await assert.rejects(
    createControlAdoptionLiveExporter(g.config)(g.input(rg)),
    /BUSINESS_REPLACED|FROZEN_SOURCE|SQLITE/,
  );
  const state = JSON.parse(
    await fs.readFile(join(g.privateRoot, "live-export.json")),
  );
  assert.equal(state.phase, "unknown");
  assert.equal(state.attachConfiguration, undefined);
  await assert.rejects(
    createControlAdoptionLiveExporter(g.config)(g.input(rg)),
    /PRIOR_RESULT_UNKNOWN/,
  );
});

test("streamed real SQLite rows check the original monotonic deadline, rollback, and never publish an attach configuration", async (t) => {
  const f = await fixture(t),
    receipt = await f.freeze(),
    row = f.db.prepare("SELECT * FROM upgrade_events LIMIT 1").get();
  const add = f.db.prepare(
    "INSERT INTO upgrade_events VALUES(@event_id,@attempt_id,@event_digest,@generation,@sequence,@fence,@kind,@payload,@recorded_at)",
  );
  f.db.transaction(() => {
    for (let i = 0; i < 32; i++)
      add.run({
        ...row,
        event_id: "deadline-row-" + i,
        sequence: 1000 + i,
        payload: JSON.stringify({ material: "x".repeat(32768) }),
      });
  })();
  let inserted = 0;
  function ObservedDatabase(...args) {
    const db = new Database(...args),
      prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (/^INSERT INTO "upgrade_events"/.test(sql)) {
        const run = statement.run.bind(statement);
        statement.run = (...values) => {
          const value = run(...values);
          inserted++;
          return value;
        };
      }
      return statement;
    };
    return db;
  }
  await assert.rejects(
    createControlAdoptionLiveExporter(f.config, {
      Database: ObservedDatabase,
      monotonic: () => (inserted >= 10 ? 1_000_000 : 0),
    })(f.input(receipt)),
    /ORIGINAL_DEADLINE_EXPIRED/,
  );
  assert.equal(inserted, 10);
  const state = JSON.parse(
    await fs.readFile(join(f.privateRoot, "live-export.json")),
  );
  assert.equal(state.phase, "unknown");
  assert.equal(state.attachConfiguration, undefined);
  assert.equal(
    await fs.stat(join(f.ledgerRoot, "control.db")).catch(() => null),
    null,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM upgrade_events").get().n,
    34,
  );
  f.writer.assert();
});

test("a source state change after the exported snapshot is rejected even though the same writer and freeze remain valid", async (t) => {
  const f = await fixture(t),
    receipt = await f.freeze();
  let observations = 0;
  f.setBeforeMetadata(async () => {
    if (++observations === 2)
      f.db
        .prepare(
          "UPDATE upgrade_instances SET service_state='transitioning',ready=0",
        )
        .run();
  });
  await assert.rejects(
    createControlAdoptionLiveExporter(f.config)(f.input(receipt)),
    /CONFIRMED_SOURCE_CHANGED/,
  );
  const state = JSON.parse(
    await fs.readFile(join(f.privateRoot, "live-export.json")),
  );
  assert.equal(state.phase, "unknown");
  assert.equal(state.attachConfiguration, undefined);
  f.writer.assert();
});

test("complete reopen refuses missing or replaced private stores before SQLite can create or modify them", async (t) => {
  for (const which of ["control", "export", "access", "missing-control"]) {
    const f = await fixture(t),
      receipt = await f.freeze();
    const result = await createControlAdoptionLiveExporter(f.config)(
      f.input(receipt),
    );
    result.sqlite.close();
    const target =
      which === "export"
        ? join(f.config.exportRoot, "metadata.db")
        : which === "access"
          ? join(f.privateRoot, "auth/access.db")
          : join(f.ledgerRoot, "control.db");
    await fs.rename(target, target + ".original");
    if (which !== "missing-control")
      await fs.writeFile(
        target,
        "retained-store-replacement-must-stay-untouched",
        { mode: 0o600 },
      );
    await assert.rejects(
      createControlAdoptionLiveExporter(f.config)(f.input(receipt)),
      /RETAINED_FILE_IDENTITY_CHANGED|ENOENT/,
    );
    if (which === "missing-control")
      assert.equal(await fs.stat(target).catch(() => null), null);
    else
      assert.equal(
        await fs.readFile(target, "utf8"),
        "retained-store-replacement-must-stay-untouched",
      );
  }
});

test("pre-existing targets without a completed original receipt are retained and never truncated or imported", async (t) => {
  const f = await fixture(t),
    receipt = await f.freeze(),
    target = join(f.ledgerRoot, "control.db");
  await fs.writeFile(target, "unknown-existing-result", { mode: 0o600 });
  await assert.rejects(
    createControlAdoptionLiveExporter(f.config)(f.input(receipt)),
    /TARGET_ALREADY_EXISTS/,
  );
  assert.equal(await fs.readFile(target, "utf8"), "unknown-existing-result");
  const state = JSON.parse(
    await fs.readFile(join(f.privateRoot, "live-export.json")),
  );
  assert.equal(state.phase, "unknown");
  assert.equal(state.attachConfiguration, undefined);
  await assert.rejects(
    createControlAdoptionLiveExporter(f.config)(f.input(receipt)),
    /PRIOR_RESULT_UNKNOWN/,
  );
});
