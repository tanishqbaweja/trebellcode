import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactSecretValue } from "./secret-redactor.mjs";

const DEFAULT_HOT_BYTES=16*1024,DEFAULT_READ_CHARS=12_000,MAX_READ_CHARS=48_000,DEFAULT_PREVIEW_CHARS=3600,DEFAULT_SIGNAL_PREVIEW_CHARS=2200;
const SIGNAL_LINE=/\b(?:error|failed|failure|exception|assert(?:ion)?|traceback|panic|fatal|timeout|timed out|cannot|can't|invalid|expected|received|not found|undefined|mismatch)\b/i;
const VIRTUALIZED_OUTPUT_NOTE="Full redacted output is outside hot model context. Preview contains bounded head/tail plus important failure-like lines when found. Use trebell_output/inspect only when more detail is needed; set query to search, or omit it to read a bounded range.";
const COLLAPSED_OUTPUT_NOTE="Runs of identical consecutive lines are collapsed here. The full redacted output is stored by Trebell; use trebell_output/inspect with this handle only if the exact repeated lines matter.";

// The text fields serialized() writes out as sections after an output's other fields.
const TEXT_KEYS=["stdout","stderr","content","output","aggregatedOutput"];
function serialized(value){
  if(typeof value==="string")return value;
  if(value&&typeof value==="object"&&!Array.isArray(value)){
    const sections=[],rest={...value};
    for(const key of TEXT_KEYS){
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
function repeatedLineNote(count){return "[Trebell: previous line repeated "+count+" more time"+(count===1?"":"s")+"]"}
// Command output only: a run of identical consecutive lines becomes its first line and a harness note that counts the rest,
// when the note is shorter than the lines it replaces. Line endings (LF or CRLF) and a trailing newline are kept.
export function collapseRepeatedLines(text){
  const value=String(text??"");if(!value.includes("\n"))return {text:value,runs:0,removedLines:0};
  const trailing=value.endsWith("\n"),lines=(trailing?value.slice(0,-1):value).split("\n"),out=[];let runs=0,removedLines=0;
  for(let index=0;index<lines.length;){
    const line=lines[index];let end=index+1;while(end<lines.length&&lines[end]===line)end++;
    const repeats=end-index-1,note=repeats?repeatedLineNote(repeats)+(line.endsWith("\r")?"\r":""):"";
    if(repeats&&repeats*(line.length+1)>note.length+1){out.push(line,note);runs++;removedLines+=repeats}
    else for(let copy=index;copy<end;copy++)out.push(line);
    index=end;
  }
  if(!runs)return {text:value,runs:0,removedLines:0};
  return {text:out.join("\n")+(trailing?"\n":""),runs,removedLines};
}
const COLLAPSIBLE_OUTPUT_KEYS=["stdout","stderr"];
function collapsedOutputValue(value){
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  let next=null,runs=0,removedLines=0;
  for(const key of COLLAPSIBLE_OUTPUT_KEYS){
    if(typeof value[key]!=="string")continue;
    const collapsed=collapseRepeatedLines(value[key]);if(!collapsed.runs)continue;
    if(!next)next={...value};next[key]=collapsed.text;runs+=collapsed.runs;removedLines+=collapsed.removedLines;
  }
  return next?{value:next,runs,removedLines}:null;
}
// A collapse in hot context adds a pointer to the stored lines (a handle is "out_" and a UUID), so it is used only when the
// characters it takes out of the model's view, as the model reads it (JSON), outnumber that pointer's.
function collapseOutweighsPointer(view,collapsed,storedText){
  const pointer={handle:"out_"+"0".repeat(36),totalBytes:byteLength(storedText),totalLines:storedText.split(/\r?\n/).length,archived:true,note:COLLAPSED_OUTPUT_NOTE};
  return JSON.stringify(view).length-JSON.stringify(collapsed).length>JSON.stringify({_trebell_output:pointer}).length;
}
function importantLines(text,maxChars,{skipRepeats=false}={}){
  const lines=String(text||"").split(/\r?\n/),out=[];let used=0;
  for(let index=0;index<lines.length;index++){
    const line=lines[index];if(!SIGNAL_LINE.test(line)||(skipRepeats&&index>0&&lines[index-1]===line))continue;
    const value=("line "+(index+1)+": "+line).slice(0,600),cost=value.length+1;
    if(used+cost>maxChars)break;
    out.push(value);used+=cost;
  }
  return out.join("\n");
}
function failureLike(value){
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  if(value.success===false||value.timedOut===true)return true;
  if(value.signal!=null&&String(value.signal).trim())return true;
  if(typeof value.error==="string"&&value.error.trim())return true;
  const exitCode=Number(value.exitCode);if(Number.isFinite(exitCode)&&exitCode!==0)return true;
  const status=Number(value.status);if(Number.isFinite(status)&&status>=400)return true;
  return false;
}
// signalText: the stored text the important lines are numbered against, when the preview shows a collapsed copy of it.
function preview(text,maxChars=DEFAULT_PREVIEW_CHARS,{compactSignalPreview=false,signalText=null}={}){
  const value=String(text||"");if(value.length<=maxChars)return value;
  const signalSource=signalText==null?value:String(signalText),signalOptions={skipRepeats:signalText!=null};
  let signals=importantLines(signalSource,Math.min(2200,Math.floor(maxChars*.36)),signalOptions);
  const target=signals&&compactSignalPreview?Math.min(maxChars,DEFAULT_SIGNAL_PREVIEW_CHARS):maxChars;
  if(signals&&target<maxChars)signals=importantLines(signalSource,Math.min(1100,Math.floor(target*.48)),signalOptions);
  const marker="\n...[Trebell virtualized "+(value.length-target).toLocaleString()+" omitted characters]...\n";
  const signalBlock=signals?"\n...[important lines from omitted output]...\n"+signals+"\n...[end important lines]...\n":"";
  const remaining=Math.max(512,target-marker.length-signalBlock.length),head=Math.floor(remaining*.62),tail=Math.max(0,remaining-head);
  return (value.slice(0,head)+marker+signalBlock+value.slice(-tail)).slice(0,target);
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
// A model view (see virtualize) applied to the redacted value, or null when there is none or it gives no object.
function projectedView(modelView,safeValue){
  if(typeof modelView!=="function")return null;
  let view;try{view=modelView(safeValue)}catch{return null}
  return view&&typeof view==="object"&&!Array.isArray(view)?view:null;
}
// A model view is already cut down to what the model is shown, so all its scalar fields other than the text sections stay
// beside its preview.
function viewMetadata(view){
  return Object.fromEntries(Object.entries(view).filter(([key,value])=>!TEXT_KEYS.includes(key)&&(value===null||["string","number","boolean"].includes(typeof value))));
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
  async #store(text,{namespace=null,name=null,totalBytes=byteLength(text)}={}){
    await mkdir(this.directory,{recursive:true});
    const handle="out_"+randomUUID(),payload={handle,createdAt:Date.now(),namespace,name,totalBytes,text};
    await writeFile(this.#path(handle),JSON.stringify(payload),"utf8");
    await this.#prune();
    return handle;
  }
  // modelView (optional): what the model is shown of this output when that is less than the whole value, such as a
  // background-process receipt. It is applied to the redacted value. The person's view (uiValue) stays the whole value, or its
  // preview when it is too large, and the stored copy behind the handle is the model's view with every output line.
  // collapseRepeatedLines (command output only): the model sees stdout and stderr with runs of identical lines collapsed,
  // and the raw output is stored behind a handle so trebell_output can still return every line. The person's view is not
  // collapsed.
  async virtualize(value,{namespace=null,name=null,collapseRepeatedLines=false,modelView=null}={}){
    // A text preview would irreversibly discard model-visible image pixels.
    // Redact ordinary metadata and text, but keep image payloads intact in hot context.
    if(Array.isArray(value?.contentItems)&&value.contentItems.some(item=>item?.type==="inputImage"||item?.type==="image")){
      const {contentItems,...metadata}=value;
      const safeMetadata=redactSecretValue(metadata,{environment:this.environment,maxDepth:20,maxArray:5000,maxFields:5000});
      const safeItems=contentItems.map(item=>item?.type==="inputImage"||item?.type==="image"?item:redactSecretValue(item,{environment:this.environment,maxDepth:20,maxArray:5000,maxFields:5000}));
      return {value:{...safeMetadata,contentItems:safeItems},virtualized:false,totalBytes:0};
    }
    const safeValue=redactSecretValue(value,{environment:this.environment,maxDepth:20,maxArray:5000,maxFields:5000});
    const text=serialized(safeValue),totalBytes=byteLength(text),view=projectedView(modelView,safeValue);
    const model=view?{value:view,text:serialized(view),metadata:viewMetadata(view)}:{value:safeValue,text,metadata:scalarMetadata(safeValue)};
    const collapsed=collapseRepeatedLines===true?collapsedOutputValue(model.value):null;
    // An output too large for hot context is previewed behind a pointer either way, so its collapse always pays.
    if(collapsed&&(totalBytes>this.maxHotBytes||collapseOutweighsPointer(model.value,collapsed.value,model.text)))return await this.#virtualizeCollapsed(safeValue,text,totalBytes,model,collapsed,{namespace,name});
    if(totalBytes<=this.maxHotBytes)return view?{value:view,uiValue:safeValue,virtualized:false,totalBytes}:{value:safeValue,virtualized:false,totalBytes};
    const handle=await this.#store(model.text,{namespace,name}),storedBytes=byteLength(model.text);
    try{this.onVirtualized?.({handle,totalBytes:storedBytes,namespace,name})}catch{}
    const compactSignalPreview=failureLike(safeValue),pointer={handle,totalBytes:storedBytes,totalLines:model.text.split(/\r?\n/).length,note:VIRTUALIZED_OUTPUT_NOTE};
    return {
      virtualized:true,totalBytes,handle,
      value:{...model.metadata,preview:preview(model.text,DEFAULT_PREVIEW_CHARS,{compactSignalPreview}),_trebell_output:pointer},
      ...(view?{uiValue:{...scalarMetadata(safeValue),preview:preview(text,DEFAULT_PREVIEW_CHARS,{compactSignalPreview}),_trebell_output:pointer}}:{}),
    };
  }
  async #virtualizeCollapsed(safeValue,text,totalBytes,model,collapsed,{namespace=null,name=null}={}){
    // The stored copy is the model's view with every line, so trebell_output returns the lines the collapse leaves out.
    const handle=await this.#store(model.text,{namespace,name}),storedBytes=byteLength(model.text),totalLines=model.text.split(/\r?\n/).length,collapsedText=serialized(collapsed.value);
    const compactSignalPreview=failureLike(safeValue),pointer={handle,totalBytes:storedBytes,totalLines,note:VIRTUALIZED_OUTPUT_NOTE};
    // The person sees what they would see without the collapse: the whole value, or its preview when it is too large.
    const uiValue=totalBytes<=this.maxHotBytes?safeValue:{...scalarMetadata(safeValue),preview:preview(text,DEFAULT_PREVIEW_CHARS,{compactSignalPreview}),_trebell_output:pointer};
    if(byteLength(collapsedText)<=this.maxHotBytes){
      try{this.onVirtualized?.({handle,totalBytes:storedBytes,namespace,name,archived:true})}catch{}
      return {
        virtualized:false,archived:true,collapsedLines:collapsed.removedLines,totalBytes,handle,uiValue,
        value:{...collapsed.value,_trebell_output:{handle,totalBytes:storedBytes,totalLines,archived:true,note:COLLAPSED_OUTPUT_NOTE}},
      };
    }
    try{this.onVirtualized?.({handle,totalBytes:storedBytes,namespace,name})}catch{}
    return {
      virtualized:true,collapsedLines:collapsed.removedLines,totalBytes,handle,uiValue,
      value:{...model.metadata,preview:preview(collapsedText,DEFAULT_PREVIEW_CHARS,{compactSignalPreview,signalText:model.text}),_trebell_output:pointer},
    };
  }
  async archive(value,{namespace=null,name=null,minBytes=0}={}){
    const safeValue=redactSecretValue(value,{environment:this.environment,maxDepth:20,maxArray:5000,maxFields:5000});
    const text=serialized(safeValue),totalBytes=byteLength(text),threshold=Math.max(0,Math.trunc(Number(minBytes)||0));
    if(totalBytes<threshold)return {archived:false,totalBytes};
    await mkdir(this.directory,{recursive:true});
    const handle="out_"+randomUUID(),payload={handle,createdAt:Date.now(),namespace,name,totalBytes,text};
    await writeFile(this.#path(handle),JSON.stringify(payload),"utf8");
    await this.#prune();
    try{this.onVirtualized?.({handle,totalBytes,namespace,name,archived:true})}catch{}
    return {archived:true,handle,totalBytes,totalLines:text.split(/\r?\n/).length};
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
    if(call.name==="inspect")return String(call.arguments?.query||"").trim()?await this.search(call.arguments||{}):await this.read(call.arguments||{});
    if(call.name==="read")return await this.read(call.arguments||{});
    if(call.name==="search")return await this.search(call.arguments||{});
    throw new Error("Unknown Trebell output tool: "+String(call.name||""));
  }
}
