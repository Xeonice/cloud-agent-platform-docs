import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  APP_TOOLS,
  APP_OWNER,
  APP_REPOSITORIES,
  APP_PERMISSIONS,
  appDirectory,
  appJwt,
  readAppPrivate,
  githubAppRequest,
  validateAppConfig,
  validateApp,
  validateInstallation,
  verifyAppGrant,
} from "./github-status-app.mjs";

export const SETUP_PORT = 8033;
const CONFIG = "github-status-app.json",
  KEY = "github-status-app.pem";
export function statusAppManifest(base = "http://127.0.0.1:" + SETUP_PORT) {
  return {
    name: "Xeonice Agent Platform Jenkins",
    url: "https://github.com/Xeonice/cloud-agent-platform-docs",
    description:
      "Private Jenkins verification source for the three Agent Platform repositories.",
    public: false,
    redirect_url: base + "/callback",
    hook_attributes: {
      url: "https://agent-api.douglasdong.com/jenkins/github-status-unused",
      active: false,
    },
    request_oauth_on_install: false,
    default_permissions: { ...APP_PERMISSIONS },
    default_events: [],
  };
}
function escape(value) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}
function installUrl(config) {
  return "https://github.com/apps/" + config.slug + "/installations/new";
}
function equalState(actual, expected) {
  if (
    typeof actual !== "string" ||
    actual.length !== expected.length ||
    !/^[A-Za-z0-9_-]{43}$/.test(actual)
  )
    return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
async function absent(path) {
  if (
    await fs.lstat(path).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    })
  )
    throw new Error(
      "Existing App credentials are preserved; use verify instead of registering again",
    );
}
async function saveNew(tools, config, pem) {
  await absent(join(tools, CONFIG));
  await absent(join(tools, KEY));
  const pending = join(tools, ".github-status-app-" + randomUUID() + ".json");
  await fs.writeFile(pending, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  try {
    await fs.writeFile(join(tools, KEY), pem, { mode: 0o600, flag: "wx" });
    // Link publishes the prepared configuration without replacing an existing
    // config. If it fails, the private pending config/key are retained for review.
    await fs.link(pending, join(tools, CONFIG));
    await fs.unlink(pending);
  } catch {
    throw new Error(
      "App registration could not be fully saved; private pending files require local review",
    );
  }
}
export async function createSetupServer(options = {}) {
  const tools = resolve(options.tools ?? APP_TOOLS),
    uid = options.uid ?? 501;
  const fetcher = options.fetch ?? globalThis.fetch,
    clock = options.clock ?? Date.now;
  await appDirectory(tools, uid);
  await absent(join(tools, CONFIG));
  await absent(join(tools, KEY));
  const state = randomBytes(32).toString("base64url"),
    started = clock(),
    lifetime = options.lifetimeMs ?? 900_000;
  let used = false,
    succeeded = false,
    port;
  const server = createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    const send = (status, html) => {
      res.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; form-action https://github.com; frame-ancestors 'none'; base-uri 'none'",
      });
      res.end(html);
    };
    if (
      req.socket.remoteAddress !== "127.0.0.1" ||
      req.headers.host !== "127.0.0.1:" + port
    )
      return send(403, "Loopback host required.");
    if (
      req.method !== "GET" ||
      typeof req.url !== "string" ||
      !req.url.startsWith("/") ||
      req.url.length > 4096
    )
      return send(405, "GET only.");
    if (clock() >= started + lifetime)
      return send(410, "This registration session expired.");
    const url = new URL(req.url, "http://127.0.0.1:" + port);
    if (url.pathname === "/") {
      if (used || url.search)
        return send(410, "This one-time registration session was consumed.");
      const manifest = statusAppManifest("http://127.0.0.1:" + port);
      return send(
        200,
        '<!doctype html><meta charset="utf-8"><title>Register Agent Platform Jenkins</title><h1>Register the private Jenkins status App</h1><p>Sign in as Xeonice. The App has Contents read, Pull requests read and Commit statuses write. Webhooks are disabled.</p><form method="post" action="https://github.com/settings/apps/new?state=' +
          state +
          '"><input type="hidden" name="manifest" value="' +
          escape(JSON.stringify(manifest)) +
          '"><button type="submit">Review and create on GitHub</button></form>',
      );
    }
    if (url.pathname !== "/callback") return send(404, "Not found.");
    if (used) return send(410, "This callback has already been consumed.");
    if (
      url.searchParams.getAll("state").length !== 1 ||
      url.searchParams.getAll("code").length !== 1 ||
      [...url.searchParams.keys()].some(
        (key) => !["code", "state"].includes(key),
      ) ||
      !equalState(url.searchParams.get("state"), state) ||
      !/^[a-f0-9]{40}$/.test(url.searchParams.get("code") ?? "")
    )
      return send(400, "Invalid registration callback.");
    used = true; // Consume before any await: concurrent callbacks cannot exchange twice.
    try {
      const value = await githubAppRequest(
        "/app-manifests/" + url.searchParams.get("code") + "/conversions",
        null,
        { method: "POST" },
        fetcher,
      );
      const config = validateAppConfig({
        version: 1,
        owner: APP_OWNER,
        appId: value.id,
        slug: value.slug,
        installationId: null,
        repositories: [...APP_REPOSITORIES],
        createdAt: new Date(clock()).toISOString(),
      });
      validateApp(value, config);
      const jwt = appJwt(value.pem, config.appId, clock());
      validateApp(await githubAppRequest("/app", jwt, {}, fetcher), config);
      await saveNew(tools, config, value.pem);
      succeeded = true;
      const installationUrl = installUrl(config);
      send(
        200,
        '<!doctype html><meta charset="utf-8"><title>App saved</title><h1>App registration saved privately</h1><p>Install as Xeonice with Only select repositories. Select exactly agent-platform-api, agent-platform-web and cloud-agent-platform-docs.</p><p><a href="' +
          installationUrl +
          '">Open the GitHub installation page</a></p><p>After installation run setup-github-app.mjs verify. No branch protection has been changed.</p>',
      );
      options.onSaved?.({
        appId: config.appId,
        slug: config.slug,
        installationUrl,
      });
      if (!options.keepOpen) server.close();
    } catch (error) {
      options.onFailure?.(error);
      send(
        502,
        "Registration exchange failed. This callback cannot be replayed; review private local state before starting again.",
      );
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? SETUP_PORT, "127.0.0.1", accept);
  });
  port = server.address().port;
  const timer = setTimeout(() => {
    server.close();
    server.closeAllConnections();
  }, lifetime);
  timer.unref();
  server.on("close", () => clearTimeout(timer));
  return {
    server,
    url: "http://127.0.0.1:" + port + "/",
    close: async () => {
      server.closeAllConnections();
      await new Promise((accept) => server.close(accept));
    },
    get succeeded() {
      return succeeded;
    },
  };
}
export async function verifySetup(options = {}) {
  const tools = resolve(options.tools ?? APP_TOOLS),
    uid = options.uid ?? 501;
  const fetcher = options.fetch ?? globalThis.fetch,
    clock = options.clock ?? Date.now;
  await appDirectory(tools, uid);
  const config = validateAppConfig(
    JSON.parse(await readAppPrivate(join(tools, CONFIG), uid)),
  );
  const pem = await readAppPrivate(join(tools, KEY), uid),
    jwt = appJwt(pem, config.appId, clock());
  validateApp(await githubAppRequest("/app", jwt, {}, fetcher), config);
  const matching = [];
  for (let page = 1; page <= 10; page++) {
    const values = await githubAppRequest(
      "/app/installations?per_page=100&page=" + page,
      jwt,
      {},
      fetcher,
    );
    if (!Array.isArray(values))
      throw new Error("GitHub returned invalid App installations");
    matching.push(
      ...values.filter(
        (value) =>
          value.account?.login?.toLowerCase() === APP_OWNER.toLowerCase(),
      ),
    );
    if (values.length < 100) break;
    if (page === 10)
      throw new Error("App installation list exceeded its bound");
  }
  if (matching.length !== 1)
    throw new Error(
      "Install the App on Xeonice with only the three reviewed repositories, then verify again",
    );
  const installation = validateInstallation(
    matching[0],
    config,
    config.installationId ?? matching[0].id,
  );
  const verified = {
    ...config,
    installationId: installation.id,
    verifiedAt: new Date(clock()).toISOString(),
  };
  await verifyAppGrant(verified, pem, { fetch: fetcher, clock });
  const temporary = join(tools, ".github-status-app-" + randomUUID() + ".json");
  await fs.writeFile(temporary, JSON.stringify(verified, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  await fs.rename(temporary, join(tools, CONFIG));
  return {
    state: "verified",
    appId: config.appId,
    installationId: installation.id,
    owner: APP_OWNER,
    repositories: APP_REPOSITORIES,
    permissions: APP_PERMISSIONS,
    effectiveTokenRepositories: 3,
    branchProtectionChanged: false,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (
      process.getuid() !== 501 ||
      process.geteuid() !== 501 ||
      process.platform !== "darwin" ||
      process.arch !== "arm64" ||
      process.versions.node.split(".")[0] !== "22"
    )
      throw new Error("Use the trusted UID501 native Mac account and Node22");
    if (process.argv[2] === "serve" && process.argv.length === 3) {
      const setup = await createSetupServer({
        onSaved: (result) =>
          console.log(JSON.stringify({ state: "app-saved", ...result })),
        onFailure: () =>
          console.error(
            "GitHub App registration failed; inspect the local callback page and private setup state before retrying",
          ),
      });
      console.log(
        JSON.stringify({
          state: "awaiting-user-registration",
          url: setup.url,
          expiresInMinutes: 15,
          branchProtectionChanged: false,
        }),
      );
    } else if (process.argv[2] === "verify" && process.argv.length === 3)
      console.log(JSON.stringify(await verifySetup(), null, 2));
    else
      throw new Error(
        "Use serve|verify. Registration and installation require the user's GitHub approval.",
      );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
