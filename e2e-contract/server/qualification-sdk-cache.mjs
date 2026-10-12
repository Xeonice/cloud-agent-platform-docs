import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import { command } from "../../deploy/upgrade/artifacts.mjs";
import {
  atomicJson,
  fileDigest,
  inside,
  readJson,
  secureDirectory,
} from "../../deploy/upgrade/io.mjs";
import { digest, invariant } from "../../deploy/upgrade/trust.mjs";

import { verifyQualificationBusinessDatabaseFilesystem } from './installer-filesystem.mjs';

const CACHE_FOLDERS = new Set([
  "configs",
  "disk-images",
  "extracted",
  "layers",
  "manifests",
]);
const BUSINESS_TABLES = [
  "sandboxes",
  "projects",
  "agent_tasks",
  "automation_runs",
  "automation_launch_intents",
  "automations",
  "terminal_bookmarks",
  "retained_volumes",
  "sandbox_project_cleanup_jobs",
];

/** Readonly SQLite proof, after the caller verifies every stopped Owner's scope.
 * Completed intents remain intact; no payload or native handle enters a receipt. */
export function qualifyBusinessCleanup(business, ownerDatabases) {
  const businessCounts = Object.fromEntries(
    BUSINESS_TABLES.map((table) => [
      table,
      business.prepare("SELECT count(*) AS n FROM " + table).get().n,
    ]),
  );
  const startIntents = business
    .prepare(
      "SELECT task_id,sandbox_id,provider,payload,state, " +
        "EXISTS(SELECT 1 FROM sandboxes s WHERE s.id=i.sandbox_id) AS sandboxExists, " +
        "EXISTS(SELECT 1 FROM agent_tasks t WHERE t.id=i.task_id) AS taskExists " +
        "FROM agent_task_start_intents i ORDER BY task_id",
    )
    .all();
  businessCounts.agent_task_start_intents = startIntents.length;
  invariant(
    BUSINESS_TABLES.every(
      (table) =>
        Number.isSafeInteger(businessCounts[table]) &&
        businessCounts[table] === 0,
    ) &&
      startIntents.every(
        (row) =>
          row.state === "complete" &&
          row.sandboxExists === 0 &&
          row.taskExists === 0,
      ),
    "QA_BUSINESS_CLEANUP_NOT_COMPLETE",
  );
  invariant(
    Array.isArray(ownerDatabases) &&
      ownerDatabases.every(
        (owner) =>
          typeof owner.ownerId === "string" && owner.ownerId.length > 0,
      ) &&
      new Set(ownerDatabases.map((owner) => owner.ownerId)).size ===
        ownerDatabases.length,
    "QA_HISTORY_OWNER_PROOF_UNKNOWN",
  );
  const closures = startIntents.map((row) => {
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      invariant(false, "QA_HISTORY_HANDLE_UNCONFIRMED");
    }
    const handle = payload?.handle,
      reference = handle?.providerState?.runtimeOwner;
    invariant(
      payload?.version === 1 &&
        payload?.operation?.operationId === "agent-task-" + row.task_id &&
        handle?.provider === row.provider &&
        row.provider === "boxlite" &&
        typeof handle?.providerSandboxId === "string" &&
        handle.providerSandboxId.length > 0 &&
        typeof reference?.ownerId === "string" &&
        reference.ownerId.length > 0 &&
        reference?.sandboxId === row.sandbox_id,
      "QA_HISTORY_HANDLE_UNCONFIRMED",
    );
    const owner = ownerDatabases.find(
      (candidate) => candidate.ownerId === reference.ownerId,
    );
    invariant(owner?.journal && owner?.sdk, "QA_HISTORY_OWNER_PROOF_UNKNOWN");
    const assignment = owner.journal
      .prepare(
        "SELECT state FROM owner_assignments WHERE sandbox_id=? AND provider=? AND provider_id=?",
      )
      .get(row.sandbox_id, row.provider, handle.providerSandboxId);
    invariant(
      assignment?.state === "destroyed",
      "QA_HISTORY_OWNER_DESTRUCTION_UNCONFIRMED",
    );
    invariant(
      !owner.sdk
        .prepare("SELECT 1 FROM box_config WHERE id=?")
        .get(handle.providerSandboxId) &&
        !owner.sdk
          .prepare("SELECT 1 FROM box_state WHERE id=?")
          .get(handle.providerSandboxId),
      "QA_HISTORY_SDK_BOX_REMAINS",
    );
    return {
      intentIdentityDigest: digest({
        taskId: row.task_id,
        sandboxId: row.sandbox_id,
        provider: row.provider,
      }),
      assignmentIdentityDigest: digest({
        ownerId: reference.ownerId,
        sandboxId: row.sandbox_id,
        provider: row.provider,
        nativeId: handle.providerSandboxId,
        state: "destroyed",
      }),
      state: "complete",
      parentsAbsent: true,
      sdkAbsent: true,
    };
  });
  return {
    businessCounts,
    startIntentHistory: {
      total: startIntents.length,
      complete: startIntents.length,
      pending: 0,
      parentsAbsent: true,
      preservedAsIdempotencyHistory: true,
      closureDigest: digest(closures),
    },
  };
}

/** Explicit successful-case administration. It never opens an SDK, changes a
 * journal, stops a process, or removes a workspace, box disk, or Owner home. */
export async function cleanupQualificationSdkImages(
  input,
  { resourcesCleaned = false } = {},
) {
  if (input.cleanupSdkImagesOnSuccess !== true || !resourcesCleaned)
    return { preserved: true };
  invariant(
    input.isolated === true &&
      input.docker?.dedicated === true &&
      process.platform === "linux" &&
      process.arch === "arm64" &&
      /^upgrade-acceptance-[a-zA-Z0-9._-]+$/.test(input.instanceId),
    "DEDICATED_QA_CACHE_CLEANUP_REQUIRED",
  );
  invariant(
    isAbsolute(input.root) &&
      resolve(input.root) === input.root &&
      /^\/tmp\/upg-qa-[a-z0-9-]+-work\//.test(input.root) &&
      /^sha256:[a-f0-9]{64}$/.test(input.docker.image) &&
      Array.isArray(input.docker.args),
    "FIXED_QA_CACHE_SCOPE_REQUIRED",
  );
  const root = await secureDirectory(input.root),
    receiptPath = join(root, "sdk-cache-cleanup.json");
  const existing = await readJson(receiptPath, null);
  const docker = (args) =>
    command(input.docker.cli || "docker", [...input.docker.args, ...args]);
  const ids = (
    await docker([
      "ps",
      "--no-trunc",
      "-aq",
      "--filter",
      "label=agent-platform.instance=" + input.instanceId,
    ])
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  invariant(
    ids.length > 0 && ids.every((id) => /^[a-f0-9]{64}$/.test(id)),
    "QA_CACHE_ROLE_IDENTITY_UNKNOWN",
  );
  const roles = JSON.parse(await docker(["inspect", ...ids]));
  invariant(
    roles.length === ids.length &&
      roles.every(
        (row) =>
          ids.includes(row.Id) &&
          row.Image === input.docker.image &&
          row.Config.Labels?.["agent-platform.instance"] === input.instanceId &&
          row.Config.Labels?.["agent-platform.installation"] === digest(root) &&
          ["api", "web", "coordinator", "owner", "installer"].includes(
            row.Config.Labels?.["agent-platform.role"],
          ) &&
          typeof row.Config.Labels?.["agent-platform.start"] === "string" &&
          row.State.Running === false &&
          row.State.Pid === 0,
      ),
    "QA_CACHE_ROLES_NOT_DEFINITELY_STOPPED",
  );
  const ownerRoles = roles.filter(
    (row) => row.Config.Labels["agent-platform.role"] === "owner",
  );
  invariant(ownerRoles.length > 0, "QA_CACHE_OWNER_SET_UNKNOWN");
  // These already compiled production SQLite bindings are loaded only after
  // every application process is definitely absent. No Nest/SDK bootstrap.
  const D = createRequire(join(input.initialRoot, "api/package.json"))(
    "better-sqlite3",
  );
  const businessDatabasePath = await verifyQualificationBusinessDatabaseFilesystem(input);
  const coordinatorRoles = roles.filter(row => row.Config.Labels["agent-platform.role"] === "coordinator");
  invariant(coordinatorRoles.length > 0 && coordinatorRoles.every(row => {
    const database = (row.Config.Env || []).filter(value => value.startsWith("DATABASE_URL="));
    return database.length === 1 && database[0].slice("DATABASE_URL=".length) === businessDatabasePath &&
      row.Mounts.some(mount => mount.Source === join(root,"business") && mount.Destination === join(root,"business") && mount.RW === true);
  }), "QA_CACHE_BUSINESS_DATABASE_SCOPE_CHANGED");
  const business = new D(businessDatabasePath, {
    readonly: true,
    fileMustExist: true,
  });
  let businessCounts, startIntentHistory;
  try {
    business.exec("PRAGMA query_only=ON");
    businessCounts = Object.fromEntries(
      BUSINESS_TABLES.map((table) => [
        table,
        business.prepare("SELECT count(*) AS n FROM " + table).get().n,
      ]),
    );
    invariant(
      Object.values(businessCounts).every((n) => n === 0),
      "QA_BUSINESS_CLEANUP_NOT_COMPLETE",
    );
  } finally {
    business.close();
  }
  const owners = [],
    historySources = [];
  for (const row of ownerRoles) {
    const env = (name) => {
      const pairs = (row.Config.Env || []).filter((v) =>
        v.startsWith(name + "="),
      );
      invariant(pairs.length === 1, "QA_OWNER_ENV_AMBIGUOUS");
      return pairs[0].slice(name.length + 1);
    };
    const ownerHome = env("RUNTIME_OWNER_HOME"),
      boxliteHome = env("BOXLITE_HOME"),
      ownerId = env("RUNTIME_OWNER_ID");
    invariant(
      isAbsolute(ownerHome) &&
        resolve(ownerHome) === ownerHome &&
        inside(root, ownerHome) &&
        (ownerHome === join(root, "original-owner") ||
          inside(join(root, "future-owners"), ownerHome)) &&
        boxliteHome === join(ownerHome, "boxlite") &&
        !inside(join(root, "business"), ownerHome) &&
        row.Mounts.some(
          (m) =>
            m.Type === "bind" &&
            m.Source === ownerHome &&
            m.Destination === ownerHome &&
            m.RW === true,
        ),
      "QA_OWNER_PRIVATE_HOME_MISMATCH",
    );
    invariant(
      (await fs.realpath(ownerHome)) === ownerHome,
      "QA_OWNER_HOME_LINK_ESCAPE",
    );
    const sdkDirectory = await fs.lstat(boxliteHome).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    invariant(
      !sdkDirectory ||
        (sdkDirectory.isDirectory() &&
          !sdkDirectory.isSymbolicLink() &&
          (await fs.realpath(boxliteHome)) === boxliteHome),
      "QA_OWNER_HOME_LINK_ESCAPE",
    );
    const journal = new D(join(ownerHome, "runtime-owner.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    let assignments;
    try {
      journal.exec("PRAGMA query_only=ON");
      assignments = journal
        .prepare("SELECT sandbox_id,provider_id,state FROM owner_assignments")
        .all();
      invariant(
        assignments.every(
          (a) =>
            a.state === "destroyed" ||
            (a.state === "owned" && a.sandbox_id === "auth-helper"),
        ),
        "QA_OWNER_BUSINESS_ASSIGNMENTS_REMAIN",
      );
    } finally {
      journal.close();
    }
    const sdkDatabase = join(boxliteHome, "db/boxlite.db");
    const databaseExists = await fs.lstat(sdkDatabase).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    invariant(
      !databaseExists ||
        (databaseExists.isFile() && !databaseExists.isSymbolicLink()),
      "QA_SDK_DATABASE_PATH_ESCAPE",
    );
    if (databaseExists) {
      const sdk = new D(sdkDatabase, { readonly: true, fileMustExist: true });
      try {
        sdk.exec("PRAGMA query_only=ON");
        invariant(
          sdk
            .prepare("SELECT id FROM box_config")
            .all()
            .every((box) =>
              assignments.some(
                (a) =>
                  a.state === "owned" &&
                  a.sandbox_id === "auth-helper" &&
                  a.provider_id === box.id,
              ),
            ),
          "QA_SDK_USER_BOX_REMAINS",
        );
      } finally {
        sdk.close();
      }
    } else invariant(assignments.length === 0, "QA_SDK_ABSENCE_UNCONFIRMED");
    historySources.push({
      ownerId,
      journalPath: join(ownerHome, "runtime-owner.sqlite"),
      sdkDatabase,
      databaseExists: Boolean(databaseExists),
    });
    const cachePath = join(boxliteHome, "images");
    const cache = await fs.lstat(cachePath).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    invariant(
      !cache ||
        (cache.isDirectory() &&
          !cache.isSymbolicLink() &&
          (await fs.realpath(cachePath)) === cachePath),
      "QA_IMAGES_CACHE_PATH_ESCAPE",
    );
    if (cache)
      invariant(
        (await fs.readdir(cachePath)).every((name) => CACHE_FOLDERS.has(name)),
        "QA_IMAGES_CACHE_BOUNDARY_CHANGED",
      );
    owners.push({
      ownerId,
      ownerHome,
      cachePath,
      dev: cache?.dev ?? null,
      ino: cache?.ino ?? null,
      containerId: row.Id,
      imageDigest: row.Image,
      startIdentity: row.Config.Labels["agent-platform.start"],
      startedAt: row.State.StartedAt,
      running: false,
      hostPid: 0,
    });
  }
  invariant(
    new Set(owners.map((owner) => owner.ownerHome)).size === owners.length,
    "QA_OWNER_HOMES_MUST_DIFFER",
  );
  const historyBusiness = new D(businessDatabasePath, {
    readonly: true,
    fileMustExist: true,
  });
  const ownerDatabases = [];
  try {
    historyBusiness.exec("PRAGMA query_only=ON");
    for (const source of historySources) {
      const journal = new D(source.journalPath, {
        readonly: true,
        fileMustExist: true,
      });
      const owner = { ownerId: source.ownerId, journal, sdk: null };
      ownerDatabases.push(owner);
      journal.exec("PRAGMA query_only=ON");
      if (source.databaseExists) {
        owner.sdk = new D(source.sdkDatabase, {
          readonly: true,
          fileMustExist: true,
        });
        owner.sdk.exec("PRAGMA query_only=ON");
      }
    }
    ({ businessCounts, startIntentHistory } = qualifyBusinessCleanup(
      historyBusiness,
      ownerDatabases,
    ));
  } finally {
    historyBusiness.close();
    for (const owner of ownerDatabases) {
      owner.sdk?.close();
      owner.journal.close();
    }
  }
  if (existing?.state === "cleaned") {
    invariant(
      existing.instanceId === input.instanceId &&
        existing.owners.length === owners.length &&
        existing.startIntentHistory?.closureDigest ===
          startIntentHistory.closureDigest &&
        owners.every(
          (owner) =>
            existing.owners.some(
              (prior) =>
                prior.containerId === owner.containerId &&
                prior.cachePath === owner.cachePath &&
                prior.startedAt === owner.startedAt,
            ) && owner.ino === null,
        ),
      "QA_CLEANUP_RECEIPT_CHANGED",
    );
    return existing;
  }
  const evidenceRoot = await secureDirectory(
    join(root, "sdk-cache-cleanup-evidence"),
  );
  const receipts = [];
  for (const owner of owners) {
    const files = [];
    async function enumerate(folder) {
      for (const name of (await fs.readdir(folder)).sort()) {
        const path = join(folder, name),
          stat = await fs.lstat(path),
          suffix = relative(owner.cachePath, path);
        invariant(inside(owner.cachePath, path), "QA_CACHE_FILE_ESCAPE");
        if (stat.isDirectory()) await enumerate(path);
        else if (stat.isSymbolicLink())
          files.push({
            path: suffix,
            link: await fs.readlink(path),
            mode: stat.mode & 0o777,
          });
        else {
          invariant(stat.isFile(), "QA_CACHE_SPECIAL_FILE");
          files.push({
            path: suffix,
            mode: stat.mode & 0o777,
            allocatedBytes: stat.blocks * 512,
            ...(await fileDigest(path)),
          });
        }
      }
    }
    if (owner.ino !== null) await enumerate(owner.cachePath);
    const manifestPath = join(
      evidenceRoot,
      digest(owner.ownerHome).slice(7) + ".json",
    );
    await atomicJson(manifestPath, { cachePath: owner.cachePath, files });
    const receipt = {
      ...owner,
      files: files.length,
      treeDigest: digest(files),
      logicalBytes: files.reduce((n, f) => n + (f.bytes || 0), 0),
      allocatedBytes: files.reduce((n, f) => n + (f.allocatedBytes || 0), 0),
      manifestPath,
      manifestDigest: (await fileDigest(manifestPath)).digest,
    };
    receipts.push(receipt);
  }
  // Full-set qualification finishes before the first deletion. Recheck actual
  // scope/stopped incarnations and inode so an unknown case is preserved.
  const fresh = JSON.parse(await docker(["inspect", ...ids]));
  invariant(
    fresh.length === roles.length &&
      fresh.every(
        (row) =>
          roles.some(
            (prior) =>
              prior.Id === row.Id &&
              prior.Image === row.Image &&
              prior.State.StartedAt === row.State.StartedAt &&
              prior.Config.Labels["agent-platform.start"] ===
                row.Config.Labels["agent-platform.start"],
          ) &&
          row.State.Running === false &&
          row.State.Pid === 0,
      ),
    "QA_ROLE_RESTARTED_DURING_CACHE_PROOF",
  );
  const beforeSpace = await fs.statfs(root);
  for (const owner of owners) {
    if (owner.ino === null) continue;
    const current = await fs.lstat(owner.cachePath);
    invariant(
      current.isDirectory() &&
        !current.isSymbolicLink() &&
        current.dev === owner.dev &&
        current.ino === owner.ino,
      "QA_CACHE_PHYSICAL_IDENTITY_CHANGED",
    );
    await fs.rm(owner.cachePath, { recursive: true });
  }
  const afterSpace = await fs.statfs(root);
  const receipt = {
    schemaVersion: 1,
    kind: "dedicated-qualification-success-sdk-image-cache-cleanup",
    state: "cleaned",
    instanceId: input.instanceId,
    explicitOption: true,
    resourcesCleaned: true,
    businessCounts,
    startIntentHistory,
    owners: receipts,
    actualRoleStops: roles.map((row) => ({
      containerId: row.Id,
      imageDigest: row.Image,
      role: row.Config.Labels["agent-platform.role"],
      startIdentity: row.Config.Labels["agent-platform.start"],
      startedAt: row.State.StartedAt,
      running: false,
      hostPid: 0,
    })),
    preserved: [
      "business database",
      "Owner journals",
      "SDK databases",
      "box disks",
      "workspaces",
      "role logs",
      "installer receipts",
    ],
    freeBytesBefore: beforeSpace.bavail * beforeSpace.bsize,
    freeBytesAfter: afterSpace.bavail * afterSpace.bsize,
    observedAt: new Date().toISOString(),
    nativeQualification: "not-run",
  };
  await atomicJson(receiptPath, receipt);
  return receipt;
}
