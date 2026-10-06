import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { userInfo } from "node:os";
import { buildSystem } from "./ci-platform.mjs";
import {
  LINUX_DEPLOY,
  deploymentContext,
  assertDeploymentLayout,
  deploymentEnvironment,
} from "./deployment-platform.mjs";

export const IMAGE_REPOSITORY =
  "https://github.com/Xeonice/agent-platform-api.git";
export const IMAGE_BRANCH = "refs/heads/feat/design-v2-migration";
export const IMAGE_TAG_REF =
  /^refs\/tags\/sandbox-image-v[0-9]+(?:\.[0-9]+){0,2}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
export const DOCKER = "/usr/local/bin/docker";
export const DOCKER_HOST = "unix:///var/run/docker.sock";
export const BUILDER = "agent-platform-runtime";
export const DOCKER_PLUGINS = "/usr/local/lib/docker/cli-plugins";
export const TOOLS = LINUX_DEPLOY.tools;
export const WORKSPACES = join(LINUX_DEPLOY.home, "agent");
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(",");

export function imageRequest(
  sha,
  ref = IMAGE_BRANCH,
  tag = "",
  mode = "check",
) {
  if (
    !SHA.test(sha ?? "") ||
    !(ref === IMAGE_BRANCH || IMAGE_TAG_REF.test(ref)) ||
    !["check", "publish"].includes(mode)
  )
    throw new Error(
      "Only the pinned API production branch or sandbox-image version tags may build images",
    );
  const fromRef = ref.startsWith("refs/tags/")
    ? ref.slice("refs/tags/sandbox-image-".length)
    : "";
  if (
    tag &&
    (tag.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(tag) ||
      tag === "latest")
  )
    throw new Error("Use an immutable OCI version tag, not latest");
  if (fromRef && tag && fromRef !== tag)
    throw new Error("Image tag must match its pinned Git tag");
  return { sha, ref, tag: fromRef || tag, mode };
}

export function imageConfiguration(config) {
  const expected = {
    aio: ["images/platform-sandbox", "agent-platform-sandbox"],
    boxlite: ["images/platform-boxlite", "agent-platform-boxlite"],
  };
  if (
    config?.version !== 1 ||
    config.registry !== "ghcr.io" ||
    config.owner !== "xeonice" ||
    config.defaultTag !== "latest" ||
    config.tagPrefix !== "sandbox-image-" ||
    JSON.stringify(config.platforms) !==
      JSON.stringify(["linux/amd64", "linux/arm64"]) ||
    !Array.isArray(config.images) ||
    config.images.length !== 2
  )
    throw new Error(
      "Sandbox publication configuration differs from the approved two-tier coordinates",
    );
  const seen = new Set();
  for (const item of config.images) {
    if (
      !expected[item.tier] ||
      seen.has(item.tier) ||
      item.context !== expected[item.tier][0] ||
      item.image !== expected[item.tier][1]
    )
      throw new Error(
        "Each sandbox provider must publish its own fixed image/context",
      );
    seen.add(item.tier);
  }
  return config;
}

async function inspectContext(directory) {
  for (const name of await fs.readdir(directory)) {
    if (
      ((name === ".env" || name.startsWith(".env.")) &&
        name !== ".env.example") ||
      [
        ".npmrc",
        "runtime.env",
        "github-token",
        "ghcr-token",
        "cloudflared.token",
      ].includes(name)
    )
      throw new Error(
        "Image build context contains a private configuration path",
      );
    const path = join(directory, name);
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink())
      throw new Error("Image build context cannot contain symlinks");
    if (stat.isDirectory()) await inspectContext(path);
    else if (!stat.isFile())
      throw new Error("Image build context contains a non-source file");
  }
}

export async function imagePlan(source, request) {
  const config = imageConfiguration(
    JSON.parse(
      await fs.readFile(join(source, "config/sandbox-publish.json"), "utf8"),
    ),
  );
  const images = [];
  for (const item of config.images) {
    const context = join(source, item.context);
    if (
      (await fs.realpath(context)) !== context ||
      (await fs.lstat(context)).isSymbolicLink()
    )
      throw new Error("Image context must remain inside its fixed checkout");
    await inspectContext(context);
    const file = join(context, "Dockerfile");
    if (!(await fs.lstat(file)).isFile())
      throw new Error("Image Dockerfile must be a regular source file");
    const dockerfile = await fs.readFile(file, "utf8");
    const version = (name) =>
      new RegExp("^ARG " + name + "=([0-9]+(?:\\.[0-9]+){1,2})\\s*$", "m").exec(
        dockerfile,
      )?.[1];
    const claudeCode = version("CLAUDE_CODE_VERSION");
    const codex = version("CODEX_VERSION");
    if (!claudeCode || !codex)
      throw new Error(
        "Both agent CLI versions must be pinned in each Dockerfile",
      );
    const tag =
      request.tag || `cc${claudeCode}-cx${codex}-g${request.sha.slice(0, 12)}`;
    images.push({
      ...item,
      tag,
      claudeCode,
      codex,
      repository: `${config.registry}/${config.owner}/${item.image}`,
      dockerfileHash: createHash("sha256").update(dockerfile).digest("hex"),
    });
  }
  return {
    version: 1,
    sha: request.sha,
    ref: request.ref,
    mode: request.mode,
    platforms: config.platforms,
    images,
  };
}

export function imageEnvironment(node, dockerConfig, temporary) {
  return {
    ...deploymentEnvironment(node, LINUX_DEPLOY.home, "linux"),
    TMPDIR: temporary,
    DOCKER_HOST,
    DOCKER_CONFIG: dockerConfig,
  };
}

async function execute(
  command,
  args,
  { cwd, env, input, log, signal, timeout = 60_000 } = {},
) {
  signal?.throwIfAborted();
  const handle = log ? await fs.open(log, "a", 0o600) : null;
  let writes = Promise.resolve(),
    writeError;
  try {
    return await new Promise((accept, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        detached: true,
      });
      let output = "",
        overflow = false,
        cancelled = false,
        killTimer;
      const capture = (chunk) => {
        if (output.length + chunk.length < 4_000_000) output += chunk;
        else overflow = true;
        if (handle) {
          writes = writes
            .then(() => handle.write(chunk))
            .catch((error) => {
              writeError ??= error;
            });
          process.stderr.write(chunk);
        }
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      // Login deliberately has no live log: the token only enters Docker through stdin.
      if (input !== undefined) {
        child.stdin.on("error", () => undefined);
        child.stdin.end(input);
      }
      const terminate = () => {
        cancelled = true;
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* Already stopped. */
        }
        killTimer ??= setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Already stopped. */
          }
        }, 10_000);
      };
      const timer = setTimeout(terminate, timeout);
      signal?.addEventListener("abort", terminate, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", terminate);
      };
      child.once("error", () => {
        cleanup();
        reject(new Error("Image subprocess could not start"));
      });
      child.once("close", (code, childSignal) => {
        cleanup();
        if (code === 0 && !cancelled && (!overflow || log))
          accept(output.trim());
        else
          reject(
            new Error(
              `${command.split("/").at(-1)} failed (${childSignal ?? code})`,
            ),
          );
      });
    });
  } finally {
    try {
      await writes;
      if (writeError) throw writeError;
    } finally {
      await handle?.close();
    }
  }
}

export async function tokenValue(path, expectedUid = LINUX_DEPLOY.uid) {
  const handle = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== expectedUid ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size > 65_536 ||
      stat.size < 1
    )
      throw new Error("GHCR token must be an owner-only regular service file");
    const value = (await handle.readFile("utf8")).trim();
    if (!value || /\s/.test(value))
      throw new Error("GHCR token format is invalid");
    return value;
  } finally {
    await handle.close();
  }
}

export async function packagePermission(token, fetcher = fetch, signal) {
  const response = await fetcher("https://api.github.com/user", {
    redirect: "error",
    signal: AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(signal ? [signal] : []),
    ]),
    headers: {
      authorization: "Bearer " + token,
      accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok)
    throw new Error(
      "GitHub package identity verification HTTP " + response.status,
    );
  const permissions = (response.headers.get("x-oauth-scopes") ?? "")
    .split(",")
    .map((scope) => scope.trim());
  if (!permissions.includes("write:packages"))
    throw new Error(
      "GHCR publication requires a token with advertised write:packages permission",
    );
  if ((await response.json()).login?.toLowerCase() !== "xeonice")
    throw new Error("GHCR token belongs to a different publication owner");
}

export async function anonymousImage(
  image,
  tag,
  expectedSha,
  fetcher = fetch,
  signal,
) {
  if (
    !/^ghcr\.io\/xeonice\/agent-platform-(?:sandbox|boxlite)$/.test(image) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(tag)
  )
    throw new Error(
      "Anonymous verification accepts only fixed image coordinates",
    );
  const name = image.slice("ghcr.io/".length);
  const request = (url, headers = {}, blob = false) =>
    fetcher(url, {
      redirect: blob ? "follow" : "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(60_000),
        ...(signal ? [signal] : []),
      ]),
      headers,
    });
  const auth = await request(
    `https://ghcr.io/token?scope=repository:${name}:pull&service=ghcr.io`,
  );
  if (!auth.ok) throw new Error("Anonymous image token HTTP " + auth.status);
  const token = (await auth.json()).token;
  if (typeof token !== "string" || !token)
    throw new Error("Anonymous image token missing");
  const headers = { authorization: "Bearer " + token, accept: ACCEPT };
  const indexResponse = await request(
    `https://ghcr.io/v2/${name}/manifests/${tag}`,
    headers,
  );
  if (indexResponse.status === 404) return null;
  if (!indexResponse.ok)
    throw new Error("Anonymous image index HTTP " + indexResponse.status);
  const body = await indexResponse.text();
  const digest = "sha256:" + createHash("sha256").update(body).digest("hex");
  const advertised = indexResponse.headers.get("docker-content-digest");
  if (advertised && advertised !== digest)
    throw new Error("Anonymous manifest bytes do not match its digest");
  const index = JSON.parse(body);
  const platforms = [];
  for (const arch of ["amd64", "arm64"]) {
    const manifests = (index.manifests ?? []).filter(
      (item) =>
        item.platform?.os === "linux" && item.platform?.architecture === arch,
    );
    if (manifests.length !== 1 || !DIGEST.test(manifests[0].digest))
      throw new Error(
        "Anonymous image lacks a unique linux/" + arch + " manifest",
      );
    const manifestResponse = await request(
      `https://ghcr.io/v2/${name}/manifests/${manifests[0].digest}`,
      headers,
    );
    if (!manifestResponse.ok)
      throw new Error(
        "Anonymous platform manifest HTTP " + manifestResponse.status,
      );
    const manifestBody = await manifestResponse.text();
    if (
      "sha256:" + createHash("sha256").update(manifestBody).digest("hex") !==
      manifests[0].digest
    )
      throw new Error("Anonymous platform manifest digest differs");
    const manifest = JSON.parse(manifestBody);
    if (!DIGEST.test(manifest.config?.digest))
      throw new Error("Anonymous image config digest missing");
    // GHCR redirects blobs to its CDN. Fetch drops Authorization across origins;
    // the independently verified content digest still pins the downloaded bytes.
    const configResponse = await request(
      `https://ghcr.io/v2/${name}/blobs/${manifest.config.digest}`,
      headers,
      true,
    );
    if (!configResponse.ok)
      throw new Error("Anonymous image config HTTP " + configResponse.status);
    const configBody = await configResponse.text();
    if (
      "sha256:" + createHash("sha256").update(configBody).digest("hex") !==
      manifest.config.digest
    )
      throw new Error("Anonymous image config bytes differ");
    const config = JSON.parse(configBody);
    if (config.os !== "linux" || config.architecture !== arch)
      throw new Error("Anonymous platform config differs from index");
    if (
      expectedSha &&
      config.config?.Labels?.["org.opencontainers.image.revision"] !==
        expectedSha
    )
      throw new Error(
        "Immutable image tag belongs to a different source revision",
      );
    platforms.push("linux/" + arch);
  }
  return { digest, platforms, anonymous: true };
}

async function writeJson(path, value) {
  const temp = path + "." + randomUUID() + ".tmp";
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  await fs.rename(temp, path);
}

export function createImagePublisher(overrides = {}) {
  const run = overrides.run ?? execute;
  const fetcher = overrides.fetch ?? fetch;
  const token =
    overrides.token ?? (() => tokenValue(join(TOOLS, "ghcr-token")));
  const workspaceRoot = resolve(overrides.workspaceRoot ?? WORKSPACES);
  const identity = overrides.identity ?? userInfo();
  const system = overrides.system ?? buildSystem();
  const checkLayout = overrides.checkLayout ?? assertDeploymentLayout;
  const signal = overrides.signal;
  async function guard() {
    const context = deploymentContext(identity, system);
    if (context.platform !== "linux")
      throw new Error(
        "Image publication requires the dedicated Linux ARM64 deployment container",
      );
    await checkLayout(context);
    signal?.throwIfAborted();
    return context;
  }
  async function head(ref = IMAGE_BRANCH) {
    const context = await guard();
    if (!(ref === IMAGE_BRANCH || IMAGE_TAG_REF.test(ref)))
      throw new Error("Invalid trusted image ref");
    const env = imageEnvironment(
      context.node,
      join(TOOLS, "anonymous-docker-unused"),
      join(TOOLS, "tmp"),
    );
    const output = await run(
      "/usr/bin/git",
      ["ls-remote", "--exit-code", IMAGE_REPOSITORY, ref],
      { cwd: workspaceRoot, env, signal },
    );
    const rows = output.split("\n").map((line) => line.split("\t"));
    if (rows.length !== 1 || !SHA.test(rows[0][0]) || rows[0][1] !== ref)
      throw new Error("Trusted image ref does not resolve to one commit");
    // Annotated tags need their peeled commit, rather than the tag object.
    if (ref.startsWith("refs/tags/")) {
      const peeled = await run(
        "/usr/bin/git",
        ["ls-remote", IMAGE_REPOSITORY, ref + "^{}"],
        { cwd: workspaceRoot, env, signal },
      );
      if (peeled) {
        const [sha, name] = peeled.split("\t");
        if (!SHA.test(sha) || name !== ref + "^{}")
          throw new Error("Invalid peeled image tag");
        return { sha, ref, repository: IMAGE_REPOSITORY };
      }
    }
    return { sha: rows[0][0], ref, repository: IMAGE_REPOSITORY };
  }
  async function stage(
    sha,
    ref,
    tag = "",
    mode = "check",
    workspace = process.cwd(),
  ) {
    const context = await guard();
    const request = imageRequest(sha, ref, tag, mode);
    const work = await fs.realpath(resolve(workspace));
    const inside = relative(workspaceRoot, work);
    if (
      !inside ||
      inside.startsWith("../") ||
      inside === ".." ||
      inside.startsWith("/")
    )
      throw new Error("Image workspace escaped the trusted Jenkins agent");
    const source = join(work, "source");
    if ((await fs.lstat(source).catch(() => null))?.isSymbolicLink())
      throw new Error("Refusing a symlink image checkout");
    await fs.rm(source, { recursive: true, force: true });
    await fs.mkdir(source, { mode: 0o700 });
    const privateDocker = await fs.mkdtemp(join(work, ".docker-"));
    await fs.chmod(privateDocker, 0o700);
    // Keep registry authentication separate from the user's normal Docker config.
    // The fixed local plugin directory is enough to discover buildx without copying auth.
    await fs.writeFile(
      join(privateDocker, "config.json"),
      JSON.stringify({ cliPluginsExtraDirs: [DOCKER_PLUGINS] }),
      { mode: 0o600 },
    );
    const env = imageEnvironment(context.node, privateDocker, privateDocker);
    const log = join(work, "sandbox-images.log");
    await fs.rm(log, { force: true });
    const result = {
      version: 1,
      repository: IMAGE_REPOSITORY,
      sha,
      ref,
      mode,
      status: "checking",
      stage: "checkout",
      images: [],
      completedAt: null,
    };
    const report = join(work, "sandbox-images-result.json");
    const advance = async (name) => {
      signal?.throwIfAborted();
      result.stage = name;
      await writeJson(report, result);
      process.stderr.write(JSON.stringify({ stage: name, sha }) + "\n");
    };
    const invoke = (command, args, options = {}) =>
      run(command, args, { cwd: source, env, signal, ...options });
    let loggedIn = false;
    try {
      await invoke("/usr/bin/git", ["init"]);
      await invoke(
        "/usr/bin/git",
        ["fetch", "--depth=1", IMAGE_REPOSITORY, ref],
        { timeout: 120_000 },
      );
      if (
        (await invoke("/usr/bin/git", ["rev-parse", "FETCH_HEAD^{commit}"])) !==
        sha
      )
        throw new Error("Image ref moved before its pinned checkout");
      await invoke("/usr/bin/git", ["checkout", "--detach", sha]);
      const plan = await imagePlan(source, request);
      result.images = plan.images.map((item) => ({
        ...item,
        status: "pending",
      }));
      result.platforms = plan.platforms;
      await advance("default-image");
      await invoke(
        context.node,
        ["scripts/check-default-image-consistency.mjs"],
        { log },
      );
      await advance("builder");
      // Context metadata is confined to this temporary DOCKER_CONFIG. This does
      // not start a Docker daemon or alter the user's active Docker context.
      await invoke(DOCKER, [
        "context",
        "create",
        BUILDER,
        "--docker",
        "host=" + DOCKER_HOST,
      ]);
      await invoke(DOCKER, ["version", "--format", "{{.Server.Version}}"]);
      const builder = await invoke(DOCKER, ["buildx", "inspect", BUILDER]);
      if (!builder.includes("linux/amd64") || !builder.includes("linux/arm64"))
        throw new Error(
          "Dedicated runtime builder lacks one of the two required Linux architectures",
        );
      if (mode === "check") {
        result.status = "checked";
        return result;
      }
      await advance("package-permission");
      const credential = await token();
      await packagePermission(credential, fetcher, signal);
      await invoke(
        DOCKER,
        ["login", "ghcr.io", "--username", "Xeonice", "--password-stdin"],
        { input: credential + "\n" },
      );
      loggedIn = true;
      await fs.chmod(join(privateDocker, "config.json"), 0o600);
      for (const image of result.images) {
        try {
          await advance("publish-" + image.tier);
          const existing = await anonymousImage(
            image.repository,
            image.tag,
            sha,
            fetcher,
            signal,
          );
          if (existing) {
            // Resume an interrupted two-tier publication using its exact immutable source.
            await invoke(
              DOCKER,
              [
                "buildx",
                "imagetools",
                "create",
                "--tag",
                image.repository + ":latest",
                image.repository + "@" + existing.digest,
              ],
              { log, timeout: 120_000 },
            );
            image.reused = true;
          } else {
            const metadata = join(work, image.tier + "-build.json");
            await fs.rm(metadata, { force: true });
            await invoke(
              DOCKER,
              [
                "buildx",
                "build",
                "--progress=plain",
                "--builder",
                BUILDER,
                "--platform",
                plan.platforms.join(","),
                "--provenance=false",
                "--push",
                "--metadata-file",
                metadata,
                "--label",
                "org.opencontainers.image.revision=" + sha,
                "--label",
                "org.opencontainers.image.source=https://github.com/Xeonice/agent-platform-api",
                "--tag",
                image.repository + ":" + image.tag,
                "--tag",
                image.repository + ":latest",
                image.context,
              ],
              { log, timeout: 90 * 60_000 },
            );
            const built = JSON.parse(await fs.readFile(metadata, "utf8"));
            if (!DIGEST.test(built["containerimage.digest"]))
              throw new Error(
                "Buildx did not record its pushed immutable image digest",
              );
            image.builtDigest = built["containerimage.digest"];
          }
          await advance("anonymous-" + image.tier);
          const version = await anonymousImage(
            image.repository,
            image.tag,
            sha,
            fetcher,
            signal,
          );
          const latest = await anonymousImage(
            image.repository,
            "latest",
            sha,
            fetcher,
            signal,
          );
          if (
            !version ||
            !latest ||
            version.digest !== latest.digest ||
            (image.builtDigest && image.builtDigest !== version.digest)
          )
            throw new Error(
              "Anonymous version/latest bytes do not match the published build",
            );
          Object.assign(image, version, { status: "published" });
        } catch (error) {
          image.status = "failed";
          image.error = error.message;
          if (signal?.aborted) throw error;
        }
        await writeJson(report, result);
      }
      result.status = result.images.every(
        (image) => image.status === "published",
      )
        ? "published"
        : "failed";
      return result;
    } catch (error) {
      result.status = "failed";
      result.error = error.message;
      return result;
    } finally {
      if (loggedIn)
        await invoke(DOCKER, ["logout", "ghcr.io"], {
          signal: undefined,
        }).catch(() => undefined);
      await fs.rm(privateDocker, { recursive: true, force: true });
      result.completedAt = new Date().toISOString();
      await writeJson(report, result);
    }
  }
  return { head, stage };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const abort = new AbortController();
  process.once("SIGTERM", () => abort.abort());
  process.once("SIGINT", () => abort.abort());
  const runner = createImagePublisher({ signal: abort.signal });
  const args = process.argv.slice(2);
  (args[0] === "head" ? runner.head(args[1]) : runner.stage(...args))
    .then((result) => {
      console.log(JSON.stringify(result));
      if (result.status === "failed") process.exitCode = 1;
    })
    .catch((error) => {
      console.error(JSON.stringify({ status: "failed", error: error.message }));
      process.exitCode = 1;
    });
}
