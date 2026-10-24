import test from "node:test";
import assert from "node:assert/strict";
import { fileTimeMs, listWindowsProcesses, processTree, treeLeft } from "../src/windows-process-tree.mjs";

// A terminal's end on Windows lists its shell's process tree, closes its console and, after a grace period, ends what of the tree
// still runs. Windows reuses a process's pid once it has gone, so a pid alone can name a later process that is none of the tree's:
// each process is the pid with its creation time. Times here are FILETIMEs (100 ns steps since 1601); t(ms) is one at ms since 1970.
const t=ms=>BigInt(ms)*10000n+116444736000000000n;
const row=(pid,ppid,ms)=>({pid,ppid,created:t(ms)});

test("a FILETIME reads as ms since 1970",()=>{
  assert.equal(fileTimeMs(t(1_700_000_000_123)),1_700_000_000_123);
});

test("a shell's process tree holds what it started and what those started, and no older process that names a reused pid as its parent",()=>{
  const rows=[
    row(100,4,1000),        // the shell
    row(200,100,1100),      // its program
    row(300,200,1200),      // a program that one started
    row(400,100,900),       // older than the shell: its parent was an earlier process that had pid 100
    row(500,400,950),       // and that one's
    row(600,7,1150),        // another process
  ];
  assert.deepEqual(processTree(rows,{pid:100,from:990,to:1010}).map(item=>item.pid),[100,200,300]);
  assert.deepEqual(processTree(rows,{pid:100,from:1500,to:1600}),[],"a process created outside the terminal's start is not its shell");
  assert.deepEqual(processTree(rows,{pid:999}),[],"no tree when the shell is not running");
});

test("what is left of a tree is what of it still runs and what it started since, never a later process that got one of its pids",()=>{
  const tree=[row(100,4,1000),row(200,100,1100),row(300,200,1200)];
  const later=[
    row(200,100,1100),      // the program, still running: left
    row(300,9,5000),        // a later process that got the pid of the one that has gone: not left
    row(310,300,5100),      // started by that later process: not left
    row(320,300,1300),      // started by the tree's 300 before it went: left
    row(330,320,1400),      // and what that one started: left
    row(210,200,1250),      // started since by the program: left
    row(100,8,6000),        // a later process with the shell's pid: not left
    row(110,100,6100),      // started by it: not left
    row(120,100,1050),      // started by the shell while it ran: left
  ];
  assert.deepEqual(treeLeft(tree,later).map(item=>item.pid).sort((a,b)=>a-b),[120,200,210,320,330]);
  assert.deepEqual(treeLeft([],later),[],"an empty tree leaves nothing");
});

test("the process listing names this process with its parent",{skip:process.platform!=="win32"&&"Windows only",timeout:60_000},async()=>{
  const rows=await listWindowsProcesses({timeoutMs:30_000});
  const self=rows.find(item=>item.pid===process.pid);
  assert.ok(self,"this process is listed");assert.equal(self.ppid,process.ppid);
  assert.ok(Math.abs(fileTimeMs(self.created)-(Date.now()-process.uptime()*1000))<10_000,"with its creation time");
});
