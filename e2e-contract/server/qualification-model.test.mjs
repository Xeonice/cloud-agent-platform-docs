import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  startQualificationModel,
  qualificationPrompt,
  qualificationExitPrompt,
} from "./qualification-model.mjs";

test("model qualification requires a dedicated isolated instance", async () => {
  await assert.rejects(
    startQualificationModel({ isolated: false, instanceId: "production" }),
  );
});
test("finite tasks receive a real final response only after their tool result and explicit release", async () => {
  const model = await startQualificationModel({
    isolated: true,
    instanceId: "upgrade-acceptance-model",
  });
  try {
    const id = randomUUID(),
      prompt = qualificationExitPrompt(id);
    const post = (messages, tools) =>
      fetch(model.origin + "/v1/messages", {
        method: "POST",
        headers: { "x-api-key": model.runtimeCredential.secret },
        body: JSON.stringify({
          model: "qualification",
          stream: true,
          messages,
          tools,
        }),
      });
    assert.throws(() => model.finishTask(id), /EXPLICIT_EXIT_TASK_REQUIRED/);
    const issued = await post(
      [{ role: "user", content: prompt }],
      [{ name: "Bash" }],
    );
    assert.match(await issued.text(), /lt 3/);
    assert.throws(() => model.finishTask(id), /ACTUAL_TOOL_RESULT_REQUIRED/);
    const result = await post([
      { role: "user", content: prompt },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_upg_" + id.replaceAll("-", ""),
            content: "fixed tool finished",
          },
        ],
      },
    ]);
    const text = result.text();
    assert.equal(model.evidence().activeStreams, 1);
    assert.deepEqual(model.finishTask(id), {
      taskId: id,
      finalResponseReleased: true,
    });
    const final = await text;
    assert.match(final, /"stop_reason":"end_turn"/);
    assert.match(final, /message_stop/);
    assert.doesNotMatch(final, /"type":"tool_use"/);
    assert.equal(model.evidence().finalResponses[0].taskId, id);
    assert.throws(
      () => model.finishTask(randomUUID()),
      /EXPLICIT_EXIT_TASK_REQUIRED/,
    );
  } finally {
    await model.close();
  }
});
test("actual HTTP rejects unrelated keys and emits the declared tool stream without leaking keys", async () => {
  const model = await startQualificationModel({
    isolated: true,
    instanceId: "upgrade-acceptance-model",
  });
  try {
    const id = randomUUID(),
      body = {
        model: "qualification",
        stream: true,
        messages: [{ role: "user", content: qualificationPrompt(id) }],
        tools: [{ name: "Bash", input_schema: { type: "object" } }],
      };
    assert.equal(
      (
        await fetch(model.origin + "/v1/messages", {
          method: "POST",
          body: JSON.stringify(body),
        })
      ).status,
      401,
    );
    const response = await fetch(model.origin + "/v1/messages?beta=true", {
      method: "POST",
      headers: { "x-api-key": model.runtimeCredential.secret },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    const events = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ],
    );
    assert.equal(events[1].content_block.name, "Bash");
    assert.match(
      JSON.parse(events[2].delta.partial_json).command,
      /while :; do/,
    );
    assert.equal(events[4].delta.stop_reason, "tool_use");
    assert.equal(model.evidence().requests[0].phase, "tool-issued");
    assert.equal(model.evidence().modelQualityQualified, false);
    assert.equal(
      JSON.stringify(model.evidence()).includes(model.runtimeCredential.secret),
      false,
    );
  } finally {
    await model.close();
  }
});
test("a real CLI tool result holds the same task connection instead of issuing the tool again", async () => {
  const model = await startQualificationModel({
    isolated: true,
    instanceId: "upgrade-acceptance-model",
  });
  const abort = new AbortController();
  try {
    const id = randomUUID(),
      toolId = "toolu_upg_" + id.replaceAll("-", "");
    const response = await fetch(model.origin + "/v1/messages", {
      method: "POST",
      signal: abort.signal,
      headers: { "x-api-key": model.runtimeCredential.secret },
      body: JSON.stringify({
        model: "qualification",
        stream: true,
        messages: [
          { role: "user", content: qualificationPrompt(id) },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolId,
                content: "actual CLI tool response",
              },
            ],
          },
        ],
      }),
    });
    const first = await response.body.getReader().read();
    assert.match(new TextDecoder().decode(first.value), /message_start/);
    assert.equal(model.evidence().requests[0].phase, "tool-result-held");
    assert.equal(model.evidence().activeStreams, 1);
    abort.abort();
  } finally {
    abort.abort();
    await model.close();
  }
});
