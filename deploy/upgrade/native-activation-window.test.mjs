import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createNativeExecutor } from "./native-executor.mjs";
import { createCoordinatorClient } from "./coordinator-client.mjs";

// Actual HTTP carries independently controlled measurement contracts. These
// fast boundary tests do not claim a real 60s load window or Native qualification.
async function activationBoundary(t, options = {}) {
  const instanceId = "activation-window-contract", attemptId = "accepted-activation";
  const fence = 7, sourceDigest = "sha256:" + "a".repeat(64), apiDigest = "sha256:" + "b".repeat(64), webDigest = "sha256:" + "c".repeat(64);
  const requests = [], errors = [], timers = new Set();
  let observations = 0, validations = 0, last, revoked = false;
  const policy = { candidateStartupMs: 5000, stageDurationMs: 60000, observationFreshnessMs: 5000, minRequests: 100, probeHz: 10, requestDeadlineMs: 2000, attachDeadlineMs: 5000, softErrorDelta: 0.01, p95Ratio: 2, p95FloorMs: 1000, consecutiveEvaluations: 2, evaluationIntervalMs: 50, ...options.policy };
  const binding = { instanceId, attemptId, fence, routeGeneration: 6, weight: 100, oldApi: { origin: "http://127.0.0.1:9011", digest: sourceDigest }, candidateApi: { origin: "http://127.0.0.1:9012", digest: apiDigest }, web: { origin: "http://127.0.0.1:9013", root: "/contract/old-web", digest: sourceDigest, treeDigest: sourceDigest }, retainedWeb: [] };
  const candidate = { origin: binding.candidateApi.origin, artifactDigest: apiDigest, startIdentity: "accepted-api-start" };
  function measurement() {
    const phase = options.alwaysFull ? "full" : observations === 1 ? "empty" : observations === 2 ? "partial" : "full";
    const empty = phase === "empty", full = phase === "full", windowMs = empty ? 0 : full ? 60000 : 59999;
    const samples = empty ? 0 : 1201;
    const lane = { known: !empty, hz: empty ? 0 : 10, samples, failures: 0, maxLatencyMs: empty ? null : 1, windowMs };
    return { observedAt: new Date().toISOString(), coordinatorGeneration: 2, observerEpoch: "accepted-observer-epoch", fenceValid: true, ownerGenerationsValid: true, routeGenerationValid: true, sharedStateHealthy: true, continuity: { qualified: true }, invariants: Object.fromEntries(["unauthorizedStops", "resourceRebuilds", "duplicateCommands", "duplicateOccurrences", "writerConflicts", "migrationDifferences", "integrityFailures"].map(k => [k, 0])), webHealth: { known: true, healthy: true, artifactDigest: binding.web.digest }, probes: { ...lane, attachMaxMs: empty ? null : 1 }, candidateProbes: { ...lane }, candidate: { known: !empty, requests: samples, errorRate: empty ? null : 0, p95Ms: empty ? null : 1, windowMs }, baseline: { known: full, qualified: full, requests: samples, failures: 0, errorRate: empty ? null : 0, p95Ms: empty ? null : 1, windowMs, source: empty ? null : { instanceId, attemptId, fence, routeGeneration: binding.routeGeneration, routeWeight: binding.weight, weight: 0, coordinatorGeneration: 2, observerEpoch: "accepted-observer-epoch", origin: binding.oldApi.origin, artifactDigest: sourceDigest, startIdentity: "accepted-source-start", observedAt: new Date().toISOString() } }, windowMs };
  }
  let origin;
  const server = createServer(async (req, res) => {
    try {
      let text = ""; for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : undefined, url = new URL(req.url, "http://localhost"), path = url.pathname;
      requests.push({ path, method: req.method, body, at: Date.now() });
      let result;
      if (path.endsWith("/renew")) {
        if (revoked) { res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ code: "UPGRADE_FENCE_EXPIRED" })); return; }
        result = { current: true };
      } else if (path === "/binding") {
        if (req.method === "POST") Object.assign(binding, body);
        result = { ...binding, inFlight: requests.length, activeWS: 1, httpByDigest: { [apiDigest]: requests.length }, wsByDigest: { [sourceDigest]: 1 } };
      } else if (path === "/start") {
        assert.equal(body.kind, "web"); result = { origin, artifactDigest: webDigest, startIdentity: "accepted-web-start", pid: process.pid };
      } else if (path === "/observe") {
        assert.equal(body.kind, "web"); result = { qualified: true, pid: process.pid, record: { origin, artifactDigest: webDigest, startIdentity: "accepted-web-start", pid: process.pid } };
      } else if (path === "/web-process") {
        result = { instanceId, artifactDigest: webDigest, startIdentity: "accepted-web-start", webRevision: "d".repeat(40), pid: process.pid };
      } else if (path === "/web-build") result = { webRevision: "d".repeat(40) };
      else if (path === "/internal/upgrades/" + attemptId) {
        const anchor = { known: true, qualified: true, source: { instanceId, attemptId, fence, routeGeneration: 6, routeWeight: 100, weight: 0, coordinatorGeneration: 2, observerEpoch: "accepted-observer-epoch", origin: binding.oldApi.origin, artifactDigest: sourceDigest, startIdentity: "accepted-source-start" } };
        result = { sourceActivation: { components: { api: { artifactDigest: sourceDigest } } }, appliedSteps: [{ stepId: "candidate", evidence: candidate }, { stepId: "coordinator-handoff", evidence: { generation: 2, sourceBaseline: { ...anchor, source: { ...anchor.source, routeGeneration: 1, routeWeight: 0 } } } }, { stepId: "observe-100", evidence: { baseline: anchor } }] };
        if (options.snapshot) options.snapshot(result);
      }
      else if (path === "/internal/upgrades/observation") {
        assert.equal(Number(url.searchParams.get("weight")), 100);
        observations++; result = measurement(); if (options.transform) options.transform(result, { observations, binding, requests }); last = result;
        if (options.revokeAfterObservation) revoked = true;
      } else if (path.endsWith("/validate-switch")) {
        validations++; assert.equal(body.actual.routeGeneration, options.webReused ? 6 : 7); assert.equal(body.actual.weight, 100);
        result = { qualified: last?.baseline.known === true, controlOnly: true, noRuntimeSideEffects: true, authContinuity: true, originalResourceAddressable: true, businessMatches: true, webMatches: true, identity: { artifactDigest: apiDigest, startIdentity: candidate.startIdentity }, baselineSamples: last?.baseline.requests ?? 0 };
        if (options.compatibility) options.compatibility(result, { validations, observations });
        if (options.validationDelayMs) await new Promise(resolve => { const timer = setTimeout(() => { timers.delete(timer); resolve(); }, options.validationDelayMs); timers.add(timer); });
      } else if (path === "/internal/upgrades/continuity") result = { qualified: true };
      else if (path === "/current-installer") {
        result = { instanceId, artifactDigest: apiDigest, startIdentity: "accepted-installer" };
        if (options.installerDelayMs) await new Promise(resolve => { const timer = setTimeout(() => { timers.delete(timer); resolve(); }, options.installerDelayMs); timers.add(timer); });
      }
      else assert.fail("Unexpected activation contract RPC: " + path);
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(result));
    } catch (error) { errors.push(error); res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ code: "CONTRACT_RECEIVER_FAILED" })); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); origin = "http://127.0.0.1:" + server.address().port;
  t.after(async () => { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(errors, []); });
  const executor = createNativeExecutor({ root: "/activation-boundary-only", instanceId, coordinator: createCoordinatorClient({ origin, instanceId, key: "k".repeat(32) }), entryOrigin: origin, entryKey: "e".repeat(32), supervisorOrigin: origin, supervisorKey: "s".repeat(32) });
  const input = { fence, attempt: { attemptId, targetDigest: "sha256:" + "f".repeat(64), manifest: { components: { api: { artifactDigest: apiDigest }, coordinator: { artifactDigest: apiDigest }, web: { artifactDigest: webDigest, webRevision: "d".repeat(40) } } }, plan: { apiReused: false, webReused: options.webReused === true, policy } }, artifact: { root: "/contract/target", treeDigest: "sha256:" + "e".repeat(64) } };
  if (options.webReused) binding.web = { ...binding.web, digest: webDigest, origin, root: "/contract/target/web" };
  else await executor.bindWeb(input);
  assert.equal(binding.routeGeneration, options.webReused ? 6 : 7);
  const fixedBefore = structuredClone(binding), beforeActions = requests.filter(r => ["/start", "/observe"].includes(r.path)).length;
  function unchanged() { assert.deepEqual(binding, fixedBefore); assert.equal(requests.filter(r => r.method === "POST" && r.path === "/binding").length, options.webReused ? 0 : 1); assert.equal(requests.filter(r => ["/start", "/observe"].includes(r.path)).length, beforeActions); }
  return { executor, input, requests, binding, unchanged, counts: () => ({ observations, validations }) };
}

test("changed API activation waits after the actual Web generation reset for an empty, partial and complete fresh window", async t => {
  const f = await activationBoundary(t);
  const result = await f.executor.activationEvidence(f.input);
  assert.equal(f.counts().observations, 3);
  assert.equal(result.activationScope.routeGeneration, 7);
  assert.equal(result.activationScope.weight, 100);
  assert.equal(result.activationScope.observerEpoch, "accepted-observer-epoch");
  assert.equal(result.activationObservation.baseline.windowMs, 60000);
  assert.equal(result.compatibility.qualified, true);
  f.unchanged();
});

test("changed API with reused Web accepts the already qualified identical serving scope without binding or starting roles", async t => {
  const f = await activationBoundary(t, { alwaysFull: true, webReused: true });
  const result = await f.executor.activationEvidence(f.input);
  assert.equal(result.activationScope.routeGeneration, 6);
  assert.equal(result.activationScope.weight, 100);
  assert.equal(f.counts().observations, 1);
  assert.equal(result.compatibility.qualified, true);
  assert.equal(f.requests.filter(r => ["/start", "/observe"].includes(r.path)).length, 0);
  f.unchanged();
});

test("same complete counts under an old route/fence/epoch/source identity cannot confirm activation", async t => {
  for (const [name, transform] of [
    ["old route generation", r => r.baseline.source.routeGeneration--],
    ["old route weight", r => r.baseline.source.routeWeight = 0],
    ["old fence", r => r.baseline.source.fence--],
    ["other epoch", r => r.baseline.source.observerEpoch = "other-observer"],
    ["other source digest", r => r.baseline.source.artifactDigest = "sha256:" + "f".repeat(64)],
    ["source process replaced before first fresh proof", r => r.baseline.source.startIdentity = "replacement-source-start"],
  ]) await t.test(name, async t => {
    const f = await activationBoundary(t, { alwaysFull: true, transform });
    await assert.rejects(f.executor.activationEvidence(f.input), { code: "ACTIVATION_SOURCE_SCOPE_CHANGED" });
    assert.equal(f.counts().validations, 0); f.unchanged();
  });
});

test("source incarnation must come from a durable pre-Web receipt, with a handoff anchor as the only fallback", async t => {
  for (const [name, snapshot] of [
    ["missing both source anchors", s => s.appliedSteps = s.appliedSteps.filter(step => step.stepId === "candidate")],
    ["malformed latest observe receipt cannot fall through", s => s.appliedSteps.find(step => step.stepId === "observe-100").evidence.baseline.source = null],
    ["wrong persisted source tuple", s => s.appliedSteps.find(step => step.stepId === "observe-100").evidence.baseline.source.artifactDigest = "sha256:" + "f".repeat(64)],
  ]) await t.test(name, async t => {
    const f = await activationBoundary(t, { alwaysFull: true, snapshot });
    await assert.rejects(f.executor.activationEvidence(f.input), { code: "ACTIVATION_SOURCE_ANCHOR_UNKNOWN" });
    assert.equal(f.counts().observations, 0); f.unchanged();
  });
  for (const [name, webReused, anchorGeneration] of [["Web reused unexpected generation", true, 5], ["Web changed skipped generation", false, 5]]) await t.test(name, async t => {
    const f = await activationBoundary(t, { alwaysFull: true, webReused, snapshot: s => s.appliedSteps.find(step => step.stepId === "observe-100").evidence.baseline.source.routeGeneration = anchorGeneration });
    await assert.rejects(f.executor.activationEvidence(f.input), { code: "ACTIVATION_SOURCE_ANCHOR_UNKNOWN" });
    assert.equal(f.counts().observations, 0); f.unchanged();
  });
  await t.test("existing verified handoff receipt", async t => {
    const f = await activationBoundary(t, { alwaysFull: true, snapshot: s => s.appliedSteps = s.appliedSteps.filter(step => step.stepId !== "observe-100") });
    assert.equal((await f.executor.activationEvidence(f.input)).compatibility.qualified, true);
    f.unchanged();
  });
});

test("source evidence time is checked separately from its fresh observation wrapper", async t => {
  for (const [name, time] of [["stale", () => new Date(Date.now() - 5001).toISOString()], ["future", () => new Date(Date.now() + 5000).toISOString()], ["null with samples", () => null]]) await t.test(name, async t => {
    const f = await activationBoundary(t, { alwaysFull: true, transform: r => r.baseline.source.observedAt = time() });
    await assert.rejects(f.executor.activationEvidence(f.input), { code: "OBSERVATION_STALE" });
    assert.equal(f.counts().validations, 0); f.unchanged();
  });
  await t.test("begin cohort identity without its first sample is pending", async t => {
    const f = await activationBoundary(t, { transform: (r, { observations }) => {
      if (observations !== 1) return;
      r.probes.maxLatencyMs = r.candidateProbes.maxLatencyMs = 0;
      r.probes.attachMaxMs = 0;
      r.baseline.source = { instanceId: "activation-window-contract", attemptId: f.input.attempt.attemptId, fence: f.input.fence, routeGeneration: 7, routeWeight: 100, weight: 0, coordinatorGeneration: 2, observerEpoch: "accepted-observer-epoch", origin: f.binding.oldApi.origin, artifactDigest: f.binding.oldApi.digest, startIdentity: "accepted-source-start", observedAt: null };
    } });
    assert.equal((await f.executor.activationEvidence(f.input)).compatibility.qualified, true);
    assert.equal(f.counts().observations, 3); f.unchanged();
  });
});

test("fresh-window collection refuses recorded faults immediately, including an otherwise exactly empty cohort", async t => {
  for (const [name, transform, code] of [
    ["empty cohort Owner violation", r => r.ownerGenerationsValid = false, "CONTROL_OR_OWNERSHIP_UNKNOWN"],
    ["empty cohort invariant violation", r => r.invariants.unauthorizedStops = 1, "HARD_INVARIANT_VIOLATION"],
    ["empty cohort continuity loss", r => r.continuity.qualified = false, "SHARED_STATE_OR_CONTINUITY_UNKNOWN"],
    ["empty cohort dead Web", r => r.webHealth.healthy = false, "WEB_UNHEALTHY"],
    ["gateway failure", r => r.probes.failures = 1, "SLO_PROBE_FAILED"],
    ["source failure", r => r.baseline.failures = 1, "ACTIVATION_SOURCE_BASELINE_UNSAFE"],
    ["candidate failure", r => r.candidateProbes.failures = 1, "SLO_PROBE_FAILED"],
    ["measured latency breach", r => r.candidateProbes.maxLatencyMs = 2001, "SLO_PROBE_FAILED"],
  ]) await t.test(name, async t => {
    const f = await activationBoundary(t, { transform });
    await assert.rejects(f.executor.activationEvidence(f.input), { code });
    assert.equal(f.counts().observations, 1); f.unchanged();
  });
});

test("serving binding, accepted process and Observer identity cannot change while waiting", async t => {
  for (const [name, options, code] of [
    ["binding generation", { transform: (_r, { binding }) => binding.routeGeneration++ }, "ACTIVATION_BINDING_CHANGED"],
    ["Coordinator generation", { transform: r => r.coordinatorGeneration++ }, "ACTIVATION_OBSERVER_SCOPE_CHANGED"],
    ["Observer epoch", { transform: r => r.observerEpoch = "restarted-observer" }, "ACTIVATION_OBSERVER_SCOPE_CHANGED"],
    ["accepted API start", { compatibility: r => r.identity.startIdentity = "replacement-api" }, "ACTIVATION_PHYSICAL_IDENTITY_CHANGED"],
    ["lost actual fence", { revokeAfterObservation: true }, "UPGRADE_FENCE_EXPIRED"],
  ]) await t.test(name, async t => {
    const f = await activationBoundary(t, options);
    await assert.rejects(f.executor.activationEvidence(f.input), { code });
    assert.equal(f.requests.filter(r => r.method === "POST" && r.path === "/binding").length, 1);
    assert.equal(f.requests.filter(r => r.path === "/start").length, 1);
  });
});

test("one activation budget covers collection and a late validating RPC", async t => {
  for (const [name, options] of [
    ["never collected", { policy: { candidateStartupMs: 80 }, transform: r => { r.baseline.known = false; r.baseline.qualified = false; r.baseline.windowMs = 0; r.windowMs = 0; } }],
    ["late qualification", { policy: { candidateStartupMs: 100 }, alwaysFull: true, validationDelayMs: 250 }],
  ]) await t.test(name, async t => {
    const f = await activationBoundary(t, options), started = Date.now();
    await assert.rejects(f.executor.activationEvidence(f.input), { code: "ACTIVATION_SCOPE_COLLECTION_EXCEEDED" });
    assert.ok(Date.now() - started < 600); f.unchanged();
    // The total-budget race cannot cancel an already dispatched read. Its late
    // completion must never cause another retry, role action or confirmation.
    const afterAbort = f.requests.length;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(f.requests.length, afterAbort); f.unchanged();
  });
});

test("fast collection polling cannot accelerate signed soft-degradation evaluation intervals", async t => {
  const interval = 1500;
  const f = await activationBoundary(t, { alwaysFull: true, policy: { evaluationIntervalMs: interval }, transform: r => { r.candidate.p95Ms = 1501; r.candidateProbes.maxLatencyMs = 1501; r.probes.maxLatencyMs = 1501; } });
  const started = Date.now();
  await assert.rejects(f.executor.activationEvidence(f.input), { code: "SOFT_TRAFFIC_DEGRADATION" });
  assert.ok(Date.now() - started >= interval);
  assert.ok(f.counts().observations >= 3);
  f.unchanged();
});

test("a slow final read cannot freshly stamp an expired activation observation or source proof", async t => {
  const f = await activationBoundary(t, { alwaysFull: true, policy: { observationFreshnessMs: 100 }, installerDelayMs: 200 });
  await assert.rejects(f.executor.activationEvidence(f.input), { code: "OBSERVATION_STALE" });
  assert.equal(f.requests.filter(r => r.path === "/current-installer").length, 1);
  assert.equal(f.counts().observations, 1);
  f.unchanged();
});
