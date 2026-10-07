import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { dockerSaveFixture } from "./fixtures/docker-save.mjs";
import { promisify } from "node:util";
import { validRef, ciEnvironment } from "./jenkins-ci.mjs";
import { GATES, WEB, releaseKey } from "./jenkins-web.mjs";
import {
  ASSETS,
  JOBS,
  REPOSITORIES,
  archiveSourceRepository,
  buildParameters,
  buildUrl,
  checksumText,
  createReleaseRunner,
  fileDigest,
  projectKey,
  releaseEnvironment,
  sourcePathAllowed,
  validateBuild,
  validateHistoricalBuild,
  validateApiPackage,
  validateRemoteAssets,
  validateSourceTree,
  verifyPackage,
} from "./project-release.mjs";
import {
  createDiscoverer,
  DISCOVERY_JOBS,
  isTrustedJenkinsLocation,
  parametersMatch,
  validRequest,
} from "./jenkins-discover.mjs";

const exec = promisify(execFile),
  directories = [];
const commits = {
  project: "a".repeat(40),
  api: "b".repeat(40),
  web: "c".repeat(40),
};
const identity = {
  username: "douglasdong",
  homedir: "/Users/douglasdong",
  uid: 501,
  platform: "darwin",
  arch: "arm64",
  nodeMajor: 22,
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});
async function temporary() {
  const path = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "agent-platform-jenkins-test-")),
  );
  directories.push(path);
  await fs.chmod(path, 0o700);
  return path;
}
async function json(path, value) {
  await fs.writeFile(path, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
}
async function read(path) {
  return JSON.parse(await fs.readFile(path, "utf8"));
}
function build(kind, number, plan, result = "SUCCESS") {
  return {
    number,
    result,
    building: false,
    url: buildUrl(JOBS[kind], number),
    actions: [
      {
        parameters: Object.entries(buildParameters(kind, plan)).map(
          ([name, value]) => ({ name, value }),
        ),
      },
    ],
  };
}
function webManifest(
  plan,
  number = 7,
  bytes = Buffer.from("real archive bytes"),
) {
  return {
    schemaVersion: 1,
    repository: WEB.repository,
    sha: plan.commits.web,
    rootSha: plan.commits.project,
    apiSha: plan.commits.api,
    ref: WEB.ref,
    production: true,
    nodeMajor: 22,
    vercelCli: "62.2.0",
    state: "packaged",
    gates: Object.fromEntries(GATES.map((gate) => [gate, { state: "passed" }])),
    jenkins: { job: JOBS.web, buildNumber: number, gateResult: "SUCCESS" },
    archives: Object.fromEntries(
      ["source.tar.gz", "prebuilt.tar.gz", "storybook.tar.gz"].map((name) => [
        name,
        { bytes: bytes.length, sha256: sha256(bytes) },
      ]),
    ),
  };
}

test("new publication binds three main heads while already retained feature build evidence remains read-only", () => {
  assert.deepEqual(
    Object.values(REPOSITORIES).map((spec) => spec.branch),
    ["main", "main", "main"],
  );
  const plan = { commits };
  const current = build("web", 7, plan);
  assert.equal(buildParameters("web", plan).REF, "refs/heads/main");
  assert.equal(validateBuild(current, "web", 7, plan), current);
  const historical = structuredClone(current);
  historical.actions[0].parameters.find((item) => item.name === "REF").value =
    "refs/heads/feat/design-v2-migration";
  const before = JSON.stringify(historical);
  assert.throws(
    () => validateBuild(historical, "web", 7, plan),
    /different pinned/,
  );
  assert.equal(validateHistoricalBuild(historical, "web", 7, plan), historical);
  assert.equal(JSON.stringify(historical), before);
  for (const ref of ["refs/heads/unapproved", "refs/pull/9/head"]) {
    const forged = structuredClone(historical);
    forged.actions[0].parameters.find((item) => item.name === "REF").value =
      ref;
    assert.throws(
      () => validateHistoricalBuild(forged, "web", 7, plan),
      /different pinned/,
    );
  }
  const wrongSha = structuredClone(historical);
  wrongSha.actions[0].parameters.find((item) => item.name === "API_SHA").value =
    "d".repeat(40);
  assert.throws(
    () => validateHistoricalBuild(wrongSha, "web", 7, plan),
    /different pinned/,
  );
});
function webArtifacts(manifest, crossReport) {
  return async (path) => {
    if (path === "artifact/web-artifacts/manifest.json") return manifest;
    if (
      path === "artifact/web-cross-repository/contract.json" &&
      crossReport !== undefined
    )
      return crossReport;
    throw Object.assign(new Error("Jenkins artifact unavailable"), {
      status: 404,
    });
  };
}
function crossReport(plan, parentNumber = 7, childNumber = 8) {
  return {
    schemaVersion: 1,
    job: JOBS.web,
    buildNumber: parentNumber,
    state: "passed",
    commits: {
      root: plan.commits.project,
      api: plan.commits.api,
      web: plan.commits.web,
    },
    child: {
      job: JOBS.contract,
      number: childNumber,
      result: "SUCCESS",
      url: buildUrl(JOBS.contract, childNumber),
    },
    parameters: buildParameters("contract", plan),
  };
}
async function fixture(options = {}) {
  const root = await temporary();
  const tools = join(root, "tools");
  await fs.mkdir(tools, { mode: 0o700 });
  const source = options.commits ?? commits,
    key = projectKey(source);
  const folder = join(root, "project-releases", key);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const plan = {
    schemaVersion: 1,
    key,
    tag: "v0.3.2",
    commits: source,
    repositories: REPOSITORIES,
    createdAt: new Date().toISOString(),
  };
  const planPath = join(folder, "plan.json");
  await json(planPath, plan);
  const runner = createReleaseRunner({
    root,
    tools,
    identity,
    head: async (spec) =>
      source[
        Object.keys(REPOSITORIES).find(
          (name) => REPOSITORIES[name].name === spec.name,
        )
      ],
    ...options,
  });
  return { root, tools, folder, plan, planPath, runner };
}
async function packageFixture(f) {
  const assets = join(f.folder, "assets");
  await fs.mkdir(assets, { mode: 0o700 });
  const hashes = {};
  for (const name of ASSETS.slice(0, 5)) {
    await fs.writeFile(join(assets, name), "archive:" + name, { mode: 0o600 });
    hashes[name] = await fileDigest(join(assets, name));
  }
  const manifest = {
    schemaVersion: 1,
    key: f.plan.key,
    tag: f.plan.tag,
    commits: f.plan.commits,
    createdAt: new Date().toISOString(),
    builtOn: { platform: "darwin", arch: "arm64", nodeMajor: 22 },
    frontendOrigin: WEB.api.replace("-api", ""),
    apiOrigin: WEB.api,
    jenkins: Object.fromEntries(
      Object.keys(JOBS).map((kind, i) => [
        kind,
        { number: i + 1, url: buildUrl(JOBS[kind], i + 1) },
      ]),
    ),
    assets: hashes,
  };
  await json(join(assets, "release-manifest.json"), manifest);
  hashes["release-manifest.json"] = await fileDigest(
    join(assets, "release-manifest.json"),
  );
  await fs.writeFile(join(assets, "SHA256SUMS"), checksumText(hashes), {
    mode: 0o600,
  });
  return { assets, ...(await verifyPackage(assets, f.plan)) };
}
function releaseRemote(f, evidence, count = ASSETS.length, draft = false) {
  const namespace = draft ? "untagged-638fc49470ae7e474d83" : f.plan.tag;
  return {
    id: 91,
    tag_name: f.plan.tag,
    target_commitish: f.plan.commits.project,
    draft,
    html_url:
      "https://github.com/" +
      REPOSITORIES.project.name +
      "/releases/tag/" +
      namespace,
    published_at: draft ? null : "2026-10-06T01:00:00.000Z",
    assets: ASSETS.slice(0, count).map((name, i) => ({
      id: i + 1,
      name,
      state: "uploaded",
      size: evidence[name].size,
      digest: "sha256:" + evidence[name].sha256,
      browser_download_url:
        "https://github.com/" +
        REPOSITORIES.project.name +
        "/releases/download/" +
        namespace +
        "/" +
        name,
    })),
  };
}
function publishRemote(remote) {
  remote.draft = false;
  remote.published_at = "2026-10-06T01:00:00.000Z";
  remote.html_url =
    "https://github.com/" +
    REPOSITORIES.project.name +
    "/releases/tag/" +
    remote.tag_name;
  for (const asset of remote.assets)
    asset.browser_download_url =
      "https://github.com/" +
      REPOSITORIES.project.name +
      "/releases/download/" +
      remote.tag_name +
      "/" +
      asset.name;
}
test("untrusted refs cannot turn a pure-CI checkout into shell or Git options", () => {
  assert.equal(validRef("refs/pull/12/head"), true);
  assert.equal(validRef("refs/heads/feature/a"), true);
  for (const ref of [
    "--upload-pack=sh",
    "refs/heads/$(cat ~/.env)",
    "refs/heads/x;curl",
    "refs/heads/x..y",
    "refs/heads/x.lock",
    "refs/heads/x\n",
    "refs/tags/v1",
  ])
    assert.equal(validRef(ref), false);
});
test("child environments omit ambient production/cloud credentials and Git hooks", async () => {
  const root = await temporary();
  for (const environment of [
    ciEnvironment(process.execPath, root, root),
    releaseEnvironment(process.execPath, root),
  ]) {
    assert.equal(environment.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
    const output = await exec(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      { env: environment },
    );
    const child = JSON.parse(output.stdout);
    assert.equal(child.ACCESS_PASSCODE, undefined);
    assert.equal(child.GITHUB_TOKEN, undefined);
    assert.equal(child.VERCEL_TOKEN, undefined);
    assert.equal(child.NODE_OPTIONS, undefined);
    assert.equal(child.HOME, root);
  }
});
test("project key uses all three pinned commits and matches web immutable cache key", () => {
  assert.equal(
    projectKey(commits),
    releaseKey(commits.project, commits.api, commits.web),
  );
  assert.notEqual(
    projectKey(commits),
    projectKey({ ...commits, api: "d".repeat(40) }),
  );
  assert.throws(() => projectKey({ ...commits, spoof: commits.api }));
  assert.throws(() => projectKey({ ...commits, project: "main" }));
});
test("Jenkins gate proof requires actual SUCCESS and the exact source combination", () => {
  const plan = { commits };
  validateBuild(build("web", 7, plan), "web", 7, plan);
  const publicBuild = build("web", 7, plan);
  publicBuild.url = "https://jenkins.douglasdong.com/job/agent-platform-web/7/";
  validateBuild(publicBuild, "web", 7, plan);
  assert.throws(() =>
    validateBuild({ ...publicBuild, number: 8 }, "web", 7, plan),
  );
  const wrong = build("web", 7, plan);
  wrong.actions[0].parameters.find((p) => p.name === "API_SHA").value =
    "d".repeat(40);
  assert.throws(() => validateBuild(wrong, "web", 7, plan));
  assert.throws(() =>
    validateBuild(build("web", 7, plan, "UNSTABLE"), "web", 7, plan),
  );
  const duplicate = build("web", 7, plan);
  duplicate.actions[0].parameters.push({ name: "SHA", value: commits.web });
  assert.throws(() => validateBuild(duplicate, "web", 7, plan));
  const external = build("web", 7, plan);
  external.url = "https://evil.invalid/job/agent-platform-web/7/";
  assert.throws(() => validateBuild(external, "web", 7, plan));
});
test("file hashing refuses symlinks instead of authenticating external private bytes", async () => {
  const root = await temporary();
  const file = join(root, "asset");
  await fs.writeFile(file, "public");
  await fs.symlink(file, join(root, "link"));
  assert.equal((await fileDigest(file)).sha256, sha256("public"));
  await assert.rejects(fileDigest(join(root, "link")));
});
test("source tree refuses tracked secrets, symlinks, and foreign submodules", () => {
  for (const path of [
    ".env.production",
    "x/runtime.env",
    "private/key.pem",
    "database.db-wal",
    "../readme",
    "/readme",
    "a\\b",
    "node_modules/auth.json",
  ])
    assert.equal(sourcePathAllowed(path), false);
  assert.equal(sourcePathAllowed(".env.example"), true);
  assert.equal(sourcePathAllowed("docs/README.md"), true);
  assert.throws(() =>
    validateSourceTree("120000 blob " + commits.api + "\tlink\0", "api"),
  );
  assert.throws(() =>
    validateSourceTree(
      "160000 commit " + commits.api + "\tforeign\0",
      "project",
    ),
  );
  assert.throws(() =>
    validateSourceTree(
      "100644 blob " + commits.api + "\t.env.production\0",
      "api",
    ),
  );
});
async function gitRepository(root, files) {
  await fs.mkdir(root, { mode: 0o700 });
  for (const [name, text] of Object.entries(files))
    await fs.writeFile(join(root, name), text);
  await exec("/usr/bin/git", ["init", "-q"], { cwd: root });
  await exec("/usr/bin/git", ["add", "."], { cwd: root });
  await exec(
    "/usr/bin/git",
    [
      "-c",
      "user.name=Acceptance",
      "-c",
      "user.email=acceptance@example.invalid",
      "commit",
      "-qm",
      "source",
    ],
    { cwd: root },
  );
  const sha = (
    await exec("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim();
  await fs.writeFile(join(root, ".git", "FETCH_HEAD"), sha + "\n");
  return sha;
}
test("actual git/tar archive verifies FETCH_HEAD and retains only tracked pinned files", async () => {
  const root = await temporary(),
    repo = join(root, "repo");
  const sha = await gitRepository(repo, {
    "README.md": "pinned source\n",
    ".env.example": "KEY=example\n",
  });
  await fs.writeFile(join(repo, "untracked-secret"), "excluded");
  await archiveSourceRepository(
    repo,
    sha,
    "api",
    join(root, "source"),
    join(root, "source.tar"),
  );
  assert.equal(
    await fs.readFile(join(root, "source/README.md"), "utf8"),
    "pinned source\n",
  );
  await assert.rejects(fs.stat(join(root, "source/untracked-secret")), {
    code: "ENOENT",
  });
  await assert.rejects(
    archiveSourceRepository(
      repo,
      commits.api,
      "api",
      join(root, "other"),
      join(root, "other.tar"),
    ),
    /does not match/,
  );
});
test("actual tracked .env aborts before creating any source tar", async () => {
  const root = await temporary(),
    repo = join(root, "repo"),
    tar = join(root, "source.tar");
  const sha = await gitRepository(repo, {
    ".env.production": "PRIVATE=not-exported\n",
  });
  await assert.rejects(
    archiveSourceRepository(repo, sha, "api", join(root, "source"), tar),
    /unsafe/,
  );
  await assert.rejects(fs.stat(tar), { code: "ENOENT" });
});
test("complete package uses three actual pinned Git archives and immutable web bytes", async () => {
  const origin = await temporary(),
    local = {};
  local.api = join(origin, "api");
  local.web = join(origin, "web");
  local.project = join(origin, "project");
  const source = {
    api: await gitRepository(local.api, { "api.txt": "API pinned source" }),
    web: await gitRepository(local.web, { "web.txt": "Web pinned source" }),
  };
  await gitRepository(local.project, { "README.md": "root pinned source" });
  for (const name of ["api", "web"])
    await exec(
      "/usr/bin/git",
      [
        "update-index",
        "--add",
        "--cacheinfo",
        "160000," + source[name] + "," + name,
      ],
      { cwd: local.project },
    );
  await exec(
    "/usr/bin/git",
    [
      "-c",
      "user.name=Acceptance",
      "-c",
      "user.email=acceptance@example.invalid",
      "commit",
      "-qm",
      "pinned submodules",
    ],
    { cwd: local.project },
  );
  source.project = (
    await exec("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: local.project })
  ).stdout.trim();
  const f = await fixture({ commits: source }),
    bytes = Buffer.from("immutable web archive"),
    manifest = webManifest(f.plan, 7, bytes);
  const webRoot = join(f.root, "web-releases", f.plan.key);
  await fs.mkdir(webRoot, { recursive: true, mode: 0o700 });
  await json(join(webRoot, "manifest.json"), manifest);
  for (const name of Object.keys(manifest.archives))
    await fs.writeFile(join(webRoot, name), bytes, { mode: 0o600 });
  const nativeRoot = join(origin, "agent-platform-api");
  await fs.mkdir(nativeRoot);
  const docker = await dockerSaveFixture(origin);
  await fs.copyFile(docker.archive, join(nativeRoot, "api-image.tar"));
  await json(join(nativeRoot, "release.json"), {
    sha: source.api,
    rootSha: source.project,
    schemaVersion: 2,
    platform: "linux",
    arch: "arm64",
    nodeMajor: 22,
    imageId: docker.imageId,
    boxliteVersion: "0.9.7",
    nativeProbe: "passed",
    builtAt: new Date().toISOString(),
    imageArchive: "api-image.tar",
  });
  await fs.writeFile(join(nativeRoot, "README.md"), "native archive fixture");
  const nativePath = join(origin, "api-package-6.tgz");
  await exec("/usr/bin/tar", [
    "-czf",
    nativePath,
    "-C",
    origin,
    "agent-platform-api",
  ]);
  const nativeBytes = await fs.readFile(nativePath);
  const nativeManifest = {
    state: "packaged",
    sha: source.api,
    rootSha: source.project,
    artifact: nativePath,
    sha256: sha256(nativeBytes),
    sizeBytes: nativeBytes.length,
    files: 3,
    platform: "linux",
    arch: "arm64",
    nodeMajor: 22,
    imageId: docker.imageId,
    boxliteVersion: "0.9.7",
    nativeProbe: "passed",
  };
  const run = createReleaseRunner({
    root: f.root,
    identity,
    buildNumber: 10,
    buildUrl: "https://jenkins.douglasdong.com/job/agent-platform-release/10/",
    head: async (spec) =>
      source[
        Object.keys(REPOSITORIES).find(
          (name) => REPOSITORIES[name].name === spec.name,
        )
      ],
    jenkins: async (kind, number, plan) => ({
      result: {
        ...build(kind, number, plan),
        url:
          "https://jenkins.douglasdong.com/job/" +
          JOBS[kind] +
          "/" +
          number +
          "/",
      },
      get: async (path) => {
        if (kind === "web") return manifest;
        if (path === "artifact/ci.json")
          return {
            sha: source.api,
            rootSha: source.project,
            runId: number,
            artifactPath: join(
              f.root,
              "releases",
              source.project + "-" + source.api,
            ),
            state: "ci-passed",
            imageId: docker.imageId,
            nativeProbe: "passed",
          };
        if (path === "artifact/api-package.json") return nativeManifest;
        return {
          state: "deployed",
          sha: source.api,
          rootSha: source.project,
          imageId: docker.imageId,
        };
      },
      response: async (path) => {
        assert.equal(path, "artifact/api-package-6.tgz");
        return {
          body: [nativeBytes.subarray(0, 12), nativeBytes.subarray(12)],
        };
      },
    }),
    apiReceipt: async (_, plan, ci) => {
      assert.equal(ci.sha, plan.commits.api);
    },
    execute: async (command, args, cwd) => {
      if (command === "/usr/bin/git" && args[0] === "fetch") {
        const name = Object.keys(REPOSITORIES).find(
          (key) =>
            args[2] === "https://github.com/" + REPOSITORIES[key].name + ".git",
        );
        assert.ok(name);
        args = [...args];
        args[2] = local[name];
      }
      return (
        await exec(command, args, {
          cwd,
          env: releaseEnvironment(process.execPath, origin),
          maxBuffer: 5_000_000,
        })
      ).stdout;
    },
  });
  const result = await run("package", f.planPath, "6", "7", "8");
  assert.equal(
    result.manifest.jenkins.release.url,
    "https://jenkins.douglasdong.com/job/agent-platform-release/10/",
  );
  await verifyPackage(result.assetsPath, f.plan);
  const extracted = join(origin, "extracted");
  await fs.mkdir(extracted);
  await exec("/usr/bin/tar", [
    "-xzf",
    join(result.assetsPath, ASSETS[4]),
    "-C",
    extracted,
  ]);
  assert.equal(
    await fs.readFile(join(extracted, "project-source", "api/api.txt"), "utf8"),
    "API pinned source",
  );
  assert.equal(
    await fs.readFile(join(extracted, "project-source", "web/web.txt"), "utf8"),
    "Web pinned source",
  );
  assert.equal(
    await fs.readFile(join(extracted, "project-source", "README.md"), "utf8"),
    "root pinned source",
  );
  const first = await fileDigest(join(result.assetsPath, ASSETS[4]));
  assert.equal((await run("package", f.planPath, "6", "7", "8")).reused, true);
  assert.deepEqual(await fileDigest(join(result.assetsPath, ASSETS[4])), first);
});
test("package checksum inventory authenticates native/web/source archives and manifest", async () => {
  const f = await fixture(),
    p = await packageFixture(f);
  assert.equal(Object.keys(p.evidence).length, 7);
  const sums = await fs.readFile(join(p.assets, "SHA256SUMS"), "utf8");
  assert.equal(sums.split("\n").filter(Boolean).length, 6);
  assert.ok(sums.includes("  release-manifest.json\n"));
  await fs.appendFile(join(p.assets, ASSETS[0]), "tampered");
  await assert.rejects(verifyPackage(p.assets, f.plan), /changed/);
});
test("checksum file itself and extra assets cannot be spoofed", async () => {
  const f = await fixture(),
    p = await packageFixture(f);
  await fs.appendFile(join(p.assets, "SHA256SUMS"), "unverified\n");
  await assert.rejects(verifyPackage(p.assets, f.plan), /SHA256SUMS/);
  await fs.writeFile(join(p.assets, "extra"), "secret");
  await assert.rejects(verifyPackage(p.assets, f.plan), /unexpected/);
});
test("release provenance rejects an unsupported build architecture", async () => {
  const f = await fixture(),
    p = await packageFixture(f),
    path = join(p.assets, "release-manifest.json");
  const m = await read(path);
  m.builtOn.arch = "x64";
  await json(path, m);
  await assert.rejects(verifyPackage(p.assets, f.plan), /provenance/);
});
test("an existing immutable combination cannot be remapped to another user-specified tag", async () => {
  const f = await fixture({ github: async () => [] });
  assert.equal((await f.runner("plan", "v0.3.2")).key, f.plan.key);
  await assert.rejects(f.runner("plan", "v1.0.0"), /another immutable tag/);
});
test("published GitHub bytes recover local state without new uploads or current-head requirement", async () => {
  const f = await fixture(),
    p = await packageFixture(f),
    remote = releaseRemote(f, p.evidence);
  let writes = 0;
  const run = createReleaseRunner({
    root: f.root,
    tools: f.tools,
    identity,
    head: async () => "d".repeat(40),
    github: async (path, options = {}) => {
      if (options.method) writes++;
      return path.startsWith("git/")
        ? { object: { type: "commit", sha: commits.project } }
        : remote;
    },
    uploadAsset: async () => {
      throw new Error("Must not upload twice");
    },
  });
  const result = await run("upload", f.planPath);
  assert.equal(result.recovered, true);
  assert.equal(writes, 0);
  assert.equal(
    (await read(join(f.root, "project-release-current.json"))).key,
    f.plan.key,
  );
  assert.equal(result.assets.length, 7);
});
test("published source or remote asset digest mismatch refuses recovery", async () => {
  const f = await fixture(),
    p = await packageFixture(f),
    remote = releaseRemote(f, p.evidence);
  remote.assets[0].digest = "sha256:" + "0".repeat(64);
  const run = createReleaseRunner({
    root: f.root,
    identity,
    github: async (path) =>
      path.startsWith("git/")
        ? { object: { type: "commit", sha: commits.project } }
        : remote,
  });
  await assert.rejects(run("upload", f.planPath), /immutable asset/);
  remote.assets[0].digest = "sha256:" + p.evidence[ASSETS[0]].sha256;
  remote.assets[0].browser_download_url = "https://evil.invalid/download";
  await assert.rejects(run("upload", f.planPath), /download URL/);
});
test("a fresh GitHub draft describes the packaged Docker Linux API before publishing the complete inventory", async () => {
  const f = await fixture(),
    p = await packageFixture(f);
  let remote = null,
    requested;
  const run = createReleaseRunner({
    root: f.root,
    identity,
    head: async (spec) =>
      commits[
        Object.keys(REPOSITORIES).find(
          (name) => REPOSITORIES[name].name === spec.name,
        )
      ],
    github: async (path, options = {}) => {
      if (path.startsWith("git/"))
        return remote && !remote.draft
          ? { object: { type: "commit", sha: commits.project } }
          : null;
      if (path.startsWith("releases?"))
        return remote ? [structuredClone(remote)] : [];
      if (path === "releases" && options.method === "POST") {
        requested = JSON.parse(options.body);
        remote = releaseRemote(f, p.evidence, 0, true);
      }
      if (options.method === "PATCH") {
        publishRemote(remote);
      }
      return structuredClone(remote);
    },
    uploadAsset: async (_, name, path, evidence) => {
      assert.equal((await fileDigest(path)).sha256, evidence.sha256);
      const item = releaseRemote(
        f,
        p.evidence,
        ASSETS.length,
        true,
      ).assets.find((asset) => asset.name === name);
      remote.assets.push(item);
      return item;
    },
  });
  const result = await run("upload", f.planPath);
  assert.equal(requested.target_commitish, commits.project);
  assert.equal(requested.draft, true);
  assert.match(requested.body, /API: Docker Linux ARM64 \/ Node22/);
  assert.doesNotMatch(requested.body, /native macOS|Darwin/);
  for (const sha of Object.values(commits))
    assert.ok(requested.body.includes(sha));
  assert.equal(result.state, "published");
  assert.deepEqual(
    remote.assets.map((asset) => asset.name),
    ASSETS,
  );
});
test("an observed draft namespace is accepted only for its fixed repository, exact asset and draft release", () => {
  const name = ASSETS[0],
    namespace = "untagged-638fc49470ae7e474d83",
    prefix = "https://github.com/" + REPOSITORIES.project.name,
    evidence = {
      [name]: {
        size: 325189424,
        sha256:
          "7eac0edf1c542cc49a19c5f18a2ae0b16d3bbd27265ad9ce9c71f612e42623bb",
      },
    },
    remote = {
      id: 404366506,
      tag_name: "v0.3.0",
      target_commitish: "74d886de0ec7dc09380141cb203fb3c7502c8d7e",
      draft: true,
      html_url: prefix + "/releases/tag/" + namespace,
      assets: [
        {
          id: 1,
          name,
          state: "uploaded",
          size: evidence[name].size,
          digest: "sha256:" + evidence[name].sha256,
          browser_download_url:
            prefix + "/releases/download/" + namespace + "/" + name,
        },
      ],
    };
  assert.doesNotThrow(() => validateRemoteAssets(remote, evidence));
  for (const invalid of [
    prefix + "/releases/download/untagged-0000000000000000/" + name,
    prefix + "/releases/download/v0.3.0/" + name,
    prefix + "/releases/download/" + namespace + "/../" + name,
    prefix + "/releases/download/" + namespace + "/foreign.tgz",
    remote.assets[0].browser_download_url + "?download=1",
    remote.assets[0].browser_download_url + "#asset",
    remote.assets[0].browser_download_url.replace(
      "cloud-agent-platform-docs",
      "agent-platform-api",
    ),
    remote.assets[0].browser_download_url.replace(
      "https://github.com",
      "https://user:password@github.com",
    ),
    remote.assets[0].browser_download_url.replace("github.com", "evil.invalid"),
    remote.assets[0].browser_download_url.replace("https:", "http:"),
  ]) {
    const bad = structuredClone(remote);
    bad.assets[0].browser_download_url = invalid;
    assert.throws(() => validateRemoteAssets(bad, evidence), /download URL/);
  }
  for (const invalid of [
    remote.html_url.replace("cloud-agent-platform-docs", "agent-platform-api"),
    prefix + "/releases/tag/v0.3.0",
    remote.html_url + "?draft=1",
    remote.html_url + "#draft",
    remote.html_url + "\n",
    remote.html_url.replace("untagged-", "untagged-nothex-"),
    remote.html_url.replace(
      "https://github.com",
      "https://user:password@github.com",
    ),
  ])
    assert.throws(
      () => validateRemoteAssets({ ...remote, html_url: invalid }, evidence),
      /release URL/,
    );
  const published = structuredClone(remote);
  publishRemote(published);
  assert.doesNotThrow(() => validateRemoteAssets(published, evidence));
  published.assets[0].browser_download_url =
    remote.assets[0].browser_download_url;
  assert.throws(
    () => validateRemoteAssets(published, evidence),
    /download URL/,
  );
  published.assets[0].browser_download_url =
    prefix + "/releases/download/v0.3.1/" + name;
  assert.throws(
    () => validateRemoteAssets(published, evidence),
    /download URL/,
  );
});
test("draft partial-upload retry skips exact immutable bytes and publishes only a complete inventory", async () => {
  const f = await fixture(),
    p = await packageFixture(f);
  let remote = releaseRemote(f, p.evidence, 2, true),
    uploads = [],
    patches = 0;
  const run = createReleaseRunner({
    root: f.root,
    identity,
    head: async (spec) =>
      commits[
        Object.keys(REPOSITORIES).find(
          (name) => REPOSITORIES[name].name === spec.name,
        )
      ],
    github: async (path, options = {}) => {
      if (path.startsWith("git/"))
        return remote.draft
          ? null
          : { object: { type: "commit", sha: commits.project } };
      if (options.method === "PATCH") {
        patches++;
        publishRemote(remote);
      }
      return structuredClone(remote);
    },
    uploadAsset: async (_, name, path, evidence) => {
      assert.equal((await fileDigest(path)).sha256, evidence.sha256);
      uploads.push(name);
      const item = releaseRemote(
        f,
        p.evidence,
        ASSETS.length,
        true,
      ).assets.find((asset) => asset.name === name);
      remote.assets.push(item);
      return item;
    },
  });
  const result = await run("upload", f.planPath);
  assert.equal(patches, 1);
  assert.deepEqual(uploads, ASSETS.slice(2));
  assert.equal(result.recovered, false);
  assert.equal((await read(join(f.folder, "published.json"))).assets.length, 7);
});
test("a private draft receipt selects its exact release even when tag lookup hides drafts and historical duplicates exist", async () => {
  const f = await fixture(),
    p = await packageFixture(f),
    remote = releaseRemote(f, p.evidence, ASSETS.length, true);
  await json(join(f.folder, "upload.json"), {
    state: "draft",
    key: f.plan.key,
    releaseId: remote.id,
    tag: f.plan.tag,
  });
  const reads = [];
  let patches = 0;
  const run = createReleaseRunner({
    root: f.root,
    identity,
    head: async (spec) =>
      commits[
        Object.keys(REPOSITORIES).find(
          (name) => REPOSITORIES[name].name === spec.name,
        )
      ],
    github: async (path, options = {}) => {
      reads.push(path);
      if (path.startsWith("git/"))
        return remote.draft
          ? null
          : { object: { type: "commit", sha: commits.project } };
      assert.equal(path, "releases/" + remote.id);
      if (options.method === "PATCH") {
        patches++;
        publishRemote(remote);
      } else assert.equal(options.method, undefined);
      return structuredClone(remote);
    },
    uploadAsset: async () => {
      throw new Error("Already uploaded immutable bytes must be reused");
    },
  });
  assert.equal((await run("upload", f.planPath)).state, "published");
  assert.equal(patches, 1);
  assert.ok(
    reads.every(
      (path) =>
        !path.startsWith("releases/tags/") && !path.startsWith("releases?"),
    ),
  );
});
test("tag lookup 404 discovers the unique actual draft and skips its uploaded first asset", async () => {
  const f = await fixture(),
    p = await packageFixture(f),
    remote = releaseRemote(f, p.evidence, 1, true),
    uploads = [];
  let lists = 0,
    creates = 0;
  const run = createReleaseRunner({
    root: f.root,
    identity,
    head: async (spec) =>
      commits[
        Object.keys(REPOSITORIES).find(
          (name) => REPOSITORIES[name].name === spec.name,
        )
      ],
    github: async (path, options = {}) => {
      if (path.startsWith("git/"))
        return remote.draft
          ? null
          : { object: { type: "commit", sha: commits.project } };
      if (path.startsWith("releases/tags/")) {
        assert.equal(options.optional, true);
        return null;
      }
      if (path === "releases?per_page=100&page=1") {
        lists++;
        return [structuredClone(remote)];
      }
      if (options.method === "POST") {
        creates++;
        throw new Error("Existing draft must not be recreated");
      }
      assert.equal(path, "releases/" + remote.id);
      if (options.method === "PATCH") publishRemote(remote);
      return structuredClone(remote);
    },
    uploadAsset: async (id, name, path, digest) => {
      assert.equal(id, remote.id);
      assert.deepEqual(await fileDigest(path), digest);
      uploads.push(name);
      const asset = releaseRemote(
        f,
        p.evidence,
        ASSETS.length,
        true,
      ).assets.find((item) => item.name === name);
      remote.assets.push(asset);
      return asset;
    },
  });
  assert.equal((await run("upload", f.planPath)).state, "published");
  assert.deepEqual(uploads, ASSETS.slice(1));
  assert.equal(creates, 0);
  assert.equal(lists, 1);
});
test("a lost draft creation response is recovered from the release inventory without another POST", async () => {
  const f = await fixture(),
    p = await packageFixture(f);
  let remote = null,
    creates = 0,
    uploaded = 0;
  const run = createReleaseRunner({
    root: f.root,
    identity,
    head: async (spec) =>
      commits[
        Object.keys(REPOSITORIES).find(
          (name) => REPOSITORIES[name].name === spec.name,
        )
      ],
    github: async (path, options = {}) => {
      if (path.startsWith("git/"))
        return remote && !remote.draft
          ? { object: { type: "commit", sha: commits.project } }
          : null;
      if (path.startsWith("releases/tags/")) return null;
      if (path.startsWith("releases?"))
        return remote ? [structuredClone(remote)] : [];
      if (options.method === "POST") {
        creates++;
        remote = releaseRemote(f, p.evidence, 0, true);
        throw new Error("Draft POST response was lost");
      }
      assert.equal(path, "releases/" + remote.id);
      if (options.method === "PATCH") publishRemote(remote);
      return structuredClone(remote);
    },
    uploadAsset: async (_, name) => {
      uploaded++;
      const asset = releaseRemote(
        f,
        p.evidence,
        ASSETS.length,
        true,
      ).assets.find((item) => item.name === name);
      remote.assets.push(asset);
      return asset;
    },
  });
  await assert.rejects(run("upload", f.planPath), /response was lost/);
  await assert.rejects(fs.stat(join(f.folder, "upload.json")), {
    code: "ENOENT",
  });
  assert.equal((await run("upload", f.planPath)).state, "published");
  assert.equal(creates, 1);
  assert.equal(uploaded, ASSETS.length);
});
test("ambiguous draft tags, foreign source and a truncated release inventory cannot create or publish", async () => {
  const f = await fixture(),
    p = await packageFixture(f),
    remote = releaseRemote(f, p.evidence, 1, true);
  const cases = [
    {
      items: [remote, { ...remote, id: 92 }],
      error: /Multiple GitHub releases/,
    },
    {
      items: [{ ...remote, target_commitish: "d".repeat(40) }],
      error: /different source/,
    },
    {
      items: [{ ...remote, draft: false }],
      error: /published release requires review/,
    },
    {
      items: Array.from({ length: 100 }, (_, i) => ({
        id: 1000 + i,
        tag_name: "v0.0." + i,
      })),
      error: /bounded scan/,
      pages: 20,
    },
  ];
  for (const scenario of cases) {
    let writes = 0,
      lists = 0;
    const run = createReleaseRunner({
      root: f.root,
      identity,
      github: async (path, options = {}) => {
        if (options.method) writes++;
        if (path.startsWith("releases/tags/")) return null;
        assert.equal(path, "releases?per_page=100&page=" + ++lists);
        return structuredClone(scenario.items);
      },
    });
    await assert.rejects(run("upload", f.planPath), scenario.error);
    assert.equal(writes, 0);
    assert.equal(lists, scenario.pages ?? 1);
  }
});
test("invalid or unavailable private release receipts never fall back to creating an unrelated draft", async () => {
  const f = await fixture(),
    p = await packageFixture(f),
    remote = releaseRemote(f, p.evidence, 1, true),
    receipt = {
      state: "draft",
      key: f.plan.key,
      tag: f.plan.tag,
      releaseId: remote.id,
    };
  for (const invalid of [
    null,
    false,
    [],
    { ...receipt, key: "0".repeat(64) },
    { ...receipt, tag: "v9.9.9" },
    { ...receipt, releaseId: -1 },
    { ...receipt, state: "published" },
    { ...receipt, state: "uploading" },
    {
      ...receipt,
      state: "uploading",
      pendingAsset: { name: ASSETS[0], size: 1, sha256: "0".repeat(64) },
    },
  ]) {
    await json(join(f.folder, "upload.json"), invalid);
    const run = createReleaseRunner({
      root: f.root,
      identity,
      github: async () => {
        throw new Error("Invalid receipt cannot query or mutate remote state");
      },
    });
    await assert.rejects(run("upload", f.planPath), /Private upload receipt/);
  }
  await json(join(f.folder, "upload.json"), receipt);
  for (const response of [
    null,
    { ...remote, id: 92 },
    { ...remote, target_commitish: "d".repeat(40) },
  ]) {
    const run = createReleaseRunner({
      root: f.root,
      identity,
      github: async (path, options) => {
        assert.equal(path, "releases/" + receipt.releaseId);
        assert.equal(options.optional, true);
        return response;
      },
    });
    await assert.rejects(
      run("upload", f.planPath),
      /unavailable or changed|different source/,
    );
  }
  await fs.chmod(join(f.folder, "upload.json"), 0o644);
  const run = createReleaseRunner({
    root: f.root,
    identity,
    github: async () => {
      throw new Error("Unsafe receipt must fail locally");
    },
  });
  await assert.rejects(
    run("upload", f.planPath),
    /Unsafe regular\/private release file/,
  );
});
test("draft confirmation cannot switch release IDs or observed namespaces before publication", async () => {
  const f = await fixture(),
    p = await packageFixture(f),
    remote = releaseRemote(f, p.evidence, ASSETS.length, true);
  for (const changed of [
    { id: 92 },
    {
      html_url: remote.html_url.replace(
        "638fc49470ae7e474d83",
        "00000000000000000000",
      ),
    },
  ]) {
    await fs.rm(join(f.folder, "upload.json"), { force: true });
    let writes = 0;
    const run = createReleaseRunner({
      root: f.root,
      identity,
      head: async (spec) =>
        commits[
          Object.keys(REPOSITORIES).find(
            (name) => REPOSITORIES[name].name === spec.name,
          )
        ],
      github: async (path, options = {}) => {
        if (options.method) writes++;
        if (path.startsWith("releases/tags/")) return structuredClone(remote);
        assert.equal(path, "releases/" + remote.id);
        return { ...structuredClone(remote), ...changed };
      },
    });
    await assert.rejects(
      run("upload", f.planPath),
      /Draft source\/state changed/,
    );
    assert.equal(writes, 0);
  }
});
test("failed local published-state write can retry after remote publication without duplicate uploads", async () => {
  const f = await fixture(),
    p = await packageFixture(f),
    remote = releaseRemote(f, p.evidence);
  await fs.mkdir(join(f.folder, "published.json"));
  let uploaded = false;
  const run = createReleaseRunner({
    root: f.root,
    identity,
    github: async (path) =>
      path.startsWith("git/")
        ? { object: { type: "commit", sha: commits.project } }
        : remote,
    uploadAsset: async () => {
      uploaded = true;
    },
  });
  await assert.rejects(run("upload", f.planPath));
  await fs.rmdir(join(f.folder, "published.json"));
  assert.equal((await run("upload", f.planPath)).state, "published");
  assert.equal(uploaded, false);
});
test("failed zero-byte draft upload is removed only with the exact private pending-upload proof", async () => {
  const f = await fixture(),
    p = await packageFixture(f);
  let remote = releaseRemote(f, p.evidence, 6, true),
    deletes = 0;
  remote.assets.push({
    id: 77,
    name: "SHA256SUMS",
    state: "starter",
    size: 0,
    digest: null,
  });
  await json(join(f.folder, "upload.json"), {
    state: "uploading",
    key: f.plan.key,
    releaseId: remote.id,
    tag: f.plan.tag,
    pendingAsset: { name: "SHA256SUMS", ...p.evidence.SHA256SUMS },
  });
  const run = createReleaseRunner({
    root: f.root,
    identity,
    head: async (spec) =>
      commits[
        Object.keys(REPOSITORIES).find(
          (name) => REPOSITORIES[name].name === spec.name,
        )
      ],
    github: async (path, options = {}) => {
      if (path.startsWith("git/"))
        return remote.draft
          ? null
          : { object: { type: "commit", sha: commits.project } };
      if (options.method === "DELETE") {
        assert.equal(path, "releases/assets/77");
        deletes++;
        remote.assets = remote.assets.filter((asset) => asset.id !== 77);
        return null;
      }
      if (options.method === "PATCH") {
        publishRemote(remote);
      }
      return structuredClone(remote);
    },
    uploadAsset: async (_, name) => {
      assert.equal(name, "SHA256SUMS");
      const asset = releaseRemote(f, p.evidence, ASSETS.length, true).assets.at(
        -1,
      );
      remote.assets.push(asset);
      return asset;
    },
  });
  assert.equal((await run("upload", f.planPath)).state, "published");
  assert.equal(deletes, 1);
});
test("unknown starter or nonempty failed upload refuses destructive recovery", async () => {
  const f = await fixture(),
    p = await packageFixture(f),
    remote = releaseRemote(f, p.evidence, 6, true);
  remote.assets.push({
    id: 77,
    name: "SHA256SUMS",
    state: "starter",
    size: 1,
    digest: null,
  });
  await json(join(f.folder, "upload.json"), {
    state: "uploading",
    key: f.plan.key,
    releaseId: remote.id,
    tag: f.plan.tag,
    pendingAsset: { name: "SHA256SUMS", ...p.evidence.SHA256SUMS },
  });
  let writes = 0;
  const run = createReleaseRunner({
    root: f.root,
    identity,
    head: async (spec) =>
      commits[
        Object.keys(REPOSITORIES).find(
          (name) => REPOSITORIES[name].name === spec.name,
        )
      ],
    github: async (_, options = {}) => {
      if (options.method) writes++;
      return remote;
    },
  });
  await assert.rejects(run("upload", f.planPath), /requires review/);
  assert.equal(writes, 0);
});
test("recovering an older published release never downgrades the current project pointer", async () => {
  const f = await fixture(),
    p = await packageFixture(f),
    remote = releaseRemote(f, p.evidence);
  await json(join(f.root, "project-release-current.json"), {
    key: "newer",
    publishedAt: "2026-10-07T00:00:00Z",
  });
  const run = createReleaseRunner({
    root: f.root,
    identity,
    github: async (path) =>
      path.startsWith("git/")
        ? { object: { type: "commit", sha: commits.project } }
        : remote,
  });
  await run("upload", f.planPath);
  assert.equal(
    (await read(join(f.root, "project-release-current.json"))).key,
    "newer",
  );
});
test("record-build saves numeric build IDs only after real gate and three-SHA proof", async () => {
  const f = await fixture(),
    manifest = webManifest(f.plan),
    run = createReleaseRunner({
      root: f.root,
      identity,
      jenkins: async (kind, number, plan) => ({
        result: build(kind, number, plan),
        get: webArtifacts(manifest),
        response: async () => ({ body: [Buffer.from("real archive bytes")] }),
      }),
    });
  const result = await run("record-build", f.planPath, "web", "7");
  assert.equal(result.savedBuilds.web, 7);
  assert.equal(typeof result.savedBuilds.web, "number");
  assert.equal(result.savedBuilds.contract, undefined);
  const bad = createReleaseRunner({
    root: f.root,
    identity,
    jenkins: async (kind, number, plan) => ({
      result: build(kind, number, plan, "FAILURE"),
    }),
  });
  await assert.rejects(
    bad("record-build", f.planPath, "contract", "8"),
    /SUCCESS/,
  );
});
test("Web parent retains an independently verified exact-three-SHA contract child in the same private record", async () => {
  const f = await fixture(),
    report = crossReport(f.plan),
    manifest = webManifest(f.plan),
    queries = [];
  const run = createReleaseRunner({
    root: f.root,
    identity,
    jenkins: async (kind, number, plan) => {
      queries.push({ kind, number });
      return {
        result: build(kind, number, plan),
        get: webArtifacts(manifest, report),
        response: async () => ({ body: [Buffer.from("real archive bytes")] }),
      };
    },
  });
  const result = await run("record-build", f.planPath, "web", "7");
  assert.deepEqual(result.savedBuilds, { web: 7, contract: 8 });
  assert.ok(
    queries.some(({ kind, number }) => kind === "contract" && number === 8),
  );
  const records = await read(join(f.folder, "builds.json"));
  assert.equal(records.web.number, 7);
  assert.equal(records.contract.number, 8);
  assert.equal(records.contract.url, buildUrl(JOBS.contract, 8));
  assert.equal(records.contract.webBuildNumber, 7);
  assert.equal(records.contract.webBuildUrl, buildUrl(JOBS.web, 7));
  assert.equal(
    records.contract.webCrossReportSha256,
    sha256(JSON.stringify(report)),
  );
  assert.equal(
    (await fs.stat(join(f.folder, "builds.json"))).mode & 0o777,
    0o600,
  );
  assert.deepEqual(
    (await fs.readdir(join(f.folder, "web-ci-artifacts"))).sort(),
    ["manifest.json", "prebuilt.tar.gz", "source.tar.gz", "storybook.tar.gz"],
  );
});
test("a pruned contract child cannot be restored from Web self-report, while original Web archives remain reusable", async () => {
  const f = await fixture(),
    manifest = webManifest(f.plan);
  let childQueries = 0;
  const run = createReleaseRunner({
    root: f.root,
    identity,
    jenkins: async (kind, number, plan) => {
      if (kind === "contract") {
        childQueries++;
        throw Object.assign(new Error("Pruned child"), { status: 404 });
      }
      return {
        result: build(kind, number, plan),
        get: webArtifacts(manifest, crossReport(plan)),
        response: async () => ({ body: [Buffer.from("real archive bytes")] }),
      };
    },
  });
  assert.deepEqual(
    (await run("record-build", f.planPath, "web", "7")).savedBuilds,
    { web: 7 },
  );
  assert.equal(childQueries, 1);
  assert.equal((await read(join(f.folder, "builds.json"))).contract, undefined);
  assert.equal(
    (await fileDigest(join(f.folder, "web-ci-artifacts", "prebuilt.tar.gz")))
      .sha256,
    manifest.archives["prebuilt.tar.gz"].sha256,
  );
});
test("cross report must match its parent, canonical child, all three commits and exact parameter schema before retaining bytes", async () => {
  const mutations = [
    (r) => {
      r.extra = "unreviewed";
    },
    (r) => {
      r.schemaVersion = 2;
    },
    (r) => {
      r.job = JOBS.release;
    },
    (r) => {
      r.buildNumber = 9;
    },
    (r) => {
      r.state = "failed";
    },
    (r) => {
      r.commits.root = "d".repeat(40);
    },
    (r) => {
      r.commits.api = "d".repeat(40);
    },
    (r) => {
      r.commits.web = "d".repeat(40);
    },
    (r) => {
      r.commits.other = commits.api;
    },
    (r) => {
      r.child.job = JOBS.api;
    },
    (r) => {
      r.child.number = "8";
    },
    (r) => {
      r.child.result = "FAILURE";
    },
    (r) => {
      r.child.url = "http://attacker.invalid/job/agent-platform-contract/8/";
    },
    (r) => {
      r.parameters.API_SHA = "d".repeat(40);
    },
    (r) => {
      r.parameters.REF = "refs/heads/feat/design-v2-migration";
    },
  ];
  for (const mutate of mutations) {
    const f = await fixture(),
      report = crossReport(f.plan);
    mutate(report);
    let childQueries = 0,
      downloads = 0;
    const run = createReleaseRunner({
      root: f.root,
      identity,
      jenkins: async (kind, number, plan) => {
        if (kind === "contract") childQueries++;
        return {
          result: build(kind, number, plan),
          get: webArtifacts(webManifest(plan), report),
          response: async () => {
            downloads++;
            return { body: [] };
          },
        };
      },
    });
    await assert.rejects(
      run("record-build", f.planPath, "web", "7"),
      /cross-repository evidence/,
    );
    assert.equal(childQueries, 0);
    assert.equal(downloads, 0);
    assert.deepEqual(await fs.readdir(f.folder), ["plan.json"]);
  }
});
test("Web artifact SUCCESS cannot hide actual failed, incomplete or wrong-commit Jenkins child", async () => {
  for (const replacement of [
    "FAILURE",
    "INCOMPLETE",
    "wrong-commit",
    "wrong-url",
  ]) {
    const f = await fixture();
    let downloads = 0;
    const run = createReleaseRunner({
      root: f.root,
      identity,
      jenkins: async (kind, number, plan) => {
        const result = build(kind, number, plan);
        if (kind === "contract") {
          if (replacement === "wrong-commit")
            result.actions[0].parameters[1].value = "d".repeat(40);
          else if (replacement === "wrong-url")
            result.url = buildUrl(JOBS.api, number);
          else result.result = replacement;
        }
        return {
          result,
          get: webArtifacts(webManifest(plan), crossReport(plan)),
          response: async () => {
            downloads++;
            return { body: [] };
          },
        };
      },
    });
    await assert.rejects(
      run("record-build", f.planPath, "web", "7"),
      /SUCCESS|different pinned commits/,
    );
    assert.equal(downloads, 0);
    assert.deepEqual(await fs.readdir(f.folder), ["plan.json"]);
  }
});
test("retained Web retry excludes a subsequently pruned child from savedBuilds without replacing its original bits", async () => {
  const f = await fixture(),
    manifest = webManifest(f.plan),
    run = createReleaseRunner({
      root: f.root,
      identity,
      jenkins: async (kind, number, plan) => ({
        result: build(kind, number, plan),
        get: webArtifacts(manifest, crossReport(plan)),
        response: async () => ({ body: [Buffer.from("real archive bytes")] }),
      }),
    });
  await run("record-build", f.planPath, "web", "7");
  const before = await fileDigest(
    join(f.folder, "web-ci-artifacts", "prebuilt.tar.gz"),
  );
  const pruned = createReleaseRunner({
    root: f.root,
    identity,
    jenkins: async () => {
      throw Object.assign(new Error("Pruned Jenkins history"), { status: 404 });
    },
  });
  assert.deepEqual(
    (await pruned("record-build", f.planPath, "web", "7")).savedBuilds,
    { web: 7 },
  );
  assert.equal((await read(join(f.folder, "builds.json"))).contract.number, 8);
  assert.deepEqual(
    await fileDigest(join(f.folder, "web-ci-artifacts", "prebuilt.tar.gz")),
    before,
  );
});
test("API package proof requires pinned Linux Docker bytes and its actual native import probe", () => {
  const value = {
    state: "packaged",
    sha: commits.api,
    rootSha: commits.project,
    artifact: "/trusted/workspace/api-package-6.tgz",
    sha256: "a".repeat(64),
    sizeBytes: 80,
    files: 2,
    platform: "linux",
    arch: "arm64",
    nodeMajor: 22,
    imageId: "sha256:" + "d".repeat(64),
    boxliteVersion: "0.9.7",
    nativeProbe: "passed",
  };
  validateApiPackage(value, 6, commits.api, commits.project);
  for (const replacement of [
    { artifact: "/trusted/workspace/api-package-7.tgz" },
    { sha: commits.web },
    { rootSha: commits.web },
    { sizeBytes: 0 },
    { nativeProbe: "not-run" },
    { platform: "darwin" },
    { arch: "x64" },
    { nodeMajor: 26 },
    { imageId: "mutable-tag" },
    { boxliteVersion: "0.9.6" },
  ])
    assert.throws(() =>
      validateApiPackage(
        { ...value, ...replacement },
        6,
        commits.api,
        commits.project,
      ),
    );
});
test("API child accepts real ci-passed receipt path and refuses stale draft-state assumptions", async () => {
  const f = await fixture();
  let ci = {
      state: "ci-passed",
      sha: commits.api,
      rootSha: commits.project,
      runId: 6,
      artifactPath: join(
        f.root,
        "releases",
        commits.project + "-" + commits.api,
      ),
      imageId: "sha256:" + "d".repeat(64),
      nativeProbe: "passed",
    },
    receipts = 0;
  const run = createReleaseRunner({
    root: f.root,
    identity,
    apiReceipt: async (_, __, value) => {
      assert.equal(value.artifactPath, ci.artifactPath);
      receipts++;
    },
    jenkins: async (kind, number, plan) => ({
      result: build(kind, number, plan),
      get: async (path) =>
        path === "artifact/ci.json"
          ? ci
          : {
              state: "current",
              sha: commits.api,
              rootSha: commits.project,
              imageId: ci.imageId,
            },
    }),
  });
  assert.equal((await run("record-build", f.planPath, "api", "6")).number, 6);
  assert.equal(receipts, 1);
  ci = { ...ci, runId: 7, state: "built" };
  await assert.rejects(
    run("record-build", f.planPath, "api", "7"),
    /Docker release/,
  );
  ci = { ...ci, state: "ci-passed", artifactPath: "/untrusted/" + commits.api };
  await assert.rejects(
    run("record-build", f.planPath, "api", "7"),
    /Docker release/,
  );
});
test("retained immutable web proof survives Jenkins build pruning and keeps original numeric ID", async () => {
  const f = await fixture(),
    manifest = webManifest(f.plan),
    bytes = Buffer.from("real archive bytes");
  const root = join(f.root, "web-releases", f.plan.key);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await json(join(root, "manifest.json"), manifest);
  for (const name of Object.keys(manifest.archives))
    await fs.writeFile(join(root, name), bytes, { mode: 0o600 });
  const run = createReleaseRunner({
    root: f.root,
    identity,
    jenkins: async (kind, number, plan) => ({
      result: build(kind, number, plan),
      get: webArtifacts(manifest),
      response: async () => ({ body: [bytes] }),
    }),
  });
  await run("record-build", f.planPath, "web", "7");
  const retained = createReleaseRunner({
    root: f.root,
    identity,
    head: async (spec) =>
      commits[
        Object.keys(REPOSITORIES).find(
          (name) => REPOSITORIES[name].name === spec.name,
        )
      ],
    jenkins: async () => {
      throw Object.assign(new Error("pruned"), { status: 404 });
    },
  });
  assert.equal((await retained("plan")).savedBuilds.web, 7);
  assert.equal(
    (await retained("record-build", f.planPath, "web", "7")).number,
    7,
  );
  await fs.appendFile(
    join(f.folder, "web-ci-artifacts", "prebuilt.tar.gz"),
    "tamper",
  );
  await assert.rejects(retained("plan"), /changed after Jenkins/);
  assert.equal(
    await fs.readFile(join(root, "prebuilt.tar.gz"), "utf8"),
    bytes.toString(),
  );
});
test("pre-adoption original archives survive pruned Jenkins history and fetch without rebuilding", async () => {
  const f = await fixture(),
    bytes = Buffer.from("real archive bytes"),
    manifest = webManifest(f.plan);
  let downloads = 0;
  const run = createReleaseRunner({
    root: f.root,
    identity,
    jenkins: async (kind, number, plan) => ({
      result: build(kind, number, plan),
      get: webArtifacts(manifest),
      response: async () => {
        downloads++;
        return { body: [bytes] };
      },
    }),
  });
  await run("record-build", f.planPath, "web", "7");
  const cache = join(f.folder, "web-ci-artifacts");
  assert.equal((await fs.stat(cache)).mode & 0o777, 0o700);
  assert.equal(
    (await fs.stat(join(cache, "prebuilt.tar.gz"))).mode & 0o777,
    0o600,
  );
  assert.equal(downloads, 3);
  await assert.rejects(fs.stat(join(f.root, "web-releases", f.plan.key)), {
    code: "ENOENT",
  });
  const retained = createReleaseRunner({
    root: f.root,
    identity,
    head: async (spec) =>
      commits[
        Object.keys(REPOSITORIES).find(
          (name) => REPOSITORIES[name].name === spec.name,
        )
      ],
    jenkins: async () => {
      throw Object.assign(new Error("pruned"), { status: 404 });
    },
  });
  assert.equal((await retained("plan")).savedBuilds.web, 7);
  assert.equal(
    (await retained("record-build", f.planPath, "web", "7")).number,
    7,
  );
  const work = join(f.root, "jenkins-agent", "workspace", "fresh");
  await fs.mkdir(work, { recursive: true, mode: 0o700 });
  const result = await retained("fetch-web", f.planPath, "7", work);
  assert.equal(
    (await fileDigest(join(result.artifacts, "prebuilt.tar.gz"))).sha256,
    sha256(bytes),
  );
  assert.equal(
    (await read(join(result.artifacts, "manifest.json"))).jenkins.buildNumber,
    7,
  );
  assert.equal(downloads, 3);
  await assert.rejects(
    run("record-build", f.planPath, "web", "8"),
    /immutable build evidence/,
  );
});
test("failed stream cannot leave a green saved build or a half-retained archive cache", async () => {
  const f = await fixture(),
    manifest = webManifest(f.plan);
  const run = createReleaseRunner({
    root: f.root,
    identity,
    jenkins: async (kind, number, plan) => ({
      result: build(kind, number, plan),
      get: webArtifacts(manifest),
      response: async () => ({ body: [Buffer.from("bad bytes")] }),
    }),
  });
  await assert.rejects(run("record-build", f.planPath, "web", "7"), /digest/);
  await assert.rejects(fs.stat(join(f.folder, "builds.json")), {
    code: "ENOENT",
  });
  await assert.rejects(fs.stat(join(f.folder, "web-ci-artifacts")), {
    code: "ENOENT",
  });
  assert.deepEqual(await fs.readdir(f.folder), ["plan.json"]);
});
test("CI cache is created only after a real matching SUCCESS, never from manifest gateResult alone", async () => {
  const f = await fixture(),
    manifest = webManifest(f.plan);
  let downloads = 0;
  const run = createReleaseRunner({
    root: f.root,
    identity,
    jenkins: async (kind, number, plan) => ({
      result: build(kind, number, plan, "UNSTABLE"),
      get: webArtifacts(manifest),
      response: async () => {
        downloads++;
        return { body: [Buffer.from("real archive bytes")] };
      },
    }),
  });
  await assert.rejects(run("record-build", f.planPath, "web", "7"), /SUCCESS/);
  assert.equal(downloads, 0);
  assert.deepEqual(await fs.readdir(f.folder), ["plan.json"]);
});
test("fetch-web verifies actual manifest and byte streams before atomic trusted workspace adoption", async () => {
  const f = await fixture(),
    bytes = Buffer.from("real archive bytes"),
    manifest = webManifest(f.plan),
    work = join(f.root, "jenkins-agent", "workspace", "fresh");
  await fs.mkdir(work, { recursive: true, mode: 0o700 });
  const run = createReleaseRunner({
    root: f.root,
    identity,
    head: async (spec) =>
      commits[
        Object.keys(REPOSITORIES).find(
          (name) => REPOSITORIES[name].name === spec.name,
        )
      ],
    jenkins: async (kind, number, plan) => ({
      result: build(kind, number, plan),
      get: webArtifacts(manifest),
      response: async () => ({
        body: [bytes.subarray(0, 4), bytes.subarray(4)],
      }),
    }),
  });
  const result = await run("fetch-web", f.planPath, "7", work);
  assert.equal(
    (await fileDigest(join(result.artifacts, "prebuilt.tar.gz"))).sha256,
    sha256(bytes),
  );
  await assert.rejects(
    run("fetch-web", f.planPath, "7", f.root),
    /isolated trusted/,
  );
  await assert.rejects(run("fetch-web", f.planPath, "7", work), /fresh/);
});
test("fetch-web tampered stream leaves no adopted folder", async () => {
  const f = await fixture(),
    manifest = webManifest(f.plan),
    work = join(f.root, "jenkins-agent", "fresh");
  await fs.mkdir(work, { recursive: true, mode: 0o700 });
  const run = createReleaseRunner({
    root: f.root,
    identity,
    head: async (spec) =>
      commits[
        Object.keys(REPOSITORIES).find(
          (name) => REPOSITORIES[name].name === spec.name,
        )
      ],
    jenkins: async (kind, number, plan) => ({
      result: build(kind, number, plan),
      get: webArtifacts(manifest),
      response: async () => ({ body: [Buffer.from("wrong")] }),
    }),
  });
  await assert.rejects(run("fetch-web", f.planPath, "7", work), /digest/);
  assert.deepEqual(await fs.readdir(work), []);
});
function sourceRefs(extra = {}) {
  return Object.fromEntries(
    Object.entries(REPOSITORIES).map(([name, spec]) => [
      name,
      [
        { ref: "refs/heads/" + spec.branch, sha: commits[name] },
        ...(extra[name] ?? []),
      ],
    ]),
  );
}
async function discoveryFixture(extra = {}) {
  const tools = await temporary(),
    deployRoot = await temporary(),
    refs = sourceRefs(extra),
    queueCalls = [],
    statuses = [],
    builds = {},
    queueItems = new Map();
  let next = 1;
  const jenkins = {
    queue: async (job, params) => {
      queueCalls.push({ job, params });
      const id = next++;
      const item = {
        id,
        task: { name: job },
        actions: [
          {
            parameters: Object.entries(params).map(([name, value]) => ({
              name,
              value,
            })),
          },
        ],
      };
      queueItems.set(id, item);
      return "http://127.0.0.1:8080/queue/item/" + id + "/";
    },
    get: async (path) => {
      if (path === "queue/api/json") return { items: [...queueItems.values()] };
      const queue = /^queue\/item\/(\d+)\/api\/json$/.exec(path);
      if (queue) {
        const item = queueItems.get(Number(queue[1]));
        if (!item) throw Object.assign(new Error("not found"), { status: 404 });
        return item;
      }
      const history = /^job\/([^/]+)\/api\/json/.exec(path);
      if (history) return { builds: builds[history[1]] ?? [] };
      const build = /^job\/([^/]+)\/(\d+)\/api\/json$/.exec(path);
      if (build) {
        const item = (builds[build[1]] ?? []).find(
          (value) => value.number === Number(build[2]),
        );
        if (item) return item;
      }
      throw Object.assign(new Error("not found"), { status: 404 });
    },
  };
  const options = {
    tools,
    deployRoot,
    refs: async (_, name) => refs[name],
    pulls: async () => [],
    jenkins,
    status: async (item) => {
      statuses.push(item);
    },
    changedImage: async () => false,
  };
  return {
    tools,
    deployRoot,
    refs,
    queueCalls,
    statuses,
    builds,
    queueItems,
    options,
    discover: createDiscoverer(options),
    state: () => read(join(tools, "discovery-state.json")),
  };
}
async function markCurrent(f) {
  await json(join(f.deployRoot, "project-release-current.json"), {
    state: "published",
    commits,
    key: projectKey(commits),
  });
}
test("Jenkins URL policy rejects foreign jobs, userinfo, query and cross-host redirects", () => {
  assert.equal(
    isTrustedJenkinsLocation("http://127.0.0.1:8080/queue/item/12/"),
    true,
  );
  assert.equal(
    isTrustedJenkinsLocation(
      "http://127.0.0.1:8080/job/agent-platform-web/3/",
      DISCOVERY_JOBS.web,
    ),
    true,
  );
  for (const url of [
    "http://127.0.0.1:8080/job/arbitrary/1/",
    "http://evil.invalid/queue/item/1/",
    "http://a@127.0.0.1:8080/queue/item/1/",
    "http://127.0.0.1:8080/queue/item/1/?next=evil",
    "http://127.0.0.1:8080/job/agent-platform-api/1/",
  ])
    assert.equal(isTrustedJenkinsLocation(url, DISCOVERY_JOBS.web), false);
});
test("persisted requests cannot supply alternate refs or unreviewed job parameters", () => {
  assert.equal(
    validRequest({
      repo: "api",
      sha: commits.api,
      ref: "refs/heads/main",
      key: "api:refs/heads/main",
      job: DISCOVERY_JOBS.api,
      params: { SHA: commits.api, REF: "refs/heads/main" },
    }),
    true,
  );
  assert.equal(
    validRequest({
      repo: "api",
      sha: commits.api,
      ref: "refs/heads/main",
      key: "x",
      job: DISCOVERY_JOBS.api,
      params: { SHA: commits.api, REF: "refs/heads/main", SCRIPT: "root" },
    }),
    false,
  );
  assert.equal(
    parametersMatch(
      {
        actions: [
          {
            parameters: [
              { name: "SHA", value: commits.api },
              { name: "SHA", value: commits.api },
            ],
          },
        ],
      },
      { SHA: commits.api },
    ),
    false,
  );
});
test("first discovery builds main/open PR across three repos while baselining historical API branches", async () => {
  const f = await discoveryFixture({
    api: [
      { ref: "refs/heads/main", sha: commits.api },
      { ref: "refs/heads/old", sha: "e".repeat(40) },
      { ref: "refs/pull/2/head", sha: "f".repeat(40) },
    ],
    web: [{ ref: "refs/heads/main", sha: commits.web }],
    project: [{ ref: "refs/pull/3/head", sha: "2".repeat(40) }],
  });
  await markCurrent(f);
  const result = await f.discover();
  assert.equal(result.queued.length, 5);
  assert.equal(
    f.queueCalls.filter((item) => item.job === DISCOVERY_JOBS.api).length,
    2,
  );
  assert.equal(
    f.queueCalls.some((item) => item.params.REF === "refs/heads/old"),
    false,
  );
  assert.deepEqual(
    new Set(f.statuses.map((item) => item.repo)),
    new Set(["api", "web", "project"]),
  );
  assert.equal(
    f.queueCalls.find((item) => item.job === DISCOVERY_JOBS.web).params.API_SHA,
    commits.api,
  );
});
test("GitHub status failure cannot discard queued work or queue twice on the next poll", async () => {
  const f = await discoveryFixture({
    api: [{ ref: "refs/heads/main", sha: commits.api }],
  });
  await markCurrent(f);
  const failing = createDiscoverer({
    ...f.options,
    status: async () => {
      const s = await f.state();
      assert.equal(s.pending.length, 3);
      assert.equal(s.refs["api:refs/heads/main"], commits.api);
      throw new Error("GitHub unavailable");
    },
  });
  assert.equal((await failing()).pendingStatuses, 3);
  await failing();
  assert.equal(f.queueCalls.length, 3);
  assert.equal((await f.discover()).pendingStatuses, 0);
});
test("queue 404 recovers the actual build by matching source parameters and completes repo-specific status", async () => {
  const f = await discoveryFixture({
    web: [{ ref: "refs/heads/main", sha: commits.web }],
  });
  await markCurrent(f);
  await f.discover();
  const item = (await f.state()).pending.find((item) => item.repo === "web"),
    number = 22;
  f.queueItems.delete(
    Number(new URL(item.location).pathname.split("/").at(-2)),
  );
  f.builds[DISCOVERY_JOBS.web] = [
    {
      number,
      url:
        "http://127.0.0.1:8080/job/" + DISCOVERY_JOBS.web + "/" + number + "/",
      building: false,
      result: "SUCCESS",
      actions: [
        {
          parameters: Object.entries(item.params).map(([name, value]) => ({
            name,
            value,
          })),
        },
      ],
    },
  ];
  const result = await f.discover();
  assert.equal(result.pending, 2);
  assert.equal(
    (await f.state()).pending.some((item) => item.repo === "web"),
    false,
  );
  assert.equal(f.queueCalls.length, 3);
  assert.equal(f.statuses.at(-1).context, "jenkins/web-ci");
  assert.equal(f.statuses.at(-1).state, "success");
});
test("vanished queue without actual matching build retries instead of remaining permanently pending", async () => {
  const f = await discoveryFixture({
    api: [{ ref: "refs/heads/main", sha: commits.api }],
  });
  await markCurrent(f);
  await f.discover();
  const item = (await f.state()).pending.find((item) => item.repo === "api");
  f.queueItems.delete(
    Number(new URL(item.location).pathname.split("/").at(-2)),
  );
  const result = await f.discover();
  assert.equal(result.completed[0].result, "LOST_QUEUE_RETRY");
  assert.equal(
    f.queueCalls.filter((item) => item.job === DISCOVERY_JOBS.api).length,
    2,
  );
  assert.equal(f.queueCalls.length, 4);
  assert.equal(result.pending, 3);
});
test("three-head production changes queue one full release; unchanged current and live duplicate do not", async () => {
  const f = await discoveryFixture();
  const first = await f.discover();
  assert.equal(first.queued.length, 4);
  const release = f.queueCalls.find(
    (item) => item.job === DISCOVERY_JOBS.release,
  );
  assert.equal(release.params.REQUEST_KEY, projectKey(commits));
  assert.equal(
    f.queueCalls.filter((item) => item.job === DISCOVERY_JOBS.release).length,
    1,
  );
  await f.discover();
  assert.equal(f.queueCalls.length, 4);
  await markCurrent(f);
  await f.discover();
  assert.equal(f.queueCalls.length, 4);
});
test("discovery recovers an already queued full release after local state loss", async () => {
  const f = await discoveryFixture();
  await f.options.jenkins.queue(DISCOVERY_JOBS.release, {
    TAG: "",
    REQUEST_KEY: projectKey(commits),
  });
  await f.discover();
  assert.equal(f.queueCalls.length, 4);
  assert.equal(
    f.queueCalls.filter((item) => item.job === DISCOVERY_JOBS.release).length,
    1,
  );
  assert.equal((await f.state()).pending.length, 4);
});
test("UNSTABLE full publication is retried by the next discovery rather than treated as published", async () => {
  const f = await discoveryFixture();
  await f.discover();
  const item = (await f.state()).pending.find(
    (item) => item.job === DISCOVERY_JOBS.release,
  );
  f.queueItems.delete(
    Number(new URL(item.location).pathname.split("/").at(-2)),
  );
  f.builds[DISCOVERY_JOBS.release] = [
    {
      number: 11,
      url: "http://127.0.0.1:8080/job/" + DISCOVERY_JOBS.release + "/11/",
      building: false,
      result: "UNSTABLE",
      actions: [
        {
          parameters: Object.entries(item.params).map(([name, value]) => ({
            name,
            value,
          })),
        },
      ],
    },
  ];
  const result = await f.discover();
  assert.equal(result.completed[0].result, "UNSTABLE");
  assert.equal(
    f.queueCalls.filter((item) => item.job === DISCOVERY_JOBS.release).length,
    2,
  );
  assert.equal(f.queueCalls.length, 5);
});
test("ordinary source CI failure is recorded once until a new source commit, without a busy retry loop", async () => {
  const f = await discoveryFixture({
    api: [{ ref: "refs/heads/main", sha: commits.api }],
  });
  await markCurrent(f);
  await f.discover();
  const item = (await f.state()).pending.find((item) => item.repo === "api");
  f.queueItems.delete(
    Number(new URL(item.location).pathname.split("/").at(-2)),
  );
  f.builds[DISCOVERY_JOBS.api] = [
    {
      number: 18,
      url: "http://127.0.0.1:8080/job/" + DISCOVERY_JOBS.api + "/18/",
      building: false,
      result: "FAILURE",
      actions: [
        {
          parameters: Object.entries(item.params).map(([name, value]) => ({
            name,
            value,
          })),
        },
      ],
    },
  ];
  const result = await f.discover();
  assert.equal(result.pending, 2);
  assert.equal(
    (await f.state()).pending.some((item) => item.repo === "api"),
    false,
  );
  assert.equal(f.statuses.at(-1).state, "failure");
  await f.discover();
  assert.equal(
    f.queueCalls.filter((item) => item.job === DISCOVERY_JOBS.api).length,
    1,
  );
  assert.equal(f.queueCalls.length, 3);
});
test("new image tag publishes only its own pinned API source and never historical tags at bootstrap", async () => {
  const f = await discoveryFixture({
    api: [{ ref: "refs/tags/sandbox-image-v1.2.3", sha: commits.api }],
  });
  await markCurrent(f);
  await f.discover();
  assert.equal(
    f.queueCalls.filter((item) => item.job === DISCOVERY_JOBS.images).length,
    0,
  );
  f.refs.api.push({
    ref: "refs/tags/sandbox-image-v1.2.4",
    sha: "d".repeat(40),
  });
  await f.discover();
  assert.deepEqual(
    f.queueCalls.find((item) => item.job === DISCOVERY_JOBS.images),
    {
      job: DISCOVERY_JOBS.images,
      params: {
        SHA: "d".repeat(40),
        REF: "refs/tags/sandbox-image-v1.2.4",
        TAG: "v1.2.4",
        MODE: "publish",
      },
    },
  );
});
test("a failed main image-check queue preserves the old source marker so the next discovery retries before recording main CI", async () => {
  const f = await discoveryFixture();
  await markCurrent(f);
  await f.discover();
  const next = "d".repeat(40);
  f.refs.api = [{ ref: "refs/heads/main", sha: next }];
  let attempts = 0;
  const original = f.options.jenkins.queue;
  f.options.jenkins.queue = async (job, params) => {
    if (job === DISCOVERY_JOBS.images && attempts++ === 0)
      throw new Error("Queue temporarily unavailable");
    return original(job, params);
  };
  const discover = createDiscoverer({
    ...f.options,
    changedImage: async () => true,
  });
  const failed = await discover();
  assert.ok(failed.errors.some((item) => item.key === "api:refs/heads/main"));
  assert.equal((await f.state()).refs["api:refs/heads/main"], commits.api);
  assert.equal(
    f.queueCalls.some(
      (item) => item.job === DISCOVERY_JOBS.api && item.params.SHA === next,
    ),
    false,
  );
  const recovered = await discover();
  assert.equal(recovered.errors.length, 0);
  assert.equal(attempts, 2);
  assert.equal((await f.state()).refs["api:refs/heads/main"], next);
  assert.deepEqual(
    f.queueCalls.find((item) => item.job === DISCOVERY_JOBS.images).params,
    { SHA: next, REF: "refs/heads/main", TAG: "", MODE: "check" },
  );
  assert.ok(
    f.queueCalls.some(
      (item) => item.job === DISCOVERY_JOBS.api && item.params.SHA === next,
    ),
  );
});

test("changed production Dockerfile schedules check, while PR does not publish an image", async () => {
  const f = await discoveryFixture();
  await markCurrent(f);
  await f.discover();
  f.refs.api[0].sha = "d".repeat(40);
  f.refs.api.push({ ref: "refs/pull/4/head", sha: "e".repeat(40) });
  await createDiscoverer({
    ...f.options,
    changedImage: async (before, after) => {
      assert.equal(before, commits.api);
      assert.equal(after, "d".repeat(40));
      return true;
    },
  })();
  assert.equal(
    f.queueCalls.filter((item) => item.job === DISCOVERY_JOBS.images).length,
    1,
  );
  assert.equal(
    f.queueCalls.find((item) => item.job === DISCOVERY_JOBS.images).params.MODE,
    "check",
  );
  assert.equal(
    f.queueCalls.some((item) => item.params.MODE === "publish"),
    false,
  );
});
