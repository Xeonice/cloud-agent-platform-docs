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
  validateMigrationManifest,
  resolveControllerMode,
  resolveControllerUrl,
  CONTROLLER_HOST,
  BUILD_HOST,
} from "./controller.mjs";
import { validatePluginLock, downloadPlugins } from "./plugins.mjs";
import { assertPrivateEquality, renderPipeline } from "./verify-controller.mjs";
import { activationScript } from "../jenkins/manage.mjs";

const source = dirname(fileURLToPath(import.meta.url));
const config = async (name) =>
  JSON.parse(await fs.readFile(join(source, name), "utf8"));
const digest = (value) => createHash("sha256").update(value).digest("hex");
async function temporary(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), "jenkins-container-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function manifest() {
  return {
    version: 1,
    archive: {
      basename: "jenkins-home.tar",
      sha256: "a".repeat(64),
      sizeBytes: 8192,
    },
    entries: [
      { path: ".", type: "directory", mode: 0o700 },
      { path: "./config.xml", type: "file", mode: 0o600, sizeBytes: 20 },
      {
        path: "./secrets/master.key",
        type: "file",
        mode: 0o600,
        sizeBytes: 256,
      },
      {
        path: "./secrets/hudson.util.Secret",
        type: "file",
        mode: 0o600,
        sizeBytes: 256,
      },
      {
        path: "./users/admin/config.xml",
        type: "file",
        mode: 0o600,
        sizeBytes: 42,
      },
      {
        path: "./jobs/api/builds/1/build.xml",
        type: "file",
        mode: 0o600,
        sizeBytes: 512,
      },
      {
        path: "./jobs/api/builds/lastSuccessfulBuild",
        type: "symlink",
        mode: 0o777,
        linkTarget: "1",
      },
      {
        path: "./init.groovy.d/10-agent-platform.groovy",
        type: "file",
        mode: 0o600,
        sizeBytes: 100,
      },
      {
        path: "./plugins/workflow-api.jpi",
        type: "file",
        mode: 0o600,
        sizeBytes: 256,
      },
      { path: "./queue.xml", type: "file", mode: 0o600, sizeBytes: 64 },
    ],
  };
}

test("controller lab, migrated controller and CI configurations retain separate volumes and profiles", async () => {
  const result = await checkConfiguration();
  assert.equal(result.status, "configuration-verified");
  assert.equal(result.jenkins, "2.580.1");
  assert.equal(result.javaMajor, 21);
  assert.equal(result.servicesStarted, false);
  assert.notEqual(CONTROLLER_HOST, BUILD_HOST);
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
        source: "/Users/douglasdong/agent-platform/production",
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
      value.services.controller.environment.DOCKER_HOST = BUILD_HOST;
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
      mounts[0].Source = "/Users/douglasdong";
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
  for (const name of ["mac-ci", "mac-deploy", "linux-ci", "linux-web-amd64"])
    assert.ok(script.includes(`name:'${name}'`));
  assert.throws(
    () => renderPipeline("@UNKNOWN_PRIVATE_TEMPLATE@"),
    /Unknown fixed/,
  );
  assert.equal(renderPipeline("/usr/local/bin/node"), "/usr/local/bin/node");
});

test("default Docker context and cross-profile daemon use are refused", () => {
  assert.equal(
    validateDockerHost("controller", CONTROLLER_HOST),
    CONTROLLER_HOST,
  );
  assert.equal(validateDockerHost("build", BUILD_HOST), BUILD_HOST);
  for (const host of [undefined, "", "unix:///var/run/docker.sock", BUILD_HOST])
    assert.throws(() => validateDockerHost("controller", host));
  assert.throws(() => validateDockerHost("build", CONTROLLER_HOST));
  assert.throws(() => validateDockerHost("unknown", null));
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

test("migration plan preserves encryption and build history while excluding executable native bootstrap and queued builds", () => {
  const result = validateMigrationManifest(manifest());
  assert.equal(result.status, "prepared-not-imported");
  assert.equal(result.retainedEntries, 6);
  assert.equal(result.jobsRequireDisabledBeforeStartup, true);
  assert.equal(result.activationRequiresExplicitReview, true);
  assert.ok(result.excluded.includes("init.groovy.d"));
  assert.ok(result.excluded.includes("plugins"));
  assert.ok(result.excluded.includes("queue.xml"));
  assert.ok(!result.excluded.includes("jobs"));
  assert.ok(!result.excluded.includes("secrets"));
});

test("Home plan rejects traversal, external links, duplicate archive paths, hardlinks and missing keys", () => {
  for (const entry of [
    { path: "../outside", type: "file", sizeBytes: 1 },
    { path: "/absolute", type: "file", sizeBytes: 1 },
    { path: "foo/../secret.key", type: "file", sizeBytes: 1 },
    { path: "link", type: "symlink", linkTarget: "/Users/Shared" },
    { path: "link", type: "symlink", linkTarget: "../outside" },
    { path: "config.xml", type: "file", sizeBytes: 1 },
    { path: "link", type: "hardlink", linkTarget: "config.xml" },
    { path: "fifo", type: "fifo" },
  ]) {
    const changed = manifest();
    changed.entries.push(entry);
    assert.throws(() => validateMigrationManifest(changed));
  }
  const missing = manifest();
  missing.entries = missing.entries.filter(
    (entry) => !entry.path.includes("master.key"),
  );
  assert.throws(() => validateMigrationManifest(missing), /encryption keys/);
});

test("Home export can omit an unused lazily generated hudson.util.Secret without inventing a key", () => {
  const original = manifest();
  original.entries = original.entries.filter(
    (entry) => !entry.path.includes("hudson.util.Secret"),
  );
  const before = structuredClone(original);
  const result = validateMigrationManifest(original);
  assert.deepEqual(result.encryptionKeys, {
    masterKeyPresent: true,
    hudsonUtilSecretPresent: false,
  });
  assert.deepEqual(original, before);
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
