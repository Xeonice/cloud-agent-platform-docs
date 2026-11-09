import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createQualificationHttpObservation,
  attachQualificationBrowserHttp,
  observeQualificationApiFetch,
} from "./qualification-http-observation.mjs";

test("passive browser timing records overlap and completion without reading secrets", () => {
  let now = 100;
  const observer = createQualificationHttpObservation({ monotonicNow: () => now, epochNow: () => 1000 });
  const page = new EventEmitter(), detach = attachQualificationBrowserHttp(page, observer);
  const request = (path, method = "GET") => ({
    url: () => "http://127.0.0.1" + path, method: () => method,
    headers: () => { throw Error("must not read headers"); },
    postData: () => { throw Error("must not read body"); },
    failure: () => { throw Error("must not read raw error"); },
  });
  const first = request("/api/system/upgrade/status?token=private"), second = request("/api/projects", "POST");
  page.emit("request", first); now = 110; page.emit("request", second);
  now = 120; page.emit("response", { request: () => first, status: () => 200 });
  now = 130; page.emit("requestfailed", second);
  now = 140; page.emit("requestfinished", first);
  page.emit("requestfinished", first); // duplicate terminal events cannot underflow.
  const actual = observer.snapshot();
  assert.deepEqual(actual.anchor, { epochMs: 1000, monotonicMs: 100 });
  assert.equal(actual.records[0].firstResponseMs, 20);
  assert.equal(actual.records[0].durationMs, 40);
  assert.equal(actual.records[1].outcome, "request-failed");
  assert.equal(actual.summary.maximumInFlight, 2);
  assert.equal(actual.summary.inFlight, 0);
  assert.equal(JSON.stringify(actual).includes("private"), false);
  assert.equal(actual.extraRequests, 0);
  detach(); assert.equal(page.eventNames().length, 0);
});

test("bounded records retain accounting and leave unfinished requests unknown", () => {
  const observer = createQualificationHttpObservation({ maximumRecords: 1 });
  assert.equal(observer.begin("http://localhost/assets/app.js", "GET", "browser"), null);
  const a = observer.begin("http://localhost/api/a", "GET", "api-context");
  const b = observer.begin("http://localhost/api/b", "GET", "api-context");
  observer.response(b, 503); observer.end(b, "finished");
  const result = observer.snapshot();
  assert.equal(result.records.length, 1);
  assert.equal(result.summary.started, 2);
  assert.equal(result.summary.omittedRecords, 1);
  assert.equal(result.summary.pendingAtSnapshot, 1);
  assert.equal(a.outcome, undefined);
  assert.equal(a.status, undefined);
  observer.end(a, "finished");
  assert.equal(result.records[0].outcome, undefined); // snapshots stay frozen.
  assert.equal(result.summary.pendingAtSnapshot, 1);
});

test("API timing observes the original unresolved fetch once and preserves its response", async () => {
  let complete, calls = 0;
  const observer = createQualificationHttpObservation();
  const response = { status: () => 503 };
  const work = observeQualificationApiFetch(observer, "http://localhost/api/system/upgrade/status", "GET", () => {
    calls++;
    return new Promise(resolve => { complete = resolve; });
  });
  assert.equal(observer.snapshot().summary.inFlight, 1);
  assert.equal(observer.records[0].outcome, undefined);
  complete(response);
  assert.equal(await work, response);
  assert.equal(calls, 1);
  assert.equal(observer.records[0].status, 503);
  assert.equal(observer.records[0].outcome, "fetch-resolved");
});

test("API failure rethrows the same error without exposing its message or replaying", async () => {
  const observer = createQualificationHttpObservation();
  const original = Error("secret-request-details");
  let calls = 0;
  await assert.rejects(observeQualificationApiFetch(observer, "http://localhost/api/system/upgrade/status?private=yes", "GET", () => {
    calls++;
    throw original;
  }), error => error === original);
  assert.equal(calls, 1);
  const actual = observer.snapshot();
  assert.equal(actual.summary.inFlight, 0);
  assert.equal(actual.records[0].status, undefined);
  assert.equal(actual.records[0].outcome, "request-failed");
  assert.equal(JSON.stringify(actual).includes("secret"), false);
  assert.equal(JSON.stringify(actual).includes("private"), false);
});
