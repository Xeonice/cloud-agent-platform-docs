import { performance } from "node:perf_hooks";

// Passive QA evidence only. Never read headers, query strings, bodies, cookies,
// error messages or terminal frames, and never send a diagnostic request.
export function createQualificationHttpObservation({
  maximumRecords = 20000,
  monotonicNow = () => performance.now(),
  epochNow = () => Date.now(),
} = {}) {
  if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 100000)
    throw new Error("QUALIFICATION_HTTP_RECORD_BOUND_REQUIRED");
  const records = [], pending = new WeakSet();
  const anchor = { epochMs: epochNow(), monotonicMs: monotonicNow() };
  let sequence = 0, inFlight = 0, maximumInFlight = 0, omittedRecords = 0;
  function begin(url, method, channel) {
    const path = new URL(url).pathname;
    if (!path.startsWith("/api/")) return null;
    const row = { id: ++sequence, path, method, channel, at: monotonicNow() };
    inFlight++;
    maximumInFlight = Math.max(maximumInFlight, inFlight);
    row.inFlightAtStart = inFlight;
    pending.add(row);
    if (records.length < maximumRecords) records.push(row);
    else omittedRecords++;
    return row;
  }
  function response(row, status) {
    if (!pending.has(row) || row.responseAt !== undefined) return;
    row.status = status;
    row.responseAt = monotonicNow();
    row.firstResponseMs = row.responseAt - row.at;
  }
  function end(row, outcome) {
    if (!pending.delete(row)) return;
    row.finishedAt = monotonicNow();
    row.durationMs = row.finishedAt - row.at;
    row.outcome = outcome;
    row.inFlightAtFinish = --inFlight;
  }
  function snapshot() {
    return {
      schemaVersion: 1,
      kind: "passive-qualification-http-observation",
      anchor: { ...anchor },
      records: records.map(row => ({ ...row })),
      observedAt: { epochMs: epochNow(), monotonicMs: monotonicNow() },
      summary: {
        started: sequence, inFlight, maximumInFlight, omittedRecords,
        pendingAtSnapshot: inFlight,
        maximumRecords,
      },
      extraRequests: 0,
      requestBodiesOrSecretsRead: false,
      qualificationEvidence: false,
    };
  }
  return { begin, response, end, snapshot, records };
}

export function attachQualificationBrowserHttp(page, observer) {
  const rows = new WeakMap();
  const request = request => {
    const row = observer.begin(request.url(), request.method(), "browser");
    if (row) rows.set(request, row);
  };
  const response = response => observer.response(rows.get(response.request()), response.status());
  const finished = request => observer.end(rows.get(request), "finished");
  const failed = request => observer.end(rows.get(request), "request-failed");
  page.on("request", request);
  page.on("response", response);
  page.on("requestfinished", finished);
  page.on("requestfailed", failed);
  return () => {
    page.off("request", request);
    page.off("response", response);
    page.off("requestfinished", finished);
    page.off("requestfailed", failed);
  };
}

// APIRequestContext has no browser request events. Observe the existing fetch's
// settlement; JSON decoding and application assertions remain with the caller.
export async function observeQualificationApiFetch(observer, url, method, fetchExisting) {
  const row = observer?.begin(url, method, "api-context");
  try {
    const response = await fetchExisting();
    observer?.response(row, response.status());
    observer?.end(row, "fetch-resolved");
    return response;
  } catch (error) {
    observer?.end(row, "request-failed");
    throw error;
  }
}
