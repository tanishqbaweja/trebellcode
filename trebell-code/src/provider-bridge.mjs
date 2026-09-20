import { createServer } from "node:http";
import { adaptResponsesBody } from "./responses-chat-adapter.mjs";
import { normalizeProviderId } from "./provider-manager.mjs";
import { PROVIDER_COMPAT_PORT } from "./config.mjs";

export { PROVIDER_COMPAT_PORT };
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function writeWebResponse(res, response) {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (/^(content-length|transfer-encoding|connection)$/i.test(name)) continue;
    try { res.setHeader(name, value); } catch {}
  }
  if (!response.body) return res.end();
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
    res.end();
  } catch (error) {
    if (!res.headersSent) sendJson(res, 502, { error: { message: error.message, type: "provider_bridge_error" } });
    else res.destroy(error);
  } finally {
    reader.releaseLock();
  }
}

export async function startProviderBridge({
  port = PROVIDER_COMPAT_PORT,
  providerManager,
  provider = "agentrouter",
  log = () => {},
} = {}) {
  if (!providerManager) throw new Error("providerManager is required");
  let selectedProvider = normalizeProviderId(provider);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    try {
      if (url.pathname === "/healthz") {
        if (req.method !== "GET") return sendJson(res, 405, { error: { message: "method not allowed" } });
        return sendJson(res, 200, {
          ok: true,
          provider: selectedProvider,
          ready: selectedProvider !== "freebuff" && providerManager.hasKey(selectedProvider),
        });
      }

      if (url.pathname === "/v1/models") {
        if (req.method !== "GET") return sendJson(res, 405, { error: { message: "method not allowed" } });
        if (selectedProvider === "freebuff") {
          return sendJson(res, 400, { error: { message: "Freebuff uses the dedicated freebuff2api bridge." } });
        }
        const catalog = await providerManager.models(selectedProvider);
        return sendJson(res, 200, {
          object: "list",
          data: (catalog.models || []).map((id) => ({
            id,
            object: "model",
            owned_by: selectedProvider,
            type: "chat",
          })),
        });
      }

      if (url.pathname === "/v1/chat/completions") {
        if (req.method !== "POST") return sendJson(res, 405, { error: { message: "method not allowed" } });
        if (selectedProvider === "freebuff") {
          return sendJson(res, 400, { error: { message: "Freebuff uses the dedicated freebuff2api bridge." } });
        }
        const body = await readJson(req);
        const response = await providerManager.forwardChat(selectedProvider, body, { userAgent: req.headers["user-agent"] });
        if (!response.ok) {
          const details = await response.clone().text().catch(()=>"");
          log(`[provider-bridge] ${selectedProvider} chat upstream HTTP ${response.status}: ${details.slice(0,1200)}\n`);
        }
        return await writeWebResponse(res, response);
      }

      if (url.pathname === "/v1/responses") {
        if (req.method !== "POST") return sendJson(res, 405, { error: { message: "method not allowed" } });
        if (selectedProvider === "freebuff") {
          return sendJson(res, 400, { error: { message: "Freebuff uses the dedicated freebuff2api bridge." } });
        }
        const body = await readJson(req);
        const response = await adaptResponsesBody(
          body,
          (chatBody) => providerManager.forwardChat(selectedProvider, chatBody, { userAgent: req.headers["user-agent"] }),
        );
        if (!response.ok) {
          const details = await response.clone().text().catch(()=>"");
          log(`[provider-bridge] ${selectedProvider} Responses upstream HTTP ${response.status}: ${details.slice(0,1200)}\n`);
        }
        return await writeWebResponse(res, response);
      }

      return sendJson(res, 404, { error: { message: `unknown endpoint: ${url.pathname}`, type: "not_found" } });
    } catch (error) {
      log(`[provider-bridge] ${error?.stack || error}\n`);
      return sendJson(res, 502, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "provider_bridge_error",
        },
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  return {
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    provider: () => selectedProvider,
    setProvider(value) {
      selectedProvider = normalizeProviderId(value);
      return selectedProvider;
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
