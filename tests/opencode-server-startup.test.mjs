import test,{ mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOpenCodeServer } from "../src/opencode-agent-session.mjs";

// Starting `opencode serve`, as every OpenCode thread, status check, model list and Git text does. Every server shares OpenCode's
// database (opencode.db), and one that finds it locked by another exits with SQLITE_BUSY, or, on the database's first run, with the
// CREATE statement another server ran first. The stand-in below runs as `node serve --hostname=... --port=N` from the test's folder:
// it counts its launches and records each port in FAKE_ATTEMPTS, and fails as FAKE_MODE says before it listens.
const FAKE_SERVE=String.raw`
const {appendFileSync,existsSync,readFileSync,writeFileSync,writeSync}=require("node:fs");
const {createServer}=require("node:http");
const {spawn}=require("node:child_process");
const file=process.env.FAKE_ATTEMPTS,mode=process.env.FAKE_MODE||"listen",port=Number((process.argv.find(arg=>arg.startsWith("--port="))||"").slice(7));
const attempt=(existsSync(file)?readFileSync(file,"utf8").split("\n").filter(Boolean).length:0)+1;appendFileSync(file,port+"\n");
// A process the server started that inherited its pipes, as OpenCode's own children can: it writes late, or holds them open.
const descendant=script=>{const child=spawn(process.execPath,["-e",script],{detached:true,windowsHide:true,stdio:["ignore","inherit","inherit"]});writeFileSync(file+".descendant",String(child.pid));child.unref()};
const locked=mode==="permanent"||(mode==="transient"&&attempt<3);
if(locked){writeSync(2,"SQLiteError: database is locked (SQLITE_BUSY)\n");process.exit(1)}
// What OpenCode 2.0.24 and 1.18.32 print when another server's first run created a table of the new database first (seen live).
const tick=String.fromCharCode(96),esc=String.fromCharCode(27);
if(mode==="schema"&&attempt===1){writeSync(2,"EffectDrizzleQueryError: Failed query: \n        CREATE TABLE "+tick+"account_state"+tick+" (\n          "+tick+"id"+tick+" integer PRIMARY KEY\n        );\n      \nparams: \n  [cause]: Error: Cause([Fail(effect/sql/SqlError: Failed to execute statement (cause: SQLiteError: table "+tick+"account_state"+tick+" already exists))])\n");process.exit(1)}
if(mode==="schema"&&attempt===2){writeSync(2,esc+"[91m"+esc+"[1mError: "+esc+"[0mUnexpected error\r\n\r\nFailed query: \n        CREATE TABLE "+tick+"workspace"+tick+" (\n          "+tick+"id"+tick+" text PRIMARY KEY\n        );\n      \nparams: \r\n");process.exit(1)}
if(mode==="configuration"){writeSync(2,"Invalid configuration\n");process.exit(1)}
if(mode==="unrelated"){writeSync(1,"note: database is locked was seen earlier\n");writeSync(2,"Invalid configuration\n");process.exit(1)}
if(mode==="late"){descendant("setTimeout(()=>{process.stderr.write('Error: opencode.json is not valid JSON\\n')},150)");process.exit(1)}
if(mode==="held"){descendant("setTimeout(()=>{},20000)");writeSync(2,"Invalid configuration\n");process.exit(1)}
if(mode==="slow"){const go=file+".go";writeFileSync(file+".started","1");const wait=setInterval(()=>{if(existsSync(go)){clearInterval(wait);listen()}},20)}
else if(mode==="silent")writeFileSync(file+".started","1"),setInterval(()=>{},1<<30);
else listen();
function listen(){const server=createServer((req,res)=>res.end("ok"));server.listen(port,"127.0.0.1",()=>process.stdout.write("opencode server listening on http://127.0.0.1:"+port+"\n"))}
`;
async function serveFolder(t,mode){
  const root=await mkdtemp(join(tmpdir(),"trebell-opencode-startup-"));
  await writeFile(join(root,"serve"),FAKE_SERVE,"utf8");
  const attempts=join(root,"attempts");
  t.after(async()=>{
    const pid=Number(await readFile(attempts+".descendant","utf8").catch(()=>""));if(pid)try{process.kill(pid)}catch{}
    await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  });
  const ports=async()=>(await readFile(attempts,"utf8").catch(()=>"")).split("\n").filter(Boolean).map(Number);
  return {root,attempts,ports,start:()=>startOpenCodeServer({command:process.execPath,cwd:root,env:{...process.env,FAKE_ATTEMPTS:attempts,FAKE_MODE:mode}})};
}

test("an OpenCode server that finds the shared database locked is started again on a new port, and comes up on its third launch",async t=>{
  const folder=await serveFolder(t,"transient");
  const server=await folder.start();
  try{
    const ports=await folder.ports();
    assert.equal(ports.length,3,"two launches found the database locked");
    assert.equal(new Set(ports).size,3,"each launch has a port of its own");
    assert.equal(server.url,`http://127.0.0.1:${ports[2]}`);
  }finally{server.close()}
});

test("an OpenCode server that lost the first run's schema setup to another server is started again, as one that found the database locked is",async t=>{
  const folder=await serveFolder(t,"schema");
  const server=await folder.start();
  try{assert.equal((await folder.ports()).length,3)}finally{server.close()}
});

test("an OpenCode server whose database stays locked is launched four times and fails with OpenCode's own reason",async t=>{
  const folder=await serveFolder(t,"permanent");
  await assert.rejects(folder.start(),error=>{
    assert.match(error.message,/^OpenCode server exited with code 1\. SQLiteError: database is locked \(SQLITE_BUSY\)$/);
    return true;
  });
  assert.equal((await folder.ports()).length,4);
});

test("an OpenCode server that exits for any other reason is not started again, a lock named only on stdout included",async t=>{
  for(const mode of ["configuration","unrelated"]){
    const folder=await serveFolder(t,mode);
    await assert.rejects(folder.start(),error=>{assert.match(error.message,/^OpenCode server exited with code 1\. .*Invalid configuration$/s);assert.notEqual(error.code,"OPENCODE_DATABASE_BUSY");return true});
    assert.equal((await folder.ports()).length,1,`${mode}: one launch`);
  }
});

test("what an OpenCode server's pipes carry just after it exits is in its error, and a process that holds them open keeps it at most half a second",async t=>{
  const late=await serveFolder(t,"late");
  await assert.rejects(late.start(),error=>{assert.match(error.message,/^OpenCode server exited with code 1\. Error: opencode\.json is not valid JSON$/);return true});
  const held=await serveFolder(t,"held"),startedAt=Date.now();
  await assert.rejects(held.start(),/^Error: OpenCode server exited with code 1\. Invalid configuration$/);
  const elapsed=Date.now()-startedAt;
  assert.ok(elapsed<3000,`the error waited ${elapsed} ms for pipes a descendant held open`);
  assert.equal((await held.ports()).length,1);
});

test("an OpenCode server that takes longer than fifteen seconds to come up is waited for up to thirty",async t=>{
  // Only setTimeout is mocked: the stand-ins run on their own clocks, and it is told when to listen.
  const slow=await serveFolder(t,"slow"),silent=await serveFolder(t,"silent");
  const settle=promise=>{const state={done:false,error:null,value:null};promise.then(value=>{state.done=true;state.value=value},error=>{state.done=true;state.error=error});return state};
  const until=async(check,what)=>{const startedAt=Date.now();while(!check()){if(Date.now()-startedAt>15_000)throw new Error(what);await new Promise(resolve=>setImmediate(resolve))}};
  const turns=async()=>{for(let index=0;index<20;index++)await new Promise(resolve=>setImmediate(resolve))};
  mock.timers.enable({apis:["setTimeout"]});
  try{
    const first=settle(slow.start());await until(()=>existsSync(slow.attempts+".started"),"the stand-in did not start");
    mock.timers.tick(20_000);await turns();
    assert.equal(first.done,false,first.error?.message||"it settled before it listened");
    await writeFile(slow.attempts+".go","1");
    await until(()=>first.done,"the server never came up");
    assert.equal(first.error,null,first.error?.message);
    first.value.close();
    // One that never says it listens is stopped after thirty seconds, with that in its error.
    const second=settle(silent.start());await until(()=>existsSync(silent.attempts+".started"),"the second stand-in did not start");
    mock.timers.tick(29_999);await turns();assert.equal(second.done,false);
    mock.timers.tick(1);await until(()=>second.done,"the wait did not end");
    assert.match(String(second.error?.message),/^OpenCode server did not start within 30 seconds\./);
  }finally{mock.timers.reset()}
});
