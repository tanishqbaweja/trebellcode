import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { WebSocket } from "ws";

const base=process.argv[2]||`http://127.0.0.1:${process.env.TREBELL_GUI_PORT||3210}`;
const cdpUrl=process.env.TREBELL_CDP_URL||"http://127.0.0.1:9333";
const fixturePort=Number(process.env.TREBELL_BROWSER_FIXTURE_PORT||33333);
const model=process.env.VYCE_MODEL||"deepseek-v4.1";
const proof="installed-agent-proof";

function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms))}

function decodeText(buffer){
  if(buffer.length>=2&&buffer[0]===0xff&&buffer[1]===0xfe)return buffer.subarray(2).toString("utf16le");
  return buffer.toString("utf8");
}

class RpcClient{
  constructor(ws,onRequest){
    this.ws=ws;this.onRequest=onRequest;this.nextId=1;this.pending=new Map();this.notifications=[];this.waiters=[];
    ws.on("message",data=>this.onMessage(data));
  }
  request(method,params={}){
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(method+" timed out"))},180000);
      this.pending.set(id,{resolve,reject,timer});
      this.ws.send(JSON.stringify({id,method,params}));
    });
  }
  respond(id,result){this.ws.send(JSON.stringify({id,result}))}
  reject(id,code,message){this.ws.send(JSON.stringify({id,error:{code,message}}))}
  waitFor(predicate,timeoutMs=180000){
    const existing=this.notifications.find(predicate);if(existing)return Promise.resolve(existing);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.waiters=this.waiters.filter(item=>item.resolve!==resolve);reject(new Error("notification wait timed out"))},timeoutMs);
      this.waiters.push({predicate,resolve,reject,timer});
    });
  }
  async onMessage(data){
    let msg;try{msg=JSON.parse(String(data))}catch{return}
    if(msg.id!=null&&this.pending.has(msg.id)){
      const entry=this.pending.get(msg.id);this.pending.delete(msg.id);clearTimeout(entry.timer);
      if(msg.error)entry.reject(new Error(msg.error.message||JSON.stringify(msg.error)));else entry.resolve(msg.result);return;
    }
    if(msg.id!=null&&msg.method){
      try{this.respond(msg.id,await this.onRequest(msg))}catch(error){this.reject(msg.id,-32000,error?.message||String(error))}
      return;
    }
    if(msg.method){
      this.notifications.push(msg);
      for(const waiter of [...this.waiters])if(waiter.predicate(msg)){
        this.waiters=this.waiters.filter(item=>item!==waiter);clearTimeout(waiter.timer);waiter.resolve(msg);
      }
    }
  }
}

const dynamicTools=[
  {type:"namespace",name:"trebell_browser",description:"Control Trebell Code's packaged isolated browser.",tools:[
    {type:"function",name:"open",description:"Navigate to a URL.",inputSchema:{type:"object",properties:{url:{type:"string"}},required:["url"],additionalProperties:false}},
    {type:"function",name:"snapshot",description:"Inspect page text and interactive elements.",inputSchema:{type:"object",properties:{},additionalProperties:false}},
    {type:"function",name:"click",description:"Click an element by snapshot ref.",inputSchema:{type:"object",properties:{ref:{type:"string"}},required:["ref"],additionalProperties:false}},
    {type:"function",name:"type",description:"Type into an element by snapshot ref.",inputSchema:{type:"object",properties:{ref:{type:"string"},text:{type:"string"}},required:["ref","text"],additionalProperties:false}},
  ]},
  {type:"namespace",name:"trebell_computer",description:"Use Trebell Code's packaged Windows computer-use bridge.",tools:[
    {type:"function",name:"screenshot",description:"Capture the primary desktop and return screenshot metadata.",inputSchema:{type:"object",properties:{},additionalProperties:false}},
  ]},
];

const fixture=createServer((_req,res)=>{
  res.writeHead(200,{"content-type":"text/html; charset=utf-8"});
  res.end(`<!doctype html><html><head><title>Installed Agent Fixture</title></head><body><input name="q" placeholder="proof input"><button onclick="document.querySelector('#result').textContent='${proof}:'+document.querySelector('input').value">Commit proof</button><p id="result">idle</p></body></html>`);
});

await new Promise((resolve,reject)=>fixture.listen(fixturePort,"127.0.0.1",resolve).once("error",reject));

let browser=null,ws=null;
const workspace=await mkdtemp(join(tmpdir(),"trebell-installed-agent-"));
try{
  for(let attempt=0;attempt<40&&!browser;attempt++){
    try{browser=await chromium.connectOverCDP(cdpUrl)}catch{await wait(500)}
  }
  assert.ok(browser,"Could not connect to packaged Trebell over CDP");
  let mainPage=null;
  for(let attempt=0;attempt<40&&!mainPage;attempt++){
    for(const page of browser.contexts().flatMap(context=>context.pages())){
      const ok=await page.evaluate(()=>Boolean(window.trebellDesktop?.browser&&window.trebellDesktop?.computer)).catch(()=>false);
      if(ok){mainPage=page;break}
    }
    if(!mainPage)await wait(250);
  }
  assert.ok(mainPage,"Packaged Trebell preload bridge was not available");

  const switched=await fetch(base+"/api/providers",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider:"vyceai"})}).then(r=>r.json());
  assert.equal(switched.selected,"vyceai");
  assert.ok(switched.models?.includes(model),`Vyce model ${model} is unavailable in packaged app`);
  let boot=null;
  for(let attempt=0;attempt<60;attempt++){
    boot=await fetch(base+"/api/bootstrap").then(r=>r.json()).catch(()=>null);
    if(boot?.provider==="vyceai"&&boot?.appServerReady)break;
    await wait(250);
  }
  assert.equal(boot?.provider,"vyceai");assert.equal(boot?.appServerReady,true);

  const toolCalls=[];let assistant="";
  ws=new WebSocket(boot.wsUrl,{origin:"http://trebell-installed-agent.local"});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("packaged Codex websocket timed out")),15000);ws.once("open",()=>{clearTimeout(timer);resolve()});ws.once("error",reject)});
  const rpc=new RpcClient(ws,async msg=>{
    const p=msg.params||{};
    if(msg.method==="item/tool/call"){
      const args=typeof p.arguments==="string"?JSON.parse(p.arguments||"{}"):p.arguments||{};
      toolCalls.push(`${p.namespace}/${p.tool}`);
      if(p.namespace==="trebell_browser"){
        let result;
        if(p.tool==="open")result=await mainPage.evaluate(url=>window.trebellDesktop.browser.navigate(url),String(args.url));
        else if(p.tool==="snapshot")result=await mainPage.evaluate(()=>window.trebellDesktop.browser.snapshot());
        else if(p.tool==="click")result=await mainPage.evaluate(ref=>window.trebellDesktop.browser.click(ref),String(args.ref));
        else if(p.tool==="type")result=await mainPage.evaluate(({ref,text})=>window.trebellDesktop.browser.type(ref,text),{ref:String(args.ref),text:String(args.text??"")});
        else throw new Error("unsupported browser tool "+p.tool);
        return {contentItems:[{type:"inputText",text:JSON.stringify(result)}],success:true};
      }
      if(p.namespace==="trebell_computer"&&p.tool==="screenshot"){
        const shot=await mainPage.evaluate(()=>window.trebellDesktop.computer.screenshot());
        assert.ok(shot?.dataUrl?.startsWith("data:image/png;base64,"),"Packaged computer screenshot failed");
        return {contentItems:[{type:"inputText",text:JSON.stringify({captured:true,width:shot.width,height:shot.height,displayId:shot.displayId})}],success:true};
      }
      return {contentItems:[{type:"inputText",text:"unsupported dynamic tool"}],success:false};
    }
    if(msg.method.includes("requestApproval")||msg.method==="applyPatchApproval"||msg.method==="execCommandApproval")return {decision:"accept"};
    if(msg.method==="item/tool/requestUserInput")return {answers:{}};
    return null;
  });
  ws.on("message",data=>{try{const msg=JSON.parse(String(data));const p=msg.params||{};if(msg.method==="item/agentMessage/delta")assistant+=p.delta||p.text||"";if(msg.method==="item/completed"&&p.item?.type==="agentMessage"&&p.item.text)assistant+=p.item.text}catch{}});

  await rpc.request("initialize",{clientInfo:{name:"trebell-installed-agent",title:"Trebell Packaged Agent Validation",version:boot.version||"0.0.0"},capabilities:{experimentalApi:true}});
  ws.send(JSON.stringify({method:"initialized",params:{}}));
  const thread=await rpc.request("thread/start",{model,modelProvider:"vyceai",cwd:workspace,approvalPolicy:"never",sandbox:"danger-full-access",ephemeral:true,threadSource:"trebell-installed-agent",dynamicTools,developerInstructions:"This is an automated packaged Trebell validation. Use the requested tools exactly and verify observed values instead of guessing."});
  assert.ok(thread.thread?.id,"thread/start did not return a thread id");
  const fixtureUrl=`http://127.0.0.1:${fixturePort}`;
  const expected=`${proof}:model-ok`;
  const turn=await rpc.request("turn/start",{threadId:thread.thread.id,model,cwd:workspace,approvalPolicy:"never",sandboxPolicy:{type:"dangerFullAccess"},input:[{type:"text",text:[
    "Perform this packaged Trebell validation using tools, not guesses.",
    "1. Call trebell_computer.screenshot once.",
    `2. Open ${fixtureUrl} with trebell_browser.open.`,
    "3. Snapshot the page. Type model-ok into the proof input, click Commit proof, then snapshot again.",
    `4. Confirm the page shows exactly ${expected}.`,
    `5. Use your shell/filesystem tools to create installed-agent-proof.txt in the current workspace containing exactly ${expected}.`,
    "6. Read that file back to verify it.",
    `7. Reply with only ${expected}.`,
  ].join("\n"),text_elements:[]} ]});
  const turnId=turn.turn?.id;assert.ok(turnId,"turn/start did not return a turn id");
  let completed;
  try{
    completed=await rpc.waitFor(msg=>msg.method==="turn/completed"&&(msg.params?.turn?.id===turnId||msg.params?.turnId===turnId),180000);
  }catch(error){
    const diagnostics=await fetch(base+"/api/diagnostics?path="+encodeURIComponent(workspace)).then(r=>r.json()).catch(()=>null);
    const resumed=await rpc.request("thread/resume",{threadId:thread.thread.id,model,modelProvider:"vyceai",cwd:workspace,excludeTurns:false}).catch(()=>null);
    console.error("PACKAGED_AGENT_TIMEOUT_DIAGNOSTICS",JSON.stringify({
      toolCalls,
      assistantTail:assistant.slice(-2000),
      notifications:rpc.notifications.slice(-50).map(msg=>({method:msg.method,turnId:msg.params?.turnId||msg.params?.turn?.id||null,itemType:msg.params?.item?.type||null,status:msg.params?.turn?.status||msg.params?.status||null,message:msg.params?.message||null})),
      resumedThread:resumed?.thread||null,
      runtime:diagnostics?.runtime||null,
      logs:(diagnostics?.logs||[]).slice(-30),
    },null,2));
    throw error;
  }
  const fileProof=decodeText(await readFile(join(workspace,"installed-agent-proof.txt"))).trim();
  assert.equal(fileProof,expected);
  assert.match(assistant,new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  for(const call of ["trebell_computer/screenshot","trebell_browser/open","trebell_browser/snapshot","trebell_browser/type","trebell_browser/click"])assert.ok(toolCalls.includes(call),`Model did not call ${call}`);
  assert.ok(toolCalls.filter(call=>call==="trebell_browser/snapshot").length>=2,"Model did not snapshot before and after browser interaction");
  assert.equal(completed.params?.turn?.status,"completed");
  console.log(JSON.stringify({ok:true,model,turnStatus:completed.params?.turn?.status,toolCalls,fileProof,assistantContainsProof:true},null,2));
}finally{
  try{ws?.close()}catch{}
  try{await browser?.close()}catch{}
  await new Promise(resolve=>fixture.close(()=>resolve()));
  await rm(workspace,{recursive:true,force:true,maxRetries:10,retryDelay:100}).catch(()=>{});
  await fetch(base+"/api/providers",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider:"freebuff"})}).catch(()=>{});
}
