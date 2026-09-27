import assert from "node:assert/strict";
import { NativeAgentSession } from "../src/native-agent-session.mjs";

const requests=[];
const events=[];
let providerCalls=0;

const session=new NativeAgentSession({
  model:"fixture-model",
  provider:"fixture",
  tools:[{type:"namespace",name:"trebell_repo",tools:[{name:"search_code"}]}],
  onEvent:event=>events.push(event),
  providerTurn:async request=>{
    requests.push(structuredClone(request));
    providerCalls++;
    if(providerCalls===1)return {id:"search-1",text:"",toolCalls:[{id:"search-a",namespace:"trebell_repo",name:"search_code",arguments:'{"query":"needle"}'}],usage:{}};
    if(providerCalls===2)return {id:"search-2",text:"",toolCalls:[{id:"search-b",namespace:"trebell_repo",name:"search_code",arguments:'{"query":"needle"}'}],usage:{}};
    return {id:"done",text:"done",toolCalls:[],usage:{}};
  },
  executeTool:async()=>({
    query:"needle",
    matches:Array.from({length:80},(_,index)=>({
      path:"src/file-"+index+".mjs",
      line:index+1,
      text:"needle "+"x".repeat(80),
    })),
  }),
});

await session.start({providerSessionId:"native-observation-dedupe-benchmark",model:"fixture-model"});
await session.prompt([{type:"text",text:"Run the same repository search twice."}]);

assert.equal(requests.length,3);
const first=String(requests[1].messages.at(-1)?.content||"");
const repeated=String(requests[2].messages.at(-1)?.content||"");
const event=events.find(item=>item.name==="native.tool.observation_deduplicated");

console.log(JSON.stringify({
  ok:true,
  firstObservationChars:first.length,
  repeatedObservationChars:repeated.length,
  savedObservationChars:Math.max(0,first.length-repeated.length),
  deduplicated:/byte-identical/i.test(repeated),
  eventSavedBytes:Number(event?.data?.savedBytes||0),
},null,2));
