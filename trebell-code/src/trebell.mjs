import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { ensureCodexConfig, DEFAULT_PORT, FALLBACK_MODEL } from "./config.mjs";
import { credentialsPath, codexBin, freebuffEntrypoint, trebellHome } from "./paths.mjs";
import { chooseModel, health, isLoggedIn, listModels, logout, runLogin, startBridge } from "./freebuff.mjs";
import { runCodex } from "./codex.mjs";

export const VERSION = "0.6.0";

export function printHelp() {
  console.log(`Trebell Code ${VERSION}

Usage:
  trebell                       start Trebell Code
  trebell run [options] [-- ...]  start Trebell Code and forward args to the agent runtime
  trebell login [--force|--resume] sign in to Freebuff
  trebell signup               open Freebuff sign-up/login
  trebell logout               remove the locally stored Freebuff credential
  trebell models               list Freebuff models available to this account
  trebell doctor               check the local Trebell Code installation\n  trebell gui                  launch the Trebell Code graphical harness

Run options:
  --model <id>                 select a Freebuff model
  --port <port>                local bridge port (default 23333)
  --no-login-check             run even when no saved credential is present
  --help                       show this help

Environment:
  TREBELL_HOME                 config root (default ~/.trebell-code)
  TREBELL_MODEL                default model id
  TREBELL_CODEX_BIN            override runtime path (also useful for tests)
  TREBELL_DISABLE_PTY=1        disable terminal branding shim

Trebell Code uses the Apache-2.0 Codex runtime for agent/tool execution and the
MIT-licensed freebuff2api bridge for Freebuff model access.
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
  return { model, port, loginCheck, forwarded };
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
  const parsed = parseRunArgs(args);
  ensureCodexConfig({ port: parsed.port });

  if (parsed.loginCheck && !isLoggedIn()) {
    console.log("Trebell Code needs a Freebuff sign-in before the first run.");
    console.log("Starting sign-in now…\n");
    const loginCode = await runLogin([], { port: parsed.port });
    if (loginCode !== 0) return loginCode;
  }

  const bridge = await startBridge({ port: parsed.port });
  try {
    const selectedModel = (await chooseModel({ requested: parsed.model, port: parsed.port })) || FALLBACK_MODEL;
    console.log(`Trebell Code · model: ${selectedModel}`);
    return await runCodex({ model: selectedModel, forwarded: parsed.forwarded });
  } finally {
    await stopBridge(bridge);
  }
}

async function modelsCommand(args) {
  const parsed = parseRunArgs(args);
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

export async function doctor(env = process.env) {
  ensureCodexConfig({ env });
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
