import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { DEFAULT_PORT } from "./config.mjs";
import { credentialsPath, codexBin, freebuffEntrypoint, packageRoot, trebellHome } from "./paths.mjs";
import { isLoggedIn, listModels, logout, runLogin, startBridge } from "./freebuff.mjs";
import { runCodex } from "./codex.mjs";
import { TrebellStateStore } from "./trebell-state.mjs";
import { ProviderManager, normalizeProviderId } from "./provider-manager.mjs";

export const VERSION = (()=>{try{return String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url),"utf8")).version||"0.0.0")}catch{return "0.0.0"}})();

export function printHelp() {
  console.log(`Trebell Code ${VERSION}

Usage:
  trebell                       start Trebell Code
  trebell run [options] [-- ...]  launch the real Codex harness and forward Codex args
  trebell login [--force|--resume] sign in to Freebuff
  trebell signup               open Freebuff sign-up/login
  trebell logout               remove the locally stored Freebuff credential
  trebell models [--provider <id>] list models for a Trebell Native provider
  trebell doctor               check the local Trebell Code installation\n  trebell gui                  launch the Trebell Code graphical harness

Run options:
  --model <id>                 ask Codex to use this model
  --help                       show this help

Native-provider utility options:
  --provider <id>              openai|anthropic|gemini|freebuff|agentrouter|justworker|hcnsec|vyceai
  --port <port>                local Freebuff bridge port for login/models (default 23333)

Environment:
  TREBELL_HOME                 config root (default ~/.trebell-code)
  TREBELL_CODEX_BIN            override runtime path (also useful for tests)
  TREBELL_DISABLE_PTY=1        disable terminal branding shim

The CLI run command preserves Codex's own account, config, provider and session semantics.
Trebell Native is a separate harness and calls its selected API directly in the graphical app.
`);
}

function openUrl(url) {
  const command = platform() === "win32"
    ? ["cmd", ["/c", "start", "", url]]
    : platform() === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
  child.unref();
}

export function parseRunArgs(args) {
  let model = null;
  let port = DEFAULT_PORT;
  let provider = null;
  let loginCheck = true;
  const forwarded = [];
  let passthrough = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (passthrough) {
      forwarded.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
    } else if (arg === "--model" || arg === "-m") {
      model = args[++i];
      if (!model) throw new Error(`${arg} requires a model id`);
    } else if (arg === "--provider") {
      provider = normalizeProviderId(args[++i]);
      if (!args[i]) throw new Error("--provider requires a provider id");
    } else if (arg === "--port") {
      const raw = args[++i];
      port = Number.parseInt(raw, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1-65535");
    } else if (arg === "--no-login-check") {
      loginCheck = false;
    } else {
      forwarded.push(arg);
    }
  }
  return { model, provider, port, loginCheck, forwarded };
}

async function stopBridge(bridge) {
  if (!bridge?.child) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { bridge.child.kill("SIGKILL"); } catch {}
      resolve();
    }, 1500);
    timer.unref?.();
    bridge.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try { bridge.child.kill("SIGTERM"); } catch { resolve(); }
  });
}

async function runCommand(args) {
  const legacyInferenceFlag=args.find(arg=>["--provider","--port","--no-login-check"].includes(arg)||arg.startsWith("--provider=")||arg.startsWith("--port="));
  if(legacyInferenceFlag)throw new Error(`${legacyInferenceFlag} no longer changes Codex inference. "trebell run" launches the real Codex harness; choose API providers under Trebell Native in the graphical app.`);
  const parsed = parseRunArgs(args);
  console.log(`Trebell Code · harness: Codex${parsed.model?` · model: ${parsed.model}`:""}`);
  return await runCodex({model:parsed.model,forwarded:parsed.forwarded,env:process.env});
}

async function modelsCommand(args) {
  const parsed = parseRunArgs(args);
  const state = new TrebellStateStore(process.env);
  const providers = new ProviderManager({ env: process.env });
  const provider = normalizeProviderId(parsed.provider || state.settings().modelProvider || "freebuff");
  if (provider === "freebuff") {
    if (!isLoggedIn()) throw new Error("Not logged in. Run: trebell login");
    const bridge = await startBridge({ port: parsed.port, quiet: true });
    try {
      const models = await listModels(parsed.port);
      for (const model of models) console.log(model);
      return 0;
    } finally {
      await stopBridge(bridge);
    }
  }
  if (!providers.hasKey(provider)) throw new Error(`${providers.get(provider).name} API key is not configured.`);
  const result = await providers.models(provider);
  for (const model of result.models || []) console.log(model);
  return 0;
}

export async function doctor(env = process.env) {
  const checks = [
    ["Node >= 22", Number(process.versions.node.split(".")[0]) >= 22, process.version],
    ["Trebell home", existsSync(trebellHome(env)), trebellHome(env)],
    ["Codex runtime", existsSync(codexBin(env)) || Boolean(env.TREBELL_CODEX_BIN), codexBin(env)],
    ["freebuff2api bridge", existsSync(freebuffEntrypoint()), freebuffEntrypoint()],
    ["Freebuff credential", existsSync(credentialsPath(env)), credentialsPath(env)],
  ];
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "✓" : "✗"} ${name}: ${detail}`);
  }
  const requiredOk = checks.slice(0, 4).every(([, ok]) => ok);
  return requiredOk ? 0 : 1;
}

export async function main(argv = []) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("-") ? args.shift() : "run";

  if (argv.includes("--help") || argv.includes("-h") || command === "help") {
    printHelp();
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-V")) {
    console.log(VERSION);
    return 0;
  }

  let code = 0;
  switch (command) {
    case "run":
      code = await runCommand(args);
      break;
    case "login":
      code = await runLogin(args);
      break;
    case "signup":
      console.log("Opening Freebuff sign-up/login…");
      openUrl("https://freebuff.com/login?callbackUrl=%2Fweb");
      code = 0;
      break;
    case "logout":
      logout();
      console.log("Trebell Code: local Freebuff credential removed.");
      code = 0;
      break;
    case "models":
      code = await modelsCommand(args);
      break;
    case "doctor":
      code = await doctor();
      break;
    default:
      // Preserve the familiar Codex-style ergonomics: an unknown leading token
      // is treated as a prompt/argument and forwarded to the runtime.
      code = await runCommand([command, ...args]);
      break;
  }

  if (typeof code === "number") process.exitCode = code;
  return code;
}
