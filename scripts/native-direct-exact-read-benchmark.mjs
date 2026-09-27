import assert from "node:assert/strict";
import { runNativeAgentTurn } from "../src/native-agent-loop.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { nativeSystemPrompt } from "../src/native-system-prompt.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";
import { providerTurnToChat } from "../src/provider-turn.mjs";

const tools=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,workspaceTools:true,terminal:true,browser:false,computer:false,sourceControl:false,delegation:false});
const fileContent="export const mode = 'strict';\nexport const retries = 3;\n";
const messages=[{role:"system",content:nativeSystemPrompt({tools,permissionMode:"full",projectless:false})},{role:"user",content:"Read `src/config.mjs` and show me its contents."}];

async function scenario({directExactReadStatus}){
  let providerInferences=0,toolCalls=0;const requests=[];
  const result=await runNativeAgentTurn({
    model:"deepseek-v4.1",provider:"fixture",messages,tools,directExactReadStatus,maxModelTurns:4,maxToolCalls:4,
    providerTurn:async request=>{
      providerInferences++;const requestMessages=Array.isArray(request.messages)?request.messages:[],requestTools=Array.isArray(request.tools)?request.tools:[],wire=providerTurnToChat({...request,model:"deepseek-v4.1"});
      requests.push({tokens:Number(nativeRequestMetrics(requestMessages,requestTools)?.totalLogical?.estimatedTokens||0),wireBytes:Buffer.byteLength(JSON.stringify(wire),"utf8")});
      if(providerInferences===1)return {text:"",toolCalls:[{id:"read",namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/config.mjs"}}],usage:{}};
      assert.equal(providerInferences,2,"baseline should need only one final reporting inference after the exact read");return {text:`Contents of src/config.mjs:\n\n${fileContent}`,toolCalls:[],usage:{}};
    },
    executeTool:async call=>{toolCalls++;assert.equal(call.namespace,"trebell_workspace");assert.equal(call.name,"read_file");assert.deepEqual(call.arguments,{path:"src/config.mjs"});return {path:"C:/repo/src/config.mjs",name:"config.mjs",content:fileContent,size:Buffer.byteLength(fileContent,"utf8")}},
  });
  assert.equal(toolCalls,1);assert.equal(result.text,`Contents of src/config.mjs:\n\n${fileContent}`);
  return {providerInferences,toolCalls,modelTurns:result.modelTurns,providerVisibleEstimatedTokens:requests.reduce((sum,item)=>sum+item.tokens,0),wireRequestBytes:requests.reduce((sum,item)=>sum+item.wireBytes,0)};
}

const baseline=await scenario({directExactReadStatus:false}),candidate=await scenario({directExactReadStatus:true});
assert.equal(baseline.providerInferences,2);assert.equal(candidate.providerInferences,0);assert.equal(candidate.modelTurns,0);assert.equal(candidate.toolCalls,baseline.toolCalls);
console.log(JSON.stringify({ok:true,benchmark:"native-direct-exact-read-zero-latency",baseline,candidate,savings:{providerInferences:baseline.providerInferences-candidate.providerInferences,providerVisibleEstimatedTokens:baseline.providerVisibleEstimatedTokens-candidate.providerVisibleEstimatedTokens,wireRequestBytes:baseline.wireRequestBytes-candidate.wireRequestBytes}},null,2));
