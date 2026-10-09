import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextEngine } from "../src/context-engine.mjs";
import { createNativeToolExecutor } from "../src/native-tool-executor.mjs";
import { runNativeAgentTurn } from "../src/native-agent-loop.mjs";
import { ADVANCED_REPOSITORY_TOOL_NAMES, repositoryDynamicToolNamespace } from "../src/repository-tool-catalog.mjs";

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

test("Native repository paths accept workspace-root-style leading slashes",async()=>{
  const root=await fixture();
  try{
    const executor=createNativeToolExecutor({contextEngine:new ContextEngine(),root,policyContext:{permissionProfile:"read-only",runtime:"native"}});
    const result=await executor({namespace:"trebell_repo",name:"read_source",arguments:{path:"/src/session.js"}});
    assert.equal(result.path,"src/session.js");assert.match(result.content,/SessionManager/);
    const escaped=await executor({namespace:"trebell_repo",name:"read_source",arguments:{path:"../outside.js"}});
    assert.equal(escaped.success,false);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Native advanced repository capabilities use the stable discover/invoke interface",async()=>{
  const root=await fixture();
  try{
    const executor=createNativeToolExecutor({
      contextEngine:new ContextEngine(),root,policyContext:{permissionProfile:"read-only",runtime:"native"},
      discoverRepositoryTools:()=>({success:true,capabilities:[{name:"git_history"}]}),
    });
    const direct=await executor({namespace:"trebell_repo",name:"git_history",arguments:{limit:2}});
    assert.equal(direct.success,false);assert.match(direct.error,/trebell_repo\/invoke/i);
    const invoked=await executor({namespace:"trebell_repo",name:"invoke",arguments:{name:"git_history",arguments:{limit:2}}});
    assert.ok(invoked&&typeof invoked==="object");
    const invalid=await executor({namespace:"trebell_repo",name:"invoke",arguments:{name:"git_history",arguments:{limit:1000}}});
    assert.equal(invalid.success,false);assert.match(invalid.error,/100|less than or equal|too big/i);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Native trebell_repo/invoke runs an advanced capability directly without a prior discover",async()=>{
  const root=await fixture();
  try{
    let discoverCalls=0;
    const executor=createNativeToolExecutor({
      contextEngine:new ContextEngine(),root,policyContext:{permissionProfile:"read-only",runtime:"native"},
      discoverRepositoryTools:()=>{discoverCalls++;throw new Error("discover must not be required before invoke")},
    });
    const relations=await executor({namespace:"trebell_repo",name:"invoke",arguments:{name:"file_relations",arguments:{path:"/src/session.js"}}});
    assert.equal(relations.path,"src/session.js");assert.ok(relations.definitions.some(item=>item.name==="SessionManager"));
    const references=await executor({namespace:"trebell_repo",name:"invoke",arguments:{name:"symbol_references",arguments:{name:"SessionManager"}}});
    assert.ok(references.data.some(item=>item.path==="src/session.js"&&item.definition===true));
    assert.equal(discoverCalls,0);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Native invoke argument errors keep the validation message and add the capability input schema",async()=>{
  const calls=[];
  const contextEngine={gitHistory(args){calls.push(args);return {commits:[]}},assessVerification(args){calls.push(args);return {state:"verified"}}};
  const executor=createNativeToolExecutor({contextEngine,root:"/repo",policyContext:{permissionProfile:"read-only",runtime:"native"}});
  const discoveredSchema=name=>repositoryDynamicToolNamespace({names:[name],includeDiscovery:false})[0].tools[0].inputSchema;
  const tooBig=await executor({namespace:"trebell_repo",name:"invoke",arguments:{name:"git_history",arguments:{limit:1000}}});
  assert.equal(tooBig.success,false);assert.match(tooBig.error,/too_big/);assert.match(tooBig.error,/<=100/);
  const marker="\nInput schema for git_history: ";
  assert.ok(tooBig.error.includes(marker),tooBig.error);
  // The schema returned with the error is exactly what trebell_repo/discover would have returned.
  assert.deepEqual(JSON.parse(tooBig.error.slice(tooBig.error.indexOf(marker)+marker.length)),discoveredSchema("git_history"));
  assert.doesNotMatch(tooBig.error,/\$schema/);
  const missingPlan=await executor({namespace:"trebell_repo",name:"invoke",arguments:{name:"verification_assess",arguments:{evidence:[]}}});
  assert.equal(missingPlan.success,false);assert.match(missingPlan.error,/"plan"/);
  assert.ok(missingPlan.error.endsWith("\nInput schema for verification_assess: "+JSON.stringify(discoveredSchema("verification_assess"))),missingPlan.error);
  assert.deepEqual(calls,[],"handlers must not run when arguments fail validation");
  assert.deepEqual(await executor({namespace:"trebell_repo",name:"invoke",arguments:{name:"git_history",arguments:{limit:5}}}),{commits:[]});
  assert.deepEqual(calls,[{root:"/repo",io:null,path:"",limit:5}]);
});

test("Native invoke names every valid advanced capability when the requested one is unknown or core",async()=>{
  const executor=createNativeToolExecutor({contextEngine:{},root:"/repo",policyContext:{permissionProfile:"read-only",runtime:"native"}});
  for(const name of ["git_log","read_source"]){
    const result=await executor({namespace:"trebell_repo",name:"invoke",arguments:{name,arguments:{}}});
    assert.equal(result.success,false);
    assert.ok(result.error.startsWith("Unknown or non-advanced repository capability: "+name+". Valid capabilities: "),result.error);
    assert.deepEqual(result.error.split("Valid capabilities: ")[1].replace(/\.$/,"").split(", "),[...ADVANCED_REPOSITORY_TOOL_NAMES]);
  }
});

test("Native invoke leaves capability failures after validation unchanged",async()=>{
  const executor=createNativeToolExecutor({
    contextEngine:{gitHistory(){throw new Error("git history is unavailable in this workspace")}},root:"/repo",
    policyContext:{permissionProfile:"read-only",runtime:"native"},
  });
  const result=await executor({namespace:"trebell_repo",name:"invoke",arguments:{name:"git_history",arguments:{limit:5}}});
  assert.equal(result.success,false);assert.equal(result.error,"git history is unavailable in this workspace");
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

test("Native MCP observations are redacted before they return to the model loop",async()=>{
  const secret="fixture-mcp-secret-value";
  const definition={
    namespace:"mcp_fixture",name:"read-secret",source:"mcp",
    policy:{kind:"read",riskLevel:"low",reversibility:"not-applicable",idempotent:true,externalSideEffect:false,asyncSafe:true},
    requirements:{desktop:false,workspace:false,project:false,fullAccess:false,delegation:false},
    rawDefinition:{serverId:"fixture",toolName:"read-secret"},
  };
  const mcpBroker={
    toolDefinition:(namespace,name)=>namespace==="mcp_fixture"&&name==="read-secret"?definition:null,
    call:async()=>({success:true,contentItems:[{type:"inputText",text:"tool returned "+secret}]}),
  };
  const executor=createNativeToolExecutor({
    mcpBroker,
    environment:{API_TOKEN:secret},
    policyContext:{permissionProfile:"read-only",runtime:"native"},
  });
  const result=await executor({namespace:"mcp_fixture",name:"read-secret",arguments:{}});
  assert.equal(result.success,true);
  assert.match(result.contentItems[0].text,/\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));
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
