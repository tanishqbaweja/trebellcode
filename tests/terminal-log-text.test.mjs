import test from "node:test";
import assert from "node:assert/strict";

import { plainTerminalStream, plainTerminalText } from "../src/terminal-log-text.mjs";

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

test("character-set escapes, device and application strings, and doubled or stray escapes leave nothing behind and take no letter", () => {
  assert.equal(plainTerminalText("\x1b[31mERROR\x1b(B\x1b[m done"), "ERROR done");
  assert.equal(plainTerminalText("\x1b)0text \x1b#8line \x1b%Gutf"), "text line utf");
  assert.equal(plainTerminalText("a\x1bP$qm\x1b\\b a\x1b_Gf=100;AAAA\x1b\\b a\x1b^private\x07b a\x1bXstart\x1b\\b"), "ab ab ab ab");
  assert.equal(plainTerminalText("\x1b\x1b[31mERROR"), "ERROR");
  assert.equal(plainTerminalText("\x1b]0;title\x1b[0mrest"), "rest");
  assert.equal(plainTerminalText("\x1b[2 q\x1b[!p\x1b[>4;2m\x1b[38:2::255:0:0mtruecolour"), "truecolour");
  assert.equal(plainTerminalText("tab\x1b\tafter\x1b"), "tab\tafter");
});

test("text without an escape is returned as it is, and anything else as its text", () => {
  const plain = "Starting Codex app-server on ws://127.0.0.1:4500\n";
  assert.equal(plainTerminalText(plain), plain);
  assert.equal(plainTerminalText(""), "");
  assert.equal(plainTerminalText(null), "");
  assert.equal(plainTerminalText(undefined), "");
  assert.equal(plainTerminalText(42), "42");
});

test("a stream's codes and characters that a chunk's end cuts in two come out whole, wherever the cut falls", () => {
  const line = "\x1b[2m2026-10-31T09:00:00Z\x1b[0m \x1b[31mERROR\x1b[0m café see \x1b]8;;https://example.invalid/docs\x1b\\the docs\x1b]8;;\x1b\\ \x1b(Bnow\n";
  const bytes = Buffer.from(line, "utf8"), whole = plainTerminalText(line);
  assert.equal(whole, "2026-10-31T09:00:00Z ERROR café see the docs now\n");
  for (let cut = 1; cut < bytes.length; cut++) {
    const read = plainTerminalStream();
    assert.equal(read(bytes.subarray(0, cut)) + read(bytes.subarray(cut)), whole, `cut at byte ${cut}`);
  }
  const read = plainTerminalStream();
  assert.equal([...bytes].map(byte => read(Buffer.from([byte]))).join(""), whole, "one byte at a time");
});

test("a message Trebell writes itself drops a code its stream left unfinished and keeps every letter", () => {
  const read = plainTerminalStream();
  assert.equal(read(Buffer.from("done\x1b[3")), "done");
  assert.equal(read("remote app-server exited code=1 signal=null\n"), "remote app-server exited code=1 signal=null\n");
  assert.equal(read(Buffer.from("again")), "again");
});

test("a string sequence longer than 4,096 characters does not wait for its end", () => {
  const read = plainTerminalStream();
  assert.equal(read(Buffer.from(`before \x1b]8;;https://example.invalid/${"a".repeat(5000)}`)), "before ");
  assert.equal(read(Buffer.from("\x1b\\after")), "after");
});
