import assert from "node:assert/strict";
import { NativeAgentSession } from "../src/native-agent-session.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";

async function runScenario({name,namespace,toolName,args,result}){
  const requests=[],events=[];let providerCalls=0;
  const session=new NativeAgentSession({
    model:"fixture-model",
    provider:"fixture",
    tools:[{type:"namespace",name:namespace,tools:[{name:toolName}]}],
    onEvent:event=>events.push(event),
    providerTurn:async request=>{
      requests.push(structuredClone(request));providerCalls++;
      if(providerCalls===1)return {id:name+"-1",text:"",toolCalls:[{id:name+"-a",namespace,name:toolName,arguments:JSON.stringify(args)}],usage:{}};
      if(providerCalls===2)return {id:name+"-2",text:"",toolCalls:[{id:name+"-b",namespace,name:toolName,arguments:JSON.stringify(args)}],usage:{}};
      return {id:"done",text:"done",toolCalls:[],usage:{}};
    },
    executeTool:async()=>structuredClone(result),
  });
  await session.start({providerSessionId:"native-observation-dedupe-"+name,model:"fixture-model"});
  await session.prompt([{type:"text",text:"Run the same read twice."}]);
  assert.equal(requests.length,3);
  const first=String(requests[1].messages.at(-1)?.content||""),repeated=String(requests[2].messages.at(-1)?.content||"");
  const event=events.find(item=>item.name==="native.tool.observation_deduplicated"),metrics=nativeRequestMetrics(requests[2].messages,requests[2].tools);
  return {
    name,
    firstObservationChars:first.length,
    repeatedObservationChars:repeated.length,
    savedObservationChars:Math.max(0,first.length-repeated.length),
    finalRequestMessageChars:JSON.stringify(requests[2].messages).length,
    finalToolResultEstimatedTokens:Number(metrics.toolResults?.estimatedTokens||0),
    deduplicated:/byte-identical/i.test(repeated),
    eventSavedBytes:Number(event?.data?.savedBytes||0),
  };
}

const results=[];
results.push(await runScenario({
  name:"repository-search",
  namespace:"trebell_repo",
  toolName:"search_code",
  args:{query:"needle"},
  result:{
    query:"needle",
    matches:Array.from({length:80},(_,index)=>({
      path:"src/file-"+index+".mjs",
      line:index+1,
      text:"needle "+"x".repeat(80),
    })),
  },
}));
results.push(await runScenario({
  name:"workspace-list",
  namespace:"trebell_workspace",
  toolName:"list",
  args:{path:"src"},
  result:{
    path:"src",
    entries:Array.from({length:120},(_,index)=>({
      path:"src/module-"+String(index).padStart(3,"0")+".mjs",
      type:"file",
      size:1000+index,
    })),
  },
}));

console.log(JSON.stringify({ok:true,results},null,2));
