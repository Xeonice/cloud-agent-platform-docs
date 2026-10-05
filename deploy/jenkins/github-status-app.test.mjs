import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync, verify } from "node:crypto";
import { request as httpRequest } from "node:http";
import {
  APP_REPOSITORIES,
  APP_PERMISSIONS,
  APP_CONTEXTS,
  appJwt,
  createStatusApp,
  validatePermissions,
  readAppPrivate,
} from "./github-status-app.mjs";
import {
  createSetupServer,
  statusAppManifest,
  verifySetup,
} from "./setup-github-app.mjs";
import { createDiscoverer } from "./jenkins-discover.mjs";
import { projectKey, REPOSITORIES } from "./project-release.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const folders = [],
  servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => fs.rm(folder, { force: true, recursive: true })),
  );
});
async function directory() {
  const folder = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "status-app-test-")),
  );
  await fs.chmod(folder, 0o700);
  folders.push(folder);
  return folder;
}
async function json(path, value) {
  await fs.writeFile(path, JSON.stringify(value) + "\n", { mode: 0o600 });
}
const config = () => ({
  version: 1,
  owner: "Xeonice",
  appId: 67,
  slug: "agent-platform-jenkins",
  installationId: 88,
  repositories: [...APP_REPOSITORIES],
});
function statusBody(repo = APP_REPOSITORIES[0]) {
  return {
    state: "success",
    context: APP_CONTEXTS[repo],
    description: "Required Jenkins gates passed",
    target_url:
      "http://127.0.0.1:8080/job/" +
      (repo === APP_REPOSITORIES[0]
        ? "agent-platform-native-ci"
        : repo === APP_REPOSITORIES[1]
          ? "agent-platform-web"
          : "agent-platform-contract") +
      "/12/",
  };
}
function provider(clock) {
  const app = {
    id: 67,
    slug: "agent-platform-jenkins",
    owner: { login: "Xeonice" },
    html_url: "https://github.com/apps/agent-platform-jenkins",
    permissions: { ...APP_PERMISSIONS, metadata: "read" },
  };
  const installation = {
    id: 88,
    app_id: 67,
    app_slug: app.slug,
    account: { login: "Xeonice" },
    repository_selection: "selected",
    suspended_at: null,
    permissions: { ...APP_PERMISSIONS, metadata: "read" },
  };
  const repositories = {
    total_count: 3,
    repositories: APP_REPOSITORIES.map((full_name, i) => ({
      id: i + 1,
      full_name,
      owner: { login: "Xeonice" },
    })),
  };
  const calls = [];
  let issued = 0,
    tokenOverride = {};
  const fetcher = async (url, options) => {
    assert.equal(new URL(url).origin, "https://api.github.com");
    assert.equal(options.redirect, "error");
    calls.push({ path: new URL(url).pathname + new URL(url).search, options });
    const path = new URL(url).pathname + new URL(url).search;
    let data;
    if (path === "/app") data = app;
    else if (path === "/app/installations/88") data = installation;
    else if (path === "/app/installations?per_page=100&page=1")
      data = [installation];
    else if (path === "/app/installations/88/access_tokens") {
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), {
        repositories: APP_REPOSITORIES.map((repo) => repo.split("/")[1]),
        permissions: APP_PERMISSIONS,
      });
      issued++;
      data = {
        token: "ghs_synthetic_status_token_" + issued,
        expires_at: new Date(clock() + 3_600_000).toISOString(),
        permissions: { ...APP_PERMISSIONS, metadata: "read" },
        repository_selection: "selected",
        ...tokenOverride,
      };
    } else if (path === "/installation/repositories?per_page=100")
      data = repositories;
    else if (/^\/repos\/Xeonice\/[a-z-]+\/statuses\/[a-f0-9]{40}$/.test(path))
      data = { state: JSON.parse(options.body).state };
    else if (/^\/app-manifests\/[a-f0-9]{40}\/conversions$/.test(path))
      data = {
        ...app,
        pem,
        client_secret: "synthetic_unused_client_secret",
        webhook_secret: "synthetic_unused_webhook_secret",
      };
    else throw new Error("Unexpected mocked GitHub path");
    return new Response(JSON.stringify(data), { status: 200 });
  };
  return {
    app,
    installation,
    repositories,
    calls,
    fetcher,
    get issued() {
      return issued;
    },
    set tokenOverride(value) {
      tokenOverride = value;
    },
  };
}
async function fixture() {
  const tools = await directory(),
    time = { now: Date.now() },
    clock = () => time.now,
    remote = provider(clock);
  await json(join(tools, "github-status-app.json"), config());
  await fs.writeFile(join(tools, "github-status-app.pem"), pem, {
    mode: 0o600,
  });
  const options = {
    tools,
    uid: process.getuid(),
    clock,
    fetch: remote.fetcher,
  };
  return { tools, time, clock, remote, options, app: createStatusApp(options) };
}
test("actual RSA signature verifies RS256 claims with bounded lifetime and clock-drift allowance", () => {
  const now = 1_800_000_000_000,
    jwt = appJwt(pem, 67, now),
    parts = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(parts[0], "base64url")), {
    alg: "RS256",
    typ: "JWT",
  });
  assert.deepEqual(JSON.parse(Buffer.from(parts[1], "base64url")), {
    iat: now / 1000 - 60,
    exp: now / 1000 + 540,
    iss: "67",
  });
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(parts[0] + "." + parts[1]),
      publicKey,
      Buffer.from(parts[2], "base64url"),
    ),
    true,
  );
});
test("RSA JWT rejects EC/public/weak keys before making any GitHub request", () => {
  const ec = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  }).privateKey.export({ type: "pkcs8", format: "pem" });
  const weak = generateKeyPairSync("rsa", {
    modulusLength: 1024,
  }).privateKey.export({ type: "pkcs8", format: "pem" });
  for (const key of [
    ec,
    weak,
    publicKey.export({ type: "spki", format: "pem" }),
    "invalid",
  ])
    assert.throws(() => appJwt(key, 67));
});
test("real private-file guards refuse wrong owner, public mode, symlinks and oversized keys", async () => {
  const tools = await directory(),
    path = join(tools, "key");
  await fs.writeFile(path, pem, { mode: 0o600 });
  assert.equal(await readAppPrivate(path, process.getuid()), pem);
  await assert.rejects(readAppPrivate(path, process.getuid() + 1), /UID501/);
  await fs.chmod(path, 0o640);
  await assert.rejects(readAppPrivate(path, process.getuid()), /mode0600/);
  await fs.chmod(path, 0o600);
  await fs.symlink(path, join(tools, "link"));
  await assert.rejects(readAppPrivate(join(tools, "link"), process.getuid()));
  await fs.writeFile(path, "x".repeat(70_000));
  await assert.rejects(readAppPrivate(path, process.getuid()), /mode0600/);
});
test("actual App/installation identity and permissions are checked before issuing narrowly scoped memory-only token", async () => {
  const f = await fixture();
  await f.app.postStatus(APP_REPOSITORIES[0], "a".repeat(40), statusBody());
  assert.deepEqual(
    f.remote.calls.map((call) => call.path),
    [
      "/app",
      "/app/installations/88",
      "/app/installations/88/access_tokens",
      "/installation/repositories?per_page=100",
      "/repos/Xeonice/agent-platform-api/statuses/" + "a".repeat(40),
    ],
  );
  const jwt = f.remote.calls[0].options.headers.Authorization.slice(7),
    parts = jwt.split(".");
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(parts[0] + "." + parts[1]),
      publicKey,
      Buffer.from(parts[2], "base64url"),
    ),
    true,
  );
  assert.equal(
    f.remote.calls
      .at(-1)
      .options.headers.Authorization.startsWith("Bearer ghs_synthetic_"),
    true,
  );
  assert.deepEqual(await fs.readdir(f.tools), [
    "github-status-app.json",
    "github-status-app.pem",
  ]);
  assert.equal(
    (
      await fs.readFile(join(f.tools, "github-status-app.json"), "utf8")
    ).includes("ghs_"),
    false,
  );
  const source = await f.app.source();
  assert.equal(source.verified, true);
  assert.equal(source.appId, 67);
  assert.equal(source.satisfiesActionsSource, false);
});
test("installation token is reused only in memory and renewed before expiry", async () => {
  const f = await fixture();
  await f.app.postStatus(APP_REPOSITORIES[0], "a".repeat(40), statusBody());
  await f.app.postStatus(
    APP_REPOSITORIES[1],
    "b".repeat(40),
    statusBody(APP_REPOSITORIES[1]),
  );
  assert.equal(f.remote.issued, 1);
  f.time.now += 3_550_000;
  await f.app.postStatus(
    APP_REPOSITORIES[2],
    "c".repeat(40),
    statusBody(APP_REPOSITORIES[2]),
  );
  assert.equal(f.remote.issued, 2);
});
test("concurrent statuses share one token renewal rather than issuing excess tokens", async () => {
  const f = await fixture();
  await Promise.all(
    APP_REPOSITORIES.map((repo) =>
      f.app.postStatus(repo, "a".repeat(40), statusBody(repo)),
    ),
  );
  assert.equal(f.remote.issued, 1);
  assert.equal(
    f.remote.calls.filter((call) => call.path.includes("/statuses/")).length,
    3,
  );
});
test("wrong App owner/id or elevated App permissions never reach token issuance or status publication", async () => {
  for (const mutation of [
    (app) => {
      app.owner.login = "other";
    },
    (app) => {
      app.id = 68;
    },
    (app) => {
      app.permissions.administration = "write";
    },
    (app) => {
      app.permissions.contents = "write";
    },
  ]) {
    const f = await fixture();
    mutation(f.remote.app);
    await assert.rejects(
      f.app.postStatus(APP_REPOSITORIES[0], "a".repeat(40), statusBody()),
    );
    assert.equal(f.remote.issued, 0);
    assert.equal(
      f.remote.calls.some((call) => call.path.includes("/statuses/")),
      false,
    );
  }
});
test("all-repository, foreign, suspended or overprivileged installations are rejected", async () => {
  for (const mutation of [
    (value) => {
      value.repository_selection = "all";
    },
    (value) => {
      value.account.login = "other";
    },
    (value) => {
      value.app_id = 68;
    },
    (value) => {
      value.suspended_at = "2026-10-06T00:00:00Z";
    },
    (value) => {
      value.permissions.checks = "write";
    },
  ]) {
    const f = await fixture();
    mutation(f.remote.installation);
    await assert.rejects(
      f.app.postStatus(APP_REPOSITORIES[0], "a".repeat(40), statusBody()),
    );
    assert.equal(f.remote.issued, 0);
  }
});
test("unexpected token scopes, expiry or effective repository set cannot publish a status", async () => {
  for (const replacement of [
    { permissions: { ...APP_PERMISSIONS, contents: "write" } },
    { expires_at: new Date(0).toISOString() },
    { repository_selection: "all" },
  ]) {
    const f = await fixture();
    f.remote.tokenOverride = replacement;
    await assert.rejects(
      f.app.postStatus(APP_REPOSITORIES[0], "a".repeat(40), statusBody()),
    );
    assert.equal(
      f.remote.calls.some((call) => call.path.includes("/statuses/")),
      false,
    );
  }
  const f = await fixture();
  f.remote.repositories.repositories[2].full_name = "Xeonice/unreviewed";
  await assert.rejects(
    f.app.postStatus(APP_REPOSITORIES[0], "a".repeat(40), statusBody()),
    /three reviewed/,
  );
  assert.equal(
    f.remote.calls.some((call) => call.path.includes("/statuses/")),
    false,
  );
});
test("status helper cannot send credentials to arbitrary repositories, contexts or Jenkins targets", async () => {
  const f = await fixture();
  for (const [repo, body] of [
    ["evil/repository", statusBody()],
    [APP_REPOSITORIES[0], { ...statusBody(), context: "build-test" }],
    [
      APP_REPOSITORIES[0],
      { ...statusBody(), target_url: "https://evil.invalid/" },
    ],
  ])
    await assert.rejects(f.app.postStatus(repo, "a".repeat(40), body));
  assert.equal(f.remote.calls.length, 0);
});
test("missing installation reports honest OAuth fallback; invalid config fails closed", async () => {
  const tools = await directory(),
    app = createStatusApp({ tools, uid: process.getuid() });
  assert.deepEqual(await app.source(), {
    kind: "oauth",
    reason: "github-app-not-configured",
    satisfiesActionsSource: false,
  });
  await json(join(tools, "github-status-app.json"), {
    ...config(),
    installationId: null,
  });
  assert.equal(
    (await app.source()).reason,
    "github-app-installation-not-verified",
  );
  await json(join(tools, "github-status-app.json"), {
    ...config(),
    owner: "other",
  });
  await assert.rejects(app.source(), /configuration/);
});
test("minimum registration manifest is private with disabled events/webhooks and no administrative grants", () => {
  const manifest = statusAppManifest();
  assert.equal(manifest.public, false);
  assert.equal(manifest.redirect_url, "http://127.0.0.1:8033/callback");
  assert.equal(manifest.hook_attributes.active, false);
  assert.deepEqual(manifest.default_events, []);
  assert.deepEqual(manifest.default_permissions, APP_PERMISSIONS);
  assert.equal(manifest.request_oauth_on_install, false);
  for (const forbidden of ["administration", "checks", "actions", "packages"])
    assert.equal(manifest.default_permissions[forbidden], undefined);
  assert.throws(() =>
    validatePermissions({ ...APP_PERMISSIONS, issues: "read" }),
  );
});
async function setupFixture() {
  const tools = await directory(),
    time = { now: Date.now() },
    clock = () => time.now,
    remote = provider(clock);
  const failures = [];
  const setup = await createSetupServer({
    tools,
    uid: process.getuid(),
    fetch: remote.fetcher,
    clock,
    port: 0,
    keepOpen: true,
    onFailure: (error) => failures.push(error.message),
  });
  servers.push(setup);
  const html = await (await fetch(setup.url)).text(),
    state = /\?state=([A-Za-z0-9_-]{43})/.exec(html)[1],
    code = "a".repeat(40);
  return {
    tools,
    time,
    clock,
    remote,
    setup,
    state,
    code,
    failures,
    callback: setup.url + "callback?code=" + code + "&state=" + state,
  };
}
test("actual loopback callback validates state/duplicates/code before conversion and consumes a valid callback once", async () => {
  const f = await setupFixture();
  for (const url of [
    f.callback.replace(f.state, "b".repeat(43)),
    f.callback + "&state=" + f.state,
    f.callback.replace(f.code, "../other"),
    f.callback + "&unexpected=1",
  ])
    assert.equal((await fetch(url)).status, 400);
  assert.equal(f.remote.calls.length, 0);
  const response = await fetch(f.callback);
  assert.equal(response.status, 200, f.failures.join("; "));
  const html = await response.text();
  assert.equal(html.includes("Only select repositories"), true);
  assert.equal(html.includes("PRIVATE KEY"), false);
  assert.equal(html.includes("synthetic_unused"), false);
  assert.equal((await fetch(f.callback)).status, 410);
  assert.equal(
    f.remote.calls.filter((call) => call.path.includes("/conversions")).length,
    1,
  );
  assert.equal(
    (await fs.stat(join(f.tools, "github-status-app.pem"))).mode & 0o777,
    0o600,
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(join(f.tools, "github-status-app.json"), "utf8"),
    ).installationId,
    null,
  );
});
test("concurrent real callbacks cannot exchange the one-time code twice", async () => {
  const f = await setupFixture();
  const responses = await Promise.all([fetch(f.callback), fetch(f.callback)]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 410],
  );
  assert.equal(
    f.remote.calls.filter((call) => call.path.includes("/conversions")).length,
    1,
  );
});
test("expired registration and wrong Host never call GitHub", async () => {
  const f = await setupFixture(),
    target = new URL(f.setup.url);
  const result = await new Promise((accept, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: target.port,
        path: "/",
        headers: { Host: "evil.invalid" },
      },
      (response) => {
        response.resume();
        response.on("end", () => accept(response.statusCode));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(result, 403);
  f.time.now += 900_000;
  assert.equal((await fetch(f.callback)).status, 410);
  assert.equal(f.remote.calls.length, 0);
});
test("manifest exchange verifies actual App identity before saving secrets and does not expose provider secrets on failure", async () => {
  const f = await setupFixture();
  f.remote.app.owner.login = "other";
  const response = await fetch(f.callback);
  assert.equal(response.status, 502);
  const html = await response.text();
  assert.equal(html.includes("synthetic"), false);
  assert.equal(html.includes("PRIVATE KEY"), false);
  assert.deepEqual(await fs.readdir(f.tools), []);
  assert.equal((await fetch(f.callback)).status, 410);
});
test("verify matches selected installation, checks effective three-repo grant and persists only nonsecret identity", async () => {
  const f = await fixture();
  await json(join(f.tools, "github-status-app.json"), {
    ...config(),
    installationId: null,
  });
  const result = await verifySetup(f.options);
  assert.equal(result.installationId, 88);
  assert.equal(result.branchProtectionChanged, false);
  assert.equal(result.effectiveTokenRepositories, 3);
  assert.equal(JSON.stringify(result).includes("ghs_"), false);
  const saved = JSON.parse(
    await fs.readFile(join(f.tools, "github-status-app.json"), "utf8"),
  );
  assert.equal(saved.installationId, 88);
  assert.equal(saved.token, undefined);
  assert.equal(saved.pem, undefined);
});
test("verify rejects all-repo or missing repo grants without saving an installation ID", async () => {
  const f = await fixture();
  await json(join(f.tools, "github-status-app.json"), {
    ...config(),
    installationId: null,
  });
  f.remote.installation.repository_selection = "all";
  await assert.rejects(verifySetup(f.options));
  assert.equal(
    JSON.parse(
      await fs.readFile(join(f.tools, "github-status-app.json"), "utf8"),
    ).installationId,
    null,
  );
});
test("existing private App configuration/key cannot be replaced by another registration server", async () => {
  const f = await fixture();
  await assert.rejects(
    createSetupServer({ ...f.options, port: 0 }),
    /preserved/,
  );
  assert.equal(
    await fs.readFile(join(f.tools, "github-status-app.pem"), "utf8"),
    pem,
  );
});
async function discoveryOptions(tools) {
  const root = await directory(),
    commits = {
      project: "a".repeat(40),
      api: "b".repeat(40),
      web: "c".repeat(40),
    };
  await json(join(root, "project-release-current.json"), {
    state: "published",
    key: projectKey(commits),
    commits,
  });
  const queued = [];
  return {
    tools,
    deployRoot: root,
    refs: async (spec, repo) => [
      { ref: "refs/heads/" + spec.branch, sha: commits[repo] },
      ...(repo === "api" ? [{ ref: "refs/heads/main", sha: commits.api }] : []),
    ],
    pulls: async () => [],
    jenkins: {
      get: async (path) =>
        path === "queue/api/json" ? { items: [] } : { builds: [] },
      queue: async (job, params) => {
        queued.push({ job, params });
        return "http://127.0.0.1:8080/queue/item/1/";
      },
    },
    changedImage: async () => false,
    queued,
  };
}
test("real discovery uses App for statuses while keeping App JWT/token away from OAuth branch queries", async () => {
  const f = await fixture(),
    opts = await discoveryOptions(f.tools),
    appCalls = f.remote.calls;
  await fs.writeFile(
    join(f.tools, "github-token"),
    "synthetic_oauth_branch_token",
    { mode: 0o600 },
  );
  let branchReads = 0;
  const result = await createDiscoverer({
    ...opts,
    pulls: undefined,
    statusApp: f.app,
    fetch: async (url, options) => {
      assert.equal(new URL(url).pathname.endsWith("/pulls"), true);
      assert.equal(
        options.headers.Authorization,
        "Bearer synthetic_oauth_branch_token",
      );
      branchReads++;
      return new Response("[]", { status: 200 });
    },
  })();
  assert.equal(result.githubStatusSource.kind, "github-app");
  assert.equal(result.githubStatusSource.verified, true);
  assert.equal(result.pendingStatuses, 0);
  assert.equal(
    appCalls.filter((call) => call.path.includes("/statuses/")).length,
    1,
  );
  assert.equal(opts.queued.length, 1);
  assert.equal(branchReads, 3);
});
test("real discovery without App retains OAuth statuses and explicitly reports unsatisfied Actions source", async () => {
  const tools = await directory(),
    opts = await discoveryOptions(tools);
  await fs.writeFile(join(tools, "github-token"), "synthetic_oauth_token", {
    mode: 0o600,
  });
  let writes = 0;
  const result = await createDiscoverer({
    ...opts,
    fetch: async (url, options) => {
      assert.equal(
        url,
        "https://api.github.com/repos/" +
          REPOSITORIES.api.name +
          "/statuses/" +
          "b".repeat(40),
      );
      assert.equal(
        options.headers.Authorization,
        "Bearer synthetic_oauth_token",
      );
      writes++;
      return new Response(JSON.stringify({ state: "pending" }), {
        status: 201,
      });
    },
  })();
  assert.equal(writes, 1);
  assert.deepEqual(result.githubStatusSource, {
    kind: "oauth",
    reason: "github-app-not-configured",
    satisfiesActionsSource: false,
  });
});
