import { test } from "node:test";
import assert from "node:assert/strict";
import { scopedRequests } from "./jenkins-discover.mjs";
import {
  capacityDecision,
  ownedStopEndpoint,
  ownedChildStopEndpoint,
} from "./scoped-ci-guard.mjs";

const GiB = 1024 ** 3;
const request = {
  schemaVersion: 1,
  requestId: "guard-r1",
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
function owned(repo = "api") {
  const selected = scope.requests.find((item) => item.repo === repo);
  const dispatch = {
    ...selected,
    scopeKey: scope.key,
    queueId: 11,
    dispatchedByScope: true,
    buildNumber: 21,
    executableQueueId: 11,
  };
  const observation = {
    number: 21,
    queueId: 11,
    building: true,
    url: `http://127.0.0.1:8080/job/${selected.job}/21/`,
    actions: actions(selected.params),
  };
  return { dispatch, observation };
}
test("capacity gate enforces 8GiB admission, 3GiB allocation and continuous 4GiB reserve", () => {
  const baseline = {
    hostFreeBytes: 9 * GiB,
    vmFreeBytes: 20 * GiB,
    buildVmAllocatedBytes: 30 * GiB,
    observedAtMs: 1000,
  };
  const good = {
    ...baseline,
    hostFreeBytes: 6 * GiB,
    buildVmAllocatedBytes: 33 * GiB,
    observedAtMs: 2000,
  };
  assert.equal(capacityDecision(baseline, good, 3000).admitted, true);
  assert.equal(
    capacityDecision({ ...baseline, hostFreeBytes: 8 * GiB - 1 }, good, 3000)
      .reason,
    "start-below-8gib",
  );
  assert.equal(
    capacityDecision(
      baseline,
      { ...good, buildVmAllocatedBytes: 33 * GiB + 1 },
      3000,
    ).reason,
    "allocation-above-3gib",
  );
  assert.equal(
    capacityDecision(baseline, { ...good, hostFreeBytes: 4 * GiB - 1 }, 3000)
      .reason,
    "reserve-below-4gib",
  );
  assert.equal(
    capacityDecision(baseline, good, 4001).reason,
    "capacity-observation-missing-or-stale",
  );
  assert.equal(
    capacityDecision(baseline, { ...good, vmFreeBytes: null }, 3000).admitted,
    false,
  );
  assert.equal(capacityDecision(baseline, good, 1999).admitted, false);
});
test("stop authority requires original dispatch plus exact request, queue and actual build identity", () => {
  const { dispatch, observation } = owned();
  assert.deepEqual(ownedStopEndpoint(request, dispatch, observation), {
    method: "POST",
    path: "job/agent-platform-native-ci/21/stop",
  });
  for (const mutate of [
    (d) => {
      d.scopeKey = "other";
    },
    (d) => {
      d.dispatchedByScope = false;
    },
    (d) => {
      d.params.SHA = "d".repeat(40);
    },
    (d) => {
      d.queueId++;
    },
    (d) => {
      d.buildNumber++;
    },
    (d) => {
      d.executableQueueId++;
    },
  ]) {
    const d = structuredClone(dispatch);
    mutate(d);
    assert.throws(() => ownedStopEndpoint(request, d, observation));
  }
  for (const mutate of [
    (o) => {
      o.number++;
    },
    (o) => {
      o.queueId++;
    },
    (o) => {
      o.building = false;
    },
    (o) => {
      o.url = "http://evil/";
    },
    (o) => {
      o.actions = actions({});
    },
  ]) {
    const o = structuredClone(observation);
    mutate(o);
    assert.throws(() => ownedStopEndpoint(request, dispatch, o));
  }
});
test("queue cancellation refuses a moved executable and does not target any worker or VM", () => {
  const { dispatch } = owned();
  delete dispatch.buildNumber;
  const queued = { id: 11, actions: actions(dispatch.params) };
  assert.deepEqual(ownedStopEndpoint(request, dispatch, queued), {
    method: "POST",
    path: "queue/cancelItem?id=11",
  });
  queued.executable = { number: 21 };
  assert.throws(
    () => ownedStopEndpoint(request, dispatch, queued),
    /resolve the actual executable/,
  );
});
test("a contract child stop requires its precise upstream owned Web build and all three SHAs", () => {
  const { dispatch, observation } = owned("web");
  const selected = scope.requests.find((item) => item.repo === "project");
  const child = {
    scopeKey: scope.key,
    job: selected.job,
    queueId: 12,
    buildNumber: 31,
    webBuildNumber: 21,
  };
  const actual = {
    number: 31,
    queueId: 12,
    building: true,
    url: "http://127.0.0.1:8080/job/agent-platform-contract/31/",
    actions: [
      ...actions(selected.params),
      {
        causes: [
          {
            _class: "hudson.model.Cause$UpstreamCause",
            upstreamProject: dispatch.job,
            upstreamBuild: 21,
          },
        ],
      },
    ],
  };
  assert.equal(
    ownedChildStopEndpoint(request, dispatch, observation, child, actual).path,
    "job/agent-platform-contract/31/stop",
  );
  for (const mutate of [
    (o) => {
      o.queueId++;
    },
    (o) => {
      o.actions[1].causes[0].upstreamBuild++;
    },
    (o) => {
      o.actions[0] = actions({})[0];
    },
    (o) => {
      o.building = false;
    },
  ]) {
    const o = structuredClone(actual);
    mutate(o);
    assert.throws(() =>
      ownedChildStopEndpoint(request, dispatch, observation, child, o),
    );
  }
});
