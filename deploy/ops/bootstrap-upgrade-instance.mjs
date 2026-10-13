import * as fs from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  createServer as createTcpServer,
  connect as connectTcp,
} from "node:net";
import {
  invariant,
  digest,
  canonical,
  verifySignedManifest,
  runInputFingerprint,
} from "../upgrade/trust.mjs";
import {
  atomicJson,
  readJson,
  secureDirectory,
  treeManifest,
  inside,
  fileDigest,
} from "../upgrade/io.mjs";
import { createStableEntry } from "../upgrade/stable-entry.mjs";
import { validateBinding } from "../upgrade/stable-entry.mjs";
import { createCandidateSupervisor } from "../upgrade/candidate-supervisor.mjs";
import { createCoordinatorClient } from "../upgrade/coordinator-client.mjs";
import {
  bootstrapDataRoot,
  roleMounts,
  createProductionRoleAdapter,
  execute,
  providerEnvironment,
} from "../upgrade/production-role-adapter.mjs";
export {
  bootstrapDataRoot,
  roleMounts,
  createProductionRoleAdapter,
} from "../upgrade/production-role-adapter.mjs";

const CID = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const BLOCKERS = [
  "sandboxes",
  "agentTasks",
  "automationRuns",
  "enabledAutomations",
  "resourceAllocations",
  "cloningProjects",
  "projectCleanupJobs",
];
const PORTS = [
  "owner",
  "coordinator",
  "apiA",
  "webA",
  "apiB",
  "webB",
  "coordinatorB",
  "coordinatorAppB",
  "ownerB",
  "installerB",
  "controllerMetadata",
  "supervisor",
  "entry",
  "entryControl",
];
const RUNTIME_ENV = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "NODE_USE_ENV_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "LANG",
  "TZ",
];
const AUTH_ENV = [
  "ACCESS_PASSCODE",
  "PASSCODE_COOKIE_SECRET",
  "PASSCODE_COOKIE_SECURE",
  "ACCESS_PASSCODE_AUTO_GENERATE",
  "ACCESS_PASSCODE_ALLOW_LOOPBACK",
  "SESSION_SECRET",
  "AUTH_SECRET",
];

export function assertBootstrapConfig(c) {
  providerEnvironment(c);
  invariant(
    c?.schemaVersion === 1 &&
      ["idle-first-bootstrap", "idle-first-bootstrap-experiment"].includes(
        c.kind,
      ) &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(c.instanceId) &&
      !c.instanceId.startsWith("upgrade-acceptance-"),
    "PRODUCTION_BOOTSTRAP_CONFIG_REQUIRED",
  );
  invariant(
    [
      "root",
      "artifactRoot",
      "businessHostPath",
      "trustRootPath",
      "catalogFile",
      "authEnvPath",
      "cloneReceiptPath",
    ].every((k) => isAbsolute(c[k] || "") && !/[\r\n,]/.test(c[k])),
    "ABSOLUTE_BOOTSTRAP_PATHS_REQUIRED",
  );
  if (c.kind === "idle-first-bootstrap-experiment")
    invariant(
      isAbsolute(c.qualificationInstallationPath || "") &&
        inside(c.root, c.qualificationInstallationPath) &&
        !inside(join(c.root, "business"), c.qualificationInstallationPath) &&
        !inside(join(c.root, "installer"), c.qualificationInstallationPath),
      "EXPERIMENT_QUALIFICATION_PROOF_PATH_REQUIRED",
    );
  invariant(
    c.root !== "/data" &&
      !inside("/data", c.root) &&
      !inside(c.artifactRoot, c.root) &&
      !inside(c.root, c.artifactRoot),
    "BOOTSTRAP_AUTHORITY_PATHS_OVERLAP",
  );
  invariant(
    !inside(c.businessHostPath, c.root) && !inside(c.root, c.businessHostPath),
    "BOOTSTRAP_BUSINESS_PATHS_OVERLAP",
  );
  invariant(
    c.original &&
      CID.test(c.original.containerId) &&
      IMAGE.test(c.original.image) &&
      typeof c.original.startedAt === "string",
    "PINNED_LEGACY_CONTAINER_REQUIRED",
  );
  invariant(
    CID.test(c.foundationContainerId),
    "PINNED_BOOTSTRAP_FOUNDATION_REQUIRED",
  );
  invariant(
    IMAGE.test(c.runtimeImage) &&
      c.docker?.dedicated === true &&
      Array.isArray(c.docker.args) &&
      c.docker.args.every((a) => typeof a === "string" && !/[\r\n]/.test(a)),
    "FIXED_BOOTSTRAP_DOCKER_REQUIRED",
  );
  invariant(
    c.ports &&
      PORTS.every(
        (k) =>
          Number.isInteger(c.ports[k]) && c.ports[k] > 0 && c.ports[k] < 65536,
      ) &&
      new Set(PORTS.map((k) => c.ports[k])).size === PORTS.length,
    "DISTINCT_BOOTSTRAP_PORTS_REQUIRED",
  );
  invariant(
    typeof c.publicOrigin === "string" && /^https?:\/\//.test(c.publicOrigin),
    "PUBLIC_BOOTSTRAP_ORIGIN_REQUIRED",
  );
  const publicUrl = new URL(c.publicOrigin);
  invariant(
    !publicUrl.username &&
      !publicUrl.password &&
      publicUrl.pathname === "/" &&
      !publicUrl.search &&
      !publicUrl.hash,
    "PUBLIC_BOOTSTRAP_ORIGIN_REQUIRED",
  );
  if (c.allowedOrigins !== undefined) {
    invariant(
      Array.isArray(c.allowedOrigins) &&
        c.allowedOrigins.includes(c.publicOrigin),
      "BOOTSTRAP_ALLOWED_ORIGINS_REQUIRED",
    );
    for (const value of c.allowedOrigins) {
      const parsed = new URL(value);
      invariant(
        typeof value === "string" &&
          ["http:", "https:"].includes(parsed.protocol) &&
          parsed.origin === value &&
          !parsed.username &&
          !parsed.password &&
          !parsed.search &&
          !parsed.hash,
        "BOOTSTRAP_ALLOWED_ORIGINS_REQUIRED",
      );
    }
  }
  invariant(
    Object.keys(c.runtimeEnv || {}).every((k) => RUNTIME_ENV.includes(k)),
    "FORBIDDEN_BOOTSTRAP_RUNTIME_AUTHORITY",
  );
  invariant(
    Number.isSafeInteger(c.uid) &&
      c.uid >= 0 &&
      Number.isSafeInteger(c.gid) &&
      c.gid >= 0,
    "FIXED_BOOTSTRAP_USER_REQUIRED",
  );
  return c;
}

export function legacyIdle(value) {
  return (
    value?.ready === true &&
    value.idle === true &&
    value.inFlightHTTP === 0 &&
    value.activeWS === 0 &&
    value.credentialAuth === 0 &&
    BLOCKERS.every((k) => value.blockers?.[k] === 0)
  );
}

export function assertCloneReceipt(c, receipt, { requireStopped = true } = {}) {
  invariant(
    receipt?.kind === "idle-first-bootstrap-clone" &&
      receipt.instanceId === c.instanceId &&
      receipt.businessHostPath === c.businessHostPath &&
      canonical(receipt.original) === canonical(c.original),
    "EXACT_BOOTSTRAP_CLONE_REQUIRED",
  );
  invariant(
    receipt.originalVolumePreserved === true &&
      receipt.originalContainerPreserved === true &&
      receipt.databaseBackupVerified === true &&
      receipt.completeVolumeBackupVerified === true &&
      typeof receipt.backupPath === "string" &&
      isAbsolute(receipt.backupPath),
    "BOOTSTRAP_ROLLBACK_COPY_REQUIRED",
  );
  invariant(
    legacyIdle(receipt.before) &&
      (!requireStopped ||
        (legacyIdle(receipt.beforeStop) &&
          receipt.admissionHeld === true &&
          receipt.oldProcessAbsent === true)),
    "LEGACY_BOOTSTRAP_NOT_IDLE",
  );
  // Destroyed business history is retained. Any extant runtime handle needs a real adoption implementation.
  invariant(
    Number.isSafeInteger(receipt.retainedDestroyedSandboxes) &&
      receipt.retainedDestroyedSandboxes >= 0 &&
      receipt.extantUserRuntimeHandles === 0 &&
      receipt.activeAgentTasks === 0,
    "LEGACY_RUNTIME_ADOPTION_REQUIRED",
  );
  invariant(
    receipt.databaseMigration?.from === 25 &&
      receipt.databaseMigration.to === 28 &&
      receipt.databaseMigration.integrity === "ok" &&
      receipt.databaseMigration.foreignKeyViolations === 0 &&
      receipt.businessRowsPreserved === true &&
      receipt.masterKeyPreserved === true,
    "BOOTSTRAP_DATABASE_MIGRATION_UNVERIFIED",
  );
  invariant(
    IMAGE.test(receipt.cloneDatabaseDigest) &&
      IMAGE.test(receipt.masterKeyDigest),
    "BOOTSTRAP_CLONE_DIGESTS_REQUIRED",
  );
  return receipt;
}

async function privateJson(path) {
  const s = await fs.lstat(path);
  invariant(
    s.isFile() &&
      !s.isSymbolicLink() &&
      (s.mode & 0o077) === 0 &&
      (!process.getuid || s.uid === process.getuid() || s.uid === 0),
    "PRIVATE_BOOTSTRAP_INPUT_REQUIRED",
  );
  return readJson(path);
}

export function verifyReleaseCatalog(roots, catalog) {
  invariant(
    (roots?.purpose || "release") === "release" &&
      roots.schemaVersion === 1 &&
      Array.isArray(roots.keys) &&
      roots.keys.length > 0 &&
      Array.isArray(roots.distributionOrigins) &&
      roots.distributionOrigins.length > 0,
    "PRODUCTION_BOOTSTRAP_TRUST_REQUIRED",
  );
  invariant(
    catalog?.schemaVersion === 1 &&
      catalog.channel === roots.channel &&
      Array.isArray(catalog.releases),
    "PRODUCTION_BOOTSTRAP_CATALOG_REQUIRED",
  );
  for (const row of catalog.releases) {
    const verified = verifySignedManifest(row.envelope, roots);
    invariant(
      verified.purpose === "release" &&
        row.releaseId === verified.manifest.releaseId &&
        row.manifestDigest === verified.manifestDigest,
      "BOOTSTRAP_CATALOG_ROW_MISMATCH",
    );
  }
  return catalog;
}

export function verifyBootstrapCatalog(c, roots, catalog, proof = null) {
  if (c.kind !== "idle-first-bootstrap-experiment")
    return verifyReleaseCatalog(roots, catalog);
  invariant(
    roots?.purpose === "qualification" &&
      roots.schemaVersion === 1 &&
      roots.qualificationInstanceId === c.instanceId &&
      Array.isArray(roots.keys) &&
      roots.keys.length > 0 &&
      Array.isArray(roots.distributionOrigins) &&
      roots.distributionOrigins.length > 0,
    "EXPERIMENT_QUALIFICATION_TRUST_REQUIRED",
  );
  invariant(
    proof?.purpose === "qualification" &&
      proof.instanceId === c.instanceId &&
      proof.trustRootDigest === digest(roots) &&
      proof.isolatedRoot === c.root &&
      bootstrapDataRoot(c) === join(proof.isolatedRoot, "business"),
    "EXPERIMENT_QUALIFICATION_PROOF_MISMATCH",
  );
  invariant(
    catalog?.schemaVersion === 1 &&
      catalog.channel === roots.channel &&
      Array.isArray(catalog.releases),
    "EXPERIMENT_QUALIFICATION_CATALOG_REQUIRED",
  );
  for (const row of catalog.releases) {
    const verified = verifySignedManifest(row.envelope, roots);
    invariant(
      verified.purpose === "qualification" &&
        verified.manifest.qualification.instanceId === c.instanceId &&
        verified.manifest.qualification.inputFingerprint ===
          runInputFingerprint(verified.manifest) &&
        row.releaseId === verified.manifest.releaseId &&
        row.manifestDigest === verified.manifestDigest,
      "EXPERIMENT_QUALIFICATION_CATALOG_MISMATCH",
    );
  }
  return catalog;
}

export function assertFoundationCloneMounts(c, foundation, old) {
  const has = (destination) =>
    foundation.Mounts.some(
      (m) =>
        m.Source === c.businessHostPath &&
        m.Destination === destination &&
        m.RW === true,
    );
  invariant(
    foundation.Id === c.foundationContainerId &&
      foundation.State.Running === true &&
      has("/data") &&
      !foundation.Mounts.some((m) =>
        old.Mounts.some(
          (o) => o.Destination === "/data" && m.Source === o.Source && m.RW,
        ),
      ),
    "BOOTSTRAP_FOUNDATION_CLONE_MOUNT_REQUIRED",
  );
  if (c.kind === "idle-first-bootstrap-experiment")
    invariant(
      has(bootstrapDataRoot(c)),
      "EXPERIMENT_DUAL_CLONE_ALIAS_REQUIRED",
    );
  return foundation;
}

export async function assertExperimentalAliases(c, { stat = fs.lstat } = {}) {
  if (c.kind !== "idle-first-bootstrap-experiment") return;
  for (const name of ["platform.db", ".master.key"]) {
    const [legacy, isolated] = await Promise.all([
      stat(join("/data", name)),
      stat(join(bootstrapDataRoot(c), name)),
    ]);
    invariant(
      legacy.isFile() &&
        isolated.isFile() &&
        !legacy.isSymbolicLink() &&
        !isolated.isSymbolicLink() &&
        legacy.dev === isolated.dev &&
        legacy.ino === isolated.ino &&
        legacy.size === isolated.size,
      "EXPERIMENT_CLONE_ALIAS_PHYSICAL_MISMATCH",
    );
  }
}

export async function verifySealedCloneFiles({
  databasePath = "/data/platform.db",
  masterKeyPath = "/data/.master.key",
  databaseDigest,
  masterKeyDigest,
}) {
  const wal = await fs.lstat(databasePath + "-wal").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  invariant(
    (wal === null ||
      (wal.isFile() && !wal.isSymbolicLink() && wal.size === 0)) &&
      (await fileDigest(databasePath)).digest === databaseDigest &&
      (await fileDigest(masterKeyPath)).digest === masterKeyDigest,
    "BOOTSTRAP_CLONE_CHANGED",
  );
}

export function assertLegacyPhysical(c, old, { requireStopped = false } = {}) {
  invariant(
    old?.Id === c.original.containerId &&
      old.Image === c.original.image &&
      old.State.StartedAt === c.original.startedAt &&
      typeof old.State.Running === "boolean" &&
      Number.isSafeInteger(old.State.Pid) &&
      (old.State.Running ? old.State.Pid > 0 : old.State.Pid === 0),
    "LEGACY_BOOTSTRAP_IDENTITY_CHANGED",
  );
  if (requireStopped)
    invariant(
      old.State.Running === false && old.State.Pid === 0,
      "LEGACY_BOOTSTRAP_PROCESS_STILL_PRESENT",
    );
  invariant(
    !old.Mounts.some((m) => m.Source === c.businessHostPath && m.RW),
    "BOOTSTRAP_WOULD_REUSE_ORIGINAL_VOLUME",
  );
  return old;
}

export function previewProbeOrigin(c) {
  invariant(
    c.kind === "idle-first-bootstrap-experiment",
    "PREVIEW_REQUIRES_EXPLICIT_EXPERIMENT",
  );
  const origin = new URL(
    c.legacyProbeOrigin || c.original.origin || "http://invalid",
  );
  invariant(
    origin.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) &&
      origin.port &&
      origin.pathname === "/" &&
      !origin.username &&
      !origin.password &&
      !origin.search &&
      !origin.hash &&
      !Object.values(c.ports).includes(Number(origin.port)),
    "PREVIEW_LEGACY_LOOPBACK_ORIGIN_REQUIRED",
  );
  return origin.origin;
}

export function assertPreviewSource(c, old, status, receipt) {
  previewProbeOrigin(c);
  assertLegacyPhysical(c, old);
  invariant(
    old.State.Running === true &&
      old.State.Pid > 0 &&
      legacyIdle(status) &&
      status.draining === false &&
      receipt.admissionHeld === false &&
      receipt.oldProcessAbsent === false &&
      receipt.extantUserRuntimeHandles === 0,
    "PREVIEW_SOURCE_NOT_LIVE_IDLE",
  );
  return {
    containerId: old.Id,
    image: old.Image,
    pid: old.State.Pid,
    startedAt: old.State.StartedAt,
    status,
  };
}

async function observePreviewSource(c, verified) {
  const origin = previewProbeOrigin(c);
  const old = JSON.parse(
    await execute(c.docker.cli || "docker", [
      ...c.docker.args,
      "inspect",
      c.original.containerId,
    ]),
  )[0];
  const response = await fetch(origin + "/api/deployment/status", {
    method: "GET",
    headers: {
      Authorization: "Bearer " + verified.authEnv.ACCESS_PASSCODE,
      Origin: c.publicOrigin,
    },
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  invariant(response.ok, "PREVIEW_SOURCE_READ_FAILED");
  const body = await response.json();
  return {
    ...assertPreviewSource(c, old, body.data || body, verified.receipt),
    observedAt: new Date().toISOString(),
    method: "GET",
    path: "/api/deployment/status",
    lifecycleActions: [],
  };
}

export async function verifyBootstrapInputs(
  c,
  { run = execute, requireStopped = false } = {},
) {
  assertBootstrapConfig(c);
  invariant(
    process.platform === "linux" &&
      process.arch === "arm64" &&
      Number(process.versions.node.split(".")[0]) === 22,
    "BOOTSTRAP_LINUX_ARM64_NODE22_REQUIRED",
  );
  const roots = await privateJson(c.trustRootPath);
  const catalog = await privateJson(c.catalogFile);
  let proof = null;
  if (c.kind === "idle-first-bootstrap-experiment") {
    const stat = await fs.lstat(c.qualificationInstallationPath);
    invariant(
      stat.uid === c.uid,
      "EXPERIMENT_QUALIFICATION_PROOF_OWNER_MISMATCH",
    );
    proof = await privateJson(c.qualificationInstallationPath);
  }
  verifyBootstrapCatalog(c, roots, catalog, proof);
  const authEnv = await privateJson(c.authEnvPath);
  invariant(
    Object.keys(authEnv).every((k) => AUTH_ENV.includes(k)) &&
      typeof authEnv.ACCESS_PASSCODE === "string" &&
      authEnv.ACCESS_PASSCODE.length >= 1 &&
      typeof authEnv.PASSCODE_COOKIE_SECRET === "string" &&
      authEnv.PASSCODE_COOKIE_SECRET.length >= 32,
    "PRESERVED_BOOTSTRAP_AUTH_REQUIRED",
  );
  const receipt = assertCloneReceipt(c, await privateJson(c.cloneReceiptPath), {
    requireStopped,
  });
  invariant(
    !receipt.channel || receipt.channel === roots.channel,
    "BOOTSTRAP_CHANNEL_MISMATCH",
  );
  const old = JSON.parse(
    await run(c.docker.cli || "docker", [
      ...c.docker.args,
      "inspect",
      c.original.containerId,
    ]),
  )[0];
  assertLegacyPhysical(c, old, { requireStopped });
  const image = JSON.parse(
    await run(c.docker.cli || "docker", [
      ...c.docker.args,
      "image",
      "inspect",
      c.runtimeImage,
    ]),
  )[0];
  invariant(
    image.Id === c.runtimeImage &&
      image.Os === "linux" &&
      image.Architecture === "arm64" &&
      !(image.Config.Env || []).some((v) =>
        /KEY|SECRET|TOKEN|PASSWORD|PASSCODE|DATABASE|DATA_ROOT|RUNTIME_OWNER_HOME|PLATFORM_/.test(
          v.split("=", 1)[0],
        ),
      ),
    "BOOTSTRAP_RUNTIME_IMAGE_INVALID",
  );
  const foundation = JSON.parse(
    await run(c.docker.cli || "docker", [
      ...c.docker.args,
      "inspect",
      c.foundationContainerId,
    ]),
  )[0];
  assertFoundationCloneMounts(c, foundation, old);
  await assertExperimentalAliases(c);
  const bundle = await readJson(join(c.artifactRoot, "upgrade-artifact.json"));
  const installed = await readJson(join(c.artifactRoot, "installed.json"));
  const files = (await treeManifest(c.artifactRoot)).filter(
    (f) => !["upgrade-artifact.json", "installed.json"].includes(f.path),
  );
  invariant(
    bundle.platform === "linux" &&
      bundle.arch === "arm64" &&
      bundle.nodeMajor === 22 &&
      bundle.treeDigest === digest(files) &&
      canonical(files) === canonical(bundle.files) &&
      canonical(installed.components) === canonical(bundle.components),
    "BOOTSTRAP_PACKAGE_CHANGED",
  );
  invariant(
    ["project", "api", "web"].every((k) =>
      /^[a-f0-9]{40}$/.test(receipt.commits?.[k]),
    ) &&
      bundle.components.api.sourceRevision === receipt.commits.api &&
      bundle.components.web.sourceRevision === receipt.commits.web &&
      bundle.components.installer.sourceRevision === receipt.commits.project,
    "BOOTSTRAP_PINNED_COMMITS_REQUIRED",
  );
  const journal = await readJson(
    join(c.artifactRoot, "api/drizzle/meta/_journal.json"),
  );
  invariant(
    journal.entries.length === receipt.databaseMigration.to,
    "BOOTSTRAP_SCHEMA_MISMATCH",
  );
  await verifySealedCloneFiles({
    databaseDigest: receipt.cloneDatabaseDigest,
    masterKeyDigest: receipt.masterKeyDigest,
  });
  const D = createRequire(join(c.artifactRoot, "api/package.json"))(
    "better-sqlite3",
  );
  const db = new D("/data/platform.db", {
    readonly: true,
    fileMustExist: true,
  });
  try {
    db.exec("PRAGMA query_only=ON");
    invariant(
      db.pragma("quick_check", { simple: true }) === "ok" &&
        db.pragma("foreign_key_check").length === 0 &&
        db.prepare("SELECT count(*) n FROM __drizzle_migrations").get().n ===
          journal.entries.length,
      "BOOTSTRAP_CLONE_DATABASE_INVALID",
    );
    invariant(
      db
        .prepare(
          "SELECT count(*) n FROM sandboxes WHERE status NOT IN ('destroyed','failed')",
        )
        .get().n === 0 &&
        db
          .prepare(
            "SELECT count(*) n FROM sandboxes WHERE status != 'destroyed' AND provider_handle IS NOT NULL",
          )
          .get().n === 0,
      "LEGACY_RUNTIME_ADOPTION_REQUIRED",
    );
    for (const query of [
      "SELECT count(*) n FROM agent_tasks WHERE status='running'",
      "SELECT count(*) n FROM automation_runs WHERE status IN ('pending','running')",
      "SELECT count(*) n FROM automations WHERE enabled=1",
      "SELECT count(*) n FROM resource_allocations WHERE released_at IS NULL",
      "SELECT count(*) n FROM projects WHERE clone_status='cloning'",
      "SELECT count(*) n FROM sandbox_project_cleanup_jobs",
    ])
      invariant(
        db.prepare(query).get().n === 0,
        "BOOTSTRAP_CLONE_HAS_LIVE_WORK",
      );
    for (const row of db.prepare("SELECT baseline_path FROM projects").all())
      if (row.baseline_path !== null)
        invariant(
          typeof row.baseline_path === "string" &&
            inside("/data", row.baseline_path) &&
            (await fs.realpath(row.baseline_path)) === row.baseline_path &&
            (await fs.stat(row.baseline_path)).isDirectory(),
          "BOOTSTRAP_PROJECT_PATH_CHANGED",
        );
  } finally {
    db.close();
  }
  return { bundle, authEnv, receipt, roots };
}

async function waitFor(origin, path, headers = {}, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin + path, {
        headers,
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) return response;
    } catch {
      /* Preserve actual startup failure in each owned container's logs. */
    }
    await new Promise((ok) => setTimeout(ok, 100));
  }
  invariant(false, "BOOTSTRAP_ROLE_NOT_READY");
}

/** First installation only. The operator supplies a stopped, backed-up, verified clone.
 * This never drains/stops/removes the original container or writes its volume. Failed
 * startup retains the new containers and its journal for explicit operator recovery. */
async function createFoundation(
  c,
  {
    paths,
    keys,
    verified,
    origin,
    bindingPath,
    ownerBindingPath,
    installedReleasePath,
    release,
    initialBinding = null,
  },
) {
  const common = {
    NODE_ENV: "production",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    PLATFORM_INSTANCE_ID: c.instanceId,
    HOST: "127.0.0.1",
    ...c.runtimeEnv,
  };
  const network = {
    API_ALLOWED_ORIGINS: (c.allowedOrigins || [c.publicOrigin]).join(","),
  };
  const controlEnv = {
    ...network,
    PLATFORM_INSTANCE_ID: c.instanceId,
    PLATFORM_CONTROL_RPC_KEY: keys.control,
    COORDINATOR_RPC_URL: origin("coordinator"),
    PLATFORM_COORDINATOR_BINDING_PATH: bindingPath,
  };
  const ownerEnv = {
    PLATFORM_INSTANCE_ID: c.instanceId,
    PLATFORM_COORDINATOR_RPC_KEY: keys.owner,
    SANDBOX_DEFAULT_PROVIDER: "boxlite",
  };
  const coordinatorEnv = {
    ...verified.authEnv,
    ...network,
    PLATFORM_INSTANCE_ID: c.instanceId,
    PLATFORM_CONTROL_RPC_KEY: keys.control,
    PLATFORM_CONTROLLER_RPC_KEY: keys.controller,
    PLATFORM_COORDINATOR_RPC_KEY: keys.owner,
    PLATFORM_COORDINATOR_BINDING_PATH: bindingPath,
    PLATFORM_RUNTIME_OWNER_BINDING_PATH: ownerBindingPath,
    COORDINATOR_RPC_URL: origin("coordinator"),
    RUNTIME_OWNER_RPC_URL: origin("owner"),
    DATA_ROOT: bootstrapDataRoot(c),
    DATABASE_URL: "/data/platform.db",
    MIGRATIONS_DIR: join(c.artifactRoot, "api/drizzle"),
    UPGRADE_ADMIN_KEY: keys.upgrade,
    UPGRADE_SESSION_SECRET: keys.upgradeSession,
    UPGRADE_TRUST_ROOT_PATH: c.trustRootPath,
    UPGRADE_CATALOG_FILE: c.catalogFile,
    UPGRADE_INITIAL_RELEASE_PATH: installedReleasePath,
    UPGRADE_INITIAL_ARTIFACT_ROOT: c.artifactRoot,
    UPGRADE_INSTALLER_ROOT: paths.installer,
    PLATFORM_ENTRY_ORIGIN: origin("entry"),
    PLATFORM_ENTRY_CONTROL_ORIGIN: origin("entryControl"),
    PLATFORM_ENTRY_CONTROL_KEY: keys.entry,
    PLATFORM_INSTALLER_SUPERVISOR_ORIGIN: origin("supervisor"),
    PLATFORM_INSTALLER_SUPERVISOR_KEY: keys.supervisor,
    SANDBOX_DEFAULT_PROVIDER: "boxlite",
    ...(c.kind === "idle-first-bootstrap-experiment"
      ? {
          UPGRADE_QUALIFICATION_INSTALLATION_PATH:
            c.qualificationInstallationPath,
        }
      : {}),
  };
  const coordinator = createCoordinatorClient({
    origin: origin("coordinator"),
    instanceId: c.instanceId,
    key: keys.controller,
    bindingPath,
  });
  const controllerConfig = {
    root: paths.installer,
    instanceId: c.instanceId,
    controllerId: "instance-controller",
    trustRootPath: c.trustRootPath,
    coordinatorOrigin: origin("coordinator"),
    coordinatorBindingPath: bindingPath,
    controllerKey: keys.controller,
    entryOrigin: origin("entryControl"),
    entryKey: keys.entry,
    supervisorOrigin: origin("supervisor"),
    supervisorKey: keys.supervisor,
    controllerMetadataPort: ports.controllerMetadata,
  };
  const adapter = await createProductionRoleAdapter(c);
  const supervisor = await createCandidateSupervisor({
    root: paths.installer,
    instanceId: c.instanceId,
    key: keys.supervisor,
    coordinator,
    controlEnv,
    coordinatorEnv,
    ownerEnv,
    runtimeEnv: c.runtimeEnv || {},
    runtimeOwnerRoot: paths.futureOwners,
    publicationRoot: join(root, "supervisor-publication"),
    apiPort: ports.apiB,
    webPort: ports.webB,
    coordinatorPort: ports.coordinatorB,
    coordinatorAppPort: ports.coordinatorAppB,
    ownerPort: ports.ownerB,
    installerPort: ports.installerB,
    installerConfig: controllerConfig,
    initialInstallerOrigin: origin("controllerMetadata"),
    port: ports.supervisor,
    launchAdapter: adapter,
  });
  const entry = await createStableEntry({
    root: paths.entry,
    instanceId: c.instanceId,
    controlKey: keys.entry,
    stickyKey: keys.sticky,
    port: ports.entry,
    controlPort: ports.entryControl,
    verifyFence: ({ attemptId, fence }) =>
      coordinator.assertFence(attemptId, fence),
    verifyContractFence: ({ contractAttemptId, fence }) =>
      coordinator.assertContractFence(contractAttemptId, fence),
    initialBinding: initialBinding || {
      instanceId: c.instanceId,
      fence: 1,
      routeGeneration: 1,
      attemptId: "initial",
      weight: 0,
      oldApi: {
        origin: origin("apiA"),
        digest: release.components.api.artifactDigest,
      },
      candidateApi: null,
      web: {
        origin: origin("webA"),
        root: paths.web,
        digest: release.components.web.artifactDigest,
        treeDigest: verified.bundle.treeDigest,
      },
      retainedWeb: [],
    },
  });
  return { common, coordinator, controllerConfig, adapter, supervisor, entry };
}

async function startBootstrap(c, { mode }) {
  invariant(["start", "preview"].includes(mode), "BOOTSTRAP_MODE_REQUIRED");
  if (mode === "preview") previewProbeOrigin(c);
  const verified = await verifyBootstrapInputs(c, {
    requireStopped: mode !== "preview",
  });
  const previewBefore =
    mode === "preview" ? await observePreviewSource(c, verified) : null;
  const root = await secureDirectory(c.root);
  await fs.writeFile(
    join(root, "startup-intent.json"),
    JSON.stringify({
      instanceId: c.instanceId,
      original: c.original,
      artifactTreeDigest: verified.bundle.treeDigest,
      mode,
      startedAt: new Date().toISOString(),
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  const paths = {};
  for (const [name, folder] of Object.entries({
    owner: "original-owner",
    futureOwners: "future-owners",
    installer: "installer",
    bindings: "bindings",
    logs: "logs",
    web: "initial-web-code",
    entry: "entry",
  }))
    paths[name] = await secureDirectory(join(root, folder));
  for (const folder of ["artifacts", "journals", "downloads"])
    await secureDirectory(join(paths.installer, folder));
  await secureDirectory("/data/workspaces");
  const keys = Object.fromEntries(
    [
      "owner",
      "control",
      "controller",
      "entry",
      "sticky",
      "upgrade",
      "supervisor",
      "upgradeSession",
    ].map((k) => [k, randomBytes(32).toString("hex")]),
  );
  await atomicJson(join(root, "installation-keys.json"), keys);
  const ports = c.ports,
    origin = (k) => `http://127.0.0.1:${ports[k]}`;
  const bindingPath = join(paths.bindings, "coordinator.json"),
    ownerBindingPath = join(paths.bindings, "owners.json");
  const release = {
    releaseId: verified.bundle.releaseId,
    channel: verified.roots.channel,
    activationGeneration: 1,
    activatedAt: new Date().toISOString(),
    schema: verified.receipt.databaseMigration.to,
    components: verified.bundle.components,
    commits: verified.receipt.commits,
    productionWebBinding: c.publicOrigin,
  };
  invariant(
    release.commits &&
      Object.values(release.commits).every((v) => /^[a-f0-9]{40}$/.test(v)),
    "BOOTSTRAP_PINNED_COMMITS_REQUIRED",
  );
  await atomicJson(bindingPath, {
    instanceId: c.instanceId,
    state: "ready",
    origin: origin("coordinator"),
    generation: 1,
    artifactDigest: release.components.coordinator.artifactDigest,
  });
  await atomicJson(ownerBindingPath, {
    instanceId: c.instanceId,
    activeOwnerId: "original-owner",
    owners: [
      {
        ownerId: "original-owner",
        endpoint: origin("owner"),
        ...release.components.owner,
      },
    ],
  });
  const installedReleasePath = join(paths.bindings, "installed-release.json");
  await atomicJson(installedReleasePath, {
    release,
    artifactRoot: c.artifactRoot,
  });
  const { common, coordinator, controllerConfig, adapter, supervisor, entry } =
    await createFoundation(c, {
      paths,
      keys,
      verified,
      origin,
      bindingPath,
      ownerBindingPath,
      installedReleasePath,
      release,
    });
  const containers = {},
    apiRoot = join(c.artifactRoot, "api"),
    roles = join(apiRoot, "apps/api/dist/roles");
  async function launch(name, kind, entryPath, env, cwd = apiRoot, extra = {}) {
    const startIdentity = randomUUID();
    const record = {
      kind,
      instanceId: c.instanceId,
      startIdentity,
      artifactRoot: c.artifactRoot,
      ...extra.record,
    };
    containers[name] = await adapter.launch({
      kind,
      entry: entryPath,
      args: [entryPath, ...(extra.args || [])],
      env: {
        ...common,
        ...env,
        PLATFORM_PROCESS_START_IDENTITY: startIdentity,
      },
      cwd,
      artifactRoot: c.artifactRoot,
      ownerHome: extra.ownerHome,
      record,
    });
    await atomicJson(
      join(paths.logs, name + ".identity.json"),
      containers[name],
    );
    return { ...containers[name], ...record, pid: 1 };
  }
  const owner = await launch(
    "owner",
    "owner",
    join(roles, "runtime-owner-main.js"),
    {
      ...ownerEnv,
      PLATFORM_PROCESS_ROLE: "runtime-owner",
      PLATFORM_ARTIFACT_DIGEST: release.components.owner.artifactDigest,
      RUNTIME_OWNER_ID: "original-owner",
      RUNTIME_OWNER_PORT: String(ports.owner),
      RUNTIME_OWNER_HOME: paths.owner,
      BOXLITE_HOME: join(paths.owner, "boxlite"),
      HOME: paths.owner,
    },
    apiRoot,
    { ownerHome: paths.owner },
  );
  await waitFor(origin("owner"), "/runtime/metadata", {
    "x-platform-internal-key": keys.owner,
    "x-platform-instance-id": c.instanceId,
  });
  await supervisor.registerInstalledRole({
    ...owner,
    origin: origin("owner"),
    ownerId: "original-owner",
    ownerHome: paths.owner,
    ...release.components.owner,
  });
  const coor = await launch(
    "coordinator",
    "coordinator",
    join(roles, "coordinator-main.js"),
    {
      ...coordinatorEnv,
      PLATFORM_PROCESS_ROLE: "coordinator",
      PORT: String(ports.coordinator),
      PLATFORM_ARTIFACT_DIGEST: release.components.coordinator.artifactDigest,
    },
  );
  await waitFor(origin("coordinator"), "/api/health");
  await supervisor.registerInstalledRole({
    ...coor,
    origin: origin("coordinator"),
    metadataPath: "/internal/application/identity",
    ...release.components.coordinator,
  });
  await launch("apiA", "api", join(roles, "control-api-main.js"), {
    ...controlEnv,
    PLATFORM_PROCESS_ROLE: "control",
    PORT: String(ports.apiA),
    PLATFORM_ARTIFACT_DIGEST: release.components.api.artifactDigest,
  });
  await waitFor(origin("apiA"), "/api/health");
  await fs.cp(join(c.artifactRoot, "web"), paths.web, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  await secureDirectory(join(paths.web, ".next/cache"));
  await launch(
    "webA",
    "web",
    join(paths.web, "server.js"),
    {
      PORT: String(ports.webA),
      HOSTNAME: "127.0.0.1",
      PLATFORM_ARTIFACT_DIGEST: release.components.web.artifactDigest,
    },
    paths.web,
  );
  await waitFor(origin("webA"), "/web-build");
  const initialWebProcess = await (
    await waitFor(origin("webA"), "/web-process")
  ).json();
  invariant(
    initialWebProcess.instanceId === c.instanceId &&
      initialWebProcess.artifactDigest ===
        release.components.web.artifactDigest &&
      initialWebProcess.startIdentity === containers.webA.startIdentity &&
      initialWebProcess.webRevision === release.components.web.webRevision,
    "BOOTSTRAP_WEB_PROCESS_IDENTITY_MISMATCH",
  );
  const startIdentity = randomUUID(),
    controllerPath = join(paths.installer, "controller-config.json");
  await atomicJson(controllerPath, { ...controllerConfig, startIdentity });
  containers.installer = await adapter.launch({
    kind: "installer",
    entry: join(c.artifactRoot, "installer/controller-main.mjs"),
    args: [
      join(c.artifactRoot, "installer/controller-main.mjs"),
      controllerPath,
    ],
    env: { NODE_ENV: "production", PATH: common.PATH, ...c.runtimeEnv },
    cwd: join(c.artifactRoot, "installer"),
    artifactRoot: c.artifactRoot,
    record: { startIdentity },
  });
  const installer = await (
    await waitFor(origin("controllerMetadata"), "/metadata", {
      "x-platform-internal-key": keys.controller,
    })
  ).json();
  invariant(
    installer.instanceId === c.instanceId &&
      installer.startIdentity === startIdentity &&
      installer.artifactDigest ===
        release.components.installer.artifactDigest &&
      installer.inputFingerprint ===
        release.components.installer.inputFingerprint,
    "BOOTSTRAP_INSTALLER_IDENTITY_MISMATCH",
  );
  const bootstrapped = await fetch(
    origin("coordinator") + "/internal/upgrades/bootstrap",
    {
      method: "POST",
      headers: {
        "x-platform-internal-key": keys.controller,
        "x-platform-instance-id": c.instanceId,
      },
      signal: AbortSignal.timeout(120000),
    },
  );
  invariant(bootstrapped.ok, "BOOTSTRAP_PHYSICAL_ACTIVATION_FAILED");
  const confirmed = await bootstrapped.json();
  invariant(
    confirmed.releaseId === release.releaseId &&
      confirmed.activationGeneration === 1,
    "BOOTSTRAP_ACTIVATION_RECEIPT_UNKNOWN",
  );
  const previewAfter =
    mode === "preview" ? await observePreviewSource(c, verified) : null;
  if (previewBefore)
    invariant(
      previewAfter.containerId === previewBefore.containerId &&
        previewAfter.image === previewBefore.image &&
        previewAfter.pid === previewBefore.pid &&
        previewAfter.startedAt === previewBefore.startedAt,
      "PREVIEW_ORIGINAL_PROCESS_CHANGED",
    );
  const upgradeStatusResponse = await fetch(
    origin("apiA") + "/api/system/upgrade/status",
    {
      method: "GET",
      headers: {
        Authorization: "Bearer " + verified.authEnv.ACCESS_PASSCODE,
        Origin: c.publicOrigin,
      },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    },
  );
  invariant(upgradeStatusResponse.ok, "BOOTSTRAP_UPGRADE_STATUS_UNAVAILABLE");
  const statusBody = await upgradeStatusResponse.json(),
    upgradeStatus = statusBody.data || statusBody;
  invariant(
    upgradeStatus.instanceId === c.instanceId &&
      upgradeStatus.serviceState === "confirmed" &&
      upgradeStatus.confirmedServiceRelease?.releaseId === release.releaseId,
    "BOOTSTRAP_UPGRADE_STATUS_UNCONFIRMED",
  );
  const result = {
    schemaVersion: 1,
    state: mode === "preview" ? "preview-ready" : "confirmed",
    mode,
    qualified: false,
    productionRouteSwitched: false,
    instanceId: c.instanceId,
    root,
    initialArtifactRoot: c.artifactRoot,
    businessHostPath: c.businessHostPath,
    original: c.original,
    originalContainerPreserved: true,
    originalVolumePreserved: true,
    bootstrapMaintenanceRequired: mode !== "preview",
    installationPurpose:
      c.kind === "idle-first-bootstrap-experiment"
        ? "qualification"
        : "release",
    qualificationOnly: c.kind === "idle-first-bootstrap-experiment",
    modelQualityQualified: false,
    ...(previewBefore
      ? {
          previewSource: { before: previewBefore, after: previewAfter },
          sourceAdmissionHeld: false,
          originalProcessPreserved: true,
        }
      : {}),
    subsequentUpgradeTrigger: "user",
    entryOrigin: entry.origin,
    publicOrigin: c.publicOrigin,
    ports,
    containers,
    release: confirmed,
    recordedAt: new Date().toISOString(),
  };
  await atomicJson(join(root, "bootstrap-result.json"), result);
  return { result, entry, supervisor, adapter };
}

export const startProductionBootstrap = (c) =>
  startBootstrap(c, { mode: "start" });
export const previewExperimentalBootstrap = (c) =>
  startBootstrap(c, { mode: "preview" });

export function assertWebRepairPhysical(c, bootstrap, binding, before) {
  invariant(
    bootstrap.instanceId === c.instanceId &&
      bootstrap.state === "preview-ready" &&
      bootstrap.qualificationOnly === true &&
      binding.instanceId === c.instanceId &&
      binding.attemptId === "initial" &&
      binding.weight === 0 &&
      binding.web.root === join(c.root, "initial-web-code") &&
      binding.web.digest === bootstrap.release.components.web.artifactDigest &&
      binding.web.origin === `http://127.0.0.1:${c.ports.webA}`,
    "REPAIR_REQUIRES_UNUPGRADED_PREVIEW_WEB",
  );
  invariant(
    before.containerId === bootstrap.containers.webA.containerId &&
      before.role === "web" &&
      before.imageDigest === c.runtimeImage &&
      before.startIdentity === bootstrap.containers.webA.startIdentity &&
      before.startedAt === bootstrap.containers.webA.startedAt &&
      before.running === true &&
      before.entrypoint.length === 1 &&
      before.entrypoint[0] === "/usr/local/bin/node" &&
      before.command.length === 1 &&
      before.command[0] === join(binding.web.root, "server.js"),
    "REPAIR_WEB_PHYSICAL_IDENTITY_CHANGED",
  );
}

export async function repairBootstrapWeb(c) {
  assertBootstrapConfig(c);
  invariant(
    c.kind === "idle-first-bootstrap-experiment",
    "REPAIR_REQUIRES_EXPLICIT_EXPERIMENT",
  );
  const root = c.root,
    bootstrap = await privateJson(join(root, "bootstrap-result.json"));
  const binding = await privateJson(join(root, "entry/entry-binding.json"));
  const adapter = await createProductionRoleAdapter(c);
  const before = await adapter.inspect(bootstrap.containers.webA.containerId);
  assertWebRepairPhysical(c, bootstrap, binding, before);
  const artifact = await readJson(
    join(c.artifactRoot, "upgrade-artifact.json"),
  );
  invariant(
    canonical(artifact.components.web) ===
      canonical(bootstrap.release.components.web),
    "REPAIR_WEB_ARTIFACT_CHANGED",
  );
  const expected = artifact.files
    .filter(
      (f) =>
        f.path.startsWith("web/") && !f.path.startsWith("web/.next/cache/"),
    )
    .map((f) => ({ ...f, path: f.path.slice(4) }));
  const actual = (await treeManifest(binding.web.root)).filter(
    (f) => !f.path.startsWith(".next/cache/"),
  );
  invariant(
    canonical(expected) === canonical(actual),
    "REPAIR_WEB_CODE_CHANGED",
  );
  const origin = binding.web.origin,
    observed = await (await waitFor(origin, "/web-process")).json();
  invariant(
    observed.instanceId === c.instanceId &&
      observed.startIdentity === before.startIdentity &&
      observed.webRevision === bootstrap.release.components.web.webRevision &&
      observed.artifactDigest === null,
    "REPAIR_WEB_MISSING_DIGEST_NOT_OBSERVED",
  );
  const recordPath = join(root, "web-identity-repair.json");
  await fs.writeFile(
    recordPath,
    JSON.stringify({
      state: "intent",
      instanceId: c.instanceId,
      before,
      createdAt: new Date().toISOString(),
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  const stopped = await adapter.signal(before.containerId, "SIGTERM");
  invariant(
    stopped.running === false && stopped.hostPid === 0,
    "REPAIR_WEB_STOP_UNCONFIRMED",
  );
  const startIdentity = randomUUID(),
    entry = join(binding.web.root, "server.js");
  const env = {
    NODE_ENV: "production",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    ...c.runtimeEnv,
    PLATFORM_INSTANCE_ID: c.instanceId,
    PLATFORM_ARTIFACT_DIGEST: bootstrap.release.components.web.artifactDigest,
    PLATFORM_PROCESS_START_IDENTITY: startIdentity,
    PORT: String(c.ports.webA),
    HOSTNAME: "127.0.0.1",
  };
  const after = await adapter.launch({
    kind: "web",
    args: [entry],
    entry,
    cwd: binding.web.root,
    artifactRoot: c.artifactRoot,
    record: { startIdentity },
    env,
  });
  const identity = await (await waitFor(origin, "/web-process")).json();
  invariant(
    identity.instanceId === c.instanceId &&
      identity.startIdentity === startIdentity &&
      identity.artifactDigest ===
        bootstrap.release.components.web.artifactDigest &&
      identity.webRevision === bootstrap.release.components.web.webRevision,
    "REPAIR_WEB_NEW_IDENTITY_UNCONFIRMED",
  );
  invariant(
    canonical(binding) ===
      canonical(await privateJson(join(root, "entry/entry-binding.json"))),
    "REPAIR_WEB_BINDING_CHANGED",
  );
  const retained = {
    ...bootstrap,
    containers: { ...bootstrap.containers, webA: after },
    webIdentityRepairedAt: new Date().toISOString(),
  };
  await atomicJson(join(root, "bootstrap-result.json"), retained);
  await atomicJson(join(root, "logs/webA.identity.json"), after);
  const result = {
    state: "repaired",
    instanceId: c.instanceId,
    artifactDigest: bootstrap.release.components.web.artifactDigest,
    codeUnchanged: true,
    before,
    stopped,
    after,
    originalProcessesPreserved: true,
    ownerRestarted: false,
    recordedAt: new Date().toISOString(),
  };
  await atomicJson(recordPath, result);
  return result;
}

export function assertOwnedResumeRole(c, kind, metadata, record, physical) {
  invariant(
    record?.instanceId === c.instanceId &&
      record.kind === kind &&
      record.containerId === physical.containerId &&
      record.startIdentity === metadata.startIdentity &&
      record.startIdentity === physical.startIdentity &&
      record.startedAt === physical.startedAt &&
      physical.running === true &&
      physical.hostPid > 0 &&
      physical.imageDigest === c.runtimeImage &&
      physical.role === kind &&
      physical.pidNamespace === "private" &&
      physical.network === "host" &&
      metadata.instanceId === c.instanceId &&
      metadata.pid === 1 &&
      typeof metadata.artifactDigest === "string",
    "RESUME_OWNED_ROLE_CHANGED",
  );
  invariant(
    canonical(record.entrypoint) === canonical(physical.entrypoint) &&
      canonical(record.command) === canonical(physical.command) &&
      canonical(
        [...record.mounts].sort(
          (a, b) =>
            a.destination.localeCompare(b.destination) ||
            a.source.localeCompare(b.source),
        ),
      ) ===
        canonical(
          [...physical.mounts].sort(
            (a, b) =>
              a.destination.localeCompare(b.destination) ||
              a.source.localeCompare(b.source),
          ),
        ),
    "RESUME_PHYSICAL_PROCESS_CHANGED",
  );
  const role = {
    owner: "runtime-owner",
    api: "control",
    installer: "installer",
    web: undefined,
  }[kind];
  if (role) invariant(metadata.role === role, "RESUME_ROLE_METADATA_MISMATCH");
  if (kind === "coordinator")
    invariant(
      ["coordinator", "coordinator-prepared"].includes(metadata.role) &&
        metadata.writerFenceValid === true,
      "RESUME_UNIQUE_WRITER_UNKNOWN",
    );
  if (kind === "api")
    invariant(
      metadata.controlOnly === true &&
        metadata.noRuntimeSideEffects === true &&
        metadata.writerFenceValid === true,
      "RESUME_CONTROL_AUTHORITY_UNKNOWN",
    );
}

async function observeOwnedResumeRoles(
  c,
  { binding, keys, adapter, ownerBinding, coordinatorBinding },
) {
  const directory = join(c.root, "supervisor-container-records"),
    records = [];
  for (const name of await fs.readdir(directory))
    if (/^[a-f0-9]{64}\.json$/.test(name))
      records.push(await privateJson(join(directory, name)));
  async function observe(kind, origin, path, key, expectedDigest = null) {
    const response = await fetch(origin + path, {
      headers: key
        ? {
            "x-platform-internal-key": key,
            "x-platform-instance-id": c.instanceId,
          }
        : {},
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    invariant(response.ok, "RESUME_ROLE_METADATA_UNAVAILABLE");
    const metadata = await response.json(),
      record = records.find(
        (r) => r.kind === kind && r.startIdentity === metadata.startIdentity,
      );
    invariant(record, "RESUME_ROLE_NOT_REGISTERED");
    const physical = await adapter.inspect(record.containerId);
    assertOwnedResumeRole(c, kind, metadata, record, physical);
    if (expectedDigest)
      invariant(
        metadata.artifactDigest === expectedDigest,
        "RESUME_ARTIFACT_IDENTITY_CHANGED",
      );
    return { kind, metadata, physical };
  }
  invariant(
    ownerBinding.instanceId === c.instanceId &&
      ownerBinding.owners?.length > 0 &&
      coordinatorBinding.instanceId === c.instanceId &&
      coordinatorBinding.state === "ready",
    "RESUME_DURABLE_ROLE_BINDING_INVALID",
  );
  const roles = [];
  for (const owner of ownerBinding.owners)
    roles.push(
      await observe(
        "owner",
        owner.endpoint,
        "/runtime/metadata",
        keys.owner,
        owner.artifactDigest,
      ),
    );
  roles.push(
    await observe(
      "coordinator",
      coordinatorBinding.origin,
      "/internal/application/identity",
      keys.control,
      coordinatorBinding.artifactDigest,
    ),
  );
  const api = binding.weight === 100 ? binding.candidateApi : binding.oldApi;
  roles.push(
    await observe(
      "api",
      api.origin,
      "/internal/control/identity",
      keys.control,
      api.digest,
    ),
  );
  roles.push(
    await observe(
      "web",
      binding.web.origin,
      "/web-process",
      null,
      binding.web.digest,
    ),
  );
  const authority = await privateJson(
    join(c.root, "installer/controller-authority.json"),
  );
  roles.push(
    await observe(
      "installer",
      authority.origin,
      "/metadata",
      keys.controller,
      authority.artifactDigest,
    ),
  );
  return roles;
}

export async function resumeBootstrapFoundation(c) {
  assertBootstrapConfig(c);
  invariant(
    process.platform === "linux" &&
      process.arch === "arm64" &&
      Number(process.versions.node.split(".")[0]) === 22,
    "BOOTSTRAP_LINUX_ARM64_NODE22_REQUIRED",
  );
  const result = await privateJson(join(c.root, "bootstrap-result.json")),
    intent = await privateJson(join(c.root, "startup-intent.json"));
  invariant(
    result.instanceId === c.instanceId &&
      result.root === c.root &&
      intent.instanceId === c.instanceId &&
      ["preview-ready", "confirmed"].includes(result.state),
    "RESUME_BOOTSTRAP_RECEIPT_INVALID",
  );
  const roots = await privateJson(c.trustRootPath),
    catalog = await privateJson(c.catalogFile),
    proof =
      c.kind === "idle-first-bootstrap-experiment"
        ? await privateJson(c.qualificationInstallationPath)
        : null;
  verifyBootstrapCatalog(c, roots, catalog, proof);
  const old = JSON.parse(
    await execute(c.docker.cli || "docker", [
      ...c.docker.args,
      "inspect",
      c.original.containerId,
    ]),
  )[0];
  assertLegacyPhysical(c, old);
  const foundation = JSON.parse(
    await execute(c.docker.cli || "docker", [
      ...c.docker.args,
      "inspect",
      c.foundationContainerId,
    ]),
  )[0];
  assertFoundationCloneMounts(c, foundation, old);
  await assertExperimentalAliases(c);
  const keys = await privateJson(join(c.root, "installation-keys.json"));
  invariant(
    [
      "owner",
      "control",
      "controller",
      "entry",
      "sticky",
      "upgrade",
      "supervisor",
      "upgradeSession",
    ].every((k) => typeof keys[k] === "string" && keys[k].length >= 32),
    "RESUME_INSTALLATION_KEYS_INVALID",
  );
  const paths = Object.fromEntries(
    Object.entries({
      owner: "original-owner",
      futureOwners: "future-owners",
      installer: "installer",
      bindings: "bindings",
      logs: "logs",
      web: "initial-web-code",
      entry: "entry",
    }).map(([name, folder]) => [name, join(c.root, folder)]),
  );
  const bindingPath = join(paths.bindings, "coordinator.json"),
    ownerBindingPath = join(paths.bindings, "owners.json"),
    installedReleasePath = join(paths.bindings, "installed-release.json");
  const binding = validateBinding(
      await privateJson(join(paths.entry, "entry-binding.json")),
    ),
    ownerBinding = await privateJson(ownerBindingPath),
    coordinatorBinding = await privateJson(bindingPath);
  invariant(
    binding.instanceId === c.instanceId && [0, 100].includes(binding.weight),
    "RESUME_PARTIAL_ROUTE_UNSUPPORTED",
  );
  const adapter = await createProductionRoleAdapter(c);
  const rolesBefore = await observeOwnedResumeRoles(c, {
    binding,
    keys,
    adapter,
    ownerBinding,
    coordinatorBinding,
  });
  const installed = await privateJson(installedReleasePath),
    authEnv = await privateJson(c.authEnvPath),
    origin = (name) => `http://127.0.0.1:${c.ports[name]}`;
  const foundationRuntime = await createFoundation(c, {
    paths,
    keys,
    verified: { authEnv },
    origin,
    bindingPath,
    ownerBindingPath,
    installedReleasePath,
    release: installed.release,
    initialBinding: binding,
  });
  const rolesAfter = await observeOwnedResumeRoles(c, {
    binding,
    keys,
    adapter,
    ownerBinding,
    coordinatorBinding,
  });
  const observedIncarnations = (roles) =>
    roles.map((r) => ({
      kind: r.kind,
      containerId: r.physical.containerId,
      hostPid: r.physical.hostPid,
      startIdentity: r.physical.startIdentity,
      startedAt: r.physical.startedAt,
      imageDigest: r.physical.imageDigest,
    }));
  invariant(
    canonical(observedIncarnations(rolesBefore)) ===
      canonical(observedIncarnations(rolesAfter)),
    "RESUME_BUSINESS_ROLE_CHANGED",
  );
  const receipt = {
    state: "foundation-resumed",
    instanceId: c.instanceId,
    roleStarts: 0,
    roleStops: 0,
    sdkHomesOpened: 0,
    roles: rolesAfter.map((r) => ({ kind: r.kind, ...r.physical })),
    recordedAt: new Date().toISOString(),
  };
  await atomicJson(join(c.root, "foundation-resume.json"), receipt);
  const bridgeReceipt = await readJson(join(c.root, "tcp-bridge.json"), null);
  const bridge =
    bridgeReceipt?.state === "active"
      ? await createBootstrapTcpBridge(c)
      : null;
  return {
    ...foundationRuntime,
    result: receipt,
    close: async () => {
      if (bridge) await bridge.close();
      await Promise.all([
        foundationRuntime.entry.close(),
        foundationRuntime.supervisor.close(),
      ]);
    },
  };
}

export function assertBridgeConfig(c) {
  assertBootstrapConfig(c);
  invariant(
    Number.isInteger(c.bridgePort) &&
      c.bridgePort > 0 &&
      c.bridgePort < 65536 &&
      !Object.values(c.ports).includes(c.bridgePort),
    "FIXED_BOOTSTRAP_BRIDGE_PORT_REQUIRED",
  );
  return c;
}

export async function createBootstrapTcpBridge(c) {
  assertBridgeConfig(c);
  const old = JSON.parse(
    await execute(c.docker.cli || "docker", [
      ...c.docker.args,
      "inspect",
      c.original.containerId,
    ]),
  )[0];
  assertLegacyPhysical(c, old, { requireStopped: true });
  const authEnv = await privateJson(c.authEnvPath),
    origin = `http://127.0.0.1:${c.ports.entry}`;
  {
    const response = await fetch(origin + "/api/system/upgrade/status", {
      headers: {
        Authorization: "Bearer " + authEnv.ACCESS_PASSCODE,
        Origin: c.publicOrigin,
      },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    invariant(response.ok, "BRIDGE_TARGET_UNAVAILABLE");
    const body = await response.json(),
      status = body.data || body;
    invariant(
      status.instanceId === c.instanceId && status.serviceState === "confirmed",
      "BRIDGE_TARGET_INSTANCE_UNCONFIRMED",
    );
  }
  const sockets = new Set();
  const server = createTcpServer((socket) => {
    const target = connectTcp({ host: "127.0.0.1", port: c.ports.entry });
    sockets.add(socket);
    sockets.add(target);
    const clear = () => {
      sockets.delete(socket);
      sockets.delete(target);
    };
    socket.once("error", () => target.destroy());
    target.once("error", () => socket.destroy());
    socket.once("close", () => {
      target.destroy();
      clear();
    });
    target.once("close", () => {
      socket.destroy();
      clear();
    });
    socket.pipe(target).pipe(socket);
  });
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(c.bridgePort, "127.0.0.1", ok);
  });
  const result = {
    state: "active",
    instanceId: c.instanceId,
    host: "127.0.0.1",
    port: c.bridgePort,
    targetPort: c.ports.entry,
    originalStopped: true,
    byteForwardingOnly: true,
    recordedAt: new Date().toISOString(),
  };
  await atomicJson(join(c.root, "tcp-bridge.json"), result);
  return {
    result,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((ok) => server.close(ok));
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const action = process.argv[2],
    config = await privateJson(resolve(process.argv[3] || ""));
  if (action === "verify" || action === "preflight") {
    const r = await verifyBootstrapInputs(config);
    process.stdout.write(
      JSON.stringify({
        state: "inputs-verified",
        instanceId: config.instanceId,
        artifactTreeDigest: r.bundle.treeDigest,
        maintenanceRequired: true,
        originalStopRequiredForStart: true,
      }) + "\n",
    );
  } else if (action === "resume" || action === "bridge") {
    const service =
      action === "resume"
        ? await resumeBootstrapFoundation(config)
        : await createBootstrapTcpBridge(config);
    process.stdout.write(JSON.stringify(service.result) + "\n");
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, () => {
        void (
          service.close
            ? service.close()
            : Promise.all([service.entry.close(), service.supervisor.close()])
        ).then(() => process.exit(0));
      });
  } else if (action === "repair-bootstrap-web") {
    const result = await repairBootstrapWeb(config);
    process.stdout.write(
      JSON.stringify({
        state: result.state,
        instanceId: result.instanceId,
        ownerRestarted: false,
        resultPath: join(config.root, "web-identity-repair.json"),
      }) + "\n",
    );
  } else if (action === "start" || action === "preview") {
    const started = await (action === "preview"
      ? previewExperimentalBootstrap(config)
      : startProductionBootstrap(config));
    process.stdout.write(
      JSON.stringify({
        state: started.result.state,
        mode: started.result.mode,
        qualified: false,
        productionRouteSwitched: false,
        instanceId: config.instanceId,
        entryOrigin: started.result.entryOrigin,
        resultPath: join(config.root, "bootstrap-result.json"),
      }) + "\n",
    );
    // Closing the foundation detaches transports only. Never signal business roles or the original mono.
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, () => {
        void Promise.all([
          started.entry.close(),
          started.supervisor.close(),
        ]).then(() => process.exit(0));
      });
  } else invariant(false, "USE_BOOTSTRAP_VERIFY_START_OR_PREVIEW");
}
