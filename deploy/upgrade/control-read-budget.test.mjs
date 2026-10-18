import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createCoordinatorClient } from "./coordinator-client.mjs";
import { createNativeExecutor } from "./native-executor.mjs";

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
    async observation(id, body, options) { controls.push({ method: "observation", id, body, options }); return { sharedStateHealthy: true }; },
    async continuity() { return { qualified: true }; },
    async fallbackEligibility(id, body, options) { controls.push({ method: "fallback", id, body, options }); return { qualified: false }; },
  };
  const executor = createNativeExecutor({ root: "/read-control-contract-only", instanceId: "normal-observation", coordinator, entryOrigin: f.origin, entryKey: "e".repeat(32), supervisorOrigin: f.origin, supervisorKey: "s".repeat(32) });
  const input = { attempt: { attemptId: "original", plan: { policy } }, fence: 7, weight: 0 };
  assert.equal((await executor.observe(input)).web.qualified, true);
  assert.equal((await executor.fallbackEligibility({ ...input, fault: { code: "observed-fault" } })).qualified, false);
  assert.equal(controls.length, 2);
  assert.ok(controls[0].options.timeoutMs > 0 && controls[0].options.timeoutMs <= 500);
  assert.ok(controls[1].options.timeoutMs > 0 && controls[1].options.timeoutMs <= 120000);
  assert.equal(policy.requestDeadlineMs, 2000);
  assert.equal(policy.attachDeadlineMs, 5000);
});
