import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { GATES, WEB } from "./jenkins-web.mjs";
import {
  APP_CONTEXTS,
  APP_PERMISSIONS,
  APP_REPOSITORIES,
} from "./github-status-app.mjs";
import {
  REPOS,
  STATUS_APP_ID,
  STATUS_INSTALLATION_ID,
  buildParameters,
  buildUrl,
  createCutover,
  protectionMatches,
  statusPatch,
  validateRequest,
  validateWebEvidence,
} from "./ci-cutover.mjs";

const clone = (value) => structuredClone(value);
const digest = (value) => createHash("sha256").update(value).digest("hex");
async function fixture(t) {
  const tools = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "ci-cutover-test-")),
  );
  await fs.chmod(tools, 0o700);
  t.after(() => fs.rm(tools, { recursive: true, force: true }));
  const request = {
    version: 1,
    commits: {
      api: "a".repeat(40),
      web: "b".repeat(40),
      project: "c".repeat(40),
    },
    refs: { api: WEB.ref, web: WEB.ref, project: REPOS.project.refs[1] },
    builds: { api: 17, web: 21, project: 24 },
  };
  const requestPath = join(tools, "request.json");
  await fs.writeFile(requestPath, JSON.stringify(request), { mode: 0o600 });
  const config = {
    appId: STATUS_APP_ID,
    installationId: STATUS_INSTALLATION_ID,
    slug: "xeonice-agent-platform-jenkins",
  };
  const protections = {},
    originalProtections = {},
    workflows = {},
    statuses = {},
    builds = {};
  for (const [kind, spec] of Object.entries(REPOS)) {
    protections[kind] = {
      url: `https://api.github.com/repos/${spec.name}/branches/main/protection`,
      required_status_checks: {
        strict: false,
        contexts: [...spec.old],
        checks: spec.old.map((context) => ({ context, app_id: 15368 })),
      },
      required_pull_request_reviews: {
        required_approving_review_count: 2,
        dismiss_stale_reviews: true,
        require_code_owner_reviews: true,
        require_last_push_approval: true,
      },
      enforce_admins: { enabled: true },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
      required_conversation_resolution: { enabled: true },
      required_signatures: { enabled: true },
      restrictions: { users: [{ login: "Xeonice" }], apps: [{ id: 123 }] },
    };
    originalProtections[kind] = clone(protections[kind]);
    workflows[kind] = spec.workflows.map((workflow) => ({
      ...workflow,
      url: `https://api.github.com/repos/${spec.name}/actions/workflows/${workflow.id}`,
      state: "active",
    }));
    statuses[kind] = [];
    builds[kind] = {
      number: request.builds[kind],
      result: "SUCCESS",
      building: false,
      url: buildUrl(kind, request.builds[kind]),
      actions: [
        {
          parameters: Object.entries(buildParameters(kind, request)).map(
            ([name, value]) => ({ name, value }),
          ),
        },
      ],
    };
  }
  const native = {
    repository: `https://github.com/${REPOS.api.name}.git`,
    sha: request.commits.api,
    ref: request.refs.api,
    nodeMajor: 22,
    platform: "linux",
    arch: "arm64",
  };
  const manifest = {
    schemaVersion: 1,
    repository: WEB.repository,
    sha: request.commits.web,
    rootSha: request.commits.project,
    apiSha: request.commits.api,
    ref: request.refs.web,
    production: true,
    nodeMajor: 22,
    vercelCli: "62.2.0",
    state: "packaged",
    buildSystem: { platform: "linux", arch: "x64" },
    gates: Object.fromEntries(
      GATES.map((gate) => [
        gate,
        {
          state: "passed",
          ...(["acceptance", "storybook"].includes(gate)
            ? { files: 21, passed: 102, failed: 0, skipped: 0 }
            : {}),
        },
      ]),
    ),
    jenkins: {
      job: REPOS.web.job,
      buildNumber: request.builds.web,
      gateResult: "SUCCESS",
    },
    archives: Object.fromEntries(
      ["source.tar.gz", "prebuilt.tar.gz", "storybook.tar.gz"].map((name) => [
        name,
        { bytes: 1234, sha256: "e".repeat(64) },
      ]),
    ),
  };
  const cross = {
    schemaVersion: 1,
    job: REPOS.web.job,
    buildNumber: request.builds.web,
    state: "passed",
    commits: {
      root: request.commits.project,
      api: request.commits.api,
      web: request.commits.web,
    },
    child: {
      job: REPOS.project.job,
      number: request.builds.project,
      result: "SUCCESS",
      url: buildUrl("project", request.builds.project),
    },
    parameters: buildParameters("project", request),
  };
  const controllers = {
    numExecutors: 0,
    jobs: [
      ...Object.values(REPOS).map((spec) => ({
        name: spec.job,
        buildable: true,
      })),
      ...[
        "agent-platform-ci-discovery",
        "agent-platform-api",
        "agent-platform-release",
        "agent-platform-mutation",
        "agent-platform-sandbox-images",
        "agent-platform-service-monitor",
      ].map((name) => ({ name, buildable: false })),
    ],
  };
  const calls = [],
    flags = {
      mode: "active",
      statusCreator: `${config.slug}[bot]`,
      failPatch: null,
      afterPublish: null,
      corruptProtection: null,
    };
  let nextId = 100;
  const github = async (kind, path, settings = {}) => {
    const method = settings.method ?? "GET";
    calls.push({ kind, path, method });
    if (path.startsWith("git/ref/"))
      return {
        ref: request.refs[kind],
        object: { type: "commit", sha: request.commits[kind] },
      };
    if (path === "branches/main/protection") return clone(protections[kind]);
    if (
      path === "branches/main/protection/required_status_checks" &&
      method === "PATCH"
    ) {
      if (flags.failPatch === kind) throw new Error("Injected provider outage");
      const patch = JSON.parse(settings.body);
      protections[kind].required_status_checks = {
        ...patch,
        contexts: patch.checks.map((check) => check.context),
      };
      if (flags.corruptProtection === kind)
        protections[kind].allow_force_pushes.enabled = true;
      return clone(protections[kind].required_status_checks);
    }
    if (path.startsWith("commits/") && path.endsWith("/statuses?per_page=100"))
      return clone(statuses[kind]);
    const match = /^actions\/workflows\/([0-9]+)(\/disable)?$/.exec(path);
    if (match) {
      const workflow = workflows[kind].find(
        (entry) => entry.id === Number(match[1]),
      );
      if (match[2] && method === "PUT") {
        workflow.state = "disabled_manually";
        return null;
      }
      return clone(workflow);
    }
    throw new Error("Unexpected fixed provider route in fixture");
  };
  const jenkins = async (path) => {
    calls.push({ provider: "jenkins", path, method: "GET" });
    if (path.startsWith("api/json")) return clone(controllers);
    const kind = Object.keys(REPOS).find((kind) =>
      path.startsWith(`job/${REPOS[kind].job}/${request.builds[kind]}/`),
    );
    if (!kind) throw new Error("Noncanonical Jenkins build request");
    if (path.includes("/api/json?")) return clone(builds[kind]);
    if (path.endsWith("/artifact/commit.json")) return clone(native);
    if (path.endsWith("/artifact/web-artifacts/manifest.json"))
      return clone(manifest);
    if (path.endsWith("/artifact/web-cross-repository/contract.json"))
      return clone(cross);
    if (path.endsWith("/artifact/commits.json")) return clone(request.commits);
    throw new Error("Unexpected Jenkins evidence path");
  };
  const app = {
    verify: async () => clone(config),
    publish: async (kind, input) => {
      calls.push({
        kind,
        path: `statuses/${input.commits[kind]}`,
        method: "POST",
        provider: "verified-status-app",
      });
      const value = {
        id: nextId++,
        state: "success",
        context: APP_CONTEXTS[REPOS[kind].name],
        target_url: buildUrl(kind, input.builds[kind]),
        creator: { type: "Bot", login: flags.statusCreator },
      };
      statuses[kind].unshift(value);
      await flags.afterPublish?.(kind);
      return clone(value);
    },
  };
  const tool = createCutover({
    tools,
    uid: process.getuid(),
    github,
    jenkins,
    app,
    controllerMode: async () => flags.mode,
  });
  return {
    tools,
    request,
    requestPath,
    config,
    protections,
    originalProtections,
    workflows,
    statuses,
    builds,
    native,
    manifest,
    cross,
    controllers,
    calls,
    flags,
    tool,
    github,
    jenkins,
  };
}
const writes = (calls) => calls.filter((call) => call.method !== "GET");

test("public Jenkins build metadata and cross-child URLs retain exact source cutover gates", async (t) => {
  const f = await fixture(t);
  for (const value of Object.values(f.builds))
    value.url = value.url.replace(
      "http://127.0.0.1:8080/",
      "https://jenkins.douglasdong.com/",
    );
  f.cross.child.url = f.cross.child.url.replace(
    "http://127.0.0.1:8080/",
    "https://jenkins.douglasdong.com/",
  );
  assert.equal(
    (await f.tool.preview(f.requestPath)).state,
    "previewed-no-remote-mutations",
  );
  assert.equal(writes(f.calls).length, 0);
  f.builds.web.url += "?redirect=evil";
  await assert.rejects(
    f.tool.preview(f.requestPath),
    /canonical completed SUCCESS/,
  );
});

test("preview is readonly, binds real formal three-SHA evidence and exposes only the narrow App-specific patches plus six fixed workflows", async (t) => {
  const f = await fixture(t),
    preview = await f.tool.preview(f.requestPath);
  assert.equal(preview.state, "previewed-no-remote-mutations");
  assert.equal(writes(f.calls).length, 0);
  assert.equal(preview.workflows.length, 6);
  for (const patch of Object.values(preview.patches)) {
    assert.equal(patch.strict, false);
    assert.equal(patch.checks.length, 1);
    assert.equal(patch.checks[0].app_id, STATUS_APP_ID);
  }
  const stat = await fs.stat(preview.planPath);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(digest(await fs.readFile(preview.planPath)), preview.planSha256);
});

test("apply roundtrips real App statuses before patching only status protection and disables workflows only after every repository is verified", async (t) => {
  const f = await fixture(t),
    preview = await f.tool.preview(f.requestPath);
  const result = await f.tool.apply(preview.planPath, preview.planSha256);
  assert.equal(result.workflowCount, 6);
  assert.equal(result.discoveryRemainsDisabled, true);
  const mutations = writes(f.calls);
  assert.deepEqual(
    mutations.map((call) => call.method),
    [
      "POST",
      "POST",
      "POST",
      "PATCH",
      "PATCH",
      "PATCH",
      "PUT",
      "PUT",
      "PUT",
      "PUT",
      "PUT",
      "PUT",
    ],
  );
  for (const kind of Object.keys(REPOS)) {
    assert.equal(
      protectionMatches(
        f.protections[kind],
        f.originalProtections[kind],
        preview.patches[kind],
      ),
      true,
    );
    assert.equal(
      f.workflows[kind].every(
        (workflow) => workflow.state === "disabled_manually",
      ),
      true,
    );
  }
  assert.equal(
    f.controllers.jobs.find((job) => job.name === "agent-platform-ci-discovery")
      .buildable,
    false,
  );
});

test("an incomplete, failed or source-mismatched actual build rejects synthetic successful artifacts before any writes", async (t) => {
  for (const mutate of [
    (f) => {
      f.builds.api.building = true;
    },
    (f) => {
      f.builds.project.result = "FAILURE";
    },
    (f) => {
      f.builds.web.actions[0].parameters.find(
        (p) => p.name === "ROOT_SHA",
      ).value = "d".repeat(40);
    },
    (f) => {
      f.native.ref = "refs/heads/main";
    },
    (f) => {
      f.cross.child.number = 999;
    },
    (f) => {
      f.manifest.gates.acceptance.state = "planned";
    },
  ]) {
    const f = await fixture(t);
    mutate(f);
    await assert.rejects(
      f.tool.preview(f.requestPath),
      /SUCCESS|artifact|provenance|gates|contract/,
    );
    assert.equal(writes(f.calls).length, 0);
  }
});

test("migration mode or discovery/deploy enabled refuses the limited validation profile", async (t) => {
  for (const boundary of ["mode", "discovery", "deploy"]) {
    const f = await fixture(t);
    if (boundary === "mode") f.flags.mode = "migration";
    else
      f.controllers.jobs.find(
        (job) =>
          job.name ===
          (boundary === "discovery"
            ? "agent-platform-ci-discovery"
            : "agent-platform-api"),
      ).buildable = true;
    await assert.rejects(
      f.tool.preview(f.requestPath),
      /active startup guard|only three validation jobs/,
    );
    assert.equal(writes(f.calls).length, 0);
  }
});

test("ref movement after real status publication cannot patch branch protection for a different main/feature SHA", async (t) => {
  const f = await fixture(t),
    preview = await f.tool.preview(f.requestPath);
  f.flags.afterPublish = async (kind) => {
    if (kind === "project") f.request.commits.api = "d".repeat(40);
  };
  await assert.rejects(
    f.tool.apply(preview.planPath, preview.planSha256),
    /current exact branch source head/,
  );
  assert.equal(
    writes(f.calls).filter(
      (call) => call.method === "PATCH" || call.method === "PUT",
    ).length,
    0,
  );
});

test("OAuth or another bot success is not accepted as proof of the verified App source", async (t) => {
  const f = await fixture(t),
    preview = await f.tool.preview(f.requestPath);
  f.flags.statusCreator = "github-actions[bot]";
  await assert.rejects(
    f.tool.apply(preview.planPath, preview.planSha256),
    /actual App status ID/,
  );
  assert.equal(
    writes(f.calls).filter(
      (call) => call.method === "PATCH" || call.method === "PUT",
    ).length,
    0,
  );
});

test("protection review/signature/admin drift or wrong old workflow identity aborts before any external mutation", async (t) => {
  for (const boundary of ["reviews", "workflow"]) {
    const f = await fixture(t),
      preview = await f.tool.preview(f.requestPath);
    if (boundary === "reviews")
      f.protections.web.required_pull_request_reviews.required_approving_review_count = 3;
    else f.workflows.api[0].path = ".github/workflows/unrelated.yml";
    await assert.rejects(
      f.tool.apply(preview.planPath, preview.planSha256),
      /protection drift|workflow identity/,
    );
    assert.equal(writes(f.calls).length, 0);
  }
});

test("unrelated protection mutation detected after PATCH never retires the old workflows", async (t) => {
  const f = await fixture(t),
    preview = await f.tool.preview(f.requestPath);
  f.flags.corruptProtection = "api";
  await assert.rejects(
    f.tool.apply(preview.planPath, preview.planSha256),
    /all other protection preserved/,
  );
  assert.equal(
    writes(f.calls).some((call) => call.method === "PUT"),
    false,
  );
});

test("a partial provider failure checkpoints each verified status and resumes without duplicate publication or weakening already migrated protection", async (t) => {
  const f = await fixture(t),
    preview = await f.tool.preview(f.requestPath);
  f.flags.failPatch = "web";
  await assert.rejects(
    f.tool.apply(preview.planPath, preview.planSha256),
    /provider outage/,
  );
  const checkpoint = JSON.parse(
    await fs.readFile(join(preview.planPath, "../checkpoint.json"), "utf8"),
  );
  assert.equal(Object.keys(checkpoint.statuses).length, 3);
  assert.equal(checkpoint.protections.api, true);
  assert.equal(checkpoint.protections.web, undefined);
  assert.equal(
    writes(f.calls).some((call) => call.method === "PUT"),
    false,
  );
  f.flags.failPatch = null;
  f.calls.length = 0;
  await f.tool.apply(preview.planPath, preview.planSha256);
  assert.equal(
    writes(f.calls).filter((call) => call.method === "POST").length,
    0,
  );
  assert.equal(
    writes(f.calls).filter((call) => call.method === "PATCH").length,
    2,
  );
  assert.equal(
    writes(f.calls).filter((call) => call.method === "PUT").length,
    6,
  );
  f.calls.length = 0;
  await f.tool.apply(preview.planPath, preview.planSha256);
  assert.equal(writes(f.calls).length, 0);
});

test("unknown required checks and generic or unrelated App sources are never dropped to unblock a merge", () => {
  const baseline = {
    required_status_checks: {
      strict: true,
      contexts: ["build-test"],
      checks: [{ context: "build-test", app_id: 15368 }],
    },
  };
  assert.deepEqual(statusPatch(baseline, "api"), {
    strict: true,
    checks: [{ context: "jenkins/native-ci", app_id: STATUS_APP_ID }],
  });
  for (const mutate of [
    (value) => {
      value.required_status_checks.checks[0].app_id = -1;
    },
    (value) => {
      value.required_status_checks.checks.push({
        context: "security-scan",
        app_id: 123,
      });
    },
    (value) => {
      value.required_status_checks.checks[0].context = "unrelated";
    },
  ]) {
    const value = clone(baseline);
    mutate(value);
    assert.throws(
      () => statusPatch(value, "api"),
      /unknown checks are never dropped/,
    );
  }
});

test("tampered reviewed plans, permissive inputs and arbitrary repositories/refs are rejected", async (t) => {
  const f = await fixture(t),
    preview = await f.tool.preview(f.requestPath);
  await fs.appendFile(preview.planPath, " ");
  await assert.rejects(
    f.tool.apply(preview.planPath, preview.planSha256),
    /plan bytes unchanged/,
  );
  assert.equal(writes(f.calls).length, 0);
  await fs.chmod(f.requestPath, 0o644);
  await assert.rejects(
    f.tool.preview(f.requestPath),
    /owner-only regular evidence/,
  );
  for (const change of [
    { refs: { ...f.request.refs, api: "refs/heads/arbitrary" } },
    { builds: { ...f.request.builds, api: 0 } },
    { repository: "other/private" },
  ])
    assert.throws(
      () => validateRequest({ ...f.request, ...change }),
      /fixed request shape|exact source/,
    );
});

test("the actual packaged Linux manifest shape retains archive sizes, trees and test counts but its manual evidence can never authorize cutover", async (t) => {
  const actual = JSON.parse(
    await fs.readFile(
      new URL("./fixtures/web-manual-package-shape.json", import.meta.url),
      "utf8",
    ),
  );
  const request = {
    version: 1,
    commits: { api: actual.apiSha, project: actual.rootSha, web: actual.sha },
    refs: { api: WEB.ref, web: actual.ref, project: REPOS.project.refs[1] },
    builds: { api: 17, web: actual.jenkins.buildNumber, project: 24 },
  };
  validateRequest(request);
  assert.equal(actual.gates.acceptance.passed, 102);
  assert.equal(actual.gates.storybook.passed, 544);
  assert.equal(actual.archives["prebuilt.tar.gz"].bytes, 23452943);
  assert.throws(
    () => validateWebEvidence(actual, request),
    /manual proof is never formal CI/,
  );
  // This only verifies the shape of a future formal artifact. Real apply also
  // queries Jenkins SUCCESS, source checkout and the actual contract child.
  const formalShape = clone(actual);
  delete formalShape.manualProof;
  assert.equal(
    validateWebEvidence(formalShape, request).trees.output.files,
    3326,
  );
  const f = await fixture(t);
  Object.assign(f.manifest, actual, {
    sha: f.request.commits.web,
    rootSha: f.request.commits.project,
    apiSha: f.request.commits.api,
    jenkins: { ...actual.jenkins, buildNumber: f.request.builds.web },
  });
  await assert.rejects(
    f.tool.preview(f.requestPath),
    /manual proof is never formal CI/,
  );
  assert.equal(writes(f.calls).length, 0);
});

test("allowed source refs are per repository and cannot substitute root's deployment branch with the API/Web feature ref", async (t) => {
  const f = await fixture(t);
  validateRequest(f.request);
  assert.throws(
    () =>
      validateRequest({
        ...f.request,
        refs: { ...f.request.refs, project: WEB.ref },
      }),
    /allowed ref/,
  );
  assert.throws(
    () =>
      validateRequest({
        ...f.request,
        refs: { ...f.request.refs, api: REPOS.project.refs[1] },
      }),
    /allowed ref/,
  );
});

test("the real App publisher signs RSA JWTs and uses only the fixed repository-limited installation token, never OAuth or wider permissions", async (t) => {
  const f = await fixture(t);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const config = {
    version: 1,
    owner: "Xeonice",
    ...f.config,
    repositories: [...APP_REPOSITORIES],
  };
  await fs.writeFile(
    join(f.tools, "github-status-app.json"),
    JSON.stringify(config),
    { mode: 0o600 },
  );
  await fs.writeFile(
    join(f.tools, "github-status-app.pem"),
    privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  const installationToken = "private-fixture-installation-token-only-in-memory";
  const httpCalls = [];
  const fetcher = async (url, settings) => {
    const path = new URL(url).pathname;
    const method = settings.method ?? "GET";
    httpCalls.push({ path, method });
    assert.equal(new URL(url).origin, "https://api.github.com");
    const credential = settings.headers.Authorization;
    let value;
    if (path.startsWith("/app")) {
      const jwt = credential.slice("Bearer ".length).split(".");
      assert.ok(
        verify(
          "RSA-SHA256",
          Buffer.from(jwt.slice(0, 2).join(".")),
          publicKey,
          Buffer.from(jwt[2], "base64url"),
        ),
        "App JWT signature is valid",
      );
      assert.equal(
        JSON.parse(Buffer.from(jwt[1], "base64url")).iss,
        String(STATUS_APP_ID),
      );
    }
    if (path === "/app")
      value = {
        id: STATUS_APP_ID,
        slug: config.slug,
        owner: { login: "Xeonice" },
        html_url: `https://github.com/apps/${config.slug}`,
        permissions: { ...APP_PERMISSIONS, metadata: "read" },
      };
    else if (path === `/app/installations/${STATUS_INSTALLATION_ID}`)
      value = {
        id: STATUS_INSTALLATION_ID,
        app_id: STATUS_APP_ID,
        app_slug: config.slug,
        account: { login: "Xeonice" },
        repository_selection: "selected",
        suspended_at: null,
        permissions: { ...APP_PERMISSIONS, metadata: "read" },
      };
    else if (path.endsWith("/access_tokens")) {
      const request = JSON.parse(settings.body);
      assert.deepEqual(request.permissions, APP_PERMISSIONS);
      assert.deepEqual(
        request.repositories,
        APP_REPOSITORIES.map((repository) => repository.split("/")[1]),
      );
      value = {
        token: installationToken,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        repository_selection: "selected",
        permissions: { ...APP_PERMISSIONS, metadata: "read" },
      };
    } else if (path === "/installation/repositories") {
      assert.ok(
        credential === `Bearer ${installationToken}`,
        "Restricted token authenticates the effective repository lookup",
      );
      value = {
        total_count: 3,
        repositories: APP_REPOSITORIES.map((full_name, index) => ({
          id: index + 1,
          full_name,
          owner: { login: "Xeonice" },
        })),
      };
    } else {
      const kind = Object.keys(REPOS).find(
        (kind) =>
          path ===
          `/repos/${REPOS[kind].name}/statuses/${f.request.commits[kind]}`,
      );
      assert.ok(
        kind &&
          method === "POST" &&
          credential === `Bearer ${installationToken}`,
        "Only fixed status endpoints use the restricted token",
      );
      const body = JSON.parse(settings.body);
      assert.equal(body.state, "success");
      assert.equal(body.context, APP_CONTEXTS[REPOS[kind].name]);
      value = {
        ...body,
        id: 500 + Object.keys(REPOS).indexOf(kind),
        creator: { type: "Bot", login: `${config.slug}[bot]` },
      };
      f.statuses[kind].unshift(value);
    }
    return new Response(JSON.stringify(value), { status: 200 });
  };
  const tool = createCutover({
    tools: f.tools,
    uid: process.getuid(),
    github: f.github,
    jenkins: f.jenkins,
    controllerMode: async () => "active",
    fetch: fetcher,
  });
  const preview = await tool.preview(f.requestPath);
  assert.equal(
    httpCalls.some((call) => call.method !== "GET"),
    false,
  );
  await tool.apply(preview.planPath, preview.planSha256);
  assert.equal(
    httpCalls.filter((call) => call.path.includes("/statuses/")).length,
    3,
  );
  for (const name of await fs.readdir(f.tools)) {
    if (name.endsWith(".pem")) continue;
    const stat = await fs.stat(join(f.tools, name));
    if (stat.isFile())
      assert.equal(
        (await fs.readFile(join(f.tools, name), "utf8")).includes(
          installationToken,
        ),
        false,
      );
  }
  const checkpoint = await fs.readFile(
    join(preview.planPath, "../checkpoint.json"),
    "utf8",
  );
  assert.equal(checkpoint.includes(installationToken), false);
});
