import { test } from "node:test";
import assert from "node:assert/strict";
import { scopedRequests } from "./jenkins-discover.mjs";
import {
  runScopedMonitor,
  watchScopedCI,
  stopOwnedRuns,
} from "./scoped-ci-monitor.mjs";

const GiB = 1024 ** 3;
const request = {
  schemaVersion: 1,
  requestId: "watch-r1",
  commits: {
    project: "a".repeat(40),
    api: "b".repeat(40),
    web: "c".repeat(40),
  },
  pullRequests: { project: 69, api: 51, web: 47 },
};
const scope = scopedRequests(request);
const actions = (params) => [
  {
    parameters: Object.entries(params).map(([name, value]) => ({
      name,
      value,
    })),
  },
];
function stopFixture(repo = "api") {
  const selected = scope.requests.find((item) => item.repo === repo);
  const dispatch = {
    ...selected,
    scopeKey: scope.key,
    dispatchedByScope: true,
    queueId: 11,
    location: `http://127.0.0.1:8080/job/${selected.job}/21/`,
    buildNumber: 21,
    executableQueueId: 11,
  };
  const actual = {
    number: 21,
    queueId: 11,
    building: true,
    url: `https://jenkins.douglasdong.com/job/${selected.job}/21/`,
    actions: actions(selected.params),
  };
  const posts = [];
  return {
    dispatch,
    actual,
    posts,
    snapshot: {
      scopeKey: scope.key,
      pending: [dispatch],
      record: { results: {} },
    },
    client: {
      get: async () => actual,
      post: async (path) => {
        posts.push(path);
        actual.building = false;
      },
    },
  };
}
test("external monitor is held before filesystem, credentials, VM or network actions", async () => {
  assert.deepEqual(await runScopedMonitor([]), { state: "held", actions: 0 });
});
test("external ownstop accepts public URLs and observes actual terminal state after stopping only its build", async () => {
  const f = stopFixture(),
    sent = new Set();
  assert.equal(
    (await stopOwnedRuns(request, f.snapshot, f.client, sent)).terminal,
    false,
  );
  assert.deepEqual(f.posts, ["job/agent-platform-native-ci/21/stop"]);
  assert.equal(
    (await stopOwnedRuns(request, f.snapshot, f.client, sent)).terminal,
    true,
  );
  assert.equal(f.posts.length, 1);
});
test("external ownstop accepts an owned persisted public build location", async () => {
  const f = stopFixture();
  f.dispatch.location = f.actual.url;
  const result = await stopOwnedRuns(request, f.snapshot, f.client);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(f.posts, ["job/agent-platform-native-ci/21/stop"]);
});
test("external ownstop refuses another queue/build/parameter tuple", async () => {
  for (const mutate of [
    (f) => {
      f.actual.queueId++;
    },
    (f) => {
      f.actual.actions = actions({});
    },
    (f) => {
      f.dispatch.dispatchedByScope = false;
    },
    (f) => {
      f.actual.number++;
    },
  ]) {
    const f = stopFixture();
    mutate(f);
    const result = await stopOwnedRuns(request, f.snapshot, f.client);
    assert.equal(result.terminal, false);
    assert.ok(result.errors.length > 0);
    assert.equal(f.posts.length, 0);
  }
});
test("external ownstop aborts only the exact Web upstream child before its parent", async () => {
  const f = stopFixture("web"),
    child = scope.requests[2];
  const actualChild = {
    number: 31,
    queueId: 12,
    building: true,
    url: "https://jenkins.douglasdong.com/job/agent-platform-contract/31/",
    actions: [
      ...actions(child.params),
      {
        causes: [
          {
            _class: "hudson.model.Cause$UpstreamCause",
            upstreamProject: f.dispatch.job,
            upstreamBuild: 21,
          },
        ],
      },
    ],
  };
  f.client.get = async (path) => {
    if (path === "queue/api/json") return { items: [] };
    if (path.startsWith("job/agent-platform-contract/api/"))
      return { builds: [actualChild] };
    return path.includes("contract/31") ? actualChild : f.actual;
  };
  f.client.post = async (path) => {
    f.posts.push(path);
    (path.includes("contract") ? actualChild : f.actual).building = false;
  };
  const result = await stopOwnedRuns(request, f.snapshot, f.client);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(f.posts, [
    "job/agent-platform-contract/31/stop",
    "job/agent-platform-web/21/stop",
  ]);
});
test("watcher admits fresh capacity and waits for all three actual results and empty outbox", async () => {
  let clock = 1000,
    samples = 0,
    prepared = 0;
  const result = await watchScopedCI({
    request,
    now: () => clock,
    sample: async () => ({
      hostFreeBytes: 9 * GiB,
      vmFreeBytes: 20 * GiB,
      buildVmAllocatedBytes: 30 * GiB,
      observedAtMs: clock,
    }),
    snapshot: async () => {
      samples++;
      return {
        scopeKey: scope.key,
        pending: [],
        pendingStatuses: samples < 2 ? 1 : 0,
        record: {
          results: {
            api: { result: "SUCCESS" },
            web: { result: "SUCCESS" },
            project: { result: "SUCCESS" },
          },
        },
      };
    },
    abort: async () => assert.fail("must not abort"),
    stop: async () => assert.fail("must not stop"),
    ready: async () => {
      prepared++;
    },
    log: async () => {},
    wait: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(result.state, "ci-passed-and-capacity-observed");
  assert.equal(prepared, 1);
  assert.equal(samples, 2);
});
test("watcher aborts dispatch on a capacity breach and continues sampling until own runs are terminal", async () => {
  let clock = 1000,
    sampleCalls = 0,
    aborts = 0,
    stops = 0;
  const result = await watchScopedCI({
    request,
    now: () => clock,
    sample: async () => ({
      hostFreeBytes: (++sampleCalls === 1 ? 9 : 3) * GiB,
      vmFreeBytes: 20 * GiB,
      buildVmAllocatedBytes: 30 * GiB,
      observedAtMs: clock,
    }),
    snapshot: async () => ({ scopeKey: scope.key, pending: [], record: null }),
    abort: async () => {
      aborts++;
    },
    stop: async () => ({
      terminal: ++stops === 2,
      active: ["owned"],
      errors: [],
    }),
    ready: async () => {},
    log: async () => {},
    wait: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(result.state, "aborted-owned-runs-terminal");
  assert.equal(aborts, 1);
  assert.equal(stops, 2);
  assert.ok(sampleCalls >= 3);
});
test("watcher refuses insufficient startup capacity before ready or any ownstop", async () => {
  const result = await watchScopedCI({
    request,
    now: () => 1000,
    sample: async () => ({
      hostFreeBytes: 7 * GiB,
      vmFreeBytes: 20 * GiB,
      buildVmAllocatedBytes: 30 * GiB,
      observedAtMs: 1000,
    }),
    ready: async () => assert.fail("must remain held"),
  });
  assert.equal(result.state, "held");
  assert.equal(result.reason, "start-below-8gib");
});
