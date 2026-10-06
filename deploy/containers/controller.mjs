import * as fs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validatePluginLock } from "./plugins.mjs";

const source = dirname(fileURLToPath(import.meta.url));
export const CONTROLLER_HOST =
  "unix:///Users/douglasdong/.colima/agent-platform-jenkins/docker.sock";
export const BUILD_HOST =
  "unix:///Users/douglasdong/.colima/agent-platform-build/docker.sock";
export const PUBLIC_CONTROLLER_URL = "https://jenkins.douglasdong.com/";
const LOCAL_CONTROLLER_URL = "http://127.0.0.1:8080/";
const LAB_CONTROLLER_URL = "http://127.0.0.1:18080/";
const CONTROLLER_URL_EXPRESSION =
  "${AGENT_PLATFORM_JENKINS_URL:-http://127.0.0.1:8080/}";
function requirePolicy(condition, message) {
  if (!condition) throw new Error(message);
}

function onlyKeys(value, allowed) {
  return value && Object.keys(value).every((key) => allowed.includes(key));
}

const CI_VOLUMES = {
  workspace: "agent-platform-linux-ci-workspace",
  web_workspace: "agent-platform-linux-web-workspace",
  ci_credentials: "agent-platform-linux-ci-credentials",
  web_credentials: "agent-platform-linux-web-credentials",
  ci_agent: "agent-platform-linux-ci-agent-workspace",
  ci_state: "agent-platform-linux-ci-jenkins-state",
  web_agent: "agent-platform-linux-web-agent-workspace",
  web_state: "agent-platform-linux-web-jenkins-state",
};

function ciMounts(service) {
  requirePolicy(
    service === "agent" || service === "web",
    "Unknown isolated CI service",
  );
  const web = service === "web";
  return [
    { source: web ? "web_workspace" : "workspace", target: "/home/jenkins" },
    { source: web ? "web_agent" : "ci_agent", target: "/home/jenkins/agent" },
    {
      source: web ? "web_state" : "ci_state",
      target: "/home/jenkins/.jenkins",
    },
    {
      source: web ? "web_credentials" : "ci_credentials",
      target: "/run/secrets",
      read_only: true,
    },
  ];
}

// Compose's explicit entries alone cannot prove that an inherited image VOLUME
// has not introduced an anonymous child mount. Check the actual inspect result.
export function validateCiMounts(service, mounts) {
  const expected = ciMounts(service);
  requirePolicy(
    Array.isArray(mounts) && mounts.length === expected.length,
    "CI runtime must have exactly four fixed named mounts",
  );
  for (const mount of expected) {
    const name = CI_VOLUMES[mount.source];
    const actual = mounts.find((value) => value.Destination === mount.target);
    requirePolicy(
      actual?.Type === "volume" &&
        actual.Name === name &&
        actual.RW === !mount.read_only &&
        actual.Source === `/var/lib/docker/volumes/${name}/_data`,
      "CI runtime has an anonymous, shared, host-backed or wrongly writable mount",
    );
  }
  return mounts;
}

export function resolveControllerMode(value = process.env.CONTROLLER_MODE) {
  const mode = value === undefined || value === "" ? "migration" : value;
  requirePolicy(
    mode === "migration" || mode === "active",
    "CONTROLLER_MODE must be migration or active",
  );
  return mode;
}

export function resolveControllerUrl(
  value = process.env.AGENT_PLATFORM_JENKINS_URL,
  mode = resolveControllerMode(),
) {
  requirePolicy(
    ["lab", "migration", "active"].includes(mode),
    "Invalid controller URL mode",
  );
  const url =
    value === undefined || value === ""
      ? mode === "lab"
        ? LAB_CONTROLLER_URL
        : LOCAL_CONTROLLER_URL
      : value;
  requirePolicy(
    mode === "lab"
      ? url === LAB_CONTROLLER_URL
      : url === LOCAL_CONTROLLER_URL || url === PUBLIC_CONTROLLER_URL,
    "AGENT_PLATFORM_JENKINS_URL must be an exact approved controller URL",
  );
  return url;
}

export function validateControllerCompose(config, mode) {
  requirePolicy(
    mode === "lab" || mode === "migration",
    "Invalid controller config mode",
  );
  requirePolicy(
    onlyKeys(config, ["name", "services", "volumes", "networks"]),
    "Unexpected controller configuration fields",
  );
  requirePolicy(
    Object.keys(config.services ?? {}).join() === "controller",
    "Controller profile must contain only the controller",
  );
  const service = config.services.controller;
  requirePolicy(
    onlyKeys(service, [
      "build",
      "image",
      "platform",
      "user",
      "ports",
      "environment",
      "volumes",
      "networks",
      "restart",
      "read_only",
      "tmpfs",
      "security_opt",
      "cap_drop",
      "mem_limit",
      "cpus",
      "pids_limit",
      "stop_grace_period",
      "logging",
    ]),
    "Unexpected controller service privileges or overrides",
  );
  requirePolicy(
    service.user === "1000:1000" && service.platform === "linux/arm64",
    "Controller must be non-root Linux ARM64",
  );
  const ports = service.ports;
  requirePolicy(
    Array.isArray(ports) &&
      ports.length === 1 &&
      ports[0].host_ip === "127.0.0.1" &&
      ports[0].target === 8080 &&
      ports[0].published === (mode === "lab" ? "18080" : "8080"),
    "Only the fixed loopback HTTP port is permitted",
  );
  requirePolicy(
    service.environment?.AGENT_PLATFORM_CONTROLLER_MODE ===
      (mode === "lab" ? "lab" : "${CONTROLLER_MODE:-migration}") &&
      (mode === "lab"
        ? service.environment?.AGENT_PLATFORM_JENKINS_URL === LAB_CONTROLLER_URL
        : [
            LOCAL_CONTROLLER_URL,
            PUBLIC_CONTROLLER_URL,
            CONTROLLER_URL_EXPRESSION,
          ].includes(service.environment?.AGENT_PLATFORM_JENKINS_URL)) &&
      Object.keys(service.environment).length === 2,
    "Controller environment is outside the fixed policy",
  );
  requirePolicy(
    !service.privileged &&
      !service.pid &&
      !service.network_mode &&
      !service.devices &&
      !service.secrets &&
      !service.command &&
      !service.entrypoint &&
      !service.extra_hosts,
    "Controller cannot acquire host or agent execution privileges",
  );
  requirePolicy(
    service.read_only === true &&
      service.security_opt?.join() === "no-new-privileges:true" &&
      service.cap_drop?.join() === "ALL",
    "Controller container isolation policy is missing",
  );
  requirePolicy(
    service.volumes?.length === 1 &&
      service.volumes[0].type === "volume" &&
      service.volumes[0].source === "home" &&
      service.volumes[0].target === "/var/jenkins_home",
    "Only the dedicated Jenkins Home volume is permitted",
  );
  requirePolicy(
    service.networks?.join() === "controller" &&
      Object.keys(config.networks ?? {}).join() === "controller",
    "Controller network must be separate from build and production services",
  );
  requirePolicy(
    service.restart === "unless-stopped" &&
      service.logging?.options?.["max-size"] === "10m" &&
      service.logging?.options?.["max-file"] === "3",
    "Bounded logs and a Docker restart policy are required",
  );
  requirePolicy(
    Object.keys(config.volumes ?? {}).join() === "home",
    "Unexpected controller volumes",
  );
  if (mode === "lab") {
    requirePolicy(
      onlyKeys(config.volumes.home, ["name"]) &&
        onlyKeys(service.build, ["context", "dockerfile"]),
      "Lab volume and build must use the reviewed definitions",
    );
    requirePolicy(
      config.name === "agent-platform-jenkins-lab" &&
        config.volumes.home.name === "agent-platform-jenkins-lab-home" &&
        !config.volumes.home.external,
      "Lab Home must be distinct from migrated Home",
    );
    requirePolicy(
      service.build?.context ===
        "${CONTROLLER_BUILD_CONTEXT:?Provide reviewed minimal build context}" &&
        service.build?.dockerfile ===
          "deploy/containers/controller.Dockerfile" &&
        service.image === "agent-platform-jenkins-controller:2.580.1",
      "Lab builds require the reviewed minimal context",
    );
  } else {
    requirePolicy(
      onlyKeys(config.volumes.home, ["name", "external"]),
      "Migrated Home cannot use host-backed driver overrides",
    );
    requirePolicy(
      config.name === "agent-platform-jenkins-controller" &&
        config.volumes.home.name === "agent-platform-jenkins-home" &&
        config.volumes.home.external === true,
      "Production must use an explicitly imported external Home volume",
    );
    requirePolicy(
      !service.build &&
        service.image ===
          "${CONTROLLER_IMAGE:?Provide verified controller image digest}",
      "Migrated controller must use a verified image without rebuilding",
    );
  }
  return config;
}

export function validateCiCompose(config) {
  requirePolicy(
    onlyKeys(config, ["name", "services", "volumes", "networks"]),
    "Unexpected CI configuration fields",
  );
  requirePolicy(
    config.name === "agent-platform-linux-ci" &&
      Object.keys(config.services ?? {}).join() === "agent,web",
    "Only the two fixed isolated CI agents are permitted",
  );
  const specs = [
    {
      service: "agent",
      name: "linux-ci",
      platform: "linux/arm64",
      image: "${CI_IMAGE:?Provide verified Linux CI image digest}",
    },
    {
      service: "web",
      name: "linux-web-amd64",
      platform: "linux/amd64",
      image: "${WEB_CI_IMAGE:?Provide verified AMD64 Web CI image digest}",
    },
  ];
  for (const spec of specs) {
    const agent = config.services[spec.service];
    requirePolicy(
      onlyKeys(agent, [
        "image",
        "platform",
        "user",
        "environment",
        "volumes",
        "networks",
        "restart",
        "security_opt",
        "cap_drop",
        "mem_limit",
        "cpus",
        "pids_limit",
        "stop_grace_period",
        "logging",
      ]),
      "Unexpected CI host privilege or override",
    );
    requirePolicy(
      agent.user === "1000:1000" &&
        agent.platform === spec.platform &&
        agent.image === spec.image,
      "CI requires the fixed unprivileged platform and verified image",
    );
    const mounts = ciMounts(spec.service);
    requirePolicy(
      agent.volumes?.length === mounts.length &&
        mounts.every((mount, index) => {
          const actual = agent.volumes[index];
          return (
            actual.type === "volume" &&
            actual.source === mount.source &&
            actual.target === mount.target &&
            (mount.read_only
              ? actual.read_only === true
              : actual.read_only === undefined) &&
            onlyKeys(
              actual,
              mount.read_only
                ? ["type", "source", "target", "read_only"]
                : ["type", "source", "target"],
            )
          );
        }),
      "CI requires independent named HOME, agent and Jenkins state volumes plus a readonly credential volume",
    );
    requirePolicy(
      agent.environment?.HOME === "/home/jenkins" &&
        agent.environment?.JENKINS_AGENT_NAME === spec.name &&
        agent.environment?.JENKINS_AGENT_SECRET_FILE ===
          "/run/secrets/jenkins_agent_secret" &&
        agent.environment?.JENKINS_URL ===
          "${JENKINS_URL:?Provide verified controller URL reachable from this profile}" &&
        Object.keys(agent.environment).length === 4,
      "CI requires the fixed file-based WebSocket agent contract",
    );
    requirePolicy(
      agent.security_opt?.join() === "no-new-privileges:true" &&
        agent.cap_drop?.join() === "ALL" &&
        agent.networks?.join() === "ci",
      "CI isolation policy is missing",
    );
  }
  requirePolicy(
    Object.keys(config.volumes ?? {}).join() === Object.keys(CI_VOLUMES).join(),
    "Unexpected CI volumes",
  );
  for (const [key, name] of Object.entries(CI_VOLUMES)) {
    const credential = key.endsWith("credentials");
    requirePolicy(
      config.volumes[key].name === name &&
        onlyKeys(
          config.volumes[key],
          credential ? ["name", "external"] : ["name"],
        ) &&
        (!credential || config.volumes[key].external === true),
      "CI volume identity or external credential provisioning is invalid",
    );
  }
  requirePolicy(
    Object.keys(config.networks ?? {}).join() === "ci" &&
      config.networks.ci.name === "agent-platform-linux-ci",
    "CI network must remain independent",
  );
  return config;
}

export function validateDockerHost(kind, host) {
  requirePolicy(
    kind === "controller" || kind === "build",
    "Unknown Docker profile kind",
  );
  requirePolicy(
    host ===
      (kind === "controller"
        ? CONTROLLER_HOST
        : kind === "build"
          ? BUILD_HOST
          : null),
    "Use the fixed dedicated Docker profile; the default context and production daemon are refused",
  );
  return host;
}

export async function checkConfiguration() {
  const lab = JSON.parse(
    await fs.readFile(join(source, "compose.lab.json"), "utf8"),
  );
  const production = JSON.parse(
    await fs.readFile(join(source, "compose.controller.json"), "utf8"),
  );
  const ci = JSON.parse(
    await fs.readFile(join(source, "compose.ci.json"), "utf8"),
  );
  validateControllerCompose(lab, "lab");
  validateControllerCompose(production, "migration");
  validateCiCompose(ci);
  const lock = validatePluginLock(
    JSON.parse(
      await fs.readFile(join(source, "../jenkins/plugins.lock.json"), "utf8"),
    ),
  );
  const controllerMode = resolveControllerMode();
  return {
    status: "configuration-verified",
    jenkins: lock.jenkins,
    javaMajor: lock.javaMajor,
    plugins: lock.plugins.length,
    controllerDockerHost: CONTROLLER_HOST,
    buildDockerHost: BUILD_HOST,
    servicesStarted: false,
    defaultControllerMode: "migration",
    controllerMode,
    controllerUrl: resolveControllerUrl(undefined, controllerMode),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [, , command, file] = process.argv;
  if (command === "check" && !file)
    console.log(JSON.stringify(await checkConfiguration()));
  else
    throw new Error(
      "Usage: controller.mjs check; this tool does not start or stop services",
    );
}
