import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { trebellHome } from "./paths.mjs";

export const MODEL_PROVIDERS = Object.freeze({
  freebuff: {
    id: "freebuff",
    name: "Freebuff",
    baseUrl: null,
    wireApi: "responses",
    envKey: null,
    requiresKey: false,
  },
  agentrouter: {
    id: "agentrouter",
    name: "AgentRouter",
    baseUrl: "https://co.agentrouter.org/v1",
    wireApi: "chat",
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
    envKey: "JUSTWORKER_API_KEY",
    requiresKey: true,
    staticModels: ["claude-opus-4-8"],
  },
  hcnsec: {
    id: "hcnsec",
    name: "HCNSec.cn",
    baseUrl: "https://api.hcnsec.cn/v1",
    wireApi: "chat",
    envKey: "HCNSEC_API_KEY",
    requiresKey: true,
    staticModels: ["glm-5.3"],
  },
  vyceai: {
    id: "vyceai",
    name: "VyceAi",
    baseUrl: "https://vyceai.com/v1",
    wireApi: "chat",
    envKey: "VYCEAI_API_KEY",
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

export class ProviderManager {
  constructor({ env = process.env, fetchFn = fetch } = {}) {
    this.env = env;
    this.fetchFn = fetchFn;
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
    return String(this.secrets[provider.id] || this.env[provider.envKey] || "").trim();
  }

  hasKey(providerId) {
    return Boolean(this.key(providerId));
  }

  setKey(providerId, value) {
    const provider = this.get(providerId);
    if (!provider.requiresKey) throw new Error(`${provider.name} does not use an API key here.`);
    const key = String(value || "").trim();
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
      requiresKey: provider.requiresKey,
      hasKey: provider.requiresKey ? this.hasKey(provider.id) : true,
      ready: provider.requiresKey ? this.hasKey(provider.id) : true,
    };
  }

  async models(providerId) {
    const provider = this.get(providerId);
    if (provider.id === "freebuff") return { models: [], source: "freebuff" };
    if (provider.requiresKey && !this.hasKey(provider.id)) {
      return { models: [], source: "none", error: "API key required" };
    }
    if (provider.staticModels) {
      return {
        models: [...provider.staticModels],
        source: "static",
        metadata: provider.staticModels.map((id) => ({ id, provider: provider.id })),
      };
    }

    const response = await this.fetchFn(provider.baseUrl + "/models", {
      headers: {
        Authorization: `Bearer ${this.key(provider.id)}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(12_000),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`${provider.name} model list failed with HTTP ${response.status}: ${raw.slice(0, 500)}`);
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
        .map((item) => ({ ...clone(item), id: String(item.id), provider: provider.id })),
    };
  }

  async directChat(providerId, { model, prompt }) {
    const provider = this.get(providerId);
    if (provider.id === "freebuff") throw new Error("Freebuff direct chat is handled by the local bridge.");
    const key = this.key(provider.id);
    if (!key) throw new Error(`${provider.name} API key is not configured.`);
    const response = await this.fetchFn(provider.baseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
      signal: AbortSignal.timeout(300_000),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`${provider.name} HTTP ${response.status}: ${raw.slice(0, 1200)}`);
    const parsed = JSON.parse(raw);
    return {
      text: parsed?.choices?.[0]?.message?.content ?? "",
      model,
      provider: provider.id,
      raw: parsed,
    };
  }
}
