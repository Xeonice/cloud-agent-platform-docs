import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  prepareApiContext,
  sourceAllowed,
  command,
  CONTAINER_INPUTS,
} from "./api-context.mjs";
import {
  idle,
  buildRequest,
  releaseKey,
  createDeployer,
  runtimePolicy,
  runtimeArguments,
  privateFile,
  immutableJson,
  digest,
  redactLogs,
  run,
  BARRIER_SCRIPT,
  CLEAR_DATA_SCRIPT,
  MIGRATION_DATA_PROBE,
  NATIVE_ADDON_PROBE,
} from "./api-container.mjs";

const SHA = "a".repeat(40),
  ROOT_SHA = "b".repeat(40),
  NEXT = "c".repeat(40);
const IMAGE = "sha256:" + "1".repeat(64),
  OLD_IMAGE = "sha256:" + "2".repeat(64),
  FINGERPRINT = "d".repeat(64);
const envText =
  "HOST=127.0.0.1\nPORT=3101\nDATA_ROOT=/data\nDATABASE_URL=/data/platform.db\nBOXLITE_HOME=/data/boxlite\nDEPLOYMENT_DRAIN_FILE=/data/deployment-drain\nAPI_ALLOWED_ORIGINS=https://app.example.com\nAPI_TRUST_PROXY=cloudflare-loopback\nACCESS_PASSCODE_ALLOW_LOOPBACK=false\nPASSCODE_COOKIE_SECURE=true\nACCESS_PASSCODE=fixture-private-passcode\nPASSCODE_COOKIE_SECRET=fixture-private-cookie\n";
const quietStatus = {
  ready: true,
  draining: true,
  activeWS: 2,
  inFlightHTTP: 0,
  credentialAuth: 0,
  blockers: {
    sandboxes: 0,
    agentTasks: 0,
    automationRuns: 0,
    enabledAutomations: 0,
    resourceAllocations: 0,
    cloningProjects: 0,
    projectCleanupJobs: 0,
  },
};
const labels = (sha = SHA, rootSha = ROOT_SHA, fingerprint = FINGERPRINT) => ({
  "com.agent-platform.role": "production-api",
  "com.agent-platform.api-sha": sha,
  "com.agent-platform.root-sha": rootSha,
  "com.agent-platform.schema-fingerprint": fingerprint,
});
const release = (sha = SHA, imageId = IMAGE, fingerprint = FINGERPRINT) => ({
  schemaVersion: 2,
  sha,
  rootSha: ROOT_SHA,
  platform: "linux",
  arch: "arm64",
  nodeMajor: 22,
  imageId,
  boxliteVersion: "0.9.7",
  nativeProbe: "passed",
  builtAt: "2026-10-07T00:00:00.000Z",
  imageArchive: "api-image.tar",
  schemaFingerprint: fingerprint,
});
async function temp(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "agent-api-test-")),
  );
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function write(path, bytes) {
  await fs.mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await fs.writeFile(path, bytes, { mode: 0o600 });
}
async function commit(path) {
  await command("git", ["init", "-q"], { cwd: path });
  await command("git", ["add", "."], { cwd: path });
  await command(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: path },
  );
  return (await command("git", ["rev-parse", "HEAD"], { cwd: path })).trim();
}
async function sources(root) {
  const api = join(root, "api"),
    project = join(root, "project");
  for (const [name, bytes] of [
    ["pnpm-lock.yaml", "lock"],
    ["pnpm-workspace.yaml", "workspace"],
    ["package.json", "{}"],
    ["apps/api/src/main.ts", "export {}"],
    ["drizzle/0001.sql", "CREATE TABLE foo(id);"],
    ["drizzle/meta/_journal.json", "{}"],
  ])
    await write(join(api, name), bytes);
  for (const name of CONTAINER_INPUTS)
    await write(
      join(project, "deploy/containers", name),
      "public-pinned-" + name,
    );
  // Unrelated root submodules and private untracked files must never be inspected or copied.
  const sha = await commit(api),
    rootSha = await commit(project);
  await command(
    "git",
    ["update-index", "--add", "--cacheinfo", "160000," + sha + ",api"],
    { cwd: project },
  );
  await command(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "submodule",
    ],
    { cwd: project },
  );
  return {
    api,
    project,
    sha,
    rootSha: (
      await command("git", ["rev-parse", "HEAD"], { cwd: project })
    ).trim(),
    oldRootSha: rootSha,
  };
}

test("public context excludes private data, dependencies and escaping paths", () => {
  for (const name of [
    ".env",
    "a/.env.production",
    "data/master.key",
    "node_modules/a.js",
    "a/dist/index.js",
    "/tmp/a",
    "../a",
    "a/../b",
    "a.pem",
    "a\\b",
  ])
    assert.equal(sourceAllowed(name), false, name);
  for (const name of [
    ".env.example",
    "pnpm-lock.yaml",
    "packages/sandbox/package.json",
    "apps/api/src/main.ts",
  ])
    assert.equal(sourceAllowed(name), true, name);
});
test("pinned root public inputs define the context; submodule, installed tools and untracked secrets stay out", async (t) => {
  const root = await temp(t),
    src = await sources(root);
  await write(join(src.api, ".env"), "SECRET=never-copy");
  await write(
    join(src.project, "deploy/containers/untrusted.mjs"),
    "throw Error('never execute')",
  );
  const { context, manifest } = await prepareApiContext(
    src.api,
    src.project,
    root,
    src,
  );
  assert.equal(
    await fs.readFile(join(context, "Dockerfile.api"), "utf8"),
    "public-pinned-Dockerfile.api",
  );
  assert.equal(manifest.rootSha, src.rootSha);
  assert.equal(manifest.sha, src.sha);
  assert.match(manifest.schemaFingerprint, /^[a-f0-9]{64}$/);
  await assert.rejects(fs.stat(join(context, "api/.env")), { code: "ENOENT" });
  await assert.rejects(fs.stat(join(context, "untrusted.mjs")), {
    code: "ENOENT",
  });
  const paths = manifest.files.map((file) => file.path);
  assert.ok(paths.includes("manifests/pnpm-lock.yaml"));
  await assert.rejects(
    prepareApiContext(src.api, src.project, root, {
      sha: src.sha,
      rootSha: src.oldRootSha,
    }),
    /Pinned checkout/,
  );
  await write(
    join(src.project, "deploy/containers/Dockerfile.api"),
    "dirty installed replacement",
  );
  await assert.rejects(
    prepareApiContext(src.api, src.project, root, src),
    /Public source command/,
  );
});
test("tracked secret, link and hardlinked inputs fail without retaining a partial context", async (t) => {
  const root = await temp(t),
    src = await sources(root);
  await write(join(src.api, ".env"), "SECRET=never-copy");
  await command("git", ["add", ".env"], { cwd: src.api });
  await assert.rejects(
    prepareApiContext(src.api, src.project, root),
    /Public source command/,
  );
  await command("git", ["reset", "-q", "HEAD", ".env"], { cwd: src.api });
  await fs.rm(join(src.api, "apps/api/src/main.ts"));
  await fs.symlink(
    join(src.api, ".env"),
    join(src.api, "apps/api/src/main.ts"),
  );
  await assert.rejects(
    prepareApiContext(src.api, src.project, root),
    /Public source command/,
  );
  await fs.rm(join(src.api, "apps/api/src/main.ts"));
  await command("git", ["checkout", "--", "apps/api/src/main.ts"], {
    cwd: src.api,
  });
  await fs.link(join(src.api, "apps/api/src/main.ts"), join(root, "linked"));
  await assert.rejects(
    prepareApiContext(src.api, src.project, root),
    /bounded regular/,
  );
  assert.equal(
    (await fs.readdir(root)).filter((name) =>
      name.startsWith("agent-platform-api-context-"),
    ).length,
    0,
  );
});
test("the complete migration input set participates in the schema guard", async (t) => {
  const root = await temp(t),
    src = await sources(root);
  const first = await prepareApiContext(src.api, src.project, root);
  await write(
    join(src.api, "drizzle/meta/_journal.json"),
    '{"newMigration":true}',
  );
  await commit(src.api);
  const second = await prepareApiContext(src.api, src.project, root);
  assert.notEqual(
    first.manifest.schemaFingerprint,
    second.manifest.schemaFingerprint,
  );
});
test("requests pin both commits and numeric Jenkins identity", () => {
  assert.deepEqual(buildRequest(SHA, "12", ROOT_SHA), {
    sha: SHA,
    rootSha: ROOT_SHA,
    runId: 12,
  });
  assert.equal(releaseKey(SHA, ROOT_SHA), ROOT_SHA + "-" + SHA);
  for (const args of [
    ["main", 1, ROOT_SHA],
    [SHA, "../12", ROOT_SHA],
    [SHA, 0, ROOT_SHA],
    [SHA, 12, "main"],
    [SHA, 12],
  ])
    assert.throws(() => buildRequest(...args));
});
test("pure dashboard sockets may reconnect, but all seven exact blocker names and auth/HTTP must be idle", () => {
  assert.equal(idle(quietStatus), true);
  for (const name of Object.keys(quietStatus.blockers))
    assert.equal(
      idle({
        ...quietStatus,
        blockers: { ...quietStatus.blockers, [name]: 1 },
      }),
      false,
      name,
    );
  for (const change of [
    { ready: false },
    { credentialAuth: 1 },
    { inFlightHTTP: 1 },
    { activeWS: undefined },
    { blockers: {} },
    { blockers: { ...quietStatus.blockers, futureUnknown: 0 } },
    { blockers: { ...quietStatus.blockers, sandboxes: undefined } },
  ])
    assert.equal(idle({ ...quietStatus, ...change }), false);
});
test("production uses VM loopback DNS with host networking and separate readonly secrets; unauthenticated or foreign runtime configuration is refused", () => {
  assert.equal(runtimePolicy(envText).PORT, "3101");
  const args = runtimeArguments(IMAGE, release());
  assert.equal(args[args.indexOf("--network") + 1], "host");
  assert.equal(args.filter((value) => value === "--dns").length, 1);
  assert.equal(args[args.indexOf("--dns") + 1], "127.0.0.2");
  assert.ok(
    args.includes(
      "type=volume,source=agent-platform-api-secrets,target=/run/secrets,readonly",
    ),
  );
  assert.ok(
    args.includes(
      "type=volume,source=agent-platform-production-data,target=/data",
    ),
  );
  assert.equal(
    args.filter((value) => value.startsWith("type=volume,")).length,
    2,
  );
  assert.ok(
    !args.some(
      (value) => value.includes("type=bind") || value.includes("docker.sock"),
    ),
  );
  for (const [from, to] of [
    [
      "ACCESS_PASSCODE_ALLOW_LOOPBACK=false",
      "ACCESS_PASSCODE_ALLOW_LOOPBACK=true",
    ],
    ["PASSCODE_COOKIE_SECURE=true", "PASSCODE_COOKIE_SECURE=false"],
    ["https://app.example.com", "https://*.example.com"],
    ["DATA_ROOT=/data", "DATA_ROOT=/Users/private"],
    ["ACCESS_PASSCODE=fixture-private-passcode", "ACCESS_PASSCODE="],
  ])
    assert.throws(() => runtimePolicy(envText.replace(from, to)));
});
test("private metadata rejects links and immutable receipts cannot be overwritten", async (t) => {
  const root = await temp(t),
    file = join(root, "receipt.json");
  await immutableJson(file, { sha: SHA });
  await immutableJson(file, { sha: SHA });
  await assert.rejects(immutableJson(file, { sha: NEXT }), /conflict/);
  await fs.link(file, join(root, "alias"));
  await assert.rejects(privateFile(file), /Unsafe/);
});
test("runtime logs collect Docker stderr and redact explicit values, bearer tokens and token assignments", async () => {
  const output = await run(
    process.execPath,
    [
      "-e",
      "process.stdout.write('public\\n');process.stderr.write('ACCESS_PASSCODE=private-value\\nBearer abc.secret\\n')",
    ],
    { quiet: true, includeStderr: true },
  );
  const safe = redactLogs(output, ["private-value"]);
  assert.match(safe, /public/);
  assert.match(safe, /ACCESS_PASSCODE=\[REDACTED\]/);
  assert.ok(!safe.includes("abc.secret") && !safe.includes("private-value"));
});
test("release native probe forces the lazy BoxLite NAPI binding to load after actual SQLite query semantics", () => {
  const output = [];
  let loads = 0,
    closes = 0;
  class SqliteFixture {
    prepare() {
      return { get: () => ({ value: 7 }) };
    }
    close() {
      closes++;
    }
  }
  const context = (unavailable) => ({
    require: (name) => {
      if (name === "better-sqlite3") return SqliteFixture;
      assert.equal(name, "node:module");
      return {
        createRequire: () => () => ({
          JsBoxlite: function LazyProxy() {},
          getNativeModule: () => {
            loads++;
            if (unavailable) throw Error("native binding unavailable");
            return { JsBoxlite: function NativeBinding() {} };
          },
        }),
      };
    },
    console: { log: (text) => output.push(text) },
  });
  assert.throws(
    () => runInNewContext(NATIVE_ADDON_PROBE, context(true)),
    /native binding unavailable/,
  );
  assert.equal(closes, 1);
  assert.equal(loads, 1);
  assert.deepEqual(output, []);
  runInNewContext(NATIVE_ADDON_PROBE, context(false));
  assert.equal(closes, 2);
  assert.equal(loads, 2);
  assert.deepEqual(output, ["native-probe-passed"]);
});

function markerScript(path) {
  return BARRIER_SCRIPT.replace(
    "const p='/data/deployment-drain'",
    "const p=" + JSON.stringify(path),
  );
}
async function marker(path, action, arg) {
  return run(
    process.execPath,
    [
      "-e",
      markerScript(path),
      action,
      typeof arg === "string" ? arg : JSON.stringify(arg),
    ],
    { quiet: true },
  );
}
test("real maintenance file preserves manual markers and operator replacements", async (t) => {
  const root = await temp(t),
    path = join(root, "drain");
  await write(path, "operator maintenance");
  await assert.rejects(marker(path, "hold", "controller owner"));
  assert.equal(await fs.readFile(path, "utf8"), "operator maintenance");
  await fs.unlink(path);
  const held = JSON.parse(await marker(path, "hold", "controller owner"));
  await marker(path, "check", held);
  await fs.unlink(path);
  await write(path, "operator replacement");
  await assert.rejects(marker(path, "release", held));
  assert.equal(await fs.readFile(path, "utf8"), "operator replacement");
});
test("real rollback tar restores data while retaining the exact admission marker inode without find", async (t) => {
  const root = await temp(t),
    data = join(root, "data"),
    archive = join(root, "backup.tgz");
  await fs.mkdir(data);
  const path = join(data, "deployment-drain");
  const held = JSON.parse(await marker(path, "hold", "controller owner"));
  await write(join(data, "platform.db"), "old database");
  await command("tar", [
    "--exclude=./deployment-drain",
    "-czf",
    archive,
    "-C",
    data,
    ".",
  ]);
  await write(join(data, "platform.db"), "failed migration");
  await write(join(data, ".temporary"), "new");
  await command("/bin/sh", ["-c", CLEAR_DATA_SCRIPT.replaceAll("/data", data)]);
  await command("tar", ["-xzf", archive, "-C", data]);
  await marker(path, "check", held);
  assert.equal(
    await fs.readFile(join(data, "platform.db"), "utf8"),
    "old database",
  );
  await assert.rejects(fs.stat(join(data, ".temporary")), { code: "ENOENT" });
  await marker(path, "release", held);
  await assert.rejects(fs.stat(path), { code: "ENOENT" });
});

async function harness(t, configuration = {}) {
  const root = await temp(t),
    workspace = join(root, "workspace"),
    tools = join(root, "tools");
  for (const path of [
    workspace,
    tools,
    join(root, "releases"),
    join(root, "jenkins-receipts"),
  ])
    await fs.mkdir(path, { mode: 0o700 });
  await write(join(root, "runtime.env"), envText);
  const calls = [],
    images = new Map();
  let current = null,
    built = 0;
  const container = (id, rel) => ({
    Id: id,
    Image: rel.imageId,
    Config: { Labels: labels(rel.sha, rel.rootSha, rel.schemaFingerprint) },
    State: { Running: true, Status: "running", Health: { Status: "healthy" } },
    HostConfig: { NetworkMode: "host" },
    Mounts: [
      {
        Type: "volume",
        Name: "agent-platform-production-data",
        Destination: "/data",
        RW: true,
      },
      {
        Type: "volume",
        Name: "agent-platform-api-secrets",
        Destination: "/run/secrets",
        RW: false,
      },
    ],
  });
  const addRelease = async (rel) => {
    const destination = join(
      root,
      "releases",
      releaseKey(rel.sha, rel.rootSha),
    );
    await fs.mkdir(destination, { mode: 0o700 });
    await immutableJson(join(destination, "release.json"), rel);
    await write(
      join(destination, "api-package.tgz"),
      "fixed-archive-" + rel.imageId,
    );
    const pkg = {
      state: "packaged",
      sha: rel.sha,
      rootSha: rel.rootSha,
      ...(await digest(join(destination, "api-package.tgz"))),
      platform: "linux",
      arch: "arm64",
      nodeMajor: 22,
      imageId: rel.imageId,
      boxliteVersion: "0.9.7",
      nativeProbe: "passed",
      files: 3,
    };
    await immutableJson(join(destination, "package.json"), pkg);
    images.set(rel.imageId, {
      Id: rel.imageId,
      Architecture: "arm64",
      Os: "linux",
      Config: { Labels: labels(rel.sha, rel.rootSha, rel.schemaFingerprint) },
    });
    return destination;
  };
  const data = join(root, "data");
  await fs.mkdir(data);
  const drain = join(data, "deployment-drain");
  const fakeRun = async (program, args, opts) => {
    calls.push({ program, args, opts });
    if (program === "tar") return run(program, args, opts);
    const a = args.slice(2);
    if (a[0] === "build") {
      built++;
      const tag = a[a.indexOf("-t") + 1];
      images.set(tag, {
        Id: IMAGE,
        Architecture: "arm64",
        Os: "linux",
        Config: { Labels: labels() },
      });
      images.set(IMAGE, images.get(tag));
      return "";
    }
    if (a[0] === "image") {
      if (!images.has(a.at(-1))) throw Error("missing image");
      return JSON.stringify([images.get(a.at(-1))]);
    }
    if (a[0] === "save") {
      await write(
        a[a.indexOf("--output") + 1],
        "fixed Docker OCI index archive",
      );
      return "";
    }
    if (a[0] === "container") return current ? current.Id + "\n" : "";
    if (a[0] === "logs") {
      assert.equal(opts.includeStderr, true);
      assert.equal(opts.quiet, true);
      if (a.at(-1) === "agent-platform-dns" && configuration.dns === null)
        throw Error("missing DNS container");
      return "public runtime output\nACCESS_PASSCODE=fixture-private-passcode\nfixture-private-cookie\nBearer fixture-authorization\n";
    }
    if (a[0] === "inspect" && a.at(-1) === "agent-platform-dns") {
      if (configuration.dns === null) throw Error("missing DNS container");
      return JSON.stringify([
        {
          Image: OLD_IMAGE,
          State: configuration.dns ?? {
            Status: "running",
            Health: { Status: "healthy" },
          },
          RestartCount: 0,
        },
      ]);
    }
    if (a[0] === "inspect") return JSON.stringify(current ? [current] : []);
    if (a[0] === "exec") return marker(drain, a.at(-2), a.at(-1));
    if (a[0] === "stop") {
      if (configuration.stopFailure) throw Error("stop outcome unknown");
      current.State.Running = false;
      configuration.onStop?.(current);
      return "";
    }
    if (a[0] === "rm") {
      current = null;
      return "";
    }
    if (a[0] === "start") {
      current.State.Running = true;
      return "";
    }
    if (a[0] === "run") {
      if (a.includes(BARRIER_SCRIPT)) return marker(drain, a.at(-2), a.at(-1));
      if (a.includes("-d")) {
        const id = "container-" + (a.at(-1) === IMAGE ? "new" : "old");
        const info = images.get(a.at(-1));
        current = container(
          id,
          release(
            info.Config.Labels["com.agent-platform.api-sha"],
            a.at(-1),
            info.Config.Labels["com.agent-platform.schema-fingerprint"],
          ),
        );
        configuration.onStart?.(current);
        return id;
      }
      if (a.at(-1).includes("Unsafe runtime secret"))
        return (
          (configuration.secretMismatch
            ? "f".repeat(64)
            : createHash("sha256").update(envText).digest("hex")) + "\n"
        );
      if (a.at(-1).includes("native-probe-passed"))
        return "native-probe-passed\n";
      if (a.at(-1).includes("migration-data-probe-passed")) {
        if (configuration.migrationProbeFail)
          throw Error("Migration DB not sealed");
        return "migration-data-probe-passed\n";
      }
      if (a.includes("/bin/sh")) {
        if (configuration.backupFailure && a.at(-1).includes("tar -czf"))
          throw Error("backup failed");
        return "";
      }
    }
    throw Error("Unhandled test boundary: " + JSON.stringify(a));
  };
  const service = createDeployer({
    root,
    tools,
    base: configuration.base,
    run: fakeRun,
    heads: async () =>
      configuration.heads?.() ?? { sha: SHA, rootSha: ROOT_SHA },
    now: () => "2026-10-07T00:00:00.000Z",
    sleep: async (ms) => configuration.onSleep?.(ms, current),
    checkout: async (kind, sha, stage) => {
      const path = join(stage, kind);
      await fs.mkdir(path);
      return path;
    },
    prepare: async (api, project, stage, request) => {
      assert.equal(request.rootSha, ROOT_SHA);
      const context = join(stage, "context");
      await fs.mkdir(context);
      return { context, manifest: { schemaFingerprint: FINGERPRINT } };
    },
    status: configuration.actualReadiness
      ? undefined
      : async () => configuration.status?.(drain) ?? quietStatus,
    ready: configuration.actualReadiness
      ? undefined
      : async (rel) => {
          configuration.onReady?.(current, rel);
          if (configuration.failNewReadiness && rel.imageId === IMAGE)
            throw Error("new readiness failed");
        },
  });
  return {
    root,
    workspace,
    calls,
    images,
    service,
    addRelease,
    drain,
    get built() {
      return built;
    },
    adopt: (rel) => {
      current = container("container-original", rel);
    },
    get current() {
      return current;
    },
  };
}
async function apiHttpFixture(t) {
  const requests = [];
  const state = { health: 200, commit: SHA, ready: true };
  const server = createServer((request, response) => {
    const authenticated =
      request.headers.authorization === "Bearer fixture-private-passcode";
    requests.push({
      method: request.method,
      path: request.url,
      authenticated,
      carriesAuthorization: request.headers.authorization !== undefined,
    });
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/api/health") {
      response.statusCode = state.health;
      response.end(JSON.stringify({ status: "ok", uptimeSec: 1 }));
    } else if (
      request.method === "GET" &&
      ["/api/system/version", "/api/deployment/status"].includes(request.url)
    ) {
      response.statusCode = authenticated ? 200 : 401;
      response.end(
        JSON.stringify(
          request.url === "/api/system/version"
            ? { commit: state.commit }
            : { ...quietStatus, ready: state.ready },
        ),
      );
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ statusCode: 404 }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    base: "http://127.0.0.1:" + server.address().port,
    port: server.address().port,
    requests,
    state,
  };
}
test("Docker HEALTHCHECK executes the real passcode-exempt /api/health route and rejects HTTP failure", async (t) => {
  const api = await apiHttpFixture(t);
  const dockerfile = await fs.readFile(
    new URL("./Dockerfile.api", import.meta.url),
    "utf8",
  );
  const cmd = dockerfile.match(/^HEALTHCHECK .* CMD node -e "(.*)"$/m)?.[1];
  assert.ok(cmd, "Docker image must advertise an executable Node healthcheck");
  async function healthcheck() {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", cmd], {
        env: { PORT: String(api.port), PATH: "/usr/bin:/bin" },
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
  }
  assert.equal(await healthcheck(), 0);
  assert.deepEqual(api.requests, [
    {
      method: "GET",
      path: "/api/health",
      authenticated: false,
      carriesAuthorization: false,
    },
  ]);
  api.state.health = 503;
  assert.equal(await healthcheck(), 1);
});
test("current-image readiness uses actual HTTP routes and still requires pinned version and authenticated deployment readiness", async (t) => {
  const api = await apiHttpFixture(t);
  const h = await harness(t, { base: api.base, actualReadiness: true });
  await h.service.build(SHA, 58, h.workspace, ROOT_SHA);
  h.adopt(release());
  assert.equal((await h.service.deploy(SHA, 58)).state, "current");
  assert.deepEqual(api.requests, [
    {
      method: "GET",
      path: "/api/health",
      authenticated: false,
      carriesAuthorization: false,
    },
    {
      method: "GET",
      path: "/api/system/version",
      authenticated: true,
      carriesAuthorization: true,
    },
    {
      method: "GET",
      path: "/api/deployment/status",
      authenticated: true,
      carriesAuthorization: true,
    },
  ]);
  api.state.commit = NEXT;
  await assert.rejects(
    h.service.deploy(SHA, 58),
    /readiness or pinned version/,
  );
  api.state.commit = SHA;
  api.state.ready = false;
  await assert.rejects(
    h.service.deploy(SHA, 58),
    /readiness or pinned version/,
  );
});
test("same root/API build cache reuses exact artifact/image/builtAt and emits independent immutable receipts", async (t) => {
  const h = await harness(t),
    first = await h.service.build(SHA, 12, h.workspace, ROOT_SHA);
  const original = JSON.parse(
      await privateFile(join(first.artifactPath, "release.json")),
    ),
    originalArtifact = await digest(join(h.workspace, "api-package-12.tgz"));
  const nextWorkspace = join(h.root, "workspace-next");
  await fs.mkdir(nextWorkspace, { mode: 0o700 });
  const second = await h.service.build(SHA, 13, nextWorkspace, ROOT_SHA);
  assert.equal(h.built, 1);
  assert.equal(second.imageId, first.imageId);
  assert.equal(
    second.artifactPath,
    join(h.root, "releases", ROOT_SHA + "-" + SHA),
  );
  assert.deepEqual(
    await digest(join(nextWorkspace, "api-package-13.tgz")),
    originalArtifact,
  );
  assert.deepEqual(
    JSON.parse(await privateFile(join(first.artifactPath, "release.json"))),
    original,
  );
  assert.equal(
    JSON.parse(
      await privateFile(join(h.root, "jenkins-receipts", SHA + "-13.json")),
    ).rootSha,
    ROOT_SHA,
  );
  const archive = (
    await command("tar", ["-tzf", join(h.workspace, "api-package-12.tgz")])
  )
    .split("\n")
    .filter((path) => path && !path.endsWith("/"));
  assert.deepEqual(archive.sort(), [
    "agent-platform-api/README.md",
    "agent-platform-api/api-image.tar",
    "agent-platform-api/release.json",
  ]);
});
test("conflicting/foreign cache and artifact bytes remain untouched rather than being overwritten", async (t) => {
  const h = await harness(t),
    destination = await h.addRelease(release());
  await write(join(destination, "api-package.tgz"), "tampered bytes");
  await assert.rejects(
    h.service.build(SHA, 12, h.workspace, ROOT_SHA),
    /content conflict/,
  );
  assert.equal(
    await fs.readFile(join(destination, "api-package.tgz"), "utf8"),
    "tampered bytes",
  );
  assert.equal(h.built, 0);
  const foreign = await harness(t);
  await fs.mkdir(join(foreign.root, "releases", releaseKey(SHA, ROOT_SHA)), {
    mode: 0o700,
  });
  await write(
    join(foreign.root, "releases", releaseKey(SHA, ROOT_SHA), "operator-note"),
    "retain",
  );
  await assert.rejects(
    foreign.service.build(SHA, 12, foreign.workspace, ROOT_SHA),
    /directory conflict/,
  );
  assert.equal(
    await fs.readFile(
      join(
        foreign.root,
        "releases",
        releaseKey(SHA, ROOT_SHA),
        "operator-note",
      ),
      "utf8",
    ),
    "retain",
  );
});
async function deployHarness(t, configuration = {}) {
  const h = await harness(t, configuration);
  await h.addRelease(
    release(
      NEXT,
      OLD_IMAGE,
      configuration.schemaChanged ? "e".repeat(64) : FINGERPRINT,
    ),
  );
  h.adopt(release(NEXT, OLD_IMAGE));
  await h.service.build(SHA, 12, h.workspace, ROOT_SHA);
  return h;
}
test("candidate Docker health keeps an HTTP-ready replacement behind admission until starting becomes healthy", async (t) => {
  const api = await apiHttpFixture(t);
  let waiting = 0;
  let h;
  h = await deployHarness(t, {
    base: api.base,
    actualReadiness: true,
    onStart: (current) => {
      api.state.commit = current.Config.Labels["com.agent-platform.api-sha"];
      current.State.Health.Status = "starting";
    },
    onSleep: async (ms, current) => {
      if (ms !== 2000) return;
      assert.equal(current.Image, IMAGE);
      assert.equal(current.State.Health.Status, "starting");
      assert.ok(await fs.stat(h.drain));
      assert.ok(api.requests.some((r) => r.path === "/api/health"));
      assert.ok(api.requests.some((r) => r.path === "/api/deployment/status"));
      if (++waiting === 2) current.State.Health.Status = "healthy";
    },
  });
  const result = await h.service.deploy(SHA, 12);
  assert.equal(waiting, 2);
  assert.equal(result.state, "deployed");
  assert.equal(h.current.State.Health.Status, "healthy");
  await assert.rejects(fs.stat(h.drain), { code: "ENOENT" });
  const report = await h.service.monitor(join(h.workspace, "health-report"));
  assert.equal(report.healthy, true);
});
test("candidate Docker health failure rolls back rather than publishing an HTTP-ready unhealthy replacement", async (t) => {
  const api = await apiHttpFixture(t);
  let waiting = 0;
  const h = await deployHarness(t, {
    base: api.base,
    actualReadiness: true,
    onStart: (current) => {
      api.state.commit = current.Config.Labels["com.agent-platform.api-sha"];
      current.State.Health.Status =
        current.Image === IMAGE ? "starting" : "healthy";
    },
    onSleep: async (ms, current) => {
      if (ms !== 2000 || current.Image !== IMAGE) return;
      waiting++;
      current.State.Health.Status = "unhealthy";
    },
  });
  const result = await h.service.deploy(SHA, 12);
  assert.equal(waiting, 1);
  assert.equal(result.state, "rolled-back");
  assert.equal(h.current.Image, OLD_IMAGE);
  assert.equal(h.current.State.Health.Status, "healthy");
  assert.equal(
    JSON.parse(await privateFile(join(h.root, "runtime-state.json"))).state,
    "rolled-back",
  );
  await assert.rejects(fs.stat(h.drain), { code: "ENOENT" });
});
test("Docker health timeout never releases admission or declares the HTTP-ready replacement deployed", async (t) => {
  const api = await apiHttpFixture(t);
  let waiting = 0;
  let h;
  h = await deployHarness(t, {
    base: api.base,
    actualReadiness: true,
    onStart: (current) => {
      api.state.commit = current.Config.Labels["com.agent-platform.api-sha"];
      current.State.Health.Status =
        current.Image === IMAGE ? "starting" : "healthy";
    },
    onSleep: async (ms, current) => {
      if (ms !== 2000 || current.Image !== IMAGE) return;
      waiting++;
      assert.ok(await fs.stat(h.drain));
    },
  });
  assert.equal((await h.service.deploy(SHA, 12)).state, "rolled-back");
  assert.equal(waiting, 90);
  assert.equal(h.current.Image, OLD_IMAGE);
  await assert.rejects(fs.stat(h.drain), { code: "ENOENT" });
});
test("replacement identity changes during Docker health waiting retain admission and the recovery checkpoint", async (t) => {
  const api = await apiHttpFixture(t);
  let h;
  h = await deployHarness(t, {
    base: api.base,
    actualReadiness: true,
    onStart: (current) => {
      current.State.Health.Status = "starting";
    },
    onSleep: async (ms, current) => {
      if (ms !== 2000) return;
      current.Id = "operator-replacement-during-health";
      current.State.Health.Status = "healthy";
    },
  });
  await assert.rejects(h.service.deploy(SHA, 12), /checkpoint retained/);
  assert.equal(h.current.Id, "operator-replacement-during-health");
  assert.ok(await fs.stat(h.drain));
  assert.equal(
    JSON.parse(
      await privateFile(join(h.root, "deployment.lock/checkpoint.json")),
    ).state,
    "operator-recovery-required",
  );
  assert.equal(h.calls.filter((call) => call.args[2] === "rm").length, 1);
});
test("schema changes and real auth activity do not create maintenance or stop any API", async (t) => {
  for (const configuration of [
    { schemaChanged: true },
    { status: () => ({ ...quietStatus, credentialAuth: 1 }) },
  ]) {
    const h = await deployHarness(t, configuration),
      result = await h.service.deploy(SHA, 12);
    assert.ok(
      ["waiting-migration-review", "waiting-idle"].includes(result.state),
    );
    assert.ok(!h.calls.some((call) => call.args[2] === "stop"));
    await assert.rejects(fs.stat(h.drain), { code: "ENOENT" });
  }
});
test("manual maintenance is preserved; no backup, stop or replacement occurs", async (t) => {
  const h = await deployHarness(t);
  await write(h.drain, "operator maintenance");
  await assert.rejects(h.service.deploy(SHA, 12));
  assert.equal(await fs.readFile(h.drain, "utf8"), "operator maintenance");
  assert.ok(!h.calls.some((call) => call.args[2] === "stop"));
});
test("successful drain samples every quiet second, backs up, starts behind barrier and publishes both commits", async (t) => {
  let statusCalls = 0;
  const h = await deployHarness(t, {
    status: () => {
      statusCalls++;
      return quietStatus;
    },
  });
  const result = await h.service.deploy(SHA, 12);
  assert.equal(result.state, "deployed");
  assert.equal(result.rootSha, ROOT_SHA);
  assert.equal(result.imageId, IMAGE);
  assert.ok(statusCalls >= 12);
  assert.ok(
    h.calls.find((call) =>
      call.args.at(-1).includes?.("tar --exclude=./deployment-drain"),
    ),
  );
  await assert.rejects(fs.stat(h.drain), { code: "ENOENT" });
  await assert.rejects(fs.stat(join(h.root, "deployment.lock")), {
    code: "ENOENT",
  });
});
test("failed replacement restores original image behind the owned barrier; ambiguous stop preserves checkpoint", async (t) => {
  const h = await deployHarness(t, { failNewReadiness: true });
  const result = await h.service.deploy(SHA, 12);
  assert.equal(result.state, "rolled-back");
  assert.equal(h.current.Image, OLD_IMAGE);
  await assert.rejects(fs.stat(h.drain), { code: "ENOENT" });
  const ambiguous = await deployHarness(t, { stopFailure: true });
  await assert.rejects(
    ambiguous.service.deploy(SHA, 12),
    /checkpoint retained/,
  );
  const checkpoint = JSON.parse(
    await privateFile(join(ambiguous.root, "deployment.lock/checkpoint.json")),
  );
  assert.equal(checkpoint.state, "operator-recovery-required");
  assert.ok(await fs.stat(ambiguous.drain));
  await assert.rejects(
    ambiguous.service.build(SHA, 13, ambiguous.workspace, ROOT_SHA),
    /lock exists/,
  );
});
test("mounted runtime secret mismatch rejects before any maintenance or service mutation", async (t) => {
  const h = await deployHarness(t, { secretMismatch: true });
  await assert.rejects(h.service.deploy(SHA, 12), /secret volume differs/);
  assert.ok(
    !h.calls.some((call) => ["exec", "stop", "rm"].includes(call.args[2])),
  );
  await assert.rejects(fs.stat(h.drain), { code: "ENOENT" });
});
test("a real-work arrival during quiet withdraws only owned admission and never stops the API", async (t) => {
  let samples = 0;
  const h = await deployHarness(t, {
    status: () =>
      ++samples > 4
        ? {
            ...quietStatus,
            blockers: { ...quietStatus.blockers, agentTasks: 1 },
          }
        : quietStatus,
  });
  const result = await h.service.deploy(SHA, 12);
  assert.equal(result.state, "waiting-idle");
  assert.ok(!h.calls.some((call) => call.args[2] === "stop"));
  await assert.rejects(fs.stat(h.drain), { code: "ENOENT" });
});
test("unknown replacement container after stop retains the barrier and checkpoint without removing it or starting a duplicate", async (t) => {
  const h = await deployHarness(t, {
    onStop: (current) => {
      current.Id = "unknown-operator-replacement";
    },
  });
  await assert.rejects(h.service.deploy(SHA, 12), /checkpoint retained/);
  assert.equal(h.current.Id, "unknown-operator-replacement");
  assert.ok(await fs.stat(h.drain));
  assert.ok(
    !h.calls.some(
      (call) =>
        call.args[2] === "rm" ||
        (call.args[2] === "run" && call.args.includes("-d")),
    ),
  );
  assert.equal(
    JSON.parse(
      await privateFile(join(h.root, "deployment.lock/checkpoint.json")),
    ).state,
    "operator-recovery-required",
  );
});
test("changed approved ROOT head produces no build receipt or service mutation", async (t) => {
  const h = await harness(t, { heads: () => ({ sha: SHA, rootSha: NEXT }) });
  await assert.rejects(
    h.service.build(SHA, 12, h.workspace, ROOT_SHA),
    /approved branch heads/,
  );
  assert.equal(h.built, 0);
  assert.deepEqual(await fs.readdir(join(h.root, "jenkins-receipts")), []);
});
test("an operator-created empty release directory is never overwritten during publish", async (t) => {
  let calls = 0,
    h;
  h = await harness(t, {
    heads: async () => {
      if (++calls === 2)
        await fs.mkdir(join(h.root, "releases", releaseKey(SHA, ROOT_SHA)), {
          mode: 0o700,
        });
      return { sha: SHA, rootSha: ROOT_SHA };
    },
  });
  await assert.rejects(h.service.build(SHA, 12, h.workspace, ROOT_SHA), {
    code: "EEXIST",
  });
  assert.deepEqual(
    await fs.readdir(join(h.root, "releases", releaseKey(SHA, ROOT_SHA))),
    [],
  );
  assert.deepEqual(await fs.readdir(join(h.root, "jenkins-receipts")), []);
});
async function preparedAdoption(t, configuration = {}) {
  const h = await harness(t, configuration);
  await h.service.build(SHA, 12, h.workspace, ROOT_SHA);
  const permit = {
    state: "native-stopped-data-imported",
    sha: SHA,
    rootSha: ROOT_SHA,
    imageId: IMAGE,
    volume: "agent-platform-production-data",
    dataManifestSha256: "e".repeat(64),
    previousNativeApiStopped: true,
    previousDedicatedTunnelStopped: true,
  };
  await immutableJson(join(h.root, "native-migration-ready.json"), permit);
  return h;
}
test("normal deployment waits for explicit initial adoption; approved private import permit produces a real adopted container and consumed history", async (t) => {
  const h = await preparedAdoption(t);
  assert.equal(
    (await h.service.deploy(SHA, 12)).state,
    "waiting-initial-adoption",
  );
  assert.ok(
    !h.calls.some((call) => call.args[2] === "run" && call.args.includes("-d")),
  );
  const adopted = await h.service.adopt(SHA, 12);
  assert.equal(adopted.state, "initial-adopted");
  assert.equal(adopted.rootSha, ROOT_SHA);
  assert.equal(h.current.Image, IMAGE);
  const permit = JSON.parse(
    await privateFile(join(h.root, "native-migration-ready.json")),
  );
  assert.equal(permit.state, "adopted");
  assert.equal(permit.dataManifestSha256, "e".repeat(64));
  assert.equal((await h.service.deploy(SHA, 12)).state, "current");
  await assert.rejects(
    h.service.adopt(SHA, 12),
    /native-stop\/data-import permit/,
  );
  await assert.rejects(fs.stat(h.drain), { code: "ENOENT" });
});
test("initial adoption refuses live work, existing API and mismatched or unowned migration permit without starting a service", async (t) => {
  for (const scenario of ["probe", "existing", "permit", "unsafe-mode"]) {
    const h = await preparedAdoption(t, {
      migrationProbeFail: scenario === "probe",
    });
    if (scenario === "existing") h.adopt(release());
    if (scenario === "permit")
      await write(
        join(h.root, "native-migration-ready.json"),
        JSON.stringify({
          state: "native-stopped-data-imported",
          sha: SHA,
          rootSha: NEXT,
        }),
      );
    if (scenario === "unsafe-mode")
      await fs.chmod(join(h.root, "native-migration-ready.json"), 0o644);
    await assert.rejects(h.service.adopt(SHA, 12));
    assert.ok(
      !h.calls.some(
        (call) => call.args[2] === "run" && call.args.includes("-d"),
      ),
      scenario,
    );
    await assert.rejects(fs.stat(h.drain), { code: "ENOENT" });
  }
});
test("initial readiness failure preserves container, migration permit, exact barrier and checkpoint for recovery", async (t) => {
  const h = await preparedAdoption(t, { failNewReadiness: true });
  await assert.rejects(h.service.adopt(SHA, 12), /new readiness failed/);
  assert.equal(h.current.Image, IMAGE);
  assert.ok(await fs.stat(h.drain));
  assert.equal(
    JSON.parse(
      await privateFile(join(h.root, "deployment.lock/checkpoint.json")),
    ).state,
    "operator-recovery-required",
  );
  assert.equal(
    JSON.parse(await privateFile(join(h.root, "native-migration-ready.json")))
      .state,
    "native-stopped-data-imported",
  );
  assert.ok(!h.calls.some((call) => ["rm", "stop"].includes(call.args[2])));
});
test("actual SQLite migration probe validates integrity, zero blockers and translated baseline while leaving source bytes unchanged", async (t) => {
  const root = await temp(t),
    data = join(root, "data"),
    baseline = join(data, "projects/baseline");
  await fs.mkdir(baseline, { recursive: true });
  const database = join(data, "platform.db"),
    db = new DatabaseSync(database);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE sandboxes(status TEXT); CREATE TABLE agent_tasks(status TEXT); CREATE TABLE automation_runs(status TEXT); CREATE TABLE automations(enabled INTEGER); CREATE TABLE resource_allocations(released_at INTEGER); CREATE TABLE projects(clone_status TEXT,baseline_path TEXT); CREATE TABLE sandbox_project_cleanup_jobs(id TEXT);",
  );
  db.prepare("INSERT INTO projects VALUES ('ready',?)").run(baseline);
  db.close();
  const before = await digest(database);
  const probe = (copy) =>
    MIGRATION_DATA_PROBE.replaceAll("/data", data).replace(
      "/tmp/migration-verify.db",
      join(root, copy),
    );
  assert.equal(
    (
      await run(process.execPath, ["-e", probe("copy-valid.db")], {
        quiet: true,
      })
    ).trim(),
    "migration-data-probe-passed",
  );
  assert.deepEqual(await digest(database), before);
  const active = new DatabaseSync(database);
  active.exec("INSERT INTO agent_tasks VALUES ('running')");
  active.close();
  await assert.rejects(
    run(process.execPath, ["-e", probe("copy-active.db")], { quiet: true }),
  );
  const invalid = new DatabaseSync(database);
  invalid.exec("DELETE FROM agent_tasks");
  invalid
    .prepare("UPDATE projects SET baseline_path=?")
    .run(join(root, "outside"));
  invalid.close();
  await assert.rejects(
    run(process.execPath, ["-e", probe("copy-bad-path.db")], { quiet: true }),
  );
});
test("monitor creates its private report directory and writes redacted runtime logs; foreign writable and symlink directories are refused", async (t) => {
  const h = await harness(t);
  h.adopt(release());
  const folder = join(h.root, "runtime-report-12");
  const report = await h.service.monitor(folder);
  assert.equal(report.healthy, true);
  assert.equal((await fs.stat(folder)).mode & 0o777, 0o700);
  const logs = await fs.readFile(join(folder, "api.redacted.log"), "utf8");
  assert.match(logs, /public runtime output/);
  assert.ok(
    !logs.includes("fixture-private-passcode") &&
      !logs.includes("fixture-private-cookie") &&
      !logs.includes("fixture-authorization"),
  );
  assert.equal(
    (await fs.stat(join(folder, "api.redacted.log"))).mode & 0o777,
    0o600,
  );
  const dns = report.containers.find((c) => c.name === "agent-platform-dns");
  assert.equal(dns.state, "running");
  assert.equal(dns.health, "healthy");
  const dnsLogs = await fs.readFile(join(folder, "dns.redacted.log"), "utf8");
  assert.match(dnsLogs, /public runtime output/);
  assert.ok(
    !dnsLogs.includes("fixture-private-passcode") &&
      !dnsLogs.includes("fixture-private-cookie") &&
      !dnsLogs.includes("fixture-authorization"),
  );
  assert.equal(
    (await fs.stat(join(folder, "dns.redacted.log"))).mode & 0o777,
    0o600,
  );
  assert.match(
    await fs.readFile(join(folder, "report.html"), "utf8"),
    /href=dns.redacted.log/,
  );
  await assert.rejects(h.service.monitor(folder), { code: "EEXIST" });
  const writable = join(h.root, "unsafe-report");
  await fs.mkdir(writable, { mode: 0o755 });
  await assert.rejects(
    h.service.monitor(writable),
    /Unsafe deployment directory/,
  );
  const linked = join(h.root, "linked-report");
  await fs.symlink(folder, linked);
  await assert.rejects(
    h.service.monitor(linked),
    /Unsafe deployment directory/,
  );
});
test("missing, starting, unhealthy or stopped DNS prevents a ready API and running tunnel from reporting healthy", async (t) => {
  for (const [state, health] of [
    ["missing", null],
    ["running", "starting"],
    ["running", "unhealthy"],
    ["exited", "healthy"],
  ]) {
    const h = await harness(t, {
      dns:
        state === "missing"
          ? null
          : { Status: state, Health: { Status: health } },
    });
    h.adopt(release());
    const folder = join(h.root, "dns-status");
    const report = await h.service.monitor(folder);
    assert.equal(report.deployment.ready, true);
    assert.equal(report.containers[0].state, "running");
    assert.equal(report.containers[0].health, "healthy");
    assert.equal(report.containers[1].state, "running");
    assert.equal(report.healthy, false);
    const dns = report.containers.find((c) => c.name === "agent-platform-dns");
    assert.equal(dns.state, state);
    assert.equal(dns.health ?? null, health);
    const persisted = JSON.parse(
      await privateFile(join(folder, "report.json")),
    );
    assert.equal(persisted.healthy, false);
    assert.match(
      await fs.readFile(join(folder, "report.html"), "utf8"),
      /Unhealthy/,
    );
    if (state === "missing")
      assert.equal(
        await fs.readFile(join(folder, "dns.redacted.log"), "utf8"),
        "",
      );
  }
});
