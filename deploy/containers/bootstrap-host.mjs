// Three fixed host engine entries. Application, Tunnel and Jenkins live in Docker.
//
//   node deploy/containers/bootstrap-host.mjs prepare            (as the operator)
//   sudo node <privateDir>/container-boot/bootstrap-host.mjs apply-system
//
// Every host value comes from ./host-layout.mjs. prepare writes the review
// directory <privateDir>/container-boot: the rendered plists, copies of this
// installer and host-layout.mjs, and review.json, which freezes the operator
// (with its primary group), the derived layout and the colima binary. apply
// runs only from that copy. As root it anchors the operator to the sudo
// invoker's passwd record before anything in the review is read, and requires
// the frozen values to match it. The frozen digests catch drift; they are no
// boundary against the operator, who owns every reviewed file.
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PROFILES,
  PROFILE_KEYS,
  REQUIRES,
  assertOperatorRecord,
  assertPlatform,
  assertSameLayout,
  assertTrustedExecutable,
  layoutRecord,
  loadHostLayout,
  nodeSystem,
  operatorGroupName,
  resolveHostLayout,
  runningOperator,
  sudoOperator,
  verifyHostLayout,
} from "./host-layout.mjs";

export const REVIEW_SCHEMA_VERSION = 2;
const LABEL_PREFIX = /^[a-z0-9]+(\.[a-z0-9-]+)+\.$/;
const GROUP_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const PLIST_HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">';
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const escape = (s) =>
  String(s).replace(
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
function xml(v) {
  if (typeof v === "string") return `<string>${escape(v)}</string>`;
  if (typeof v === "boolean") return v ? "<true/>" : "<false/>";
  if (typeof v === "number") return `<integer>${v}</integer>`;
  if (Array.isArray(v)) return `<array>${v.map(xml).join("")}</array>`;
  return `<dict>${Object.entries(v)
    .map(([k, x]) => `<key>${escape(k)}</key>${xml(x)}`)
    .join("")}</dict>`;
}

// Primary group of the operator (staff on a default Mac), cross-checked with
// its GID; for callers that render from a layout alone (host-layout doctor).
function primaryGroup(operator) {
  const id = (option) =>
    spawnSync("/usr/bin/id", [option, "--", operator.username], {
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      encoding: "utf8",
      timeout: 15_000,
    });
  const name = id("-gn"),
    gid = id("-g");
  const group = name.stdout?.trim() ?? "";
  if (
    name.status !== 0 ||
    gid.status !== 0 ||
    !GROUP_NAME.test(group) ||
    gid.stdout.trim() !== String(operator.gid)
  )
    throw Error("Primary group of the operator could not be confirmed");
  return group;
}

// layout: from host-layout.mjs with host-layout.json consulted. group: the
// operator's primary group, looked up when a system definition needs it.
export function definitions(system = false, layout, group) {
  if (!layout?.colima || !layout.launchdPath || !layout.launchdLabelPrefix)
    throw Error("Render needs a host layout derived with host-layout.json");
  const groupName = system ? (group ?? primaryGroup(layout.operator)) : null;
  if (system && !(typeof groupName === "string" && GROUP_NAME.test(groupName)))
    throw Error("Render needs the operator's primary group");
  return PROFILE_KEYS.map((key) => {
    const profile = layout.profiles[key];
    return {
      Label: profile.label,
      ...(system
        ? { UserName: layout.operator.username, GroupName: groupName }
        : {}),
      ProgramArguments: [
        layout.colima,
        "--profile",
        profile.name,
        "start",
        "--foreground",
        "--activate=false",
        "--save-config=false",
        "--ssh-agent=false",
        "--ssh-config=false",
      ],
      WorkingDirectory: layout.operator.home,
      EnvironmentVariables: {
        HOME: layout.operator.home,
        PATH: layout.launchdPath,
        LANG: "en_US.UTF-8",
        DOCKER_CONFIG: layout.dockerConfig,
      },
      RunAtLoad: true,
      StartInterval: 60,
      KeepAlive: { SuccessfulExit: false },
      ThrottleInterval: 30,
      ExitTimeOut: 90,
      Umask: 63,
      StandardOutPath: profile.log,
      StandardErrorPath: profile.log,
    };
  });
}
// {Label: plist text}. prepare and apply pass the group they verified.
export function render(system = false, layout, group) {
  return Object.fromEntries(
    definitions(system, layout, group).map((s) => [
      s.Label,
      PLIST_HEADER + xml(s) + "</plist>\n",
    ]),
  );
}

async function command(program, args) {
  return new Promise((accept, reject) => {
    const p = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "",
      err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.once("error", reject);
    p.once("exit", (code) =>
      code === 0
        ? accept(out)
        : reject(Error(`${program} failed (${code}): ${err.slice(-1000)}`)),
    );
  });
}

// O_NOFOLLOW + fstat: uid's single-link regular file, not writable by group
// or others.
export async function ownedFile(path, uid, { sys = nodeSystem() } = {}) {
  const changed = () => Error("Boot review file identity changed");
  const before = await sys.lstat(path);
  if (!before.isFile()) throw changed();
  let handle;
  try {
    handle = await sys.open(path, READ_FLAGS);
  } catch {
    throw changed();
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.uid !== uid ||
      stat.mode & 0o022 ||
      stat.nlink !== 1 ||
      stat.size > 2_000_000
    )
      throw changed();
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) throw changed();
    return bytes;
  } finally {
    await handle.close();
  }
}

async function reviewFolder(path, uid, sys) {
  const stat = await sys.lstat(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== uid ||
    stat.mode & 0o077
  )
    throw Error(
      "Review directories must be the operator's private directories",
    );
}

// The frozen review must name exactly the anchored operator and its group;
// every derived field must follow from them and the frozen overridable values.
export function reviewedLayout(manifest, { operator, group }) {
  if (manifest?.schemaVersion !== REVIEW_SCHEMA_VERSION)
    throw Error(
      `Review is not schema ${REVIEW_SCHEMA_VERSION}; run prepare again`,
    );
  const frozen = manifest.operator;
  assertOperatorRecord(frozen);
  for (const key of ["username", "uid", "gid", "home"])
    if (frozen[key] !== operator[key])
      throw Error("The review was prepared for another account");
  if (frozen.group !== group)
    throw Error("The operator's primary group changed since prepare");
  const recorded = manifest.hostLayout;
  if (
    !recorded?.overrides ||
    typeof recorded.overrides !== "object" ||
    Array.isArray(recorded.overrides)
  )
    throw Error("Review has no frozen host layout; run prepare again");
  const layout = resolveHostLayout({
    identity: operator,
    execPath: recorded.node,
    overrides: recorded.overrides,
  });
  assertSameLayout(recorded, layout);
  if (!LABEL_PREFIX.test(layout.launchdLabelPrefix))
    throw Error("LaunchDaemon label prefix refused");
  return layout;
}

// The account the services are installed for. As root that is only the sudo
// invoker anchored to passwd, never a value read from the review.
export async function invoker(
  system,
  { sys = nodeSystem(), env = process.env } = {},
) {
  assertPlatform(sys);
  if (!system) return runningOperator(sys);
  if (sys.getuid() !== 0 || sys.geteuid() !== 0)
    throw Error("Run reviewed installation with sudo");
  return sudoOperator(
    { sudoUid: env.SUDO_UID, sudoUser: env.SUDO_USER },
    { sys },
  );
}

// Nothing in the review is parsed before its directory and review.json proved
// to be the operator's; the running installer must be the reviewed copy.
export async function openReview(
  operator,
  { sys = nodeSystem(), script = fileURLToPath(import.meta.url) } = {},
) {
  const anchor = resolveHostLayout({
    identity: operator,
    execPath: sys.execPath,
    overrides: null,
  });
  const review = anchor.bootReview;
  const installer = join(review, "bootstrap-host.mjs");
  if ((await fs.realpath(script)) !== installer)
    throw Error(`Run the reviewed copy ${installer}`);
  await verifyHostLayout(anchor, ["privateDir"], { sys });
  for (const folder of [review, join(review, "system"), join(review, "user")])
    await reviewFolder(folder, operator.uid, sys);
  const read = (name) => ownedFile(join(review, name), operator.uid, { sys });
  let manifest;
  try {
    manifest = JSON.parse((await read("review.json")).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw Error("review.json is not valid JSON; run prepare again");
    throw error;
  }
  const group = await operatorGroupName(operator, { sys });
  const layout = reviewedLayout(manifest, { operator, group });
  if (
    digest(await read("bootstrap-host.mjs")) !== manifest.installerSha256 ||
    digest(await read("host-layout.mjs")) !== manifest.layoutModuleSha256
  )
    throw Error("Reviewed installer changed");
  return { review, manifest, layout, group };
}

// A plist that starts one of the three profiles under another label, or in
// the other launchd domain, would run a second colima for the same VM.
async function noOtherDefinitions(layout, ours, { sys, run }) {
  const found = [];
  for (const directory of [layout.launchDaemons, layout.launchAgents]) {
    let names;
    try {
      names = await sys.readdir(directory);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const name of [...names].sort()) {
      const file = join(directory, name);
      if (!name.endsWith(".plist") || ours.has(file)) continue;
      const stat = await sys.lstat(file);
      if (!stat.isFile() || stat.size > 1_000_000) continue;
      const text = (await sys.readFile(file)).toString("latin1");
      if (!PROFILES.some((profile) => text.includes(profile))) continue;
      let args = null;
      try {
        args = JSON.parse(
          await run("/usr/bin/plutil", [
            "-convert",
            "json",
            "-o",
            "-",
            "--",
            file,
          ]),
        ).ProgramArguments;
      } catch {
        // Unreadable but naming a profile: treated as starting it.
      }
      if (
        args === null ||
        (Array.isArray(args) &&
          PROFILES.some(
            (profile) =>
              args.includes(profile) || args.includes(`--profile=${profile}`),
          ))
      )
        found.push(file);
    }
  }
  if (found.length)
    throw Error(
      `Other launchd definitions start the same Colima profiles; remove them first: ${found.join(", ")}`,
    );
}

async function prepare({ sys = nodeSystem(), command: run = command } = {}) {
  // As the operator (never root). The review is written into the private
  // directory, so that is checked as well.
  const layout = await loadHostLayout({
    requires: [...REQUIRES["bootstrap-prepare"], "privateDir"],
    sys,
  });
  const { operator } = layout;
  const group = await operatorGroupName(operator, { sys });
  const colima = await assertTrustedExecutable(layout.colima, operator, {
    sys,
    hash: true,
  });
  const review = layout.bootReview;
  for (const folder of [
    review,
    layout.bootLogs,
    join(review, "system"),
    join(review, "user"),
  ]) {
    await fs.mkdir(folder, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    await reviewFolder(folder, operator.uid, sys);
  }
  const manifest = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    operator: { ...operator, group },
    hostLayout: layoutRecord(layout),
    colima: {
      path: colima.path,
      realpath: colima.realpath,
      sha256: colima.sha256,
    },
    profileConfigurations: {},
    files: {},
    applicationsInDocker: true,
    systemInstallationRequiresAdministrator: true,
  };
  for (const key of PROFILE_KEYS) {
    const profile = layout.profiles[key];
    manifest.profileConfigurations[profile.name] = digest(
      await ownedFile(profile.colimaYaml, operator.uid, { sys }),
    );
  }
  for (const system of [false, true]) {
    const folder = system ? "system" : "user";
    for (const [label, bytes] of Object.entries(
      render(system, layout, group),
    )) {
      const file = join(review, folder, label + ".plist");
      await fs.writeFile(file, bytes, { mode: 0o600 });
      await run("/usr/bin/plutil", ["-lint", file]);
      manifest.files[`${folder}/${label}.plist`] = digest(bytes);
    }
  }
  // apply runs from these copies only.
  for (const [name, source, field] of [
    ["bootstrap-host.mjs", new URL(import.meta.url), "installerSha256"],
    [
      "host-layout.mjs",
      new URL("./host-layout.mjs", import.meta.url),
      "layoutModuleSha256",
    ],
  ]) {
    const bytes = await fs.readFile(source);
    await fs.writeFile(join(review, name), bytes, { mode: 0o600 });
    manifest[field] = digest(bytes);
  }
  await fs.writeFile(
    join(review, "review.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { mode: 0o600 },
  );
  return {
    state: "prepared",
    review,
    operator: operator.username,
    installerSha256: manifest.installerSha256,
    layoutModuleSha256: manifest.layoutModuleSha256,
    profileCount: 3,
    configurationUnchanged: true,
  };
}

async function apply(
  system,
  {
    sys = nodeSystem(),
    env = process.env,
    command: run = command,
    script,
  } = {},
) {
  const operator = await invoker(system, { sys, env });
  const { review, manifest, layout, group } = await openReview(operator, {
    sys,
    script,
  });
  // The colima binary and the PATH the services will run with, checked again
  // here (as root for apply-system).
  await verifyHostLayout(layout, "bootstrap-apply-system", { sys });
  const colima = await assertTrustedExecutable(layout.colima, operator, {
    sys,
    hash: true,
  });
  if (
    colima.realpath !== manifest.colima?.realpath ||
    colima.sha256 !== manifest.colima?.sha256
  )
    throw Error("colima changed since prepare; prepare again");
  for (const key of PROFILE_KEYS) {
    const profile = layout.profiles[key];
    if (
      digest(await ownedFile(profile.colimaYaml, operator.uid, { sys })) !==
      manifest.profileConfigurations?.[profile.name]
    )
      throw Error("Engine configuration changed; prepare again");
  }
  const directory = system ? layout.launchDaemons : layout.launchAgents;
  if (!system) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = await sys.lstat(directory);
  if (
    !target.isDirectory() ||
    target.isSymbolicLink() ||
    target.uid !== (system ? 0 : operator.uid) ||
    target.mode & 0o022
  )
    throw Error("Unsafe launchd destination");
  const services = render(system, layout, group);
  await noOtherDefinitions(
    layout,
    new Set(
      Object.keys(services).map((label) => join(directory, label + ".plist")),
    ),
    { sys, run },
  );
  for (const [label, expected] of Object.entries(services)) {
    const relative = `${system ? "system" : "user"}/${label}.plist`;
    const bytes = await ownedFile(join(review, relative), operator.uid, {
      sys,
    });
    if (
      digest(bytes) !== manifest.files?.[relative] ||
      bytes.toString() !== expected
    )
      throw Error("Reviewed service definition changed");
    const file = join(directory, label + ".plist");
    if (dirname(file) !== directory || basename(file) !== label + ".plist")
      throw Error("Unsafe launchd label");
    const prior = await sys.lstat(file).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (prior && (!prior.isFile() || prior.uid !== (system ? 0 : operator.uid)))
      throw Error("Existing service definition has unexpected owner");
    if (prior && (await sys.readFile(file)).toString() !== expected)
      throw Error("Existing container engine service differs; review required");
    if (!prior) {
      await fs.writeFile(file, bytes, { flag: "wx", mode: 0o644 });
      if (system) await fs.chown(file, 0, 0);
    }
    const domain = system ? "system" : layout.userDomain;
    if (system)
      await run("/bin/launchctl", [
        "bootout",
        `${layout.userDomain}/${label}`,
      ]).catch(() => {});
    await run("/bin/launchctl", ["enable", `${domain}/${label}`]);
    const present = await run("/bin/launchctl", [
      "print",
      `${domain}/${label}`,
    ]).then(
      () => true,
      () => false,
    );
    if (!present) await run("/bin/launchctl", ["bootstrap", domain, file]);
  }
  return {
    state: system
      ? "system-engine-services-installed"
      : "login-engine-services-installed",
    profileCount: 3,
    domain: system ? "system" : layout.userDomain,
    applicationStartup: "Docker restart unless-stopped",
    productionApiOrTunnelStopped: false,
  };
}

// options: injected system access for tests; the CLI passes none.
export async function main(action, options = {}) {
  if (action === "prepare") return prepare(options);
  if (action === "apply-user") return apply(false, options);
  if (action === "apply-system") return apply(true, options);
  throw Error("Use prepare, apply-user or apply-system");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main(process.argv[2]).then(
    (r) => console.log(JSON.stringify(r)),
    (e) => {
      console.error(e.message);
      process.exitCode = 1;
    },
  );
