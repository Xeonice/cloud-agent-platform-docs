import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  checkConfiguration,
  validateControllerCompose,
  validateCiCompose,
  validateCiMounts,
  validateDockerHost,
  resolveControllerMode,
  resolveControllerUrl,
} from "./controller.mjs";
import { validatePluginLock, downloadPlugins } from "./plugins.mjs";
import { assertPrivateEquality, dockerProfiles } from "./verify-controller.mjs";
import { resolveHostLayout } from "./host-layout.mjs";
import {
  activationScript,
  reviewedPipeline,
  runManagement,
  idleReport,
  parseWaitIdleArguments,
  DEFAULT_IDLE_TIMEOUT_SECONDS,
} from "../jenkins/manage.mjs";

const source = dirname(fileURLToPath(import.meta.url));
// Injected host layout; tests never use the real account.
const LAYOUT = resolveHostLayout({
  identity: {
    username: "operator",
    uid: 5101,
    gid: 20,
    homedir: "/Users/operator",
  },
  execPath: "/opt/node-22/bin/node",
  overrides: {},
});
const SOCKETS = {
  jenkins: LAYOUT.profiles.jenkins.socket,
  build: LAYOUT.profiles.build.socket,
  runtime: LAYOUT.profiles.runtime.socket,
};
// The nine templates manage.mjs sync-pipelines sends.
const PIPELINES = [
  "api.groovy",
  "native-ci.groovy",
  "monitor.groovy",
  "discover.groovy",
  "release.groovy",
  "contract.groovy",
  "web.groovy",
  "mutation.groovy",
  "sandbox-images.groovy",
];
const config = async (name) =>
  JSON.parse(await fs.readFile(join(source, name), "utf8"));
const digest = (value) => createHash("sha256").update(value).digest("hex");
async function temporary(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), "jenkins-container-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
test("controller lab, migrated controller and CI configurations retain separate volumes and profiles", async () => {
  const result = await checkConfiguration();
  assert.equal(result.status, "configuration-verified");
  assert.equal(result.jenkins, "2.580.1");
  assert.equal(result.javaMajor, 21);
  assert.equal(result.servicesStarted, false);
  // Static check only: no host value appears (host-layout.mjs print shows them).
  assert.equal(result.controllerDockerHost, undefined);
  assert.equal(result.buildDockerHost, undefined);
  assert.doesNotMatch(JSON.stringify(result), /unix:|\/Users\/|docker\.sock/);
  const lab = await config("compose.lab.json");
  const production = await config("compose.controller.json");
  const ci = await config("compose.ci.json");
  assert.notEqual(lab.volumes.home.name, production.volumes.home.name);
  assert.notEqual(ci.volumes.workspace.name, production.volumes.home.name);
});

test("controller policy rejects socket/data mounts, host execution and public HTTP exposure", async () => {
  const lab = await config("compose.lab.json");
  for (const alter of [
    (value) =>
      value.services.controller.volumes.push({
        type: "bind",
        source: "/var/run/docker.sock",
        target: "/var/run/docker.sock",
      }),
    (value) =>
      value.services.controller.volumes.push({
        type: "bind",
        source: "/Users/operator/agent-platform/production",
        target: "/data",
      }),
    (value) => {
      value.services.controller.privileged = true;
    },
    (value) => {
      value.services.controller.network_mode = "host";
    },
    (value) => {
      value.services.controller.user = "0:0";
    },
    (value) => {
      value.services.controller.ports[0].host_ip = "0.0.0.0";
    },
    (value) => {
      value.services.controller.ports.push({
        target: 50000,
        published: "50000",
      });
    },
    (value) => {
      value.services.controller.environment.DOCKER_HOST = SOCKETS.build;
    },
    (value) => {
      value.services.controller.command = "bash";
    },
    (value) => {
      value.services.controller.use_api_socket = true;
    },
    (value) => {
      value.volumes.home.driver_opts = {
        type: "none",
        device: "/private",
        o: "bind",
      };
    },
  ]) {
    const changed = structuredClone(lab);
    alter(changed);
    assert.throws(() => validateControllerCompose(changed, "lab"));
  }
});

test("migration config refuses accidental fresh Home, native bootstrap, or shared lab volume", async () => {
  const production = await config("compose.controller.json");
  for (const alter of [
    (value) => {
      value.volumes.home.external = false;
    },
    (value) => {
      value.volumes.home.name = "agent-platform-jenkins-lab-home";
    },
    (value) => {
      value.services.controller.environment.AGENT_PLATFORM_CONTROLLER_MODE =
        "active";
    },
    (value) => {
      value.services.controller.build = { context: "../.." };
    },
  ]) {
    const changed = structuredClone(production);
    alter(changed);
    assert.throws(() => validateControllerCompose(changed, "migration"));
  }
});

test("migrated controller defaults to paused migration but supports validated active restarts", async () => {
  assert.equal(resolveControllerMode(undefined), "migration");
  assert.equal(resolveControllerMode(""), "migration");
  assert.equal(resolveControllerMode("migration"), "migration");
  assert.equal(resolveControllerMode("active"), "active");
  for (const mode of ["lab", "production", "active --privileged", null, false])
    assert.throws(() => resolveControllerMode(mode), /migration or active/);
  const production = await config("compose.controller.json");
  assert.equal(
    production.services.controller.environment.AGENT_PLATFORM_CONTROLLER_MODE,
    "${CONTROLLER_MODE:-migration}",
  );
  validateControllerCompose(production, "migration");
});

test("the fixed public Jenkins root URL does not expose controller ports or change its Home and isolated CI routes", async () => {
  const production = await config("compose.controller.json"),
    publicConfig = structuredClone(production);
  publicConfig.services.controller.environment.AGENT_PLATFORM_JENKINS_URL =
    "https://jenkins.douglasdong.com/";
  assert.doesNotThrow(() =>
    validateControllerCompose(publicConfig, "migration"),
  );
  assert.deepEqual(
    publicConfig.services.controller.ports,
    production.services.controller.ports,
  );
  assert.deepEqual(
    publicConfig.services.controller.volumes,
    production.services.controller.volumes,
  );
  assert.deepEqual(publicConfig.volumes, production.volumes);
  const lab = await config("compose.lab.json");
  lab.services.controller.environment.AGENT_PLATFORM_JENKINS_URL =
    "https://jenkins.douglasdong.com/";
  assert.throws(() => validateControllerCompose(lab, "lab"), /environment/);
  validateCiCompose(await config("compose.ci.json"));
});

test("controller URL selection keeps the lab private and admits only exact formal local or protected public origins", async () => {
  for (const mode of ["migration", "active"]) {
    assert.equal(resolveControllerUrl("", mode), "http://127.0.0.1:8080/");
    for (const url of [
      "http://127.0.0.1:8080/",
      "https://jenkins.douglasdong.com/",
    ])
      assert.equal(resolveControllerUrl(url, mode), url);
    for (const url of [
      "http://127.0.0.1:18080/",
      "http://jenkins.douglasdong.com/",
      "https://jenkins.douglasdong.com",
      "https://jenkins.douglasdong.com:443/",
      "https://jenkins.douglasdong.com/path/",
      "https://jenkins.douglasdong.com/?origin=local",
      "https://jenkins.douglasdong.com/#anchor",
      "https://other.douglasdong.com/",
      "https://jenkins.douglasdong.com.evil.invalid/",
      "https://user:do-not-log-credential@jenkins.douglasdong.com/",
      "https://jenkins.douglasdong.com/\n",
      null,
      false,
    ])
      assert.throws(() => resolveControllerUrl(url, mode), /exact approved/);
  }
  assert.equal(resolveControllerUrl("", "lab"), "http://127.0.0.1:18080/");
  assert.equal(
    resolveControllerUrl("http://127.0.0.1:18080/", "lab"),
    "http://127.0.0.1:18080/",
  );
  for (const url of [
    "http://127.0.0.1:8080/",
    "https://jenkins.douglasdong.com/",
  ])
    assert.throws(() => resolveControllerUrl(url, "lab"), /exact approved/);
  assert.throws(() => resolveControllerUrl("", "unknown"), /URL mode/);

  const production = await config("compose.controller.json");
  assert.equal(
    production.services.controller.environment.AGENT_PLATFORM_JENKINS_URL,
    "${AGENT_PLATFORM_JENKINS_URL:-http://127.0.0.1:8080/}",
  );
  for (const url of [
    "${UNREVIEWED_PUBLIC_URL}",
    "https://other.douglasdong.com/",
  ]) {
    const changed = structuredClone(production);
    changed.services.controller.environment.AGENT_PLATFORM_JENKINS_URL = url;
    assert.throws(
      () => validateControllerCompose(changed, "migration"),
      /environment/,
    );
  }
});

test("the actual controller check CLI validates explicit public selection before any service operation and rejects credential-bearing overrides without echoing them", () => {
  const run = (extra = {}) =>
    spawnSync(process.execPath, [join(source, "controller.mjs"), "check"], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", ...extra },
      encoding: "utf8",
      timeout: 20000,
    });
  const baseline = run();
  assert.equal(baseline.status, 0);
  assert.equal(
    JSON.parse(baseline.stdout).controllerUrl,
    "http://127.0.0.1:8080/",
  );
  const selected = run({
    CONTROLLER_MODE: "active",
    AGENT_PLATFORM_JENKINS_URL: "https://jenkins.douglasdong.com/",
  });
  assert.equal(selected.status, 0);
  const result = JSON.parse(selected.stdout);
  assert.equal(result.controllerMode, "active");
  assert.equal(result.controllerUrl, "https://jenkins.douglasdong.com/");
  assert.equal(result.servicesStarted, false);
  const operand = "https://user:do-not-log-credential@jenkins.douglasdong.com/";
  const refused = run({
    CONTROLLER_MODE: "active",
    AGENT_PLATFORM_JENKINS_URL: operand,
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /exact approved controller URL/);
  assert.ok(
    !refused.stdout.includes(operand) && !refused.stderr.includes(operand),
  );
});

test("controller image uses the actual verified Node and Jenkins base digests", async () => {
  const dockerfile = await fs.readFile(
    join(source, "controller.Dockerfile"),
    "utf8",
  );
  assert.match(
    dockerfile,
    /^FROM node:22\.23\.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS plugins$/m,
  );
  assert.match(
    dockerfile,
    /^FROM jenkins\/jenkins:2\.580\.1-jdk21@sha256:a660310e39ade10631f774bacd5219de767dfd08947ea5c32a739b5e5bb382c1$/m,
  );
});

test("Chinese UI adds only the verified Locale and localization dependency closure without changing the existing seventy plugins", async () => {
  const lock = validatePluginLock(await config("../jenkins/plugins.lock.json"));
  const additions = [
    {
      name: "locale",
      version: "641.v84f22d75fd8b_",
      sha256:
        "bc460e95fad4ae09783f151e4480049837ea02de190e4831a69fb6a40a2e0865",
    },
    {
      name: "localization-support",
      version: "1.41.v186a_c1569458",
      sha256:
        "f9ddb45cbc86a8245e5e3041bb5c96c3dfc35d8af001474bc6fd7db6b157b485",
    },
    {
      name: "localization-zh-cn",
      version: "371.v23851f835d6b_",
      sha256:
        "34e2fdd236189d7ed0d7f83fb57f4f0732d93927cf8d471d6e0e2707c9236fa1",
    },
  ];
  const names = new Set(additions.map((plugin) => plugin.name));
  assert.deepEqual(
    lock.plugins.filter((plugin) => names.has(plugin.name)),
    additions,
  );
  const existing = lock.plugins.filter((plugin) => !names.has(plugin.name));
  assert.equal(existing.length, 70);
  assert.equal(
    digest(JSON.stringify(existing)),
    "b8e4cb581e26dec1f4ecb11f83965e5ffe6bbc8b6848f2016771af3f36c5422a",
  );
  assert.equal(lock.plugins.length, 73);
});

test("Chinese startup policy saves and verifies the official Locale API before readiness and overrides browser and saved user preferences", async () => {
  const guard = await fs.readFile(
    join(source, "init.groovy.d/10-container-guard.groovy"),
    "utf8",
  );
  const pluginValidation = guard.indexOf("lock.plugins.each");
  const configuration = guard.indexOf("def locale = PluginImpl.get()");
  const readiness = guard.indexOf("Files.createFile(ready,");
  assert.ok(pluginValidation >= 0 && configuration > pluginValidation);
  assert.ok(readiness > configuration);
  const language = guard.slice(configuration, guard.indexOf("def state ="));
  assert.match(guard, /import hudson\.plugins\.locale\.PluginImpl/);
  assert.match(language, /locale\.setSystemLocale\('zh_CN'\)/);
  assert.match(language, /locale\.setIgnoreAcceptLanguage\(true\)/);
  assert.match(language, /locale\.setAllowUserPreferences\(false\)/);
  assert.match(language, /locale\.save\(\)/);
  assert.match(language, /locale\.getSystemLocale\(\) != 'zh_CN'/);
  assert.match(language, /!locale\.isIgnoreAcceptLanguage\(\)/);
  assert.match(language, /locale\.isAllowUserPreferences\(\)/);
  assert.match(
    language,
    /Locale\.getDefault\(\)\.toLanguageTag\(\) != 'zh-CN'/,
  );
  assert.match(language, /throw new IllegalStateException/);
  const ready = guard.slice(readiness);
  assert.match(ready, /locale: locale\.getSystemLocale\(\)/);
  assert.match(
    ready,
    /ignoreAcceptLanguage: locale\.isIgnoreAcceptLanguage\(\)/,
  );
  assert.match(
    ready,
    /allowUserPreferences: locale\.isAllowUserPreferences\(\)/,
  );
});

test("generic CI keeps only its three independent data volumes and file-based agent credential", async () => {
  const ci = await config("compose.ci.json");
  validateCiCompose(ci);
  for (const alter of [
    (value) =>
      value.services.agent.volumes.push({
        type: "bind",
        source: "/var/run/docker.sock",
        target: "/var/run/docker.sock",
      }),
    (value) => {
      value.services.agent.environment.GITHUB_TOKEN = "must-not-be-forwarded";
    },
    (value) => {
      value.services.agent.environment.JENKINS_AGENT_SECRET =
        "must-not-be-forwarded";
    },
    (value) => {
      value.services.agent.environment.JENKINS_AGENT_NAME = "mac-deploy";
    },
    (value) => {
      value.services.agent.privileged = true;
    },
    (value) => {
      value.services.agent.user = "0";
    },
  ]) {
    const changed = structuredClone(ci);
    alter(changed);
    assert.throws(() => validateCiCompose(changed));
  }
});

test("ARM64 and AMD64 CI cannot share credentials or use a writable secret mount", async () => {
  const ci = await config("compose.ci.json");
  for (const alter of [
    (value) => {
      value.services.web.volumes[3].source = "ci_credentials";
    },
    (value) => {
      value.services.agent.volumes[3].read_only = false;
    },
    (value) => {
      value.services.agent.volumes[3].type = "bind";
    },
    (value) => {
      value.volumes.web_credentials.external = false;
    },
    (value) => {
      value.services.web.platform = "linux/arm64";
    },
  ]) {
    const changed = structuredClone(ci);
    alter(changed);
    assert.throws(() => validateCiCompose(changed));
  }
});

test("named child mounts cover the inherited agent workDir and Jenkins state without replacing HOME caches", async () => {
  const ci = await config("compose.ci.json");
  validateCiCompose(ci);
  assert.equal(ci.volumes.workspace.name, "agent-platform-linux-ci-workspace");
  assert.equal(
    ci.volumes.web_workspace.name,
    "agent-platform-linux-web-workspace",
  );
  const allNames = [];
  for (const [service, prefix] of [
    ["agent", "ci"],
    ["web", "web"],
  ]) {
    const mounts = ci.services[service].volumes;
    assert.equal(mounts.length, 4);
    assert.deepEqual(
      mounts.map((mount) => mount.target),
      [
        "/home/jenkins",
        "/home/jenkins/agent",
        "/home/jenkins/.jenkins",
        "/run/secrets",
      ],
    );
    assert.equal(
      ci.volumes[mounts[1].source].name,
      `agent-platform-linux-${prefix}-agent-workspace`,
    );
    assert.equal(
      ci.volumes[mounts[2].source].name,
      `agent-platform-linux-${prefix}-jenkins-state`,
    );
    assert.equal(mounts[3].read_only, true);
    allNames.push(...mounts.map((mount) => ci.volumes[mount.source].name));
  }
  assert.equal(new Set(allNames).size, 8);
  for (const alter of [
    (value) => value.services.agent.volumes.splice(1, 1),
    (value) => {
      value.services.web.volumes[1].source = "ci_agent";
    },
    (value) => {
      value.services.agent.volumes[2].source = "web_state";
    },
    (value) => {
      value.services.agent.volumes[1].target = "/home/jenkins/agent/workspace";
    },
    (value) => {
      delete value.services.agent.volumes[2].source;
    },
    (value) => {
      value.volumes.ci_agent.driver_opts = {
        type: "none",
        device: "/private",
        o: "bind",
      };
    },
    (value) => {
      value.volumes.web_state.name = value.volumes.ci_state.name;
    },
  ]) {
    const changed = structuredClone(ci);
    alter(changed);
    assert.throws(() => validateCiCompose(changed));
  }
});

function runtimeMounts(prefix) {
  const names = [
    [`agent-platform-linux-${prefix}-workspace`, "/home/jenkins"],
    [`agent-platform-linux-${prefix}-agent-workspace`, "/home/jenkins/agent"],
    [`agent-platform-linux-${prefix}-jenkins-state`, "/home/jenkins/.jenkins"],
    [`agent-platform-linux-${prefix}-credentials`, "/run/secrets"],
  ];
  return names.map(([Name, Destination], index) => ({
    Type: "volume",
    Name,
    Destination,
    RW: index !== 3,
    Source: `/var/lib/docker/volumes/${Name}/_data`,
  }));
}

test("actual inspect topology accepts only fixed named mounts including both inherited child targets", () => {
  for (const [service, prefix] of [
    ["agent", "ci"],
    ["web", "web"],
  ]) {
    validateCiMounts(service, runtimeMounts(prefix));
    validateCiMounts(service, runtimeMounts(prefix).reverse());
  }
  const oldTopology = runtimeMounts("ci");
  for (const index of [1, 2]) {
    oldTopology[index].Name = "8".repeat(64);
    oldTopology[index].Source =
      `/var/lib/docker/volumes/${oldTopology[index].Name}/_data`;
  }
  assert.throws(() => validateCiMounts("agent", oldTopology), /anonymous/);
});

test("runtime mounts refuse anonymous extras, missing child targets, shared nodes, host mounts and writable credentials", () => {
  for (const alter of [
    (mounts) =>
      mounts.push({
        Type: "volume",
        Name: "a".repeat(64),
        Destination: "/extra",
        RW: true,
      }),
    (mounts) => mounts.splice(1, 1),
    (mounts) => {
      mounts[2] = { ...mounts[1] };
    },
    (mounts) => {
      mounts[1].Name = "agent-platform-linux-web-agent-workspace";
    },
    (mounts) => {
      mounts[0].Type = "bind";
      mounts[0].Source = "/Users/operator";
    },
    (mounts) => {
      mounts[2].Destination = "/var/run/docker.sock";
    },
    (mounts) => {
      mounts[3].RW = true;
    },
    (mounts) => {
      mounts[1].Source = "/private/host-data";
    },
  ]) {
    const mounts = runtimeMounts("ci");
    alter(mounts);
    assert.throws(() => validateCiMounts("agent", mounts));
  }
  assert.throws(() => validateCiMounts("mac-ci", runtimeMounts("ci")));
  assert.throws(() => validateCiMounts("agent", null));
});

test("failed private comparisons never include secret operands in the assertion message", () => {
  const before = "private-password-not-for-logs-before";
  const after = "private-password-not-for-logs-after";
  let failure;
  try {
    assertPrivateEquality(before, after, "Private state");
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.ok(
    !String(failure).includes(before) && !String(failure).includes(after),
  );
  assert.equal(failure.actual, false);
  assert.equal(failure.expected, true);
});

test("managed activation checks active mode before state mutation and only clears connected fixed nodes", () => {
  const script = activationScript();
  assert.ok(
    script.indexOf("System.getenv('AGENT_PLATFORM_CONTROLLER_MODE')") <
      script.indexOf("s.enabled=true"),
  );
  assert.ok(script.includes("computer.getChannel() != null"));
  assert.ok(script.includes("nodesWaitingForConnection:waiting"));
  for (const name of ["linux-deploy", "linux-ci", "linux-web-amd64"])
    assert.ok(script.includes(`name:'${name}'`));
  assert.doesNotMatch(script, /mac-ci|mac-deploy/);
});

test("pipeline templates are sent exactly as reviewed and no template carries a host placeholder", async () => {
  for (const text of [
    "@UNKNOWN_PRIVATE_TEMPLATE@",
    "def node='@NODE22@'",
    "x @JENKINS_TOOLS@ y",
  ])
    assert.throws(() => reviewedPipeline(text), /@KEY@ placeholders/);
  for (const text of ["/usr/local/bin/node", "user@example.com", "@ @a@ @@"])
    assert.equal(reviewedPipeline(text), text);
  // Every Groovy file manage.mjs sends: the nine pipelines and bootstrap.groovy.
  const jenkins = join(source, "../jenkins");
  const groovy = (await fs.readdir(jenkins)).filter((name) =>
    name.endsWith(".groovy"),
  );
  for (const name of [...PIPELINES, "bootstrap.groovy"])
    assert.ok(groovy.includes(name), name);
  for (const name of groovy) {
    const text = await fs.readFile(join(jenkins, name), "utf8");
    assert.doesNotMatch(text, /@[A-Z_0-9]+@/, name);
    assert.doesNotMatch(text, /\/Users\//, name);
  }
});

test("bootstrap manages only the three current Linux agents and the retired native Home copy action is rejected before credential lookup", async () => {
  const bootstrap = await fs.readFile(
    join(source, "../jenkins/bootstrap.groovy"),
    "utf8",
  );
  const agents = bootstrap.slice(
    bootstrap.indexOf("JenkinsLocationConfiguration.get().setUrl(location)"),
    bootstrap.indexOf("[name: 'agent-platform-api'"),
  );
  assert.deepEqual(
    [...agents.matchAll(/name: '([^']+)'/g)].map((match) => match[1]),
    ["linux-deploy", "linux-ci", "linux-web-amd64"],
  );
  assert.doesNotMatch(agents, /\/Users\/|deployAgentRoot/);
  await assert.rejects(
    runManagement(["copy-bootstrap-credentials"]),
    /Use status\|sync-pipelines/,
  );
});

// Fake Jenkins for the quietDown/queue/idle actions: no request leaves the process.
const FAKE_TOKEN = "fake-jenkins-api-token-not-for-logs";
const FAKE_BASIC = Buffer.from(`operator:${FAKE_TOKEN}`).toString("base64");
const idleJobs = () => [
  {
    name: "agent-platform-release",
    disabled: true,
    builds: [{ number: 47, building: false }],
  },
  { name: "agent-platform-ci-discovery", disabled: true, builds: [] },
  {
    name: "agent-platform-service-monitor",
    disabled: false,
    builds: [{ number: 9, building: false }],
  },
];
const idleComputers = () => ({
  computer: [
    { displayName: "Built-In Node", executors: [], oneOffExecutors: [] },
    {
      displayName: "linux-deploy",
      executors: [{ idle: true, currentExecutable: null }],
      oneOffExecutors: [],
    },
  ],
});
async function fakeJenkins(t, state = {}) {
  const tools = await temporary(t);
  await fs.writeFile(
    join(tools, "admin-api.json"),
    JSON.stringify({ username: "operator", token: FAKE_TOKEN }),
    { mode: 0o600 },
  );
  const jenkins = {
    quietingDown: false,
    jobs: idleJobs(),
    computers: idleComputers(),
    queue: { items: [] },
    postStatus: 302,
    applyPost: true,
    ...state,
  };
  const calls = [];
  // Requests already sent when each listener check ran.
  const checks = [];
  const scripts = [];
  const reply = (status, body) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).slice("http://jenkins.test/".length);
    const method = init.method ?? "GET";
    calls.push({
      path,
      method,
      redirect: init.redirect,
      authorization: init.headers?.authorization,
    });
    const route = path.split("?")[0];
    if (method === "POST" && route === "scriptText") {
      scripts.push(init.body.get("script"));
      return new Response("Reviewed managed pipeline templates synchronized\n");
    }
    if (method === "POST" && ["quietDown", "cancelQuietDown"].includes(route)) {
      if (jenkins.applyPost) jenkins.quietingDown = route === "quietDown";
      return jenkins.postStatus === 302
        ? new Response(null, {
            status: 302,
            headers: { location: "http://jenkins.test/" },
          })
        : reply(jenkins.postStatus, { error: "refused" });
    }
    if (method !== "GET") return reply(405, {});
    if (route === "api/json")
      return reply(200, {
        quietingDown: jenkins.quietingDown,
        jobs: jenkins.jobs,
      });
    if (route === "queue/api/json")
      return reply(jenkins.queueStatus ?? 200, jenkins.queue);
    if (route === "computer/api/json") return reply(200, jenkins.computers);
    return reply(404, {});
  };
  const options = {
    tools,
    base: "http://jenkins.test/",
    fetchImpl,
    assertListener: async () => {
      checks.push(calls.length);
      if (jenkins.foreignListener)
        throw new Error(
          "127.0.0.1:8080 is held by UID 5102, not the operator; the Jenkins credential is not sent",
        );
    },
    now: () => jenkins.clock ?? 0,
    sleep: async (ms) => {
      jenkins.clock = (jenkins.clock ?? 0) + ms;
      jenkins.onSleep?.(jenkins);
    },
  };
  return { jenkins, calls, checks, scripts, options };
}
const posts = (calls) => calls.filter((call) => call.method === "POST");
function assertNoCredential(error) {
  for (const value of [FAKE_TOKEN, FAKE_BASIC])
    assert.ok(!String(error?.message ?? error).includes(value));
  return true;
}

test("quiet-down only posts quietDown to an idle controller with release and discovery disabled, and a confirmed 302 counts as success", async (t) => {
  const { calls, options } = await fakeJenkins(t);
  const log = t.mock.method(console, "log", () => {});
  await runManagement(["quiet-down"], options);
  assert.deepEqual(JSON.parse(log.mock.calls[0].arguments[0]), {
    state: "quieting-down",
    quietingDown: true,
    disabledJobs: ["agent-platform-ci-discovery", "agent-platform-release"],
  });
  assert.deepEqual(
    posts(calls).map(({ path, redirect }) => ({ path, redirect })),
    [{ path: "quietDown", redirect: "manual" }],
  );
  // The state is read back after the redirect instead of trusting it.
  assert.equal(calls.at(-1).method, "GET");
  for (const call of calls) {
    assert.equal(call.authorization, `Basic ${FAKE_BASIC}`);
    if (call.method === "GET") assert.equal(call.redirect, "error");
  }
});

test("quiet-down sends nothing while release or discovery is enabled or any build, executor or queue item is busy", async (t) => {
  const busy = {
    enabled: {
      jobs: idleJobs().map((job) =>
        job.name === "agent-platform-release"
          ? { ...job, disabled: false }
          : job,
      ),
    },
    running: {
      jobs: [
        ...idleJobs(),
        {
          name: "agent-platform-web",
          disabled: false,
          builds: [{ number: 12, building: true }],
        },
      ],
    },
    oneOff: {
      computers: {
        computer: [
          {
            displayName: "linux-deploy",
            executors: [{ idle: true, currentExecutable: null }],
            oneOffExecutors: [
              {
                idle: false,
                currentExecutable: {
                  fullDisplayName: "agent-platform-release #48",
                },
              },
            ],
          },
        ],
      },
    },
    queued: {
      queue: {
        items: [
          {
            id: 7,
            why: "In the quiet period",
            task: { name: "agent-platform-api" },
          },
        ],
      },
    },
  };
  const expected = {
    enabled: /quietDown was not sent: agent-platform-release is not disabled/,
    running: /running builds: agent-platform-web #12/,
    oneOff: /busy executors: linux-deploy: agent-platform-release #48/,
    queued: /queued: agent-platform-api/,
  };
  for (const [name, state] of Object.entries(busy)) {
    const { calls, options } = await fakeJenkins(t, state);
    await assert.rejects(runManagement(["quiet-down"], options), (error) => {
      assert.match(error.message, expected[name]);
      assert.match(error.message, /run wait-idle, then retry/);
      return assertNoCredential(error);
    });
    assert.deepEqual(posts(calls), [], name);
  }
});

test("quiet-down is a no-op when Jenkins is already quieting down and fails when a 302 is not confirmed", async (t) => {
  const already = await fakeJenkins(t, { quietingDown: true });
  const log = t.mock.method(console, "log", () => {});
  await runManagement(["quiet-down"], already.options);
  assert.equal(
    JSON.parse(log.mock.calls[0].arguments[0]).alreadyQuietingDown,
    true,
  );
  assert.deepEqual(posts(already.calls), []);

  const ignored = await fakeJenkins(t, { applyPost: false });
  await assert.rejects(
    runManagement(["quiet-down"], ignored.options),
    /does not report quietingDown after quietDown/,
  );
  const refused = await fakeJenkins(t, { postStatus: 403 });
  await assert.rejects(
    runManagement(["quiet-down"], refused.options),
    (error) => {
      assert.equal(error.message, "Jenkins HTTP 403");
      return assertNoCredential(error);
    },
  );
});

test("cancel-quiet-down treats a confirmed 302 as success and reports the jobs that are still disabled", async (t) => {
  const { calls, options } = await fakeJenkins(t, { quietingDown: true });
  const log = t.mock.method(console, "log", () => {});
  await runManagement(["cancel-quiet-down"], options);
  assert.deepEqual(JSON.parse(log.mock.calls[0].arguments[0]), {
    state: "quiet-down-cancelled",
    quietingDown: false,
    disabledJobs: ["agent-platform-ci-discovery", "agent-platform-release"],
  });
  assert.deepEqual(
    posts(calls).map(({ path, redirect }) => ({ path, redirect })),
    [{ path: "cancelQuietDown", redirect: "manual" }],
  );
  const ignored = await fakeJenkins(t, {
    quietingDown: true,
    applyPost: false,
  });
  await assert.rejects(
    runManagement(["cancel-quiet-down"], ignored.options),
    /still reports quietingDown/,
  );
});

test("queue is read-only and a redirect is only accepted from the two quietDown endpoints", async (t) => {
  const { calls, options } = await fakeJenkins(t, {
    queue: {
      items: [
        {
          id: 31,
          why: "Waiting for next available executor on linux-deploy",
          blocked: false,
          buildable: true,
          stuck: false,
          inQueueSince: Date.UTC(2026, 9, 8, 1, 2, 3),
          task: { name: "agent-platform-service-monitor" },
        },
      ],
    },
  });
  const log = t.mock.method(console, "log", () => {});
  await runManagement(["queue"], options);
  assert.deepEqual(JSON.parse(log.mock.calls[0].arguments[0]), {
    count: 1,
    items: [
      {
        id: 31,
        job: "agent-platform-service-monitor",
        why: "Waiting for next available executor on linux-deploy",
        blocked: false,
        buildable: true,
        stuck: false,
        inQueueSince: "2026-10-08T01:02:03.000Z",
      },
    ],
  });
  assert.ok(
    calls.every((call) => call.method === "GET" && call.redirect === "error"),
  );
  const redirected = await fakeJenkins(t, { queueStatus: 302 });
  await assert.rejects(
    runManagement(["queue"], redirected.options),
    /^Error: Jenkins HTTP 302$/,
  );
});

test("wait-idle polls until no build, executor or queue item is busy and reports progress on stderr", async (t) => {
  const { jenkins, calls, options } = await fakeJenkins(t, {
    jobs: [
      ...idleJobs(),
      {
        name: "agent-platform-web",
        disabled: false,
        builds: [{ number: 12, building: true }],
      },
    ],
    onSleep: (state) => {
      if (state.clock === 10_000) {
        state.jobs = idleJobs();
        state.queue = {
          items: [{ id: 8, task: { name: "agent-platform-service-monitor" } }],
        };
      } else state.queue = { items: [] };
    },
  });
  const log = t.mock.method(console, "log", () => {});
  const progress = t.mock.method(console, "error", () => {});
  await runManagement(["wait-idle", "--timeout", "60"], options);
  assert.deepEqual(JSON.parse(log.mock.calls[0].arguments[0]), {
    state: "idle",
    waitedSeconds: 20,
    quietingDown: false,
    disabledJobs: ["agent-platform-ci-discovery", "agent-platform-release"],
  });
  assert.deepEqual(
    progress.mock.calls.map((call) => JSON.parse(call.arguments[0])),
    [
      {
        state: "waiting",
        elapsedSeconds: 0,
        quietingDown: false,
        runningBuilds: ["agent-platform-web #12"],
        busyExecutors: [],
        queued: [],
      },
      {
        state: "waiting",
        elapsedSeconds: 10,
        quietingDown: false,
        runningBuilds: [],
        busyExecutors: [],
        queued: ["agent-platform-service-monitor"],
      },
    ],
  );
  assert.equal(jenkins.clock, 20_000);
  assert.deepEqual(posts(calls), []);
});

test("wait-idle stops at its timeout and names only what is still busy", async (t) => {
  const { jenkins, calls, options } = await fakeJenkins(t, {
    jobs: idleJobs().map((job) =>
      job.name === "agent-platform-release"
        ? { ...job, builds: [{ number: 48, building: true }, ...job.builds] }
        : job,
    ),
  });
  t.mock.method(console, "error", () => {});
  await assert.rejects(
    runManagement(["wait-idle", "--timeout=25"], options),
    (error) => {
      assert.equal(
        error.message,
        "Jenkins did not become idle within 25 seconds (running builds: agent-platform-release #48)",
      );
      return assertNoCredential(error);
    },
  );
  // Polls at 0, 10, 20 and exactly at the 25 second deadline.
  assert.equal(jenkins.clock, 25_000);
  assert.equal(
    calls.filter((call) => call.path.startsWith("queue/")).length,
    4,
  );
  assert.deepEqual(posts(calls), []);
});

test("new Jenkins actions reject bad arguments and unsafe credentials before any request", async (t) => {
  const missing = join(await temporary(t), "missing");
  for (const args of [
    ["wait-idle", "--timeout", "0"],
    ["wait-idle", "--timeout", "14401"],
    ["wait-idle", "--timeout=soon"],
    ["wait-idle", "60"],
    ["queue", "agent-platform-api"],
    ["quiet-down", "agent-platform-release"],
    ["cancel-quiet-down", "now"],
  ])
    await assert.rejects(
      runManagement(args, { tools: missing }),
      /^Error: Use /,
    );
  assert.deepEqual(parseWaitIdleArguments([]), {
    timeoutSeconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
  });
  assert.deepEqual(parseWaitIdleArguments(["--timeout", "14400"]), {
    timeoutSeconds: 14400,
  });
  const { calls, options } = await fakeJenkins(t);
  await fs.chmod(join(options.tools, "admin-api.json"), 0o644);
  await assert.rejects(
    runManagement(["queue"], options),
    /Unsafe private API credential/,
  );
  assert.deepEqual(calls, []);
});

test("idle detection treats unnamed node-block executors as busy, ignores offline idle nodes and fails closed on odd responses", () => {
  const report = idleReport({
    controller: { quietingDown: true, jobs: idleJobs() },
    queue: {
      items: [{ id: 3, task: { name: "agent-platform-service-monitor" } }],
    },
    computers: {
      computer: [
        {
          displayName: "linux-ci",
          executors: [
            {
              idle: false,
              currentExecutable: {
                _class:
                  "org.jenkinsci.plugins.workflow.support.steps.ExecutorStepExecution$PlaceholderTask$PlaceholderExecutable",
              },
            },
          ],
        },
        {
          displayName: "mac-ci",
          executors: [{ idle: true, currentExecutable: null }],
        },
      ],
    },
  });
  assert.equal(report.idle, false);
  assert.deepEqual(report.busyExecutors, ["linux-ci: busy"]);
  assert.deepEqual(report.queued, ["agent-platform-service-monitor"]);
  assert.equal(report.quietingDown, true);
  for (const broken of [
    { controller: {}, queue: { items: [] }, computers: idleComputers() },
    { controller: { jobs: [] }, queue: {}, computers: idleComputers() },
    { controller: { jobs: [] }, queue: { items: [] }, computers: {} },
  ])
    assert.throws(() => idleReport(broken), /Unexpected Jenkins/);
});

test("default Docker context and cross-profile daemon use are refused", () => {
  const { profiles } = LAYOUT;
  assert.equal(
    validateDockerHost("controller", SOCKETS.jenkins, profiles),
    SOCKETS.jenkins,
  );
  assert.equal(
    validateDockerHost("build", SOCKETS.build, profiles),
    SOCKETS.build,
  );
  for (const host of [
    undefined,
    "",
    "unix:///var/run/docker.sock",
    SOCKETS.build,
    SOCKETS.runtime,
  ])
    assert.throws(
      () => validateDockerHost("controller", host, profiles),
      /fixed dedicated Docker profile/,
    );
  for (const host of [SOCKETS.jenkins, SOCKETS.runtime])
    assert.throws(() => validateDockerHost("build", host, profiles));
  assert.throws(() => validateDockerHost("runtime", SOCKETS.runtime, profiles));
  assert.throws(() => validateDockerHost("unknown", null, profiles));
  // Without the host layout nothing is accepted, not even an empty host.
  for (const [kind, host, layoutProfiles] of [
    ["controller", SOCKETS.jenkins, undefined],
    ["build", undefined, undefined],
    ["build", undefined, {}],
    ["controller", "", { jenkins: { socket: "" } }],
  ])
    assert.throws(
      () => validateDockerHost(kind, host, layoutProfiles),
      /fixed dedicated Docker profile/,
    );
  // A layout whose build profile points at the runtime daemon is refused.
  const crossed = {
    ...profiles,
    build: { ...profiles.build, socket: SOCKETS.runtime },
  };
  assert.throws(() => validateDockerHost("build", SOCKETS.runtime, crossed));
});

test("lab verification reaches the jenkins and build profiles of the host layout only", () => {
  const docker = dockerProfiles(LAYOUT);
  assert.deepEqual(Object.keys(docker), ["controller", "build"]);
  assert.ok(Object.isFrozen(docker));
  const crossed = {
    ...LAYOUT,
    profiles: {
      ...LAYOUT.profiles,
      jenkins: { ...LAYOUT.profiles.jenkins, socket: SOCKETS.runtime },
    },
  };
  assert.throws(() => dockerProfiles(crossed), /fixed dedicated/);
});

test("manage confirms the loopback listener before every credentialed request and sends nothing to a foreign one", async (t) => {
  t.mock.method(console, "log", () => {});
  const status = await fakeJenkins(t);
  await runManagement(["status"], status.options);
  // Two sequential requests, each preceded by its own check.
  assert.deepEqual(status.checks, [0, 1]);
  assert.equal(status.calls.length, 2);

  // Three concurrent reads share one check per poll.
  const idle = await fakeJenkins(t);
  await runManagement(["wait-idle"], idle.options);
  assert.deepEqual(idle.checks, [0]);
  assert.equal(idle.calls.length, 3);

  const quiet = await fakeJenkins(t);
  await runManagement(["quiet-down"], quiet.options);
  assert.deepEqual(quiet.checks, [0, 3, 4]);
  assert.deepEqual(
    quiet.calls.map((call) => call.method),
    ["GET", "GET", "GET", "POST", "GET"],
  );

  for (const args of [
    ["status"],
    ["queue"],
    ["wait-idle"],
    ["disable", "agent-platform-release"],
    ["sync-pipelines"],
  ]) {
    const foreign = await fakeJenkins(t, { foreignListener: true });
    await assert.rejects(runManagement(args, foreign.options), (error) => {
      assert.match(error.message, /not the operator/);
      return assertNoCredential(error);
    });
    assert.deepEqual(foreign.calls, [], args[0]);
    assert.deepEqual(foreign.checks, [0], args[0]);
  }
});

test("manage takes every host value from its caller and refuses to run without them", async (t) => {
  const { calls, checks, options } = await fakeJenkins(t);
  for (const missing of ["tools", "base", "assertListener"]) {
    const partial = { ...options };
    delete partial[missing];
    await assert.rejects(
      runManagement(["queue"], partial),
      /requires the private tools directory, the Jenkins URL and a listener check/,
    );
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(checks, []);
  const text = await fs.readFile(join(source, "../jenkins/manage.mjs"), "utf8");
  // The host layout is imported only by the Mac CLI branch, never at the top.
  assert.doesNotMatch(text, /^import[^;]*host-layout/m);
  assert.match(text, /await import\("\.\.\/containers\/host-layout\.mjs"\)/);
  assert.doesNotMatch(text, /\/Users\/|\b501\b|fnm\/node-versions/);
});

test("sync-pipelines sends each reviewed template byte for byte after the listener check", async (t) => {
  const { calls, checks, scripts, options } = await fakeJenkins(t);
  const log = t.mock.method(console, "log", () => {});
  await runManagement(["sync-pipelines"], options);
  assert.equal(
    log.mock.calls[0].arguments[0],
    "Reviewed managed pipeline templates synchronized",
  );
  assert.deepEqual(checks, [0]);
  assert.deepEqual(
    calls.map(({ path, method }) => ({ path, method })),
    [{ path: "scriptText", method: "POST" }],
  );
  const encoded = /new String\('([A-Za-z0-9+/=]+)'\.decodeBase64\(\)/.exec(
    scripts[0],
  )[1];
  const files = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  assert.deepEqual(Object.keys(files), PIPELINES);
  for (const name of PIPELINES)
    assert.deepEqual(
      Buffer.from(files[name], "base64"),
      await fs.readFile(join(source, "../jenkins", name)),
      name,
    );
});

test("the API credential is read without following links and only as the account's single-link private file", async (t) => {
  for (const alter of [
    async (path) => {
      const target = `${path}.target`;
      await fs.rename(path, target);
      await fs.symlink(target, path);
    },
    async (path) => fs.link(path, `${path}.second-link`),
    async (path) => fs.chmod(path, 0o640),
    async (path) => {
      await fs.rm(path);
      await fs.mkdir(path);
    },
  ]) {
    const { calls, checks, options } = await fakeJenkins(t);
    await alter(join(options.tools, "admin-api.json"));
    await assert.rejects(
      runManagement(["queue"], options),
      /^Error: Unsafe private API credential$/,
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(checks, []);
  }
});

test("plugin install writes exactly verified bytes without dependency/version resolution", async (t) => {
  const dir = await temporary(t);
  const bytes = Buffer.from("exact reviewed artifact");
  const lock = {
    jenkins: "2.580.1",
    javaMajor: 21,
    plugins: [
      { name: "workflow-api", version: "123.vabc", sha256: digest(bytes) },
    ],
  };
  let requested;
  await downloadPlugins(lock, join(dir, "plugins"), {
    fetchImpl: async (url) => {
      requested = url;
      return new Response(bytes);
    },
  });
  assert.equal(
    requested,
    "https://updates.jenkins.io/download/plugins/workflow-api/123.vabc/workflow-api.hpi",
  );
  assert.deepEqual(
    await fs.readFile(join(dir, "plugins/workflow-api.jpi")),
    bytes,
  );
  assert.deepEqual(await fs.readdir(join(dir, "plugins")), [
    "workflow-api.jpi",
  ]);
});

test("plugin SHA/download failures discard all partial plugins and preserve no installable output", async (t) => {
  const dir = await temporary(t);
  for (const [name, response] of [
    ["wrong-sha", new Response("unexpected")],
    ["http-error", new Response("missing", { status: 404 })],
  ]) {
    const destination = join(dir, name);
    const lock = {
      jenkins: "2.580.1",
      javaMajor: 21,
      plugins: [
        { name: "workflow-api", version: "123.vabc", sha256: "a".repeat(64) },
      ],
    };
    await assert.rejects(
      downloadPlugins(lock, destination, { fetchImpl: async () => response }),
    );
    assert.deepEqual(await fs.readdir(destination), []);
  }
});

test("plugin installer refuses lock drift, duplicate plugins, URL injection and existing output", async (t) => {
  const dir = await temporary(t);
  const valid = {
    jenkins: "2.580.1",
    javaMajor: 21,
    plugins: [
      { name: "workflow-api", version: "123.vabc", sha256: "a".repeat(64) },
    ],
  };
  for (const alter of [
    (value) => {
      value.jenkins = "latest";
    },
    (value) => {
      value.javaMajor = 17;
    },
    (value) => value.plugins.push({ ...value.plugins[0] }),
    (value) => {
      value.plugins[0].name = "../credentials";
    },
    (value) => {
      value.plugins[0].version = "1?url=http://host";
    },
    (value) => {
      value.plugins[0].sha256 = "unverified";
    },
  ]) {
    const changed = structuredClone(valid);
    alter(changed);
    assert.throws(() => validatePluginLock(changed));
  }
  await fs.writeFile(join(dir, "existing.jpi"), "untouched");
  await assert.rejects(downloadPlugins(valid, dir), /must be empty/);
  assert.equal(
    await fs.readFile(join(dir, "existing.jpi"), "utf8"),
    "untouched",
  );
});

test("container entrypoint clears stale readiness before attempting Jenkins startup", async (t) => {
  const home = await temporary(t);
  await fs.mkdir(join(home, "container-state"));
  await fs.writeFile(join(home, "container-state/ready.json"), "stale");
  const result = spawnSync(
    "/bin/bash",
    [join(source, "controller-entrypoint.sh")],
    {
      cwd: "/",
      env: {
        PATH: "/usr/bin:/bin",
        JENKINS_HOME: home,
        AGENT_PLATFORM_CONTROLLER_MODE: "lab",
      },
      encoding: "utf8",
    },
  );
  // The Linux image launcher is intentionally absent on this host; no server is started.
  assert.notEqual(result.status, 0);
  await assert.rejects(fs.lstat(join(home, "container-state/ready.json")), {
    code: "ENOENT",
  });
});

test("container entrypoint refuses a linked readiness directory without changing its target", async (t) => {
  const home = await temporary(t);
  const outside = join(home, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(join(outside, "ready.json"), "must remain");
  await fs.symlink(outside, join(home, "container-state"));
  const result = spawnSync(
    "/bin/bash",
    [join(source, "controller-entrypoint.sh")],
    {
      cwd: "/",
      env: {
        PATH: "/usr/bin:/bin",
        JENKINS_HOME: home,
        AGENT_PLATFORM_CONTROLLER_MODE: "migration",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must not be a symlink/);
  assert.equal(
    await fs.readFile(join(outside, "ready.json"), "utf8"),
    "must remain",
  );
});
