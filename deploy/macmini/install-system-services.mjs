import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { isDeepStrictEqual } from "node:util";
import {
  prepareVercel,
  verifyVercel,
  installVercel,
} from "./public-build-tools.mjs";
import {
  validateConfig,
  privateFile,
  runtimeEnvironment,
  readyManifest,
  createMaintenanceBarrier,
  releaseMaintenanceBarrier,
} from "./lib.mjs";
import {
  SERVICE_USER,
  SERVICE_UID,
  SERVICE_GID,
  SERVICE_HOME,
  DEPLOY_ROOT,
  SERVICE_HELPER,
  SUDOERS_FILE,
  LABELS,
  ACCOUNTS,
  EXTRA_SERVICES,
  CI_TOOLS,
  PUBLIC_TOOLS,
  assertNativeServiceIdentity,
  assertRuntimeUser,
  systemPlistPath,
  servicePlist,
  serviceControlScript,
  serviceSudoers,
  validateExtraPlist,
  validateSecretHandoffs,
} from "./system-services.mjs";

const source = dirname(fileURLToPath(import.meta.url));
const configPath = join(DEPLOY_ROOT, "config.json");
const gui = `gui/${SERVICE_UID}`;
const tools = [
  "controller.mjs",
  "lib.mjs",
  "runtime.mjs",
  "install.mjs",
  "install-tunnel.mjs",
  "system-services.mjs",
  "install-system-services.mjs",
  "public-build-tools.mjs",
  "jenkins-monitor.mjs",
];
const action = process.argv[2] ?? "status";
const review = process.argv[3] ? resolve(process.argv[3]) : null;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

function command(file, args, options = {}) {
  const { workerErrors = false, ...spawnOptions } = options;
  const result = spawnSync(file, args, {
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
    ...spawnOptions,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      (workerErrors && safeWorkerFailure(result.stderr)) ||
        `${file.split("/").at(-1)} ${args[0] ?? ""} failed (${result.status ?? "timeout"})`,
    );
  return result.stdout;
}
function loaded(domain, label) {
  return (
    spawnSync("/bin/launchctl", ["print", `${domain}/${label}`], {
      stdio: "ignore",
      timeout: 10_000,
    }).status === 0
  );
}
function launch(args) {
  command("/bin/launchctl", args);
}
async function ownerFile(path, uid = SERVICE_UID) {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== uid ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 16 * 1024 * 1024
    )
      throw new Error(
        `Expected owner-only regular review/config file: ${path}`,
      );
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
async function writeOwned(path, contents, uid = SERVICE_UID, mode = 0o600) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, contents, { flag: "wx", mode });
  if (process.getuid() === 0)
    await fs.chown(temporary, uid, uid === 0 ? 0 : SERVICE_GID);
  await fs.chmod(temporary, mode);
  await fs.rename(temporary, path);
}
async function jsonOwned(path, value, uid = SERVICE_UID) {
  await writeOwned(path, `${JSON.stringify(value, null, 2)}\n`, uid);
}
async function userDirectory(path) {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(path);
  if (
    !stat.isDirectory() ||
    (stat.uid !== SERVICE_UID && stat.uid !== process.getuid())
  )
    throw new Error(`Unexpected directory ownership: ${path}`);
  if (process.getuid() === 0) await fs.chown(path, SERVICE_UID, SERVICE_GID);
  await fs.chmod(path, 0o700);
}
async function rootDirectory(path) {
  // macOS intentionally aliases /etc to the root-owned /private/etc.
  if (path === "/etc" || path.startsWith("/etc/")) path = `/private${path}`;
  const parent = dirname(path);
  if (parent !== path) await rootDirectory(parent);
  await fs.mkdir(path, { mode: 0o755 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0)
    throw new Error(
      `Privileged path must be a root-owned non-writable directory: ${path}`,
    );
}
function convertedConfig(original) {
  const config = validateConfig({
    ...original,
    ciProvider: "jenkins",
    jenkinsJob: "agent-platform-api",
    launchdDomain: "system",
    runtimePlist: systemPlistPath(LABELS.api),
    serviceHelper: SERVICE_HELPER,
  });
  assertNativeServiceIdentity(config);
  return config;
}
async function parsePlist(path) {
  command("/usr/bin/plutil", ["-lint", path]);
  return JSON.parse(
    command("/usr/bin/plutil", ["-convert", "json", "-o", "-", path]),
  );
}
function userWorker(commandName, timeout = 30_000) {
  const output = command(
    process.execPath,
    [
      join(review, "tools/install-system-services.mjs"),
      "internal",
      review,
      commandName,
    ],
    {
      uid: SERVICE_UID,
      gid: SERVICE_GID,
      timeout,
      workerErrors: true,
      cwd: DEPLOY_ROOT,
      env: {
        HOME: SERVICE_HOME,
        USER: SERVICE_USER,
        LOGNAME: SERVICE_USER,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        LANG: "en_US.UTF-8",
      },
    },
  );
  return JSON.parse(output);
}

export const BLOCKER_NAMES = Object.freeze([
  "sandboxes",
  "agentTasks",
  "automationRuns",
  "enabledAutomations",
  "resourceAllocations",
  "cloningProjects",
  "projectCleanupJobs",
]);

export function cutoverStatus(value, sha) {
  const count = (number) => Number.isSafeInteger(number) && number >= 0;
  if (
    !/^[a-f0-9]{40}$/.test(sha) ||
    ![
      value?.ready,
      value?.idle,
      value?.draining,
      value?.readiness?.database,
      value?.readiness?.provider,
      value?.readiness?.image,
    ].every((item) => typeof item === "boolean") ||
    ![
      value?.activeWS,
      value?.inFlightHTTP,
      value?.credentialAuth,
      ...BLOCKER_NAMES.map((name) => value?.blockers?.[name]),
    ].every(count) ||
    !value?.blockers ||
    Array.isArray(value.blockers) ||
    Object.keys(value.blockers).length !== BLOCKER_NAMES.length ||
    Object.keys(value.blockers).some((name) => !BLOCKER_NAMES.includes(name))
  )
    throw new Error("Deployment preflight returned an invalid status");
  const blockers = Object.fromEntries(
    BLOCKER_NAMES.map((name) => [name, value.blockers[name]]),
  );
  const readiness = {
    database: value.readiness.database,
    provider: value.readiness.provider,
    image: value.readiness.image,
  };
  return {
    ready: value.ready && Object.values(readiness).every(Boolean),
    idle:
      value.idle &&
      value.activeWS === 0 &&
      value.inFlightHTTP === 0 &&
      value.credentialAuth === 0 &&
      Object.values(blockers).every((number) => number === 0),
    draining: value.draining,
    readiness,
    activeWS: value.activeWS,
    inFlightHTTP: value.inFlightHTTP,
    credentialAuth: value.credentialAuth,
    blockers,
    sha,
  };
}

export async function readCutoverStatus(base, headers, sha, fetcher = fetch) {
  const response = await fetcher(`${base}/api/deployment/status`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(
      `Authenticated deployment status failed (${response.status})`,
    );
  const value = await response.json();
  const version = await fetcher(`${base}/api/system/version`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  if (!version.ok || (await version.json()).commit !== sha)
    throw new Error(
      "Production did not prove the current release and readiness",
    );
  return cutoverStatus(value, sha);
}

function busyReason(value) {
  return `Production is busy; ready=${value.ready} idle=${value.idle} activeWS=${value.activeWS} inFlightHTTP=${value.inFlightHTTP} credentialAuth=${value.credentialAuth} blockers=${BLOCKER_NAMES.map((name) => `${name}:${value.blockers[name]}`).join(",")}; no configuration or services were changed`;
}

function noWork(value) {
  return (
    value.ready &&
    value.inFlightHTTP === 0 &&
    value.credentialAuth === 0 &&
    Object.values(value.blockers).every((number) => number === 0)
  );
}

// Only this explicit operator cutover may disconnect the reviewed GUI Tunnel's
// otherwise idle sockets. The automatic controller still requires zero sockets.
export async function operatorPreflight(probe, dedicatedTunnelLoaded) {
  const value = await probe();
  const checked = cutoverStatus(value, value.sha);
  if (checked.draining)
    throw new Error(
      "Production is already draining; no configuration or services were changed",
    );
  if (!noWork(checked) || (!checked.idle && checked.activeWS === 0))
    throw new Error(busyReason(checked));
  if (checked.activeWS > 0 && !dedicatedTunnelLoaded)
    throw new Error(
      "Residual connections require the validated dedicated GUI Tunnel; no configuration or services were changed",
    );
  return checked;
}

// Refusal sits outside the mutation/rollback block so config/review stay intact.
export async function cutoverAfterPreflight(probe, tunnelLoaded, transition) {
  await operatorPreflight(probe, tunnelLoaded);
  return transition();
}

export async function holdCutoverAdmission(path, heldPath, probe) {
  const first = await probe();
  const checked = cutoverStatus(first, first.sha);
  if (!noWork(checked) || checked.draining)
    throw new Error("Production is busy; no service has been stopped");
  let held;
  try {
    held = await createMaintenanceBarrier(path);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error("Maintenance already exists; barrier was preserved");
    throw error;
  }
  try {
    await jsonOwned(heldPath, held);
    const after = await probe();
    const snapshot = cutoverStatus(after, after.sha);
    if (!noWork(snapshot) || !snapshot.draining)
      throw new Error("Production became busy after the barrier");
    return held;
  } catch (error) {
    await releaseMaintenanceBarrier(path, held);
    throw error;
  }
}

export async function waitCutoverQuiet(
  probe,
  ownsBarrier,
  { sleep = pause, now = () => performance.now(), timeoutMs = 60_000 } = {},
) {
  const deadline = now() + timeoutMs;
  let quietSince = null;
  while (now() <= deadline) {
    if (!(await ownsBarrier()))
      throw new Error("Maintenance ownership changed; barrier was preserved");
    const value = await probe();
    const checked = cutoverStatus(value, value.sha);
    if (!checked.draining || !noWork(checked))
      throw new Error("Production became busy after the barrier");
    if (checked.idle) {
      quietSince ??= now();
      if (now() - quietSince >= 10_000) {
        if (!(await ownsBarrier()))
          throw new Error(
            "Maintenance ownership changed; barrier was preserved",
          );
        return checked;
      }
    } else quietSince = null;
    await sleep(1000);
  }
  throw new Error("Production did not stay quiet for ten seconds");
}

export async function recoverUnstoppedApi({
  tunnelWasLoaded,
  tunnelWasStopped,
  restartTunnel,
  hasBarrier,
  ready,
  release,
}) {
  if (tunnelWasLoaded && tunnelWasStopped) await restartTunnel();
  if (hasBarrier) {
    await ready();
    await release();
  }
}

const DEDICATED_TUNNEL = Object.freeze({
  tunnelId: "b59b8cc0-571a-46ec-bf21-1a01b78670a4",
  hostname: "agent-api.douglasdong.com",
  service: "http://127.0.0.1:3101",
});
const GUI_TUNNEL_ERROR =
  "Existing GUI Tunnel differs from the fixed dedicated production service; no services were stopped";

export function validateGuiTunnelPlist(plist, config, metadata) {
  assertNativeServiceIdentity(config);
  const required = {
    Label: LABELS.tunnel,
    ProgramArguments: [
      "/opt/homebrew/bin/cloudflared",
      "tunnel",
      "--no-autoupdate",
      "--metrics",
      "127.0.0.1:20241",
      "run",
      "--token-file",
      join(DEPLOY_ROOT, "cloudflared.token"),
    ],
    WorkingDirectory: DEPLOY_ROOT,
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 20,
    ExitTimeOut: 30,
    Umask: 63,
    StandardOutPath: join(DEPLOY_ROOT, "logs/tunnel.log"),
    StandardErrorPath: join(DEPLOY_ROOT, "logs/tunnel.log"),
  };
  // The first dedicated GUI installer inherited its UID501 GUI session's home
  // and environment. Later plists state them explicitly; neither form may add
  // arbitrary launchd fields, users, arguments or paths.
  const optional = {
    EnvironmentVariables: {
      HOME: SERVICE_HOME,
      USER: SERVICE_USER,
      LOGNAME: SERVICE_USER,
      PATH: `${dirname(config.node)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: "en_US.UTF-8",
      TMPDIR: join(DEPLOY_ROOT, "tmp"),
    },
    ProcessType: "Background",
  };
  if (
    !isDeepStrictEqual(metadata, DEDICATED_TUNNEL) ||
    !plist ||
    Array.isArray(plist) ||
    Object.keys(plist).some(
      (key) => !Object.hasOwn(required, key) && !Object.hasOwn(optional, key),
    ) ||
    Object.entries(required).some(
      ([key, value]) => !isDeepStrictEqual(plist[key], value),
    ) ||
    Object.entries(optional).some(
      ([key, value]) =>
        Object.hasOwn(plist, key) && !isDeepStrictEqual(plist[key], value),
    )
  )
    throw new Error(GUI_TUNNEL_ERROR);
  return true;
}

async function verifyGuiTunnelPlist(config) {
  const path = join(
    SERVICE_HOME,
    "Library/LaunchAgents",
    `${LABELS.tunnel}.plist`,
  );
  const contents = await ownerFile(path);
  const plist = JSON.parse(
    command("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
      input: contents,
    }),
  );
  const metadata = JSON.parse(
    await ownerFile(join(DEPLOY_ROOT, "tunnel.json")),
  );
  validateGuiTunnelPlist(plist, config, metadata);
}

async function validatedGuiTunnel(config) {
  if (!loaded(gui, LABELS.tunnel)) return false;
  await verifyGuiTunnelPlist(config);
  return true;
}

const SAFE_WORKER_REASONS = new Set([
  "Internal worker requires a review directory",
  "Cutover is restricted to the existing production3101 data; preview is excluded",
  "Current release escaped the production release directory",
  "Deployment preflight returned an invalid status",
  "Production did not prove the current release and readiness",
  "Production is not quiet behind the held barrier",
  "Production is busy; no service has been stopped",
  "Production became busy after the barrier",
  "Production did not stay quiet for ten seconds",
  "Backup requires quiet production behind the barrier",
  "Production failed authenticated readiness behind the barrier",
  "Maintenance ownership changed; barrier was preserved",
  "Maintenance already exists; barrier was preserved",
  "Existing GUI Tunnel differs from the fixed dedicated production service; no services were stopped",
  "Cannot inspect the original dedicated Tunnel process",
  "Cannot inspect dedicated Tunnel metrics ownership",
  "Dedicated Tunnel process or metrics ownership changed; no replacement Tunnel or API was started",
  "Invalid internal worker command",
]);
export function safeWorkerFailure(stderr) {
  for (const line of String(stderr ?? "").split(/\r?\n/)) {
    const reason = /^Error: ([^\r\n]+)$/.exec(line)?.[1];
    if (!reason) continue;
    if (
      SAFE_WORKER_REASONS.has(reason) ||
      /^Authenticated deployment status failed \([1-5][0-9]{2}\)$/.test(reason)
    )
      return reason;
  }
  return null;
}

// This worker is deliberately unprivileged: only it reads the runtime passcode,
// authenticates the idle/readiness endpoints and loads the native SQLite addon.
async function internalWorker() {
  if (!review) throw new Error("Internal worker requires a review directory");
  const original = JSON.parse(
    await privateFile(join(review, "original-config.json")),
  );
  const config = convertedConfig(original);
  assertRuntimeUser(config);
  const runtime = runtimeEnvironment(
    await privateFile(config.runtimeEnvFile),
    config,
  );
  if (
    runtime.PORT !== "3101" ||
    runtime.DATA_ROOT !== join(SERVICE_HOME, "agent-platform/production") ||
    runtime.DATABASE_URL !== join(runtime.DATA_ROOT, "platform.db") ||
    runtime.BOXLITE_HOME !== join(runtime.DATA_ROOT, "boxlite")
  )
    throw new Error(
      "Cutover is restricted to the existing production3101 data; preview is excluded",
    );
  const base = `http://127.0.0.1:${runtime.PORT}`;
  const headers = { authorization: `Bearer ${runtime.ACCESS_PASSCODE}` };
  const release = await fs.realpath(join(config.root, "current"));
  const sha = release.split("/").at(-1);
  if (release !== join(config.root, "releases", sha))
    throw new Error("Current release escaped the production release directory");
  await readyManifest(release, sha);
  async function status() {
    const value = await readCutoverStatus(base, headers, sha);
    if (!value.ready)
      throw new Error(
        "Production did not prove the current release and readiness",
      );
    return value;
  }
  const heldPath = join(review, "barrier.json");
  const commandName = process.argv[4];
  if (commandName === "preflight") {
    const snapshot = await readCutoverStatus(base, headers, sha);
    const tunnelLoaded = await validatedGuiTunnel(original);
    const tunnelIdentity = tunnelLoaded ? captureGuiTunnel() : null;
    const eligible = await operatorPreflight(
      async () => snapshot,
      tunnelLoaded,
    ).then(
      () => true,
      () => false,
    );
    console.log(
      JSON.stringify({
        state: "preflight",
        ...snapshot,
        dedicatedTunnelLoaded: tunnelLoaded,
        dedicatedTunnelPid: tunnelIdentity?.pid ?? null,
        dedicatedTunnelOwnership: tunnelIdentity
          ? {
              launchProgram: tunnelIdentity.program,
              process: tunnelIdentity.process,
              listeners: tunnelIdentity.listeners,
            }
          : null,
        operatorEligible: eligible,
        requiresTunnelDisconnect: snapshot.activeWS > 0,
        previewUntouched: true,
      }),
    );
  } else if (commandName === "gate") {
    const value = await status();
    if (!value.idle || !value.draining)
      throw new Error("Production is not quiet behind the held barrier");
    if (!(await stillOwnsBarrier()))
      throw new Error("Maintenance ownership changed; barrier was preserved");
    console.log(
      JSON.stringify({ idle: true, draining: true, ready: true, sha }),
    );
  } else if (commandName === "hold-admission") {
    await holdCutoverAdmission(runtime.DEPLOYMENT_DRAIN_FILE, heldPath, status);
    console.log(
      JSON.stringify({ admissionHeld: true, draining: true, ready: true, sha }),
    );
  } else if (commandName === "wait-quiet") {
    const value = await waitCutoverQuiet(status, stillOwnsBarrier);
    console.log(
      JSON.stringify({ idle: value.idle, draining: true, ready: true, sha }),
    );
  } else if (commandName === "backup") {
    const value = await status();
    if (!value.idle || !value.draining)
      throw new Error("Backup requires quiet production behind the barrier");
    if (!(await stillOwnsBarrier()))
      throw new Error("Maintenance ownership changed; barrier was preserved");
    const Database = createRequire(join(release, "package.json"))(
      "better-sqlite3",
    );
    const database = new Database(runtime.DATABASE_URL, {
      readonly: true,
      fileMustExist: true,
    });
    const backup = join(
      config.root,
      "backups",
      `system-cutover-${sha}-${Date.now()}.db`,
    );
    try {
      await database.backup(backup);
    } finally {
      database.close();
    }
    await fs.chmod(backup, 0o600);
    console.log(JSON.stringify({ backup, sha }));
  } else if (commandName === "ready" || commandName === "release") {
    let value;
    for (
      let attempt = 0;
      attempt < (commandName === "ready" ? 90 : 1);
      attempt++
    ) {
      try {
        value = await status();
        break;
      } catch (error) {
        if (commandName === "release") throw error;
        await pause(1000);
      }
    }
    if (!value?.ready || !value.draining)
      throw new Error(
        "Production failed authenticated readiness behind the barrier",
      );
    if (commandName === "release") {
      const held = JSON.parse(await privateFile(heldPath));
      if (
        !(await releaseMaintenanceBarrier(runtime.DEPLOYMENT_DRAIN_FILE, held))
      )
        throw new Error("Maintenance ownership changed; barrier was preserved");
    }
    console.log(
      JSON.stringify({ ready: true, sha, released: commandName === "release" }),
    );
  } else throw new Error("Invalid internal worker command");
}

async function prepare() {
  if (
    process.getuid() !== SERVICE_UID ||
    process.geteuid() !== SERVICE_UID ||
    !review
  )
    throw new Error(
      "Run prepare as douglasdong with an explicit review directory",
    );
  const original = await ownerFile(configPath);
  const config = convertedConfig(JSON.parse(original));
  if (JSON.parse(original).launchdDomain === "system")
    throw new Error(
      "System services are already configured; use status or reviewed recovery",
    );
  await fs.mkdir(review, { mode: 0o700 }); // Refuse to overwrite an earlier review.
  await fs.mkdir(join(review, "tools"), { mode: 0o700 });
  await fs.writeFile(join(review, "original-config.json"), original, {
    flag: "wx",
    mode: 0o600,
  });
  await jsonOwned(join(review, "new-config.json"), config);
  const files = {};
  for (const name of tools) {
    const contents = await fs.readFile(join(source, name));
    const relative = `tools/${name}`;
    await fs.writeFile(join(review, relative), contents, {
      flag: "wx",
      mode: 0o600,
    });
    files[relative] = digest(contents);
  }
  for (const kind of ["api", "tunnel"]) {
    const contents = servicePlist(kind, config, { system: true });
    const name = `${LABELS[kind]}.plist`;
    await fs.writeFile(join(review, name), contents, {
      flag: "wx",
      mode: 0o600,
    });
    await parsePlist(join(review, name));
    files[name] = digest(contents);
  }
  for (const [name, contents] of [
    ["service-control.sh", serviceControlScript()],
    ["sudoers", serviceSudoers()],
  ]) {
    await fs.writeFile(join(review, name), contents, {
      flag: "wx",
      mode: 0o600,
    });
    files[name] = digest(contents);
  }
  command("/bin/sh", ["-n", join(review, "service-control.sh")]);
  const extra = process.argv[4]
    ? JSON.parse(await ownerFile(resolve(process.argv[4])))
    : { services: [], tools: [], secrets: [] };
  if (
    !Array.isArray(extra.services) ||
    !Array.isArray(extra.tools) ||
    !Array.isArray(extra.secrets)
  )
    throw new Error("Invalid extra-services manifest");
  const extraLabels = [];
  for (const item of extra.services) {
    if (extraLabels.includes(item.label))
      throw new Error("Duplicate extra service");
    const contents = await ownerFile(item.plist);
    await fs.writeFile(join(review, `${item.label}.plist`), contents, {
      flag: "wx",
      mode: 0o600,
    });
    validateExtraPlist(
      await parsePlist(join(review, `${item.label}.plist`)),
      item.label,
    );
    files[`${item.label}.plist`] = digest(contents);
    extraLabels.push(item.label);
  }
  for (const item of extra.tools) {
    if (!PUBLIC_TOOLS.includes(item.name))
      throw new Error(
        "Only the fixed reviewed public Jenkins tools are supported",
      );
    const contents = await fs.readFile(item.source);
    if (item.name === "agent.jar") {
      const expected = (await fs.readFile(`${item.source}.sha256`, "utf8"))
        .trim()
        .split(/\s+/)[0];
      if (!/^[a-f0-9]{64}$/.test(expected) || digest(contents) !== expected)
        throw new Error(
          "Inbound agent JAR differs from the downloaded reviewed SHA256",
        );
    }
    await fs.writeFile(join(review, item.name), contents, {
      flag: "wx",
      mode: 0o600,
    });
    files[item.name] = digest(contents);
  }
  validateSecretHandoffs(extra.secrets);
  const vercel = extra.vercelSource
    ? await prepareVercel(extra.vercelSource, review)
    : null;
  await jsonOwned(join(review, "manifest.json"), {
    version: 1,
    preparedAt: new Date().toISOString(),
    configSha256: digest(original),
    files,
    extraLabels,
    secrets: extra.secrets,
    vercel,
    root: DEPLOY_ROOT,
    user: SERVICE_USER,
    uid: SERVICE_UID,
    excludesPreviewPort: 3100,
    productionPort: 3101,
  });
  console.log(
    JSON.stringify(
      {
        state: "prepared-only",
        review,
        services: [LABELS.api, LABELS.tunnel, ...extraLabels],
        applicationUid: SERVICE_UID,
        next: `sudo '${process.execPath}' '${join(source, "install-system-services.mjs")}' apply '${review}'`,
        warning:
          "apply refuses active work/auth/HTTP; an otherwise idle operator cutover disconnects only the reviewed GUI Tunnel's residual sockets before ten seconds of strict idle; preview3100 is excluded",
      },
      null,
      2,
    ),
  );
}

async function account(name) {
  const home = ACCOUNTS[name];
  const existing = spawnSync(
    "/usr/bin/dscl",
    [".", "-read", `/Users/${name}`],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (existing.status === 0) {
    const fields = Object.fromEntries(
      existing.stdout
        .split("\n")
        .filter((line) => line.includes(": "))
        .map((line) => {
          const i = line.indexOf(": ");
          return [line.slice(0, i), line.slice(i + 2)];
        }),
    );
    const uid = Number(fields.UniqueID);
    if (
      !Number.isInteger(uid) ||
      uid < 400 ||
      uid > 499 ||
      fields.PrimaryGroupID !== String(SERVICE_GID) ||
      fields.NFSHomeDirectory !== home ||
      fields.UserShell !== "/usr/bin/false" ||
      fields.IsHidden !== "1" ||
      fields.Password !== "*" ||
      !fields.AuthenticationAuthority?.includes("DisabledUser")
    )
      throw new Error(
        `Existing ${name} does not match the isolated disabled service account`,
      );
    return uid;
  }
  const occupied = new Set(
    command("/usr/bin/dscl", [".", "-list", "/Users", "UniqueID"])
      .split("\n")
      .map((line) => Number(line.trim().split(/\s+/).at(-1))),
  );
  const uid = Array.from({ length: 100 }, (_, index) => 400 + index).find(
    (value) => !occupied.has(value),
  );
  if (uid === undefined)
    throw new Error(
      "No unused service UID400–499; administrator must choose an account explicitly",
    );
  const record = `/Users/${name}`;
  for (const [key, value] of Object.entries({
    UniqueID: String(uid),
    PrimaryGroupID: String(SERVICE_GID),
    NFSHomeDirectory: home,
    UserShell: "/usr/bin/false",
    Password: "*",
    IsHidden: "1",
    AuthenticationAuthority: ";DisabledUser;",
  }))
    command("/usr/bin/dscl", [".", "-create", record, key, value]);
  return uid;
}
async function chownHome(path, uid) {
  if (!Object.values(ACCOUNTS).includes(path))
    throw new Error(
      "Only isolated new Jenkins/CI homes may be recursively changed",
    );
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  async function walk(next) {
    const stat = await fs.lstat(next);
    if (
      (!stat.isDirectory() && !stat.isFile()) ||
      (stat.isFile() && stat.nlink !== 1) ||
      ![SERVICE_UID, uid, 0].includes(stat.uid)
    )
      throw new Error(`Unsafe entry in isolated service home: ${next}`);
    if (stat.isDirectory())
      for (const name of await fs.readdir(next)) await walk(join(next, name));
    await fs.chown(next, uid, SERVICE_GID);
    if (stat.isDirectory()) await fs.chmod(next, 0o700);
    else await fs.chmod(next, stat.mode & 0o700);
  }
  await walk(path);
}
async function stopJob(domain, label) {
  if (loaded(domain, label)) launch(["bootout", `${domain}/${label}`]);
}
async function portOpen(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value) => {
      socket.destroy();
      done(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1500, () => finish(false));
  });
}
async function httpReady(url) {
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(2000),
        redirect: "manual",
      });
      if (response.ok || response.status === 302) return;
    } catch {
      /* Wait for the dedicated service, without probing external systems. */
    }
    await pause(1000);
  }
  throw new Error(`Service did not become ready: ${new URL(url).pathname}`);
}
const TUNNEL_EXECUTABLE = "/opt/homebrew/bin/cloudflared";
const TUNNEL_OWNERSHIP_ERROR =
  "Dedicated Tunnel process or metrics ownership changed; no replacement Tunnel or API was started";

function tunnelProcess(pid) {
  const result = spawnSync(
    "/bin/ps",
    ["-p", String(pid), "-o", "uid=", "-o", "comm="],
    {
      encoding: "utf8",
      timeout: 5000,
    },
  );
  if (!result.error && result.status === 1 && !result.stdout.trim())
    return null;
  const matched = /^\s*([0-9]+)\s+([^\r\n]+?)\s*$/.exec(result.stdout);
  if (result.error || result.status !== 0 || !matched)
    throw new Error("Cannot inspect the original dedicated Tunnel process");
  return { pid, uid: Number(matched[1]), command: matched[2] };
}

export function tunnelListenerMetadata(stdout) {
  const listeners = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    if (/^p[0-9]+$/.test(line)) listeners.push({ pid: Number(line.slice(1)) });
    else if (listeners.length && /^u[0-9]+$/.test(line))
      listeners.at(-1).uid = Number(line.slice(1));
    else if (listeners.length && line.startsWith("c"))
      listeners.at(-1).command = line.slice(1);
    // lsof emits an fd record even when only process fields were requested.
    else if (listeners.length && /^f[0-9]+$/.test(line)) continue;
    else throw new Error("Cannot inspect dedicated Tunnel metrics ownership");
  }
  return listeners;
}

function tunnelListeners() {
  const result = spawnSync(
    "/usr/sbin/lsof",
    ["-nP", "-iTCP:20241", "-sTCP:LISTEN", "-Fpcu"],
    { encoding: "utf8", timeout: 5000 },
  );
  if (!result.error && result.status === 1 && !result.stdout.trim()) return [];
  if (result.error || result.status !== 0)
    throw new Error("Cannot inspect dedicated Tunnel metrics ownership");
  return tunnelListenerMetadata(result.stdout);
}

function tunnelExitState(identity, domain = gui) {
  return {
    process: tunnelProcess(identity.pid),
    listeners: tunnelListeners(),
    jobLoaded: loaded(domain, LABELS.tunnel),
  };
}

export function dedicatedTunnelExited(identity, snapshot) {
  if (
    !Number.isSafeInteger(identity?.pid) ||
    identity.pid < 1 ||
    identity.uid !== SERVICE_UID ||
    identity.command !== TUNNEL_EXECUTABLE ||
    typeof snapshot?.jobLoaded !== "boolean" ||
    !Array.isArray(snapshot.listeners) ||
    (snapshot.process !== null &&
      (snapshot.process?.pid !== identity.pid ||
        snapshot.process?.uid !== SERVICE_UID ||
        snapshot.process?.command !== TUNNEL_EXECUTABLE)) ||
    snapshot.listeners.some(
      (listener) =>
        listener.pid !== identity.pid ||
        listener.uid !== SERVICE_UID ||
        listener.command !== "cloudflared",
    ) ||
    snapshot.jobLoaded
  )
    throw new Error(TUNNEL_OWNERSHIP_ERROR);
  return snapshot.process === null && snapshot.listeners.length === 0;
}

function captureGuiTunnel(domain = gui, { requireMetrics = true } = {}) {
  if (domain !== gui && domain !== "system")
    throw new Error(TUNNEL_OWNERSHIP_ERROR);
  const output = command("/bin/launchctl", [
    "print",
    `${domain}/${LABELS.tunnel}`,
  ]);
  const pid = Number(/^\s*pid = ([0-9]+)$/m.exec(output)?.[1]);
  const program = /^\s*program = (.+)$/m.exec(output)?.[1];
  if (!Number.isSafeInteger(pid) || pid < 1 || program !== TUNNEL_EXECUTABLE)
    throw new Error(TUNNEL_OWNERSHIP_ERROR);
  const identity = { pid, uid: SERVICE_UID, command: TUNNEL_EXECUTABLE };
  const snapshot = tunnelExitState(identity, domain);
  if (
    program !== TUNNEL_EXECUTABLE ||
    !snapshot.jobLoaded ||
    snapshot.process === null ||
    (requireMetrics && snapshot.listeners.length === 0)
  )
    throw new Error(TUNNEL_OWNERSHIP_ERROR);
  // Use the same strict process/listener ownership check, before bootout too.
  dedicatedTunnelExited(identity, { ...snapshot, jobLoaded: false });
  return {
    ...identity,
    program,
    process: snapshot.process,
    listeners: snapshot.listeners,
  };
}

export async function waitDedicatedTunnelExit(
  identity,
  probe,
  ownsBarrier,
  { sleep = pause, now = () => performance.now(), timeoutMs = 90_000 } = {},
) {
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    if (!(await ownsBarrier()))
      throw new Error("Maintenance ownership changed; barrier was preserved");
    if (dedicatedTunnelExited(identity, await probe())) {
      if (!(await ownsBarrier()))
        throw new Error("Maintenance ownership changed; barrier was preserved");
      return;
    }
    await sleep(1000);
  }
  throw new Error(
    "Old dedicated Tunnel has not exited and released its metrics listener within ninety seconds",
  );
}
async function stillOwnsBarrier() {
  const path = join(DEPLOY_ROOT, "maintenance");
  const stat = await fs.lstat(path).catch(() => null);
  if (!stat?.isFile()) return false;
  const held = JSON.parse(
    (await ownerFile(join(review, "barrier.json"))).toString(),
  );
  return (
    held.owned === true &&
    stat.dev === held.dev &&
    stat.ino === held.ino &&
    (await fs.readFile(path, "utf8")) === held.contents
  );
}
async function waitApiExit(state) {
  if (!Number.isInteger(state?.pid) || state.pid < 1)
    throw new Error(
      "Missing recorded production API process; operator review required",
    );
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      process.kill(state.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await pause(1000);
  }
  throw new Error(
    "Old production API has not exited; no second API was started",
  );
}

async function apply() {
  if (process.getuid() !== 0 || !review)
    throw new Error(
      "apply requires explicit administrator sudo and a prepared review directory",
    );
  const manifest = JSON.parse(await ownerFile(join(review, "manifest.json")));
  if (
    manifest.version !== 1 ||
    manifest.root !== DEPLOY_ROOT ||
    manifest.uid !== SERVICE_UID ||
    manifest.productionPort !== 3101
  )
    throw new Error("Invalid fixed production review");
  for (const [relative, hash] of Object.entries(manifest.files)) {
    if (
      !/^(?:tools\/)?[a-zA-Z0-9.-]+$/.test(relative) ||
      digest(await ownerFile(join(review, relative))) !== hash
    )
      throw new Error("Reviewed source/plist changed; prepare again");
  }
  validateSecretHandoffs(manifest.secrets);
  if (manifest.vercel) await verifyVercel(review, manifest.vercel);
  if (digest(await ownerFile(configPath)) !== manifest.configSha256)
    throw new Error(
      "Production configuration changed since review; prepare again",
    );
  if (
    Number(command("/usr/bin/id", ["-u", SERVICE_USER]).trim()) !==
      SERVICE_UID ||
    Number(command("/usr/bin/id", ["-g", SERVICE_USER]).trim()) !== SERVICE_GID
  )
    throw new Error("Service account identity no longer matches UID501/staff");
  const original = JSON.parse(
    await ownerFile(join(review, "original-config.json")),
  );
  const config = convertedConfig(original);
  if (
    JSON.stringify(config) !==
    JSON.stringify(JSON.parse(await ownerFile(join(review, "new-config.json"))))
  )
    throw new Error(
      "Reviewed configuration does not match the fixed system transition",
    );
  for (const kind of ["api", "tunnel"])
    if (
      (await ownerFile(join(review, `${LABELS[kind]}.plist`))).toString() !==
      servicePlist(kind, config, { system: true })
    )
      throw new Error(
        "API/Tunnel plist differs from the fixed unprivileged policy",
      );
  if (
    (await ownerFile(join(review, "service-control.sh"))).toString() !==
      serviceControlScript() ||
    (await ownerFile(join(review, "sudoers"))).toString() !== serviceSudoers()
  )
    throw new Error(
      "Privileged helper/sudoers differs from the fixed reviewed policy",
    );
  if (
    !loaded(gui, LABELS.api) ||
    loaded("system", LABELS.api) ||
    loaded("system", LABELS.tunnel)
  )
    throw new Error(
      "Expected exactly one existing GUI production API and no system API/Tunnel",
    );
  const oldTunnelLoaded = await validatedGuiTunnel(original);
  if (oldTunnelLoaded) captureGuiTunnel();
  if (!oldTunnelLoaded && (await portOpen(20241)))
    throw new Error(
      "Unmanaged process owns the dedicated Tunnel metrics port; no services were stopped",
    );
  if (await fs.lstat(join(DEPLOY_ROOT, "controller.lock")).catch(() => null))
    throw new Error(
      "Old controller lock exists; retire/wait/review worker recovery before cutover",
    );
  for (const label of manifest.extraLabels) {
    if (!EXTRA_SERVICES[label] || loaded("system", label) || loaded(gui, label))
      throw new Error("Additional service is unknown or already loaded");
    validateExtraPlist(await parsePlist(join(review, `${label}.plist`)), label);
  }
  if (
    manifest.extraLabels.includes("com.douglasdong.agent-platform.jenkins") &&
    (await portOpen(8080))
  )
    throw new Error(
      "Existing foreground Jenkins still owns port8080; stop only that reviewed bootstrap process before apply",
    );
  // The worker only performs authenticated GETs. Refusal here deliberately sits
  // outside recovery: there is nothing to restore and the reviewed hash stays valid.
  return cutoverAfterPreflight(
    () => userWorker("preflight"),
    oldTunnelLoaded,
    () => performCutover(manifest, original, config, oldTunnelLoaded),
  );
}

async function performCutover(manifest, original, config, oldTunnelLoaded) {
  const id = `${Date.now()}-${randomUUID()}`;
  const archive = join(DEPLOY_ROOT, "backups", `launchd-cutover-${id}`);
  await userDirectory(archive);
  await userDirectory(join(archive, "tools"));
  const state = {
    id,
    state: "preflight",
    at: new Date().toISOString(),
    archive,
    services: [],
    events: [],
    previewUntouched: true,
  };
  async function stage(name) {
    state.state = name;
    state.events.push({ state: name, at: new Date().toISOString() });
    await jsonOwned(join(DEPLOY_ROOT, "system-services-state.json"), state);
  }
  const runtimeState = JSON.parse(
    await ownerFile(join(DEPLOY_ROOT, "runtime-state.json")),
  );
  let committed = false;
  let barrier = false,
    oldApiStopped = false,
    oldTunnelStopped = false,
    configChanged = false,
    pollingRetired = false;
  let oldTunnelIdentity;
  const startedExtras = [];
  try {
    await writeOwned(join(archive, "config.json"), await ownerFile(configPath));
    // Retire polling before taking a barrier: its crash-recovery path must never
    // mistake this installer-owned quiet interval for its own interrupted deploy.
    await jsonOwned(configPath, { ...original, deployEnabled: false });
    await stopJob(gui, LABELS.cicd);
    launch(["disable", `${gui}/${LABELS.cicd}`]);
    const pollingPlist = join(
      SERVICE_HOME,
      "Library/LaunchAgents",
      `${LABELS.cicd}.plist`,
    );
    if (await fs.lstat(pollingPlist).catch(() => null)) {
      await ownerFile(pollingPlist);
      await fs.rename(pollingPlist, join(archive, `${LABELS.cicd}.plist`));
    }
    pollingRetired = true;
    if (await fs.lstat(join(DEPLOY_ROOT, "controller.lock")).catch(() => null))
      throw new Error(
        "Polling worker still holds a lock; API remains unchanged",
      );
    await stage("polling-retired");
    await stage("holding-admission-barrier");
    userWorker("hold-admission");
    barrier = true;
    // Only the reviewed dedicated Tunnel is disconnected. The API stays live
    // behind its own admission barrier until every counter is strictly zero.
    if (oldTunnelLoaded) {
      await validatedGuiTunnel(original);
      oldTunnelIdentity = captureGuiTunnel();
      state.oldTunnelPid = oldTunnelIdentity.pid;
      oldTunnelStopped = true;
      await stopJob(gui, LABELS.tunnel);
      await stage("waiting-gui-tunnel-exit");
      await waitDedicatedTunnelExit(
        oldTunnelIdentity,
        () => tunnelExitState(oldTunnelIdentity),
        stillOwnsBarrier,
      );
    }
    await stage("gui-tunnel-disconnected");
    userWorker("wait-quiet", 90_000);
    await stage("production-quiet-ten-seconds");
    state.backup = userWorker("backup", 120_000).backup;
    await stage("backup-complete");
    const identities = {};
    for (const name of new Set(
      manifest.extraLabels
        .map((label) => EXTRA_SERVICES[label])
        .filter((name) => name !== SERVICE_USER),
    )) {
      identities[name] = await account(name);
      await chownHome(ACCOUNTS[name], identities[name]);
    }
    state.identities = identities;
    if (manifest.vercel)
      await installVercel(review, manifest.vercel, rootDirectory);
    for (const name of PUBLIC_TOOLS)
      if (manifest.files[name]) {
        await rootDirectory(CI_TOOLS);
        await writeOwned(
          join(CI_TOOLS, name),
          await ownerFile(join(review, name)),
          0,
          0o644,
        );
      }
    for (const item of manifest.secrets) {
      const uid =
        item.owner === SERVICE_USER ? SERVICE_UID : identities._agentplatformci;
      if (!Number.isInteger(uid))
        throw new Error("Missing isolated CI identity for secret handoff");
      const stat = await fs.lstat(item.source);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.mode & 0o077 ||
        stat.uid !== identities._agentplatformjenkins
      )
        throw new Error(
          "Jenkins agent secret source is not private and owned by the isolated controller",
        );
      const temporary = `${item.destination}.${randomUUID()}.tmp`;
      await fs.copyFile(item.source, temporary, constants.COPYFILE_EXCL);
      await fs.chown(temporary, uid, SERVICE_GID);
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, item.destination);
    }
    // Probe executables as the target service users; never relax Douglas/prod directory permissions.
    for (const label of manifest.extraLabels) {
      const plist = await parsePlist(join(review, `${label}.plist`));
      const uid =
        plist.UserName === SERVICE_USER
          ? SERVICE_UID
          : identities[plist.UserName];
      const result = spawnSync(
        "/usr/bin/test",
        ["-x", plist.ProgramArguments[0]],
        { uid, gid: SERVICE_GID, stdio: "ignore", timeout: 5000 },
      );
      if (result.status !== 0)
        throw new Error(
          `Executable is not traversable by ${plist.UserName}: ${plist.ProgramArguments[0]}`,
        );
    }
    if (identities._agentplatformci) {
      const options = {
        uid: identities._agentplatformci,
        gid: SERVICE_GID,
        stdio: "ignore",
        timeout: 5000,
      };
      if (spawnSync("/usr/bin/test", ["-x", config.node], options).status !== 0)
        throw new Error(
          "Node22 path is not traversable by isolated CI; permissions must be reviewed explicitly",
        );
      for (const path of [
        config.runtimeEnvFile,
        join(DEPLOY_ROOT, "cloudflared.token"),
        join(SERVICE_HOME, "agent-platform/production/platform.db"),
      ])
        if (spawnSync("/usr/bin/test", ["-r", path], options).status === 0)
          throw new Error(
            "Isolated CI can read a production secret/database; cutover refused",
          );
    }
    await stage("privileged-files-reviewed");
    userWorker("gate");
    try {
      await stopJob(gui, LABELS.api);
    } finally {
      // A failed bootout can leave the GUI API running. Do not pretend it was
      // replaced, or run system-service rollback against that original process.
      oldApiStopped = !loaded(gui, LABELS.api);
    }
    if (!oldApiStopped)
      throw new Error(
        "GUI production API was not stopped; no second API was started",
      );
    await waitApiExit(runtimeState);
    for (const kind of ["api", "tunnel"]) {
      launch(["disable", `${gui}/${LABELS[kind]}`]);
      const path = join(
        SERVICE_HOME,
        "Library/LaunchAgents",
        `${LABELS[kind]}.plist`,
      );
      await ownerFile(path);
      await fs.rename(path, join(archive, `${LABELS[kind]}.plist`));
    }
    for (const name of tools) {
      const installed = join(DEPLOY_ROOT, "tools", name);
      const previous = await fs.lstat(installed).catch(() => null);
      if (previous)
        await writeOwned(
          join(archive, "tools", name),
          await ownerFile(installed),
        );
      await writeOwned(installed, await ownerFile(join(review, "tools", name)));
    }
    await userDirectory(join(DEPLOY_ROOT, "tmp"));
    await jsonOwned(configPath, { ...config, deployEnabled: false });
    configChanged = true;
    await rootDirectory("/Library/LaunchDaemons");
    await rootDirectory(dirname(SERVICE_HELPER));
    await rootDirectory(dirname(SUDOERS_FILE));
    await writeOwned(
      SERVICE_HELPER,
      await ownerFile(join(review, "service-control.sh")),
      0,
      0o755,
    );
    const sudoers = await ownerFile(join(review, "sudoers"));
    command("/usr/sbin/visudo", ["-cf", join(review, "sudoers")]);
    await writeOwned(SUDOERS_FILE, sudoers, 0, 0o440);
    for (const label of [LABELS.api, LABELS.tunnel, ...manifest.extraLabels]) {
      await writeOwned(
        systemPlistPath(label),
        await ownerFile(join(review, `${label}.plist`)),
        0,
        0o644,
      );
      state.services.push(label);
    }
    await stage("system-starting");
    command(SERVICE_HELPER, ["api", "start"]);
    userWorker("ready", 120_000);
    command(SERVICE_HELPER, ["tunnel", "start"]);
    await httpReady("http://127.0.0.1:20241/ready");
    const order = [
      "com.douglasdong.agent-platform.build-docker",
      "com.douglasdong.agent-platform.jenkins",
      "com.douglasdong.agent-platform.jenkins-ci-agent",
      "com.douglasdong.agent-platform.jenkins-deploy-agent",
    ];
    for (const label of order.filter((value) =>
      manifest.extraLabels.includes(value),
    )) {
      launch(["enable", `system/${label}`]);
      launch(["bootstrap", "system", systemPlistPath(label)]);
      startedExtras.push(label);
      if (label === "com.douglasdong.agent-platform.jenkins")
        await httpReady("http://127.0.0.1:8080/login");
    }
    await jsonOwned(configPath, config);
    userWorker("release");
    barrier = false;
    committed = true;
    await stage("system-active");
    console.log(
      JSON.stringify(
        {
          state: state.state,
          archive,
          backup: state.backup,
          services: state.services,
          runtimeDomain: "system",
          applicationUid: SERVICE_UID,
          pollingRetired: true,
          previewUntouched: true,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    // A terminated unprivileged worker may have created a barrier before it
    // returned. Recovery still checks the exact token/inode; never unlink blindly.
    barrier ||= Boolean(
      await fs.lstat(join(DEPLOY_ROOT, "maintenance")).catch(() => null),
    );
    state.error = error.message;
    await stage("failed-recovering");
    if (
      oldApiStopped &&
      (committed || !(await stillOwnsBarrier().catch(() => false)))
    ) {
      // Once admission resumed (or ownership changed), users may have created
      // work. Never roll a live service back merely because trace writing failed.
      state.recoveryError =
        "Admission resumed or maintenance ownership changed; live services were preserved for operator review";
      await stage("operator-recovery-required-services-preserved");
      console.error(
        JSON.stringify({
          state: state.state,
          error: state.error,
          recoveryError: state.recoveryError,
          archive,
          previewUntouched: true,
        }),
      );
      process.exitCode = 1;
      return;
    }
    try {
      for (const label of startedExtras.reverse())
        await stopJob("system", label);
      if (oldApiStopped) {
        await stopJob("system", LABELS.api);
        await waitApiExit(
          JSON.parse(await ownerFile(join(DEPLOY_ROOT, "runtime-state.json"))),
        );
        const systemTunnel = loaded("system", LABELS.tunnel)
          ? captureGuiTunnel("system", { requireMetrics: false })
          : null;
        await stopJob("system", LABELS.tunnel);
        if (systemTunnel)
          await waitDedicatedTunnelExit(
            systemTunnel,
            () => tunnelExitState(systemTunnel, "system"),
            stillOwnsBarrier,
          );
        for (const name of tools) {
          const old = join(archive, "tools", name);
          if (await fs.lstat(old).catch(() => null))
            await writeOwned(
              join(DEPLOY_ROOT, "tools", name),
              await ownerFile(old),
            );
        }
        await jsonOwned(configPath, { ...original, deployEnabled: false });
        configChanged = false;
        for (const kind of ["api", "tunnel"]) {
          const old = join(archive, `${LABELS[kind]}.plist`);
          const path = join(
            SERVICE_HOME,
            "Library/LaunchAgents",
            `${LABELS[kind]}.plist`,
          );
          if (await fs.lstat(old).catch(() => null)) await fs.rename(old, path);
          launch(["enable", `${gui}/${LABELS[kind]}`]);
          if ((kind === "api" || oldTunnelLoaded) && !loaded(gui, LABELS[kind]))
            launch(["bootstrap", gui, path]);
        }
      } else {
        if (configChanged)
          await jsonOwned(configPath, { ...original, deployEnabled: false });
        await recoverUnstoppedApi({
          tunnelWasLoaded: oldTunnelLoaded,
          tunnelWasStopped: oldTunnelStopped,
          restartTunnel: async () => {
            await verifyGuiTunnelPlist(original);
            if (!loaded(gui, LABELS.tunnel)) {
              if (
                oldTunnelIdentity &&
                !dedicatedTunnelExited(
                  oldTunnelIdentity,
                  tunnelExitState(oldTunnelIdentity),
                )
              )
                throw new Error(
                  "Original dedicated Tunnel is still exiting; no replacement Tunnel was started",
                );
              launch([
                "bootstrap",
                gui,
                join(
                  SERVICE_HOME,
                  "Library/LaunchAgents",
                  `${LABELS.tunnel}.plist`,
                ),
              ]);
            } else captureGuiTunnel();
            await httpReady("http://127.0.0.1:20241/ready");
          },
          hasBarrier: barrier,
          ready: () => userWorker("ready", 120_000),
          release: () => userWorker("release"),
        });
        barrier = false;
      }
      if (oldApiStopped && barrier) {
        userWorker("ready", 120_000);
        userWorker("release");
        barrier = false;
      }
      await stage(
        pollingRetired
          ? "rolled-back-polling-still-retired"
          : "preflight-refused-services-unchanged",
      );
    } catch (recovery) {
      state.recoveryError = recovery.message;
      await stage("operator-recovery-required");
    }
    console.error(
      JSON.stringify({
        state: state.state,
        error: state.error,
        recoveryError: state.recoveryError,
        archive,
        maintenancePreserved: barrier,
        previewUntouched: true,
      }),
    );
    process.exitCode = 1;
  }
}

async function main() {
  if (
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    process.versions.node.split(".")[0] !== "22"
  )
    throw new Error(
      "Use macOS ARM64 Node22; this installer does not support Linux/root application execution",
    );
  if (action === "internal") await internalWorker();
  else if (action === "preflight") {
    if (!review) throw new Error("Preflight requires a review directory");
    if (process.getuid() === 0)
      console.log(JSON.stringify(userWorker("preflight")));
    else {
      process.argv[4] = "preflight";
      await internalWorker();
    }
  } else if (action === "prepare") await prepare();
  else if (action === "apply") await apply();
  else if (action === "status") {
    const statePath = join(DEPLOY_ROOT, "system-services-state.json");
    const trace = JSON.parse(
      (
        await ownerFile(statePath).catch((error) => {
          if (error.code === "ENOENT")
            return Buffer.from('{"state":"not-yet-applied"}');
          throw error;
        })
      ).toString(),
    );
    console.log(
      JSON.stringify(
        {
          production: Object.fromEntries(
            ["api", "tunnel", "cicd"].map((kind) => [
              kind,
              {
                gui: loaded(gui, LABELS[kind]),
                system: loaded("system", LABELS[kind]),
              },
            ]),
          ),
          jenkins: Object.fromEntries(
            Object.keys(EXTRA_SERVICES).map((label) => [
              label,
              loaded("system", label),
            ]),
          ),
          transition: trace,
          configPath,
          statePath,
          logs: join(DEPLOY_ROOT, "logs"),
          previewUntouched: true,
        },
        null,
        2,
      ),
    );
  } else
    throw new Error(
      "Commands: prepare <new-review-directory> [extra-services.json], preflight <review-directory>, apply <review-directory> (sudo), status",
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
