import test from "node:test";
import assert from "node:assert/strict";
import { interactiveTerminalCommand } from "../src/terminal-command.mjs";

test("interactive terminal commands quote Windows shim paths without changing simple args",()=>{
  assert.equal(interactiveTerminalCommand("C:\\Program Files\\OpenCode\\opencode.cmd",["auth","login"],{platform:"win32"}),'"C:\\Program Files\\OpenCode\\opencode.cmd" auth login');
});

test("interactive terminal commands quote POSIX paths safely",()=>{
  assert.equal(interactiveTerminalCommand("/opt/My Tool/opencode",["auth","it's-me"],{platform:"linux"}),"'/opt/My Tool/opencode' 'auth' 'it'\\''s-me'");
});
