import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { NativeAgentSession } from "../src/native-agent-session.mjs";
import { NativeToolOutputStore } from "../src/native-tool-output-store.mjs";

function digest(value){
  return createHash("sha256").update(String(value||"")).digest("hex").slice(0,16);
}

async function run(provider){
  const root=await mkdtemp(join(tmpdir(),"trebell-cache-history-")),requests=[],events=[];let calls=0;
  try{
    const store=new NativeToolOutputStore({directory:root,maxHotBytes:4096});
    const session=new NativeAgentSession({
      model:provider==="openai"?"gpt-5.6":"fixture-model",provider,toolOutputStore:store,onEvent:event=>events.push(event),
      tools:[
        {type:"namespace",name:"trebell_terminal",tools:[{name:"run"}]},
        {type:"namespace",name:"trebell_workspace",tools:[{name:"read_file"}]},
      ],
      providerTurn:async request=>{
        requests.push(structuredClone(request));calls++;
        if(calls===1)return {id:"big-turn",text:"",toolCalls:[{id:"big",namespace:"trebell_terminal",name:"run",arguments:'{"command":"verify"}'}],usage:{}};
        if(calls===2)return {id:"small-turn",text:"",toolCalls:[{id:"small",namespace:"trebell_workspace",name:"read_file",arguments:'{"path":"small.txt"}'}],usage:{}};
        return {id:"done",text:"done",toolCalls:[],usage:{}};
      },
      executeTool:async call=>call.id==="big"
        ?{exitCode:1,stdout:"x".repeat(40_000),stderr:"CRITICAL_ASSERTION expected strict but received legacy"}
        :{path:"small.txt",size:8,content:"small-ok"},
    });
    await session.start({providerSessionId:"cache-history-"+provider,model:provider==="openai"?"gpt-5.6":"fixture-model"});
    await session.prompt([{type:"text",text:"inspect the evidence"}]);
    const hot=String(requests[1].messages.find(message=>message.role==="tool"&&message.toolCallId==="big")?.content||"");
    const later=String(requests[2].messages.find(message=>message.role==="tool"&&message.toolCallId==="big")?.content||"");
    const persisted=String(session.messages.find(message=>message.role==="tool"&&message.toolCallId==="big")?.content||"");
    assert.ok(hot.length>512,"virtualized hot evidence should retain a meaningful preview");
    assert.match(hot,/CRITICAL_ASSERTION expected strict but received legacy/,"hot preview should retain the decisive failure signal");
    return {
      provider,
      hotChars:hot.length,
      laterChars:later.length,
      persistedChars:persisted.length,
      hotDigest:digest(hot),
      laterDigest:digest(later),
      persistedDigest:digest(persisted),
      providerPrefixPreserved:hot===later&&hot===persisted,
      cooledEvents:events.filter(event=>event.name==="native.tool.history_cooled").length,
    };
  }finally{
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});
  }
}

async function runBudgetFinalization(provider){
  const requests=[];let calls=0;
  const tools=[{type:"namespace",name:"trebell_workspace",tools:[{name:"read_file",inputSchema:{type:"object",properties:{path:{type:"string"}}}}]}];
  const session=new NativeAgentSession({
    model:provider==="openai"?"gpt-5.6":"fixture-model",provider,tools,
    providerTurn:async request=>{
      requests.push(structuredClone(request));calls++;
      if(calls===1)return {id:"read",text:"",toolCalls:[{id:"read-1",namespace:"trebell_workspace",name:"read_file",arguments:'{"path":"a.txt"}'}],usage:{}};
      return {id:"done",text:"done",toolCalls:[],usage:{}};
    },
    executeTool:async()=>({path:"a.txt",content:"evidence"}),
  });
  await session.start({providerSessionId:"cache-tools-"+provider,model:provider==="openai"?"gpt-5.6":"fixture-model"});
  await session.prompt([{type:"text",text:"read once then answer"}],{maxToolCalls:1,maxModelTurns:2});
  assert.equal(requests.length,2);
  const first=JSON.stringify(requests[0].tools),final=JSON.stringify(requests[1].tools);
  return {
    provider,
    firstToolSchemaChars:first.length,
    finalToolSchemaChars:final.length,
    finalToolChoice:requests[1].toolChoice,
    providerToolManifestPreserved:first===final,
  };
}

const openai=await run("openai"),vyce=await run("vyceai");
const openaiBudget=await runBudgetFinalization("openai"),vyceBudget=await runBudgetFinalization("vyceai");
assert.equal(openai.providerPrefixPreserved,true);
assert.equal(openai.cooledEvents,0);
assert.equal(vyce.providerPrefixPreserved,false);
assert.ok(vyce.laterChars<vyce.hotChars);
assert.equal(openaiBudget.providerToolManifestPreserved,true);
assert.equal(openaiBudget.finalToolChoice,"none");
assert.equal(vyceBudget.providerToolManifestPreserved,false);
assert.equal(vyceBudget.finalToolSchemaChars,2);
console.log(JSON.stringify({ok:true,history:[openai,vyce],budgetFinalization:[openaiBudget,vyceBudget]},null,2));
