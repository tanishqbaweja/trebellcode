import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexHome, trebellHome } from "./paths.mjs";

export const DEFAULT_PORT = 23333;
export const FALLBACK_MODEL = "freebuff/deepseek/deepseek-v4-flash";

export function ensureDirs(env = process.env) {
  mkdirSync(trebellHome(env), { recursive: true });
  mkdirSync(codexHome(env), { recursive: true });
}

export function codexConfigPath(env = process.env) {
  return join(codexHome(env), "config.toml");
}

export function renderCodexConfig({ port = DEFAULT_PORT } = {}) {
  return `# Managed by Trebell Code.
# The agent runtime is Apache-2.0 Codex; model traffic is routed through
# the bundled freebuff2api bridge.

model_provider = "freebuff"

[model_providers.freebuff]
name = "Trebell Freebuff"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 2
stream_max_retries = 2
stream_idle_timeout_ms = 300000
`;
}

export function ensureCodexConfig({ port = DEFAULT_PORT, env = process.env } = {}) {
  ensureDirs(env);
  const path = codexConfigPath(env);
  const expected = renderCodexConfig({ port });
  if (!existsSync(path) || readFileSync(path, "utf8") !== expected) {
    writeFileSync(path, expected, { encoding: "utf8", mode: 0o600 });
  }
  return path;
}
