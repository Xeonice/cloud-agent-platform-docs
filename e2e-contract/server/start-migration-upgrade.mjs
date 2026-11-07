import * as fs from "node:fs/promises";
import { createServer } from "node:net";
import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonical,
  digest,
  invariant,
  loadTrustRoot,
  verifySignedManifest,
  signQualificationManifest,
  runInputFingerprint,
} from "../../deploy/upgrade/trust.mjs";
import {
  atomicJson,
  secureDirectory,
  readJson,
  treeManifest,
  fileDigest,
} from "../../deploy/upgrade/io.mjs";
import { unpackVerified } from "../../deploy/upgrade/artifacts.mjs";
import { execute } from "../../deploy/upgrade/production-role-adapter.mjs";
import { captureProcessIdentity } from "../../deploy/upgrade/supervisor-sampler.mjs";
import {
  publishInitialRoleInventory,
  createInitialRoleIdentityReader,
} from "../../deploy/upgrade/initial-role-inventory.mjs";

const ROOT =
  /^\/var\/lib\/agent-independent-control-qa-[0-9]+\/instances\/upgrade-acceptance-[a-zA-Z0-9._-]+$/;
export const MIGRATION_LEGACY_SOURCE_PIN = Object.freeze({
  releaseId: "v0.3.20-experiment.iflytek.20261019.2",
  archiveDigest:
    "sha256:5a793879f466c32ddafd291c9d3388fa1bb7bfcc38594b8330828f4222cea786",
  archiveBytes: 94477057,
  apiRevision: "90f969b4fa5e7f86ba68270af740bdad3d8103b5",
  projectRevision: "eb0a597bc29382a6c8e52891e8bcb40afafd0b48",
  webRevision: "1593f5edf0429cb36f00e87eda26214bd84cd5da",
});
const KEYS = [
  "owner",
  "control",
  "controller",
  "upgradeControl",
  "entry",
  "sticky",
  "supervisor",
  "upgradeSession",
  "privateEntry",
  "businessProbe",
  "accessAuthority",
  "cookie",
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
  "control",
];
const privateFile = async (path, uid, gid) => {
  const s = await fs.lstat(path);
  invariant(
    s.isFile() &&
      !s.isSymbolicLink() &&
      (s.mode & 0o077) === 0 &&
      s.uid === uid &&
      s.gid === gid &&
      s.size <= 1048576,
    "MIGRATION_NATIVE_PRIVATE_FILE_OWNER_INVALID",
  );
  return path;
};
const origin = (ports, name) => "http://127.0.0.1:" + ports[name];
export function assertMigrationNativeIdentity(
  input,
  actual = {
    platform: process.platform,
    arch: process.arch,
    nodeMajor: Number(process.versions.node.split(".")[0]),
    uid: process.getuid?.(),
    gid: process.getgid?.(),
  },
) {
  invariant(
    actual.platform === "linux" &&
      actual.arch === "arm64" &&
      actual.nodeMajor === 22,
    "MIGRATION_NATIVE_LINUX_ARM64_NODE22_REQUIRED",
  );
  invariant(
    input?.isolated === true &&
      input.docker?.dedicated === true &&
      ROOT.test(input.root) &&
      resolve(input.root) === input.root &&
      input.instanceId === input.root.split("/").at(-1),
    "MIGRATION_NATIVE_EXCLUSIVE_ROOT_REQUIRED",
  );
  invariant(
    Number.isSafeInteger(input.uid) &&
      input.uid >= 0 &&
      Number.isSafeInteger(input.gid) &&
      input.gid >= 0 &&
      actual.uid === input.uid &&
      actual.gid === input.gid &&
      input.targetAdapterUid === input.uid &&
      input.targetAdapterGid === input.gid &&
      input.adapter?.uid === input.uid &&
      input.adapter?.gid === input.gid &&
      input.docker.uid === input.uid &&
      input.docker.gid === input.gid,
    "MIGRATION_NATIVE_RUNNER_TARGET_UID_GID_MISMATCH",
  );
  invariant(
    KEYS.every(
      (k) => typeof input.keys?.[k] === "string" && input.keys[k].length >= 32,
    ) && new Set(KEYS.map((k) => input.keys[k])).size === KEYS.length,
    "MIGRATION_NATIVE_ROLE_KEYS_REQUIRED",
  );
  invariant(
    /^sha256:[a-f0-9]{64}$/.test(input.docker.image) &&
      isAbsolute(input.docker.clientPath ?? "") &&
      /^sha256:[a-f0-9]{64}$/.test(input.docker.clientDigest ?? "") &&
      Array.isArray(input.docker.args) &&
      input.docker.args.every(
        (a) => typeof a === "string" && !/[\r\n]/.test(a),
      ),
    "MIGRATION_NATIVE_FIXED_RUNTIME_REQUIRED",
  );
  invariant(
    input.source?.releaseId === MIGRATION_LEGACY_SOURCE_PIN.releaseId &&
      input.source.archiveDigest ===
        MIGRATION_LEGACY_SOURCE_PIN.archiveDigest &&
      input.source.archiveBytes === MIGRATION_LEGACY_SOURCE_PIN.archiveBytes,
    "MIGRATION_NATIVE_REAL_V20_SOURCE_REQUIRED",
  );
  return true;
}
export function frozenLegacyFoundationDriver(source, artifactRoot) {
  invariant(
    isAbsolute(artifactRoot) && !artifactRoot.includes("'"),
    "MIGRATION_NATIVE_SOURCE_ROOT_INVALID",
  );
  invariant(
    source.includes("export async function startUpgradeHarness(config)") &&
      source.includes("from './installer-filesystem.mjs'"),
    "MIGRATION_NATIVE_LEGACY_BOOTSTRAP_SOURCE_CHANGED",
  );
  let driver = source
    .replaceAll("../../deploy/upgrade/", artifactRoot + "/installer/")
    .replace(
      "import { verifyQualificationBusinessDatabaseFilesystem } from './installer-filesystem.mjs';",
      `async function verifyQualificationBusinessDatabaseFilesystem(c){invariant(!c.businessDatabaseFilesystemEvidence&&!c.businessDatabaseFilesystem,'MIGRATION_NATIVE_SIMPLE_SOURCE_DB_REQUIRED');return join(c.root,'business/platform.db');}`,
    );
  const footer = driver.indexOf(
    "if(process.argv[1]&&import.meta.url===pathToFileURL",
  );
  invariant(footer > 0, "MIGRATION_NATIVE_LEGACY_DRIVER_ENTRY_CHANGED");
  driver = driver.slice(0, footer);
  driver = driver.replace(
    "join(root,'harness.json'),info",
    "join(root,'bindings/legacy-harness.json'),info",
  );
  const resume = `await atomicJson(join(root,'legacy-foundation/runtime/resume.json'),{schemaVersion:1,instanceId:config.instanceId,coordinator:{origin:origin('coordinator'),instanceId:config.instanceId,key:keys.controller,bindingPath},docker:{...config.docker,instanceId:config.instanceId,installationRoot:root,installerRoot:paths.installer,businessRoot:paths.data,bindingRoot:paths.bindings,runtimeOwnerRoot:paths.futureOwners,trustRootPath:config.trustRootPath,qualificationRoot:resolve(config.qualificationInstallationPath,'..')},supervisor:{root:paths.installer,instanceId:config.instanceId,key:keys.supervisor,controlEnv,coordinatorEnv,ownerEnv,runtimeEnv:config.runtimeEnv||{},runtimeOwnerRoot:paths.futureOwners,publicationRoot:join(root,'supervisor-publication'),apiPort:ports.apiB,webPort:ports.webB,coordinatorPort:ports.coordinatorB,coordinatorAppPort:ports.coordinatorAppB,ownerPort:ports.ownerB,installerPort:ports.installerB,installerConfig:controllerConfig,initialInstallerOrigin:origin('controllerMetadata'),port:ports.supervisor},entry:{root:join(root,'entry'),instanceId:config.instanceId,controlKey:keys.entry,stickyKey:keys.sticky,port:ports.entry,controlPort:ports.entryControl}});`;
  driver = driver.replace(
    "  const info={instanceId:",
    "  const activation=await bootstrap.json();await atomicJson(join(root,'bindings/legacy-activation.json'),activation);\n  " +
      resume +
      "\n  const info={instanceId:",
  );
  // Foundation shutdown owns its two listeners only. The migration runner
  // separately reconciles/stops Installer and writer; Owner/Guest remain live.
  return (
    driver +
    `\nconst config=await readJson(process.argv[2]),previous=await readJson(join(config.root,'legacy-foundation/runtime/resume.json'),null);\nlet h;if(previous){invariant(previous.schemaVersion===1&&previous.instanceId===config.instanceId,'MIGRATION_NATIVE_LEGACY_RESUME_SCOPE_CHANGED');const coordinator=createCoordinatorClient(previous.coordinator),adapter=await createDockerRoleAdapter(previous.docker);invariant((await fs.lstat(join(previous.entry.root,'entry-binding.json'))).isFile(),'MIGRATION_NATIVE_LEGACY_ENTRY_STATE_MISSING');const supervisor=await createCandidateSupervisor({...previous.supervisor,coordinator,launchAdapter:adapter});const entry=await createStableEntry({...previous.entry,verifyFence:({attemptId,fence})=>coordinator.assertFence(attemptId,fence),verifyContractFence:({contractAttemptId,fence})=>coordinator.assertContractFence(contractAttemptId,fence)});h={supervisor,entry};}else h=await startUpgradeHarness(config);\nfor(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>{Promise.all([h.supervisor.close(),h.entry.close()]).then(()=>process.exit(0),()=>process.exit(70));});\n`
  );
}
async function ports(input) {
  const result = { ...input.ports };
  for (const name of PORTS)
    if (!result[name]) {
      const server = createServer();
      await new Promise((ok, fail) => {
        server.once("error", fail);
        server.listen(0, "127.0.0.1", ok);
      });
      result[name] = server.address().port;
      await new Promise((ok) => server.close(ok));
    }
  invariant(
    new Set(Object.values(result)).size === PORTS.length,
    "MIGRATION_NATIVE_PORT_COLLISION",
  );
  return result;
}
async function waitFile(path, inspect, deadline) {
  while (Date.now() < deadline) {
    const value = await readJson(path, null);
    if (value) return value;
    const physical = await inspect();
    invariant(
      physical.State.Running,
      "MIGRATION_NATIVE_LEGACY_FOUNDATION_EXITED",
    );
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw Object.assign(
    Error("Actual immutable legacy bootstrap has not become ready"),
    { code: "MIGRATION_NATIVE_LEGACY_START_TIMEOUT" },
  );
}

/** Real immutable v20 roles, with the original bootstrap assembly inside its
 * own Foundation container. The bootstrap wrapper is hashed separately; all
 * application/Installer imports resolve into the verified old package. */
export async function startLegacyMigrationSource(input) {
  assertMigrationNativeIdentity(input);
  const uid = input.uid,
    gid = input.gid;
  for (const path of [
    input.source.manifestPath,
    input.source.trustRootPath,
    input.qa.trustRootPath,
    input.qa.privateKeyPath,
    input.qualificationInstallationPath,
  ])
    await privateFile(path, uid, gid);
  const dockerBinary = await fileDigest(input.docker.clientPath);
  invariant(
    dockerBinary.digest === input.docker.clientDigest,
    "MIGRATION_NATIVE_DOCKER_CLIENT_CHANGED",
  );
  const archive = await fileDigest(input.source.archivePath);
  invariant(
    archive.digest === input.source.archiveDigest &&
      archive.bytes === input.source.archiveBytes,
    "MIGRATION_NATIVE_SOURCE_BYTES_CHANGED",
  );
  const originalRoots = await loadTrustRoot(input.source.trustRootPath),
    original = verifySignedManifest(
      await readJson(input.source.manifestPath),
      originalRoots,
    ),
    qaRoots = await loadTrustRoot(input.qa.trustRootPath),
    key = createPrivateKey(await fs.readFile(input.qa.privateKeyPath));
  const publicKey = createPublicKey(key).export({
      format: "pem",
      type: "spki",
    }),
    qaKey = qaRoots.keys.find((k) => k.id === input.qa.keyId);
  invariant(
    original.manifest.releaseId === input.source.releaseId &&
      original.manifest.commits.api ===
        MIGRATION_LEGACY_SOURCE_PIN.apiRevision &&
      original.manifest.commits.project ===
        MIGRATION_LEGACY_SOURCE_PIN.projectRevision &&
      original.manifest.commits.web ===
        MIGRATION_LEGACY_SOURCE_PIN.webRevision &&
      original.manifest.packages.some(
        (p) =>
          p.digest === archive.digest &&
          p.bytes === archive.bytes &&
          p.platform === "linux" &&
          p.arch === "arm64",
      ) &&
      qaRoots.purpose === "qualification" &&
      qaRoots.qualificationInstanceId === input.instanceId &&
      qaRoots.channel !== originalRoots.channel &&
      qaKey?.publicKey === publicKey &&
      !originalRoots.keys.some((k) => k.publicKey === publicKey),
    "MIGRATION_NATIVE_SEPARATE_QA_TRUST_REQUIRED",
  );
  const parent = await fs.stat(dirname(input.root));
  invariant(
    parent.uid === uid && parent.gid === gid && parent.isDirectory(),
    "MIGRATION_NATIVE_PARENT_OWNER_INVALID",
  );
  const space = await fs.statfs(dirname(input.root));
  invariant(
    space.bavail * space.bsize >= input.source.archiveBytes * 3 + 4 * 1024 ** 3,
    "MIGRATION_NATIVE_DISK_RESERVE_REQUIRED",
  );
  invariant(
    !(await fs.lstat(input.root).catch(() => null)),
    "MIGRATION_NATIVE_HOME_ALREADY_USED",
  );
  const root = await secureDirectory(input.root),
    p = await ports(input),
    paths = {};
  for (const [name, folder] of Object.entries({
    data: "business",
    owner: "original-owner",
    futureOwners: "future-owners",
    installer: "installer",
    bindings: "bindings",
    logs: "logs",
    web: "initial-web-code",
    entry: "entry",
    legacy: "legacy-foundation",
    publication: "supervisor-publication",
    registry: "supervisor-container-records",
  }))
    paths[name] = await secureDirectory(join(root, folder));
  await secureDirectory(join(paths.legacy, "runtime"));
  for (const folder of [
    "artifacts",
    "downloads",
    "journals",
    "processes",
    "process-code",
  ])
    await secureDirectory(join(paths.installer, folder));
  const manifest = {
    ...original.manifest,
    channel: qaRoots.channel,
    purpose: "qualification",
    qualification: {
      instanceId: input.instanceId,
      inputFingerprint: runInputFingerprint(original.manifest),
    },
    evidence: original.manifest.evidence.map((e) => ({
      ...e,
      result: "not-run",
      reportDigest: digest({
        historicalSourceManifest: original.manifestDigest,
        kind: e.kind,
        newNativeRun: "not-run",
      }),
    })),
  };
  manifest.qualification.inputFingerprint = runInputFingerprint(manifest);
  const envelope = signQualificationManifest(
      manifest,
      input.qa.keyId,
      key.export({ format: "pem", type: "pkcs8" }),
    ),
    sourceManifestPath = join(paths.legacy, "source-qa-envelope.json");
  verifySignedManifest(envelope, qaRoots);
  await atomicJson(sourceManifestPath, envelope);
  const pkg = manifest.packages.find(
      (x) => x.platform === "linux" && x.arch === "arm64",
    ),
    stage = await secureDirectory(join(root, "legacy-code")),
    installed = await unpackVerified(
      input.source.archivePath,
      pkg,
      stage,
      manifest.components,
    ),
    sourceRoot = installed.root;
  const catalog = join(paths.legacy, "catalog.json");
  await atomicJson(catalog, {
    schemaVersion: 1,
    channel: qaRoots.channel,
    releases: [],
  });
  const driverPath = join(paths.legacy, "foundation-main.mjs"),
    source = await fs.readFile(
      new URL("./start-upgrade.mjs", import.meta.url),
      "utf8",
    );
  await fs.writeFile(
    driverPath,
    frozenLegacyFoundationDriver(source, sourceRoot),
    { mode: 0o600, flag: "wx" },
  );
  const release = {
    releaseId: manifest.releaseId,
    activationGeneration: 1,
    activatedAt: new Date().toISOString(),
    schema: 29,
    channel: qaRoots.channel,
    components: manifest.components,
    commits: manifest.commits,
    productionWebBinding: origin(p, "entry"),
  };
  const driverConfig = {
    isolated: true,
    instanceId: input.instanceId,
    root,
    initialRoot: sourceRoot,
    initialRelease: release,
    initialTreeDigest: installed.treeDigest,
    keys: Object.fromEntries(
      [
        "owner",
        "control",
        "controller",
        "entry",
        "sticky",
        "supervisor",
        "upgradeSession",
      ].map((k) => [k, input.keys[k]]),
    ),
    ports: p,
    provider: "boxlite",
    authEnv: input.authEnv,
    runtimeEnv: input.runtimeEnv ?? {},
    ownerEnv: input.ownerEnv ?? {},
    trustRootPath: input.qa.trustRootPath,
    catalogFile: catalog,
    qualificationInstallationPath: input.qualificationInstallationPath,
    docker: {
      ...input.docker,
      cli: input.docker.clientPath,
      procRoot: input.hostProcRoot ?? "/host/proc",
    },
  };
  const configPath = join(paths.legacy, "config.json");
  await atomicJson(configPath, driverConfig);
  const codeFiles = (await treeManifest(join(sourceRoot, "installer")))
    .filter((f) => !f.link && f.path.endsWith(".mjs"))
    .map((f) => ({
      path: join(sourceRoot, "installer", f.path),
      digest: f.digest,
      bytes: f.bytes,
    }));
  codeFiles.push(
    { path: driverPath, ...(await fileDigest(driverPath)) },
    { path: configPath, ...(await fileDigest(configPath)) },
  );
  invariant(
    codeFiles.length <= 128 &&
      codeFiles.every((f) => /^sha256:[a-f0-9]{64}$/.test(f.digest)),
    "MIGRATION_NATIVE_OLD_CODE_PROOF_INVALID",
  );
  const startIdentity = randomUUID(),
    artifactDigest = digest(codeFiles),
    docker = (args) =>
      execute(input.docker.cli ?? "docker", [...input.docker.args, ...args]);
  const image = JSON.parse(
    await docker(["image", "inspect", input.docker.image]),
  )[0];
  invariant(
    image.Id === input.docker.image &&
      image.Os === "linux" &&
      image.Architecture === "arm64",
    "MIGRATION_NATIVE_IMAGE_CHANGED",
  );
  const mounts = [
    sourceRoot,
    input.qa.trustRootPath,
    input.qualificationInstallationPath,
    input.docker.clientPath,
    paths.legacy,
  ].map((source) => ({ source, rw: false }));
  for (const path of [
    paths.installer,
    paths.bindings,
    paths.logs,
    paths.web,
    paths.entry,
    paths.publication,
    paths.registry,
    paths.data,
  ])
    mounts.push({ source: path, rw: true });
  mounts.push({ source: join(paths.legacy, "runtime"), rw: true });
  const resources = input.capacityBudgets?.initial?.foundation;
  invariant(
    resources &&
      resources.memoryBytes > 0 &&
      resources.cpuMilliCores > 0 &&
      Number.isSafeInteger(input.legacyFoundationPidsLimit) &&
      input.legacyFoundationPidsLimit >= 16,
    "MIGRATION_NATIVE_FOUNDATION_RESOURCE_CAP_REQUIRED",
  );
  const args = [
    "run",
    "--detach",
    "--name",
    input.instanceId + "-legacy-foundation",
    "--network",
    "host",
    "--read-only",
    "--user",
    uid + ":" + gid,
    "--restart",
    "no",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    String(resources.memoryBytes),
    "--memory-swap",
    String(resources.memoryBytes),
    "--cpus",
    String(resources.cpuMilliCores / 1000),
    "--pids-limit",
    String(input.legacyFoundationPidsLimit),
    "--label",
    "agent-platform.instance=" + input.instanceId,
    "--label",
    "agent-platform.installation=" + digest(root),
    "--label",
    "agent-platform.role=foundation",
    "--label",
    "agent-platform.start=" + startIdentity,
    "--label",
    "agent-platform.artifact=" + artifactDigest,
    "--tmpfs",
    root + `:rw,nosuid,nodev,size=16m,mode=0700,uid=${uid},gid=${gid}`,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=128m",
    "--workdir",
    paths.legacy,
  ];
  for (const m of mounts)
    args.push(
      "--mount",
      `type=bind,src=${m.source},dst=${m.source}${m.rw ? "" : ",readonly"}`,
    );
  args.push(
    "--mount",
    "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
    "--mount",
    `type=bind,src=/proc,dst=${input.hostProcRoot ?? "/host/proc"},readonly`,
    "--entrypoint",
    input.docker.node ?? "/usr/local/bin/node",
    input.docker.image,
    driverPath,
    configPath,
  );
  await atomicJson(join(paths.legacy, "provision-intent.json"), {
    instanceId: input.instanceId,
    sourceManifestDigest: original.manifestDigest,
    qaManifestDigest: envelope.manifestDigest,
    archive,
    codeFiles,
    startIdentity,
    artifactDigest,
    uid,
    gid,
    startedAt: new Date().toISOString(),
  });
  const containerId = (await docker(args)).trim();
  invariant(
    /^[a-f0-9]{64}$/.test(containerId),
    "MIGRATION_NATIVE_FOUNDATION_ID_UNKNOWN",
  );
  const raw = () =>
    docker(["inspect", containerId]).then((x) => JSON.parse(x)[0]);
  const info = await waitFile(
      join(paths.bindings, "legacy-harness.json"),
      raw,
      Date.now() + 240000,
    ),
    row = await raw();
  invariant(
    row.Id === containerId &&
      row.State.Running &&
      row.State.Paused === false &&
      row.Config.User === uid + ":" + gid &&
      row.Config.Labels["agent-platform.start"] === startIdentity &&
      !row.HostConfig.Privileged &&
      !row.HostConfig.Devices?.some((d) => d.PathOnHost === "/dev/kvm") &&
      !row.Mounts.some((m) =>
        [paths.owner, paths.futureOwners].some(
          (p) => m.Source === p || m.Source.startsWith(p + "/"),
        ),
      ),
    "MIGRATION_NATIVE_FOUNDATION_SCOPE_INVALID",
  );
  codeFiles.push({
    path: join(paths.legacy, "runtime/resume.json"),
    ...(await fileDigest(join(paths.legacy, "runtime/resume.json"))),
  });
  const foundation = {
    instanceId: input.instanceId,
    containerId,
    ...(await captureProcessIdentity({
      hostPid: row.State.Pid,
      containerId,
      procRoot: input.hostProcRoot ?? "/host/proc",
    })),
    startIdentity,
    artifactDigest,
    codeFiles,
    role: "foundation",
    imageDigest: row.Image,
    hostPid: row.State.Pid,
    startedAt: row.State.StartedAt,
    running: true,
    paused: false,
    restartPolicy: "no",
    restartCount: row.RestartCount,
    oomKilled: row.State.OOMKilled,
    exitCode: row.State.ExitCode,
    commandDigest: digest({
      entrypoint: row.Config.Entrypoint,
      command: row.Config.Cmd,
      workingDirectory: row.Config.WorkingDir,
    }),
    mountDigest: digest(
      row.Mounts.map((m) => ({
        source: m.Source,
        destination: m.Destination,
        rw: m.RW,
      })).sort((a, b) => a.destination.localeCompare(b.destination)),
    ),
  };
  async function inspect(name) {
    if (name === "foundation") return foundation;
    const r = info.roleContainers[name];
    invariant(r?.containerId, "MIGRATION_NATIVE_ROLE_RECORD_MISSING");
    const actual = JSON.parse(await docker(["inspect", r.containerId]))[0];
    invariant(
      actual.Config.User === uid + ":" + gid &&
        actual.Config.Labels["agent-platform.instance"] === input.instanceId &&
        actual.Config.Labels["agent-platform.start"] === r.startIdentity &&
        actual.Config.Labels["agent-platform.artifact"] === r.artifactDigest,
      "MIGRATION_NATIVE_SOURCE_ROLE_CHANGED",
    );
    const birth = actual.State.Running
      ? await captureProcessIdentity({
          hostPid: actual.State.Pid,
          containerId: actual.Id,
          procRoot: input.hostProcRoot ?? "/host/proc",
        })
      : {};
    return {
      ...r,
      ...birth,
      containerId: actual.Id,
      instanceId: input.instanceId,
      role: actual.Config.Labels["agent-platform.role"],
      startIdentity: actual.Config.Labels["agent-platform.start"],
      artifactDigest: actual.Config.Labels["agent-platform.artifact"],
      imageDigest: actual.Image,
      hostPid: actual.State.Pid,
      pid: 1,
      startedAt: actual.State.StartedAt,
      running: actual.State.Running,
      paused: actual.State.Paused,
      restartPolicy: actual.HostConfig.RestartPolicy?.Name ?? "no",
      restartCount: actual.RestartCount,
      oomKilled: actual.State.OOMKilled,
      exitCode: actual.State.ExitCode,
      finishedAt: actual.State.FinishedAt,
    };
  }
  const roles = { foundation };
  for (const name of ["owner", "coordinator", "apiA", "webA", "controller"])
    roles[name] = await inspect(name);
  const activation = await readJson(
    join(paths.bindings, "legacy-activation.json"),
  );
  invariant(
    canonical(activation) === canonical(release),
    "MIGRATION_NATIVE_REAL_LEGACY_ACTIVATION_MISMATCH",
  );
  const names = {
    apiA: "api",
    coordinator: "coordinator",
    webA: "web",
    controller: "installer",
  };
  await publishInitialRoleInventory({
    path: join(paths.publication, "initial-role-inventory.json"),
    instanceId: input.instanceId,
    activation,
    records: Object.entries(names).map(([name, kind]) => ({
      ...roles[name],
      instanceId: input.instanceId,
      kind,
      artifactRoot: sourceRoot,
      ...release.components[kind],
      origin: origin(p, name === "controller" ? "controllerMetadata" : name),
    })),
    inspect: (id) =>
      inspect(Object.keys(names).find((n) => roles[n].containerId === id)),
    readIdentity: createInitialRoleIdentityReader({
      instanceId: input.instanceId,
      controlKey: input.keys.control,
      controllerKey: input.keys.controller,
    }),
  });
  const proof = {
    instanceId: input.instanceId,
    sourceReleaseId: release.releaseId,
    sourceManifestDigest: original.manifestDigest,
    qaManifestDigest: envelope.manifestDigest,
    archive,
    sourceRoot,
    foundation,
    roles,
    uid,
    gid,
    nativeScenario: "legacy-to-independent",
    nativeResult: "not-run",
  };
  await atomicJson(join(paths.legacy, "provision-receipt.json"), proof);
  return {
    ...info,
    paths,
    ports: p,
    keys: input.keys,
    release,
    sourceRoot,
    sourceManifestPath,
    businessDatabasePath: join(paths.data, "platform.db"),
    roles,
    inspect,
    docker,
    driverConfigPath: configPath,
    entryOrigin: origin(p, "entry"),
    provisionReceipt: proof,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const s = await fs.lstat(process.argv[2]);
  invariant(
    s.isFile() && !s.isSymbolicLink() && (s.mode & 0o077) === 0,
    "MIGRATION_NATIVE_CONFIG_INSECURE",
  );
  const h = await startLegacyMigrationSource(await readJson(process.argv[2]));
  process.stdout.write(
    JSON.stringify({
      instanceId: h.instanceId,
      entryOrigin: h.entryOrigin,
      sourceReleaseId: h.release.releaseId,
      result: "legacy-ready-migration-not-run",
    }) + "\n",
  );
}
