import * as fs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const source = dirname(fileURLToPath(import.meta.url));
const home = "/Users/Shared/agent-platform-jenkins";
const tools = "/Users/douglasdong/.local/share/agent-platform-jenkins-tools";
const deployRoot = "/Users/douglasdong/.local/share/agent-platform-deploy";
const node =
  "/Users/douglasdong/.local/share/fnm/node-versions/v22.23.3/installation/bin/node";
const java = "/opt/homebrew/opt/openjdk@21/bin/java";
const war = "/opt/homebrew/opt/jenkins-lts/libexec/jenkins.war";

async function secret(path, value) {
  await fs
    .writeFile(path, value, { flag: "wx", mode: 0o600 })
    .catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  const stat = await fs.lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077
  )
    throw new Error(`Unsafe private file: ${path}`);
}
function xml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character],
  );
}
function plist(label, user, args, cwd, env, log, shutdown = 60) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>UserName</key><string>${user}</string><key>GroupName</key><string>staff</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(cwd)}</string><key>EnvironmentVariables</key><dict>${Object.entries(
    env,
  )
    .map(
      ([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`,
    )
    .join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>20</integer><key>ExitTimeOut</key><integer>${shutdown}</integer>
<key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>\n`;
}
async function capture(command, args) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let value = "";
    child.stdout.on("data", (chunk) => (value += chunk));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? accept(value.trim())
        : reject(new Error("GitHub authentication is unavailable")),
    );
  });
}

for (const path of [
  home,
  join(home, "bootstrap-secrets"),
  join(home, "init.groovy.d"),
  join(home, "managed-pipelines"),
  join(home, "logs"),
  tools,
  join(tools, "system-plists"),
  join(deployRoot, "jenkins-agent"),
]) {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(path)).isSymbolicLink())
    throw new Error("Refusing symlink in managed setup directory");
}
await secret(
  join(home, "bootstrap-secrets/admin-login.json"),
  JSON.stringify({
    username: "douglasdong",
    password: randomBytes(30).toString("base64url"),
  }),
);
await secret(
  join(tools, "admin-login.json"),
  await fs.readFile(join(home, "bootstrap-secrets/admin-login.json")),
);
await secret(
  join(tools, "github-token"),
  await capture("/opt/homebrew/bin/gh", ["auth", "token"]),
);
await fs.copyFile(
  join(source, "bootstrap.groovy"),
  join(home, "init.groovy.d/10-agent-platform.groovy"),
);
const replacements = {
  NODE22: node,
  DEPLOY_ROOT: deployRoot,
  DEPLOY_CONFIG: join(deployRoot, "config.json"),
  DEPLOY_TOOLS: join(deployRoot, "tools"),
  JENKINS_TOOLS: tools,
  JENKINS_SOURCE: join(tools, "source"),
  COREPACK:
    "/Users/douglasdong/.local/share/fnm/node-versions/v22.23.3/installation/lib/node_modules/corepack/dist/corepack.js",
};
for (const file of [
  "api.groovy",
  "native-ci.groovy",
  "monitor.groovy",
  "discover.groovy",
  "release.groovy",
  "contract.groovy",
  "web.groovy",
  "mutation.groovy",
  "sandbox-images.groovy",
]) {
  if (!(await fs.stat(join(source, file)).catch(() => null))) continue;
  const original = await fs.readFile(join(source, file), "utf8");
  const result = original.replace(/@([A-Z_0-9]+)@/g, (_, key) => {
    if (!replacements[key]) throw new Error("Unknown template key");
    return replacements[key].replace(/'/g, "\\'");
  });
  await fs.writeFile(join(home, "managed-pipelines", file), result, {
    mode: 0o600,
  });
}
await secret(
  join(home, "bootstrap-settings.json"),
  JSON.stringify(
    { enabled: false, deployAgentRoot: join(deployRoot, "jenkins-agent") },
    null,
    2,
  ),
);
for (const file of ["jenkins-discover.mjs", "jenkins-ci.mjs"])
  await fs.copyFile(join(source, file), join(tools, file));
const services = [
  {
    label: "com.douglasdong.agent-platform.jenkins",
    user: "_agentplatformjenkins",
    args: [
      java,
      "-Xms256m",
      "-Xmx1024m",
      "-Djenkins.install.runSetupWizard=false",
      "-jar",
      war,
      "--httpListenAddress=127.0.0.1",
      "--httpPort=8080",
    ],
    cwd: home,
    env: {
      JENKINS_HOME: home,
      HOME: home,
      JAVA_HOME: "/opt/homebrew/opt/openjdk@21",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    },
    log: join(home, "logs/jenkins.log"),
  },
  {
    label: "com.douglasdong.agent-platform.jenkins-deploy-agent",
    user: "douglasdong",
    args: [
      java,
      "-Xmx384m",
      "-jar",
      join(home, "agent.jar"),
      "-url",
      "http://127.0.0.1:8080/",
      "-secret",
      `@${deployRoot}/jenkins-agent.secret`,
      "-name",
      "mac-deploy",
      "-webSocket",
      "-workDir",
      join(deployRoot, "jenkins-agent"),
    ],
    cwd: deployRoot,
    env: {
      HOME: "/Users/douglasdong",
      PATH: `${dirname(node)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
    log: join(deployRoot, "logs/jenkins-agent.log"),
  },
  {
    label: "com.douglasdong.agent-platform.jenkins-ci-agent",
    user: "_agentplatformci",
    args: [
      java,
      "-Xmx384m",
      "-jar",
      "/Library/Application Support/AgentPlatform/jenkins-tools/agent.jar",
      "-url",
      "http://127.0.0.1:8080/",
      "-secret",
      "@/Users/Shared/agent-platform-ci/agent.secret",
      "-name",
      "mac-ci",
      "-webSocket",
      "-workDir",
      "/Users/Shared/agent-platform-ci/agent",
    ],
    cwd: "/Users/Shared/agent-platform-ci",
    env: {
      HOME: "/Users/Shared/agent-platform-ci",
      PATH: `${dirname(node)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
    log: "/Users/Shared/agent-platform-ci/agent.log",
  },
  {
    label: "com.douglasdong.agent-platform.build-docker",
    user: "douglasdong",
    args: [
      "/opt/homebrew/bin/colima",
      "start",
      "agent-platform-build",
      "--cpu",
      "4",
      "--memory",
      "8",
      "--disk",
      "100",
      "--vm-type",
      "vz",
      "--runtime",
      "docker",
      "--activate=false",
      "--ssh-config=false",
      "--mount",
      "none",
      "--foreground",
    ],
    cwd: "/Users/douglasdong",
    env: {
      HOME: "/Users/douglasdong",
      PATH: "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin",
    },
    log: join(deployRoot, "logs/build-docker.log"),
  },
];
// Agent jar is installed into a root-owned, readable directory. A controller-private home must never be made readable to agents.
services[1].args[services[1].args.indexOf(join(home, "agent.jar"))] =
  "/Library/Application Support/AgentPlatform/jenkins-tools/agent.jar";
const manifest = {
  services: [],
  tools: [
    { name: "jenkins-ci.mjs", source: join(source, "jenkins-ci.mjs") },
    { name: "agent.jar", source: join(tools, "agent.jar") },
  ],
  secrets: [
    {
      source: join(home, "secrets/mac-deploy.secret"),
      destination: join(deployRoot, "jenkins-agent.secret"),
      owner: "douglasdong",
    },
    {
      source: join(home, "secrets/mac-ci.secret"),
      destination: "/Users/Shared/agent-platform-ci/agent.secret",
      owner: "_agentplatformci",
    },
  ],
};
for (const file of [
  "project-ci.mjs",
  "jenkins-web.mjs",
  "ci-platform.mjs",
  "mutation.mjs",
])
  if (await fs.stat(join(source, file)).catch(() => null))
    manifest.tools.push({ name: file, source: join(source, file) });
manifest.vercelSource = "/Users/Shared/agent-platform-build-tools/vercel";
for (const service of services) {
  const path = join(tools, "system-plists", `${service.label}.plist`);
  await fs.writeFile(
    path,
    plist(
      service.label,
      service.user,
      service.args,
      service.cwd,
      service.env,
      service.log,
    ),
    { mode: 0o600 },
  );
  manifest.services.push({ label: service.label, plist: path });
}
await fs.writeFile(
  join(tools, "system-extras.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(
  JSON.stringify(
    {
      state: "prepared",
      jenkinsHome: home,
      reviewManifest: join(tools, "system-extras.json"),
      loginCredentialFile: join(tools, "admin-login.json"),
      jobsEnabled: false,
    },
    null,
    2,
  ),
);
