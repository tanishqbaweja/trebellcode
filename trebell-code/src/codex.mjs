import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { rebrandTerminalChunk } from "./branding.mjs";
import { codexBin, codexHome } from "./paths.mjs";
import { buildRuntimeEnvironment } from "./runtime-environment.mjs";

export function codexChildEnvironment(env = process.env) {
  return {
    ...buildRuntimeEnvironment("native",{parent:env,platform:process.platform}),
    CODEX_HOME:codexHome(env),
  };
}

export function codexArgs({ model, provider = "freebuff", forwarded = [] } = {}) {
  const base = [
    "-c", `model_provider="${provider}"`,
  ];
  if (model) base.push("-m", model);
  return [...base, ...forwarded];
}

function filterWrite(stream, chunk) {
  stream.write(rebrandTerminalChunk(chunk));
}

async function runWithPty(command, args, env) {
  const pty = await import("node-pty");
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;
  const terminal = pty.spawn(command, args, {
    name: process.env.TERM || "xterm-256color",
    cols,
    rows,
    cwd: process.cwd(),
    env,
  });

  terminal.onData((data) => filterWrite(process.stdout, data));

  const wasRaw = Boolean(process.stdin.isRaw);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
  }
  const onInput = (data) => terminal.write(data);
  process.stdin.on("data", onInput);

  const onResize = () => {
    try {
      terminal.resize(process.stdout.columns || cols, process.stdout.rows || rows);
    } catch {}
  };
  process.stdout.on("resize", onResize);

  return await new Promise((resolve) => {
    terminal.onExit(({ exitCode, signal }) => {
      process.stdin.off("data", onInput);
      process.stdout.off("resize", onResize);
      if (process.stdin.isTTY) process.stdin.setRawMode?.(wasRaw);
      resolve(signal ? 128 : exitCode);
    });
  });
}

async function runInherited(command, args, env) {
  const child = spawn(command, args, {
    env,
    cwd: process.cwd(),
    stdio: "inherit",
    windowsHide: false,
  });
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 128 : (code ?? 1)));
  });
}

export async function runCodex({ model, provider = "freebuff", forwarded = [], env = process.env } = {}) {
  const command = codexBin(env);
  if (!existsSync(command) && !env.TREBELL_CODEX_BIN) {
    throw new Error(`Codex runtime was not installed at ${command}. Run npm install in Trebell Code.`);
  }

  const args = codexArgs({ model, provider, forwarded });
  const nextEnv = codexChildEnvironment(env);

  if (process.stdin.isTTY && process.stdout.isTTY && env.TREBELL_DISABLE_PTY !== "1") {
    try {
      return await runWithPty(command, args, nextEnv);
    } catch (error) {
      console.error(`Trebell Code: PTY branding layer unavailable (${error instanceof Error ? error.message : String(error)}); continuing normally.`);
    }
  }
  return await runInherited(command, args, nextEnv);
}
