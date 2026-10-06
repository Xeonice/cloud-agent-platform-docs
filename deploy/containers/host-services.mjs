import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  targetAccess,
  targetCommand,
  assertPrivatePathsInaccessible,
  isolatedAccountUid,
} from "../macmini/install-system-services.mjs";
import {
  verifyPublicVercelTree,
  VERCEL_DESTINATION,
  VERCEL_VERSION,
} from "../macmini/public-build-tools.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const HOST_ROOT =
  "/Users/douglasdong/.local/share/agent-platform-jenkins-tools";
export const PUBLIC_ROOT =
  "/Library/Application Support/AgentPlatform/jenkins-tools";
export const DOCKER_CONFIG = join(HOST_ROOT, "container-docker-context");
const deploy = "/Users/douglasdong/.local/share/agent-platform-deploy";
const ciHome = "/Users/Shared/agent-platform-ci";
const node =
  "/Users/douglasdong/.local/share/fnm/node-versions/v22.23.3/installation/bin/node";
const corepack =
  "/Users/douglasdong/.local/share/fnm/node-versions/v22.23.3/installation/lib/node_modules/corepack/dist/corepack.js";
const java = "/opt/homebrew/opt/openjdk@21/bin/java";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const privateProduction = [
  join(deploy, "runtime.env"),
  join(deploy, "cloudflared.token"),
  "/Users/douglasdong/agent-platform/production/platform.db",
];
export const PUBLIC_SOURCES = {
  "jenkins-ci.mjs": "deploy/jenkins/jenkins-ci.mjs",
  "project-ci.mjs": "deploy/jenkins/project-ci.mjs",
  "jenkins-web.mjs": "deploy/jenkins/jenkins-web.mjs",
  "ci-platform.mjs": "deploy/jenkins/ci-platform.mjs",
  "mutation.mjs": "deploy/jenkins/mutation.mjs",
};
export const SECRET_TARGETS = {
  "mac-deploy.secret": { path: join(deploy, "jenkins-agent.secret"), uid: 501 },
  "mac-ci.secret": { path: join(ciHome, "agent.secret"), uid: 401 },
};
export const PROFILES = ["agent-platform-jenkins", "agent-platform-build"];

export function validateDockerConfiguration(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        !["auths", "currentContext", "cliPluginsExtraDirs"].includes(key),
    ) ||
    (value.auths &&
      (typeof value.auths !== "object" ||
        Array.isArray(value.auths) ||
        Object.keys(value.auths).length)) ||
    (value.currentContext !== undefined &&
      typeof value.currentContext !== "string") ||
    (value.cliPluginsExtraDirs !== undefined &&
      (!Array.isArray(value.cliPluginsExtraDirs) ||
        value.cliPluginsExtraDirs.length !== 1 ||
        value.cliPluginsExtraDirs[0] !==
          "/Applications/OrbStack.app/Contents/MacOS/xbin"))
  )
    throw new Error(
      "Dedicated VM Docker configuration must contain no credentials or credential helpers",
    );
}

async function verifyDockerConfiguration() {
  await privateDirectory(DOCKER_CONFIG);
  validateDockerConfiguration(
    JSON.parse(await readPrivate(join(DOCKER_CONFIG, "config.json"))),
  );
}

function validateAgentSecret(content) {
  if (!/^[a-f0-9]{64}\n?$/.test(content.toString()))
    throw new Error("Expected a private exported Jenkins agent credential");
}

async function profileHashes() {
  const observed = {};
  for (const profile of PROFILES) {
    const path = join("/Users/douglasdong/.colima", profile, "colima.yaml");
    const file = await fs.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.uid !== 501 ||
        stat.nlink !== 1 ||
        stat.mode & 0o022 ||
        stat.size > 1024 * 1024
      )
        throw new Error("Existing dedicated profile configuration differs");
      observed[profile] = hash(await file.readFile());
    } finally {
      await file.close();
    }
  }
  return observed;
}

function escape(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
}
function xml(value) {
  if (typeof value === "string") return `<string>${escape(value)}</string>`;
  if (typeof value === "number") return `<integer>${value}</integer>`;
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (Array.isArray(value)) return `<array>${value.map(xml).join("")}</array>`;
  return `<dict>${Object.entries(value)
    .map(([key, item]) => `<key>${escape(key)}</key>${xml(item)}`)
    .join("")}</dict>`;
}

export function hostServiceDefinitions() {
  const env = (home) => ({
    HOME: home,
    PATH: `${dirname(node)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: "en_US.UTF-8",
  });
  const vm = (label, profile, cpus, memory, disk, rosetta) => ({
    Label: label,
    UserName: "douglasdong",
    GroupName: "staff",
    ProgramArguments: [
      "/opt/homebrew/bin/colima",
      "start",
      profile,
      "--arch",
      "aarch64",
      "--cpus",
      String(cpus),
      "--memory",
      String(memory),
      "--disk",
      String(disk),
      "--vm-type",
      "vz",
      "--runtime",
      "docker",
      "--mount",
      "none",
      "--activate=false",
      "--ssh-config=false",
      "--save-config=false",
      `--vz-rosetta=${rosetta}`,
      "--foreground",
    ],
    WorkingDirectory: "/Users/douglasdong",
    EnvironmentVariables: { ...env("/Users/douglasdong"), DOCKER_CONFIG },
    RunAtLoad: true,
    StartInterval: 60,
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 30,
    ExitTimeOut: 90,
    Umask: 63,
    StandardOutPath: "/dev/null",
    StandardErrorPath: join(HOST_ROOT, "logs", `${profile}.log`),
  });
  const agent = (label, user, home, name, work, secret) => ({
    Label: label,
    UserName: user,
    GroupName: "staff",
    ProgramArguments: [
      java,
      "-Xmx384m",
      "-jar",
      join(PUBLIC_ROOT, "agent.jar"),
      "-url",
      "http://127.0.0.1:8080/",
      "-secret",
      `@${secret}`,
      "-name",
      name,
      "-webSocket",
      "-workDir",
      work,
    ],
    WorkingDirectory: home,
    EnvironmentVariables: env(home),
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 20,
    ExitTimeOut: 60,
    Umask: 63,
    StandardOutPath: "/dev/null",
    StandardErrorPath: "/dev/null",
  });
  return [
    vm(
      "com.douglasdong.agent-platform.jenkins-docker",
      "agent-platform-jenkins",
      2,
      4,
      40,
      false,
    ),
    vm(
      "com.douglasdong.agent-platform.build-docker",
      "agent-platform-build",
      4,
      8,
      100,
      true,
    ),
    agent(
      "com.douglasdong.agent-platform.jenkins-deploy-agent",
      "douglasdong",
      "/Users/douglasdong",
      "mac-deploy",
      join(deploy, "jenkins-agent"),
      SECRET_TARGETS["mac-deploy.secret"].path,
    ),
    agent(
      "com.douglasdong.agent-platform.jenkins-ci-agent",
      "_agentplatformci",
      ciHome,
      "mac-ci",
      join(ciHome, "agent"),
      SECRET_TARGETS["mac-ci.secret"].path,
    ),
  ];
}

export function renderHostServices() {
  return Object.fromEntries(
    hostServiceDefinitions().map((spec) => [
      spec.Label,
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${xml(spec)}</plist>\n`,
    ]),
  );
}

export async function readPrivate(path, uid = 501) {
  const file = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== uid ||
      stat.nlink !== 1 ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.size > 128 * 1024 * 1024
    )
      throw new Error("Expected a regular owner-only reviewed file");
    return await file.readFile();
  } finally {
    await file.close();
  }
}

export async function verifyBundle(directory, expectedHash, uid = 501) {
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.uid !== uid ||
    (stat.mode & 0o7777) !== 0o700 ||
    (await fs.realpath(directory)) !== resolve(directory)
  )
    throw new Error("Unsafe reviewed host-service bundle");
  const bytes = await readPrivate(join(directory, "manifest.json"), uid);
  if (
    !/^[a-f0-9]{64}$/.test(expectedHash ?? "") ||
    hash(bytes) !== expectedHash
  )
    throw new Error("Reviewed host-service manifest hash changed");
  const manifest = JSON.parse(bytes);
  const plists = renderHostServices();
  const expectedNames = [
    ...Object.keys(plists).map((label) => `${label}.plist`),
    ...Object.keys(PUBLIC_SOURCES),
    "agent.jar",
    ...Object.keys(SECRET_TARGETS),
  ];
  if (
    manifest.version !== 1 ||
    manifest.kind !== "jenkins-container-host-services" ||
    !manifest.files ||
    Object.keys(manifest.files).sort().join() !== expectedNames.sort().join() ||
    (await fs.readdir(directory)).sort().join() !==
      [...expectedNames, "manifest.json"].sort().join()
  )
    throw new Error("Host-service bundle contains missing or unapproved files");
  for (const name of expectedNames) {
    const content = await readPrivate(join(directory, name), uid);
    if (
      hash(content) !== manifest.files[name].sha256 ||
      content.length !== manifest.files[name].sizeBytes
    )
      throw new Error("Reviewed host-service bytes changed");
    if (
      name.endsWith(".plist") &&
      content.toString() !== plists[name.slice(0, -6)]
    )
      throw new Error(
        "A service differs from its fixed label, identity, executable or profile",
      );
    if (Object.hasOwn(SECRET_TARGETS, name)) validateAgentSecret(content);
  }
  if (
    manifest.vercel?.version !== VERCEL_VERSION ||
    manifest.vercel?.destination !== VERCEL_DESTINATION
  )
    throw new Error(
      "Pinned existing public Vercel distribution evidence is required",
    );
  if (
    !manifest.profileHashes ||
    Object.keys(manifest.profileHashes).sort().join() !==
      [...PROFILES].sort().join() ||
    Object.values(manifest.profileHashes).some(
      (value) => !/^[a-f0-9]{64}$/.test(value),
    )
  )
    throw new Error(
      "Reviewed dedicated profile configuration evidence is required",
    );
  return manifest;
}

async function privateDirectory(path, uid = 501) {
  const stat = await fs.lstat(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== uid ||
    (stat.mode & 0o7777) !== 0o700 ||
    (await fs.realpath(path)) !== resolve(path)
  )
    throw new Error("Expected the fixed private directory and owner");
}

export async function prepareHostBundle(secretDirectory, vercelReview) {
  if (
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    process.getuid() !== 501 ||
    process.versions.node.split(".")[0] !== "22"
  )
    throw new Error(
      "Host-service preparation requires the dedicated native Node22 UID501 user",
    );
  await privateDirectory(HOST_ROOT);
  await verifyDockerConfiguration();
  await privateDirectory(secretDirectory);
  if (
    !resolve(secretDirectory).startsWith(`${HOST_ROOT}/`) ||
    !resolve(vercelReview).startsWith(`${HOST_ROOT}/`)
  )
    throw new Error(
      "Use private staged exports within the dedicated tools directory",
    );
  const vercel = JSON.parse(await readPrivate(vercelReview)).vercel;
  await verifyPublicVercelTree(VERCEL_DESTINATION, vercel);
  const profiles = await profileHashes();
  const parent = join(HOST_ROOT, "host-services");
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await privateDirectory(parent);
  const directory = join(parent, randomUUID());
  await fs.mkdir(directory, { mode: 0o700 });
  const sources = {};
  for (const [name, relative] of Object.entries(PUBLIC_SOURCES)) {
    const file = await fs.open(
      join(repository, relative),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== 501 ||
        stat.size > 2 * 1024 * 1024
      )
        throw new Error("Unexpected public source file");
      sources[name] = await file.readFile();
    } finally {
      await file.close();
    }
  }
  const jar = await fs.open(
    join(PUBLIC_ROOT, "agent.jar"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await jar.stat();
    if (
      !stat.isFile() ||
      stat.uid !== 0 ||
      stat.nlink !== 1 ||
      (stat.mode & 0o7777) !== 0o644
    )
      throw new Error("Expected the existing root-owned public agent JAR");
    sources["agent.jar"] = await jar.readFile();
  } finally {
    await jar.close();
  }
  for (const name of Object.keys(SECRET_TARGETS))
    sources[name] = await readPrivate(join(secretDirectory, name));
  for (const [label, text] of Object.entries(renderHostServices()))
    sources[`${label}.plist`] = Buffer.from(text);
  const files = {};
  for (const [name, content] of Object.entries(sources)) {
    await fs.writeFile(join(directory, name), content, {
      flag: "wx",
      mode: 0o600,
    });
    files[name] = { sha256: hash(content), sizeBytes: content.length };
  }
  const manifest = {
    version: 1,
    kind: "jenkins-container-host-services",
    files,
    vercel,
    profileHashes: profiles,
    services: Object.keys(renderHostServices()),
    vmPolicy: "RunAtLoad + StartInterval60 + retry on unsuccessful exit",
    logPolicy: {
      containers: "Docker json-file 10m x3",
      macAgents:
        "Remoting workDir rotating logs; launchd stdout/stderr discarded",
      vmStderr:
        "fixed owner-only startup log; no automatic size rotation configured",
    },
    coldBootTested: false,
    productionApiOrTunnelChanged: false,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(join(directory, "manifest.json"), bytes, {
    flag: "wx",
    mode: 0o600,
  });
  await verifyBundle(directory, hash(bytes));
  return {
    state: "prepared-not-installed",
    directory,
    manifestSha256: hash(bytes),
    serviceLabels: manifest.services,
    productionApiOrTunnelChanged: false,
  };
}

function command(file, args) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    timeout: 15_000,
    maxBuffer: 256 * 1024,
  });
  if (result.error || result.signal || result.status !== 0)
    throw new Error(
      "Fixed host-service command failed; raw output is withheld",
    );
  return result.stdout;
}

function serviceLoaded(label, domain) {
  const result = spawnSync("/bin/launchctl", ["print", `${domain}/${label}`], {
    encoding: "utf8",
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    timeout: 10_000,
    maxBuffer: 128 * 1024,
  });
  if (result.error || result.signal || !Number.isInteger(result.status))
    throw new Error("Service status query failed");
  if (result.status === 0) return true;
  if (result.status === 113 && /Could not find service/.test(result.stderr))
    return false;
  throw new Error("Service status is unknown; no bootstrap is permitted");
}

export function assertFixedLabelsUnloaded(probe = serviceLoaded) {
  for (const spec of hostServiceDefinitions())
    for (const domain of ["system", "gui/501"]) {
      const loaded = probe(spec.Label, domain);
      if (typeof loaded !== "boolean")
        throw new Error(
          "Host-service status is unknown; no installation is permitted",
        );
      if (loaded)
        throw new Error(
          "A fixed system or GUI host-service label is already loaded; no service was stopped or replaced",
        );
    }
}

export function validateNativeStartup(target, run = spawnSync) {
  if (!(
    (target.user === "douglasdong" &&
      target.uid === 501 &&
      target.home === "/Users/douglasdong") ||
    (target.user === "_agentplatformci" &&
      target.uid === 401 &&
      target.home === ciHome)
  ))
    throw new Error("Unexpected fixed native agent identity");
  const work =
    target.user === "douglasdong"
      ? join(deploy, "jenkins-agent")
      : join(ciHome, "agent");
  for (const path of [target.home, work])
    for (const flag of ["-x", "-w"])
      if (!targetAccess(flag, path, target, run))
        throw new Error(
          "Native agent cannot traverse or write its fixed Home/workDir",
        );
  for (const file of [java, node])
    if (!targetAccess("-x", file, target, run))
      throw new Error("A target user cannot execute its fixed runtime");
  if (!/^v22\./.test(targetCommand("Node22", node, ["--version"], target, run)))
    throw new Error("Node22 is required");
  if (
    !/^(?:openjdk|java) 21(?:\.|\s)/m.test(
      targetCommand("Java21", java, ["--version"], target, run),
    )
  )
    throw new Error("Java21 is required");
  targetCommand("Corepack", node, [corepack, "--version"], target, run);
  targetCommand(
    "Agent JAR help",
    java,
    ["-jar", join(PUBLIC_ROOT, "agent.jar"), "-help"],
    target,
    run,
  );
  const imports = Object.keys(PUBLIC_SOURCES).map(
    (name) => pathToFileURL(join(PUBLIC_ROOT, name)).href,
  );
  targetCommand(
    "Public tools imports",
    node,
    [
      "--input-type=module",
      "-e",
      `await Promise.all(${JSON.stringify(imports)}.map(path=>import(path)))`,
    ],
    target,
    run,
  );
  if (
    !targetCommand(
      "Vercel62.2",
      node,
      [
        join(VERCEL_DESTINATION, "node_modules/vercel/dist/index.js"),
        "--version",
      ],
      target,
      run,
    )
      .split(/\r?\n/)
      .includes(VERCEL_VERSION)
  )
    throw new Error("Pinned Vercel startup differs");
  const secret =
    SECRET_TARGETS[
      target.user === "douglasdong" ? "mac-deploy.secret" : "mac-ci.secret"
    ].path;
  if (!targetAccess("-r", secret, target, run))
    throw new Error("Native agent secret is not readable by its fixed user");
  return {
    user: target.user,
    uid: target.uid,
    homeAccess: true,
    nodeMajor: 22,
    javaMajor: 21,
    corepackStarted: true,
    agentJarHelpStarted: true,
    publicImports: 5,
    vercel: VERCEL_VERSION,
    credentialReadable: true,
  };
}

async function makePrivateDirectory(path, uid) {
  const existing = await fs.lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!existing) {
    await fs.mkdir(path, { mode: 0o700 });
    await fs.chown(path, uid, 20);
  }
  await privateDirectory(path, uid);
}

async function prepareLog(path) {
  const file = await fs.open(
    path,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      ![0, 501].includes(stat.uid) ||
      (stat.mode & 0o7777) !== 0o600
    )
      throw new Error("Unexpected fixed VM startup log");
    if (stat.uid === 0) await file.chown(501, 20);
  } finally {
    await file.close();
  }
}

async function installFile(path, bytes, uid, mode) {
  const before = await fs.lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (before && (!before.isFile() || before.nlink !== 1 || before.uid !== uid))
    throw new Error("Refusing an unexpected existing installation file");
  const temporary = `${path}.${randomUUID()}.installing`;
  try {
    const file = await fs.open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(bytes);
      await file.chown(uid, uid === 0 ? 0 : 20);
      await file.chmod(mode);
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(temporary, path);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function applyHostBundle(directory, expectedHash) {
  if (
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    process.getuid() !== 0 ||
    process.versions.node.split(".")[0] !== "22"
  )
    throw new Error(
      "Applying the reviewed fixed host services requires native Node22 administrator execution",
    );
  if (!resolve(directory).startsWith(`${HOST_ROOT}/host-services/`))
    throw new Error("Unexpected host-service review location");
  const manifest = await verifyBundle(directory, expectedHash);
  const plists = renderHostServices();
  assertFixedLabelsUnloaded();
  await privateDirectory(HOST_ROOT);
  await verifyDockerConfiguration();
  const daemonRoot = "/Library/LaunchDaemons";
  const daemonStat = await fs.lstat(daemonRoot);
  if (
    !daemonStat.isDirectory() ||
    daemonStat.uid !== 0 ||
    daemonStat.mode & 0o022 ||
    (await fs.realpath(daemonRoot)) !== daemonRoot
  )
    throw new Error("Fixed LaunchDaemons directory differs");
  for (const [user, uid, home] of [
    ["douglasdong", 501, "/Users/douglasdong"],
    ["_agentplatformci", 401, ciHome],
  ]) {
    const fields =
      user === "_agentplatformci"
        ? [
            "dsAttrTypeStandard:UniqueID",
            "dsAttrTypeStandard:PrimaryGroupID",
            "dsAttrTypeStandard:NFSHomeDirectory",
            "dsAttrTypeStandard:UserShell",
            "dsAttrTypeNative:IsHidden",
            "dsAttrTypeStandard:Password",
            "dsAttrTypeStandard:AuthenticationAuthority",
          ]
        : ["UniqueID", "PrimaryGroupID", "NFSHomeDirectory"];
    const identity = command("/usr/bin/dscl", [
      "-plist",
      ".",
      "-read",
      `/Users/${user}`,
      ...fields,
    ]);
    const parsed = spawnSync(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", "-"],
      {
        input: identity,
        encoding: "utf8",
        cwd: "/",
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
        timeout: 10_000,
        maxBuffer: 128 * 1024,
      },
    );
    if (parsed.error || parsed.signal || parsed.status !== 0)
      throw new Error("Native service identity parsing failed");
    const record = JSON.parse(parsed.stdout);
    if (user === "_agentplatformci" && isolatedAccountUid(record, user) !== uid)
      throw new Error(
        "Existing isolated CI identity differs from fixed UID401",
      );
    if (
      record["dsAttrTypeStandard:UniqueID"]?.join() !== String(uid) ||
      record["dsAttrTypeStandard:PrimaryGroupID"]?.join() !== "20" ||
      record["dsAttrTypeStandard:NFSHomeDirectory"]?.join() !== home
    )
      throw new Error("Existing native service identity differs");
    const stat = await fs.lstat(home);
    if (
      !stat.isDirectory() ||
      stat.uid !== uid ||
      (await fs.realpath(home)) !== home
    )
      throw new Error("Native service Home differs");
    if (user === "_agentplatformci") await privateDirectory(home, uid);
  }
  const publicStat = await fs.lstat(PUBLIC_ROOT);
  if (
    !publicStat.isDirectory() ||
    publicStat.uid !== 0 ||
    (publicStat.mode & 0o7777) !== 0o755 ||
    (await fs.realpath(PUBLIC_ROOT)) !== PUBLIC_ROOT
  )
    throw new Error("Existing public tool directory differs");
  await verifyPublicVercelTree(VERCEL_DESTINATION, manifest.vercel);
  const profiles = await profileHashes();
  if (
    PROFILES.some(
      (profile) => manifest.profileHashes[profile] !== profiles[profile],
    )
  )
    throw new Error("Reviewed dedicated profile configuration changed");
  for (const name of [...Object.keys(PUBLIC_SOURCES), "agent.jar"])
    await installFile(
      join(PUBLIC_ROOT, name),
      await readPrivate(join(directory, name)),
      0,
      0o644,
    );
  for (const [name, target] of Object.entries(SECRET_TARGETS)) {
    await privateDirectory(dirname(target.path), target.uid);
    await installFile(
      target.path,
      await readPrivate(join(directory, name)),
      target.uid,
      0o600,
    );
  }
  await makePrivateDirectory(join(deploy, "jenkins-agent"), 501);
  await makePrivateDirectory(join(ciHome, "agent"), 401);
  const startupChecks = [];
  for (const [user, uid, home] of [
    ["douglasdong", 501, "/Users/douglasdong"],
    ["_agentplatformci", 401, ciHome],
  ])
    startupChecks.push(validateNativeStartup({ user, uid, home }));
  await assertPrivatePathsInaccessible(privateProduction, {
    user: "_agentplatformci",
    uid: 401,
    home: ciHome,
  });
  const vmUser = { user: "douglasdong", uid: 501, home: "/Users/douglasdong" };
  if (!targetAccess("-x", "/opt/homebrew/bin/colima", vmUser))
    throw new Error("Dedicated VM runtime is not executable");
  targetCommand(
    "Colima version only",
    "/opt/homebrew/bin/colima",
    ["version"],
    vmUser,
  );
  const logs = join(HOST_ROOT, "logs");
  await makePrivateDirectory(logs, 501);
  for (const spec of hostServiceDefinitions()) {
    if (spec.StartInterval) await prepareLog(spec.StandardErrorPath);
    else {
      const work =
        spec.ProgramArguments[spec.ProgramArguments.indexOf("-workDir") + 1];
      await makePrivateDirectory(
        work,
        spec.UserName === "douglasdong" ? 501 : 401,
      );
    }
  }
  // All startup probes and reviewed-byte checks finish before the first bootstrap.
  assertFixedLabelsUnloaded();
  for (const spec of hostServiceDefinitions()) {
    if (
      serviceLoaded(spec.Label, "system") ||
      serviceLoaded(spec.Label, "gui/501")
    )
      throw new Error(
        "A host-service label became loaded during preparation; it is preserved",
      );
    const path = `/Library/LaunchDaemons/${spec.Label}.plist`;
    await installFile(path, Buffer.from(plists[spec.Label]), 0, 0o644);
    command("/bin/launchctl", ["enable", `system/${spec.Label}`]);
    command("/bin/launchctl", ["bootstrap", "system", path]);
  }
  return {
    state: "host-services-bootstrapped",
    services: Object.keys(plists).map((label) => ({
      label,
      state: "bootstrapped",
    })),
    startupPrerequisites: "passed",
    startupChecks,
    coldBootTested: false,
    dockerOwnsContainerRestarts: true,
    productionApiOrTunnelChanged: false,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [, , action, first, second] = process.argv;
  if (process.argv.length !== 5)
    throw new Error(
      "Usage: host-services.mjs prepare <private-staged-agent-secrets> <private-Vercel-review-manifest> | apply <prepared-bundle> <reviewed-manifest-sha256>",
    );
  if (action === "prepare")
    console.log(JSON.stringify(await prepareHostBundle(first, second)));
  else if (action === "apply")
    console.log(JSON.stringify(await applyHostBundle(first, second)));
  else
    throw new Error(
      "Only fixed host-service prepare/apply commands are supported",
    );
}
