import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_PROVIDERS, ProviderManager, autoToolChoiceRequest } from "../src/provider-manager.mjs";

// The Meta Model API takes tool_choice "auto" only: "none", "required" and a named tool are refused with HTTP 400 (checked live on
// 2026-10-31; a request with no tools is accepted). Native's controllers ask for a call ("required", an allowed set or a named tool)
// or for none ("none"), so on Meta a turn that did either failed: the runner exited 1 on Terminal-Bench Pro's
// recover-and-sanitize-postgres-wal-secret three times out of three. The stand-in below answers as Meta does.
const META_REFUSAL={error:{code:null,message:'only `"auto"` is supported for `tool_choice`. `"none"`, `"required"`, and named function choices are not currently supported',param:"tool_choice",type:"invalid_request_error"}};
const completed=model=>({id:"resp_test",object:"response",status:"completed",model,output:[{type:"message",id:"msg_test",role:"assistant",status:"completed",content:[{type:"output_text",text:"done",annotations:[]}]}],usage:{input_tokens:20,input_tokens_details:{cached_tokens:0},output_tokens:2,output_tokens_details:{reasoning_tokens:0},total_tokens:22}});
function api(){
  const requests=[];
  return {requests,fetchFn:async(url,init={})=>{
    const target=String(url);
    if(!/^https:\/\/api\.(meta\.ai|x\.ai)\//.test(target))throw new Error("Unexpected request: "+target);
    const body=JSON.parse(String(init.body||"{}"));requests.push({url:target,body});
    if(target.includes("api.meta.ai")&&body.tool_choice!=null&&body.tool_choice!=="auto")return new Response(JSON.stringify(META_REFUSAL),{status:400,headers:{"content-type":"application/json"}});
    return Response.json(completed(body.model));
  }};
}
const home=()=>mkdtempSync(join(tmpdir(),"trebell-meta-tool-choice-"));
const tools=[{type:"namespace",name:"trebell_workspace",description:"Workspace files.",tools:[{type:"function",name:"list",description:"List files.",inputSchema:{type:"object",properties:{path:{type:"string"}}}}]}];
const request=(provider,model,toolChoice)=>({provider,model,messages:[{role:"system",content:"You are Trebell Native."},{role:"user",content:"List the files."}],tools,toolChoice,parallelToolCalls:true,maxOutputTokens:1024});

test("a turn that must call a tool asks a provider of auto only for auto, and one that must not is sent without its tools",()=>{
  const base=request("meta","muse-spark-1.3-contributor","auto");
  assert.equal(autoToolChoiceRequest(base),base,"auto is sent as it is");
  const unset={...base,toolChoice:undefined};assert.equal(autoToolChoiceRequest(unset),unset,"no choice is sent as it is");
  for(const choice of ["required",{namespace:"trebell_workspace",name:"list"},{type:"allowed_tools",mode:"required",tools:[{namespace:"trebell_workspace",name:"list"}]}]){
    const sent=autoToolChoiceRequest({...base,toolChoice:choice});
    assert.equal(sent.toolChoice,"auto",JSON.stringify(choice));assert.equal(sent.tools,tools,"its tools stay");
  }
  const none=autoToolChoiceRequest({...base,toolChoice:"none"});
  assert.deepEqual(none.tools,[]);assert.equal(none.toolChoice,"auto");assert.equal(base.tools,tools,"the caller's request is not changed");
  assert.equal(MODEL_PROVIDERS.meta.autoToolChoiceOnly,true);
  assert.equal(Object.values(MODEL_PROVIDERS).filter(provider=>provider.autoToolChoiceOnly).map(provider=>provider.id).join(","),"meta","only Meta's API is known to take auto only");
});

test("on Meta a forced, a named or an allowed-set tool choice is sent as auto and the turn is answered instead of refused",async()=>{
  const root=home();
  try{
    for(const choice of ["required",{namespace:"trebell_workspace",name:"list"},{type:"allowed_tools",mode:"required",tools:[{namespace:"trebell_workspace",name:"list"}]}]){
      const stand=api(),manager=new ProviderManager({env:{TREBELL_HOME:root,META_API_KEY:"meta-test-key"},fetchFn:stand.fetchFn});
      const result=await manager.turn("meta",request("meta","muse-spark-1.3-contributor",choice));
      assert.equal(result.text,"done",JSON.stringify(choice));
      const [sent]=stand.requests;
      assert.equal(sent.body.tool_choice,"auto",JSON.stringify(choice));
      assert.equal(sent.body.tools.length,1,"the turn keeps its tools");
    }
  }finally{rmSync(root,{recursive:true,force:true})}
});

test("on Meta a turn that must answer without a tool is sent without its tools, and is answered",async()=>{
  const root=home();
  try{
    const stand=api(),manager=new ProviderManager({env:{TREBELL_HOME:root,META_API_KEY:"meta-test-key"},fetchFn:stand.fetchFn});
    const result=await manager.turn("meta",request("meta","muse-spark-1.3-contributor","none"));
    assert.equal(result.text,"done");
    const [sent]=stand.requests;
    assert.deepEqual(sent.body.tools,[]);assert.equal("tool_choice" in sent.body,false,"no tool_choice at all");
  }finally{rmSync(root,{recursive:true,force:true})}
});

test("a provider whose tool_choice takes every value is sent the choice the turn asked for",async()=>{
  const root=home();
  try{
    const stand=api(),manager=new ProviderManager({env:{TREBELL_HOME:root,XAI_API_KEY:"xai-test-key"},fetchFn:stand.fetchFn});
    await manager.turn("xai",request("xai","grok-4.7","required"));
    const [sent]=stand.requests;
    assert.equal(sent.body.tool_choice,"required");assert.equal(sent.body.tools.length,1);
  }finally{rmSync(root,{recursive:true,force:true})}
});
