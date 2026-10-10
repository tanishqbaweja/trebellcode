import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

export const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function trebellHome(env = process.env) {
  return env.TREBELL_HOME?.trim() || join(homedir(), ".trebell-code");
}

export function codexHome(env = process.env) {
  return join(trebellHome(env), "codex");
}

function environmentValue(env, name) {
  const key = Object.keys(env || {}).find(item => item.toUpperCase() === name);
  return key ? String(env[key] ?? "") : "";
}

// The native executable npm installs behind its `codex` launcher. Older Codex packages used vendor/<triple>/codex/.
function npmCodexNativeCandidates(prefix, arch) {
  const packageName = arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
  const triple = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const roots = [
    win32.join(prefix, "node_modules", "@openai", "codex", "node_modules", "@openai", packageName, "vendor", triple),
    win32.join(prefix, "node_modules", "@openai", packageName, "vendor", triple),
  ];
  return roots.flatMap(root => [win32.join(root, "bin", "codex.exe"), win32.join(root, "codex", "codex.exe")]);
}

// A PATH entry inside Trebell's own node_modules (npm scripts put node_modules/.bin first) is a package Trebell depends
// on, never the user's Codex.
function insideOwnPackages(entry, platform, root) {
  const path = platform === "win32" ? win32 : posix;
  const fold = value => platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const own = fold(path.join(root, "node_modules"));
  const candidate = fold(entry);
  return candidate === own || candidate.startsWith(own + path.sep);
}

// Codex runs from the user's own installed CLI, like T3 Code's default `codex` binary path: the first `codex` on PATH
// (on Windows the native executable behind npm's launcher, which Node can spawn without a shell), then npm's global
// prefix when a desktop launch has a stale PATH. TREBELL_CODEX_BIN overrides for tests and custom builds. When nothing is
// installed the bare command name is returned, so spawning it reports that Codex is not installed.
export function codexBin(env = process.env, platform = process.platform, arch = process.arch, { exists = existsSync, root = packageRoot } = {}) {
  if (env.TREBELL_CODEX_BIN?.trim()) return env.TREBELL_CODEX_BIN.trim();
  const separator = platform === "win32" ? ";" : ":";
  const entries = [...new Set(environmentValue(env, "PATH").split(separator).map(entry => entry.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean))]
    .filter(entry => !insideOwnPackages(entry, platform, root));
  if (platform !== "win32") {
    for (const entry of entries) {
      const candidate = posix.join(entry, "codex");
      if (exists(candidate)) return candidate;
    }
    return "codex";
  }
  const appData = environmentValue(env, "APPDATA").trim();
  for (const entry of entries) {
    const executable = win32.join(entry, "codex.exe");
    if (exists(executable)) return executable;
    const launcher = ["codex.cmd", "codex.bat"].map(name => win32.join(entry, name)).find(candidate => exists(candidate));
    if (launcher) return npmCodexNativeCandidates(entry, arch).find(candidate => exists(candidate)) || launcher;
  }
  if (appData) {
    const prefix = win32.join(appData, "npm");
    const native = npmCodexNativeCandidates(prefix, arch).find(candidate => exists(candidate));
    if (native) return native;
    const launcher = win32.join(prefix, "codex.cmd");
    if (exists(launcher)) return launcher;
  }
  return "codex";
}
