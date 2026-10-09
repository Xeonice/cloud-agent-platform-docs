// Mac host layout for the operator tools: which account runs them and where
// their host files live. Used only on the Mac (upgrade-agents, manage,
// bootstrap-host, controller, verify-controller, ci-smoke, setup-github-app,
// import-ghcr-token); no image context lists this file.
//
// - The operator is whoever passwd says runs the process (os.userInfo()).
//   HOME, USER, LOGNAME, XDG_* and AGENT_PLATFORM_* are never read, and the home
//   never comes from Node's $HOME-following lookup. The only environment
//   variable read is COLIMA_HOME, and only to refuse one that points away from
//   <home>/.colima.
// - Every path derives from the operator home with a fixed relative layout.
//   Only dockerCli, homebrewPrefix and launchdLabelPrefix may be overridden, and
//   only from <privateDir>/host-layout.json.
// - Each tool declares the checks its action needs (REQUIRES); nothing else is
//   inspected, so a missing VM never blocks `manage.mjs disable`.
// - node: built-ins only. Importing this module performs no I/O.
//
//   node deploy/containers/host-layout.mjs print [--shell]
//   node deploy/containers/host-layout.mjs doctor [--stage host|engines|launchd|images|full]
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LAYOUT_SCHEMA_VERSION = 1;
export const OVERRIDE_SCHEMA_VERSION = 1;
export const NODE_MAJOR = 22;
export const MIN_OPERATOR_UID = 501;
// Above this the UID is a wrapped negative ID such as nobody (-2).
const MAX_OPERATOR_UID = 0x7fffffff;
export const PROFILE_KEYS = Object.freeze(["jenkins", "build", "runtime"]);
export const PROFILES = Object.freeze(
  PROFILE_KEYS.map((key) => "agent-platform-" + key),
);
export const OVERRIDE_KEYS = Object.freeze([
  "dockerCli",
  "homebrewPrefix",
  "launchdLabelPrefix",
]);
// Reverse deployment domain: a deployment name, not a path. Changing it means
// replacing the three LaunchDaemons (the VMs stop meanwhile).
export const DEFAULT_LAUNCHD_LABEL_PREFIX =
  "com.douglasdong.agent-platform.container-engine.";
export const DEFAULT_HOMEBREW_PREFIX = "/opt/homebrew";
const DEFAULT_DOCKER_CLI = ".orbstack/bin/docker";
const PRIVATE_DIR = ".local/share/agent-platform-jenkins-tools";
export const JENKINS_PORTS = Object.freeze({ production: 8080, lab: 18080 });
export const STAGES = Object.freeze([
  "host",
  "engines",
  "launchd",
  "images",
  "full",
]);
const LAUNCH_DAEMONS = "/Library/LaunchDaemons";
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const CHILD_SYSTEM_PATH = ["/usr/local/bin", "/usr/bin", "/bin"];
const TOOL_ENV = Object.freeze({ PATH: SYSTEM_PATH, LANG: "C", LC_ALL: "C" });
const BIN = Object.freeze({
  ls: "/bin/ls",
  lsof: "/usr/sbin/lsof",
  id: "/usr/bin/id",
  dscl: "/usr/bin/dscl",
  dseditgroup: "/usr/sbin/dseditgroup",
  launchctl: "/bin/launchctl",
  plutil: "/usr/bin/plutil",
});
// Group write is tolerated only for these groups, and only while their
// members are root, the operator and the macOS setup account.
const WRITER_GROUPS = Object.freeze({ 0: "wheel", 80: "admin" });
const SYSTEM_GROUP_MEMBERS = Object.freeze(["root", "_mbsetupuser"]);
const USERNAME = /^[a-z][a-z0-9._-]*$/;
const LABEL_PREFIX = /^[a-z0-9]+(\.[a-z0-9-]+)+\.$/;
const PLAIN_PATH = /^(\/[A-Za-z0-9._-]+)+$/;
const CONTROL = /[\0-\x1f\x7f]/;
const READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const ERROR_CODES = Object.freeze({
  HL_USAGE: "command line or API misuse",
  HL_REQUIRE: "unknown or missing host check declaration",
  HL_PLATFORM: "not macOS on Apple Silicon",
  HL_NODE: "not Node 22, or Node path is not plain",
  HL_IDENTITY_EUID: "real and effective UID differ",
  HL_IDENTITY_ROOT: "running as root or through sudo",
  HL_IDENTITY_SERVICE: "service account or out-of-range UID",
  HL_IDENTITY_NAME: "account name outside the operator policy",
  HL_IDENTITY_HOME: "account home is not a plain absolute path",
  HL_IDENTITY_PASSWD: "passwd lookup failed or disagrees with the process",
  HL_IDENTITY_MISMATCH: "layout was derived for another account",
  HL_SUDO: "sudo invoker cannot be anchored to passwd",
  HL_COLIMA_HOME: "COLIMA_HOME points away from <home>/.colima",
  HL_OVERRIDE_FILE: "host-layout.json file identity refused",
  HL_OVERRIDE_SCHEMA: "host-layout.json content refused",
  HL_OVERRIDE_VALUE: "host-layout.json value refused",
  HL_LAYOUT_CHANGED: "derived layout differs from the recorded one",
  HL_MISSING: "required path is absent",
  HL_UNREADABLE: "path cannot be inspected",
  HL_OWNER_CHAIN:
    "a directory on the path is not owned correctly or is writable by others",
  HL_ACL: "ACL entry other than deny, or ACL unreadable",
  HL_PRIVATE_DIR: "private directory identity refused",
  HL_PRIVATE_FILE: "private file identity refused",
  HL_FILE: "operator file identity refused",
  HL_SOCKET: "Docker socket identity refused",
  HL_DOCKER_CONFIG: "private DOCKER_CONFIG refused",
  HL_UNTRUSTED_PATH: "executable or directory outside a trusted location",
  HL_GROUP_MEMBERS: "group-writable path whose group has other members",
  HL_JENKINS_LISTENER: "loopback Jenkins listener is not the operator's",
  HL_PROBE: "read-only probe failed",
  HL_LAUNCHD: "LaunchDaemon definition or state differs",
  HL_REVIEW: "bootstrap review is outdated",
  HL_INTERNAL: "unexpected failure (CLI only)",
});

export class HostLayoutError extends Error {
  constructor(code, reason, { path = null, key = null } = {}) {
    super(
      `Host layout refused [${code}]: ${reason}${path ? ` (${path})` : ""}`,
    );
    this.name = "HostLayoutError";
    this.code = code;
    this.reason = reason;
    this.path = path;
    this.key = key;
  }
}
function refuse(code, reason, details) {
  throw new HostLayoutError(code, reason, details);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

// Absolute, lexically normal (no "." or ".." segments, no repeated or trailing
// slash) and portable characters only. Symlinks are allowed and not resolved.
export function isPlainAbsolutePath(value) {
  return (
    typeof value === "string" &&
    value.length <= 1024 &&
    PLAIN_PATH.test(value) &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}

// ---------------------------------------------------------------------------
// Real system access. Tests replace any member with fakes.

function runCommand(
  file,
  args,
  { env = TOOL_ENV, timeoutMs = 30_000, maxBytes = 4_000_000 } = {},
) {
  return new Promise((done) => {
    let stdout = "",
      stderr = "",
      size = 0,
      settled = false,
      child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ stdout, stderr, ...result });
    };
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
      finish({ code: null, signal: "SIGKILL", timedOut: true });
    }, timeoutMs);
    timer.unref?.();
    try {
      child = spawn(file, args, {
        env,
        cwd: "/",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish({ code: null, signal: null, error: "spawn" });
      return;
    }
    const collect = (append) => (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) child.kill("SIGKILL");
      else append(chunk);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on(
      "data",
      collect((chunk) => (stdout += chunk)),
    );
    child.stderr.on(
      "data",
      collect((chunk) => (stderr += chunk)),
    );
    child.once("error", (error) =>
      finish({ code: null, signal: null, error: error.code ?? "error" }),
    );
    child.once("close", (code, signal) =>
      finish(
        size > maxBytes
          ? { code: null, signal, overflow: true }
          : { code, signal },
      ),
    );
  });
}

export function nodeSystem(overrides = {}) {
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    execPath: process.execPath,
    getuid: () => process.getuid(),
    geteuid: () => process.geteuid(),
    // getpwuid(geteuid()): the account database, never $HOME or $USER.
    userInfo: () => userInfo(),
    // The single environment read of this module (see assertColimaHome).
    colimaHome: () => process.env.COLIMA_HOME,
    lstat: (path) => fs.lstat(path),
    readlink: (path) => fs.readlink(path),
    readdir: (path) => fs.readdir(path),
    readFile: (path) => fs.readFile(path),
    open: (path, flags) => fs.open(path, flags),
    run: runCommand,
    fetch: (url, init) => fetch(url, init),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Operator identity.

export function assertOperatorRecord(record) {
  if (!record || typeof record !== "object")
    refuse("HL_IDENTITY_PASSWD", "No passwd record for the operator");
  const { username, uid, gid } = record;
  const home = record.home ?? record.homedir;
  if (
    !Number.isSafeInteger(uid) ||
    !Number.isSafeInteger(gid) ||
    uid < 0 ||
    gid < 0
  )
    refuse("HL_IDENTITY_PASSWD", "passwd UID or GID is not a number");
  if (uid === 0)
    refuse(
      "HL_IDENTITY_ROOT",
      "Run as the operator account, not as root or through sudo",
    );
  if (uid < MIN_OPERATOR_UID || uid > MAX_OPERATOR_UID)
    refuse(
      "HL_IDENTITY_SERVICE",
      `UID ${uid} is a service account; the operator has a UID of ${MIN_OPERATOR_UID} or above`,
    );
  if (typeof username !== "string" || !USERNAME.test(username))
    refuse(
      "HL_IDENTITY_NAME",
      "Account name must match ^[a-z][a-z0-9._-]*$ (service accounts start with _)",
    );
  if (!isPlainAbsolutePath(home))
    refuse("HL_IDENTITY_HOME", "Account home must be a plain absolute path");
  return Object.freeze({ username, uid, gid, home });
}

export function assertPlatform(sys = nodeSystem()) {
  if (sys.platform !== "darwin" || sys.arch !== "arm64")
    refuse(
      "HL_PLATFORM",
      "Mac operator tools run on macOS on Apple Silicon only",
    );
  if (Number(String(sys.nodeVersion).split(".")[0]) !== NODE_MAJOR)
    refuse("HL_NODE", `Run with Node ${NODE_MAJOR}`);
}

// The account the OS reports for this process; no platform checks, so the
// stop-loss path (manage.mjs) depends on as little as possible.
export function runningOperator(sys = nodeSystem()) {
  const uid = sys.getuid();
  if (uid !== sys.geteuid())
    refuse("HL_IDENTITY_EUID", "Real and effective UID differ");
  if (uid === 0)
    refuse(
      "HL_IDENTITY_ROOT",
      "Run as the operator account, not as root or through sudo",
    );
  let info;
  try {
    info = sys.userInfo();
  } catch {
    refuse("HL_IDENTITY_PASSWD", "The running UID has no passwd entry");
  }
  if (info?.uid !== uid)
    refuse("HL_IDENTITY_PASSWD", "passwd entry disagrees with the running UID");
  return assertOperatorRecord({
    username: info.username,
    uid: info.uid,
    gid: info.gid,
    home: info.homedir,
  });
}

// darwin/arm64/Node 22, uid===euid, not root, UID >= MIN_OPERATOR_UID, plain
// account name.
export function assertOperatorIdentity(sys = nodeSystem()) {
  assertPlatform(sys);
  return runningOperator(sys);
}

// BSD `id -P` prints one master.passwd line:
// name:password:uid:gid:class:change:expire:gecos:home:shell
export function parsePasswdRecord(text) {
  const lines = String(text)
    .split("\n")
    .filter((line) => line !== "");
  if (lines.length !== 1)
    refuse("HL_IDENTITY_PASSWD", "Expected exactly one passwd record");
  const fields = lines[0].split(":");
  if (fields.length !== 10)
    refuse("HL_IDENTITY_PASSWD", "Unexpected passwd record format");
  const [username, , uid, gid, , , , , home, shell] = fields;
  if (!/^(0|[1-9][0-9]*)$/.test(uid) || !/^(0|[1-9][0-9]*)$/.test(gid))
    refuse("HL_IDENTITY_PASSWD", "passwd UID or GID is not a number");
  return { username, uid: Number(uid), gid: Number(gid), home, shell };
}

export async function passwdRecord(username, { sys = nodeSystem() } = {}) {
  if (typeof username !== "string" || !USERNAME.test(username))
    refuse("HL_IDENTITY_NAME", "Account name outside the operator policy");
  const result = await sys.run(BIN.id, ["-P", "--", username], {
    env: TOOL_ENV,
    timeoutMs: 15_000,
  });
  if (result.code !== 0)
    refuse("HL_IDENTITY_PASSWD", "The account has no passwd record");
  const record = parsePasswdRecord(result.stdout);
  if (record.username !== username)
    refuse("HL_IDENTITY_PASSWD", "passwd record names another account");
  return record;
}

// Root side of a reviewed installation: SUDO_UID/SUDO_USER (passed in by the
// caller) are anchored to passwd before anything frozen is trusted.
export async function sudoOperator(
  { sudoUid, sudoUser } = {},
  { sys = nodeSystem() } = {},
) {
  if (
    typeof sudoUid !== "string" ||
    !/^[1-9][0-9]*$/.test(sudoUid) ||
    !Number.isSafeInteger(Number(sudoUid))
  )
    refuse("HL_SUDO", "SUDO_UID must be a positive decimal UID");
  if (typeof sudoUser !== "string" || !USERNAME.test(sudoUser))
    refuse("HL_SUDO", "SUDO_USER is not an operator account name");
  const record = await passwdRecord(sudoUser, { sys });
  if (record.uid !== Number(sudoUid))
    refuse("HL_SUDO", "SUDO_USER and SUDO_UID name different accounts");
  return assertOperatorRecord(record);
}

// Primary group name (staff on a default Mac), for the LaunchDaemon GroupName.
export async function operatorGroupName(operator, { sys = nodeSystem() } = {}) {
  const run = (args) =>
    sys.run(BIN.id, args, { env: TOOL_ENV, timeoutMs: 15_000 });
  const [name, gid] = await Promise.all([
    run(["-gn", "--", operator.username]),
    run(["-g", "--", operator.username]),
  ]);
  const group = name.stdout?.trim();
  if (
    name.code !== 0 ||
    gid.code !== 0 ||
    !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(group ?? "") ||
    gid.stdout.trim() !== String(operator.gid)
  )
    refuse(
      "HL_IDENTITY_PASSWD",
      "Primary group of the operator could not be confirmed",
    );
  return group;
}

export function assertColimaHome(sys, colimaHome) {
  const value = sys.colimaHome();
  if (value !== undefined && value !== colimaHome)
    refuse(
      "HL_COLIMA_HOME",
      "COLIMA_HOME is set to another location; unset it so colima and the LaunchDaemons use the same VMs",
      { path: colimaHome },
    );
}

// ---------------------------------------------------------------------------
// Derivation.

function checkOverrideValues(values) {
  if (!values || typeof values !== "object" || Array.isArray(values))
    refuse("HL_OVERRIDE_SCHEMA", "Overrides must be an object");
  for (const key of Object.keys(values))
    if (!OVERRIDE_KEYS.includes(key))
      refuse(
        "HL_OVERRIDE_SCHEMA",
        `Unknown key ${JSON.stringify(key)}; only ${OVERRIDE_KEYS.join(", ")} may be overridden`,
        { key },
      );
  const checked = {};
  for (const key of OVERRIDE_KEYS) {
    if (!Object.hasOwn(values, key)) continue;
    const value = values[key];
    if (key === "launchdLabelPrefix") {
      if (
        typeof value !== "string" ||
        value.length > 200 ||
        !LABEL_PREFIX.test(value)
      )
        refuse(
          "HL_OVERRIDE_VALUE",
          "launchdLabelPrefix must look like com.example.agent-platform.container-engine. (lower case, dot separated, trailing dot)",
          { key },
        );
    } else if (!isPlainAbsolutePath(value))
      refuse(
        "HL_OVERRIDE_VALUE",
        `${key} must be an absolute path without ".", ".." or repeated slashes, using only A-Z a-z 0-9 . _ - /`,
        { key },
      );
    checked[key] = value;
  }
  return checked;
}

// Content of host-layout.json: {"schemaVersion":1, <override keys>...}.
export function validateOverrides(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    refuse("HL_OVERRIDE_SCHEMA", "host-layout.json must hold a JSON object");
  if (raw.schemaVersion !== OVERRIDE_SCHEMA_VERSION)
    refuse(
      "HL_OVERRIDE_SCHEMA",
      `host-layout.json schemaVersion must be ${OVERRIDE_SCHEMA_VERSION}`,
    );
  const values = { ...raw };
  delete values.schemaVersion;
  return Object.freeze(checkOverrideValues(values));
}

// Pure. identity: {username, uid, gid, home|homedir}; execPath: the Node binary;
// overrides: validated values ({} = defaults), or null when host-layout.json
// was not consulted (the overridable fields are then null).
export function resolveHostLayout({ identity, execPath, overrides = {} } = {}) {
  const operator = assertOperatorRecord(identity);
  if (!isPlainAbsolutePath(execPath))
    refuse("HL_NODE", "Node path must be a plain absolute path");
  const loaded = overrides !== null;
  const values = loaded ? checkOverrideValues(overrides) : {};
  const { home } = operator;
  const pick = (key, fallback) =>
    !loaded ? null : Object.hasOwn(values, key) ? values[key] : fallback;
  const source = (key) =>
    !loaded
      ? "not-loaded"
      : Object.hasOwn(values, key)
        ? "host-layout.json"
        : "default";
  const privateDir = `${home}/${PRIVATE_DIR}`;
  const bootReview = `${privateDir}/container-boot`;
  const colimaHome = `${home}/.colima`;
  const dockerCli = pick("dockerCli", `${home}/${DEFAULT_DOCKER_CLI}`);
  const homebrewPrefix = pick("homebrewPrefix", DEFAULT_HOMEBREW_PREFIX);
  const labelPrefix = pick("launchdLabelPrefix", DEFAULT_LAUNCHD_LABEL_PREFIX);
  const brew = (name) =>
    homebrewPrefix === null ? null : `${homebrewPrefix}/bin/${name}`;
  const profiles = {};
  for (const key of PROFILE_KEYS) {
    const name = "agent-platform-" + key;
    const directory = `${colimaHome}/${name}`;
    const label = labelPrefix === null ? null : labelPrefix + name;
    if (label !== null && (label.includes("/") || label.includes("..")))
      refuse(
        "HL_OVERRIDE_VALUE",
        "LaunchDaemon label must not contain / or ..",
      );
    profiles[key] = {
      key,
      name,
      directory,
      colimaYaml: `${directory}/colima.yaml`,
      socketPath: `${directory}/docker.sock`,
      socket: `unix://${directory}/docker.sock`,
      daemonName: "colima-" + name,
      label,
      log: `${bootReview}/logs/${name}.log`,
    };
  }
  return deepFreeze({
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    operator: { ...operator },
    node: execPath,
    privateDir,
    dockerConfig: `${privateDir}/container-docker-context`,
    stackEnv: `${privateDir}/container-stack.env`,
    runtimeEnv: `${privateDir}/container-runtime.env`,
    adminApi: `${privateDir}/admin-api.json`,
    bootReview,
    bootLogs: `${bootReview}/logs`,
    overrideFile: `${privateDir}/host-layout.json`,
    colimaHome,
    limaOverride: `${colimaHome}/_lima/_config/override.yaml`,
    launchAgents: `${home}/Library/LaunchAgents`,
    launchDaemons: LAUNCH_DAEMONS,
    userDomain: `gui/${operator.uid}`,
    dockerCli,
    homebrewPrefix,
    colima: brew("colima"),
    limactl: brew("limactl"),
    homebrewDocker: brew("docker"),
    launchdPath:
      homebrewPrefix === null ? null : `${homebrewPrefix}/bin:${SYSTEM_PATH}`,
    launchdLabelPrefix: labelPrefix,
    profiles,
    overrides: loaded ? { ...values } : null,
    sources: Object.fromEntries(OVERRIDE_KEYS.map((key) => [key, source(key)])),
  });
}

// Plain JSON copy for plan.json / review.json.
export function layoutRecord(layout) {
  return JSON.parse(JSON.stringify(layout));
}
export function layoutSha256(layout) {
  return digest(JSON.stringify(layoutRecord(layout)));
}

function firstDifference(a, b, path = "") {
  if (Object.is(a, b)) return null;
  if (
    a &&
    b &&
    typeof a === "object" &&
    typeof b === "object" &&
    Array.isArray(a) === Array.isArray(b)
  ) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const found = firstDifference(
        a[key],
        b[key],
        path ? `${path}.${key}` : key,
      );
      if (found) return found;
    }
    return null;
  }
  return path || "(layout)";
}

// Recorded (plan.json, review.json) against freshly derived: every field equal.
export function assertSameLayout(recorded, current) {
  const field = firstDifference(layoutRecord(recorded), layoutRecord(current));
  if (field)
    refuse(
      "HL_LAYOUT_CHANGED",
      `Host layout changed since it was recorded (field ${field}); restore the account, Node or host-layout.json, or start again with a fresh output`,
      { key: field },
    );
}

// Every derived field must follow from operator, node and overrides.
export function assertLayoutConsistent(layout) {
  if (!layout || layout.schemaVersion !== LAYOUT_SCHEMA_VERSION)
    refuse("HL_LAYOUT_CHANGED", "Unknown host layout schema");
  assertSameLayout(
    layout,
    resolveHostLayout({
      identity: layout.operator,
      execPath: layout.node,
      overrides: layout.overrides,
    }),
  );
}

export function childPath(layout) {
  return [posix.dirname(layout.node), ...CHILD_SYSTEM_PATH];
}

// Host part of a child environment; identity comes from passwd, never from
// the caller's environment. Callers append their own fixed keys after it.
export function childEnvironment(layout) {
  return {
    PATH: childPath(layout).join(":"),
    HOME: layout.operator.home,
    USER: layout.operator.username,
    LOGNAME: layout.operator.username,
    LANG: "en_US.UTF-8",
    DOCKER_CONFIG: layout.dockerConfig,
  };
}

export function dockerHostArgs(layout, profileKey) {
  if (!PROFILE_KEYS.includes(profileKey))
    refuse("HL_USAGE", "Unknown Colima profile");
  return [
    "--config",
    layout.dockerConfig,
    "--host",
    layout.profiles[profileKey].socket,
  ];
}

// Path and sha256 of the host-layout module actually loaded (plan binding).
export async function moduleIdentity() {
  const path = await fs.realpath(fileURLToPath(import.meta.url));
  const handle = await fs.open(path, READ_FLAGS);
  try {
    return Object.freeze({ path, sha256: digest(await handle.readFile()) });
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Read-only file system checks.

function context(sys, operator) {
  return { sys, operator, acl: new Map(), dirs: new Map(), groups: new Map() };
}

async function lstatOrNull(ctx, path) {
  try {
    return await ctx.sys.lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    refuse(
      "HL_UNREADABLE",
      `Path cannot be inspected (${error?.code ?? "error"})`,
      { path },
    );
  }
}

function ancestorsOf(path) {
  const parts = path.split("/").filter(Boolean);
  const out = ["/"];
  for (let i = 1; i < parts.length; i++)
    out.push("/" + parts.slice(0, i).join("/"));
  return out;
}

// `/bin/ls -lde` prints the long listing line, then one line per ACL entry:
//  0: group:everyone deny delete
//  1: group:staff inherited allow read,write
export function parseAclListing(text) {
  const entries = [];
  for (const line of String(text).split("\n").slice(1)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+): (.+)$/.exec(line);
    if (!match) {
      entries.push({
        index: null,
        text: line.trim(),
        kind: "unknown",
        inherited: false,
      });
      continue;
    }
    const words = match[2].split(" ");
    const inherited = words[1] === "inherited";
    const kind = words[inherited ? 2 : 1];
    entries.push({
      index: Number(match[1]),
      text: match[2],
      kind: kind === "allow" || kind === "deny" ? kind : "unknown",
      inherited,
    });
  }
  return entries;
}

// Mode bits do not show ACLs; any entry other than deny is refused.
async function assertNoAllowAcl(ctx, path) {
  if (ctx.acl.has(path)) return;
  if (CONTROL.test(path)) refuse("HL_ACL", "Path contains control characters");
  const result = await ctx.sys.run(BIN.ls, ["-lde", "--", path], {
    env: TOOL_ENV,
    timeoutMs: 15_000,
  });
  if (result.code !== 0 || !result.stdout)
    refuse("HL_ACL", "ACL could not be read", { path });
  const offending = parseAclListing(result.stdout).filter(
    (entry) => entry.kind !== "deny",
  );
  if (offending.length)
    refuse(
      "HL_ACL",
      `Only deny ACL entries are accepted (${offending.map((entry) => entry.text).join("; ")})`,
      { path },
    );
  ctx.acl.set(path, true);
}

// Above the home: root's and not writable by group/others unless sticky.
// From the home down: the operator's and not writable by group/others.
async function chainDirectory(ctx, dir, aboveHome) {
  if (ctx.dirs.has(dir)) return ctx.dirs.get(dir);
  const stat = await lstatOrNull(ctx, dir);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory())
    refuse(
      "HL_OWNER_CHAIN",
      "Expected a real directory, not a symlink or file",
      { path: dir },
    );
  if (aboveHome) {
    if (stat.uid !== 0 || (stat.mode & 0o022 && !(stat.mode & 0o1000)))
      refuse(
        "HL_OWNER_CHAIN",
        "Directories above the operator home must be root's and not writable by group or others (unless sticky)",
        { path: dir },
      );
  } else if (stat.uid !== ctx.operator.uid || stat.mode & 0o022)
    refuse(
      "HL_OWNER_CHAIN",
      "Directories from the operator home down must be the operator's and not writable by group or others",
      { path: dir },
    );
  await assertNoAllowAcl(ctx, dir);
  ctx.dirs.set(dir, stat);
  return stat;
}

// Every directory from / down to the parent of path. False when one is absent
// and allowMissing is set.
async function ownedChain(ctx, path, { allowMissing = false } = {}) {
  const { home } = ctx.operator;
  if (path !== home && !path.startsWith(home + "/"))
    refuse("HL_OWNER_CHAIN", "Path is outside the operator home", { path });
  for (const dir of ancestorsOf(path)) {
    const aboveHome = dir !== home && !dir.startsWith(home + "/");
    if (await chainDirectory(ctx, dir, aboveHome)) continue;
    if (allowMissing) return false;
    refuse("HL_MISSING", "Directory is absent", { path: dir });
  }
  return true;
}

async function homeDirectory(ctx) {
  const { home } = ctx.operator;
  await ownedChain(ctx, home);
  if (!(await chainDirectory(ctx, home, false)))
    refuse("HL_MISSING", "Operator home is absent", { path: home });
}

async function privateDirectory(
  ctx,
  dir,
  { code = "HL_PRIVATE_DIR", allowMissing = false } = {},
) {
  if (!(await ownedChain(ctx, dir, { allowMissing }))) return null;
  const stat = await lstatOrNull(ctx, dir);
  if (!stat) {
    if (allowMissing) return null;
    refuse("HL_MISSING", "Required private directory is absent", { path: dir });
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== ctx.operator.uid ||
    (stat.mode & 0o777) !== 0o700
  )
    refuse(
      code,
      "Private directory must be the operator's real directory with mode 0700",
      {
        path: dir,
      },
    );
  await assertNoAllowAcl(ctx, dir);
  return stat;
}

async function readOpened(ctx, path, handle, before, code) {
  const stat = await handle.stat();
  if (stat.dev !== before.dev || stat.ino !== before.ino)
    refuse(code, "File changed while it was opened", { path });
  const bytes = await handle.readFile();
  const after = await handle.stat();
  if (
    bytes.length !== after.size ||
    after.size !== stat.size ||
    after.mtimeMs !== stat.mtimeMs ||
    after.ctimeMs !== stat.ctimeMs
  )
    refuse(code, "File changed while it was read", { path });
  return bytes;
}

// Secrets and private configuration: O_NOFOLLOW + fstat, the operator's,
// mode 0600, one link, no allow ACL. Content is read only on request.
async function privateFile(
  ctx,
  path,
  {
    read = false,
    maxBytes = 8_000_000,
    allowMissing = false,
    code = "HL_PRIVATE_FILE",
  } = {},
) {
  if (!(await ownedChain(ctx, path, { allowMissing }))) return null;
  const before = await lstatOrNull(ctx, path);
  if (!before) {
    if (allowMissing) return null;
    refuse("HL_MISSING", "Required private file is absent", { path });
  }
  if (before.isSymbolicLink() || !before.isFile())
    refuse(code, "Private file must be a regular file, not a symlink", {
      path,
    });
  let handle;
  try {
    handle = await ctx.sys.open(path, READ_FLAGS);
  } catch (error) {
    refuse(
      code,
      `Private file could not be opened without following links (${error?.code ?? "error"})`,
      {
        path,
      },
    );
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.uid !== ctx.operator.uid ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1
    )
      refuse(
        code,
        "Private file must be the operator's single-link regular file with mode 0600",
        {
          path,
        },
      );
    if (stat.size > maxBytes)
      refuse(code, "Private file is unexpectedly large", { path });
    await assertNoAllowAcl(ctx, path);
    const proof = { path, dev: stat.dev, ino: stat.ino, size: stat.size };
    if (read) proof.bytes = await readOpened(ctx, path, handle, before, code);
    return proof;
  } finally {
    await handle.close();
  }
}

// Non-secret operator files (colima.yaml, Lima override, review.json input).
async function operatorFile(
  ctx,
  path,
  { read = false, maxBytes = 2_000_000, code = "HL_FILE" } = {},
) {
  await ownedChain(ctx, path);
  const stat = await lstatOrNull(ctx, path);
  if (!stat) refuse("HL_MISSING", "Required file is absent", { path });
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.uid !== ctx.operator.uid ||
    stat.mode & 0o022 ||
    stat.size > maxBytes
  )
    refuse(
      code,
      "Must be the operator's regular file, not writable by group or others",
      { path },
    );
  await assertNoAllowAcl(ctx, path);
  if (!read) return { path };
  let handle;
  try {
    handle = await ctx.sys.open(path, READ_FLAGS);
  } catch (error) {
    refuse(
      code,
      `File could not be opened without following links (${error?.code ?? "error"})`,
      {
        path,
      },
    );
  }
  try {
    return { path, bytes: await readOpened(ctx, path, handle, stat, code) };
  } finally {
    await handle.close();
  }
}

async function operatorSocket(ctx, profile) {
  const path = profile.socketPath;
  await ownedChain(ctx, path);
  const stat = await lstatOrNull(ctx, path);
  if (!stat)
    refuse(
      "HL_MISSING",
      `Docker socket of ${profile.name} is absent (is the VM running?)`,
      {
        path,
      },
    );
  if (
    !stat.isSocket() ||
    stat.uid !== ctx.operator.uid ||
    (stat.mode & 0o777) !== 0o600
  )
    refuse(
      "HL_SOCKET",
      "Docker socket must be the operator's socket with mode 0600",
      { path },
    );
  await assertNoAllowAcl(ctx, path);
  return { path };
}

// `dscl . -read` prints "Key: v1 v2", long values continue on indented lines.
export function parseDsclAttributes(text) {
  const out = {};
  let current = null;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    const match = /^([A-Za-z][A-Za-z0-9_.:-]*):(?: (.*))?$/.exec(line);
    if (match && !line.startsWith(" ")) {
      current = match[1];
      out[current] = (match[2] ?? "").split(" ").filter(Boolean);
    } else if (current && line.startsWith(" "))
      out[current].push(...line.trim().split(" ").filter(Boolean));
  }
  return out;
}

function parseDsclList(text) {
  const rows = [];
  for (const line of String(text).split("\n")) {
    const match = /^(\S+)\s+(-?[0-9]+)\s*$/.exec(line);
    if (match) rows.push({ name: match[1], value: Number(match[2]) });
  }
  return rows;
}

// Explicit members, accounts with the group as primary group, and every local
// account with a UID of 500 or above that dseditgroup reports as a member.
async function groupMembers(ctx, gid, name) {
  if (ctx.groups.has(gid)) return ctx.groups.get(gid);
  const pending = (async () => {
    const run = (file, args) =>
      ctx.sys.run(file, args, { env: TOOL_ENV, timeoutMs: 15_000 });
    const where = { path: "/Groups/" + name };
    const record = await run(BIN.dscl, [
      ".",
      "-read",
      "/Groups/" + name,
      "GroupMembership",
      "PrimaryGroupID",
      "NestedGroups",
    ]);
    if (record.code !== 0)
      refuse("HL_GROUP_MEMBERS", "Group membership could not be read", where);
    const attributes = parseDsclAttributes(record.stdout);
    if (attributes.PrimaryGroupID?.[0] !== String(gid))
      refuse(
        "HL_GROUP_MEMBERS",
        "Group ID differs from the expected group",
        where,
      );
    if (attributes.NestedGroups?.length)
      refuse("HL_GROUP_MEMBERS", "Nested groups cannot be enumerated", where);
    const members = new Set(attributes.GroupMembership ?? []);
    const [primary, ids] = await Promise.all([
      run(BIN.dscl, [".", "-list", "/Users", "PrimaryGroupID"]),
      run(BIN.dscl, [".", "-list", "/Users", "UniqueID"]),
    ]);
    if (primary.code !== 0 || ids.code !== 0)
      refuse("HL_GROUP_MEMBERS", "Local accounts could not be listed", where);
    for (const row of parseDsclList(primary.stdout))
      if (row.value === gid) members.add(row.name);
    for (const row of parseDsclList(ids.stdout)) {
      if (row.value < 500 || members.has(row.name)) continue;
      const check = await run(BIN.dseditgroup, [
        "-o",
        "checkmember",
        "-m",
        row.name,
        name,
      ]);
      if (check.code === 0) members.add(row.name);
    }
    return members;
  })();
  ctx.groups.set(gid, pending);
  return pending;
}

async function trustedEntry(ctx, entry, stat) {
  if (stat.uid !== 0 && stat.uid !== ctx.operator.uid)
    refuse(
      "HL_UNTRUSTED_PATH",
      "Owned by an account other than root and the operator",
      {
        path: entry,
      },
    );
  // Symlink permission bits are not used by macOS; the link's directory is checked.
  if (!stat.isSymbolicLink()) {
    if (stat.mode & 0o002)
      refuse("HL_UNTRUSTED_PATH", "Writable by others", { path: entry });
    if (stat.mode & 0o020) {
      const name = WRITER_GROUPS[stat.gid];
      if (!name)
        refuse(
          "HL_UNTRUSTED_PATH",
          "Group-writable by a group other than admin or wheel",
          {
            path: entry,
          },
        );
      const allowed = new Set([...SYSTEM_GROUP_MEMBERS, ctx.operator.username]);
      const extra = [...(await groupMembers(ctx, stat.gid, name))].filter(
        (member) => !allowed.has(member),
      );
      if (extra.length)
        refuse(
          "HL_GROUP_MEMBERS",
          `Group ${name} may write here and also contains ${extra.sort().join(", ")}`,
          { path: entry },
        );
    }
  }
  await assertNoAllowAcl(ctx, entry);
}

// Resolves path one component at a time (lstat on every hop, following
// symlinks by hand) and requires each directory, link and the final entry to
// be root's or the operator's, not writable by others, group-writable only by
// a restricted admin/wheel, and without allow ACLs.
async function trustedPath(ctx, path, { expect }) {
  if (!isPlainAbsolutePath(path))
    refuse("HL_UNTRUSTED_PATH", "Path must be a plain absolute path", { path });
  const seen = new Set();
  const visit = async (entry, stat) => {
    if (seen.has(entry)) return;
    seen.add(entry);
    await trustedEntry(ctx, entry, stat);
  };
  let current = "/";
  let final = await lstatOrNull(ctx, "/");
  if (!final) refuse("HL_MISSING", "Root directory is absent", { path: "/" });
  await visit("/", final);
  let pending = path.split("/").filter(Boolean);
  let hops = 0;
  while (pending.length) {
    const part = pending.shift();
    if (part === ".") continue;
    if (part === "..") {
      current = posix.dirname(current);
      continue;
    }
    const next = current === "/" ? "/" + part : `${current}/${part}`;
    const stat = await lstatOrNull(ctx, next);
    if (!stat) refuse("HL_MISSING", "Path is absent", { path: next });
    await visit(next, stat);
    if (stat.isSymbolicLink()) {
      if (++hops > 32)
        refuse("HL_UNTRUSTED_PATH", "Too many symbolic links", { path });
      const target = await ctx.sys.readlink(next);
      if (!target || CONTROL.test(target))
        refuse("HL_UNTRUSTED_PATH", "Unexpected symbolic link target", {
          path: next,
        });
      if (target.startsWith("/")) current = "/";
      pending = [...target.split("/").filter(Boolean), ...pending];
      continue;
    }
    if (pending.length && !stat.isDirectory())
      refuse("HL_UNTRUSTED_PATH", "Not a directory", { path: next });
    current = next;
    final = stat;
  }
  if (expect === "file" && (!final.isFile() || !(final.mode & 0o111)))
    refuse("HL_UNTRUSTED_PATH", "Not an executable regular file", {
      path: current,
    });
  if (expect === "directory" && !final.isDirectory())
    refuse("HL_UNTRUSTED_PATH", "Not a directory", { path: current });
  return { path, realpath: current };
}

// A directory on a search path. It may be absent: trustedPath reports
// HL_MISSING only after it verified the directory the entry would be created
// in (also behind symlinks), so nobody else can create it.
async function trustedDirectory(ctx, dir) {
  try {
    return {
      ...(await trustedPath(ctx, dir, { expect: "directory" })),
      present: true,
    };
  } catch (error) {
    if (error?.code !== "HL_MISSING") throw error;
    return { path: dir, realpath: null, present: false };
  }
}

export async function assertTrustedExecutable(
  path,
  operator,
  { sys = nodeSystem(), hash = false, ctx = context(sys, operator) } = {},
) {
  const found = await trustedPath(ctx, path, { expect: "file" });
  if (!hash) return Object.freeze(found);
  const handle = await sys.open(found.realpath, READ_FLAGS);
  try {
    return Object.freeze({ ...found, sha256: digest(await handle.readFile()) });
  } finally {
    await handle.close();
  }
}

// host-layout.json is read only after every directory down to the private
// directory proved to be the operator's; absent file or directory = defaults.
export async function loadOverrides(
  operator,
  { sys = nodeSystem(), ctx = context(sys, operator) } = {},
) {
  const privateDir = `${operator.home}/${PRIVATE_DIR}`;
  const path = `${privateDir}/host-layout.json`;
  const absent = Object.freeze({
    path,
    present: false,
    sha256: null,
    values: Object.freeze({}),
  });
  if (!(await ownedChain(ctx, path, { allowMissing: true }))) return absent;
  const file = await privateFile(ctx, path, {
    read: true,
    maxBytes: 64 * 1024,
    allowMissing: true,
    code: "HL_OVERRIDE_FILE",
  });
  if (!file) return absent;
  let raw;
  try {
    raw = JSON.parse(file.bytes.toString("utf8"));
  } catch {
    refuse("HL_OVERRIDE_SCHEMA", "host-layout.json is not valid JSON", {
      path,
    });
  }
  let values;
  try {
    values = validateOverrides(raw);
  } catch (error) {
    if (error instanceof HostLayoutError)
      refuse(error.code, error.reason, { path, key: error.key });
    throw error;
  }
  return Object.freeze({
    path,
    present: true,
    sha256: digest(file.bytes),
    values,
  });
}

async function dockerConfiguration(ctx, layout) {
  const code = "HL_DOCKER_CONFIG";
  await privateDirectory(ctx, layout.dockerConfig, { code });
  const path = `${layout.dockerConfig}/config.json`;
  const file = await privateFile(ctx, path, {
    read: true,
    maxBytes: 1_000_000,
    code,
  });
  let config;
  try {
    config = JSON.parse(file.bytes.toString("utf8"));
  } catch {
    refuse(code, "config.json is not valid JSON", { path });
  }
  if (!config || typeof config !== "object" || Array.isArray(config))
    refuse(code, "config.json must hold a JSON object", { path });
  for (const key of ["credsStore", "credHelpers"])
    if (Object.hasOwn(config, key))
      refuse(
        code,
        `config.json sets ${key}, which runs credential helpers found on PATH`,
        {
          path,
        },
      );
  const dirs = config.cliPluginsExtraDirs;
  if (
    !Array.isArray(dirs) ||
    !dirs.length ||
    dirs.length > 8 ||
    !dirs.every(isPlainAbsolutePath)
  )
    refuse(code, "cliPluginsExtraDirs must list plain absolute directories", {
      path,
    });
  const plugins = {};
  for (const dir of dirs) {
    await trustedPath(ctx, dir, { expect: "directory" });
    for (const name of ["docker-compose", "docker-buildx"]) {
      // Docker uses the first directory that provides a plugin.
      if (plugins[name] || !(await lstatOrNull(ctx, `${dir}/${name}`)))
        continue;
      plugins[name] = await trustedPath(ctx, `${dir}/${name}`, {
        expect: "file",
      });
    }
  }
  for (const name of ["docker-compose", "docker-buildx"])
    if (!plugins[name])
      refuse(code, `${name} is missing from cliPluginsExtraDirs`, { path });
  return {
    pluginDirs: [...dirs],
    plugins,
    extraKeys: Object.keys(config).filter(
      (key) => key !== "cliPluginsExtraDirs",
    ),
  };
}

// ---------------------------------------------------------------------------
// Per-action checks.

function overridden(layout) {
  if (layout.overrides === null)
    refuse(
      "HL_USAGE",
      "This layout was derived without host-layout.json; declare the check when loading",
    );
  return layout;
}

const REQUIRE_CHECKS = {
  platform: async (ctx) => assertPlatform(ctx.sys),
  operator: async (ctx, layout) => {
    const running = runningOperator(ctx.sys);
    if (firstDifference({ ...running }, { ...layout.operator }))
      refuse(
        "HL_IDENTITY_MISMATCH",
        "This layout was derived for another account",
      );
  },
  colimaEnv: async (ctx, layout) =>
    assertColimaHome(ctx.sys, layout.colimaHome),
  home: (ctx) => homeDirectory(ctx),
  overrideFile: async (ctx, layout) => {
    const found = await loadOverrides(layout.operator, { sys: ctx.sys, ctx });
    if (
      firstDifference({ ...found.values }, { ...overridden(layout).overrides })
    )
      refuse(
        "HL_LAYOUT_CHANGED",
        "host-layout.json changed after the layout was derived",
        {
          path: found.path,
        },
      );
    return { present: found.present, sha256: found.sha256 };
  },
  privateDir: async (ctx, layout) => {
    await privateDirectory(ctx, layout.privateDir);
  },
  dockerConfig: (ctx, layout) => dockerConfiguration(ctx, layout),
  stackEnv: async (ctx, layout) => {
    await privateFile(ctx, layout.stackEnv);
  },
  runtimeEnv: async (ctx, layout) => {
    await privateFile(ctx, layout.runtimeEnv);
  },
  adminApi: async (ctx, layout) => {
    await privateFile(ctx, layout.adminApi);
  },
  dockerCli: (ctx, layout) =>
    trustedPath(ctx, overridden(layout).dockerCli, { expect: "file" }),
  node: async (ctx, layout) => {
    if (layout.node !== ctx.sys.execPath)
      refuse(
        "HL_LAYOUT_CHANGED",
        "This layout was derived for another Node binary",
        {
          path: layout.node,
        },
      );
    const node = await trustedPath(ctx, layout.node, { expect: "file" });
    for (const dir of childPath(layout)) await trustedDirectory(ctx, dir);
    return node;
  },
  colima: (ctx, layout) =>
    trustedPath(ctx, overridden(layout).colima, { expect: "file" }),
  limactl: (ctx, layout) =>
    trustedPath(ctx, overridden(layout).limactl, { expect: "file" }),
  homebrewDocker: (ctx, layout) =>
    trustedPath(ctx, overridden(layout).homebrewDocker, { expect: "file" }),
  launchdPath: async (ctx, layout) => {
    for (const dir of overridden(layout).launchdPath.split(":"))
      await trustedDirectory(ctx, dir);
  },
  colimaYaml: async (ctx, layout) => {
    for (const key of PROFILE_KEYS)
      await operatorFile(ctx, layout.profiles[key].colimaYaml);
  },
  "socket:jenkins": (ctx, layout) =>
    operatorSocket(ctx, layout.profiles.jenkins),
  "socket:build": (ctx, layout) => operatorSocket(ctx, layout.profiles.build),
  "socket:runtime": (ctx, layout) =>
    operatorSocket(ctx, layout.profiles.runtime),
  limaOverride: async (ctx, layout) => {
    await operatorFile(ctx, layout.limaOverride);
  },
};
const ALIASES = {
  identity: ["platform", "operator"],
  sockets: ["socket:jenkins", "socket:build", "socket:runtime"],
};
// Checks that need host-layout.json (overridable fields).
const OVERRIDE_DEPENDENT = new Set([
  "overrideFile",
  "dockerCli",
  "colima",
  "limactl",
  "homebrewDocker",
  "launchdPath",
]);
// Checks about the Colima VMs; COLIMA_HOME is refused whenever one is declared.
const COLIMA_DEPENDENT = new Set([
  "socket:jenkins",
  "socket:build",
  "socket:runtime",
  "colimaYaml",
  "colima",
  "limactl",
  "launchdPath",
  "limaOverride",
]);
export const REQUIRE_KEYS = Object.freeze([
  ...Object.keys(REQUIRE_CHECKS),
  ...Object.keys(ALIASES),
]);

const UPGRADE_BUILD = [
  "identity",
  "colimaEnv",
  "overrideFile",
  "privateDir",
  "dockerConfig",
  "stackEnv",
  "runtimeEnv",
  "dockerCli",
  "node",
  "socket:build",
];
// What each action needs before it starts; nothing else is inspected.
export const REQUIRES = deepFreeze({
  // Stop-loss path: account from passwd, private directory, credential only.
  manage: ["operator", "privateDir", "adminApi"],
  "upgrade-build": UPGRADE_BUILD,
  "upgrade-apply": [
    ...UPGRADE_BUILD,
    "adminApi",
    "socket:runtime",
    "socket:jenkins",
  ],
  "bootstrap-prepare": [
    "identity",
    "colimaEnv",
    "overrideFile",
    "colimaYaml",
    "colima",
    "launchdPath",
  ],
  // Root with the operator anchored by sudoOperator(); values frozen at prepare.
  "bootstrap-apply-system": [
    "colimaEnv",
    "colimaYaml",
    "colima",
    "launchdPath",
  ],
  "verify-controller": [
    "identity",
    "colimaEnv",
    "overrideFile",
    "privateDir",
    "dockerConfig",
    "dockerCli",
    "socket:jenkins",
    "socket:build",
  ],
  "ci-smoke": [
    "identity",
    "colimaEnv",
    "overrideFile",
    "privateDir",
    "dockerConfig",
    "dockerCli",
    "socket:build",
  ],
  "setup-github-app": ["identity", "privateDir"],
  "import-ghcr-token": ["identity", "privateDir"],
  print: ["identity", "colimaEnv", "overrideFile"],
});

// Preset name or list of keys -> ordered, de-duplicated check keys.
export function expandRequires(requires) {
  let list = requires;
  if (typeof requires === "string") {
    if (!Object.hasOwn(REQUIRES, requires))
      refuse(
        "HL_REQUIRE",
        `Unknown host check preset ${JSON.stringify(requires)}`,
      );
    list = REQUIRES[requires];
  }
  if (!Array.isArray(list) || !list.length)
    refuse("HL_REQUIRE", "Declare the host checks this action needs");
  const out = [];
  const add = (key) => out.includes(key) || out.push(key);
  for (const key of list) {
    if (typeof key === "string" && Object.hasOwn(ALIASES, key))
      ALIASES[key].forEach(add);
    else if (typeof key === "string" && Object.hasOwn(REQUIRE_CHECKS, key))
      add(key);
    else refuse("HL_REQUIRE", `Unknown host check ${JSON.stringify(key)}`);
  }
  if (
    out.some((key) => COLIMA_DEPENDENT.has(key)) &&
    !out.includes("colimaEnv")
  )
    out.splice(
      out.filter((key) => key === "platform" || key === "operator").length,
      0,
      "colimaEnv",
    );
  return Object.freeze(out);
}

// Runs the declared checks in order; the first failure throws HostLayoutError.
export async function verifyHostLayout(
  layout,
  requires,
  { sys = nodeSystem() } = {},
) {
  const keys = expandRequires(requires);
  assertLayoutConsistent(layout);
  const ctx = context(sys, layout.operator);
  const results = {};
  for (const key of keys) {
    try {
      results[key] = (await REQUIRE_CHECKS[key](ctx, layout)) ?? null;
    } catch (error) {
      if (error instanceof HostLayoutError && !error.key) error.key = key;
      throw error;
    }
  }
  return Object.freeze({ requires: keys, results });
}

// Entry point for the operator tools: identity (and platform when declared),
// host-layout.json only when a declared check depends on it, then the checks.
export async function loadHostLayout({ requires, sys = nodeSystem() } = {}) {
  const keys = expandRequires(requires);
  if (keys.includes("platform")) assertPlatform(sys);
  const operator = runningOperator(sys);
  const overrides = keys.some((key) => OVERRIDE_DEPENDENT.has(key))
    ? (await loadOverrides(operator, { sys })).values
    : null;
  const layout = resolveHostLayout({
    identity: operator,
    execPath: sys.execPath,
    overrides,
  });
  await verifyHostLayout(layout, keys, { sys });
  return layout;
}

// ---------------------------------------------------------------------------
// Jenkins loopback listener.

export function parseLsofListeners(text) {
  const listeners = [];
  let current = null;
  for (const line of String(text).split("\n")) {
    if (!line) continue;
    const value = line.slice(1);
    if (line[0] === "p") {
      if (!/^[1-9][0-9]*$/.test(value))
        refuse("HL_JENKINS_LISTENER", "Unexpected lsof output");
      current = { pid: Number(value), uid: null };
      listeners.push(current);
    } else if (line[0] === "u") {
      if (!current || !/^(0|[1-9][0-9]*)$/.test(value))
        refuse("HL_JENKINS_LISTENER", "Unexpected lsof output");
      current.uid = Number(value);
    }
  }
  if (listeners.some((listener) => listener.uid === null))
    refuse("HL_JENKINS_LISTENER", "lsof did not report the listener's UID");
  return listeners;
}

// The loopback port is first come, first served across accounts: confirm the
// operator holds it before any Jenkins credential is sent. As a normal user
// lsof only sees the operator's own processes, so "nothing visible" refuses.
export async function assertJenkinsListener(
  port,
  operator,
  { sys = nodeSystem() } = {},
) {
  if (!Object.values(JENKINS_PORTS).includes(port))
    refuse(
      "HL_USAGE",
      "Only the Jenkins loopback ports 8080 and 18080 are checked",
    );
  if (!Number.isSafeInteger(operator?.uid))
    refuse("HL_USAGE", "Operator identity required");
  const result = await sys.run(
    BIN.lsof,
    ["-nP", "-a", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN", "-Fpu"],
    { env: TOOL_ENV, timeoutMs: 15_000 },
  );
  if (result.code !== 0 && !(result.code === 1 && !result.stdout.trim()))
    refuse(
      "HL_JENKINS_LISTENER",
      `lsof failed while checking 127.0.0.1:${port}`,
    );
  const listeners = parseLsofListeners(result.stdout);
  if (!listeners.length)
    refuse(
      "HL_JENKINS_LISTENER",
      `No listener of the operator on 127.0.0.1:${port}; the Jenkins credential is not sent`,
    );
  const foreign = [
    ...new Set(
      listeners.filter((l) => l.uid !== operator.uid).map((l) => l.uid),
    ),
  ];
  if (foreign.length)
    refuse(
      "HL_JENKINS_LISTENER",
      `127.0.0.1:${port} is held by UID ${foreign.join(", ")}, not the operator; the Jenkins credential is not sent`,
    );
  return Object.freeze({ port, listeners: Object.freeze(listeners) });
}

// ---------------------------------------------------------------------------
// doctor: read-only, staged. Checks of later stages are reported as not-yet.

function dockerProbeEnv(layout) {
  return {
    PATH: "/usr/bin:/bin",
    HOME: layout.operator.home,
    LANG: "C",
    DOCKER_CONFIG: layout.dockerConfig,
  };
}

async function dockerProbe(d) {
  const { layout, sys } = d;
  const run = (args) =>
    sys.run(layout.dockerCli, ["--config", layout.dockerConfig, ...args], {
      env: dockerProbeEnv(layout),
      timeoutMs: 20_000,
    });
  const [client, compose, buildx] = await Promise.all([
    run(["--version"]),
    run(["compose", "version", "--short"]),
    run(["buildx", "version"]),
  ]);
  for (const [name, result] of Object.entries({ client, compose, buildx }))
    if (result.code !== 0 || !result.stdout.trim())
      refuse(
        "HL_PROBE",
        `docker ${name === "client" ? "--version" : name + " version"} failed`,
        {
          path: layout.dockerCli,
        },
      );
  return {
    detail: `${client.stdout.trim()}; compose ${compose.stdout.trim()}; ${buildx.stdout.trim().split(" ").slice(0, 2).join(" ")}`,
  };
}

async function daemonProbe(d, key) {
  const { layout, sys } = d;
  const profile = layout.profiles[key];
  const result = await sys.run(
    layout.dockerCli,
    [...dockerHostArgs(layout, key), "info", "--format", "{{.Name}}"],
    { env: dockerProbeEnv(layout), timeoutMs: 30_000 },
  );
  if (result.code !== 0)
    refuse("HL_PROBE", `Docker daemon of ${profile.name} did not answer`, {
      path: profile.socketPath,
    });
  if (result.stdout.trim() !== profile.daemonName)
    refuse(
      "HL_PROBE",
      `Socket answers as another daemon, expected ${profile.daemonName}`,
      {
        path: profile.socketPath,
      },
    );
  return { detail: profile.daemonName };
}

async function plistJson(d, file) {
  const result = await d.sys.run(
    BIN.plutil,
    ["-convert", "json", "-o", "-", "--", file],
    {
      env: TOOL_ENV,
      timeoutMs: 15_000,
    },
  );
  if (result.code !== 0)
    refuse("HL_LAUNCHD", "plist could not be parsed", { path: file });
  try {
    return JSON.parse(result.stdout);
  } catch {
    refuse("HL_LAUNCHD", "plist could not be parsed", { path: file });
  }
}

async function launchdService(d, key) {
  const { layout, sys, ctx } = d;
  const profile = layout.profiles[key];
  const file = `${LAUNCH_DAEMONS}/${profile.label}.plist`;
  const stat = await lstatOrNull(ctx, file);
  if (!stat)
    refuse("HL_MISSING", "LaunchDaemon is not installed", { path: file });
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.uid !== 0 ||
    stat.mode & 0o022
  )
    refuse(
      "HL_LAUNCHD",
      "LaunchDaemon must be root's regular file, not writable by group or others",
      {
        path: file,
      },
    );
  await assertNoAllowAcl(ctx, file);
  const bytes = await sys.readFile(file);
  let compared = "fields";
  if (typeof d.render === "function") {
    let expected;
    try {
      expected = d.render(true, layout)?.[profile.label];
    } catch {
      expected = undefined;
    }
    if (typeof expected !== "string")
      refuse(
        "HL_LAUNCHD",
        "bootstrap-host render produced no definition for this label",
        { path: file },
      );
    if (bytes.toString("utf8") !== expected)
      refuse(
        "HL_LAUNCHD",
        "Installed plist differs from bootstrap-host render of this layout",
        {
          path: file,
        },
      );
    compared = "bytes and fields";
  }
  d.groupName ??= await operatorGroupName(layout.operator, { sys });
  const plist = await plistJson(d, file);
  const expected = {
    Label: profile.label,
    UserName: layout.operator.username,
    GroupName: d.groupName,
    "ProgramArguments[0..2]": [layout.colima, "--profile", profile.name],
    WorkingDirectory: layout.operator.home,
    "EnvironmentVariables.HOME": layout.operator.home,
    "EnvironmentVariables.PATH": layout.launchdPath,
    "EnvironmentVariables.DOCKER_CONFIG": layout.dockerConfig,
    StandardOutPath: profile.log,
    StandardErrorPath: profile.log,
  };
  const actual = {
    Label: plist.Label,
    UserName: plist.UserName,
    GroupName: plist.GroupName,
    "ProgramArguments[0..2]": Array.isArray(plist.ProgramArguments)
      ? plist.ProgramArguments.slice(0, 3)
      : null,
    WorkingDirectory: plist.WorkingDirectory,
    "EnvironmentVariables.HOME": plist.EnvironmentVariables?.HOME,
    "EnvironmentVariables.PATH": plist.EnvironmentVariables?.PATH,
    "EnvironmentVariables.DOCKER_CONFIG":
      plist.EnvironmentVariables?.DOCKER_CONFIG,
    StandardOutPath: plist.StandardOutPath,
    StandardErrorPath: plist.StandardErrorPath,
  };
  const differing = Object.keys(expected).filter((field) =>
    firstDifference(expected[field], actual[field]),
  );
  if (differing.length)
    refuse(
      "HL_LAUNCHD",
      `Installed plist differs from the layout in ${differing.join(", ")}`,
      {
        path: file,
      },
    );
  const state = await sys.run(
    BIN.launchctl,
    ["print", `system/${profile.label}`],
    {
      env: TOOL_ENV,
      timeoutMs: 15_000,
    },
  );
  if (state.code !== 0 || !/^\s*state = running\s*$/m.test(state.stdout))
    refuse("HL_LAUNCHD", "LaunchDaemon is not running", { path: file });
  return { path: file, detail: `${compared} match; running` };
}

// Another plist that starts one of the three profiles under a different label
// would run a second colima for the same VM.
async function launchdDuplicates(d) {
  const { layout, sys } = d;
  const ours = new Set(
    PROFILE_KEYS.map((key) => `${layout.profiles[key].label}.plist`),
  );
  const found = [];
  for (const [directory, system] of [
    [LAUNCH_DAEMONS, true],
    [layout.launchAgents, false],
  ]) {
    let names;
    try {
      names = await sys.readdir(directory);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      refuse("HL_UNREADABLE", "Directory cannot be listed", {
        path: directory,
      });
    }
    for (const name of names) {
      if (!name.endsWith(".plist") || (system && ours.has(name))) continue;
      const file = `${directory}/${name}`;
      const stat = await lstatOrNull(d.ctx, file);
      if (!stat?.isFile() || stat.size > 1_000_000) continue;
      if (
        !(await sys.readFile(file)).toString("utf8").includes("agent-platform-")
      )
        continue;
      const args = (await plistJson(d, file)).ProgramArguments;
      if (!Array.isArray(args)) continue;
      const profile = PROFILES.find((name) =>
        args.some((arg) => arg === name || arg === `--profile=${name}`),
      );
      if (profile) found.push({ file, profile, system });
    }
  }
  const system = found.filter((entry) => entry.system);
  if (system.length)
    refuse(
      "HL_LAUNCHD",
      `Other LaunchDaemons start ${system.map((entry) => entry.profile).join(", ")}`,
      { path: system.map((entry) => entry.file).join(", ") },
    );
  if (found.length)
    return {
      warn: true,
      code: "HL_LAUNCHD",
      detail: `User LaunchAgents also mention ${found.map((entry) => entry.profile).join(", ")}; keep them disabled`,
      path: found.map((entry) => entry.file).join(", "),
    };
  return { detail: "no other definitions start the three profiles" };
}

async function bootReview(d) {
  const { layout, ctx } = d;
  const path = `${layout.bootReview}/review.json`;
  const file = await privateFile(ctx, path, {
    read: true,
    allowMissing: true,
    maxBytes: 2_000_000,
    code: "HL_REVIEW",
  });
  if (!file)
    return {
      warn: true,
      code: "HL_REVIEW",
      path,
      detail: "No bootstrap review; run prepare before the next apply-system",
    };
  let manifest;
  try {
    manifest = JSON.parse(file.bytes.toString("utf8"));
  } catch {
    return {
      warn: true,
      code: "HL_REVIEW",
      path,
      detail: "review.json is not valid JSON; run prepare again",
    };
  }
  const notes = [];
  if (!(manifest?.schemaVersion >= 2))
    notes.push(
      `review.json schemaVersion ${manifest?.schemaVersion}; run prepare again before the next apply-system`,
    );
  const stale = [];
  for (const key of PROFILE_KEYS) {
    const profile = layout.profiles[key];
    const { bytes } = await operatorFile(ctx, profile.colimaYaml, {
      read: true,
    });
    if (manifest?.profileConfigurations?.[profile.name] !== digest(bytes))
      stale.push(profile.name);
  }
  if (stale.length)
    notes.push(
      `colima.yaml changed since prepare for ${stale.join(", ")} (apply would stop with "Engine configuration changed; prepare again")`,
    );
  return notes.length
    ? { warn: true, code: "HL_REVIEW", path, detail: notes.join("; ") }
    : { path, detail: "schema and colima.yaml digests current" };
}

async function limaOverrideCheck(d) {
  const { layout, ctx, sys } = d;
  const { bytes } = await operatorFile(ctx, layout.limaOverride, {
    read: true,
  });
  let expected;
  try {
    expected = await sys.readFile(d.repositoryLimaOverride);
  } catch {
    return {
      warn: true,
      code: "HL_PROBE",
      path: layout.limaOverride,
      detail:
        "Repository copy deploy/host/lima-override.yaml not found next to this module; content not compared",
    };
  }
  if (!Buffer.from(bytes).equals(Buffer.from(expected)))
    refuse(
      "HL_FILE",
      "Lima override differs from deploy/host/lima-override.yaml",
      {
        path: layout.limaOverride,
      },
    );
  return {
    path: layout.limaOverride,
    detail: "matches deploy/host/lima-override.yaml",
  };
}

async function jenkinsLogin(d) {
  const url = `http://127.0.0.1:${JENKINS_PORTS.production}/login`;
  let response;
  try {
    response = await d.sys.fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    refuse("HL_PROBE", "Jenkins login page is unreachable", { path: url });
  }
  await response.body?.cancel?.();
  if (response.status !== 200)
    refuse("HL_PROBE", `Jenkins login page answered HTTP ${response.status}`, {
      path: url,
    });
  return { detail: "HTTP 200 without credentials" };
}

const requireCheck = (key) => (d) => REQUIRE_CHECKS[key](d.ctx, d.layout);
const pathDetail = (key, path) => async (d) => {
  const result = await requireCheck(key)(d);
  return {
    path: path(d.layout),
    detail: result?.realpath ? `-> ${result.realpath}` : undefined,
  };
};
const DOCTOR_CHECKS = [
  {
    id: "platform",
    stage: "host",
    run: async (d) => {
      assertPlatform(d.sys);
      return {
        detail: `${d.sys.platform}/${d.sys.arch}, Node ${d.sys.nodeVersion}`,
      };
    },
  },
  {
    id: "operator",
    stage: "host",
    after: ["platform"],
    run: async (d) => {
      d.operator = runningOperator(d.sys);
      d.ctx = context(d.sys, d.operator);
      return {
        detail: `${d.operator.username} (UID ${d.operator.uid}, home ${d.operator.home})`,
      };
    },
  },
  {
    id: "colimaEnv",
    stage: "host",
    after: ["operator"],
    run: async (d) => {
      assertColimaHome(d.sys, `${d.operator.home}/.colima`);
      return { detail: "COLIMA_HOME unset or equal to <home>/.colima" };
    },
  },
  {
    id: "home",
    stage: "host",
    after: ["operator"],
    run: async (d) => {
      await homeDirectory(d.ctx);
      return { path: d.operator.home };
    },
  },
  {
    id: "overrideFile",
    stage: "host",
    after: ["home"],
    run: async (d) => {
      const found = await loadOverrides(d.operator, { sys: d.sys, ctx: d.ctx });
      d.layout = resolveHostLayout({
        identity: d.operator,
        execPath: d.sys.execPath,
        overrides: found.values,
      });
      return {
        path: found.path,
        detail: found.present
          ? `present (${Object.keys(found.values).join(", ") || "no overrides"})`
          : "absent; built-in defaults",
      };
    },
  },
  {
    id: "privateDir",
    stage: "host",
    after: ["overrideFile"],
    run: pathDetail("privateDir", (l) => l.privateDir),
  },
  {
    id: "dockerConfig",
    stage: "host",
    after: ["privateDir"],
    run: async (d) => {
      const found = await requireCheck("dockerConfig")(d);
      const plugins = Object.entries(found.plugins).map(
        ([name, entry]) => `${name} -> ${entry.realpath}`,
      );
      const result = {
        path: d.layout.dockerConfig,
        detail: plugins.join("; "),
      };
      if (found.extraKeys.length)
        Object.assign(result, {
          warn: true,
          code: "HL_DOCKER_CONFIG",
          detail: `${result.detail}; config.json also sets ${found.extraKeys.join(", ")}`,
        });
      return result;
    },
  },
  {
    id: "dockerCli",
    stage: "host",
    after: ["overrideFile"],
    run: pathDetail("dockerCli", (l) => l.dockerCli),
  },
  {
    id: "dockerProbe",
    stage: "host",
    after: ["dockerCli", "dockerConfig"],
    run: dockerProbe,
  },
  {
    id: "node",
    stage: "host",
    after: ["overrideFile"],
    run: pathDetail("node", (l) => l.node),
  },
  {
    id: "colima",
    stage: "host",
    after: ["overrideFile"],
    run: pathDetail("colima", (l) => l.colima),
  },
  {
    id: "limactl",
    stage: "host",
    after: ["overrideFile"],
    run: pathDetail("limactl", (l) => l.limactl),
  },
  {
    id: "homebrewDocker",
    stage: "host",
    after: ["overrideFile"],
    run: pathDetail("homebrewDocker", (l) => l.homebrewDocker),
  },
  {
    id: "launchdPath",
    stage: "host",
    after: ["overrideFile"],
    run: pathDetail("launchdPath", (l) => l.launchdPath),
  },
  {
    id: "limaOverride",
    stage: "engines",
    after: ["overrideFile"],
    run: limaOverrideCheck,
  },
  {
    id: "colimaYaml",
    stage: "engines",
    after: ["overrideFile"],
    run: pathDetail("colimaYaml", (l) => l.colimaHome),
  },
  ...PROFILE_KEYS.map((key) => ({
    id: `socket:${key}`,
    stage: "engines",
    after: ["overrideFile"],
    run: pathDetail(`socket:${key}`, (l) => l.profiles[key].socketPath),
  })),
  ...PROFILE_KEYS.map((key) => ({
    id: `daemon:${key}`,
    stage: "engines",
    after: [`socket:${key}`, "dockerCli", "dockerConfig"],
    run: (d) => daemonProbe(d, key),
  })),
  ...PROFILE_KEYS.map((key) => ({
    id: `launchd:${key}`,
    stage: "launchd",
    after: ["colima", "launchdPath"],
    run: (d) => launchdService(d, key),
  })),
  {
    id: "launchdDuplicates",
    stage: "launchd",
    after: ["overrideFile"],
    run: launchdDuplicates,
  },
  {
    id: "bootReview",
    stage: "launchd",
    after: ["colimaYaml"],
    warnOnly: true,
    run: bootReview,
  },
  {
    id: "stackEnv",
    stage: "images",
    after: ["overrideFile"],
    run: pathDetail("stackEnv", (l) => l.stackEnv),
  },
  {
    id: "runtimeEnv",
    stage: "images",
    after: ["overrideFile"],
    run: pathDetail("runtimeEnv", (l) => l.runtimeEnv),
  },
  {
    id: "adminApi",
    stage: "full",
    after: ["overrideFile"],
    run: pathDetail("adminApi", (l) => l.adminApi),
  },
  {
    id: "jenkinsListener",
    stage: "full",
    after: ["operator"],
    run: async (d) => {
      const found = await assertJenkinsListener(
        JENKINS_PORTS.production,
        d.operator,
        { sys: d.sys },
      );
      return {
        detail: `127.0.0.1:${found.port} held by PID ${found.listeners.map((l) => l.pid).join(", ")} of the operator`,
      };
    },
  },
  {
    id: "jenkinsLogin",
    stage: "full",
    after: ["jenkinsListener"],
    run: jenkinsLogin,
  },
];
export const DOCTOR_CHECK_IDS = Object.freeze(
  DOCTOR_CHECKS.map((check) => check.id),
);

const defaultRepositoryLimaOverride = () =>
  fileURLToPath(new URL("../host/lima-override.yaml", import.meta.url));

// Never reads secrets: private files are opened only for fstat; review.json,
// config.json and colima.yaml are configuration, not credentials.
export async function doctor({
  stage = "full",
  sys = nodeSystem(),
  render,
  repositoryLimaOverride = defaultRepositoryLimaOverride(),
} = {}) {
  if (!STAGES.includes(stage))
    refuse("HL_USAGE", `Use --stage ${STAGES.join("|")}`);
  const limit = STAGES.indexOf(stage);
  const d = {
    sys,
    render,
    repositoryLimaOverride,
    operator: null,
    ctx: null,
    layout: null,
  };
  const status = new Map();
  const checks = [];
  for (const check of DOCTOR_CHECKS) {
    const entry = { id: check.id, stage: check.stage };
    if (STAGES.indexOf(check.stage) > limit) entry.status = "not-yet";
    else {
      const blockedBy = (check.after ?? []).filter(
        (id) => !["ok", "warn"].includes(status.get(id)),
      );
      if (blockedBy.length)
        Object.assign(entry, {
          status: "blocked",
          detail: `needs ${blockedBy.join(", ")}`,
        });
      else {
        try {
          const { warn, ...result } = (await check.run(d)) ?? {};
          Object.assign(entry, { status: warn ? "warn" : "ok" }, result);
        } catch (error) {
          const known = error instanceof HostLayoutError;
          Object.assign(entry, {
            status: check.warnOnly ? "warn" : "fail",
            code: known ? error.code : "HL_PROBE",
            ...(known && error.path ? { path: error.path } : {}),
            detail: known
              ? error.reason
              : `Unexpected failure: ${error?.message ?? error}`,
          });
        }
      }
    }
    for (const key of Object.keys(entry))
      if (entry[key] === undefined) delete entry[key];
    status.set(check.id, entry.status);
    checks.push(entry);
  }
  const counts = { ok: 0, warn: 0, fail: 0, blocked: 0, "not-yet": 0 };
  for (const entry of checks) counts[entry.status]++;
  return {
    state: counts.fail || counts.blocked ? "doctor-failed" : "doctor-passed",
    stage,
    operator: d.operator?.username ?? null,
    layoutSha256: d.layout ? layoutSha256(d.layout) : null,
    counts,
    checks,
  };
}

// ---------------------------------------------------------------------------
// CLI.

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
export function shellAssignments(layout) {
  const pairs = [
    ["HL_OPERATOR", layout.operator.username],
    ["HL_UID", layout.operator.uid],
    ["HL_GID", layout.operator.gid],
    ["HL_HOME", layout.operator.home],
    ["HL_NODE", layout.node],
    ["HL_PRIVATE_DIR", layout.privateDir],
    ["HL_DOCKER_CONFIG", layout.dockerConfig],
    ["HL_STACK_ENV", layout.stackEnv],
    ["HL_RUNTIME_ENV", layout.runtimeEnv],
    ["HL_ADMIN_API", layout.adminApi],
    ["HL_BOOT_REVIEW", layout.bootReview],
    ["HL_OVERRIDE_FILE", layout.overrideFile],
    ["HL_COLIMA_HOME", layout.colimaHome],
    ["HL_LIMA_OVERRIDE", layout.limaOverride],
    ["HL_DOCKER_CLI", layout.dockerCli],
    ["HL_HOMEBREW_PREFIX", layout.homebrewPrefix],
    ["HL_COLIMA", layout.colima],
    ["HL_LAUNCHD_PATH", layout.launchdPath],
    ["HL_LABEL_PREFIX", layout.launchdLabelPrefix],
    ...PROFILE_KEYS.map((key) => [
      `HL_${key.toUpperCase()}_SOCKET`,
      layout.profiles[key].socket,
    ]),
    ...PROFILE_KEYS.map((key) => [
      `HL_${key.toUpperCase()}_LABEL`,
      layout.profiles[key].label,
    ]),
  ];
  return pairs
    .map(([name, value]) => `${name}=${shellQuote(value ?? "")}\n`)
    .join("");
}

const USAGE =
  "Use print [--shell] | doctor [--stage host|engines|launchd|images|full]";

function stageArgument(args) {
  if (!args.length) return "full";
  if (args.length === 2 && args[0] === "--stage") return args[1];
  if (args.length === 1 && args[0].startsWith("--stage="))
    return args[0].slice("--stage=".length);
  refuse("HL_USAGE", USAGE);
}

async function bootstrapRenderer() {
  try {
    const module = await import(
      new URL("./bootstrap-host.mjs", import.meta.url).href
    );
    return typeof module.render === "function" ? module.render : undefined;
  } catch {
    return undefined;
  }
}

export async function main(
  argv = process.argv.slice(2),
  {
    sys = nodeSystem(),
    write = (text) => process.stdout.write(text),
    render,
  } = {},
) {
  const [command, ...args] = argv;
  if (command === "print") {
    if (args.length > 1 || (args.length === 1 && args[0] !== "--shell"))
      refuse("HL_USAGE", USAGE);
    const layout = await loadHostLayout({ requires: "print", sys });
    write(
      args.length
        ? shellAssignments(layout)
        : JSON.stringify(layoutRecord(layout), null, 2) + "\n",
    );
    return 0;
  }
  if (command === "doctor") {
    const stage = stageArgument(args);
    const report = await doctor({
      stage,
      sys,
      render: render ?? (await bootstrapRenderer()),
    });
    write(JSON.stringify(report, null, 2) + "\n");
    return report.state === "doctor-passed" ? 0 : 1;
  }
  refuse("HL_USAGE", USAGE);
}

const invoked = process.argv[1] && resolve(process.argv[1]);
if (
  invoked &&
  [
    invoked,
    invoked
      .replace(/^\/tmp(?=\/|$)/, "/private/tmp")
      .replace(/^\/var(?=\/|$)/, "/private/var"),
  ].some((path) => pathToFileURL(path).href === import.meta.url)
)
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(
        JSON.stringify({
          state: "host-layout-refused",
          code: error instanceof HostLayoutError ? error.code : "HL_INTERNAL",
          message:
            error instanceof HostLayoutError
              ? error.message
              : `Unexpected failure: ${error?.message}`,
        }),
      );
      process.exitCode = 1;
    },
  );
