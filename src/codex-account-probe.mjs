import spawn from "cross-spawn";
import { TREBELL_VERSION } from "./version.mjs";
import { signInNeeded } from "./harness-status-words.mjs";

// Codex readiness comes from a provider probe: a short-lived `codex app-server` answers `account/read`. Codex
// itself decides whether its configured model provider needs OpenAI sign-in (`requiresOpenaiAuth`), so a profile that
// runs Ollama, LM Studio, Azure or another API-key provider is ready without `codex login`.

// How long the probe may take: Trebell's own 25 s. It starts a `codex app-server`, slowest on the first start after an update, and
// the account read can refresh the sign-in over the network.
export const CODEX_ACCOUNT_PROBE_TIMEOUT_MS = 25_000;

// The name a profile's account is shown with, from the account in Codex's account/read answer (the Account and PlanType of
// the protocol Codex prints with `codex app-server generate-json-schema`).

// A plan Codex names nothing here (its own "unknown", or one a newer Codex adds) leaves the service's plain name.
function chatgptLabel({ planType }) {
  const type = String(planType);
  return Object.hasOwn(PLAN_SHOWN_AS, type) ? `ChatGPT ${PLAN_SHOWN_AS[type]}` : "ChatGPT";
}

// Each plan type Codex sends (its PlanType, codex-rs/protocol/src/account.rs in openai/codex) by the name Codex's own /status
// shows it under (codex-rs/tui/src/subscription.rs, SubscriptionDisplay::Status, at openai/codex 67f0994b). OpenAI names the
// "business" plan type Enterprise there, and Team Business.
const PLAN_SHOWN_AS = Object.freeze({
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro 200",
  prolite: "Pro 100",
  promax: "Pro 500",
  team: "Business",
  self_serve_business_usage_based: "Business",
  self_serve_business_prolite: "Business Premium",
  business: "Enterprise",
  enterprise: "Enterprise",
  ent26: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise",
  enterprise_cbp_automation: "Enterprise (Automation)",
  edu: "Edu",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
  sci: "Academic Researchers",
  sci_plus: "Academic Researchers Plus",
});

// Each kind of account Codex reports and its name. Codex signs in to OpenAI with an API key, so the key is OpenAI's.
const LABEL_BY_KIND = new Map([
  ["apiKey", () => "OpenAI API key"],
  ["amazonBedrock", () => "Amazon Bedrock"],
  ["chatgpt", chatgptLabel],
]);

// The account's name, or null with no account. A kind a newer Codex adds is shown by Codex's own name for it.
export function codexAccountLabel(account) {
  if (account === null || typeof account !== "object") return null;
  const { type } = account;
  const name = LABEL_BY_KIND.get(type);
  if (name) return name(account);
  return type ? String(type) : null;
}

// What Codex's account/read answer means for the profile. With no account, Codex's requiresOpenaiAuth says whether its model
// provider needs an OpenAI sign-in: it does, and nobody is signed in; or it does not, and the provider runs as configured (ready,
// sign-in unknown). An account is a sign-in, named by its kind and plan.
const NO_ACCOUNT = Object.freeze({
  signInNeeded: Object.freeze({ ready: false, authenticated: false, message: signInNeeded("codex") }),
  noSignInUsed: Object.freeze({ ready: true, authenticated: null, message: "Ready · this Codex model provider does not use OpenAI sign-in" }),
});
export function codexAccountStatus(response) {
  const account = response?.account;
  if (account === null || typeof account !== "object") {
    const { ready, authenticated, message } = NO_ACCOUNT[response?.requiresOpenaiAuth ? "signInNeeded" : "noSignInUsed"];
    return { ready, authenticated, authType: null, label: null, message };
  }
  const label = codexAccountLabel(account);
  return { ready: true, authenticated: true, authType: account.type || null, label, message: label ? `Signed in with ${label}` : "Signed in" };
}

// A wait in words, for an account read that did not answer: seconds from one second up, else milliseconds.
function waitInWords(ms) {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 100) / 10;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

// The Codex release its initialize answer's user agent names ("codex_cli_rs/0.162.0 (Windows 11; x86_64) trebell"): what follows
// the first slash that has text right after it, up to the next whitespace.
export function codexVersionFromUserAgent(userAgent) {
  const text = String(userAgent || "");
  for (let slash = text.indexOf("/"); slash >= 0; slash = text.indexOf("/", slash + 1)) {
    const release = text.slice(slash + 1).split(/\s/, 1)[0];
    if (release) return release;
  }
  return null;
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
      reject(new Error(`Codex stopped${code === null || code === undefined ? "" : ` with exit code ${code}`}${detail ? `: ${detail}` : ""}`));
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
      if (message.error) waiter.reject(Object.assign(new Error(message.error.message || "Codex answered with an error"), { error: message.error }));
      else waiter.resolve(message.result);
    }
  });
  let nextId = 1, awaiting = null;
  const send = message => child.stdin.write(JSON.stringify(message) + "\n");
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    awaiting = method;
    pending.set(id, { resolve, reject });
    try { send({ id, method, params }); } catch (error) { pending.delete(id); reject(error); }
  });
  const work = (async () => {
    const initialize = await request("initialize", { clientInfo: { name: "trebell-code", title: "Trebell Code", version: clientVersion }, capabilities: { experimentalApi: true } });
    send({ method: "initialized" });
    const account = await request("account/read", {});
    return { userAgent: initialize?.userAgent || null, version: codexVersionFromUserAgent(initialize?.userAgent), account };
  })();
  // Out of time, in words a person reads on the Codex row: whether Codex had started (its initialize answered) and how long it was given.
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Codex did not ${awaiting === "account/read" ? "answer" : "start"} within ${waitInWords(timeoutMs)}`)), timeoutMs); });
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
