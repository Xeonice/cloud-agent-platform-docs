import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve, basename } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { prepareApiContext } from "./api-context.mjs";

export const ROOT = "/srv/agent-platform/deploy";
export const TOOLS = "/run/agent-platform/jenkins-tools";
export const API = "agent-platform-api";
export const IMAGE = /^sha256:[a-f0-9]{64}$/;
export const SHA = /^[a-f0-9]{40}$/;
export const REPOSITORIES = Object.freeze({
  api: {
    name: "Xeonice/agent-platform-api",
    branch: "feat/design-v2-migration",
  },
  root: {
    name: "Xeonice/cloud-agent-platform-docs",
    branch: "Xeonice/初始化一下项目开发",
  },
});
const docker = "/usr/local/bin/docker";
const spec = ["--host", "unix:///var/run/docker.sock"];
const BLOCKERS = [
  "sandboxes",
  "agentTasks",
  "automationRuns",
  "enabledAutomations",
  "resourceAllocations",
  "cloningProjects",
  "projectCleanupJobs",
];
const LABEL = "com.agent-platform.role";
const SHA_LABEL = "com.agent-platform.api-sha";
const ROOT_LABEL = "com.agent-platform.root-sha";
const SCHEMA_LABEL = "com.agent-platform.schema-fingerprint";
const SAFE_ENV = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/home/jenkins",
  CI: "true",
  LANG: "C.UTF-8",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

export async function privateFile(path, uid = process.getuid()) {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await handle.stat();
    if (
      !s.isFile() ||
      s.nlink !== 1 ||
      s.uid !== uid ||
      s.mode & 0o077 ||
      s.size > 1_000_000
    )
      throw Error("Unsafe private deployment file");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
async function directory(path, { create = false, privateMode = true } = {}) {
  if (create) await fs.mkdir(path, { mode: 0o700 });
  const s = await fs.lstat(path);
  if (
    !s.isDirectory() ||
    s.uid !== process.getuid() ||
    (privateMode && s.mode & 0o077) ||
    (await fs.realpath(path)) !== path
  )
    throw Error("Unsafe deployment directory");
  return path;
}
async function ensureDirectory(path) {
  try {
    return await directory(path, { create: true });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return directory(path);
  }
}
export async function trusted() {
  if (
    process.platform !== "linux" ||
    process.arch !== "arm64" ||
    process.getuid() !== 1000 ||
    process.geteuid() !== 1000 ||
    process.versions.node.split(".")[0] !== "22"
  )
    throw Error("Fixed trusted Linux deployment account required");
  await directory(ROOT);
  await directory(TOOLS);
}
async function atomic(path, data) {
  const temp = path + "." + randomUUID() + ".tmp";
  await fs.writeFile(temp, JSON.stringify(data, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  try {
    await fs.rename(temp, path);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
export async function immutableJson(path, data) {
  const bytes = JSON.stringify(data, null, 2) + "\n";
  try {
    await fs.writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if ((await privateFile(path)) !== bytes)
      throw Error("Immutable deployment metadata conflict");
  }
}
export async function run(
  program,
  args,
  {
    cwd = "/",
    env = SAFE_ENV,
    input,
    quiet = false,
    includeStderr = false,
  } = {},
) {
  return new Promise((accept, reject) => {
    const child = spawn(program, args, {
      cwd,
      env,
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let output = "",
      overflow = false;
    const collect = (bytes) => {
      output += bytes;
      if (output.length > 16_000_000) {
        overflow = true;
        child.kill();
      }
    };
    if (input) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
    child.stdout.on("data", collect);
    child.stderr.on("data", (bytes) => {
      if (includeStderr) collect(bytes);
      else if (!quiet) process.stderr.write(bytes);
    });
    child.once("error", reject);
    child.once("close", (code, signal) =>
      code === 0 && !signal && !overflow
        ? accept(output)
        : reject(Error(`${basename(program)} failed (${code ?? "signal"})`)),
    );
  });
}
export async function digest(path) {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid()
    )
      throw Error("Unsafe artifact file");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk);
    const after = await handle.stat(),
      named = await fs.lstat(path);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      named.ino !== before.ino ||
      named.dev !== before.dev
    )
      throw Error("Artifact changed during verification");
    return { sha256: hash.digest("hex"), sizeBytes: before.size };
  } finally {
    await handle.close();
  }
}
export function buildRequest(sha, runId, rootSha) {
  if (
    !SHA.test(sha ?? "") ||
    !SHA.test(rootSha ?? "") ||
    !/^[1-9]\d{0,9}$/.test(String(runId))
  )
    throw Error("Pinned API/root commits and Jenkins build required");
  return { sha, rootSha, runId: Number(runId) };
}
export function releaseKey(sha, rootSha) {
  if (!SHA.test(sha ?? "") || !SHA.test(rootSha ?? ""))
    throw Error("Pinned release commits required");
  return rootSha + "-" + sha;
}
export function idle(status) {
  return Boolean(
    status?.ready === true &&
    Number.isSafeInteger(status.activeWS) &&
    status.activeWS >= 0 &&
    status.inFlightHTTP === 0 &&
    status.credentialAuth === 0 &&
    status.blockers &&
    Object.keys(status.blockers).length === BLOCKERS.length &&
    BLOCKERS.every((name) => status.blockers[name] === 0),
  );
}
export function runtimePolicy(text) {
  const env = parseEnv(text);
  const origins = (env.API_ALLOWED_ORIGINS ?? "").split(",");
  const originValid = (value) => {
    try {
      const u = new URL(value);
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        u.pathname === "/" &&
        !u.search &&
        !u.hash &&
        !value.includes("*")
      );
    } catch {
      return false;
    }
  };
  if (
    env.HOST !== "127.0.0.1" ||
    env.PORT !== "3101" ||
    env.DATA_ROOT !== "/data" ||
    env.DATABASE_URL !== "/data/platform.db" ||
    env.BOXLITE_HOME !== "/data/boxlite" ||
    env.DEPLOYMENT_DRAIN_FILE !== "/data/deployment-drain" ||
    env.API_TRUST_PROXY !== "cloudflare-loopback" ||
    env.ACCESS_PASSCODE_ALLOW_LOOPBACK !== "false" ||
    env.PASSCODE_COOKIE_SECURE !== "true" ||
    !env.ACCESS_PASSCODE ||
    !env.PASSCODE_COOKIE_SECRET ||
    !origins.every(originValid)
  )
    throw Error(
      "Invalid authenticated production loopback runtime configuration",
    );
  return env;
}
export function runtimeArguments(imageId, release) {
  if (!IMAGE.test(imageId)) throw Error("Immutable image ID required");
  validateRelease(release);
  return [
    "run",
    "-d",
    "--name",
    API,
    "--label",
    LABEL + "=production-api",
    "--label",
    SHA_LABEL + "=" + release.sha,
    "--label",
    ROOT_LABEL + "=" + release.rootSha,
    "--label",
    SCHEMA_LABEL + "=" + release.schemaFingerprint,
    "--restart",
    "unless-stopped",
    "--network",
    "host",
    "--privileged",
    "--device",
    "/dev/kvm",
    "--cpus",
    "6",
    "--memory",
    "14g",
    "--pids-limit",
    "8192",
    "--stop-timeout",
    "90",
    "--log-driver",
    "json-file",
    "--log-opt",
    "max-size=10m",
    "--log-opt",
    "max-file=5",
    "--mount",
    "type=volume,source=agent-platform-production-data,target=/data",
    "--mount",
    "type=volume,source=agent-platform-api-secrets,target=/run/secrets,readonly",
    imageId,
  ];
}
export function validateRelease(value, expected = {}) {
  if (
    value?.schemaVersion !== 2 ||
    !SHA.test(value.sha ?? "") ||
    !SHA.test(value.rootSha ?? "") ||
    !IMAGE.test(value.imageId ?? "") ||
    !/^[a-f0-9]{64}$/.test(value.schemaFingerprint ?? "") ||
    value.platform !== "linux" ||
    value.arch !== "arm64" ||
    value.nodeMajor !== 22 ||
    value.boxliteVersion !== "0.9.7" ||
    value.nativeProbe !== "passed" ||
    value.imageArchive !== "api-image.tar" ||
    !Number.isFinite(Date.parse(value.builtAt)) ||
    (expected.sha && value.sha !== expected.sha) ||
    (expected.rootSha && value.rootSha !== expected.rootSha)
  )
    throw Error("Immutable release identity mismatch");
  return value;
}
export function redactLogs(text, values = []) {
  for (const value of values
    .filter((value) => typeof value === "string" && value.length > 2)
    .sort((a, b) => b.length - a.length))
    text = text.split(value).join("[REDACTED]");
  return text
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9]+/g, "[REDACTED]")
    .replace(
      /(ACCESS_PASSCODE|PASSCODE_COOKIE_SECRET|TOKEN|PASSWORD)([=:]\s*)[^\s"']+/g,
      "$1$2[REDACTED]",
    );
}
export function ownedContainer(value, expected = {}) {
  const mounts = value?.Mounts ?? [],
    labels = value?.Config?.Labels;
  return (
    typeof value?.Id === "string" &&
    IMAGE.test(value.Image ?? "") &&
    labels?.[LABEL] === "production-api" &&
    (!expected.id || value.Id === expected.id) &&
    (!expected.imageId || value.Image === expected.imageId) &&
    value.HostConfig?.NetworkMode === "host" &&
    mounts.length === 2 &&
    mounts.some(
      (m) =>
        m.Type === "volume" &&
        m.Name === "agent-platform-production-data" &&
        m.Destination === "/data" &&
        m.RW === true,
    ) &&
    mounts.some(
      (m) =>
        m.Type === "volume" &&
        m.Name === "agent-platform-api-secrets" &&
        m.Destination === "/run/secrets" &&
        m.RW === false,
    )
  );
}

// The helper owns only this exact file identity. An operator's replacement is never removed.
export const BARRIER_SCRIPT = `const fs=require('fs'),crypto=require('crypto');const p='/data/deployment-drain';const [action,arg]=process.argv.slice(1);if(action==='hold'){const f=fs.openSync(p,'wx',384);try{fs.writeFileSync(f,arg);fs.fsyncSync(f);}finally{fs.closeSync(f);}const s=fs.lstatSync(p);console.log(JSON.stringify({dev:s.dev,ino:s.ino,sha256:crypto.createHash('sha256').update(arg).digest('hex')}));}else{const expected=JSON.parse(arg);const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.dev!==expected.dev||s.ino!==expected.ino||crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==expected.sha256)throw Error('Maintenance ownership changed');if(action==='release')fs.unlinkSync(p);else if(action!=='check')throw Error('Invalid maintenance operation');}`;
export const CLEAR_DATA_SCRIPT = `set -eu; for entry in /data/* /data/.[!.]* /data/..?*; do if [ "$entry" = /data/deployment-drain ]; then continue; fi; if [ -e "$entry" ] || [ -L "$entry" ]; then rm -rf -- "$entry"; fi; done`;
export const MIGRATION_DATA_PROBE = `const fs=require('fs'),{DatabaseSync}=require('node:sqlite');const p='/data/platform.db',s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||fs.existsSync(p+'-wal'))throw Error('Unsafe or unsealed migrated database');const copy='/tmp/migration-verify.db';fs.copyFileSync(p,copy,fs.constants.COPYFILE_EXCL);const db=new DatabaseSync(copy);try{if(db.prepare('PRAGMA quick_check').all().some(r=>r.quick_check!=='ok')||db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Migrated database integrity failed');for(const q of ["select count(*) as n from sandboxes where status not in ('stopped','failed','destroyed')","select count(*) as n from agent_tasks where status='running'","select count(*) as n from automation_runs where status in ('pending','running')","select count(*) as n from automations where enabled=1","select count(*) as n from resource_allocations where released_at is null","select count(*) as n from projects where clone_status='cloning'","select count(*) as n from sandbox_project_cleanup_jobs"]){if(db.prepare(q).get().n!==0)throw Error('Migrated database has live work');}for(const {baseline_path:p}of db.prepare('select baseline_path from projects').all()){if(p===null)continue;if(typeof p!=='string'||!p.startsWith('/data/')||p.split('/').some(x=>x==='.'||x==='..')||fs.realpathSync(p)!==p||!fs.statSync(p).isDirectory())throw Error('Migrated baseline is not a real /data directory');}console.log('migration-data-probe-passed');}finally{db.close();}`;
export const NATIVE_ADDON_PROBE =
  "const D=require('better-sqlite3');const d=new D(':memory:');if(d.prepare('SELECT 7 AS value').get().value!==7)throw Error('SQLite failed');d.close();const B=require('node:module').createRequire('/app/packages/modules/sandbox/package.json')('@boxlite-ai/boxlite');if(typeof B.JsBoxlite!=='function'||typeof B.getNativeModule().JsBoxlite!=='function')throw Error('BoxLite native binding failed');console.log('native-probe-passed')";

export function createDeployer(options = {}) {
  const root = options.root ?? ROOT,
    tools = options.tools ?? TOOLS;
  const base = options.base ?? "http://127.0.0.1:3101";
  const exec = options.run ?? run;
  const now = options.now ?? (() => new Date().toISOString());
  const sleep =
    options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const d = (args, opts) => exec(docker, [...spec, ...args], opts);
  const receipts = join(root, "jenkins-receipts"),
    releases = join(root, "releases");
  const runtimeEnv = async () =>
    runtimePolicy(await privateFile(join(root, "runtime.env")));
  async function heads() {
    if (options.heads) return options.heads();
    const token = (await privateFile(join(tools, "github-token"))).trim(),
      result = {};
    for (const [kind, repo] of Object.entries(REPOSITORIES)) {
      const response = await fetch(
        "https://api.github.com/repos/" +
          repo.name +
          "/commits/" +
          encodeURIComponent(repo.branch),
        {
          headers: {
            authorization: "Bearer " + token,
            accept: "application/vnd.github+json",
          },
          redirect: "error",
          signal: AbortSignal.timeout(60000),
        },
      );
      if (!response.ok)
        throw Error(`GitHub approved head HTTP ${response.status}`);
      const sha = (await response.json()).sha;
      if (!SHA.test(sha ?? "")) throw Error("Invalid approved branch commit");
      result[kind === "api" ? "sha" : "rootSha"] = sha;
    }
    return result;
  }
  async function approved(request) {
    const latest = await heads();
    return latest.sha === request.sha && latest.rootSha === request.rootSha;
  }
  async function checkout(kind, sha, folder) {
    if (options.checkout) return options.checkout(kind, sha, folder);
    const repo = REPOSITORIES[kind],
      askpass = join(folder, ".askpass-" + kind),
      source = join(folder, kind + "-source");
    await fs.writeFile(
      askpass,
      '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" x-access-token ;; *) cat /run/agent-platform/jenkins-tools/github-token ;; esac\n',
      { flag: "wx", mode: 0o700 },
    );
    const env = { ...SAFE_ENV, GIT_ASKPASS: askpass };
    try {
      await exec(
        "git",
        [
          "clone",
          "--no-checkout",
          "--filter=blob:none",
          "--single-branch",
          "--branch",
          repo.branch,
          "https://github.com/" + repo.name + ".git",
          source,
        ],
        { env, quiet: true },
      );
      await exec("git", ["checkout", "--detach", sha], {
        cwd: source,
        env,
        quiet: true,
      });
      if (
        (
          await exec("git", ["rev-parse", "HEAD"], { cwd: source, env })
        ).trim() !== sha ||
        (
          await exec("git", ["rev-parse", "origin/" + repo.branch], {
            cwd: source,
            env,
          })
        ).trim() !== sha
      )
        throw Error("Checkout no longer matches approved branch head");
      return source;
    } finally {
      await fs.rm(askpass, { force: true });
    }
  }
  async function withLock(callback) {
    const lock = join(root, "deployment.lock"),
      owner = { kind: "api-container", token: randomUUID(), pid: process.pid };
    try {
      await fs.mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST")
        throw Error(
          "Deployment lock exists; review the checkpoint before operator recovery",
        );
      throw error;
    }
    await immutableJson(join(lock, "owner.json"), owner);
    let preserve = false;
    const checkpoint = async (value) => {
      preserve = value.state === "operator-recovery-required";
      await atomic(join(lock, "checkpoint.json"), value);
    };
    try {
      return await callback(checkpoint);
    } finally {
      if (!preserve) {
        if (
          JSON.stringify(
            JSON.parse(await privateFile(join(lock, "owner.json"))),
          ) !== JSON.stringify(owner)
        )
          throw Error("Deployment lock ownership changed; retained");
        await fs.rm(join(lock, "checkpoint.json"), { force: true });
        await fs.unlink(join(lock, "owner.json"));
        await fs.rmdir(lock);
      }
    }
  }
  async function imageInfo(imageId, release) {
    const values = JSON.parse(await d(["image", "inspect", imageId]));
    if (
      values.length !== 1 ||
      values[0].Id !== imageId ||
      values[0].Architecture !== "arm64" ||
      values[0].Os !== "linux" ||
      values[0].Config?.Labels?.[SHA_LABEL] !== release.sha ||
      values[0].Config?.Labels?.[ROOT_LABEL] !== release.rootSha ||
      values[0].Config?.Labels?.[SCHEMA_LABEL] !== release.schemaFingerprint
    )
      throw Error("Immutable cached image identity mismatch");
  }
  async function cached(destination, request) {
    await directory(destination);
    if (
      (await fs.readdir(destination)).sort().join(",") !==
      "api-package.tgz,package.json,release.json"
    )
      throw Error("Immutable release directory conflict");
    const release = validateRelease(
      JSON.parse(await privateFile(join(destination, "release.json"))),
      request,
    );
    const pkg = JSON.parse(
        await privateFile(join(destination, "package.json")),
      ),
      actual = await digest(join(destination, "api-package.tgz"));
    if (
      pkg.sha !== release.sha ||
      pkg.rootSha !== release.rootSha ||
      pkg.imageId !== release.imageId ||
      pkg.sha256 !== actual.sha256 ||
      pkg.sizeBytes !== actual.sizeBytes ||
      pkg.files !== 3 ||
      pkg.nativeProbe !== "passed"
    )
      throw Error("Immutable package content conflict");
    await imageInfo(release.imageId, release);
    return { release, pkg };
  }
  async function packageWorkspace(destination, workspace, request, value) {
    workspace = resolve(workspace);
    await directory(workspace, { privateMode: false });
    const artifact = join(workspace, "api-package-" + request.runId + ".tgz");
    try {
      await fs.copyFile(
        join(destination, "api-package.tgz"),
        artifact,
        constants.COPYFILE_EXCL,
      );
      await fs.chmod(artifact, 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const actual = await digest(artifact);
      if (
        actual.sha256 !== value.pkg.sha256 ||
        actual.sizeBytes !== value.pkg.sizeBytes
      )
        throw Error("Workspace package conflict");
    }
    const proof = { ...value.pkg, artifact };
    await immutableJson(join(workspace, "api-package.json"), proof);
    const ci = {
      state: "ci-passed",
      ...request,
      artifactPath: destination,
      imageId: value.release.imageId,
      nativeProbe: "passed",
      platform: "linux",
      arch: "arm64",
    };
    await ensureDirectory(receipts);
    await immutableJson(
      join(receipts, request.sha + "-" + request.runId + ".json"),
      ci,
    );
    return ci;
  }
  async function build(sha, runId, workspace, rootSha) {
    const request = buildRequest(sha, runId, rootSha);
    if (!(await approved(request)))
      throw Error(
        "Pinned API/root source no longer equals approved branch heads",
      );
    return withLock(async () => {
      await ensureDirectory(releases);
      const destination = join(releases, releaseKey(sha, rootSha));
      let existing = false;
      try {
        await fs.lstat(destination);
        existing = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (existing)
        return packageWorkspace(
          destination,
          workspace,
          request,
          await cached(destination, request),
        );
      const stage = await fs.mkdtemp(join(releases, ".building-"));
      try {
        const apiSource = await checkout("api", sha, stage),
          rootSource = await checkout("root", rootSha, stage);
        const { context, manifest } = await (
          options.prepare ?? prepareApiContext
        )(apiSource, rootSource, stage, request);
        const builtAt = now(),
          tag = "agent-platform-api:" + releaseKey(sha, rootSha);
        await d([
          "build",
          "--platform",
          "linux/arm64",
          "--progress=plain",
          "--build-arg",
          "APP_COMMIT=" + sha,
          "--build-arg",
          "APP_BUILT_AT=" + builtAt,
          "--label",
          SHA_LABEL + "=" + sha,
          "--label",
          ROOT_LABEL + "=" + rootSha,
          "--label",
          SCHEMA_LABEL + "=" + manifest.schemaFingerprint,
          "-f",
          join(context, "Dockerfile.api"),
          "-t",
          tag,
          context,
        ]);
        const image = JSON.parse(await d(["image", "inspect", tag]))[0];
        if (!IMAGE.test(image?.Id ?? "")) throw Error("Invalid Linux image ID");
        const release = {
          schemaVersion: 2,
          sha,
          rootSha,
          platform: "linux",
          arch: "arm64",
          nodeMajor: 22,
          imageId: image.Id,
          boxliteVersion: "0.9.7",
          nativeProbe: "passed",
          builtAt,
          imageArchive: "api-image.tar",
          schemaFingerprint: manifest.schemaFingerprint,
        };
        validateRelease(release);
        await imageInfo(image.Id, release);
        const nativeProbe = await d([
          "run",
          "--rm",
          "--network",
          "none",
          "--entrypoint",
          "node",
          image.Id,
          "-e",
          NATIVE_ADDON_PROBE,
        ]);
        if (nativeProbe.trim() !== "native-probe-passed")
          throw Error("Container native addon probe failed");
        const packageRoot = join(stage, "package", "agent-platform-api");
        await fs.mkdir(packageRoot, { recursive: true, mode: 0o700 });
        await immutableJson(join(packageRoot, "release.json"), release);
        await d([
          "save",
          "--output",
          join(packageRoot, "api-image.tar"),
          image.Id,
        ]);
        await fs.chmod(join(packageRoot, "api-image.tar"), 0o600);
        await fs.writeFile(
          join(packageRoot, "README.md"),
          "# Agent Platform API — Linux ARM64\n\nBuilt locally by Jenkins. Verify the release checksum before extraction and docker load -i api-image.tar. release.json pins both API and ROOT commits and the immutable Docker image ID. Requires Linux ARM64, accessible /dev/kvm and the verified privileged BoxLite container policy. Use separate production data and read-only runtime secrets volumes, authenticated HTTPS origins, access passcode and secure cookie secret. No database or credentials are included. Database migration changes require an operator-reviewed migration; code rollback alone cannot undo schema changes.\n",
          { flag: "wx", mode: 0o644 },
        );
        const artifact = join(stage, "api-package.tgz");
        await exec("tar", [
          "-czf",
          artifact,
          "-C",
          join(stage, "package"),
          "agent-platform-api",
        ]);
        await fs.chmod(artifact, 0o600);
        const pkg = {
          state: "packaged",
          sha,
          rootSha,
          ...(await digest(artifact)),
          platform: "linux",
          arch: "arm64",
          nodeMajor: 22,
          imageId: image.Id,
          boxliteVersion: "0.9.7",
          nativeProbe: "passed",
          files: 3,
        };
        await immutableJson(join(stage, "release.json"), release);
        await immutableJson(join(stage, "package.json"), pkg);
        // Delete only this invocation's fresh staging inputs, never an existing release directory.
        for (const name of await fs.readdir(stage))
          if (
            !["api-package.tgz", "release.json", "package.json"].includes(name)
          )
            await fs.rm(join(stage, name), { recursive: true, force: true });
        if (!(await approved(request)))
          throw Error(
            "Approved heads changed during build; no receipt published",
          );
        // mkdir is exclusive; rename(directory) could silently replace an operator's empty directory.
        await fs.mkdir(destination, { mode: 0o700 });
        for (const name of [
          "api-package.tgz",
          "release.json",
          "package.json",
        ]) {
          await fs.copyFile(
            join(stage, name),
            join(destination, name),
            constants.COPYFILE_EXCL,
          );
          await fs.chmod(join(destination, name), 0o600);
        }
        return await packageWorkspace(destination, workspace, request, {
          release,
          pkg,
        });
      } finally {
        await fs.rm(stage, { recursive: true, force: true });
      }
    });
  }
  async function status() {
    if (options.status) return options.status();
    const env = await runtimeEnv();
    const r = await fetch(base + "/api/deployment/status", {
      headers: { authorization: "Bearer " + env.ACCESS_PASSCODE },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw Error(`Production idle probe HTTP ${r.status}`);
    return r.json();
  }
  async function inspectApi() {
    const result = await d([
      "container",
      "ls",
      "-a",
      "--filter",
      "name=^/" + API + "$",
      "--format",
      "{{.ID}}",
    ]);
    if (!result.trim()) return null;
    const values = JSON.parse(await d(["inspect", API]));
    if (values.length !== 1) throw Error("Ambiguous API container");
    return values[0];
  }
  async function exactContainer(expected) {
    const actual = await inspectApi();
    if (!ownedContainer(actual, expected))
      throw Error(
        "Production container identity or mounts changed; operator recovery required",
      );
    return actual;
  }
  async function ready(release) {
    if (options.ready) return options.ready(release);
    const env = await runtimeEnv();
    for (let attempt = 0; attempt < 90; attempt++) {
      try {
        const r = await fetch(base + "/api/health", {
          redirect: "error",
          signal: AbortSignal.timeout(2000),
        });
        const v = await fetch(base + "/api/system/version", {
          headers: { authorization: "Bearer " + env.ACCESS_PASSCODE },
          redirect: "error",
          signal: AbortSignal.timeout(2000),
        });
        if (
          r.ok &&
          v.ok &&
          (await v.json()).commit === release.sha &&
          (await status()).ready
        )
          return;
      } catch {
        /* Remain behind maintenance until pinned readiness succeeds. */
      }
      await sleep(2000);
    }
    throw Error("API failed readiness or pinned version");
  }
  async function helper(
    image,
    args,
    { writable = false, backup = false, input } = {},
  ) {
    return d(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "/bin/sh",
        "--mount",
        "type=volume,source=agent-platform-production-data,target=/data" +
          (writable ? "" : ",readonly"),
        ...(backup
          ? [
              "--mount",
              "type=volume,source=agent-platform-runtime-backups,target=/backups" +
                (backup === "read" ? ",readonly" : ""),
            ]
          : []),
        image,
        "-c",
        args,
      ],
      { input },
    );
  }
  async function barrier(action, identity, image, containerId) {
    const args = [
      "node",
      "-e",
      BARRIER_SCRIPT,
      action,
      typeof identity === "string" ? identity : JSON.stringify(identity),
    ];
    if (containerId) {
      await exactContainer({ id: containerId, imageId: image });
      return d(["exec", containerId, ...args]);
    }
    return d([
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "node",
      "--mount",
      "type=volume,source=agent-platform-production-data,target=/data",
      image,
      "-e",
      BARRIER_SCRIPT,
      action,
      typeof identity === "string" ? identity : JSON.stringify(identity),
    ]);
  }
  async function verifiedReceipt(sha, runId) {
    if (!SHA.test(sha ?? "") || !/^[1-9]\d{0,9}$/.test(String(runId)))
      throw Error("Pinned commit and build required");
    await directory(receipts);
    const receipt = JSON.parse(
      await privateFile(join(receipts, sha + "-" + runId + ".json")),
    );
    const request = buildRequest(sha, runId, receipt.rootSha),
      destination = join(releases, releaseKey(sha, receipt.rootSha));
    if (
      receipt.state !== "ci-passed" ||
      receipt.sha !== sha ||
      receipt.runId !== request.runId ||
      receipt.artifactPath !== destination ||
      receipt.nativeProbe !== "passed"
    )
      throw Error("Verified dual-commit receipt missing");
    const { release } = await cached(destination, request);
    if (receipt.imageId !== release.imageId)
      throw Error("Receipt image conflict");
    const envText = await privateFile(join(root, "runtime.env"));
    runtimePolicy(envText);
    const mountedHash = (
      await d([
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "node",
        "--mount",
        "type=volume,source=agent-platform-api-secrets,target=/run/secrets,readonly",
        release.imageId,
        "-e",
        "const fs=require('fs'),c=require('crypto');const p='/run/secrets/runtime.env',s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||(s.mode&63))throw Error('Unsafe runtime secret');console.log(c.createHash('sha256').update(fs.readFileSync(p)).digest('hex'))",
      ])
    ).trim();
    if (mountedHash !== createHash("sha256").update(envText).digest("hex"))
      throw Error(
        "API secret volume differs from the verified deployment runtime",
      );
    return { request, release };
  }
  async function deploy(sha, runId) {
    const { request, release } = await verifiedReceipt(sha, runId);
    if (!(await approved(request))) return { state: "superseded", ...request };
    return withLock(async (checkpoint) => {
      const old = await inspectApi();
      if (!old) return { state: "waiting-initial-adoption", ...request };
      if (!ownedContainer(old))
        throw Error("Production container has not been safely adopted");
      const oldLabels = old.Config.Labels;
      const oldRequest = {
        sha: oldLabels[SHA_LABEL],
        rootSha: oldLabels[ROOT_LABEL],
      };
      const oldValue = await cached(
        join(releases, releaseKey(oldRequest.sha, oldRequest.rootSha)),
        oldRequest,
      );
      if (oldValue.release.imageId !== old.Image)
        throw Error("Current release image metadata conflict");
      if (old.Image === release.imageId) {
        await ready(release);
        return { state: "current", ...request, imageId: old.Image };
      }
      if (oldValue.release.schemaFingerprint !== release.schemaFingerprint)
        return {
          state: "waiting-migration-review",
          ...request,
          imageId: release.imageId,
        };
      if (!idle(await status())) return { state: "waiting-idle", ...request };
      let held,
        holdAttempted = false,
        stopped = false,
        replacement;
      const backup =
        "api-backup-" +
        releaseKey(sha, request.rootSha) +
        "-" +
        runId +
        "-" +
        randomUUID() +
        ".tgz";
      try {
        holdAttempted = true;
        held = JSON.parse(
          await barrier(
            "hold",
            JSON.stringify({
              kind: "api-container",
              token: randomUUID(),
              ...request,
              heldAt: now(),
            }) + "\n",
            old.Image,
            old.Id,
          ),
        );
        await checkpoint({
          state: "draining",
          ...request,
          previousContainerId: old.Id,
          previousImageId: old.Image,
          barrier: held,
        });
        for (let second = 0; second < 10; second++) {
          await sleep(1000);
          await barrier("check", held, old.Image, old.Id);
          const value = await status();
          if (!value.draining || !idle(value)) {
            await barrier("release", held, old.Image, old.Id);
            held = null;
            return { state: "waiting-idle", ...request };
          }
        }
        if (!(await approved(request))) {
          await barrier("release", held, old.Image, old.Id);
          held = null;
          return { state: "superseded", ...request };
        }
        // Admission is still held and every real work/auth/HTTP counter remains zero immediately before stop.
        await barrier("check", held, old.Image, old.Id);
        if (!idle(await status()))
          throw Error("Production became active before stop");
        stopped = true;
        await checkpoint({
          state: "stopping",
          ...request,
          previousContainerId: old.Id,
          previousImageId: old.Image,
          barrier: held,
          backup,
        });
        await d(["stop", "--time", "90", old.Id]);
        const stoppedOld = await exactContainer({
          id: old.Id,
          imageId: old.Image,
        });
        if (stoppedOld.State?.Running !== false)
          throw Error("Original API did not stop");
        await barrier("check", held, old.Image);
        await helper(
          old.Image,
          `set -eu; test ! -e /backups/${backup}; tar --exclude=./deployment-drain -czf /backups/${backup} -C /data .; tar -tzf /backups/${backup} >/dev/null`,
          { backup: true },
        );
        await checkpoint({
          state: "backed-up",
          ...request,
          previousContainerId: old.Id,
          previousImageId: old.Image,
          barrier: held,
          backup,
        });
        await exactContainer({ id: old.Id, imageId: old.Image });
        await d(["rm", old.Id]);
        const id = (await d(runtimeArguments(release.imageId, release))).trim();
        replacement = { id, imageId: release.imageId };
        await exactContainer(replacement);
        await ready(release);
        await barrier("check", held, release.imageId, id);
        // Replacement starts behind the same barrier. Only this controller releases it after readiness.
        await barrier("release", held, release.imageId, id);
        held = null;
        const result = {
          state: "deployed",
          ...request,
          imageId: release.imageId,
          previousImageId: old.Image,
          backup,
          deployedAt: now(),
        };
        await atomic(join(root, "runtime-state.json"), result);
        return result;
      } catch (error) {
        if (!stopped) {
          if (held) {
            try {
              await barrier("release", held, old.Image, old.Id);
              held = null;
            } catch {
              await checkpoint({
                state: "operator-recovery-required",
                ...request,
                barrier: held,
                reason: "Maintenance owner changed before stop",
              });
            }
          } else if (holdAttempted) {
            await checkpoint({
              state: "operator-recovery-required",
              ...request,
              reason:
                "Admission acquisition outcome could not be verified; existing marker preserved",
            });
          }
          throw error;
        }
        if (!held) {
          await checkpoint({
            state: "operator-recovery-required",
            ...request,
            replacement,
            reason:
              "Service published but final metadata could not be persisted; no live rollback attempted",
          });
          throw Error(
            "Published service retained; deployment checkpoint requires operator review",
          );
        }
        try {
          const existing = await inspectApi();
          if (existing) {
            if (replacement) {
              await exactContainer(replacement);
              await d(["stop", "--time", "90", replacement.id]);
              await exactContainer(replacement);
              await d(["rm", replacement.id]);
            } else {
              await exactContainer({ id: old.Id, imageId: old.Image });
              if (existing.State?.Running !== false)
                throw Error("Original stop outcome is ambiguous");
            }
          }
          await barrier("check", held, old.Image);
          // Never clear data without a verified complete archive. The original barrier must still match.
          if (replacement) {
            await helper(
              old.Image,
              `set -eu; tar -tzf /backups/${backup} >/dev/null; ${CLEAR_DATA_SCRIPT}; tar -xzf /backups/${backup} -C /data`,
              { writable: true, backup: "read" },
            );
            await barrier("check", held, old.Image);
          }
          const remaining = await inspectApi();
          let restoredId;
          if (remaining) {
            await exactContainer({ id: old.Id, imageId: old.Image });
            await d(["start", old.Id]);
            restoredId = old.Id;
          } else
            restoredId = (
              await d(runtimeArguments(old.Image, oldValue.release))
            ).trim();
          await exactContainer({ id: restoredId, imageId: old.Image });
          await ready(oldValue.release);
          await barrier("release", held, old.Image, restoredId);
          held = null;
          const result = {
            state: "rolled-back",
            ...request,
            imageId: old.Image,
            failedImageId: release.imageId,
            backup,
            reason:
              "Replacement did not complete readiness; original release restored",
          };
          await atomic(join(root, "runtime-state.json"), result);
          return result;
        } catch {
          await checkpoint({
            state: "operator-recovery-required",
            ...request,
            previousContainerId: old.Id,
            previousImageId: old.Image,
            replacement,
            barrier: held,
            backup,
            reason:
              "Identity, backup or rollback readiness could not be verified",
          });
          throw Error(
            "Deployment failed; exact maintenance and checkpoint retained for operator recovery",
          );
        }
      }
    });
  }
  async function adopt(sha, runId) {
    const { request, release } = await verifiedReceipt(sha, runId);
    if (!(await approved(request)))
      throw Error("Initial adoption requires current approved API/root heads");
    return withLock(async (checkpoint) => {
      const path = join(root, "native-migration-ready.json");
      const permit = JSON.parse(await privateFile(path));
      if (
        permit.state !== "native-stopped-data-imported" ||
        permit.sha !== request.sha ||
        permit.rootSha !== request.rootSha ||
        (permit.imageId && permit.imageId !== release.imageId) ||
        permit.volume !== "agent-platform-production-data" ||
        !/^[a-f0-9]{64}$/.test(permit.dataManifestSha256 ?? "") ||
        permit.previousNativeApiStopped !== true ||
        permit.previousDedicatedTunnelStopped !== true
      )
        throw Error("Verified native-stop/data-import permit required");
      if (
        (await inspectApi()) ||
        (
          await d([
            "container",
            "ls",
            "-a",
            "--filter",
            "label=" + LABEL + "=production-api",
            "--format",
            "{{.ID}}",
          ])
        ).trim()
      )
        throw Error(
          "Initial adoption refuses any existing production API container",
        );
      const dataProbe = await d([
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "node",
        "--mount",
        "type=volume,source=agent-platform-production-data,target=/data,readonly",
        release.imageId,
        "-e",
        MIGRATION_DATA_PROBE,
      ]);
      if (dataProbe.trim() !== "migration-data-probe-passed")
        throw Error(
          "Initial migration SQLite, blockers or baseline probe failed",
        );
      if (!(await approved(request)))
        throw Error("Approved heads changed before initial adoption");
      let held,
        attempted = false,
        containerId;
      try {
        attempted = true;
        held = JSON.parse(
          await barrier(
            "hold",
            JSON.stringify({
              kind: "api-container-initial-adopt",
              token: randomUUID(),
              ...request,
              heldAt: now(),
            }) + "\n",
            release.imageId,
          ),
        );
        await checkpoint({
          state: "initial-adopting",
          ...request,
          imageId: release.imageId,
          barrier: held,
          dataManifestSha256: permit.dataManifestSha256,
        });
        // Recheck after holding admission; the volume must remain the verified idle migration.
        if (
          (
            await d([
              "container",
              "ls",
              "-a",
              "--filter",
              "label=" + LABEL + "=production-api",
              "--format",
              "{{.ID}}",
            ])
          ).trim()
        )
          throw Error("Production API appeared during initial adoption");
        containerId = (
          await d(runtimeArguments(release.imageId, release))
        ).trim();
        await exactContainer({ id: containerId, imageId: release.imageId });
        await ready(release);
        if (!idle(await status()))
          throw Error(
            "Initially adopted API has unexpected live work or authorization",
          );
        await barrier("check", held, release.imageId, containerId);
        const adoptedAt = now();
        const result = {
          state: "initial-adopted",
          ...request,
          imageId: release.imageId,
          dataManifestSha256: permit.dataManifestSha256,
          adoptedAt,
        };
        await atomic(join(root, "runtime-state.json"), result);
        await atomic(path, {
          ...permit,
          state: "adopted",
          runId: request.runId,
          imageId: release.imageId,
          adoptedAt,
        });
        await barrier("release", held, release.imageId, containerId);
        return result;
      } catch (error) {
        if (attempted)
          await checkpoint({
            state: "operator-recovery-required",
            ...request,
            imageId: release.imageId,
            containerId,
            barrier: held,
            dataManifestSha256: permit.dataManifestSha256,
            reason:
              "Initial adoption outcome not verified; migration data and admission retained",
          });
        throw error;
      }
    });
  }
  async function monitor(folder) {
    folder = resolve(folder);
    await ensureDirectory(folder);
    const env = await runtimeEnv(),
      secrets = Object.entries(env)
        .filter(([key]) => /PASSCODE|SECRET|TOKEN|PASSWORD|KEY/.test(key))
        .map(([, value]) => value);
    for (const name of ["github-token", "ghcr-token"])
      try {
        secrets.push((await privateFile(join(tools, name))).trim());
      } catch {
        /* Optional credentials are not needed for read-only status. */
      }
    const containers = [];
    for (const [name, log] of [
      [API, "api"],
      ["agent-platform-tunnel", "tunnel"],
      ["agent-platform-linux-deploy", "cicd"],
    ]) {
      let item;
      try {
        const values = JSON.parse(await d(["inspect", name]));
        const value = values[0];
        item = {
          name,
          imageId: value.Image,
          state: value.State.Status,
          health: value.State.Health?.Status ?? null,
          startedAt: value.State.StartedAt,
          restartCount: value.RestartCount,
        };
      } catch {
        item = { name, state: "missing" };
      }
      containers.push(item);
      let lines = "";
      try {
        lines = await d(["logs", "--tail", "300", name], {
          quiet: true,
          includeStderr: true,
        });
      } catch {
        /* No logs for missing containers. */
      }
      await fs.writeFile(
        join(folder, log + ".redacted.log"),
        redactLogs(lines, secrets),
        { flag: "wx", mode: 0o600 },
      );
    }
    await fs.writeFile(
      join(folder, "build.redacted.log"),
      "Build output is retained in the associated Jenkins console and immutable artifacts.\n",
      { flag: "wx", mode: 0o600 },
    );
    let probe = null;
    try {
      probe = await status();
    } catch {
      /* Failed probe is unhealthy. */
    }
    const healthy =
      containers.slice(0, 2).every((c) => c.state === "running") &&
      containers[0].health === "healthy" &&
      probe?.ready === true;
    const report = {
      schemaVersion: 2,
      capturedAt: now(),
      healthy,
      containers,
      deployment: probe,
      management:
        "Docker restart, healthchecks and bounded logs; Jenkins archived status",
    };
    await atomic(join(folder, "report.json"), report);
    const escaped = JSON.stringify(report, null, 2).replace(
      /[&<>]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
    );
    await fs.writeFile(
      join(folder, "report.html"),
      "<!doctype html><meta charset=utf-8><title>Service status</title><h1>" +
        (healthy ? "Healthy" : "Unhealthy") +
        "</h1><pre>" +
        escaped +
        "</pre><p><a href=api.redacted.log>API log</a> · <a href=tunnel.redacted.log>Tunnel log</a> · <a href=cicd.redacted.log>Deployment agent log</a></p>",
      { flag: "wx", mode: 0o600 },
    );
    return report;
  }
  return { heads, build, deploy, adopt, monitor };
}
export async function main(action, ...args) {
  await trusted();
  const service = createDeployer();
  if (action === "head") return service.heads();
  if (action === "build") return service.build(...args);
  if (action === "deploy") {
    const result = await service.deploy(...args);
    if (result.state === "rolled-back") process.exitCode = 1;
    return result;
  }
  if (action === "adopt") return service.adopt(...args);
  if (action === "monitor") {
    const folder = resolve(args[0]);
    const result = await service.monitor(folder);
    if (!result.healthy) process.exitCode = 2;
    return result;
  }
  throw Error(
    "Use head, build API_SHA BUILD_NUMBER WORKSPACE ROOT_SHA, deploy/adopt API_SHA BUILD_NUMBER or monitor DIRECTORY",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main(...process.argv.slice(2)).then(
    (r) => console.log(JSON.stringify(r)),
    (e) => {
      console.error(e.message);
      process.exitCode = 1;
    },
  );
