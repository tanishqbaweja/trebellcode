import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

async function stdinText(){
  const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);return Buffer.concat(chunks).toString("utf8");
}

async function main(){
  const kindArg=process.argv.find(value=>value.startsWith("--kind=")),fileArg=process.argv.find(value=>value.startsWith("--file="));
  const kind=String(kindArg?.slice(7)||"").trim().toLowerCase();
  if(!["native","codex"].includes(kind))throw new Error("--kind must be native or codex");
  const text=fileArg?await readFile(resolve(fileArg.slice(7)),"utf8"):await stdinText();
  const summary=kind==="native"?summarizeNativeEventHealth(text):summarizeCodexEventHealth(text);
  process.stdout.write(JSON.stringify(summary,null,2)+"\n");
}

if(resolve(process.argv[1]||"")===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error?.message||error);process.exitCode=1});
