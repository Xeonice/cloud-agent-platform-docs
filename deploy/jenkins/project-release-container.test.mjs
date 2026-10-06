import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  deploymentContext,
  assertDeploymentLayout,
  deploymentEnvironment,
  LINUX_DEPLOY,
  jenkinsTransport,
  canonicalJenkinsLocation,
} from "./deployment-platform.mjs";
import {
  verifyDockerSaveArchive,
  createReleaseRunner,
  projectKey,
  REPOSITORIES,
  JOBS,
  buildUrl,
  buildParameters,
} from "./project-release.mjs";
import { createDiscoverer } from "./jenkins-discover.mjs";
import { dockerSaveFixture } from "./fixtures/docker-save.mjs";
import { GATES, WEB } from "./jenkins-web.mjs";

const system = {
  platform: "linux",
  arch: "arm64",
  nodeMajor: 22,
  node: "/usr/local/bin/node",
};
const identity = {
  username: "jenkins",
  uid: 1000,
  gid: 1000,
  homedir: "/home/jenkins",
};
async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "container-release-test-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const writeJson = async (path, value) =>
  fs.writeFile(path, JSON.stringify(value), { mode: 0o600 });

async function webFetchFixture(t, caller = { ...identity, ...system }) {
  const root = await fixture(t),
    tools = join(root, "tools");
  await fs.mkdir(tools, { mode: 0o700 });
  const commits = {
    project: "a".repeat(40),
    api: "b".repeat(40),
    web: "c".repeat(40),
  };
  const plan = {
    schemaVersion: 1,
    key: projectKey(commits),
    tag: "v0.4.1",
    commits,
    repositories: REPOSITORIES,
    createdAt: new Date().toISOString(),
  };
  const folder = join(root, "project-releases", plan.key);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const planPath = join(folder, "plan.json");
  await writeJson(planPath, plan);
  const archives = Object.fromEntries(
    ["source.tar.gz", "prebuilt.tar.gz", "storybook.tar.gz"].map((name) => [
      name,
      Buffer.from("fixture archive stream: " + name),
    ]),
  );
  const manifest = {
    schemaVersion: 1,
    repository: WEB.repository,
    sha: commits.web,
    rootSha: commits.project,
    apiSha: commits.api,
    ref: WEB.ref,
    production: true,
    nodeMajor: 22,
    vercelCli: "62.2.0",
    state: "packaged",
    gates: Object.fromEntries(GATES.map((gate) => [gate, { state: "passed" }])),
    jenkins: { job: JOBS.web, buildNumber: 37, gateResult: "SUCCESS" },
    archives: Object.fromEntries(
      Object.entries(archives).map(([name, bytes]) => [
        name,
        {
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ]),
    ),
  };
  let downloads = 0;
  const runner = createReleaseRunner({
    root,
    tools,
    identity: caller,
    assertLayout: async (context) => {
      assert.equal(context.home, LINUX_DEPLOY.home);
      assert.equal(context.root, root);
    },
    head: async (spec) =>
      commits[
        Object.keys(REPOSITORIES).find(
          (name) => REPOSITORIES[name].name === spec.name,
        )
      ],
    jenkins: async (kind, number, request) => ({
      result: {
        number,
        result: "SUCCESS",
        building: false,
        url: buildUrl(JOBS[kind], number),
        actions: [
          {
            parameters: Object.entries(buildParameters(kind, request)).map(
              ([name, value]) => ({ name, value }),
            ),
          },
        ],
      },
      get: async (path) => {
        assert.equal(path, "artifact/web-artifacts/manifest.json");
        return manifest;
      },
      response: async (path) => {
        const name = path.slice("artifact/web-artifacts/".length);
        assert.equal(path, "artifact/web-artifacts/" + name);
        assert.ok(Object.hasOwn(archives, name));
        downloads++;
        return {
          body: [archives[name].subarray(0, 9), archives[name].subarray(9)],
        };
      },
    }),
  });
  return {
    root,
    runner,
    planPath,
    archives,
    manifest,
    get downloads() {
      return downloads;
    },
  };
}

test("fetch-web selects the actual platform workspace and atomically writes verified archive streams without accepting symlink destinations", async (t) => {
  const caller =
    process.platform === "linux"
      ? { ...identity, ...system }
      : {
          username: "douglasdong",
          homedir: "/Users/douglasdong",
          uid: 501,
          platform: "darwin",
          arch: "arm64",
          nodeMajor: 22,
        };
  const f = await webFetchFixture(t, caller);
  const anchor =
    process.platform === "linux"
      ? "/home/jenkins/agent/workspace"
      : join(f.root, "jenkins-agent");
  await fs.mkdir(anchor, { recursive: true, mode: 0o700 });
  const work = await fs.realpath(
    await fs.mkdtemp(join(anchor, "fetch-web-owned-fixture-")),
  );
  t.after(() => fs.rm(work, { recursive: true, force: true }));
  const result = await f.runner("fetch-web", f.planPath, "37", work);
  assert.equal(result.state, "web-fetched");
  assert.equal(result.workspace, work);
  assert.equal(f.downloads, 3);
  for (const [name, bytes] of Object.entries(f.archives))
    assert.deepEqual(await fs.readFile(join(result.artifacts, name)), bytes);
  assert.deepEqual(
    JSON.parse(await fs.readFile(join(result.artifacts, "manifest.json"))),
    f.manifest,
  );
  assert.deepEqual((await fs.readdir(work)).sort(), ["web-artifacts"]);
  await assert.rejects(f.runner("fetch-web", f.planPath, "37", work), /fresh/);
  const external = join(f.root, "outside-workspace");
  await fs.mkdir(join(external, "nested"), { recursive: true, mode: 0o700 });
  const link = join(work, "linked-destination");
  await fs.symlink(external, link);
  for (const path of [link, join(link, "nested")])
    await assert.rejects(
      f.runner("fetch-web", f.planPath, "37", path),
      /Unsafe release directory/,
    );
  assert.deepEqual(await fs.readdir(external), ["nested"]);
  assert.equal(f.downloads, 3);
});

test("Linux fetch-web admits only canonical descendants of the fixed Jenkins workspace, never a Mac root or another home", async (t) => {
  const f = await webFetchFixture(t);
  const anchor = "/home/jenkins/agent/workspace";
  const missing = join(anchor, "uncreated-fetch-fixture-" + randomUUID());
  // A legitimate Linux destination reaches the actual filesystem check even
  // on macOS, without creating or faking the Linux account's home there.
  await assert.rejects(f.runner("fetch-web", f.planPath, "37", missing), {
    code: "ENOENT",
  });
  for (const path of [
    anchor,
    "/home/jenkins/agent/other/fresh",
    "/home/jenkins/agent/workspace-evil/fresh",
    "/home/another-user/agent/workspace/fresh",
    join(f.root, "jenkins-agent", "workspace", "fresh"),
    anchor + "/../escaped-fresh",
    anchor + "/../workspace/noncanonical-fresh",
  ])
    await assert.rejects(
      f.runner("fetch-web", f.planPath, "37", path),
      /isolated trusted Jenkins workspace/,
    );
  assert.equal(f.downloads, 0);
});

test("trusted Linux deployment pins account, ARM64 Node and private volume paths", () => {
  const context = deploymentContext(identity, system);
  assert.equal(context.root, "/srv/agent-platform/deploy");
  assert.equal(
    context.auth,
    "/run/agent-platform/jenkins-tools/vercel/auth.json",
  );
  for (const replacement of [
    { uid: 0 },
    { uid: 501 },
    { gid: 501 },
    { homedir: "/tmp" },
    { username: "_agentplatformci" },
  ])
    assert.throws(
      () => deploymentContext({ ...identity, ...replacement }, system),
      /Trusted deployment/,
    );
  for (const replacement of [
    { arch: "x64" },
    { nodeMajor: 26 },
    { node: "/tmp/node" },
  ])
    assert.throws(() =>
      deploymentContext(identity, { ...system, ...replacement }),
    );
  const env = deploymentEnvironment(system.node, LINUX_DEPLOY.home, "linux");
  assert.equal(env.PATH.includes("homebrew"), false);
  for (const key of [
    "ACCESS_PASSCODE",
    "DATABASE_URL",
    "GH_TOKEN",
    "VERCEL_TOKEN",
    "NODE_OPTIONS",
    "DOCKER_HOST",
  ])
    assert.equal(env[key], undefined);
});

test("ordinary CI cannot authorize deployment merely by sharing UID1000; absent, writable and linked volumes fail", async (t) => {
  const root = await fixture(t);
  const tools = join(root, "secrets");
  await fs.mkdir(tools, { mode: 0o700 });
  const context = {
    ...LINUX_DEPLOY,
    platform: "linux",
    uid: process.getuid(),
    root,
    tools,
    publicTools: "/usr/bin",
  };
  await assertDeploymentLayout(context);
  await fs.chmod(tools, 0o755);
  await assert.rejects(assertDeploymentLayout(context), /permissions invalid/);
  await fs.chmod(tools, 0o700);
  await assert.rejects(
    assertDeploymentLayout({ ...context, root: join(root, "absent") }),
    { code: "ENOENT" },
  );
  await assert.rejects(
    assertDeploymentLayout({ ...context, uid: process.getuid() + 1 }),
    /ownership/,
  );
  const link = join(root, "linked");
  await fs.symlink(tools, link);
  await assert.rejects(
    assertDeploymentLayout({ ...context, tools: link }),
    /ownership/,
  );
  await assert.rejects(
    assertDeploymentLayout({ ...context, publicTools: tools }),
    /ownership/,
  );
});

test("Jenkins transport reaches only the fixed host gateway while provenance stays canonical", () => {
  const url = buildUrl(JOBS.web, 7);
  assert.equal(
    jenkinsTransport(url + "api/json?tree=number", LINUX_DEPLOY),
    "http://host.lima.internal:8080/job/agent-platform-web/7/api/json?tree=number",
  );
  assert.equal(
    canonicalJenkinsLocation(
      "http://host.lima.internal:8080/queue/item/9/",
      LINUX_DEPLOY,
    ),
    "http://127.0.0.1:8080/queue/item/9/",
  );
  for (const foreign of [
    "https://evil.invalid/queue/item/9/",
    "http://user@127.0.0.1:8080/queue/item/9/",
    "http://127.0.0.1:8080/queue/item/9/?token=x",
  ])
    assert.throws(() => canonicalJenkinsLocation(foreign, LINUX_DEPLOY));
  assert.throws(() =>
    jenkinsTransport(
      "http://host.lima.internal:8080/job/agent-platform-web/7/",
      LINUX_DEPLOY,
    ),
  );
  assert.throws(() =>
    jenkinsTransport(url, { jenkins: "https://evil.invalid" }),
  );
});

test("Docker29 OCI index image ID is verified through the ARM64 manifest/config chain, not mistaken for config ID", async (t) => {
  const root = await fixture(t);
  const image = await dockerSaveFixture(root);
  assert.notEqual(image.imageId, image.configDigest);
  assert.deepEqual(
    await verifyDockerSaveArchive(image.archive, image.imageId),
    {
      imageId: image.imageId,
      configDigest: image.configDigest,
      platform: "linux",
      arch: "arm64",
      format: "docker-save-oci",
    },
  );
  await assert.rejects(
    verifyDockerSaveArchive(image.archive, image.configDigest),
    /root image identity/,
  );
  await fs.appendFile(join(image.source, image.configPath), " ");
  await image.repack();
  await assert.rejects(
    verifyDockerSaveArchive(image.archive, image.imageId),
    /descriptor bytes/,
  );
});

test("legacy Docker-save validates immutable config ID; wrong architecture, missing blobs and ambiguous runtime are rejected", async (t) => {
  const root = await fixture(t);
  for (const [name, options, failure] of [
    ["legacy", { oci: false }, null],
    ["foreign-arch", { arch: "amd64" }, /architecture/],
    ["duplicate-runtime", { duplicateRuntime: true }, /exactly one/],
  ]) {
    const path = join(root, name);
    await fs.mkdir(path);
    const image = await dockerSaveFixture(path, options);
    if (failure)
      await assert.rejects(
        verifyDockerSaveArchive(image.archive, image.imageId),
        failure,
      );
    else {
      assert.equal(
        (await verifyDockerSaveArchive(image.archive, image.imageId)).format,
        "docker-save-legacy",
      );
      await assert.rejects(
        verifyDockerSaveArchive(image.archive, "sha256:" + "f".repeat(64)),
        /configuration differs/,
      );
      await fs.rm(
        join(image.source, "blobs/sha256", image.layer.digest.slice(7)),
      );
      await image.repack();
      await assert.rejects(
        verifyDockerSaveArchive(image.archive, image.imageId),
        /complete image/,
      );
    }
  }
});

test("trusted Linux runner verifies actual Jenkins SUCCESS at the gateway and preserves canonical three-SHA evidence", async (t) => {
  const root = await fixture(t),
    tools = join(root, "tools");
  await fs.mkdir(tools, { mode: 0o700 });
  await writeJson(join(tools, "admin-api.json"), {
    username: "fixture",
    token: "fixture-not-a-real-credential",
  });
  const commits = {
    project: "a".repeat(40),
    api: "b".repeat(40),
    web: "c".repeat(40),
  };
  const plan = {
    schemaVersion: 1,
    key: projectKey(commits),
    tag: "v0.3.1",
    commits,
    repositories: REPOSITORIES,
    createdAt: new Date().toISOString(),
  };
  const folder = join(root, "project-releases", plan.key);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, "plan.json");
  await writeJson(path, plan);
  let result = "SUCCESS",
    layoutChecks = 0;
  const requests = [];
  const runner = createReleaseRunner({
    root,
    tools,
    identity: { ...identity, ...system },
    assertLayout: async (context) => {
      layoutChecks++;
      assert.equal(context.platform, "linux");
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return Response.json({
        number: 8,
        result,
        building: false,
        url: buildUrl(JOBS.contract, 8),
        actions: [
          {
            parameters: Object.entries(buildParameters("contract", plan)).map(
              ([name, value]) => ({ name, value }),
            ),
          },
        ],
      });
    },
  });
  assert.equal((await runner("record-build", path, "contract", "8")).number, 8);
  assert.equal(layoutChecks, 1);
  assert.equal(
    requests[0].url.startsWith(
      "http://host.lima.internal:8080/job/agent-platform-contract/8/",
    ),
    true,
  );
  assert.equal(requests[0].options.redirect, "error");
  const saved = JSON.parse(
    await fs.readFile(join(folder, "builds.json"), "utf8"),
  );
  assert.equal(saved.contract.url, buildUrl(JOBS.contract, 8));
  result = "FAILURE";
  await assert.rejects(
    runner("record-build", path, "contract", "8"),
    /completed SUCCESS/,
  );
  await fs.writeFile(
    join(tools, "admin-api.json"),
    '{"token":"malformed-fixture-private-value',
    { mode: 0o600 },
  );
  await assert.rejects(
    runner("record-build", path, "contract", "8"),
    (error) => error.message === "Release JSON invalid",
  );
});

test("API evidence requires the matching private root/API receipt and refuses stale root-only release reuse", async (t) => {
  const root = await fixture(t),
    tools = join(root, "tools");
  await fs.mkdir(tools, { mode: 0o700 });
  const commits = {
    project: "a".repeat(40),
    api: "b".repeat(40),
    web: "c".repeat(40),
  };
  const plan = {
    schemaVersion: 1,
    key: projectKey(commits),
    tag: "v0.3.1",
    commits,
    repositories: REPOSITORIES,
    createdAt: new Date().toISOString(),
  };
  const folder = join(root, "project-releases", plan.key);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, "plan.json");
  await writeJson(path, plan);
  const ci = {
    state: "ci-passed",
    sha: commits.api,
    rootSha: commits.project,
    runId: 6,
    artifactPath: join(root, "releases", commits.project + "-" + commits.api),
    imageId: "sha256:" + "d".repeat(64),
    nativeProbe: "passed",
  };
  const receiptFolder = join(root, "jenkins-receipts");
  await fs.mkdir(receiptFolder, { mode: 0o700 });
  const receipt = join(receiptFolder, commits.api + "-6.json");
  await writeJson(receipt, ci);
  const runner = createReleaseRunner({
    root,
    tools,
    identity: { ...identity, ...system },
    assertLayout: async () => {},
    jenkins: async (kind, number) => ({
      result: {
        number,
        result: "SUCCESS",
        building: false,
        url: buildUrl(JOBS.api, number),
        actions: [
          {
            parameters: Object.entries(buildParameters("api", plan)).map(
              ([name, value]) => ({ name, value }),
            ),
          },
        ],
      },
      get: async (artifact) =>
        artifact === "artifact/ci.json"
          ? ci
          : {
              state: "deployed",
              sha: ci.sha,
              rootSha: ci.rootSha,
              imageId: ci.imageId,
            },
    }),
  });
  assert.equal((await runner("record-build", path, "api", "6")).number, 6);
  for (const changed of [
    { rootSha: "e".repeat(40) },
    { imageId: "sha256:" + "f".repeat(64) },
    { artifactPath: join(root, "releases", commits.api) },
  ]) {
    await writeJson(receipt, { ...ci, ...changed });
    await assert.rejects(
      runner("record-build", path, "api", "6"),
      /Trusted local API receipt/,
    );
  }
  await writeJson(receipt, ci);
  ci.rootSha = "e".repeat(40);
  await assert.rejects(
    runner("record-build", path, "api", "6"),
    /pinned completed Docker release/,
  );
});

test("Linux discovery queues exact commits through the gateway and stores canonical queue provenance", async (t) => {
  const root = await fixture(t),
    tools = join(root, "tools");
  await fs.mkdir(tools, { mode: 0o700 });
  await writeJson(join(tools, "admin-api.json"), {
    username: "fixture",
    token: "fixture-not-a-real-token",
  });
  const commits = {
    project: "a".repeat(40),
    api: "b".repeat(40),
    web: "c".repeat(40),
  };
  await writeJson(join(root, "project-release-current.json"), {
    state: "published",
    commits,
    key: projectKey(commits),
  });
  let queued = 0,
    layoutChecks = 0;
  const requests = [];
  const discover = createDiscoverer({
    tools,
    deployRoot: root,
    identity,
    system,
    assertLayout: async (context) => {
      layoutChecks++;
      assert.equal(context.platform, "linux");
    },
    refs: async (spec, repo) => [
      { ref: "refs/heads/" + spec.branch, sha: commits[repo] },
      { ref: "refs/heads/main", sha: commits[repo] },
    ],
    pulls: async () => [],
    status: async () => {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("buildWithParameters"))
        return new Response(null, {
          status: 201,
          headers: {
            location: `http://host.lima.internal:8080/queue/item/${++queued}/`,
          },
        });
      return Response.json(
        url.includes("queue/api/json") ? { items: [] } : { builds: [] },
      );
    },
  });
  const report = await discover();
  assert.equal(layoutChecks, 1);
  assert.equal(report.errors.length, 0);
  assert.equal(queued, 3);
  assert.equal(
    requests.every(({ url }) =>
      url.startsWith("http://host.lima.internal:8080/"),
    ),
    true,
  );
  const state = JSON.parse(
    await fs.readFile(join(tools, "discovery-state.json"), "utf8"),
  );
  assert.equal(state.pending.length, 3);
  assert.equal(
    state.pending.every(({ location }) =>
      location.startsWith("http://127.0.0.1:8080/queue/item/"),
    ),
    true,
  );
  const native = state.pending.find(
    ({ job }) => job === "agent-platform-native-ci",
  );
  assert.deepEqual(native.params, { SHA: commits.api, REF: "refs/heads/main" });
});

test("new Linux trusted pipelines preserve executor release before child waits and use container monitor CLI", async () => {
  for (const name of ["release", "discover", "monitor", "web"]) {
    const source = await fs.readFile(
      new URL(`./${name}.groovy`, import.meta.url),
      "utf8",
    );
    assert.match(source, /agent-platform-linux-deploy/);
    assert.doesNotMatch(
      source,
      /agent-platform-deploy'|@NODE22@|@JENKINS_SOURCE@|@DEPLOY_CONFIG@|@DEPLOY_TOOLS@|\/Library\/Application Support/,
    );
    if (["monitor", "release"].includes(name))
      assert.match(source, /\$MONITOR_TOOL" monitor/);
    if (name === "release") {
      assert.match(source, /agent none/);
      assert.match(source, /record-build "\$PLAN_PATH" web "\$WEB_BUILD"/);
      assert.match(source, /result.result != 'SUCCESS'/);
    }
  }
});
