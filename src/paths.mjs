import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

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

export function codexBin(env = process.env, platform = process.platform, arch = process.arch) {
  if (env.TREBELL_CODEX_BIN?.trim()) return env.TREBELL_CODEX_BIN.trim();
  if (platform === "win32") {
    const packageName = arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
    const triple = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
    const vendorRoot = join(packageRoot, "node_modules", "@openai", packageName, "vendor", triple);
    const nativeCandidates = [
      join(vendorRoot, "bin", "codex.exe"),
      join(vendorRoot, "codex", "codex.exe"),
    ];
    const native = nativeCandidates.find(existsSync);
    if (native) return native;
  }
  const suffix = platform === "win32" ? ".cmd" : "";
  return join(packageRoot, "node_modules", ".bin", `codex${suffix}`);
}
