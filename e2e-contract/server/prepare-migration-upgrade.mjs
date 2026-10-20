import * as fs from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { join, isAbsolute } from "node:path";
import {
  canonical,
  digest,
  invariant,
  loadTrustRoot,
  verifyManifest,
} from "../../deploy/upgrade/trust.mjs";
import {
  atomicJson,
  secureDirectory,
  readJson,
  fileDigest,
  treeManifest,
} from "../../deploy/upgrade/io.mjs";
import { actualInstallerIdentity } from "../../deploy/upgrade/installer-identity.mjs";
import { verifyInstalledControlPackage } from "../../deploy/upgrade/control-package.mjs";
import { createPrivateControlRpc } from "../../deploy/upgrade/control-rpc.mjs";
import {
  sampleLinuxCapacity,
  capacityResidentIdentity,
  capacityHostIdentity,
  createControlCapacityCollector,
  linuxDevice,
} from "../../deploy/upgrade/control-capacity-collector.mjs";
import {
  freezeCapacityBudget,
  evaluateCapacityAdmission,
} from "../../deploy/upgrade/capacity-admission.mjs";
import { assertMigrationNativeIdentity } from "./start-migration-upgrade.mjs";

const CONTROLS = ["control-agent", "control-supervisor", "control-entry"],
  BUSINESS = ["api", "coordinator"];
async function freePort() {
  const s = createServer();
  await new Promise((ok, fail) => {
    s.once("error", fail);
    s.listen(0, "127.0.0.1", ok);
  });
  const p = s.address().port;
  await new Promise((ok) => s.close(ok));
  return p;
}
/** All physical source and Guest records are produced by the running source
 * harness and real SDK/proc reader. No input accepts hand-written ready IDs. */
export async function prepareMigrationUpgrade(
  input,
  h,
  { protectedProcesses },
) {
  assertMigrationNativeIdentity(input);
  invariant(
    h.instanceId === input.instanceId &&
      h.provisionReceipt.nativeResult === "not-run" &&
      Array.isArray(protectedProcesses) &&
      protectedProcesses.length > 0,
    "MIGRATION_NATIVE_PROTECTION_REQUIRED",
  );
  const target = input.target;
  invariant(
    target &&
      [
        "artifactRoot",
        "manifestPath",
        "archivePath",
        "controlArtifactRoot",
        "controlManifestPath",
        "catalogFile",
      ].every((k) => isAbsolute(target[k] ?? "")),
    "MIGRATION_NATIVE_SIGNED_TARGET_INPUT_REQUIRED",
  );
  const paths = { ...h.paths };
  for (const [name, folder] of Object.entries({
    control: "control-private",
    ledger: "control-ledger",
    capacity: "capacity-state",
    foundation: "foundation",
    entry: "independent-entry",
    journal: "migration-journal",
  }))
    paths[name] = await secureDirectory(join(input.root, folder));
  await secureDirectory(join(paths.control, "auth"));
  await secureDirectory(
    join(input.root, "supervisor-publication/retired-coordinators"),
  );
  const agentInputs = {};
  for (const [name, source] of Object.entries({
    descriptor: target.controlManifestPath,
    catalog: target.catalogFile,
    qualification: input.qualificationInstallationPath,
  })) {
    const path = join(paths.control, name + ".json");
    await fs.copyFile(source, path, fs.constants.COPYFILE_EXCL);
    await fs.chmod(path, 0o600);
    agentInputs[name] = path;
  }
  const p = {
    ...h.ports,
    coordinator: h.ports.coordinatorB,
    apiA: h.ports.apiB,
  };
  for (const k of ["apiB", "webB", "coordinatorB", "coordinatorAppB"])
    p[k] = await freePort();
  invariant(
    new Set(Object.values(p)).size === Object.keys(p).length,
    "MIGRATION_NATIVE_TARGET_PORT_COLLISION",
  );
  const origin = (k) => "http://127.0.0.1:" + p[k],
    keys = h.keys;
  const requireApi = createRequire(
      join(target.artifactRoot, "api/apps/api/package.json"),
    ),
    Database = requireApi("better-sqlite3");
  const db = new Database(h.businessDatabasePath, {
    readonly: true,
    fileMustExist: true,
  });
  let epochFloor;
  try {
    db.pragma("query_only=ON");
    epochFloor = Math.max(
      db
        .prepare(
          "SELECT coalesce(max(fence),0) n FROM upgrade_attempts WHERE instance_id=?",
        )
        .get(input.instanceId).n,
      db
        .prepare(
          "SELECT coalesce(max(fence),0) n FROM platform_operations WHERE instance_id=? AND role IN ('upgrade-plan','project-name-contract','upgrade-observation','upgrade-stage-progress')",
        )
        .get(input.instanceId).n,
    );
  } finally {
    db.close();
  }
  const current = {
      ...h.release,
      instanceId: input.instanceId,
      platform: "linux",
      arch: "arm64",
      generation: h.release.activationGeneration,
      protocols: Object.fromEntries(
        Object.entries(h.release.components).map(([k, c]) => [k, c.protocol]),
      ),
      ...Object.fromEntries(
        Object.entries(h.release.components).flatMap(([k, c]) => [
          [k + "Digest", c.artifactDigest],
          [k + "InputFingerprint", c.inputFingerprint],
        ]),
      ),
    },
    currentPath = join(paths.journal, "source-current.json");
  await atomicJson(currentPath, current);
  const roots = await loadTrustRoot(input.qa.trustRootPath),
    envelope = await readJson(target.manifestPath),
    signed = verifyManifest(envelope, roots, current),
    pkg = signed.package,
    components = signed.manifest.components;
  const actual = await fileDigest(target.archivePath);
  invariant(
    actual.digest === pkg.digest && actual.bytes === pkg.bytes,
    "MIGRATION_NATIVE_TARGET_ARCHIVE_CHANGED",
  );
  const archivePath = join(
    paths.installer,
    "artifacts",
    pkg.digest.slice(7) + ".tgz",
  );
  await fs.copyFile(
    target.archivePath,
    archivePath,
    fs.constants.COPYFILE_EXCL,
  );
  await fs.chmod(archivePath, 0o600);
  invariant(
    canonical(await fileDigest(archivePath)) === canonical(actual),
    "MIGRATION_NATIVE_TARGET_COPY_CHANGED",
  );
  const bundle = await readJson(
      join(target.artifactRoot, "upgrade-artifact.json"),
    ),
    files = (await treeManifest(target.artifactRoot)).filter(
      (f) => !["installed.json", "upgrade-artifact.json"].includes(f.path),
    );
  invariant(
    canonical(files) === canonical(bundle.files) &&
      digest(files) === bundle.treeDigest &&
      canonical(bundle.components) === canonical(components),
    "MIGRATION_NATIVE_TARGET_TREE_CHANGED",
  );
  const starts = Object.fromEntries(
      [...CONTROLS, ...BUSINESS].map((k) => [k, randomUUID()]),
    ),
    engine = await actualInstallerIdentity({
      instanceId: input.instanceId,
      startIdentity: starts["control-agent"],
      root: join(target.controlArtifactRoot, "installer"),
    });
  const control = await verifyInstalledControlPackage({
    artifactRoot: target.controlArtifactRoot,
    manifestPath: target.controlManifestPath,
    trustRootPath: input.qa.trustRootPath,
    engineIdentity: engine,
  });
  invariant(
    control.executionEngineDigest === components.installer.artifactDigest,
    "MIGRATION_NATIVE_STABLE_ENGINE_CHANGED",
  );
  const metadata = createPrivateControlRpc({
      origin: h.coordinatorOrigin,
      instanceId: input.instanceId,
      key: keys.control,
    }),
    sourceIdentity = await metadata("/internal/application/identity");
  invariant(
    sourceIdentity.writerFenceValid === true &&
      sourceIdentity.startIdentity === h.roles.coordinator.startIdentity &&
      sourceIdentity.artifactDigest === h.roles.coordinator.artifactDigest,
    "MIGRATION_NATIVE_SOURCE_WRITER_CHANGED",
  );
  const bindingPath = h.bindingPath,
    ownerBindingPath = h.ownerBindingPath,
    installedReleasePath = join(paths.bindings, "installed-release.json"),
    originalCoordinator = await readJson(bindingPath),
    snapshotPath = join(paths.journal, "original-coordinator.json");
  await atomicJson(snapshotPath, originalCoordinator);
  const entry = createPrivateControlRpc({
      origin: origin("entryControl"),
      instanceId: input.instanceId,
      key: keys.entry,
    }),
    { inFlight, activeWS, httpByDigest, wsByDigest, ...originalEntry } =
      await entry("/binding");
  invariant(
    originalEntry.instanceId === input.instanceId &&
      originalEntry.oldApi?.digest ===
        h.release.components.api.artifactDigest &&
      originalEntry.web?.digest === h.release.components.web.artifactDigest,
    "MIGRATION_NATIVE_SOURCE_ENTRY_CHANGED",
  );
  const initialBinding = {
    ...originalEntry,
    routeGeneration: originalEntry.routeGeneration + 1,
    weight: 0,
    oldApi: { origin: origin("apiA"), digest: components.api.artifactDigest },
    candidateApi: null,
  };
  const controlDbPath = join(paths.ledger, "control.db"),
    accessPath = join(paths.control, "auth/access.db"),
    capacityPlanPath = join(paths.capacity, "plan.json"),
    resourceObservationPath = join(paths.capacity, "observation.json"),
    migrationSourcePath = join(paths.bindings, "migration-source.json");
  const stableControl = {
    origin: origin("control"),
    key: keys.upgradeControl,
    accessKey: keys.accessAuthority,
    statePath: join(paths.foundation, "supervisor.db"),
    controlDbPath,
    agentStartIdentity: starts["control-agent"],
    capacityPlanPath,
    resourceObservationPath,
    referenceStatePath: join(paths.capacity, "references.json"),
    capacityCollectorConfigPath: join(paths.capacity, "collector.json"),
    capacityTransitionRoot: join(paths.capacity, "transitions"),
    migratedArtifactPath: migrationSourcePath,
    capacityTemplates: Object.fromEntries(
      ["api", "web", "coordinator", "owner"].map((kind) => [
        kind,
        {
          allocationId: input.capacityAllocationIds[kind],
          resources: input.capacityBudgets.candidate[kind],
        },
      ]),
    ),
  };
  const c = {
    ...input.adapter,
    kind: "idle-first-bootstrap-experiment",
    runtimeImage: input.docker.image,
    root: input.root,
    instanceId: input.instanceId,
    artifactRoot: target.artifactRoot,
    businessHostPath: paths.data,
    businessRoot: paths.data,
    uid: input.uid,
    gid: input.gid,
    docker: { ...input.docker, cli: input.docker.clientPath },
    ports: p,
    publicOrigin: origin("entry"),
    allowedOrigins: [origin("entry")],
    trustRootPath: input.qa.trustRootPath,
    catalogFile: target.catalogFile,
    qualificationInstallationPath: input.qualificationInstallationPath,
    stableControl,
    controlArtifactRoot: target.controlArtifactRoot,
    controlAgentArtifactRoot: target.controlArtifactRoot,
    controlPrivateRoot: paths.control,
    controlLedgerRoot: paths.ledger,
    controlDownloadRoot: join(paths.installer, "downloads"),
    capacityStateRoot: paths.capacity,
    controlFoundationRoot: paths.foundation,
    controlEntryRoot: paths.entry,
    controlEntryWebRoots: [
      join(h.sourceRoot, "web"),
      join(target.artifactRoot, "web"),
      join(paths.installer, "process-code"),
    ],
    controlFutureOwnerRoot: paths.futureOwners,
    controlAgentStartIdentity: starts["control-agent"],
    runtimeRoots: [paths.owner, paths.futureOwners],
    existingRuntimeRoots: [paths.owner, paths.futureOwners],
    procRoot: input.hostProcRoot ?? "/host/proc",
    cgroupRoot: "/host/cgroup",
    controlAgentResources: {
      ...input.capacityBudgets.migrationTargets["control-agent"],
      pidsLimit: input.controlRolePidsLimits["control-agent"],
    },
    runtimeEnv: input.runtimeEnv ?? {},
  };
  c.controlFoundationEntries = Object.fromEntries(
    ["entry", "supervisor"].map((mode) => [
      mode,
      {
        startIdentity: starts["control-" + mode],
        configPath: join(paths.foundation, mode + ".json"),
        resources: {
          ...input.capacityBudgets.migrationTargets["control-" + mode],
          pidsLimit: input.controlRolePidsLimits["control-" + mode],
        },
      },
    ]),
  );
  const context = {
    paths,
    keys: Object.fromEntries(
      Object.entries(keys).filter(
        ([name]) => name !== "cookie" && name !== "upgradeSession",
      ),
    ),
    bindingPath,
    ownerBindingPath,
    installedReleasePath,
    initialBinding,
  };
  for (const mode of ["entry", "supervisor"])
    await atomicJson(c.controlFoundationEntries[mode].configPath, {
      schemaVersion: 1,
      c: { ...c, foundationMode: mode },
      context,
    });
  const agentConfigPath = join(paths.control, "config.json");
  await atomicJson(agentConfigPath, {
    instanceId: input.instanceId,
    startIdentity: starts["control-agent"],
    controlArtifactRoot: target.controlArtifactRoot,
    controlManifestPath: agentInputs.descriptor,
    trustRootPath: input.qa.trustRootPath,
    catalogFile: agentInputs.catalog,
    qualificationInstallationPath: agentInputs.qualification,
    controlRoot: paths.control,
    controlLedgerRoot: paths.ledger,
    // downloadVerified appends /downloads; the Agent mount remains that child only.
    downloadRoot: paths.installer,
    coordinatorBindingPath: bindingPath,
    capacityStateRoot: paths.capacity,
    capacityPlanPath,
    capacityAllocationIds: input.capacityAllocationIds,
    controllerKey: keys.upgradeControl,
    businessKey: keys.controller,
    supervisorKey: keys.supervisor,
    entryKey: keys.entry,
    privateEntryKey: keys.privateEntry,
    accessAuthorityKey: keys.accessAuthority,
    coordinatorOrigin: origin("coordinator"),
    supervisorOrigin: origin("supervisor"),
    entryOrigin: origin("entryControl"),
    controlPort: p.control,
    allowedOrigins: [origin("entry")],
    epochFloor,
  });
  const common = {
      NODE_ENV: "production",
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOST: "127.0.0.1",
      PLATFORM_INSTANCE_ID: input.instanceId,
      ...input.runtimeEnv,
    },
    network = { API_ALLOWED_ORIGINS: origin("entry") },
    access = {
      UPGRADE_ACCESS_AUTHORITY_ORIGIN: origin("control"),
      UPGRADE_ACCESS_AUTHORITY_KEY: keys.accessAuthority,
    };
  const coordinatorEnv = {
      ...common,
      ...network,
      ...access,
      PLATFORM_PROCESS_ROLE: "coordinator",
      PORT: String(p.coordinator),
      PLATFORM_CONTROL_RPC_KEY: keys.control,
      PLATFORM_CONTROLLER_RPC_KEY: keys.controller,
      PLATFORM_COORDINATOR_RPC_KEY: keys.owner,
      PLATFORM_COORDINATOR_BINDING_PATH: bindingPath,
      PLATFORM_RUNTIME_OWNER_BINDING_PATH: ownerBindingPath,
      COORDINATOR_RPC_URL: origin("coordinator"),
      RUNTIME_OWNER_RPC_URL: origin("owner"),
      DATA_ROOT: paths.data,
      DATABASE_URL: "/data/platform.db",
      MIGRATIONS_DIR: join(target.artifactRoot, "api/drizzle"),
      UPGRADE_TRUST_ROOT_PATH: input.qa.trustRootPath,
      UPGRADE_CATALOG_FILE: target.catalogFile,
      UPGRADE_QUALIFICATION_INSTALLATION_PATH:
        input.qualificationInstallationPath,
      UPGRADE_INITIAL_RELEASE_PATH: installedReleasePath,
      UPGRADE_INITIAL_ARTIFACT_ROOT: target.artifactRoot,
      UPGRADE_INSTALLER_ROOT: paths.installer,
      PLATFORM_ENTRY_ORIGIN: origin("entry"),
      PLATFORM_ENTRY_CONTROL_ORIGIN: origin("entryControl"),
      PLATFORM_ENTRY_CONTROL_KEY: keys.controller,
      PLATFORM_INSTALLER_SUPERVISOR_ORIGIN: origin("supervisor"),
      PLATFORM_INSTALLER_SUPERVISOR_KEY: keys.controller,
      UPGRADE_CONTROL_DATABASE_PATH: controlDbPath,
      UPGRADE_CONTROL_ORIGIN: origin("control"),
      UPGRADE_MIGRATED_ARTIFACT_PATH: migrationSourcePath,
      UPGRADE_BUSINESS_PROBE_KEY: keys.businessProbe,
      SANDBOX_DEFAULT_PROVIDER: "boxlite",
      SANDBOX_RECONCILE_ON_BOOT: "false",
    },
    apiEnv = {
      ...common,
      ...network,
      ...access,
      PLATFORM_PROCESS_ROLE: "control",
      PORT: String(p.apiA),
      PLATFORM_CONTROL_RPC_KEY: keys.control,
      COORDINATOR_RPC_URL: origin("coordinator"),
      PLATFORM_COORDINATOR_BINDING_PATH: bindingPath,
    };
  const targets = Object.fromEntries(
    [...CONTROLS, ...BUSINESS].map((kind) => {
      const controlRole = CONTROLS.includes(kind),
        mode = kind.slice(8),
        artifactRoot = controlRole
          ? target.controlArtifactRoot
          : target.artifactRoot,
        entry =
          kind === "control-agent"
            ? join(artifactRoot, "installer/control-main.mjs")
            : controlRole
              ? join(artifactRoot, "installer/control-foundation.mjs")
              : join(
                  artifactRoot,
                  "api/apps/api/dist/roles",
                  kind === "api"
                    ? "control-api-main.js"
                    : "coordinator-main.js",
                ),
        component = controlRole ? engine : components[kind],
        env = {
          ...(controlRole
            ? {
                ...common,
                PLATFORM_PROCESS_ROLE:
                  kind === "control-agent"
                    ? "upgrade-control"
                    : "control-foundation",
              }
            : kind === "api"
              ? apiEnv
              : coordinatorEnv),
          PLATFORM_PROCESS_START_IDENTITY: starts[kind],
          PLATFORM_ARTIFACT_DIGEST: component.artifactDigest,
        };
      return [
        kind,
        {
          kind,
          ...(kind.startsWith("control-") && kind !== "control-agent"
            ? { mode }
            : {}),
          origin:
            kind === "control-agent"
              ? origin("control")
              : kind === "control-supervisor"
                ? origin("supervisor")
                : kind === "control-entry"
                  ? origin("entry")
                  : origin(kind === "api" ? "apiA" : "coordinator"),
          entry,
          args: [
            entry,
            ...(kind === "control-agent"
              ? [agentConfigPath]
              : controlRole
                ? [c.controlFoundationEntries[mode].configPath]
                : []),
          ],
          cwd: join(artifactRoot, controlRole ? "installer" : "api"),
          artifactRoot,
          env,
          resources: input.capacityBudgets.migrationTargets[kind],
          capacityAllocationId: "migration-" + kind,
          record: {
            kind,
            startIdentity: starts[kind],
            artifactDigest: component.artifactDigest,
            inputFingerprint: component.inputFingerprint,
          },
        },
      ];
    }),
  );
  const source = {
    foundation: {
      ...h.roles.foundation,
      capacityAllocationId: "legacy-foundation",
    },
    installer: {
      ...h.roles.controller,
      role: "installer",
      capacityAllocationId: "legacy-controller",
    },
    coordinator: {
      ...h.roles.coordinator,
      role: "coordinator",
      origin: h.coordinatorOrigin,
      capacityAllocationId: "legacy-coordinator",
    },
  };
  const capacity = await migrationCapacity(input, h, paths, targets, source);
  const sourceEnvironmentPath = join(paths.journal, "original-access-env.json"),
    sourceKeysPath = join(paths.journal, "source-keys.json");
  await atomicJson(sourceEnvironmentPath, {
    ...input.authEnv,
    UPGRADE_SESSION_SECRET: keys.upgradeSession,
  });
  await atomicJson(sourceKeysPath, {
    controller: keys.controller,
    control: keys.control,
  });
  const migrationId = randomUUID(),
    deadline = Date.now() + input.migrationBudgetMs,
    rollbackDeadline = deadline + input.rollbackBudgetMs;
  invariant(
    Number.isSafeInteger(input.migrationBudgetMs) &&
      input.migrationBudgetMs > 0 &&
      Number.isSafeInteger(input.rollbackBudgetMs) &&
      input.rollbackBudgetMs > 0,
    "MIGRATION_NATIVE_FIXED_BUDGET_REQUIRED",
  );
  const config = {
    apiRoot: join(target.artifactRoot, "api"),
    businessPath: h.businessDatabasePath,
    exportPath: join(paths.journal, "metadata-export.sqlite"),
    controlPath: controlDbPath,
    accessPath,
    instanceId: input.instanceId,
    migrationId,
    epochFloor,
    limits: input.migrationLimits,
    sourceCoordinator: {
      artifactDigest: h.roles.coordinator.artifactDigest,
      generation: sourceIdentity.coordinatorGeneration,
      metadataPath: "/internal/application/identity",
      origin: h.coordinatorOrigin,
      startIdentity: h.roles.coordinator.startIdentity,
    },
    sourceInstallationKeysPath: sourceKeysPath,
    sourceEnvironmentPath,
    runtime: {
      schemaVersion: 1,
      migrationId,
      instanceId: input.instanceId,
      deadline,
      rollbackDeadline,
      actionBudgetMs: input.actionBudgetMs,
      journalRoot: paths.journal,
      source,
      targets,
      keys: {
        controller: keys.controller,
        upgradeControl: keys.upgradeControl,
        control: keys.control,
        supervisor: keys.supervisor,
        entry: keys.entry,
      },
      capacity,
      bindings: {
        coordinatorPath: bindingPath,
        originalCoordinatorDigest: digest(originalCoordinator),
        originalCoordinatorSnapshotPath: snapshotPath,
      },
      protectedRuntimeRoots: [paths.owner, paths.futureOwners],
      protectedOwners: [h.roles.owner],
      protectedProcesses,
      adapter: c,
      procRoot: input.hostProcRoot ?? "/host/proc",
      runnerProcRoot: input.runnerProcRoot ?? "/proc",
      entryOrigin: origin("entry"),
      entryControlOrigin: origin("entryControl"),
      supervisorOrigin: origin("supervisor"),
      entryBindingDigest: digest(initialBinding),
      legacyProcessRoot: join(paths.installer, "processes"),
      installedRolesRoot: join(
        input.root,
        "supervisor-publication/installed-roles",
      ),
      retiredCoordinatorRoot: join(
        input.root,
        "supervisor-publication/retired-coordinators",
      ),
      controlPackage: {
        artifactRoot: target.controlArtifactRoot,
        manifestPath: target.controlManifestPath,
        trustRootPath: input.qa.trustRootPath,
      },
      businessPackage: {
        artifactRoot: target.artifactRoot,
        envelopePath: target.manifestPath,
        currentSourcePath: currentPath,
        trustRootPath: input.qa.trustRootPath,
        archivePath,
      },
      migrationSourcePath,
    },
  };
  const configPath = join(paths.journal, "migration-config.json");
  await atomicJson(configPath, config);
  const ownership = await Promise.all(
    [
      configPath,
      sourceEnvironmentPath,
      sourceKeysPath,
      agentConfigPath,
      ...Object.values(c.controlFoundationEntries).map((x) => x.configPath),
    ].map((path) => fs.stat(path)),
  );
  invariant(
    ownership.every(
      (s) =>
        s.uid === input.uid && s.gid === input.gid && (s.mode & 0o077) === 0,
    ),
    "MIGRATION_NATIVE_TARGET_PRIVATE_OWNERSHIP_INVALID",
  );
  await atomicJson(join(paths.journal, "native-prepared-input.json"), {
    instanceId: input.instanceId,
    migrationId,
    configDigest: digest(config),
    sourceManifestDigest: h.provisionReceipt.sourceManifestDigest,
    sourceArchiveDigest: h.provisionReceipt.archive.digest,
    targetManifestDigest: signed.manifestDigest,
    controlPackageDigest: control.packageDigest,
    uid: input.uid,
    gid: input.gid,
    nativeResult: "not-run",
  });
  return {
    configPath,
    config,
    paths,
    targets,
    controlDbPath,
    accessPath,
    agentConfigPath,
    entryOrigin: origin("entry"),
    controlOrigin: origin("control"),
    migrationId,
    capacity,
  };
}

async function migrationCapacity(input, h, paths, targets, source) {
  const diskPath = input.capacityDevicePath ?? input.root,
    s = await fs.stat(diskPath),
    device = {
      id: input.capacityDeviceId ?? "instance-fs",
      path: diskPath,
      dev: String(s.dev),
      majorMinor: linuxDevice(s.dev),
    },
    config = {
      schemaVersion: 1,
      instanceId: input.instanceId,
      sourceDigest: digest(h.release.components),
      hostProcRoot: input.hostProcRoot ?? "/host/proc",
      dockerSocketPath: "/var/run/docker.sock",
      devices: [device],
      sampleIntervalMs: 250,
      timeoutMs: 2000,
      ioQualificationPath: input.ioQualificationPath,
      ioEffectiveBudgetBytesPerSecond: input.ioEffectiveBudgetBytesPerSecond,
      ioQualificationRawDigest: input.ioQualificationRawDigest,
      observationPath: join(paths.capacity, "observation.json"),
    },
    sample = await sampleLinuxCapacity(config, {
      signal: AbortSignal.timeout(2000),
    }),
    allocations = Object.fromEntries(
      [
        "source",
        "retainedOwners",
        "retainedGuests",
        "existingCandidates",
        "candidate",
        "verification",
        "control",
        "recovery",
      ].map((k) => [k, []]),
    ),
    residents = [];
  for (const [name, record] of Object.entries(h.roles)) {
    const actual = sample.containers.find(
      (x) => x.containerId === record.containerId,
    );
    invariant(
      actual &&
        actual.startIdentity === record.startIdentity &&
        actual.artifactDigest === record.artifactDigest,
      "MIGRATION_NATIVE_CAPACITY_SOURCE_MISMATCH",
    );
    const id = "legacy-" + name,
      resources = input.capacityBudgets.initial[name];
    invariant(resources, "MIGRATION_NATIVE_SOURCE_BUDGET_REQUIRED");
    residents.push({ id, containers: [actual] });
    allocations[name === "owner" ? "retainedOwners" : "source"].push({
      id,
      resident: true,
      identityDigest: capacityResidentIdentity([actual]),
      resources,
    });
  }
  invariant(
    sample.containers.filter((x) => x.instanceId === input.instanceId)
      .length === residents.length,
    "MIGRATION_NATIVE_CAPACITY_INVENTORY_UNKNOWN",
  );
  allocations.source.push({
    id: "host-overhead",
    resident: true,
    identityDigest: capacityHostIdentity(sample, input.instanceId),
    resources: input.capacityBudgets.hostOverhead,
  });
  for (const [kind, t] of Object.entries(targets))
    allocations[CONTROLS.includes(kind) ? "control" : "candidate"].push({
      id: t.capacityAllocationId,
      resident: false,
      identityDigest: digest({
        kind,
        startIdentity: t.record.startIdentity,
        artifactDigest: t.record.artifactDigest,
      }),
      resources: t.resources,
    });
  for (const category of ["verification", "recovery"])
    for (const [id, resources] of Object.entries(
      input.capacityBudgets[category] ?? {},
    ))
      allocations[category].push({
        id,
        resident: false,
        identityDigest: digest({ id, category }),
        resources,
      });
  config.residents = residents;
  const plan = freezeCapacityBudget({
      instanceId: input.instanceId,
      sourceDigest: config.sourceDigest,
      maxObservationAgeMs: 5000,
      limits: {
        memoryBytes: sample.memory.total,
        cpuMilliCores: sample.cpu.cpus * 1000,
        ioBytesPerSecond: input.ioEffectiveBudgetBytesPerSecond,
        disks: { [device.id]: sample.devices[0].capacityBytes },
      },
      allocations,
    }),
    planPath = join(paths.capacity, "plan.json"),
    configPath = join(paths.capacity, "collector.json");
  await atomicJson(planPath, plan);
  const observation = await createControlCapacityCollector({ config }).collect({
      plan,
      expectedRevision: 0,
    }),
    admission = evaluateCapacityAdmission({ plan, observation });
  invariant(
    admission.qualified,
    admission.reason ?? "MIGRATION_NATIVE_CAPACITY_DEFERRED",
  );
  await atomicJson(configPath, config);
  return {
    planDigest: plan.planDigest,
    planPath,
    configPath,
    observationPath: config.observationPath,
  };
}
