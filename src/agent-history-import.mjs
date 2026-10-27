import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { codexHome } from "./paths.mjs";

// Claude Code's sessions are listed and read through the Claude Agent SDK, which loads with the first scan or import that needs it,
// not with the server (budget B25).
let claudeAgentSdk=null;
const loadClaudeAgentSdk=()=>claudeAgentSdk??=import("@anthropic-ai/claude-agent-sdk");

const MAX_CODEX_SCAN_FILES=240;
const MAX_CODEX_SCAN_BYTES=1024*1024;
const MAX_CLAUDE_SESSIONS=80;
const MAX_IMPORTED_TURNS=120;
const MAX_MESSAGE_CHARS=32_000;
// The text one imported Claude session keeps in all, its messages' text counted from its newest message back.
const MAX_IMPORTED_CHARS=8*1024*1024;

function pathKey(value){
  const normalized=resolve(String(value||"")).replace(/[\\/]+$/,"");
  return process.platform==="win32"?normalized.toLowerCase():normalized;
}
function stableId(source,key){
  return source+"-"+createHash("sha256").update(String(key)).digest("hex").slice(0,24);
}
async function directoryExists(path){
  if(!path)return false;
  try{return (await stat(path)).isDirectory()}catch{return false}
}
async function collectJsonl(root,{limit=MAX_CODEX_SCAN_FILES,depth=5}={}){
  const result=[];
  async function walk(dir,remainingDepth){
    if(result.length>=limit||remainingDepth<0)return;
    let entries;try{entries=await readdir(dir,{withFileTypes:true})}catch{return}
    entries.sort((a,b)=>String(b.name).localeCompare(String(a.name)));
    for(const entry of entries){
      if(result.length>=limit)break;
      const path=join(dir,entry.name);
      if(entry.isDirectory())await walk(path,remainingDepth-1);
      else if(entry.isFile()&&entry.name.toLowerCase().endsWith(".jsonl"))result.push(path);
    }
  }
  await walk(root,depth);
  return result;
}
async function readPrefix(path,maxBytes=MAX_CODEX_SCAN_BYTES){
  const handle=await open(path,"r");
  try{
    const buffer=Buffer.alloc(maxBytes);const {bytesRead}=await handle.read(buffer,0,maxBytes,0);
    return buffer.subarray(0,bytesRead).toString("utf8");
  }finally{await handle.close()}
}
function codexText(value){
  if(typeof value==="string")return value.trim();
  if(Array.isArray(value))return value.map(item=>codexText(item?.text??item?.content??item)).filter(Boolean).join("\n").trim();
  if(value&&typeof value==="object"){
    if(typeof value.text==="string")return value.text.trim();
    if(value.content!=null)return codexText(value.content);
  }
  return "";
}
export function parseCodexHistoryPrefix(text,{path="",updatedAt=0,createdAt=0}={}){
  let sessionId=null,cwd=null,model=null,firstPrompt=null,timestamp=null;
  for(const line of String(text||"").split(/\r?\n/)){
    if(!line.trim())continue;
    let record;try{record=JSON.parse(line)}catch{continue}
    if(!timestamp&&record.timestamp)timestamp=Date.parse(record.timestamp)||null;
    const payload=record.payload||{};
    if(record.type==="session_meta"){
      sessionId=String(payload.id||payload.session_id||sessionId||"").trim()||sessionId;
      cwd=String(payload.cwd||cwd||"").trim()||cwd;
    }else if(record.type==="turn_context"){
      model=String(payload.model||model||"").trim()||model;
    }else if(record.type==="event_msg"&&payload.type==="user_message"&&!firstPrompt){
      firstPrompt=codexText(payload.message||payload.content);
    }
    if(sessionId&&cwd&&firstPrompt&&model)break;
  }
  if(!sessionId||!cwd)return null;
  const title=(firstPrompt||"Imported Codex session").replace(/\s+/g," ").trim().slice(0,160);
  return {
    id:stableId("codex",path||sessionId),
    source:"codex",
    providerSessionId:sessionId,
    cwd,
    title,
    preview:title,
    model:model||null,
    updatedAt:Number(updatedAt)||timestamp||0,
    createdAt:Number(createdAt)||timestamp||0,
    sourcePath:path,
  };
}
export async function scanCodexHistory({env=process.env,sourceHome=null,excludeHomes=[],maxSessions=60}={}){
  const home=sourceHome||env.CODEX_HOME||join(homedir(),".codex");
  const sessionsRoot=join(home,"sessions");
  const excluded=new Set([codexHome(env),...excludeHomes].filter(Boolean).map(pathKey));
  if(excluded.has(pathKey(home)))return [];
  const paths=await collectJsonl(sessionsRoot);
  const candidates=[];
  for(const path of paths){
    if(candidates.length>=maxSessions)break;
    try{
      const info=await stat(path);if(!info.isFile())continue;
      const parsed=parseCodexHistoryPrefix(await readPrefix(path),{path,updatedAt:info.mtimeMs,createdAt:info.birthtimeMs});
      if(parsed&&await directoryExists(parsed.cwd))candidates.push(parsed);
    }catch{}
  }
  return candidates.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)).slice(0,maxSessions);
}
// The folder the SDK's listSessions reads every project's sessions from (Claude Agent SDK 0.3.276: CLAUDE_CONFIG_DIR of this process,
// else ~/.claude, then projects). Without it the list is empty, so the SDK is not loaded to say so: a first run's onboarding asks
// for this list as it opens.
function claudeProjectsFolder(){return join((process.env.CLAUDE_CONFIG_DIR??join(homedir(),".claude")).normalize("NFC"),"projects")}
export async function scanClaudeHistory({listSessionsFn=null,maxSessions=MAX_CLAUDE_SESSIONS}={}){
  if(!listSessionsFn&&!existsSync(claudeProjectsFolder()))return [];
  const list=listSessionsFn||(await loadClaudeAgentSdk()).listSessions;
  let sessions=[];try{sessions=await list({limit:maxSessions,offset:0,includeProgrammatic:false})}catch{return []}
  const candidates=[];
  for(const session of sessions||[]){
    const sessionId=String(session?.sessionId||"").trim(),cwd=String(session?.cwd||"").trim();
    if(!sessionId||!cwd||!(await directoryExists(cwd)))continue;
    const title=String(session.customTitle||session.summary||session.firstPrompt||"Imported Claude session").replace(/\s+/g," ").trim().slice(0,160);
    candidates.push({
      id:stableId("claude",sessionId+"\n"+pathKey(cwd)),
      source:"claude",providerSessionId:sessionId,cwd,title,preview:String(session.firstPrompt||title).replace(/\s+/g," ").trim().slice(0,240),
      model:null,updatedAt:Number(session.lastModified)||0,createdAt:Number(session.createdAt)||0,gitBranch:session.gitBranch||null,
    });
  }
  return candidates.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)).slice(0,maxSessions);
}
export async function scanLocalAgentHistory(options={}){
  const [codex,claude]=await Promise.all([
    options.includeCodex===false?[]:scanCodexHistory(options),
    options.includeClaude===false?[]:scanClaudeHistory(options),
  ]);
  return [...codex,...claude].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
}
function messageText(message){
  const value=message?.message??message;
  if(typeof value==="string")return value.trim();
  const content=value?.content;
  if(typeof content==="string")return content.trim();
  if(!Array.isArray(content))return "";
  return content.map(block=>{
    if(typeof block==="string")return block;
    if(block?.type==="text"&&typeof block.text==="string")return block.text;
    return "";
  }).filter(Boolean).join("\n").trim();
}
// A Claude session's latest turns, as Claude resumes it: from its newest message back, each user message with text opens a turn and
// the assistant text after it joins that turn, up to MAX_IMPORTED_TURNS turns and MAX_IMPORTED_CHARS of text. Tool calls and
// results have no text and take no room, and a compaction's summary (is_meta) is not a request the person sent.
export function claudeMessagesToTurns(messages,{createdAt=Date.now()}={}){
  const list=Array.isArray(messages)?messages:[],kept=[];let opened=0,chars=0,full=false;
  for(let position=list.length-1;position>=0&&opened<MAX_IMPORTED_TURNS;position--){
    const message=list[position];if((message?.type!=="user"&&message?.type!=="assistant")||message.is_meta===true)continue;
    const text=messageText(message).slice(0,MAX_MESSAGE_CHARS);if(!text)continue;
    // Past the bound an older turn is left out whole; the newest keeps its request and its latest replies.
    if(full||chars+text.length>MAX_IMPORTED_CHARS){if(opened)break;full=true;if(message.type==="assistant")continue}
    chars+=text.length;kept.push({message,text});if(message.type==="user")opened++;
  }
  const base=Math.floor((Number(createdAt)||Date.now())/1000);const turns=[];let current=null,index=0;
  const finish=()=>{if(current){current.status="completed";current.completedAt=current.startedAt;current.durationMs=0;turns.push(current);current=null}};
  for(const {message,text} of kept.reverse()){
    if(message.type==="user"){
      finish();const turnId="import-"+String(message.uuid||index++);
      current={id:turnId,status:"completed",startedAt:base+turns.length,completedAt:base+turns.length,durationMs:0,error:null,items:[{type:"userMessage",id:"user-"+turnId,clientId:null,content:[{type:"text",text}]}]};
    }else if(message.type==="assistant"&&current){
      current.items.push({type:"agentMessage",id:"assistant-"+String(message.uuid||index++),text,phase:null,memoryCitation:null,delivery:null,questions:null});
    }
  }
  finish();return turns;
}
export async function importClaudeHistory(agentThreads,candidate,{getSessionMessagesFn=null}={}){
  const existing=agentThreads.findProviderSession?.("claude",candidate.providerSessionId);
  if(existing)return {status:"skipped",reason:"already_imported",thread:existing};
  const read=getSessionMessagesFn||(await loadClaudeAgentSdk()).getSessionMessages;
  // The whole session: the SDK parses all of it whatever is asked, and its limit counts from the start, tool records too.
  const messages=await read(candidate.providerSessionId,{dir:candidate.cwd,includeSystemMessages:false});
  const turns=claudeMessagesToTurns(messages,{createdAt:candidate.createdAt||candidate.updatedAt});
  if(!turns.length)throw new Error("Claude session has no visible user/assistant history to import");
  const thread=agentThreads.importHistory({
    runtime:"claude",cwd:candidate.cwd,providerSessionId:candidate.providerSessionId,model:candidate.model||null,
    name:candidate.title||null,preview:candidate.preview||candidate.title||null,turns,
    createdAt:candidate.createdAt,updatedAt:candidate.updatedAt,
    providerMeta:{historyImport:{source:"claude",sourceId:candidate.id,importedAt:Date.now()}},
  });
  return {status:"imported",thread};
}
export function publicHistoryCandidate(candidate,{alreadyImported=false}={}){
  const {sourcePath:_sourcePath,...publicCandidate}=candidate;
  return {...publicCandidate,alreadyImported:Boolean(alreadyImported)};
}
