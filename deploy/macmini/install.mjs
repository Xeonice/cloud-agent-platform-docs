import * as fs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  atomicJson,
  privateFile,
  REPOSITORY,
  BRANCH,
  JENKINS_JOB,
  SHA,
  validateConfig,
  runtimeEnvironment,
} from "./lib.mjs";
import {
  assertNativeServiceIdentity,
  servicePlist,
  SERVICE_UID,
} from "./system-services.mjs";

const root = join(homedir(), ".local/share/agent-platform-deploy");
const configPath = join(root, "config.json");
const agentFolder = join(homedir(), "Library/LaunchAgents");
const uid = process.getuid();
const command = process.argv[2] ?? "status";
const domain = `gui/${uid}`;
const labels = {
  cicd: "com.douglasdong.agent-platform.cicd",
  api: "com.douglasdong.agent-platform.api",
};
function compatibleConfig(value) {
  return validateConfig({
    ...value,
    ciProvider: value.ciProvider ?? "jenkins",
    jenkinsJob: value.jenkinsJob ?? JENKINS_JOB,
    launchdDomain: value.launchdDomain ?? domain,
  });
}
function launch(args, required = true) {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (required && result.status !== 0)
    throw new Error(`launchctl ${args[0]} failed (${result.status})`);
  return result.status === 0;
}
if (
  process.platform !== "darwin" ||
  process.arch !== "arm64" ||
  process.versions.node.split(".")[0] !== "22" ||
  uid !== SERVICE_UID
)
  throw new Error("Use the installed Node 22 on the ARM64 Mac mini");

if (command === "init" || command === "update-tools") {
  if (
    launch(["print", `${domain}/${labels.api}`], false) ||
    launch(["print", `system/${labels.api}`], false)
  )
    throw new Error(
      "Live API tools require reviewed idle/drain cutover, not in-place overwrite",
    );
  for (const path of [
    root,
    join(root, "tools"),
    join(root, "logs"),
    join(root, "releases"),
    join(root, "backups"),
    join(root, "tmp"),
  ]) {
    await fs.mkdir(path, { recursive: true, mode: 0o700 });
    await fs.chmod(path, 0o700);
  }
  if (
    command === "update-tools" &&
    launch(["print", `${domain}/${labels.cicd}`], false)
  )
    throw new Error(
      "Stop the CI/CD LaunchAgent before updating its installed controller",
    );
  const source = dirname(fileURLToPath(import.meta.url));
  for (const name of [
    "controller.mjs",
    "runtime.mjs",
    "lib.mjs",
    "install.mjs",
    "install-tunnel.mjs",
    "system-services.mjs",
    "install-system-services.mjs",
  ]) {
    await fs.copyFile(join(source, name), join(root, "tools", name));
    await fs.chmod(join(root, "tools", name), 0o600);
  }
  await fs.mkdir(agentFolder, { recursive: true });
  const runtimePlist = join(agentFolder, `${labels.api}.plist`);
  let config;
  try {
    config = compatibleConfig(JSON.parse(await privateFile(configPath)));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const production = join(homedir(), "agent-platform/production");
    await fs.mkdir(production, { recursive: true, mode: 0o700 });
    if (await fs.stat(join(production, "platform.db")).catch(() => null))
      throw new Error("Production data already exists; review adoption first");
    config = {
      repository: REPOSITORY,
      branch: BRANCH,
      ciProvider: "jenkins",
      jenkinsJob: JENKINS_JOB,
      launchdDomain: domain,
      root,
      uid,
      node: process.execPath,
      corepack: resolve(
        dirname(process.execPath),
        "../lib/node_modules/corepack/dist/corepack.js",
      ),
      runtimeEnvFile: join(root, "runtime.env"),
      runtimePlist,
      deployEnabled: false,
      minimumCommit: null,
      channelStartedAt: new Date().toISOString(),
    };
    const runtime = [
      "HOST=127.0.0.1",
      "PORT=3101",
      `DATA_ROOT=${production}`,
      `DATABASE_URL=${join(production, "platform.db")}`,
      `BOXLITE_HOME=${join(production, "boxlite")}`,
      "API_ALLOWED_ORIGINS=https://agent.douglasdong.com,https://agent-api.douglasdong.com",
      "API_TRUST_PROXY=cloudflare-loopback",
      "PASSCODE_COOKIE_SECURE=true",
      `ACCESS_PASSCODE=${randomBytes(24).toString("base64url")}`,
      `PASSCODE_COOKIE_SECRET=${randomBytes(48).toString("base64url")}`,
      "ACCESS_PASSCODE_ALLOW_LOOPBACK=false",
      "ACCESS_PASSCODE_AUTO_GENERATE=false",
      "SANDBOX_RECONCILE_ON_BOOT=true",
      `DEPLOYMENT_DRAIN_FILE=${join(root, "maintenance")}`,
      "SCHEDULER_HOST_CORES=8",
      "SCHEDULER_HOST_RAM_MB=32768",
      "SCHEDULER_HOST_DISK_MB=131072",
      "",
    ].join("\n");
    runtimeEnvironment(runtime, config);
    await fs.writeFile(config.runtimeEnvFile, runtime, {
      flag: "wx",
      mode: 0o600,
    });
    await atomicJson(configPath, config);
  }
  assertNativeServiceIdentity(config);
  for (const [kind, label] of Object.entries({ api: labels.api })) {
    if (config.launchdDomain === "system") continue;
    const path = join(agentFolder, `${label}.plist`);
    await fs.writeFile(path, servicePlist(kind, config), { mode: 0o600 });
    const check = spawnSync("/usr/bin/plutil", ["-lint", path], {
      encoding: "utf8",
    });
    if (check.status !== 0) throw new Error("Invalid LaunchAgent plist");
  }
  console.log(
    JSON.stringify({
      state: "installed",
      root,
      deployEnabled: config.deployEnabled,
      port: 3101,
      ciProvider: "jenkins",
      pollingInstalled: false,
    }),
  );
} else if (command === "start") {
  throw new Error(
    "Polling LaunchAgent is retired; start reviewed Jenkins/system services instead",
  );
} else if (command === "stop" || command === "retire-polling") {
  const config = JSON.parse(await privateFile(configPath));
  const oldPlist = join(agentFolder, `${labels.cicd}.plist`);
  const exists = await fs.lstat(oldPlist).catch(() => null);
  if (exists || launch(["print", `${domain}/${labels.cicd}`], false))
    await atomicJson(configPath, { ...config, deployEnabled: false });
  if (launch(["print", `${domain}/${labels.cicd}`], false))
    launch(["bootout", `${domain}/${labels.cicd}`]);
  launch(["disable", `${domain}/${labels.cicd}`]);
  let archived = null;
  if (exists) {
    await privateFile(oldPlist);
    const folder = join(root, "retired-launchagents");
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    archived = join(folder, `${labels.cicd}.${Date.now()}.plist`);
    await fs.rename(oldPlist, archived);
  }
  console.log(
    JSON.stringify({
      state: "polling-retired",
      archived,
      disabled: true,
      apiUnchanged: true,
    }),
  );
} else if (command === "enable" || command === "disable") {
  const config = validateConfig(JSON.parse(await privateFile(configPath)));
  config.deployEnabled = command === "enable";
  if (command === "enable") {
    const sha = process.argv[3];
    if (!SHA.test(sha ?? ""))
      throw new Error("enable requires the reviewed full API commit SHA");
    config.minimumCommit = sha;
  }
  await atomicJson(configPath, config);
  console.log(
    JSON.stringify({
      state: command === "enable" ? "deployment-enabled" : "build-only",
      minimumCommit: config.minimumCommit,
    }),
  );
} else if (command === "status") {
  const config = compatibleConfig(JSON.parse(await privateFile(configPath)));
  const status = JSON.parse(
    await fs
      .readFile(join(root, "status.json"), "utf8")
      .catch(() => '{"state":"not-yet-run"}'),
  );
  console.log(
    JSON.stringify(
      {
        ...status,
        cicdLoaded: launch(["print", `${domain}/${labels.cicd}`], false),
        apiLoaded: launch(
          ["print", `${config.launchdDomain}/${labels.api}`],
          false,
        ),
        runtimeDomain: config.launchdDomain,
        ciProvider: config.ciProvider,
        systemStatePath: join(root, "system-services-state.json"),
        logs: join(root, "logs"),
      },
      null,
      2,
    ),
  );
} else
  throw new Error(
    "Commands: init, update-tools (offline), retire-polling, enable <full-api-sha>, disable, status",
  );
