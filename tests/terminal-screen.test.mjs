import test from "node:test";
import assert from "node:assert/strict";
import { createTerminalScreen, TERMINAL_SCROLLBACK_LINES } from "../ui/src/terminal-screen.js";

const screenOf=(...messages)=>{const screen=createTerminalScreen();for(const message of messages)screen.write(message);return screen};

test("ConPTY's moves to column 1 of a later row become line breaks, and the title and cursor sequences leave no text",()=>{
  const screen=screenOf(
    "\x1b[?9001h\x1b[?1004h",
    "\x1b[?25l\x1b[2J\x1b[m\x1b[HMicrosoft Windows [Version 10.0.26300.9550]\x1b]0;C:\\WINDOWS\\system32\\cmd.exe\x07\x1b[?25h",
    "\x1b[?25l\r\n(c) Microsoft Corporation. All rights reserved.\x1b[4;1HH:\\repo>\x1b[?25h",
    "echo hi\r\n","\x1b[?25lhi\x1b[8;1HH:\\repo>\x1b[?25h",
  );
  assert.equal(screen.text(),"Microsoft Windows [Version 10.0.26300.9550]\n(c) Microsoft Corporation. All rights reserved.\nH:\\repo>echo hi\nhi\nH:\\repo>");
});

test("a clear drops the output before it, a cursor-forward becomes spaces and a lone carriage return starts a new line",()=>{
  assert.equal(screenOf("old output\r\n","\x1b[2J\x1b[Hfresh").text(),"fresh");
  assert.equal(screenOf("a\x1b[3Cb").text(),"a   b");
  assert.equal(screenOf("10%\r20%\r","30%\r\ndone\r\n\r\nnext").text(),"10%\n20%\n30%\ndone\n\nnext");
});

test("a control sequence or a carriage return cut between two messages is finished by the next one",()=>{
  assert.equal(screenOf("red: \x1b[3","1mred\x1b","[0m done").text(),"red: red done");
  assert.equal(screenOf("before\x1b]0;a ti","tle\x07after").text(),"beforeafter");
  assert.equal(screenOf("before\x1b]0;title\x1b","\\after").text(),"beforeafter");
  assert.equal(screenOf("one\r","\ntwo").text(),"one\ntwo");
  assert.equal(screenOf("hi 7\r\x1b]0;cmd - echo hi 7\x07","\n\x1b]0;cmd\x07","\nH:\\repo>").text(),"hi 7\n\nH:\\repo>");
});

test("the screen keeps its last lines, counts the ones it dropped and cleans up with a clear",()=>{
  const screen=createTerminalScreen();
  for(let line=1;line<=12000;line++)screen.write("line "+line+"\r\n");
  screen.write("H:\\repo>");
  assert.equal(screen.lines,TERMINAL_SCROLLBACK_LINES);
  assert.equal(screen.dropped,12001-TERMINAL_SCROLLBACK_LINES);
  const text=screen.text();
  assert.ok(text.startsWith("line 7002\n"),text.slice(0,20));
  assert.ok(text.endsWith("line 12000\nH:\\repo>"));
  assert.equal(text.split("\n").length,TERMINAL_SCROLLBACK_LINES);
  assert.ok(screen.chunks.length<=Math.ceil(TERMINAL_SCROLLBACK_LINES/200)+1,"the text stays in a few chunks");
  screen.write("\x1b[2J\x1b[Hcleared");
  assert.equal(screen.text(),"cleared");assert.equal(screen.dropped,0);assert.equal(screen.lines,1);
});

test("a long run of small messages costs each message only its own text",()=>{
  const screen=createTerminalScreen(),started=performance.now();
  for(let line=1;line<=100000;line++)screen.write("line "+line+"\r\n");
  const elapsed=performance.now()-started;
  assert.equal(screen.lines,TERMINAL_SCROLLBACK_LINES);
  assert.ok(elapsed<3000,"100,000 messages took "+Math.round(elapsed)+" ms");
});

test("a snapshot replaces the screen, and the chunks only change at the end while output streams",()=>{
  const screen=createTerminalScreen();
  for(let line=1;line<=450;line++)screen.write("line "+line+"\r\n");
  const before=screen.chunks.map(chunk=>({id:chunk.id,text:chunk.text}));
  screen.write("more\r\n");
  const after=screen.chunks;
  assert.deepEqual(after.slice(0,-1).map(chunk=>({id:chunk.id,text:chunk.text})),before.slice(0,-1));
  assert.equal(after.at(-1).text,before.at(-1).text+"more\n");
  screen.reset("\x1b[2J\x1b[Hrestored\r\nH:\\repo>");
  assert.equal(screen.text(),"restored\nH:\\repo>");
});
