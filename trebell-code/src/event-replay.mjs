import { boundDiagnosticValue } from "./diagnostic-bounds.mjs";
import { redactSecretValue } from "./secret-redactor.mjs";
import { reduceEventJournal } from "./event-state-reducer.mjs";

function text(value,max=4000){return String(value??"").trim().slice(0,max)}
function numeric(value){const number=Number(value);return Number.isFinite(number)?number:null}

function normalizeReplayEvent(event,index,environment){
  if(!event||typeof event!=="object")return null;
  const at=numeric(event.at),name=text(event.name,200);if(at==null||!name)return null;
  const data=boundDiagnosticValue(redactSecretValue(event.data??{},{environment,maxDepth:10,maxArray:100,maxFields:200}),{maxChars:16*1024,maxFields:300,maxDepth:10});
  return {
    id:text(event.id,300)||("replay-"+index),
    at,
    runtime:text(event.runtime,120)||null,provider:text(event.provider,200)||null,
    environmentId:text(event.environmentId,300)||null,threadId:text(event.threadId,300)||null,turnId:text(event.turnId,300)||null,
    category:text(event.category,80)||"runtime",name,status:text(event.status,80)||null,data,
    _order:index,
  };
}

export function createReplayFixture(events=[],{environment=process.env,maxEvents=5000}={}){
  const source=Array.isArray(events)?events:[],cap=Math.max(1,Math.min(50_000,Math.trunc(Number(maxEvents)||5000))),normalized=[],invalidIndexes=[];
  let outOfOrder=0,lastAt=-Infinity;
  for(let index=0;index<source.length&&normalized.length<cap;index++){
    const event=normalizeReplayEvent(source[index],index,environment);
    if(!event){invalidIndexes.push(index);continue}
    if(event.at<lastAt)outOfOrder++;lastAt=event.at;normalized.push(event);
  }
  const byId=new Map(),duplicateIds=[];
  for(const event of normalized){
    if(byId.has(event.id))duplicateIds.push(event.id);
    byId.set(event.id,event);
  }
  const canonical=[...byId.values()].sort((a,b)=>a.at-b.at||a._order-b._order).map(({_order,...event})=>event);
  return {
    version:1,createdAt:Date.now(),
    events:canonical,
    diagnostics:{
      inputEvents:source.length,acceptedEvents:normalized.length,replayEvents:canonical.length,
      truncated:source.length>cap,invalidIndexes:invalidIndexes.slice(0,100),duplicateIds:[...new Set(duplicateIds)].slice(0,100),outOfOrder,
    },
  };
}

export function replayEventFixture(fixture={},options={}){
  const untilAt=options.untilAt==null?Infinity:Number(options.untilAt),threadId=options.threadId==null?null:String(options.threadId);
  const events=(Array.isArray(fixture?.events)?fixture.events:[]).filter(event=>(Number(event.at)||0)<=untilAt&&(!threadId||String(event.threadId||"")===threadId));
  const threads=reduceEventJournal(events),categories={},runtimes={};
  for(const event of events){
    categories[event.category]=(categories[event.category]||0)+1;
    const runtime=event.runtime||"unknown";runtimes[runtime]=(runtimes[runtime]||0)+1;
  }
  return {
    version:Number(fixture?.version)||1,
    untilAt:Number.isFinite(untilAt)?untilAt:null,
    eventCount:events.length,
    threadCount:Object.keys(threads).length,
    threads,categories,runtimes,
    firstAt:events.length?events[0].at:null,lastAt:events.length?events.at(-1).at:null,
    sourceDiagnostics:fixture?.diagnostics||null,
  };
}

export function replayDiff(before={},after={}){
  const beforeThreads=before.threads||{},afterThreads=after.threads||{},ids=new Set([...Object.keys(beforeThreads),...Object.keys(afterThreads)]),threads={};
  for(const id of ids){
    const left=beforeThreads[id]||null,right=afterThreads[id]||null;
    if(JSON.stringify(left)===JSON.stringify(right))continue;
    threads[id]={
      status:{before:left?.status??null,after:right?.status??null},
      activeTurnId:{before:left?.activeTurnId??null,after:right?.activeTurnId??null},
      eventCount:{before:left?.eventCount??0,after:right?.eventCount??0},
      verification:{before:left?.verification??null,after:right?.verification??null},
      budget:{before:left?.budget??null,after:right?.budget??null},
      recovery:{before:left?.recovery??null,after:right?.recovery??null},
    };
  }
  return {changedThreadIds:Object.keys(threads),threads};
}
