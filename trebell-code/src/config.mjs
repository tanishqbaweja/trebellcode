import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexHome, trebellHome } from "./paths.mjs";

export const DEFAULT_PORT = 23333;
export const PROVIDER_COMPAT_PORT = 23334;
export const FALLBACK_MODEL = "freebuff/deepseek/deepseek-v4-flash";

const PROVIDERS = {
  freebuff: { name: "Trebell Freebuff", baseUrl: (port) => `http://127.0.0.1:${port}/v1` },
  agentrouter: { name: "Trebell AgentRouter", baseUrl: () => `http://127.0.0.1:${PROVIDER_COMPAT_PORT}/v1` },
  justworker: { name: "Trebell JustWorker", baseUrl: () => `http://127.0.0.1:${PROVIDER_COMPAT_PORT}/v1` },
  hcnsec: { name: "Trebell HCNSec", baseUrl: () => `http://127.0.0.1:${PROVIDER_COMPAT_PORT}/v1` },
  vyceai: { name: "Trebell VyceAi", baseUrl: () => `http://127.0.0.1:${PROVIDER_COMPAT_PORT}/v1` },
};

export function codexProviderOverrides({port=DEFAULT_PORT,provider="freebuff"}={}){
  const selectedId=provider in PROVIDERS?provider:"freebuff";
  const selected=PROVIDERS[selectedId];
  return [
    "--config",`model_provider=${JSON.stringify(selectedId)}`,
    "--config",`model_providers.${selectedId}.name=${JSON.stringify(selected.name)}`,
    "--config",`model_providers.${selectedId}.base_url=${JSON.stringify(selected.baseUrl(port))}`,
    "--config",`model_providers.${selectedId}.wire_api=\"responses\"`,
    "--config",`model_providers.${selectedId}.requires_openai_auth=false`,
    "--config",`model_providers.${selectedId}.request_max_retries=2`,
    "--config",`model_providers.${selectedId}.stream_max_retries=2`,
    "--config",`model_providers.${selectedId}.stream_idle_timeout_ms=300000`,
  ];
}

export function ensureDirs(env = process.env) {
  mkdirSync(trebellHome(env), { recursive: true });
  mkdirSync(codexHome(env), { recursive: true });
}

export function codexConfigPath(env = process.env) {
  return join(codexHome(env), "config.toml");
}

export function renderCodexConfig({ port = DEFAULT_PORT, provider = "freebuff" } = {}) {
  const selectedId = provider in PROVIDERS ? provider : "freebuff";
  const selected = PROVIDERS[selectedId];
  return `# Managed by Trebell Code.
# Codex always speaks the modern Responses API. Freebuff exposes Responses
# directly through freebuff2api; chat-only providers are translated by
# Trebell's loopback compatibility bridge.

model_provider = "${selectedId}"

[model_providers.${selectedId}]
name = "${selected.name}"
base_url = "${selected.baseUrl(port)}"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 2
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
