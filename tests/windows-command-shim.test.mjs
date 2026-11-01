import test from "node:test";
import assert from "node:assert/strict";
import { resolveWindowsCommandShim, windowsCommandShimTarget } from "../src/windows-command-shim.mjs";

// The launcher npm writes for a package's native binary at path (relative to the launcher's folder): its opening lines, then
// the line that runs the binary with every argument. The line break and the spaces before %* can be changed.
const npmNativeLauncherText = (path, { lineBreak = "\r\n", gap = "   " } = {}) => `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\${path}"${gap}%*
`.replace(/\n/g, lineBreak);

const NATIVE_SHIM = npmNativeLauncherText("node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe");

// A launcher of a JavaScript bin: the node.exe beside the launcher when there is one, else Node from PATH, runs the script.
const SCRIPT_SHIM = `@ECHO off
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`.replace(/\n/g, "\r\n");

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

// exact: only npm's launcher for a native binary, line for line, so the binary can run without cmd.exe and end
// with the process that started it. One that sets anything up first is left to run as it is.
test("exact resolves npm's launcher of a native binary to that binary, and leaves any other launcher as it is", () => {
  const shim = "C:\\nvm4w\\nodejs\\opencode.cmd", binary = "C:\\nvm4w\\nodejs\\node_modules\\opencode-ai\\bin\\opencode.exe";
  const launcher = npmNativeLauncherText("node_modules\\opencode-ai\\bin\\opencode.exe"), options = fake({ [shim]: launcher, [binary]: "MZ" });
  assert.equal(windowsCommandShimTarget(shim, { ...options, exact: true }), binary);
  assert.equal(resolveWindowsCommandShim(shim, { ...options, exact: true }), binary);
  // A launcher with a line of its own, one with a node fallback, and one whose binary is not there stay as they are.
  const setsUp = launcher.replace("SETLOCAL\r\n", "SETLOCAL\r\nSET OPENCODE_CONFIG=%~dp0opencode.json\r\n");
  assert.equal(windowsCommandShimTarget(shim, { ...fake({ [shim]: setsUp, [binary]: "MZ" }), exact: true }), null);
  assert.equal(resolveWindowsCommandShim(shim, { ...fake({ [shim]: setsUp, [binary]: "MZ" }), exact: true }), shim);
  assert.equal(windowsCommandShimTarget(shim, { ...fake({ [shim]: SCRIPT_SHIM, [binary]: "MZ" }), exact: true }), null);
  assert.equal(windowsCommandShimTarget(shim, { ...fake({ [shim]: launcher }), exact: true }), null);
  // The lenient reading still finds the binary behind the launcher that sets something up.
  assert.equal(windowsCommandShimTarget(shim, fake({ [shim]: setsUp, [binary]: "MZ" })), binary);
});

test("exact takes npm's launcher however its lines break and however many spaces come before %*, and only as npm writes it", () => {
  const shim = "C:\\npm\\opencode.cmd", binary = "C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
  const exact = text => windowsCommandShimTarget(shim, { ...fake({ [shim]: text, [binary]: "MZ" }), exact: true });
  const path = "node_modules\\opencode-ai\\bin\\opencode.exe";
  assert.equal(exact(npmNativeLauncherText(path, { lineBreak: "\n" })), binary, "LF line breaks");
  assert.equal(exact(npmNativeLauncherText(path, { gap: " " })), binary, "one space before %*");
  // A blank line does nothing in a batch file.
  assert.equal(exact(npmNativeLauncherText(path).replace("GOTO start\r\n", "GOTO start\r\n\r\n")), binary);
  // Anything npm does not write: other arguments, a tab, text after %*, a line of another case, a missing or an extra line.
  assert.equal(exact(npmNativeLauncherText(path, { gap: " --print-logs " })), null);
  assert.equal(exact(npmNativeLauncherText(path, { gap: "\t" })), null);
  assert.equal(exact(npmNativeLauncherText(path).replace("%*", "%* --yes")), null);
  assert.equal(exact(npmNativeLauncherText(path).replace("@ECHO off", "@echo off")), null);
  assert.equal(exact(npmNativeLauncherText(path).replace("EXIT /b\r\n", "")), null);
  assert.equal(exact(npmNativeLauncherText(path) + "EXIT /b %ERRORLEVEL%\r\n"), null);
  // The program is an .exe, as written, with no other variable in its path.
  assert.equal(exact(npmNativeLauncherText("node_modules\\opencode-ai\\bin\\opencode.js")), null);
  assert.equal(exact(npmNativeLauncherText("node_modules\\opencode-ai\\bin\\opencode.EXE")), null);
  assert.equal(exact(npmNativeLauncherText("node_modules\\%PACKAGE%\\bin\\opencode.exe")), null);
  // npm writes .cmd launchers only.
  const bat = "C:\\npm\\opencode.bat";
  assert.equal(windowsCommandShimTarget(bat, { ...fake({ [bat]: npmNativeLauncherText(path), [binary]: "MZ" }), exact: true }), null);
  // The program's path is taken inside the launcher's folder, .. included.
  const outside = "C:\\tools\\opencode.exe";
  assert.equal(windowsCommandShimTarget(shim, { ...fake({ [shim]: npmNativeLauncherText("..\\tools\\opencode.exe"), [outside]: "MZ" }), exact: true }), outside);
});

test("the lenient reading takes any launcher's quoted paths in its own folder, natives first, and nothing outside the folder", () => {
  const shim = "C:\\npm\\tool.cmd";
  const read = (text, files = {}, options = {}) => windowsCommandShimTarget(shim, { ...fake({ [shim]: text, ...files }), ...options });
  // Older launchers name the folder as %~dp0, and the variable may be in either case; a .bat launcher is read the same way.
  const codex = "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
  const older = "@ECHO off\r\nnode \"%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n";
  assert.equal(read(older, { [codex]: "" }), null, "a script only for a caller that runs it");
  assert.equal(read(older, { [codex]: "" }, { allowScripts: true }), codex);
  assert.equal(read("\"%DP0%\\bin\\tool.EXE\" %*", { "C:\\npm\\bin\\tool.EXE": "MZ" }), "C:\\npm\\bin\\tool.EXE");
  const bat = "C:\\npm\\tool.bat";
  assert.equal(windowsCommandShimTarget(bat, fake({ [bat]: "\"%dp0%\\tool.exe\" %*", "C:\\npm\\tool.exe": "MZ" })), "C:\\npm\\tool.exe");
  // A native program wins over a script named before it; the script is taken when no native program is there.
  const both = "\"%dp0%\\lib\\cli.mjs\" \"%dp0%\\bin\\tool.exe\" %*";
  assert.equal(read(both, { "C:\\npm\\lib\\cli.mjs": "", "C:\\npm\\bin\\tool.exe": "MZ" }, { allowScripts: true }), "C:\\npm\\bin\\tool.exe");
  assert.equal(read(both, { "C:\\npm\\lib\\cli.mjs": "" }, { allowScripts: true }), "C:\\npm\\lib\\cli.mjs");
  // The first program that is there, in the launcher's order; .. steps out of the folder.
  const two = "\"%dp0%\\missing.exe\" || \"%~dp0\\..\\tools\\tool.exe\" %*";
  assert.equal(read(two, { "C:\\tools\\tool.exe": "MZ" }), "C:\\tools\\tool.exe");
  // A path with another variable in it is passed over, and the next one is still read.
  assert.equal(read("\"%dp0%\\%TOOL%.exe\" \"%dp0%\\tool.exe\" %*", { "C:\\npm\\tool.exe": "MZ" }), "C:\\npm\\tool.exe");
  // Neither other kinds of file nor launchers that are not npm's: an editor's "%~dp0..\Code.exe", a wrapper's
  // "%~dp0name.exe" and a program outside the folder stay with their own readers or run as they are.
  assert.equal(read("\"%dp0%\\tool.com\" \"%dp0%\\tool.ps1\" %*", { "C:\\npm\\tool.com": "", "C:\\npm\\tool.ps1": "" }, { allowScripts: true }), null);
  assert.equal(read("@echo off\r\n\"%~dp0..\\Code.exe\" %*\r\n", { "C:\\Code.exe": "MZ" }), null);
  assert.equal(read("@echo off\r\n\"%~dp0muse-bin-1.4.13.exe\" %*\r\n", { "C:\\npm\\muse-bin-1.4.13.exe": "MZ" }), null);
  const elsewhere = "C:\\Program Files\\Example Tools\\runner.exe";
  assert.equal(read("@echo off\r\n\"%ProgramFiles%\\Example Tools\\runner.exe\" \"%~dp0runner.ps1\" %*\r\n", { [elsewhere]: "MZ" }), null);
});

test("a launcher is named by an absolute path, white space around it aside, and any other command is given back as it came", () => {
  const shim = "C:\\npm\\claude.cmd", binary = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
  const options = fake({ [shim]: NATIVE_SHIM, [binary]: "MZ" });
  assert.equal(resolveWindowsCommandShim(`  ${shim}\t`, options), binary);
  assert.equal(resolveWindowsCommandShim("  claude  ", options), "claude");
  assert.equal(resolveWindowsCommandShim(undefined, options), "");
  const unc = "\\\\build\\share\\npm\\claude.cmd", uncBinary = "\\\\build\\share\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
  assert.equal(windowsCommandShimTarget(unc, fake({ [unc]: NATIVE_SHIM, [uncBinary]: "MZ" })), uncBinary);
  assert.equal(windowsCommandShimTarget("C:claude.cmd", fake({ "C:claude.cmd": NATIVE_SHIM, [binary]: "MZ" })), null, "a drive-relative path is not absolute");
});
