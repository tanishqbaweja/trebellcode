import { randomUUID } from "node:crypto";

function splitNamespacedTool(name) {
  const marker = String(name || "").indexOf("__");
  if (marker <= 0 || marker >= String(name || "").length - 2) return { name: String(name || "tool") };
  return { namespace: name.slice(0, marker), name: name.slice(marker + 2) };
}

function responsesToolName(tool) {
  if (typeof tool?.namespace === "string" && tool.namespace && typeof tool?.name === "string") {
    return `${tool.namespace}__${tool.name}`;
  }
  return typeof tool?.name === "string" ? tool.name : "tool";
}

function contentToChat(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
      if (typeof part.text === "string") parts.push({ type: "text", text: part.text });
    } else if (part.type === "input_image" && typeof part.image_url === "string") {
      parts.push({ type: "image_url", image_url: { url: part.image_url } });
    }
  }
  if (!parts.length) return "";
  if (parts.every((part) => part.type === "text")) return parts.map((part) => part.text).join("");
  return parts;
}

function toolOutputToString(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item.text === "string") return item.text;
      return JSON.stringify(item);
    }).join("\n");
  }
  if (output == null) return "";
  return typeof output === "object" ? JSON.stringify(output) : String(output);
}

export function responsesRequestToChat(body = {}) {
  const messages = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions });
  }

  const input = Array.isArray(body.input) ? body.input : [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      messages.push({
        role: item.role === "assistant" ? "assistant" : item.role === "developer" ? "system" : "user",
        content: contentToChat(item.content),
      });
    } else if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: item.call_id || item.id || randomUUID(),
          type: "function",
          function: {
            name: responsesToolName(item),
            arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
          },
        }],
      });
    } else if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id || item.id || "",
        content: toolOutputToString(item.output),
      });
    }
  }

  const tools = [];
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!tool || typeof tool !== "object") continue;
      if (tool.type === "function") {
        tools.push({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters || {},
          },
        });
      } else if (tool.type === "namespace" && Array.isArray(tool.tools)) {
        for (const child of tool.tools) {
          if (!child || typeof child !== "object") continue;
          tools.push({
            type: "function",
            function: {
              name: `${tool.name}__${child.name}`,
              description: child.description || tool.description,
              parameters: child.parameters || child.inputSchema || {},
            },
          });
        }
      }
    }
  }

  const chat = {
    model: body.model,
    messages,
    stream: body.stream !== false,
  };
  if (tools.length) chat.tools = tools;
  if (body.tool_choice) {
    if (typeof body.tool_choice === "string") chat.tool_choice = body.tool_choice;
    else if (body.tool_choice.type === "function" && body.tool_choice.name) {
      chat.tool_choice = { type: "function", function: { name: body.tool_choice.name } };
    }
  }
  if (typeof body.temperature === "number") chat.temperature = body.temperature;
  if (typeof body.top_p === "number") chat.top_p = body.top_p;
  if (typeof body.max_output_tokens === "number") chat.max_tokens = body.max_output_tokens;
  if (typeof body.parallel_tool_calls === "boolean") chat.parallel_tool_calls = body.parallel_tool_calls;
  return chat;
}

function responseUsage(usage) {
  const input = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0;
  const output = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0;
  return {
    input_tokens: input,
    input_tokens_details: null,
    output_tokens: output,
    output_tokens_details: null,
    total_tokens: Number(usage?.total_tokens ?? input + output) || input + output,
  };
}

function sseEvent(type, value) {
  return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
}

export function chatCompletionToResponse(body, responseId = `resp_${randomUUID()}`) {
  const choice = body?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const output = [];
  if (typeof message.content === "string" && message.content) {
    output.push({
      type: "message",
      role: "assistant",
      id: `msg_${randomUUID()}`,
      content: [{ type: "output_text", text: message.content }],
    });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (call?.type !== "function") continue;
      const split = splitNamespacedTool(call.function?.name || "tool");
      output.push({
        type: "function_call",
        call_id: call.id || `call_${randomUUID()}`,
        ...split,
        arguments: call.function?.arguments || "{}",
      });
    }
  }
  return {
    id: responseId,
    object: "response",
    status: "completed",
    output,
    usage: responseUsage(body?.usage),
  };
}

export function chatSseToResponsesStream(source) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const responseId = `resp_${randomUUID()}`;
  let buffer = "";
  let fullText = "";
  const toolCalls = new Map();
  let usage = null;
  const messageId = `msg_${randomUUID()}`;

  return new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(sseEvent("response.created", {
        type: "response.created",
        response: { id: responseId, object: "response", status: "in_progress", output: [] },
      })));
      const reader = source.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() || "";
          for (const block of blocks) {
            const dataLines = block.split(/\r?\n/).filter((line) => line.startsWith("data:"));
            if (!dataLines.length) continue;
            const data = dataLines.map((line) => line.slice(5).trimStart()).join("\n");
            if (!data || data === "[DONE]") continue;
            let chunk;
            try { chunk = JSON.parse(data); } catch { continue; }
            if (chunk.usage) usage = chunk.usage;
            const delta = chunk?.choices?.[0]?.delta ?? {};
            if (typeof delta.content === "string" && delta.content) {
              fullText += delta.content;
              controller.enqueue(encoder.encode(sseEvent("response.output_text.delta", {
                type: "response.output_text.delta",
                item_id: messageId,
                output_index: 0,
                content_index: 0,
                delta: delta.content,
              })));
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const part of delta.tool_calls) {
                const index = Number.isInteger(part.index) ? part.index : 0;
                const current = toolCalls.get(index) || {
                  id: part.id || `call_${randomUUID()}`,
                  name: "",
                  arguments: "",
                };
                if (part.id) current.id = part.id;
                if (part.function?.name) current.name += part.function.name;
                if (part.function?.arguments) current.arguments += part.function.arguments;
                toolCalls.set(index, current);
              }
            }
          }
        }

        if (fullText) {
          controller.enqueue(encoder.encode(sseEvent("response.output_item.done", {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "message",
              role: "assistant",
              id: messageId,
              status: "completed",
              content: [{ type: "output_text", text: fullText }],
            },
          })));
        }
        let toolIndex = fullText ? 1 : 0;
        for (const call of [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value)) {
          const split = splitNamespacedTool(call.name || "tool");
          controller.enqueue(encoder.encode(sseEvent("response.output_item.done", {
            type: "response.output_item.done",
            output_index: toolIndex++,
            item: {
              type: "function_call",
              id: `fc_${randomUUID()}`,
              call_id: call.id,
              ...split,
              arguments: call.arguments || "{}",
              status: "completed",
            },
          })));
        }
        controller.enqueue(encoder.encode(sseEvent("response.completed", {
          type: "response.completed",
          response: {
            id: responseId,
            object: "response",
            status: "completed",
            usage: responseUsage(usage),
          },
        })));
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

export async function adaptResponsesBody(body, forwardChat) {
  const chatBody = responsesRequestToChat(body);
  const upstream = await forwardChat(chatBody);
  if (!upstream.ok) return upstream;

  const contentType = upstream.headers.get("content-type") || "";
  if (chatBody.stream && upstream.body && contentType.includes("text/event-stream")) {
    return new Response(chatSseToResponsesStream(upstream.body), {
      status: upstream.status,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }
  const json = await upstream.json();
  return Response.json(chatCompletionToResponse(json), { status: upstream.status });
}
