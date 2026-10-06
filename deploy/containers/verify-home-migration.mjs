import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONTROLLER_HOST } from "./controller.mjs";
import {
  HOME_VOLUME,
  inspectBuildRecord,
  verifyExport,
} from "./import-jenkins-home.mjs";
import { validatePluginLock } from "./plugins.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tools = "/Users/douglasdong/.local/share/agent-platform-jenkins-tools";
export const EXPORT_DIRECTORY = join(
  tools,
  "migration/bc32cab8-c8a7-4891-9849-fd85bee61ddf",
);
export const IMPORT_RECEIPT = join(
  EXPORT_DIRECTORY,
  "import-receipt-eea909a0-0752-449d-8c7e-5d4d4cea757f.json",
);
export const CONTROLLER_NAME = "agent-platform-jenkins-controller-controller-1";
export const CONTROLLER_IMAGE =
  "sha256:0c3590904dfba9c1ee5f206da6591b92e6a4a634b44130258a791717e11dba3f";
const DOCKER = "/Users/douglasdong/.orbstack/bin/docker";
const DOCKER_CONFIG = join(tools, "container-docker-context");
const API_PID = 64657;
const BASE = "http://127.0.0.1:8080/";
const home = "/var/jenkins_home";
const jobs = [
  "agent-platform-api",
  "agent-platform-ci-discovery",
  "agent-platform-contract",
  "agent-platform-mutation",
  "agent-platform-native-ci",
  "agent-platform-release",
  "agent-platform-sandbox-images",
  "agent-platform-service-monitor",
  "agent-platform-web",
];

function requireProof(value, label) {
  // Secret operands, response bodies and external errors never become messages.
  if (!value) throw new Error(`Migration verification failed: ${label}`);
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jobName = (path) => /^jobs\/([^/]+)\//.exec(path)?.[1];

export function validateReceipt(receipt, archiveSha256) {
  requireProof(
    receipt?.state === "imported-not-started" &&
      receipt.targetHomeVolume === HOME_VOLUME &&
      receipt.archiveSha256 === archiveSha256 &&
      receipt.controllerMode === "migration" &&
      receipt.activated === false &&
      receipt.apiTouched === false,
    "private import receipt identity",
  );
  return receipt;
}

export function verifyInspection(value) {
  requireProof(
    value?.Name === `/${CONTROLLER_NAME}` &&
      /^[a-f0-9]{64}$/.test(value.Id ?? "") &&
      value.Image === CONTROLLER_IMAGE &&
      value.State?.Status === "running" &&
      value.State?.Health?.Status === "healthy",
    "dedicated healthy controller identity",
  );
  requireProof(
    value.Config?.User === "1000:1000" &&
      value.Config.Env?.includes("AGENT_PLATFORM_CONTROLLER_MODE=migration") &&
      value.HostConfig?.ReadonlyRootfs === true &&
      value.HostConfig.Privileged === false &&
      JSON.stringify(value.HostConfig.CapDrop) === '["ALL"]',
    "controller nonroot readonly migration policy",
  );
  requireProof(
    value.Mounts?.length === 1 &&
      value.Mounts[0].Type === "volume" &&
      value.Mounts[0].Name === HOME_VOLUME &&
      value.Mounts[0].Destination === home &&
      value.Mounts[0].RW === true,
    "only imported Home volume mounted",
  );
  const ports = value.HostConfig.PortBindings;
  requireProof(
    Object.keys(ports ?? {}).length === 1 &&
      ports["8080/tcp"]?.length === 1 &&
      ports["8080/tcp"][0].HostIp === "127.0.0.1" &&
      ports["8080/tcp"][0].HostPort === "8080",
    "loopback-only controller port",
  );
  requireProof(
    value.HostConfig.NetworkMode !== "host" &&
      (value.HostConfig.Binds ?? []).every(
        (bind) => bind === `${HOME_VOLUME}:${home}:rw`,
      ) &&
      (value.HostConfig.Binds ?? []).length <= 1,
    "no host network, bind or daemon socket",
  );
  return {
    id: value.Id,
    imageId: value.Image,
    homeOwner: 1000,
    readonlyRootfs: true,
    hostSocketMounted: false,
  };
}

export function verifyPausedState(controller, computers, queue, jobStates) {
  requireProof(
    controller.numExecutors === 0 &&
      controller.jobs?.length === jobs.length &&
      jobs.every((name) =>
        controller.jobs.some(
          (job) => job.name === name && job.buildable === false,
        ),
      ),
    "nine imported jobs paused and built-in executors zero",
  );
  requireProof(queue.items?.length === 0, "empty queue");
  const nodes =
    computers.computer?.filter(
      (node) =>
        node.displayName !== "Built-In Node" &&
        node._class !== "hudson.model.Hudson$MasterComputer",
    ) ?? [];
  requireProof(
    nodes.length === 2 &&
      ["mac-ci", "mac-deploy"].every((name) =>
        nodes.some(
          (node) =>
            node.displayName === name &&
            node.offline === true &&
            node.temporarilyOffline === true &&
            node.numExecutors === 1,
        ),
      ),
    "two original Mac agents offline",
  );
  requireProof(
    jobStates.length === jobs.length &&
      jobStates.every(
        (state) =>
          jobs.includes(state.name) &&
          state.buildable === false &&
          state.builds.every((build) => build.building === false),
      ),
    "no imported builds running",
  );
  return {
    jobs: jobs.length,
    allDisabled: true,
    queueItems: 0,
    existingMacNodes: 2,
    allOffline: true,
    builtInExecutors: 0,
    runningBuilds: 0,
  };
}

export function verifyPlugins(lock, actual, hashes) {
  validatePluginLock(lock);
  requireProof(
    lock.plugins.length === 70 &&
      actual.plugins?.length === lock.plugins.length &&
      lock.plugins.every(
        (expected) =>
          actual.plugins.some(
            (plugin) =>
              plugin.shortName === expected.name &&
              plugin.version === expected.version &&
              plugin.active === true &&
              plugin.enabled === true,
          ) && hashes.get(`plugins/${expected.name}.jpi`) === expected.sha256,
      ),
    "seventy locked active plugin versions and archive digests",
  );
  return {
    count: lock.plugins.length,
    versionsMatch: true,
    allActive: true,
    allArchiveHashesMatch: true,
  };
}

export function comparePrivateHashes(expected, actual, label) {
  requireProof(
    expected.size > 0 &&
      expected.size === actual.size &&
      [...expected].every(([path, hash]) => actual.get(path) === hash),
    label,
  );
  return { files: expected.size, allBytesMatch: true };
}

export function compareUserAuthentication(original, current) {
  const password = (xml) =>
    /<passwordHash>([^<]+)<\/passwordHash>/.exec(xml)?.[1];
  const tokens = (xml) => /<tokenList>([\s\S]*?)<\/tokenList>/.exec(xml)?.[1];
  const beforePassword = password(original),
    afterPassword = password(current);
  const beforeTokens = tokens(original),
    afterTokens = tokens(current);
  requireProof(
    beforePassword &&
      afterPassword &&
      digest(beforePassword) === digest(afterPassword) &&
      beforeTokens &&
      afterTokens &&
      digest(beforeTokens) === digest(afterTokens),
    "preserved user password and API token fields",
  );
  return {
    passwordHashPreserved: true,
    apiTokenStorePreserved: true,
    wholeConfigBytesMatch: digest(original) === digest(current),
  };
}

export async function verifyMigration({ verified, receipt, lock, operations }) {
  validateReceipt(receipt, verified.manifest.archive.sha256);
  const container = verifyInspection(await operations.inspect());
  requireProof(
    (await operations.homeOwner()) === "1000:1000:700",
    "imported Home UID/GID1000 private root",
  );
  const ready = await operations.ready();
  requireProof(
    ready.mode === "migration" &&
      ready.jenkins === "2.580.1" &&
      ready.javaMajor === 21 &&
      ready.plugins === 70 &&
      ready.executors === 0,
    "actual migration startup guard completed",
  );
  const originalFiles = verified.entries.filter(
    (entry) => entry.type === "file",
  );
  const secretFiles = originalFiles.filter((entry) =>
    entry.path.startsWith("secrets/"),
  );
  requireProof(secretFiles.length === 10, "ten original secret files present");
  const credentialFiles = originalFiles.filter(
    (entry) =>
      entry.path.startsWith("bootstrap-secrets/") ||
      ["secret.key", "identity.key.enc"].includes(entry.path),
  );
  const buildFiles = originalFiles.filter((entry) =>
    /^jobs\/[^/]+\/builds\/[1-9][0-9]*\/build\.xml$/.test(entry.path),
  );
  requireProof(
    buildFiles.length === 6,
    "six original saved build records present",
  );
  const expectedHashes = async (entries) =>
    new Map(
      await Promise.all(
        entries.map(async (entry) => [
          entry.path,
          digest(await operations.archiveFile(entry)),
        ]),
      ),
    );
  const secrets = comparePrivateHashes(
    await expectedHashes(secretFiles),
    await operations.homeHashes(secretFiles.map((entry) => entry.path)),
    "original secret bytes preserved",
  );
  const credentials = comparePrivateHashes(
    await expectedHashes(credentialFiles),
    await operations.homeHashes(credentialFiles.map((entry) => entry.path)),
    "bootstrap credentials and identity bytes preserved",
  );
  const builds = comparePrivateHashes(
    await expectedHashes(buildFiles),
    await operations.homeHashes(buildFiles.map((entry) => entry.path)),
    "saved build XML bytes preserved",
  );
  const users = originalFiles.filter((entry) =>
    /^users\/[^/]+\/config\.xml$/.test(entry.path),
  );
  requireProof(users.length === 1, "original local user configuration present");
  const user = compareUserAuthentication(
    (await operations.archiveFile(users[0])).toString("utf8"),
    await operations.homeText(users[0].path),
  );
  const controller = await operations.request(
    "api/json?tree=numExecutors,jobs[name,buildable]",
    "token",
  );
  const computers = await operations.request(
    "computer/api/json?tree=computer[_class,displayName,offline,temporarilyOffline,numExecutors]",
    "token",
  );
  const queue = await operations.request(
    "queue/api/json?tree=items[id]",
    "token",
  );
  const jobStates = await Promise.all(
    jobs.map(async (name) => {
      const state = await operations.request(
        `job/${name}/api/json?tree=name,buildable,builds[number,result,building]`,
        "token",
      );
      const xml = await operations.request(
        `job/${name}/config.xml`,
        "token",
        false,
      );
      requireProof(
        /<disabled>\s*true\s*<\/disabled>/.test(xml),
        "persisted job disablement",
      );
      return state;
    }),
  );
  const paused = verifyPausedState(controller, computers, queue, jobStates);
  const expectedBuilds = [];
  for (const entry of buildFiles)
    expectedBuilds.push({
      job: jobName(entry.path),
      number: Number(/\/builds\/([0-9]+)\//.exec(entry.path)[1]),
      ...inspectBuildRecord(
        (await operations.archiveFile(entry)).toString("utf8"),
      ),
    });
  requireProof(
    jobStates.reduce((count, state) => count + state.builds.length, 0) ===
      expectedBuilds.length &&
      expectedBuilds.every((expected) =>
        jobStates
          .find((state) => state.name === expected.job)
          ?.builds.some(
            (build) =>
              build.number === expected.number &&
              build.result === expected.result &&
              build.building === false,
          ),
      ),
    "saved build history and results unchanged",
  );
  const plugins = verifyPlugins(
    lock,
    await operations.request(
      "pluginManager/api/json?tree=plugins[shortName,version,active,enabled]",
      "token",
    ),
    await operations.homeHashes(
      lock.plugins.map((plugin) => `plugins/${plugin.name}.jpi`),
    ),
  );
  requireProof(
    (await operations.status("api/json", "anonymous")) === 403 &&
      (await operations.status("api/json", "token")) === 200 &&
      (await operations.status("api/json", "password")) === 200,
    "anonymous forbidden and original API/password credentials usable",
  );
  requireProof(
    (await operations.apiHealth()) === 200 &&
      (await operations.publicApiHealth()) === 200 &&
      (await operations.apiPid()) === API_PID,
    "public and local API healthy with unchanged native PID",
  );
  return {
    state: "verified-migration-paused-not-activated",
    archive: {
      sha256: verified.manifest.archive.sha256,
      sizeBytes: verified.manifest.archive.sizeBytes,
      entries: verified.entries.length,
      unchanged: true,
    },
    container,
    secrets,
    credentials,
    user,
    builds: {
      ...builds,
      success: expectedBuilds.filter((build) => build.result === "SUCCESS")
        .length,
      failure: expectedBuilds.filter((build) => build.result === "FAILURE")
        .length,
      historyMatches: true,
    },
    paused,
    plugins,
    authentication: {
      anonymousStatus: 403,
      originalApiTokenStatus: 200,
      originalPasswordStatus: 200,
      credentialsReset: false,
    },
    api: {
      publicHealthStatus: 200,
      localHealthStatus: 200,
      pid: API_PID,
      unchanged: true,
    },
    mutations: false,
    activated: false,
  };
}

async function privateFile(path) {
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stat = await file.stat();
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== 501 ||
    (stat.mode & 0o777) !== 0o600
  ) {
    await file.close();
    throw new Error("Unsafe private verification input");
  }
  return file;
}
async function privateJson(path) {
  const file = await privateFile(path);
  try {
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}
function run(program, args, { archiveFd } = {}) {
  const result = spawnSync(program, args, {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", LANG: "C", COPYFILE_DISABLE: "1" },
    encoding: null,
    stdio:
      archiveFd === undefined
        ? ["ignore", "pipe", "ignore"]
        : ["ignore", "pipe", "ignore", archiveFd],
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  requireProof(
    !result.error && !result.signal && result.status === 0,
    "readonly command execution",
  );
  return result.stdout;
}

export async function runVerification() {
  requireProof(
    process.platform === "darwin" &&
      process.arch === "arm64" &&
      process.getuid() === 501 &&
      process.geteuid() === 501 &&
      process.versions.node.split(".")[0] === "22",
    "fixed native verification identity",
  );
  const socket = await fs.lstat(CONTROLLER_HOST.slice(7));
  const configDirectory = await fs.lstat(DOCKER_CONFIG);
  requireProof(
    socket.isSocket() &&
      socket.uid === 501 &&
      configDirectory.isDirectory() &&
      configDirectory.uid === 501 &&
      (configDirectory.mode & 0o777) === 0o700,
    "dedicated private Docker context",
  );
  const dockerConfig = await privateFile(join(DOCKER_CONFIG, "config.json"));
  await dockerConfig.close();
  const verified = await verifyExport(join(EXPORT_DIRECTORY, "manifest.json"));
  const receipt = await privateJson(IMPORT_RECEIPT);
  const apiCredential = await privateJson(join(tools, "admin-api.json"));
  const passwordCredential = await privateJson(join(tools, "admin-login.json"));
  requireProof(
    apiCredential.username === "douglasdong" &&
      typeof apiCredential.token === "string" &&
      apiCredential.token.length >= 20 &&
      passwordCredential.username === "douglasdong" &&
      typeof passwordCredential.password === "string" &&
      passwordCredential.password.length >= 20,
    "original external private authentication inputs",
  );
  const authorization = {
    token: `Basic ${Buffer.from(`${apiCredential.username}:${apiCredential.token}`).toString("base64")}`,
    password: `Basic ${Buffer.from(`${passwordCredential.username}:${passwordCredential.password}`).toString("base64")}`,
  };
  const docker = (args) =>
    run(DOCKER, [
      "--host",
      CONTROLLER_HOST,
      "--config",
      DOCKER_CONFIG,
      ...args,
    ]);
  const http = (path, authentication) =>
    fetch(`${BASE}${path}`, {
      headers:
        authentication === "anonymous"
          ? {}
          : { authorization: authorization[authentication] },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  const operations = {
    inspect: async () => JSON.parse(docker(["inspect", CONTROLLER_NAME]))[0],
    homeOwner: async () =>
      docker(["exec", CONTROLLER_NAME, "stat", "-c", "%u:%g:%a", home])
        .toString("utf8")
        .trim(),
    ready: async () =>
      JSON.parse(
        docker([
          "exec",
          CONTROLLER_NAME,
          "cat",
          `${home}/container-state/ready.json`,
        ]),
      ),
    archiveFile: async (entry) => {
      requireProof(
        entry.type === "file" && entry.sizeBytes <= 16 * 1024 * 1024,
        "bounded original file comparison",
      );
      const file = await privateFile(verified.archivePath);
      try {
        const stat = await file.stat();
        requireProof(
          Object.entries(verified.archiveIdentity).every(
            ([key, value]) => stat[key] === value,
          ),
          "unchanged export identity",
        );
        return run("/usr/bin/tar", ["-xOf", "/dev/fd/3", `./${entry.path}`], {
          archiveFd: file.fd,
        });
      } finally {
        await file.close();
      }
    },
    homeHashes: async (paths) => {
      requireProof(
        paths.length > 0 &&
          paths.every(
            (path) =>
              /^[A-Za-z0-9_.\/-]+$/.test(path) &&
              !path.split("/").includes("..") &&
              !path.startsWith("/"),
          ),
        "fixed confined Home comparison paths",
      );
      const rows = docker([
        "exec",
        CONTROLLER_NAME,
        "sha256sum",
        "--",
        ...paths.map((path) => `${home}/${path}`),
      ])
        .toString("utf8")
        .trim()
        .split("\n");
      const hashes = new Map();
      for (const row of rows) {
        const match = /^([a-f0-9]{64})  \/var\/jenkins_home\/(.+)$/.exec(row);
        requireProof(
          match && paths.includes(match[2]) && !hashes.has(match[2]),
          "private hash comparison metadata",
        );
        hashes.set(match[2], match[1]);
      }
      return hashes;
    },
    homeText: async (path) =>
      docker(["exec", CONTROLLER_NAME, "cat", `${home}/${path}`]).toString(
        "utf8",
      ),
    request: async (path, authentication, json = true) => {
      const response = await http(path, authentication);
      requireProof(
        response.status === 200,
        "authenticated readonly Jenkins query",
      );
      return json ? response.json() : response.text();
    },
    status: async (path, authentication) =>
      (await http(path, authentication)).status,
    apiHealth: async () =>
      (
        await fetch("http://127.0.0.1:3101/api/health", {
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        })
      ).status,
    publicApiHealth: async () =>
      (
        await fetch("https://agent-api.douglasdong.com/api/health", {
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        })
      ).status,
    apiPid: async () => {
      const value = run("/usr/sbin/lsof", [
        "-nP",
        "-iTCP:3101",
        "-sTCP:LISTEN",
        "-Fpu",
      ]).toString("utf8");
      const pids = [...value.matchAll(/^p([0-9]+)$/gm)].map((match) =>
        Number(match[1]),
      );
      requireProof(
        pids.length === 1 && /^u501$/m.test(value),
        "single unchanged native API listener",
      );
      return pids[0];
    },
  };
  const result = await verifyMigration({
    verified,
    receipt,
    lock: JSON.parse(
      await fs.readFile(join(root, "deploy/jenkins/plugins.lock.json"), "utf8"),
    ),
    operations,
  });
  const after = await verifyExport(join(EXPORT_DIRECTORY, "manifest.json"));
  requireProof(
    after.manifest.archive.sha256 === verified.manifest.archive.sha256,
    "original archive remains intact after verification",
  );
  const proof = {
    ...result,
    checkedAt: new Date().toISOString(),
    sourceHashes: {},
  };
  for (const path of [
    "deploy/containers/verify-home-migration.mjs",
    "deploy/containers/verify-home-migration.test.mjs",
  ])
    proof.sourceHashes[path] = digest(await fs.readFile(join(root, path)));
  await fs.writeFile(
    join(root, "artifacts/jenkins-controller-home-migration-verification.json"),
    `${JSON.stringify(proof, null, 2)}\n`,
    { mode: 0o644 },
  );
  return proof;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 2)
    throw new Error("Use the fixed readonly verification without arguments");
  runVerification()
    .then((proof) => console.log(JSON.stringify(proof)))
    .catch(() => {
      console.error(
        "Readonly migration verification failed; private command, configuration and authentication output withheld",
      );
      process.exitCode = 1;
    });
}
