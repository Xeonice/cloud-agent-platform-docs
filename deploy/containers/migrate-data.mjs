import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve, relative, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { DatabaseSync, backup } from "node:sqlite";
import { spawn } from "node:child_process";

export const NATIVE_DATA = "/Users/douglasdong/agent-platform/production";
export const NATIVE_ENV =
  "/Users/douglasdong/.local/share/agent-platform-deploy/runtime.env";
export const STAGING_ROOT =
  "/Users/douglasdong/.local/share/agent-platform-deploy/container-migration";
export const RUNTIME_HOST =
  "unix:///Users/douglasdong/.colima/agent-platform-runtime/docker.sock";
export const DATA_VOLUME = "agent-platform-production-data";
export const PATH_COLUMNS = [
  ["projects", "baseline_path"],
  ["sandboxes", "workspace_path"],
  ["retained_volumes", "workspace_path"],
  ["agent_tasks", "log_path"],
  ["automation_runs", "log_path"],
  ["sandbox_project_cleanup_jobs", "workspace_path"],
];
const DOCKER = "/Users/douglasdong/.orbstack/bin/docker";
const DOCKER_CONFIG =
  "/Users/douglasdong/.local/share/agent-platform-jenkins-tools/container-docker-context";
const SHA = /^sha256:[a-f0-9]{64}$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const EMPTY_DATA_GUARD =
  'for entry in "$data_root"/* "$data_root"/.[!.]* "$data_root"/..?*; do if [ -e "$entry" ] || [ -L "$entry" ]; then exit 41; fi; done';

function requireCondition(ok, reason) {
  if (!ok) throw new Error(reason);
}
function sqlIdentifier(value) {
  requireCondition(
    /^[A-Za-z_][A-Za-z_0-9]*$/.test(value),
    "Unsafe SQL identifier",
  );
  return '"' + value + '"';
}
async function directory(path, uid, privateMode = false) {
  const stat = await fs.lstat(path);
  requireCondition(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === uid &&
      (stat.mode & (privateMode ? 0o077 : 0o022)) === 0,
    "Data directory ownership or type differs",
  );
  return stat;
}
async function readFile(path, uid, secret = false) {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    requireCondition(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.uid === uid &&
        (!secret || (stat.mode & 0o077) === 0),
      "Source file ownership, links or private permissions differ",
    );
    const bytes = await handle.readFile();
    const after = await handle.stat();
    requireCondition(
      stat.size === after.size &&
        stat.mtimeMs === after.mtimeMs &&
        stat.ctimeMs === after.ctimeMs,
      "Source file changed while being copied",
    );
    return { bytes, mode: stat.mode & 0o777, sizeBytes: bytes.length };
  } finally {
    await handle.close();
  }
}
async function writeFresh(path, bytes, mode = 0o600) {
  await fs.writeFile(path, bytes, { flag: "wx", mode });
  await fs.chmod(path, mode);
}
function tables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => row.name);
}
export function rowCounts(db) {
  return Object.fromEntries(
    tables(db).map((table) => [
      table,
      db.prepare(`SELECT COUNT(*) AS count FROM ${sqlIdentifier(table)}`).get()
        .count,
    ]),
  );
}
function columns(db, table) {
  return db
    .prepare(`PRAGMA table_info(${sqlIdentifier(table)})`)
    .all()
    .map((row) => row.name);
}
export function remapDataPath(value, sourceRoot, targetRoot = "/data") {
  if (value === null || value === undefined || value === "") return value;
  requireCondition(
    typeof value === "string" && value.startsWith(sourceRoot + "/"),
    "Stored data path is outside the approved source root",
  );
  const suffix = relative(sourceRoot, value);
  requireCondition(
    suffix && !suffix.startsWith("..") && resolve(sourceRoot, suffix) === value,
    "Stored data path is not canonical",
  );
  return posix.join(targetRoot, ...suffix.split("/"));
}
export function remapDatabase(db, sourceRoot, targetRoot = "/data") {
  const existing = new Set(tables(db));
  const changes = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [table, column] of PATH_COLUMNS) {
      if (!existing.has(table) || !columns(db, table).includes(column))
        continue;
      const selected = db
        .prepare(
          `SELECT rowid AS migration_rowid, ${sqlIdentifier(column)} AS value FROM ${sqlIdentifier(table)}`,
        )
        .all();
      const update = db.prepare(
        `UPDATE ${sqlIdentifier(table)} SET ${sqlIdentifier(column)}=? WHERE rowid=?`,
      );
      let changed = 0;
      for (const row of selected) {
        const next = remapDataPath(row.value, sourceRoot, targetRoot);
        if (next !== row.value) {
          update.run(next, row.migration_rowid);
          changed++;
        }
      }
      changes.push({ table, column, changed });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return changes;
}
function encryptedDataExists(db) {
  const existing = new Set(tables(db));
  if (
    existing.has("credentials") &&
    columns(db, "credentials").includes("encrypted_blob") &&
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM credentials WHERE encrypted_blob IS NOT NULL",
      )
      .get().count
  )
    return true;
  if (
    existing.has("image_manifests") &&
    columns(db, "image_manifests").includes("image_config")
  ) {
    const hasSecret = (value) =>
      value &&
      typeof value === "object" &&
      (value.secret === true || Object.values(value).some(hasSecret));
    for (const row of db
      .prepare(
        "SELECT image_config FROM image_manifests WHERE image_config IS NOT NULL",
      )
      .all()) {
      if (hasSecret(JSON.parse(row.image_config))) return true;
    }
  }
  return false;
}
export function containerEnvironment(source, sourceRoot) {
  const parsed = parseEnv(source);
  for (const [key, value] of Object.entries({
    DATA_ROOT: sourceRoot,
    DATABASE_URL: join(sourceRoot, "platform.db"),
    BOXLITE_HOME: join(sourceRoot, "boxlite"),
  })) {
    requireCondition(
      parsed[key] === value,
      "Native runtime data configuration differs",
    );
  }
  const mapped = {
    DATA_ROOT: "/data",
    DATABASE_URL: "/data/platform.db",
    BOXLITE_HOME: "/data/boxlite",
    DEPLOYMENT_DRAIN_FILE: "/data/deployment-drain",
  };
  const removed = new Set([
    ...Object.keys(mapped),
    "SCHEDULER_HOST_CORES",
    "SCHEDULER_HOST_RAM_MB",
    "SCHEDULER_HOST_DISK_MB",
  ]);
  const kept = [];
  let quoted = null,
    omitContinuation = false;
  for (const line of source.split(/\r?\n/)) {
    if (quoted !== null) {
      if (!omitContinuation) kept.push(line);
      if (line.includes(quoted)) {
        quoted = null;
        omitContinuation = false;
      }
      continue;
    }
    const assignment =
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)$/.exec(line);
    const omit = assignment && removed.has(assignment[1]);
    if (
      assignment &&
      ['"', "'", "`"].includes(assignment[2][0]) &&
      assignment[2].indexOf(assignment[2][0], 1) === -1
    ) {
      quoted = assignment[2][0];
      omitContinuation = Boolean(omit);
    }
    if (!omit) kept.push(line);
  }
  const result =
    kept.join("\n").replace(/\n*$/, "\n") +
    Object.entries(mapped)
      .map(([key, value]) => `${key}=${value}\n`)
      .join("");
  const output = parseEnv(result);
  for (const [key, value] of Object.entries(parsed))
    if (!removed.has(key))
      requireCondition(
        output[key] === value,
        "Unmapped runtime configuration changed during migration",
      );
  return result;
}
async function copyTree(source, destination, uid) {
  await directory(source, uid);
  await fs.mkdir(destination, { mode: 0o700 });
  for (const entry of (await fs.readdir(source)).sort()) {
    const from = join(source, entry),
      to = join(destination, entry);
    const stat = await fs.lstat(from);
    requireCondition(
      !stat.isSymbolicLink(),
      "Data tree contains a symbolic link",
    );
    if (stat.isDirectory()) await copyTree(from, to, uid);
    else {
      const file = await readFile(from, uid);
      await writeFresh(to, file.bytes, file.mode & 0o111 ? 0o700 : 0o600);
    }
  }
}
async function inventory(root, uid, prefix = "") {
  await directory(root, uid);
  const entries = [
    {
      path: prefix || ".",
      type: "directory",
      mode: (await fs.stat(root)).mode & 0o777,
    },
  ];
  for (const name of (await fs.readdir(root)).sort()) {
    const path = join(root, name),
      rel = prefix ? prefix + "/" + name : name;
    const stat = await fs.lstat(path);
    requireCondition(
      !stat.isSymbolicLink(),
      "Migration staging contains a symbolic link",
    );
    if (stat.isDirectory()) entries.push(...(await inventory(path, uid, rel)));
    else {
      const file = await readFile(path, uid);
      entries.push({
        path: rel,
        type: "file",
        mode: file.mode,
        sizeBytes: file.sizeBytes,
        sha256: hash(file.bytes),
      });
    }
  }
  return entries;
}

// Core factory accepts fixture roots for real WAL/backup tests. CLI pins all native paths.
export async function prepareData({
  sourceRoot,
  runtimeEnv,
  stagingRoot,
  uid = process.getuid(),
}) {
  await directory(sourceRoot, uid, true);
  await directory(stagingRoot, uid, true);
  const stage = join(stagingRoot, randomUUID());
  await fs.mkdir(stage, { mode: 0o700 });
  const data = join(stage, "data");
  await fs.mkdir(data, { mode: 0o700 });
  const env = await readFile(runtimeEnv, uid, true);
  const derivedEnv = containerEnvironment(
    env.bytes.toString("utf8"),
    sourceRoot,
  );
  await writeFresh(join(stage, "source.runtime.env"), env.bytes);
  await writeFresh(join(stage, "runtime.env"), derivedEnv);
  const sourcePath = join(sourceRoot, "platform.db");
  const sourceMeta = await fs.lstat(sourcePath);
  requireCondition(
    sourceMeta.isFile() &&
      !sourceMeta.isSymbolicLink() &&
      sourceMeta.nlink === 1 &&
      sourceMeta.uid === uid &&
      (sourceMeta.mode & 0o077) === 0,
    "Native database identity differs",
  );
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  source.exec("PRAGMA query_only=ON");
  let sourceBefore, sourceAfter;
  try {
    sourceBefore = rowCounts(source);
    await backup(source, join(data, "platform.db"));
    sourceAfter = rowCounts(source);
  } finally {
    source.close();
  }
  await fs.chmod(join(data, "platform.db"), 0o600);
  const target = new DatabaseSync(join(data, "platform.db"));
  let before, after, mapped, keyMode;
  try {
    before = rowCounts(target);
    mapped = remapDatabase(target, sourceRoot);
    const key = await readFile(
      join(sourceRoot, ".master.key"),
      uid,
      true,
    ).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const envKey = parseEnv(
      env.bytes.toString("utf8"),
    ).PLATFORM_MASTER_KEY?.trim();
    if (envKey)
      requireCondition(
        Buffer.from(envKey, "base64").length === 32,
        "Runtime master key format differs",
      );
    if (key) {
      requireCondition(
        key.bytes.length === 32,
        "File master key format differs",
      );
      await writeFresh(join(data, ".master.key"), key.bytes);
    }
    requireCondition(
      key || envKey || !encryptedDataExists(target),
      "Encrypted records exist without their master key",
    );
    keyMode = envKey
      ? "environment-preserved"
      : key
        ? "file-preserved"
        : "not-created-no-encrypted-records";
    after = rowCounts(target);
    requireCondition(
      JSON.stringify(before) === JSON.stringify(after),
      "Path migration changed row counts",
    );
    requireCondition(
      target.prepare("PRAGMA integrity_check").get().integrity_check === "ok",
      "Backup integrity check failed",
    );
    target.exec("PRAGMA journal_mode=DELETE");
  } finally {
    target.close();
  }
  for (const tree of ["baselines", "workspaces"]) {
    const exists = await fs.lstat(join(sourceRoot, tree)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (exists) await copyTree(join(sourceRoot, tree), join(data, tree), uid);
  }
  const logs = new DatabaseSync(join(data, "platform.db"), { readOnly: true });
  try {
    if (
      tables(logs).includes("projects") &&
      columns(logs, "projects").includes("baseline_path")
    ) {
      for (const row of logs
        .prepare(
          "SELECT baseline_path FROM projects WHERE baseline_path IS NOT NULL",
        )
        .all()) {
        if (!row.baseline_path) continue;
        requireCondition(
          row.baseline_path.startsWith("/data/baselines/"),
          "Project baseline is outside the fixed baseline directory",
        );
        await directory(
          join(data, row.baseline_path.slice("/data/".length)),
          uid,
        );
      }
    }
    for (const [table, column] of PATH_COLUMNS.filter(
      ([, column]) => column === "log_path",
    )) {
      if (
        !tables(logs).includes(table) ||
        !columns(logs, table).includes(column)
      )
        continue;
      for (const row of logs
        .prepare(
          `SELECT DISTINCT ${sqlIdentifier(column)} AS value FROM ${sqlIdentifier(table)} WHERE ${sqlIdentifier(column)} IS NOT NULL`,
        )
        .all()) {
        if (!row.value) continue;
        requireCondition(
          row.value.startsWith("/data/logs/"),
          "Recorded task log is outside the fixed logs directory",
        );
        const suffix = row.value.slice("/data/".length);
        const destination = join(data, suffix);
        let ancestor = sourceRoot;
        for (const component of suffix.split("/").slice(0, -1)) {
          ancestor = join(ancestor, component);
          await directory(ancestor, uid);
        }
        await fs.mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        const file = await readFile(join(sourceRoot, suffix), uid);
        if (
          !(await fs.lstat(destination).catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          }))
        )
          await writeFresh(destination, file.bytes);
      }
    }
  } finally {
    logs.close();
  }
  const manifest = {
    version: 1,
    kind: "native-platform-data-migration",
    state: "staged-not-imported",
    createdAt: new Date().toISOString(),
    sourceRoot,
    targetRoot: "/data",
    targetUid: 0,
    backupMethod:
      "Node22 SQLite online backup API; source readOnly/query_only; includes committed WAL",
    sourceCountsBefore: sourceBefore,
    sourceCountsAfter: sourceAfter,
    backupCounts: before,
    migratedCounts: after,
    pathChanges: mapped,
    masterKey: keyMode,
    boxliteHomeCopied: false,
    boxliteRestore: "separate SDK export/import required; auth helper rebuilt",
    sourceRuntimeEnvSha256: hash(env.bytes),
    runtimeEnvSha256: hash(Buffer.from(derivedEnv)),
    runtimeEnvironment: {
      schemaVersion: 2,
      drainFile: "/data/deployment-drain",
      nativeCapacityOverrides: "removed; Linux probes cgroup and statfs",
      unmappedValues:
        "preserved including authentication and explicit overcommit",
    },
    entries: await inventory(data, uid),
    productionStopped: false,
  };
  await writeFresh(
    join(stage, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return {
    stage,
    manifestSha256: hash(await fs.readFile(join(stage, "manifest.json"))),
    manifest,
  };
}

export async function verifyDataStage(
  stage,
  expectedHash,
  uid = process.getuid(),
) {
  await directory(stage, uid, true);
  const file = await readFile(join(stage, "manifest.json"), uid, true);
  requireCondition(
    hash(file.bytes) === expectedHash,
    "Migration manifest digest differs",
  );
  const manifest = JSON.parse(file.bytes);
  requireCondition(
    manifest.version === 1 &&
      manifest.kind === "native-platform-data-migration" &&
      manifest.state === "staged-not-imported" &&
      manifest.targetRoot === "/data" &&
      manifest.targetUid === 0,
    "Migration manifest contract differs",
  );
  requireCondition(
    JSON.stringify(await inventory(join(stage, "data"), uid)) ===
      JSON.stringify(manifest.entries),
    "Migration staging files, modes or digests differ",
  );
  for (const [name, digest] of [
    ["source.runtime.env", manifest.sourceRuntimeEnvSha256],
    ["runtime.env", manifest.runtimeEnvSha256],
  ]) {
    const env = await readFile(join(stage, name), uid, true);
    requireCondition(
      hash(env.bytes) === digest,
      "Private runtime environment digest differs",
    );
  }
  return manifest;
}

export function importArguments(image, volume = DATA_VOLUME) {
  requireCondition(SHA.test(image), "Use an immutable Docker image ID");
  requireCondition(
    volume === DATA_VOLUME || /^migration-test-[a-z0-9-]{8,80}$/.test(volume),
    "Unexpected migration data volume",
  );
  return [
    "--config",
    DOCKER_CONFIG,
    "--host",
    RUNTIME_HOST,
    "run",
    "--rm",
    "-i",
    "--network",
    "none",
    "--user",
    "0:0",
    "--mount",
    `type=volume,src=${volume},dst=/data`,
    "--entrypoint",
    "/bin/sh",
    image,
    "-ec",
    `data_root=/data; ${EMPTY_DATA_GUARD}; umask 077; tar -xf - --no-same-owner -C /data; chmod 700 /data; printf "data-imported\\n"`,
  ];
}
export function validateDataVolume(value, name) {
  importArguments("sha256:" + "0".repeat(64), name);
  requireCondition(
    value?.Name === name &&
      value.Driver === "local" &&
      value.Scope === "local" &&
      value.Mountpoint === `/var/lib/docker/volumes/${name}/_data` &&
      (!value.Options || Object.keys(value.Options).length === 0),
    "Migration volume is host-backed or outside the fixed daemon layout",
  );
  return value;
}
export function pipeArchive(producer, consumer) {
  producer.stdout.pipe(consumer.stdin);
  const drain = () => {
    producer.stdout.unpipe(consumer.stdin);
    producer.stdout.resume();
  };
  consumer.stdin.on("error", drain);
  consumer.once("close", drain);
}
export async function importDataStage(
  stage,
  manifestHash,
  image,
  volume = DATA_VOLUME,
) {
  const manifest = await verifyDataStage(stage, manifestHash);
  const args = importArguments(image, volume);
  const inspect = spawn(
    DOCKER,
    [
      "--config",
      DOCKER_CONFIG,
      "--host",
      RUNTIME_HOST,
      "volume",
      "inspect",
      volume,
    ],
    {
      env: { PATH: "/usr/bin:/bin", HOME: "/Users/douglasdong" },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  let metadata = "";
  inspect.stdout.on("data", (chunk) => {
    metadata += chunk;
  });
  const inspected = await new Promise((resolve, reject) => {
    inspect.once("error", reject);
    inspect.once("close", (code, signal) => resolve({ code, signal }));
  });
  requireCondition(
    inspected.code === 0 && !inspected.signal,
    "Create a fresh named migration volume before import",
  );
  const values = JSON.parse(metadata);
  requireCondition(
    values.length === 1,
    "Unexpected migration volume inspect result",
  );
  validateDataVolume(values[0], volume);
  const tar = spawn(
    "/usr/bin/tar",
    ["-cf", "-", "-C", join(stage, "data"), "."],
    {
      env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const docker = spawn(DOCKER, args, {
    env: { PATH: "/usr/bin:/bin", HOME: "/Users/douglasdong" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  pipeArchive(tar, docker);
  const result = async (child, capture = false) => {
    let stdout = "";
    if (capture)
      child.stdout?.on("data", (chunk) => {
        stdout = (stdout + chunk).slice(-4096);
      });
    child.stderr?.resume();
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stdout }));
    });
  };
  const [a, b] = await Promise.all([result(tar), result(docker, true)]);
  requireCondition(
    a.code === 0 &&
      !a.signal &&
      b.code === 0 &&
      !b.signal &&
      b.stdout.trim() === "data-imported",
    "Named volume data import failed; preserve partial volume for inspection",
  );
  return {
    state: "imported-not-started",
    volume,
    image,
    manifestSha256: manifestHash,
    rowCounts: manifest.migratedCounts,
    runtimeEnvTransferred: false,
    productionTouched: false,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  requireCondition(
    process.versions.node.split(".")[0] === "22" &&
      process.platform === "darwin" &&
      process.arch === "arm64" &&
      process.getuid() === 501,
    "Use the fixed Node22 Darwin ARM64 owner",
  );
  const [action, stage, digest, image, volume] = process.argv.slice(2);
  let output;
  if (action === "prepare") {
    await fs.mkdir(STAGING_ROOT, { recursive: true, mode: 0o700 });
    const result = await prepareData({
      sourceRoot: NATIVE_DATA,
      runtimeEnv: NATIVE_ENV,
      stagingRoot: STAGING_ROOT,
    });
    output = {
      state: result.manifest.state,
      stage: result.stage,
      manifestSha256: result.manifestSha256,
      rowCounts: result.manifest.migratedCounts,
      pathChanges: result.manifest.pathChanges,
      runtimeEnvironmentPreservedPrivately: true,
      masterKey: result.manifest.masterKey,
      boxliteHomeCopied: false,
      productionStopped: false,
    };
  } else {
    requireCondition(
      stage &&
        dirname(resolve(stage)) === STAGING_ROOT &&
        /^[a-f0-9-]{36}$/.test(relative(STAGING_ROOT, resolve(stage))),
      "Use a fixed private migration staging directory",
    );
    if (action === "verify") output = await verifyDataStage(stage, digest);
    else if (action === "import")
      output = await importDataStage(stage, digest, image, volume);
    else
      throw new Error(
        "Use prepare | verify <stage> <manifest SHA256> | import <stage> <manifest SHA256> <immutable image ID> [volume]",
      );
  }
  console.log(JSON.stringify(output));
}
