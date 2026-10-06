import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CONTROLLER_NAME,
  CONTROLLER_IMAGE,
  comparePrivateHashes,
  compareUserAuthentication,
  validateReceipt,
  verifyInspection,
  verifyMigration,
  verifyPausedState,
  verifyPlugins,
} from "./verify-home-migration.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const jobs = [
  "agent-platform-api",
  "agent-platform-ci-discovery",
  "agent-platform-contract",
  "agent-platform-mutation",
  "agent-platform-native-ci",
  "agent-platform-release",
  "agent-platform-sandbox-images",
  "agent-platform-service-monitor",
  "agent-platform-web",
];
const userXml =
  "<user><passwordHash>private-fixture-password-hash</passwordHash><tokenStore><tokenList><token><value>private-fixture-token-hash</value></token></tokenList></tokenStore></user>";
function inspection() {
  return {
    Name: `/${CONTROLLER_NAME}`,
    Id: "a".repeat(64),
    Image: CONTROLLER_IMAGE,
    State: { Status: "running", Health: { Status: "healthy" } },
    Config: {
      User: "1000:1000",
      Env: ["AGENT_PLATFORM_CONTROLLER_MODE=migration"],
    },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ["ALL"],
      Binds: ["agent-platform-jenkins-home:/var/jenkins_home:rw"],
      NetworkMode: "agent-platform-jenkins-controller",
      PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] },
    },
    Mounts: [
      {
        Type: "volume",
        Name: "agent-platform-jenkins-home",
        Destination: "/var/jenkins_home",
        RW: true,
      },
    ],
  };
}
function fixture() {
  const files = new Map();
  for (let index = 0; index < 10; index++)
    files.set(
      `secrets/key-${index}`,
      Buffer.from(`private-fixture-key-${index}`),
    );
  for (const path of [
    "bootstrap-secrets/admin-api.json",
    "bootstrap-secrets/admin-login.json",
    "identity.key.enc",
    "secret.key",
  ])
    files.set(path, Buffer.from(`private-fixture-value-${path}`));
  files.set("users/admin/config.xml", Buffer.from(userXml));
  for (let index = 1; index <= 6; index++)
    files.set(
      `jobs/agent-platform-api/builds/${index}/build.xml`,
      Buffer.from(
        `<flow-build><completed>true</completed><result>${index === 1 ? "FAILURE" : "SUCCESS"}</result></flow-build>`,
      ),
    );
  const verified = {
    manifest: { archive: { sha256: "d".repeat(64), sizeBytes: 12345 } },
    entries: [...files].map(([path, bytes]) => ({
      path,
      type: "file",
      sizeBytes: bytes.length,
    })),
  };
  const receipt = {
    state: "imported-not-started",
    targetHomeVolume: "agent-platform-jenkins-home",
    archiveSha256: verified.manifest.archive.sha256,
    controllerMode: "migration",
    activated: false,
    apiTouched: false,
  };
  const lock = {
    jenkins: "2.580.1",
    javaMajor: 21,
    plugins: Array.from({ length: 70 }, (_, index) => ({
      name: `plugin-${index}`,
      version: "1.0",
      sha256: digest(`fixture-jpi-${index}`),
    })),
  };
  const controller = {
    numExecutors: 0,
    jobs: jobs.map((name) => ({ name, buildable: false })),
  };
  const computers = {
    computer: [
      {
        _class: "hudson.model.Hudson$MasterComputer",
        displayName: "Built-In Node",
        numExecutors: 0,
      },
      ...["mac-ci", "mac-deploy"].map((displayName) => ({
        displayName,
        offline: true,
        temporarilyOffline: true,
        numExecutors: 1,
      })),
    ],
  };
  const queue = { items: [] };
  const jobStates = jobs.map((name) => ({
    name,
    buildable: false,
    builds:
      name === "agent-platform-api"
        ? Array.from({ length: 6 }, (_, index) => ({
            number: index + 1,
            result: index === 0 ? "FAILURE" : "SUCCESS",
            building: false,
          }))
        : [],
  }));
  const plugins = {
    plugins: lock.plugins.map((plugin) => ({
      shortName: plugin.name,
      version: plugin.version,
      active: true,
      enabled: true,
    })),
  };
  const calls = [];
  const operations = {
    inspect: async () => inspection(),
    homeOwner: async () => "1000:1000:700",
    ready: async () => ({
      mode: "migration",
      jenkins: "2.580.1",
      javaMajor: 21,
      plugins: 70,
      executors: 0,
    }),
    archiveFile: async (entry) => {
      calls.push(`archive:${entry.path}`);
      return files.get(entry.path);
    },
    homeHashes: async (paths) =>
      new Map(
        paths.map((path) => [
          path,
          path.startsWith("plugins/")
            ? lock.plugins.find(
                (plugin) => path === `plugins/${plugin.name}.jpi`,
              ).sha256
            : digest(files.get(path)),
        ]),
      ),
    homeText: async () => userXml,
    request: async (path, auth) => {
      calls.push(`GET:${path}:${auth}`);
      if (path.startsWith("api/json")) return controller;
      if (path.startsWith("computer/")) return computers;
      if (path.startsWith("queue/")) return queue;
      if (path.startsWith("pluginManager/")) return plugins;
      const name = /^job\/([^/]+)/.exec(path)?.[1];
      if (name && path.endsWith("config.xml"))
        return "<flow-definition><disabled>true</disabled></flow-definition>";
      if (name) return jobStates.find((job) => job.name === name);
      throw new Error("Unexpected readonly fixture query");
    },
    status: async (_path, auth) => (auth === "anonymous" ? 403 : 200),
    apiHealth: async () => 200,
    publicApiHealth: async () => 200,
    apiPid: async () => 64657,
  };
  return {
    verified,
    receipt,
    lock,
    operations,
    files,
    calls,
    controller,
    computers,
    queue,
    jobStates,
    plugins,
  };
}

test("complete readonly evidence proves ten secrets, original credentials/history, paused jobs, locked plugins and unchanged native API without exposing values or digests", async () => {
  const f = fixture();
  const proof = await verifyMigration(f);
  assert.equal(proof.secrets.files, 10);
  assert.equal(proof.secrets.allBytesMatch, true);
  assert.equal(proof.builds.files, 6);
  assert.equal(proof.builds.success, 5);
  assert.equal(proof.builds.failure, 1);
  assert.equal(proof.user.passwordHashPreserved, true);
  assert.equal(proof.authentication.originalApiTokenStatus, 200);
  assert.equal(proof.authentication.originalPasswordStatus, 200);
  assert.equal(proof.paused.jobs, 9);
  assert.equal(proof.plugins.count, 70);
  assert.equal(proof.mutations, false);
  assert.equal(proof.activated, false);
  const serialized = JSON.stringify(proof);
  for (const [path, bytes] of f.files)
    assert.ok(
      !serialized.includes(bytes.toString()) &&
        !serialized.includes(digest(bytes)),
      `Private operands withheld for ${path}`,
    );
  assert.equal(
    f.calls.some((call) =>
      /POST:|scriptText|createItem|buildWithParameters|activate/.test(call),
    ),
    false,
  );
});

test("secret hash mismatch fails using only a fixed safe label rather than formatting secret operands", () => {
  const before = digest("private-fixture-secret-original");
  const after = digest("private-fixture-secret-replacement");
  try {
    comparePrivateHashes(
      new Map([["secrets/master.key", before]]),
      new Map([["secrets/master.key", after]]),
      "secret bytes preserved",
    );
    assert.fail("Expected mismatch");
  } catch (error) {
    assert.equal(
      error.message.includes(before) ||
        error.message.includes(after) ||
        error.message.includes("private-fixture"),
      false,
    );
    assert.match(error.message, /secret bytes preserved/);
  }
});

test("user API token/password field drift fails even if configuration looks structurally valid", () => {
  for (const changed of [
    userXml.replace("private-fixture-password-hash", "replacement-password"),
    userXml.replace("private-fixture-token-hash", "replacement-token"),
    "<user/>",
  ])
    assert.throws(
      () => compareUserAuthentication(userXml, changed),
      /preserved user password and API token fields/,
    );
  assert.deepEqual(compareUserAuthentication(userXml, `\n${userXml}`), {
    passwordHashPreserved: true,
    apiTokenStorePreserved: true,
    wholeConfigBytesMatch: false,
  });
});

test("only the matching never-activated private import receipt proves source identity", () => {
  const f = fixture();
  for (const change of [
    { archiveSha256: "e".repeat(64) },
    { targetHomeVolume: "agent-platform-jenkins-lab-home" },
    { activated: true },
    { apiTouched: true },
    { controllerMode: "active" },
  ])
    assert.throws(
      () =>
        validateReceipt(
          { ...f.receipt, ...change },
          f.verified.manifest.archive.sha256,
        ),
      /receipt identity/,
    );
});

test("container root identity, writable rootfs, host socket/binds, public binding and active mode are rejected", () => {
  for (const mutate of [
    (value) => {
      value.Config.User = "0:0";
    },
    (value) => {
      value.HostConfig.ReadonlyRootfs = false;
    },
    (value) => {
      value.Mounts.push({ Type: "bind", Source: "/var/run/docker.sock" });
    },
    (value) => {
      value.HostConfig.NetworkMode = "host";
    },
    (value) => {
      value.HostConfig.PortBindings["8080/tcp"][0].HostIp = "0.0.0.0";
    },
    (value) => {
      value.Config.Env = ["AGENT_PLATFORM_CONTROLLER_MODE=active"];
    },
  ]) {
    const value = inspection();
    mutate(value);
    assert.throws(
      () => verifyInspection(value),
      /Migration verification failed/,
    );
  }
});

test("a queued build, enabled job, online original Mac node or running historical build cannot pass migration readiness", () => {
  for (const mutate of [
    (f) => {
      f.queue.items.push({ id: 1 });
    },
    (f) => {
      f.controller.jobs[0].buildable = true;
    },
    (f) => {
      f.computers.computer[1].offline = false;
    },
    (f) => {
      f.jobStates[0].builds[0].building = true;
    },
    (f) => {
      f.controller.numExecutors = 2;
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(
      () => verifyPausedState(f.controller, f.computers, f.queue, f.jobStates),
      /Migration verification failed/,
    );
  }
});

test("plugins must match both live active versions and exact pinned JPI bytes", () => {
  for (const boundary of ["version", "active", "hash", "extra"]) {
    const f = fixture();
    const hashes = new Map(
      f.lock.plugins.map((plugin) => [
        `plugins/${plugin.name}.jpi`,
        plugin.sha256,
      ]),
    );
    if (boundary === "version")
      f.plugins.plugins[0].version = "replacement-version";
    if (boundary === "active") f.plugins.plugins[0].active = false;
    if (boundary === "hash") hashes.set("plugins/plugin-0.jpi", "e".repeat(64));
    if (boundary === "extra")
      f.plugins.plugins.push({ shortName: "unexpected", active: true });
    assert.throws(
      () => verifyPlugins(f.lock, f.plugins, hashes),
      /locked active plugin/,
    );
  }
});

test("matching build XML bytes do not hide a live-history result or record-count change", async () => {
  for (const mutate of [
    (f) => {
      f.jobStates[0].builds[0].result = "SUCCESS";
    },
    (f) => {
      f.jobStates[0].builds.push({
        number: 7,
        result: "SUCCESS",
        building: false,
      });
    },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(verifyMigration(f), /history and results unchanged/);
  }
});

test("an original password/token failure or changed public API PID refuses a successful report", async () => {
  for (const boundary of ["password", "token", "apiPid", "publicHealth"]) {
    const f = fixture();
    if (boundary === "password" || boundary === "token")
      f.operations.status = async (_path, auth) =>
        auth === "anonymous" ? 403 : auth === boundary ? 401 : 200;
    if (boundary === "apiPid") f.operations.apiPid = async () => 99999;
    if (boundary === "publicHealth")
      f.operations.publicApiHealth = async () => 503;
    await assert.rejects(
      verifyMigration(f),
      /credentials usable|unchanged native PID/,
    );
  }
});

test("the verifier uses only fixed read commands and GET endpoints, with no inherited credentials or raw-error logging", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(
      new URL("./verify-home-migration.mjs", import.meta.url),
      "utf8",
    ),
  );
  assert.match(source, /O_RDONLY \| constants\.O_NOFOLLOW/);
  assert.match(
    source,
    /env: \{ PATH: "\/usr\/bin:\/bin", LANG: "C", COPYFILE_DISABLE: "1" \}/,
  );
  assert.equal(
    /method:\s*["']POST|\["(?:run|start|stop|create|restart|rm)"/.test(source),
    false,
  );
  assert.equal(
    /console\.(?:log|error)\([^\n]*(?:credential|authorization|cookie|password|stderr|error\.message)/i.test(
      source,
    ),
    false,
  );
});
