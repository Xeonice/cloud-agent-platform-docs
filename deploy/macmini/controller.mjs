import * as fs from "node:fs/promises";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as pause } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  atomicJson,
  attestArtifact,
  buildArtifactPath,
  buildEnvironment,
  CI_CHECKS,
  jenkinsInvocation,
  migrationsHash,
  privateFile,
  readyManifest,
  releasePath,
  runCycle,
  runJenkinsBuild,
  readJenkinsReceipt,
  validateConfig,
  withLock,
  activateRelease,
  runtimeEnvironment,
  createMaintenanceBarrier,
  recoverMaintenanceBarrier,
  releaseMaintenanceBarrier,
  SERVICE_CONTROL_HELPER,
  verifiedArtifact,
  writeJenkinsReceipt,
} from "./lib.mjs";

async function execute(
  command,
  args,
  { cwd, env, log, timeout = 300_000 } = {},
) {
  const handle = log ? await fs.open(log, "a", 0o600) : null;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", handle?.fd ?? "pipe", handle?.fd ?? "pipe"],
      });
      let output = "";
      child.stdout?.on("data", (chunk) => {
        if (output.length < 100_000) output += chunk;
      });
      child.stderr?.on("data", () => {}); // Keep arbitrary subprocess stderr out of controller status.
      let killTimer;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      }, timeout);
      child.once("error", (error) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        if (code === 0) resolve(output.trim());
        else
          reject(
            Object.assign(
              new Error(
                `${command.split("/").at(-1)} exited ${signal ?? code}`,
              ),
              { exitCode: code },
            ),
          );
      });
    });
  } finally {
    await handle?.close();
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function runNativeChecks(
  config,
  path,
  env,
  log,
  progress,
  run = execute,
) {
  const pnpm = (args) => [config.node, [config.corepack, "pnpm", ...args]];
  const commands = [
    pnpm([
      "install",
      "--frozen-lockfile",
      "--store-dir",
      join(config.root, "pnpm-store"),
    ]),
    pnpm(["typecheck"]),
    pnpm(["lint", "--max-warnings=0"]),
    pnpm(["format:check"]),
    pnpm(["check:default-image"]),
    pnpm(["test:acceptance:report"]),
    [config.node, ["scripts/check-fake-provider-caps.mjs"]],
    pnpm(["build"]),
    pnpm(["openapi:emit"]),
    ["/usr/bin/git", ["diff", "--exit-code", "--", "openapi.json"]],
    [
      config.node,
      [
        "-e",
        "const DB=require('better-sqlite3');const db=new DB(':memory:');db.prepare('select 1').get();db.close()",
      ],
    ],
    [
      config.node,
      [
        "-e",
        "import('@boxlite-ai/boxlite').then(s=>{if(typeof s.JsBoxlite!=='function')process.exit(1)})",
      ],
    ],
  ];
  for (const [index, [command, args]] of commands.entries()) {
    const stage = CI_CHECKS[index];
    await progress(stage, "running");
    try {
      await run(command, args, {
        cwd:
          stage === "boxlite-native"
            ? join(path, "packages/modules/sandbox")
            : path,
        env,
        log,
        timeout: 1_800_000,
      });
    } catch (error) {
      await progress(stage, "failed");
      throw Object.assign(error, { stage, artifactPath: path, logPath: log });
    }
    await progress(stage, "passed");
  }
}

export function serviceCommand(config, action) {
  if (!["start", "stop"].includes(action))
    throw new Error("Invalid API service operation");
  if (config.launchdDomain === "system")
    return ["/usr/bin/sudo", ["-n", SERVICE_CONTROL_HELPER, "api", action]];
  return [
    "/bin/launchctl",
    action === "start"
      ? ["bootstrap", config.launchdDomain, config.runtimePlist]
      : [
          "bootout",
          `${config.launchdDomain}/com.douglasdong.agent-platform.api`,
        ],
  ];
}

export async function remoteHead(config) {
  const output = await execute(
    "/usr/bin/git",
    [
      "ls-remote",
      "--exit-code",
      `https://github.com/${config.repository}.git`,
      `refs/heads/${config.branch}`,
    ],
    { env: buildEnvironment(config.node) },
  );
  const sha = output.split(/\s/)[0];
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid remote head");
  return {
    state: "head",
    sha,
    repository: config.repository,
    branch: config.branch,
  };
}

export async function reconcile(config, request) {
  if (
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    process.versions.node.split(".")[0] !== "22"
  )
    throw new Error("Native releases require macOS ARM64 and Node 22");
  request = jenkinsInvocation(
    config,
    request?.action,
    request?.sha,
    request?.buildNumber,
    request?.buildUrl,
  );
  const env = buildEnvironment(config.node);
  const runtime = runtimeEnvironment(
    await privateFile(config.runtimeEnvFile),
    config,
  );
  const identity = {
    dataRoot: runtime.DATA_ROOT,
    databaseUrl: runtime.DATABASE_URL,
    boxliteHome: runtime.BOXLITE_HOME,
  };
  const mirror = join(config.root, "source.git");
  const git = (args, cwd = config.root) =>
    execute("/usr/bin/git", args, { cwd, env });
  const remote = `https://github.com/${config.repository}.git`;
  async function head() {
    const output = await git([
      "ls-remote",
      "--exit-code",
      remote,
      `refs/heads/${config.branch}`,
    ]);
    return output.split(/\s/)[0];
  }
  async function current() {
    try {
      const path = await fs.realpath(join(config.root, "current"));
      const sha = path.split("/").at(-1);
      if (path !== releasePath(config, sha))
        throw new Error("Invalid current link");
      return { ...(await readyManifest(path, sha)), path };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async function prepareSource(sha, history = false) {
    if (!(await fs.stat(mirror).catch(() => null)))
      await git(["init", "--bare", mirror]);
    const shallow = await git([
      "--git-dir",
      mirror,
      "rev-parse",
      "--is-shallow-repository",
    ]);
    await git([
      "--git-dir",
      mirror,
      "fetch",
      ...(history && shallow === "true" ? ["--unshallow"] : []),
      remote,
      `refs/heads/${config.branch}`,
    ]);
    const fetched = await git(["--git-dir", mirror, "rev-parse", "FETCH_HEAD"]);
    if (fetched !== sha) throw new Error("Remote changed before checkout");
  }
  const log = join(
    config.root,
    "logs",
    `jenkins-${request.buildNumber}-${request.sha}.log`,
  );
  const progress = async (stage, stageStatus) => {
    if (!["checkout", "cache", "receipt", ...CI_CHECKS].includes(stage))
      throw new Error("Invalid build stage");
    const value = {
      state: "building",
      stage,
      stageStatus,
      sha: request.sha,
      runId: request.buildNumber,
      logPath: log,
      updatedAt: new Date().toISOString(),
    };
    await atomicJson(join(config.root, "status.json"), value);
    await fs.mkdir(dirname(log), { recursive: true, mode: 0o700 });
    await fs.appendFile(log, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    console.error(JSON.stringify(value));
  };
  async function build(sha) {
    const active = await current();
    const path = buildArtifactPath(config, sha, active?.sha);
    try {
      const manifest = await verifiedArtifact(config, path, sha);
      if (
        manifest.dataRoot !== identity.dataRoot ||
        manifest.databaseUrl !== identity.databaseUrl ||
        manifest.boxliteHome !== identity.boxliteHome
      )
        throw new Error("Cached release belongs to different persistent data");
      await progress("cache", "passed");
      return { ...manifest, path, reused: true, logPath: log };
    } catch {
      /* A partial build is not a release. Retry only our own unactivated worktree. */
    }
    if (path === active?.path)
      throw new Error("Refusing to alter the active release");
    await progress("checkout", "running");
    await prepareSource(sha);
    if (await fs.stat(path).catch(() => null))
      await git(["--git-dir", mirror, "worktree", "remove", "--force", path]);
    await git(["--git-dir", mirror, "worktree", "prune"]);
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await git(["--git-dir", mirror, "worktree", "add", "--detach", path, sha]);
    await progress("checkout", "passed");
    await runNativeChecks(config, path, env, log, progress);
    const manifest = {
      sha,
      builtAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: 22,
      schemaHash: await migrationsHash(path),
      boxliteVersion: JSON.parse(
        await fs.readFile(
          join(path, "packages/modules/sandbox/package.json"),
          "utf8",
        ),
      ).dependencies["@boxlite-ai/boxlite"],
      ...identity,
    };
    await atomicJson(join(path, ".macmini-release.json"), manifest);
    return { ...(await attestArtifact(config, path, sha)), logPath: log };
  }
  const descendsFrom = async (sha, minimum) => {
    if (sha === minimum) return true;
    await prepareSource(sha, true);
    try {
      await git([
        "--git-dir",
        mirror,
        "merge-base",
        "--is-ancestor",
        minimum,
        sha,
      ]);
      return true;
    } catch (error) {
      if (error.exitCode === 1) return false;
      throw error;
    }
  };
  if (request.action === "build")
    return runJenkinsBuild(config, {
      request,
      head,
      descendsFrom,
      build,
      receipt: async (candidate) => {
        await writeJenkinsReceipt(config, request, candidate);
        await progress("receipt", "passed");
      },
    });
  const base = `http://127.0.0.1:${runtime.PORT}`;
  const auth = { authorization: `Bearer ${runtime.ACCESS_PASSCODE}` };
  const status = () =>
    requestJson(`${base}/api/deployment/status`, { headers: auth });
  async function idle(draining = false) {
    const first = await status();
    if (!first.idle || (draining && !first.draining)) return false;
    // Once the barrier is in place, require a stable quiet interval, not one empty SELECT.
    if (draining) {
      await pause(10_000);
      const second = await status();
      return second.idle && second.draining;
    }
    return true;
  }
  const domain = config.launchdDomain;
  async function stop() {
    let state;
    try {
      state = JSON.parse(
        await fs.readFile(join(config.root, "runtime-state.json"), "utf8"),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const installed = await execute(
      "/bin/launchctl",
      ["print", `${domain}/com.douglasdong.agent-platform.api`],
      { env },
    ).then(
      () => true,
      () => false,
    );
    if (installed) {
      const [command, args] = serviceCommand(config, "stop");
      await execute(command, args, { env });
    }
    if (!state) return;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        process.kill(state.pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") return;
        throw error;
      }
      await pause(1_000);
    }
    throw new Error("Old API did not exit; refusing to start a second API");
  }
  async function pointTo(path) {
    const link = join(config.root, "current.next");
    await fs.rm(link, { force: true });
    await fs.symlink(path, link);
    await fs.rename(link, join(config.root, "current"));
  }
  async function start(candidate) {
    await pointTo(candidate.path);
    const [command, args] = serviceCommand(config, "start");
    await execute(command, args, { env });
    for (let attempt = 0; attempt < 90; attempt++) {
      try {
        const health = await requestJson(`${base}/api/health`);
        const version = await requestJson(`${base}/api/system/version`, {
          headers: auth,
        });
        const deployment = await status();
        if (
          health.status === "ok" &&
          version.commit === candidate.sha &&
          deployment.ready === true
        )
          return;
      } catch {
        /* Startup has not reached readiness yet. */
      }
      await pause(1_000);
    }
    throw new Error("Candidate failed authenticated readiness");
  }
  async function prepare(previous) {
    if (previous) {
      // SQLite backup API includes WAL; do not copy the main file while it is live.
      const require = createRequire(join(previous.path, "package.json"));
      const Database = require("better-sqlite3");
      const database = new Database(runtime.DATABASE_URL, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        await database.backup(
          join(config.root, "backups", `${previous.sha}-${Date.now()}.db`),
        );
      } finally {
        database.close();
      }
    } else {
      // First installation must never take over an unmanaged process or nonempty data.
      if (await fs.stat(runtime.DATABASE_URL).catch(() => null))
        throw new Error("Existing data needs explicit adoption");
      try {
        await requestJson(`${base}/api/health`);
        throw new Error("Port already serves an unmanaged API");
      } catch (error) {
        if (!String(error.cause?.code).includes("ECONNREFUSED")) throw error;
      }
    }
  }
  async function stillApproved() {
    const latest = validateConfig(
      JSON.parse(await privateFile(join(config.root, "config.json"))),
    );
    const latestRuntime = runtimeEnvironment(
      await privateFile(config.runtimeEnvFile),
      latest,
    );
    return (
      latest.deployEnabled &&
      JSON.stringify(latest) === JSON.stringify(config) &&
      JSON.stringify(latestRuntime) === JSON.stringify(runtime)
    );
  }
  // Manual/unknown barriers and disabled channels are never automatically reopened.
  const receipt = await readJenkinsReceipt(config, request);
  const recovery = receipt
    ? await recoverMaintenanceBarrier(runtime.DEPLOYMENT_DRAIN_FILE, {
        deployEnabled: config.deployEnabled,
        stillApproved,
        isReady: async () => {
          const managed = await current();
          const version = await requestJson(`${base}/api/system/version`, {
            headers: auth,
          });
          const deployment = await status();
          return Boolean(
            managed && version.commit === managed.sha && deployment.ready,
          );
        },
      })
    : { state: "no-maintenance" };
  if (!["no-maintenance", "maintenance-recovered"].includes(recovery.state))
    return recovery;
  let heldBarrier = null;
  return runCycle(config, {
    request,
    head,
    current,
    build: async () => {
      const verified = await readJenkinsReceipt(config, request);
      if (!verified) throw new Error("Jenkins receipt is no longer valid");
      return verified.candidate;
    },
    idle,
    activate: (candidate, previous) =>
      activateRelease(candidate, previous, { prepare, stop, start }),
    healthy: async (managed) => {
      try {
        const version = await requestJson(`${base}/api/system/version`, {
          headers: auth,
        });
        const deployment = await status();
        return version.commit === managed.sha && deployment.ready === true;
      } catch {
        return false;
      }
    },
    stillApproved,
    descendsFrom,
    ci: () => readJenkinsReceipt(config, request),
    drain: async () => {
      heldBarrier = await createMaintenanceBarrier(
        runtime.DEPLOYMENT_DRAIN_FILE,
      );
    },
    resume: () =>
      releaseMaintenanceBarrier(runtime.DEPLOYMENT_DRAIN_FILE, heldBarrier),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const config = validateConfig(JSON.parse(await privateFile(process.argv[2])));
  try {
    if (process.argv[3] === "head") {
      console.log(JSON.stringify(await remoteHead(config)));
    } else {
      const request = jenkinsInvocation(
        config,
        process.argv[3],
        process.argv[4],
        process.argv[5],
        process.env.BUILD_URL,
      );
      const result = await withLock(join(config.root, "controller.lock"), () =>
        reconcile(config, request),
      );
      await atomicJson(join(config.root, "status.json"), {
        ...result,
        updatedAt: new Date().toISOString(),
      });
      console.log(JSON.stringify(result));
    }
  } catch (error) {
    // Error messages originate from our own fixed operations; no environment or HTTP bodies.
    const result = {
      state: "error",
      error: error.message,
      ...(error.stage
        ? {
            stage: error.stage,
            artifactPath: error.artifactPath,
            logPath: error.logPath,
          }
        : {}),
      ...(error.rollbackReady ? { rollbackReady: true } : {}),
      updatedAt: new Date().toISOString(),
    };
    await atomicJson(join(config.root, "status.json"), result);
    console.error(JSON.stringify(result));
    process.exitCode = 1;
  }
}
