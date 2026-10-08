import test from "node:test";
import assert from "node:assert/strict";
import { resolveWindowsCommandShim, windowsCommandShimTarget } from "../src/windows-command-shim.mjs";

const NATIVE_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*",
  "",
].join("\r\n");

const SCRIPT_SHIM = [
  "@ECHO off",
  "SETLOCAL",
  "CALL :find_dp0",
  "IF EXIST \"%dp0%\\node.exe\" (",
  "  SET \"_prog=%dp0%\\node.exe\"",
  ") ELSE (",
  "  SET \"_prog=node\"",
  ")",
  "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*",
  "",
].join("\r\n");

const fake = (files) => ({
  platform: "win32",
  read: path => { if (!(path in files)) throw new Error("ENOENT " + path); return files[path]; },
  exists: path => path in files,
});

test("an npm shim that forwards to a native executable resolves to that executable", () => {
  const shim = "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd";
  const binary = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
  const options = fake({ [shim]: NATIVE_SHIM, [binary]: "MZ" });
  assert.equal(windowsCommandShimTarget(shim, options), binary);
  assert.equal(resolveWindowsCommandShim(shim, options), binary);
});

test("script shims resolve only when the caller can run the script itself, and node.exe is never chosen", () => {
  const shim = "C:\\npm\\claude.cmd";
  const script = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
  const options = fake({ [shim]: SCRIPT_SHIM, [script]: "#!/usr/bin/env node", "C:\\npm\\node.exe": "MZ" });
  assert.equal(windowsCommandShimTarget(shim, options), null);
  assert.equal(resolveWindowsCommandShim(shim, options), shim);
  assert.equal(windowsCommandShimTarget(shim, { ...options, allowScripts: true }), script);
});

test("shim resolution leaves other commands untouched", () => {
  const shim = "C:\\npm\\claude.cmd";
  const options = fake({ [shim]: NATIVE_SHIM });
  // Missing target: keep the configured command so the failure names what the user configured.
  assert.equal(resolveWindowsCommandShim(shim, options), shim);
  assert.equal(resolveWindowsCommandShim("claude", options), "claude");
  assert.equal(resolveWindowsCommandShim("C:\\tools\\claude.exe", options), "C:\\tools\\claude.exe");
  assert.equal(resolveWindowsCommandShim(shim, { ...options, platform: "linux" }), shim);
  assert.equal(resolveWindowsCommandShim("relative\\claude.cmd", options), "relative\\claude.cmd");
  assert.equal(resolveWindowsCommandShim("C:\\npm\\unreadable.cmd", options), "C:\\npm\\unreadable.cmd");
});
