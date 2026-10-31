import test from "node:test";
import assert from "node:assert/strict";

import { plainTerminalText } from "../src/terminal-log-text.mjs";

test("a coloured log line reads as plain text in the Diagnostics runtime log", () => {
  assert.equal(plainTerminalText("\x1b[31mERROR\x1b[0m codex_core: stream disconnected\n"), "ERROR codex_core: stream disconnected\n");
  assert.equal(plainTerminalText("\x1b[2m2026-10-31T09:00:00Z\x1b[0m \x1b[32m INFO\x1b[0m \x1b[1;38;5;208mready\x1b[22m"), "2026-10-31T09:00:00Z  INFO ready");
});

test("cursor moves, erases, window titles, hyperlinks and two-byte escapes are dropped; the text and its breaks are kept", () => {
  assert.equal(plainTerminalText("\x1b[2K\x1b[1Gdownloading\x1b[?25l 40%\r\n"), "downloading 40%\r\n");
  assert.equal(plainTerminalText("\x1b]0;codex\x07title set\tdone"), "title set\tdone");
  assert.equal(plainTerminalText("see \x1b]8;;https://example.invalid\x1b\\the docs\x1b]8;;\x1b\\ now"), "see the docs now");
  assert.equal(plainTerminalText("\x1b7saved\x1b8 \x1b=keypad\x1b> \x1bcreset"), "saved keypad reset");
  assert.equal(plainTerminalText("cut off \x1b]0;never closed"), "cut off ");
});

test("text without an escape is returned as it is, and anything else as its text", () => {
  const plain = "Starting Codex app-server on ws://127.0.0.1:4500\n";
  assert.equal(plainTerminalText(plain), plain);
  assert.equal(plainTerminalText(""), "");
  assert.equal(plainTerminalText(null), "");
  assert.equal(plainTerminalText(undefined), "");
  assert.equal(plainTerminalText(42), "42");
});
