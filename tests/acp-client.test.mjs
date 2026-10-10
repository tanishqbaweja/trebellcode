import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpClient, ACP_STDERR_TAIL_MAX_CHARS, appendAcpStderrTail, defaultAcpClientCapabilities, sanitizeAcpStderrExcerpt } from "../src/acp-client.mjs";

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

test("ACP stderr tail stays bounded and redacts secrets before surfacing",()=>{
  const prefix="x".repeat(ACP_STDERR_TAIL_MAX_CHARS);
  assert.equal(appendAcpStderrTail(prefix,"abc"),prefix.slice(3)+"abc");
  const home=process.platform==="win32"?"C:\\Users\\ada":"/home/ada";
  const value=sanitizeAcpStderrExcerpt([
    "Invalid project config at "+home+"/.cursor/cli.json",
    "Authorization: Bearer secret-token-value",
    "Visit http://localhost:5733/pair#token=ABCDEF",
    "openai=sk-proj-abcdefghijklmnopqrstuvwxyz012345",
    "x-api-key: private-api-key",
    "custom=totally-opaque-runtime-secret",
  ].join("\n"),{...process.env,HOME:home,USERPROFILE:home,CUSTOM_RUNTIME_TOKEN:"totally-opaque-runtime-secret"});
  assert.match(value,/~\/\.cursor\/cli\.json/);
  assert.match(value,/Bearer \[redacted\]/);
  assert.match(value,/\[pairing-url\]/);
  assert.doesNotMatch(value,/secret-token-value|ABCDEF|sk-proj-|private-api-key|totally-opaque-runtime-secret/);
});

test("ACP startup failures include the useful stderr instead of a generic closed-session error",async()=>{
  const home=process.platform==="win32"?"C:\\Users\\fixture":"/home/fixture";
  const source=[
    "process.stderr.write("+JSON.stringify("Invalid project config at "+home+"/.cursor/cli.json: schema validation failed. Unrecognized key(s): 'approvalMode', 'sandbox'\nAuthorization: Bearer secret-startup-token\n")+");",
    "process.exit(1);",
  ].join("");
  const client=new AcpClient({command:process.execPath,args:["-e",source],env:{...process.env,HOME:home,USERPROFILE:home},timeoutMs:3000});
  let failure=null;
  try{await client.start();await client.initialize()}catch(error){failure=error}
  assert.ok(failure);
  assert.match(failure.message,/cli\.json/);
  assert.match(failure.message,/Unrecognized key/);
  assert.match(failure.message,/approvalMode/);
  assert.doesNotMatch(failure.message,/secret-startup-token/);
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
  }finally{await client.stop().catch(()=>{});await rm(root,{recursive:true,force:true})}
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
