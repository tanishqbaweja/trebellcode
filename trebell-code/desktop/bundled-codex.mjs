import { existsSync } from "node:fs";
import { join } from "node:path";

const TARGETS=Object.freeze({
  "linux:x64":{packageName:"codex-linux-x64",triple:"x86_64-unknown-linux-musl",binary:"codex"},
  "linux:arm64":{packageName:"codex-linux-arm64",triple:"aarch64-unknown-linux-musl",binary:"codex"},
  "darwin:x64":{packageName:"codex-darwin-x64",triple:"x86_64-apple-darwin",binary:"codex"},
  "darwin:arm64":{packageName:"codex-darwin-arm64",triple:"aarch64-apple-darwin",binary:"codex"},
  "win32:x64":{packageName:"codex-win32-x64",triple:"x86_64-pc-windows-msvc",binary:"codex.exe"},
  "win32:arm64":{packageName:"codex-win32-arm64",triple:"aarch64-pc-windows-msvc",binary:"codex.exe"},
});

export function bundledCodexTarget(platform=process.platform,arch=process.arch){
  return TARGETS[`${platform}:${arch}`]||null;
}

export function bundledCodexCandidates(resourcesPath,{platform=process.platform,arch=process.arch}={}){
  const target=bundledCodexTarget(platform,arch);if(!target)return [];
  const vendor=join(String(resourcesPath||""),"app.asar.unpacked","node_modules","@openai",target.packageName,"vendor",target.triple);
  return [join(vendor,"bin",target.binary),join(vendor,"codex",target.binary)];
}

export function bundledCodexPath(resourcesPath,{platform=process.platform,arch=process.arch,exists=existsSync}={}){
  const target=bundledCodexTarget(platform,arch);if(!target)throw new Error(`Unsupported packaged Codex target: ${platform} (${arch})`);
  const candidates=bundledCodexCandidates(resourcesPath,{platform,arch});return candidates.find(candidate=>exists(candidate))||candidates[0];
}

export const BUNDLED_CODEX_TARGETS=TARGETS;
