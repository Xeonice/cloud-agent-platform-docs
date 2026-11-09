import { createServer } from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { assertQualificationIsolation } from './qualification-isolation.mjs';

const MARKER = /UPG_PROTOCOL_TASK:([a-f0-9-]{36})/;
export const qualificationPrompt = (id) => {
  if (!/^[a-f0-9-]{36}$/.test(id))
    throw new Error("INVALID_QUALIFICATION_TASK");
  return `UPG_PROTOCOL_TASK:${id} Run the qualification Bash tool and keep this original task active until the test explicitly cancels it.`;
};
export const qualificationExitPrompt = (id) => {
  qualificationPrompt(id); // Validate the same dedicated task identity.
  return `UPG_PROTOCOL_TASK:${id} UPG_PROTOCOL_EXIT:${id} Run the qualification Bash tool, then complete this task normally when the final response is released.`;
};

// This substitutes only model responses. The actual CLI must execute the tool
// in its original BoxLite VM through the normal AgentTask/job path.
function command(id, finite = false) {
  const folder = "/workspace/.upg-agent-proof/" + id;
  // Bash tools may execute in a subshell: $$ still names its parent shell,
  // while BASHPID identifies the process that actually runs this counter.
  return `mkdir -p ${folder}; pid=\${BASHPID:-$$}; printf '%s\\n' "$pid" >> ${folder}/launches; printf '%s\\n' "$pid" > ${folder}/pid; awk '{print $22}' /proc/$pid/stat > ${folder}/birth; i=0; while ${finite ? '[ "$i" -lt 3 ]' : ":"}; do i=$((i+1)); printf '%s\\n' $i >> ${folder}/counter; sleep 1; done`;
}
function finishMessage(res) {
  send(res, {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  send(res, {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Qualification task complete." },
  });
  send(res, { type: "content_block_stop", index: 0 });
  send(res, {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  send(res, { type: "message_stop" });
  res.end();
}
function send(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
function message(model, id, content, reason) {
  return {
    id: "msg_upg_" + id.replaceAll("-", ""),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: reason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}
const MAX_INGRESS_RECORDS = 256;
const INGRESS_CATEGORIES = [
  "health", "auth-rejected", "route-rejected", "count-tokens",
  "tool-issued", "tool-result-held", "auxiliary", "invalid-json",
  "body-too-large", "missing-bash", "invalid-request", "client-abort", "fixture-close",
];
const INGRESS_METHODS = ["GET", "POST", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS", "OTHER"];

// Independent transport evidence: fixed enums and numbers only. Neither the
// request URL nor headers, body, key, error text or task content is retained.
function createIngressObservation() {
  const records = [];
  const counts = {
    started: 0, finished: 0, inFlight: 0, maximumInFlight: 0,
    omittedRecords: 0, observationErrors: 0,
  };
  const routes = { health: 0, messages: 0, "count-tokens": 0, other: 0 };
  const methods = Object.fromEntries(INGRESS_METHODS.map((name) => [name, 0]));
  const categories = Object.fromEntries(INGRESS_CATEGORIES.map((name) => [name, 0]));
  const statuses = { "200": 0, "400": 0, "401": 0, "404": 0 };
  let closing = false;
  const bump = (object, key) => {
    object[key] = Math.min(Number.MAX_SAFE_INTEGER, object[key] + 1);
  };
  const safe = (action) => {
    try { action(); } catch { bump(counts, "observationErrors"); }
  };
  return {
    begin(req, res, pathname) {
      let done = false, selected = false;
      const started = performance.now();
      const record = {
        route: pathname === "/health" ? "health" : pathname === "/v1/messages" ? "messages"
          : pathname === "/v1/messages/count_tokens" ? "count-tokens" : "other",
        method: INGRESS_METHODS.includes(req.method) ? req.method : "OTHER",
        category: "pending", status: null, outcome: "in-flight",
        startedAtMs: Date.now(), decisionAtMs: null, finishedAtMs: null,
        decisionElapsedMs: null, durationMs: null,
      };
      const finish = (outcome) => safe(() => {
        if (done) return;
        done = true;
        try {
          record.outcome = outcome;
          record.finishedAtMs = Date.now();
          record.durationMs = Math.max(0, performance.now() - started);
          bump(counts, "finished");
          counts.inFlight = Math.max(0, counts.inFlight - 1);
          if (outcome !== "response-finished") bump(categories, outcome);
        } finally {
          req.off("aborted", aborted);
          res.off("finish", finished);
          res.off("close", closed);
        }
      });
      const aborted = () => finish(closing ? "fixture-close" : "client-abort");
      const finished = () => finish("response-finished");
      const closed = () => finish(res.writableFinished ? "response-finished"
        : closing ? "fixture-close" : "client-abort");
      safe(() => {
        bump(counts, "started");
        bump(counts, "inFlight");
        counts.maximumInFlight = Math.max(counts.maximumInFlight, counts.inFlight);
        bump(routes, record.route);
        bump(methods, record.method);
        if (records.length < MAX_INGRESS_RECORDS) records.push(record);
        else bump(counts, "omittedRecords");
        req.once("aborted", aborted);
        res.once("finish", finished);
        res.once("close", closed);
      });
      return {
        mark(category, status) {
          safe(() => {
            if (done || selected) return;
            if (!INGRESS_CATEGORIES.includes(category) || !Object.hasOwn(statuses, String(status))) {
              bump(counts, "observationErrors");
              return;
            }
            selected = true;
            record.category = category;
            record.status = status;
            record.decisionAtMs = Date.now();
            record.decisionElapsedMs = Math.max(0, performance.now() - started);
            bump(categories, category);
            bump(statuses, String(status));
          });
        },
        afterHandler() {
          safe(() => {
            if (res.writableFinished) finished();
            else if (res.destroyed) closed();
          });
        },
      };
    },
    closing() { closing = true; },
    snapshot() {
      return {
        schemaVersion: 1, kind: "qualification-model-http-ingress-observation",
        maximumRecords: MAX_INGRESS_RECORDS, ...counts,
        routeCounts: { ...routes }, methodCounts: { ...methods },
        // Branch counts can include an abort/fixture-close after a selected response.
        categoryCounts: { ...categories }, responseStatusCounts: { ...statuses },
        records: records.map((record) => ({ ...record })),
      };
    },
  };
}

async function bodyOf(req, rejected) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) {
      rejected("body-too-large");
      throw new Error("MODEL_REQUEST_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    rejected("invalid-json");
    throw error;
  }
}
export async function startQualificationModel({
  isolated,
  instanceId,
  host = "127.0.0.1",
  guestHost = "host.boxlite.internal",
  port = 0,
  qualificationInput,
}) {
  if (qualificationInput?.sameInstanceQa !== undefined) {
    if (qualificationInput.instanceId !== instanceId || qualificationInput.isolated !== isolated)
      throw new Error('DEDICATED_QUALIFICATION_INSTANCE_REQUIRED');
    await assertQualificationIsolation(qualificationInput);
  }
  if (
    isolated !== true ||
    (!/^upgrade-acceptance-[a-zA-Z0-9._-]+$/.test(instanceId) && qualificationInput?.sameInstanceQa === undefined)
  )
    throw new Error("DEDICATED_QUALIFICATION_INSTANCE_REQUIRED");
  const secret = "sk-ant-upg-qualification-" + randomBytes(24).toString("hex");
  const requests = [],
    held = new Set(),
    finiteTasks = new Set(),
    releasedTasks = new Set(),
    taskStreams = new Map(),
    releases = [];
  const ingress = createIngressObservation();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://qualification.invalid");
    const observation = ingress.begin(req, res, url.pathname);
    if (req.method === "GET" && url.pathname === "/health") {
      observation.mark("health", 200);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          modelMode: "local-protocol-test",
          modelQualityQualified: false,
        }),
      );
      return;
    }
    if (req.headers["x-api-key"] !== secret) {
      observation.mark("auth-rejected", 401);
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "authentication_error",
            message: "Dedicated qualification key required",
          },
        }),
      );
      return;
    }
    if (
      req.method !== "POST" ||
      !["/v1/messages", "/v1/messages/count_tokens"].includes(url.pathname)
    ) {
      observation.mark("route-rejected", 404);
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const input = await bodyOf(req, (category) => observation.mark(category, 400));
      if (url.pathname.endsWith("/count_tokens")) {
        observation.mark("count-tokens", 200);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      const marker = MARKER.exec(JSON.stringify(input.messages ?? []))?.[1];
      const id = marker ?? "00000000-0000-0000-0000-000000000000";
      const finite =
        marker &&
        JSON.stringify(input.messages ?? []).includes(
          "UPG_PROTOCOL_EXIT:" + marker,
        );
      if (finite) finiteTasks.add(id);
      const toolId = "toolu_upg_" + id.replaceAll("-", "");
      const toolResult = (input.messages ?? []).some(
        (entry) =>
          Array.isArray(entry.content) &&
          entry.content.some(
            (block) =>
              block.type === "tool_result" && block.tool_use_id === toolId,
          ),
      );
      const tool = (input.tools ?? []).find((value) => value.name === "Bash");
      if (marker && !toolResult && !tool) {
        observation.mark("missing-bash", 400);
        throw new Error("ACTUAL_CLI_BASH_TOOL_REQUIRED");
      }
      const phase = !marker
        ? "auxiliary"
        : toolResult
          ? "tool-result-held"
          : "tool-issued";
      requests.push({
        at: new Date().toISOString(),
        taskId: marker ?? null,
        phase,
        requestDigest:
          "sha256:" +
          createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      });
      observation.mark(phase, 200);
      if (toolResult) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        send(res, {
          type: "message_start",
          message: message(input.model, id, [], null),
        });
        const ping = setInterval(() => send(res, { type: "ping" }), 1000);
        held.add(res);
        if (finiteTasks.has(id)) taskStreams.set(res, id);
        res.once("close", () => {
          clearInterval(ping);
          held.delete(res);
          taskStreams.delete(res);
        });
        if (releasedTasks.has(id)) finishMessage(res);
        return;
      }
      const content = marker
        ? [
            {
              type: "tool_use",
              id: toolId,
              name: tool.name,
              input: {
                command: command(id, finite),
                timeout: 600000,
                ...(!finite ? { run_in_background: true } : {}),
                description: "Run original upgrade continuity counter",
              },
            },
          ]
        : [{ type: "text", text: "Local qualification protocol service." }];
      const reason = marker ? "tool_use" : "end_turn";
      if (!input.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(message(input.model, id, content, reason)));
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      send(res, {
        type: "message_start",
        message: message(input.model, id, [], null),
      });
      const block = content[0];
      send(res, {
        type: "content_block_start",
        index: 0,
        content_block:
          block.type === "tool_use"
            ? { ...block, input: {} }
            : { type: "text", text: "" },
      });
      send(res, {
        type: "content_block_delta",
        index: 0,
        delta:
          block.type === "tool_use"
            ? {
                type: "input_json_delta",
                partial_json: JSON.stringify(block.input),
              }
            : { type: "text_delta", text: block.text },
      });
      send(res, { type: "content_block_stop", index: 0 });
      send(res, {
        type: "message_delta",
        delta: { stop_reason: reason, stop_sequence: null },
        usage: { output_tokens: 1 },
      });
      send(res, { type: "message_stop" });
      res.end();
    } catch {
      observation.mark("invalid-request", 400);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "Invalid qualification request",
          },
        }),
      );
    } finally {
      observation.afterHandler();
    }
  });
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, ok);
  });
  const selectedPort = server.address().port;
  return {
    origin: `http://${host}:${selectedPort}`,
    guestOrigin: `http://${guestHost}:${selectedPort}`,
    runtimeId: "claude-code",
    runtimeCredential: { method: "api-key", secret },
    finishTask(id) {
      if (!finiteTasks.has(id)) throw new Error("EXPLICIT_EXIT_TASK_REQUIRED");
      const streams = [...taskStreams].filter(([, taskId]) => taskId === id);
      if (streams.length === 0) throw new Error("ACTUAL_TOOL_RESULT_REQUIRED");
      if (releasedTasks.has(id))
        throw new Error("EXIT_RESPONSE_ALREADY_RELEASED");
      releasedTasks.add(id);
      releases.push({
        taskId: id,
        at: new Date().toISOString(),
        actualToolResult: true,
      });
      for (const [response] of streams) finishMessage(response);
      return { taskId: id, finalResponseReleased: true };
    },
    imageEnv: [
      {
        key: "NO_PROXY",
        value: [guestHost, "localhost", "127.0.0.1", "::1"].join(","),
        secret: false,
      },
      {
        key: "ANTHROPIC_BASE_URL",
        value: `http://${guestHost}:${selectedPort}`,
        secret: false,
      },
    ],
    evidence: () => ({
      modelMode: "local-protocol-test",
      modelQualityQualified: false,
      requests: [...requests],
      finalResponses: releases.map((row) => ({ ...row })),
      activeStreams: held.size,
      ingress: ingress.snapshot(),
    }),
    async close() {
      ingress.closing();
      for (const res of held) res.destroy();
      await new Promise((ok) => {
        server.close(ok);
        server.closeAllConnections();
      });
    },
  };
}

/** Use the actual public image configuration API before any measured task exists. */
export async function configureQualificationImage(request, origin, model) {
  const response = await request.get(origin + "/api/images?provider=boxlite");
  if (response.status() !== 200)
    throw new Error("QUALIFICATION_IMAGE_LIST_FAILED");
  const images = await response.json();
  const selected = images.find(
    (image) =>
      image.isProviderDefault &&
      image.isActive &&
      image.validationStatus !== "invalid" &&
      image.supportedRuntimes.includes(model.runtimeId),
  );
  if (!selected) throw new Error("ACTUAL_CONFIGURED_CLI_IMAGE_REQUIRED");
  const replaced = new Set(model.imageEnv.map((entry) => entry.key));
  const env = [
    ...(selected.imageConfig?.env ?? []).filter(
      (entry) => !replaced.has(entry.key),
    ),
    ...model.imageEnv,
  ];
  const patched = await request.patch(
    origin + "/api/images/" + encodeURIComponent(selected.id),
    {
      data: { imageConfig: { env } },
      headers: { Origin: origin, "X-Operation-Id": randomUUID() },
    },
  );
  if (patched.status() !== 200)
    throw new Error("QUALIFICATION_IMAGE_CONFIG_FAILED");
  const actual = await patched.json();
  if (
    !model.imageEnv.every((entry) =>
      actual.imageConfig?.env.some(
        (value) => value.key === entry.key && value.value === entry.value,
      ),
    )
  )
    throw new Error("QUALIFICATION_MODEL_ENDPOINT_NOT_SAVED");
  return {
    imageManifestId: actual.id,
    imageDigest: actual.digest,
    runtimeId: model.runtimeId,
  };
}
