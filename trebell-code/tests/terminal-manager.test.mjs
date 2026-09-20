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
