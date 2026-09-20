import test from "node:test";
import assert from "node:assert/strict";

import {
  responsesRequestToChat,
  chatCompletionToResponse,
  chatSseToResponsesStream,
} from "../vendor/freebuff2api/src/responses-adapter.ts";

test("Responses request converts Codex messages, tools and tool outputs to Chat Completions", () => {
  const converted = responsesRequestToChat({
    model: "freebuff/test/model",
    instructions: "You are a coding agent.",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
      { type: "function_call", call_id: "call_1", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call_output", call_id: "call_1", output: [{ type: "input_text", text: "a.txt" }] },
    ],
    tools: [{
      type: "function",
      name: "exec_command",
      description: "Run a command",
      parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
    }],
    stream: true,
  });

  assert.equal(converted.model, "freebuff/test/model");
  assert.equal(converted.stream, true);
  assert.equal(converted.messages[0].role, "system");
  assert.equal(converted.messages[1].content, "list files");
  assert.equal(converted.messages[2].tool_calls[0].function.name, "exec_command");
  assert.equal(converted.messages[3].role, "tool");
  assert.equal(converted.messages[3].content, "a.txt");
  assert.equal(converted.tools[0].function.name, "exec_command");
});

test("non-stream Chat Completion converts to a Responses object with function call", () => {
  const result = chatCompletionToResponse({
    choices: [{
      message: {
        content: "Checking.",
        tool_calls: [{
          id: "call_7",
          type: "function",
          function: { name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
        }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  }, "resp_test");

  assert.equal(result.id, "resp_test");
  assert.equal(result.status, "completed");
  assert.equal(result.output[0].type, "message");
  assert.equal(result.output[1].type, "function_call");
  assert.equal(result.output[1].call_id, "call_7");
  assert.equal(result.usage.total_tokens, 14);
});

test("Chat Completion SSE converts text and tool calls to Responses SSE", async () => {
  const encoder = new TextEncoder();
  const chatSse = [
    'data: {"choices":[{"delta":{"content":"Hi "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"there"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"exec_","arguments":"{\\\"cmd\\\":\\\""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"command","arguments":"pwd\\\"}"}}]}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
    "data: [DONE]\n\n",
  ].join("");

  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(chatSse));
      controller.close();
    },
  });

  const responseStream = chatSseToResponsesStream(source);
  const text = await new Response(responseStream).text();

  assert.match(text, /response\.created/);
  assert.match(text, /response\.output_text\.delta/);
  assert.match(text, /Hi /);
  assert.match(text, /there/);
  assert.match(text, /"type":"function_call"/);
  assert.match(text, /"call_id":"call_9"/);
  assert.match(text, /"name":"exec_command"/);
  assert.match(text, /response\.completed/);
  assert.match(text, /"total_tokens":5/);
});
