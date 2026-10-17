/** One-time Darwin mono -> Linux separated-role data import. This module never
 * controls launchd, opens a provider SDK, starts a service, or writes the source.
 * The host operator must first freeze the real source and supply its stop proof. */
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { invariant, canonical, digest } from "../upgrade/trust.mjs";
import {
  atomicJson,
  fileDigest,
  inside,
  secureDirectory,
} from "../upgrade/io.mjs";

const SHA = /^sha256:[a-f0-9]{64}$/;
const PATH_COLUMNS = [
  ["projects", "baseline_path", "baselines"],
  ["retained_volumes", "workspace_path", "workspaces"],
  ["sandboxes", "workspace_path", "workspaces"],
  ["sandbox_create_intents", "workspace_path", "workspaces"],
  ["agent_tasks", "log_path", "logs"],
  ["automation_runs", "log_path", "logs"],
];
const COPIED = new Set([
  "baselines",
  "workspaces",
  "logs",
  ".ssh",
  ".master.key",
  ".upgrade-session-secret",
]);
const EXCLUDED = new Set([
  "boxlite",
  "auth-helper",
  ".gitkeys",
  "platform.db-wal",
  "platform.db-shm",
]);
const BLOCKERS = [
  "sandboxes",
  "agentTasks",
  "automationRuns",
  "enabledAutomations",
  "resourceAllocations",
  "cloningProjects",
  "projectCleanupJobs",
];
export const nativeSource = (c) => c?.original?.kind === "darwin-native";
const idle = (s) =>
  s?.ready === true &&
  s.idle === true &&
  s.draining === false &&
  ["inFlightHTTP", "activeWS", "credentialAuth"].every((k) => s[k] === 0) &&
  BLOCKERS.every((k) => s.blockers?.[k] === 0);
const absolute = (p) =>
  typeof p === "string" &&
  isAbsolute(p) &&
  resolve(p) === p &&
  !/[\r\n,\0]/.test(p);
export function assertNativeOriginal(o) {
  invariant(
    o?.kind === "darwin-native" &&
      o.platform === "darwin" &&
      o.arch === "arm64" &&
      absolute(o.dataRoot) &&
      o.dataRoot !== "/",
    "PINNED_NATIVE_SOURCE_REQUIRED",
  );
  for (const role of ["api", "web"]) {
    const r = o[role];
    invariant(
      r &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]+$/.test(r.label) &&
        Number.isSafeInteger(r.pid) &&
        r.pid > 0 &&
        /^[1-9][0-9]{9,19}$/.test(r.birthMicros) &&
        absolute(r.entry) &&
        SHA.test(r.entryDigest),
      "PINNED_NATIVE_PROCESS_REQUIRED",
    );
  }
  invariant(
    o.api.pid !== o.web.pid && o.api.label !== o.web.label,
    "DISTINCT_NATIVE_PROCESSES_REQUIRED",
  );
  return o;
}
export function assertNativeStopReceipt(original, r) {
  assertNativeOriginal(original);
  invariant(
    r?.schemaVersion === 1 &&
      r.kind === "darwin-native-source-stop" &&
      canonical(r.original) === canonical(original),
    "EXACT_NATIVE_STOP_PROOF_REQUIRED",
  );
  invariant(
    idle(r.before) &&
      idle(r.beforeStop) &&
      r.admissionHeld === true &&
      r.oldProcessAbsent === true &&
      r.launchdUnloaded === true &&
      SHA.test(r.frozenDatabaseDigest) &&
      SHA.test(r.masterKeyDigest) &&
      Number.isFinite(Date.parse(r.stoppedAt)) &&
      Number.isFinite(Date.parse(r.observedAt)) &&
      Date.parse(r.observedAt) >= Date.parse(r.stoppedAt),
    "NATIVE_SOURCE_STOP_UNCONFIRMED",
  );
  return r;
}
export function remapNativePath(value, sourceRoot, targetRoot, folder) {
  if (value === null) return null;
  invariant(
    absolute(sourceRoot) &&
      absolute(targetRoot) &&
      absolute(value) &&
      inside(join(sourceRoot, folder), value),
    "NATIVE_BUSINESS_PATH_ESCAPE",
  );
  return join(targetRoot, relative(sourceRoot, value));
}
const q = (s) => '"' + s.replaceAll('"', '""') + '"';
function rowDigest(db, table, omit = []) {
  const cols = db
    .prepare(`PRAGMA table_info(${q(table)})`)
    .all()
    .map((r) => r.name)
    .filter((c) => !omit.includes(c));
  const rows = db
    .prepare(`SELECT ${cols.map(q).join(",")} FROM ${q(table)}`)
    .all()
    .map((r) => canonical(r))
    .sort();
  return { count: rows.length, digest: digest(rows) };
}
export function assertNativeDatabaseIdle(db) {
  const queries = [
    [
      "runtimeHandles",
      "SELECT count(*) n FROM sandboxes WHERE status NOT IN ('destroyed','failed') OR (status != 'destroyed' AND provider_handle IS NOT NULL)",
    ],
    ["agentTasks", "SELECT count(*) n FROM agent_tasks WHERE status='running'"],
    [
      "automationRuns",
      "SELECT count(*) n FROM automation_runs WHERE status IN ('pending','running') OR outcome_applied=0",
    ],
    [
      "enabledAutomations",
      "SELECT count(*) n FROM automations WHERE enabled=1",
    ],
    [
      "resourceAllocations",
      "SELECT count(*) n FROM resource_allocations WHERE released_at IS NULL",
    ],
    [
      "cloningProjects",
      "SELECT count(*) n FROM projects WHERE clone_status='cloning'",
    ],
    [
      "projectCleanupJobs",
      "SELECT count(*) n FROM sandbox_project_cleanup_jobs",
    ],
    [
      "sandboxIntents",
      "SELECT count(*) n FROM sandbox_create_intents WHERE state!='finished'",
    ],
    [
      "taskIntents",
      "SELECT count(*) n FROM agent_task_start_intents WHERE state!='complete'",
    ],
    [
      "automationIntents",
      "SELECT count(*) n FROM automation_launch_intents i LEFT JOIN automation_runs r ON r.id=i.run_id WHERE r.id IS NULL OR r.status IN ('pending','running')",
    ],
    [
      "upgradeInstances",
      "SELECT count(*) n FROM upgrade_instances WHERE activation_generation!=0 OR confirmed_release IS NOT NULL OR service_state!='unknown' OR ready!=0",
    ],
    ["upgradeAttempts", "SELECT count(*) n FROM upgrade_attempts"],
    ["roleLeases", "SELECT count(*) n FROM platform_role_leases"],
    ["operations", "SELECT count(*) n FROM platform_operations"],
    ["coordinatorHandoffs", "SELECT count(*) n FROM coordinator_handoffs"],
    ["roleHandoffs", "SELECT count(*) n FROM upgrade_role_handoffs"],
    ["coordinatorRecoveries", "SELECT count(*) n FROM coordinator_recoveries"],
    ["onlineMigrations", "SELECT count(*) n FROM upgrade_online_migrations"],
  ];
  for (const [kind, sql] of queries)
    invariant(
      db.prepare(sql).get().n === 0,
      "NATIVE_SOURCE_LIVE_" + kind.toUpperCase(),
    );
  invariant(
    db.pragma("quick_check", { simple: true }) === "ok" &&
      db.pragma("foreign_key_check").length === 0 &&
      db.prepare("SELECT count(*) n FROM __drizzle_migrations").get().n === 28,
    "NATIVE_SOURCE_DATABASE_INVALID",
  );
}
function gitMetadata(path, bytes, sourceRoot) {
  const name = path.split("/").at(-1),
    text = bytes.toString("utf8");
  if (name === ".git") {
    const match = /^gitdir:\s*(.+)\r?\n?$/.exec(text);
    invariant(
      match &&
        !isAbsolute(match[1]) &&
        inside(sourceRoot, resolve(dirname(path), match[1])),
      "NATIVE_GIT_POINTER_ESCAPE",
    );
  }
  if (path.includes("/.git/") && name === "alternates")
    for (const value of text.split(/\r?\n/).filter(Boolean))
      invariant(
        !isAbsolute(value) && inside(sourceRoot, resolve(dirname(path), value)),
        "NATIVE_GIT_ALTERNATES_ESCAPE",
      );
  if (path.includes("/.git/") && name === "config") {
    for (const match of text.matchAll(/^\s*worktree\s*=\s*(.+?)\s*$/gim)) {
      const value = match[1].replace(/^"(.*)"$/, "$1");
      invariant(!isAbsolute(value), "NATIVE_GIT_WORKTREE_ABSOLUTE");
      invariant(
        !/[\\\0]/.test(value) &&
          inside(sourceRoot, resolve(dirname(path), value)),
        "NATIVE_GIT_WORKTREE_ESCAPE",
      );
    }
  }
}
async function copyBusiness(sourceRoot, destRoot) {
  const manifest = [],
    excluded = [];
  async function copy(rel) {
    const src = join(sourceRoot, rel),
      dest = join(destRoot, rel),
      st = await fs.lstat(src);
    if (st.isSymbolicLink()) {
      const link = await fs.readlink(src);
      invariant(
        !isAbsolute(link) &&
          inside(sourceRoot, resolve(dirname(src), link)) &&
          inside(sourceRoot, await fs.realpath(src)),
        "NATIVE_BUSINESS_LINK_ESCAPE",
      );
      await fs.symlink(link, dest);
      manifest.push({ path: rel, link });
    } else if (st.isDirectory()) {
      await fs.mkdir(dest, { mode: st.mode & 0o777 });
      for (const name of (await fs.readdir(src)).sort())
        await copy(join(rel, name));
      await fs.chmod(dest, st.mode & 0o777);
      manifest.push({ path: rel, directory: true, mode: st.mode & 0o777 });
    } else {
      invariant(st.isFile(), "NATIVE_SPECIAL_BUSINESS_FILE");
      if (
        rel.endsWith("/.git") ||
        (rel.includes("/.git/") &&
          ["config", "alternates"].includes(rel.split("/").at(-1)))
      )
        gitMetadata(src, await fs.readFile(src), sourceRoot);
      await fs.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
      await fs.chmod(dest, st.mode & 0o777);
      const [before, after] = await Promise.all([
        fileDigest(src),
        fileDigest(dest),
      ]);
      invariant(
        canonical(before) === canonical(after),
        "NATIVE_BUSINESS_COPY_CHANGED",
      );
      manifest.push({ path: rel, mode: st.mode & 0o777, ...after });
    }
  }
  for (const name of (await fs.readdir(sourceRoot)).sort()) {
    if (EXCLUDED.has(name)) {
      excluded.push(name);
      continue;
    }
    if (name === "platform.db") continue;
    invariant(COPIED.has(name), "UNKNOWN_NATIVE_DATA_ENTRY");
    await copy(name);
  }
  invariant(
    manifest.some((r) => r.path === ".master.key"),
    "NATIVE_MASTER_KEY_REQUIRED",
  );
  return { manifest, excluded };
}
/** Verify the imported business payload before any role can write it. Runtime
 * caches are forbidden, not treated as mutable business payload exclusions. */
export async function verifyNativeImportedTree(root, receipt) {
  const manifest = [];
  async function visit(rel) {
    const path = join(root, rel),
      st = await fs.lstat(path);
    if (st.isSymbolicLink()) {
      const link = await fs.readlink(path);
      invariant(
        !isAbsolute(link) &&
          inside(root, resolve(dirname(path), link)) &&
          inside(root, await fs.realpath(path)),
        "NATIVE_BUSINESS_LINK_ESCAPE",
      );
      manifest.push({ path: rel, link });
    } else if (st.isDirectory()) {
      for (const name of (await fs.readdir(path)).sort())
        await visit(join(rel, name));
      manifest.push({ path: rel, directory: true, mode: st.mode & 0o777 });
    } else {
      invariant(st.isFile(), "NATIVE_SPECIAL_BUSINESS_FILE");
      manifest.push({
        path: rel,
        mode: st.mode & 0o777,
        ...(await fileDigest(path)),
      });
    }
  }
  for (const name of (await fs.readdir(root)).sort()) {
    if (["platform.db", "platform.db-wal", "platform.db-shm"].includes(name))
      continue;
    invariant(COPIED.has(name), "NATIVE_IMPORTED_RUNTIME_PRESENT");
    await visit(name);
  }
  invariant(
    digest(manifest) === receipt.copiedBusinessTreeDigest &&
      manifest.length === receipt.copiedBusinessFiles,
    "NATIVE_IMPORTED_BUSINESS_CHANGED",
  );
  return { digest: digest(manifest), entries: manifest.length };
}

/** sourceRoot must be a private, immutable stopped export. destinationRoot must
 * not exist. On failure the partial destination is retained for investigation. */
export async function importNativeSource(c) {
  const {
    sourceRoot,
    destinationRoot,
    sourceDataRoot,
    targetDataRoot,
    original,
    stopReceipt,
  } = c;
  assertNativeStopReceipt(original, stopReceipt);
  invariant(
    [
      sourceRoot,
      destinationRoot,
      sourceDataRoot,
      targetDataRoot,
      c.sqliteModulePath,
      c.receiptPath,
      c.backupPath,
    ].every(absolute) &&
      original.dataRoot === sourceDataRoot &&
      !inside(sourceRoot, destinationRoot) &&
      !inside(destinationRoot, sourceRoot) &&
      !inside(sourceRoot, c.receiptPath) &&
      !inside(destinationRoot, c.receiptPath),
    "DISTINCT_NATIVE_IMPORT_PATHS_REQUIRED",
  );
  invariant(
    typeof c.instanceId === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(c.instanceId) &&
      absolute(c.businessHostPath) &&
      Object.values(c.commits || {}).length === 3 &&
      ["project", "api", "web"].every((k) =>
        /^[a-f0-9]{40}$/.test(c.commits[k]),
      ),
    "PINNED_NATIVE_IMPORT_REQUIRED",
  );
  const sourceStat = await fs.lstat(sourceRoot);
  invariant(
    sourceStat.isDirectory() &&
      !sourceStat.isSymbolicLink() &&
      (sourceStat.mode & 0o077) === 0 &&
      (await fs.realpath(sourceRoot)) === sourceRoot,
    "NATIVE_SOURCE_ROOT_CHANGED",
  );
  for (const name of ["platform.db", ".master.key"]) {
    const st = await fs.lstat(join(sourceRoot, name));
    invariant(
      st.isFile() && !st.isSymbolicLink() && (st.mode & 0o077) === 0,
      "PRIVATE_NATIVE_SOURCE_REQUIRED",
    );
  }
  invariant(
    c.backupPath === sourceRoot,
    "FROZEN_NATIVE_EXPORT_BACKUP_REQUIRED",
  );
  const sealedDatabase = await fileDigest(join(sourceRoot, "platform.db"));
  invariant(
    sealedDatabase.digest === stopReceipt.frozenDatabaseDigest &&
      (await fileDigest(join(sourceRoot, ".master.key"))).digest ===
        stopReceipt.masterKeyDigest,
    "NATIVE_FROZEN_EXPORT_MISMATCH",
  );
  const wal = await fs.lstat(join(sourceRoot, "platform.db-wal")).catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  invariant(
    wal === null || (wal.isFile() && !wal.isSymbolicLink() && wal.size === 0),
    "NATIVE_EXPORT_NOT_SEALED",
  );
  invariant(
    (await fs.readFile(join(sourceRoot, ".master.key"))).length === 32,
    "NATIVE_MASTER_KEY_LENGTH_INVALID",
  );
  for (const privateName of [".upgrade-session-secret"]) {
    const st = await fs.lstat(join(sourceRoot, privateName)).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (st)
      invariant(
        st.isFile() &&
          !st.isSymbolicLink() &&
          (st.mode & 0o077) === 0 &&
          st.size >= 32,
        "PRIVATE_NATIVE_SOURCE_REQUIRED",
      );
  }
  const priorReceipt = await fs.lstat(c.receiptPath).catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  invariant(priorReceipt === null, "NATIVE_IMPORT_RECEIPT_EXISTS");
  await fs.mkdir(destinationRoot, { mode: 0o700 });
  await secureDirectory(destinationRoot);
  const D = createRequire(c.sqliteModulePath)("better-sqlite3"),
    source = new D(join(sourceRoot, "platform.db"), {
      readonly: true,
      fileMustExist: true,
    });
  let before, copied;
  try {
    source.exec("PRAGMA query_only=ON");
    assertNativeDatabaseIdle(source);
    before = source
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => ({
        name,
        ...rowDigest(
          source,
          name,
          PATH_COLUMNS.filter(([t]) => t === name).map(([, col]) => col),
        ),
      }));
    copied = await copyBusiness(sourceRoot, destinationRoot);
    await source.backup(join(destinationRoot, "platform.db"));
  } finally {
    source.close();
  }
  invariant(
    (await fileDigest(join(sourceRoot, "platform.db"))).digest ===
      sealedDatabase.digest,
    "NATIVE_FROZEN_EXPORT_CHANGED",
  );
  await fs.chmod(join(destinationRoot, "platform.db"), 0o600);
  const db = new D(join(destinationRoot, "platform.db"), {
    fileMustExist: true,
  });
  const rewrites = [];
  try {
    assertNativeDatabaseIdle(db);
    db.transaction(() => {
      for (const [table, column, folder] of PATH_COLUMNS) {
        const rows = db
          .prepare(
            `SELECT rowid _rowid, ${q(column)} value FROM ${q(table)} WHERE ${q(column)} IS NOT NULL`,
          )
          .all();
        const update = db.prepare(
          `UPDATE ${q(table)} SET ${q(column)}=? WHERE rowid=?`,
        );
        for (const row of rows)
          update.run(
            remapNativePath(row.value, sourceDataRoot, targetDataRoot, folder),
            row._rowid,
          );
        rewrites.push({ table, column, count: rows.length });
      }
    })();
    for (const row of before)
      invariant(
        canonical(
          rowDigest(
            db,
            row.name,
            PATH_COLUMNS.filter(([t]) => t === row.name).map(([, col]) => col),
          ),
        ) === canonical({ count: row.count, digest: row.digest }),
        "NATIVE_BUSINESS_ROWS_CHANGED",
      );
    for (const row of db.prepare("SELECT baseline_path FROM projects").all()) {
      const path = join(
        destinationRoot,
        relative(targetDataRoot, row.baseline_path),
      );
      invariant(
        (await fs.realpath(path)) === path &&
          (await fs.stat(path)).isDirectory(),
        "NATIVE_PROJECT_BASELINE_MISSING",
      );
    }
    assertNativeDatabaseIdle(db);
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  const database = await fileDigest(join(destinationRoot, "platform.db")),
    master = await fileDigest(join(destinationRoot, ".master.key"));
  invariant(
    master.digest ===
      (await fileDigest(join(sourceRoot, ".master.key"))).digest,
    "NATIVE_MASTER_KEY_CHANGED",
  );
  const result = {
    schemaVersion: 1,
    kind: "darwin-native-bootstrap-clone",
    instanceId: c.instanceId,
    businessHostPath: c.businessHostPath,
    original,
    sourceStop: stopReceipt,
    originalDataPreserved: true,
    originalInstallationPreserved: true,
    databaseBackupVerified: true,
    businessExportVerified: true,
    backupPath: c.backupPath,
    before: stopReceipt.before,
    beforeStop: stopReceipt.beforeStop,
    admissionHeld: true,
    oldProcessAbsent: true,
    retainedDestroyedSandboxes: 0,
    extantUserRuntimeHandles: 0,
    activeAgentTasks: 0,
    databaseMigration: {
      from: 28,
      to: 28,
      integrity: "ok",
      foreignKeyViolations: 0,
    },
    businessRowsPreserved: true,
    masterKeyPreserved: true,
    cloneDatabaseDigest: database.digest,
    masterKeyDigest: master.digest,
    sourceExportDatabaseDigest: sealedDatabase.digest,
    commits: c.commits,
    pathConversion: {
      sourceDataRoot,
      targetDataRoot,
      rewrites,
      otherColumns: before,
    },
    copiedBusinessTreeDigest: digest(copied.manifest),
    copiedBusinessFiles: copied.manifest.length,
    excluded: copied.excluded,
    darwinSdkImported: false,
    importedAt: new Date().toISOString(),
  };
  const count = new D(join(destinationRoot, "platform.db"), { readonly: true });
  try {
    result.retainedDestroyedSandboxes = count
      .prepare("SELECT count(*) n FROM sandboxes WHERE status='destroyed'")
      .get().n;
  } finally {
    count.close();
  }
  await verifyNativeImportedTree(destinationRoot, result);
  await atomicJson(c.receiptPath, result);
  return result;
}
