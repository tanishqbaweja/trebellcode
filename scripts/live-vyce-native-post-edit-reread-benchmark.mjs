import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createNativeBuiltins } from "../src/native-builtins.mjs";
import { NativeAgentSession } from "../src/native-agent-session.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";

const apiKey=String(process.env.TREBELL_TEST_VYCE_API_KEY||process.env.VYCEAI_API_KEY||process.env.VYCE_API_KEY||"").trim();
if(!apiKey)throw new Error("Set TREBELL_TEST_VYCE_API_KEY, VYCEAI_API_KEY, or VYCE_API_KEY before running the post-edit reread benchmark.");
const env={...process.env,VYCEAI_API_KEY:apiKey},manager=new ProviderManager({env});
const catalog=await manager.models("vyceai"),requested=String(process.env.VYCE_MODEL||"deepseek-v4.1").trim(),model=catalog.models.includes(requested)?requested:catalog.models[0];
if(!model)throw new Error("Vyce did not advertise any model for the post-edit reread benchmark.");

const root=await mkdtemp(join(tmpdir(),"trebell-post-edit-reread-"));
try{
  const file="src/config.txt",target=join(root,file),before=("ordinary configuration line xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n".repeat(190))+"mode=legacy\n"+("ordinary trailing line yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\n".repeat(25));
  await mkdir(dirname(target),{recursive:true});await writeFile(target,before,"utf8");
  const execute=createNativeBuiltins({root,environment:env}),requests=[];let calls=0;
  const tools=[{type:"namespace",name:"trebell_workspace",tools:[
    {name:"read_file",description:"Read one workspace file.",inputSchema:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false}},
    {name:"replace_text",description:"Replace exact text in one workspace file.",inputSchema:{type:"object",properties:{path:{type:"string"},old_text:{type:"string"},new_text:{type:"string"}},required:["path","old_text","new_text"],additionalProperties:false}},
  ]}];
  const session=new NativeAgentSession({
    cwd:root,provider:"vyceai",model,tools,executeTool:execute,
    initialMessages:[{role:"system",content:"After the forced tool sequence, reply exactly VERIFIED if the final workspace reread confirms the successful mode=legacy to mode=strict edit. Otherwise reply exactly NOT VERIFIED."}],
    providerTurn:async request=>{
      calls++;const record={messages:structuredClone(request.messages),tools:structuredClone(request.tools||[]),metrics:nativeRequestMetrics(request.messages,request.tools),usage:null,telemetry:null,text:null};requests.push(record);
      if(calls===1)return {id:"synthetic-read-before",text:"",toolCalls:[{id:"read-before",namespace:"trebell_workspace",name:"read_file",arguments:JSON.stringify({path:file})}],usage:{}};
      if(calls===2)return {id:"synthetic-edit",text:"",toolCalls:[{id:"edit",namespace:"trebell_workspace",name:"replace_text",arguments:JSON.stringify({path:file,old_text:"mode=legacy",new_text:"mode=strict"})}],usage:{}};
      if(calls===3)return {id:"synthetic-read-after",text:"",toolCalls:[{id:"read-after",namespace:"trebell_workspace",name:"read_file",arguments:JSON.stringify({path:file})}],usage:{}};
      const response=await manager.turn("vyceai",{...request,provider:"vyceai",model,tools:[],toolChoice:"none",maxOutputTokens:16},{signal:request.signal});record.usage=response.usage;record.telemetry=response.telemetry;record.text=String(response.text||"");return response;
    },
  });
  await session.start({providerSessionId:"post-edit-reread-benchmark",model});
  const result=await session.prompt([{type:"text",text:"Run the forced read, edit, and reread sequence, then report whether the edit is verified."}],{maxModelTurns:4,maxToolCalls:3,maxWallTimeMs:120_000});
  assert.equal(requests.length,4);const final=requests[3],wire=JSON.stringify(final.messages),fresh=final.messages.find(message=>message.role==="tool"&&message.toolCallId==="read-after");assert.ok(fresh);
  const finalText=String(final.text||result?.raw?.text||"").trim();assert.match(finalText,/VERIFIED/i);
  console.log(JSON.stringify({
    ok:true,runtime:"native",provider:"vyceai",model,
    finalRequestInputTokens:Number(final.usage?.inputTokens||0),finalRequestOutputTokens:Number(final.usage?.outputTokens||0),finalRequestCachedInputTokens:Number(final.usage?.cachedInputTokens||0),
    finalRequestBytes:Number(final.telemetry?.requestBytes||0),finalRequestMessageChars:wire.length,
    freshRereadChars:String(fresh.content||"").length,freshRereadCompacted:/postEditVerified|byte-match the exact successful edit/i.test(String(fresh.content||"")),
    fullStrictBodyPresentInFreshReread:/ordinary trailing line y{20}/.test(String(fresh.content||"")),
    finalAgentText:finalText,
  },null,2));
}finally{await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
