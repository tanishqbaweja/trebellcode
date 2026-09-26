import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactSecretValue } from "./secret-redactor.mjs";

const DEFAULT_HOT_BYTES=16*1024,DEFAULT_READ_CHARS=12_000,MAX_READ_CHARS=48_000,DEFAULT_PREVIEW_CHARS=6000;
const SIGNAL_LINE=/\b(?:error|failed|failure|exception|assert(?:ion)?|traceback|panic|fatal|timeout|timed out|cannot|can't|invalid|expected|received|not found|undefined|mismatch)\b/i;

function serialized(value){
  if(typeof value==="string")return value;
  if(value&&typeof value==="object"&&!Array.isArray(value)){
    const textKeys=["stdout","stderr","content","output","aggregatedOutput"],sections=[],rest={...value};
    for(const key of textKeys){
      if(typeof rest[key]!=="string")continue;
      const text=rest[key];delete rest[key];
      sections.push("--- "+key+" ---\n"+text);
    }
    if(sections.length){
      const metadata=Object.keys(rest).length?JSON.stringify(rest,null,2):"";
      return [metadata,...sections].filter(Boolean).join("\n\n");
    }
  }
  try{return JSON.stringify(value,null,2)}catch{return String(value)}
}
function byteLength(value){return Buffer.byteLength(String(value||""),"utf8")}
function importantLines(text,maxChars){
  const lines=String(text||"").split(/\r?\n/),out=[];let used=0;
  for(let index=0;index<lines.length;index++){
    const line=lines[index];if(!SIGNAL_LINE.test(line))continue;
    const value=("line "+(index+1)+": "+line).slice(0,600),cost=value.length+1;
    if(used+cost>maxChars)break;
    out.push(value);used+=cost;
  }
  return out.join("\n");
}
function preview(text,maxChars=DEFAULT_PREVIEW_CHARS){
  const value=String(text||"");if(value.length<=maxChars)return value;
  const signals=importantLines(value,Math.min(2200,Math.floor(maxChars*.36)));
  const marker="\n...[Trebell virtualized "+(value.length-maxChars).toLocaleString()+" omitted characters]...\n";
  const signalBlock=signals?"\n...[important lines from omitted output]...\n"+signals+"\n...[end important lines]...\n":"";
  const remaining=Math.max(512,maxChars-marker.length-signalBlock.length),head=Math.floor(remaining*.62),tail=Math.max(0,remaining-head);
  return (value.slice(0,head)+marker+signalBlock+value.slice(-tail)).slice(0,maxChars);
}
function safeHandle(value){
  const handle=String(value||"");if(!/^out_[a-zA-Z0-9-]{8,80}$/.test(handle))throw new Error("Invalid Trebell output handle");
  return handle;
}
function scalarMetadata(value){
  if(!value||typeof value!=="object"||Array.isArray(value))return {};
  const keep=["success","exitCode","signal","timedOut","truncated","durationMs","cwd","command","args","path","size","replacements","error","message","status"];
  return Object.fromEntries(keep.filter(key=>Object.prototype.hasOwnProperty.call(value,key)).map(key=>[key,value[key]]));
}

export class NativeToolOutputStore{
  constructor({directory,maxHotBytes=DEFAULT_HOT_BYTES,maxEntries=120,onVirtualized=null,environment=process.env}={}){
    if(!directory)throw new Error("NativeToolOutputStore requires a directory");
    this.directory=directory;this.maxHotBytes=Math.max(4096,Math.trunc(Number(maxHotBytes)||DEFAULT_HOT_BYTES));this.maxEntries=Math.max(10,Math.min(1000,Math.trunc(Number(maxEntries)||120)));this.onVirtualized=onVirtualized;this.environment=environment||process.env;
  }
  #path(handle){return join(this.directory,safeHandle(handle)+".json")}
  async #prune(){
    let entries=[];try{entries=await readdir(this.directory)}catch{return}
    const rows=[];
    for(const name of entries.filter(name=>/^out_[a-zA-Z0-9-]{8,80}\.json$/.test(name))){
      const path=join(this.directory,name);try{const info=await stat(path);rows.push({path,mtime:info.mtimeMs})}catch{}
    }
    rows.sort((a,b)=>b.mtime-a.mtime);
    await Promise.all(rows.slice(this.maxEntries).map(row=>unlink(row.path).catch(()=>{})));
  }
  async virtualize(value,{namespace=null,name=null}={}){
    const safeValue=redactSecretValue(value,{environment:this.environment,maxDepth:20,maxArray:5000,maxFields:5000});
    const text=serialized(safeValue),totalBytes=byteLength(text);
    if(totalBytes<=this.maxHotBytes)return {value:safeValue,virtualized:false,totalBytes};
    await mkdir(this.directory,{recursive:true});
    const handle="out_"+randomUUID(),payload={handle,createdAt:Date.now(),namespace,name,totalBytes,text};
    await writeFile(this.#path(handle),JSON.stringify(payload),"utf8");
    await this.#prune();
    try{this.onVirtualized?.({handle,totalBytes,namespace,name})}catch{}
    const lines=text.split(/\r?\n/).length;
    return {
      virtualized:true,totalBytes,handle,
      value:{
        ...scalarMetadata(safeValue),
        preview:preview(text),
        _trebell_output:{
          handle,totalBytes,totalLines:lines,
          note:"Full redacted output is outside hot model context. Preview contains bounded head/tail plus important failure-like lines when found. Use trebell_output/search first, or trebell_output/read for a bounded range, only when more detail is needed.",
        },
      },
    };
  }
  async #load(handle){
    const parsed=JSON.parse(await readFile(this.#path(handle),"utf8"));
    if(!parsed||parsed.handle!==String(handle)||typeof parsed.text!=="string")throw new Error("Trebell output handle is corrupted");
    return parsed;
  }
  async read({handle,start_line=1,end_line=null,max_chars=DEFAULT_READ_CHARS}={}){
    const entry=await this.#load(safeHandle(handle)),lines=entry.text.split(/\r?\n/),start=Math.max(1,Math.trunc(Number(start_line)||1)),limit=Math.max(1000,Math.min(MAX_READ_CHARS,Math.trunc(Number(max_chars)||DEFAULT_READ_CHARS)));
    const end=end_line==null?lines.length:Math.max(start,Math.min(lines.length,Math.trunc(Number(end_line)||start)));
    let content=lines.slice(start-1,end).join("\n"),clipped=false;if(content.length>limit){content=content.slice(0,limit);clipped=true}
    return {handle:entry.handle,startLine:start,endLine:end,totalLines:lines.length,totalBytes:entry.totalBytes,clipped,content};
  }
  async search({handle,query,regex=false,case_sensitive=false,limit=40,context_lines=2}={}){
    const entry=await this.#load(safeHandle(handle)),needle=String(query||"");if(!needle)throw new Error("Output search query is required");
    const max=Math.max(1,Math.min(100,Math.trunc(Number(limit)||40)));
    const context=Math.max(0,Math.min(8,Math.trunc(Number(context_lines)||2)));
    const lines=entry.text.split(/\r?\n/),matches=[];
    let pattern=null;if(regex)pattern=new RegExp(needle,case_sensitive?"":"i");
    const normalized=case_sensitive?needle:needle.toLowerCase();
    for(let index=0;index<lines.length&&matches.length<max;index++){
      const line=lines[index],hit=pattern?pattern.test(line):(case_sensitive?line:line.toLowerCase()).includes(normalized);if(!hit)continue;
      const from=Math.max(0,index-context),to=Math.min(lines.length,index+context+1);
      matches.push({line:index+1,excerpt:lines.slice(from,to).map((value,offset)=>String(from+offset+1).padStart(6)+" | "+value.slice(0,1200)).join("\n")});
    }
    return {handle:entry.handle,query:needle,totalLines:lines.length,totalBytes:entry.totalBytes,matches};
  }
  async execute(call={}){
    if(call.name==="read")return await this.read(call.arguments||{});
    if(call.name==="search")return await this.search(call.arguments||{});
    throw new Error("Unknown Trebell output tool: "+String(call.name||""));
  }
}
