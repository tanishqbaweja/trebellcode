import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { compactDirectTerminalStatusProviderHistory } from "../src/native-tool-history.mjs";

function baseline(messages=[]){
  const source=Array.isArray(messages)?messages:[],out=[];let count=0;
  for(let index=0;index<source.length;index++){
    const assistant=source[index],tool=source[index+1],receipt=source[index+2],calls=Array.isArray(assistant?.toolCalls)?assistant.toolCalls:[];
    if(assistant?.role==="assistant"&&calls.length===1&&tool?.role==="tool"&&receipt?.role==="assistant"){
      const call=calls[0],handle=(()=>{const content=String(tool.content||""),start=content.indexOf("{");if(start<0)return "";try{return String(JSON.parse(content.slice(start))?._trebell_output?.handle||"")}catch{return ""}})();
      if(/^native-direct-terminal-status-\d+$/.test(String(call?.id||""))&&String(call?.id||"")===String(tool.toolCallId||"")&&call?.namespace==="trebell_terminal"&&call?.name==="run"&&!Array.isArray(receipt?.toolCalls)&&typeof receipt.content==="string"&&receipt.content.trim()&&/^out_[a-zA-Z0-9-]{8,80}$/.test(handle)){
        const note=`[Full command output handle: ${handle}; inspect via trebell_output/inspect only if needed.]`;out.push({...receipt,content:receipt.content+"\n"+note});index+=2;count++;continue;
      }
    }
    out.push(source[index]);
  }
  return {messages:out,count,savedChars:Math.max(0,JSON.stringify(source).length-JSON.stringify(out).length)};
}

const history=Array.from({length:4000},(_,index)=>({role:index%2?"assistant":"user",content:`history-${index} `+"x".repeat(320)})),iterations=120;
const expected=baseline(history),actual=compactDirectTerminalStatusProviderHistory(history);assert.deepEqual(actual,expected);

function measure(fn){
  const started=performance.now();let count=0;
  for(let index=0;index<iterations;index++)count+=fn(history).count;
  return {durationMs:Number((performance.now()-started).toFixed(3)),count};
}

for(let index=0;index<5;index++){baseline(history);compactDirectTerminalStatusProviderHistory(history)}
const baselineRun=measure(baseline),candidateRun=measure(compactDirectTerminalStatusProviderHistory),savedMs=Number((baselineRun.durationMs-candidateRun.durationMs).toFixed(3)),savedPercent=baselineRun.durationMs?Number((savedMs/baselineRun.durationMs*100).toFixed(2)):0;
console.log(JSON.stringify({ok:true,benchmark:"native-direct-terminal-history-local-overhead",messages:history.length,iterations,baseline:baselineRun,candidate:candidateRun,savings:{durationMs:savedMs,percent:savedPercent},note:"Deterministic local CPU/allocation benchmark. No provider latency, token, or billing claim."},null,2));
