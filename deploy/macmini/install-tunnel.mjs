import * as fs from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { privateFile, atomicJson } from "./lib.mjs";

const root = join(homedir(), ".local/share/agent-platform-deploy");
const label = "com.douglasdong.agent-platform.tunnel";
const tokenFile = join(root, "cloudflared.token");
const plistFile = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
const domain = `gui/${process.getuid()}`;
const action = process.argv[2] ?? "status";
function launch(args, required = true) {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (required && result.status !== 0)
    throw new Error(`launchctl ${args[0]} failed (${result.status})`);
  return result.status === 0;
}
function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
if (action === "install") {
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
  const args = [
    "/opt/homebrew/bin/cloudflared",
    "tunnel",
    "--no-autoupdate",
    "--metrics",
    "127.0.0.1:20241",
    "run",
    "--token-file",
    tokenFile,
  ];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>20</integer><key>ExitTimeOut</key><integer>30</integer><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(root, "logs/tunnel.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(root, "logs/tunnel.log"))}</string>
</dict></plist>\n`;
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
      tokenFileExists: Boolean(await fs.stat(tokenFile).catch(() => null)),
    }),
  );
} else if (action === "stop") {
  if (launch(["print", `${domain}/${label}`], false))
    launch(["bootout", `${domain}/${label}`]);
  console.log(JSON.stringify({ state: "tunnel-unloaded" }));
} else
  throw new Error("Commands: install <dedicated-tunnel-uuid>, status, stop");
