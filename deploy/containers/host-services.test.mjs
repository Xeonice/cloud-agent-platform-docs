import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  hostServiceDefinitions,
  renderHostServices,
  verifyBundle,
  validateNativeStartup,
  validateDockerConfiguration,
  assertFixedLabelsUnloaded,
  PUBLIC_SOURCES,
  SECRET_TARGETS,
  PROFILES,
  DOCKER_CONFIG,
} from "./host-services.mjs";
import {
  VERCEL_DESTINATION,
  VERCEL_VERSION,
} from "../macmini/public-build-tools.mjs";

const uid = process.getuid();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
async function fixture(t) {
  const directory = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "host-service-review-")),
  );
  await fs.chmod(directory, 0o700);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const content = Object.fromEntries(
    Object.entries(renderHostServices()).map(([label, text]) => [
      `${label}.plist`,
      Buffer.from(text),
    ]),
  );
  for (const name of Object.keys(PUBLIC_SOURCES))
    content[name] = Buffer.from(`// reviewed ${name}\n`);
  content["agent.jar"] = Buffer.from("fixture archive bytes");
  for (const name of Object.keys(SECRET_TARGETS))
    content[name] = Buffer.from(`${"a".repeat(64)}\n`);
  const files = {};
  for (const [name, bytes] of Object.entries(content)) {
    await fs.writeFile(join(directory, name), bytes, { mode: 0o600 });
    files[name] = { sha256: hash(bytes), sizeBytes: bytes.length };
  }
  const manifest = {
    version: 1,
    kind: "jenkins-container-host-services",
    files,
    vercel: { version: VERCEL_VERSION, destination: VERCEL_DESTINATION },
    profileHashes: Object.fromEntries(
      PROFILES.map((profile) => [profile, "a".repeat(64)]),
    ),
  };
  const save = async () => {
    const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    await fs.writeFile(join(directory, "manifest.json"), bytes, {
      mode: 0o600,
    });
    return hash(bytes);
  };
  const change = async (name, bytes) => {
    await fs.writeFile(join(directory, name), bytes);
    manifest.files[name] = {
      sha256: hash(bytes),
      sizeBytes: Buffer.byteLength(bytes),
    };
    return save();
  };
  return { directory, manifest, save, change, reviewedHash: await save() };
}

test("only two dedicated VM timers and two unprivileged native agents are rendered", () => {
  const definitions = hostServiceDefinitions();
  assert.equal(definitions.length, 4);
  assert.equal(new Set(definitions.map((value) => value.Label)).size, 4);
  assert.ok(
    definitions.every((value) => !/\.(?:api|tunnel|cicd)$/.test(value.Label)),
  );
  const timers = definitions.filter((value) => value.StartInterval);
  assert.equal(timers.length, 2);
  assert.deepEqual(
    timers.map((value) => value.ProgramArguments[2]),
    PROFILES,
  );
  for (const timer of timers) {
    assert.equal(timer.UserName, "douglasdong");
    assert.equal(timer.StartInterval, 60);
    assert.deepEqual(timer.KeepAlive, { SuccessfulExit: false });
    assert.ok(timer.ProgramArguments.includes("--foreground"));
    assert.ok(timer.ProgramArguments.includes("--save-config=false"));
    assert.ok(timer.ProgramArguments.includes("--activate=false"));
    assert.equal(
      timer.ProgramArguments[timer.ProgramArguments.indexOf("--mount") + 1],
      "none",
    );
    assert.equal(timer.EnvironmentVariables.DOCKER_CONFIG, DOCKER_CONFIG);
  }
  assert.ok(timers[0].ProgramArguments.includes("--vz-rosetta=false"));
  assert.ok(timers[1].ProgramArguments.includes("--vz-rosetta=true"));
});

test("existing system or GUI jobs and unknown queries refuse installation before any service change", () => {
  const calls = [];
  assertFixedLabelsUnloaded((label, domain) => {
    calls.push({ label, domain });
    return false;
  });
  assert.equal(calls.length, 8);
  assert.deepEqual(
    [...new Set(calls.map((value) => value.domain))],
    ["system", "gui/501"],
  );
  for (const existingDomain of ["system", "gui/501"])
    assert.throws(
      () =>
        assertFixedLabelsUnloaded(
          (label, domain) =>
            domain === existingDomain && label.endsWith("jenkins-ci-agent"),
        ),
      /already loaded/,
    );
  assert.throws(() => assertFixedLabelsUnloaded(() => null), /unknown/);
  assert.throws(
    () =>
      assertFixedLabelsUnloaded(() => {
        throw new Error("query failed");
      }),
    /query failed/,
  );
});

test("agents use fixed file credentials and Remoting workDirs without secret environment values", () => {
  const agents = hostServiceDefinitions().filter(
    (value) => !value.StartInterval,
  );
  assert.deepEqual(
    agents.map((value) => value.UserName),
    ["douglasdong", "_agentplatformci"],
  );
  assert.deepEqual(
    agents.map(
      (value) =>
        value.ProgramArguments[value.ProgramArguments.indexOf("-name") + 1],
    ),
    ["mac-deploy", "mac-ci"],
  );
  for (const agent of agents) {
    assert.ok(
      agent.ProgramArguments[
        agent.ProgramArguments.indexOf("-secret") + 1
      ].startsWith("@/"),
    );
    assert.ok(agent.ProgramArguments.includes("-webSocket"));
    assert.equal(
      agent.ProgramArguments[agent.ProgramArguments.indexOf("-url") + 1],
      "http://127.0.0.1:8080/",
    );
    assert.ok(
      Object.keys(agent.EnvironmentVariables).every(
        (name) => !/SECRET|TOKEN|PASS|DOCKER/.test(name),
      ),
    );
    assert.equal(agent.KeepAlive, true);
    assert.equal(agent.Umask, 0o077);
  }
});

test("five public modules include the ci-platform sibling and all source imports resolve without execution", async () => {
  assert.equal(Object.keys(PUBLIC_SOURCES).length, 5);
  assert.equal(
    PUBLIC_SOURCES["ci-platform.mjs"],
    "deploy/jenkins/ci-platform.mjs",
  );
  for (const relative of Object.values(PUBLIC_SOURCES)) {
    const file = join(repository, relative);
    assert.ok((await fs.lstat(file)).isFile());
    await import(pathToFileURL(file).href);
  }
});

test("VM Docker configuration accepts credential-free contexts and rejects credentials/helpers", () => {
  validateDockerConfiguration({});
  validateDockerConfiguration({
    auths: {},
    currentContext: "colima-agent-platform-jenkins",
  });
  for (const config of [
    null,
    [],
    { auths: { registry: { auth: "fixture" } } },
    { auths: [] },
    { credsStore: "osxkeychain" },
    { credHelpers: {} },
    { currentContext: {} },
    { plugins: {} },
  ])
    assert.throws(() => validateDockerConfiguration(config));
});

test("existing OrbStack Compose/Buildx plugin directory is allowed only at its fixed exact path", () => {
  const fixed = "/Applications/OrbStack.app/Contents/MacOS/xbin";
  validateDockerConfiguration({ cliPluginsExtraDirs: [fixed] });
  validateDockerConfiguration({ auths: {}, cliPluginsExtraDirs: [fixed] });
  for (const directories of [
    [],
    ["/tmp/plugins"],
    [fixed, "/tmp/plugins"],
    [fixed, fixed],
    [fixed + "/../xbin"],
    fixed,
    null,
  ])
    assert.throws(() =>
      validateDockerConfiguration({ cliPluginsExtraDirs: directories }),
    );
  assert.throws(() =>
    validateDockerConfiguration({
      cliPluginsExtraDirs: [fixed],
      credsStore: "osxkeychain",
    }),
  );
});

test("complete private reviewed bytes and fixed plist arguments verify", async (t) => {
  const value = await fixture(t);
  const actual = await verifyBundle(value.directory, value.reviewedHash, uid);
  assert.equal(actual.kind, "jenkins-container-host-services");
  assert.equal(Object.keys(actual.files).length, 12);
});

test("changed manifest hash or changed reviewed public tool bytes are refused", async (t) => {
  const value = await fixture(t);
  await assert.rejects(
    () => verifyBundle(value.directory, "b".repeat(64), uid),
    /manifest hash/,
  );
  await fs.appendFile(
    join(value.directory, "project-ci.mjs"),
    "// unreviewed\n",
  );
  await assert.rejects(
    () => verifyBundle(value.directory, value.reviewedHash, uid),
    /bytes changed/,
  );
});

test("extra members and unapproved destinations cannot enter the privileged bundle", async (t) => {
  const value = await fixture(t);
  await fs.writeFile(join(value.directory, "unexpected.sh"), "fixture", {
    mode: 0o600,
  });
  await assert.rejects(
    () => verifyBundle(value.directory, value.reviewedHash, uid),
    /unapproved files/,
  );
  await fs.unlink(join(value.directory, "unexpected.sh"));
  value.manifest.vercel.destination = "/tmp/arbitrary-root-destination";
  await assert.rejects(
    async () => verifyBundle(value.directory, await value.save(), uid),
    /Vercel distribution/,
  );
});

test("even rehashed service changes cannot introduce another program or production label", async (t) => {
  const value = await fixture(t);
  const name = `${hostServiceDefinitions()[0].Label}.plist`;
  const content = (
    await fs.readFile(join(value.directory, name), "utf8")
  ).replace("/opt/homebrew/bin/colima", "/bin/sh");
  const reviewedHash = await value.change(name, content);
  await assert.rejects(
    () => verifyBundle(value.directory, reviewedHash, uid),
    /fixed label/,
  );
});

test("symlink and hardlink members are refused without following external bytes", async (t) => {
  const value = await fixture(t);
  const file = join(value.directory, "mac-ci.secret");
  const outside = `${value.directory}-external`;
  t.after(() => fs.rm(outside, { force: true }));
  await fs.rename(file, outside);
  await fs.symlink(outside, file);
  await assert.rejects(() =>
    verifyBundle(value.directory, value.reviewedHash, uid),
  );
  await fs.unlink(file);
  await fs.link(outside, file);
  await assert.rejects(
    () => verifyBundle(value.directory, value.reviewedHash, uid),
    /owner-only/,
  );
});

test("world-readable files or a directory alias cannot pass private review", async (t) => {
  const value = await fixture(t);
  const name = join(value.directory, "agent.jar");
  await fs.chmod(name, 0o644);
  await assert.rejects(
    () => verifyBundle(value.directory, value.reviewedHash, uid),
    /owner-only/,
  );
  await fs.chmod(name, 0o600);
  const alias = `${value.directory}-alias`;
  t.after(() => fs.unlink(alias));
  await fs.symlink(value.directory, alias);
  await assert.rejects(
    () => verifyBundle(alias, value.reviewedHash, uid),
    /Unsafe reviewed/,
  );
});

test("blank or malformed agent credentials and missing profile evidence cannot pass review", async (t) => {
  const value = await fixture(t);
  const reviewedHash = await value.change(
    "mac-ci.secret",
    "not-an-agent-credential",
  );
  await assert.rejects(
    () => verifyBundle(value.directory, reviewedHash, uid),
    /exported Jenkins/,
  );
  await value.change("mac-ci.secret", "a".repeat(64));
  delete value.manifest.profileHashes[PROFILES[1]];
  await assert.rejects(
    async () => verifyBundle(value.directory, await value.save(), uid),
    /profile configuration evidence/,
  );
});

function successfulRun(calls) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    const stdout =
      args[0] === "--version"
        ? file.endsWith("/java")
          ? "openjdk 21.0.12"
          : "v22.23.3"
        : args.at(-1) === "--version"
          ? args[0].endsWith("corepack.js")
            ? "0.36.0"
            : VERCEL_VERSION
          : "";
    return { status: 0, signal: null, stdout, stderr: "" };
  };
}
const ciTarget = {
  user: "_agentplatformci",
  uid: 401,
  home: "/Users/Shared/agent-platform-ci",
};

test("startup probes drop privileges, isolate environment and import all five reviewed public tools", () => {
  const calls = [];
  const result = validateNativeStartup(ciTarget, successfulRun(calls));
  assert.equal(result.publicImports, 5);
  for (const call of calls) {
    assert.equal(call.options.uid, 401);
    assert.equal(call.options.gid, 20);
    assert.equal(call.options.cwd, "/");
    assert.ok(!Object.hasOwn(call.options.env, "NODE_OPTIONS"));
    assert.ok(!Object.hasOwn(call.options.env, "ACCESS_PASSCODE"));
  }
  assert.ok(calls.filter((call) => call.file === "/bin/test").length >= 7);
  const moduleProbe = calls.find(
    (call) => call.args[0] === "--input-type=module",
  );
  assert.ok(moduleProbe.args.at(-1).includes("ci-platform.mjs"));
  assert.ok(moduleProbe.args.at(-1).includes("Application%20Support"));
  assert.ok(!calls.some((call) => call.args.includes("pnpm")));
});

test("missing commands, timeouts, signals and nonstandard test results fail closed", () => {
  for (const result of [
    { error: { code: "ENOENT" }, status: 0 },
    { error: { code: "ETIMEDOUT" }, status: 1 },
    { signal: "SIGTERM", status: 0 },
    { status: null },
    { status: 2 },
    { status: 1 },
  ])
    assert.throws(() => validateNativeStartup(ciTarget, () => result));
  assert.throws(
    () => validateNativeStartup({ ...ciTarget, uid: 501 }, successfulRun([])),
    /identity/,
  );
});

test("wrong Node or Java versions and unsuccessful module imports block service startup", () => {
  for (const phase of ["Node22", "Java21", "imports"]) {
    const baseline = successfulRun([]);
    const run = (file, args, options) => {
      if (
        phase === "Node22" &&
        file.endsWith("/node") &&
        args[0] === "--version"
      )
        return { status: 0, stdout: "v24.0.0" };
      if (
        phase === "Java21" &&
        file.endsWith("/java") &&
        args[0] === "--version"
      )
        return { status: 0, stdout: "openjdk 17.0.0" };
      if (phase === "imports" && args[0] === "--input-type=module")
        return { status: 1, stderr: "fixture failure" };
      return baseline(file, args, options);
    };
    assert.throws(() => validateNativeStartup(ciTarget, run));
  }
});
