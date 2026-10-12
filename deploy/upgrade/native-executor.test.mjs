import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createNativeExecutor } from "./native-executor.mjs";

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
  const record = {
    origin,
    startIdentity: "cold-process",
    artifactDigest: "sha256:" + "a".repeat(64),
    pid: process.pid,
  };
  const supervisor = createServer(async (req, res) => {
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
    res.end(JSON.stringify({ qualified: true, record }));
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
    entryOrigin: origin,
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
  return { run, counts: () => ({ observations, validations, fences }) };
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
