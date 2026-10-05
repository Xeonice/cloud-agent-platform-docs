import * as fs from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  atomicJson,
  buildEnvironment,
  privateFile,
  readyManifest,
  validateConfig,
  runtimeEnvironment,
  withLock,
  assertNoLiveApi,
} from "./lib.mjs";

const config = validateConfig(JSON.parse(await privateFile(process.argv[2])));
if (
  process.platform !== "darwin" ||
  process.arch !== "arm64" ||
  process.versions.node.split(".")[0] !== "22"
)
  throw new Error("Native runtime requires macOS ARM64 and Node 22");
const result = await withLock(join(config.root, "runtime.lock"), async () => {
  let previous = null;
  try {
    previous = JSON.parse(
      await fs.readFile(join(config.root, "runtime-state.json"), "utf8"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  assertNoLiveApi(previous);
  const release = await fs.realpath(join(config.root, "current"));
  const sha = release.split("/").at(-1);
  if (release !== join(config.root, "releases", sha))
    throw new Error("Release escaped release directory");
  const manifest = await readyManifest(release, sha);
  const runtime = runtimeEnvironment(
    await privateFile(config.runtimeEnvFile),
    config,
  );
  if (
    manifest.dataRoot !== runtime.DATA_ROOT ||
    manifest.databaseUrl !== runtime.DATABASE_URL ||
    manifest.boxliteHome !== runtime.BOXLITE_HOME
  )
    throw new Error(
      "Runtime data differs from the approved release; adoption review required",
    );
  let stopping = false;
  const child = spawn(config.node, [join(release, "apps/api/dist/main.js")], {
    cwd: release,
    env: {
      ...buildEnvironment(config.node),
      ...runtime,
      NODE_ENV: "production",
      MIGRATIONS_DIR: join(release, "drizzle"),
      APP_COMMIT: manifest.sha,
      APP_VERSION: manifest.sha.slice(0, 12),
      APP_BUILT_AT: manifest.builtAt,
    },
    stdio: "inherit",
  });
  const finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(stopping ? 0 : (code ?? 1)));
  });
  const listeners = ["SIGTERM", "SIGINT"].map((signal) => {
    const listener = () => {
      stopping = true;
      child.kill(signal);
    };
    process.on(signal, listener);
    return [signal, listener];
  });
  try {
    if (!child.pid) throw new Error("API did not spawn");
    await atomicJson(join(config.root, "runtime-state.json"), {
      pid: child.pid,
      supervisorPid: process.pid,
      sha,
      startedAt: new Date().toISOString(),
    });
    // Hold the lock until child exit; a killed wrapper leaves an operator recovery gate.
    process.exitCode = await finished;
  } catch (error) {
    child.kill("SIGTERM");
    await finished.catch(() => {});
    throw error;
  } finally {
    for (const [signal, listener] of listeners) process.off(signal, listener);
  }
});
if (result?.state) {
  console.error(JSON.stringify(result));
  process.exitCode = 1;
}
