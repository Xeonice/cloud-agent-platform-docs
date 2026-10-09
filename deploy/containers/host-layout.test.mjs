import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LAUNCHD_LABEL_PREFIX,
  DOCTOR_CHECK_IDS,
  ERROR_CODES,
  HostLayoutError,
  PROFILES,
  REQUIRES,
  REQUIRE_KEYS,
  STAGES,
  assertJenkinsListener,
  assertLayoutConsistent,
  assertOperatorIdentity,
  assertOperatorRecord,
  assertSameLayout,
  assertTrustedExecutable,
  childEnvironment,
  childPath,
  dockerHostArgs,
  doctor,
  expandRequires,
  layoutRecord,
  layoutSha256,
  loadHostLayout,
  loadOverrides,
  main,
  nodeSystem,
  operatorGroupName,
  parseAclListing,
  parseDsclAttributes,
  parseLsofListeners,
  parsePasswdRecord,
  resolveHostLayout,
  runningOperator,
  shellAssignments,
  sudoOperator,
  validateOverrides,
  verifyHostLayout,
} from "./host-layout.mjs";

const moduleFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "host-layout.mjs",
);
const digest = (value) => createHash("sha256").update(value).digest("hex");

// Injected operator; tests never use the real account.
const OP_UID = 5101;
const OPERATOR = Object.freeze({
  username: "operator",
  uid: OP_UID,
  gid: 20,
  homedir: "/Users/operator",
  shell: "/bin/zsh",
});
const HOME = OPERATOR.homedir;
const P = `${HOME}/.local/share/agent-platform-jenkins-tools`;
const COLIMA = `${HOME}/.colima`;
const NODE = "/opt/node-22/bin/node";
const XBIN = "/Applications/OrbStack.app/Contents/MacOS/xbin";
const DOCKER = `${HOME}/.orbstack/bin/docker`;
const LIMA = "# Lima override\n";
const REPOSITORY_LIMA = "/repo/deploy/host/lima-override.yaml";
const label = (name) => DEFAULT_LAUNCHD_LABEL_PREFIX + name;
const plistFile = (name) => `/Library/LaunchDaemons/${label(name)}.plist`;
const yaml = (name) => `# colima ${name}\n`;

const dir = (uid, mode = 0o755, gid = uid === 0 ? 0 : 20) => ({
  type: "dir",
  uid,
  gid,
  mode,
});
const file = (uid, mode, content = "", gid = uid === 0 ? 0 : 20) => ({
  type: "file",
  uid,
  gid,
  mode,
  nlink: 1,
  content,
});
const link = (target, uid = OP_UID, mode = 0o755) => ({
  type: "link",
  uid,
  gid: 20,
  mode,
  target,
});
const socket = (uid = OP_UID, mode = 0o600) => ({
  type: "socket",
  uid,
  gid: 20,
  mode,
});

function plistObject(name) {
  const log = `${P}/container-boot/logs/${name}.log`;
  return {
    Label: label(name),
    UserName: "operator",
    GroupName: "staff",
    ProgramArguments: [
      "/opt/homebrew/bin/colima",
      "--profile",
      name,
      "start",
      "--foreground",
    ],
    WorkingDirectory: HOME,
    EnvironmentVariables: {
      HOME,
      PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
      DOCKER_CONFIG: `${P}/container-docker-context`,
    },
    StandardOutPath: log,
    StandardErrorPath: log,
  };
}
const plistText = (name) =>
  `<plist>${JSON.stringify(plistObject(name))}</plist>\n`;
const render = () =>
  Object.fromEntries(PROFILES.map((name) => [label(name), plistText(name)]));

// A Mac as the operator tools expect it, matching the live layout on the
// Mac mini but with an injected account.
function machine() {
  const files = {
    "/": dir(0),
    "/Users": dir(0, 0o755, 80),
    [HOME]: dir(OP_UID, 0o750),
    [`${HOME}/.local`]: dir(OP_UID),
    [`${HOME}/.local/share`]: dir(OP_UID),
    [P]: dir(OP_UID, 0o700),
    [`${P}/admin-api.json`]: file(
      OP_UID,
      0o600,
      '{"username":"u","token":"never-read"}',
    ),
    [`${P}/container-stack.env`]: file(OP_UID, 0o600, "CI_IMAGE=sha256:1\n"),
    [`${P}/container-runtime.env`]: file(
      OP_UID,
      0o600,
      "DEPLOY_IMAGE=sha256:2\n",
    ),
    [`${P}/container-docker-context`]: dir(OP_UID, 0o700),
    [`${P}/container-docker-context/config.json`]: file(
      OP_UID,
      0o600,
      JSON.stringify({ cliPluginsExtraDirs: [XBIN] }),
    ),
    [`${P}/container-boot`]: dir(OP_UID, 0o700),
    [`${P}/container-boot/review.json`]: file(
      OP_UID,
      0o600,
      JSON.stringify({
        schemaVersion: 2,
        profileConfigurations: Object.fromEntries(
          PROFILES.map((name) => [name, digest(yaml(name))]),
        ),
      }),
    ),
    [COLIMA]: dir(OP_UID),
    [`${COLIMA}/_lima`]: dir(OP_UID),
    [`${COLIMA}/_lima/_config`]: dir(OP_UID),
    [`${COLIMA}/_lima/_config/override.yaml`]: file(OP_UID, 0o644, LIMA),
    [`${HOME}/.orbstack`]: dir(OP_UID, 0o700),
    [`${HOME}/.orbstack/bin`]: dir(OP_UID),
    // OrbStack creates its links with mode 0777; link bits are not used.
    [DOCKER]: link(`${XBIN}/docker`, OP_UID, 0o777),
    "/Applications": dir(0, 0o775, 80),
    "/Applications/OrbStack.app": dir(OP_UID, 0o755, 80),
    "/Applications/OrbStack.app/Contents": dir(OP_UID, 0o755, 80),
    "/Applications/OrbStack.app/Contents/MacOS": dir(OP_UID, 0o755, 80),
    [XBIN]: dir(OP_UID, 0o755, 80),
    [`${XBIN}/docker`]: link("docker-tools"),
    [`${XBIN}/docker-compose`]: link("docker-tools"),
    [`${XBIN}/docker-buildx`]: link("docker-tools"),
    [`${XBIN}/docker-tools`]: file(OP_UID, 0o755, "docker-tools", 80),
    "/opt": dir(0),
    "/opt/homebrew": dir(OP_UID, 0o755, 80),
    "/opt/homebrew/bin": dir(OP_UID, 0o775, 80),
    "/opt/homebrew/Cellar": dir(OP_UID, 0o775, 80),
    "/opt/node-22": dir(0),
    "/opt/node-22/bin": dir(0),
    [NODE]: file(0, 0o755, "node"),
    "/usr": dir(0),
    "/usr/bin": dir(0),
    "/usr/sbin": dir(0),
    "/usr/local": dir(0),
    "/usr/local/bin": dir(0, 0o700),
    "/bin": dir(0),
    "/sbin": dir(0),
    "/Library": dir(0),
    "/Library/LaunchDaemons": dir(0),
    [`${HOME}/Library`]: dir(OP_UID, 0o700),
    [`${HOME}/Library/LaunchAgents`]: dir(OP_UID),
    "/repo": dir(0),
    "/repo/deploy": dir(0),
    "/repo/deploy/host": dir(0),
    [REPOSITORY_LIMA]: file(0, 0o644, LIMA),
  };
  for (const [formula, version, binary] of [
    ["colima", "0.10.3", "colima"],
    ["lima", "2.2.1", "limactl"],
    ["docker", "29.8.2", "docker"],
  ]) {
    const cellar = `/opt/homebrew/Cellar/${formula}`;
    files[cellar] = dir(OP_UID, 0o755, 80);
    files[`${cellar}/${version}`] = dir(OP_UID, 0o755, 80);
    files[`${cellar}/${version}/bin`] = dir(OP_UID, 0o755, 80);
    files[`${cellar}/${version}/bin/${binary}`] = file(
      OP_UID,
      0o555,
      binary,
      80,
    );
    files[`/opt/homebrew/bin/${binary}`] = link(
      `../Cellar/${formula}/${version}/bin/${binary}`,
    );
  }
  const plists = {};
  const daemons = {};
  for (const name of PROFILES) {
    files[`${COLIMA}/${name}`] = dir(OP_UID);
    files[`${COLIMA}/${name}/colima.yaml`] = file(OP_UID, 0o644, yaml(name));
    files[`${COLIMA}/${name}/docker.sock`] = socket();
    files[plistFile(name)] = file(0, 0o644, plistText(name));
    plists[plistFile(name)] = plistObject(name);
    daemons[`unix://${COLIMA}/${name}/docker.sock`] = "colima-" + name;
  }
  return {
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "22.23.3",
    execPath: NODE,
    uid: OP_UID,
    euid: OP_UID,
    user: { ...OPERATOR },
    colimaHome: undefined,
    files,
    acl: { [HOME]: ["group:everyone deny delete"] },
    aclFailures: [],
    users: [
      { name: "root", uid: 0, gid: 0, home: "/var/root" },
      { name: "_mbsetupuser", uid: 248, gid: 248, home: "/var/setup" },
      { name: "operator", uid: OP_UID, gid: 20, home: HOME },
      { name: "nobody", uid: -2, gid: -2, home: "/var/empty" },
    ],
    groups: {
      admin: {
        gid: 80,
        members: ["root", "operator", "_mbsetupuser"],
        nested: [],
      },
      wheel: { gid: 0, members: ["root"], nested: [] },
    },
    checkmember: {
      admin: ["root", "operator", "_mbsetupuser"],
      wheel: ["root"],
    },
    groupName: "staff",
    listeners: { 8080: { code: 0, stdout: `p70835\nu${OP_UID}\nf11\n` } },
    running: PROFILES.map(label),
    plists,
    daemons,
    dockerCli: DOCKER,
    fetchStatus: 200,
  };
}

function remove(m, ...paths) {
  for (const key of Object.keys(m.files))
    if (paths.some((path) => key === path || key.startsWith(path + "/")))
      delete m.files[key];
}

function command(m, file, args) {
  const ok = (stdout) => ({ code: 0, signal: null, stdout, stderr: "" });
  const no = (code = 1, stderr = "") => ({
    code,
    signal: null,
    stdout: "",
    stderr,
  });
  switch (file) {
    case "/bin/ls": {
      const path = args[2];
      if (args[0] !== "-lde" || args[1] !== "--") return no(2, "usage");
      if (m.aclFailures.includes(path) || !m.files[path])
        return no(1, "ls failed");
      const entries = (m.acl[path] ?? []).map(
        (entry, index) => ` ${index}: ${entry}`,
      );
      return ok(
        [
          `-rw-r--r--  1 someone  staff  0 Oct  1 00:00 ${path}`,
          ...entries,
        ].join("\n") + "\n",
      );
    }
    case "/usr/bin/dscl": {
      if (args[1] === "-read") {
        const group = m.groups[args[2].replace("/Groups/", "")];
        if (!group) return no(56, "Data source not found");
        let out = `GroupMembership: ${group.members.join(" ")}\nPrimaryGroupID: ${group.gid}\n`;
        if (group.nested.length)
          out += `NestedGroups: ${group.nested.join(" ")}\n`;
        return ok(out);
      }
      const field = args[3];
      return ok(
        m.users
          .map(
            (user) =>
              `${user.name.padEnd(24)} ${field === "UniqueID" ? user.uid : user.gid}`,
          )
          .join("\n") + "\n",
      );
    }
    case "/usr/sbin/dseditgroup":
      return m.checkmember[args[4]]?.includes(args[3])
        ? ok(`yes ${args[3]} is a member\n`)
        : no(67);
    case "/usr/bin/id": {
      const user = m.users.find((entry) => entry.name === args[2]);
      if (!user) return no(1, "no such user");
      if (args[0] === "-P")
        return ok(
          `${user.name}:********:${user.uid}:${user.gid}::0:0:${user.name}:${user.home}:/bin/zsh\n`,
        );
      if (args[0] === "-gn") return ok(m.groupName + "\n");
      return ok(`${user.gid}\n`);
    }
    case "/usr/sbin/lsof": {
      const port = /^-iTCP@127\.0\.0\.1:(\d+)$/.exec(args[2])?.[1];
      return {
        signal: null,
        stderr: "",
        ...(m.listeners[port] ?? { code: 1, stdout: "" }),
      };
    }
    case "/bin/launchctl": {
      const name = args[1].replace("system/", "");
      return m.running.includes(name)
        ? ok(`system/${name} = {\n\tstate = running\n}\n`)
        : no(113);
    }
    case "/usr/bin/plutil":
      return m.plists[args[5]] ? ok(JSON.stringify(m.plists[args[5]])) : no(1);
    case m.dockerCli: {
      if (args[0] !== "--config") return no(125);
      const rest = args.slice(2).join(" ");
      if (rest === "--version")
        return ok("Docker version 29.4.0, build test\n");
      if (rest === "compose version --short") return ok("5.1.2\n");
      if (rest === "buildx version")
        return ok("github.com/docker/buildx v0.33.0 test\n");
      const info = /^--host (\S+) info --format \{\{\.Name\}\}$/.exec(rest);
      if (info && m.daemons[info[1]]) return ok(m.daemons[info[1]] + "\n");
      return no(1, "Cannot connect");
    }
    default:
      return no(127, "not found");
  }
}

// Kernel-like path resolution over m.files; every access is recorded.
function fakeSystem(m) {
  const calls = {
    run: [],
    open: [],
    read: [],
    readFile: [],
    fetch: [],
    colimaHome: 0,
  };
  const inodes = new Map();
  const fail = (code, path) =>
    Object.assign(new Error(`${code}: ${path}`), { code });
  function walk(path, followFinal) {
    let pending = path.split("/").filter(Boolean);
    let current = "/";
    let hops = 0;
    while (pending.length) {
      const part = pending.shift();
      if (part === ".") continue;
      if (part === "..") {
        current = dirname(current);
        continue;
      }
      const next = current === "/" ? `/${part}` : `${current}/${part}`;
      const node = m.files[next];
      if (!node) throw fail("ENOENT", next);
      if (node.type === "link" && (pending.length || followFinal)) {
        if (++hops > 40) throw fail("ELOOP", path);
        if (node.target.startsWith("/")) current = "/";
        pending = [...node.target.split("/").filter(Boolean), ...pending];
        continue;
      }
      if (pending.length && node.type !== "dir") throw fail("ENOTDIR", next);
      current = next;
    }
    return current;
  }
  function stat(path) {
    const node = m.files[path];
    if (!inodes.has(path)) inodes.set(path, inodes.size + 1);
    const type = {
      dir: 0o040000,
      file: 0o100000,
      link: 0o120000,
      socket: 0o140000,
    }[node.type];
    return {
      dev: 1,
      ino: inodes.get(path),
      uid: node.uid,
      gid: node.gid,
      mode: type | node.mode,
      nlink: node.nlink ?? 1,
      size:
        node.size ??
        Buffer.byteLength(
          node.type === "link" ? node.target : (node.content ?? ""),
        ),
      mtimeMs: 1,
      ctimeMs: 1,
      isFile: () => node.type === "file",
      isDirectory: () => node.type === "dir",
      isSymbolicLink: () => node.type === "link",
      isSocket: () => node.type === "socket",
    };
  }
  const sys = {
    platform: m.platform,
    arch: m.arch,
    nodeVersion: m.nodeVersion,
    execPath: m.execPath,
    getuid: () => m.uid,
    geteuid: () => m.euid,
    userInfo: () => {
      if (m.user instanceof Error) throw m.user;
      return m.user;
    },
    colimaHome: () => {
      calls.colimaHome++;
      return m.colimaHome;
    },
    lstat: async (path) => stat(walk(path, false)),
    readlink: async (path) => {
      const real = walk(path, false);
      if (m.files[real].type !== "link") throw fail("EINVAL", path);
      return m.files[real].target;
    },
    readdir: async (path) => {
      const real = walk(path, true);
      const prefix = real === "/" ? "/" : real + "/";
      return Object.keys(m.files)
        .filter(
          (key) =>
            key.startsWith(prefix) &&
            key !== real &&
            !key.slice(prefix.length).includes("/"),
        )
        .map((key) => key.slice(prefix.length));
    },
    readFile: async (path) => {
      calls.readFile.push(path);
      const node = m.files[walk(path, true)];
      if (node.type !== "file") throw fail("EISDIR", path);
      return Buffer.from(node.content ?? "");
    },
    open: async (path, flags) => {
      calls.open.push(path);
      // Simulates a path replaced between the lstat and the open.
      if (m.swapOnOpen?.[path]) m.files[path] = m.swapOnOpen[path];
      const real = walk(path, !(flags & constants.O_NOFOLLOW));
      const node = m.files[real];
      if (node.type === "link") throw fail("ELOOP", path);
      return {
        stat: async () => stat(real),
        readFile: async () => {
          calls.read.push(path);
          return Buffer.from(node.content ?? "");
        },
        close: async () => {},
      };
    },
    run: async (file, args, options = {}) => {
      calls.run.push({ file, args, env: options.env });
      return command(m, file, args);
    },
    fetch: async (url) => {
      calls.fetch.push(url);
      return { status: m.fetchStatus, body: { cancel: async () => {} } };
    },
  };
  return { sys, calls };
}

const layoutOf = (m, overrides = {}) =>
  resolveHostLayout({ identity: m.user, execPath: m.execPath, overrides });

async function refused(action, code, details = {}) {
  await assert.rejects(action, (error) => {
    assert.ok(
      error instanceof HostLayoutError,
      `expected HostLayoutError, got ${error?.stack ?? error}`,
    );
    assert.equal(error.code, code, error.message);
    assert.ok(
      Object.hasOwn(ERROR_CODES, error.code),
      `undocumented code ${error.code}`,
    );
    for (const [name, value] of Object.entries(details))
      assert.equal(error[name], value, error.message);
    return true;
  });
}
const refusedNow = (action, code) =>
  refused(async () => {
    action();
  }, code);

test("every host path derives from the passwd identity, the Node binary and the fixed relative layout", () => {
  const layout = resolveHostLayout({ identity: OPERATOR, execPath: NODE });
  const profile = (key) => {
    const name = "agent-platform-" + key;
    return {
      key,
      name,
      directory: `${COLIMA}/${name}`,
      colimaYaml: `${COLIMA}/${name}/colima.yaml`,
      socketPath: `${COLIMA}/${name}/docker.sock`,
      socket: `unix://${COLIMA}/${name}/docker.sock`,
      daemonName: `colima-${name}`,
      label: `com.douglasdong.agent-platform.container-engine.${name}`,
      log: `${P}/container-boot/logs/${name}.log`,
    };
  };
  assert.deepEqual(layoutRecord(layout), {
    schemaVersion: 1,
    operator: {
      username: "operator",
      uid: 5101,
      gid: 20,
      home: "/Users/operator",
    },
    node: NODE,
    privateDir: "/Users/operator/.local/share/agent-platform-jenkins-tools",
    dockerConfig: `${P}/container-docker-context`,
    stackEnv: `${P}/container-stack.env`,
    runtimeEnv: `${P}/container-runtime.env`,
    adminApi: `${P}/admin-api.json`,
    bootReview: `${P}/container-boot`,
    bootLogs: `${P}/container-boot/logs`,
    overrideFile: `${P}/host-layout.json`,
    colimaHome: "/Users/operator/.colima",
    limaOverride: "/Users/operator/.colima/_lima/_config/override.yaml",
    launchAgents: "/Users/operator/Library/LaunchAgents",
    launchDaemons: "/Library/LaunchDaemons",
    userDomain: "gui/5101",
    dockerCli: "/Users/operator/.orbstack/bin/docker",
    homebrewPrefix: "/opt/homebrew",
    colima: "/opt/homebrew/bin/colima",
    limactl: "/opt/homebrew/bin/limactl",
    homebrewDocker: "/opt/homebrew/bin/docker",
    launchdPath: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    launchdLabelPrefix: "com.douglasdong.agent-platform.container-engine.",
    profiles: {
      jenkins: profile("jenkins"),
      build: profile("build"),
      runtime: profile("runtime"),
    },
    overrides: {},
    sources: {
      dockerCli: "default",
      homebrewPrefix: "default",
      launchdLabelPrefix: "default",
    },
  });
  assert.deepEqual(PROFILES, [
    "agent-platform-jenkins",
    "agent-platform-build",
    "agent-platform-runtime",
  ]);
  assert.throws(() => {
    layout.privateDir = "/tmp/elsewhere";
  }, TypeError);
  assert.throws(() => {
    layout.profiles.build.socket = "unix:///tmp/docker.sock";
  }, TypeError);
  assert.throws(() => {
    layout.operator.uid = 0;
  }, TypeError);
});

test("only dockerCli, homebrewPrefix and launchdLabelPrefix can be overridden, each with its source", async () => {
  const base = resolveHostLayout({ identity: OPERATOR, execPath: NODE });
  const all = resolveHostLayout({
    identity: OPERATOR,
    execPath: NODE,
    overrides: {
      dockerCli: "/usr/local/bin/docker",
      homebrewPrefix: "/usr/local",
      launchdLabelPrefix: "org.example.engines.",
    },
  });
  assert.equal(all.dockerCli, "/usr/local/bin/docker");
  assert.equal(all.colima, "/usr/local/bin/colima");
  assert.equal(all.limactl, "/usr/local/bin/limactl");
  assert.equal(all.homebrewDocker, "/usr/local/bin/docker");
  assert.equal(all.launchdPath, "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(
    all.profiles.runtime.label,
    "org.example.engines.agent-platform-runtime",
  );
  assert.deepEqual(all.sources, {
    dockerCli: "host-layout.json",
    homebrewPrefix: "host-layout.json",
    launchdLabelPrefix: "host-layout.json",
  });
  for (const field of [
    "operator",
    "privateDir",
    "dockerConfig",
    "adminApi",
    "colimaHome",
    "bootReview",
  ])
    assert.deepEqual(all[field], base[field], field);
  for (const key of ["jenkins", "build", "runtime"])
    assert.equal(all.profiles[key].socket, base.profiles[key].socket);

  const partial = resolveHostLayout({
    identity: OPERATOR,
    execPath: NODE,
    overrides: { homebrewPrefix: "/usr/local" },
  });
  assert.deepEqual(partial.sources, {
    dockerCli: "default",
    homebrewPrefix: "host-layout.json",
    launchdLabelPrefix: "default",
  });
  assert.equal(partial.dockerCli, base.dockerCli);

  const skipped = resolveHostLayout({
    identity: OPERATOR,
    execPath: NODE,
    overrides: null,
  });
  for (const field of [
    "dockerCli",
    "homebrewPrefix",
    "colima",
    "limactl",
    "launchdPath",
    "launchdLabelPrefix",
    "overrides",
  ])
    assert.equal(skipped[field], null, field);
  assert.equal(skipped.profiles.build.label, null);
  assert.equal(skipped.sources.dockerCli, "not-loaded");
  assert.equal(skipped.adminApi, base.adminApi);

  await refusedNow(
    () =>
      resolveHostLayout({
        identity: OPERATOR,
        execPath: NODE,
        overrides: { privateDir: "/tmp/x" },
      }),
    "HL_OVERRIDE_SCHEMA",
  );
  await refusedNow(
    () =>
      resolveHostLayout({
        identity: OPERATOR,
        execPath: NODE,
        overrides: { dockerCli: "docker" },
      }),
    "HL_OVERRIDE_VALUE",
  );
  await refusedNow(
    () => resolveHostLayout({ identity: OPERATOR, execPath: "node" }),
    "HL_NODE",
  );
});

test("child environment, Docker arguments and layout records follow the derivation", async () => {
  const layout = resolveHostLayout({ identity: OPERATOR, execPath: NODE });
  assert.deepEqual(childPath(layout), [
    "/opt/node-22/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]);
  const environment = { ...childEnvironment(layout), CI: "1" };
  assert.deepEqual(Object.keys(environment), [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "DOCKER_CONFIG",
    "CI",
  ]);
  assert.deepEqual(environment, {
    PATH: "/opt/node-22/bin:/usr/local/bin:/usr/bin:/bin",
    HOME: HOME,
    USER: "operator",
    LOGNAME: "operator",
    LANG: "en_US.UTF-8",
    DOCKER_CONFIG: `${P}/container-docker-context`,
    CI: "1",
  });
  assert.deepEqual(dockerHostArgs(layout, "build"), [
    "--config",
    `${P}/container-docker-context`,
    "--host",
    `unix://${COLIMA}/agent-platform-build/docker.sock`,
  ]);
  await refusedNow(() => dockerHostArgs(layout, "default"), "HL_USAGE");

  const record = JSON.parse(JSON.stringify(layoutRecord(layout)));
  assertSameLayout(record, layout);
  assertLayoutConsistent(record);
  assert.equal(
    layoutSha256(layout),
    layoutSha256(resolveHostLayout({ identity: OPERATOR, execPath: NODE })),
  );
  await refused(
    async () =>
      assertSameLayout(
        record,
        resolveHostLayout({
          identity: OPERATOR,
          execPath: "/opt/node-22b/bin/node",
        }),
      ),
    "HL_LAYOUT_CHANGED",
    { key: "node" },
  );
  await refused(
    async () =>
      assertSameLayout(
        record,
        resolveHostLayout({
          identity: OPERATOR,
          execPath: NODE,
          overrides: { dockerCli: "/usr/local/bin/docker" },
        }),
      ),
    "HL_LAYOUT_CHANGED",
    { key: "dockerCli" },
  );
  await refused(
    async () =>
      assertSameLayout(
        record,
        resolveHostLayout({
          identity: { ...OPERATOR, uid: 5102 },
          execPath: NODE,
        }),
      ),
    "HL_LAYOUT_CHANGED",
    { key: "operator.uid" },
  );
  record.profiles.build.socket = "unix:///tmp/docker.sock";
  await refused(
    async () => assertLayoutConsistent(record),
    "HL_LAYOUT_CHANGED",
    { key: "profiles.build.socket" },
  );

  const shell = shellAssignments(layout);
  for (const line of shell.trimEnd().split("\n"))
    assert.match(line, /^HL_[A-Z_]+='[^']*'$/);
  assert.ok(shell.includes(`HL_PRIVATE_DIR='${P}'\n`));
  assert.ok(
    shell.includes(
      `HL_BUILD_SOCKET='unix://${COLIMA}/agent-platform-build/docker.sock'\n`,
    ),
  );
  assert.ok(
    shellAssignments({ ...layoutRecord(layout), privateDir: "/a'b" }).includes(
      "HL_PRIVATE_DIR='/a'\\''b'\n",
    ),
  );
});

test("the operator is the passwd account of the process and follows the operator policy", async () => {
  const { sys } = fakeSystem(machine());
  assert.deepEqual(
    { ...assertOperatorIdentity(sys) },
    { username: "operator", uid: 5101, gid: 20, home: HOME },
  );
  const cases = [
    [{ platform: "linux" }, "HL_PLATFORM"],
    [{ arch: "x64" }, "HL_PLATFORM"],
    [{ nodeVersion: "20.18.0" }, "HL_NODE"],
    [{ nodeVersion: "24.1.0" }, "HL_NODE"],
    [
      {
        uid: 0,
        euid: 0,
        user: { username: "root", uid: 0, gid: 0, homedir: "/var/root" },
      },
      "HL_IDENTITY_ROOT",
    ],
    [{ euid: 0 }, "HL_IDENTITY_EUID"],
    [
      {
        uid: 401,
        euid: 401,
        user: {
          username: "_agentplatformci",
          uid: 401,
          gid: 401,
          homedir: "/Users/Shared/x",
        },
      },
      "HL_IDENTITY_SERVICE",
    ],
    [
      { uid: 500, euid: 500, user: { ...OPERATOR, uid: 500 } },
      "HL_IDENTITY_SERVICE",
    ],
    [
      {
        uid: 4294967294,
        euid: 4294967294,
        user: {
          username: "nobody",
          uid: 4294967294,
          gid: 4294967294,
          homedir: "/var/empty",
        },
      },
      "HL_IDENTITY_SERVICE",
    ],
    [{ user: { ...OPERATOR, username: "_operator" } }, "HL_IDENTITY_NAME"],
    [{ user: { ...OPERATOR, username: "Operator" } }, "HL_IDENTITY_NAME"],
    [{ user: { ...OPERATOR, username: "op erator" } }, "HL_IDENTITY_NAME"],
    [
      { user: { ...OPERATOR, homedir: "/Users/operator/../other" } },
      "HL_IDENTITY_HOME",
    ],
    [{ user: { ...OPERATOR, homedir: "Users/operator" } }, "HL_IDENTITY_HOME"],
    [
      { user: { ...OPERATOR, homedir: "/Users/oper ator" } },
      "HL_IDENTITY_HOME",
    ],
    [
      { user: { ...OPERATOR, homedir: "/Users//operator" } },
      "HL_IDENTITY_HOME",
    ],
    [{ user: { ...OPERATOR, homedir: "/" } }, "HL_IDENTITY_HOME"],
    [{ user: { ...OPERATOR, uid: 5102 } }, "HL_IDENTITY_PASSWD"],
    [
      { user: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) },
      "HL_IDENTITY_PASSWD",
    ],
  ];
  for (const [change, code] of cases) {
    const m = Object.assign(machine(), change);
    await refusedNow(() => assertOperatorIdentity(fakeSystem(m).sys), code);
  }
  const boundary = Object.assign(machine(), {
    uid: 501,
    euid: 501,
    user: { ...OPERATOR, uid: 501 },
  });
  assert.equal(assertOperatorIdentity(fakeSystem(boundary).sys).uid, 501);
  // The stop-loss identity does not depend on platform or Node.
  const linux = Object.assign(machine(), {
    platform: "linux",
    nodeVersion: "20.0.0",
  });
  assert.equal(runningOperator(fakeSystem(linux).sys).username, "operator");
  await refusedNow(
    () => assertOperatorRecord({ ...OPERATOR, uid: "5101" }),
    "HL_IDENTITY_PASSWD",
  );
});

test("a sudo invoker is anchored to passwd before frozen values are trusted", async () => {
  assert.deepEqual(
    parsePasswdRecord(
      "douglasdong:********:501:20::0:0:douglasdong:/Users/douglasdong:/opt/homebrew/bin/zsh\n",
    ),
    {
      username: "douglasdong",
      uid: 501,
      gid: 20,
      home: "/Users/douglasdong",
      shell: "/opt/homebrew/bin/zsh",
    },
  );
  await refusedNow(
    () =>
      parsePasswdRecord(
        "a:*:501:20::0:0:a:/Users/a:/bin/zsh\nb:*:502:20::0:0:b:/Users/b:/bin/zsh\n",
      ),
    "HL_IDENTITY_PASSWD",
  );
  await refusedNow(
    () => parsePasswdRecord("a:*:501:20:/Users/a:/bin/zsh\n"),
    "HL_IDENTITY_PASSWD",
  );
  await refusedNow(
    () => parsePasswdRecord("a:*:x:20::0:0:a:/Users/a:/bin/zsh\n"),
    "HL_IDENTITY_PASSWD",
  );

  const m = machine();
  m.users.push({ name: "svc", uid: 400, gid: 400, home: "/var/svc" });
  const { sys, calls } = fakeSystem(m);
  assert.deepEqual(
    {
      ...(await sudoOperator(
        { sudoUid: "5101", sudoUser: "operator" },
        { sys },
      )),
    },
    {
      username: "operator",
      uid: 5101,
      gid: 20,
      home: HOME,
    },
  );
  assert.deepEqual(calls.run.at(-1).args, ["-P", "--", "operator"]);
  for (const sudoUid of ["0", "0501", "5101 ", "-5101", "abc", "", undefined])
    await refused(
      () => sudoOperator({ sudoUid, sudoUser: "operator" }, { sys }),
      "HL_SUDO",
    );
  for (const sudoUser of ["_operator", "operator;id", "", undefined])
    await refused(
      () => sudoOperator({ sudoUid: "5101", sudoUser }, { sys }),
      "HL_SUDO",
    );
  await refused(
    () => sudoOperator({ sudoUid: "5102", sudoUser: "operator" }, { sys }),
    "HL_SUDO",
  );
  await refused(
    () => sudoOperator({ sudoUid: "5101", sudoUser: "root" }, { sys }),
    "HL_SUDO",
  );
  await refused(
    () => sudoOperator({ sudoUid: "400", sudoUser: "svc" }, { sys }),
    "HL_IDENTITY_SERVICE",
  );
  await refused(
    () => sudoOperator({ sudoUid: "5101", sudoUser: "ghost" }, { sys }),
    "HL_IDENTITY_PASSWD",
  );

  assert.equal(
    await operatorGroupName(assertOperatorRecord(OPERATOR), { sys }),
    "staff",
  );
  await refused(
    () =>
      operatorGroupName(
        { ...assertOperatorRecord(OPERATOR), gid: 80 },
        { sys },
      ),
    "HL_IDENTITY_PASSWD",
  );
});

test("host-layout.json is read only from the operator's private, single-link 0600 file", async () => {
  const operator = assertOperatorRecord(OPERATOR);
  const overrideFile = `${P}/host-layout.json`;
  const absent = await loadOverrides(operator, fakeSystem(machine()));
  assert.deepEqual(
    { ...absent, values: { ...absent.values } },
    { path: overrideFile, present: false, sha256: null, values: {} },
  );
  const missingDirectory = machine();
  remove(missingDirectory, P);
  assert.equal(
    (await loadOverrides(operator, fakeSystem(missingDirectory))).present,
    false,
  );

  const content = JSON.stringify({
    schemaVersion: 1,
    dockerCli: "/usr/local/bin/docker",
    launchdLabelPrefix: "org.example.engines.",
  });
  const valid = machine();
  valid.files[overrideFile] = file(OP_UID, 0o600, content);
  // A symlinked value is accepted and kept verbatim: never resolved.
  valid.files["/usr/local/bin/docker"] = link("/opt/homebrew/bin/docker", 0);
  const found = await loadOverrides(operator, fakeSystem(valid));
  assert.equal(found.present, true);
  assert.equal(found.sha256, digest(content));
  assert.deepEqual(
    { ...found.values },
    {
      dockerCli: "/usr/local/bin/docker",
      launchdLabelPrefix: "org.example.engines.",
    },
  );
  const layout = await loadHostLayout({
    requires: "print",
    sys: fakeSystem(valid).sys,
  });
  assert.equal(layout.dockerCli, "/usr/local/bin/docker");
  assert.deepEqual(
    { ...layout.sources },
    {
      dockerCli: "host-layout.json",
      homebrewPrefix: "default",
      launchdLabelPrefix: "host-layout.json",
    },
  );
  assert.equal(
    (await verifyHostLayout(layout, ["dockerCli"], fakeSystem(valid))).results
      .dockerCli.realpath,
    "/opt/homebrew/Cellar/docker/29.8.2/bin/docker",
  );

  const cases = [
    [
      "mode 0644",
      (m) => (m.files[overrideFile].mode = 0o644),
      "HL_OVERRIDE_FILE",
    ],
    [
      "foreign owner",
      (m) => (m.files[overrideFile].uid = 5102),
      "HL_OVERRIDE_FILE",
    ],
    [
      "second hard link",
      (m) => (m.files[overrideFile].nlink = 2),
      "HL_OVERRIDE_FILE",
    ],
    [
      "symlinked file",
      (m) => {
        m.files[`${P}/real.json`] = m.files[overrideFile];
        m.files[overrideFile] = link(`${P}/real.json`);
      },
      "HL_OVERRIDE_FILE",
    ],
    [
      "directory",
      (m) => (m.files[overrideFile] = dir(OP_UID, 0o700)),
      "HL_OVERRIDE_FILE",
    ],
    [
      "symlinked private directory",
      (m) => {
        remove(m, P);
        m.files["/Users/elsewhere"] = dir(OP_UID, 0o700);
        m.files["/Users/elsewhere/host-layout.json"] = file(
          OP_UID,
          0o600,
          content,
        );
        m.files[P] = link("/Users/elsewhere");
      },
      "HL_OWNER_CHAIN",
    ],
    [
      "group-writable ~/.local",
      (m) => (m.files[`${HOME}/.local`].mode = 0o775),
      "HL_OWNER_CHAIN",
    ],
    [
      "allow ACL",
      (m) => (m.acl[overrideFile] = ["user:nobody allow read"]),
      "HL_ACL",
    ],
    [
      "oversized",
      (m) => (m.files[overrideFile].size = 70_000),
      "HL_OVERRIDE_FILE",
    ],
    [
      "not JSON",
      (m) => (m.files[overrideFile].content = "{"),
      "HL_OVERRIDE_SCHEMA",
    ],
    [
      "array",
      (m) => (m.files[overrideFile].content = "[]"),
      "HL_OVERRIDE_SCHEMA",
    ],
    [
      "schema 2",
      (m) => (m.files[overrideFile].content = '{"schemaVersion":2}'),
      "HL_OVERRIDE_SCHEMA",
    ],
    [
      "fixed key",
      (m) =>
        (m.files[overrideFile].content =
          '{"schemaVersion":1,"privateDir":"/tmp/x"}'),
      "HL_OVERRIDE_SCHEMA",
    ],
    [
      "prototype key",
      (m) =>
        (m.files[overrideFile].content =
          '{"schemaVersion":1,"__proto__":{"dockerCli":"/x"}}'),
      "HL_OVERRIDE_SCHEMA",
    ],
  ];
  for (const [value, code] of [
    ["bin/docker", "HL_OVERRIDE_VALUE"],
    ["/usr/local/../bin/docker", "HL_OVERRIDE_VALUE"],
    ["/usr/./bin/docker", "HL_OVERRIDE_VALUE"],
    ["/usr//bin/docker", "HL_OVERRIDE_VALUE"],
    ["/usr/bin/docker/", "HL_OVERRIDE_VALUE"],
    ["/usr/bin/doc ker", "HL_OVERRIDE_VALUE"],
    ["/usr/bin/docker\n", "HL_OVERRIDE_VALUE"],
    [42, "HL_OVERRIDE_VALUE"],
  ])
    cases.push([
      `dockerCli ${JSON.stringify(value)}`,
      (m) =>
        (m.files[overrideFile].content = JSON.stringify({
          schemaVersion: 1,
          dockerCli: value,
        })),
      code,
    ]);
  for (const value of [
    "com.example",
    "Com.Example.",
    "com/example.",
    "com..example.",
    ".com.example.",
    "com.",
    "com.example..",
  ])
    cases.push([
      `label ${value}`,
      (m) =>
        (m.files[overrideFile].content = JSON.stringify({
          schemaVersion: 1,
          launchdLabelPrefix: value,
        })),
      "HL_OVERRIDE_VALUE",
    ]);
  for (const [name, change, code] of cases) {
    const m = machine();
    m.files[overrideFile] = file(OP_UID, 0o600, content);
    change(m);
    await assert.rejects(loadOverrides(operator, fakeSystem(m)), (error) => {
      assert.equal(error.code, code, `${name}: ${error.message}`);
      return true;
    });
  }
  const keyed = machine();
  keyed.files[overrideFile] = file(
    OP_UID,
    0o600,
    '{"schemaVersion":1,"homebrewPrefix":"opt"}',
  );
  await refused(
    () => loadOverrides(operator, fakeSystem(keyed)),
    "HL_OVERRIDE_VALUE",
    { path: overrideFile, key: "homebrewPrefix" },
  );
  await refusedNow(
    () => validateOverrides({ schemaVersion: 1, colimaHome: "/x" }),
    "HL_OVERRIDE_SCHEMA",
  );
});

test("the owner chain and ACLs guard every directory down to private files and sockets", async () => {
  const m = machine();
  const { sys, calls } = fakeSystem(m);
  const layout = await loadHostLayout({ requires: "upgrade-apply", sys });
  assert.equal(layout.operator.username, "operator");
  // Secrets are opened for fstat only, never read.
  for (const secret of [layout.adminApi, layout.stackEnv, layout.runtimeEnv])
    assert.ok(!calls.read.includes(secret), `${secret} was read`);
  // Every child command gets a fixed environment, never the caller's.
  for (const call of calls.run)
    assert.deepEqual(call.env, {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C",
      LC_ALL: "C",
    });

  const cases = [
    [
      "group-writable home",
      "privateDir",
      (x) => (x.files[HOME].mode = 0o770),
      "HL_OWNER_CHAIN",
      HOME,
    ],
    [
      "foreign home",
      "privateDir",
      (x) => (x.files[HOME].uid = 5102),
      "HL_OWNER_CHAIN",
      HOME,
    ],
    [
      "/Users not root's",
      "privateDir",
      (x) => (x.files["/Users"].uid = OP_UID),
      "HL_OWNER_CHAIN",
      "/Users",
    ],
    [
      "/Users world-writable",
      "privateDir",
      (x) => (x.files["/Users"].mode = 0o777),
      "HL_OWNER_CHAIN",
      "/Users",
    ],
    [
      "symlinked ~/.local",
      "privateDir",
      (x) => {
        remove(x, `${HOME}/.local`);
        x.files[`${HOME}/.elsewhere`] = dir(OP_UID);
        x.files[`${HOME}/.local`] = link(`${HOME}/.elsewhere`);
      },
      "HL_OWNER_CHAIN",
      `${HOME}/.local`,
    ],
    [
      "private directory 0750",
      "privateDir",
      (x) => (x.files[P].mode = 0o750),
      "HL_PRIVATE_DIR",
      P,
    ],
    [
      "foreign private directory",
      "privateDir",
      (x) => (x.files[P].uid = 5102),
      "HL_PRIVATE_DIR",
      P,
    ],
    [
      "allow ACL on ~/.colima",
      "socket:build",
      (x) => (x.acl[COLIMA] = ["user:intruder allow add_file,delete_child"]),
      "HL_ACL",
      COLIMA,
    ],
    [
      "inherited allow ACL",
      "privateDir",
      (x) => (x.acl[P] = ["group:staff inherited allow read"]),
      "HL_ACL",
      P,
    ],
    [
      "allow after deny",
      "privateDir",
      (x) =>
        (x.acl[HOME] = [
          "group:everyone deny delete",
          "user:intruder allow list",
        ]),
      "HL_ACL",
      HOME,
    ],
    ["unparseable ACL", "privateDir", (x) => (x.acl[P] = ["???"]), "HL_ACL", P],
    ["ACL unreadable", "privateDir", (x) => x.aclFailures.push(P), "HL_ACL", P],
    [
      "missing private directory",
      "privateDir",
      (x) => remove(x, P),
      "HL_MISSING",
      P,
    ],
    [
      "socket is a file",
      "socket:build",
      (x) =>
        (x.files[`${COLIMA}/agent-platform-build/docker.sock`] = file(
          OP_UID,
          0o600,
        )),
      "HL_SOCKET",
      `${COLIMA}/agent-platform-build/docker.sock`,
    ],
    [
      "socket 0660",
      "socket:runtime",
      (x) =>
        (x.files[`${COLIMA}/agent-platform-runtime/docker.sock`].mode = 0o660),
      "HL_SOCKET",
      `${COLIMA}/agent-platform-runtime/docker.sock`,
    ],
    [
      "foreign socket",
      "socket:jenkins",
      (x) =>
        (x.files[`${COLIMA}/agent-platform-jenkins/docker.sock`].uid = 5102),
      "HL_SOCKET",
      `${COLIMA}/agent-platform-jenkins/docker.sock`,
    ],
    [
      "symlinked socket",
      "socket:build",
      (x) =>
        (x.files[`${COLIMA}/agent-platform-build/docker.sock`] =
          link("/tmp/docker.sock")),
      "HL_SOCKET",
      `${COLIMA}/agent-platform-build/docker.sock`,
    ],
    [
      "socket absent",
      "socket:build",
      (x) => delete x.files[`${COLIMA}/agent-platform-build/docker.sock`],
      "HL_MISSING",
      `${COLIMA}/agent-platform-build/docker.sock`,
    ],
    [
      "group-writable profile directory",
      "socket:build",
      (x) => (x.files[`${COLIMA}/agent-platform-build`].mode = 0o775),
      "HL_OWNER_CHAIN",
      `${COLIMA}/agent-platform-build`,
    ],
    [
      "admin-api.json 0640",
      "adminApi",
      (x) => (x.files[`${P}/admin-api.json`].mode = 0o640),
      "HL_PRIVATE_FILE",
      `${P}/admin-api.json`,
    ],
    [
      "admin-api.json hard link",
      "adminApi",
      (x) => (x.files[`${P}/admin-api.json`].nlink = 2),
      "HL_PRIVATE_FILE",
      `${P}/admin-api.json`,
    ],
    [
      "admin-api.json symlink",
      "adminApi",
      (x) => {
        x.files[`${P}/other.json`] = x.files[`${P}/admin-api.json`];
        x.files[`${P}/admin-api.json`] = link(`${P}/other.json`);
      },
      "HL_PRIVATE_FILE",
      `${P}/admin-api.json`,
    ],
    [
      "foreign admin-api.json",
      "adminApi",
      (x) => (x.files[`${P}/admin-api.json`].uid = 5102),
      "HL_PRIVATE_FILE",
      `${P}/admin-api.json`,
    ],
    [
      "admin-api.json absent",
      "adminApi",
      (x) => delete x.files[`${P}/admin-api.json`],
      "HL_MISSING",
      `${P}/admin-api.json`,
    ],
    [
      "env file is a directory",
      "stackEnv",
      (x) => (x.files[`${P}/container-stack.env`] = dir(OP_UID, 0o700)),
      "HL_PRIVATE_FILE",
      `${P}/container-stack.env`,
    ],
    [
      "colima.yaml group-writable",
      "colimaYaml",
      (x) =>
        (x.files[`${COLIMA}/agent-platform-jenkins/colima.yaml`].mode = 0o664),
      "HL_FILE",
      `${COLIMA}/agent-platform-jenkins/colima.yaml`,
    ],
  ];
  for (const [name, key, change, code, path] of cases) {
    const x = machine();
    change(x);
    await assert.rejects(
      verifyHostLayout(layoutOf(x), [key], fakeSystem(x)),
      (error) => {
        assert.equal(error.code, code, `${name}: ${error.message}`);
        assert.equal(error.path, path, `${name}: ${error.message}`);
        assert.equal(error.key, key, name);
        return true;
      },
    );
  }
  // Two layers against a symlinked secret: lstat first, then O_NOFOLLOW for a
  // link swapped in after the lstat.
  const linked = machine();
  linked.files[`${P}/other.json`] = linked.files[`${P}/admin-api.json`];
  linked.files[`${P}/admin-api.json`] = link(`${P}/other.json`);
  await assert.rejects(
    verifyHostLayout(layoutOf(linked), ["adminApi"], fakeSystem(linked)),
    /regular file, not a symlink/,
  );
  const raced = machine();
  raced.files[`${P}/other.json`] = file(OP_UID, 0o600, "{}");
  raced.swapOnOpen = { [`${P}/admin-api.json`]: link(`${P}/other.json`) };
  await assert.rejects(
    verifyHostLayout(layoutOf(raced), ["adminApi"], fakeSystem(raced)),
    (error) =>
      error.code === "HL_PRIVATE_FILE" &&
      /without following links \(ELOOP\)/.test(error.message),
  );
  const sticky = machine();
  sticky.files["/Users"].mode = 0o1777;
  await verifyHostLayout(layoutOf(sticky), ["privateDir"], fakeSystem(sticky));

  assert.deepEqual(
    parseAclListing(
      "drwxr-x---+ 61 douglasdong  staff  1952 Oct  8 21:04 /Users/douglasdong\n 0: group:everyone deny delete\n",
    ),
    [
      {
        index: 0,
        text: "group:everyone deny delete",
        kind: "deny",
        inherited: false,
      },
    ],
  );
  assert.deepEqual(
    parseAclListing(
      "-rw-r--r--@ 1 501  0  0 Oct  8 21:06 /x\n 0: ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C deny delete\n 1: FFFFEEEE-DDDD-CCCC-BBBB-AAAAFFFFFFFE allow read\n 2: group:staff inherited allow read,write\n",
    ).map((entry) => [entry.kind, entry.inherited]),
    [
      ["deny", false],
      ["allow", false],
      ["allow", true],
    ],
  );
  assert.deepEqual(
    parseAclListing("drwx------  4 douglasdong  staff  128 Oct  8 21:01 /p\n"),
    [],
  );
});

test("executables and search paths must live where only root and the operator can write", async () => {
  const m = machine();
  const { sys } = fakeSystem(m);
  const layout = layoutOf(m);
  const { results } = await verifyHostLayout(
    layout,
    [
      "dockerCli",
      "colima",
      "limactl",
      "homebrewDocker",
      "launchdPath",
      "node",
      "dockerConfig",
    ],
    { sys },
  );
  assert.equal(results.dockerCli.realpath, `${XBIN}/docker-tools`);
  assert.equal(
    results.colima.realpath,
    "/opt/homebrew/Cellar/colima/0.10.3/bin/colima",
  );
  assert.equal(results.node.realpath, NODE);
  assert.deepEqual(Object.keys(results.dockerConfig.plugins), [
    "docker-compose",
    "docker-buildx",
  ]);
  assert.equal(
    results.dockerConfig.plugins["docker-buildx"].realpath,
    `${XBIN}/docker-tools`,
  );
  const hashed = await assertTrustedExecutable(DOCKER, layout.operator, {
    sys,
    hash: true,
  });
  assert.equal(hashed.sha256, digest("docker-tools"));

  const cases = [
    [
      "admin has another member",
      "dockerCli",
      (x) => x.groups.admin.members.push("alice"),
      "HL_GROUP_MEMBERS",
      "/Applications",
    ],
    [
      "dseditgroup finds another member",
      "colima",
      (x) => {
        x.users.push({ name: "bob", uid: 502, gid: 20, home: "/Users/bob" });
        x.checkmember.admin.push("bob");
      },
      "HL_GROUP_MEMBERS",
      "/opt/homebrew/bin",
    ],
    [
      "account with admin as primary group",
      "colima",
      (x) =>
        x.users.push({
          name: "carol",
          uid: 503,
          gid: 80,
          home: "/Users/carol",
        }),
      "HL_GROUP_MEMBERS",
      "/opt/homebrew/bin",
    ],
    [
      "nested groups",
      "colima",
      (x) => x.groups.admin.nested.push("ABCD-1234"),
      "HL_GROUP_MEMBERS",
      "/Groups/admin",
    ],
    [
      "membership unreadable",
      "colima",
      (x) => delete x.groups.admin,
      "HL_GROUP_MEMBERS",
      "/Groups/admin",
    ],
    [
      "group-writable by staff",
      "colima",
      (x) => (x.files["/opt/homebrew/bin"].gid = 20),
      "HL_UNTRUSTED_PATH",
      "/opt/homebrew/bin",
    ],
    [
      "world-writable Cellar",
      "colima",
      (x) => (x.files["/opt/homebrew/Cellar"].mode = 0o777),
      "HL_UNTRUSTED_PATH",
      "/opt/homebrew/Cellar",
    ],
    [
      "foreign Cellar entry",
      "colima",
      (x) => (x.files["/opt/homebrew/Cellar/colima"].uid = 5102),
      "HL_UNTRUSTED_PATH",
      "/opt/homebrew/Cellar/colima",
    ],
    [
      "foreign symlink",
      "dockerCli",
      (x) => (x.files[DOCKER].uid = 5102),
      "HL_UNTRUSTED_PATH",
      DOCKER,
    ],
    [
      "allow ACL on the binary",
      "dockerCli",
      (x) => (x.acl[`${XBIN}/docker-tools`] = ["user:intruder allow write"]),
      "HL_ACL",
      `${XBIN}/docker-tools`,
    ],
    [
      "binary not executable",
      "limactl",
      (x) =>
        (x.files["/opt/homebrew/Cellar/lima/2.2.1/bin/limactl"].mode = 0o644),
      "HL_UNTRUSTED_PATH",
      "/opt/homebrew/Cellar/lima/2.2.1/bin/limactl",
    ],
    [
      "world-writable binary",
      "homebrewDocker",
      (x) =>
        (x.files["/opt/homebrew/Cellar/docker/29.8.2/bin/docker"].mode = 0o757),
      "HL_UNTRUSTED_PATH",
      "/opt/homebrew/Cellar/docker/29.8.2/bin/docker",
    ],
    [
      "link loop",
      "dockerCli",
      (x) => (x.files[`${XBIN}/docker-tools`] = link("docker")),
      "HL_UNTRUSTED_PATH",
      DOCKER,
    ],
    [
      "dangling link",
      "colima",
      (x) => delete x.files["/opt/homebrew/Cellar/colima/0.10.3/bin/colima"],
      "HL_MISSING",
      "/opt/homebrew/Cellar/colima/0.10.3/bin/colima",
    ],
    [
      "Node in a foreign directory",
      "node",
      (x) => (x.files["/opt/node-22"].uid = 5102),
      "HL_UNTRUSTED_PATH",
      "/opt/node-22",
    ],
    [
      "world-writable search path",
      "node",
      (x) => (x.files["/usr/local/bin"].mode = 0o777),
      "HL_UNTRUSTED_PATH",
      "/usr/local/bin",
    ],
    [
      "LaunchDaemon PATH entry",
      "launchdPath",
      (x) => (x.files["/usr/sbin"].mode = 0o777),
      "HL_UNTRUSTED_PATH",
      "/usr/sbin",
    ],
    [
      "plugin directory world-writable",
      "dockerConfig",
      (x) => (x.files[XBIN].mode = 0o777),
      "HL_UNTRUSTED_PATH",
      XBIN,
    ],
    [
      "buildx missing",
      "dockerConfig",
      (x) => delete x.files[`${XBIN}/docker-buildx`],
      "HL_DOCKER_CONFIG",
      `${P}/container-docker-context/config.json`,
    ],
    [
      "credential helper",
      "dockerConfig",
      (x) =>
        (x.files[`${P}/container-docker-context/config.json`].content =
          JSON.stringify({
            cliPluginsExtraDirs: [XBIN],
            credsStore: "osxkeychain",
          })),
      "HL_DOCKER_CONFIG",
      `${P}/container-docker-context/config.json`,
    ],
    [
      "relative plugin directory",
      "dockerConfig",
      (x) =>
        (x.files[`${P}/container-docker-context/config.json`].content =
          '{"cliPluginsExtraDirs":["xbin"]}'),
      "HL_DOCKER_CONFIG",
      `${P}/container-docker-context/config.json`,
    ],
    [
      "config.json 0644",
      "dockerConfig",
      (x) =>
        (x.files[`${P}/container-docker-context/config.json`].mode = 0o644),
      "HL_DOCKER_CONFIG",
      `${P}/container-docker-context/config.json`,
    ],
    [
      "DOCKER_CONFIG 0755",
      "dockerConfig",
      (x) => (x.files[`${P}/container-docker-context`].mode = 0o755),
      "HL_DOCKER_CONFIG",
      `${P}/container-docker-context`,
    ],
  ];
  for (const [name, key, change, code, path] of cases) {
    const x = machine();
    change(x);
    await assert.rejects(
      verifyHostLayout(layoutOf(x), [key], fakeSystem(x)),
      (error) => {
        assert.equal(error.code, code, `${name}: ${error.message}`);
        assert.equal(error.path, path, `${name}: ${error.message}`);
        return true;
      },
    );
  }
  // A missing search-path directory is fine while its parent is trusted.
  const noLocal = machine();
  delete noLocal.files["/usr/local/bin"];
  await verifyHostLayout(layoutOf(noLocal), ["node"], fakeSystem(noLocal));
  // Behind a link, the directory the target would be created in decides.
  const dangling = machine();
  dangling.files["/usr/local/bin"] = link("/srv/missing/bin", 0);
  dangling.files["/srv"] = dir(0);
  await verifyHostLayout(layoutOf(dangling), ["node"], fakeSystem(dangling));
  dangling.files["/srv"].mode = 0o777;
  await refused(
    () => verifyHostLayout(layoutOf(dangling), ["node"], fakeSystem(dangling)),
    "HL_UNTRUSTED_PATH",
    { path: "/srv" },
  );
  // wheel may write when root is its only member.
  const wheel = machine();
  wheel.files["/opt"] = dir(0, 0o775, 0);
  await verifyHostLayout(layoutOf(wheel), ["colima"], fakeSystem(wheel));
  // The layout must belong to the running Node.
  const otherNode = machine();
  await refused(
    () =>
      verifyHostLayout(
        layoutOf(otherNode),
        ["node"],
        fakeSystem({ ...otherNode, execPath: "/usr/local/bin/node" }),
      ),
    "HL_LAYOUT_CHANGED",
  );
});

test("each action declares its checks; the stop-loss path survives what only Docker tools need", async () => {
  const m = machine();
  m.colimaHome = "/Users/operator/other-colima";
  m.files[`${P}/host-layout.json`] = file(OP_UID, 0o600, "{");
  remove(m, COLIMA, `${HOME}/.orbstack`, "/Applications", "/opt/homebrew");
  const { sys, calls } = fakeSystem(m);
  const layout = await loadHostLayout({ requires: "manage", sys });
  assert.equal(layout.adminApi, `${P}/admin-api.json`);
  assert.equal(layout.dockerCli, null);
  assert.equal(calls.colimaHome, 0);
  assert.ok(!calls.open.includes(`${P}/host-layout.json`));
  assert.deepEqual(
    [...new Set(calls.run.map((call) => call.file))],
    ["/bin/ls"],
  );
  assert.deepEqual(
    [...REQUIRES.manage],
    ["operator", "privateDir", "adminApi"],
  );
  await refused(
    () => verifyHostLayout(layout, ["dockerCli"], { sys }),
    "HL_USAGE",
  );
  // manage does not check the platform either.
  await loadHostLayout({
    requires: "manage",
    sys: fakeSystem({ ...machine(), nodeVersion: "20.0.0" }).sys,
  });

  // build runs before admin-api.json and the other VMs exist (disaster recovery 5.6).
  const build = machine();
  delete build.files[`${P}/admin-api.json`];
  for (const name of ["agent-platform-runtime", "agent-platform-jenkins"])
    delete build.files[`${COLIMA}/${name}/docker.sock`];
  await loadHostLayout({
    requires: "upgrade-build",
    sys: fakeSystem(build).sys,
  });
  await refused(
    () =>
      loadHostLayout({ requires: "upgrade-apply", sys: fakeSystem(build).sys }),
    "HL_MISSING",
    { key: "adminApi" },
  );
  build.files[`${P}/admin-api.json`] = file(OP_UID, 0o600, "{}");
  await refused(
    () =>
      loadHostLayout({ requires: "upgrade-apply", sys: fakeSystem(build).sys }),
    "HL_MISSING",
    { key: "socket:runtime" },
  );

  // bootstrap prepare needs neither the private directory nor any socket.
  const prepare = machine();
  remove(prepare, P);
  for (const name of PROFILES)
    delete prepare.files[`${COLIMA}/${name}/docker.sock`];
  await loadHostLayout({
    requires: "bootstrap-prepare",
    sys: fakeSystem(prepare).sys,
  });
  await refused(
    () =>
      loadHostLayout({
        requires: "bootstrap-prepare",
        sys: fakeSystem({ ...prepare, nodeVersion: "24.0.0" }).sys,
      }),
    "HL_NODE",
  );

  // COLIMA_HOME is refused for every action that touches the VMs, even when empty.
  for (const value of ["/Users/operator/other-colima", "", `${COLIMA}/`])
    await refused(
      () =>
        loadHostLayout({
          requires: "upgrade-build",
          sys: fakeSystem({ ...machine(), colimaHome: value }).sys,
        }),
      "HL_COLIMA_HOME",
      { key: "colimaEnv" },
    );
  await loadHostLayout({
    requires: "upgrade-build",
    sys: fakeSystem({ ...machine(), colimaHome: COLIMA }).sys,
  });
  assert.deepEqual(expandRequires(["identity", "sockets"]), [
    "platform",
    "operator",
    "colimaEnv",
    "socket:jenkins",
    "socket:build",
    "socket:runtime",
  ]);
  assert.deepEqual(expandRequires(["operator", "privateDir"]), [
    "operator",
    "privateDir",
  ]);
  for (const bad of [
    undefined,
    [],
    ["unknown"],
    ["toString"],
    "nope",
    "__proto__",
    [42],
  ])
    await refusedNow(() => expandRequires(bad), "HL_REQUIRE");
  await refused(() => loadHostLayout({ sys }), "HL_REQUIRE");
  for (const [name, keys] of Object.entries(REQUIRES)) {
    for (const key of keys)
      assert.ok(REQUIRE_KEYS.includes(key), `${name}: ${key}`);
    expandRequires(name);
  }
  // A layout derived for another account is refused by the operator check.
  const foreign = resolveHostLayout({
    identity: { ...OPERATOR, uid: 5102, homedir: "/Users/other" },
    execPath: NODE,
    overrides: null,
  });
  await refused(
    () => verifyHostLayout(foreign, ["operator"], fakeSystem(machine())),
    "HL_IDENTITY_MISMATCH",
  );
  // A tampered layout object is refused before any check.
  const tampered = {
    ...layoutRecord(layoutOf(machine())),
    privateDir: "/tmp/p",
  };
  await refused(
    () => verifyHostLayout(tampered, ["operator"], fakeSystem(machine())),
    "HL_LAYOUT_CHANGED",
  );
  // The override file may not change between loading and verifying.
  const changed = machine();
  const before = await loadHostLayout({
    requires: "print",
    sys: fakeSystem(changed).sys,
  });
  changed.files[`${P}/host-layout.json`] = file(
    OP_UID,
    0o600,
    '{"schemaVersion":1,"homebrewPrefix":"/usr/local"}',
  );
  await refused(
    () => verifyHostLayout(before, ["overrideFile"], fakeSystem(changed)),
    "HL_LAYOUT_CHANGED",
  );
});

test("Jenkins credentials go only to a loopback listener held by the operator", async () => {
  assert.deepEqual(parseLsofListeners("p70835\nu501\nf11\n"), [
    { pid: 70835, uid: 501 },
  ]);
  assert.deepEqual(parseLsofListeners(""), []);
  const operator = assertOperatorRecord(OPERATOR);
  const m = machine();
  const { sys, calls } = fakeSystem(m);
  const found = await assertJenkinsListener(8080, operator, { sys });
  assert.deepEqual(JSON.parse(JSON.stringify(found)), {
    port: 8080,
    listeners: [{ pid: 70835, uid: OP_UID }],
  });
  assert.deepEqual(calls.run.at(-1), {
    file: "/usr/sbin/lsof",
    args: ["-nP", "-a", "-iTCP@127.0.0.1:8080", "-sTCP:LISTEN", "-Fpu"],
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
  });
  m.listeners[18080] = { code: 0, stdout: `p4242\nu${OP_UID}\nf9\n` };
  assert.equal(
    (await assertJenkinsListener(18080, operator, { sys })).listeners[0].pid,
    4242,
  );
  assert.equal(calls.run.at(-1).args[2], "-iTCP@127.0.0.1:18080");
  for (const [listener, code] of [
    [{ code: 0, stdout: "p1\nu5102\nf3\n" }, "HL_JENKINS_LISTENER"],
    [
      { code: 0, stdout: `p1\nu${OP_UID}\nf3\np2\nu0\nf4\n` },
      "HL_JENKINS_LISTENER",
    ],
    [{ code: 1, stdout: "" }, "HL_JENKINS_LISTENER"],
    [{ code: 1, stdout: "p1\nu5101\n" }, "HL_JENKINS_LISTENER"],
    [{ code: 2, stdout: "" }, "HL_JENKINS_LISTENER"],
    [{ code: 0, stdout: "pabc\nu5101\n" }, "HL_JENKINS_LISTENER"],
    [{ code: 0, stdout: "p1\nf3\n" }, "HL_JENKINS_LISTENER"],
  ]) {
    m.listeners[8080] = listener;
    await refused(() => assertJenkinsListener(8080, operator, { sys }), code);
  }
  await refused(
    () => assertJenkinsListener(9090, operator, { sys }),
    "HL_USAGE",
  );
  await refused(() => assertJenkinsListener(8080, null, { sys }), "HL_USAGE");
});

test("doctor checks one disaster-recovery stage at a time and reports later items as not-yet", async () => {
  // End of disaster recovery 5.1: no VMs, LaunchDaemons, env files, credential or Jenkins.
  const fresh = machine();
  remove(
    fresh,
    COLIMA,
    `${P}/container-boot`,
    `${P}/admin-api.json`,
    `${P}/container-stack.env`,
    `${P}/container-runtime.env`,
    "/Library/LaunchDaemons",
  );
  fresh.files["/Library/LaunchDaemons"] = dir(0);
  fresh.listeners = {};
  fresh.running = [];
  const { sys, calls } = fakeSystem(fresh);
  const host = await doctor({
    stage: "host",
    sys,
    render,
    repositoryLimaOverride: REPOSITORY_LIMA,
  });
  assert.equal(
    host.state,
    "doctor-passed",
    JSON.stringify(
      host.checks.filter((c) => c.status !== "ok" && c.status !== "not-yet"),
    ),
  );
  assert.equal(host.operator, "operator");
  assert.deepEqual(
    host.checks.map((check) => check.id),
    [...DOCTOR_CHECK_IDS],
  );
  for (const check of host.checks)
    assert.equal(
      check.status,
      check.stage === "host" ? "ok" : "not-yet",
      check.id,
    );
  assert.ok(
    !calls.run.some((call) =>
      ["/bin/launchctl", "/usr/sbin/lsof", "/usr/bin/plutil"].includes(
        call.file,
      ),
    ),
  );
  assert.ok(!calls.run.some((call) => call.args.includes("info")));
  assert.equal(calls.fetch.length, 0);

  const engines = await doctor({
    stage: "engines",
    sys: fakeSystem(fresh).sys,
    repositoryLimaOverride: REPOSITORY_LIMA,
  });
  assert.equal(engines.state, "doctor-failed");
  const byId = Object.fromEntries(
    engines.checks.map((check) => [check.id, check]),
  );
  assert.equal(byId["socket:build"].status, "fail");
  assert.equal(byId["socket:build"].code, "HL_MISSING");
  assert.equal(byId["daemon:build"].status, "blocked");
  assert.equal(byId["launchd:build"].status, "not-yet");
  assert.equal(byId.adminApi.status, "not-yet");

  // A complete machine passes every stage; secrets are never read.
  const complete = machine();
  const run = fakeSystem(complete);
  const full = await doctor({
    stage: "full",
    sys: run.sys,
    render,
    repositoryLimaOverride: REPOSITORY_LIMA,
  });
  assert.equal(
    full.state,
    "doctor-passed",
    JSON.stringify(full.checks.filter((c) => c.status !== "ok")),
  );
  assert.deepEqual(full.counts, {
    ok: DOCTOR_CHECK_IDS.length,
    warn: 0,
    fail: 0,
    blocked: 0,
    "not-yet": 0,
  });
  assert.equal(full.layoutSha256, layoutSha256(layoutOf(complete)));
  for (const secret of [
    `${P}/admin-api.json`,
    `${P}/container-stack.env`,
    `${P}/container-runtime.env`,
  ])
    assert.ok(
      !run.calls.read.includes(secret) && !run.calls.readFile.includes(secret),
      secret,
    );
  assert.deepEqual(run.calls.fetch, ["http://127.0.0.1:8080/login"]);
  const launchd = full.checks.find((check) => check.id === "launchd:build");
  assert.equal(launchd.detail, "bytes and fields match; running");
  const probes = run.calls.run.filter((call) => call.file === DOCKER);
  for (const call of probes)
    assert.deepEqual(call.env, {
      PATH: "/usr/bin:/bin",
      HOME,
      LANG: "C",
      DOCKER_CONFIG: `${P}/container-docker-context`,
    });

  const variants = [
    [
      "review schema 1 and a changed colima.yaml",
      (x) => {
        x.files[`${P}/container-boot/review.json`].content = JSON.stringify({
          schemaVersion: 1,
          profileConfigurations: {
            "agent-platform-build": digest(yaml("agent-platform-build")),
          },
        });
      },
      "bootReview",
      "warn",
      "HL_REVIEW",
    ],
    [
      "no review yet",
      (x) => delete x.files[`${P}/container-boot/review.json`],
      "bootReview",
      "warn",
      "HL_REVIEW",
    ],
    [
      "review readable by others",
      (x) => (x.files[`${P}/container-boot/review.json`].mode = 0o644),
      "bootReview",
      "warn",
      "HL_REVIEW",
    ],
    [
      "plist bytes differ from render",
      (x) => (x.files[plistFile("agent-platform-build")].content += " "),
      "launchd:build",
      "fail",
      "HL_LAUNCHD",
    ],
    [
      "plist runs as another account",
      (x) => (x.plists[plistFile("agent-platform-runtime")].UserName = "other"),
      "launchd:runtime",
      "fail",
      "HL_LAUNCHD",
    ],
    [
      "plist writable by group",
      (x) => (x.files[plistFile("agent-platform-jenkins")].mode = 0o664),
      "launchd:jenkins",
      "fail",
      "HL_LAUNCHD",
    ],
    [
      "service not running",
      (x) => (x.running = x.running.slice(1)),
      "launchd:jenkins",
      "fail",
      "HL_LAUNCHD",
    ],
    [
      "second definition for a profile",
      (x) => {
        x.files["/Library/LaunchDaemons/org.example.colima.plist"] = file(
          0,
          0o644,
          "agent-platform-build",
        );
        x.plists["/Library/LaunchDaemons/org.example.colima.plist"] = {
          Label: "org.example.colima",
          ProgramArguments: [
            "/opt/homebrew/bin/colima",
            "--profile",
            "agent-platform-build",
            "start",
          ],
        };
      },
      "launchdDuplicates",
      "fail",
      "HL_LAUNCHD",
    ],
    [
      "user agent for a profile",
      (x) => {
        x.files[`${HOME}/Library/LaunchAgents/old.plist`] = file(
          OP_UID,
          0o644,
          "agent-platform-runtime",
        );
        x.plists[`${HOME}/Library/LaunchAgents/old.plist`] = {
          ProgramArguments: [
            "colima",
            "--profile=agent-platform-runtime",
            "start",
          ],
        };
      },
      "launchdDuplicates",
      "warn",
      "HL_LAUNCHD",
    ],
    [
      "Lima override edited",
      (x) =>
        (x.files[`${COLIMA}/_lima/_config/override.yaml`].content = "edited\n"),
      "limaOverride",
      "fail",
      "HL_FILE",
    ],
    [
      "socket answers as another daemon",
      (x) =>
        (x.daemons[`unix://${COLIMA}/agent-platform-runtime/docker.sock`] =
          "colima-agent-platform-build"),
      "daemon:runtime",
      "fail",
      "HL_PROBE",
    ],
    [
      "foreign Jenkins listener",
      (x) => (x.listeners[8080] = { code: 0, stdout: "p9\nu5102\nf3\n" }),
      "jenkinsListener",
      "fail",
      "HL_JENKINS_LISTENER",
    ],
    [
      "Jenkins login page",
      (x) => (x.fetchStatus = 503),
      "jenkinsLogin",
      "fail",
      "HL_PROBE",
    ],
    [
      "extra config.json keys",
      (x) =>
        (x.files[`${P}/container-docker-context/config.json`].content =
          JSON.stringify({ cliPluginsExtraDirs: [XBIN], auths: {} })),
      "dockerConfig",
      "warn",
      "HL_DOCKER_CONFIG",
    ],
    [
      "stack env 0644",
      (x) => (x.files[`${P}/container-stack.env`].mode = 0o644),
      "stackEnv",
      "fail",
      "HL_PRIVATE_FILE",
    ],
  ];
  for (const [name, change, id, status, code] of variants) {
    const x = machine();
    change(x);
    const report = await doctor({
      stage: "full",
      sys: fakeSystem(x).sys,
      render,
      repositoryLimaOverride: REPOSITORY_LIMA,
    });
    const check = report.checks.find((entry) => entry.id === id);
    assert.equal(check.status, status, `${name}: ${JSON.stringify(check)}`);
    assert.equal(check.code, code, name);
    assert.equal(
      report.state,
      status === "warn" ? "doctor-passed" : "doctor-failed",
      name,
    );
  }
  const blocked = await doctor({
    stage: "full",
    sys: fakeSystem({
      ...machine(),
      listeners: { 8080: { code: 0, stdout: "p9\nu5102\n" } },
    }).sys,
    render,
    repositoryLimaOverride: REPOSITORY_LIMA,
  });
  assert.equal(
    blocked.checks.find((check) => check.id === "jenkinsLogin").status,
    "blocked",
  );
  const review = await doctor({
    stage: "launchd",
    sys: fakeSystem(
      (() => {
        const x = machine();
        x.files[`${P}/container-boot/review.json`].content = JSON.stringify({
          schemaVersion: 1,
          profileConfigurations: {},
        });
        return x;
      })(),
    ).sys,
    render,
    repositoryLimaOverride: REPOSITORY_LIMA,
  });
  const detail = review.checks.find(
    (check) => check.id === "bootReview",
  ).detail;
  assert.match(detail, /schemaVersion 1/);
  assert.match(
    detail,
    /agent-platform-jenkins, agent-platform-build, agent-platform-runtime/,
  );
  // Without the repository copy the Lima override is only warned about.
  const elsewhere = await doctor({
    stage: "engines",
    sys: fakeSystem(machine()).sys,
    repositoryLimaOverride: "/nowhere/lima-override.yaml",
  });
  assert.equal(
    elsewhere.checks.find((check) => check.id === "limaOverride").status,
    "warn",
  );
  // Root or another account: identity fails and every dependent check is blocked.
  const root = await doctor({
    stage: "full",
    sys: fakeSystem({ ...machine(), uid: 0, euid: 0 }).sys,
    render,
  });
  assert.equal(root.state, "doctor-failed");
  assert.equal(root.checks[0].status, "ok");
  assert.equal(root.checks[1].code, "HL_IDENTITY_ROOT");
  assert.ok(root.checks.slice(2).every((check) => check.status === "blocked"));
  await refused(() => doctor({ stage: "everything", sys }), "HL_USAGE");
  assert.deepEqual(
    [...STAGES],
    ["host", "engines", "launchd", "images", "full"],
  );
});

test("the CLI prints the layout and runs doctor without options beyond its stage", async () => {
  const m = machine();
  let output = "";
  const write = (text) => (output += text);
  assert.equal(await main(["print"], { sys: fakeSystem(m).sys, write }), 0);
  assert.deepEqual(JSON.parse(output), layoutRecord(layoutOf(m)));
  output = "";
  assert.equal(
    await main(["print", "--shell"], { sys: fakeSystem(m).sys, write }),
    0,
  );
  assert.equal(output, shellAssignments(layoutOf(m)));
  output = "";
  assert.equal(
    await main(["doctor", "--stage=launchd"], {
      sys: fakeSystem(m).sys,
      write,
      render,
    }),
    0,
  );
  assert.equal(JSON.parse(output).stage, "launchd");
  output = "";
  const failing = { ...machine(), fetchStatus: 500 };
  assert.equal(
    await main(["doctor", "--stage", "full"], {
      sys: fakeSystem(failing).sys,
      write,
      render,
    }),
    1,
  );
  for (const argv of [
    [],
    ["print", "--json"],
    ["print", "--shell", "x"],
    ["doctor", "--stage"],
    ["doctor", "--stage", "full", "extra"],
    ["doctor", "--host", "x"],
    ["apply"],
  ])
    await refused(
      () => main(argv, { sys: fakeSystem(m).sys, write }),
      "HL_USAGE",
    );

  assert.equal(spawnSync(process.execPath, ["--check", moduleFile]).status, 0);
  const usage = spawnSync(process.execPath, [moduleFile, "bogus"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
    timeout: 30_000,
  });
  assert.equal(usage.status, 1);
  assert.deepEqual(JSON.parse(usage.stderr), {
    state: "host-layout-refused",
    code: "HL_USAGE",
    message:
      "Host layout refused [HL_USAGE]: Use print [--shell] | doctor [--stage host|engines|launchd|images|full]",
  });
  assert.equal(usage.stdout, "");
});

test("the module reads no environment variable except COLIMA_HOME and never uses os.homedir()", async (t) => {
  const source = await fs.readFile(moduleFile, "utf8");
  const code = source.replace(/^\s*\/\/.*$/gm, "");
  assert.deepEqual(code.match(/process\.env\b[.[]?\w*/g), [
    "process.env.COLIMA_HOME",
  ]);
  assert.doesNotMatch(code, /homedir\(|tmpdir\(|process\.env\[/);
  assert.doesNotMatch(code, /from "\.\.\/jenkins\//);
  for (const match of code.matchAll(/(?:import|from)\s*\(?\s*"([^"]+)"/g))
    assert.ok(
      match[1].startsWith("node:") || match[1] === "./bootstrap-host.mjs",
      match[1],
    );

  let operatorPolicy = true;
  try {
    const info = userInfo();
    assertOperatorRecord({
      username: info.username,
      uid: info.uid,
      gid: info.gid,
      home: info.homedir,
    });
  } catch {
    operatorPolicy = false;
  }
  if (!operatorPolicy) {
    t.skip("the account running the tests is outside the operator policy");
    return;
  }
  const script = `
    const seen = new Set();
    const record = (key) => typeof key === "string" && seen.add(key);
    process.env = new Proxy(process.env, {
      get: (target, key) => (record(key), Reflect.get(target, key)),
      has: (target, key) => (record(key), Reflect.has(target, key)),
      getOwnPropertyDescriptor: (target, key) => (record(key), Reflect.getOwnPropertyDescriptor(target, key)),
      ownKeys: (target) => (seen.add("*"), Reflect.ownKeys(target)),
    });
    const hostLayout = await import(${JSON.stringify(new URL("./host-layout.mjs", import.meta.url).href)});
    const imported = [...seen];
    seen.clear();
    const plain = await hostLayout.loadHostLayout({ requires: ["operator"] });
    const plainKeys = [...seen];
    seen.clear();
    const colima = await hostLayout.loadHostLayout({ requires: ["operator", "colimaEnv"] });
    console.log(JSON.stringify({ imported, plainKeys, colimaKeys: [...seen], home: plain.operator.home, privateDir: colima.privateDir }));
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/tmp/not-home",
        USER: "nobody",
        LOGNAME: "nobody",
        XDG_DATA_HOME: "/tmp/xdg",
        AGENT_PLATFORM_PRIVATE_DIR: "/tmp/evil",
        DOCKER_CONFIG: "/tmp/evil-docker",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  const forbidden = (key) =>
    key === "*" ||
    /^(HOME|USER|LOGNAME|TMPDIR|LIMA_HOME|SUDO_\w+|XDG_\w+|AGENT_PLATFORM_\w+|DOCKER_\w+|HOMEBREW_\w+)$/.test(
      key,
    );
  for (const keys of [
    observed.imported,
    observed.plainKeys,
    observed.colimaKeys,
  ])
    assert.deepEqual(keys.filter(forbidden), [], JSON.stringify(observed));
  assert.ok(!observed.imported.includes("COLIMA_HOME"));
  assert.ok(!observed.plainKeys.includes("COLIMA_HOME"));
  assert.ok(observed.colimaKeys.includes("COLIMA_HOME"));
  assert.equal(observed.home, userInfo().homedir);
  assert.equal(
    observed.privateDir,
    `${userInfo().homedir}/.local/share/agent-platform-jenkins-tools`,
  );
});

// The operator home is created directly in /tmp: its ancestors must be root's
// (or sticky), which /tmp is on macOS and Linux and the per-user macOS TMPDIR is not.
async function realHome(t) {
  if (!(process.getuid?.() >= 501))
    return t.skip("needs a non-system UID to own the temporary home");
  const tmp = await fs.stat("/tmp");
  if (tmp.uid !== 0 || !(tmp.mode & 0o1000))
    return t.skip("/tmp is not root's sticky directory");
  const home = await fs.realpath(await fs.mkdtemp("/tmp/hl-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.chmod(home, 0o750);
  const operator = {
    username: "operator",
    uid: process.getuid(),
    gid: process.getgid(),
    homedir: home,
  };
  const sys = nodeSystem({
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "22.23.3",
    userInfo: () => operator,
    colimaHome: () => undefined,
    // GNU ls has no -e; ACL parsing is covered above and by the macOS-only case.
    run: async (file, args) =>
      file === "/bin/ls"
        ? { code: 0, signal: null, stdout: `entry ${args[2]}\n`, stderr: "" }
        : { code: 127, signal: null, stdout: "", stderr: "" },
  });
  const layout = resolveHostLayout({
    identity: operator,
    execPath: process.execPath,
    overrides: {},
  });
  await fs.mkdir(layout.privateDir, { recursive: true, mode: 0o700 });
  await fs.chmod(layout.privateDir, 0o700);
  await fs.writeFile(layout.adminApi, '{"token":"x"}', { mode: 0o600 });
  return { home, sys, layout, operator: assertOperatorRecord(operator) };
}

test("real files: private file identity is checked with O_NOFOLLOW and fstat", async (t) => {
  const real = await realHome(t);
  if (!real) return;
  const { sys, layout, operator } = real;
  await verifyHostLayout(layout, ["privateDir", "adminApi"], { sys });
  await fs.chmod(layout.adminApi, 0o644);
  await refused(
    () => verifyHostLayout(layout, ["adminApi"], { sys }),
    "HL_PRIVATE_FILE",
  );
  await fs.chmod(layout.adminApi, 0o600);
  await fs.link(layout.adminApi, `${layout.privateDir}/second-link`);
  await refused(
    () => verifyHostLayout(layout, ["adminApi"], { sys }),
    "HL_PRIVATE_FILE",
  );
  await fs.unlink(`${layout.privateDir}/second-link`);
  await fs.rename(layout.adminApi, `${layout.privateDir}/moved.json`);
  await fs.symlink(`${layout.privateDir}/moved.json`, layout.adminApi);
  await refused(
    () => verifyHostLayout(layout, ["adminApi"], { sys }),
    "HL_PRIVATE_FILE",
  );
  await fs.chmod(layout.privateDir, 0o750);
  await refused(
    () => verifyHostLayout(layout, ["privateDir"], { sys }),
    "HL_PRIVATE_DIR",
  );
  await fs.chmod(layout.privateDir, 0o700);

  await fs.writeFile(
    layout.overrideFile,
    '{"schemaVersion":1,"homebrewPrefix":"/usr/local"}',
    { mode: 0o600 },
  );
  assert.deepEqual(
    { ...(await loadOverrides(operator, { sys })).values },
    { homebrewPrefix: "/usr/local" },
  );
  await fs.chmod(layout.overrideFile, 0o640);
  await refused(() => loadOverrides(operator, { sys }), "HL_OVERRIDE_FILE");
});

test("real files: Docker sockets are recognised with lstat", async (t) => {
  const real = await realHome(t);
  if (!real) return;
  const { sys, layout } = real;
  const profile = layout.profiles.build;
  await fs.mkdir(profile.directory, { recursive: true, mode: 0o755 });
  const server = createServer();
  await new Promise((done, fail) =>
    server.once("error", fail).listen(profile.socketPath, done),
  );
  t.after(() => new Promise((done) => server.close(done)));
  await fs.chmod(profile.socketPath, 0o600);
  await verifyHostLayout(layout, ["socket:build"], { sys });
  await fs.chmod(profile.socketPath, 0o666);
  await refused(
    () => verifyHostLayout(layout, ["socket:build"], { sys }),
    "HL_SOCKET",
  );
  await refused(
    () => verifyHostLayout(layout, ["socket:runtime"], { sys }),
    "HL_MISSING",
  );
});

test(
  "macOS: allow ACL entries from the real /bin/ls are refused",
  { skip: process.platform !== "darwin" && "macOS only" },
  async (t) => {
    const real = await realHome(t);
    if (!real) return;
    const { layout } = real;
    const sys = { ...real.sys, run: nodeSystem().run };
    await verifyHostLayout(layout, ["privateDir", "adminApi"], { sys });
    assert.equal(
      spawnSync("/bin/chmod", ["+a", "user:nobody allow read", layout.adminApi])
        .status,
      0,
    );
    t.after(() => spawnSync("/bin/chmod", ["-N", layout.adminApi]));
    await refused(
      () => verifyHostLayout(layout, ["adminApi"], { sys }),
      "HL_ACL",
      { path: layout.adminApi },
    );
    assert.equal(spawnSync("/bin/chmod", ["-N", layout.adminApi]).status, 0);
    await verifyHostLayout(layout, ["adminApi"], { sys });
  },
);

test("parsers for dscl output keep continuation lines", () => {
  assert.deepEqual(
    parseDsclAttributes(
      "GroupMembership: root douglasdong _mbsetupuser\nPrimaryGroupID: 80\n",
    ),
    {
      GroupMembership: ["root", "douglasdong", "_mbsetupuser"],
      PrimaryGroupID: ["80"],
    },
  );
  assert.deepEqual(
    parseDsclAttributes(
      "GroupMembership:\n root\n alice bob\nPrimaryGroupID: 0\n",
    ),
    {
      GroupMembership: ["root", "alice", "bob"],
      PrimaryGroupID: ["0"],
    },
  );
});
