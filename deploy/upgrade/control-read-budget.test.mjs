import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createCoordinatorClient } from "./coordinator-client.mjs";
import { createNativeExecutor } from "./native-executor.mjs";
import { inspectObservation } from "./circuit-breaker.mjs";

async function receiver(t, handler) {
  const calls = [], errors = [], timers = new Set();
  const wait = (ms) => new Promise((resolve) => {
    const timer = setTimeout(() => { timers.delete(timer); resolve(); }, ms);
    timers.add(timer);
  });
  const server = createServer(async (request, response) => {
    try {
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = text ? JSON.parse(text) : undefined;
      const url = new URL(request.url, "http://localhost");
      calls.push({ path: url.pathname, method: request.method, body });
      const result = await handler({ url, body, response, wait });
      if (!response.destroyed && !response.writableEnded) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(result));
      }
    } catch (error) {
      errors.push(error);
      if (!response.destroyed) response.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  return { origin: "http://127.0.0.1:" + server.address().port, calls };
}

test("only explicit read controls outlive 5s; fence requests retain the default deadline", async (t) => {
  const f = await receiver(t, async ({ url, body, wait }) => {
    await wait(5200);
    if (url.pathname.endsWith("/fallback-eligibility")) {
      assert.equal(body.fault.code, "observed-fault");
      return { qualified: true };
    }
    return { qualified: true };
  });
  const client = createCoordinatorClient({ origin: f.origin, instanceId: "read-budget", key: "k".repeat(32) });
  const results = await Promise.allSettled([
    client.observation("original-attempt", { fence: 7, weight: 0 }, { timeoutMs: 8000 }),
    client.fallbackEligibility("original-attempt", { fence: 7, fault: { code: "observed-fault" } }, { timeoutMs: 8000 }),
    client.assertFence("original-attempt", 7),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "fulfilled");
  assert.equal(results[2].status, "rejected");
  assert.equal(results[2].reason.name, "TimeoutError");
  assert.equal(results[2].reason.rpcContext.timeoutMs, 5000);
  assert.equal(f.calls.length, 3);
});

test("invalid control-read budgets fail before transport, including nonintegers and over 120s", () => {
  let calls = 0;
  const client = createCoordinatorClient({ origin: "http://127.0.0.1:1", instanceId: "budget-validation", key: "k".repeat(32), fetcher: async () => { calls++; throw Error("unexpected transport"); } });
  for (const timeoutMs of [0, -1, 1.5, 120001, NaN, Infinity]) {
    for (const method of ["observation", "fallbackEligibility"])
      assert.throws(() => client[method]("original", { fence: 7, weight: 0 }, { timeoutMs }), (error) => error.code === "INVALID_CONTROL_READ_TIMEOUT");
  }
  assert.equal(calls, 0);
});

test("RPC failure receipts contain routing and timing only, retaining the original error code", async (t) => {
  const f = await receiver(t, async ({ response }) => {
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "OBSERVATION_SCOPE_CHANGED" }));
  });
  const client = createCoordinatorClient({ origin: f.origin, instanceId: "private-instance-marker", key: "private-key-marker".repeat(3) });
  await assert.rejects(client.observation("private-query-marker", { fence: 7, weight: 0 }, { timeoutMs: 1500 }), (error) => {
    assert.equal(error.code, "OBSERVATION_SCOPE_CHANGED");
    assert.equal(error.status, 409);
    assert.equal(error.faultEvidence.rpc.path, "/internal/upgrades/observation");
    assert.equal(error.faultEvidence.rpc.action, null);
    assert.equal(error.faultEvidence.rpc.timeoutMs, 1500);
    assert.ok(Number.isFinite(Date.parse(error.faultEvidence.rpc.startedAt)));
    assert.ok(error.faultEvidence.rpc.elapsedMs >= 0);
    assert.doesNotMatch(JSON.stringify(error.faultEvidence), /private-|headers|body|127\.0\.0\.1|\?/);
    return true;
  });
  await assert.rejects(client.coordinatorHandoff("original", { action: "prepare", fence: 7, secret: "private-body-marker" }, { timeoutMs: 1600 }), (error) => {
    assert.equal(error.faultEvidence.rpc.action, "prepare");
    assert.equal(error.faultEvidence.rpc.timeoutMs, 1600);
    assert.doesNotMatch(JSON.stringify(error.faultEvidence), /private-|headers|body/);
    return true;
  });
});

test("normal observation and fallback reads explicitly bound control work without changing request or attachment SLOs", async (t) => {
  const controls = [], policy = { candidateStartupMs: 500, requestDeadlineMs: 2000, attachDeadlineMs: 5000 };
  const continuity = { qualified: true, observedAt: new Date().toISOString(), baselineDigest: "same-observation-proof" };
  const web = { origin: null, digest: "sha256:" + "a".repeat(64) };
  const f = await receiver(t, async ({ url }) => {
    if (url.pathname === "/binding") return { web };
    if (url.pathname === "/web-process") return { instanceId: "normal-observation", artifactDigest: web.digest, webRevision: "b".repeat(40), startIdentity: "fixed-web", pid: process.pid };
    if (url.pathname === "/web-build") return { webRevision: "b".repeat(40) };
    assert.fail("Unexpected control receiver path: " + url.pathname);
  });
  web.origin = f.origin;
  const coordinator = {
    async assertFence() {},
    async observation(id, body, options) { controls.push({ method: "observation", id, body, options }); return { sharedStateHealthy: true, continuity }; },
    async continuity() { assert.fail("normal observation must retain its original continuity proof"); },
    async fallbackEligibility(id, body, options) { controls.push({ method: "fallback", id, body, options }); return { qualified: false }; },
  };
  const executor = createNativeExecutor({ root: "/read-control-contract-only", instanceId: "normal-observation", coordinator, entryOrigin: f.origin, entryKey: "e".repeat(32), supervisorOrigin: f.origin, supervisorKey: "s".repeat(32) });
  const input = { attempt: { attemptId: "original", plan: { policy } }, fence: 7, weight: 0 };
  const observation = await executor.observe(input);
  assert.equal(observation.web.qualified, true);
  assert.equal(observation.continuity, continuity);
  assert.equal((await executor.fallbackEligibility({ ...input, fault: { code: "observed-fault" } })).qualified, false);
  assert.equal(controls.length, 2);
  assert.ok(controls[0].options.timeoutMs > 0 && controls[0].options.timeoutMs <= 500);
  assert.ok(controls[1].options.timeoutMs > 0 && controls[1].options.timeoutMs <= 120000);
  assert.equal(policy.requestDeadlineMs, 2000);
  assert.equal(policy.attachDeadlineMs, 5000);
});

for (const mode of ["qualified", "unqualified", "missing", "stale"]) {
  test("observation preserves its single HTTP proof and safety result: " + mode, async (t) => {
    const policy = {
      candidateStartupMs: 1000, observationFreshnessMs: 5000,
      requestDeadlineMs: 2000, attachDeadlineMs: 5000,
      stageDurationMs: 60000, probeHz: 10, minRequests: 100,
      softErrorDelta: 0.01, p95Ratio: 2, p95FloorMs: 1000,
      consecutiveEvaluations: 2,
    };
    const observedAt = new Date(Date.now() - (mode === "stale" ? 6000 : 0)).toISOString();
    const proof = {
      observedAt, fenceValid: true, ownerGenerationsValid: true,
      routeGenerationValid: true, sharedStateHealthy: true,
      coordinatorGeneration: 7, observerEpoch: "original-epoch",
      invariants: Object.fromEntries([
        "unauthorizedStops", "resourceRebuilds", "duplicateCommands",
        "duplicateOccurrences", "writerConflicts", "migrationDifferences", "integrityFailures",
      ].map((key) => [key, 0])),
      probes: { known: true, hz: 10, samples: 600, failures: 0, maxLatencyMs: 10, attachMaxMs: 20, windowMs: 60000 },
      candidateProbes: { known: true, hz: 10, samples: 600, failures: 0, maxLatencyMs: 10, windowMs: 60000 },
      candidate: { known: true, requests: 600, errorRate: 0, p95Ms: 10, windowMs: 60000 },
      baseline: { known: true, qualified: true, requests: 600, errorRate: 0, p95Ms: 10, windowMs: 60000 },
      windowMs: 60000,
      ...(mode === "missing" ? {} : {
        continuity: {
          instanceId: "single-observation", attemptId: "original", fence: 7,
          qualified: mode !== "unqualified", observedAt,
          baselineDigest: "original-baseline", reasons: mode === "unqualified" ? ["original-resource-unknown"] : [],
        },
      }),
    };
    const web = { origin: null, digest: "sha256:" + "a".repeat(64) };
    const f = await receiver(t, async ({ url, body }) => {
      if (url.pathname.endsWith("/renew")) {
        assert.deepEqual(body, { fence: 7, controllerId: null, checkOnly: true });
        return {};
      }
      if (url.pathname === "/internal/upgrades/observation") {
        assert.equal(url.searchParams.get("attemptId"), "original");
        assert.equal(url.searchParams.get("fence"), "7");
        assert.equal(url.searchParams.get("weight"), "25");
        return proof;
      }
      if (url.pathname === "/binding") return { web };
      if (url.pathname === "/web-process") return { instanceId: "single-observation", artifactDigest: web.digest, webRevision: "b".repeat(40), startIdentity: "fixed-web", pid: process.pid };
      if (url.pathname === "/web-build") return { webRevision: "b".repeat(40) };
      assert.fail("Unexpected extra proof request: " + url.pathname);
    });
    web.origin = f.origin;
    const coordinator = createCoordinatorClient({ origin: f.origin, instanceId: "single-observation", key: "k".repeat(32) });
    const executor = createNativeExecutor({ root: "/single-proof-contract-only", instanceId: "single-observation", coordinator, entryOrigin: f.origin, entryKey: "e".repeat(32), supervisorOrigin: f.origin, supervisorKey: "s".repeat(32) });
    const result = await executor.observe({ attempt: { attemptId: "original", plan: { policy } }, fence: 7, weight: 25 });
    assert.deepEqual({ ...result, web: undefined }, { ...proof, web: undefined });
    assert.equal(result.web.qualified, true);
    assert.equal(f.calls.filter((c) => c.path === "/internal/upgrades/observation").length, 1);
    assert.equal(f.calls.filter((c) => c.path === "/internal/upgrades/continuity").length, 0);
    const inspection = inspectObservation(result, policy);
    if (mode === "qualified") assert.equal(inspection.qualified, true);
    else assert.equal(inspection.fault, mode === "stale" ? "OBSERVATION_STALE" : "SHARED_STATE_OR_CONTINUITY_UNKNOWN");
  });
}
