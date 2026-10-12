// A request that may have to start the thread's harness first waits as long as the server lets that start take: an ACP agent's
// initialize, session/load and session/new each have their own bound (up to 90, 90 and 180 s), and a conversation the harness
// lost starts it once more. Giving up after a minute would call a turn that did start "not sent". Opening a thread starts the
// harnesses that do not start lazily, and a rewind starts any harness that is not running yet.
const HARNESS_START_METHODS = new Set(["turn/start", "thread/start", "thread/resume", "thread/fork", "thread/compact/start", "thread/revert", "review/start", "thread/queue/start", "thread/delegate"]);
export const requestTimeoutMs = method => HARNESS_START_METHODS.has(method) ? 10 * 60_000 : 60_000;

export class CodexRpcClient {
  constructor(url, { onNotification, onServerRequest, onStatus, clientVersion = "0.0.0" } = {}) {
    this.url = url;
    this.clientVersion = clientVersion;
    this.onNotification = onNotification;
    this.onServerRequest = onServerRequest;
    this.onStatus = onStatus;
    this.notificationListeners = new Set();
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  isConnected() {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN);
  }

  async connect() {
    if (!this.url) throw new Error("No app-server websocket URL was provided");
    this.onStatus?.("connecting");
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to Codex app-server")), 12000);
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Could not connect to Codex app-server"));
      }, { once: true });
    });

    this.socket.addEventListener("message", (event) => this.#handleMessage(event.data));
    this.socket.addEventListener("close", () => {
      this.onStatus?.("disconnected");
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("App-server disconnected"));
      }
      this.pending.clear();
    });

    await this.request("initialize", {
      clientInfo: { name: "trebell-code", title: "Trebell Code", version: this.clientVersion },
      capabilities: {
        experimentalApi: true,
        mcpServerOpenaiFormElicitation: true,
        extensions: {
          "openai/form": {},
          "openai/elicitation": { form: {} },
        },
      },
    });
    this.notify("initialized", {});
    this.onStatus?.("connected");
  }

  request(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("App-server is not connected"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer=setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        const error = new Error(`${method} timed out`);
        error.rpcTimedOut = true;
        pending.reject(error);
      }, requestTimeoutMs(method));
      this.pending.set(id, { resolve, reject, timer });
      try{this.socket.send(JSON.stringify({ method, id, params }))}
      catch(error){clearTimeout(timer);this.pending.delete(id);reject(error)}
    });
  }

  notify(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ method, params }));
  }

  subscribeNotifications(listener) {
    if (typeof listener !== "function") return () => {};
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  respond(id, result) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ id, result }));
    return true;
  }

  reject(id, code = -32000, message = "Request declined") {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ id, error: { code, message } }));
  }

  close() {
    this.socket?.close();
  }

  #handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || "RPC request failed");
        error.trebellRpcResponse = true;
        error.rpcCode = message.error.code;
        error.rpcData = message.error.data;
        pending.reject(error);
      }
      else pending.resolve(message.result);
      return;
    }

    if (message.method && Object.prototype.hasOwnProperty.call(message, "id")) {
      this.onServerRequest?.(message);
      return;
    }

    if (message.method) {
      this.onNotification?.(message);
      for (const listener of [...this.notificationListeners]) {
        try { listener(message); } catch {}
      }
      try {
        if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof window.CustomEvent === "function") {
          window.dispatchEvent(new window.CustomEvent("trebell:rpc-notification", { detail: message }));
        }
      } catch {}
    }
  }
}
