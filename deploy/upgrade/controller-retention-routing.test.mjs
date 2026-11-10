import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInstanceController } from "./instance-controller.mjs";
import { createCoordinatorClient } from "./coordinator-client.mjs";
import { atomicJson, readJson } from "./io.mjs";
import { digest } from "./trust.mjs";

const id = "77777777-7777-4777-8777-777777777779",
  artifact = digest("serving-api");
function observed(weight, patch = {}) {
  const source = {
    known: true,
    qualified: true,
    requests: 1200,
    errorRate: 0,
    p95Ms: 10,
    windowMs: 60000,
  };
  const absent = {
    known: false,
    requests: 0,
    errorRate: null,
    p95Ms: null,
    windowMs: 0,
  };
  return {
    observedAt: new Date().toISOString(),
    fenceValid: true,
    ownerGenerationsValid: true,
    routeGenerationValid: true,
    sharedStateHealthy: true,
    continuity: { qualified: true },
    web: { qualified: true },
    invariants: Object.fromEntries(
      [
        "unauthorizedStops",
        "resourceRebuilds",
        "duplicateCommands",
        "duplicateOccurrences",
        "writerConflicts",
        "migrationDifferences",
        "integrityFailures",
      ].map((k) => [k, 0]),
    ),
    probes: {
      known: true,
      hz: 20,
      samples: 1200,
      failures: 0,
      maxLatencyMs: 10,
      attachMaxMs: 10,
      windowMs: 60000,
    },
    candidateProbes:
      weight === 0
        ? {
            known: false,
            hz: 0,
            samples: 0,
            failures: 0,
            maxLatencyMs: null,
            windowMs: 0,
          }
        : {
            known: true,
            hz: 20,
            samples: 1200,
            failures: 0,
            maxLatencyMs: 10,
            windowMs: 60000,
          },
    candidate: weight === 0 ? absent : source,
    baseline: source,
    windowMs: 60000,
    ...patch,
  };
}
// Real Controller/CoordinatorClient/journal and HTTP, with actual observation
// contract doubles. These checks are not native or production qualification.
async function fixture(
  t,
  { apiReused = true, weight = 0, routeDigest = artifact, patch = {} } = {},
) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "retention-route-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plan = {
    apiReused,
    policy: {
      retentionMs: 600000,
      evaluationIntervalMs: 1,
      observationFreshnessMs: 5000,
      stageDurationMs: 60000,
      minRequests: 100,
      probeHz: 10,
      requestDeadlineMs: 2000,
      attachDeadlineMs: 5000,
      softErrorDelta: 0.01,
      p95Ratio: 2,
      p95FloorMs: 1000,
      consecutiveEvaluations: 2,
    },
    steps: [],
  };
  plan.planDigest = digest(plan);
  const attempt = {
    attemptId: id,
    instanceId: "retention-instance",
    state: "activation-confirmed",
    generation: 2,
    sequence: 9,
    targetDigest: digest("manifest"),
    observedAt: new Date().toISOString(),
  };
  const manifest = { components: { api: { artifactDigest: artifact } } },
    events = [],
    observationWeights = [];
  const actual = {
    instanceId: attempt.instanceId,
    attemptId: id,
    fence: 4,
    routeGeneration: 3,
    weight,
    oldApi: { origin: "http://127.0.0.1:3101", digest: routeDigest },
    candidateApi:
      weight === 0
        ? null
        : { origin: "http://127.0.0.1:3102", digest: routeDigest },
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const send = (x) => res.end(JSON.stringify(x));
    const snapshot = () => ({ attempt: { ...attempt }, plan, manifest });
    if (req.method === "GET") return send(snapshot());
    let body = "";
    for await (const chunk of req) body += chunk;
    const command = JSON.parse(body);
    if (req.url.endsWith("/claim"))
      return send({ fence: 4, generation: 2, snapshot: snapshot() });
    if (req.url.endsWith("/renew")) return send({ fence: 4 });
    assert.ok(req.url.endsWith("/commit"));
    assert.equal(command.kind, "ready-revoked");
    assert.equal(command.fence, 4);
    assert.equal(command.generation, 2);
    assert.equal(command.expectedSequence, attempt.sequence);
    events.push(command);
    attempt.sequence++;
    return send(snapshot());
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((ok) => server.close(ok));
  });
  await atomicJson(join(root, "journals", id + ".json"), {
    attemptId: id,
    planDigest: plan.planDigest,
    steps: {},
  });
  const coordinator = createCoordinatorClient({
    origin: "http://127.0.0.1:" + server.address().port,
    instanceId: attempt.instanceId,
    key: "contract-only-retention-controller-key",
  });
  const executor = {
    actual: async () => structuredClone(actual),
    observe: async (input) => {
      observationWeights.push(input.weight);
      return observed(input.weight, {
        ...patch,
        routeGenerationValid:
          input.weight === actual.weight &&
          patch.routeGenerationValid !== false,
      });
    },
    fallbackEligibility: async () => ({ qualified: false }),
    recover: async () => {
      throw Error("no recovery capability in this fixture");
    },
  };
  const controller = createInstanceController({
    root,
    instanceId: attempt.instanceId,
    controllerId: "retention-controller",
    coordinator,
    executor,
  });
  return {
    controller,
    events,
    observationWeights,
    actual,
    attempt,
    journal: () => readJson(join(root, "journals", id + ".json")),
  };
}
test("Installer-only retention observes the actual zero-weight source and leaves missing candidate evidence unknown", async (t) => {
  const f = await fixture(t);
  const binding = structuredClone(f.actual);
  for (let i = 0; i < 3; i++) {
    assert.equal(
      (await f.controller.monitorOnce()).state,
      "retention-observed",
    );
    await new Promise((ok) => setTimeout(ok, 3));
  }
  assert.deepEqual(f.observationWeights, [0, 0, 0]);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.actual, binding);
  assert.equal(f.attempt.state, "activation-confirmed");
  assert.equal((await f.journal()).circuitBroken, undefined);
});
test("changed API retention still observes the actual fully switched candidate at weight100", async (t) => {
  const f = await fixture(t, { apiReused: false, weight: 100 });
  assert.equal((await f.controller.monitorOnce()).state, "retention-observed");
  assert.deepEqual(f.observationWeights, [100]);
  assert.deepEqual(f.events, []);
});
for (const change of [
  { weight: 25 },
  { routeDigest: digest("different-api") },
  { apiReused: false, weight: 0 },
])
  test(
    "unconfirmed final route still revokes readiness: " +
      JSON.stringify(change),
    async (t) => {
      const f = await fixture(t, change);
      assert.equal((await f.controller.monitorOnce()).state, "ready-revoked");
      assert.deepEqual(f.observationWeights, []);
      assert.equal(f.events[0].payload.reason, "CONFIRMED_ROUTE_UNCONFIRMED");
      assert.equal(f.attempt.state, "activation-confirmed");
    },
  );
for (const patch of [
  { ownerGenerationsValid: false },
  { sharedStateHealthy: false },
  { web: { qualified: false } },
  {
    probes: {
      known: true,
      hz: 20,
      samples: 1200,
      failures: 1,
      maxLatencyMs: 10,
      attachMaxMs: 10,
      windowMs: 60000,
    },
  },
])
  test(
    "zero-weight retention retains the existing health gate: " +
      JSON.stringify(patch),
    async (t) => {
      const f = await fixture(t, { patch });
      assert.equal((await f.controller.monitorOnce()).state, "ready-revoked");
      assert.deepEqual(f.observationWeights, [0]);
      assert.equal(f.events.length, 1);
      assert.equal(f.attempt.state, "activation-confirmed");
    },
  );
