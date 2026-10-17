import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  importNativeSource,
  assertNativeStopReceipt,
  assertNativeDatabaseIdle,
  remapNativePath,
  verifyNativeImportedTree,
} from "./native-source-import.mjs";
const require = createRequire(
  new URL("../../api/package.json", import.meta.url),
);
const D = require("better-sqlite3"),
  { drizzle } = require("drizzle-orm/better-sqlite3"),
  { migrate } = require("drizzle-orm/better-sqlite3/migrator");
const sqliteModulePath = fileURLToPath(
  new URL("../../api/package.json", import.meta.url),
);
const sha = "sha256:" + "a".repeat(64);
const idle = () => ({
  ready: true,
  idle: true,
  draining: false,
  inFlightHTTP: 0,
  activeWS: 0,
  credentialAuth: 0,
  blockers: Object.fromEntries(
    [
      "sandboxes",
      "agentTasks",
      "automationRuns",
      "enabledAutomations",
      "resourceAllocations",
      "cloningProjects",
      "projectCleanupJobs",
    ].map((k) => [k, 0]),
  ),
});
function original() {
  return {
    kind: "darwin-native",
    platform: "darwin",
    arch: "arm64",
    dataRoot: "/Users/operator/native/data",
    api: {
      label: "com.example.native.api",
      pid: 42,
      birthMicros: "1791945075334011",
      entry: "/Users/operator/native/api.js",
      entryDigest: sha,
    },
    web: {
      label: "com.example.native.web",
      pid: 43,
      birthMicros: "1791945075334021",
      entry: "/Users/operator/native/web.js",
      entryDigest: sha,
    },
  };
}
function stop(o) {
  return {
    schemaVersion: 1,
    kind: "darwin-native-source-stop",
    original: o,
    before: idle(),
    beforeStop: idle(),
    admissionHeld: true,
    oldProcessAbsent: true,
    launchdUnloaded: true,
    frozenDatabaseDigest: sha,
    masterKeyDigest: sha,
    stoppedAt: "2026-10-17T00:00:00Z",
    observedAt: "2026-10-17T00:00:01Z",
  };
}
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "native-import-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "source");
  await fs.mkdir(sourceRoot, { mode: 0o700 });
  const o = original(),
    key = randomBytes(32),
    iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv),
    blob = Buffer.concat([
      cipher.update("private-test-credential"),
      cipher.final(),
    ]);
  await fs.writeFile(join(sourceRoot, ".master.key"), key, { mode: 0o600 });
  await fs.writeFile(
    join(sourceRoot, ".upgrade-session-secret"),
    randomBytes(32),
    { mode: 0o600 },
  );
  for (const d of [
    "baselines/p",
    "workspaces/old",
    "logs/agent-tasks/task",
    ".ssh",
    "boxlite",
    "auth-helper",
    ".gitkeys",
  ])
    await fs.mkdir(join(sourceRoot, d), { recursive: true, mode: 0o700 });
  await fs.chmod(join(sourceRoot, "workspaces/old"), 0o777);
  await fs.writeFile(join(sourceRoot, "baselines/p/readme"), "baseline");
  await fs.writeFile(
    join(sourceRoot, "workspaces/old/result"),
    "retained-result",
  );
  await fs.symlink("result", join(sourceRoot, "workspaces/old/result-link"));
  await fs.writeFile(
    join(sourceRoot, "logs/agent-tasks/task/stdout.jsonl"),
    '{"type":"test"}\n',
    { mode: 0o600 },
  );
  await fs.writeFile(
    join(sourceRoot, ".ssh/known_hosts"),
    "example.test public-test-key\n",
    { mode: 0o600 },
  );
  await fs.writeFile(join(sourceRoot, "boxlite/do-not-import"), "native-sdk");
  const db = new D(join(sourceRoot, "platform.db"));
  migrate(drizzle(db), {
    migrationsFolder: fileURLToPath(
      new URL("../../api/drizzle", import.meta.url),
    ),
  });
  db.prepare(
    "INSERT INTO projects(id,name,source_type,clone_status,baseline_path,created_at,updated_at) VALUES('p','Test','empty','ready',?,1,1)",
  ).run(o.dataRoot + "/baselines/p");
  db.prepare(
    "INSERT INTO sandboxes(id,project_id,runtime,status,headless,workspace_path,created_at,updated_at) VALUES('old','p','codex','destroyed',0,?,1,1)",
  ).run(o.dataRoot + "/workspaces/old");
  db.prepare(
    "INSERT INTO sandbox_create_intents(sandbox_id,operation_id,request_digest,workspace_path,state,created_at) VALUES('old','operation','digest',?,'finished',1)",
  ).run(o.dataRoot + "/workspaces/old");
  db.prepare(
    "INSERT INTO retained_volumes(id,project_id,sandbox_id,workspace_path,source,retain_until,retained_at) VALUES('retained','p','old',?,'manual-destroy',2000,1)",
  ).run(o.dataRoot + "/workspaces/old");
  db.prepare(
    "INSERT INTO agent_tasks(id,sandbox_id,runtime,job_handle,status,log_path,timeout_ms,started_at,finished_at) VALUES('task','old','codex','{\"opaque\":\"native-history\"}','succeeded',?,1000,1,2)",
  ).run(o.dataRoot + "/logs/agent-tasks/task");
  db.prepare(
    "INSERT INTO automations(id,project_id,name,runtime_id,prompt,schedule_kind,schedule_config,timezone,enabled,created_at,updated_at) VALUES('automation','p','history','codex','test','hourly','{}','UTC',0,1,1)",
  ).run();
  db.prepare(
    "INSERT INTO automation_runs(id,automation_id,status,triggered_at,started_at,completed_at,outcome_applied,log_path) VALUES('run','automation','success',1,1,2,1,?)",
  ).run(o.dataRoot + "/logs/agent-tasks/task/stdout.jsonl");
  db.prepare(
    "INSERT INTO system_settings(id,access_passcode_session_secret) VALUES(1,?)",
  ).run("persisted-cookie-secret".padEnd(64, "x"));
  db.prepare(
    "INSERT INTO credentials(id,kind,masked_identifier,encrypted_blob,iv,auth_tag,encryption_key_id,obtained_via,allowed_hosts,issued_at) VALUES('c','git','masked',?,?,?,?, 'git-https-token','[\"example.test\"]',1)",
  ).run(
    blob.toString("base64"),
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    "test-key",
  );
  db.close();
  await fs.chmod(join(sourceRoot, "platform.db"), 0o600);
  const stopReceipt = stop(o);
  stopReceipt.frozenDatabaseDigest =
    "sha256:" +
    createHash("sha256")
      .update(await fs.readFile(join(sourceRoot, "platform.db")))
      .digest("hex");
  stopReceipt.masterKeyDigest =
    "sha256:" + createHash("sha256").update(key).digest("hex");
  return {
    root,
    key,
    config: {
      sourceRoot,
      destinationRoot: join(root, "destination"),
      sourceDataRoot: o.dataRoot,
      targetDataRoot: "/data",
      original: o,
      stopReceipt,
      sqliteModulePath,
      instanceId: "iflytek-unified",
      businessHostPath: "/var/lib/docker/volumes/new-business/_data",
      receiptPath: join(root, "receipt.json"),
      backupPath: sourceRoot,
      commits: Object.fromEntries(
        ["project", "api", "web"].map((k) => [k, "a".repeat(40)]),
      ),
    },
  };
}
test("real migrated schema-28 SQLite and files import without opening SDK or changing source; Vault and Cookie bytes survive", async (t) => {
  const f = await fixture(t),
    c = f.config,
    sourceBytes = await fs.readFile(join(c.sourceRoot, "platform.db"));
  const r = await importNativeSource(c);
  assert.deepEqual(
    await fs.readFile(join(c.sourceRoot, "platform.db")),
    sourceBytes,
  );
  assert.equal(
    (await fs.stat(join(c.destinationRoot, "workspaces/old"))).mode & 0o777,
    0o777,
  );
  assert.equal(r.databaseMigration.from, 28);
  assert.equal(r.databaseMigration.to, 28);
  assert.equal(r.darwinSdkImported, false);
  assert.equal(r.retainedDestroyedSandboxes, 1);
  assert.equal(
    await fs.readFile(join(c.destinationRoot, "workspaces/old/result"), "utf8"),
    "retained-result",
  );
  assert.equal(
    await fs.readlink(join(c.destinationRoot, "workspaces/old/result-link")),
    "result",
  );
  for (const d of ["boxlite", "auth-helper", ".gitkeys"])
    await assert.rejects(fs.stat(join(c.destinationRoot, d)), {
      code: "ENOENT",
    });
  const db = new D(join(c.destinationRoot, "platform.db"), { readonly: true });
  try {
    for (const [table, column, expected] of [
      ["retained_volumes", "workspace_path", "/data/workspaces/old"],
      ["sandbox_create_intents", "workspace_path", "/data/workspaces/old"],
      ["agent_tasks", "log_path", "/data/logs/agent-tasks/task"],
      [
        "automation_runs",
        "log_path",
        "/data/logs/agent-tasks/task/stdout.jsonl",
      ],
    ])
      assert.equal(
        db.prepare(`SELECT ${column} p FROM ${table}`).get().p,
        expected,
      );
    assert.equal(
      db.prepare("SELECT baseline_path p FROM projects").get().p,
      "/data/baselines/p",
    );
    assert.equal(
      db.prepare("SELECT workspace_path p FROM sandboxes").get().p,
      "/data/workspaces/old",
    );
    assert.equal(
      db
        .prepare("SELECT access_passcode_session_secret s FROM system_settings")
        .get().s,
      "persisted-cookie-secret".padEnd(64, "x"),
    );
    const row = db.prepare("SELECT * FROM credentials").get();
    const d = createDecipheriv(
      "aes-256-gcm",
      await fs.readFile(join(c.destinationRoot, ".master.key")),
      Buffer.from(row.iv, "base64"),
    );
    d.setAuthTag(Buffer.from(row.auth_tag, "base64"));
    assert.equal(
      Buffer.concat([
        d.update(Buffer.from(row.encrypted_blob, "base64")),
        d.final(),
      ]).toString(),
      "private-test-credential",
    );
    assertNativeDatabaseIdle(db);
  } finally {
    db.close();
  }
  assert.equal((await fs.stat(c.receiptPath)).mode & 0o777, 0o600);
  await verifyNativeImportedTree(c.destinationRoot, r);
  await fs.writeFile(
    join(c.destinationRoot, "workspaces/old/result"),
    "tampered",
  );
  await assert.rejects(
    verifyNativeImportedTree(c.destinationRoot, r),
    (e) => e.code === "NATIVE_IMPORTED_BUSINESS_CHANGED",
  );
});
test("a sealed read-only WAL database with stale SHM imports without incremental backup or source writes", async (t) => {
  const { config: c, root } = await fixture(t);
  const sourceDatabase = join(c.sourceRoot, "platform.db"),
    db = new D(sourceDatabase);
  db.pragma("journal_mode=WAL");
  db.exec(
    "CREATE TABLE readonly_backup_regression(payload TEXT); INSERT INTO readonly_backup_regression VALUES(hex(zeroblob(524288)))",
  );
  db.pragma("wal_checkpoint(TRUNCATE)");
  const staleShm = await fs.readFile(sourceDatabase + "-shm");
  assert.equal((await fs.stat(sourceDatabase + "-wal")).size, 0);
  db.close();
  // Preserve the exact sidecar shape from the stopped export, then make all
  // three database files genuinely nonwritable for this process. The fixture
  // is over 100 pages, so the old incremental backup repeatedly restarts.
  await fs.writeFile(sourceDatabase + "-wal", Buffer.alloc(0));
  await fs.writeFile(sourceDatabase + "-shm", staleShm);
  const sourceBytes = await fs.readFile(sourceDatabase);
  c.stopReceipt.frozenDatabaseDigest =
    "sha256:" + createHash("sha256").update(sourceBytes).digest("hex");
  const configPath = join(root, "readonly-import.json");
  await fs.writeFile(configPath, JSON.stringify(c), { mode: 0o600 });
  const beforeEntries = (await fs.readdir(c.sourceRoot)).sort();
  for (const suffix of ["", "-wal", "-shm"])
    await fs.chmod(sourceDatabase + suffix, 0o400);
  await fs.chmod(c.sourceRoot, 0o500);
  try {
    // Isolate the old implementation's unbounded setImmediate loop: a failed
    // regression kills only this child, never the test runner or any service.
    const moduleUrl = new URL("./native-source-import.mjs", import.meta.url);
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { readFile } from 'node:fs/promises'; import { importNativeSource } from ${JSON.stringify(moduleUrl.href)}; await importNativeSource(JSON.parse(await readFile(process.argv[1], 'utf8')));`,
        configPath,
      ],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
    );
    assert.deepEqual(await fs.readFile(sourceDatabase), sourceBytes);
    assert.deepEqual(await fs.readFile(sourceDatabase + "-shm"), staleShm);
    assert.equal((await fs.stat(sourceDatabase + "-wal")).size, 0);
    assert.deepEqual((await fs.readdir(c.sourceRoot)).sort(), beforeEntries);
    for (const suffix of ["", "-wal", "-shm"])
      assert.equal(
        (await fs.stat(sourceDatabase + suffix)).mode & 0o777,
        0o400,
      );
    const imported = new D(join(c.destinationRoot, "platform.db"));
    try {
      assert.equal(
        imported
          .prepare("SELECT length(payload) n FROM readonly_backup_regression")
          .get().n,
        1048576,
      );
      assert.equal(
        imported.prepare("SELECT baseline_path p FROM projects").get().p,
        "/data/baselines/p",
      );
      assertNativeDatabaseIdle(imported);
    } finally {
      imported.close();
    }
    const receipt = JSON.parse(await fs.readFile(c.receiptPath, "utf8"));
    assert.equal(
      receipt.sourceExportDatabaseDigest,
      c.stopReceipt.frozenDatabaseDigest,
    );
    assert.ok(receipt.excluded.includes("platform.db-wal"));
    assert.ok(receipt.excluded.includes("platform.db-shm"));
  } finally {
    await fs.chmod(c.sourceRoot, 0o700);
    for (const suffix of ["", "-wal", "-shm"])
      await fs.chmod(sourceDatabase + suffix, 0o600);
  }
});
test("unknown data, external symlink and absolute Git pointers refuse the import", async (t) => {
  for (const kind of ["unknown", "symlink", "git"]) {
    const f = await fixture(t),
      c = f.config;
    if (kind === "unknown")
      await fs.writeFile(join(c.sourceRoot, "unclassified"), "unknown");
    if (kind === "symlink")
      await fs.symlink("/etc/passwd", join(c.sourceRoot, "baselines/p/leak"));
    if (kind === "git")
      await fs.writeFile(
        join(c.sourceRoot, "baselines/p/.git"),
        "gitdir: /Users/operator/elsewhere\n",
      );
    await assert.rejects(
      importNativeSource(c),
      (e) =>
        e.code ===
        {
          unknown: "UNKNOWN_NATIVE_DATA_ENTRY",
          symlink: "NATIVE_BUSINESS_LINK_ESCAPE",
          git: "NATIVE_GIT_POINTER_ESCAPE",
        }[kind],
    );
  }
});
test("a live or stopped Native runtime is not adopted, and the source is never edited to make it idle", async (t) => {
  for (const status of ["running", "stopped"]) {
    const f = await fixture(t),
      c = f.config,
      db = new D(join(c.sourceRoot, "platform.db"));
    db.prepare(
      "UPDATE sandboxes SET status=?,provider_handle='native-handle'",
    ).run(status);
    db.close();
    const bytes = await fs.readFile(join(c.sourceRoot, "platform.db"));
    c.stopReceipt.frozenDatabaseDigest =
      "sha256:" + createHash("sha256").update(bytes).digest("hex");
    await assert.rejects(
      importNativeSource(c),
      (e) => e.code === "NATIVE_SOURCE_LIVE_RUNTIMEHANDLES",
    );
    assert.deepEqual(
      await fs.readFile(join(c.sourceRoot, "platform.db")),
      bytes,
    );
  }
});
test("source identity, missing stop proof, same-root import, path prefix/traversal and re-import are refused", async (t) => {
  const f = await fixture(t),
    c = f.config;
  assert.throws(
    () =>
      assertNativeStopReceipt(c.original, {
        ...c.stopReceipt,
        launchdUnloaded: false,
      }),
    (e) => e.code === "NATIVE_SOURCE_STOP_UNCONFIRMED",
  );
  assert.throws(
    () =>
      assertNativeStopReceipt(
        {
          ...c.original,
          api: { ...c.original.api, birthMicros: "1791945075334999" },
        },
        c.stopReceipt,
      ),
    (e) => e.code === "EXACT_NATIVE_STOP_PROOF_REQUIRED",
  );
  for (const p of [
    "/Users/operator/native/data2/baselines/p",
    "/Users/operator/native/data/baselines/../workspaces/x",
    "/etc/passwd",
  ])
    assert.throws(
      () => remapNativePath(p, c.sourceDataRoot, "/data", "baselines"),
      (e) => e.code === "NATIVE_BUSINESS_PATH_ESCAPE",
    );
  await assert.rejects(
    importNativeSource({ ...c, destinationRoot: c.sourceRoot }),
    (e) => e.code === "DISTINCT_NATIVE_IMPORT_PATHS_REQUIRED",
  );
  await importNativeSource(c);
  await assert.rejects(
    importNativeSource(c),
    (e) => e.code === "NATIVE_IMPORT_RECEIPT_EXISTS",
  );
});

test("frozen source bytes must match the real stop proof and a nonempty WAL never becomes a sealed export", async (t) => {
  for (const kind of ["digest", "wal"]) {
    const { config: c } = await fixture(t);
    if (kind === "digest")
      c.stopReceipt.frozenDatabaseDigest = "sha256:" + "f".repeat(64);
    else
      await fs.writeFile(
        join(c.sourceRoot, "platform.db-wal"),
        Buffer.alloc(128),
      );
    await assert.rejects(
      importNativeSource(c),
      (e) =>
        e.code ===
        (kind === "digest"
          ? "NATIVE_FROZEN_EXPORT_MISMATCH"
          : "NATIVE_EXPORT_NOT_SEALED"),
    );
    await assert.rejects(fs.stat(c.destinationRoot), { code: "ENOENT" });
  }
});
