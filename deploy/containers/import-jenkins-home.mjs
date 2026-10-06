import * as fs from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CONTROLLER_HOST,
  MIGRATION_EXCLUSIONS,
  validateDockerHost,
  validateMigrationManifest,
} from "./controller.mjs";
import {
  SOURCE_HOME,
  SOURCE_UID,
  snapshotEntries,
  validateRelativeEntry,
  validateInternalLink,
} from "./export-jenkins-home.mjs";

export const HOME_VOLUME = "agent-platform-jenkins-home";
const DOCKER = "/Users/douglasdong/.orbstack/bin/docker";
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const HELPER = `set -eu
umask 077
test -z "$(find /import-home -mindepth 1 -maxdepth 1 -print -quit)"
tar -xf - --no-same-owner -C /import-home
chmod 700 /import-home
chown -hR 1000:1000 /import-home
printf 'jenkins-home-imported\\n'
`;

function safeMetadataText(value) {
  if (
    typeof value !== "string" ||
    /[\x00-\x1f\x7f]/.test(value) ||
    value.includes(" -> ") ||
    value.includes(" link to ")
  ) {
    throw new Error(
      "Archive names contain unsafe or ambiguous metadata characters",
    );
  }
  return value;
}

export function normalizeArchivePath(raw) {
  safeMetadataText(raw);
  if (raw === "." || raw === "./") return ".";
  const value = raw.replace(/^\.\//, "").replace(/\/$/, "");
  validateRelativeEntry(value);
  if (posix.normalize(value) !== value)
    throw new Error("Unsafe archive path normalization");
  return value;
}

function permissions(value) {
  if (!/^[rwx-]{9}$/.test(value))
    throw new Error("Special archive permissions are refused");
  return [...value].reduce(
    (mode, character, index) =>
      mode | (character === "-" ? 0 : 1 << (8 - index)),
    0,
  );
}

/** Parse standard BSD/GNU tar metadata only. Filenames with control/link delimiters are refused. */
export function parseTarListing(output) {
  const rows = [];
  for (const line of output.replace(/\n$/, "").split("\n")) {
    const bsd =
      /^([dl-])([rwxstST-]{9})\s+\d+\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+[A-Z][a-z]{2}\s+\d{1,2}\s+(?:\d{2}:\d{2}|\d{4})\s(.+)$/.exec(
        line,
      );
    const gnu =
      /^([dl-])([rwxstST-]{9})\s+(-?\d+)\/(-?\d+)\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s(.+)$/.exec(
        line,
      );
    const match = bsd ?? gnu;
    if (!match)
      throw new Error("Unknown, hard-linked or special tar archive header");
    const [, type, mode, uid, gid, size, tail] = match;
    if (tail.includes(" link to "))
      throw new Error("Hard-linked archive entries are refused");
    const parts = type === "l" ? tail.split(" -> ") : [tail];
    if (parts.length !== (type === "l" ? 2 : 1))
      throw new Error("Ambiguous archive symlink metadata");
    const row = {
      path: normalizeArchivePath(parts[0]),
      archiveName: parts[0],
      type: type === "d" ? "directory" : type === "l" ? "symlink" : "file",
      mode: permissions(mode),
      uid: Number(uid),
      gid: Number(gid),
      sizeBytes: Number(size),
    };
    if (
      ![row.uid, row.gid, row.sizeBytes].every(Number.isSafeInteger) ||
      row.sizeBytes < 0
    )
      throw new Error("Invalid tar numeric metadata");
    if (row.type === "symlink")
      row.linkTarget = validateInternalLink(
        row.path,
        safeMetadataText(parts[1]),
      );
    rows.push(row);
  }
  return rows;
}

export function matchArchiveEntries(manifest, actual) {
  const expected = manifest.entries.map((entry) => ({
    ...entry,
    path: normalizeArchivePath(entry.path),
  }));
  const names = new Map();
  for (const entry of expected) {
    if (
      names.has(entry.path) ||
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777
    )
      throw new Error("Invalid or duplicate export entry metadata");
    if (entry.type === "symlink")
      validateInternalLink(entry.path, safeMetadataText(entry.linkTarget));
    names.set(entry.path, entry);
  }
  const links = expected
    .filter((entry) => entry.type === "symlink")
    .map((entry) => entry.path);
  if (
    expected.some((entry) =>
      links.some((link) => entry.path.startsWith(`${link}/`)),
    )
  )
    throw new Error("Archive members cannot descend through a symbolic link");
  if (actual.length !== expected.length)
    throw new Error("Actual archive entries differ from the export manifest");
  const seen = new Set();
  for (const entry of actual) {
    const wanted = names.get(entry.path);
    if (
      !wanted ||
      seen.has(entry.path) ||
      wanted.type !== entry.type ||
      wanted.mode !== entry.mode ||
      wanted.uid !== entry.uid ||
      wanted.gid !== entry.gid ||
      (entry.type === "file" && wanted.sizeBytes !== entry.sizeBytes) ||
      (entry.type === "symlink" && wanted.linkTarget !== entry.linkTarget)
    )
      throw new Error("Actual archive entries differ from the export manifest");
    seen.add(entry.path);
  }
  return expected;
}

async function command(
  program,
  args,
  { inputPath, outputFd, archiveFd, env = {}, cwd = "/" } = {},
) {
  return new Promise((resolve, reject) => {
    const stdio = [inputPath ? "pipe" : "ignore", outputFd ?? "pipe", "ignore"];
    if (archiveFd !== undefined) stdio.push(archiveFd);
    const child = spawn(program, args, {
      cwd,
      env: {
        PATH: "/usr/bin:/bin",
        LANG: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
        LC_TIME: "C",
        COPYFILE_DISABLE: "1",
        ...env,
      },
      stdio,
    });
    let output = "";
    let excessive = false;
    child.stdout?.on("data", (chunk) => {
      if (output.length + chunk.length > 64 * 1024 * 1024) {
        excessive = true;
        child.kill("SIGTERM");
      } else output += chunk;
    });
    const input = inputPath
      ? createReadStream(inputPath, {
          flags: constants.O_RDONLY | constants.O_NOFOLLOW,
        })
      : null;
    input?.on("error", () => {
      child.kill("SIGTERM");
    });
    input?.pipe(child.stdin);
    child.stdin?.on("error", () => {
      /* Early helper rejection is reported by its exit code. */
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 30 * 60_000);
    child.once("error", () => {
      clearTimeout(timer);
      input?.destroy();
      reject(new Error("Reviewed archive command could not start"));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      input?.destroy();
      if (code === 0 && !excessive) resolve(output);
      else
        reject(
          new Error(`Reviewed archive command failed (${signal ?? code})`),
        );
    });
  });
}

async function privateDirectory(path) {
  const stat = await fs.lstat(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error("Export and staging directories must remain owner-only");
}

async function openPrivate(path) {
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stat = await file.stat();
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o600
  ) {
    await file.close();
    throw new Error(
      "Export inputs must be private regular files without aliases",
    );
  }
  return { file, stat };
}

export function inspectSecurityConfiguration(xml, entries) {
  const realm = /<securityRealm\b[^>]*\bclass="([A-Za-z0-9_.$]+)"/.exec(
    xml,
  )?.[1];
  const authorization =
    /<authorizationStrategy\b[^>]*\bclass="([A-Za-z0-9_.$]+)"/.exec(xml)?.[1];
  if (
    /<!DOCTYPE|<!ENTITY/i.test(xml) ||
    !/<useSecurity>\s*true\s*<\/useSecurity>/.test(xml) ||
    !realm ||
    !authorization ||
    /(?:\$None|NO_AUTHENTICATION|Unsecured)/.test(`${realm}\n${authorization}`)
  )
    throw new Error(
      "Imported Jenkins authentication must be configured and secured",
    );
  if (
    authorization ===
      "hudson.security.FullControlOnceLoggedInAuthorizationStrategy" &&
    !/<denyAnonymousReadAccess>\s*true\s*<\/denyAnonymousReadAccess>/.test(xml)
  )
    throw new Error(
      "Imported full-control authentication must refuse anonymous read access",
    );
  const users = entries.filter(
    (entry) =>
      /^users\/[^/]+\/config\.xml$/.test(entry.path) && entry.type === "file",
  ).length;
  if (realm === "hudson.security.HudsonPrivateSecurityRealm" && users === 0)
    throw new Error(
      "Imported local authentication requires its preserved user records",
    );
  return {
    useSecurity: true,
    realm,
    authorization,
    userRecords: users,
    resetAuthentication: false,
    generatesKeys: false,
  };
}

export function inspectBuildRecord(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("Unsafe saved build XML is refused");
  const pipeline =
    /<(?:flow-build|org\.jenkinsci\.plugins\.workflow\.job\.WorkflowRun)\b/.test(
      xml,
    );
  if (pipeline) {
    const completion = [
      ...xml.matchAll(/<completed>\s*(true|false)\s*<\/completed>/g),
    ];
    if (completion.length !== 1 || completion[0][1] !== "true")
      throw new Error(
        "An unfinished saved Pipeline could resume; Home import is refused",
      );
  }
  const result =
    /<result>(SUCCESS|FAILURE|UNSTABLE|ABORTED|NOT_BUILT)<\/result>/.exec(
      xml,
    )?.[1] ?? "UNKNOWN";
  return { pipeline, completed: pipeline ? true : null, result };
}

async function readArchiveXml(archivePath, archiveIdentity, entry) {
  if (entry.sizeBytes > 4 * 1024 * 1024)
    throw new Error("Saved controller XML is too large to review");
  const archive = await openPrivate(archivePath);
  try {
    if (
      Object.entries(archiveIdentity).some(
        ([key, value]) => archive.stat[key] !== value,
      )
    )
      throw new Error(
        "Export archive changed before saved configuration review",
      );
    return await command(
      "/usr/bin/tar",
      ["-xOf", "/dev/fd/3", entry.archiveName],
      { archiveFd: archive.file.fd },
    );
  } finally {
    await archive.file.close();
  }
}

export async function verifyExport(manifestPath, options = {}) {
  const directory = dirname(manifestPath);
  await privateDirectory(directory);
  if (manifestPath !== join(directory, "manifest.json"))
    throw new Error("Use the original private export manifest");
  const { file: metadata, stat: metadataStat } =
    await openPrivate(manifestPath);
  let manifest;
  try {
    if (metadataStat.size > 64 * 1024 * 1024)
      throw new Error("Export metadata is too large to review");
    manifest = JSON.parse(await metadata.readFile("utf8"));
  } finally {
    await metadata.close();
  }
  validateMigrationManifest(manifest);
  if (
    manifest.source?.fixedHome !== (options.sourceHome ?? SOURCE_HOME) ||
    manifest.source?.uid !== (options.sourceUid ?? SOURCE_UID) ||
    manifest.source?.mode !== 0o700
  )
    throw new Error("Export source is not the reviewed Jenkins Home identity");
  const archivePath = join(directory, manifest.archive.basename);
  const { file, stat } = await openPrivate(archivePath);
  try {
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({
      start: 0,
      autoClose: false,
    }))
      hash.update(chunk);
    if (
      stat.size !== manifest.archive.sizeBytes ||
      hash.digest("hex") !== manifest.archive.sha256
    )
      throw new Error("Export archive hash or size differs from its manifest");
    const actual = parseTarListing(
      await command("/usr/bin/tar", ["--numeric-owner", "-Ptvf", "/dev/fd/3"], {
        archiveFd: file.fd,
      }),
    );
    const entries = matchArchiveEntries(manifest, actual);
    const after = await file.stat();
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new Error("Export archive changed while being verified");
    const archiveIdentity = {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
    const configEntry = actual.find((entry) => entry.path === "config.xml");
    const security = inspectSecurityConfiguration(
      await readArchiveXml(archivePath, archiveIdentity, configEntry),
      entries,
    );
    const history = { records: 0, completedPipelineRuns: 0, results: {} };
    for (const entry of actual.filter(
      (value) =>
        value.type === "file" &&
        /^jobs\/.+\/builds\/[1-9][0-9]*\/build\.xml$/.test(value.path),
    )) {
      const record = inspectBuildRecord(
        await readArchiveXml(archivePath, archiveIdentity, entry),
      );
      history.records++;
      if (record.pipeline) history.completedPipelineRuns++;
      history.results[record.result] =
        (history.results[record.result] ?? 0) + 1;
    }
    return {
      manifest,
      archivePath,
      entries,
      security,
      history,
      archiveIdentity,
    };
  } finally {
    await file.close();
  }
}

export async function stageRetainedHome(verified, stage) {
  await privateDirectory(stage);
  if ((await fs.readdir(stage)).length)
    throw new Error("Staging directory must be new and empty");
  const archive = await openPrivate(verified.archivePath);
  try {
    const stat = archive.stat;
    if (
      Object.entries(verified.archiveIdentity).some(
        ([key, value]) => stat[key] !== value,
      )
    )
      throw new Error("Verified export archive changed before extraction");
    await command(
      "/usr/bin/tar",
      ["-xf", "/dev/fd/3", "--no-same-owner", "-C", stage],
      { archiveFd: archive.file.fd },
    );
  } finally {
    await archive.file.close();
  }
  const actual = await snapshotEntries(stage, process.getuid());
  const comparable = (entry) =>
    JSON.stringify({
      path: entry.path,
      type: entry.type,
      mode: entry.mode,
      sizeBytes: entry.type === "file" ? entry.sizeBytes : undefined,
      linkTarget: entry.linkTarget,
    });
  const expectedByPath = new Map(
    verified.entries.map((entry) => [entry.path, comparable(entry)]),
  );
  if (
    actual.length !== verified.entries.length ||
    actual.some((entry) => comparable(entry) !== expectedByPath.get(entry.path))
  )
    throw new Error("Extracted Home does not match verified archive metadata");
  // Job disablement at startup cannot prevent a saved Pipeline from resuming.
  // Recheck the actual staged records before making any Home volume available.
  for (const entry of actual.filter(
    (value) =>
      value.type === "file" &&
      /^jobs\/.+\/builds\/[1-9][0-9]*\/build\.xml$/.test(value.path),
  )) {
    const file = await fs.open(
      join(stage, entry.path),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid() ||
        stat.size > 4 * 1024 * 1024
      )
        throw new Error(
          "Saved controller XML is too large or its file identity changed",
        );
      inspectBuildRecord(await file.readFile("utf8"));
    } finally {
      await file.close();
    }
  }
  for (const path of MIGRATION_EXCLUSIONS)
    await fs.rm(join(stage, path), { recursive: true, force: true });
  const retained = await snapshotEntries(stage, process.getuid());
  if (
    retained.some((entry) =>
      MIGRATION_EXCLUSIONS.some(
        (path) => entry.path === path || entry.path.startsWith(`${path}/`),
      ),
    )
  )
    throw new Error("Old executable bootstrap or excluded Home data remains");
  return retained;
}

export function validateImportImage(image) {
  if (!IMAGE_ID.test(image ?? ""))
    throw new Error(
      "Use the verified controller image ID, never a mutable tag",
    );
  return image;
}

export async function importVolume(
  verified,
  image,
  { docker, retainedArchive } = {},
) {
  validateImportImage(image);
  validateDockerHost("controller", CONTROLLER_HOST);
  const present = (
    await docker([
      "volume",
      "ls",
      "--format",
      "{{.Name}}",
      "--filter",
      `name=^${HOME_VOLUME}$`,
    ])
  )
    .split("\n")
    .filter(Boolean);
  if (present.includes(HOME_VOLUME))
    throw new Error(
      "The target Home volume already exists; never overwrite or reuse it",
    );
  const info = JSON.parse(await docker(["image", "inspect", image]));
  if (
    info.length !== 1 ||
    info[0].Id !== image ||
    info[0].Os !== "linux" ||
    info[0].Architecture !== "arm64" ||
    !info[0].Config?.Env?.includes("JENKINS_VERSION=2.580.1")
  )
    throw new Error(
      "Controller helper image differs from the verified Linux ARM64 core",
    );
  const token = randomUUID();
  await docker([
    "volume",
    "create",
    "--label",
    `agent-platform.home-import=${token}`,
    "--label",
    `agent-platform.export-sha256=${verified.manifest.archive.sha256}`,
    HOME_VOLUME,
  ]);
  const volume = JSON.parse(
    await docker(["volume", "inspect", HOME_VOLUME]),
  )[0];
  if (
    volume?.Name !== HOME_VOLUME ||
    volume.Driver !== "local" ||
    Object.keys(volume.Options ?? {}).length ||
    volume.Labels?.["agent-platform.home-import"] !== token
  )
    throw new Error("New Home volume ownership changed before import");
  if ((await docker(["ps", "-aq", "--filter", `volume=${HOME_VOLUME}`])).trim())
    throw new Error("New Home volume is already attached to another container");
  let container;
  try {
    container = (
      await docker([
        "create",
        "-i",
        "--network",
        "none",
        "--read-only",
        "--user",
        "0:0",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "CHOWN",
        "--cap-add",
        "DAC_OVERRIDE",
        "--security-opt",
        "no-new-privileges:true",
        "--label",
        `agent-platform.home-import=${token}`,
        "--mount",
        `type=volume,source=${HOME_VOLUME},target=/import-home`,
        "--entrypoint",
        "/bin/sh",
        image,
        "-c",
        HELPER,
      ])
    ).trim();
    if (!CONTAINER_ID.test(container))
      throw new Error("Cannot identify the dedicated import helper");
    const result = await docker(["start", "-ai", container], {
      inputPath: retainedArchive,
    });
    if (result.trim() !== "jenkins-home-imported")
      throw new Error("Home import helper did not confirm completion");
  } finally {
    if (CONTAINER_ID.test(container ?? ""))
      await docker(["rm", "-f", container]);
  }
  return {
    state: "imported-not-started",
    targetHomeVolume: HOME_VOLUME,
    archiveSha256: verified.manifest.archive.sha256,
    excluded: MIGRATION_EXCLUSIONS,
    security: verified.security,
    history: verified.history,
    controllerMode: "migration",
    jobsPause: "guard-on-startup; connect no agents before review",
    activated: false,
    apiTouched: false,
  };
}

export async function applyImport(manifestPath, image) {
  if (
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    process.getuid() !== 501 ||
    process.geteuid() !== 501 ||
    process.versions.node.split(".")[0] !== "22"
  )
    throw new Error(
      "Home import runs only as the native trusted UID501 Node22 user, never root",
    );
  validateImportImage(image);
  const socket = await fs.lstat(CONTROLLER_HOST.slice("unix://".length));
  if (!socket.isSocket() || socket.uid !== 501)
    throw new Error(
      "Dedicated controller Docker socket is not owned by the trusted user",
    );
  const verified = await verifyExport(manifestPath);
  const workspace = join(dirname(manifestPath), `.import-${randomUUID()}`);
  await fs.mkdir(workspace, { mode: 0o700 });
  const stage = join(workspace, "home");
  const config = join(workspace, "docker-config");
  await fs.mkdir(stage, { mode: 0o700 });
  await fs.mkdir(config, { mode: 0o700 });
  await fs.writeFile(join(config, "config.json"), "{}\n", {
    mode: 0o600,
    flag: "wx",
  });
  const retainedArchive = join(workspace, "retained.tar");
  try {
    await stageRetainedHome(verified, stage);
    const output = await fs.open(
      retainedArchive,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await command("/usr/bin/tar", ["-cf", "-", "-C", stage, "."], {
        outputFd: output.fd,
      });
      await output.sync();
    } finally {
      await output.close();
    }
    const docker = (args, options = {}) =>
      command(
        DOCKER,
        ["--host", CONTROLLER_HOST, "--config", config, ...args],
        { ...options, env: { HOME: "/Users/douglasdong" }, cwd: workspace },
      );
    const result = await importVolume(verified, image, {
      docker,
      retainedArchive,
    });
    const receiptPath = join(
      dirname(manifestPath),
      `import-receipt-${randomUUID()}.json`,
    );
    await fs.writeFile(receiptPath, `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    return { ...result, receiptPath };
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [action, manifestPath, image, ...extra] = process.argv.slice(2);
  const task =
    extra.length === 0 && action === "plan" && manifestPath && image
      ? (validateImportImage(image),
        verifyExport(manifestPath).then((value) => ({
          state: "verified-not-imported",
          archive: value.manifest.archive,
          entries: value.entries.length,
          security: value.security,
          history: value.history,
          excluded: MIGRATION_EXCLUSIONS,
          targetHomeVolume: HOME_VOLUME,
          dockerHost: CONTROLLER_HOST,
          image,
          requiresNewEmptyVolume: true,
          startsServices: false,
        })))
      : extra.length === 0 && action === "apply" && manifestPath && image
        ? applyImport(manifestPath, image)
        : Promise.reject(
            new Error(
              "Use plan or apply with the private manifest and verified controller image ID",
            ),
          );
  task
    .then((value) => console.log(JSON.stringify(value)))
    .catch((error) => {
      console.error(
        error instanceof SyntaxError
          ? "Invalid private migration metadata"
          : error.message,
      );
      process.exitCode = 1;
    });
}
