import { existsSync, readFileSync } from "node:fs";
import { codexBin, trebellHome } from "./paths.mjs";
import { runCodex } from "./codex.mjs";
import { TrebellStateStore } from "./trebell-state.mjs";
import { DEFAULT_MODEL_PROVIDER, MODEL_PROVIDERS, ProviderManager, normalizeProviderId } from "./provider-manager.mjs";
import { removeRetiredProviderData } from "./legacy-provider-migration.mjs";

export const VERSION = (()=>{try{return String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url),"utf8")).version||"0.0.0")}catch{return "0.0.0"}})();

export const NO_ACCOUNT_SIGN_IN_MESSAGE = 'Trebell Code has no account sign-in of its own. Add a model provider API key in Settings → Agents & models (or set OPENAI_API_KEY), or run "codex login" to sign in to the Codex harness.';

export function printHelp() {
  console.log(`Trebell Code ${VERSION}

Usage:
  trebell                       start Trebell Code
  trebell run [options] [-- ...]  launch the real Codex harness and forward Codex args
  trebell models [--provider <id>] list models for a Trebell Native provider
  trebell doctor               check the local Trebell Code installation\n  trebell gui                  launch the Trebell Code graphical harness

Run options:
  --model <id>                 ask Codex to use this model
  --help                       show this help

Native-provider utility options:
  --provider <id>              ${Object.keys(MODEL_PROVIDERS).join("|")} (default: the selected Native provider, else ${DEFAULT_MODEL_PROVIDER})

Environment:
  TREBELL_HOME                 config root (default ~/.trebell-code)
  TREBELL_CODEX_BIN            override runtime path (also useful for tests)
  TREBELL_DISABLE_PTY=1        disable terminal branding shim

The CLI run command preserves Codex's own account, config, provider and session semantics.
Trebell Native is a separate harness and calls its selected API directly in the graphical app.
`);
}

export function parseRunArgs(args) {
  let model = null;
  let provider = null;
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
      const requested = String(args[++i] || "").trim();
      if (!requested) throw new Error("--provider requires a provider id");
      if (!Object.prototype.hasOwnProperty.call(MODEL_PROVIDERS, requested.toLowerCase())) throw new Error(`Unknown provider "${requested}". Choose one of: ${Object.keys(MODEL_PROVIDERS).join(", ")}.`);
      provider = normalizeProviderId(requested);
    } else {
      forwarded.push(arg);
    }
  }
  return { model, provider, forwarded };
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
  const provider = normalizeProviderId(parsed.provider || state.settings().modelProvider || DEFAULT_MODEL_PROVIDER);
  if (!providers.hasKey(provider)) throw new Error(`No API key is configured for ${providers.get(provider).name}. Add one in Settings → Agents & models or set ${providers.get(provider).envKey}.`);
  const result = await providers.models(provider);
  for (const model of result.models || []) console.log(model);
  return 0;
}

export async function doctor(env = process.env) {
  const checks = [
    ["Node >= 22", Number(process.versions.node.split(".")[0]) >= 22, process.version],
    ["Trebell home", existsSync(trebellHome(env)), trebellHome(env)],
    ["Codex runtime", existsSync(codexBin(env)) || Boolean(env.TREBELL_CODEX_BIN), codexBin(env)],
  ];
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "✓" : "✗"} ${name}: ${detail}`);
  }
  return checks.every(([, ok]) => ok) ? 0 : 1;
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

  // Most commands never load the app state, so remove what retired model providers left behind here too.
  removeRetiredProviderData(process.env, { log: (message) => console.error(message) });

  let code = 0;
  switch (command) {
    case "run":
      code = await runCommand(args);
      break;
    case "login":
    case "signup":
    case "logout":
      // Never fall through to the Codex pass-through: "codex logout" would sign the user out of Codex.
      console.error(NO_ACCOUNT_SIGN_IN_MESSAGE);
      code = 1;
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
