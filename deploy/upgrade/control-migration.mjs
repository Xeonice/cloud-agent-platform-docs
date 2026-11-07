import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import {
  openSync,
  closeSync,
  chmodSync,
  lstatSync,
  realpathSync,
  statSync,
  existsSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { canonical, digest, invariant, DIGEST } from "./trust.mjs";
import { createControlAccessAuthority } from "./control-access-authority.mjs";
import { createControlAuthority } from "./control-authority.mjs";
import { verifyClosedBusinessReadView } from "./closed-business-read-view.mjs";

export const CONTROL_MIGRATION_ROLES = Object.freeze([
  "upgrade-plan",
  "project-name-contract",
  "upgrade-observation",
  "upgrade-stage-progress",
]);
const TABLES = Object.freeze({
  upgrade_instances:
    "instance_id activation_generation confirmed_release service_state ready updated_at".split(
      " ",
    ),
  upgrade_attempts:
    "attempt_id instance_id actor_id request_id request_digest target_release_id target_digest manifest plan source_activation source_actual generation sequence state stage reason controller_id fence lease_expires_at accepted_at observed_at".split(
      " ",
    ),
  upgrade_events:
    "event_id attempt_id event_digest generation sequence fence kind payload recorded_at".split(
      " ",
    ),
  upgrade_steps:
    "attempt_id step_id completed_work applied receipt_digest evidence applied_at".split(
      " ",
    ),
  upgrade_recoveries:
    "recovery_attempt_id triggering_attempt_id instance_id generation sequence state plan plan_digest reason observed_at".split(
      " ",
    ),
  upgrade_continuity_baselines: "attempt_id snapshot digest captured_at".split(
    " ",
  ),
  platform_operations:
    "operation_id instance_id actor_id role fence request_digest state result created_at updated_at".split(
      " ",
    ),
});
const columns = (table) => [
  ...TABLES[table],
  ...(table === "upgrade_attempts"
    ? ["plan_digest"]
    : table === "upgrade_steps"
      ? ["evidence_digest"]
      : []),
];
const q = (name) => '"' + name + '"';
const identity = (path) => {
  invariant(
    isAbsolute(path) && resolve(path) === path && realpathSync(path) === path,
    "CONTROL_MIGRATION_PATH_UNKNOWN",
  );
  const s = lstatSync(path);
  invariant(
    s.isFile() && !s.isSymbolicLink(),
    "CONTROL_MIGRATION_FILE_REQUIRED",
  );
  return { dev: String(s.dev), ino: String(s.ino) };
};
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
function separateDirectories(a, b) {
  const x = dirname(a),
    y = dirname(b);
  invariant(
    x !== y && !x.startsWith(y + "/") && !y.startsWith(x + "/"),
    "CONTROL_MIGRATION_DATABASE_DIRECTORIES_OVERLAP",
  );
}
function secureTarget(path) {
  invariant(
    isAbsolute(path) &&
      resolve(path) === path &&
      realpathSync(dirname(path)) === dirname(path),
    "CONTROL_MIGRATION_TARGET_PATH_UNKNOWN",
  );
  const parent = statSync(dirname(path));
  invariant(
    parent.isDirectory() && (parent.mode & 0o077) === 0,
    "CONTROL_MIGRATION_PRIVATE_DIRECTORY_REQUIRED",
  );
  if (existsSync(path)) {
    identity(path);
    invariant(
      (statSync(path).mode & 0o077) === 0,
      "CONTROL_MIGRATION_TARGET_INSECURE",
    );
  } else {
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
  }
}
function loadApi(apiRoot) {
  const require = createRequire(join(apiRoot, "apps/api/package.json"));
  return require(
    join(apiRoot, "apps/api/dist/platform/upgrade/control-store-factory.js"),
  );
}
function assertSchema(db, projected = false) {
  for (const table of Object.keys(TABLES)) {
    invariant(
      db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(table)
        ?.type === "table",
      "CONTROL_MIGRATION_TABLE_SCHEMA_UNKNOWN",
    );
    const actual = db
      .prepare("PRAGMA table_info(" + q(table) + ")")
      .all()
      .map((r) => r.name);
    invariant(
      canonical(actual) ===
        canonical(projected ? columns(table) : TABLES[table]),
      "CONTROL_MIGRATION_TABLE_SCHEMA_UNKNOWN",
    );
  }
}
function selection(table) {
  if (
    ["upgrade_instances", "upgrade_attempts", "upgrade_recoveries"].includes(
      table,
    )
  )
    return "instance_id=@instanceId";
  if (table === "platform_operations")
    return (
      "instance_id=@instanceId AND role IN (" +
      CONTROL_MIGRATION_ROLES.map((r) => "'" + r + "'").join(",") +
      ")"
    );
  return "attempt_id IN (SELECT attempt_id FROM upgrade_attempts WHERE instance_id=@instanceId)";
}
function budget(limits) {
  invariant(
    limits &&
      Object.keys(limits).sort().join(",") ===
        "maxBytes,maxDurationMs,maxRowBytes,maxRows" &&
      ["maxRowBytes", "maxRows", "maxBytes", "maxDurationMs"].every(
        (k) => Number.isSafeInteger(limits[k]) && limits[k] > 0,
      ) &&
      limits.maxRowBytes <= 32 * 1024 * 1024 &&
      limits.maxRows <= 10000000 &&
      limits.maxBytes <= 16 * 1024 ** 3 &&
      limits.maxDurationMs <= 120000,
    "CONTROL_MIGRATION_LIMITS_REQUIRED",
  );
  const started = performance.now(),
    hash = createHash("sha256"),
    counts = {};
  let bytes = 0,
    rows = 0;
  return {
    counts,
    add(table, row) {
      const line = table + "\0" + canonical(row) + "\n",
        size = Buffer.byteLength(line);
      invariant(
        size <= limits.maxRowBytes &&
          ++rows <= limits.maxRows &&
          (bytes += size) <= limits.maxBytes &&
          performance.now() - started <= limits.maxDurationMs,
        "CONTROL_MIGRATION_BUDGET_EXCEEDED",
      );
      counts[table] = (counts[table] || 0) + 1;
      hash.update(line);
    },
    finish() {
      invariant(
        performance.now() - started <= limits.maxDurationMs,
        "CONTROL_MIGRATION_BUDGET_EXCEEDED",
      );
      for (const t of Object.keys(TABLES)) counts[t] ??= 0;
      return { counts, bytes, rows, rowDigest: "sha256:" + hash.digest("hex") };
    },
  };
}
function rows(db, table, instanceId, projected) {
  return db
    .prepare(
      "SELECT rowid AS __rowid," +
        (projected ? columns(table) : TABLES[table]).map(q).join(",") +
        " FROM " +
        q(table) +
        " WHERE " +
        selection(table) +
        " ORDER BY rowid",
    )
    .iterate({ instanceId });
}
function project(table, row) {
  if (table === "upgrade_attempts") {
    const plan = JSON.parse(row.plan);
    invariant(
      plan && DIGEST.test(plan.planDigest),
      "CONTROL_MIGRATION_PLAN_DIGEST_UNKNOWN",
    );
    return { ...row, plan_digest: plan.planDigest };
  }
  if (table === "upgrade_steps")
    return {
      ...row,
      evidence_digest:
        row.evidence === null ? null : digest(JSON.parse(row.evidence)),
    };
  return row;
}
function insert(db, table) {
  const fields = ["__rowid", ...columns(table)];
  return db.prepare(
    "INSERT INTO " +
      q(table) +
      "(rowid," +
      columns(table).map(q).join(",") +
      ") VALUES(" +
      fields.map((n) => "@" + n).join(",") +
      ")",
  );
}
function assertClosure(db, instanceId) {
  invariant(
    db
      .prepare("SELECT count(*) n FROM upgrade_instances WHERE instance_id=?")
      .get(instanceId).n === 1,
    "CONTROL_MIGRATION_INSTANCE_UNKNOWN",
  );
  invariant(
    !db
      .prepare(
        "SELECT 1 FROM upgrade_attempts WHERE instance_id=? AND state IN ('accepted','downloading','package-verified','migrating','prepared','candidate-ready','routing-switched','observing','api-activated') LIMIT 1",
      )
      .get(instanceId),
    "CONTROL_MIGRATION_ACTIVE_ATTEMPT",
  );
  invariant(
    !db
      .prepare(
        "SELECT 1 FROM upgrade_recoveries WHERE instance_id=? AND state='recovering' LIMIT 1",
      )
      .get(instanceId),
    "CONTROL_MIGRATION_ACTIVE_RECOVERY",
  );
  const roles = db
    .prepare(
      "SELECT role,count(*) n FROM platform_operations WHERE instance_id=? GROUP BY role",
    )
    .all(instanceId);
  invariant(
    !roles.some(
      (r) =>
        !CONTROL_MIGRATION_ROLES.includes(r.role) &&
        (r.role.startsWith("upgrade-") ||
          r.role.startsWith("project-name-contract")),
    ),
    "CONTROL_MIGRATION_OPERATION_ROLE_UNKNOWN",
  );
  const running = db
    .prepare(
      "SELECT 1 FROM platform_operations WHERE instance_id=@instanceId AND role IN ('upgrade-plan','project-name-contract') AND state NOT IN ('completed','failed','cancelled','deferred','cleared') LIMIT 1",
    )
    .get({ instanceId });
  invariant(!running, "CONTROL_MIGRATION_ACTIVE_OPERATION");
  invariant(
    !db
      .prepare(
        "SELECT 1 FROM upgrade_recoveries r LEFT JOIN upgrade_attempts a ON a.attempt_id=r.triggering_attempt_id WHERE r.instance_id=? AND (a.attempt_id IS NULL OR a.instance_id<>r.instance_id) LIMIT 1",
      )
      .get(instanceId),
    "CONTROL_MIGRATION_SCOPE_INVALID",
  );
}
function clearUninitializedInstance(db, instanceId) {
  for (const table of Object.keys(TABLES).filter(
    (t) => t !== "upgrade_instances",
  ))
    invariant(
      db.prepare("SELECT count(*) n FROM " + q(table)).get().n === 0,
      "CONTROL_MIGRATION_TARGET_NOT_EMPTY",
    );
  const instances = db.prepare("SELECT * FROM upgrade_instances").all();
  invariant(
    instances.length === 0 ||
      (instances.length === 1 &&
        instances[0].instance_id === instanceId &&
        instances[0].activation_generation === 0 &&
        instances[0].confirmed_release === null &&
        instances[0].ready === 0 &&
        instances[0].service_state === "unknown"),
    "CONTROL_MIGRATION_TARGET_NOT_EMPTY",
  );
  db.prepare("DELETE FROM upgrade_instances WHERE instance_id=?").run(
    instanceId,
  );
}
function manifestRow(db) {
  const r = db
    .prepare("SELECT value FROM control_migration_export WHERE singleton=1")
    .get();
  invariant(r, "CONTROL_MIGRATION_EXPORT_INCOMPLETE");
  const v = JSON.parse(r.value),
    unsigned = { ...v };
  delete unsigned.exportDigest;
  invariant(
    v.schemaVersion === 1 &&
      v.state === "complete" &&
      v.exportDigest === digest(unsigned),
    "CONTROL_MIGRATION_EXPORT_INVALID",
  );
  return v;
}
function checkExportTables(db) {
  const allowed = new Set([
    ...Object.keys(TABLES),
    "control_store_metadata",
    "control_business_binding",
    "control_migration_export",
  ]);
  for (const row of db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .iterate())
    invariant(allowed.has(row.name), "CONTROL_MIGRATION_EXPORT_TABLE_UNKNOWN");
}
function readAuth(db, environment) {
  invariant(
    environment &&
      Object.keys(environment).every((k) =>
        [
          "ACCESS_PASSCODE",
          "PASSCODE_COOKIE_SECRET",
          "UPGRADE_SESSION_SECRET_BASE64",
          "UPGRADE_LEGACY_AUTH_CONTINUITY_KEY",
          "UPGRADE_ADMIN_KEY",
        ].includes(k),
      ),
    "CONTROL_MIGRATION_AUTH_ENV_UNKNOWN",
  );
  const row = db
    .prepare(
      "SELECT access_passcode_hash,access_passcode_updated_at,access_passcode_session_secret FROM system_settings WHERE id=1",
    )
    .get();
  invariant(row, "CONTROL_MIGRATION_AUTH_SOURCE_UNKNOWN");
  const sessionSecret =
    environment.PASSCODE_COOKIE_SECRET || row.access_passcode_session_secret;
  invariant(
    typeof sessionSecret === "string" &&
      sessionSecret.length > 0 &&
      typeof environment.UPGRADE_SESSION_SECRET_BASE64 === "string",
    "CONTROL_MIGRATION_AUTH_SECRET_REQUIRED",
  );
  return {
    source: environment.ACCESS_PASSCODE
      ? "env"
      : row.access_passcode_hash
        ? "stored"
        : "none",
    sessionSecret,
    storedPasscodeHash: row.access_passcode_hash,
    envPasscode: environment.ACCESS_PASSCODE || "",
    secretPinned: Boolean(environment.PASSCODE_COOKIE_SECRET),
    updatedAt: row.access_passcode_updated_at,
    upgradeSessionSecretBase64: environment.UPGRADE_SESSION_SECRET_BASE64,
    ...(environment.UPGRADE_LEGACY_AUTH_CONTINUITY_KEY ||
    environment.UPGRADE_ADMIN_KEY
      ? {
          legacyContinuityKey:
            environment.UPGRADE_LEGACY_AUTH_CONTINUITY_KEY ||
            environment.UPGRADE_ADMIN_KEY,
        }
      : {}),
  };
}
function authStateDigest(db) {
  const access = db
      .prepare("SELECT * FROM control_access WHERE singleton=1")
      .get(),
    environment = db
      .prepare("SELECT * FROM control_access_environment ORDER BY instance_id")
      .all();
  invariant(
    environment.length <= 1 &&
      environment.every((row) => row.instance_id === access?.instance_id),
    "CONTROL_MIGRATION_AUTH_SCOPE_CHANGED",
  );
  return digest({ access, environment });
}
/** Called inside the source RO snapshot. Secrets never leave this RAM-to-private-DB operation. */
export async function importControlAccessState({
  Database,
  accessPath,
  instanceId,
  migrationId,
  input,
}) {
  secureTarget(accessPath);
  const db = new Database(accessPath);
  try {
    db.pragma("busy_timeout = 50");
    const other = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('control_access','control_access_environment','control_migration_auth') LIMIT 1",
      )
      .get();
    invariant(!other, "CONTROL_MIGRATION_AUTH_DATABASE_SCOPE_INVALID");
    const authority = createControlAccessAuthority({
      sqlite: db,
      instanceId,
      envPasscode: input.envPasscode,
      retainEnvironment: true,
      sessionSecretOverride: input.secretPinned ? input.sessionSecret : "",
    });
    db.exec(
      "CREATE TABLE IF NOT EXISTS control_migration_auth(singleton INTEGER PRIMARY KEY CHECK(singleton=1),instance_id TEXT NOT NULL,migration_id TEXT NOT NULL,input_digest TEXT NOT NULL,state_digest TEXT NOT NULL)",
    );
    const prior = db
        .prepare("SELECT * FROM control_migration_auth WHERE singleton=1")
        .get(),
      inputDigest = digest(input);
    if (prior) {
      invariant(
        prior.instance_id === instanceId &&
          prior.migration_id === migrationId &&
          prior.input_digest === inputDigest &&
          prior.state_digest === authStateDigest(db),
        "CONTROL_MIGRATION_AUTH_CONFLICT",
      );
      const r = db
        .prepare("SELECT * FROM control_access WHERE singleton=1")
        .get();
      invariant(
        r &&
          r.instance_id === instanceId &&
          r.session_secret === input.sessionSecret &&
          r.passcode_hash === (input.storedPasscodeHash ?? null) &&
          r.upgrade_secret === input.upgradeSessionSecretBase64 &&
          r.legacy_key === (input.legacyContinuityKey ?? null) &&
          r.secret_pinned === (input.secretPinned ? 1 : 0) &&
          r.source === (input.storedPasscodeHash ? "stored" : "none") &&
          r.updated_at === (input.updatedAt ?? null) &&
          r.revision === 1 &&
          r.session_generation === 1,
        "CONTROL_MIGRATION_AUTH_CHANGED",
      );
      return { prepared: true, stateDigest: authStateDigest(db) };
    }
    // Async KDF retains the ENV verifier only in the private authority database.
    db.exec("BEGIN IMMEDIATE");
    try {
      await authority.importState(input);
      db.prepare("INSERT INTO control_migration_auth VALUES(1,?,?,?,?)").run(
        instanceId,
        migrationId,
        inputDigest,
        authStateDigest(db),
      );
      db.exec("COMMIT");
    } catch (e) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw e;
    }
    return {
      prepared: true,
      stateDigest: authStateDigest(db),
    };
  } finally {
    db.close();
  }
}
/** Live qualification is captured before maintenance. It never grants activation. */
export async function qualifyControlMigrationSource({
  Database,
  apiRoot,
  businessPath,
  instanceId,
  readSourceCoordinator,
  sourcePhysical,
  clock = Date.now,
}) {
  const db = new Database(businessPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    db.pragma("query_only=ON");
    db.exec("BEGIN");
    assertSchema(db);
    assertClosure(db, instanceId);
    const sourceCoordinator = await readSourceCoordinator();
    invariant(
      sourcePhysical?.running === true &&
        sourcePhysical.hostPid > 0 &&
        sourcePhysical.startIdentity === sourceCoordinator.startIdentity &&
        sourcePhysical.artifactDigest === sourceCoordinator.artifactDigest,
      "CONTROL_MIGRATION_LIVE_PHYSICAL_UNKNOWN",
    );
    const binding = loadApi(apiRoot).observeControlMetadataSource({
      businessSqlite: db,
      instanceId,
      migrationsFolder: join(apiRoot, "drizzle"),
      clock: { now: () => new Date(clock()) },
      sourceCoordinator,
    });
    const lease = db
      .prepare(
        "SELECT instance_id,holder_id,generation,fence,expires_at FROM platform_role_leases WHERE role='state-coordinator'",
      )
      .get();
    const proof = {
      instanceId,
      business: { ...identity(businessPath), path: businessPath },
      binding,
      sourceCoordinator,
      sourcePhysical,
      lease,
      observedAt: sourceCoordinator.observedAt,
    };
    return { ...proof, proofDigest: digest(proof) };
  } finally {
    if (db.inTransaction) db.exec("ROLLBACK");
    db.close();
  }
}
function verifyStoppedSource(
  db,
  qualifiedSource,
  physical,
  instanceId,
  businessPath,
  clock,
) {
  const unsigned = { ...qualifiedSource };
  delete unsigned.proofDigest;
  invariant(
    qualifiedSource.proofDigest === digest(unsigned) &&
      qualifiedSource.instanceId === instanceId &&
      qualifiedSource.business.path === businessPath &&
      sameIdentity(qualifiedSource.business, identity(businessPath)),
    "CONTROL_MIGRATION_FINAL_SOURCE_UNKNOWN",
  );
  const lease = db
    .prepare(
      "SELECT instance_id,holder_id,generation,fence,expires_at FROM platform_role_leases WHERE role='state-coordinator'",
    )
    .get();
  invariant(
    physical?.running === false &&
      physical.hostPid === 0 &&
      physical.oomKilled === false &&
      [0, 143].includes(physical.exitCode) &&
      physical.restartPolicy === "no" &&
      ["containerId", "startIdentity", "artifactDigest", "startedAt"].every(
        (k) => physical[k] === qualifiedSource.sourcePhysical[k],
      ) &&
      lease?.instance_id === instanceId &&
      ["holder_id", "generation", "fence"].every(
        (k) => lease[k] === qualifiedSource.lease[k],
      ) &&
      lease.expires_at <= clock(),
    "CONTROL_MIGRATION_FINAL_WRITER_NOT_STOPPED",
  );
  const journal = db
    .prepare(
      "SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at,id",
    )
    .all();
  invariant(
    journal.length === 29 &&
      digest(journal) === qualifiedSource.binding.source_journal_digest,
    "CONTROL_MIGRATION_SOURCE_SCHEMA_UNKNOWN",
  );
  return qualifiedSource.binding;
}
/** Source stays readonly/query_only. Only one row and its canonical encoding are resident. */
export async function exportControlMetadata({
  Database,
  apiRoot,
  businessPath,
  exportPath,
  accessPath,
  instanceId,
  migrationId,
  epochFloor,
  limits,
  readSourceCoordinator,
  readAccessEnvironment,
  qualifiedSource,
  readStoppedWriter,
  businessReadView,
  businessReadViewScope,
  clock = Date.now,
}) {
  invariant(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(instanceId) &&
      typeof migrationId === "string" &&
      migrationId.length <= 128 &&
      migrationId.length > 0 &&
      Number.isSafeInteger(epochFloor) &&
      epochFloor >= 0,
    "CONTROL_MIGRATION_SCOPE_INVALID",
  );
  invariant(
    new Set([businessPath, exportPath, accessPath]).size === 3,
    "CONTROL_MIGRATION_DATABASES_MUST_BE_SEPARATE",
  );
  separateDirectories(accessPath, businessPath);
  separateDirectories(exportPath, businessPath);
  const sourceIdentity = identity(businessPath),
    api = loadApi(apiRoot);
  if (qualifiedSource) {
    invariant(businessReadView?.receipt?.scope?.instanceId === instanceId && businessReadView.receipt.scope.migrationId === migrationId && businessReadView.receipt.scope.phase === "final-source" && DIGEST.test(businessReadViewScope?.configDigest) && canonical(businessReadView.receipt.scope) === canonical(businessReadViewScope), "CONTROL_MIGRATION_CLOSED_READ_VIEW_REQUIRED");
    await verifyClosedBusinessReadView({ Database, businessPath, view: businessReadView, assertClosed: async () => {
      const actual = await readStoppedWriter();
      invariant(actual.running === false && actual.hostPid === 0 && actual.oomKilled === false && [0,143].includes(actual.exitCode) && ["containerId","startIdentity","artifactDigest","startedAt"].every(k => actual[k] === qualifiedSource.sourcePhysical[k]), "CONTROL_MIGRATION_FINAL_WRITER_NOT_STOPPED");
    } });
  } else invariant(!businessReadView, "CONTROL_MIGRATION_LIVE_SOURCE_REQUIRES_REAL_DB");
  invariant(!existsSync(exportPath), "CONTROL_MIGRATION_EXPORT_EXISTS");
  secureTarget(exportPath);
  const source = new Database(businessReadView?.path ?? businessPath, {
      readonly: true,
      fileMustExist: true,
    }),
    target = new Database(exportPath);
  try {
    source.pragma("query_only = ON");
    source.pragma("busy_timeout = 50");
    target.pragma("busy_timeout = 50");
    source.exec("BEGIN");
    assertSchema(source);
    assertClosure(source, instanceId);
    const sourceCoordinator =
      qualifiedSource?.sourceCoordinator ?? (await readSourceCoordinator());
    const binding = qualifiedSource
      ? verifyStoppedSource(
          source,
          qualifiedSource,
          await readStoppedWriter(),
          instanceId,
          businessPath,
          clock,
        )
      : api.observeControlMetadataSource({
          businessSqlite: source,
          instanceId,
          migrationsFolder: join(apiRoot, "drizzle"),
          clock: { now: () => new Date(clock()) },
          sourceCoordinator,
        });
    const maxFence = Math.max(
      source
        .prepare(
          "SELECT coalesce(max(fence),0) n FROM upgrade_attempts WHERE instance_id=?",
        )
        .get(instanceId).n,
      source
        .prepare(
          "SELECT coalesce(max(fence),0) n FROM platform_operations WHERE instance_id=? AND role IN ('upgrade-plan','project-name-contract','upgrade-observation','upgrade-stage-progress')",
        )
        .get(instanceId).n,
    );
    invariant(epochFloor >= maxFence, "CONTROL_MIGRATION_EPOCH_FLOOR_TOO_LOW");
    api.createUpgradeControlStores({
      sqlite: target,
      instanceId,
      clock: { now: () => new Date(clock()) },
      ids: { next: randomUUID },
    });
    target.exec(
      "CREATE TABLE control_migration_export(singleton INTEGER PRIMARY KEY CHECK(singleton=1),value TEXT NOT NULL)",
    );
    target.exec("BEGIN IMMEDIATE");
    clearUninitializedInstance(target, instanceId);
    const measure = budget(limits);
    for (const table of Object.keys(TABLES)) {
      const statement = insert(target, table);
      for (const row of rows(source, table, instanceId, false)) {
        const value = project(table, row);
        measure.add(table, value);
        statement.run(value);
      }
    }
    api.bindControlMetadataSource(target, binding);
    const auth = await importControlAccessState({
      Database,
      accessPath,
      instanceId,
      migrationId,
      input: readAuth(source, await readAccessEnvironment()),
    });
    invariant(
      sameIdentity(sourceIdentity, identity(businessPath)),
      "CONTROL_MIGRATION_SOURCE_IDENTITY_CHANGED",
    );
    const manifest = {
      schemaVersion: 1,
      state: "complete",
      instanceId,
      migrationId,
      epochFloor,
      business: { ...sourceIdentity, path: businessPath },
      ...(businessReadView ? { businessReadView: businessReadView.receipt } : {}),
      binding,
      writerObservedAt: sourceCoordinator.observedAt,
      authStateDigest: auth.stateDigest,
      limits,
      ...measure.finish(),
      recordedAt: new Date(clock()).toISOString(),
    };
    manifest.exportDigest = digest(manifest);
    target
      .prepare("INSERT INTO control_migration_export VALUES(1,?)")
      .run(canonical(manifest));
    target.exec("COMMIT");
    source.exec("COMMIT");
    return manifest;
  } catch (e) {
    if (source.inTransaction) source.exec("ROLLBACK");
    if (target.inTransaction) target.exec("ROLLBACK");
    throw e;
  } finally {
    source.close();
    target.close();
    chmodSync(exportPath, 0o400);
  }
}
/** Repeated import compares every original row. Passive state is mandatory; no activation occurs. */
export function importControlMetadata({
  Database,
  apiRoot,
  exportPath,
  controlPath,
  accessPath,
  instanceId,
  expectedExportDigest,
  clock = Date.now,
}) {
  invariant(
    new Set([exportPath, controlPath, accessPath]).size === 3 &&
      isAbsolute(accessPath),
    "CONTROL_MIGRATION_DATABASES_MUST_BE_SEPARATE",
  );
  separateDirectories(controlPath, accessPath);
  const exportIdentity = identity(exportPath),
    api = loadApi(apiRoot);
  secureTarget(controlPath);
  const targetIdentity = identity(controlPath);
  const source = new Database(exportPath, {
      readonly: true,
      fileMustExist: true,
    }),
    target = new Database(controlPath);
  try {
    source.pragma("query_only = ON");
    source.exec("BEGIN");
    checkExportTables(source);
    assertSchema(source, true);
    const manifest = manifestRow(source);
    invariant(
      sameIdentity(manifest.business, identity(manifest.business.path)),
      "CONTROL_MIGRATION_SOURCE_IDENTITY_CHANGED",
    );
    separateDirectories(controlPath, manifest.business.path);
    separateDirectories(accessPath, manifest.business.path);
    assertClosure(source, instanceId);
    for (const table of Object.keys(TABLES))
      invariant(
        source.prepare("SELECT count(*) n FROM " + q(table)).get().n ===
          manifest.counts[table],
        "CONTROL_MIGRATION_EXPORT_SCOPE_INVALID",
      );
    invariant(
      manifest.instanceId === instanceId &&
        manifest.exportDigest === expectedExportDigest,
      "CONTROL_MIGRATION_EXPORT_SCOPE_INVALID",
    );
    const access = new Database(accessPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      access.pragma("query_only = ON");
      const stamp = access
        .prepare(
          "SELECT instance_id,migration_id FROM control_migration_auth WHERE singleton=1",
        )
        .get();
      invariant(
        stamp?.instance_id === instanceId &&
          stamp.migration_id === manifest.migrationId &&
          authStateDigest(access) === manifest.authStateDigest,
        "CONTROL_MIGRATION_AUTH_CHANGED",
      );
    } finally {
      access.close();
    }
    api.createUpgradeControlStores({
      sqlite: target,
      instanceId,
      clock: { now: () => new Date(clock()) },
      ids: { next: randomUUID },
    });
    const authority = createControlAuthority({
      sqlite: target,
      instanceId,
      epochFloor: manifest.epochFloor,
      clock,
    });
    invariant(
      authority.observe().mode === "passive" &&
        authority.observe().holderId === null &&
        authority.observe().operationId === null &&
        authority.observe().kind === null &&
        authority.observe().epoch === manifest.epochFloor &&
        authority.observe().sourceBindingDigest === null &&
        authority.observe().leaseExpiresAt === 0,
      "CONTROL_MIGRATION_AUTHORITY_MUST_BE_PASSIVE",
    );
    target.exec(
      "CREATE TABLE IF NOT EXISTS control_migration_import(singleton INTEGER PRIMARY KEY CHECK(singleton=1),instance_id TEXT NOT NULL,migration_id TEXT NOT NULL,export_digest TEXT NOT NULL,auth_digest TEXT NOT NULL)",
    );
    const prior = target
      .prepare("SELECT * FROM control_migration_import WHERE singleton=1")
      .get();
    invariant(
      !prior ||
        (prior.instance_id === instanceId &&
          prior.migration_id === manifest.migrationId &&
          prior.export_digest === manifest.exportDigest),
      "CONTROL_MIGRATION_IMPORT_CONFLICT",
    );
    target.exec("BEGIN IMMEDIATE");
    invariant(
      authority.observe().mode === "passive" &&
        authority.observe().holderId === null &&
        authority.observe().operationId === null &&
        authority.observe().kind === null &&
        authority.observe().epoch === manifest.epochFloor &&
        authority.observe().sourceBindingDigest === null &&
        authority.observe().leaseExpiresAt === 0,
      "CONTROL_MIGRATION_AUTHORITY_MUST_BE_PASSIVE",
    );
    if (!prior) clearUninitializedInstance(target, instanceId);
    const measure = budget(manifest.limits);
    for (const table of Object.keys(TABLES)) {
      const statement = prior ? null : insert(target, table);
      if (!prior)
        invariant(
          target.prepare("SELECT count(*) n FROM " + q(table)).get().n === 0,
          "CONTROL_MIGRATION_TARGET_NOT_EMPTY",
        );
      const existing = prior
        ? target
            .prepare(
              "SELECT rowid AS __rowid," +
                columns(table).map(q).join(",") +
                " FROM " +
                q(table) +
                " ORDER BY rowid",
            )
            .iterate()
        : null;
      try {
        for (const row of rows(source, table, instanceId, true)) {
          measure.add(table, row);
          if (statement) statement.run(row);
          else
            invariant(
              canonical(existing.next().value) === canonical(row),
              "CONTROL_MIGRATION_IMPORTED_HISTORY_CHANGED",
            );
        }
        if (existing)
          invariant(
            existing.next().done,
            "CONTROL_MIGRATION_IMPORTED_HISTORY_CHANGED",
          );
      } finally {
        existing?.return();
      }
    }
    const measured = measure.finish();
    invariant(
      measured.rowDigest === manifest.rowDigest &&
        canonical(measured.counts) === canonical(manifest.counts) &&
        measured.bytes === manifest.bytes &&
        measured.rows === manifest.rows,
      "CONTROL_MIGRATION_EXPORT_CONTENT_CHANGED",
    );
    invariant(
      sameIdentity(exportIdentity, identity(exportPath)),
      "CONTROL_MIGRATION_EXPORT_IDENTITY_CHANGED",
    );
    api.bindControlMetadataSource(target, manifest.binding);
    if (!prior)
      target
        .prepare("INSERT INTO control_migration_import VALUES(1,?,?,?,?)")
        .run(
          instanceId,
          manifest.migrationId,
          manifest.exportDigest,
          manifest.authStateDigest,
        );
    invariant(
      sameIdentity(targetIdentity, identity(controlPath)),
      "CONTROL_MIGRATION_TARGET_IDENTITY_CHANGED",
    );
    target.exec("COMMIT");
    source.exec("COMMIT");
    return {
      prepared: true,
      mode: "passive",
      instanceId,
      migrationId: manifest.migrationId,
      exportDigest: manifest.exportDigest,
      counts: manifest.counts,
      rows: manifest.rows,
      business: manifest.business,
      writerObservedAt: manifest.writerObservedAt,
    };
  } catch (e) {
    if (source.inTransaction) source.exec("ROLLBACK");
    if (target.inTransaction) target.exec("ROLLBACK");
    throw e;
  } finally {
    source.close();
    target.close();
  }
}
export function controlMigrationStatus({
  Database,
  controlPath,
  accessPath,
  instanceId,
}) {
  if (!existsSync(controlPath))
    return { state: "not-prepared", instanceId, applySupported: false };
  identity(controlPath);
  identity(accessPath);
  const ledger = new Database(controlPath, {
      readonly: true,
      fileMustExist: true,
    }),
    access = new Database(accessPath, { readonly: true, fileMustExist: true });
  try {
    ledger.pragma("query_only = ON");
    access.pragma("query_only = ON");
    const record = ledger
      .prepare("SELECT * FROM control_migration_import WHERE singleton=1")
      .get();
    const policy = access
      .prepare(
        "SELECT instance_id,migration_id FROM control_migration_auth WHERE singleton=1",
      )
      .get();
    const authority = ledger
      .prepare(
        "SELECT instance_id,mode,epoch FROM control_authority WHERE instance_id=?",
      )
      .get(instanceId);
    invariant(
      record?.instance_id === instanceId &&
        policy?.instance_id === instanceId &&
        record.migration_id === policy.migration_id &&
        authority?.instance_id === instanceId,
      "CONTROL_MIGRATION_PREPARATION_INCOMPLETE",
    );
    invariant(
      authStateDigest(access) === record.auth_digest,
      "CONTROL_MIGRATION_AUTH_CHANGED",
    );
    return {
      state: "prepared",
      instanceId,
      migrationId: policy.migration_id,
      exportDigest: record.export_digest,
      mode: authority.mode,
      epoch: authority.epoch,
      applySupported: false,
    };
  } finally {
    ledger.close();
    access.close();
  }
}

/** Local RO planning, not live writer qualification or permission to apply. */
export function planControlMigration({
  Database,
  apiRoot,
  businessPath,
  instanceId,
  migrationId,
  epochFloor,
  limits,
}) {
  budget(limits);
  const business = identity(businessPath),
    db = new Database(businessPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    db.exec("BEGIN");
    assertSchema(db);
    assertClosure(db, instanceId);
    const api = loadApi(apiRoot),
      journal = db
        .prepare(
          "SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at,id",
        )
        .all();
    invariant(
      journal.length === 29 &&
        digest(journal) === api.CONTROL_METADATA_MIGRATION.sourceJournalDigest,
      "CONTROL_MIGRATION_SOURCE_SCHEMA_UNKNOWN",
    );
    const counts = {};
    for (const table of Object.keys(TABLES))
      counts[table] = db
        .prepare(
          "SELECT count(*) n FROM " + q(table) + " WHERE " + selection(table),
        )
        .get({ instanceId }).n;
    const instance = db
      .prepare(
        "SELECT activation_generation,service_state,ready FROM upgrade_instances WHERE instance_id=?",
      )
      .get(instanceId);
    return {
      state: "planned",
      instanceId,
      migrationId,
      epochFloor,
      business: { ...business, path: businessPath },
      businessSchema: 29,
      counts,
      instance,
      limits,
      liveWriterQualified: false,
      applySupported: false,
    };
  } finally {
    if (db.inTransaction) db.exec("ROLLBACK");
    db.close();
  }
}
export async function prepareControlMigration(input) {
  let manifest;
  if (existsSync(input.exportPath)) {
    const db = new input.Database(input.exportPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      db.pragma("query_only = ON");
      manifest = manifestRow(db);
    } finally {
      db.close();
    }
    invariant(
      manifest.instanceId === input.instanceId &&
        manifest.migrationId === input.migrationId &&
        manifest.epochFloor === input.epochFloor &&
        manifest.business.path === input.businessPath &&
        canonical(manifest.limits) === canonical(input.limits),
      "CONTROL_MIGRATION_EXPORT_SCOPE_INVALID",
    );
  } else manifest = await exportControlMetadata(input);
  const receipt = importControlMetadata({
    ...input,
    expectedExportDigest: manifest.exportDigest,
  });
  return { ...receipt, applySupported: false };
}
