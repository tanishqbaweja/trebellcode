import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function trebellHome(env = process.env) {
  return env.TREBELL_HOME?.trim() || join(homedir(), ".trebell-code");
}

export function codexHome(env = process.env) {
  return join(trebellHome(env), "codex");
}

export function freebuffConfigDir(env = process.env) {
  return join(trebellHome(env), "freebuff2api");
}

export function credentialsPath(env = process.env) {
  return join(freebuffConfigDir(env), "credentials.json");
}

export function freebuffEntrypoint(env = process.env) {
  if (env.TREBELL_FREEBUFF_ENTRYPOINT?.trim()) return env.TREBELL_FREEBUFF_ENTRYPOINT.trim();
  return join(packageRoot, "vendor", "freebuff2api", "src", "index.ts");
}

export function codexBin(env = process.env, platform = process.platform) {
  if (env.TREBELL_CODEX_BIN?.trim()) return env.TREBELL_CODEX_BIN.trim();
  const suffix = platform === "win32" ? ".cmd" : "";
  return join(packageRoot, "node_modules", ".bin", `codex${suffix}`);
}
