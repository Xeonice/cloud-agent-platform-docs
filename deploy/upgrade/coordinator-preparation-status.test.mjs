import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCoordinatorClient } from "./coordinator-client.mjs";

const instanceId = "preparation-http-contract";
const attemptId = "original-attempt";
const original = {
  fence: 7,
  operationId: "original-operation",
  planDigest: "sha256:" + "a".repeat(64),
  candidate: {
    startIdentity: "original-candidate",
    artifactRoot: "/private-candidate-path-must-not-enter-error-metadata",
  },
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const command = (action) => structuredClone({ ...original, action });

// These are real local HTTP receivers and production client calls. They are
// protocol tests, not Source/Native evidence or permission to replay prepare.
async function receiver(t, handler) {
  const calls = [];
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ path: request.url, method: request.method, body });
      const result = await handler(body, response);
      if (!response.destroyed && !response.writableEnded) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(result));
      }
    } catch (error) {
      errors.push(error);
      response.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  const origin = "http://127.0.0.1:" + server.address().port;
  return {
    calls,
    client: (options = {}) =>
      createCoordinatorClient({
        origin,
        instanceId,
        key: "fixture-key-never-in-error-metadata-32",
        ...options,
      }),
  };
}

function scope() {
  return {
    instanceId,
    attemptId,
    operationId: original.operationId,
    fence: original.fence,
    planDigest: original.planDigest,
  };
}

test("opt-in status read preserves the original wire command and legacy result", async (t) => {
  const prepared = {
    stage: "prepared",
    applied: false,
    commitKnown: true,
    resumeAction: "quiesce",
  };
  const f = await receiver(t, () => prepared);
  const body = command("status");
  const result = await f.client().coordinatorHandoff(attemptId, body, {
    statusRead: { deadline: Date.now() + 500, timeoutMs: 200 },
  });
  assert.deepEqual(result, prepared);
  assert.deepEqual(f.calls, [
    {
      path: "/internal/upgrades/" + attemptId + "/coordinator-handoff",
      method: "POST",
      body,
    },
  ]);
});

test("unknown prepare is sent once and reconciled only by the original status command", async (t) => {
  let committed = false;
  const f = await receiver(t, async (body) => {
    if (body.action === "prepare") {
      committed = true;
      await sleep(180);
      return { commitKnown: true, stage: "prepared" };
    }
    assert.equal(committed, true);
    assert.deepEqual(body, command("status"));
    return { stage: "prepared", applied: false, commitKnown: true, resumeAction: "quiesce" };
  });
  const client = f.client();
  let failure;
  await assert.rejects(
    client.coordinatorHandoff(attemptId, command("prepare"), { timeoutMs: 70 }),
    (error) => {
      failure = error;
      assert.equal(error.name, "TimeoutError");
      assert.deepEqual(error.preparationOutcome, {
        ...scope(),
        requestDispatched: true,
        responseDecoded: false,
        result: "unknown",
        reconciliationRequired: true,
      });
      return true;
    },
  );
  assert.deepEqual(failure.faultEvidence, { rpc: failure.rpcContext });
  const status = await client.coordinatorHandoff(attemptId, command("status"), {
    statusRead: { deadline: Date.now() + 300, timeoutMs: 100 },
  });
  assert.equal(status.stage, "prepared");
  assert.equal(status.applied, false);
  assert.deepEqual(f.calls.map((call) => call.body.action), ["prepare", "status"]);
});

test("absent status remains an observation and never causes prepare to be dispatched", async (t) => {
  const absent = { definitelyNotApplied: true, stage: "absent" };
  const f = await receiver(t, () => absent);
  assert.deepEqual(
    await f.client().coordinatorHandoff(attemptId, command("status"), {
      statusRead: { deadline: Date.now() + 300 },
    }),
    absent,
  );
  assert.deepEqual(f.calls.map((call) => call.body.action), ["status"]);
});

test("prepare failure before dispatch has safe scope and does not claim an unknown request", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "preparation-status-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bindingPath = join(dir, "binding.json");
  await writeFile(bindingPath, JSON.stringify({ instanceId, generation: 1, state: "invalid" }), { mode: 0o600 });
  const f = await receiver(t, () => assert.fail("No HTTP call is allowed"));
  await assert.rejects(
    f.client({ bindingPath }).coordinatorHandoff(attemptId, command("prepare")),
    (error) => {
      assert.equal(error.code, "COORDINATOR_BINDING_UNKNOWN");
      assert.deepEqual(error.preparationOutcome, {
        ...scope(),
        requestDispatched: false,
        responseDecoded: false,
        result: "not-dispatched",
        reconciliationRequired: false,
      });
      return true;
    },
  );
  assert.equal(f.calls.length, 0);
});

test("a complete prepare rejection keeps its original code and conservatively requires reconciliation", async (t) => {
  const f = await receiver(t, (_body, response) => {
    response.statusCode = 409;
    return { code: "HANDOFF_INTENT_CONFLICT" };
  });
  await assert.rejects(
    f.client().coordinatorHandoff(attemptId, command("prepare")),
    (error) => {
      assert.equal(error.code, "HANDOFF_INTENT_CONFLICT");
      assert.equal(error.status, 409);
      assert.deepEqual(error.preparationOutcome, {
        ...scope(),
        requestDispatched: true,
        responseDecoded: true,
        result: "completed-rejection",
        reconciliationRequired: true,
      });
      assert.equal(error.rpcContext.action, "prepare");
      assert.equal(error.rpcContext.firstResponseMs >= 0, true);
      const safe = JSON.stringify(error.faultEvidence);
      assert.equal(safe.includes(original.candidate.artifactRoot), false);
      assert.equal(safe.includes("fixture-key-never"), false);
      assert.equal(safe.includes("candidate"), false);
      return true;
    },
  );
});

test("an undecodable prepare response is unknown even after HTTP headers arrived", async (t) => {
  const f = await receiver(t, (_body, response) => {
    response.end("not-json");
  });
  await assert.rejects(
    f.client().coordinatorHandoff(attemptId, command("prepare")),
    (error) => {
      assert.equal(error.preparationOutcome.requestDispatched, true);
      assert.equal(error.preparationOutcome.responseDecoded, false);
      assert.equal(error.preparationOutcome.result, "unknown");
      assert.equal(error.rpcContext.firstResponseMs >= 0, true);
      return true;
    },
  );
});

test("a decoded but invalid prepare acknowledgement remains unknown", async (t) => {
  const f = await receiver(t, () => null);
  await assert.rejects(f.client().coordinatorHandoff(attemptId, command("prepare")), (error) => {
    assert.equal(error.name, "TypeError");
    assert.equal(error.preparationOutcome.requestDispatched, true);
    assert.equal(error.preparationOutcome.responseDecoded, true);
    assert.equal(error.preparationOutcome.result, "unknown");
    assert.equal(error.preparationOutcome.reconciliationRequired, true);
    return true;
  });
  assert.equal(f.calls.length, 1);
});

test("status deadline and timeout options cannot extend the original short read contract", async (t) => {
  const f = await receiver(t, () => assert.fail("Invalid options must not reach HTTP"));
  const client = f.client({ timeoutMs: 100 });
  for (const statusRead of [
    null, {}, { deadline: Infinity }, { deadline: 1.5 }, { deadline: -1 },
    { deadline: Date.now() + 500, timeoutMs: 101 },
    { deadline: Date.now() + 500, timeoutMs: 0 },
    { deadline: Date.now() + 500, timeoutMs: 1.5 },
    { deadline: Date.now() + 500, unrecognized: true },
  ]) {
    await assert.rejects(client.coordinatorHandoff(attemptId, command("status"), { statusRead }), {
      code: "INVALID_PREPARATION_STATUS_READ",
    });
  }
  await assert.rejects(client.coordinatorHandoff(attemptId, command("prepare"), {
    statusRead: { deadline: Date.now() + 500 },
  }), { code: "PREPARATION_STATUS_READ_NOT_ALLOWED" });
  await assert.rejects(client.coordinatorHandoff(attemptId, command("status"), {
    timeoutMs: 100,
    statusRead: { deadline: Date.now() + 500 },
  }), { code: "INVALID_PREPARATION_STATUS_READ" });
  await assert.rejects(client.coordinatorHandoff(attemptId, command("status"), { timeoutMs: 8000 }), {
    code: "PREPARATION_TIMEOUT_NOT_ALLOWED",
  });
  assert.equal(f.calls.length, 0);
});

test("an expired status deadline never reaches the receiver", async (t) => {
  const f = await receiver(t, () => assert.fail("Expired read must not be sent"));
  await assert.rejects(f.client().coordinatorHandoff(attemptId, command("status"), {
    statusRead: { deadline: Date.now() - 1 },
  }), { name: "TimeoutError" });
  assert.equal(f.calls.length, 0);
});

test("binding wait consumes the same status deadline without dispatch", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "preparation-status-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bindingPath = join(dir, "binding.json");
  await writeFile(bindingPath, JSON.stringify({ instanceId, generation: 1, state: "quiescing", attemptId: "another-attempt", fence: 99, origin: "http://127.0.0.1:1" }), { mode: 0o600 });
  const f = await receiver(t, () => assert.fail("No request is allowed"));
  const start = performance.now();
  await assert.rejects(f.client({ bindingPath }).coordinatorHandoff(attemptId, command("status"), {
    statusRead: { deadline: Date.now() + 45 },
  }), { code: "COORDINATOR_HANDOFF_WAIT_EXCEEDED" });
  assert.equal(performance.now() - start < 500, true);
  assert.equal(f.calls.length, 0);
});

test("successive original status reads do not refresh their absolute deadline", async (t) => {
  const f = await receiver(t, async () => {
    await sleep(50);
    return { stage: "prepared", commitKnown: true, applied: false };
  });
  const client = f.client();
  const statusRead = { deadline: Date.now() + 85, timeoutMs: 200 };
  assert.equal((await client.coordinatorHandoff(attemptId, command("status"), { statusRead })).stage, "prepared");
  await assert.rejects(client.coordinatorHandoff(attemptId, command("status"), { statusRead }), { name: "TimeoutError" });
  assert.deepEqual(f.calls.map((call) => call.body.action), ["status", "status"]);
});

test("status read respects the shorter existing request-context deadline", async (t) => {
  const f = await receiver(t, async () => {
    await sleep(150);
    return { stage: "prepared", commitKnown: true };
  });
  const deadline = Date.now() + 50;
  await assert.rejects(f.client({ requestContext: () => ({ deadline }) }).coordinatorHandoff(attemptId, command("status"), {
    statusRead: { deadline: Date.now() + 500, timeoutMs: 300 },
  }), (error) => {
    assert.equal(error.name, "TimeoutError");
    assert.equal(error.rpcContext.timeoutMs <= 50, true);
    return true;
  });
  assert.equal(f.calls.length, 1);
});

test("a late decoded status result cannot qualify even if an injected transport ignores abort", async () => {
  const client = createCoordinatorClient({
    origin: "http://127.0.0.1:1", instanceId, key: "k".repeat(32),
    fetcher: async () => ({ ok: true, json: async () => {
      await sleep(50);
      return { stage: "prepared", commitKnown: true };
    } }),
  });
  await assert.rejects(client.coordinatorHandoff(attemptId, command("status"), {
    statusRead: { deadline: Date.now() + 500, timeoutMs: 20 },
  }), { name: "TimeoutError" });
});

test("prepare dispatch is conservatively true before invoking a failing transport", async () => {
  const transportError = new Error("transport refused");
  const client = createCoordinatorClient({
    origin: "http://127.0.0.1:1", instanceId, key: "k".repeat(32),
    fetcher: () => { throw transportError; },
  });
  await assert.rejects(client.coordinatorHandoff(attemptId, command("prepare")), (error) => {
    assert.equal(error, transportError);
    assert.equal(error.preparationOutcome.requestDispatched, true);
    assert.equal(error.preparationOutcome.result, "unknown");
    return true;
  });
  const ownerClient = createCoordinatorClient({
    origin: "http://127.0.0.1:1", instanceId, key: "k".repeat(32),
    fetcher: () => { throw new Error("owner transport refused"); },
  });
  await assert.rejects(ownerClient.ownerCandidate(attemptId, command("prepare")), (error) => {
    assert.equal(error.preparationOutcome, undefined);
    return true;
  });
});

test("prepare and opt-in status keep their original scope if the caller mutates its body while routing", async (t) => {
  const f = await receiver(t, (body) => {
    assert.deepEqual(body, command(body.action));
    return { commitKnown: true, stage: "prepared" };
  });
  const client = f.client();
  for (const action of ["prepare", "status"]) {
    const body = command(action);
    const pending = client.coordinatorHandoff(attemptId, body, action === "status" ? {
      statusRead: { deadline: Date.now() + 500 },
    } : undefined);
    body.operationId = "changed-operation";
    body.candidate.startIdentity = "changed-candidate";
    await pending;
  }
  assert.deepEqual(f.calls.map((call) => call.body.action), ["prepare", "status"]);
});

test("new status reads reject incomplete scope before dispatch", async (t) => {
  const f = await receiver(t, () => assert.fail("Unknown scope must not reach HTTP"));
  for (const patch of [{ operationId: "\nprivate" }, { fence: 0 }, { planDigest: "unknown" }]) {
    await assert.rejects(f.client().coordinatorHandoff(attemptId, { ...command("status"), ...patch }, {
      statusRead: { deadline: Date.now() + 500 },
    }), { code: "PREPARATION_STATUS_SCOPE_INVALID" });
  }
  assert.equal(f.calls.length, 0);
});
