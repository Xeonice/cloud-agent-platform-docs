import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInstanceController } from "./instance-controller.mjs";
import { createCoordinatorClient } from "./coordinator-client.mjs";
import { digest } from "./trust.mjs";

const id = "77777777-7777-4777-8777-777777777777";

// Real HTTP and the production Controller/Client/journal, with the ledger at
// a contract boundary. These checks do not claim native qualification.
async function fixture(t, { loseFirstAck = false } = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "upg-controller-fault-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const attempt = {
    attemptId: id,
    instanceId: "fault-instance",
    sequence: 7,
    generation: 2,
    state: "observing",
    targetDigest: digest("target"),
  };
  const plan = { policy: { retentionMs: 60000 }, steps: [] };
  const events = new Map(),
    requests = [];
  let lost = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") {
      res.end(JSON.stringify({ attempt, plan }));
      return;
    }
    let text = "";
    for await (const bytes of req) text += bytes;
    const command = JSON.parse(text);
    if (req.url.endsWith("/renew")) {
      res.end(JSON.stringify({ fence: 4 }));
      return;
    }
    requests.push(command);
    const prior = events.get(command.eventId);
    if (prior) {
      assert.equal(digest(command), prior);
      res.end(JSON.stringify({ attempt, plan }));
      return;
    }
    if (typeof command.payload?.reason !== "string") {
      res.writeHead(400);
      res.end(JSON.stringify({ code: "UPGRADE_FAILURE_REASON_REQUIRED" }));
      return;
    }
    assert.equal(command.fence, 4);
    assert.equal(command.generation, attempt.generation);
    assert.equal(command.expectedSequence, attempt.sequence);
    events.set(command.eventId, digest(command));
    attempt.sequence++;
    attempt.state = "failed";
    attempt.reason = command.payload.reason;
    if (loseFirstAck && !lost) {
      lost = true;
      req.socket.destroy();
      return;
    }
    res.end(JSON.stringify({ attempt, plan }));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((ok) => server.close(ok));
  });
  const origin = "http://127.0.0.1:" + server.address().port;
  const coordinator = createCoordinatorClient({
    origin,
    instanceId: attempt.instanceId,
    key: "synthetic-fault-key-32-characters-long",
  });
  let recoveries = 0;
  const executor = {
    actual: async () => ({ weight: 1, routeGeneration: 2 }),
    fallbackEligibility: async () => ({ qualified: false }),
    recover: async () => {
      recoveries++;
      throw Error("must not recover without eligibility");
    },
  };
  const controller = createInstanceController({
    root,
    instanceId: attempt.instanceId,
    controllerId: "fault-controller",
    coordinator,
    executor,
  });
  return {
    controller,
    session: {
      attempt: { ...attempt },
      fence: 4,
      generation: 2,
      currentStep: { kind: "coordinator-handoff" },
    },
    attempts: () => ({ ...attempt }),
    requests,
    events,
    recoveries: () => recoveries,
    journal: async () =>
      JSON.parse(await readFile(join(root, "journals", id + ".json"), "utf8")),
  };
}

for (const [name, error, code] of [
  [
    "DOM timeout",
    new DOMException("synthetic timeout", "TimeoutError"),
    "UPGRADE_RPC_TIMEOUT",
  ],
  [
    "DOM abort",
    new DOMException("synthetic abort", "AbortError"),
    "UPGRADE_RPC_ABORTED",
  ],
  ["unclassified numeric code", { code: 23 }, "UPGRADE_FAILED"],
  [
    "platform string code",
    { code: "PROBE_DEADLINE_EXCEEDED" },
    "PROBE_DEADLINE_EXCEEDED",
  ],
]) {
  test(`${name} records a valid failure reason over real HTTP without recovery`, async (t) => {
    const f = await fixture(t);
    assert.equal(
      (await f.controller.handleFault(f.session, error)).state,
      "frozen-no-qualified-fallback",
    );
    assert.equal(f.attempts().reason, code);
    assert.equal(f.attempts().state, "failed");
    assert.equal(f.attempts().sequence, 8);
    assert.equal(f.events.size, 1);
    assert.equal(f.recoveries(), 0);
    const journal = await f.journal();
    assert.equal(journal.faultCommitApplied, true);
    assert.equal(journal.faultCommit.payload.evidence.code, code);
  });
}

test("lost failure ACK preserves the exact durable event on reconciliation", async (t) => {
  const f = await fixture(t, { loseFirstAck: true });
  await assert.rejects(
    f.controller.handleFault(
      f.session,
      new DOMException("synthetic timeout", "TimeoutError"),
    ),
  );
  const before = await f.journal();
  assert.equal(before.faultCommitApplied, undefined);
  assert.equal(f.events.size, 1);
  assert.equal(f.recoveries(), 0);
  assert.equal(
    (
      await f.controller.handleFault(f.session, {
        code: "LATER_DIFFERENT_ERROR",
      })
    ).state,
    "frozen-no-qualified-fallback",
  );
  const after = await f.journal();
  assert.deepEqual(after.faultCommit, before.faultCommit);
  assert.deepEqual(f.requests[1], f.requests[0]);
  assert.equal(after.faultCommitApplied, true);
  assert.equal(f.attempts().sequence, 8);
  assert.equal(f.attempts().reason, "UPGRADE_RPC_TIMEOUT");
  assert.equal(f.events.size, 1);
  assert.equal(f.recoveries(), 0);
});
