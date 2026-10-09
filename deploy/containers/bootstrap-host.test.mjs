import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REVIEW_SCHEMA_VERSION,
  definitions,
  invoker,
  main,
  openReview,
  ownedFile,
  render,
  reviewedLayout,
} from "./bootstrap-host.mjs";
import {
  DEFAULT_LAUNCHD_LABEL_PREFIX,
  HostLayoutError,
  PROFILES,
  PROFILE_KEYS,
  layoutRecord,
  nodeSystem,
  resolveHostLayout,
} from "./host-layout.mjs";

const source = dirname(fileURLToPath(import.meta.url));
const digest = (value) => createHash("sha256").update(value).digest("hex");
// Injected operator; tests never use the real account.
const OPERATOR = Object.freeze({
  username: "operator",
  uid: 5101,
  gid: 20,
  homedir: "/Users/operator",
});
const NODE = "/opt/node-22/bin/node";
const layoutFor = (identity = OPERATOR, overrides = {}) =>
  resolveHostLayout({ identity, execPath: NODE, overrides });
const anchored = (identity = OPERATOR) => ({
  username: identity.username,
  uid: identity.uid,
  gid: identity.gid,
  home: identity.homedir,
});

// The plist written byte for byte, spelled out independently of the module.
function expectedPlist(
  name,
  { system, home, user = "operator", group = "staff", brew, prefix },
) {
  const p = `${home}/.local/share/agent-platform-jenkins-tools`;
  const log = `${p}/container-boot/logs/${name}.log`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict>' +
    `<key>Label</key><string>${prefix}${name}</string>` +
    (system
      ? `<key>UserName</key><string>${user}</string><key>GroupName</key><string>${group}</string>`
      : "") +
    `<key>ProgramArguments</key><array><string>${brew}/bin/colima</string><string>--profile</string><string>${name}</string><string>start</string><string>--foreground</string><string>--activate=false</string><string>--save-config=false</string><string>--ssh-agent=false</string><string>--ssh-config=false</string></array>` +
    `<key>WorkingDirectory</key><string>${home}</string>` +
    `<key>EnvironmentVariables</key><dict><key>HOME</key><string>${home}</string><key>PATH</key><string>${brew}/bin:/usr/bin:/bin:/usr/sbin:/sbin</string><key>LANG</key><string>en_US.UTF-8</string><key>DOCKER_CONFIG</key><string>${p}/container-docker-context</string></dict>` +
    "<key>RunAtLoad</key><true/><key>StartInterval</key><integer>60</integer><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>30</integer><key>ExitTimeOut</key><integer>90</integer><key>Umask</key><integer>63</integer>" +
    `<key>StandardOutPath</key><string>${log}</string><key>StandardErrorPath</key><string>${log}</string>` +
    "</dict></plist>\n"
  );
}

async function refused(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof HostLayoutError, error?.stack ?? String(error));
    assert.equal(error.code, code, error.message);
    return true;
  });
}

test("render writes the reviewed plists from the host layout, in profile order and with XML escaping", () => {
  const layout = layoutFor();
  const values = {
    home: "/Users/operator",
    brew: "/opt/homebrew",
    prefix: DEFAULT_LAUNCHD_LABEL_PREFIX,
  };
  for (const system of [true, false]) {
    const rendered = render(system, layout, "staff");
    assert.deepEqual(
      Object.keys(rendered),
      PROFILES.map((name) => DEFAULT_LAUNCHD_LABEL_PREFIX + name),
    );
    for (const name of PROFILES)
      assert.equal(
        rendered[DEFAULT_LAUNCHD_LABEL_PREFIX + name],
        expectedPlist(name, { system, ...values }),
        name,
      );
  }
  // Overridable values flow into every field that uses them; nothing else moves.
  const moved = layoutFor(OPERATOR, {
    homebrewPrefix: "/usr/local",
    launchdLabelPrefix: "org.example.engines.",
  });
  assert.equal(
    render(true, moved, "admin")["org.example.engines.agent-platform-build"],
    expectedPlist("agent-platform-build", {
      system: true,
      home: "/Users/operator",
      group: "admin",
      brew: "/usr/local",
      prefix: "org.example.engines.",
    }),
  );
  // Another account: its own home, name and UID, never a fixed one.
  const other = layoutFor({
    username: "ops.two",
    uid: 5102,
    gid: 20,
    homedir: "/Users/ops.two",
  });
  assert.equal(
    render(true, other, "staff")[
      DEFAULT_LAUNCHD_LABEL_PREFIX + "agent-platform-runtime"
    ],
    expectedPlist("agent-platform-runtime", {
      system: true,
      ...values,
      home: "/Users/ops.two",
      user: "ops.two",
    }),
  );
  // Strings are escaped (a hand-made layout; the policy itself refuses such values).
  const odd = {
    ...layout,
    operator: { ...layout.operator, home: "/Users/a&b<c>\"d'" },
  };
  const text = Object.values(render(false, odd))[0];
  assert.ok(
    text.includes(
      "<key>WorkingDirectory</key><string>/Users/a&amp;b&lt;c&gt;&quot;d&apos;</string>",
    ),
  );
  // Field order is fixed.
  assert.deepEqual(Object.keys(definitions(true, layout, "staff")[0]), [
    "Label",
    "UserName",
    "GroupName",
    "ProgramArguments",
    "WorkingDirectory",
    "EnvironmentVariables",
    "RunAtLoad",
    "StartInterval",
    "KeepAlive",
    "ThrottleInterval",
    "ExitTimeOut",
    "Umask",
    "StandardOutPath",
    "StandardErrorPath",
  ]);
});

test("render refuses a layout derived without host-layout.json and a missing or malformed group", () => {
  const skipped = resolveHostLayout({
    identity: OPERATOR,
    execPath: NODE,
    overrides: null,
  });
  for (const system of [true, false])
    assert.throws(() => render(system, skipped, "staff"), /host-layout\.json/);
  assert.throws(() => render(true, undefined, "staff"), /host-layout\.json/);
  const layout = layoutFor();
  for (const group of ["", "bad group", "a:b", "-x", 42, false])
    assert.throws(() => render(true, layout, group), /primary group/);
  // Looked up only when not given: an absent account has no primary group.
  const absent = layoutFor({ ...OPERATOR, username: "hl-absent-account" });
  for (const group of [undefined, null])
    assert.throws(() => render(true, absent, group), /could not be confirmed/);
  assert.equal(Object.keys(render(false, absent)).length, 3);
});

test("render without a group looks up the running account's primary group, as host-layout doctor calls it", (t) => {
  const me = userInfo();
  let layout;
  try {
    layout = layoutFor(me);
  } catch {
    return t.skip(
      "the account running the tests is outside the operator policy",
    );
  }
  const id = spawnSync("/usr/bin/id", ["-gn"], { encoding: "utf8" });
  if (id.status !== 0) return t.skip("id is unavailable");
  const group = id.stdout.trim();
  assert.deepEqual(render(true, layout), render(true, layout, group));
  assert.equal(definitions(true, layout)[0].GroupName, group);
});

test("a frozen review must name the anchored operator and a layout that follows from it", async () => {
  const layout = layoutFor();
  const manifest = () => ({
    schemaVersion: REVIEW_SCHEMA_VERSION,
    operator: { ...anchored(), group: "staff" },
    hostLayout: layoutRecord(layout),
  });
  const anchor = { operator: anchored(), group: "staff" };
  assert.deepEqual(
    layoutRecord(reviewedLayout(manifest(), anchor)),
    layoutRecord(layout),
  );
  const refuse = (alter, pattern) => {
    const value = manifest();
    alter(value);
    assert.throws(() => reviewedLayout(value, anchor), pattern);
  };
  refuse((m) => (m.schemaVersion = 1), /schema 2/);
  refuse((m) => delete m.schemaVersion, /schema 2/);
  for (const [key, value] of [
    ["username", "other"],
    ["uid", 5102],
    ["gid", 80],
    ["home", "/Users/other"],
  ])
    refuse((m) => (m.operator[key] = value), /another account/);
  refuse((m) => (m.operator.group = "admin"), /primary group changed/);
  assert.throws(
    () => reviewedLayout(manifest(), { ...anchor, group: "admin" }),
    /primary group changed/,
  );
  // The frozen operator is checked against the policy itself.
  for (const [alter, code] of [
    [(m) => (m.operator.uid = 0), "HL_IDENTITY_ROOT"],
    [(m) => (m.operator.uid = 401), "HL_IDENTITY_SERVICE"],
    [(m) => (m.operator.username = "_agentplatformci"), "HL_IDENTITY_NAME"],
    [(m) => (m.operator.home = "/Users/x/../y"), "HL_IDENTITY_HOME"],
    [(m) => delete m.operator, "HL_IDENTITY_PASSWD"],
  ]) {
    const value = manifest();
    alter(value);
    await refused(async () => reviewedLayout(value, anchor), code);
  }
  // Derived fields cannot be edited on their own.
  for (const alter of [
    (m) => (m.hostLayout.privateDir = "/tmp/elsewhere"),
    (m) => (m.hostLayout.bootReview = "/tmp/review"),
    (m) => (m.hostLayout.colima = "/tmp/colima"),
    (m) => (m.hostLayout.launchdPath = "/tmp:/usr/bin:/bin"),
    (m) =>
      (m.hostLayout.profiles.build.label =
        DEFAULT_LAUNCHD_LABEL_PREFIX + "agent-platform-runtime"),
    (m) => (m.hostLayout.profiles.jenkins.log = "/tmp/log"),
    (m) => (m.hostLayout.operator.uid = 5102),
    (m) => (m.hostLayout.schemaVersion = 2),
    (m) => (m.hostLayout.extra = true),
  ]) {
    const value = manifest();
    alter(value);
    await refused(
      async () => reviewedLayout(value, anchor),
      "HL_LAYOUT_CHANGED",
    );
  }
  // Overridable values pass the same validation as host-layout.json.
  for (const [key, value] of [
    ["homebrewPrefix", "/opt/homebrew/../evil"],
    ["homebrewPrefix", "relative/brew"],
    ["launchdLabelPrefix", "com.example/../evil."],
    ["launchdLabelPrefix", "Com.Example."],
    ["privateDir", "/tmp/p"],
  ]) {
    const frozen = manifest();
    frozen.hostLayout.overrides[key] = value;
    await refused(
      async () => reviewedLayout(frozen, anchor),
      key === "privateDir" ? "HL_OVERRIDE_SCHEMA" : "HL_OVERRIDE_VALUE",
    );
  }
  for (const overrides of [null, undefined, [], "x"]) {
    const frozen = manifest();
    frozen.hostLayout.overrides = overrides;
    assert.throws(
      () => reviewedLayout(frozen, anchor),
      /no frozen host layout/,
    );
  }
  // A consistent override frozen at prepare is the operator's choice.
  const moved = layoutFor(OPERATOR, { homebrewPrefix: "/usr/local" });
  assert.equal(
    reviewedLayout({ ...manifest(), hostLayout: layoutRecord(moved) }, anchor)
      .colima,
    "/usr/local/bin/colima",
  );
});

// Minimal system for the identity checks: no file system access at all.
function identitySystem({ uid = 0, platform = "darwin", accounts }) {
  const calls = [];
  return {
    calls,
    sys: {
      platform,
      arch: "arm64",
      nodeVersion: "22.23.3",
      execPath: NODE,
      getuid: () => uid,
      geteuid: () => uid,
      userInfo: () => OPERATOR,
      run: async (file, args) => {
        calls.push([file, ...args]);
        const account = accounts[args[2]];
        if (file !== "/usr/bin/id" || args[0] !== "-P" || !account)
          return { code: 1, signal: null, stdout: "", stderr: "no such user" };
        return {
          code: 0,
          signal: null,
          stdout: `${args[2]}:********:${account.uid}:${account.gid}::0:0:${args[2]}:${account.home}:/bin/zsh\n`,
          stderr: "",
        };
      },
    },
  };
}

test("as root, only the sudo invoker anchored to passwd is trusted", async () => {
  const accounts = {
    operator: { uid: 5101, gid: 20, home: "/Users/operator" },
    other: { uid: 5102, gid: 20, home: "/Users/other" },
    svc: { uid: 400, gid: 400, home: "/var/empty" },
  };
  const root = identitySystem({ accounts });
  const env = { SUDO_UID: "5101", SUDO_USER: "operator" };
  assert.deepEqual(
    { ...(await invoker(true, { sys: root.sys, env })) },
    anchored(),
  );
  assert.deepEqual(root.calls, [["/usr/bin/id", "-P", "--", "operator"]]);
  for (const [sudo, code] of [
    [{ SUDO_UID: "5102", SUDO_USER: "operator" }, "HL_SUDO"],
    [{ SUDO_UID: "5101", SUDO_USER: "other" }, "HL_SUDO"],
    [{ SUDO_UID: "0", SUDO_USER: "operator" }, "HL_SUDO"],
    [{ SUDO_UID: "05101", SUDO_USER: "operator" }, "HL_SUDO"],
    [{ SUDO_UID: "5101 ", SUDO_USER: "operator" }, "HL_SUDO"],
    [{ SUDO_USER: "operator" }, "HL_SUDO"],
    [{ SUDO_UID: "5101" }, "HL_SUDO"],
    [{ SUDO_UID: "5101", SUDO_USER: "_operator" }, "HL_SUDO"],
    [{ SUDO_UID: "5101", SUDO_USER: "-P" }, "HL_SUDO"],
    [{ SUDO_UID: "5103", SUDO_USER: "ghost" }, "HL_IDENTITY_PASSWD"],
    [{ SUDO_UID: "400", SUDO_USER: "svc" }, "HL_IDENTITY_SERVICE"],
  ])
    await refused(
      () => invoker(true, { sys: identitySystem({ accounts }).sys, env: sudo }),
      code,
    );
  // Not root: refused before any lookup.
  const user = identitySystem({ uid: 5101, accounts });
  await assert.rejects(
    invoker(true, { sys: user.sys, env }),
    /Run reviewed installation with sudo/,
  );
  assert.deepEqual(user.calls, []);
  // apply-user: the passwd account of the process, never root.
  assert.deepEqual(
    { ...(await invoker(false, { sys: user.sys, env: {} })) },
    anchored(),
  );
  await refused(
    () => invoker(false, { sys: root.sys, env: {} }),
    "HL_IDENTITY_ROOT",
  );
  const linux = identitySystem({ platform: "linux", accounts });
  await refused(() => invoker(true, { sys: linux.sys, env }), "HL_PLATFORM");
  assert.deepEqual(linux.calls, []);
});

test("review files are read without following links, as the owner's single-link files", async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "bootstrap-host-review-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const uid = process.getuid();
  const file = join(dir, "review.json");
  await fs.writeFile(file, '{"schemaVersion":2}', { mode: 0o600 });
  assert.equal(String(await ownedFile(file, uid)), '{"schemaVersion":2}');
  await assert.rejects(ownedFile(file, uid + 1), /identity changed/);
  await fs.symlink(file, join(dir, "link"));
  await assert.rejects(ownedFile(join(dir, "link"), uid), /identity changed/);
  await fs.link(file, join(dir, "second"));
  await assert.rejects(ownedFile(file, uid), /identity changed/);
  await fs.rm(join(dir, "second"));
  await fs.chmod(file, 0o620);
  await assert.rejects(ownedFile(file, uid), /identity changed/);
  await fs.chmod(file, 0o644);
  assert.ok(await ownedFile(file, uid));
  await fs.mkdir(join(dir, "folder"));
  await assert.rejects(ownedFile(join(dir, "folder"), uid), /identity changed/);
  const fifo = spawnSync("mkfifo", [join(dir, "fifo")]);
  if (fifo.status === 0)
    await assert.rejects(ownedFile(join(dir, "fifo"), uid), /identity changed/);
  await assert.rejects(ownedFile(join(dir, "absent"), uid), { code: "ENOENT" });
});

// A sandbox operator home under /tmp (its ancestors are root's or sticky):
// real files for everything the operator owns, injected answers for the
// Homebrew colima, ACL listings, id, plutil, launchctl and /Library.
async function sandbox(t) {
  const uid = process.getuid?.();
  if (!(uid >= 501)) {
    t.skip("needs a non-system UID to own the temporary home");
    return null;
  }
  const tmp = await fs.stat("/tmp");
  if (tmp.uid !== 0 || !(tmp.mode & 0o1000)) {
    t.skip("/tmp is not root's sticky directory");
    return null;
  }
  const home = await fs.realpath(await fs.mkdtemp("/tmp/boot-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const operator = {
    username: "operator",
    uid,
    gid: process.getgid(),
    homedir: home,
  };
  const layout = layoutFor(operator);
  const mkdir = async (path, mode) => {
    await fs.mkdir(path, { mode });
    await fs.chmod(path, mode);
  };
  await fs.chmod(home, 0o750);
  await mkdir(`${home}/.local`, 0o755);
  await mkdir(`${home}/.local/share`, 0o755);
  await mkdir(layout.privateDir, 0o700);
  await mkdir(layout.colimaHome, 0o755);
  for (const key of PROFILE_KEYS) {
    await mkdir(layout.profiles[key].directory, 0o755);
    await fs.writeFile(layout.profiles[key].colimaYaml, `# ${key}\n`);
    await fs.chmod(layout.profiles[key].colimaYaml, 0o644);
  }
  const state = {
    colima: "colima 0.10.3",
    group: "staff",
    loaded: new Set(),
    commands: [],
    plists: {},
  };
  const real = nodeSystem();
  const brew = {
    "/opt": { dir: true, uid: 0 },
    "/opt/homebrew": { dir: true, uid },
    "/opt/homebrew/bin": { dir: true, uid },
    "/opt/homebrew/bin/colima": { dir: false, uid },
  };
  const statOf = (path) => {
    const entry = brew[path];
    return {
      dev: 4242,
      ino: Object.keys(brew).indexOf(path) + 1,
      uid: entry.uid,
      gid: entry.uid === 0 ? 0 : 20,
      mode: (entry.dir ? 0o040000 : 0o100000) | 0o755,
      nlink: 1,
      size: entry.dir ? 64 : state.colima.length,
      mtimeMs: 1,
      ctimeMs: 1,
      isFile: () => !entry.dir,
      isDirectory: () => entry.dir,
      isSymbolicLink: () => false,
      isSocket: () => false,
    };
  };
  const answer = (stdout, code = 0) => ({
    code,
    signal: null,
    stdout,
    stderr: "",
  });
  const sys = nodeSystem({
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "22.23.3",
    execPath: NODE,
    getuid: () => state.uid ?? uid,
    geteuid: () => state.uid ?? uid,
    userInfo: () => state.user ?? operator,
    colimaHome: () => undefined,
    lstat: async (path) => (brew[path] ? statOf(path) : real.lstat(path)),
    open: async (path, flags) =>
      brew[path]
        ? {
            stat: async () => statOf(path),
            readFile: async () => Buffer.from(state.colima),
            close: async () => {},
          }
        : real.open(path, flags),
    // The machine's own LaunchDaemons are never consulted.
    readdir: async (path) =>
      path === layout.launchDaemons ? [] : real.readdir(path),
    run: async (file, args) => {
      if (file === "/bin/ls") return answer(`entry ${args[2]}\n`);
      if (file === "/usr/bin/id" && args[2] === "operator") {
        if (args[0] === "-gn") return answer(`${state.group}\n`);
        if (args[0] === "-g") return answer(`${operator.gid}\n`);
        if (args[0] === "-P")
          return answer(
            `operator:********:${uid}:${operator.gid}::0:0:Operator:${home}:/bin/zsh\n`,
          );
      }
      return answer("", 1);
    },
  });
  const command = async (program, args) => {
    state.commands.push([program, ...args]);
    if (program === "/usr/bin/plutil" && args[0] === "-lint")
      return `${args[1]}: OK\n`;
    if (program === "/usr/bin/plutil" && args[0] === "-convert") {
      if (!state.plists[args[5]]) throw Error("plutil failed (1)");
      return JSON.stringify(state.plists[args[5]]);
    }
    if (program === "/bin/launchctl") {
      if (args[0] === "print") {
        if (state.loaded.has(args[1])) return "state = running\n";
        throw Error("/bin/launchctl failed (113)");
      }
      if (args[0] === "bootstrap")
        state.loaded.add(`${args[1]}/${basename(args[2], ".plist")}`);
      return "";
    }
    throw Error(`Unexpected command ${program}`);
  };
  const review = layout.bootReview;
  return {
    home,
    uid,
    operator,
    layout,
    state,
    review,
    options: { sys, command, script: join(review, "bootstrap-host.mjs") },
  };
}

const launchctl = (state) =>
  state.commands.filter(([program]) => program === "/bin/launchctl");

test("prepare freezes the operator, the layout and colima, and stages exactly what apply installs", async (t) => {
  const s = await sandbox(t);
  if (!s) return;
  const prepared = await main("prepare", s.options);
  assert.deepEqual(prepared, {
    state: "prepared",
    review: s.review,
    operator: "operator",
    installerSha256: digest(
      await fs.readFile(join(source, "bootstrap-host.mjs")),
    ),
    layoutModuleSha256: digest(
      await fs.readFile(join(source, "host-layout.mjs")),
    ),
    profileCount: 3,
    configurationUnchanged: true,
  });
  const manifest = JSON.parse(
    await fs.readFile(join(s.review, "review.json"), "utf8"),
  );
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.operator, {
    ...anchored(s.operator),
    group: "staff",
  });
  assert.deepEqual(manifest.hostLayout, layoutRecord(s.layout));
  assert.deepEqual(manifest.colima, {
    path: "/opt/homebrew/bin/colima",
    realpath: "/opt/homebrew/bin/colima",
    sha256: digest("colima 0.10.3"),
  });
  for (const key of PROFILE_KEYS)
    assert.equal(
      manifest.profileConfigurations[`agent-platform-${key}`],
      digest(`# ${key}\n`),
    );
  for (const system of [false, true])
    for (const [label, bytes] of Object.entries(
      render(system, s.layout, "staff"),
    )) {
      const relative = `${system ? "system" : "user"}/${label}.plist`;
      assert.equal(await fs.readFile(join(s.review, relative), "utf8"), bytes);
      assert.equal(manifest.files[relative], digest(bytes));
    }
  assert.equal(Object.keys(manifest.files).length, 6);
  for (const [name, field] of [
    ["bootstrap-host.mjs", "installerSha256"],
    ["host-layout.mjs", "layoutModuleSha256"],
  ]) {
    const copy = await fs.readFile(join(s.review, name));
    assert.deepEqual(copy, await fs.readFile(join(source, name)));
    assert.equal(manifest[field], digest(copy));
  }
  for (const folder of ["", "logs", "system", "user"])
    assert.equal(
      (await fs.lstat(join(s.review, folder))).mode & 0o777,
      0o700,
      folder,
    );
  assert.equal(
    (await fs.lstat(join(s.review, "review.json"))).mode & 0o777,
    0o600,
  );
  assert.equal(
    s.state.commands.filter(([, verb]) => verb === "-lint").length,
    6,
  );
  assert.deepEqual(launchctl(s.state), []);
});

test("prepare runs as the operator only and writes the review into a private directory only", async (t) => {
  const cases = {
    root: [
      (s) => {
        s.state.uid = 0;
      },
      "HL_IDENTITY_ROOT",
    ],
    "private directory open to others": [
      (s) => fs.chmod(s.layout.privateDir, 0o755),
      "HL_PRIVATE_DIR",
    ],
    "review directory open to others": [
      async (s) => {
        await fs.mkdir(s.review, { mode: 0o700 });
        await fs.chmod(s.review, 0o750);
      },
      /private directories/,
    ],
    "colima.yaml writable by the group": [
      (s) => fs.chmod(s.layout.profiles.build.colimaYaml, 0o664),
      "HL_FILE",
    ],
    "COLIMA_HOME elsewhere": [
      (s) => {
        s.options.sys.colimaHome = () => "/tmp/other-colima";
      },
      "HL_COLIMA_HOME",
    ],
  };
  for (const [name, [alter, expected]] of Object.entries(cases)) {
    const s = await sandbox(t);
    if (!s) return;
    await alter(s);
    await assert.rejects(main("prepare", s.options), (error) => {
      if (typeof expected === "string")
        assert.equal(error.code, expected, `${name}: ${error.message}`);
      else assert.match(error.message, expected, name);
      return true;
    });
    await assert.rejects(fs.lstat(join(s.review, "review.json")), {
      code: "ENOENT",
    });
    assert.deepEqual(s.state.commands, [], name);
  }
});

test("apply-user installs the reviewed definitions once and is idempotent", async (t) => {
  const s = await sandbox(t);
  if (!s) return;
  await main("prepare", s.options);
  const result = await main("apply-user", s.options);
  assert.deepEqual(result, {
    state: "login-engine-services-installed",
    profileCount: 3,
    domain: `gui/${s.uid}`,
    applicationStartup: "Docker restart unless-stopped",
    productionApiOrTunnelStopped: false,
  });
  const agents = s.layout.launchAgents;
  for (const [label, bytes] of Object.entries(render(false, s.layout))) {
    const file = join(agents, `${label}.plist`);
    assert.equal(await fs.readFile(file, "utf8"), bytes);
    assert.equal((await fs.lstat(file)).mode & 0o777, 0o644);
  }
  assert.deepEqual(
    launchctl(s.state).map(([, verb, target]) => [verb, target]),
    PROFILES.flatMap((name) => {
      const target = `gui/${s.uid}/${DEFAULT_LAUNCHD_LABEL_PREFIX}${name}`;
      return [
        ["enable", target],
        ["print", target],
        ["bootstrap", `gui/${s.uid}`],
      ];
    }),
  );
  s.state.commands.length = 0;
  await main("apply-user", s.options);
  assert.deepEqual(
    launchctl(s.state).map(([, verb]) => verb),
    ["enable", "print", "enable", "print", "enable", "print"],
  );
});

test("apply-system and apply-user refuse before any launchd change when the review, the account or the machine drifted", async (t) => {
  const cases = {
    "run from the repository copy": [
      (s) => {
        s.options.script = join(source, "bootstrap-host.mjs");
      },
      /Run the reviewed copy/,
    ],
    "another account runs it": [
      (s) => {
        s.state.uid = s.uid + 1;
        s.state.user = { ...s.operator, uid: s.uid + 1 };
      },
      "HL_OWNER_CHAIN",
    ],
    "review directory open to others": [
      (s) => fs.chmod(s.review, 0o755),
      /private directories/,
    ],
    "frozen operator edited": [
      (s) =>
        editReview(s, (m) => {
          m.operator.username = "other";
        }),
      /another account/,
    ],
    "frozen derived field edited": [
      (s) =>
        editReview(s, (m) => {
          m.hostLayout.launchdPath = "/tmp:/usr/bin:/bin:/usr/sbin:/sbin";
        }),
      "HL_LAYOUT_CHANGED",
    ],
    "schema 1 review": [
      (s) =>
        editReview(s, (m) => {
          m.schemaVersion = 1;
        }),
      /schema 2/,
    ],
    "review.json hard-linked": [
      (s) => fs.link(join(s.review, "review.json"), join(s.home, "linked")),
      /identity changed/,
    ],
    "installer copy changed": [
      (s) => fs.appendFile(join(s.review, "bootstrap-host.mjs"), "\n"),
      /Reviewed installer changed/,
    ],
    "host-layout copy changed": [
      (s) => fs.appendFile(join(s.review, "host-layout.mjs"), "\n"),
      /Reviewed installer changed/,
    ],
    "primary group changed": [
      (s) => {
        s.state.group = "admin";
      },
      /primary group changed/,
    ],
    "colima binary replaced": [
      (s) => {
        s.state.colima = "colima 0.11.0";
      },
      /colima changed since prepare/,
    ],
    "colima.yaml edited": [
      (s) => fs.appendFile(s.layout.profiles.runtime.colimaYaml, "cpu: 8\n"),
      /Engine configuration changed; prepare again/,
    ],
    "staged plist edited": [
      (s) =>
        fs.appendFile(
          join(s.review, "user", `${s.layout.profiles.jenkins.label}.plist`),
          "\n",
        ),
      /Reviewed service definition changed/,
    ],
    "another definition starts a profile": [
      async (s) => {
        const file = join(s.layout.launchAgents, "org.example.vm.plist");
        await fs.mkdir(s.layout.launchAgents, { recursive: true });
        await fs.writeFile(file, "<plist>agent-platform-build</plist>");
        s.state.plists[file] = {
          ProgramArguments: [
            "/usr/local/bin/colima",
            "--profile=agent-platform-build",
          ],
        };
      },
      /Other launchd definitions start the same Colima profiles/,
    ],
    "unreadable definition naming a profile": [
      async (s) => {
        await fs.mkdir(s.layout.launchAgents, { recursive: true });
        await fs.writeFile(
          join(s.layout.launchAgents, "org.example.odd.plist"),
          "agent-platform-runtime",
        );
      },
      /Other launchd definitions/,
    ],
    "installed definition differs": [
      async (s) => {
        await fs.mkdir(s.layout.launchAgents, { recursive: true });
        await fs.writeFile(
          join(
            s.layout.launchAgents,
            `${s.layout.profiles.jenkins.label}.plist`,
          ),
          "<plist/>\n",
        );
      },
      /differs; review required/,
    ],
  };
  for (const [name, [alter, expected]] of Object.entries(cases)) {
    const s = await sandbox(t);
    if (!s) return;
    await main("prepare", s.options);
    s.state.commands.length = 0;
    await alter(s);
    await assert.rejects(main("apply-user", s.options), (error) => {
      if (typeof expected === "string")
        assert.equal(error.code, expected, `${name}: ${error.message}`);
      else assert.match(error.message, expected, name);
      return true;
    });
    assert.deepEqual(launchctl(s.state), [], name);
  }
  // A harmless definition that only mentions a profile name is not a duplicate.
  const s = await sandbox(t);
  if (!s) return;
  await main("prepare", s.options);
  const note = join(s.layout.launchAgents, "org.example.backup.plist");
  await fs.mkdir(s.layout.launchAgents, { recursive: true });
  await fs.writeFile(note, "agent-platform-build-backup");
  s.state.plists[note] = {
    ProgramArguments: ["/usr/bin/true", "agent-platform-build-backup"],
  };
  await main("apply-user", s.options);
});

async function editReview(s, alter) {
  const file = join(s.review, "review.json");
  const manifest = JSON.parse(await fs.readFile(file, "utf8"));
  alter(manifest);
  await fs.writeFile(file, JSON.stringify(manifest, null, 2) + "\n");
}

test("the root side anchors the sudo invoker, then checks the review it owns before parsing it", async (t) => {
  const s = await sandbox(t);
  if (!s) return;
  await main("prepare", s.options);
  // Not root: refused before anything is read.
  await assert.rejects(
    main("apply-system", s.options),
    /Run reviewed installation with sudo/,
  );
  s.state.uid = 0;
  const env = { SUDO_UID: String(s.uid), SUDO_USER: "operator" };
  const operator = await invoker(true, { sys: s.options.sys, env });
  assert.deepEqual({ ...operator }, anchored(s.operator));
  const opened = await openReview(operator, s.options);
  assert.equal(opened.review, s.review);
  assert.equal(opened.group, "staff");
  assert.deepEqual(layoutRecord(opened.layout), layoutRecord(s.layout));
  await refused(
    () =>
      invoker(true, {
        sys: s.options.sys,
        env: { SUDO_UID: String(s.uid + 1), SUDO_USER: "operator" },
      }),
    "HL_SUDO",
  );
  // The review belongs to the anchored account or it is not read at all.
  const stranger = { ...operator, uid: s.uid + 1 };
  await refused(() => openReview(stranger, s.options), "HL_OWNER_CHAIN");
  await editReview(s, (m) => {
    m.hostLayout.privateDir = "/tmp/elsewhere";
  });
  await refused(() => openReview(operator, s.options), "HL_LAYOUT_CHANGED");
});

test("the installer CLI accepts only its three actions", () => {
  const run = (...args) =>
    spawnSync(process.execPath, [join(source, "bootstrap-host.mjs"), ...args], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 30_000,
    });
  for (const args of [[], ["bogus"], ["apply"]]) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr.trim(),
      "Use prepare, apply-user or apply-system",
    );
    assert.equal(result.stdout, "");
  }
});
