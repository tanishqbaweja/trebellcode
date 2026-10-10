import spawn from "cross-spawn";
import { TREBELL_VERSION } from "./version.mjs";

// Codex readiness follows T3 Code's provider probe: a short-lived `codex app-server` answers `account/read`. Codex
// itself decides whether its configured model provider needs OpenAI sign-in (`requiresOpenaiAuth`), so a profile that
// runs Ollama, LM Studio, Azure or another API-key provider is ready without `codex login`.

export const CODEX_ACCOUNT_PROBE_TIMEOUT_MS = 20_000;

const PLAN_LABELS = Object.freeze({
  free: "ChatGPT Free",
  go: "ChatGPT Go",
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro 20x",
  prolite: "ChatGPT Pro 5x",
  promax: "ChatGPT Pro Max",
  team: "ChatGPT Team",
  self_serve_business_prolite: "ChatGPT Business",
  self_serve_business_usage_based: "ChatGPT Business",
  business: "ChatGPT Business",
  ent26: "ChatGPT Enterprise",
  enterprise_cbp_automation: "ChatGPT Enterprise",
  enterprise_cbp_usage_based: "ChatGPT Enterprise",
  enterprise: "ChatGPT Enterprise",
  edu: "ChatGPT Edu",
  edu_plus: "ChatGPT Edu",
  edu_pro: "ChatGPT Edu",
  unknown: "ChatGPT",
});

export function codexAccountLabel(account) {
  if (!account || typeof account !== "object") return null;
  if (account.type === "apiKey") return "OpenAI API key";
  if (account.type === "amazonBedrock") return "Amazon Bedrock";
  if (account.type === "chatgpt") return PLAN_LABELS[String(account.planType || "")] || "ChatGPT";
  return account.type ? String(account.type) : null;
}

// T3 accountProbeStatus: an account means signed in; no account plus requiresOpenaiAuth means sign-in is required;
// no account without that requirement is a provider Codex can use as configured (authentication unknown, ready).
export function codexAccountStatus(response) {
  const account = response?.account && typeof response.account === "object" ? response.account : null;
  if (account) {
    const label = codexAccountLabel(account);
    return { ready: true, authenticated: true, authType: account.type || null, label, message: label ? `Signed in with ${label}` : "Signed in" };
  }
  if (response?.requiresOpenaiAuth) {
    return { ready: false, authenticated: false, authType: null, label: null, message: "Codex CLI is not authenticated. Run codex login and try again." };
  }
  return { ready: true, authenticated: null, authType: null, label: null, message: "Ready · this Codex model provider does not use OpenAI sign-in" };
}

export function codexVersionFromUserAgent(userAgent) {
  return String(userAgent || "").match(/\/([^\s]+)/)?.[1] || null;
}

async function terminate(child, platform) {
  if (!child) return;
  if (platform === "win32" && child.pid) {
    await new Promise(resolve => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      try {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.once("exit", done);
        killer.once("error", done);
        setTimeout(done, 3000).unref?.();
      } catch { done(); }
    });
    return;
  }
  try { child.stdin?.end(); } catch {}
  try { child.kill(); } catch {}
}

// Starts `codex app-server` on stdio through `spawnAppServer(args)` (local or remote), runs initialize/initialized and
// account/read, then stops the process tree. Resolves {version, userAgent, account} or rejects with the failure.
export async function readCodexAccount({ spawnAppServer, clientVersion = TREBELL_VERSION, timeoutMs = CODEX_ACCOUNT_PROBE_TIMEOUT_MS, platform = process.platform } = {}) {
  if (typeof spawnAppServer !== "function") throw new Error("spawnAppServer is required");
  let child;
  try { child = spawnAppServer(["app-server"]); }
  catch (error) { throw Object.assign(new Error(error?.message || String(error)), { codexSpawnFailed: true }); }
  let buffer = "", stderr = "", timer = null;
  const pending = new Map();
  const failAll = error => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  const finished = new Promise((resolve, reject) => {
    child.once?.("error", error => reject(Object.assign(new Error(error?.message || String(error)), { codexSpawnFailed: true })));
    child.once?.("exit", code => {
      const detail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ").slice(0, 400);
      reject(new Error(`Codex app-server exited${code === null || code === undefined ? "" : ` with code ${code}`}${detail ? `: ${detail}` : ""}`));
    });
  });
  finished.catch(error => failAll(error));
  let exited = false;
  const exit = new Promise(resolve => {
    child.once?.("exit", () => { exited = true; resolve(); });
    child.once?.("error", () => { exited = true; resolve(); });
  });
  child.stdin?.on?.("error", () => {});
  child.stderr?.on?.("data", chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
  child.stdout?.on?.("data", chunk => {
    buffer += String(chunk);
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message?.id === undefined || message?.method) continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(Object.assign(new Error(message.error.message || "Codex app-server request failed"), { error: message.error }));
      else waiter.resolve(message.result);
    }
  });
  let nextId = 1;
  const send = message => child.stdin.write(JSON.stringify(message) + "\n");
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    try { send({ id, method, params }); } catch (error) { pending.delete(id); reject(error); }
  });
  const work = (async () => {
    const initialize = await request("initialize", { clientInfo: { name: "trebell-code", title: "Trebell Code", version: clientVersion }, capabilities: { experimentalApi: true } });
    send({ method: "initialized" });
    const account = await request("account/read", {});
    return { userAgent: initialize?.userAgent || null, version: codexVersionFromUserAgent(initialize?.userAgent), account };
  })();
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out while checking Codex app-server account status")), timeoutMs); });
  try {
    return await Promise.race([work, timeout, finished]);
  } finally {
    clearTimeout(timer);
    failAll(new Error("Codex account probe finished"));
    if (!exited) await terminate(child, platform);
    // Wait for the process to go away so its CODEX_HOME files are released before the caller moves on.
    await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 3000).unref?.())]);
  }
}
