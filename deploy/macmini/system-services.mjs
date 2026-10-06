import { dirname, join, isAbsolute } from "node:path";

export const SERVICE_USER = "douglasdong";
export const SERVICE_UID = 501;
export const SERVICE_GID = 20;
export const SERVICE_HOME = "/Users/douglasdong";
export const DEPLOY_ROOT = join(
  SERVICE_HOME,
  ".local/share/agent-platform-deploy",
);
export const SERVICE_HELPER =
  "/Library/PrivilegedHelperTools/com.douglasdong.agent-platform-service";
export const SUDOERS_FILE = "/etc/sudoers.d/agent-platform-service";
export const LABELS = {
  api: "com.douglasdong.agent-platform.api",
  tunnel: "com.douglasdong.agent-platform.tunnel",
  cicd: "com.douglasdong.agent-platform.cicd",
};
export const ACCOUNTS = {
  _agentplatformjenkins: "/Users/Shared/agent-platform-jenkins",
  _agentplatformci: "/Users/Shared/agent-platform-ci",
};
export const EXTRA_SERVICES = {
  "com.douglasdong.agent-platform.jenkins": "_agentplatformjenkins",
  "com.douglasdong.agent-platform.jenkins-deploy-agent": SERVICE_USER,
  "com.douglasdong.agent-platform.jenkins-ci-agent": "_agentplatformci",
  "com.douglasdong.agent-platform.build-docker": SERVICE_USER,
};
export const CI_TOOLS =
  "/Library/Application Support/AgentPlatform/jenkins-tools";
export const PUBLIC_TOOLS = [
  "jenkins-ci.mjs",
  "project-ci.mjs",
  "jenkins-web.mjs",
  "ci-platform.mjs",
  "mutation.mjs",
  "agent.jar",
];
export const SECRET_HANDOFFS = [
  {
    source: join(ACCOUNTS._agentplatformjenkins, "secrets/mac-deploy.secret"),
    destination: join(DEPLOY_ROOT, "jenkins-agent.secret"),
    owner: SERVICE_USER,
  },
  {
    source: join(ACCOUNTS._agentplatformjenkins, "secrets/mac-ci.secret"),
    destination: join(ACCOUNTS._agentplatformci, "agent.secret"),
    owner: "_agentplatformci",
  },
];

export function validateSecretHandoffs(items) {
  if (!Array.isArray(items) || items.length > SECRET_HANDOFFS.length)
    throw new Error("Invalid secret handoff list");
  const destinations = new Set();
  for (const item of items) {
    if (
      !SECRET_HANDOFFS.some(
        (allowed) =>
          item.source === allowed.source &&
          item.destination === allowed.destination &&
          item.owner === allowed.owner,
      ) ||
      destinations.has(item.destination)
    )
      throw new Error(
        "Secret handoff must use the fixed Jenkins-to-agent file paths and identities",
      );
    destinations.add(item.destination);
  }
  return items;
}

export function assertNativeServiceIdentity(config) {
  if (
    config.uid !== SERVICE_UID ||
    config.root !== DEPLOY_ROOT ||
    config.runtimeEnvFile !== join(DEPLOY_ROOT, "runtime.env") ||
    !isAbsolute(config.node)
  )
    throw new Error(
      "Only the dedicated douglasdong/UID501 production installation is supported",
    );
}

export function assertRuntimeUser(config) {
  // Private configs/manifests validate the runtime paths; installation separately
  // pins the production root. Isolated acceptance releases remain possible.
  if (
    process.getuid() === 0 ||
    config.uid !== process.getuid() ||
    config.uid !== process.geteuid()
  )
    throw new Error(
      "Runtime must run as its private configuration owner, never as root",
    );
  if (config.root === DEPLOY_ROOT) {
    assertNativeServiceIdentity(config);
    if (process.getuid() !== SERVICE_UID || process.getgid() !== SERVICE_GID)
      throw new Error(
        "Production API must run as douglasdong/UID501 and staff",
      );
  }
}

export function systemPlistPath(label) {
  if (
    ![LABELS.api, LABELS.tunnel, ...Object.keys(EXTRA_SERVICES)].includes(label)
  )
    throw new Error("Unknown production service label");
  return join("/Library/LaunchDaemons", `${label}.plist`);
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function servicePlist(kind, config, { system = false } = {}) {
  assertNativeServiceIdentity(config);
  if (!["api", "tunnel"].includes(kind))
    throw new Error("Unknown service kind");
  const args =
    kind === "api"
      ? [
          config.node,
          join(config.root, "tools/runtime.mjs"),
          join(config.root, "config.json"),
        ]
      : [
          "/opt/homebrew/bin/cloudflared",
          "tunnel",
          "--no-autoupdate",
          "--metrics",
          "127.0.0.1:20241",
          "run",
          "--token-file",
          join(config.root, "cloudflared.token"),
        ];
  const environment = {
    HOME: SERVICE_HOME,
    USER: SERVICE_USER,
    LOGNAME: SERVICE_USER,
    PATH: `${dirname(config.node)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: "en_US.UTF-8",
    TMPDIR: join(config.root, "tmp"),
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${LABELS[kind]}</string>
${system ? `<key>UserName</key><string>${SERVICE_USER}</string><key>GroupName</key><string>staff</string>` : ""}
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(config.root)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(environment)
    .map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`)
    .join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>20</integer><key>ExitTimeOut</key><integer>${kind === "api" ? 60 : 30}</integer><key>Umask</key><integer>63</integer>
${kind === "api" ? "<key>AbandonProcessGroup</key><true/>" : ""}
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(join(config.root, `logs/${kind}.log`))}</string>
<key>StandardErrorPath</key><string>${xml(join(config.root, `logs/${kind}.log`))}</string>
</dict></plist>\n`;
}

export function validateExtraPlist(plist, label) {
  const user = EXTRA_SERVICES[label];
  if (
    !user ||
    plist.Label !== label ||
    plist.UserName !== user ||
    plist.GroupName !== "staff"
  )
    throw new Error(
      "Additional service must use its fixed unprivileged identity",
    );
  const home = user === SERVICE_USER ? SERVICE_HOME : ACCOUNTS[user];
  if (
    plist.EnvironmentVariables?.HOME !== home ||
    plist.RunAtLoad !== true ||
    !Array.isArray(plist.ProgramArguments) ||
    !isAbsolute(plist.ProgramArguments[0] ?? "") ||
    !isAbsolute(plist.WorkingDirectory ?? "")
  )
    throw new Error(
      "Additional service has invalid executable, home or working directory",
    );
  const envKeys = new Set([
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "LANG",
    "JAVA_HOME",
    "JENKINS_HOME",
    "TMPDIR",
  ]);
  if (
    Object.keys(plist.EnvironmentVariables ?? {}).some(
      (key) => !envKeys.has(key),
    )
  )
    throw new Error(
      "Service plist must not embed secrets or unsupported environment variables",
    );
  const secret = plist.ProgramArguments.indexOf("-secret");
  if (secret >= 0 && !plist.ProgramArguments[secret + 1]?.startsWith("@/"))
    throw new Error(
      "Inbound agent secret must be a file reference, not a command-line secret",
    );
  for (const key of ["StandardOutPath", "StandardErrorPath"])
    if (!isAbsolute(plist[key] ?? ""))
      throw new Error("Service needs absolute persistent log paths");
  if (
    user === "_agentplatformci" &&
    plist.WorkingDirectory !== home &&
    !plist.WorkingDirectory.startsWith(`${home}/`)
  )
    throw new Error(
      "Untrusted CI work must remain inside the isolated CI home",
    );
  if (
    label === "com.douglasdong.agent-platform.build-docker" &&
    (plist.ProgramArguments[0] !== "/opt/homebrew/bin/colima" ||
      plist.ProgramArguments[1] !== "start" ||
      plist.ProgramArguments[2] !== "agent-platform-build" ||
      !plist.ProgramArguments.includes("--foreground") ||
      !plist.ProgramArguments.includes("--activate=false") ||
      !plist.ProgramArguments.includes("--ssh-config=false") ||
      !plist.ProgramArguments.some(
        (value, index) =>
          value === "--mount" && plist.ProgramArguments[index + 1] === "none",
      ))
  )
    throw new Error(
      "Build Docker must use only the dedicated foreground Colima profile without global context/SSH/mount changes",
    );
  return plist;
}

export function serviceControlScript() {
  return `#!/bin/sh
# Root-owned narrow launchd control; application code always runs under UserName.
set -eu
[ "$(/usr/bin/id -u)" = 0 ] || exit 77
[ "$#" = 2 ] || exit 64
case "$1" in
  api) label='${LABELS.api}' ;;
  tunnel) label='${LABELS.tunnel}' ;;
  *) exit 64 ;;
esac
case "$2" in start|stop|restart|status) ;; *) exit 64 ;; esac
target="system/$label"
plist="/Library/LaunchDaemons/$label.plist"
loaded() { /bin/launchctl print "$target" >/dev/null 2>&1; }
start() {
  [ -f "$plist" ] && [ ! -L "$plist" ] || exit 78
  [ "$(/usr/bin/stat -f %u "$plist")" = 0 ] || exit 78
  [ "$(/usr/bin/stat -f %Lp "$plist")" = 644 ] || exit 78
  if loaded; then return; fi
  /bin/launchctl enable "$target"
  /bin/launchctl bootstrap system "$plist"
}
stop() { if loaded; then /bin/launchctl bootout "$target"; fi; }
case "$2" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) if loaded; then printf 'loaded\\n'; else printf 'unloaded\\n'; exit 3; fi ;;
esac
`;
}

export function serviceSudoers() {
  const commands = ["api", "tunnel"].flatMap((kind) =>
    ["start", "stop", "restart", "status"].map(
      (action) => `${SERVICE_HELPER} ${kind} ${action}`,
    ),
  );
  return `# Fixed production labels only; no generic launchctl or root Node permission.\n${SERVICE_USER} ALL=(root) NOPASSWD: ${commands.join(", ")}\n`;
}
