import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createCoordinatorClient } from "./coordinator-client.mjs";
import { createNativeExecutor } from "./native-executor.mjs";

// Real Node HTTP transport and production clients/executors. These scoped
// ledger and Supervisor receivers are contract doubles, not Native evidence.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = "sha256:" + "a".repeat(64);
const revision = "b".repeat(40);
const attemptId = "accepted-http-budget";
const operationId = "fixed-operation";
const fence = 7;
const hardInvariants = Object.fromEntries(
  [
    "unauthorizedStops",
    "resourceRebuilds",
    "duplicateCommands",
    "duplicateOccurrences",
    "writerConflicts",
    "migrationDifferences",
    "integrityFailures",
  ].map((name) => [name, 0]),
);

async function listener(t, handler, port = 0) {
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      const value = await handler(request, body, response);
      if (!response.destroyed && !response.writableEnded) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(value));
      }
    } catch (error) {
      errors.push(error);
      if (!response.destroyed) {
        response.statusCode = 500;
        response.end(JSON.stringify({ code: "RECEIVER_FAILED" }));
      }
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  return "http://127.0.0.1:" + server.address().port;
}

async function boundary(t, { budgetMs = 8000, delays = {}, extra } = {}) {
  const calls = [];
  const record = {
    origin: "http://127.0.0.1:1",
    startIdentity: "fixed-process",
    artifactDigest: digest,
    pid: process.pid,
  };
  let binding = {
    instanceId: "http-budget-case",
    attemptId,
    fence,
    weight: 0,
    routeGeneration: 1,
    oldApi: { origin: record.origin, digest },
    web: { origin: "http://127.0.0.1:2", digest: "sha256:" + "c".repeat(64) },
    retainedWeb: [],
  };
  let generation = 1;
  const oldBinding = structuredClone(binding);
  const origin = await listener(t, async (request, body, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    const phase = body?.action ?? path;
    calls.push({ path, phase, method: request.method, body });
    if (delays[phase]) await sleep(delays[phase]);
    if (extra) {
      const handled = await extra({ path, body, record, response });
      if (handled !== undefined) return handled;
    }
    if (path === "/start") return record;
    if (path === "/observe") return { qualified: true, record };
    if (path.endsWith("/renew")) return { current: true };
    if (path === "/internal/upgrades/" + attemptId)
      return { sourceActivation: { components: { api: { artifactDigest: digest } } } };
    if (path === "/internal/upgrades/observation")
      return {
        coordinatorGeneration: generation,
        observerEpoch: "budget-observer-" + generation,
        fenceValid: true,
        ownerGenerationsValid: true,
        routeGenerationValid: true,
        baseline: {
          known: true, qualified: true, requests: 100, errorRate: 0,
          p95Ms: 1, windowMs: 60000,
          source: {
            instanceId: "http-budget-case", attemptId, fence,
            routeGeneration: binding.routeGeneration,
            coordinatorGeneration: generation,
            observerEpoch: "budget-observer-" + generation,
            artifactDigest: digest, startIdentity: "source-control",
            origin: binding.oldApi.origin, weight: 0, routeWeight: 0,
            observedAt: new Date().toISOString(),
          },
        },
        sharedStateHealthy: true,
        continuity: { qualified: true },
        invariants: hardInvariants,
        probes: { hz: 10, samples: 600, failures: 0, maxLatencyMs: 1, attachMaxMs: 1 },
      };
    if (
      path.endsWith("/owner-candidate") ||
      path.endsWith("/coordinator-handoff")
    ) {
      assert.deepEqual(Object.keys(body).sort(), [
        "action",
        "candidate",
        "fence",
        "operationId",
        "planDigest",
      ]);
      assert.equal(body.operationId, operationId);
      assert.equal(body.fence, fence);
      assert.equal(body.planDigest, digest);
      if (body.action === "status")
        return { definitelyNotApplied: true, stage: "absent" };
      if (body.action === "adopt") {
        generation = 2;
        return {
          commitKnown: true,
          evidence: {
            qualified: true,
            originalResourcesPreserved: true,
            singleWriter: true,
            maxControlPauseMs: 1,
            generation,
          },
        };
      }
      return { commitKnown: true, stage: body.action };
    }
    if (path === "/binding") {
      if (request.method === "POST") binding = body;
      return binding;
    }
    assert.fail("Unexpected receiver path: " + path);
  });
  const coordinator = createCoordinatorClient({
    origin,
    instanceId: "http-budget-case",
    key: "k".repeat(32),
  });
  const executor = createNativeExecutor({
    root: "/http-contract-only",
    instanceId: "http-budget-case",
    coordinator,
    entryOrigin: origin,
    entryKey: "e".repeat(32),
    supervisorOrigin: origin,
    supervisorKey: "s".repeat(32),
  });
  const attempt = {
    attemptId,
    manifest: {
      components: { web: { artifactDigest: digest, webRevision: revision } },
    },
    plan: {
      planDigest: digest,
      policy: {
        candidateStartupMs: budgetMs,
        minRequests: 1,
        probeHz: 10,
        requestDeadlineMs: 2000,
        attachDeadlineMs: 5000,
        stageDurationMs: 60000,
        observationFreshnessMs: 5000,
      },
    },
  };
  const input = {
    attempt,
    fence,
    operationId,
    artifact: {
      root: "/http-contract-only/artifacts/fixed",
      treeDigest: digest,
    },
  };
  return {
    coordinator,
    executor,
    input,
    calls,
    record,
    oldBinding,
    binding: () => binding,
    body: (action) => ({
      fence,
      operationId,
      planDigest: digest,
      candidate: record,
      action,
    }),
  };
}

function criticalCalls(fixture) {
  return fixture.calls.filter((call) =>
    ["quiesce", "release", "adopt"].includes(call.phase),
  );
}

test(
  "role preparation uses its frozen budget and keeps the wire contract",
  { concurrency: true },
  async (t) => {
    await Promise.all(
      ["coordinatorHandoff", "ownerCandidate"].map((method) =>
        t.test(
          method + " accepts an actual 5.2s preparation inside 8s",
          async (t) => {
            const f = await boundary(t, { delays: { prepare: 5200 } });
            const started = Date.now();
            const result = await f.executor[method](f.input);
            assert.ok(Date.now() - started >= 5200);
            assert.equal(result.qualified, true);
            const actions = f.calls.filter((call) => call.body?.action);
            assert.deepEqual(
              actions.map((call) => call.phase),
              method === "coordinatorHandoff"
                ? ["prepare", "quiesce", "release", "adopt"]
                : ["prepare", "adopt"],
            );
            for (const call of actions)
              assert.deepEqual(call.body, f.body(call.phase));
          },
        ),
      ),
    );
  },
);

test(
  "late preparation cannot enter quiesce or adoption",
  { concurrency: true },
  async (t) => {
    await Promise.all(
      [
        ["start", { "/start": 400 }],
        ["observe", { "/observe": 400 }],
        ["baseline", { "/internal/upgrades/observation": 400 }],
        ["prepare", { prepare: 400 }],
        [
          "one cumulative budget",
          {
            "/start": 90,
            "/observe": 90,
            "/internal/upgrades/observation": 90,
            prepare: 90,
          },
        ],
      ].map(([phase, delays]) =>
        t.test(phase, async (t) => {
          const f = await boundary(t, { budgetMs: 300, delays });
          await assert.rejects(f.executor.coordinatorHandoff(f.input));
          assert.deepEqual(criticalCalls(f), []);
        }),
      ),
    );
  },
);

test("preparation waits for a real 5.2s observation inside its original budget", async (t) => {
  let observations = 0;
  const f = await boundary(t, {
    extra: async ({ path }) => {
      if (path === "/internal/upgrades/observation" && ++observations === 1)
        await sleep(5200);
    },
  });
  const started = Date.now();
  const result = await f.executor.coordinatorHandoff(f.input);
  assert.ok(Date.now() - started >= 5200);
  assert.equal(result.qualified, true);
  assert.equal(f.calls.filter((call) => call.path === "/start").length, 1);
  assert.deepEqual(criticalCalls(f).map((call) => call.phase), ["quiesce", "release", "adopt"]);
});

test("a completed stale observation is reread serially without restarting or reposting prepare", async (t) => {
  let observations = 0, active = 0, maxActive = 0;
  const f = await boundary(t, {
    extra: async ({ path, response }) => {
      if (path !== "/internal/upgrades/observation") return;
      active++; maxActive = Math.max(maxActive, active); observations++;
      await sleep(25); active--;
      if (observations === 1) {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: "OBSERVATION_STALE" }));
        return null;
      }
    },
  });
  const result = await f.executor.coordinatorHandoff(f.input);
  assert.equal(result.qualified, true);
  assert.equal(maxActive, 1);
  assert.equal(f.calls.filter((call) => call.path === "/start").length, 1);
  assert.equal(f.calls.filter((call) => call.phase === "prepare").length, 1);
  assert.equal(observations, 3); // initial stale, fresh preflight, fresh post-adoption
});

for (const code of ["OBSERVATION_SCOPE_CHANGED", "GLOBAL_SCHEMA_INTEGRITY_FAILED", "UPGRADE_FENCE_EXPIRED"]) {
  test("preparation never retries a completed hard rejection: " + code, async (t) => {
    let observations = 0;
    const f = await boundary(t, {
      extra: async ({ path, response }) => {
        if (path !== "/internal/upgrades/observation") return;
        observations++;
        response.writeHead(409, { "content-type": "application/json" });
        response.end(JSON.stringify({ code }));
        return null;
      },
    });
    await assert.rejects(f.executor.coordinatorHandoff(f.input), (error) => error.code === code);
    assert.equal(observations, 1);
    assert.deepEqual(criticalCalls(f), []);
    assert.equal(f.calls.filter((call) => call.phase === "prepare").length, 0);
  });
}

test("unknown observation at the original deadline is not reread or allowed to quiesce", async (t) => {
  let observations = 0;
  const f = await boundary(t, {
    budgetMs: 250,
    extra: async ({ path }) => {
      if (path === "/internal/upgrades/observation") {
        observations++;
        await sleep(400);
      }
    },
  });
  await assert.rejects(f.executor.coordinatorHandoff(f.input), (error) => {
    assert.equal(error.name, "TimeoutError");
    assert.equal(error.rpcContext.path, "/internal/upgrades/observation");
    assert.ok(error.rpcContext.timeoutMs <= 250);
    return true;
  });
  assert.equal(observations, 1);
  assert.deepEqual(criticalCalls(f), []);
  assert.equal(f.calls.filter((call) => call.phase === "prepare").length, 0);
});

test("repeated completed stale reads share the original deadline and never prepare", async (t) => {
  let observations = 0;
  const f = await boundary(t, {
    budgetMs: 250,
    extra: async ({ path, response }) => {
      if (path !== "/internal/upgrades/observation") return;
      observations++;
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "OBSERVATION_STALE" }));
      return null;
    },
  });
  const started = Date.now();
  await assert.rejects(f.executor.coordinatorHandoff(f.input), (error) => error.code === "COORDINATOR_BASELINE_NOT_QUALIFIED");
  assert.ok(Date.now() - started >= 200);
  assert.ok(observations >= 1 && observations <= 3);
  assert.deepEqual(criticalCalls(f), []);
  assert.equal(f.calls.filter((call) => call.phase === "prepare").length, 0);
});

test(
  "only local prepare may change the transport deadline",
  { concurrency: true },
  async (t) => {
    await Promise.all(
      ["ownerCandidate", "coordinatorHandoff"].map((method) =>
        t.test(method, async (t) => {
          const f = await boundary(t);
          for (const timeoutMs of [0, -1, 120001, NaN, 1.5])
            await assert.rejects(
              async () =>
                f.coordinator[method](attemptId, f.body("prepare"), {
                  timeoutMs,
                }),
              { code: "INVALID_PREPARATION_TIMEOUT" },
            );
          for (const action of ["status", "quiesce", "release", "adopt"])
            await assert.rejects(
              async () =>
                f.coordinator[method](attemptId, f.body(action), {
                  timeoutMs: 8000,
                }),
              { code: "PREPARATION_TIMEOUT_NOT_ALLOWED" },
            );
          assert.deepEqual(f.calls, []);
          const prepared = await f.coordinator[method](
            attemptId,
            f.body("prepare"),
            { timeoutMs: 120000 },
          );
          assert.equal(prepared.commitKnown, true);
          assert.equal(f.calls.length, 1);
          assert.deepEqual(f.calls[0].body, f.body("prepare"));
        }),
      ),
    );
  },
);

test(
  "status, adoption, default prepare and baseline retain actual 5s aborts",
  { concurrency: true },
  async (t) => {
    await Promise.all(
      [
        ["status", "coordinatorHandoff"],
        ["adopt", "ownerCandidate"],
        ["prepare", "ownerCandidate"],
        ["/internal/upgrades/observation", "observation"],
      ].map(([phase, method]) =>
        t.test(phase, async (t) => {
          const f = await boundary(t, { delays: { [phase]: 5300 } });
          const started = Date.now();
          const request =
            method === "observation"
              ? f.coordinator.observation(attemptId, { fence, weight: 0 })
              : f.coordinator[method](attemptId, f.body(phase));
          await assert.rejects(request, { name: "TimeoutError" });
          assert.ok(Date.now() - started >= 4800);
          assert.equal(f.calls.length, 1);
          assert.deepEqual(
            criticalCalls(f).map((call) => call.phase),
            phase === "adopt" ? ["adopt"] : [],
          );
        }),
      ),
    );
  },
);

test("migration preparation and reconciliation wait for asynchronous integrity without changing the frozen batch budget", { concurrency: true }, async (t) => {
  await Promise.all(["prepare", "status"].map(action => t.test(action, async t => {
    const result = {commitKnown:true,integrityValid:true,complete:true};
    const f = await boundary(t, {delays:{[action]:5200}, extra:({path}) => path.endsWith('/migration') ? result : undefined});
    f.input.attempt.plan.migrationPath={migrationPlanDigest:digest};
    f.input.attempt.plan.policy.migrationBatchMs=500;
    const request={...f.input,action,checkpoint:null};
    const started=Date.now();
    assert.deepEqual(await f.executor.migration(request),result);
    assert.ok(Date.now()-started>=5200);
    assert.deepEqual(f.calls.map(c=>c.body),[{fence,operationId,action,planDigest:digest,checkpoint:null,policy:f.input.attempt.plan.policy}]);
    assert.equal(f.calls[0].body.policy.migrationBatchMs,500);
    assert.deepEqual(criticalCalls(f),[]);
  })));
});

test("migration timeout overrides are bounded and cannot extend a write batch", { concurrency: true }, async (t) => {
  const f=await boundary(t,{extra:({path})=>path.endsWith('/migration')?{complete:true}:undefined});
  for(const action of ['prepare','status']){
    for(const timeoutMs of [0,-1,120001,NaN,1.5]) await assert.rejects(async()=>f.coordinator.migration(attemptId,{action},{timeoutMs}),{code:'INVALID_MIGRATION_TIMEOUT'});
  }
  for(const action of ['batch','quiesce','release','adopt']) await assert.rejects(async()=>f.coordinator.migration(attemptId,{action},{timeoutMs:120000}),{code:'MIGRATION_TIMEOUT_NOT_ALLOWED'});
  assert.deepEqual(f.calls,[]);
});

test("migration write batches keep the actual default 5s transport deadline", { concurrency: true }, async (t) => {
  const f=await boundary(t,{delays:{batch:5300},extra:({path})=>path.endsWith('/migration')?{complete:true}:undefined});
  f.input.attempt.plan.migrationPath={migrationPlanDigest:digest};
  f.input.attempt.plan.policy.migrationBatchMs=500;
  const started=Date.now();
  await assert.rejects(f.executor.migration({...f.input,action:'batch',checkpoint:{phase:'batch'}}),{name:'TimeoutError'});
  assert.ok(Date.now()-started>=4800);
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].body.policy.migrationBatchMs,500);
  assert.deepEqual(criticalCalls(f),[]);
});

async function webBoundary(
  t,
  {
    budgetMs = 1500,
    listenAfterMs = 150,
    buildDelayMs = 0,
    wrongRevision = false,
    wrongIdentity = false,
    wrongDigest = false,
  } = {},
) {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const origin = "http://127.0.0.1:" + port;
  const requests = [];
  let timer;
  const web = createServer(async (request, response) => {
    requests.push(request.url);
    response.setHeader("content-type", "application/json");
    if (request.url === "/web-build") {
      if (buildDelayMs) await sleep(buildDelayMs);
      if (!response.destroyed)
        response.end(
          JSON.stringify({
            webRevision: wrongRevision ? "d".repeat(40) : revision,
          }),
        );
      return;
    }
    response.end(
      JSON.stringify({
        instanceId: "http-budget-case",
        artifactDigest: wrongDigest ? "sha256:" + "d".repeat(64) : digest,
        webRevision: revision,
        startIdentity: wrongIdentity ? "other-process" : "fixed-process",
        pid: process.pid,
      }),
    );
  });
  t.after(async () => {
    clearTimeout(timer);
    if (web.listening) {
      web.closeAllConnections();
      await new Promise((resolve) => web.close(resolve));
    }
  });
  const f = await boundary(t, {
    budgetMs,
    extra: async ({ path, record }) => {
      record.origin = origin;
      if (path === "/start") {
        timer = setTimeout(() => web.listen(port, "127.0.0.1"), listenAfterMs);
        return record;
      }
      if (path !== "/observe") return undefined;
      try {
        const response = await fetch(origin + "/web-process", {
          signal: AbortSignal.timeout(70),
        });
        const identity = await response.json();
        return { qualified: true, record, ...identity };
      } catch {
        return { qualified: false, definitelyAbsent: false, record };
      }
    },
  });
  return { ...f, requests };
}

test(
  "Web publication waits for actual process and build identity within one budget",
  { concurrency: true },
  async (t) => {
    await Promise.all([
      t.test("a delayed real listener is ready before binding", async (t) => {
        const f = await webBoundary(t);
        await f.executor.bindWeb(f.input);
        assert.ok(
          f.calls.filter((call) => call.path === "/observe").length >= 2,
        );
        assert.ok(f.requests.includes("/web-process"));
        assert.ok(f.requests.includes("/web-build"));
        assert.equal(
          f.calls.filter(
            (call) => call.path === "/binding" && call.method === "POST",
          ).length,
          1,
        );
        assert.equal(f.binding().web.digest, digest);
      }),
      ...[
        [
          "listener is not ready by the deadline",
          { budgetMs: 100, listenAfterMs: 250 },
        ],
        [
          "build finishes after the shared deadline",
          { budgetMs: 300, listenAfterMs: 10, buildDelayMs: 400 },
        ],
        [
          "compiled revision does not match the signed target",
          { wrongRevision: true },
        ],
        [
          "process identity differs from the accepted spawn",
          { wrongIdentity: true },
        ],
        [
          "process artifact digest does not match the signed target",
          { wrongDigest: true },
        ],
      ].map(([name, options]) =>
        t.test(name, async (t) => {
          const f = await webBoundary(t, options);
          await assert.rejects(f.executor.bindWeb(f.input));
          assert.equal(
            f.calls.filter(
              (call) => call.path === "/binding" && call.method === "POST",
            ).length,
            0,
          );
          assert.deepEqual(f.binding(), f.oldBinding);
        }),
      ),
    ]);
  },
);
