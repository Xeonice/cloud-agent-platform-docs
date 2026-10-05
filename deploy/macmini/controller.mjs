import * as fs from "node:fs/promises";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as pause } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  atomicJson,
  buildEnvironment,
  migrationsHash,
  privateFile,
  readyManifest,
  releasePath,
  runCycle,
  validateConfig,
  withLock,
  activateRelease,
  runtimeEnvironment,
  createMaintenanceBarrier,
  recoverMaintenanceBarrier,
  releaseMaintenanceBarrier,
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
            new Error(`${command.split("/").at(-1)} exited ${signal ?? code}`),
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

export async function reconcile(config) {
  if (
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    process.versions.node.split(".")[0] !== "22"
  )
    throw new Error("Native releases require macOS ARM64 and Node 22");
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
  async function prepareSource(sha) {
    if (!(await fs.stat(mirror).catch(() => null)))
      await git(["init", "--bare", mirror]);
    await git([
      "--git-dir",
      mirror,
      "fetch",
      "--depth=1",
      remote,
      `refs/heads/${config.branch}`,
    ]);
    const fetched = await git(["--git-dir", mirror, "rev-parse", "FETCH_HEAD"]);
    if (fetched !== sha) throw new Error("Remote changed before checkout");
  }
  async function build(sha) {
    const path = releasePath(config, sha);
    try {
      const manifest = await readyManifest(path, sha);
      if (
        manifest.dataRoot !== identity.dataRoot ||
        manifest.databaseUrl !== identity.databaseUrl ||
        manifest.boxliteHome !== identity.boxliteHome
      )
        throw new Error("Cached release belongs to different persistent data");
      return { ...manifest, path };
    } catch {
      /* A partial build is not a release. Retry only our own unactivated worktree. */
    }
    if ((await current())?.sha === sha)
      throw new Error("Refusing to alter the active release");
    await prepareSource(sha);
    if (await fs.stat(path).catch(() => null))
      await git(["--git-dir", mirror, "worktree", "remove", "--force", path]);
    await git(["--git-dir", mirror, "worktree", "prune"]);
    await git(["--git-dir", mirror, "worktree", "add", "--detach", path, sha]);
    const log = join(config.root, "logs", `build-${sha}.log`);
    await atomicJson(join(config.root, "status.json"), {
      state: "building",
      sha,
      updatedAt: new Date().toISOString(),
    });
    const pnpm = (args) =>
      execute(config.node, [config.corepack, "pnpm", ...args], {
        cwd: path,
        env,
        log,
        timeout: 1_800_000,
      });
    await pnpm([
      "install",
      "--frozen-lockfile",
      "--store-dir",
      join(config.root, "pnpm-store"),
    ]);
    await pnpm(["typecheck"]);
    await pnpm(["lint", "--max-warnings=0"]);
    await pnpm(["format:check"]);
    await pnpm(["check:default-image"]);
    await pnpm(["test:acceptance:report"]);
    await pnpm(["build"]);
    await pnpm(["openapi:emit"]);
    await git(["diff", "--exit-code", "--", "openapi.json"], path);
    await execute(
      config.node,
      [
        "-e",
        "const DB=require('better-sqlite3');const db=new DB(':memory:');db.prepare('select 1').get();db.close()",
      ],
      { cwd: path, env, log },
    );
    await execute(
      config.node,
      [
        "-e",
        "import('@boxlite-ai/boxlite').then(s=>{if(typeof s.JsBoxlite!=='function')process.exit(1)})",
      ],
      { cwd: join(path, "packages/modules/sandbox"), env, log },
    );
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
    return { ...manifest, path };
  }
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
  const domain = `gui/${config.uid}`;
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
    if (installed)
      await execute(
        "/bin/launchctl",
        ["bootout", `${domain}/com.douglasdong.agent-platform.api`],
        { env },
      );
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
    await execute(
      "/bin/launchctl",
      ["bootstrap", domain, config.runtimePlist],
      { env },
    );
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
  const recovery = await recoverMaintenanceBarrier(
    runtime.DEPLOYMENT_DRAIN_FILE,
    {
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
    },
  );
  if (!["no-maintenance", "maintenance-recovered"].includes(recovery.state))
    return recovery;
  let heldBarrier = null;
  return runCycle(config, {
    head,
    current,
    build,
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
    descendsFrom: async (sha, minimum) => {
      if (sha === minimum) return true;
      const comparison = await requestJson(
        `https://api.github.com/repos/${config.repository}/compare/${minimum}...${sha}`,
        { headers: { accept: "application/vnd.github+json" } },
      );
      return comparison.status === "ahead";
    },
    ci: async (sha) => {
      const query = new URLSearchParams({
        branch: config.branch,
        event: "push",
        head_sha: sha,
        per_page: "10",
      });
      const runs = await requestJson(
        `https://api.github.com/repos/${config.repository}/actions/workflows/ci.yml/runs?${query}`,
        {
          headers: {
            accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      return runs.workflow_runs[0];
    },
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
    const result = await withLock(join(config.root, "controller.lock"), () =>
      reconcile(config),
    );
    await atomicJson(join(config.root, "status.json"), {
      ...result,
      updatedAt: new Date().toISOString(),
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    // Error messages originate from our own fixed operations; no environment or HTTP bodies.
    const result = {
      state: "error",
      error: error.message,
      updatedAt: new Date().toISOString(),
    };
    await atomicJson(join(config.root, "status.json"), result);
    console.error(JSON.stringify(result));
    process.exitCode = 1;
  }
}
