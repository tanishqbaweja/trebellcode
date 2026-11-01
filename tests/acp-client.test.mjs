import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpClient, defaultAcpClientCapabilities } from "../src/acp-client.mjs";
import { AGENT_LOG_KEPT_CHARS, agentLogExcerpt, extendAgentLog } from "../src/agent-log.mjs";
import { BEARER_LINE, HIDDEN_IN_EXCERPT, PAIRING_LINE, SIGN_IN_LINE } from "./fixtures/agent-log-lines.mjs";

test("ACP initialization advertises only client features Trebell actually handles",()=>{
  assert.deepEqual(defaultAcpClientCapabilities(),{
    fs:{readTextFile:true,writeTextFile:true},
    terminal:true,
    auth:{terminal:true},
    plan:{},
    session:{compaction:{}},
    elicitation:{form:{},url:{}},
  });
});

// The client keeps the newest 4,096 characters of what the agent printed, for a failure to quote.
test("an agent's log keeps its newest 4,096 characters, the oldest cut from the front",()=>{
  assert.equal(AGENT_LOG_KEPT_CHARS,4096,"the bound");
  // 60 numbered lines of 100 characters each, written one at a time: 6,000 characters.
  const lines=Array.from({length:60},(_,index)=>`agent log line ${String(index).padStart(2,"0")} `.padEnd(99,"-")+"\n");
  const kept=lines.reduce((tail,line)=>extendAgentLog(tail,line),"");
  assert.equal(kept,lines.join("").slice(-4096),"the newest 4,096 characters");
  assert.ok(kept.startsWith("t log line 19 -")&&kept.endsWith(lines[59]),"the cut falls 4 characters into line 19, and the last line is whole");
  // Under the bound nothing goes; a missing piece adds nothing; one chunk longer than the bound keeps its own end.
  assert.equal(extendAgentLog("booting\n","listening on stdio\n"),"booting\nlistening on stdio\n");
  assert.equal(extendAgentLog(undefined,"only\n"),"only\n");
  assert.equal(extendAgentLog("kept\n",null),"kept\n");
  const burst="z".repeat(5000)+"<end>";
  assert.equal(extendAgentLog("older\n",burst),burst.slice(-4096));
});

// What an error or a warning quotes of an agent's log: each line as the agent printed it, with the home folder written as ~ and
// every secret, pairing link and Google sign-in address replaced by its marker, both ends trimmed.
test("an agent's log excerpt hides its secrets, home folder and sign-in addresses, line by line",()=>{
  const home=process.platform==="win32"?"C:\\Users\\mira":"/home/mira",relaySecret="r3lay-0paque-value-for-tests";
  const lines=[
    ["[agent] reading settings from "+home+"/.config/agent/settings.json","[agent] reading settings from ~/.config/agent/settings.json"],
    BEARER_LINE,
    PAIRING_LINE,
    ["[agent] provider OPENAI=sk-test-4f1c9e2b7a6d accepted","[agent] provider OPENAI=[redacted] accepted"],
    ["[agent] upstream header x-api-key: tbk-upstream-0000","[agent] upstream header x-api-key: [redacted]"],
    ["[agent] relay session "+relaySecret+" opened","[agent] relay session [redacted] opened"],
    SIGN_IN_LINE,
  ];
  const log="\n\n"+lines.map(([line])=>line).join("\n")+"\n\n";
  const excerpt=agentLogExcerpt(log,{HOME:home,USERPROFILE:home,TREBELL_RELAY_TOKEN:relaySecret});
  assert.equal(excerpt,lines.map(([,line])=>line).join("\n"));
  assert.doesNotMatch(excerpt,/mira|sk-test|tbk-upstream|r3lay/);
  assert.doesNotMatch(excerpt,HIDDEN_IN_EXCERPT,"no token, pairing code, state, loopback address or Google host is left");
});

// An agent that cannot read its own settings as it starts: the failure quotes what it printed, the settings file under ~ and the
// token it was about to send hidden, instead of a generic closed-session error.
test("ACP startup failures include the useful stderr instead of a generic closed-session error",async()=>{
  const home=process.platform==="win32"?"C:\\Users\\fixture":"/home/fixture";
  const printed=[
    "fixture-agent 0.9.2: could not load "+home+"/.config/fixture-agent/settings.toml",
    "  line 7: unknown field `sandbox_mode`, expected one of `model`, `approvals`",
    "fixture-agent: giving up before contacting https://agent.example/v1 (Authorization: Bearer startup.T0ken-7~x)",
  ].join("\n")+"\n";
  const source="process.stderr.write("+JSON.stringify(printed)+",()=>process.exit(2));";
  const client=new AcpClient({command:process.execPath,args:["-e",source],env:{...process.env,HOME:home,USERPROFILE:home},timeoutMs:3000});
  let failure=null;
  try{await client.start();await client.initialize()}catch(error){failure=error}
  assert.ok(failure);
  assert.match(failure.message,/^ACP runtime exited code=2/);
  assert.match(failure.message,/could not load ~\/\.config\/fixture-agent\/settings\.toml$/m,"the settings file, under ~");
  assert.match(failure.message,/unknown field `sandbox_mode`/);
  assert.match(failure.message,/\(Authorization: Bearer \[redacted\]\)$/m);
  assert.doesNotMatch(failure.message,/T0ken|fixture[\\/]\.config/);
  assert.doesNotMatch(failure.message,/ACP runtime is not connected/);
  await client.stop().catch(()=>{});
});

test("ACP stop tears down helper processes on Windows instead of orphaning the runtime tree",{timeout:15000},async t=>{
  if(process.platform!=="win32")return t.skip("Windows process-tree regression");
  const root=await mkdtemp(join(tmpdir(),"trebell-acp-tree-")),pidFile=join(root,"child.pid"),fixture=join(root,"parent.mjs");
  const source=`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
setInterval(()=>{},1000);
`;
  await writeFile(fixture,source,"utf8");
  const client=new AcpClient({command:process.execPath,args:[fixture],cwd:root});
  const alive=pid=>{try{process.kill(Number(pid),0);return true}catch{return false}};
  try{
    await client.start();
    let helperPid=null;for(let i=0;i<50&&!helperPid;i++){try{helperPid=Number(await readFile(pidFile,"utf8"))||null}catch{}if(!helperPid)await new Promise(resolve=>setTimeout(resolve,50))}
    assert.ok(helperPid&&alive(helperPid),"fixture helper should be running before shutdown");
    await client.stop();
    for(let i=0;i<40&&alive(helperPid);i++)await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(alive(helperPid),false,"ACP helper must be terminated with its launcher");
  }finally{await client.stop().catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("session/prompt waits for the agent with no timer while other requests keep their timeout",{timeout:20000},async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-acp-prompt-")),fixture=join(root,"agent.mjs");
  await writeFile(fixture,`
import readline from "node:readline";
const send=message=>process.stdout.write(JSON.stringify(message)+"\\n");
readline.createInterface({input:process.stdin}).on("line",line=>{const message=JSON.parse(line);
  if(message.method==="session/prompt")setTimeout(()=>send({jsonrpc:"2.0",id:message.id,result:{stopReason:"end_turn",meta:message.params._meta}}),1600);
});
`,"utf8");
  const client=new AcpClient({command:process.execPath,args:[fixture],cwd:root,timeoutMs:1000});
  t.after(async()=>{await client.stop().catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})});
  await client.start();
  await assert.rejects(client.request("session/slow",{}),/session\/slow timed out/);
  assert.deepEqual(await client.prompt("s",[{type:"text",text:"hi"}],{meta:{promptId:"p1"}}),{stopReason:"end_turn",meta:{promptId:"p1"}},"a turn longer than the request timeout still completes");
});

test("a launch's own temp folder is gone once stop() resolves, also when the process ended by itself",{timeout:20000},async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-acp-runtemp-")),fixture=join(root,"agent.mjs"),runRoot=join(root,"runs");
  await writeFile(fixture,`
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const dir=process.env.TEMP||process.env.TMPDIR;
for(let index=0;index<50;index++)writeFileSync(join(dir,"unpacked-"+index+".bin"),"x".repeat(4096));
setTimeout(()=>process.exit(0),100);
`,"utf8");
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const client=new AcpClient({command:process.execPath,args:[fixture],cwd:root,runTempRoot:runRoot});
  const ended=new Promise(resolve=>client.once("terminated",resolve));
  await client.start();
  assert.equal((await readdir(runRoot)).length,1,"the process runs in its own folder under the run root");
  await ended;await client.stop();
  assert.deepEqual(await readdir(runRoot),[],"stop() waits for the removal the exit started");
});
