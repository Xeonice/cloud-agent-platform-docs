import { createServer } from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";

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
async function bodyOf(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) throw new Error("MODEL_REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function startQualificationModel({
  isolated,
  instanceId,
  host = "127.0.0.1",
  guestHost = "host.boxlite.internal",
  port = 0,
}) {
  if (
    isolated !== true ||
    !/^upgrade-acceptance-[a-zA-Z0-9._-]+$/.test(instanceId)
  )
    throw new Error("DEDICATED_QUALIFICATION_INSTANCE_REQUIRED");
  const secret = "sk-ant-upg-qualification-" + randomBytes(24).toString("hex");
  const requests = [],
    held = new Set(),
    finiteTasks = new Set(),
    releasedTasks = new Set(),
    taskStreams = new Map(),
    releases = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://qualification.invalid");
    if (req.method === "GET" && url.pathname === "/health") {
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
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const input = await bodyOf(req);
      if (url.pathname.endsWith("/count_tokens")) {
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
      if (marker && !toolResult && !tool)
        throw new Error("ACTUAL_CLI_BASH_TOOL_REQUIRED");
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
    }),
    async close() {
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
