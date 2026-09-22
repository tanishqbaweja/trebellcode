import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalManager } from "../src/terminal-manager.mjs";

test("persistent terminal worker starts a PTY and retains output",{timeout:20000},async()=>{
  const terminals=new TerminalManager({persist:false});
  try{
    const session=await terminals.create({cwd:process.cwd(),cols:100,rows:30});
    const marker="trebell-terminal-"+Date.now();
    const output=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("terminal output timeout")),10000);
      const listener=(id,data)=>{if(id===session.id&&data.includes(marker)){clearTimeout(timer);terminals.off("output",listener);resolve(data);}};
      terminals.on("output",listener);
    });
    const command=process.platform==="win32"?`echo ${marker}\r`:`printf '${marker}\\n'\n`;
    await terminals.write(session.id,command);
    await output;
    assert.match(terminals.snapshot(session.id).buffer,new RegExp(marker));
  }finally{await terminals.shutdown();}
});


test("terminal manager can await a dedicated command PTY",{timeout:20000},async()=>{
  const terminals=new TerminalManager({persist:false});
  try{
    const marker="trebell-setup-"+Date.now();
    const shell=process.platform==="win32"?(process.env.COMSPEC||"cmd.exe"):(process.env.SHELL||"/bin/bash");
    const args=process.platform==="win32"
      ? ["/d","/s","/c",`echo ${marker} & exit /b 7`]
      : ["-lc",`printf '${marker}\\n'; exit 7`];
    const session=await terminals.create({cwd:process.cwd(),shell,args,name:"Setup test"});
    const completion=await terminals.waitForExit(session.id,{timeoutMs:10000});
    assert.equal(completion.exitCode,7);
    assert.match(terminals.snapshot(session.id).buffer,new RegExp(marker));
    assert.equal(terminals.snapshot(session.id).running,false);
  }finally{await terminals.shutdown();}
});

test("terminal scrollback survives manager restart as stopped history",{timeout:30000},async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-terminal-history-"));const env={...process.env,TREBELL_HOME:home};let first=null,second=null;
  try{
    first=new TerminalManager({env});
    const marker="trebell-history-"+Date.now();
    const shell=process.platform==="win32"?(process.env.COMSPEC||"cmd.exe"):(process.env.SHELL||"/bin/bash");
    const args=process.platform==="win32"?["/d","/s","/c",`echo ${marker}`]:["-lc",`printf '${marker}\\n'`];
    const session=await first.create({cwd:process.cwd(),displayCwd:"/srv/app",shell,args,name:"History fixture",environmentId:"ssh-a",environmentName:"Build box",environmentType:"ssh"});
    await first.waitForExit(session.id,{timeoutMs:10000});assert.match(first.snapshot(session.id).buffer,new RegExp(marker));
    await first.shutdown();first=null;
    second=new TerminalManager({env});const restored=second.snapshot(session.id);
    assert.ok(restored);assert.equal(restored.running,false);assert.equal(restored.restored,true);assert.equal(restored.name,"History fixture");assert.equal(restored.cwd,"/srv/app");assert.equal(restored.environmentId,"ssh-a");assert.equal(restored.environmentName,"Build box");assert.equal(restored.environmentType,"ssh");assert.match(restored.buffer,new RegExp(marker));
    assert.equal(second.list("ssh-a").length,1);assert.equal(second.list(null).length,0);
    await assert.rejects(()=>second.write(session.id,"echo should-not-run\r"),/stopped/i);
    await second.close(session.id);assert.equal(second.snapshot(session.id),null);
  }finally{await first?.shutdown().catch(()=>{});await second?.shutdown().catch(()=>{});await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:100})}
});
