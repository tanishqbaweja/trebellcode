import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexHome, trebellHome } from "./paths.mjs";

export const DEFAULT_PORT = 23333;
export const FALLBACK_MODEL = "freebuff/deepseek/deepseek-v4-flash";

const PROVIDERS = {
  freebuff: { name: "Trebell Freebuff", baseUrl: (port) => `http://127.0.0.1:${port}/v1`, wireApi: "responses", envKey: null },
  agentrouter: { name: "AgentRouter", baseUrl: () => "https://co.agentrouter.org/v1", wireApi: "chat", envKey: "AGENTROUTER_API_KEY" },
  justworker: { name: "JustWorker.icu", baseUrl: () => "https://api.justwoker.icu/v1", wireApi: "chat", envKey: "JUSTWORKER_API_KEY" },
  hcnsec: { name: "HCNSec.cn", baseUrl: () => "https://api.hcnsec.cn/v1", wireApi: "chat", envKey: "HCNSEC_API_KEY" },
  vyceai: { name: "VyceAi", baseUrl: () => "https://vyceai.com/v1", wireApi: "chat", envKey: "VYCEAI_API_KEY" },
};

export function ensureDirs(env = process.env) {
  mkdirSync(trebellHome(env), { recursive: true });
  mkdirSync(codexHome(env), { recursive: true });
}

export function codexConfigPath(env = process.env) {
  return join(codexHome(env), "config.toml");
}

export function renderCodexConfig({ port = DEFAULT_PORT, provider = "freebuff" } = {}) {
  const selected = PROVIDERS[provider] || PROVIDERS.freebuff;
  const envKey = selected.envKey ? `env_key = "${selected.envKey}"\n` : "";
  const authLine = provider === "freebuff" ? "requires_openai_auth = false\n" : "";
  return `# Managed by Trebell Code.
# Codex is the local agent harness. The selected inference provider is
# configured below and can be changed from Trebell Settings.

model_provider = "${provider in PROVIDERS ? provider : "freebuff"}"

[model_providers.${provider in PROVIDERS ? provider : "freebuff"}]
name = "${selected.name}"
base_url = "${selected.baseUrl(port)}"
${envKey}wire_api = "${selected.wireApi}"
${authLine}request_max_retries = 2
stream_max_retries = 2
stream_idle_timeout_ms = 300000
`;
}

export function ensureCodexConfig({ port = DEFAULT_PORT, provider = "freebuff", env = process.env } = {}) {
  ensureDirs(env);
  const path = codexConfigPath(env);
  const expected = renderCodexConfig({ port, provider });
  if (!existsSync(path) || readFileSync(path, "utf8") !== expected) {
    writeFileSync(path, expected, { encoding: "utf8", mode: 0o600 });
  }
  return path;
}
