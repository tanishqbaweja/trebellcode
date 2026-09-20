import { existsSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { rebrandTerminalChunk } from "./branding.mjs";
import { DEFAULT_PORT } from "./config.mjs";
import { credentialsPath, freebuffConfigDir, freebuffEntrypoint } from "./paths.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function bridgeEnv({ port = DEFAULT_PORT, env = process.env } = {}) {
  return {
    ...env,
    FREEBUFF2API_CONFIG_DIR: freebuffConfigDir(env),
    PUBLIC_UPSTREAM_ENABLED: "false",
    LISTEN_ADDR: `127.0.0.1:${port}`,
    PORT: String(port),
  };
}

export function isLoggedIn(env = process.env) {
  return existsSync(credentialsPath(env));
}

export function logout(env = process.env) {
  const path = credentialsPath(env);
  if (existsSync(path)) rmSync(path, { force: true });
}

function spawnBridge(args, { port = DEFAULT_PORT, env = process.env, stdio = "pipe" } = {}) {
  return spawn(process.execPath, [
    "--experimental-strip-types",
    freebuffEntrypoint(),
    ...args,
  ], {
    env: bridgeEnv({ port, env }),
    stdio,
    windowsHide: true,
  });
}

function pipeRebranded(child) {
  child.stdout?.on("data", (chunk) => process.stdout.write(rebrandTerminalChunk(chunk)));
  child.stderr?.on("data", (chunk) => process.stderr.write(rebrandTerminalChunk(chunk)));
}

export async function runLogin(args = [], options = {}) {
  const child = spawnBridge(["login", ...args], options);
  pipeRebranded(child);
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) return reject(new Error(`login bridge exited via ${signal}`));
      resolve(code ?? 1);
    });
  });
}

export async function health(port = DEFAULT_PORT, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1200),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForHealth(port = DEFAULT_PORT, timeoutMs = 12000, fetchImpl = fetch) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await health(port, fetchImpl)) return true;
    await sleep(200);
  }
  return false;
}

export async function startBridge({ port = DEFAULT_PORT, env = process.env, quiet = false } = {}) {
  if (await health(port)) {
    return { child: null, reused: true, port };
  }

  const child = spawnBridge(["--listen-addr", `127.0.0.1:${port}`], { port, env });
  if (!quiet) pipeRebranded(child);

  let earlyFailure = null;
  child.once("error", (error) => { earlyFailure = error; });
  const ready = await waitForHealth(port);
  if (!ready) {
    try { child.kill(); } catch {}
    throw earlyFailure || new Error("Trebell Freebuff bridge did not become healthy within 12 seconds");
  }
  return { child, reused: false, port };
}

export async function listModels(port = DEFAULT_PORT, fetchImpl = fetch) {
  const response = await fetchImpl(`http://127.0.0.1:${port}/v1/models`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(`model list failed with HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`);
  }
  const body = await response.json();
  const ids = Array.isArray(body?.data)
    ? body.data.map((entry) => entry?.id).filter((id) => typeof id === "string")
    : [];
  return ids;
}

export async function chooseModel({ requested, port = DEFAULT_PORT } = {}) {
  if (requested) return requested;
  if (process.env.TREBELL_MODEL?.trim()) return process.env.TREBELL_MODEL.trim();
  try {
    const models = await listModels(port);
    return models.find((id) => id.startsWith("freebuff/")) || models[0] || null;
  } catch {
    return null;
  }
}
