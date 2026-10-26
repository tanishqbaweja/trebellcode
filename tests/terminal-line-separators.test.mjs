// The terminal worker and its manager talk in JSON lines too, split on "\n" alone (ndjson-lines.mjs): a program's output that holds
// U+2028 or U+2029, which JSON.stringify leaves raw, reaches the terminal whole, and a line typed into a terminal with one reaches its
// program, where readline split the message into pieces that are not JSON: the output was lost, and the input went nowhere while its
// write waited 15 s for an answer that never came.
import test from "node:test";
import assert from "node:assert/strict";
import { TerminalManager } from "../src/terminal-manager.mjs";

const LS=String.fromCharCode(0x2028),PS=String.fromCharCode(0x2029);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const within=(promise,ms,what)=>Promise.race([promise,sleep(ms).then(()=>{throw new Error(what+" never came")})]);
async function until(check,ms,what){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await sleep(25)}throw new Error(what+" never came")}
// A terminal's screen text without the pseudo-console's control sequences.
const screenText=buffer=>buffer.replace(/\x1b\][^\x07]*\x07/g,"").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g,"");

test("a program's output holding U+2028 or U+2029 reaches its terminal whole",{timeout:60000},async()=>{
  const terminals=new TerminalManager({persist:false});
  try{
    const marker="separators-"+Date.now();
    const source=`const LS=String.fromCharCode(0x2028),PS=String.fromCharCode(0x2029);process.stdout.write("before"+LS+"between"+PS+"after-${marker}\\n")`;
    const session=await terminals.create({cwd:process.cwd(),shell:process.execPath,args:["-e",source],name:"Line separators"});
    assert.equal((await terminals.waitForExit(session.id,{timeoutMs:20000})).exitCode,0);
    const screen=screenText(terminals.snapshot(session.id).buffer);
    assert.ok(screen.includes(`before${LS}between${PS}after-${marker}`),`the output arrives whole: ${JSON.stringify(screen.slice(-200))}`);
  }finally{await terminals.shutdown()}
});

test("a line typed into a terminal holding U+2028 or U+2029 reaches its program, and the write answers",{timeout:60000},async()=>{
  const terminals=new TerminalManager({persist:false});
  try{
    // The program reads its keys raw and, at Enter, prints the code points it got.
    const source="process.stdin.setRawMode(true);let got='';process.stdout.write('READY\\n');process.stdin.on('data',data=>{got+=String(data);if(got.includes('\\r')){process.stdout.write('GOT:'+[...got].map(c=>c.codePointAt(0).toString(16)).join(',')+'\\n');process.exit(0)}})";
    const session=await terminals.create({cwd:process.cwd(),shell:process.execPath,args:["-e",source],name:"Typed separators"});
    await until(()=>terminals.snapshot(session.id).buffer.includes("READY"),20000,"the program's READY");
    await within(terminals.write(session.id,`a${LS}b${PS}c\r`),10000,"the answer to the write");
    assert.equal((await terminals.waitForExit(session.id,{timeoutMs:20000})).exitCode,0);
    assert.match(screenText(terminals.snapshot(session.id).buffer),/GOT:61,2028,62,2029,63,d/);
  }finally{await terminals.shutdown()}
});
