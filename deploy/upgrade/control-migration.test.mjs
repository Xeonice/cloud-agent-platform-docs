import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createHmac, scryptSync } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  exportControlMetadata,
  importControlMetadata,
  controlMigrationStatus,
  prepareControlMigration,
} from "./control-migration.mjs";
import { createControlAccessAuthority } from "./control-access-authority.mjs";
import { runControlMigrationCommand } from "../ops/migrate-independent-control.mjs";
import { digest, canonical } from "./trust.mjs";
import {
  fixture,
  apiRoot,
  Database,
  limits,
} from "../test-support/control-migration-fixtures.mjs";
test("real legacy29 snapshot imports exact failed history/receipts and old cookie into passive independent stores; repeated import is identical", async (t) => {
  const f = await fixture(t),
    before = f.db
      .prepare("SELECT * FROM upgrade_attempts ORDER BY rowid")
      .all();
  const manifest = await f.export(),
    result = f.import(manifest);
  assert.equal(result.mode, "passive");
  assert.equal(manifest.counts.platform_operations, 4);
  const ledger = new Database(f.controlPath),
    auth = new Database(f.accessPath);
  t.after(() => ledger.close());
  t.after(() => auth.close());
  for (const row of ledger
    .prepare("SELECT * FROM upgrade_attempts ORDER BY rowid")
    .all()) {
    const { plan_digest, ...original } = row;
    assert.deepEqual(
      original,
      before.find((r) => r.attempt_id === row.attempt_id),
    );
    assert.equal(plan_digest, JSON.parse(row.plan).planDigest);
  }
  assert.deepEqual(
    ledger
      .prepare("SELECT event_digest,payload FROM upgrade_events ORDER BY rowid")
      .all(),
    f.db
      .prepare("SELECT event_digest,payload FROM upgrade_events ORDER BY rowid")
      .all(),
  );
  assert.deepEqual(
    ledger
      .prepare(
        "SELECT receipt_digest,evidence FROM upgrade_steps ORDER BY rowid",
      )
      .all(),
    f.db
      .prepare(
        "SELECT receipt_digest,evidence FROM upgrade_steps ORDER BY rowid",
      )
      .all(),
  );
  assert.equal(
    ledger.prepare("SELECT evidence_digest FROM upgrade_steps LIMIT 1").get()
      .evidence_digest,
    digest(
      JSON.parse(
        f.db.prepare("SELECT evidence FROM upgrade_steps LIMIT 1").get()
          .evidence,
      ),
    ),
  );
  assert.equal(
    ledger.prepare("SELECT activation_generation FROM upgrade_instances").get()
      .activation_generation,
    6,
  );
  assert.deepEqual(f.import(manifest), result);
  assert.equal(f.status().applySupported, false);
  const authority = createControlAccessAuthority({
      sqlite: auth,
      instanceId: "instance",
      envPasscode: "",
    }),
    expires = String(Date.now() + 60000),
    cookie =
      expires +
      "." +
      createHmac("sha256", "original-cookie-signing-secret")
        .update(expires)
        .digest("hex");
  assert.equal(authority.verifySessionToken(cookie), true);
  assert.equal(
    await authority.authenticate(
      { headers: {}, socket: { remoteAddress: "192.0.2.1" } },
      "existing-passcode",
    ),
    true,
  );
  const exported = new Database(f.exportPath, { readonly: true });
  t.after(() => exported.close());
  assert.equal(
    exported
      .prepare(
        "SELECT count(*) n FROM sqlite_master WHERE name IN ('system_settings','control_access')",
      )
      .get().n,
    0,
  );
  assert.equal(
    JSON.stringify(manifest).includes("original-cookie-signing-secret"),
    false,
  );
  assert.deepEqual(
    f.db.prepare("SELECT * FROM upgrade_attempts ORDER BY rowid").all(),
    before,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM __drizzle_migrations").get().n,
    29,
  );
});
test("unknown source schema, selected table columns, unknown upgrade role and cross-instance recovery reject", async (t) => {
  for (const change of [
    (f) =>
      f.db
        .prepare(
          "UPDATE __drizzle_migrations SET hash='unknown' WHERE created_at=(SELECT max(created_at) FROM __drizzle_migrations)",
        )
        .run(),
    (f) =>
      f.db.exec("ALTER TABLE upgrade_events ADD COLUMN unknown_field TEXT"),
    (f) =>
      f.db
        .prepare(
          "UPDATE platform_operations SET role='upgrade-unknown' WHERE role='task-start'",
        )
        .run(),
    (f) =>
      f.db
        .prepare(
          "UPDATE upgrade_recoveries SET triggering_attempt_id='missing'",
        )
        .run(),
  ]) {
    const f = await fixture(t);
    f.db.pragma("foreign_keys = OFF");
    change(f);
    await assert.rejects(f.export());
    assert.equal(await fs.stat(f.accessPath).catch(() => null), null);
  }
});
test("stale writer, wrong generation or insufficient epoch floor refuses before auth import", async (t) => {
  for (const change of [
    (f) => {
      f.sourceCoordinator.observedAt = new Date(f.now - 6000).toISOString();
    },
    (f) => {
      f.sourceCoordinator.generation = 8;
    },
    (f) => {
      f.args.epochFloor = 1;
    },
  ]) {
    const f = await fixture(t);
    change(f);
    await assert.rejects(f.export());
    assert.equal(await fs.stat(f.accessPath).catch(() => null), null);
  }
});
test("same source snapshot survives concurrent normal writes; row budget fails closed without full export", async (t) => {
  const f = await fixture(t);
  f.args.readAccessEnvironment = async () => {
    f.db
      .prepare(
        "UPDATE upgrade_attempts SET reason='LATER_WRITE' WHERE attempt_id='failed-1'",
      )
      .run();
    return f.environment;
  };
  const manifest = await f.export();
  f.import(manifest);
  const ledger = new Database(f.controlPath);
  t.after(() => ledger.close());
  assert.equal(
    ledger
      .prepare(
        "SELECT reason FROM upgrade_attempts WHERE attempt_id='failed-1'",
      )
      .get().reason,
    "ORIGINAL_FAILURE",
  );
  assert.equal(
    f.db
      .prepare(
        "SELECT reason FROM upgrade_attempts WHERE attempt_id='failed-1'",
      )
      .get().reason,
    "LATER_WRITE",
  );
  const g = await fixture(t);
  g.args.limits = { ...limits, maxRows: 2 };
  await assert.rejects(g.export(), /CONTROL_MIGRATION_BUDGET_EXCEEDED/);
});
test("changed export, extra table and altered imported history are never accepted as idempotent", async (t) => {
  const f = await fixture(t),
    manifest = await f.export();
  await fs.chmod(f.exportPath, 0o600);
  const exportDb = new Database(f.exportPath);
  exportDb.exec("CREATE TABLE stolen_business_secret(value TEXT)");
  exportDb.close();
  assert.throws(
    () => f.import(manifest),
    /CONTROL_MIGRATION_EXPORT_TABLE_UNKNOWN/,
  );
  const g = await fixture(t),
    m = await g.export();
  g.import(m);
  const ledger = new Database(g.controlPath);
  ledger
    .prepare(
      "UPDATE upgrade_steps SET receipt_digest='changed' WHERE attempt_id='failed-1'",
    )
    .run();
  ledger.close();
  assert.throws(
    () => g.import(m),
    /CONTROL_MIGRATION_IMPORTED_HISTORY_CHANGED/,
  );
});

test("streaming export/import never calls all() on history, even with many independent material receipts", async (t) => {
  const f = await fixture(t),
    base = f.db.prepare("SELECT * FROM upgrade_events LIMIT 1").get();
  const add = f.db.prepare(
    "INSERT INTO upgrade_events VALUES(@event_id,@attempt_id,@event_digest,@generation,@sequence,@fence,@kind,@payload,@recorded_at)",
  );
  f.db.transaction(() => {
    for (let i = 0; i < 256; i++)
      add.run({
        ...base,
        event_id: "material-" + i,
        sequence: 1000 + i,
        payload: JSON.stringify({ material: "x".repeat(32768) }),
      });
  })();
  let iterations = 0;
  function StreamingDatabase(...args) {
    const db = new Database(...args),
      prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (/^SELECT rowid AS __rowid,/.test(sql)) {
        statement.all = () =>
          assert.fail("history cannot be materialized with all()");
        const iterate = statement.iterate.bind(statement);
        statement.iterate = (...params) => {
          iterations++;
          return iterate(...params);
        };
      }
      return statement;
    };
    return db;
  }
  f.args.Database = StreamingDatabase;
  const manifest = await f.export();
  importControlMetadata({
    Database: StreamingDatabase,
    apiRoot,
    exportPath: f.exportPath,
    controlPath: f.controlPath,
    accessPath: f.accessPath,
    instanceId: "instance",
    expectedExportDigest: manifest.exportDigest,
  });
  assert.equal(manifest.counts.upgrade_events, 258);
  assert.ok(manifest.bytes > 8 * 1024 * 1024);
  assert.ok(iterations >= 14);
});
test("prepare is exact-idempotent, cannot change immutable inputs, and apply requires a complete fixed runtime", async (t) => {
  const f = await fixture(t),
    args = { ...f.args, controlPath: f.controlPath };
  const first = await prepareControlMigration(args),
    second = await prepareControlMigration(args);
  assert.deepEqual(second, first);
  assert.equal(first.applySupported, false);
  await assert.rejects(
    prepareControlMigration({ ...args, epochFloor: 35 }),
    /CONTROL_MIGRATION_EXPORT_SCOPE_INVALID/,
  );
  const configPath = join(f.root, "metadata-only.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      ...args,
      Database: undefined,
      readSourceCoordinator: undefined,
      readAccessEnvironment: undefined,
    }),
    { mode: 0o600 },
  );
  await assert.rejects(
    runControlMigrationCommand("apply", configPath),
    /CONTROL_MIGRATION_RUNTIME_CONFIG_REQUIRED/,
  );
});
test("auth or source identity changes, overlapping ledger/auth directories, and active authority reject import", async (t) => {
  const f = await fixture(t),
    m = await f.export();
  const auth = new Database(f.accessPath);
  auth.prepare("UPDATE control_access SET session_secret='changed'").run();
  auth.close();
  assert.throws(() => f.import(m), /CONTROL_MIGRATION_AUTH_CHANGED/);
  const g = await fixture(t),
    n = await g.export();
  assert.throws(
    () =>
      importControlMetadata({
        Database,
        apiRoot,
        exportPath: g.exportPath,
        controlPath: join(g.root, "private/control.db"),
        accessPath: g.accessPath,
        instanceId: "instance",
        expectedExportDigest: n.exportDigest,
      }),
    /CONTROL_MIGRATION_DATABASE_DIRECTORIES_OVERLAP/,
  );
  g.import(n);
  const ledger = new Database(g.controlPath);
  ledger.prepare("UPDATE control_authority SET mode='active'").run();
  ledger.close();
  assert.throws(
    () => g.import(n),
    /CONTROL_MIGRATION_AUTHORITY_MUST_BE_PASSIVE/,
  );
});

test("operator plan/prepare/status use one actual fixed source identity GET, preserve original env auth, and never print secrets", async (t) => {
  const f = await fixture(t),
    key = "fixture-control-key-".repeat(2),
    start = "source-coordinator-start-identity";
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    assert.equal(req.url, "/internal/application/identity");
    assert.equal(req.headers["x-platform-internal-key"], key);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ...f.sourceCoordinator,
        role: "coordinator",
        pid: 1,
        startIdentity: start,
        coordinatorGeneration: 7,
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const sourceInstallationKeysPath = join(f.root, "installation-keys.json"),
    sourceEnvironmentPath = join(f.root, "old-environment.json"),
    configPath = join(f.root, "migration.json");
  await fs.writeFile(
    sourceInstallationKeysPath,
    JSON.stringify({
      control: key,
      controller: "different-controller-key-".repeat(2),
      upgradeControl: "never-forward-global-upgrade-key-".repeat(2),
      owner: "never-forward-owner-key",
    }),
    { mode: 0o600 },
  );
  await fs.writeFile(
    sourceEnvironmentPath,
    JSON.stringify({
      ACCESS_PASSCODE: "fixed-env-passcode",
      PASSCODE_COOKIE_SECRET: "original-cookie-signing-secret",
      UPGRADE_SESSION_SECRET: "original-upgrade-session-key-32bytes",
    }),
    { mode: 0o600 },
  );
  const {
    Database: ignoredDatabase,
    readSourceCoordinator: ignoredReader,
    readAccessEnvironment: ignoredEnv,
    ...config
  } = f.args;
  await fs.writeFile(
    configPath,
    JSON.stringify({
      ...config,
      controlPath: f.controlPath,
      sourceInstallationKeysPath,
      sourceEnvironmentPath,
      sourceCoordinator: {
        origin: "http://127.0.0.1:" + server.address().port,
        metadataPath: "/internal/application/identity",
        startIdentity: start,
        artifactDigest: f.sourceCoordinator.artifactDigest,
        generation: 7,
      },
    }),
    { mode: 0o600 },
  );
  assert.equal(
    (await runControlMigrationCommand("plan", configPath)).liveWriterQualified,
    false,
  );
  assert.equal(calls, 0);
  const prepared = await runControlMigrationCommand("prepare", configPath);
  assert.equal(prepared.mode, "passive");
  assert.equal(calls, 1);
  const status = await runControlMigrationCommand("status", configPath);
  assert.equal(status.state, "prepared");
  assert.equal(status.applySupported, false);
  const text = JSON.stringify({ prepared, status });
  for (const secret of [
    key,
    "never-forward-owner-key",
    "never-forward-global-upgrade-key-".repeat(2),
    "fixed-env-passcode",
    "original-cookie-signing-secret",
  ])
    assert.equal(text.includes(secret), false);
  const db = new Database(f.accessPath);
  t.after(() => db.close());
  const authority = createControlAccessAuthority({
    sqlite: db,
    instanceId: "instance",
    envPasscode: "fixed-env-passcode",
    sessionSecretOverride: "original-cookie-signing-secret",
  });
  assert.equal(authority.status().source, "env");
  assert.equal(
    await authority.authenticate(
      { headers: {}, socket: { remoteAddress: "192.0.2.1" } },
      "fixed-env-passcode",
    ),
    true,
  );
});

test("migration epoch floor covers retained contract operations; a passive reserved control authority is never an empty import target", async (t) => {
  const low = await fixture(t);
  low.db
    .prepare(
      "UPDATE platform_operations SET fence=100 WHERE role='project-name-contract'",
    )
    .run();
  await assert.rejects(low.export(), {
    code: "CONTROL_MIGRATION_EPOCH_FLOOR_TOO_LOW",
  });
  for (const mutation of [
    "operation_id='maintenance-existing'",
    "kind='maintenance'",
    "epoch=100",
    "source_binding_digest='sha256:" + "0".repeat(64) + "'",
    "lease_expires_at=100",
  ]) {
    const f = await fixture(t),
      manifest = await f.export();
    f.import(manifest);
    const target = new Database(f.controlPath);
    target.prepare("UPDATE control_authority SET " + mutation).run();
    target.close();
    assert.throws(() => f.import(manifest), {
      code: "CONTROL_MIGRATION_AUTHORITY_MUST_BE_PASSIVE",
    });
  }
});

test("original ENV precedence survives real private DB reopen without plaintext in Foundation or loss of stored hash/cookie", async (t) => {
  const f = await fixture(t);
  f.environment.ACCESS_PASSCODE = "original-env-only-passcode";
  f.environment.PASSCODE_COOKIE_SECRET = "original-pinned-cookie-secret";
  const before = f.db
      .prepare("SELECT access_passcode_hash FROM system_settings")
      .get().access_passcode_hash,
    manifest = await f.export();
  f.import(manifest);
  const db = new Database(f.accessPath);
  t.after(() => db.close());
  const authority = createControlAccessAuthority({
    sqlite: db,
    instanceId: "instance",
    retainEnvironment: true,
  });
  assert.equal(authority.status().source, "env");
  assert.equal(authority.status().envOverride, true);
  assert.equal(
    await authority.authenticate(
      { headers: {}, socket: { remoteAddress: "192.0.2.1" } },
      f.environment.ACCESS_PASSCODE,
    ),
    true,
  );
  assert.equal(
    db.prepare("SELECT passcode_hash FROM control_access").get().passcode_hash,
    before,
  );
  assert.equal(
    (await fs.readFile(f.accessPath)).includes(
      Buffer.from(f.environment.ACCESS_PASSCODE),
    ),
    false,
  );
  assert.deepEqual(f.import(manifest).mode, "passive");
  db.prepare(
    "UPDATE control_access_environment SET passcode_hash='changed'",
  ).run();
  assert.throws(() => f.status(), { code: "CONTROL_MIGRATION_AUTH_CHANGED" });
});

test("source management identity GET uses the old business controller capability and never the global upgrade key", async (t) => {
  const f = await fixture(t),
    oldKey = "business-controller-key-".repeat(2),
    globalKey = "new-global-upgrade-key-".repeat(2);
  let seen = 0;
  const server = createServer((req, res) => {
    seen++;
    assert.equal(req.url, "/internal/coordinator/identity");
    assert.equal(req.headers["x-platform-internal-key"], oldKey);
    assert.notEqual(req.headers["x-platform-internal-key"], globalKey);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ...f.sourceCoordinator,
        role: "coordinator",
        pid: 1,
        generation: 7,
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const keysPath = join(f.root, "keys.json"),
    envPath = join(f.root, "env.json"),
    configPath = join(f.root, "config.json");
  await fs.writeFile(
    keysPath,
    JSON.stringify({
      controller: oldKey,
      control: "other-control-key-".repeat(2),
      upgradeControl: globalKey,
    }),
    { mode: 0o600 },
  );
  await fs.writeFile(
    envPath,
    JSON.stringify({ UPGRADE_SESSION_SECRET: "old-upgrade-secret-".repeat(2) }),
    { mode: 0o600 },
  );
  const {
    Database: ignoredDb,
    readSourceCoordinator: ignoredRead,
    readAccessEnvironment: ignoredEnv,
    ...config
  } = f.args;
  await fs.writeFile(
    configPath,
    JSON.stringify({
      ...config,
      controlPath: f.controlPath,
      sourceInstallationKeysPath: keysPath,
      sourceEnvironmentPath: envPath,
      sourceCoordinator: {
        origin: "http://127.0.0.1:" + server.address().port,
        metadataPath: "/internal/coordinator/identity",
        startIdentity: f.sourceCoordinator.startIdentity,
        artifactDigest: f.sourceCoordinator.artifactDigest,
        generation: 7,
      },
    }),
    { mode: 0o600 },
  );
  const result = await runControlMigrationCommand("prepare", configPath);
  assert.equal(result.mode, "passive");
  assert.equal(seen, 1);
  assert.equal(JSON.stringify(result).includes(globalKey), false);
});
