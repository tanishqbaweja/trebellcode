import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialsPath, trebellHome } from "./paths.mjs";

export const FREEBUFF_API_HOST = "https://www.codebuff.com";
export const FREEBUFF_HEARTBEAT_MS = 45_000;

export const DOCUMENTED_PRICES = Object.freeze({
  "z-ai/glm-5.3-flash": { peak: 5 },
  "mimo/mimo-v2.5": { peak: 10 },
  "deepseek/deepseek-v4-flash": { peak: 15, offPeak: 10, offPeakStartUtc: 22, offPeakEndUtc: 6 },
  "openai/gpt-5.6-luna": { peak: 20 },
  "openai/gpt-5.6-luna-es": { peak: 20 },
  "upstage/solar-pro4": { dynamic: true },
  "crof/kimi-k3-eco": { peak: 5 },
  "meta/muse-spark-1.3-contributor": { peak: 15 },
  "meta/muse-spark-1.2-contributor": { peak: 15 },
  "google/gemini-3.8-flash": { peak: 50 },
});

export function normalizeModelId(model) {
  return String(model || "").replace(/^freebuff\//, "");
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

export function loadFreebuffIdentity(env = process.env) {
  const raw = readJson(credentialsPath(env));
  const user = raw?.default;
  if (!user || typeof user.authToken !== "string" || !user.authToken) return null;
  return {
    token: user.authToken,
    user: {
      id: typeof user.id === "string" ? user.id : null,
      email: typeof user.email === "string" ? user.email : null,
      name: typeof user.name === "string" ? user.name : null,
      credits: typeof user.credits === "number" ? user.credits : null,
    },
  };
}

export function fallbackInstanceId(env = process.env) {
  const dir = trebellHome(env);
  const path = join(dir, "freebuff-instance-id");
  try {
    const existing = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
    if (existing) return existing;
  } catch {}
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  writeFileSync(path, id, { encoding: "utf8", mode: 0o600 });
  return id;
}

export function extractBalance(session) {
  const candidates = [
    session?.freebucks?.balance,
    session?.freebucks?.available,
    session?.freebucks?.total,
    session?.freebucks,
    session?.freebucksBalance,
    session?.balance,
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function numericPrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return null;
  for (const key of ["current", "price", "freebucks", "freebucksPerHour", "hourlyPrice", "amount"]) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) return value[key];
  }
  return null;
}

function serverPrice(prices, bareModel) {
  if (!prices) return null;
  if (Array.isArray(prices)) {
    const entry = prices.find((item) =>
      item && typeof item === "object" &&
      normalizeModelId(item.model || item.modelId || item.id) === bareModel
    );
    const current = numericPrice(entry);
    return current == null ? null : { current, source: "server" };
  }
  if (typeof prices === "object") {
    const direct = prices[bareModel] ?? prices[`freebuff/${bareModel}`];
    const current = numericPrice(direct);
    if (current != null) return { current, source: "server" };
  }
  return null;
}

export function priceForModel(model, prices = null, now = new Date()) {
  const bare = normalizeModelId(model);
  const live = serverPrice(prices, bare);
  if (live) return { ...live, model: bare, offPeakActive: false };

  const fallback = DOCUMENTED_PRICES[bare];
  if (!fallback) return { model: bare, current: null, source: "unknown", offPeakActive: false };
  if (fallback.dynamic) return { model: bare, current: null, dynamic: true, source: "documented-fallback", offPeakActive: false };

  const hour = now.getUTCHours();
  const offPeakActive =
    typeof fallback.offPeak === "number" &&
    (hour >= fallback.offPeakStartUtc || hour < fallback.offPeakEndUtc);
  return {
    model: bare,
    current: offPeakActive ? fallback.offPeak : fallback.peak,
    peak: fallback.peak,
    offPeak: fallback.offPeak ?? null,
    offPeakActive,
    source: "documented-fallback",
  };
}

function rateLimitForModel(session, model) {
  const bare = normalizeModelId(model);
  const all = session?.rateLimitsByModel;
  if (!all || typeof all !== "object") return null;
  return all[bare] ?? all[`freebuff/${bare}`] ?? null;
}

function safeTimezone(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format();
    return candidate;
  } catch {
    return "UTC";
  }
}

async function requestJson(url, { headers = {}, method = "GET", signal } = {}) {
  const response = await fetch(url, {
    method,
    headers,
    signal: signal ?? AbortSignal.timeout(12_000),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { ok: response.ok, status: response.status, body };
}

async function proxySnapshot(bridgePort) {
  try {
    const response = await fetch(`http://127.0.0.1:${bridgePort}/trebell/session-state`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return null;
    const body = await response.json();
    const sessions = body?.sessions && typeof body.sessions === "object" ? body.sessions : {};
    const values = Object.values(sessions);
    return values.find((item) => item?.status === "active")
      ?? values.find((item) => item?.status === "queued")
      ?? values[0]
      ?? null;
  } catch {
    return null;
  }
}

function priceMap(prices, selectedModel, now = new Date()) {
  const ids = new Set(Object.keys(DOCUMENTED_PRICES));
  if (prices && !Array.isArray(prices) && typeof prices === "object") {
    for (const id of Object.keys(prices)) ids.add(normalizeModelId(id));
  }
  if (selectedModel) ids.add(normalizeModelId(selectedModel));
  const out = {};
  for (const id of ids) out[`freebuff/${id}`] = priceForModel(id, prices, now);
  return out;
}

export async function getFreebuffOverview({
  model,
  timezone,
  heartbeat = false,
  bridgePort = 23333,
  env = process.env,
  apiHost = env.FREEBUFF_API_HOST || FREEBUFF_API_HOST,
} = {}) {
  const identity = loadFreebuffIdentity(env);
  if (!identity) return { loggedIn: false, user: null, session: null, streak: null, derived: null };

  const tz = safeTimezone(timezone);
  const proxy = await proxySnapshot(bridgePort);
  const instanceId = proxy?.instanceId || fallbackInstanceId(env);
  const selectedModel = normalizeModelId(model || proxy?.model || "");
  const commonHeaders = {
    Authorization: `Bearer ${identity.token}`,
    "x-fb-timezone": tz,
    "x-freebuff-first-tab-discount": "0",
    "x-freebuff-multi-session": "1",
    "x-freebuff-instance-id": instanceId,
    "x-trebell-client": "Trebell-Code/0.6.0",
    "User-Agent": "Trebell-Code/0.6.0",
  };

  const sessionHeaders = {
    ...commonHeaders,
    ...(heartbeat
      ? { "x-freebuff-heartbeat": "1" }
      : { "x-freebuff-include-unused-rate-limits": "1" }),
  };

  const [sessionResult, streakResult] = await Promise.all([
    requestJson(`${apiHost}/api/v1/freebuff/session`, { headers: sessionHeaders }),
    requestJson(`${apiHost}/api/v1/freebuff/streak`, {
      headers: {
        Authorization: commonHeaders.Authorization,
        "x-fb-timezone": tz,
        "x-trebell-client": commonHeaders["x-trebell-client"],
        "User-Agent": commonHeaders["User-Agent"],
      },
    }),
  ]);

  const session = sessionResult.body && typeof sessionResult.body === "object" ? sessionResult.body : {};
  const streak = streakResult.ok && streakResult.body && typeof streakResult.body === "object" ? streakResult.body : null;
  const activeModel = normalizeModelId(
    session.currentModel || session.model || session.requestedModel || proxy?.model || ""
  );
  const effectiveModel = selectedModel || activeModel;
  const selectedPrice = priceForModel(effectiveModel, session.prices);
  const balance = extractBalance(session);

  return {
    loggedIn: true,
    user: identity.user,
    instanceId,
    proxySession: proxy,
    session,
    streak,
    errors: {
      session: sessionResult.ok ? null : { status: sessionResult.status, body: sessionResult.body },
      streak: streakResult.ok ? null : { status: streakResult.status, body: streakResult.body },
    },
    derived: {
      balance,
      selectedModel: effectiveModel ? `freebuff/${effectiveModel}` : null,
      activeModel: activeModel ? `freebuff/${activeModel}` : null,
      selectedPrice,
      priceByModel: priceMap(session.prices, effectiveModel),
      rateLimit: rateLimitForModel(session, effectiveModel),
      sessionStatus: String(session.status || proxy?.status || "none"),
      admittedAt: session.admittedAt || null,
      expiresAt: session.expiresAt || proxy?.expiresAt || null,
      firstTabDiscount: session.firstTabDiscount ?? null,
      offPeakOffers: session.offPeakOffers ?? session.offPeak ?? null,
      resetTime: session.resetAt ?? session.resetTime ?? null,
      timezone: tz,
    },
  };
}
