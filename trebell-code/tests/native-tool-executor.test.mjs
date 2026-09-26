import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextEngine } from "../src/context-engine.mjs";
import { createNativeToolExecutor } from "../src/native-tool-executor.mjs";
import { runNativeAgentTurn } from "../src/native-agent-loop.mjs";

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"trebell-native-tools-"));await mkdir(join(root,"src"),{recursive:true});
  await writeFile(join(root,"src","session.js"),"export class SessionManager { refresh(){ return true; } }\n","utf8");
  return root;
}

test("Native repository tools execute in-process through Context Engine and shared policy",async()=>{
  const root=await fixture();
  try{
    const executor=createNativeToolExecutor({contextEngine:new ContextEngine(),root,policyContext:{permissionProfile:"read-only",runtime:"native"}});
    const result=await executor({id:"repo-1",namespace:"trebell_repo",name:"search_symbols",arguments:{query:"SessionManager"}});
    assert.equal(result.query,"SessionManager");assert.ok(result.data.some(item=>item.name==="SessionManager"&&item.path==="src/session.js"));
    const invalid=await executor({id:"repo-2",namespace:"trebell_repo",name:"search_symbols",arguments:{}});
    assert.equal(invalid.success,false);assert.match(invalid.error,/query/i);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Native shared tools stay delegated but still pass through gateway requirements",async()=>{
  const calls=[];
  const executor=createNativeToolExecutor({
    policyContext:{permissionProfile:"read-only",runtime:"native",desktopAvailable:true},
    executeShared:async call=>{calls.push(call);return {contentItems:[{type:"inputText",text:"snapshot-ok"}]};},
  });
  const result=await executor({id:"browser-1",namespace:"trebell_browser",name:"snapshot",arguments:{}});
  assert.deepEqual(result,{contentItems:[{type:"inputText",text:"snapshot-ok"}]});assert.equal(calls.length,1);
  const denied=createNativeToolExecutor({policyContext:{permissionProfile:"auto",runtime:"native",desktopAvailable:true},executeShared:async()=>{throw new Error("must not execute")}});
  const click=await denied({id:"computer-1",namespace:"trebell_computer",name:"click",arguments:{x:1,y:2}});
  assert.equal(click.success,false);assert.match(click.error,/full access/i);
});

test("Native supervised tools require explicit confirmation before delegated execution",async()=>{
  let executions=0;
  const withoutConfirm=createNativeToolExecutor({policyContext:{permissionProfile:"supervised",runtime:"native",desktopAvailable:true},executeShared:async()=>{executions++;return "ok"}});
  const pending=await withoutConfirm({namespace:"trebell_browser",name:"snapshot",arguments:{}});
  assert.equal(pending.success,false);assert.equal(pending.confirmationRequired,true);assert.equal(executions,0);
  const confirmed=createNativeToolExecutor({policyContext:{permissionProfile:"supervised",runtime:"native",desktopAvailable:true},confirm:async()=>true,executeShared:async()=>{executions++;return "ok"}});
  assert.equal(await confirmed({namespace:"trebell_browser",name:"snapshot",arguments:{}}),"ok");assert.equal(executions,1);
});

test("Native tool observations preserve uncertain external outcomes so the model does not blindly repeat them",async()=>{
  const executor=createNativeToolExecutor({
    policyContext:{permissionProfile:"full",runtime:"native",desktopAvailable:true},
    executeShared:async()=>{throw Object.assign(new Error("desktop connection lost after click"),{code:"ECONNRESET"})},
  });
  const result=await executor({namespace:"trebell_browser",name:"click",arguments:{ref:"send-button"}});
  assert.equal(result.success,false);assert.equal(result.uncertain,true);assert.equal(result.retrySafe,false);assert.match(result.error,/Inspect the real-world state before repeating/i);
});

test("Native agent loop receives only the repository observation, not gateway internals",async()=>{
  const root=await fixture();
  try{
    const executor=createNativeToolExecutor({contextEngine:new ContextEngine(),root,policyContext:{permissionProfile:"read-only",runtime:"native"}});let turn=0;
    const result=await runNativeAgentTurn({
      model:"fixture",messages:[{role:"user",content:"Find SessionManager"}],
      providerTurn:async request=>{
        turn++;
        if(turn===1)return {text:"",toolCalls:[{id:"repo-call",namespace:"trebell_repo",name:"search_symbols",arguments:'{"query":"SessionManager"}'}],usage:{}};
        const observation=request.messages.at(-1);assert.equal(observation.role,"tool");assert.match(observation.content,/SessionManager/);assert.doesNotMatch(observation.content,/authorization|requirementFailed|policy/i);
        return {text:"Found it.",toolCalls:[],usage:{}};
      },executeTool:executor,
    });
    assert.equal(result.text,"Found it.");assert.equal(result.toolCalls,1);
  }finally{await rm(root,{recursive:true,force:true})}
});
