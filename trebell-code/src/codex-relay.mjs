import { TREBELL_USER_AGENT } from "./version.mjs";
import { WebSocket, WebSocketServer } from "ws";

export async function probeCodexReady(port, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.timeout(900),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForCodexReady(port, timeoutMs = 15000, fetchImpl = fetch) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await probeCodexReady(port, fetchImpl)) return true;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return false;
}

export function attachCodexRelay(httpServer, {
  targetUrl,
  path = "/api/codex/ws",
  enabled = () => true,
  authorize = () => true,
  log = () => {},
  onClientMessage = () => {},
  onServerMessage = () => {},
} = {}) {
  const wss = new WebSocketServer({ noServer: true });
  const pairs = new Set();

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname !== path) return;
    let authorized=false;
    try { authorized=Boolean(authorize(request,url)); } catch {}
    if (!authorized) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!enabled()) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (browserSocket) => {
      const resolvedTarget=typeof targetUrl==="function"?targetUrl():targetUrl;
      const upstream = new WebSocket(resolvedTarget, {
        headers: {
          "User-Agent": TREBELL_USER_AGENT,
          "x-trebell-client": TREBELL_USER_AGENT,
        },
      });
      const queued = [];
      const pair = { browserSocket, upstream };
      pairs.add(pair);

      browserSocket.on("message", (data, isBinary) => {
        if(!isBinary)try{onClientMessage(JSON.parse(String(data)))}catch{}
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        else if (upstream.readyState === WebSocket.CONNECTING) queued.push([data, isBinary]);
      });

      upstream.on("open", () => {
        for (const [data, isBinary] of queued.splice(0)) upstream.send(data, { binary: isBinary });
      });
      upstream.on("message", (data, isBinary) => {
        if(!isBinary)try{onServerMessage(JSON.parse(String(data)))}catch{}
        if (browserSocket.readyState === WebSocket.OPEN) browserSocket.send(data, { binary: isBinary });
      });

      const closeBoth = (code = 1000, reason = "") => {
        pairs.delete(pair);
        if (browserSocket.readyState === WebSocket.OPEN || browserSocket.readyState === WebSocket.CONNECTING) {
          try { browserSocket.close(code, reason.slice(0, 120)); } catch {}
        }
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
          try { upstream.close(code, reason.slice(0, 120)); } catch {}
        }
      };

      browserSocket.on("close", () => closeBoth());
      browserSocket.on("error", (error) => {
        log(`renderer websocket error: ${error.message}`);
        closeBoth(1011, "renderer websocket error");
      });
      upstream.on("close", (code, reason) => closeBoth(code || 1011, String(reason || "codex disconnected")));
      upstream.on("error", (error) => {
        log(`codex websocket error: ${error.message}`);
        closeBoth(1011, "codex websocket unavailable");
      });
    });
  });

  return {
    close() {
      for (const pair of pairs) {
        try { pair.browserSocket.terminate(); } catch {}
        try { pair.upstream.terminate(); } catch {}
      }
      pairs.clear();
      try { wss.close(); } catch {}
    },
  };
}
