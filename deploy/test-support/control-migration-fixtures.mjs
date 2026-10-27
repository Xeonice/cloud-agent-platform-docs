import { createRequire } from "node:module";
import { scryptSync } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  exportControlMetadata,
  importControlMetadata,
  controlMigrationStatus,
} from "../upgrade/control-migration.mjs";
import { digest } from "../upgrade/trust.mjs";
export const apiRoot = resolve("api"),
  require = createRequire(join(apiRoot, "package.json")),
  Database = require("better-sqlite3"),
  { drizzle } = require("drizzle-orm/better-sqlite3"),
  { migrate } = require("drizzle-orm/better-sqlite3/migrator");
export const limits = {
  maxRowBytes: 4 * 1024 * 1024,
  maxRows: 100000,
  maxBytes: 64 * 1024 * 1024,
  maxDurationMs: 30000,
};
const put = (db, table, row) =>
  db
    .prepare(
      "INSERT INTO " +
        table +
        "(" +
        Object.keys(row).join(",") +
        ") VALUES(" +
        Object.keys(row)
          .map((k) => "@" + k)
          .join(",") +
        ")",
    )
    .run(row);
export async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "control-migration-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ["business", "export", "ledger", "private"])
    await fs.mkdir(join(root, dir), { mode: 0o700 });
  const migrationRoot = join(root, "migrations");
  await fs.mkdir(join(migrationRoot, "meta"), { recursive: true });
  const journal = JSON.parse(
    await fs.readFile(join(apiRoot, "drizzle/meta/_journal.json"), "utf8"),
  );
  journal.entries = journal.entries.slice(0, 29);
  await fs.writeFile(
    join(migrationRoot, "meta/_journal.json"),
    JSON.stringify(journal),
  );
  for (const m of journal.entries)
    await fs.copyFile(
      join(apiRoot, "drizzle", m.tag + ".sql"),
      join(migrationRoot, m.tag + ".sql"),
    );
  const businessPath = join(root, "business/platform.db"),
    exportPath = join(root, "export/metadata.db"),
    controlPath = join(root, "ledger/control.db"),
    accessPath = join(root, "private/access.db");
  const db = new Database(businessPath);
  db.pragma("journal_mode = WAL");
  migrate(drizzle(db), { migrationsFolder: migrationRoot });
  const now = Date.now(),
    instanceId = "instance";
  put(db, "upgrade_instances", {
    instance_id: instanceId,
    activation_generation: 6,
    confirmed_release: JSON.stringify({ releaseId: "v0.3.18" }),
    service_state: "transitioning",
    ready: 0,
    updated_at: now,
  });
  for (const n of [1, 2]) {
    const id = "failed-" + n,
      plan = JSON.stringify({ planDigest: digest("plan-" + n), steps: [] });
    put(db, "upgrade_attempts", {
      attempt_id: id,
      instance_id: instanceId,
      actor_id: "admin",
      request_id: "request-" + n,
      request_digest: digest("request-" + n),
      target_release_id: "v0.3." + (18 + n),
      target_digest: digest("target-" + n),
      manifest: "{}",
      plan,
      source_activation: "{}",
      source_actual: '{"partial":true}',
      generation: 8 + n,
      sequence: 300 + n,
      state: "failed",
      stage: "failed",
      reason: "ORIGINAL_FAILURE",
      controller_id: "original-controller",
      fence: 20 + n,
      lease_expires_at: 0,
      accepted_at: now - 10000,
      observed_at: now - 1000,
    });
    const evidence = JSON.stringify({
      observedAt: new Date(now - 1000).toISOString(),
      payload: "real-original-" + n,
    });
    put(db, "upgrade_steps", {
      attempt_id: id,
      step_id: "observe25",
      completed_work: 25,
      applied: 1,
      receipt_digest: digest("receipt-" + n),
      evidence,
      applied_at: now - 1000,
    });
    put(db, "upgrade_events", {
      event_id: "event-" + n,
      attempt_id: id,
      event_digest: digest("event-" + n),
      generation: 8 + n,
      sequence: 300 + n,
      fence: 20 + n,
      kind: "failed",
      payload: evidence,
      recorded_at: now - 1000,
    });
    put(db, "upgrade_continuity_baselines", {
      attempt_id: id,
      snapshot: evidence,
      digest: digest("baseline-" + n),
      captured_at: now - 1000,
    });
  }
  put(db, "upgrade_recoveries", {
    recovery_attempt_id: "recovery",
    triggering_attempt_id: "failed-2",
    instance_id: instanceId,
    generation: 10,
    sequence: 4,
    state: "failed",
    plan: "{}",
    plan_digest: digest("recovery-plan"),
    reason: "ORIGINAL_FAILURE",
    observed_at: now - 1000,
  });
  for (const [i, role] of [
    "upgrade-plan",
    "project-name-contract",
    "upgrade-observation",
    "upgrade-stage-progress",
    "task-start",
  ].entries())
    put(db, "platform_operations", {
      operation_id: "op-" + i,
      instance_id: instanceId,
      actor_id: "admin",
      role,
      fence: 21,
      state:
        role === "upgrade-plan" || role === "project-name-contract"
          ? "failed"
          : "observed",
      request_digest: digest("op-" + i),
      result: JSON.stringify({ original: true }),
      created_at: now - 10000,
      updated_at: now - 1000,
    });
  put(db, "platform_role_leases", {
    role: "state-coordinator",
    instance_id: instanceId,
    holder_id: "source-holder",
    generation: 7,
    fence: 7,
    expires_at: now + 120000,
  });
  const salt = Buffer.alloc(16, 7),
    hash =
      "scrypt$16384$8$1$" +
      salt.toString("base64") +
      "$" +
      scryptSync("existing-passcode", salt, 32, {
        N: 16384,
        r: 8,
        p: 1,
      }).toString("base64");
  db.prepare(
    "INSERT INTO system_settings(id,access_passcode_hash,access_passcode_session_secret) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET access_passcode_hash=excluded.access_passcode_hash,access_passcode_session_secret=excluded.access_passcode_session_secret",
  ).run(hash, "original-cookie-signing-secret");
  t.after(() => db.close());
  const sourceCoordinator = {
    instanceId,
    artifactDigest: digest("coordinator19"),
    startIdentity: "source-coordinator-start-identity",
    generation: 7,
    writerFenceValid: true,
    observedAt: new Date(now).toISOString(),
  };
  const environment = {
    UPGRADE_SESSION_SECRET_BASE64: Buffer.alloc(32, 8).toString("base64"),
  };
  const args = {
    Database,
    apiRoot,
    businessPath,
    exportPath,
    accessPath,
    instanceId,
    migrationId: "migration",
    epochFloor: 34,
    limits,
    readSourceCoordinator: async () => sourceCoordinator,
    readAccessEnvironment: async () => environment,
  };
  return {
    root,
    db,
    args,
    controlPath,
    accessPath,
    exportPath,
    sourceCoordinator,
    environment,
    now,
    export: () => exportControlMetadata(args),
    import: (manifest) =>
      importControlMetadata({
        Database,
        apiRoot,
        exportPath,
        controlPath,
        accessPath,
        instanceId,
        expectedExportDigest: manifest.exportDigest,
      }),
    status: () =>
      controlMigrationStatus({ Database, controlPath, accessPath, instanceId }),
  };
}
