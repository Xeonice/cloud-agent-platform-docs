import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import {
  assertBootstrapConfig,
  assertCloneReceipt,
  legacyIdle,
  roleMounts,
  createProductionRoleAdapter,
  verifyReleaseCatalog,
  assertLegacyPhysical,
  verifyBootstrapCatalog,
  assertFoundationCloneMounts,
  assertExperimentalAliases,
  bootstrapDataRoot,
  previewProbeOrigin,
  assertPreviewSource,
  verifySealedCloneFiles,
} from "./bootstrap-upgrade-instance.mjs";
import {
  providerEnvironment,
  roleEnvironment,
} from "../upgrade/production-role-adapter.mjs";
import {
  digest,
  signManifest,
  signQualificationManifest,
  runInputFingerprint,
} from "../upgrade/trust.mjs";

const image = "sha256:" + "a".repeat(64),
  cid = "b".repeat(64);
const status = () => ({
  ready: true,
  idle: true,
  inFlightHTTP: 0,
  activeWS: 0,
  credentialAuth: 0,
  blockers: Object.fromEntries(
    [
      "sandboxes",
      "agentTasks",
      "automationRuns",
      "enabledAutomations",
      "resourceAllocations",
      "cloningProjects",
      "projectCleanupJobs",
    ].map((k) => [k, 0]),
  ),
});
const config = () => ({
  schemaVersion: 1,
  kind: "idle-first-bootstrap",
  instanceId: "agent-platform-main",
  root: "/srv/upgrades/installation",
  artifactRoot: "/srv/upgrades/initial-package",
  businessHostPath:
    "/var/lib/docker/volumes/agent-platform-bootstrap-data/_data",
  trustRootPath: "/srv/upgrades/trust-root.json",
  catalogFile: "/srv/upgrades/catalog.json",
  authEnvPath: "/srv/upgrades/auth.json",
  cloneReceiptPath: "/srv/upgrades/clone.json",
  foundationContainerId: "c".repeat(64),
  original: { containerId: cid, image, startedAt: "2026-10-09T17:02:28Z" },
  runtimeImage: image,
  docker: { dedicated: true, args: ["--host", "unix:///var/run/docker.sock"] },
  ports: Object.fromEntries(
    [
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
    ].map((k, i) => [k, 31000 + i]),
  ),
  publicOrigin: "https://agent.example.com",
  uid: 1000,
  gid: 1000,
});
const receipt = (c) => ({
  kind: "idle-first-bootstrap-clone",
  instanceId: c.instanceId,
  businessHostPath: c.businessHostPath,
  original: c.original,
  originalVolumePreserved: true,
  originalContainerPreserved: true,
  databaseBackupVerified: true,
  completeVolumeBackupVerified: true,
  backupPath: "/srv/upgrades/backups/original.tgz",
  before: status(),
  beforeStop: status(),
  admissionHeld: true,
  oldProcessAbsent: true,
  retainedDestroyedSandboxes: 1,
  extantUserRuntimeHandles: 0,
  activeAgentTasks: 0,
  databaseMigration: {
    from: 25,
    to: 28,
    integrity: "ok",
    foreignKeyViolations: 0,
  },
  businessRowsPreserved: true,
  masterKeyPreserved: true,
  cloneDatabaseDigest: image,
  masterKeyDigest: image,
});
const fails = (fn, code) => assert.throws(fn, (error) => error.code === code);

test("repeatable readonly SQLite preflight permits its actual empty WAL while sealed DB/key hashes stay intact", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "bootstrap-empty-wal-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const D = createRequire(new URL("../../api/package.json", import.meta.url))(
    "better-sqlite3",
  );
  const databasePath = join(root, "platform.db"),
    masterKeyPath = join(root, ".master.key");
  await fs.writeFile(masterKeyPath, "unit-only-private-master-key", {
    mode: 0o600,
  });
  const writer = new D(databasePath);
  writer.pragma("journal_mode = WAL");
  writer.exec(
    "CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES('before')",
  );
  writer.pragma("wal_checkpoint(TRUNCATE)");
  writer.close();
  const fixed = {
    databasePath,
    masterKeyPath,
    databaseDigest: digest(await fs.readFile(databasePath)),
    masterKeyDigest: digest(await fs.readFile(masterKeyPath)),
  };
  await verifySealedCloneFiles(fixed);
  const reader = new D(databasePath, { readonly: true, fileMustExist: true });
  try {
    reader.exec("PRAGMA query_only=ON");
    assert.equal(
      reader.prepare("SELECT value FROM proof").get().value,
      "before",
    );
    assert.equal((await fs.stat(databasePath + "-wal")).size, 0);
    await verifySealedCloneFiles(fixed);
    await verifySealedCloneFiles(fixed);
    const activeWriter = new D(databasePath);
    try {
      activeWriter.exec("INSERT INTO proof VALUES('uncheckpointed')");
      assert.ok((await fs.stat(databasePath + "-wal")).size > 0);
      await assert.rejects(
        verifySealedCloneFiles(fixed),
        (error) => error.code === "BOOTSTRAP_CLONE_CHANGED",
      );
    } finally {
      activeWriter.close();
    }
    await fs.writeFile(masterKeyPath, "changed");
    await assert.rejects(
      verifySealedCloneFiles(fixed),
      (error) => error.code === "BOOTSTRAP_CLONE_CHANGED",
    );
  } finally {
    reader.close();
  }
});

test("fixed provider images survive Owner/Coordinator launches while transport and installer get no provider config", () => {
  const providerEnv = {
    SANDBOX_DEFAULT_PROVIDER: "boxlite",
    SANDBOX_DEFAULT_IMAGE:
      "registry.example.com/team/fixed@sha256:" + "a".repeat(64),
    SANDBOX_BOXLITE_REGISTRY: "registry.example.com",
    SANDBOX_AUTH_HELPER_IMAGE: "registry.example.com/team/helper:v1",
  };
  const c = { ...config(), providerEnv };
  assert.equal(providerEnvironment(c), providerEnv);
  for (const kind of ["owner", "coordinator"])
    assert.deepEqual(
      roleEnvironment(c, kind, {
        NODE_ENV: "production",
        SANDBOX_DEFAULT_IMAGE: "unwanted-default",
      }),
      { NODE_ENV: "production", ...providerEnv },
    );
  for (const kind of ["api", "web", "installer"])
    assert.deepEqual(roleEnvironment(c, kind, { NODE_ENV: "production" }), {
      NODE_ENV: "production",
    });
  for (const forbidden of [
    { BOXLITE_HOME: "/original/home" },
    { DATA_ROOT: "/data" },
    { PLATFORM_COORDINATOR_RPC_KEY: "secret" },
    { SANDBOX_DEFAULT_PROVIDER: "aio" },
    { SANDBOX_DEFAULT_IMAGE: "image\nDATA_ROOT=/data" },
    { SANDBOX_AUTH_HELPER_IMAGE: 1 },
    null,
    false,
    [],
  ])
    fails(
      () => providerEnvironment({ ...c, providerEnv: forbidden }),
      "BOOTSTRAP_PROVIDER_ENV_INVALID",
    );
});

// Unit-only signing fixture. These synthetic reports are never written as release evidence.
function releaseCatalogFixture() {
  const keys = generateKeyPairSync("ed25519"),
    sha = "a".repeat(40);
  const component = {
    artifactDigest: image,
    inputFingerprint: image,
    sourceRevision: sha,
    protocol: { min: 1, max: 2 },
  };
  const manifest = {
    schemaVersion: 2,
    purpose: "release",
    releaseId: "v1.1.0",
    channel: "stable",
    publishedAt: new Date().toISOString(),
    commits: { project: sha, api: sha, web: sha },
    components: {
      api: component,
      coordinator: component,
      installer: component,
      web: { ...component, webRevision: sha },
    },
    packages: [
      {
        platform: "linux",
        arch: "arm64",
        name: "agent-platform-v1.1.0-linux-arm64.tgz",
        digest: image,
        bytes: 1,
        format: "native-tar",
        url: "https://updates.example.com/v1.1.0/agent-platform-v1.1.0-linux-arm64.tgz",
      },
    ],
    upgradePaths: [
      {
        fromRelease: "v1.0.0",
        minSchema: 28,
        maxSchema: 28,
        targetSchema: 28,
        bridgeReleases: [],
        migrationPlanDigest: null,
      },
    ],
    policy: {
      id: "bootstrap-test",
      weights: [1, 5, 25, 100],
      stageDurationMs: 60000,
      minRequests: 100,
      observationFreshnessMs: 5000,
      probeHz: 10,
      requestDeadlineMs: 2000,
      attachDeadlineMs: 5000,
      softErrorDelta: 0.01,
      p95Ratio: 2,
      p95FloorMs: 1000,
      evaluationIntervalMs: 10000,
      consecutiveEvaluations: 2,
      retentionMs: 60000,
      migrationBatchMs: 500,
      maxWalBytes: 100000,
      minFreeBytes: 100000,
      fallbacks: [
        {
          releaseId: "v1.0.0",
          apiDigest: image,
          webDigest: image,
          rehearsed: true,
        },
      ],
      stopUserResources: false,
      restoreLiveVolume: false,
      contractInUpgrade: false,
    },
    evidence: [
      "build",
      "contracts",
      "four-combinations",
      "native-continuity",
      "fault-recovery",
    ].map((kind) => ({
      kind,
      result: "passed",
      inputFingerprint: image,
      reportDigest: image,
      runId: "bootstrap-test-unit-only",
      recordedAt: new Date().toISOString(),
    })),
  };
  const envelope = signManifest(
    manifest,
    "test-release-key",
    keys.privateKey.export({ format: "pem", type: "pkcs8" }),
  );
  const roots = {
    schemaVersion: 1,
    purpose: "release",
    channel: "stable",
    distributionOrigins: ["https://updates.example.com"],
    keys: [
      {
        id: "test-release-key",
        publicKey: keys.publicKey.export({ format: "pem", type: "spki" }),
      },
    ],
  };
  const catalog = {
    schemaVersion: 1,
    channel: "stable",
    releases: [
      {
        releaseId: manifest.releaseId,
        manifestDigest: envelope.manifestDigest,
        envelope,
      },
    ],
  };
  return { roots, catalog };
}

function experimentalCatalogFixture() {
  const c = {
    ...config(),
    kind: "idle-first-bootstrap-experiment",
    instanceId: "agent-platform-exp-20261014",
    qualificationInstallationPath:
      "/srv/upgrades/installation/qualification-proof.json",
  };
  const original = releaseCatalogFixture();
  const keys = generateKeyPairSync("ed25519");
  const manifest = structuredClone(
    original.catalog.releases[0].envelope.manifest,
  );
  manifest.purpose = "qualification";
  const fingerprint = runInputFingerprint(manifest);
  manifest.qualification = {
    instanceId: c.instanceId,
    inputFingerprint: fingerprint,
  };
  manifest.runInputFingerprint = fingerprint;
  for (const evidence of manifest.evidence) {
    evidence.result = "not-run";
    evidence.inputFingerprint = fingerprint;
  }
  for (const fallback of manifest.policy.fallbacks) fallback.rehearsed = false;
  const envelope = signQualificationManifest(
    manifest,
    "experiment-test-key",
    keys.privateKey.export({ format: "pem", type: "pkcs8" }),
  );
  const roots = {
    ...original.roots,
    purpose: "qualification",
    qualificationInstanceId: c.instanceId,
    keys: [
      {
        id: "experiment-test-key",
        publicKey: keys.publicKey.export({ format: "pem", type: "spki" }),
      },
    ],
  };
  const catalog = {
    schemaVersion: 1,
    channel: roots.channel,
    releases: [
      {
        releaseId: manifest.releaseId,
        manifestDigest: envelope.manifestDigest,
        envelope,
      },
    ],
  };
  const proof = {
    purpose: "qualification",
    instanceId: c.instanceId,
    trustRootDigest: digest(roots),
    isolatedRoot: c.root,
  };
  return { c, roots, catalog, proof };
}

test("explicit experiment verifies real qualification signature and pending evidence; ordinary release rejects it", () => {
  const { c, roots, catalog, proof } = experimentalCatalogFixture();
  assert.equal(assertBootstrapConfig(c), c);
  assert.equal(bootstrapDataRoot(c), join(c.root, "business"));
  assert.equal(verifyBootstrapCatalog(c, roots, catalog, proof), catalog);
  assert.equal(
    catalog.releases[0].envelope.manifest.evidence.every(
      (e) => e.result === "not-run",
    ),
    true,
  );
  fails(
    () => verifyBootstrapCatalog(config(), roots, catalog, proof),
    "PRODUCTION_BOOTSTRAP_TRUST_REQUIRED",
  );
  fails(
    () =>
      verifyBootstrapCatalog(c, roots, catalog, {
        ...proof,
        isolatedRoot: "/",
      }),
    "EXPERIMENT_QUALIFICATION_PROOF_MISMATCH",
  );
  fails(
    () =>
      verifyBootstrapCatalog(c, roots, catalog, {
        ...proof,
        instanceId: "other",
      }),
    "EXPERIMENT_QUALIFICATION_PROOF_MISMATCH",
  );
  fails(
    () =>
      verifyBootstrapCatalog(c, roots, catalog, {
        ...proof,
        trustRootDigest: "sha256:" + "f".repeat(64),
      }),
    "EXPERIMENT_QUALIFICATION_PROOF_MISMATCH",
  );
  fails(
    () =>
      verifyBootstrapCatalog(
        c,
        { ...roots, qualificationInstanceId: "other" },
        catalog,
        proof,
      ),
    "EXPERIMENT_QUALIFICATION_TRUST_REQUIRED",
  );
  const tampered = structuredClone(catalog);
  tampered.releases[0].envelope.manifest.releaseId = "v1.2.0";
  fails(
    () => verifyBootstrapCatalog(c, roots, tampered, proof),
    "SIGNATURE_OR_MANIFEST_DIGEST_INVALID",
  );
});

test("experiment requires actual clone source mounted at both aliases and refuses original volume exposure", () => {
  const { c } = experimentalCatalogFixture();
  const old = {
    Mounts: [{ Source: "/original-data", Destination: "/data", RW: true }],
  };
  const foundation = {
    Id: c.foundationContainerId,
    State: { Running: true },
    Mounts: [
      { Source: c.businessHostPath, Destination: "/data", RW: true },
      {
        Source: c.businessHostPath,
        Destination: bootstrapDataRoot(c),
        RW: true,
      },
    ],
  };
  assert.equal(assertFoundationCloneMounts(c, foundation, old), foundation);
  fails(
    () =>
      assertFoundationCloneMounts(
        c,
        { ...foundation, Mounts: foundation.Mounts.slice(0, 1) },
        old,
      ),
    "EXPERIMENT_DUAL_CLONE_ALIAS_REQUIRED",
  );
  fails(
    () =>
      assertFoundationCloneMounts(
        c,
        {
          ...foundation,
          Mounts: [
            foundation.Mounts[0],
            { ...foundation.Mounts[1], Source: "/different-clone" },
          ],
        },
        old,
      ),
    "EXPERIMENT_DUAL_CLONE_ALIAS_REQUIRED",
  );
  fails(
    () =>
      assertFoundationCloneMounts(
        c,
        {
          ...foundation,
          Mounts: [
            ...foundation.Mounts,
            { Source: "/original-data", Destination: "/old", RW: true },
          ],
        },
        old,
      ),
    "BOOTSTRAP_FOUNDATION_CLONE_MOUNT_REQUIRED",
  );
});

test("preview is explicit qualification only and keeps its listener ports distinct from live source", () => {
  const { c } = experimentalCatalogFixture();
  c.legacyProbeOrigin = "http://127.0.0.1:3000";
  assert.equal(previewProbeOrigin(c), "http://127.0.0.1:3000");
  fails(
    () =>
      previewProbeOrigin({
        ...config(),
        legacyProbeOrigin: c.legacyProbeOrigin,
      }),
    "PREVIEW_REQUIRES_EXPLICIT_EXPERIMENT",
  );
  for (const legacyProbeOrigin of [
    "https://example.com:3000",
    "http://192.168.1.2:3000",
    "http://user:pass@127.0.0.1:3000",
    `http://127.0.0.1:${c.ports.entry}`,
    "http://127.0.0.1:3000/other",
  ])
    fails(
      () => previewProbeOrigin({ ...c, legacyProbeOrigin }),
      "PREVIEW_LEGACY_LOOPBACK_ORIGIN_REQUIRED",
    );
});

test("preview observes real idle source and refuses stopped source, maintenance, connections or user work", () => {
  const { c } = experimentalCatalogFixture();
  c.legacyProbeOrigin = "http://127.0.0.1:3000";
  const old = {
    Id: c.original.containerId,
    Image: c.original.image,
    State: { Running: true, Pid: 100, StartedAt: c.original.startedAt },
    Mounts: [{ Source: "/original-data", Destination: "/data", RW: true }],
  };
  const r = {
      ...receipt(c),
      admissionHeld: false,
      oldProcessAbsent: false,
      beforeStop: null,
    },
    value = { ...status(), draining: false };
  assert.equal(assertPreviewSource(c, old, value, r).pid, 100);
  fails(
    () =>
      assertPreviewSource(
        c,
        { ...old, State: { ...old.State, Running: false, Pid: 0 } },
        value,
        r,
      ),
    "PREVIEW_SOURCE_NOT_LIVE_IDLE",
  );
  fails(
    () => assertPreviewSource(c, old, { ...value, draining: true }, r),
    "PREVIEW_SOURCE_NOT_LIVE_IDLE",
  );
  fails(
    () => assertPreviewSource(c, old, { ...value, activeWS: 1 }, r),
    "PREVIEW_SOURCE_NOT_LIVE_IDLE",
  );
  fails(
    () =>
      assertPreviewSource(
        c,
        old,
        { ...value, blockers: { ...value.blockers, agentTasks: 1 } },
        r,
      ),
    "PREVIEW_SOURCE_NOT_LIVE_IDLE",
  );
  fails(
    () => assertPreviewSource(c, old, value, { ...r, admissionHeld: true }),
    "PREVIEW_SOURCE_NOT_LIVE_IDLE",
  );
  fails(
    () =>
      assertPreviewSource(c, old, value, { ...r, extantUserRuntimeHandles: 1 }),
    "PREVIEW_SOURCE_NOT_LIVE_IDLE",
  );
});

test("experiment alias verification compares actual dev/inode for database and master key, without SDK access", async () => {
  const { c } = experimentalCatalogFixture();
  const seen = [];
  const stat = async (path) => {
    seen.push(path);
    return {
      isFile: () => true,
      isSymbolicLink: () => false,
      dev: 1,
      ino: path.endsWith(".master.key") ? 10 : 20,
      size: 100,
    };
  };
  await assertExperimentalAliases(c, { stat });
  assert.deepEqual(seen, [
    "/data/platform.db",
    join(c.root, "business/platform.db"),
    "/data/.master.key",
    join(c.root, "business/.master.key"),
  ]);
  await assert.rejects(
    assertExperimentalAliases(c, {
      stat: async (path) => ({
        ...(await stat(path)),
        ino: path.startsWith(c.root) ? 99 : 20,
      }),
    }),
    (error) => error.code === "EXPERIMENT_CLONE_ALIAS_PHYSICAL_MISMATCH",
  );
});

test("experimental owner has only workspace dual aliases; coordinator has actual clone dual aliases and read-only qualification proof", () => {
  const { c } = experimentalCatalogFixture();
  const owner = roleMounts(c, {
    kind: "owner",
    artifactRoot: c.artifactRoot,
    ownerHome: join(c.root, "original-owner"),
    env: {},
  });
  assert.equal(
    owner.filter((m) => m.source === join(c.businessHostPath, "workspaces"))
      .length,
    2,
  );
  assert.equal(
    owner.some(
      (m) =>
        m.source === c.businessHostPath ||
        m.destination === "/data" ||
        m.destination === bootstrapDataRoot(c) ||
        m.source === c.qualificationInstallationPath,
    ),
    false,
  );
  const coor = roleMounts(c, {
    kind: "coordinator",
    artifactRoot: c.artifactRoot,
    env: {},
  });
  assert.deepEqual(
    coor
      .filter((m) => m.source === c.businessHostPath)
      .map((m) => m.destination)
      .sort(),
    ["/data", bootstrapDataRoot(c)].sort(),
  );
  assert.equal(
    coor.find((m) => m.source === c.qualificationInstallationPath).rw,
    false,
  );
});

test("real Ed25519 release catalogs verify; omitted purpose keeps the established release protocol", () => {
  const { roots, catalog } = releaseCatalogFixture();
  assert.equal(verifyReleaseCatalog(roots, catalog), catalog);
  const untagged = { ...roots };
  delete untagged.purpose;
  assert.equal(verifyReleaseCatalog(untagged, catalog), catalog);
  assert.equal(
    verifyReleaseCatalog(roots, { ...catalog, releases: [] }).releases.length,
    0,
  );
});

test("catalog rejects wrong signatures, mismatched row identity and qualification trust before instance startup", () => {
  const { roots, catalog } = releaseCatalogFixture();
  const changed = structuredClone(catalog);
  changed.releases[0].envelope.manifest.releaseId = "v1.2.0";
  fails(
    () => verifyReleaseCatalog(roots, changed),
    "SIGNATURE_OR_MANIFEST_DIGEST_INVALID",
  );
  const wrongRow = structuredClone(catalog);
  wrongRow.releases[0].releaseId = "v1.2.0";
  fails(
    () => verifyReleaseCatalog(roots, wrongRow),
    "BOOTSTRAP_CATALOG_ROW_MISMATCH",
  );
  fails(
    () => verifyReleaseCatalog({ ...roots, purpose: "qualification" }, catalog),
    "PRODUCTION_BOOTSTRAP_TRUST_REQUIRED",
  );
  fails(
    () => verifyReleaseCatalog({ ...roots, purpose: "production" }, catalog),
    "PRODUCTION_BOOTSTRAP_TRUST_REQUIRED",
  );
  fails(
    () => verifyReleaseCatalog(roots, { ...catalog, channel: "other" }),
    "PRODUCTION_BOOTSTRAP_CATALOG_REQUIRED",
  );
});

test("preflight preserves live original identity; first writer startup requires physically absent original process", () => {
  const c = config(),
    old = {
      Id: c.original.containerId,
      Image: c.original.image,
      State: { StartedAt: c.original.startedAt, Running: true, Pid: 100 },
      Mounts: [
        {
          Source: "/var/lib/docker/volumes/original/_data",
          Destination: "/data",
          RW: true,
        },
      ],
    };
  assert.equal(assertLegacyPhysical(c, old), old);
  fails(
    () => assertLegacyPhysical(c, old, { requireStopped: true }),
    "LEGACY_BOOTSTRAP_PROCESS_STILL_PRESENT",
  );
  const stopped = { ...old, State: { ...old.State, Running: false, Pid: 0 } };
  assert.equal(
    assertLegacyPhysical(c, stopped, { requireStopped: true }),
    stopped,
  );
  fails(
    () =>
      assertLegacyPhysical(c, {
        ...old,
        State: { ...old.State, StartedAt: "different" },
      }),
    "LEGACY_BOOTSTRAP_IDENTITY_CHANGED",
  );
});

test("prepared clone can be verified before maintenance; final startup requires the final idle stop receipt", () => {
  const c = config(),
    r = {
      ...receipt(c),
      oldProcessAbsent: false,
      admissionHeld: false,
      beforeStop: null,
    };
  assert.equal(assertCloneReceipt(c, r, { requireStopped: false }), r);
  fails(() => assertCloneReceipt(c, r), "LEGACY_BOOTSTRAP_NOT_IDLE");
});

test("production bootstrap refuses test instance aliases, role port collisions and overlapping authority roots", () => {
  const c = config();
  assert.equal(assertBootstrapConfig(c), c);
  fails(
    () =>
      assertBootstrapConfig({
        ...c,
        instanceId: "upgrade-acceptance-pretend-production",
      }),
    "PRODUCTION_BOOTSTRAP_CONFIG_REQUIRED",
  );
  fails(
    () =>
      assertBootstrapConfig({
        ...c,
        ports: { ...c.ports, entry: c.ports.owner },
      }),
    "DISTINCT_BOOTSTRAP_PORTS_REQUIRED",
  );
  fails(
    () => assertBootstrapConfig({ ...c, root: "/data/install" }),
    "BOOTSTRAP_AUTHORITY_PATHS_OVERLAP",
  );
  fails(
    () =>
      assertBootstrapConfig({ ...c, businessHostPath: c.root + "/business" }),
    "BOOTSTRAP_BUSINESS_PATHS_OVERLAP",
  );
  fails(
    () =>
      assertBootstrapConfig({
        ...c,
        runtimeEnv: { DATABASE_URL: "/data/platform.db" },
      }),
    "FORBIDDEN_BOOTSTRAP_RUNTIME_AUTHORITY",
  );
});

test("every real work and connection counter must be known zero even when idle is asserted", () => {
  assert.equal(legacyIdle(status()), true);
  for (const key of Object.keys(status().blockers)) {
    const value = status();
    value.blockers[key] = 1;
    assert.equal(legacyIdle(value), false, key);
  }
  for (const key of ["inFlightHTTP", "activeWS", "credentialAuth"]) {
    const value = status();
    value[key] = 1;
    assert.equal(legacyIdle(value), false, key);
    delete value[key];
    assert.equal(legacyIdle(value), false, "missing " + key);
  }
  const value = status();
  delete value.blockers.agentTasks;
  assert.equal(legacyIdle(value), false);
});

test("retained destroyed history is accepted while existing stopped or active runtime handles defer", () => {
  const c = config(),
    r = receipt(c);
  assert.equal(assertCloneReceipt(c, r), r);
  fails(
    () => assertCloneReceipt(c, { ...r, extantUserRuntimeHandles: 1 }),
    "LEGACY_RUNTIME_ADOPTION_REQUIRED",
  );
  fails(
    () => assertCloneReceipt(c, { ...r, activeAgentTasks: 1 }),
    "LEGACY_RUNTIME_ADOPTION_REQUIRED",
  );
});

test("clone receipt requires exact old identity, intact rollback copy and freshly held idle barrier", () => {
  const c = config(),
    r = receipt(c);
  fails(
    () =>
      assertCloneReceipt(c, {
        ...r,
        original: { ...r.original, image: "sha256:" + "f".repeat(64) },
      }),
    "EXACT_BOOTSTRAP_CLONE_REQUIRED",
  );
  fails(
    () => assertCloneReceipt(c, { ...r, completeVolumeBackupVerified: false }),
    "BOOTSTRAP_ROLLBACK_COPY_REQUIRED",
  );
  fails(
    () => assertCloneReceipt(c, { ...r, oldProcessAbsent: false }),
    "LEGACY_BOOTSTRAP_NOT_IDLE",
  );
  fails(
    () =>
      assertCloneReceipt(c, { ...r, beforeStop: { ...status(), activeWS: 1 } }),
    "LEGACY_BOOTSTRAP_NOT_IDLE",
  );
  fails(
    () => assertCloneReceipt(c, { ...r, masterKeyPreserved: false }),
    "BOOTSTRAP_DATABASE_MIGRATION_UNVERIFIED",
  );
});

test("owner sees its fresh home and workspace subdirectory only; coordinator retains /data absolute paths", () => {
  const c = config(),
    artifactRoot = c.artifactRoot,
    ownerHome = c.root + "/original-owner";
  const owner = roleMounts(c, {
    kind: "owner",
    artifactRoot,
    ownerHome,
    env: {},
  });
  assert.deepEqual(
    owner.find((m) => m.destination === "/data/workspaces"),
    {
      source: c.businessHostPath + "/workspaces",
      destination: "/data/workspaces",
      rw: true,
    },
  );
  assert.equal(
    owner.some(
      (m) => m.source === c.businessHostPath || m.destination === "/data",
    ),
    false,
  );
  assert.deepEqual(
    owner.find((m) => m.source === ownerHome),
    { source: ownerHome, destination: ownerHome, rw: true },
  );
  const coor = roleMounts(c, { kind: "coordinator", artifactRoot, env: {} });
  assert.deepEqual(
    coor.find((m) => m.destination === "/data"),
    { source: c.businessHostPath, destination: "/data", rw: true },
  );
});

test("control, web, owner and installer reject credentials outside their role scope", () => {
  const c = config(),
    basic = {
      artifactRoot: c.artifactRoot,
      cwd: c.root + "/web",
      ownerHome: c.root + "/original-owner",
    };
  for (const [kind, key, code] of [
    ["api", "DATA_ROOT", "BOOTSTRAP_CONTROL_EXCESS_AUTHORITY"],
    ["web", "ACCESS_PASSCODE", "BOOTSTRAP_WEB_EXCESS_AUTHORITY"],
    ["owner", "DATABASE_URL", "BOOTSTRAP_OWNER_EXCESS_AUTHORITY"],
    [
      "installer",
      "PLATFORM_COORDINATOR_RPC_KEY",
      "BOOTSTRAP_INSTALLER_EXCESS_AUTHORITY",
    ],
  ])
    fails(
      () => roleMounts(c, { ...basic, kind, env: { [key]: "forbidden" } }),
      code,
    );
});

test("actual adapter uses private env file, isolated container and scoped workspace mount; no original lifecycle command", async (t) => {
  const folder = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "bootstrap-adapter-test-")),
  );
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const c = { ...config(), root: folder },
    calls = [];
  let runArgs,
    envFileRemoved = false;
  const run = async (_, allArgs) => {
    const args = allArgs.slice(c.docker.args.length);
    calls.push(args);
    if (args[0] === "image")
      return JSON.stringify([
        {
          Id: image,
          Os: "linux",
          Architecture: "arm64",
          Config: { Env: ["PATH=/usr/local/bin:/usr/bin:/bin"] },
        },
      ]);
    if (args[0] === "run") {
      runArgs = args;
      const path = args[args.indexOf("--env-file") + 1];
      assert.equal((await fs.stat(path)).mode & 0o077, 0);
      assert.match(
        await fs.readFile(path, "utf8"),
        /PLATFORM_COORDINATOR_RPC_KEY=owner-test-key/,
      );
      return cid + "\n";
    }
    if (args[0] === "inspect") {
      const path = runArgs[runArgs.indexOf("--env-file") + 1];
      envFileRemoved = !(await fs.lstat(path).catch(() => null));
      return JSON.stringify([
        {
          Id: cid,
          Image: image,
          State: {
            Running: true,
            Pid: 12345,
            StartedAt: "2026-10-14T00:00:00Z",
          },
          Config: {
            Labels: {
              "agent-platform.instance": c.instanceId,
              "agent-platform.installation": digest(c.root),
              "agent-platform.start": "start-owner",
              "agent-platform.role": "owner",
            },
            Env: ["PLATFORM_COORDINATOR_RPC_KEY=owner-test-key"],
            WorkingDir: c.artifactRoot + "/api",
            Entrypoint: ["/usr/local/bin/node"],
            Cmd: [
              c.artifactRoot + "/api/apps/api/dist/roles/runtime-owner-main.js",
            ],
          },
          HostConfig: { PidMode: "", NetworkMode: "host", Privileged: true },
          Mounts: [],
        },
      ]);
    }
    throw Error("unexpected operation");
  };
  const adapter = await createProductionRoleAdapter(c, { run });
  const entry =
    c.artifactRoot + "/api/apps/api/dist/roles/runtime-owner-main.js";
  await adapter.launch({
    kind: "owner",
    args: [entry],
    entry,
    cwd: c.artifactRoot + "/api",
    artifactRoot: c.artifactRoot,
    ownerHome: c.root + "/original-owner",
    record: { startIdentity: "start-owner" },
    env: { PLATFORM_COORDINATOR_RPC_KEY: "owner-test-key" },
  });
  assert.equal(envFileRemoved, true);
  assert.equal(runArgs.includes("--privileged"), true);
  assert.equal(
    runArgs.includes("type=bind,src=" + c.businessHostPath + ",dst=/data"),
    false,
  );
  assert.ok(
    runArgs.includes(
      "type=bind,src=" +
        c.businessHostPath +
        "/workspaces,dst=/data/workspaces",
    ),
  );
  assert.equal(
    calls.some((args) => ["stop", "rm", "kill", "volume"].includes(args[0])),
    false,
  );
  await assert.rejects(
    adapter.signal(cid, "SIGKILL"),
    (error) => error.code === "BOOTSTRAP_FORCE_STOP_FORBIDDEN",
  );
});

test("adapter refuses mutable or authority-bearing runtime images before starting any role", async (t) => {
  const folder = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "bootstrap-image-test-")),
  );
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const c = { ...config(), root: folder },
    calls = [];
  await assert.rejects(
    createProductionRoleAdapter(c, {
      run: async (_, args) => {
        calls.push(args);
        return JSON.stringify([
          {
            Id: image,
            Os: "linux",
            Architecture: "arm64",
            Config: { Env: ["ACCESS_PASSCODE=bad"] },
          },
        ]);
      },
    }),
    (error) => error.code === "BOOTSTRAP_RUNTIME_IMAGE_INVALID",
  );
  assert.equal(calls.length, 1);
});
