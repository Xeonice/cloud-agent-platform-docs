import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { startQualificationModel, qualificationPrompt } from "./qualification-model.mjs";

const fixture = () => startQualificationModel({ isolated: true, instanceId: "upgrade-acceptance-ingress" });
const waitFor = async (condition) => {
  const deadline = performance.now() + 2000;
  while (!condition()) {
    assert.ok(performance.now() < deadline, "bounded fixture observation completed");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const fixedError = {
  type: "error",
  error: { type: "invalid_request_error", message: "Invalid qualification request" },
};
const post = (model, path, body) => fetch(model.origin + path, {
  method: "POST", headers: { "x-api-key": model.runtimeCredential.secret }, body,
});

test("ingress records the health/auth/route/count_tokens branches missing from accepted-model evidence", async () => {
  const model = await fixture();
  try {
    const health = await fetch(model.origin + "/health?private-query-do-not-record");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).modelMode, "local-protocol-test");
    const denied = await fetch(model.origin + "/v1/messages", { method: "POST", body: "not-json" });
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).error.type, "authentication_error");
    const wrongRoute = await fetch(model.origin + "/private-path-do-not-record?private-query", {
      method: "PATCH", headers: { "x-api-key": model.runtimeCredential.secret },
    });
    assert.equal(wrongRoute.status, 404);
    assert.equal(await wrongRoute.text(), "");
    const tokens = await post(model, "/v1/messages/count_tokens", "{}");
    assert.equal(tokens.status, 200);
    assert.deepEqual(await tokens.json(), { input_tokens: 1 });
    const evidence = model.evidence();
    assert.deepEqual(evidence.requests, []);
    assert.equal(evidence.ingress.started, 4);
    assert.equal(evidence.ingress.finished, 4);
    assert.equal(evidence.ingress.inFlight, 0);
    for (const category of ["health", "auth-rejected", "route-rejected", "count-tokens"])
      assert.equal(evidence.ingress.categoryCounts[category], 1);
    assert.equal(evidence.ingress.methodCounts.PATCH, 1);
    assert.equal(evidence.ingress.observationErrors, 0);
    const encoded = JSON.stringify(evidence.ingress);
    for (const excluded of [model.runtimeCredential.secret, "private-query", "private-path", "not-json", "x-api-key"])
      assert.equal(encoded.includes(excluded), false);
  } finally { await model.close(); }
});

test("invalid JSON, oversized bodies, missing Bash and other invalid requests retain the original 400 response", async () => {
  const model = await fixture();
  try {
    for (const [body, category] of [
      ["{", "invalid-json"],
      [Buffer.alloc(8 * 1024 * 1024 + 1, 120), "body-too-large"],
      [JSON.stringify({ messages: [{ content: qualificationPrompt(randomUUID()) }] }), "missing-bash"],
      ["null", "invalid-request"],
    ]) {
      const response = await post(model, "/v1/messages", body);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), fixedError);
      assert.equal(model.evidence().ingress.categoryCounts[category], 1);
    }
    assert.deepEqual(model.evidence().requests, []);
    assert.equal(model.evidence().ingress.responseStatusCounts["400"], 4);
    assert.equal(model.evidence().ingress.finished, 4);
  } finally { await model.close(); }
});

test("accepted tool and auxiliary requests keep their response semantics and safe independent timings", async () => {
  const model = await fixture();
  try {
    const id = randomUUID();
    const tool = await post(model, "/v1/messages?discard-this-query", JSON.stringify({
      messages: [{ content: qualificationPrompt(id) }], tools: [{ name: "Bash" }],
    }));
    assert.equal(tool.status, 200);
    assert.equal((await tool.json()).stop_reason, "tool_use");
    const auxiliary = await post(model, "/v1/messages", "{}");
    assert.equal((await auxiliary.json()).stop_reason, "end_turn");
    const evidence = model.evidence();
    assert.equal(evidence.requests[0].phase, "tool-issued");
    assert.match(evidence.requests[0].requestDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(evidence.ingress.categoryCounts["tool-issued"], 1);
    assert.equal(evidence.ingress.categoryCounts.auxiliary, 1);
    for (const row of evidence.ingress.records) {
      assert.deepEqual(Object.keys(row).sort(), ["route", "method", "category", "status", "outcome", "startedAtMs", "decisionAtMs", "finishedAtMs", "decisionElapsedMs", "durationMs"].sort());
      assert.equal(row.outcome, "response-finished");
      for (const field of ["startedAtMs", "decisionAtMs", "finishedAtMs", "decisionElapsedMs", "durationMs"])
        assert.ok(Number.isFinite(row[field]) && row[field] >= 0);
    }
    assert.equal(JSON.stringify(evidence.ingress).includes(id), false);
    evidence.ingress.records[0].category = "caller-mutated";
    evidence.ingress.categoryCounts["tool-issued"] = 999;
    evidence.ingress.routeCounts.messages = 999;
    assert.equal(model.evidence().ingress.records[0].category, "tool-issued");
    assert.equal(model.evidence().ingress.categoryCounts["tool-issued"], 1);
    assert.equal(model.evidence().ingress.routeCounts.messages, 2);
  } finally { await model.close(); }
});

test("partial-body client abort is counted once without reading or retaining body content", async () => {
  const model = await fixture();
  try {
    const request = httpRequest(model.origin + "/v1/messages", {
      method: "POST", headers: { "x-api-key": model.runtimeCredential.secret, "content-length": "10000" },
    });
    request.on("error", () => {});
    request.write("private-partial-body-do-not-record");
    await waitFor(() => model.evidence().ingress.started === 1);
    request.destroy();
    await waitFor(() => model.evidence().ingress.finished === 1);
    const ingress = model.evidence().ingress;
    assert.equal(ingress.categoryCounts["client-abort"], 1);
    assert.equal(ingress.records[0].outcome, "client-abort");
    assert.equal(ingress.records[0].status, null);
    assert.equal(ingress.inFlight, 0);
    assert.equal(JSON.stringify(ingress).includes("private-partial-body"), false);
    assert.deepEqual(model.evidence().requests, []);
  } finally { await model.close(); }
});

test("held streams are visible before completion and fixture shutdown is not misreported as a client abort", async () => {
  const model = await fixture();
  try {
    const id = randomUUID();
    const response = await post(model, "/v1/messages", JSON.stringify({
      stream: true, messages: [
        { content: qualificationPrompt(id) },
        { content: [{ type: "tool_result", tool_use_id: "toolu_upg_" + id.replaceAll("-", "") }] },
      ],
    }));
    const reader = response.body.getReader();
    await reader.read();
    assert.equal(model.evidence().ingress.inFlight, 1);
    assert.equal(model.evidence().ingress.categoryCounts["tool-result-held"], 1);
    await model.close();
    await waitFor(() => model.evidence().ingress.inFlight === 0);
    const ingress = model.evidence().ingress;
    assert.equal(ingress.inFlight, 0);
    assert.equal(ingress.categoryCounts["fixture-close"], 1);
    assert.equal(ingress.categoryCounts["client-abort"], 0);
    assert.equal(ingress.records[0].outcome, "fixture-close");
    await reader.cancel().catch(() => {});
  } finally { await model.close(); }
});

test("ingress record storage is bounded while fixed-enum aggregate counts keep observing omitted requests", async () => {
  const model = await fixture();
  try {
    const maximum = model.evidence().ingress.maximumRecords;
    for (let at = 0; at < maximum + 3; at += 16) {
      await Promise.all(Array.from({ length: Math.min(16, maximum + 3 - at) }, async () => {
        const response = await fetch(model.origin + "/health");
        await response.text();
      }));
    }
    const ingress = model.evidence().ingress;
    assert.equal(ingress.records.length, maximum);
    assert.equal(ingress.omittedRecords, 3);
    assert.equal(ingress.started, maximum + 3);
    assert.equal(ingress.finished, maximum + 3);
    assert.equal(ingress.categoryCounts.health, maximum + 3);
    assert.equal(ingress.routeCounts.health, maximum + 3);
    assert.equal(ingress.inFlight, 0);
    assert.equal(ingress.observationErrors, 0);
  } finally { await model.close(); }
});

test("unlisted HTTP methods are retained only as the fixed OTHER enum", async () => {
  const model = await fixture();
  try {
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(model.origin + "/v1/messages", {
        method: "PROPFIND", headers: { "x-api-key": model.runtimeCredential.secret },
      }, (response) => { response.resume(); response.once("end", () => resolve(response.statusCode)); });
      request.once("error", reject);
      request.end();
    });
    assert.equal(status, 404);
    const ingress = model.evidence().ingress;
    assert.equal(ingress.methodCounts.OTHER, 1);
    assert.equal(ingress.records[0].method, "OTHER");
    assert.equal(JSON.stringify(ingress).includes("PROPFIND"), false);
  } finally { await model.close(); }
});
