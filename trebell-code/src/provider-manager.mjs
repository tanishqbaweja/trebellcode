import { TREBELL_USER_AGENT } from "./version.mjs";
import { adaptAnthropicResponse, chatToAnthropic } from "./anthropic-chat-adapter.mjs";
import { normalizeChatTurnResponse, normalizeResponsesTurnResponse, providerTurnToChat, providerTurnToResponses } from "./provider-turn.mjs";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { trebellHome } from "./paths.mjs";
import { redactSecretText } from "./secret-redactor.mjs";

export const MODEL_PROVIDERS = Object.freeze({
  freebuff: {
    id: "freebuff",
    name: "Freebuff",
    baseUrl: null,
    wireApi: "responses",
    protocolCompatibility: ["openai-responses"],
    envKey: null,
    requiresKey: false,
  },
  agentrouter: {
    id: "agentrouter",
    name: "AgentRouter",
    baseUrl: "https://agentrouter.org/v1",
    wireApi: "responses",
    protocolCompatibility: ["openai-responses"],
    envKey: "AGENTROUTER_API_KEY",
    requiresKey: true,
  },
  justworker: {
    id: "justworker",
    name: "JustWorker.icu",
    // The endpoint supplied by the service intentionally spells the host
    // "justwoker". Keep the configured API URL exact instead of guessing.
    baseUrl: "https://api.justwoker.icu/v1",
    wireApi: "chat",
    protocolCompatibility: ["anthropic-messages"],
    envKey: "JUSTWORKER_API_KEY",
    envKeys: ["JUSTWORKER_API_KEY", "JUST_WORKER_API_KEY"],
    requiresKey: true,
    staticModels: ["claude-opus-4-8"],
  },
  hcnsec: {
    id: "hcnsec",
    name: "HCNSec.cn",
    baseUrl: "https://api.hcnsec.cn/v1",
    wireApi: "chat",
    protocolCompatibility: ["openai-chat-completions"],
    envKey: "HCNSEC_API_KEY",
    envKeys: ["HCNSEC_API_KEY", "HNSEC_API_KEY"],
    requiresKey: true,
    staticModels: ["glm-5.3"],
  },
  vyceai: {
    id: "vyceai",
    name: "VyceAi",
    baseUrl: "https://vyceai.com/v1",
    wireApi: "chat",
    protocolCompatibility: ["openai-chat-completions"],
    envKey: "VYCEAI_API_KEY",
    envKeys: ["VYCEAI_API_KEY", "VYCE_API_KEY"],
    requiresKey: true,
  },
});

export function normalizeProviderId(value) {
  const id = String(value || "freebuff").trim().toLowerCase();
  return MODEL_PROVIDERS[id] ? id : "freebuff";
}

function providerSecretsPath(env = process.env) {
  return join(trebellHome(env), "provider-secrets.json");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const AGENTROUTER_CLIENT_VERSION = "0.149.1";
const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 300_000;
function providerErrorExcerpt(value,{environment={},secret="",maxChars=1200}={}){
  const max=Math.max(120,Math.min(4000,Math.trunc(Number(maxChars)||1200))),scan=String(value??"").slice(0,Math.max(max*4,max+4096));
  return redactSecretText(scan,{environment:{...environment,TREBELL_PROVIDER_ERROR_SECRET:String(secret||"")}}).slice(0,max);
}
const AGENTROUTER_CLIENT_HEADERS = Object.freeze({
  "User-Agent": `codex_cli_rs/${AGENTROUTER_CLIENT_VERSION}`,
  originator: "codex_cli_rs",
  version: AGENTROUTER_CLIENT_VERSION,
});

function agentRouterHeaders(key, { accept = "application/json" } = {}) {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: accept,
    ...AGENTROUTER_CLIENT_HEADERS,
  };
}

function normalizeProviderKey(value) {
  let key = String(value || "")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .trim();
  if (key.length >= 2) {
    const first = key[0];
    const last = key[key.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === "`" && last === "`")) {
      key = key.slice(1, -1).trim();
    }
  }
  key = key.replace(/^Bearer\s+/i, "").trim();
  return key;
}

function providerRequestSignal(signal, timeoutMs = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export class ProviderManager {
  constructor({ env = process.env, fetchFn = fetch, requestTimeoutMs = DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS } = {}) {
    this.env = env;
    this.fetchFn = fetchFn;
    const timeoutMs = Math.trunc(Number(requestTimeoutMs));
    this.requestTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
    this.path = providerSecretsPath(env);
    mkdirSync(dirname(this.path), { recursive: true });
    this.secrets = this.#load();
  }

  #load() {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  #save() {
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.secrets, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.path);
  }

  definitions() {
    return Object.values(MODEL_PROVIDERS).map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      wireApi: provider.wireApi,
      protocolCompatibility: [...(provider.protocolCompatibility || [])],
      requiresKey: provider.requiresKey,
      hasKey: provider.requiresKey ? this.hasKey(provider.id) : true,
    }));
  }

  get(providerId) {
    return MODEL_PROVIDERS[normalizeProviderId(providerId)];
  }

  key(providerId) {
    const provider = this.get(providerId);
    if (!provider.requiresKey) return "";
    const envValue = (provider.envKeys || [provider.envKey]).map(key => this.env[key]).find(Boolean);
    return normalizeProviderKey(this.secrets[provider.id] || envValue || "");
  }

  hasKey(providerId) {
    return Boolean(this.key(providerId));
  }

  setKey(providerId, value) {
    const provider = this.get(providerId);
    if (!provider.requiresKey) throw new Error(`${provider.name} does not use an API key here.`);
    const key = normalizeProviderKey(value);
    if (key) this.secrets[provider.id] = key;
    else delete this.secrets[provider.id];
    this.#save();
    return { provider: provider.id, hasKey: Boolean(key) };
  }

  childEnv(providerId, baseEnv = this.env) {
    const provider = this.get(providerId);
    const next = { ...baseEnv };
    if (provider.requiresKey) {
      const key = this.key(provider.id);
      if (key) next[provider.envKey] = key;
      else delete next[provider.envKey];
    }
    return next;
  }

  status(providerId) {
    const provider = this.get(providerId);
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      wireApi: provider.wireApi,
      protocolCompatibility: [...(provider.protocolCompatibility || [])],
      requiresKey: provider.requiresKey,
      hasKey: provider.requiresKey ? this.hasKey(provider.id) : true,
      ready: provider.requiresKey ? this.hasKey(provider.id) : true,
    };
  }

  async models(providerId) {
    const provider = this.get(providerId);
    if (provider.id === "freebuff") return { models: [], source: "freebuff" };
    if (provider.staticModels) {
      return {
        models: [...provider.staticModels],
        source: "static",
        metadata: provider.staticModels.map((id) => ({ id, provider: provider.id, protocolCompatibility: [...(provider.protocolCompatibility || [])] })),
        ...(provider.requiresKey && !this.hasKey(provider.id) ? { error: "API key required" } : {}),
      };
    }
    if (provider.requiresKey && !this.hasKey(provider.id)) {
      return { models: [], source: "none", error: "API key required" };
    }

    const key = this.key(provider.id);
    const response = await this.fetchFn(provider.baseUrl + "/models", {
      headers: provider.id === "agentrouter"
        ? agentRouterHeaders(key)
        : {
            Authorization: `Bearer ${key}`,
            Accept: "application/json",
          },
      signal: AbortSignal.timeout(12_000),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`${provider.name} model list failed with HTTP ${response.status}: ${providerErrorExcerpt(raw,{environment:this.env,secret:key,maxChars:500})}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${provider.name} returned invalid JSON from /models`);
    }
    const rows = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : [];
    const models = [...new Set(rows.map((item) => typeof item === "string" ? item : item?.id).filter(Boolean).map(String))].sort();
    return {
      models,
      source: "live",
      metadata: rows
        .filter((item) => item && typeof item === "object" && item.id)
        .map((item) => {
          const metadata={ ...clone(item), id: String(item.id), provider: provider.id };
          if(metadata.protocolCompatibility==null)metadata.protocolCompatibility=[...(provider.protocolCompatibility||[])];
          return metadata;
        }),
    };
  }

  async forwardChat(providerId, chatBody, { signal, userAgent } = {}) {
    const provider = this.get(providerId);
    if (provider.id === "freebuff") throw new Error("Freebuff chat is handled by the local freebuff2api bridge.");
    const key = this.key(provider.id);
    if (!key) throw new Error(`${provider.name} API key is not configured.`);
    if (provider.id === "justworker") {
      const anthropicBody = chatToAnthropic(chatBody);
      const upstream = await this.fetchFn(provider.baseUrl + "/messages", {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
          "Accept": anthropicBody.stream ? "text/event-stream, application/json" : "application/json",
          "User-Agent": TREBELL_USER_AGENT,
        },
        body: JSON.stringify(anthropicBody),
        signal: providerRequestSignal(signal, this.requestTimeoutMs),
      });
      return await adaptAnthropicResponse(upstream, { stream: anthropicBody.stream, model: chatBody.model });
    }

    const headers = provider.id === "agentrouter"
      ? agentRouterHeaders(key, {
          accept: chatBody.stream ? "text/event-stream, application/json" : "application/json",
        })
      : {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Accept": chatBody.stream ? "text/event-stream, application/json" : "application/json",
          "User-Agent": TREBELL_USER_AGENT,
        };

    return await this.fetchFn(provider.baseUrl + "/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(chatBody),
      signal: providerRequestSignal(signal, this.requestTimeoutMs),
    });
  }

  async forwardResponses(providerId, responsesBody, { signal } = {}) {
    const provider = this.get(providerId);
    if (provider.id !== "agentrouter") {
      throw new Error(`${provider.name} does not use direct Responses forwarding.`);
    }
    const key = this.key(provider.id);
    if (!key) throw new Error(`${provider.name} API key is not configured.`);
    const stream = Boolean(responsesBody?.stream);
    return await this.fetchFn(provider.baseUrl + "/responses", {
      method: "POST",
      headers: agentRouterHeaders(key, {
        accept: stream ? "text/event-stream, application/json" : "application/json",
      }),
      body: JSON.stringify(responsesBody),
      signal: providerRequestSignal(signal, this.requestTimeoutMs),
    });
  }

  async turn(providerId, request={}, { signal } = {}) {
    const provider=this.get(providerId),model=String(request.model||"").trim();
    if(!model)throw new Error("Provider turn requires a model.");
    if(provider.id==="freebuff")throw new Error("Freebuff provider turns are served by the local Freebuff bridge, not ProviderManager.");
    const upstream=provider.wireApi==="responses"
      ?await this.forwardResponses(provider.id,providerTurnToResponses({...request,model}),{signal})
      :await this.forwardChat(provider.id,providerTurnToChat({...request,model}),{signal});
    const raw=await upstream.text();
    if(!upstream.ok){
      const error=new Error(`${provider.name} HTTP ${upstream.status}: ${providerErrorExcerpt(raw,{environment:this.env,secret:this.key(provider.id),maxChars:1200})}`);
      error.status=upstream.status;
      error.retryable=[408,409,425,429].includes(upstream.status)||(upstream.status>=500&&upstream.status<=599);
      throw error;
    }
    let parsed;try{parsed=raw?JSON.parse(raw):{}}catch{throw new Error(`${provider.name} returned invalid JSON for a provider turn.`)}
    return provider.wireApi==="responses"
      ?normalizeResponsesTurnResponse(parsed,provider.id,model)
      :normalizeChatTurnResponse(parsed,provider.id,model);
  }

  async directChat(providerId, { model, prompt }) {
    const provider = this.get(providerId);
    const response = await this.forwardChat(provider.id, {
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`${provider.name} HTTP ${response.status}: ${providerErrorExcerpt(raw,{environment:this.env,secret:this.key(provider.id),maxChars:1200})}`);
    const parsed = JSON.parse(raw);
    return {
      text: parsed?.choices?.[0]?.message?.content ?? "",
      model,
      provider: provider.id,
      raw: parsed,
    };
  }
}
