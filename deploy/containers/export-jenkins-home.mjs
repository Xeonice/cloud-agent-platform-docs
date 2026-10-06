import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";

export const SOURCE_HOME = "/Users/Shared/agent-platform-jenkins";
export const MIGRATION_ROOT =
  "/Users/douglasdong/.local/share/agent-platform-jenkins-tools/migration";
export const SOURCE_UID = 400;
export const TARGET_UID = 501;
export const TARGET_GID = 20;
export const ARCHIVE_NAME = "jenkins-home.tar";
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SERVICE_LABEL = "com.douglasdong.agent-platform.jenkins";

function identity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o777,
  };
}

export function validateSourceIdentity(value) {
  if (
    !value ||
    value.uid !== SOURCE_UID ||
    value.gid !== TARGET_GID ||
    value.mode !== 0o700 ||
    !Number.isSafeInteger(value.dev) ||
    !Number.isSafeInteger(value.ino) ||
    value.dev < 0 ||
    value.ino <= 0
  ) {
    throw new Error(
      "Jenkins Home must retain its dedicated UID 400 identity and mode 0700",
    );
  }
  return value;
}

export function createExportPlan(sourceIdentity, id = randomUUID()) {
  validateSourceIdentity(sourceIdentity);
  if (!ID.test(id)) throw new Error("Invalid migration identifier");
  return {
    schemaVersion: 1,
    kind: "jenkins-home-export",
    source: { fixedHome: SOURCE_HOME, ...sourceIdentity },
    destination: join(MIGRATION_ROOT, id),
    archiveBasename: ARCHIVE_NAME,
    destinationUid: TARGET_UID,
    destinationGid: TARGET_GID,
    requiresStoppedJenkins: true,
  };
}

export function validateExportPlan(value, planPath, currentIdentity) {
  const id = value?.destination?.slice(MIGRATION_ROOT.length + 1);
  if (!ID.test(id ?? ""))
    throw new Error(
      "Export plan paths or source identity changed; prepare a new plan",
    );
  const expected = createExportPlan(currentIdentity, id);
  if (
    planPath !== join(expected.destination, "plan.json") ||
    JSON.stringify(value) !== JSON.stringify(expected)
  ) {
    throw new Error(
      "Export plan paths or source identity changed; prepare a new plan",
    );
  }
  return expected;
}

export function exportPlanDirectory(planPath) {
  if (
    typeof planPath !== "string" ||
    !planPath.startsWith(`${MIGRATION_ROOT}/`)
  ) {
    throw new Error("Only a prepared fixed migration plan is accepted");
  }
  const parts = planPath.slice(MIGRATION_ROOT.length + 1).split("/");
  if (parts.length !== 2 || !ID.test(parts[0]) || parts[1] !== "plan.json") {
    throw new Error("Only a prepared fixed migration plan is accepted");
  }
  return join(MIGRATION_ROOT, parts[0]);
}

export function validateRelativeEntry(path) {
  if (
    typeof path !== "string" ||
    path === "" ||
    path.includes("\0") ||
    path.includes("\\") ||
    posix.isAbsolute(path) ||
    path.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new Error("Unsafe Jenkins archive entry path");
  }
  return path;
}

export function validateInternalLink(path, target) {
  validateRelativeEntry(path);
  if (
    typeof target !== "string" ||
    target === "" ||
    target.includes("\0") ||
    target.includes("\\") ||
    posix.isAbsolute(target)
  ) {
    throw new Error(
      "Jenkins Home contains an external or unsafe symbolic link",
    );
  }
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  if (resolved === ".." || resolved.startsWith("../")) {
    throw new Error(
      "Jenkins Home contains an external or unsafe symbolic link",
    );
  }
  return target;
}

/** Only metadata is inspected. Symbolic links are recorded, never traversed. */
export async function snapshotEntries(source, ownerUid) {
  const entries = [];
  async function visit(path) {
    validateRelativeEntry(path);
    const absolute = path === "." ? source : join(source, path);
    const stat = await fs.lstat(absolute);
    if (
      stat.uid !== ownerUid ||
      (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0)
    ) {
      throw new Error(
        "Jenkins Home entry ownership or writable permissions are unsafe",
      );
    }
    const common = {
      path,
      ...identity(stat),
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
    if (stat.isSymbolicLink()) {
      // Link mode 0777 does not grant write access to its destination. Its private
      // parent and link ownership are checked separately.
      entries.push({
        ...common,
        type: "symlink",
        linkTarget: validateInternalLink(path, await fs.readlink(absolute)),
      });
    } else if (stat.isDirectory()) {
      entries.push({ ...common, type: "directory" });
      const children = (await fs.readdir(absolute)).sort();
      for (const child of children)
        await visit(path === "." ? child : `${path}/${child}`);
    } else if (stat.isFile() && stat.nlink === 1) {
      entries.push({ ...common, type: "file" });
    } else {
      throw new Error(
        "Jenkins Home contains a hard link or unsupported special file",
      );
    }
  }
  await visit(".");
  return entries;
}

async function privateDirectory(path, ownerUid) {
  const stat = await fs.lstat(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== ownerUid ||
    (stat.mode & 0o777) !== 0o700
  ) {
    throw new Error("Migration directory must be a real owner-only directory");
  }
  return identity(stat);
}

async function privateFile(path, ownerUid) {
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== ownerUid ||
      (stat.mode & 0o777) !== 0o600
    ) {
      throw new Error("Migration plan must be a real owner-only file");
    }
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

export function assertJenkinsStopped(run = spawnSync) {
  for (const domain of ["system", "gui/501"]) {
    const result = run(
      "/bin/launchctl",
      ["print", `${domain}/${SERVICE_LABEL}`],
      {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    if (result.error || result.signal || !Number.isInteger(result.status)) {
      throw new Error(
        "Cannot establish whether the Jenkins service is stopped",
      );
    }
    if (result.status === 0)
      throw new Error("Stop Jenkins before exporting its Home");
    // launchctl's known absent-service code. Other failures are not evidence of idle.
    if (result.status !== 113)
      throw new Error(
        "Cannot establish whether the Jenkins service is stopped",
      );
  }
  const processes = run("/bin/ps", ["-axo", "uid=,pid="], {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
    encoding: "utf8",
    timeout: 10_000,
  });
  if (processes.error || processes.signal || processes.status !== 0) {
    throw new Error(
      "Cannot establish whether the dedicated Jenkins account is idle",
    );
  }
  for (const line of processes.stdout.trim().split("\n")) {
    const match = /^\s*(-?\d+)\s+(\d+)\s*$/.exec(line);
    if (
      !match ||
      !Number.isSafeInteger(Number(match[1])) ||
      !Number.isSafeInteger(Number(match[2])) ||
      Number(match[2]) <= 0
    )
      throw new Error(
        "Cannot establish whether the dedicated Jenkins account is idle",
      );
    if (Number(match[1]) === SOURCE_UID)
      throw new Error("Stop all dedicated Jenkins processes before export");
  }
}

async function standardTar(source, fd) {
  await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/tar", ["-cf", "-", "-C", source, "."], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", LANG: "C", COPYFILE_DISABLE: "1" },
      // No -h/--dereference. Tar writes to the already-open private archive.
      stdio: ["ignore", fd, "ignore"],
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 30 * 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Standard Jenkins archive export failed (${signal ?? code})`,
          ),
        );
    });
  });
}

/** Generic fixture boundary; privileged CLI only calls this after fixed-path checks. */
export async function archiveHome(source, destination, options = {}) {
  const uid = options.uid ?? process.getuid();
  const gid = options.gid ?? process.getgid();
  const ownerUid = options.sourceUid ?? process.getuid();
  const beforeDirectory = await privateDirectory(destination, uid);
  for (const basename of [ARCHIVE_NAME, "manifest.json"]) {
    if (
      await fs.lstat(join(destination, basename)).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      })
    )
      throw new Error(
        "A Jenkins Home export already exists; never overwrite it",
      );
  }
  const entries = await snapshotEntries(source, ownerUid);
  const temporary = join(destination, `.archive-${randomUUID()}`);
  const temporaryManifest = join(destination, `.manifest-${randomUUID()}`);
  const file = await fs.open(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_RDWR |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await (options.tar ?? standardTar)(source, file.fd);
    await file.sync();
    const after = await snapshotEntries(source, ownerUid);
    if (JSON.stringify(entries) !== JSON.stringify(after))
      throw new Error(
        "Jenkins Home changed during export; discard this snapshot",
      );
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600)
      throw new Error("Archive file identity changed");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({
      start: 0,
      autoClose: false,
    }))
      hash.update(chunk);
    if (process.getuid() === 0) await file.chown(uid, gid);
    const manifest = {
      version: 1,
      kind: "jenkins-home-export",
      createdAt: new Date().toISOString(),
      source: { fixedHome: source, ...identity(await fs.lstat(source)) },
      archive: {
        basename: ARCHIVE_NAME,
        sha256: hash.digest("hex"),
        sizeBytes: stat.size,
      },
      method:
        "system tar without symlink dereference; stopped account; before/after metadata equality",
      entries,
    };
    await fs.writeFile(
      temporaryManifest,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    if (process.getuid() === 0) await fs.chown(temporaryManifest, uid, gid);
    if (
      JSON.stringify(await privateDirectory(destination, uid)) !==
      JSON.stringify(beforeDirectory)
    )
      throw new Error("Migration directory identity changed");
    // Exclusive publication: another exporter cannot be overwritten by rename.
    await fs.link(temporary, join(destination, ARCHIVE_NAME));
    await fs.rm(temporary);
    await fs.link(temporaryManifest, join(destination, "manifest.json"));
    await fs.rm(temporaryManifest);
    return manifest;
  } finally {
    await file.close();
    await fs.rm(temporary, { force: true });
    await fs.rm(temporaryManifest, { force: true });
    // If a final metadata publication failed, the complete private archive remains
    // recoverable. It is never overwritten or silently deleted on retry.
  }
}

function nativeIdentity(uid) {
  if (
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    process.versions.node.split(".")[0] !== "22" ||
    process.getuid() !== uid ||
    process.geteuid() !== uid
  ) {
    throw new Error(
      "This fixed Jenkins migration requires native macOS ARM64, Node 22 and the expected user",
    );
  }
}

export async function prepare() {
  nativeIdentity(TARGET_UID);
  const source = await fs.lstat(SOURCE_HOME);
  if (!source.isDirectory())
    throw new Error("Jenkins Home is not a real directory");
  const plan = createExportPlan(identity(source));
  await privateDirectory(dirname(MIGRATION_ROOT), TARGET_UID);
  await fs.mkdir(MIGRATION_ROOT, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  await privateDirectory(MIGRATION_ROOT, TARGET_UID);
  await fs.mkdir(plan.destination, { mode: 0o700 });
  const planPath = join(plan.destination, "plan.json");
  await fs.writeFile(planPath, `${JSON.stringify(plan)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return {
    state: "prepared",
    planPath,
    source: plan.source,
    requiresStoppedJenkins: true,
  };
}

export async function apply(planPath) {
  nativeIdentity(0);
  const destination = exportPlanDirectory(planPath);
  await privateDirectory(dirname(MIGRATION_ROOT), TARGET_UID);
  await privateDirectory(MIGRATION_ROOT, TARGET_UID);
  await privateDirectory(destination, TARGET_UID);
  const value = JSON.parse(await privateFile(planPath, TARGET_UID));
  const current = await fs.lstat(SOURCE_HOME);
  if (!current.isDirectory())
    throw new Error("Jenkins Home is not a real directory");
  const plan = validateExportPlan(value, planPath, identity(current));
  assertJenkinsStopped();
  const manifest = await archiveHome(SOURCE_HOME, plan.destination, {
    sourceUid: SOURCE_UID,
    uid: TARGET_UID,
    gid: TARGET_GID,
  });
  return {
    state: "exported",
    manifestPath: join(plan.destination, "manifest.json"),
    archive: manifest.archive,
    entries: manifest.entries.length,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [action, path, ...extra] = process.argv.slice(2);
  const task =
    extra.length === 0 && action === "prepare" && path === undefined
      ? prepare()
      : extra.length === 0 && action === "apply"
        ? apply(path)
        : Promise.reject(
            new Error("Use prepare or apply with its reviewed plan path"),
          );
  task
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      // Source names, file contents, tar stderr and credential values never enter output.
      console.error(
        error instanceof SyntaxError
          ? "Invalid export plan JSON"
          : error.message,
      );
      process.exitCode = 1;
    });
}
