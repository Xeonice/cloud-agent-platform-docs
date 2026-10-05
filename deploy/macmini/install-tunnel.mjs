import * as fs from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  privateFile,
  atomicJson,
  validateConfig,
  JENKINS_JOB,
} from "./lib.mjs";
import {
  assertNativeServiceIdentity,
  SERVICE_UID,
  servicePlist,
  SERVICE_HELPER,
} from "./system-services.mjs";

const root = join(homedir(), ".local/share/agent-platform-deploy");
const label = "com.douglasdong.agent-platform.tunnel";
const tokenFile = join(root, "cloudflared.token");
const plistFile = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
const config = JSON.parse(await privateFile(join(root, "config.json")));
const domain = config.launchdDomain ?? `gui/${process.getuid()}`;
const validated = validateConfig({
  ...config,
  ciProvider: config.ciProvider ?? "jenkins",
  jenkinsJob: config.jenkinsJob ?? JENKINS_JOB,
  launchdDomain: domain,
});
assertNativeServiceIdentity(validated);
if (
  process.getuid() !== SERVICE_UID ||
  process.geteuid() !== SERVICE_UID ||
  process.versions.node.split(".")[0] !== "22" ||
  process.platform !== "darwin"
)
  throw new Error("Tunnel tools require macOS Node22 as douglasdong/UID501");
const action = process.argv[2] ?? "status";
function launch(args, required = true) {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (required && result.status !== 0)
    throw new Error(`launchctl ${args[0]} failed (${result.status})`);
  return result.status === 0;
}
if (action === "install") {
  if (domain === "system")
    throw new Error(
      "System Tunnel installation requires reviewed install-system-services prepare/apply",
    );
  const tunnelId = process.argv[3];
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      tunnelId ?? "",
    )
  )
    throw new Error("install requires the new agent-platform-api Tunnel UUID");
  const token = (await privateFile(tokenFile)).trim();
  let claims;
  try {
    claims = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
  } catch {
    throw new Error("Invalid Tunnel token file");
  }
  if (
    claims.a !== "d3490c6f8d3310941a3a88d7f163ab3d" ||
    claims.t !== tunnelId ||
    typeof claims.s !== "string"
  )
    throw new Error(
      "Token must belong to the dedicated Tunnel in the approved account",
    );
  if (launch(["print", `${domain}/${label}`], false))
    throw new Error("Dedicated Tunnel is already loaded");
  await fs.mkdir(join(root, "tmp"), { recursive: true, mode: 0o700 });
  const plist = servicePlist("tunnel", validated);
  await fs.writeFile(plistFile, plist, { mode: 0o600 });
  if (spawnSync("/usr/bin/plutil", ["-lint", plistFile]).status !== 0)
    throw new Error("Invalid Tunnel LaunchAgent");
  await atomicJson(join(root, "tunnel.json"), {
    tunnelId,
    hostname: "agent-api.douglasdong.com",
    service: "http://127.0.0.1:3101",
  });
  launch(["bootstrap", domain, plistFile]);
  console.log(JSON.stringify({ state: "tunnel-loaded", tunnelId, label }));
} else if (action === "status") {
  console.log(
    JSON.stringify({
      loaded: launch(["print", `${domain}/${label}`], false),
      domain,
      logPath: join(root, "logs/tunnel.log"),
      tokenFileExists: Boolean(await fs.stat(tokenFile).catch(() => null)),
    }),
  );
} else if (action === "stop") {
  if (domain === "system") {
    const result = spawnSync(
      "/usr/bin/sudo",
      ["-n", SERVICE_HELPER, "tunnel", "stop"],
      { encoding: "utf8", timeout: 40_000 },
    );
    if (result.error || result.status !== 0)
      throw new Error(
        "System Tunnel stop requires the installed narrow service helper",
      );
  } else if (launch(["print", `${domain}/${label}`], false))
    launch(["bootout", `${domain}/${label}`]);
  console.log(JSON.stringify({ state: "tunnel-unloaded" }));
} else
  throw new Error("Commands: install <dedicated-tunnel-uuid>, status, stop");
