import test from "node:test";
import assert from "node:assert/strict";
import { inspectQualificationToolStartup as tool, inspectQualificationCounterStartup as counter } from "../../e2e-contract/server/qualification-agent-startup.mjs";
const taskId = "11111111-1111-4111-8111-111111111111";
const base = { taskId, requestAtMs: 1000, acceptedAtMs: 1100 };
const event = (atMs, id = taskId) => ({ taskId: id, phase: "tool-issued", at: new Date(atMs).toISOString() });
const proof = { pid: 42, birth: "12345", launches: [42], seq: [1, 2] };
const code = (expected) => (error) => error.code === expected;

test("cold CLI startup and actual tool execution have separate fixed budgets", () => {
  const issued = tool({ ...base, nowMs: 154000, requests: [event(153000)] });
  assert.equal(issued.elapsedMs, 152000);
  assert.equal(counter({ toolIssuedAtMs: issued.toolIssuedAtMs, nowMs: 199356, counter: proof }).phase, "counter-ready");
});
test("another task or an auxiliary request cannot satisfy the actual marker gate", () => {
  assert.equal(tool({ ...base, nowMs: 180999, requests: [event(10000, "22222222-2222-4222-8222-222222222222"), { taskId, phase: "auxiliary" }] }).phase, "waiting-for-tool");
  assert.throws(() => tool({ ...base, nowMs: 181000, requests: [] }), code("AGENT_TOOL_STARTUP_TIMEOUT"));
});
test("a late tool request cannot refresh the original 180 second deadline", () => {
  assert.throws(() => tool({ ...base, nowMs: 181001, requests: [event(181001)] }), code("AGENT_TOOL_STARTUP_TIMEOUT"));
  assert.equal(tool({ ...base, nowMs: 181000, requests: [event(181000)] }).phase, "tool-issued");
});
test("invalid, future or duplicate original tool times remain unknown", () => {
  for (const requests of [[event(2000), event(2001)], [{ ...event(2000), at: "unknown" }], [event(999)], [event(3001)]])
    assert.throws(() => tool({ ...base, nowMs: 3000, requests }));
});
test("counter readiness is anchored to the first tool time, not its re-observation", () => {
  assert.equal(counter({ toolIssuedAtMs: 2000, nowMs: 62000, counter: proof }).phase, "counter-ready");
  assert.throws(() => counter({ toolIssuedAtMs: 2000, nowMs: 62001, counter: proof }), code("AGENT_COUNTER_STARTUP_TIMEOUT"));
  assert.throws(() => counter({ toolIssuedAtMs: 2000, nowMs: 62001 }), code("AGENT_COUNTER_STARTUP_TIMEOUT"));
});
test("one real counter sample freezes original PID and birth while gathering two", () => {
  const first = counter({ toolIssuedAtMs: 2000, nowMs: 3000, counter: { ...proof, seq: [1] } });
  assert.equal(first.phase, "waiting-for-counter");
  assert.equal(counter({ toolIssuedAtMs: 2000, nowMs: 4000, counter: proof, firstIdentity: first.identity }).phase, "counter-ready");
  for (const changed of [{ ...proof, birth: "12346" }, { ...proof, pid: 43, launches: [43] }])
    assert.throws(() => counter({ toolIssuedAtMs: 2000, nowMs: 4000, counter: changed, firstIdentity: first.identity }), code("AGENT_COUNTER_IDENTITY_CHANGED"));
});
test("replayed launches or discontinuous counters cannot qualify setup", () => {
  assert.throws(() => counter({ toolIssuedAtMs: 2000, nowMs: 3000, counter: { ...proof, launches: [42, 42] } }), code("AGENT_COUNTER_MULTIPLE_LAUNCHES"));
  for (const seq of [[2, 3], [1, 3], []])
    assert.throws(() => counter({ toolIssuedAtMs: 2000, nowMs: 3000, counter: { ...proof, seq } }), code("AGENT_STARTUP_COUNTER_SEQUENCE_INVALID"));
});
