import assert from "node:assert/strict";
import { runNativeAgentTurn } from "../src/native-agent-loop.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { nativeSystemPrompt } from "../src/native-system-prompt.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";
import { providerTurnToChat } from "../src/provider-turn.mjs";

const tools=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,workspaceTools:true,terminal:true,browser:false,computer:false,sourceControl:false,delegation:false});
const listing={root:"C:/repo/src",entries:[{name:"api",relativePath:"api",isDirectory:true,isFile:false,depth:0},{name:"index.mjs",relativePath:"index.mjs",isDirectory:false,isFile:true,depth:0},{name:"nested.mjs",relativePath:"api/nested.mjs",isDirectory:false,isFile:true,depth:1}],truncated:false};
const expectedText="Immediate entries in src:\n- api/\n- index.mjs",messages=[{role:"system",content:nativeSystemPrompt({tools,permissionMode:"full",projectless:false})},{role:"user",content:"List the top-level files and folders in `src`."}];

async function scenario({directExactListStatus}){
  let providerInferences=0,toolCalls=0;const requests=[];
  const result=await runNativeAgentTurn({
    model:"deepseek-v4.1",provider:"fixture",messages,tools,directExactListStatus,maxModelTurns:4,maxToolCalls:4,
    providerTurn:async request=>{
      providerInferences++;const requestMessages=Array.isArray(request.messages)?request.messages:[],requestTools=Array.isArray(request.tools)?request.tools:[],wire=providerTurnToChat({...request,model:"deepseek-v4.1"});
      requests.push({tokens:Number(nativeRequestMetrics(requestMessages,requestTools)?.totalLogical?.estimatedTokens||0),wireBytes:Buffer.byteLength(JSON.stringify(wire),"utf8")});
      if(providerInferences===1)return {text:"",toolCalls:[{id:"list",namespace:"trebell_workspace",name:"list",arguments:{path:"src",depth:1,limit:1000}}],usage:{}};
      assert.equal(providerInferences,2,"baseline should need only one final reporting inference after the exact list");return {text:expectedText,toolCalls:[],usage:{}};
    },
    executeTool:async call=>{toolCalls++;assert.equal(call.namespace,"trebell_workspace");assert.equal(call.name,"list");assert.deepEqual(call.arguments,{path:"src",depth:1,limit:1000});return listing},
  });
  assert.equal(toolCalls,1);assert.equal(result.text,expectedText);
  return {providerInferences,toolCalls,modelTurns:result.modelTurns,providerVisibleEstimatedTokens:requests.reduce((sum,item)=>sum+item.tokens,0),wireRequestBytes:requests.reduce((sum,item)=>sum+item.wireBytes,0)};
}

const baseline=await scenario({directExactListStatus:false}),candidate=await scenario({directExactListStatus:true});
assert.equal(baseline.providerInferences,2);assert.equal(candidate.providerInferences,0);assert.equal(candidate.modelTurns,0);assert.equal(candidate.toolCalls,baseline.toolCalls);
console.log(JSON.stringify({ok:true,benchmark:"native-direct-exact-list-zero-latency",baseline,candidate,savings:{providerInferences:baseline.providerInferences-candidate.providerInferences,providerVisibleEstimatedTokens:baseline.providerVisibleEstimatedTokens-candidate.providerVisibleEstimatedTokens,wireRequestBytes:baseline.wireRequestBytes-candidate.wireRequestBytes}},null,2));
