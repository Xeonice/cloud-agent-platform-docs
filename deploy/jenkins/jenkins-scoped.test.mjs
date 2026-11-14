import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDiscoverer,
  scopedRequests,
  exactParametersMatch,
  DISCOVERY_JOBS,
} from "./jenkins-discover.mjs";
import { runScopedRequest, readScopedRequest } from "./scoped-ci-request.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});
const commits = {
  project: "a".repeat(40),
  api: "b".repeat(40),
  web: "c".repeat(40),
};
const spec = () => ({
  schemaVersion: 1,
  requestId: "qualification-r1",
  commits: { ...commits },
  pullRequests: { project: 69, api: 51, web: 47 },
});
const parameters = (params) => [
  {
    parameters: Object.entries(params).map(([name, value]) => ({
      name,
      value,
    })),
  },
];
const url = (job, number) => `http://127.0.0.1:8080/job/${job}/${number}/`;
const json = async (path, value) =>
  fs.writeFile(path, JSON.stringify(value), { mode: 0o600 });
async function temporary() {
  const path = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "scoped-ci-test-")),
  );
  directories.push(path);
  await fs.chmod(path, 0o700);
  return path;
}
async function fixture(request = spec()) {
  const tools = await temporary(),
    deployRoot = await temporary();
  const calls = [],
    statuses = [],
    reads = [],
    queues = new Map(),
    builds = new Map();
  let report,
    next = 1,
    rejectStatus = false;
  const options = {
    requests: request,
    tools,
    deployRoot,
    identity: {
      username: "jenkins",
      uid: 1000,
      gid: 1000,
      homedir: "/home/jenkins",
    },
    system: {
      platform: "linux",
      arch: "arm64",
      nodeMajor: 22,
      node: "/usr/local/bin/node",
    },
    assertLayout: async () => {},
    refs: async () => {
      throw new Error("Forbidden branch/tag scan");
    },
    pulls: async () => {
      throw new Error("Forbidden PR enumeration");
    },
    changedImage: async () => {
      throw new Error("Forbidden image comparison");
    },
    pull: async (repo) => ({
      number: spec().pullRequests[repo],
      state: "open",
      draft: true,
      base: { ref: "main" },
      head: {
        sha: commits[repo],
        repo: {
          full_name: {
            api: "Xeonice/agent-platform-api",
            web: "Xeonice/agent-platform-web",
            project: "Xeonice/cloud-agent-platform-docs",
          }[repo],
        },
      },
    }),
    jenkins: {
      queue: async (job, params) => {
        assert.ok(
          [DISCOVERY_JOBS.api, DISCOVERY_JOBS.web].includes(job),
          "no release, images or duplicate contract",
        );
        calls.push({ job, params: structuredClone(params) });
        const id = next++;
        queues.set(id, {
          id,
          task: { name: job },
          actions: parameters(params),
        });
        return `http://127.0.0.1:8080/queue/item/${id}/`;
      },
      get: async (path) => {
        reads.push(path);
        if (path === "queue/api/json") return { items: [...queues.values()] };
        const queued = /^queue\/item\/(\d+)\/api\/json$/.exec(path);
        if (queued && queues.has(Number(queued[1])))
          return queues.get(Number(queued[1]));
        const history = /^job\/([^/]+)\/api\/json/.exec(path);
        if (history)
          return {
            builds: [...builds.values()].filter(
              (build) => build.job === history[1],
            ),
          };
        const build = /^job\/([^/]+)\/(\d+)\/api\/json$/.exec(path);
        if (build && builds.has(`${build[1]}:${build[2]}`))
          return builds.get(`${build[1]}:${build[2]}`);
        if (
          /artifact\/web-cross-repository\/contract.json$/.test(path) &&
          report
        )
          return structuredClone(report);
        throw Object.assign(new Error("not found"), { status: 404 });
      },
    },
    status: async (item) => {
      if (rejectStatus) throw new Error("App temporarily unavailable");
      statuses.push(structuredClone(item));
    },
  };
  const state = async () =>
    JSON.parse(await fs.readFile(join(tools, "discovery-state.json"), "utf8"));
  function finish(repo, result = "SUCCESS", extraParams = {}) {
    const call = calls.findLast((entry) => entry.job === DISCOVERY_JOBS[repo]);
    const queued = [...queues.values()].find(
      (entry) => entry.task.name === call.job,
    );
    const number = repo === "api" ? 11 : 21;
    const build = {
      job: call.job,
      number,
      url: url(call.job, number),
      building: false,
      result,
      queueId: queued.id,
      actions: parameters({ ...call.params, ...extraParams }),
    };
    builds.set(`${call.job}:${number}`, build);
    queued.executable = { number, url: build.url };
    if (repo === "web") {
      const child = {
        job: DISCOVERY_JOBS.project,
        number: 31,
        result: "SUCCESS",
        url: url(DISCOVERY_JOBS.project, 31),
      };
      const params = {
        ROOT_SHA: commits.project,
        API_SHA: commits.api,
        WEB_SHA: commits.web,
      };
      builds.set(`${child.job}:31`, {
        ...child,
        building: false,
        actions: parameters(params),
      });
      report = {
        schemaVersion: 1,
        job: DISCOVERY_JOBS.web,
        buildNumber: 21,
        state: "passed",
        commits: { root: commits.project, api: commits.api, web: commits.web },
        child,
        parameters: params,
      };
    }
  }
  return {
    tools,
    options,
    calls,
    statuses,
    reads,
    queues,
    builds,
    state,
    finish,
    report: () => report,
    failStatus: (value) => {
      rejectStatus = value;
    },
    advance: () => createDiscoverer(options)(),
    reconcile: () => createDiscoverer({ ...options, action: "reconcile" })(),
  };
}
async function reachWeb(f) {
  await f.advance();
  f.finish("api");
  await f.advance();
  await f.advance();
  assert.deepEqual(
    f.calls.map((call) => call.job),
    [DISCOVERY_JOBS.api, DISCOVERY_JOBS.web],
  );
}
async function reachChild(f) {
  await reachWeb(f);
  f.finish("web");
  await f.advance();
}

test("explicit three-PR request derives exact parameters and rejects invalid shape/SHA/PR", () => {
  const scope = scopedRequests(spec());
  assert.deepEqual(
    scope.requests.map((item) => item.repo),
    ["api", "web", "project"],
  );
  assert.equal(scope.requests[0].ref, "refs/pull/51/head");
  for (const mutate of [
    (value) => {
      value.commits.api = "main";
    },
    (value) => {
      value.pullRequests.api = 0;
    },
    (value) => {
      value.pullRequests.web = "47";
    },
    (value) => {
      value.params = { SHA: commits.api };
    },
    (value) => {
      value.commits.extra = commits.api;
    },
  ]) {
    const value = spec();
    mutate(value);
    assert.throws(() => scopedRequests(value));
  }
});
test("scoped actual factory serializes API then Web and binds its exact real contract child", async () => {
  const f = await fixture();
  await f.advance();
  await f.advance();
  assert.deepEqual(
    f.calls.map((call) => call.job),
    [DISCOVERY_JOBS.api],
  );
  f.finish("api");
  await f.advance();
  await f.advance();
  f.finish("web");
  await f.advance();
  const result = await f.advance();
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(result.scopedResults).map(([repo, value]) => [
        repo,
        value.result,
      ]),
    ),
    { api: "SUCCESS", web: "SUCCESS", project: "SUCCESS" },
  );
  assert.equal(f.calls.length, 2);
  assert.equal(f.statuses.filter((item) => item.state === "success").length, 3);
  assert.equal(
    f.statuses.findLast((item) => item.repo === "project").targetUrl,
    "https://jenkins.douglasdong.com/job/agent-platform-contract/31/",
  );
  assert.equal(
    (await f.state()).initializedAt,
    undefined,
    "scoped run does not initialize global discovery",
  );
});
test("changed PR number/head/base/fork is refused before any dispatch or App status", async () => {
  for (const mutate of [
    (pull) => {
      pull.number++;
    },
    (pull) => {
      pull.head.sha = "d".repeat(40);
    },
    (pull) => {
      pull.base.ref = "other";
    },
    (pull) => {
      pull.head.repo.full_name = "other/fork";
    },
  ]) {
    const f = await fixture();
    const original = f.options.pull;
    f.options.pull = async (...args) => {
      const pull = await original(...args);
      mutate(pull);
      return pull;
    };
    await assert.rejects(f.advance(), /PR head, repository or base changed/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.statuses.length, 0);
  }
});
test("failed, unstable, aborted and unknown API results cannot advance or become success", async () => {
  for (const terminal of ["FAILURE", "UNSTABLE", "ABORTED", null]) {
    const f = await fixture();
    await f.advance();
    f.finish("api", terminal);
    await f.advance();
    await f.advance();
    await f.advance();
    assert.equal(f.calls.length, 1);
    assert.equal(
      f.statuses.some((item) => item.state === "success"),
      false,
    );
  }
});
test("actual completion with extra or wrong parameters is not accepted", async () => {
  for (const extra of [{ EXTRA: "forbidden" }, { SHA: "d".repeat(40) }]) {
    const f = await fixture();
    await f.advance();
    f.finish("api", "SUCCESS", extra);
    await f.advance();
    const result = await f.advance();
    assert.match(result.errors[0].error, /different source parameters/);
    assert.equal(f.calls.length, 1);
    assert.equal(
      f.statuses.some((item) => item.state === "success"),
      false,
    );
  }
});
test("old pending/outbox entries remain byte-for-byte and are neither read nor sent", async () => {
  const f = await fixture();
  const pending = [
    {
      key: "unrelated",
      job: DISCOVERY_JOBS.release,
      params: { TAG: "" },
      location: "private-old-identity",
    },
  ];
  const statuses = [
    {
      repo: "api",
      sha: "f".repeat(40),
      state: "success",
      context: "jenkins/native-ci",
      targetUrl: "old",
    },
  ];
  await json(join(f.tools, "discovery-state.json"), {
    schemaVersion: 2,
    refs: { old: "keep" },
    pending,
    statuses,
  });
  await f.advance();
  await f.reconcile();
  const state = await f.state();
  assert.deepEqual(
    state.pending.filter((item) => !item.scopeKey),
    pending,
  );
  assert.deepEqual(
    state.statuses.filter((item) => !item.scopeKey),
    statuses,
  );
  assert.equal(state.refs.old, "keep");
  assert.equal(
    f.statuses.some((item) => item.sha === "f".repeat(40)),
    false,
  );
  assert.equal(
    f.reads.some((path) => path.includes("release")),
    false,
  );
});
test("outbox survives App failure and repeated requests never dispatch duplicate builds", async () => {
  const f = await fixture();
  f.failStatus(true);
  assert.equal((await f.advance()).pendingStatuses, 1);
  await f.advance();
  assert.equal(f.calls.length, 1);
  f.failStatus(false);
  await f.reconcile();
  await f.reconcile();
  assert.equal(f.statuses.length, 1);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.state()).statuses.length, 0);
});
test("contract child cannot be replaced by a different successful history entry or mismatched evidence", async () => {
  for (const mutate of [
    (f) => {
      f.report().child.number = 32;
    },
    (f) => {
      f.report().parameters.API_SHA = "d".repeat(40);
    },
    (f) => {
      f.builds.get(`${DISCOVERY_JOBS.project}:31`).actions = parameters({
        ROOT_SHA: commits.project,
        API_SHA: commits.api,
        WEB_SHA: "d".repeat(40),
      });
    },
    (f) => {
      f.builds.get(`${DISCOVERY_JOBS.project}:31`).result = "FAILURE";
    },
    (f) => {
      f.builds.get(`${DISCOVERY_JOBS.project}:31`).building = true;
    },
  ]) {
    const f = await fixture();
    await reachChild(f);
    mutate(f);
    await assert.rejects(f.advance(), /contract child/);
    assert.equal(
      f.statuses.some(
        (item) => item.repo === "project" && item.state === "success",
      ),
      false,
    );
    assert.equal(f.calls.length, 2);
  }
});
test("reconcile observes only and does not dispatch the next serial stage", async () => {
  const f = await fixture();
  await f.advance();
  f.finish("api");
  await f.reconcile();
  await f.reconcile();
  assert.equal(f.calls.length, 1);
  await f.advance();
  assert.equal(f.calls.length, 2);
});
test("strict parameter comparison rejects duplicate and extra entries", () => {
  assert.equal(
    exactParametersMatch(
      { actions: parameters({ SHA: commits.api, EXTRA: "x" }) },
      { SHA: commits.api },
    ),
    false,
  );
  assert.equal(
    exactParametersMatch(
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
test("Root tool is held before layout, request reads, credentials or network", async () => {
  const result = await runScopedRequest([], {
    context: () => {
      throw new Error("must not be called");
    },
  });
  assert.deepEqual(result, { state: "held", actions: 0 });
});
test("Root tool private request and exclusive lock guard its actual factory call", async () => {
  const tools = await temporary(),
    path = join(tools, "request.json");
  await json(path, spec());
  assert.deepEqual(await readScopedRequest(path), spec());
  let calls = 0;
  const options = {
    context: () => ({ tools }),
    assertLayout: async () => {},
    createDiscoverer:
      ({ requests, action }) =>
      async () => {
        calls++;
        assert.deepEqual(requests, spec());
        assert.equal(action, "reconcile");
        return { state: "observed" };
      },
  };
  await json(join(tools, "scoped-ci-request.lock"), {});
  await assert.rejects(
    runScopedRequest(["--root-go", path, "reconcile"], options),
    /EEXIST/,
  );
  assert.equal(calls, 0);
  await fs.unlink(join(tools, "scoped-ci-request.lock"));
  await runScopedRequest(["--root-go", path, "reconcile"], options);
  assert.equal(calls, 1);
  await assert.rejects(
    fs.stat(join(tools, "scoped-ci-request.lock")),
    /ENOENT/,
  );
  await fs.chmod(path, 0o644);
  await assert.rejects(readScopedRequest(path), /private owner-only/);
});
test("production status path uses the real App adapter and refuses OAuth fallback before dispatch", async () => {
  const f = await fixture(),
    appCalls = [];
  delete f.options.status;
  f.options.statusApp = {
    source: async () => ({ kind: "github-app" }),
    postStatus: async (repository, sha, body) =>
      appCalls.push({ repository, sha, body }),
  };
  await reachChild(f);
  await f.advance();
  assert.deepEqual(
    appCalls
      .filter((item) => item.body.state === "success")
      .map((item) => item.body.context),
    ["jenkins/native-ci", "jenkins/web-ci", "jenkins/project-ci"],
  );
  const denied = await fixture();
  delete denied.options.status;
  denied.options.statusApp = { source: async () => ({ kind: "oauth" }) };
  await assert.rejects(denied.advance(), /require the configured GitHub App/);
  assert.equal(denied.calls.length, 0);
});
test("unknown actual building flag or wrong queue ID is never terminal success", async () => {
  for (const mutate of [
    (build) => {
      delete build.building;
    },
    (build) => {
      build.queueId++;
    },
    (build) => {
      build.number++;
    },
  ]) {
    const f = await fixture();
    await f.advance();
    f.finish("api");
    mutate(f.builds.get(`${DISCOVERY_JOBS.api}:11`));
    await f.advance();
    const result = await f.advance();
    assert.match(result.errors[0].error, /identity or terminal state/);
    assert.equal(f.calls.length, 1);
    assert.equal(
      f.statuses.some((item) => item.state === "success"),
      false,
    );
  }
});
test("legacy discovery state is refused without migrating old pending or outbox", async () => {
  const f = await fixture(),
    path = join(f.tools, "discovery-state.json");
  const original = {
    refs: {},
    pending: [{ old: true }],
    statuses: [{ old: true }],
  };
  await json(path, original);
  const before = await fs.readFile(path);
  await assert.rejects(f.advance(), /will not migrate unrelated legacy/);
  assert.deepEqual(await fs.readFile(path), before);
});
test("public Jenkins URLs are canonicalized for historical SUCCESS and actual queue transitions", async () => {
  const f = await fixture(),
    selected = scopedRequests(spec()).requests[0];
  f.builds.set(`${selected.job}:41`, {
    job: selected.job,
    number: 41,
    queueId: 81,
    building: false,
    result: "SUCCESS",
    url: `https://jenkins.douglasdong.com/job/${selected.job}/41/`,
    actions: parameters(selected.params),
  });
  await f.advance();
  assert.equal(f.calls.length, 0);
  await f.advance();
  assert.equal(f.calls[0].job, DISCOVERY_JOBS.web);
  f.finish("web");
  const web = f.builds.get(`${DISCOVERY_JOBS.web}:21`);
  web.url = web.url.replace(
    "http://127.0.0.1:8080",
    "https://jenkins.douglasdong.com",
  );
  [...f.queues.values()][0].executable.url = web.url;
  f.report().child.url = f
    .report()
    .child.url.replace(
      "http://127.0.0.1:8080",
      "https://jenkins.douglasdong.com",
    );
  const child = f.builds.get(`${DISCOVERY_JOBS.project}:31`);
  child.url = f.report().child.url;
  await f.advance();
  const result = await f.advance();
  assert.equal(result.scopedResults.project.result, "SUCCESS");
  assert.equal(f.calls.length, 1);
});
test("unknown POST persists intent first, then only looks up the actual queue without redispatch", async () => {
  const f = await fixture(),
    original = f.options.jenkins.queue;
  let attempts = 0;
  f.options.jenkins.queue = async (...args) => {
    attempts++;
    await original(...args);
    throw new Error("POST response lost");
  };
  await assert.rejects(f.advance(), /response lost/);
  const scope = scopedRequests(spec());
  assert.equal(
    (await f.state()).scopedRequests[scope.key].dispatchIntents.api.state,
    "dispatching",
  );
  const recovered = await f.reconcile();
  assert.equal(recovered.scopedPending, 1);
  const pending = (await f.state()).pending[0];
  assert.equal(pending.queueId, 1);
  assert.equal(pending.dispatchedByScope, true);
  await f.advance();
  assert.equal(attempts, 1);
  assert.equal(f.calls.length, 1);
});
test("unobserved unknown POST is held permanently and never silently resubmitted", async () => {
  const f = await fixture();
  let attempts = 0;
  f.options.jenkins.queue = async () => {
    attempts++;
    throw new Error("no response");
  };
  await assert.rejects(f.advance());
  for (let count = 0; count < 3; count++) {
    const result = await f.advance();
    assert.match(result.errors[0].error, /lookup only, no redispatch/);
    assert.equal(result.scopedUnresolvedDispatches, 1);
  }
  assert.equal(attempts, 1);
});
test("Root snapshot and abort are scope-bound, and abort blocks the actual beforeQueue callback", async () => {
  const tools = await temporary(),
    path = join(tools, "request.json");
  await json(path, spec());
  const options = { context: () => ({ tools }), assertLayout: async () => {} };
  const scope = scopedRequests(spec());
  await assert.rejects(
    runScopedRequest(
      ["--root-go", path, "snapshot", "--expect-scope", "0".repeat(64)],
      options,
    ),
    /differs/,
  );
  const snapshot = await runScopedRequest(
    ["--root-go", path, "snapshot", "--expect-scope", scope.key],
    options,
  );
  assert.equal(snapshot.record, null);
  await runScopedRequest(["--root-go", path, "abort"], options);
  let called = 0;
  await assert.rejects(
    runScopedRequest(["--root-go", path, "advance"], {
      ...options,
      createDiscoverer:
        ({ beforeQueue }) =>
        async () => {
          called++;
          await beforeQueue();
        },
    }),
    /permanently aborted/,
  );
  assert.equal(called, 1);
});
