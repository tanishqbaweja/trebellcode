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
// Before a rollout counts toward the 240 read, its own session_meta (its first line) says whether Codex ran it for itself: read in
// 8 KiB pieces, for at most 5,000 rollouts and 64 MiB in all per scan (T3 Code's metadata budget per source).
const CODEX_META_READ_BYTES=8*1024;
const MAX_CODEX_CLASSIFIED_FILES=5000;
const MAX_CODEX_CLASSIFIED_BYTES=64*1024*1024;
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
// The newest .jsonl files under root, up to limit of those accept(path) takes (true; false skips one; null, a spent budget, ends the walk).
async function collectJsonl(root,{limit=MAX_CODEX_SCAN_FILES,depth=5,accept=null}={}){
  const result=[];let spent=false;
  async function walk(dir,remainingDepth){
    if(spent||result.length>=limit||remainingDepth<0)return;
    let entries;try{entries=await readdir(dir,{withFileTypes:true})}catch{return}
    entries.sort((a,b)=>String(b.name).localeCompare(String(a.name)));
    for(const entry of entries){
      if(spent||result.length>=limit)break;
      const path=join(dir,entry.name);
      if(entry.isDirectory())await walk(path,remainingDepth-1);
      else if(entry.isFile()&&entry.name.toLowerCase().endsWith(".jsonl")){
        const taken=accept?await accept(path):true;
        if(taken===null)spent=true;else if(taken)result.push(path);
      }
    }
  }
  await walk(root,depth);
  return result;
}
// Whether a rollout is one of the person's own sessions, from its first session_meta (codexSubagentSource), read piece by piece up to
// MAX_CODEX_SCAN_BYTES from the scan's budget: false for Codex's own or a file with no session_meta there, null once the budget is spent.
async function codexOwnRollout(path,budget){
  if(budget.files<=0||budget.bytes<=0)return null;
  budget.files--;
  let handle;try{handle=await open(path,"r")}catch{return false}
  try{
    const decoder=new TextDecoder();let rest="",offset=0;
    const verdict=line=>{
      let record;try{record=JSON.parse(line)}catch{return undefined}
      return record?.type==="session_meta"?!codexSubagentSource(record.payload?.source):undefined;
    };
    while(offset<MAX_CODEX_SCAN_BYTES){
      if(budget.bytes<=0)return null;
      const size=Math.min(CODEX_META_READ_BYTES,MAX_CODEX_SCAN_BYTES-offset,budget.bytes),buffer=Buffer.alloc(size);
      const {bytesRead}=await handle.read(buffer,0,size,offset);budget.bytes-=bytesRead;
      if(!bytesRead)return verdict(rest+decoder.decode())??false;
      offset+=bytesRead;rest+=decoder.decode(buffer.subarray(0,bytesRead),{stream:true});
      const lines=rest.split("\n");rest=lines.pop();
      for(const line of lines){const own=verdict(line.trim());if(own!==undefined)return own}
    }
    return false;
  }finally{await handle.close()}
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
// A session Codex ran for itself: a spawned child agent, a review, a compaction or a guardian check ({subagent:...}; {subAgent:...}).
function codexSubagentSource(source){
  return Boolean(source)&&typeof source==="object"&&!Array.isArray(source)&&(Object.hasOwn(source,"subagent")||Object.hasOwn(source,"subAgent"));
}
// The setup text Codex records as user text ahead of a request (T3 Code's CODEX_TITLE_PREAMBLE): its context and instruction blocks,
// the AGENTS.md heading and the IDE's request heading. A title is taken after it; the session itself is imported as it is.
const CODEX_TITLE_PREAMBLE=/^(?:\s*(?:<(recommended_plugins|environment_context|user_instructions|INSTRUCTIONS|in-app-browser-context)(?:\s[^>]*)?>[\s\S]*?<\/\1>|# AGENTS\.md instructions\b[^\n]*|## My request for Codex:))+/;
export function parseCodexHistoryPrefix(text,{path="",updatedAt=0,createdAt=0}={}){
  let sessionId=null,cwd=null,model=null,request=null,timestamp=null;
  for(const line of String(text||"").split(/\r?\n/)){
    if(!line.trim())continue;
    let record;try{record=JSON.parse(line)}catch{continue}
    if(!timestamp&&record.timestamp)timestamp=Date.parse(record.timestamp)||null;
    const payload=record.payload||{};
    if(record.type==="session_meta"){
      // The rollout's own session_meta comes first: a fork copies its ancestors' in after it, which name other sessions (a subagent's
      // among them). A subagent's own is left out before it counts toward the scan's sessions, whatever later records say.
      if(!sessionId){
        if(codexSubagentSource(payload.source))return null;
        sessionId=String(payload.id||payload.session_id||"").trim()||null;
      }
      cwd=cwd||String(payload.cwd||"").trim()||null;
    }else if(record.type==="turn_context"){
      model=String(payload.model||model||"").trim()||model;
    }else if(record.type==="event_msg"&&payload.type==="user_message"&&!request){
      // A message that is only setup text names nothing; the next one may.
      request=codexText(payload.message||payload.content).replace(CODEX_TITLE_PREAMBLE,"").trim()||null;
    }
    if(sessionId&&cwd&&request&&model)break;
  }
  if(!sessionId||!cwd)return null;
  const title=(request||"Imported Codex session").replace(/\s+/g," ").trim().slice(0,160);
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
  // Only the person's own sessions count toward the rollouts read: newer child-agent, review, guardian and compaction sessions,
  // however many, are passed over first.
  const budget={files:MAX_CODEX_CLASSIFIED_FILES,bytes:MAX_CODEX_CLASSIFIED_BYTES};
  const paths=await collectJsonl(sessionsRoot,{accept:path=>codexOwnRollout(path,budget)});
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
// A compaction's summary, which Claude Code's chain after a compaction starts at (the SDK marks it is_meta and isCompactSummary).
function claudeCompactSummary(message){return message?.type==="user"&&message.is_meta===true&&message.isCompactSummary===true}
// A Claude session's latest turns, as Claude resumes it: from its newest message back, each user message with text opens a turn and
// the assistant text after it joins that turn, up to MAX_IMPORTED_TURNS turns and MAX_IMPORTED_CHARS of text. Tool calls and
// results have no text and take no room, and a compaction's summary (is_meta) is not a request the person sent. Replies that follow
// the summary before any request (Claude Code compacted in the middle of a turn and carried on) are kept in a turn of their own that
// opens with the compaction, as a compaction, not as the person's words.
export function claudeMessagesToTurns(messages,{createdAt=Date.now()}={}){
  const list=Array.isArray(messages)?messages:[],kept=[];let opened=0,chars=0,full=false,replies=0;
  for(let position=list.length-1;position>=0&&opened<MAX_IMPORTED_TURNS;position--){
    const message=list[position];
    // replies: the replies kept since the last request kept, which a compaction's summary before them opens a turn for.
    if(claudeCompactSummary(message)){if(replies){kept.push({message,compaction:true});opened++;replies=0}continue}
    if((message?.type!=="user"&&message?.type!=="assistant")||message.is_meta===true)continue;
    const text=messageText(message).slice(0,MAX_MESSAGE_CHARS);if(!text)continue;
    // Past the bound an older turn is left out whole; the newest keeps its request and its latest replies.
    if(full||chars+text.length>MAX_IMPORTED_CHARS){if(opened)break;full=true;if(message.type==="assistant")continue}
    chars+=text.length;kept.push({message,text});if(message.type==="user"){opened++;replies=0}else replies++;
  }
  const base=Math.floor((Number(createdAt)||Date.now())/1000);const turns=[];let current=null,index=0;
  const finish=()=>{if(current){current.status="completed";current.completedAt=current.startedAt;current.durationMs=0;turns.push(current);current=null}};
  const open=(turnId,item)=>({id:turnId,status:"completed",startedAt:base+turns.length,completedAt:base+turns.length,durationMs:0,error:null,items:[item]});
  for(const {message,text,compaction} of kept.reverse()){
    if(compaction){finish();const turnId="import-"+String(message.uuid||index++);current=open(turnId,{type:"contextCompaction",id:"compaction-"+turnId,status:"completed"})}
    else if(message.type==="user"){
      finish();const turnId="import-"+String(message.uuid||index++);
      current=open(turnId,{type:"userMessage",id:"user-"+turnId,clientId:null,content:[{type:"text",text}]});
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
