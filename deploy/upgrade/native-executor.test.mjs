import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createNativeExecutor } from "./native-executor.mjs";
import { createCoordinatorClient } from "./coordinator-client.mjs";
import { createStableEntry } from "./stable-entry.mjs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

// Actual delayed HTTP listeners exercise the executor boundary. The scoped
// supervisor/coordinator receivers are contract doubles, not Native evidence.
async function coldBoundary(
  t,
  {
    listenAfterMs = 220,
    startDelayMs = 0,
    budgetMs = 2000,
    validationDelayMs = 0,
    validationError = null,
  } = {},
) {
  const candidate = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        instanceId: "cold-case",
        startIdentity: "cold-process",
        artifactDigest: "sha256:" + "a".repeat(64),
        pid: process.pid,
      }),
    );
  });
  const reservation = createServer();
  await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const origin = "http://127.0.0.1:" + port;
  let timer,
    observations = 0,
    validations = 0,
    fences = 0;
  let validationReadyAt = 0;
  const record = {
    origin,
    startIdentity: "cold-process",
    artifactDigest: "sha256:" + "a".repeat(64),
    pid: process.pid,
  };
  const supervisor = createServer(async (req, res) => {
    if (req.url === "/binding") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ instanceId: "cold-case", attemptId: "accepted-cold", fence: 7, routeGeneration: 1, weight: 0 }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    assert.equal(input.kind, "api");
    assert.equal(input.fence, 7);
    res.setHeader("content-type", "application/json");
    if (req.url === "/start") {
      timer = setTimeout(
        () => candidate.listen(port, "127.0.0.1"),
        listenAfterMs,
      );
      if (startDelayMs) await new Promise((r) => setTimeout(r, startDelayMs));
      res.end(JSON.stringify(record));
      return;
    }
    assert.equal(req.url, "/observe");
    observations++;
    let observed;
    try {
      const r = await fetch(origin + "/internal/control/identity", {
        signal: AbortSignal.timeout(100),
      });
      observed = await r.json();
    } catch {
      res.end(JSON.stringify({ qualified: false, definitelyAbsent: false }));
      return;
    }
    assert.equal(observed.startIdentity, record.startIdentity);
    res.end(JSON.stringify({ qualified: true, record, ...observed }));
  });
  await new Promise((r) => supervisor.listen(0, "127.0.0.1", r));
  t.after(async () => {
    clearTimeout(timer);
    supervisor.closeAllConnections();
    await new Promise((r) => supervisor.close(r));
    if (candidate.listening) {
      candidate.closeAllConnections();
      await new Promise((r) => candidate.close(r));
    }
  });
  const coordinator = {
    async assertFence() {
      fences++;
    },
    async validateSwitch() {
      validations++;
      const r = await fetch(origin + "/internal/control/identity");
      assert.equal(r.status, 200);
      if (validationError)
        throw Object.assign(Error("Strict semantic validation rejected"), {
          code: validationError,
        });
      if (validationDelayMs)
        await new Promise((r) => setTimeout(r, validationDelayMs));
      if (Date.now() < validationReadyAt) return { qualified: false };
      return {
        qualified: true,
        controlOnly: true,
        noRuntimeSideEffects: true,
        authContinuity: true,
        originalResourceAddressable: true,
      };
    },
  };
  const executor = createNativeExecutor({
    root: "/boundary-only",
    instanceId: "cold-case",
    coordinator,
    entryOrigin: "http://127.0.0.1:" + supervisor.address().port,
    entryKey: "e".repeat(32),
    supervisorOrigin: "http://127.0.0.1:" + supervisor.address().port,
    supervisorKey: "s".repeat(32),
  });
  const run = () =>
    executor.candidate({
      artifact: { root: "/boundary-only/artifact" },
      attempt: {
        attemptId: "accepted-cold",
        targetDigest: "sha256:" + "b".repeat(64),
        plan: { policy: { candidateStartupMs: budgetMs } },
      },
      fence: 7,
    });
  const reconcile = () => executor.reconcile({ step: { kind: "candidate" },
    attempt: { attemptId: "accepted-cold", targetDigest: "sha256:" + "b".repeat(64),
      manifest: { components: { api: { artifactDigest: record.artifactDigest } } },
      plan: { policy: { candidateStartupMs: budgetMs } } },
    fence: 7, local: {} });
  return { run, reconcile, deferValidation: ms => { validationReadyAt = Date.now() + ms; }, counts: () => ({ observations, validations, fences }) };
}

test("cold Control HTTP is actually observed before strict candidate validation", async (t) => {
  const f = await coldBoundary(t);
  const result = await f.run();
  assert.equal(result.startIdentity, "cold-process");
  assert.equal(result.evidence.qualified, true);
  assert.ok(f.counts().observations >= 2);
  assert.equal(f.counts().validations, 1);
  assert.ok(f.counts().fences >= f.counts().observations);
});
test("API listener becoming ready after the frozen startup deadline cannot qualify late", async (t) => {
  const f = await coldBoundary(t, { listenAfterMs: 150, budgetMs: 80 });
  await assert.rejects(f.run(), { code: "CANDIDATE_PROCESS_STARTUP_EXCEEDED" });
  assert.equal(f.counts().validations, 0);
});
test("start, observed HTTP readiness and strict validation share one startup budget", async (t) => {
  const f = await coldBoundary(t, {
    listenAfterMs: 10,
    startDelayMs: 40,
    budgetMs: 100,
    validationDelayMs: 90,
  });
  await assert.rejects(f.run(), { code: "CANDIDATE_STARTUP_BUDGET_EXCEEDED" });
  assert.equal(f.counts().validations, 1);
});

test("strict INTERNAL validation errors are still rejected, not treated as startup retries", async (t) => {
  const f = await coldBoundary(t, {
    listenAfterMs: 10,
    validationError: "INTERNAL",
  });
  await assert.rejects(f.run(), { code: "INTERNAL" });
  assert.equal(f.counts().validations, 1);
});

test("an existing candidate waits for fresh qualification during reconciliation without starting it again", async t => {
  const f = await coldBoundary(t, { listenAfterMs: 10 });
  await f.run();
  const startsBefore = f.counts().validations;
  f.deferValidation(180);
  const result = await f.reconcile();
  assert.equal(result.applied, true);
  assert.equal(result.evidence.startIdentity, "cold-process");
  assert.ok(f.counts().validations >= startsBefore + 2);
});

// Real short HTTP RPCs carry explicit contract-double measurement receipts.
// These tests verify Executor ordering/guards, not Native or 60s load evidence.
async function sourceBoundary(t, { transform, revokeAfterObservation = false, appliedGeneration = 2, productionEntry = false, raceStamp = false } = {}) {
  const sourceDigest = "sha256:" + "c".repeat(64);
  const targetDigest = "sha256:" + "d".repeat(64);
  const attemptId = "accepted-source-boundary", fence = 7;
  let generation = 1, adoptedAt = null, observations = 0, fenceRevoked = false;
  const requests = [], errors = [];
  const binding = {
    instanceId: "source-boundary", attemptId, fence, routeGeneration: 1,
    weight: 0, oldApi: { origin: "http://127.0.0.1:1", digest: sourceDigest },
    candidateApi: null,
    web: { root: tmpdir(), digest: sourceDigest, treeDigest: sourceDigest },
    retainedWeb: [{ root: tmpdir(), digest: targetDigest, treeDigest: targetDigest }],
  };
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      const path = new URL(request.url, "http://localhost").pathname;
      requests.push({ path, method: request.method, body, at: Date.now() });
      let result;
      if (path.endsWith("/renew")) {
        if (fenceRevoked) {
          response.writeHead(409, { "content-type": "application/json" });
          response.end(JSON.stringify({ code: "UPGRADE_FENCE_EXPIRED" }));
          return;
        }
        result = { current: true };
      } else if (path === "/internal/upgrades/" + attemptId) {
        result = { sourceActivation: { components: { api: { artifactDigest: sourceDigest } } } };
      } else if (path.endsWith('/validate-switch')) {
        assert.equal(body.fence, fence);
        assert.equal(body.actual.instanceId, binding.instanceId);
        assert.equal(body.actual.attemptId, attemptId);
        assert.equal(body.actual.oldApi.digest, sourceDigest);
        assert.equal(body.actual.weight, 0);
        result = { qualified: true, controlOnly: true, authContinuity: true, originalResourceAddressable: true, baselineSamples: 100 };
      } else if (path === '/internal/upgrades/continuity') {
        result = { qualified: true, originalResourcesPreserved: true };
      } else if (path === '/current-installer') {
        assert.equal(body.kind, 'installer');
        assert.equal(body.fence, fence);
        result = { instanceId: binding.instanceId, artifactDigest: targetDigest, inputFingerprint: targetDigest, startIdentity: 'new-installer' };
      } else if (path === "/start" || path === "/observe") {
        const record = { origin: "http://127.0.0.1:2", artifactDigest: targetDigest, startIdentity: "new-coordinator" };
        result = path === "/start" ? record : { qualified: true, record };
      } else if (path.endsWith("/coordinator-handoff")) {
        if (body.action === "adopt") {
          generation = 2;
          adoptedAt = Date.now();
          result = { commitKnown: true, evidence: { qualified: true, originalResourcesPreserved: true, singleWriter: true, maxControlPauseMs: 1, generation: appliedGeneration } };
        } else if (body.action === "status") {
          generation = 2;
          result = { applied: true, evidence: { qualified: true, originalResourcesPreserved: true, generation: appliedGeneration } };
        } else result = { commitKnown: true };
      } else if (path === "/internal/upgrades/observation") {
        if (actualEntry) {
          const current = await fetch(actualEntry.controlOrigin + "/binding", { headers: { "x-platform-internal-key": "e".repeat(32) } });
          Object.assign(binding, await current.json());
        }
        const observerEpoch = "live-observer-" + generation;
        result = {
          coordinatorGeneration: generation, observerEpoch,
          fenceValid: true, ownerGenerationsValid: true, routeGenerationValid: true,
          sharedStateHealthy: true, continuity: { qualified: true },
          invariants: Object.fromEntries(["unauthorizedStops", "resourceRebuilds", "duplicateCommands", "duplicateOccurrences", "writerConflicts", "migrationDifferences", "integrityFailures"].map(name => [name, 0])),
          probes: { known: true, hz: 10, samples: 600, failures: 0, maxLatencyMs: 1, attachMaxMs: 1 },
          baseline: {
            known: true, qualified: true, requests: 100, errorRate: 0,
            p95Ms: 1, windowMs: 60000,
            source: { instanceId: binding.instanceId, attemptId, fence,
              routeGeneration: binding.routeGeneration, coordinatorGeneration: generation,
              observerEpoch, artifactDigest: sourceDigest, startIdentity: "original-control",
              origin: binding.oldApi.origin, weight: 0, routeWeight: 0,
              observedAt: new Date().toISOString() },
          },
        };
        if (generation === 2 || adoptedAt === null) {
          observations++;
          if (transform) result = transform(result, { observations, adoptedAt });
          if (revokeAfterObservation && (generation === 2 || transform)) fenceRevoked = true;
        }
      } else if (path === "/binding") {
        if (request.method === "POST") Object.assign(binding, body);
        result = binding;
      } else assert.fail("Unexpected source-boundary RPC: " + path);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(result));
    } catch (error) {
      errors.push(error);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "RECEIVER_FAILED" }));
    }
  });
  const upgraded = new Set();
  server.on("upgrade", (_request, socket) => {
    upgraded.add(socket);
    socket.once("close", () => upgraded.delete(socket));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    socket.on("data", chunk => socket.write(chunk));
  });
  let actualEntry;
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of upgraded) socket.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  const origin = "http://127.0.0.1:" + server.address().port;
  const coordinator = createCoordinatorClient({ origin, instanceId: binding.instanceId, key: "k".repeat(32) });
  let entryOrigin = origin;
  if (productionEntry) {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "executor-entry-admission-")));
    t.after(async () => { if (actualEntry) await actualEntry.close(); await rm(directory, { recursive: true, force: true }); });
    binding.oldApi.origin = origin;
    binding.attemptId = "initial";
    binding.fence = 1;
    actualEntry = await createStableEntry({ root: directory, instanceId: binding.instanceId,
      controlKey: "e".repeat(32), stickyKey: "t".repeat(32),
      verifyFence: ({ attemptId: id, fence: value }) => coordinator.assertFence(id, value),
      initialBinding: structuredClone(binding) });
    entryOrigin = actualEntry.controlOrigin;
    const admitted = await fetch(entryOrigin + "/fence", { method: "POST", headers: { "content-type": "application/json", "x-platform-internal-key": "e".repeat(32) },
      body: JSON.stringify({ instanceId: binding.instanceId, attemptId, fence }) });
    assert.equal(admitted.status, 200);
  }
  let raced = false;
  const fetcher = async (url, options) => {
    if (raceStamp && !raced && url === entryOrigin + "/binding" && options.method === "POST" && JSON.parse(options.body).weight === 0) {
      raced = true;
      const competing = JSON.parse(options.body);
      competing.routeGeneration++;
      const applied = await fetch(url, { ...options, body: JSON.stringify(competing) });
      assert.equal(applied.status, 200);
    }
    return fetch(url, options);
  };
  const executor = createNativeExecutor({ root: "/source-contract-only", instanceId: binding.instanceId, coordinator,
    entryOrigin, entryKey: "e".repeat(32), supervisorOrigin: origin, supervisorKey: "s".repeat(32), fetcher });
  const input = { attempt: { attemptId, targetDigest, manifest: { components: { api: { artifactDigest: targetDigest } } },
    plan: { planDigest: targetDigest, policy: { candidateStartupMs: 2000, stageDurationMs: 60000,
      minRequests: 100, observationFreshnessMs: 5000, probeHz: 10, requestDeadlineMs: 2000, attachDeadlineMs: 5000 } } },
    artifact: {}, operationId: "accepted-operation", fence,
    candidate: { origin: "http://127.0.0.1:2", artifactDigest: targetDigest }, weight: 1 };
  return { executor, input, requests, binding, entry: actualEntry, observations: () => observations, adoptAt: () => adoptedAt };
}

test("Coordinator adoption returns promptly but handoff waits for its fresh complete source window", async t => {
  let readyAt;
  const f = await sourceBoundary(t, { transform: (receipt, { adoptedAt }) => {
    if (adoptedAt === null) return receipt;
    readyAt ??= adoptedAt + 230;
    if (Date.now() < readyAt) receipt.baseline = { ...receipt.baseline, known: false, qualified: false, source: null, requests: 0, windowMs: 0 };
    return receipt;
  } });
  const result = await f.executor.coordinatorHandoff(f.input);
  assert.ok(Date.now() >= readyAt);
  assert.equal(result.sourceBaseline.source.coordinatorGeneration, 2);
  assert.equal(result.sourceBaseline.source.observerEpoch, "live-observer-2");
  assert.ok(f.requests.filter(r => r.path === "/internal/upgrades/observation").length >= 3);
  assert.deepEqual(f.requests.filter(r => r.body?.action).map(r => r.body.action), ["prepare", "quiesce", "release", "adopt"]);
  assert.equal(f.binding.weight, 0);
});

test("first 1% route requires both real sample threshold and complete 60s window", async t => {
  for (const [name, change] of [
    ["99 measured pairs", baseline => { baseline.requests = 99; }],
    ["59999ms window", baseline => { baseline.windowMs = 59999; }],
    ["stale source receipt", baseline => { baseline.source.observedAt = new Date(Date.now() - 5001).toISOString(); }],
  ]) await t.test(name, async t => {
    const f = await sourceBoundary(t, { transform: (receipt, { observations }) => {
      if (observations < 3) change(receipt.baseline);
      return receipt;
    } });
    await f.executor.applyRoute(f.input);
    assert.equal(f.observations(), 3);
    const route = f.requests.filter(r => r.path === "/binding" && r.method === "POST");
    assert.equal(route.length, 1);
    assert.equal(route[0].body.weight, 1);
  });
});

test("old protocol, wrong source identity/epoch and hard failures cannot mutate first route", async t => {
  for (const [name, code, change] of [
    ["old statistics only", "COORDINATOR_SOURCE_BASELINE_PROTOCOL_REQUIRED", r => { delete r.baseline.known; }],
    ["prior Observer epoch", "COORDINATOR_SOURCE_BASELINE_PROOF_MISMATCH", r => { r.baseline.source.observerEpoch = "retired-observer"; }],
    ["target masquerades as source", "COORDINATOR_SOURCE_BASELINE_PROOF_MISMATCH", r => { r.baseline.source.artifactDigest = "sha256:" + "d".repeat(64); }],
    ["old controller fence", "COORDINATOR_SOURCE_BASELINE_PROOF_MISMATCH", r => { r.baseline.source.fence--; }],
    ["entry probe failure", "COORDINATOR_SOURCE_BASELINE_UNSAFE", r => { r.probes.failures = 1; }],
    ["invalid Owner generation", "COORDINATOR_SOURCE_BASELINE_UNSAFE", r => { r.ownerGenerationsValid = false; }],
  ]) await t.test(name, async t => {
    const f = await sourceBoundary(t, { transform: r => { change(r); return r; } });
    await assert.rejects(f.executor.applyRoute(f.input), { code });
    assert.equal(f.requests.filter(r => r.path === "/binding" && r.method === "POST").length, 0);
    assert.equal(f.binding.weight, 0);
  });
});

test("fence expiration after a qualified source receipt still prevents routing", async t => {
  const f = await sourceBoundary(t, { transform: r => r, revokeAfterObservation: true });
  await assert.rejects(f.executor.applyRoute(f.input), { code: "UPGRADE_FENCE_EXPIRED" });
  assert.equal(f.requests.filter(r => r.path === "/binding" && r.method === "POST").length, 0);
});

test("adoption generation and the live Observer generation must agree", async t => {
  const f = await sourceBoundary(t, { appliedGeneration: 3 });
  await assert.rejects(f.executor.coordinatorHandoff(f.input), { code: "COORDINATOR_SOURCE_BASELINE_GENERATION_CHANGED" });
  assert.equal(f.binding.weight, 0);
});

test("reconciling an already adopted handoff cannot bypass fresh source qualification", async t => {
  const f = await sourceBoundary(t, { transform: (receipt, { observations }) => {
    if (observations < 3) receipt.baseline.qualified = false;
    return receipt;
  } });
  const result = await f.executor.reconcile({
    step: { kind: "coordinator-handoff" }, attempt: f.input.attempt, fence: f.input.fence,
    local: { operationId: f.input.operationId },
  });
  assert.equal(f.observations(), 3);
  assert.equal(result.applied, true);
  assert.equal(result.evidence.sourceBaseline.qualified, true);
  assert.deepEqual(f.requests.filter(r => r.body?.action).map(r => r.body.action), ["status"]);
});

test("bootstrap admission stamps only metadata before sampling and preserves the original socket", async t => {
  const f = await sourceBoundary(t, { productionEntry: true, transform: (receipt, { observations }) => {
    if (observations < 3) receipt.baseline.qualified = false;
    return receipt;
  } });
  const publicOrigin = new URL(f.entry.origin);
  const socket = connect(Number(publicOrigin.port), publicOrigin.hostname);
  t.after(() => socket.destroy());
  const read = () => new Promise((resolve, reject) => {
    socket.once("data", chunk => resolve(chunk.toString()));
    socket.once("error", reject);
  });
  const upgrade = read();
  socket.write("GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  assert.match(await upgrade, /101 Switching Protocols/);
  const result = await f.executor.applyRoute(f.input);
  const stamp = result.sourceBaselineAdmission;
  assert.equal(stamp.metadataOnly, true);
  assert.deepEqual([stamp.before.attemptId, stamp.before.fence, stamp.before.routeGeneration], ["initial", 1, 1]);
  assert.deepEqual([stamp.after.attemptId, stamp.after.fence, stamp.after.routeGeneration, stamp.after.weight], [f.input.attempt.attemptId, 7, 2, 0]);
  for (const field of ["oldApi", "candidateApi", "web", "retainedWeb"])
    assert.deepEqual(stamp.after[field], stamp.before[field]);
  assert.equal(result.sourceBaseline.source.routeGeneration, 2);
  assert.equal(result.routeGeneration, 3);
  assert.equal(result.weight, 1);
  assert.equal(f.observations(), 3);
  const echo = read();
  socket.write("original-socket-after-admission");
  assert.equal(await echo, "original-socket-after-admission");
});

test("production Entry rejects a metadata stamp that loses the route-generation CAS", async t => {
  const f = await sourceBoundary(t, { productionEntry: true, raceStamp: true });
  await assert.rejects(f.executor.applyRoute(f.input), { code: "ENTRY_RPC_FAILED" });
  assert.equal(f.observations(), 0);
  const response = await fetch(f.entry.controlOrigin + "/binding", { headers: { "x-platform-internal-key": "e".repeat(32) } });
  const current = await response.json();
  assert.equal(current.weight, 0);
  assert.equal(current.routeGeneration, 3);
});

test('Installer-only activation admits actual Controller fence and waits for empty, partial and complete source receipts without changing serving roles', async t => {
  const f = await sourceBoundary(t, { productionEntry: true, transform: (receipt, { observations }) => {
    if (observations === 1) {
      receipt.baseline = { ...receipt.baseline, known: false, qualified: false, source: null, requests: 0, windowMs: 0 };
      receipt.probes = { known: false, hz: 0, samples: 0, failures: 0, maxLatencyMs: null, attachMaxMs: null };
    } else if (observations === 2) {
      receipt.baseline.requests = 99;
      receipt.baseline.windowMs = 59999;
    }
    return receipt;
  } });
  f.input.attempt.plan.apiReused = true;
  f.input.attempt.manifest.components.api.artifactDigest = f.binding.oldApi.digest;
  const before = structuredClone(f.binding);
  const result = await f.executor.activationEvidence(f.input);
  assert.equal(f.observations(), 3);
  assert.equal(result.compatibility.qualified, true);
  assert.equal(result.actualInstaller.startIdentity, 'new-installer');
  assert.equal(result.actual.attemptId, f.input.attempt.attemptId);
  assert.equal(result.actual.fence, f.input.fence);
  assert.equal(result.actual.routeGeneration, before.routeGeneration + 1);
  assert.equal(result.actual.weight, 0);
  for (const key of ['oldApi', 'candidateApi', 'web', 'retainedWeb']) assert.deepEqual(result.actual[key], before[key]);
  const writes = f.requests.filter(r => r.method === 'POST');
  assert.equal(writes.some(r => r.path === '/start' || r.path === '/coordinator-handoff'), false);
  const validation = f.requests.find(r => r.path.endsWith('/validate-switch'));
  const samples = f.requests.filter(r => r.path === '/internal/upgrades/observation');
  assert.ok(validation.at >= samples.at(-1).at);
});

test('Installer-only activation refuses actual failures and stale Controller authority before final validation', async t => {
  for (const [name, options, code] of [
    ['empty scope with failure', { transform: r => { r.baseline.known = false; r.probes = { known: false, hz: 0, samples: 0, failures: 1, maxLatencyMs: null, attachMaxMs: null }; return r; } }, 'COORDINATOR_SOURCE_BASELINE_UNSAFE'],
    ['measured latency breach', { transform: r => { r.probes.maxLatencyMs = 2001; return r; } }, 'COORDINATOR_SOURCE_BASELINE_UNSAFE'],
    ['wrong source scope', { transform: r => { r.baseline.source.fence--; return r; } }, 'COORDINATOR_SOURCE_BASELINE_PROOF_MISMATCH'],
    ['lost Controller fence', { transform: r => r, revokeAfterObservation: true }, 'UPGRADE_FENCE_EXPIRED'],
    ['Entry compare-and-swap race', { raceStamp: true }, 'ENTRY_RPC_FAILED'],
  ]) await t.test(name, async t => {
    const f = await sourceBoundary(t, { productionEntry: true, ...options });
    f.input.attempt.plan.apiReused = true;
    f.input.attempt.manifest.components.api.artifactDigest = f.binding.oldApi.digest;
    await assert.rejects(f.executor.activationEvidence(f.input), { code });
    assert.equal(f.requests.some(r => r.path.endsWith('/validate-switch')), false);
    assert.equal(f.requests.some(r => r.path === '/start'), false);
  });
});
