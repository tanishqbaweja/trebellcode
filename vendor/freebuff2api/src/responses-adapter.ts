import { randomUUID } from "node:crypto";

type Json = Record<string, any>;

function splitNamespacedTool(name: string): { name: string; namespace?: string } {
  const marker = name.indexOf("__");
  if (marker <= 0 || marker >= name.length - 2) return { name };
  return { namespace: name.slice(0, marker), name: name.slice(marker + 2) };
}

function responsesToolName(tool: any): string {
  if (typeof tool?.namespace === "string" && tool.namespace && typeof tool?.name === "string") {
    return `${tool.namespace}__${tool.name}`;
  }
  return typeof tool?.name === "string" ? tool.name : "tool";
}

function contentToChat(content: any): any {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: any[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
      if (typeof part.text === "string") parts.push({ type: "text", text: part.text });
    } else if (part.type === "input_image" && typeof part.image_url === "string") {
      parts.push({ type: "image_url", image_url: { url: part.image_url } });
    }
  }
  if (parts.length === 0) return "";
  if (parts.every((p) => p.type === "text")) return parts.map((p) => p.text).join("");
  return parts;
}

function toolOutputToString(output: any): string {
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

export function responsesRequestToChat(body: Json): Json {
  const messages: any[] = [];
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

  const tools: any[] = [];
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
              parameters: child.parameters || {},
            },
          });
        }
      }
    }
  }

  const chat: Json = {
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
  if (typeof body.max_output_tokens === "number") chat.max_tokens = body.max_output_tokens;
  return chat;
}

function responseUsage(usage: any) {
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

function sseEvent(type: string, value: any): string {
  return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
}

export function chatCompletionToResponse(body: any, responseId = `resp_${randomUUID()}`) {
  const choice = body?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const output: any[] = [];
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

export function chatSseToResponsesStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const responseId = `resp_${randomUUID()}`;
  let buffer = "";
  let fullText = "";
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: any = null;
  let messageId = `msg_${randomUUID()}`;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(sseEvent("response.created", {
        type: "response.created",
        response: { id: responseId },
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
            let chunk: any;
            try { chunk = JSON.parse(data); } catch { continue; }
            if (chunk.usage) usage = chunk.usage;
            const delta = chunk?.choices?.[0]?.delta ?? {};
            if (typeof delta.content === "string" && delta.content) {
              fullText += delta.content;
              controller.enqueue(encoder.encode(sseEvent("response.output_text.delta", {
                type: "response.output_text.delta",
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
            item: {
              type: "message",
              role: "assistant",
              id: messageId,
              content: [{ type: "output_text", text: fullText }],
            },
          })));
        }
        for (const call of [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)) {
          const split = splitNamespacedTool(call.name || "tool");
          controller.enqueue(encoder.encode(sseEvent("response.output_item.done", {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: call.id,
              ...split,
              arguments: call.arguments || "{}",
            },
          })));
        }
        controller.enqueue(encoder.encode(sseEvent("response.completed", {
          type: "response.completed",
          response: {
            id: responseId,
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

export async function adaptResponsesRequest(
  request: Request,
  forwardChat: (request: Request) => Promise<Response>,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: { message: "method not allowed", type: "invalid_request_error" } }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }
  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: { message: "invalid JSON body", type: "invalid_request_error" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const chatBody = responsesRequestToChat(body);
  const headers = new Headers(request.headers);
  headers.set("x-trebell-client", "Trebell-Code/0.6.0");
  const chatRequest = new Request(new URL("/v1/chat/completions", request.url), {
    method: "POST",
    headers,
    body: JSON.stringify(chatBody),
    signal: request.signal,
  });
  const upstream = await forwardChat(chatRequest);
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
