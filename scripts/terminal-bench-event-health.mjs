import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync=promisify(execFile);

function rows(text){
  const out=[];
  for(const line of String(text||"").split(/\r?\n/)){
    if(!line.trim())continue;
    try{out.push(JSON.parse(line))}catch{}
  }
  return out;
}

export function summarizeNativeEventHealth(text){
  const counts={modelRequested:0,modelCompleted:0,modelRetrying:0,toolRequested:0,toolCompleted:0};
  let lastAtMs=null,lastEvent=null;
  for(const row of rows(text)){
    const name=String(row?.name||"");
    if(name==="native.model.requested")counts.modelRequested++;
    else if(name==="native.model.completed")counts.modelCompleted++;
    else if(name==="native.model.retrying")counts.modelRetrying++;
    else if(name==="native.tool.requested")counts.toolRequested++;
    else if(name==="native.tool.completed")counts.toolCompleted++;
    const atMs=Number(row?.atMs);
    if(Number.isFinite(atMs)&&(lastAtMs==null||atMs>=lastAtMs)){lastAtMs=atMs;lastEvent=name||null}
  }
  return {kind:"native",counts,lastAtMs,lastEvent,pendingTools:Math.max(0,counts.toolRequested-counts.toolCompleted)};
}

export function summarizeCodexEventHealth(text){
  const counts={reasoningCompleted:0,agentMessages:0,toolCalls:0,commandCompleted:0,commandFailed:0,usageRecords:0};
  let lastTimestamp=null,lastEvent=null;
  for(const row of rows(text)){
    const type=String(row?.type||""),payload=row?.payload||{};
    if(type==="response_item"&&payload.type==="custom_tool_call"){counts.toolCalls++;lastEvent="ToolCall"}
    else if(type==="token_usage_record"){counts.usageRecords++;lastEvent="TokenUsage"}
    else if(type==="event_msg"&&payload.type==="item_completed"){
      const itemType=String(payload?.item?.type||"");
      if(itemType==="Reasoning")counts.reasoningCompleted++;
      else if(itemType==="AgentMessage")counts.agentMessages++;
      else if(itemType==="CommandExecution"){
        if(String(payload?.item?.status||"")==="failed")counts.commandFailed++;else counts.commandCompleted++;
      }
      lastEvent=itemType||"ItemCompleted";
    }
    if(row?.timestamp)lastTimestamp=String(row.timestamp);
  }
  return {kind:"codex",counts,lastTimestamp,lastEvent,pendingCommands:Math.max(0,counts.toolCalls-counts.commandCompleted-counts.commandFailed)};
}

export function healthAdvanced(before,after){
  if(!before||!after)return false;
  if(Number(after.fileBytes||0)>Number(before.fileBytes||0))return true;
  if(after.summary?.kind==="native"&&before.summary?.kind==="native"){
    return Number(after.summary.lastAtMs||0)>Number(before.summary.lastAtMs||0)
      ||Number(after.summary.counts?.modelCompleted||0)>Number(before.summary.counts?.modelCompleted||0)
      ||Number(after.summary.counts?.toolCompleted||0)>Number(before.summary.counts?.toolCompleted||0);
  }
  if(after.summary?.kind==="codex"&&before.summary?.kind==="codex"){
    return String(after.summary.lastTimestamp||"")>String(before.summary.lastTimestamp||"")
      ||Number(after.summary.counts?.reasoningCompleted||0)>Number(before.summary.counts?.reasoningCompleted||0)
      ||Number(after.summary.counts?.toolCalls||0)>Number(before.summary.counts?.toolCalls||0)
      ||Number(after.summary.counts?.commandCompleted||0)>Number(before.summary.counts?.commandCompleted||0)
      ||Number(after.summary.counts?.usageRecords||0)>Number(before.summary.counts?.usageRecords||0);
  }
  return false;
}

export function classifyHealth(before,after,{nowMs=Date.now(),recentMs=60_000}={}){
  if(healthAdvanced(before,after))return "progressed";
  if(!after?.available)return "unavailable";
  if(Number(after.mtimeMs||0)>0&&nowMs-Number(after.mtimeMs)<=recentMs)return "recently-active";
  return "quiet";
}

async function findFile(root,predicate){
  for(const entry of await readdir(root,{withFileTypes:true}).catch(()=>[])){
    const path=resolve(root,entry.name);
    if(entry.isDirectory()){
      const nested=await findFile(path,predicate);if(nested)return nested;
    }else if(predicate(path))return path;
  }
  return null;
}

async function docker(args){
  try{
    const result=await execFileAsync("docker",args,{windowsHide:true,maxBuffer:16*1024*1024,encoding:"utf8"});
    return {ok:true,stdout:String(result.stdout||"").trim()};
  }catch(error){
    return {ok:false,stdout:String(error?.stdout||"").trim(),error:String(error?.stderr||error?.message||"")};
  }
}

async function activeTaskContainer(task){
  const slug=String(task||"").split("/").filter(Boolean).at(-1)||"";
  const listed=await docker(["ps","--format","{{.Names}}"]);
  if(!listed.ok)return null;
  return listed.stdout.split(/\r?\n/).map(value=>value.trim()).filter(Boolean).find(name=>name.startsWith(slug+"__"))||null;
}

async function latestCodexSession(container){
  const found=await docker(["exec",container,"find","/tmp/codex-home/sessions","-type","f","-name","*.jsonl","-printf","%T@|%s|%p\n"]);
  if(!found.ok||!found.stdout)return null;
  const rows=found.stdout.split(/\r?\n/).map(line=>line.trim()).filter(Boolean)
    .map(line=>{const [mtime,size,...rest]=line.split("|");return {mtime:Number(mtime),size:Number(size),path:rest.join("|")}})
    .filter(row=>row.path&&Number.isFinite(row.mtime)).sort((a,b)=>b.mtime-a.mtime);
  return rows[0]||null;
}

async function pairSample(pair,pairPath){
  const workRoot=dirname(dirname(pairPath)),jobRoot=resolve(workRoot,".harbor-jobs",String(pair.activeJobName||""));
  if(pair.activeHarness==="native"){
    const file=await findFile(jobRoot,path=>basename(path)==="trebell-native-events.jsonl");
    if(!file)return {kind:"native",available:false,reason:"Native event journal not found yet."};
    const [text,info]=await Promise.all([readFile(file,"utf8"),stat(file)]);
    return {kind:"native",available:true,fileBytes:info.size,mtimeMs:info.mtimeMs,summary:summarizeNativeEventHealth(text)};
  }
  if(String(pair.activeHarness||"").startsWith("codex")){
    const container=await activeTaskContainer(pair.task);
    if(!container)return {kind:"codex",available:false,reason:"Active task container not found yet."};
    const session=await latestCodexSession(container);
    if(!session)return {kind:"codex",available:false,container,reason:"Codex session JSONL not found yet."};
    const tail=await docker(["exec",container,"tail","-n","900",session.path]);
    if(!tail.ok)return {kind:"codex",available:false,container,reason:"Codex session tail unavailable."};
    return {kind:"codex",available:true,container,fileBytes:session.size,mtimeMs:session.mtime*1000,summary:summarizeCodexEventHealth(tail.stdout)};
  }
  return {kind:String(pair.activeHarness||"unknown"),available:false,reason:"Unsupported active harness."};
}

async function pairHealth(pairFile,sampleMs){
  const pairPath=resolve(pairFile),beforePair=JSON.parse(await readFile(pairPath,"utf8"));
  const before=await pairSample(beforePair,pairPath);
  if(sampleMs)await new Promise(resolveSleep=>setTimeout(resolveSleep,sampleMs));
  const afterPair=JSON.parse(await readFile(pairPath,"utf8"));
  if(afterPair.complete)return {pairId:afterPair.pairId||null,complete:true,activeHarness:afterPair.activeHarness||null,classification:"complete",sampleMs,before,after:null};
  if(beforePair.activeHarness!==afterPair.activeHarness)return {pairId:afterPair.pairId||null,complete:false,activeHarness:afterPair.activeHarness||null,classification:"lane-transition",sampleMs,before,after:null};
  const after=await pairSample(afterPair,pairPath);
  return {
    pairId:afterPair.pairId||null,
    complete:false,
    activeHarness:afterPair.activeHarness||null,
    activeJobName:afterPair.activeJobName||null,
    classification:classifyHealth(before,after),
    sampleMs,
    before,
    after,
  };
}

async function stdinText(){
  const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);return Buffer.concat(chunks).toString("utf8");
}

async function main(){
  const pairArg=process.argv.find(value=>value.startsWith("--pair="));
  if(pairArg){
    const sampleArg=process.argv.find(value=>value.startsWith("--sample-ms="));
    const sampleMs=Math.max(0,Math.min(60_000,Number(sampleArg?.slice(12)||5000)));
    process.stdout.write(JSON.stringify(await pairHealth(pairArg.slice(7),sampleMs),null,2)+"\n");
    return;
  }
  const kindArg=process.argv.find(value=>value.startsWith("--kind=")),fileArg=process.argv.find(value=>value.startsWith("--file="));
  const kind=String(kindArg?.slice(7)||"").trim().toLowerCase();
  if(!["native","codex"].includes(kind))throw new Error("--kind must be native or codex");
  const text=fileArg?await readFile(resolve(fileArg.slice(7)),"utf8"):await stdinText();
  const summary=kind==="native"?summarizeNativeEventHealth(text):summarizeCodexEventHealth(text);
  process.stdout.write(JSON.stringify(summary,null,2)+"\n");
}

if(resolve(process.argv[1]||"")===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error?.message||error);process.exitCode=1});
