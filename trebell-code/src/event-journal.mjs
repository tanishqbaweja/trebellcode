import { appendFile, rename, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { trebellHome } from "./paths.mjs";
import { boundDiagnosticValue } from "./diagnostic-bounds.mjs";
import { redactSecretValue } from "./secret-redactor.mjs";

const DEFAULT_MAX_RECORDS=5000;
const DEFAULT_MAX_BYTES=8*1024*1024;
const NOISY_METHOD=/(?:^initialize$|\/delta$|\/progress$|tokenUsage\/updated$|reasoning\/activity$|\/list$|\/read$|\/get$|\/search$|capabilities\/read$)/i;
function clone(value){return JSON.parse(JSON.stringify(value))}

function compactProtocolData(method,params={}){
  const turn=params.turn||null,item=params.item||null,thread=params.thread||null;
  const data={};
  if(params.model)data.model=String(params.model);
  if(params.cwd)data.cwd=String(params.cwd);
  if(Array.isArray(params.input))data.inputItems=params.input.length;
  if(params.additionalContext)data.additionalContextKeys=Object.keys(params.additionalContext);
  if(thread)data.thread={id:thread.id||null,status:thread.status?.type||thread.status||null,model:thread.model||null,cwd:thread.cwd||null};
  if(turn)data.turn={id:turn.id||null,status:turn.status||null,durationMs:turn.durationMs??null};
  if(item)data.item={
    id:item.id||null,type:item.type||null,status:item.status||null,
    command:Array.isArray(item.command)?item.command.slice(0,20).map((part,index,array)=>/^(?:--api-key|--token|--password|--secret)$/i.test(String(array[index-1]||""))?"[redacted]":part):undefined,
    tool:item.tool||item.name||undefined,server:item.server||undefined,
    exitCode:item.exitCode??null,durationMs:item.durationMs??null,success:item.success??null,
  };
  if(params.status&&!data.status)data.status=params.status?.type||params.status;
  if(params.reason)data.reason=String(params.reason).slice(0,1000);
  if(params.message)data.message=String(params.message).slice(0,2000);
  if(params.checkpointId)data.checkpointId=String(params.checkpointId).slice(0,200);
  if(/requestApproval|Approval$/i.test(method))data.approvalKind=method;
  return data;
}

export class EventJournal{
  constructor(env=process.env,{maxRecords=DEFAULT_MAX_RECORDS,maxBytes=DEFAULT_MAX_BYTES}={}){
    this.env=env;this.maxRecords=Math.max(100,Math.trunc(Number(maxRecords)||DEFAULT_MAX_RECORDS));
    this.maxBytes=Math.max(256*1024,Math.trunc(Number(maxBytes)||DEFAULT_MAX_BYTES));
    this.path=join(trebellHome(env),"events.jsonl");mkdirSync(dirname(this.path),{recursive:true});
    this.recent=[];this.bytes=0;this.writeQueue=Promise.resolve();this.lastError=null;
    try{
      if(existsSync(this.path)){
        this.bytes=statSync(this.path).size;
        const text=readFileSync(this.path,"utf8");
        const lines=text.split(/\r?\n/).filter(Boolean).slice(-this.maxRecords);
        this.recent=lines.map(line=>{try{return JSON.parse(line)}catch{return null}}).filter(Boolean);
      }
    }catch{this.recent=[];this.bytes=0}
  }

  record(entry={}){
    const cleaned=boundDiagnosticValue(redactSecretValue(entry.data??{},{environment:this.env,maxDepth:10,maxArray:100,maxFields:200}),{maxChars:16*1024,maxFields:300,maxDepth:10});
    const record={
      id:String(entry.id||randomUUID()),at:Number(entry.at)||Date.now(),
      runtime:entry.runtime?String(entry.runtime):null,provider:entry.provider?String(entry.provider):null,
      environmentId:entry.environmentId?String(entry.environmentId):null,
      threadId:entry.threadId?String(entry.threadId):null,turnId:entry.turnId?String(entry.turnId):null,
      category:String(entry.category||"runtime").slice(0,80),name:String(entry.name||"event").slice(0,200),
      status:entry.status?String(entry.status).slice(0,80):null,data:cleaned,
    };
    this.recent.push(record);if(this.recent.length>this.maxRecords)this.recent.splice(0,this.recent.length-this.maxRecords);
    const line=JSON.stringify(record)+"\n";this.bytes+=Buffer.byteLength(line);
    this.writeQueue=this.writeQueue.then(async()=>{
      await appendFile(this.path,line,{encoding:"utf8",mode:0o600});
      if(this.bytes>this.maxBytes)await this.#compact();
      this.lastError=null;
    }).catch(error=>{
      this.lastError={at:Date.now(),message:String(error?.message||error||"Event journal write failed").slice(0,2000)};
    });
    return clone(record);
  }

  recordProtocol({runtime=null,provider=null,environmentId=null,direction="runtime",method="",params={}}={}){
    if(!method||NOISY_METHOD.test(method))return null;
    const threadId=params.threadId||params.thread?.id||null;
    const turnId=params.turnId||params.turn?.id||null;
    const status=params.turn?.status||params.item?.status||params.status?.type||params.status||null;
    return this.record({runtime,provider,environmentId,threadId,turnId,category:direction,name:method,status,data:compactProtocolData(method,params)});
  }

  list({threadId=null,turnId=null,runtime=null,category=null,limit=200,before=null,after=null}={}){
    const max=Math.max(1,Math.min(1000,Math.trunc(Number(limit)||200)));
    const beforeValue=before==null?Infinity:Number(before),afterValue=after==null?-Infinity:Number(after);
    const beforeCutoff=Number.isFinite(beforeValue)?beforeValue:Infinity,afterCutoff=Number.isFinite(afterValue)?afterValue:-Infinity;
    const items=[];
    for(let index=this.recent.length-1;index>=0&&items.length<max;index--){
      const item=this.recent[index];if(item.at>=beforeCutoff||item.at<afterCutoff)continue;
      if(threadId&&item.threadId!==String(threadId))continue;
      if(turnId&&item.turnId!==String(turnId))continue;
      if(runtime&&item.runtime!==String(runtime))continue;
      if(category&&item.category!==String(category))continue;
      items.push(item);
    }
    return clone(items);
  }

  status(){
    return {path:this.path,records:this.recent.length,bytes:this.bytes,lastError:this.lastError?clone(this.lastError):null};
  }

  async #compact(){
    const tmp=this.path+".tmp";
    const payload=this.recent.map(item=>JSON.stringify(item)).join("\n")+(this.recent.length?"\n":"");
    await writeFile(tmp,payload,{encoding:"utf8",mode:0o600});await rename(tmp,this.path);this.bytes=Buffer.byteLength(payload);
  }

  async flush(){await this.writeQueue}
}
