import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseEnv } from "node:util";

export const REPOSITORY = "Xeonice/agent-platform-api";
export const BRANCH = "feat/design-v2-migration";
export const WORKFLOW = ".github/workflows/ci.yml";
export const JENKINS_JOB = "agent-platform-api";
export const SERVICE_CONTROL_HELPER =
  "/Library/PrivilegedHelperTools/com.douglasdong.agent-platform-service";
export const CI_CHECKS = Object.freeze([
  "install",
  "typecheck",
  "lint",
  "format",
  "default-image",
  "acceptance",
  "provider-fixtures",
  "build",
  "openapi",
  "openapi-drift",
  "sqlite-native",
  "boxlite-native",
]);
export const SHA = /^[a-f0-9]{40}$/;

export function validateConfig(config) {
  if (
    config.repository !== REPOSITORY ||
    config.branch !== BRANCH ||
    config.ciProvider !== "jenkins" ||
    config.jenkinsJob !== JENKINS_JOB
  )
    throw new Error(
      "This installed controller only accepts the configured production channel",
    );
  for (const key of [
    "root",
    "node",
    "corepack",
    "runtimeEnvFile",
    "runtimePlist",
  ]) {
    if (typeof config[key] !== "string" || !isAbsolute(config[key]))
      throw new Error(`Invalid ${key}`);
  }
  if (config.root === "/" || !Number.isInteger(config.uid) || config.uid < 0)
    throw new Error("Invalid service identity");
  if (
    !["system", `gui/${config.uid}`].includes(config.launchdDomain) ||
    (config.launchdDomain === "system" &&
      (config.serviceHelper !== SERVICE_CONTROL_HELPER ||
        config.runtimePlist !==
          "/Library/LaunchDaemons/com.douglasdong.agent-platform.api.plist"))
  )
    throw new Error("Invalid launchd service control");
  if (!["boolean"].includes(typeof config.deployEnabled))
    throw new Error("Invalid deployEnabled");
  if (!Number.isFinite(Date.parse(config.channelStartedAt)))
    throw new Error("Invalid channel start");
  if (config.minimumCommit !== null && !SHA.test(config.minimumCommit))
    throw new Error("Invalid minimumCommit");
  return config;
}

export function jenkinsInvocation(config, action, sha, buildNumber, buildUrl) {
  if (
    !["build", "deploy"].includes(action) ||
    !SHA.test(sha ?? "") ||
    !/^[1-9]\d{0,9}$/.test(String(buildNumber ?? ""))
  )
    throw new Error("Use build|deploy <full SHA> <Jenkins build number>");
  if (
    buildUrl &&
    ![
      `http://127.0.0.1:8080/job/${config.jenkinsJob}/${buildNumber}/`,
      `http://localhost:8080/job/${config.jenkinsJob}/${buildNumber}/`,
    ].includes(buildUrl)
  )
    throw new Error("Invalid local Jenkins build URL");
  return {
    action,
    sha,
    buildNumber: Number(buildNumber),
    buildUrl: buildUrl || null,
  };
}

export function trustedRun(run, head, config, buildNumber) {
  return (
    SHA.test(head) &&
    run?.version === 1 &&
    run.provider === "jenkins" &&
    run.sha === head &&
    run.branch === config.branch &&
    run.repository === config.repository &&
    run.job === config.jenkinsJob &&
    Number.isInteger(buildNumber) &&
    run.buildNumber === buildNumber &&
    run.result === "success" &&
    run.channelStartedAt === config.channelStartedAt &&
    Date.parse(run.completedAt) >= Date.parse(config.channelStartedAt)
  );
}

export function buildEnvironment(node, source = process.env) {
  // Intentionally exclude runtime secrets, shell startup hooks and Node/DYLD injection.
  const result = {
    PATH: `${dirname(node)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    CI: "true",
    HUSKY: "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "en_US.UTF-8",
  };
  for (const key of ["HOME", "TMPDIR"])
    if (source[key]) result[key] = source[key];
  return result;
}

export function runtimeEnvironment(text, config) {
  const runtime = parseEnv(text);
  const allowed = new Set([
    "HOST",
    "PORT",
    "DATA_ROOT",
    "DATABASE_URL",
    "BOXLITE_HOME",
    "API_ALLOWED_ORIGINS",
    "API_TRUST_PROXY",
    "PASSCODE_COOKIE_SECURE",
    "PASSCODE_COOKIE_SECRET",
    "ACCESS_PASSCODE",
    "ACCESS_PASSCODE_ALLOW_LOOPBACK",
    "ACCESS_PASSCODE_AUTO_GENERATE",
    "SANDBOX_RECONCILE_ON_BOOT",
    "DEPLOYMENT_DRAIN_FILE",
    "SANDBOX_DEFAULT_IMAGE",
    "SANDBOX_DEFAULT_IMAGE_BOXLITE",
    "SANDBOX_BOXLITE_REGISTRY",
    "SCHEDULER_HOST_CORES",
    "SCHEDULER_HOST_RAM_MB",
    "SCHEDULER_HOST_DISK_MB",
  ]);
  if (Object.keys(runtime).some((key) => !allowed.has(key)))
    throw new Error("Unsupported runtime environment key");
  if (
    runtime.HOST !== "127.0.0.1" ||
    !/^\d+$/.test(runtime.PORT ?? "") ||
    Number(runtime.PORT) < 1024 ||
    Number(runtime.PORT) > 65535 ||
    ![runtime.DATA_ROOT, runtime.DATABASE_URL, runtime.BOXLITE_HOME].every(
      (p) => p && isAbsolute(p),
    ) ||
    runtime.ACCESS_PASSCODE_ALLOW_LOOPBACK !== "false" ||
    runtime.PASSCODE_COOKIE_SECURE !== "true" ||
    !runtime.ACCESS_PASSCODE ||
    !runtime.PASSCODE_COOKIE_SECRET ||
    runtime.DEPLOYMENT_DRAIN_FILE !== join(config.root, "maintenance")
  )
    throw new Error("Invalid production runtime configuration");
  return runtime;
}

export async function atomicJson(path, value) {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temporary, path);
}

export async function privateFile(path) {
  const stat = await fs.lstat(path);
  if (
    !stat.isFile() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid()
  )
    throw new Error(`Expected owner-only regular file: ${path}`);
  return fs.readFile(path, "utf8");
}

const MAINTENANCE_OWNER = "agent-platform-macmini-controller";
const MAINTENANCE_TOKEN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function readMaintenanceBarrier(path) {
  let handle;
  try {
    handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(handle);
    if (!stat.isFile() || stat.size > 4096) return { owned: false };
    const contents = readFileSync(handle, "utf8");
    let marker;
    try {
      marker = JSON.parse(contents);
    } catch {
      return { owned: false };
    }
    return {
      owned:
        marker?.owner === MAINTENANCE_OWNER &&
        marker.version === 1 &&
        typeof marker.token === "string" &&
        MAINTENANCE_TOKEN.test(marker.token),
      dev: stat.dev,
      ino: stat.ino,
      contents,
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code === "ELOOP") return { owned: false };
    throw error;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

export async function createMaintenanceBarrier(path) {
  const contents = `${JSON.stringify({
    owner: MAINTENANCE_OWNER,
    version: 1,
    token: randomUUID(),
  })}\n`;
  const handle = await fs.open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    const stat = await handle.stat();
    return { owned: true, dev: stat.dev, ino: stat.ino, contents };
  } finally {
    await handle.close();
  }
}

export async function releaseMaintenanceBarrier(path, held) {
  if (!held?.owned) return false;
  // Keep the final ownership check and unlink in one turn, without an async gap.
  const current = readMaintenanceBarrier(path);
  if (
    !current?.owned ||
    current.dev !== held.dev ||
    current.ino !== held.ino ||
    current.contents !== held.contents
  )
    return false;
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function recoverMaintenanceBarrier(
  path,
  { deployEnabled, isReady, stillApproved },
) {
  const held = readMaintenanceBarrier(path);
  if (!held) return { state: "no-maintenance" };
  if (!held.owned) return { state: "manual-maintenance" };
  if (!deployEnabled || !(await stillApproved()))
    return { state: "maintenance-preserved" };
  if (!(await isReady()))
    throw new Error("Interrupted deployment needs operator recovery");
  if (!(await stillApproved())) return { state: "maintenance-preserved" };
  return (await releaseMaintenanceBarrier(path, held))
    ? { state: "maintenance-recovered" }
    : { state: "maintenance-changed" };
}

export function assertNoLiveApi(state) {
  if (state === null) return;
  if (!Number.isInteger(state?.pid) || state.pid < 1)
    throw new Error("Unknown previous API process; operator recovery required");
  try {
    process.kill(state.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw error;
  }
  throw new Error("Previous API still exists; refusing a second API process");
}

export async function withLock(path, work) {
  const token = randomUUID();
  const owner = join(path, "owner.json");
  try {
    await fs.mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let previous;
    try {
      previous = JSON.parse(await fs.readFile(owner, "utf8"));
    } catch {
      return { state: "locked" };
    } // Incomplete/unknown owner is never stolen.
    if (!Number.isInteger(previous.pid) || previous.pid < 1)
      return { state: "locked" };
    try {
      process.kill(previous.pid, 0);
      return { state: "locked" };
    } catch (failure) {
      if (failure.code !== "ESRCH") return { state: "locked" };
    }
    // A dead controller may have left a live compiler. Never steal its lock automatically.
    return { state: "stale-lock-needs-recovery", pid: previous.pid };
  }
  await fs.writeFile(owner, JSON.stringify({ pid: process.pid, token }), {
    mode: 0o600,
  });
  try {
    return await work();
  } finally {
    const current = JSON.parse(
      await fs.readFile(owner, "utf8").catch(() => "{}"),
    );
    if (current.token === token) await fs.rm(path, { recursive: true });
  }
}

export async function migrationsHash(release) {
  const hash = createHash("sha256");
  async function walk(folder, relative = "") {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const next = join(folder, entry.name);
      const name = join(relative, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Migrations cannot contain symlinks");
      if (entry.isDirectory()) await walk(next, name);
      else {
        hash.update(name);
        hash.update("\0");
        hash.update(await fs.readFile(next));
        hash.update("\0");
      }
    }
  }
  await walk(join(release, "drizzle"));
  return hash.digest("hex");
}

export function canRollback(previous, candidate) {
  return Boolean(
    previous &&
    previous.schemaHash === candidate.schemaHash &&
    previous.boxliteVersion === candidate.boxliteVersion &&
    previous.dataRoot === candidate.dataRoot &&
    previous.databaseUrl === candidate.databaseUrl &&
    previous.boxliteHome === candidate.boxliteHome,
  );
}

export async function readyManifest(path, sha) {
  const manifest = JSON.parse(
    await fs.readFile(join(path, ".macmini-release.json"), "utf8"),
  );
  if (
    !SHA.test(sha) ||
    manifest.sha !== sha ||
    manifest.platform !== "darwin" ||
    manifest.arch !== "arm64" ||
    manifest.nodeMajor !== 22 ||
    typeof manifest.boxliteVersion !== "string" ||
    manifest.boxliteVersion.length === 0 ||
    manifest.schemaHash !== (await migrationsHash(path))
  )
    throw new Error("Invalid release manifest");
  await fs.access(join(path, "apps/api/dist/main.js"), constants.R_OK);
  return manifest;
}

function contentHash(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function artifactPath(config, path, sha) {
  if (
    ![
      releasePath(config, sha),
      join(config.root, "ci-workspaces", sha),
    ].includes(path)
  )
    throw new Error("Invalid CI artifact path");
  return path;
}

export function buildArtifactPath(config, sha, activeSha) {
  if (!SHA.test(sha)) throw new Error("Invalid CI candidate SHA");
  return activeSha === sha
    ? join(config.root, "ci-workspaces", sha)
    : releasePath(config, sha);
}

export function jenkinsReceiptPath(config, request) {
  jenkinsInvocation(config, "deploy", request.sha, request.buildNumber);
  return join(
    config.root,
    "jenkins-receipts",
    `${request.sha}-${request.buildNumber}.json`,
  );
}

export async function verifiedArtifact(config, path, sha) {
  artifactPath(config, path, sha);
  const manifest = await readyManifest(path, sha);
  const manifestHash = contentHash(
    await privateFile(join(path, ".macmini-release.json")),
  );
  const contents = await privateFile(join(path, ".macmini-ci.json"));
  const proof = JSON.parse(contents);
  if (
    proof.version !== 1 ||
    proof.provider !== "jenkins" ||
    proof.job !== config.jenkinsJob ||
    proof.repository !== config.repository ||
    proof.branch !== config.branch ||
    proof.sha !== sha ||
    proof.channelStartedAt !== config.channelStartedAt ||
    !(Date.parse(proof.completedAt) >= Date.parse(config.channelStartedAt)) ||
    proof.manifestHash !== manifestHash ||
    JSON.stringify(proof.checks) !== JSON.stringify(CI_CHECKS)
  )
    throw new Error("Artifact has no matching complete Jenkins verification");
  return { ...manifest, path, proofHash: contentHash(contents) };
}

// Only the installed controller calls this after every allowlisted check succeeds.
export async function attestArtifact(config, path, sha) {
  artifactPath(config, path, sha);
  await readyManifest(path, sha);
  await atomicJson(join(path, ".macmini-ci.json"), {
    version: 1,
    provider: "jenkins",
    job: config.jenkinsJob,
    repository: config.repository,
    branch: config.branch,
    sha,
    channelStartedAt: config.channelStartedAt,
    completedAt: new Date().toISOString(),
    manifestHash: contentHash(
      await privateFile(join(path, ".macmini-release.json")),
    ),
    checks: CI_CHECKS,
  });
  return verifiedArtifact(config, path, sha);
}

export async function writeJenkinsReceipt(config, request, candidate) {
  jenkinsInvocation(
    config,
    "build",
    request.sha,
    request.buildNumber,
    request.buildUrl,
  );
  const verified = await verifiedArtifact(config, candidate.path, request.sha);
  const receipt = {
    version: 1,
    provider: "jenkins",
    repository: config.repository,
    branch: config.branch,
    job: config.jenkinsJob,
    buildNumber: request.buildNumber,
    buildUrl: request.buildUrl ?? null,
    sha: request.sha,
    result: "success",
    channelStartedAt: config.channelStartedAt,
    completedAt: new Date().toISOString(),
    artifactPath: verified.path,
    proofHash: verified.proofHash,
  };
  await atomicJson(jenkinsReceiptPath(config, request), receipt);
  return receipt;
}

export async function readJenkinsReceipt(config, request) {
  let receipt;
  try {
    receipt = JSON.parse(
      await privateFile(jenkinsReceiptPath(config, request)),
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!trustedRun(receipt, request.sha, config, request.buildNumber))
    return null;
  jenkinsInvocation(
    config,
    "deploy",
    request.sha,
    request.buildNumber,
    receipt.buildUrl,
  );
  const candidate = await verifiedArtifact(
    config,
    receipt.artifactPath,
    request.sha,
  );
  if (candidate.proofHash !== receipt.proofHash)
    throw new Error("Jenkins verification changed after receipt was recorded");
  return { ...receipt, candidate };
}

export async function runJenkinsBuild(config, operations) {
  const request = operations.request;
  jenkinsInvocation(
    config,
    "build",
    request.sha,
    request.buildNumber,
    request.buildUrl,
  );
  const head = await operations.head();
  if (!SHA.test(head)) throw new Error("Invalid remote head");
  if (request.sha !== head) return { state: "superseded", sha: request.sha };
  if (
    config.minimumCommit &&
    !(await operations.descendsFrom(head, config.minimumCommit))
  )
    return { state: "waiting-channel-commit", sha: head };
  const candidate = await operations.build(head);
  if ((await operations.head()) !== head)
    return { state: "superseded", sha: head };
  await operations.receipt(candidate);
  return {
    state: "ci-passed",
    sha: head,
    runId: request.buildNumber,
    reused: candidate.reused === true,
    artifactPath: candidate.path,
    receiptPath: jenkinsReceiptPath(config, request),
    logPath: candidate.logPath,
    acceptanceReport: join(candidate.path, "acceptance/execution-report.json"),
    acceptanceResults: [
      join(candidate.path, "reports/acceptance/non-protocol.json"),
      join(candidate.path, "reports/acceptance/protocol.json"),
    ],
  };
}

// The deployment decision is shared by the launchd controller and deterministic tests.
export async function runCycle(config, operations) {
  const request = operations.request;
  jenkinsInvocation(
    config,
    "deploy",
    request.sha,
    request.buildNumber,
    request.buildUrl,
  );
  const head = await operations.head();
  if (!SHA.test(head)) throw new Error("Invalid remote head");
  if (request.sha !== head) return { state: "superseded", sha: request.sha };
  const current = await operations.current();
  if (
    config.minimumCommit &&
    !(await operations.descendsFrom(head, config.minimumCommit))
  )
    return { state: "waiting-channel-commit", sha: head };
  const run = await operations.ci(head);
  if (!trustedRun(run, head, config, request.buildNumber))
    return { state: "waiting-ci", sha: head };
  if (current?.sha === head)
    return {
      state: (await operations.healthy(current))
        ? "current"
        : "unhealthy-current-needs-recovery",
      sha: head,
      runId: run.buildNumber,
    };
  const candidate = await operations.build(head);
  if ((await operations.head()) !== head)
    return { state: "superseded", sha: head };
  if (
    !config.deployEnabled ||
    (operations.stillApproved && !(await operations.stillApproved()))
  )
    return { state: "built", sha: head, runId: run.buildNumber };
  if (current && !canRollback(current, candidate))
    return {
      state: "schema-or-data-change-needs-review",
      sha: head,
      runId: run.buildNumber,
    };
  if (current && !(await operations.idle()))
    return { state: "waiting-idle", sha: head };
  await operations.drain();
  let safeToResume = true;
  try {
    if ((await operations.head()) !== head)
      return { state: "superseded", sha: head };
    if (current && !(await operations.idle(true)))
      return { state: "waiting-idle", sha: head };
    if (operations.stillApproved && !(await operations.stillApproved()))
      return { state: "built", sha: head, runId: run.buildNumber };
    safeToResume = false;
    await operations.activate(candidate, current);
    safeToResume = true;
    return { state: "deployed", sha: head, runId: run.buildNumber };
  } catch (error) {
    safeToResume ||= error.rollbackReady === true;
    throw error;
  } finally {
    if (safeToResume) await operations.resume();
  }
}

export async function activateRelease(candidate, previous, operations) {
  await operations.prepare(previous);
  if (previous) await operations.stop();
  try {
    await operations.start(candidate);
  } catch (error) {
    await operations.stop();
    if (canRollback(previous, candidate)) {
      await operations.start(previous);
      error.rollbackReady = true;
    }
    throw error;
  }
}

export function releasePath(config, sha) {
  if (!SHA.test(sha)) throw new Error("Invalid release SHA");
  return resolve(config.root, "releases", sha);
}
