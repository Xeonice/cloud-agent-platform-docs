import { createRequire } from "node:module";
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { join, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs/promises";
import {
  atomicJson,
  secureDirectory,
  readJson,
  treeManifest,
} from "../../deploy/upgrade/io.mjs";
import {
  invariant,
  canonical,
  digest,
  loadTrustRoot,
  verifySignedManifest,
} from "../../deploy/upgrade/trust.mjs";
import { command } from "../../deploy/upgrade/artifacts.mjs";
import {
  createProductionRoleAdapter,
  execute,
} from "../../deploy/upgrade/production-role-adapter.mjs";
import { createCoordinatorClient } from "../../deploy/upgrade/coordinator-client.mjs";
import { createControlInspectorClient } from "../../deploy/upgrade/control-inspector-client.mjs";
import { createControlAuthority } from "../../deploy/upgrade/control-authority.mjs";
import { createContractRetirement } from "../../deploy/upgrade/contract-retirement.mjs";
import { actualInstallerIdentity } from "../../deploy/upgrade/installer-identity.mjs";
import { verifyInstalledControlPackage } from "../../deploy/upgrade/control-package.mjs";
import {
  createControlCapacityCollector,
  sampleLinuxCapacity,
  capacityResidentIdentity,
  capacityHostIdentity,
  linuxDevice,
} from "../../deploy/upgrade/control-capacity-collector.mjs";
import {
  freezeCapacityBudget,
  evaluateCapacityAdmission,
} from "../../deploy/upgrade/capacity-admission.mjs";

const RESERVE = 4 * 1024 ** 3,
  ID = /^upgrade-acceptance-[a-zA-Z0-9._-]{1,44}$/;
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
  "supervisor",
  "entry",
  "entryControl",
  "control",
];
async function freePort() {
  const listener = createServer();
  await new Promise((ok, fail) => {
    listener.once("error", fail);
    listener.listen(0, "127.0.0.1", ok);
  });
  const port = listener.address().port;
  await new Promise((ok) => listener.close(ok));
  return port;
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
    } catch {}
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw Object.assign(Error("Actual independent role is not ready"), {
    code: "INDEPENDENT_ROLE_NOT_READY",
  });
}
async function reserve(root) {
  const actual = await fs.statfs(root);
  invariant(
    actual.bavail * actual.bsize >= RESERVE,
    "NATIVE_QA_DISK_RESERVE_REQUIRED",
  );
}
const headers = (key, instanceId) => ({
  "x-platform-internal-key": key,
  "x-platform-instance-id": instanceId,
});

/** Fresh installation using only actual immutable production entrypoints. The
 * administrator owns cold initialization; the long-lived Agent never receives
 * business DB, SDK home, Owner key or Docker socket. No legacy Controller runs. */
export async function startIndependentUpgradeHarness(input) {
  invariant(
    process.platform === "linux" &&
      process.arch === "arm64" &&
      Number(process.versions.node.split(".")[0]) === 22,
    "INDEPENDENT_NATIVE_LINUX_ARM64_NODE22_REQUIRED",
  );
  invariant(
    input.isolated === true &&
      ID.test(input.instanceId) &&
      input.docker?.dedicated === true &&
      [
        "root",
        "initialRoot",
        "controlArtifactRoot",
        "controlManifestPath",
        "initialManifestPath",
        "trustRootPath",
        "catalogFile",
        "qualificationInstallationPath",
      ].every(
        (key) =>
          isAbsolute(input[key] ?? "") && resolve(input[key]) === input[key],
      ) &&
      /^\/var\/lib\/agent-independent-control-qa-[0-9]+\/instances\//.test(
        input.root,
      ),
    "INDEPENDENT_NATIVE_FROZEN_INPUT_REQUIRED",
  );
  const root = await secureDirectory(input.root);
  await reserve(root);
  const startFile = await fs.open(
    join(root, "independent-start-intent.json"),
    "wx",
    0o600,
  );
  try {
    await startFile.writeFile(
      canonical({
        instanceId: input.instanceId,
        initialRoot: input.initialRoot,
        controlArtifactRoot: input.controlArtifactRoot,
        startedAt: new Date().toISOString(),
      }),
    );
    await startFile.sync();
  } finally {
    await startFile.close();
  }
  const ports = {};
  for (const name of PORTS)
    ports[name] = input.ports?.[name] ?? (await freePort());
  invariant(
    new Set(Object.values(ports)).size === PORTS.length,
    "INDEPENDENT_ROLE_PORTS_MUST_DIFFER",
  );
  const origin = (name) => `http://127.0.0.1:${ports[name]}`;
  const keys = { ...input.keys };
  for (const name of [
    "owner",
    "control",
    "controller",
    "upgradeControl",
    "entry",
    "sticky",
    "supervisor",
    "privateEntry",
    "businessProbe",
    "accessAuthority",
    "cookie",
  ])
    keys[name] ??= randomBytes(32).toString("hex");
  invariant(
    Object.values(keys).every(
      (value) => typeof value === "string" && value.length >= 32,
    ) && new Set(Object.values(keys)).size === Object.values(keys).length,
    "INDEPENDENT_ROLE_KEYS_MUST_DIFFER",
  );
  const paths = {};
  for (const [name, folder] of Object.entries({
    data: "business",
    owner: "original-owner",
    futureOwners: "future-owners",
    installer: "installer",
    bindings: "bindings",
    entry: "entry",
    foundation: "foundation",
    control: "control-private",
    ledger: "control-ledger",
    capacity: "capacity-state",
    web: "initial-web-code",
  }))
    paths[name] = await secureDirectory(join(root, folder));
  for (const folder of ["artifacts", "downloads", "processes", "process-code"])
    await secureDirectory(join(paths.installer, folder));
  for (const folder of [
    "supervisor-publication",
    "supervisor-container-records",
  ])
    await secureDirectory(join(root, folder));
  await secureDirectory(join(paths.data, "workspaces"));
  const bundle = await readJson(
    join(input.initialRoot, "upgrade-artifact.json"),
  );
  const actualFiles = (await treeManifest(input.initialRoot)).filter(
    (file) => !["installed.json", "upgrade-artifact.json"].includes(file.path),
  );
  invariant(
    canonical(actualFiles) === canonical(bundle.files) &&
      digest(actualFiles) === bundle.treeDigest,
    "INDEPENDENT_INITIAL_ARTIFACT_CHANGED",
  );
  const signedInitial = verifySignedManifest(
    await readJson(input.initialManifestPath),
    await loadTrustRoot(input.trustRootPath),
  );
  const installedInitial = await readJson(
    join(input.initialRoot, "installed.json"),
  );
  invariant(
    signedInitial.manifest.releaseId === bundle.releaseId &&
      canonical(signedInitial.manifest.components) ===
        canonical(bundle.components) &&
      signedInitial.manifest.packages.some(
        (pkg) =>
          pkg.platform === "linux" &&
          pkg.arch === "arm64" &&
          pkg.digest === installedInitial.packageDigest,
      ),
    "INDEPENDENT_SIGNED_INITIAL_PACKAGE_REQUIRED",
  );
  const release = {
    ...input.initialRelease,
    productionWebBinding: origin("entry"),
  };
  invariant(
    release.activationGeneration === 1 &&
      release.schema === 29 &&
      canonical(release.components) === canonical(bundle.components),
    "INDEPENDENT_INITIAL_RELEASE_SCOPE_INVALID",
  );
  const startIds = Object.fromEntries(
    [
      "owner",
      "coordinator",
      "apiA",
      "webA",
      "control",
      "entry",
      "supervisor",
    ].map((name) => [name, randomUUID()]),
  );
  const controlIdentity = await actualInstallerIdentity({
    instanceId: input.instanceId,
    startIdentity: startIds.control,
    root: join(input.controlArtifactRoot, "installer"),
  });
  const verifiedControl = await verifyInstalledControlPackage({
    artifactRoot: input.controlArtifactRoot,
    manifestPath: input.controlManifestPath,
    trustRootPath: input.trustRootPath,
    engineIdentity: controlIdentity,
  });
  invariant(
    release.components.installer?.artifactDigest ===
      controlIdentity.artifactDigest,
    "INDEPENDENT_STABLE_ENGINE_MUST_BE_PINNED",
  );
  const bindingPath = join(paths.bindings, "coordinator.json"),
    ownerBindingPath = join(paths.bindings, "owners.json"),
    installedReleasePath = join(paths.bindings, "installed-release.json");
  await atomicJson(bindingPath, {
    instanceId: input.instanceId,
    state: "ready",
    origin: origin("coordinator"),
    generation: 2,
    artifactDigest: release.components.coordinator.artifactDigest,
  });
  await atomicJson(ownerBindingPath, {
    instanceId: input.instanceId,
    activeOwnerId: "original-owner",
    owners: [
      {
        ownerId: "original-owner",
        endpoint: origin("owner"),
        ...release.components.owner,
      },
    ],
  });
  await atomicJson(installedReleasePath, {
    release,
    artifactRoot: input.initialRoot,
  });
  const businessPath = join(paths.data, "platform.db"),
    controlDbPath = join(paths.ledger, "control.db");
  const coldConfig = join(paths.foundation, "cold-business.json");
  await atomicJson(coldConfig, {
    instanceId: input.instanceId,
    businessPath,
    controlPath: controlDbPath,
    migrationsFolder: join(input.initialRoot, "api/drizzle"),
    coordinatorArtifactRoot: input.initialRoot,
    deadline: Date.now() + 120000,
  });
  const coldReceipt = JSON.parse(
    (
      await command(
        process.execPath,
        [
          join(
            input.initialRoot,
            "api/apps/api/dist/tooling/bootstrap-independent-installation.js",
          ),
          coldConfig,
        ],
        {
          cwd: join(input.initialRoot, "api"),
          env: {
            NODE_ENV: "production",
            PATH: process.env.PATH,
            PLATFORM_PROCESS_ROLE: "installation-admin",
          },
        },
      )
    ).trim(),
  );
  const { receiptDigest, ...coldFacts } = coldReceipt;
  invariant(
    coldReceipt.instanceId === input.instanceId &&
      digest(coldFacts) === receiptDigest &&
      coldReceipt.confirmed === false &&
      coldReceipt.temporaryWriter?.expires_at === 0,
    "INDEPENDENT_COLD_BOOTSTRAP_UNCONFIRMED",
  );
  await atomicJson(join(root, "cold-business-receipt.json"), coldReceipt);
  const qualificationProof = join(
    paths.control,
    "qualification-installation.json",
  );
  await fs.copyFile(
    input.qualificationInstallationPath,
    qualificationProof,
    fs.constants.COPYFILE_EXCL,
  );
  await fs.chmod(qualificationProof, 0o600);
  const descriptor = join(paths.control, "control-package.json");
  await fs.copyFile(
    input.controlManifestPath,
    descriptor,
    fs.constants.COPYFILE_EXCL,
  );
  await fs.chmod(descriptor, 0o600);
  const agentCatalog = join(paths.control, "catalog.json");
  await fs.copyFile(
    input.catalogFile,
    agentCatalog,
    fs.constants.COPYFILE_EXCL,
  );
  await fs.chmod(agentCatalog, 0o600);
  const capacityPlanPath = join(paths.capacity, "plan.json"),
    resourceObservationPath = join(paths.capacity, "observation.json");
  const stableControl = {
    origin: origin("control"),
    key: keys.upgradeControl,
    accessKey: keys.accessAuthority,
    statePath: join(paths.foundation, "supervisor.db"),
    capacityPlanPath,
    resourceObservationPath,
    referenceStatePath: join(paths.capacity, "references.json"),
    controlDbPath,
    agentStartIdentity: startIds.control,
    capacityCollectorConfigPath: join(paths.capacity, "collector.json"),
    capacityTransitionRoot: join(paths.capacity, "transitions"),
    capacityTemplates: Object.fromEntries(
      ["api", "web", "coordinator", "owner"].map((kind) => [kind, {
        allocationId: input.capacityAllocationIds?.[kind],
        resources: input.capacityBudgets?.candidate?.[kind],
      }]),
    ),
  };
  const foundationInput = Object.fromEntries(
    Object.entries(input).filter(
      ([name]) =>
        ![
          "keys",
          "authEnv",
          "runtimeCredential",
          "localModel",
          "initialRelease",
          "scenarios",
        ].includes(name),
    ),
  );
  const c = {
    ...foundationInput,
    kind: "idle-first-bootstrap-experiment",
    artifactRoot: input.initialRoot,
    businessHostPath: paths.data,
    uid: process.getuid(),
    gid: process.getgid(),
    ports,
    publicOrigin: origin("entry"),
    allowedOrigins: [origin("entry")],
    stableControl,
    controlArtifactRoot: input.controlArtifactRoot,
    controlAgentArtifactRoot: input.controlArtifactRoot,
    controlPrivateRoot: paths.control,
    controlLedgerRoot: paths.ledger,
    controlDownloadRoot: join(paths.installer, "downloads"),
    capacityStateRoot: paths.capacity,
    controlFoundationRoot: paths.foundation,
    controlEntryRoot: paths.entry,
    controlEntryWebRoots: [
      join(input.initialRoot, "web"),
      join(paths.installer, "process-code"),
    ],
    controlFutureOwnerRoot: paths.futureOwners,
    controlAgentStartIdentity: startIds.control,
    runtimeRoots: [paths.owner, paths.futureOwners],
    existingRuntimeRoots: [paths.owner, paths.futureOwners],
    procRoot: "/host/proc",
    cgroupRoot: "/host/cgroup",
    controlAgentResources: input.controlRoleResources?.agent,
    controlFoundationEntries: Object.fromEntries(
      ["entry", "supervisor"].map((mode) => [
        mode,
        {
          startIdentity: startIds[mode],
          configPath: join(paths.foundation, mode + ".json"),
          resources: input.controlRoleResources?.[mode],
        },
      ]),
    ),
  };
  const adapter = await createProductionRoleAdapter(c),
    roles = {},
    initialBinding = {
      instanceId: input.instanceId,
      attemptId: randomUUID(),
      fence: 1,
      routeGeneration: 1,
      weight: 0,
      oldApi: {
        origin: origin("apiA"),
        digest: release.components.api.artifactDigest,
      },
      candidateApi: null,
      web: {
        origin: origin("webA"),
        root: join(input.initialRoot, "web"),
        digest: release.components.web.artifactDigest,
        treeDigest: bundle.treeDigest,
      },
      retainedWeb: [],
    };
  const common = {
    NODE_ENV: "production",
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOST: "127.0.0.1",
    PLATFORM_INSTANCE_ID: input.instanceId,
    ...input.runtimeEnv,
  };
  invariant(
    Object.keys(input.runtimeEnv ?? {}).every((name) =>
      [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "NODE_USE_ENV_PROXY",
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "LANG",
        "TZ",
        "DISABLE_CREDENTIAL_REFRESH_SCANNER",
      ].includes(name),
    ),
    "INDEPENDENT_RUNTIME_ENV_EXCESS_AUTHORITY",
  );
  const network = { API_ALLOWED_ORIGINS: origin("entry") };
  const access = {
    UPGRADE_ACCESS_AUTHORITY_ORIGIN: origin("control"),
    UPGRADE_ACCESS_AUTHORITY_KEY: keys.accessAuthority,
  };
  const controlEnv = {
    ...network,
    ...access,
    PLATFORM_CONTROL_RPC_KEY: keys.control,
    COORDINATOR_RPC_URL: origin("coordinator"),
    PLATFORM_COORDINATOR_BINDING_PATH: bindingPath,
  };
  const ownerEnv = {
    PLATFORM_COORDINATOR_RPC_KEY: keys.owner,
    SANDBOX_DEFAULT_PROVIDER: "boxlite",
  };
  const coordinatorEnv = {
    ...network,
    ...access,
    PLATFORM_CONTROL_RPC_KEY: keys.control,
    PLATFORM_CONTROLLER_RPC_KEY: keys.controller,
    PLATFORM_COORDINATOR_RPC_KEY: keys.owner,
    PLATFORM_COORDINATOR_BINDING_PATH: bindingPath,
    PLATFORM_RUNTIME_OWNER_BINDING_PATH: ownerBindingPath,
    COORDINATOR_RPC_URL: origin("coordinator"),
    RUNTIME_OWNER_RPC_URL: origin("owner"),
    DATA_ROOT: paths.data,
    DATABASE_URL: "/data/platform.db",
    MIGRATIONS_DIR: join(input.initialRoot, "api/drizzle"),
    UPGRADE_TRUST_ROOT_PATH: input.trustRootPath,
    UPGRADE_CATALOG_FILE: input.catalogFile,
    UPGRADE_QUALIFICATION_INSTALLATION_PATH:
      input.qualificationInstallationPath,
    UPGRADE_INITIAL_RELEASE_PATH: installedReleasePath,
    UPGRADE_INITIAL_ARTIFACT_ROOT: input.initialRoot,
    UPGRADE_INSTALLER_ROOT: paths.installer,
    PLATFORM_ENTRY_ORIGIN: origin("entry"),
    PLATFORM_ENTRY_CONTROL_ORIGIN: origin("entryControl"),
    PLATFORM_ENTRY_CONTROL_KEY: keys.controller,
    PLATFORM_INSTALLER_SUPERVISOR_ORIGIN: origin("supervisor"),
    PLATFORM_INSTALLER_SUPERVISOR_KEY: keys.controller,
    UPGRADE_CONTROL_DATABASE_PATH: controlDbPath,
    UPGRADE_CONTROL_ORIGIN: origin("control"),
    UPGRADE_BUSINESS_PROBE_KEY: keys.businessProbe,
    SANDBOX_DEFAULT_PROVIDER: "boxlite",
    SANDBOX_RECONCILE_ON_BOOT: "false",
  };
  async function launch(name, kind, entry, env, options = {}) {
    await reserve(root);
    const artifactRoot = [
      "control-agent",
      "control-entry",
      "control-supervisor",
    ].includes(kind)
      ? input.controlArtifactRoot
      : input.initialRoot;
    const component = release.components[kind] ?? release.components.api;
    const record = {
      instanceId: input.instanceId,
      kind,
      attemptId: "cold-install",
      operationId: "cold-install",
      commandId: "cold-install:" + name,
      startIdentity: startIds[name],
      artifactDigest: kind.startsWith("control-")
        ? controlIdentity.artifactDigest
        : component.artifactDigest,
      inputFingerprint: kind.startsWith("control-")
        ? controlIdentity.inputFingerprint
        : component.inputFingerprint,
      ...options.record,
    };
    const spec = {
      kind,
      resources: input.capacityBudgets?.initial?.[name],
      entry,
      args: [entry, ...(options.args ?? [])],
      cwd: options.cwd ?? join(artifactRoot, "api"),
      artifactRoot,
      record,
      env: {
        ...common,
        ...env,
        PLATFORM_PROCESS_START_IDENTITY: record.startIdentity,
        PLATFORM_ARTIFACT_DIGEST: record.artifactDigest,
      },
      ownerHome: options.ownerHome,
      assertBeforeDispatch: () => reserve(root),
      stableBootstrap: true,
    };
    const result =
      kind === "control-agent"
        ? await adapter.launchControlAgent(spec)
        : kind.startsWith("control-")
          ? await adapter.launchIndependentFoundation({
              ...spec,
              mode: kind.slice(8),
            })
          : await adapter.launch(spec);
    roles[name] = { ...record, ...result, kind, artifactRoot };
    return roles[name];
  }
  const foundationKeys = Object.fromEntries(
    Object.entries(keys).filter(([name]) => name !== "cookie"),
  );
  const context = {
    paths,
    keys: foundationKeys,
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
    startIdentity: startIds.control,
    controlArtifactRoot: input.controlArtifactRoot,
    controlManifestPath: descriptor,
    trustRootPath: input.trustRootPath,
    catalogFile: agentCatalog,
    qualificationInstallationPath: qualificationProof,
    controlRoot: paths.control,
    controlLedgerRoot: paths.ledger,
    downloadRoot: join(paths.installer, "downloads"),
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
    controlPort: ports.control,
    allowedOrigins: [origin("entry")],
    epochFloor: 1,
  });
  await launch(
    "control",
    "control-agent",
    join(input.controlArtifactRoot, "installer/control-main.mjs"),
    {
      PLATFORM_PROCESS_ROLE: "upgrade-control",
      ACCESS_PASSCODE: input.authEnv.ACCESS_PASSCODE,
      PASSCODE_COOKIE_SECRET: keys.cookie,
    },
    {
      args: [agentConfigPath],
      cwd: join(input.controlArtifactRoot, "installer"),
    },
  );
  await waitFor(
    origin("control"),
    "/metadata",
    headers(keys.upgradeControl, input.instanceId),
  );
  for (const mode of ["supervisor", "entry"])
    await launch(
      mode,
      "control-" + mode,
      join(input.controlArtifactRoot, "installer/control-foundation.mjs"),
      { PLATFORM_PROCESS_ROLE: "control-foundation" },
      {
        args: [c.controlFoundationEntries[mode].configPath],
        cwd: join(input.controlArtifactRoot, "installer"),
      },
    );
  await waitFor(
    origin("supervisor"),
    "/metadata",
    headers(keys.supervisor, input.instanceId),
  );
  const apiRoot = join(input.initialRoot, "api"),
    apiRoles = join(apiRoot, "apps/api/dist/roles");
  await launch(
    "owner",
    "owner",
    join(apiRoles, "runtime-owner-main.js"),
    {
      ...ownerEnv,
      PLATFORM_PROCESS_ROLE: "runtime-owner",
      RUNTIME_OWNER_ID: "original-owner",
      RUNTIME_OWNER_PORT: String(ports.owner),
      RUNTIME_OWNER_HOME: paths.owner,
      BOXLITE_HOME: join(paths.owner, "boxlite"),
      HOME: paths.owner,
    },
    { ownerHome: paths.owner },
  );
  await waitFor(
    origin("owner"),
    "/runtime/metadata",
    headers(keys.owner, input.instanceId),
  );
  await launch(
    "coordinator",
    "coordinator",
    join(apiRoles, "coordinator-main.js"),
    {
      ...coordinatorEnv,
      PLATFORM_PROCESS_ROLE: "coordinator",
      PORT: String(ports.coordinator),
    },
  );
  await waitFor(origin("coordinator"), "/api/health");
  await launch("apiA", "api", join(apiRoles, "control-api-main.js"), {
    ...controlEnv,
    PLATFORM_PROCESS_ROLE: "control",
    PORT: String(ports.apiA),
  });
  await waitFor(origin("apiA"), "/api/health");
  await fs.cp(join(input.initialRoot, "web"), paths.web, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  await launch(
    "webA",
    "web",
    join(paths.web, "server.js"),
    { PORT: String(ports.webA), HOSTNAME: "127.0.0.1" },
    {
      cwd: paths.web,
      record: { artifactDigest: release.components.web.artifactDigest },
    },
  );
  await waitFor(origin("webA"), "/web-build");
  const coordinator = createCoordinatorClient({
    origin: origin("coordinator"),
    instanceId: input.instanceId,
    key: keys.controller,
    bindingPath,
    independentControl: true,
  });
  const inspector = createControlInspectorClient({
    client: coordinator,
    instanceId: input.instanceId,
  });
  const retirement = await createContractRetirement({
    directory: join(root, "supervisor-publication/installed-roles"),
    instanceId: input.instanceId,
    coordinator,
    launchAdapter: adapter,
    controlKey: keys.control,
    controllerKey: keys.controller,
    ownerKey: keys.owner,
    businessRoot: paths.data,
  });
  for (const name of ["owner", "coordinator"])
    await retirement.register({
      ...roles[name],
      pid: 1,
      origin: origin(name),
      metadataPath:
        name === "coordinator" ? "/internal/application/identity" : undefined,
      ...(name === "owner"
        ? { ownerId: "original-owner", ownerHome: paths.owner }
        : {}),
      ...release.components[name],
    });
  await inspector.bootstrapProof(release, input.initialRoot);
  const requireApi = createRequire(
      join(input.controlArtifactRoot, "api/apps/api/package.json"),
    ),
    Database = requireApi("better-sqlite3");
  const ledger = new Database(controlDbPath);
  try {
    const { createUpgradeControlStores } = requireApi(
      join(
        input.controlArtifactRoot,
        "api/apps/api/dist/platform/upgrade/control-store-factory.js",
      ),
    );
    const { fromEpochMs } = requireApi("@platform/shared-kernel");
    const stores = createUpgradeControlStores({
      sqlite: ledger,
      instanceId: input.instanceId,
      clock: { now: () => fromEpochMs(Date.now()) },
      ids: { next: randomUUID },
    });
    stores.store.bootstrap(release);
  } finally {
    ledger.close();
  }
  const capacity = await startNativeCapacity({
    input,
    c,
    paths,
    roles,
    sourceDigest: digest(release.components),
  });
  const activate = new Database(controlDbPath);
  try {
    const authority = createControlAuthority({
      sqlite: activate,
      instanceId: input.instanceId,
      epochFloor: 1,
    });
    authority.activate({
      expectedRevision: authority.observe().revision,
      sourceBindingDigest: digest({
        coldReceipt,
        initialBinding,
        roles: Object.values(roles).map(
          ({ containerId, startIdentity, artifactDigest }) => ({
            containerId,
            startIdentity,
            artifactDigest,
          }),
        ),
      }),
    });
  } finally {
    activate.close();
  }
  const info = {
    instanceId: input.instanceId,
    root,
    entryOrigin: origin("entry"),
    controlOrigin: origin("control"),
    businessDatabasePath: businessPath,
    controlDbPath,
    bindingPath,
    ownerBindingPath,
    ports,
    roles,
    paths,
    agentConfigPath,
    controlPackageDigest: verifiedControl.packageDigest,
    coldReceiptDigest: receiptDigest,
  };
  await atomicJson(join(root, "independent-harness.json"), info);
  const docker = (args) =>
    execute(input.docker.cli || "docker", [...input.docker.args, ...args]);
  async function owned(name) {
    invariant(
      [
        "control",
        "coordinator",
        "apiA",
        "webA",
        "entry",
        "supervisor",
      ].includes(name) && roles[name]?.containerId,
      "INDEPENDENT_OWNED_CONTROL_ROLE_REQUIRED",
    );
    const actual = await adapter.inspect(roles[name].containerId);
    invariant(
      actual.startIdentity === roles[name].startIdentity &&
        actual.artifactDigest === roles[name].artifactDigest,
      "INDEPENDENT_PHYSICAL_ROLE_CHANGED",
    );
    return actual;
  }
  return {
    ...info,
    keys,
    coordinator,
    inspector,
    adapter,
    capacity,
    async inspect(name) {
      return adapter.inspect(roles[name].containerId);
    },
    async faultSignal(name, signal) {
      invariant(
        ["SIGKILL", "SIGSTOP", "SIGCONT"].includes(signal),
        "INDEPENDENT_FIXED_FAULT_SIGNAL_REQUIRED",
      );
      const actual = await owned(name);
      invariant(
        actual.running === true,
        "INDEPENDENT_FAULT_TARGET_NOT_RUNNING",
      );
      await docker(["kill", "--signal", signal, actual.containerId]);
      return {
        name,
        signal,
        containerId: actual.containerId,
        startIdentity: actual.startIdentity,
        startedAt: actual.startedAt,
        hostPid: actual.hostPid,
        observedAt: new Date().toISOString(),
      };
    },
    async restartAgentForFault() {
      const before = await owned("control");
      invariant(before.running === false, "INDEPENDENT_AGENT_MUST_BE_STOPPED");
      await docker(["start", before.containerId]);
      await waitFor(
        origin("control"),
        "/metadata",
        headers(keys.upgradeControl, input.instanceId),
      );
      return adapter.inspect(before.containerId);
    },
    async close({ resourcesCleaned = false } = {}) {
      await capacity.close();
      if (!resourcesCleaned) return { preserved: true };
      const db = new Database(businessPath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        invariant(
          db.prepare("SELECT count(*) n FROM sandboxes").get().n === 0 &&
            db
              .prepare(
                "SELECT count(*) n FROM agent_tasks WHERE status='running'",
              )
              .get().n === 0,
          "INDEPENDENT_CLEANUP_TASKS_STILL_ACTIVE",
        );
      } finally {
        db.close();
      }
      const ids = (
        await docker([
          "ps",
          "--no-trunc",
          "--filter",
          "label=agent-platform.instance=" + input.instanceId,
          "--filter",
          "label=agent-platform.installation=" + digest(root),
          "--format",
          "{{.ID}}",
        ])
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      for (const id of ids) {
        const actual = await adapter.inspect(id);
        invariant(
          actual.running &&
            [
              "owner",
              "coordinator",
              "api",
              "web",
              "control-agent",
              "control-entry",
              "control-supervisor",
            ].includes(actual.role),
          "INDEPENDENT_CLEANUP_FOREIGN_ROLE",
        );
        await adapter.signal(id, "SIGTERM");
      }
      return { stopped: true, removed: false };
    },
  };
}

/** Real host accounting. All role peak budgets and IO qualification are supplied
 * explicitly. Missing/changed inventory or qualification closes admission. */
export async function startNativeCapacity({
  input,
  c,
  paths,
  roles,
  sourceDigest,
}) {
  const budgets = input.capacityBudgets;
  invariant(
    budgets && input.ioQualificationPath && input.capacityAllocationIds,
    "INDEPENDENT_EXPLICIT_CAPACITY_BUDGET_REQUIRED",
  );
  const diskPath = input.capacityDevicePath ?? input.root,
    stat = await fs.stat(diskPath),
    device = {
      id: input.capacityDeviceId ?? "instance-fs",
      path: diskPath,
      dev: String(stat.dev),
      majorMinor: linuxDevice(stat.dev),
    };
  const base = {
    schemaVersion: 1,
    instanceId: input.instanceId,
    sourceDigest,
    hostProcRoot: input.hostProcRoot ?? "/host/proc",
    dockerSocketPath: "/var/run/docker.sock",
    devices: [device],
    sampleIntervalMs: 250,
    timeoutMs: 2000,
    ioQualificationPath: input.ioQualificationPath,
    ioEffectiveBudgetBytesPerSecond: input.ioEffectiveBudgetBytesPerSecond,
    ioQualificationRawDigest: input.ioQualificationRawDigest,
    observationPath: join(paths.capacity, "observation.json"),
  };
  const sample = await sampleLinuxCapacity(base, {
      signal: AbortSignal.timeout(2000),
    }),
    residents = [],
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
      ].map((name) => [name, []]),
    );
  for (const [name, record] of Object.entries(roles)) {
    const actual = sample.containers.find(
      (row) => row.containerId === record.containerId,
    );
    invariant(
      actual && actual.startIdentity === record.startIdentity,
      "INDEPENDENT_CAPACITY_ROLE_IDENTITY_UNKNOWN",
    );
    const id = "initial-" + name,
      resources = budgets.initial?.[name];
    invariant(resources, "INDEPENDENT_CAPACITY_ROLE_BUDGET_MISSING");
    residents.push({ id, containers: [actual] });
    allocations[
      name === "owner"
        ? "retainedOwners"
        : ["control", "entry", "supervisor"].includes(name)
          ? "control"
          : "source"
    ].push({
      id,
      resident: true,
      identityDigest: capacityResidentIdentity([actual]),
      resources,
    });
  }
  invariant(
    sample.containers.filter((row) => row.instanceId === input.instanceId)
      .length === residents.length,
    "INDEPENDENT_CAPACITY_INVENTORY_UNKNOWN",
  );
  allocations.source.push({
    id: "host-overhead",
    resident: true,
    identityDigest: capacityHostIdentity(sample, input.instanceId),
    resources: budgets.hostOverhead,
  });
  for (const [kind, id] of Object.entries(input.capacityAllocationIds)) {
    invariant(
      budgets.candidate?.[kind],
      "INDEPENDENT_CANDIDATE_BUDGET_MISSING",
    );
    allocations.candidate.push({
      id,
      resident: false,
      identityDigest: digest({ id, kind }),
      resources: budgets.candidate[kind],
    });
  }
  for (const category of ["verification", "recovery"])
    for (const [id, resources] of Object.entries(budgets[category] ?? {}))
      allocations[category].push({
        id,
        resident: false,
        identityDigest: digest({ id, category }),
        resources,
      });
  const limits = {
    memoryBytes: sample.memory.total,
    cpuMilliCores: sample.cpu.cpus * 1000,
    ioBytesPerSecond: input.ioEffectiveBudgetBytesPerSecond,
    disks: { [device.id]: sample.devices[0].capacityBytes },
  };
  const plan = freezeCapacityBudget({
    instanceId: input.instanceId,
    sourceDigest,
    maxObservationAgeMs: 5000,
    limits,
    allocations,
  });
  const config = { ...base, residents },
    configPath = join(paths.capacity, "collector.json");
  // Publish the collector configuration only after its actual first observation
  // is durable. Until then the production Supervisor sees missing inputs and
  // keeps admission closed. It becomes the sole continuous publisher.
  await atomicJson(join(paths.capacity, "plan.json"), plan);
  const previous = await readJson(base.observationPath, null);
  const actual = await createControlCapacityCollector({ config }).collect({
    plan,
    expectedRevision: previous?.revision ?? 0,
  });
  const admission = evaluateCapacityAdmission({ plan, observation: actual });
  invariant(
    admission.qualified,
    admission.reason ?? "INDEPENDENT_CAPACITY_NOT_QUALIFIED",
  );
  await atomicJson(configPath, config);
  return {
    configPath,
    planPath: join(paths.capacity, "plan.json"),
    publisher: "stable-supervisor",
    initialObservationDigest: digest(actual),
    close: async () => {},
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const harness = await startIndependentUpgradeHarness(
    await readJson(process.argv[2]),
  );
  process.stdout.write(
    JSON.stringify({
      instanceId: harness.instanceId,
      entryOrigin: harness.entryOrigin,
      root: harness.root,
    }) + "\n",
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      void harness.close().then(() => process.exit(0));
    });
}
