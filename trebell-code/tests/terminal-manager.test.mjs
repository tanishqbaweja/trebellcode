import test from "node:test";
import assert from "node:assert/strict";
import { TerminalManager } from "../src/terminal-manager.mjs";

test("persistent terminal worker starts a PTY and retains output",{timeout:20000},async()=>{
  const terminals=new TerminalManager();
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
  const terminals=new TerminalManager();
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
