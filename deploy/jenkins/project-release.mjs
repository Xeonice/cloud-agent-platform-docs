import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import {
  join,
  dirname,
  basename,
  resolve,
  relative,
  isAbsolute,
} from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { validateManifest as validateWebManifest } from "./jenkins-web.mjs";

export const ROOT = "/Users/douglasdong/.local/share/agent-platform-deploy";
export const TOOLS =
  "/Users/douglasdong/.local/share/agent-platform-jenkins-tools";
export const REPOSITORIES = Object.freeze({
  project: {
    name: "Xeonice/cloud-agent-platform-docs",
    branch: "Xeonice/初始化一下项目开发",
  },
  api: {
    name: "Xeonice/agent-platform-api",
    branch: "feat/design-v2-migration",
  },
  web: {
    name: "Xeonice/agent-platform-web",
    branch: "feat/design-v2-migration",
  },
});
export const SHA = /^[a-f0-9]{40}$/;
export const ASSETS = Object.freeze([
  "agent-platform-api-darwin-arm64.tgz",
  "agent-platform-web-prebuilt.tgz",
  "agent-platform-web-source.tgz",
  "agent-platform-storybook.tgz",
  "agent-platform-source.tgz",
  "release-manifest.json",
  "SHA256SUMS",
]);
export const JOBS = Object.freeze({
  api: "agent-platform-api",
  web: "agent-platform-web",
  contract: "agent-platform-contract",
  release: "agent-platform-release",
});
const ARCHIVES = Object.freeze({
  "prebuilt.tar.gz": ASSETS[1],
  "source.tar.gz": ASSETS[2],
  "storybook.tar.gz": ASSETS[3],
});
const MAX_ASSET = 1_999_999_999;
const now = () => new Date().toISOString();

export function projectKey(commits) {
  if (
    !commits ||
    Object.keys(commits).sort().join(",") !== "api,project,web" ||
    !Object.keys(REPOSITORIES).every((name) => SHA.test(commits?.[name] ?? ""))
  )
    throw new Error("Every repository must have a pinned full commit");
  return createHash("sha256")
    .update([commits.project, commits.api, commits.web].join("\n"))
    .digest("hex");
}
export function validateTag(tag) {
  if (
    typeof tag !== "string" ||
    tag.length > 100 ||
    !/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/.test(tag)
  )
    throw new Error("Use an immutable semantic release tag");
  return tag;
}
export function buildUrl(job, number) {
  if (
    !Object.values(JOBS).includes(job) ||
    !/^[1-9]\d{0,9}$/.test(String(number))
  )
    throw new Error("Invalid fixed Jenkins job/build");
  return "http://127.0.0.1:8080/job/" + job + "/" + number + "/";
}
export function releaseEnvironment(node, home) {
  return {
    PATH: dirname(node) + ":/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    CI: "true",
    HUSKY: "0",
    LANG: "en_US.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}
export function buildParameters(kind, plan) {
  if (kind === "api") return { SHA: plan.commits.api };
  if (kind === "web")
    return {
      SHA: plan.commits.web,
      REF: "refs/heads/" + REPOSITORIES.web.branch,
      ROOT_SHA: plan.commits.project,
      API_SHA: plan.commits.api,
    };
  if (kind === "contract")
    return {
      ROOT_SHA: plan.commits.project,
      API_SHA: plan.commits.api,
      WEB_SHA: plan.commits.web,
    };
  throw new Error("Invalid child build kind");
}
export function validateBuild(value, kind, number, plan) {
  if (
    value?.number !== Number(number) ||
    value.result !== "SUCCESS" ||
    value.building !== false ||
    value.url !== buildUrl(JOBS[kind], number)
  )
    throw new Error(
      "Required Jenkins build is not the matching completed SUCCESS",
    );
  const parameters = {};
  for (const item of (value.actions ?? []).flatMap(
    (action) => action.parameters ?? [],
  )) {
    if (Object.hasOwn(parameters, item.name))
      throw new Error("Duplicate Jenkins parameter");
    parameters[item.name] = String(item.value);
  }
  for (const [name, expected] of Object.entries(buildParameters(kind, plan)))
    if (parameters[name] !== expected)
      throw new Error("Jenkins build checked different pinned commits");
  return value;
}
export function validateApiPackage(value, number, sha) {
  if (
    value?.state !== "packaged" ||
    value.sha !== sha ||
    typeof value.artifact !== "string" ||
    basename(value.artifact) !== "api-package-" + number + ".tgz" ||
    !/^[a-f0-9]{64}$/.test(value.sha256 ?? "") ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 1 ||
    value.sizeBytes > MAX_ASSET ||
    value.relocatedNativeProbe !== "passed" ||
    !Array.isArray(value.nativeDependencies) ||
    value.nativeDependencies.length < 2 ||
    !Number.isSafeInteger(value.files) ||
    value.files < 1
  )
    throw new Error(
      "API package does not attest the pinned native relocated archive",
    );
  return value;
}
async function regular(path, privateOnly = false) {
  const handle = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > MAX_ASSET ||
      (privateOnly && (stat.uid !== process.getuid() || stat.mode & 0o077))
    )
      throw new Error("Unsafe regular/private release file");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function readJson(path, privateOnly = true) {
  const handle = await regular(path, privateOnly);
  try {
    const stat = await handle.stat();
    if (stat.size > 2_000_000) throw new Error("Release JSON oversized");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}
async function readPrivate(path) {
  const handle = await regular(path, true);
  try {
    if ((await handle.stat()).size > 65_536)
      throw new Error("Private configuration oversized");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
async function writeJson(path, value) {
  const temporary = path + "." + randomUUID() + ".tmp";
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  await fs.rename(temporary, path);
}
async function directory(path) {
  const stat = await fs.lstat(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o022 ||
    (await fs.realpath(path)) !== resolve(path)
  )
    throw new Error("Unsafe release directory");
}
export async function fileDigest(path) {
  const handle = await regular(path);
  try {
    const before = await handle.stat();
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk);
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.size <= 0
    )
      throw new Error("Release asset changed during hashing or is empty");
    return { size: before.size, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}
export function sourcePathAllowed(path) {
  const parts = path.split("/");
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    parts.some((part) => !part || part === "." || part === "..")
  )
    return false;
  return !parts.some(
    (part) =>
      part !== ".env.example" &&
      (/^\.env(?:\.|$)/.test(part) ||
        [
          ".git",
          ".vercel",
          ".npmrc",
          "runtime.env",
          "auth.json",
          "credentials.json",
          "credential.json",
          "cloudflared.token",
          "github-token",
          "admin-api.json",
          "jenkins-agent.secret",
          "agent.secret",
          "id_rsa",
          "id_ed25519",
        ].includes(part) ||
        /\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$/.test(part) ||
        /\.(?:pem|p12|pfx|key)$/.test(part)),
  );
}
export function validateSourceTree(output, name) {
  const files = [];
  for (const line of output.split("\0").filter(Boolean)) {
    const match = /^([0-9]{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(
      line,
    );
    if (!match || !sourcePathAllowed(match[4]))
      throw new Error("Source archive contains an unsafe or private path");
    if (
      match[1] === "160000" &&
      name === "project" &&
      ["api", "web"].includes(match[4])
    )
      continue;
    if (!["100644", "100755"].includes(match[1]) || match[2] !== "blob")
      throw new Error(
        "Source archives cannot contain symlinks or unexpected submodules",
      );
    files.push(match[4]);
  }
  if (!files.length) throw new Error("Source tree is empty");
  return files;
}
async function execute(command, args, cwd, capture = true) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: releaseEnvironment(process.execPath, "/Users/douglasdong"),
      stdio: capture
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "inherit", "inherit"],
    });
    let output = "",
      overflow = false;
    child.stdout?.on("data", (chunk) => {
      if (output.length + chunk.length > 5_000_000) {
        overflow = true;
        child.kill();
      } else output += chunk;
    });
    child.stderr?.resume();
    child.once("error", () =>
      reject(new Error("Release subprocess could not start")),
    );
    child.once("exit", (code, signal) =>
      code === 0 && !overflow
        ? accept(output)
        : reject(
            new Error(
              command.split("/").at(-1) + " failed (" + (signal ?? code) + ")",
            ),
          ),
    );
  });
}
export async function archiveSourceRepository(
  checkout,
  sha,
  name,
  output,
  archive,
  run = execute,
) {
  if (!SHA.test(sha) || !Object.hasOwn(REPOSITORIES, name))
    throw new Error("Invalid source identity");
  if (
    (
      await run("/usr/bin/git", ["rev-parse", "FETCH_HEAD"], checkout)
    ).trim() !== sha
  )
    throw new Error("Fetched source commit does not match plan");
  validateSourceTree(
    await run("/usr/bin/git", ["ls-tree", "-rz", sha], checkout),
    name,
  );
  await run(
    "/usr/bin/git",
    ["archive", "--format=tar", "-o", archive, sha],
    checkout,
  );
  const names = (await run("/usr/bin/tar", ["-tf", archive], checkout))
    .split("\n")
    .filter(Boolean)
    .map((path) => (path.endsWith("/") ? path.slice(0, -1) : path));
  if (!names.length || names.some((path) => !sourcePathAllowed(path)))
    throw new Error("Archive path differs from safe source policy");
  const types = (await run("/usr/bin/tar", ["-tvf", archive], checkout))
    .split("\n")
    .filter(Boolean);
  if (types.some((line) => !/^[d-]/.test(line)))
    throw new Error("Source archive contains a link or special entry");
  await fs.mkdir(output, { mode: 0o700 });
  await run(
    "/usr/bin/tar",
    ["-xf", archive, "--no-same-owner", "-C", output],
    checkout,
  );
}
export function checksumText(evidence) {
  if (
    Object.keys(evidence).length !== ASSETS.length - 1 ||
    ASSETS.slice(0, -1).some(
      (name) => !/^[a-f0-9]{64}$/.test(evidence[name]?.sha256 ?? ""),
    )
  )
    throw new Error("Incomplete fixed release checksum inventory");
  return (
    ASSETS.slice(0, -1)
      .map((name) => evidence[name].sha256 + "  " + name)
      .join("\n") + "\n"
  );
}
export async function verifyPackage(folder, plan) {
  await directory(folder);
  const names = (await fs.readdir(folder)).sort();
  if (JSON.stringify(names) !== JSON.stringify([...ASSETS].sort()))
    throw new Error("Package has missing or unexpected assets");
  const manifest = await readJson(join(folder, "release-manifest.json"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.key !== plan.key ||
    projectKey(manifest.commits) !== plan.key ||
    manifest.tag !== plan.tag ||
    manifest.builtOn?.platform !== "darwin" ||
    manifest.builtOn?.arch !== "arm64" ||
    manifest.builtOn?.nodeMajor !== 22 ||
    manifest.frontendOrigin !== "https://agent.douglasdong.com" ||
    manifest.apiOrigin !== "https://agent-api.douglasdong.com" ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    JSON.stringify(Object.keys(manifest.assets ?? {}).sort()) !==
      JSON.stringify(ASSETS.slice(0, 5).sort())
  )
    throw new Error(
      "Package provenance or asset inventory does not match plan",
    );
  for (const kind of ["api", "web", "contract", "release"])
    if (
      manifest.jenkins?.[kind]?.url !==
      buildUrl(JOBS[kind], manifest.jenkins[kind].number)
    )
      throw new Error(
        "Package Jenkins provenance has an untrusted job/build URL",
      );
  const evidence = {};
  for (const name of ASSETS.slice(0, -1)) {
    evidence[name] = await fileDigest(join(folder, name));
    if (
      name !== "release-manifest.json" &&
      (manifest.assets[name].sha256 !== evidence[name].sha256 ||
        manifest.assets[name].size !== evidence[name].size)
    )
      throw new Error("An artifact changed after packaging");
  }
  const sums = await regular(join(folder, "SHA256SUMS"));
  try {
    if ((await sums.readFile("utf8")) !== checksumText(evidence))
      throw new Error(
        "SHA256SUMS does not authenticate every artifact and the release manifest",
      );
  } finally {
    await sums.close();
  }
  evidence.SHA256SUMS = await fileDigest(join(folder, "SHA256SUMS"));
  return { manifest, evidence };
}
export function validateRemoteAssets(release, evidence, complete = false) {
  const seen = new Set();
  for (const asset of release.assets ?? []) {
    if (!ASSETS.includes(asset.name) || seen.has(asset.name))
      throw new Error("GitHub release has an unexpected or duplicate asset");
    seen.add(asset.name);
    const expected = evidence[asset.name];
    if (
      !Number.isSafeInteger(asset.id) ||
      asset.id < 1 ||
      asset.state !== "uploaded" ||
      asset.size !== expected.size ||
      asset.digest !== "sha256:" + expected.sha256
    )
      throw new Error(
        "Existing GitHub asset bytes are different; never overwrite an immutable asset",
      );
    if (
      release.tag_name &&
      asset.browser_download_url !==
        "https://github.com/" +
          REPOSITORIES.project.name +
          "/releases/download/" +
          release.tag_name +
          "/" +
          asset.name
    )
      throw new Error(
        "GitHub asset download URL is not the fixed release source",
      );
  }
  if (complete && seen.size !== ASSETS.length)
    throw new Error("Published release is incomplete");
}

export function createReleaseRunner(overrides = {}) {
  const root = resolve(overrides.root ?? ROOT),
    tools = resolve(overrides.tools ?? TOOLS);
  const releases = join(root, "project-releases");
  const identity = overrides.identity ?? {
    uid: process.getuid(),
    platform: process.platform,
    arch: process.arch,
    nodeMajor: Number(process.versions.node.split(".")[0]),
  };
  const run = overrides.execute ?? execute;
  const fetcher = overrides.fetch ?? globalThis.fetch;
  async function github(path, options = {}) {
    const token = (await readPrivate(join(tools, "github-token"))).trim();
    const response = await fetcher(
      "https://api.github.com/repos/" + REPOSITORIES.project.name + "/" + path,
      {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...options.headers,
        },
      },
    );
    if (!response.ok) {
      if (response.status === 404 && options.optional) return null;
      throw new Error("GitHub release HTTP " + response.status);
    }
    return response.status === 204 ? null : response.json();
  }
  const gh = overrides.github ?? github;
  const head =
    overrides.head ??
    (async (spec) => {
      const output = await run("/usr/bin/git", [
        "ls-remote",
        "--exit-code",
        "https://github.com/" + spec.name + ".git",
        "refs/heads/" + spec.branch,
      ]);
      const entries = output.trim().split("\n");
      if (
        entries.length !== 1 ||
        entries[0].split(/\s+/)[1] !== "refs/heads/" + spec.branch ||
        !SHA.test(entries[0].split(/\s+/)[0])
      )
        throw new Error("Invalid fixed branch head");
      return entries[0].split(/\s+/)[0];
    });
  async function ensureHeads(plan) {
    for (const [name, spec] of Object.entries(REPOSITORIES))
      if ((await head(spec)) !== plan.commits[name])
        throw new Error(
          "A repository moved; rebuild the new pinned combination",
        );
  }
  async function jenkins(kind, number, plan) {
    const job = JOBS[kind],
      prefix = buildUrl(job, number);
    if (overrides.jenkins) {
      const value = await overrides.jenkins(kind, Number(number), plan);
      validateBuild(value.result, kind, number, plan);
      return { ...value, number: Number(number), url: prefix };
    }
    const credential = await readJson(join(tools, "admin-api.json"));
    const auth =
      "Basic " +
      Buffer.from(credential.username + ":" + credential.token).toString(
        "base64",
      );
    async function response(path) {
      if (
        !/^(?:api\/json\?tree=[A-Za-z0-9_,[\]]+|artifact\/[A-Za-z0-9_./-]+)$/.test(
          path,
        ) ||
        path.includes("..")
      )
        throw new Error("Invalid fixed Jenkins evidence path");
      const result = await fetcher(prefix + path, {
        headers: { authorization: auth },
        redirect: "error",
        signal: AbortSignal.timeout(
          /\.(?:tar\.gz|tgz)$/.test(path) ? 1_200_000 : 20_000,
        ),
      });
      if (!result.ok)
        throw Object.assign(
          new Error("Jenkins evidence HTTP " + result.status),
          { status: result.status },
        );
      return result;
    }
    const result = await (
      await response(
        "api/json?tree=number,result,building,url,actions[parameters[name,value]]",
      )
    ).json();
    validateBuild(result, kind, number, plan);
    return {
      result,
      number: Number(number),
      url: prefix,
      get: async (path) => (await response(path)).json(),
      response,
    };
  }
  async function readPlan(path) {
    const full = resolve(path),
      plan = await readJson(full);
    if (
      full !== join(releases, projectKey(plan.commits), "plan.json") ||
      plan.key !== projectKey(plan.commits) ||
      plan.schemaVersion !== 1
    )
      throw new Error("Invalid immutable project release plan path/key");
    validateTag(plan.tag);
    return plan;
  }
  async function apiEvidence(proof, plan) {
    const ci = await proof.get("artifact/ci.json"),
      deployment = await proof.get("artifact/deployment.json");
    if (
      ci.sha !== plan.commits.api ||
      ci.runId !== proof.number ||
      ![
        join(root, "releases", plan.commits.api),
        join(root, "ci-workspaces", plan.commits.api),
      ].includes(ci.artifactPath) ||
      ci.state !== "ci-passed" ||
      !["current", "deployed"].includes(deployment.state) ||
      deployment.sha !== plan.commits.api
    )
      throw new Error(
        "API child evidence is not the pinned completed native release",
      );
    if (overrides.apiReceipt) await overrides.apiReceipt(proof, plan, ci);
    else {
      const library = await import(
        pathToFileURL(join(root, "tools/lib.mjs")).href
      );
      const config = library.validateConfig(
        await readJson(join(root, "config.json")),
      );
      const receipt = await library.readJenkinsReceipt(config, {
        sha: plan.commits.api,
        buildNumber: proof.number,
      });
      if (!receipt || receipt.artifactPath !== ci.artifactPath)
        throw new Error(
          "Trusted local API receipt does not match Jenkins artifact evidence",
        );
    }
    return ci;
  }
  async function download(proof, path, expected, target) {
    const response = await proof.response(path);
    const handle = await fs.open(target, "wx", 0o600);
    let size = 0;
    const hash = createHash("sha256");
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > expected.size || size > MAX_ASSET)
          throw new Error("Jenkins artifact exceeded declared size");
        hash.update(chunk);
        await handle.writeFile(chunk);
      }
    } finally {
      await handle.close();
    }
    if (size !== expected.size || hash.digest("hex") !== expected.sha256)
      throw new Error("Jenkins artifact digest differs from verified manifest");
  }
  async function downloadApi(proof, plan, target) {
    const manifest = validateApiPackage(
      await proof.get("artifact/api-package.json"),
      proof.number,
      plan.commits.api,
    );
    await download(
      proof,
      "artifact/api-package-" + proof.number + ".tgz",
      { size: manifest.sizeBytes, sha256: manifest.sha256 },
      target,
    );
    const paths = (await run("/usr/bin/tar", ["-tzf", target]))
      .split("\n")
      .filter(Boolean);
    if (
      !paths.length ||
      paths.some(
        (path) =>
          !path.startsWith("agent-platform-api/") ||
          path.includes("\\") ||
          /[\u0000-\u001f\u007f]/.test(path) ||
          path.split("/").some((part) => part === ".." || part === ".") ||
          /(?:^|\/)(?:runtime\.env|cloudflared\.token|jenkins-agent\.secret|\.env(?:\..*)?)(?:\/|$)/.test(
            path.replace(/\/\.env\.example$/, "/example"),
          ),
      )
    )
      throw new Error("API archive contains an unsafe path or private state");
    const release = JSON.parse(
      await run("/usr/bin/tar", [
        "-xzOf",
        target,
        "agent-platform-api/release.json",
      ]),
    );
    if (
      release.sha !== plan.commits.api ||
      release.platform !== "darwin" ||
      release.arch !== "arm64" ||
      release.nodeMajor !== 22
    )
      throw new Error(
        "API archive release provenance differs from verified source",
      );
    return manifest;
  }
  async function verifyRetainedWeb(plan, record, folder) {
    if (
      !record ||
      record.key !== plan.key ||
      record.url !== buildUrl(JOBS.web, record.number)
    )
      throw new Error("Retained web receipt differs from project plan");
    const cache = join(folder, "web-ci-artifacts");
    const cached = await fs.lstat(cache).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const webRoot = cached ? cache : join(root, "web-releases", plan.key);
    await directory(webRoot);
    if (
      cached &&
      (cached.mode & 0o077 ||
        JSON.stringify((await fs.readdir(cache)).sort()) !==
          JSON.stringify(["manifest.json", ...Object.keys(ARCHIVES)].sort()))
    )
      throw new Error(
        "Retained CI archives must remain owner-only with a fixed inventory",
      );
    const manifest = validateWebManifest(
      await readJson(join(webRoot, "manifest.json")),
      plan.commits.web,
      plan.commits.project,
      true,
      plan.commits.api,
    );
    if (
      manifest.jenkins.buildNumber !== record.number ||
      record.webManifestSha256 !==
        createHash("sha256").update(JSON.stringify(manifest)).digest("hex")
    )
      throw new Error(
        "Retained web manifest differs from verified Jenkins receipt",
      );
    for (const name of Object.keys(ARCHIVES)) {
      const handle = await regular(join(webRoot, name), true);
      await handle.close();
      const value = await fileDigest(join(webRoot, name));
      if (
        value.sha256 !== manifest.archives[name].sha256 ||
        value.size !== manifest.archives[name].bytes
      )
        throw new Error(
          "Retained web archive changed after Jenkins verification",
        );
    }
    return { webRoot, manifest };
  }
  async function cacheWeb(plan, proof, manifest, folder) {
    const cache = join(folder, "web-ci-artifacts");
    const hash = createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("hex");
    const record = {
      key: plan.key,
      number: proof.number,
      url: proof.url,
      webManifestSha256: hash,
    };
    if (
      await fs.lstat(cache).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      })
    ) {
      await verifyRetainedWeb(plan, record, folder);
      return;
    }
    const scratch = join(folder, ".web-ci-" + randomUUID());
    await fs.mkdir(scratch, { mode: 0o700 });
    try {
      await writeJson(join(scratch, "manifest.json"), manifest);
      for (const name of Object.keys(ARCHIVES)) {
        const expected = manifest.archives[name];
        await download(
          proof,
          "artifact/web-artifacts/" + name,
          { size: expected.bytes, sha256: expected.sha256 },
          join(scratch, name),
        );
      }
      await fs.rename(scratch, cache);
      await verifyRetainedWeb(plan, record, folder);
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }
  async function savedBuilds(plan, folder) {
    const records = await readJson(join(folder, "builds.json")).catch(
      (error) => {
        if (error.code === "ENOENT") return {};
        throw error;
      },
    );
    const saved = {};
    for (const [kind, record] of Object.entries(records)) {
      if (
        !["api", "web", "contract"].includes(kind) ||
        record.key !== plan.key ||
        record.url !== buildUrl(JOBS[kind], record.number)
      )
        throw new Error("Saved build provenance differs from plan");
      try {
        await jenkins(kind, record.number, plan);
        saved[kind] = record.number;
      } catch (error) {
        // The first real SUCCESS retains owner-only original CI archives before
        // any adoption. Jenkins retention cannot force new Next build bits.
        if (error.status === 404 && kind === "web") {
          await verifyRetainedWeb(plan, record, folder);
          saved.web = record.number;
        } else if (error.status !== 404) throw error;
      }
    }
    return saved;
  }
  async function webContractEvidence(proof, plan) {
    // A retained parent proves the original Web bytes, not a still-available
    // cross-repository child. Never infer a child's SUCCESS from that cache.
    if (proof.retainedReceipt) return null;
    let report;
    try {
      report = await proof.get("artifact/web-cross-repository/contract.json");
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
    const exactKeys = (value, keys) =>
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === keys.sort().join(",");
    const parameters = buildParameters("contract", plan);
    if (
      !exactKeys(report, [
        "schemaVersion",
        "job",
        "buildNumber",
        "state",
        "commits",
        "child",
        "parameters",
      ]) ||
      report.schemaVersion !== 1 ||
      report.job !== JOBS.web ||
      report.buildNumber !== proof.number ||
      report.state !== "passed" ||
      !exactKeys(report.commits, ["root", "api", "web"]) ||
      report.commits.root !== plan.commits.project ||
      report.commits.api !== plan.commits.api ||
      report.commits.web !== plan.commits.web ||
      !exactKeys(report.child, ["job", "number", "result", "url"]) ||
      report.child.job !== JOBS.contract ||
      !Number.isSafeInteger(report.child.number) ||
      report.child.number < 1 ||
      report.child.result !== "SUCCESS" ||
      report.child.url !== buildUrl(JOBS.contract, report.child.number) ||
      !exactKeys(report.parameters, Object.keys(parameters)) ||
      Object.entries(parameters).some(
        ([name, value]) => report.parameters[name] !== value,
      )
    )
      throw new Error("Web cross-repository evidence differs from pinned plan");
    let child;
    try {
      child = await jenkins("contract", report.child.number, plan);
    } catch (error) {
      // Artifact text alone cannot restore a pruned Jenkins child. The release
      // pipeline can safely run a new real contract build for this combination.
      if (error.status === 404) return null;
      throw error;
    }
    return {
      key: plan.key,
      number: child.number,
      url: child.url,
      verifiedAt: now(),
      webBuildNumber: proof.number,
      webBuildUrl: proof.url,
      webCrossReportSha256: createHash("sha256")
        .update(JSON.stringify(report))
        .digest("hex"),
    };
  }
  async function recordBuild(plan, kind, number, folder) {
    if (!["api", "web", "contract"].includes(kind))
      throw new Error("Invalid saved build kind");
    const existing = await readJson(join(folder, "builds.json")).catch(
      (error) => {
        if (error.code === "ENOENT") return {};
        throw error;
      },
    );
    if (
      kind !== "web" &&
      existing[kind]?.number === Number(number) &&
      (await savedBuilds(plan, folder))[kind] === Number(number)
    )
      return {
        state: "build-recorded",
        kind,
        number: Number(number),
        savedBuilds: await savedBuilds(plan, folder),
      };
    if (
      kind === "web" &&
      existing.web &&
      existing.web.number !== Number(number)
    )
      throw new Error("Pinned web CI already has immutable build evidence");
    const proof =
      kind === "web" && existing.web
        ? await webProof(plan, number)
        : await jenkins(kind, number, plan);
    const record = {
      key: plan.key,
      number: proof.number,
      url: proof.url,
      verifiedAt: now(),
    };
    let contract;
    if (kind === "api") await apiEvidence(proof, plan);
    if (kind === "web") {
      const manifest = validateWebManifest(
        await proof.get("artifact/web-artifacts/manifest.json"),
        plan.commits.web,
        plan.commits.project,
        true,
        plan.commits.api,
      );
      if (manifest.jenkins.buildNumber !== proof.number)
        throw new Error("Web artifact belongs to a different CI build");
      contract = await webContractEvidence(proof, plan);
      await cacheWeb(plan, proof, manifest, folder);
      record.webManifestSha256 = createHash("sha256")
        .update(JSON.stringify(manifest))
        .digest("hex");
    }
    const records = await readJson(join(folder, "builds.json")).catch(
      (error) => {
        if (error.code === "ENOENT") return {};
        throw error;
      },
    );
    if (
      records[kind] &&
      records[kind].number !== record.number &&
      kind === "web"
    )
      throw new Error("Pinned web CI already has immutable build evidence");
    records[kind] = record;
    if (contract) records.contract = contract;
    await writeJson(join(folder, "builds.json"), records);
    return {
      state: "build-recorded",
      kind,
      number: proof.number,
      savedBuilds: await savedBuilds(plan, folder),
    };
  }
  async function webProof(plan, number) {
    try {
      return await jenkins("web", number, plan);
    } catch (error) {
      if (error.status !== 404) throw error;
      const folder = join(releases, plan.key);
      const records = await readJson(join(folder, "builds.json"));
      if (records.web?.number !== Number(number)) throw error;
      const { webRoot } = await verifyRetainedWeb(plan, records.web, folder);
      return {
        number: Number(number),
        url: buildUrl(JOBS.web, number),
        retainedReceipt: true,
        get: async (path) => {
          if (path !== "artifact/web-artifacts/manifest.json")
            throw new Error("Unexpected retained web evidence path");
          return readJson(join(webRoot, "manifest.json"));
        },
        response: async (path) => {
          const name = path.slice("artifact/web-artifacts/".length);
          if (
            path !== "artifact/web-artifacts/" + name ||
            !Object.hasOwn(ARCHIVES, name)
          )
            throw new Error("Unexpected retained web archive path");
          const handle = await regular(join(webRoot, name));
          return { body: handle.createReadStream({ autoClose: true }) };
        },
      };
    }
  }
  async function fetchWeb(plan, number, workspace) {
    await ensureHeads(plan);
    const proof = await webProof(plan, number);
    const manifest = validateWebManifest(
      await proof.get("artifact/web-artifacts/manifest.json"),
      plan.commits.web,
      plan.commits.project,
      true,
      plan.commits.api,
    );
    if (manifest.jenkins.buildNumber !== proof.number)
      throw new Error("Downloaded web manifest belongs to another build");
    const work = resolve(workspace);
    const rel = relative(join(root, "jenkins-agent"), work);
    if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel))
      throw new Error(
        "Web evidence destination must be an isolated trusted Jenkins workspace",
      );
    await directory(work);
    const destination = join(work, "web-artifacts");
    if (await fs.lstat(destination).catch(() => null))
      throw new Error("Use a fresh web artifact destination");
    const scratch = join(work, ".web-download-" + randomUUID());
    await fs.mkdir(scratch, { mode: 0o700 });
    try {
      await writeJson(join(scratch, "manifest.json"), manifest);
      for (const name of Object.keys(ARCHIVES)) {
        const expected = manifest.archives[name];
        const response = await proof.response("artifact/web-artifacts/" + name);
        const handle = await fs.open(join(scratch, name), "wx", 0o600);
        let size = 0;
        const hash = createHash("sha256");
        try {
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > expected.bytes || size > MAX_ASSET)
              throw new Error("Jenkins artifact exceeded declared size");
            hash.update(chunk);
            await handle.writeFile(chunk);
          }
        } finally {
          await handle.close();
        }
        if (size !== expected.bytes || hash.digest("hex") !== expected.sha256)
          throw new Error(
            "Jenkins artifact digest differs from verified manifest",
          );
      }
      await ensureHeads(plan);
      await fs.rename(scratch, destination);
      return {
        state: "web-fetched",
        workspace: work,
        artifacts: destination,
        buildNumber: proof.number,
        commits: plan.commits,
      };
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }
  async function writePublished(folder, plan, release, evidence, recovered) {
    if (
      !Number.isSafeInteger(release.id) ||
      release.id < 1 ||
      release.html_url !==
        "https://github.com/" +
          REPOSITORIES.project.name +
          "/releases/tag/" +
          plan.tag ||
      !Number.isFinite(Date.parse(release.published_at))
    )
      throw new Error("Unexpected published release identity");
    const record = {
      state: "published",
      key: plan.key,
      tag: plan.tag,
      releaseId: release.id,
      releaseUrl: release.html_url,
      commits: plan.commits,
      assets: ASSETS.map((name) => ({
        name,
        ...evidence[name],
        url: release.assets.find((asset) => asset.name === name)
          .browser_download_url,
      })),
      publishedAt: release.published_at,
    };
    await writeJson(join(folder, "published.json"), record);
    const prior = await readJson(
      join(root, "project-release-current.json"),
    ).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (
      !prior ||
      Date.parse(prior.publishedAt) <= Date.parse(record.publishedAt)
    )
      await writeJson(join(root, "project-release-current.json"), record);
    return { ...record, recovered };
  }
  async function tagCommit(tag) {
    let ref = await gh("git/ref/tags/" + encodeURIComponent(tag), {
      optional: true,
    });
    if (!ref) return null;
    for (let depth = 0; depth < 5; depth++) {
      if (ref.object?.type === "commit" && SHA.test(ref.object.sha))
        return ref.object.sha;
      if (ref.object?.type !== "tag" || !SHA.test(ref.object.sha))
        throw new Error("Unsupported release tag target");
      ref = await gh("git/tags/" + ref.object.sha);
    }
    throw new Error("Release tag nesting exceeds limit");
  }
  return async function release(action, ...args) {
    if (
      identity.uid !== 501 ||
      identity.platform !== "darwin" ||
      identity.arch !== "arm64" ||
      identity.nodeMajor !== 22
    )
      throw new Error(
        "Publishing requires the trusted Mac mini deploy account and Node22",
      );
    if (action === "plan") {
      const commits = {};
      for (const [name, spec] of Object.entries(REPOSITORIES))
        commits[name] = await head(spec);
      const key = projectKey(commits),
        folder = join(releases, key);
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      await directory(folder);
      const existing = await readJson(join(folder, "plan.json")).catch(
        (error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      const prior = await readJson(
        join(root, "project-release-current.json"),
      ).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (existing) {
        await readPlan(join(folder, "plan.json"));
        if (args[0] && validateTag(args[0]) !== existing.tag)
          throw new Error(
            "This pinned combination already reserved another immutable tag",
          );
        return {
          ...existing,
          planPath: join(folder, "plan.json"),
          savedBuilds: await savedBuilds(existing, folder),
          unchanged: prior?.key === key,
        };
      }
      let releasesRemote = [];
      for (let page = 1; page <= 20; page++) {
        const items = await gh("releases?per_page=100&page=" + page);
        releasesRemote.push(...items);
        if (items.length < 100) break;
        if (page === 20)
          throw new Error("Release history exceeds bounded pagination");
      }
      const patches = releasesRemote
        .filter((item) => /^v0\.3\.\d+$/.test(item.tag_name))
        .map((item) => Number(item.tag_name.split(".")[2]));
      const tag = validateTag(
        args[0] || "v0.3." + (patches.length ? Math.max(...patches) + 1 : 0),
      );
      if (
        (await gh("releases/tags/" + encodeURIComponent(tag), {
          optional: true,
        })) ||
        (await tagCommit(tag))
      )
        throw new Error("Release/tag already exists; it is immutable");
      const plan = {
        schemaVersion: 1,
        key,
        tag,
        commits,
        repositories: REPOSITORIES,
        createdAt: now(),
      };
      await writeJson(join(folder, "plan.json"), plan);
      return {
        ...plan,
        planPath: join(folder, "plan.json"),
        savedBuilds: {},
        unchanged: false,
      };
    }
    const plan = await readPlan(args[0]),
      folder = join(releases, plan.key);
    if (action === "record-build")
      return recordBuild(plan, args[1], args[2], folder);
    if (action === "fetch-web") return fetchWeb(plan, args[1], args[2]);
    if (action === "pin-web") {
      await ensureHeads(plan);
      await writeJson(join(root, "jenkins-web-pin.json"), {
        version: 1,
        repository: REPOSITORIES.project.name,
        rootSha: plan.commits.project,
        apiSha: plan.commits.api,
        webSha: plan.commits.web,
        approved: true,
      });
      return { state: "pinned", commits: plan.commits };
    }
    if (action === "package") {
      await ensureHeads(plan);
      const assets = join(folder, "assets");
      if (await fs.lstat(assets).catch(() => null)) {
        const value = await verifyPackage(assets, plan);
        return {
          state: "packaged",
          reused: true,
          tag: plan.tag,
          assetsPath: assets,
          manifest: value.manifest,
        };
      }
      const api = await jenkins("api", args[1], plan),
        web = await webProof(plan, args[2]),
        contract = await jenkins("contract", args[3], plan);
      await apiEvidence(api, plan);
      const webRoot = join(root, "web-releases", plan.key);
      const webManifest = validateWebManifest(
        await readJson(join(webRoot, "manifest.json")),
        plan.commits.web,
        plan.commits.project,
        true,
        plan.commits.api,
      );
      if (webManifest.jenkins.buildNumber !== web.number)
        throw new Error(
          "Adopted web bytes belong to another verified CI build",
        );
      const remoteManifest = await web.get(
        "artifact/web-artifacts/manifest.json",
      );
      if (JSON.stringify(remoteManifest) !== JSON.stringify(webManifest))
        throw new Error(
          "Adopted web manifest differs from actual Jenkins artifact",
        );
      const number = Number(overrides.buildNumber ?? process.env.BUILD_NUMBER),
        url = overrides.buildUrl ?? process.env.BUILD_URL;
      if (url !== buildUrl(JOBS.release, number))
        throw new Error(
          "Packaging must identify its actual fixed Jenkins release build",
        );
      const stage = join(folder, ".package-" + randomUUID());
      await fs.mkdir(stage, { mode: 0o700 });
      try {
        await downloadApi(api, plan, join(stage, ASSETS[0]));
        for (const [from, to] of Object.entries(ARCHIVES)) {
          const actual = await fileDigest(join(webRoot, from)),
            expected = webManifest.archives[from];
          if (
            actual.sha256 !== expected.sha256 ||
            actual.size !== expected.bytes
          )
            throw new Error("Adopted web archive changed after CI");
          await fs.copyFile(
            join(webRoot, from),
            join(stage, to),
            constants.COPYFILE_EXCL,
          );
        }
        const scratch = join(folder, ".source-" + randomUUID());
        await fs.mkdir(scratch, { mode: 0o700 });
        try {
          for (const [name, spec] of Object.entries(REPOSITORIES)) {
            const checkout = join(scratch, name + "-checkout");
            await fs.mkdir(checkout, { mode: 0o700 });
            await run("/usr/bin/git", ["init"], checkout);
            await run(
              "/usr/bin/git",
              [
                "fetch",
                "--depth=1",
                "https://github.com/" + spec.name + ".git",
                plan.commits[name],
              ],
              checkout,
            );
            await archiveSourceRepository(
              checkout,
              plan.commits[name],
              name,
              join(scratch, name + "-source"),
              join(scratch, name + ".tar"),
              run,
            );
          }
          const combined = join(scratch, "project-source");
          for (const name of ["api", "web"]) {
            const target = join(combined, name);
            const placeholder = await fs.lstat(target).catch(() => null);
            if (placeholder) {
              if (
                !placeholder.isDirectory() ||
                (await fs.readdir(target)).length
              )
                throw new Error(
                  "Root source contains non-submodule content at API/web overlay path",
                );
              await fs.rmdir(target);
            }
            await fs.rename(join(scratch, name + "-source"), target);
          }
          await run("/usr/bin/tar", [
            "-czf",
            join(stage, ASSETS[4]),
            "-C",
            scratch,
            "project-source",
          ]);
        } finally {
          await fs.rm(scratch, { recursive: true, force: true });
        }
        const hashes = {};
        for (const name of ASSETS.slice(0, 5))
          hashes[name] = await fileDigest(join(stage, name));
        const manifest = {
          schemaVersion: 1,
          key: plan.key,
          tag: plan.tag,
          commits: plan.commits,
          createdAt: now(),
          builtOn: { platform: "darwin", arch: "arm64", nodeMajor: 22 },
          jenkins: {
            api: { number: api.number, url: api.url },
            web: { number: web.number, url: web.url },
            contract: { number: contract.number, url: contract.url },
            release: { number, url, stateAtPackaging: "running" },
          },
          frontendOrigin: "https://agent.douglasdong.com",
          apiOrigin: "https://agent-api.douglasdong.com",
          assets: hashes,
        };
        await writeJson(join(stage, "release-manifest.json"), manifest);
        hashes["release-manifest.json"] = await fileDigest(
          join(stage, "release-manifest.json"),
        );
        await fs.writeFile(join(stage, "SHA256SUMS"), checksumText(hashes), {
          flag: "wx",
          mode: 0o600,
        });
        await verifyPackage(stage, plan);
        await ensureHeads(plan);
        await fs.rename(stage, assets);
        await writeJson(join(folder, "packaged.json"), {
          state: "packaged",
          key: plan.key,
          tag: plan.tag,
          commits: plan.commits,
          at: now(),
        });
        return {
          state: "packaged",
          tag: plan.tag,
          assetsPath: assets,
          manifest,
        };
      } finally {
        await fs.rm(stage, { recursive: true, force: true });
      }
    }
    if (action === "upload") {
      const { evidence } = await verifyPackage(join(folder, "assets"), plan);
      let release = await gh("releases/tags/" + encodeURIComponent(plan.tag), {
        optional: true,
      });
      if (
        release &&
        (!Number.isSafeInteger(release.id) ||
          release.tag_name !== plan.tag ||
          release.target_commitish !== plan.commits.project)
      )
        throw new Error("Existing release refers to different source");
      if (release && !release.draft) {
        if ((await tagCommit(plan.tag)) !== plan.commits.project)
          throw new Error("Published tag source differs from plan");
        validateRemoteAssets(release, evidence, true);
        return writePublished(folder, plan, release, evidence, true);
      }
      await ensureHeads(plan);
      if (!release)
        release = await gh("releases", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tag_name: plan.tag,
            target_commitish: plan.commits.project,
            name: "Agent Platform " + plan.tag,
            body:
              "Complete pinned Agent Platform release. Project " +
              plan.commits.project +
              ", API " +
              plan.commits.api +
              ", web " +
              plan.commits.web +
              ". API: native macOS ARM64 / Node22; frontend: Vercel prebuilt; source and Storybook included. Verify every downloaded asset and manifest with SHA256SUMS. Production data and private runtime files are excluded.",
            draft: true,
            prerelease: false,
          }),
        });
      if (
        !Number.isSafeInteger(release.id) ||
        release.id < 1 ||
        !release.draft ||
        release.tag_name !== plan.tag ||
        release.target_commitish !== plan.commits.project
      )
        throw new Error("GitHub did not create the requested immutable draft");
      const starters = (release.assets ?? []).filter(
        (asset) => asset.state === "starter",
      );
      if (starters.length) {
        const receipt = await readJson(join(folder, "upload.json"));
        validateRemoteAssets(
          {
            ...release,
            assets: release.assets.filter((asset) => asset.state !== "starter"),
          },
          evidence,
        );
        if (
          starters.length !== 1 ||
          receipt.key !== plan.key ||
          receipt.releaseId !== release.id ||
          receipt.tag !== plan.tag
        )
          throw new Error("Unverified failed GitHub upload requires review");
        const asset = starters[0],
          pending = receipt.pendingAsset;
        if (
          !Number.isSafeInteger(asset.id) ||
          asset.id < 1 ||
          asset.size !== 0 ||
          asset.digest != null ||
          !ASSETS.includes(asset.name) ||
          pending?.name !== asset.name ||
          pending.sha256 !== evidence[asset.name].sha256 ||
          pending.size !== evidence[asset.name].size
        )
          throw new Error("Unverified failed GitHub upload requires review");
        // Only our proven zero-byte unpublished failed upload is disposable.
        // Uploaded immutable bytes are never deleted or replaced.
        await gh("releases/assets/" + asset.id, { method: "DELETE" });
        release = await gh("releases/" + release.id);
        if (
          !release.draft ||
          release.tag_name !== plan.tag ||
          release.target_commitish !== plan.commits.project
        )
          throw new Error("Draft changed during failed-upload recovery");
      }
      validateRemoteAssets(release, evidence);
      await writeJson(join(folder, "upload.json"), {
        state: "draft",
        key: plan.key,
        releaseId: release.id,
        tag: plan.tag,
        at: now(),
      });
      for (const name of ASSETS) {
        if ((release.assets ?? []).some((item) => item.name === name)) continue;
        const local = evidence[name];
        await writeJson(join(folder, "upload.json"), {
          state: "uploading",
          key: plan.key,
          releaseId: release.id,
          tag: plan.tag,
          pendingAsset: { name, ...local },
          at: now(),
        });
        let item;
        if (overrides.uploadAsset)
          item = await overrides.uploadAsset(
            release.id,
            name,
            join(folder, "assets", name),
            local,
          );
        else {
          const token = (await readPrivate(join(tools, "github-token"))).trim(),
            handle = await regular(join(folder, "assets", name));
          try {
            const response = await fetcher(
              "https://uploads.github.com/repos/" +
                REPOSITORIES.project.name +
                "/releases/" +
                release.id +
                "/assets?name=" +
                encodeURIComponent(name),
              {
                method: "POST",
                body: handle.createReadStream({ autoClose: false }),
                duplex: "half",
                redirect: "error",
                signal: AbortSignal.timeout(1_200_000),
                headers: {
                  Authorization: "Bearer " + token,
                  Accept: "application/vnd.github+json",
                  "X-GitHub-Api-Version": "2022-11-28",
                  "Content-Type": name.endsWith(".tgz")
                    ? "application/gzip"
                    : "application/octet-stream",
                  "Content-Length": String(local.size),
                },
              },
            );
            if (!response.ok)
              throw new Error("GitHub asset upload HTTP " + response.status);
            item = await response.json();
          } finally {
            await handle.close();
          }
        }
        if (item.name !== name)
          throw new Error(
            "Upload response changed the requested asset identity",
          );
        validateRemoteAssets({ tag_name: plan.tag, assets: [item] }, evidence);
        release.assets ??= [];
        release.assets.push(item);
      }
      const confirmed = await gh("releases/" + release.id);
      if (
        !confirmed.draft ||
        confirmed.tag_name !== plan.tag ||
        confirmed.target_commitish !== plan.commits.project
      )
        throw new Error("Draft source/state changed during upload");
      validateRemoteAssets(confirmed, evidence, true);
      await ensureHeads(plan);
      const tag = await tagCommit(plan.tag);
      if (tag && tag !== plan.commits.project)
        throw new Error("Draft tag source changed");
      await gh("releases/" + release.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: false, make_latest: "true" }),
      });
      const published = await gh("releases/" + release.id);
      if (
        published.draft ||
        (await tagCommit(plan.tag)) !== plan.commits.project
      )
        throw new Error(
          "GitHub did not confirm the immutable published source",
        );
      validateRemoteAssets(published, evidence, true);
      return writePublished(folder, plan, published, evidence, false);
    }
    throw new Error("Use plan|pin-web|record-build|fetch-web|package|upload");
  };
}
export async function runRelease(action, ...args) {
  return createReleaseRunner()(action, ...args);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runRelease(...process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(
        JSON.stringify({ state: "release-failed", error: error.message }),
      );
      process.exitCode = 1;
    });
