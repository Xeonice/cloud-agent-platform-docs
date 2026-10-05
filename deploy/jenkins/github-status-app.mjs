import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { pathToFileURL } from "node:url";

export const APP_TOOLS =
  "/Users/douglasdong/.local/share/agent-platform-jenkins-tools";
export const APP_OWNER = "Xeonice";
export const APP_REPOSITORIES = Object.freeze([
  "Xeonice/agent-platform-api",
  "Xeonice/agent-platform-web",
  "Xeonice/cloud-agent-platform-docs",
]);
export const APP_PERMISSIONS = Object.freeze({
  contents: "read",
  pull_requests: "read",
  statuses: "write",
});
export const APP_CONTEXTS = Object.freeze({
  "Xeonice/agent-platform-api": "jenkins/native-ci",
  "Xeonice/agent-platform-web": "jenkins/web-ci",
  "Xeonice/cloud-agent-platform-docs": "jenkins/project-ci",
});
const JOBS = Object.freeze({
  "Xeonice/agent-platform-api": "agent-platform-native-ci",
  "Xeonice/agent-platform-web": "agent-platform-web",
  "Xeonice/cloud-agent-platform-docs": "agent-platform-contract",
});
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const sameOwner = (value) =>
  typeof value === "string" && value.toLowerCase() === APP_OWNER.toLowerCase();
export function validatePermissions(value) {
  if (
    !value ||
    Object.entries(APP_PERMISSIONS).some(
      ([key, permission]) => value[key] !== permission,
    ) ||
    Object.entries(value).some(([key, permission]) =>
      key === "metadata"
        ? permission !== "read"
        : !Object.hasOwn(APP_PERMISSIONS, key),
    )
  )
    throw new Error(
      "GitHub App permissions must match the reviewed minimum exactly",
    );
  return value;
}
export function validateAppConfig(value) {
  if (
    value?.version !== 1 ||
    value.owner !== APP_OWNER ||
    !positive(value.appId) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug ?? "") ||
    (value.installationId != null && !positive(value.installationId)) ||
    JSON.stringify(value.repositories) !== JSON.stringify(APP_REPOSITORIES) ||
    Object.keys(value).some(
      (key) =>
        ![
          "version",
          "owner",
          "appId",
          "slug",
          "installationId",
          "repositories",
          "createdAt",
          "verifiedAt",
        ].includes(key),
    )
  )
    throw new Error("Invalid fixed GitHub status App configuration");
  return value;
}
export function validateApp(value, config) {
  if (
    value?.id !== config.appId ||
    value.slug !== config.slug ||
    !sameOwner(value.owner?.login) ||
    value.html_url !== "https://github.com/apps/" + config.slug
  )
    throw new Error("GitHub returned a different App or owner");
  validatePermissions(value.permissions);
  return value;
}
export function validateInstallation(
  value,
  config,
  id = config.installationId,
) {
  if (
    !positive(value?.id) ||
    value.id !== id ||
    value.app_id !== config.appId ||
    value.app_slug !== config.slug ||
    !sameOwner(value.account?.login) ||
    value.repository_selection !== "selected" ||
    value.suspended_at != null
  )
    throw new Error(
      "GitHub installation is not the selected, active Xeonice status App",
    );
  validatePermissions(value.permissions);
  return value;
}
export async function readAppPrivate(path, uid = 501) {
  const handle = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== uid ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size < 1 ||
      stat.size > 65_536
    )
      throw new Error(
        "GitHub App credentials must be UID501-owned mode0600 regular files",
      );
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
export async function appDirectory(path, uid = 501) {
  const stat = await fs.lstat(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o700 ||
    (await fs.realpath(path)) !== resolve(path)
  )
    throw new Error(
      "GitHub App directory must be owner-only and cannot traverse a symlink",
    );
}
export function appJwt(pem, appId, milliseconds = Date.now()) {
  if (!positive(appId)) throw new Error("Invalid App ID");
  let key;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error("Invalid GitHub App RSA private key");
  }
  if (
    key.asymmetricKeyType !== "rsa" ||
    key.asymmetricKeyDetails.modulusLength < 2048
  )
    throw new Error("GitHub App requires an RSA key of at least 2048 bits");
  const time = Math.floor(milliseconds / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: time - 60, exp: time + 540, iss: String(appId) }),
  ).toString("base64url");
  const body = header + "." + payload;
  return (
    body +
    "." +
    sign("RSA-SHA256", Buffer.from(body), key).toString("base64url")
  );
}
export async function githubAppRequest(
  path,
  credential,
  options = {},
  fetcher = globalThis.fetch,
) {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("..") ||
    /[\u0000-\u0020\u007f\\]/.test(path)
  )
    throw new Error("Unsafe fixed GitHub App endpoint");
  let response;
  try {
    response = await fetcher("https://api.github.com" + path, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(credential ? { Authorization: "Bearer " + credential } : {}),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch {
    throw new Error("GitHub App request could not complete");
  }
  if (!response.ok)
    throw Object.assign(new Error("GitHub App HTTP " + response.status), {
      status: response.status,
    });
  const text = await response.text();
  if (text.length > 2_000_000)
    throw new Error("GitHub App response exceeded its limit");
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error("GitHub App returned invalid JSON");
  }
}
export function validateEffectiveRepositories(value) {
  if (
    value?.total_count !== 3 ||
    !Array.isArray(value.repositories) ||
    value.repositories.length !== 3 ||
    JSON.stringify(value.repositories.map((repo) => repo.full_name).sort()) !==
      JSON.stringify([...APP_REPOSITORIES].sort()) ||
    value.repositories.some(
      (repo) => !positive(repo.id) || !sameOwner(repo.owner?.login),
    )
  )
    throw new Error(
      "Installation token must grant exactly the three reviewed repositories",
    );
  return value.repositories;
}
export async function verifyAppGrant(config, pem, options = {}) {
  const clock = options.clock ?? Date.now;
  const request = (path, token, settings) =>
    githubAppRequest(path, token, settings, options.fetch ?? globalThis.fetch);
  const jwt = appJwt(pem, config.appId, clock());
  validateApp(await request("/app", jwt), config);
  validateInstallation(
    await request("/app/installations/" + config.installationId, jwt),
    config,
  );
  const value = await request(
    "/app/installations/" + config.installationId + "/access_tokens",
    jwt,
    {
      method: "POST",
      body: JSON.stringify({
        repositories: APP_REPOSITORIES.map((repo) => repo.split("/")[1]),
        permissions: APP_PERMISSIONS,
      }),
    },
  );
  validatePermissions(value.permissions);
  const expires = Date.parse(value.expires_at);
  if (
    typeof value.token !== "string" ||
    value.token.length < 20 ||
    value.token.length > 4096 ||
    /[\s\u0000-\u001f]/.test(value.token) ||
    !Number.isFinite(expires) ||
    expires <= clock() + 60_000 ||
    expires > clock() + 3_660_000 ||
    value.repository_selection !== "selected"
  )
    throw new Error("GitHub returned an invalid bounded installation token");
  validateEffectiveRepositories(
    await request("/installation/repositories?per_page=100", value.token),
  );
  // Sensitive return value: internal callers keep this token only in memory.
  return { token: value.token, expires };
}
export function createStatusApp(options = {}) {
  const tools = resolve(options.tools ?? APP_TOOLS),
    uid = options.uid ?? 501,
    clock = options.clock ?? Date.now;
  const fetcher = options.fetch ?? globalThis.fetch;
  const request = (path, token, settings) =>
    githubAppRequest(path, token, settings, fetcher);
  let cached = null,
    renewing = null;
  async function configuration() {
    let text;
    try {
      text = await readAppPrivate(join(tools, "github-status-app.json"), uid);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    await appDirectory(tools, uid);
    let config;
    try {
      config = validateAppConfig(JSON.parse(text));
    } catch {
      throw new Error("Invalid GitHub status App configuration");
    }
    return config;
  }
  async function source() {
    const config = await configuration();
    if (!config || config.installationId == null)
      return {
        kind: "oauth",
        reason: !config
          ? "github-app-not-configured"
          : "github-app-installation-not-verified",
        satisfiesActionsSource: false,
      };
    return {
      kind: "github-app",
      appId: config.appId,
      installationId: config.installationId,
      slug: config.slug,
      verified:
        !!cached &&
        cached.appId === config.appId &&
        cached.installationId === config.installationId &&
        cached.expires > clock() + 60_000,
      satisfiesActionsSource: false,
    };
  }
  async function renew(config, pem, fingerprint) {
    // No unrestricted token is minted to inspect wider user selections.
    cached = {
      ...(await verifyAppGrant(config, pem, { fetch: fetcher, clock })),
      fingerprint,
      appId: config.appId,
      installationId: config.installationId,
    };
    return cached.token;
  }
  async function token() {
    const config = await configuration();
    if (!config?.installationId)
      throw new Error("GitHub status App installation has not been verified");
    const pem = await readAppPrivate(join(tools, "github-status-app.pem"), uid);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(config))
      .update(pem)
      .digest("hex");
    if (
      cached?.fingerprint === fingerprint &&
      cached.expires > clock() + 60_000
    )
      return cached.token;
    if (!renewing)
      renewing = renew(config, pem, fingerprint).finally(() => {
        renewing = null;
      });
    const result = await renewing;
    if (cached.fingerprint !== fingerprint) return token();
    return result;
  }
  return {
    source,
    async postStatus(repo, sha, body) {
      if (
        !APP_REPOSITORIES.includes(repo) ||
        !/^[a-f0-9]{40}$/.test(sha ?? "") ||
        body?.context !== APP_CONTEXTS[repo] ||
        !["pending", "success", "failure", "error"].includes(body.state) ||
        typeof body.description !== "string" ||
        body.description.length > 140 ||
        Object.keys(body).some(
          (key) =>
            !["context", "state", "description", "target_url"].includes(key),
        )
      )
        throw new Error("Unreviewed GitHub status source");
      const target = new URL(body.target_url);
      if (
        target.origin !== "http://127.0.0.1:8080" ||
        target.username ||
        target.password ||
        target.search ||
        target.hash ||
        !(
          target.pathname === "/job/" + JOBS[repo] + "/" ||
          new RegExp("^/job/" + JOBS[repo] + "/[1-9][0-9]*/$").test(
            target.pathname,
          )
        )
      )
        throw new Error("Untrusted Jenkins status target");
      await request("/repos/" + repo + "/statuses/" + sha, await token(), {
        method: "POST",
        body: JSON.stringify(body),
      });
      return source();
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.error(
    "Use setup-github-app.mjs verify; status publishing is owned by Jenkins discovery.",
  );
  process.exitCode = 1;
}
