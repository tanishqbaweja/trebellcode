import { statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { documentTextPath, isDocumentTextPath } from "./document-text.mjs";
import { fileUriPath } from "./file-uri.mjs";
import { PROMPT_AUDIO_PATH, PROMPT_IMAGE_PATH, PROMPT_TEXT_PATH } from "./prompt-attachments.mjs";

// A document's extracted text holds up to 2,000,000 characters (document-text.mjs), which UTF-8 keeps in at most 6,000,000 bytes.
const SOURCE_MAX_BYTES=8*1024*1024;

// The files a Trebell Native thread's messages carried on this machine, and the text Trebell extracted from its documents
// (document-text.mjs): the files its two reads open wherever they are, at every access level, since the person gave them to the
// thread: read_file (the gateway's and the built-in tools' attachedFile) and read_source, which reads any range of their lines, so
// the text of a long document can be read to its end (readSource, the tool executor's attachedSource). Only these exact files: no
// other file beside them, no folder of them and no other thread's attachments, and no other tool reaches them.
export class NativeAttachedFiles{
  #files=new Map();
  #platform;
  #root;
  // root: the thread's workspace, which a relative path starts from, as the read tools place it.
  constructor({platform=process.platform,root=null}={}){this.#platform=platform;this.#root=typeof root==="string"&&root?root:null}
  #key(path){const full=resolve(path);return this.#platform==="win32"?full.toLowerCase():full}
  add(path){
    const text=typeof path==="string"?path.trim():"";
    if(text&&isAbsolute(text))this.#files.set(this.#key(text),resolve(text));
  }
  // The attached file a path names, as it was attached, or null: an absolute path, or one relative to the workspace that leads to it
  // (a model may write ../../home/attachments/<file> from the project instead of the path its message gave).
  find(path){
    const text=typeof path==="string"?path.trim():"";if(!text)return null;
    const full=isAbsolute(text)?text:this.#root?resolve(this.#root,text):null;
    return full?this.#files.get(this.#key(full))??null:null;
  }
  // A read_source of an attached file: the lines it asks for, read where the file is, as the repository's read gives a project file's
  // (context-engine readSourceRange: at most 400 lines and 32,000 characters at a time). null for any path that is not attached.
  async readSource({path,startLine=1,endLine=null,maxLines=200}={}){
    const file=this.find(path);if(!file)return null;
    const info=await stat(file);if(!info.isFile())throw new Error(`The attached file is not a file: ${path}`);
    if(info.size>SOURCE_MAX_BYTES)throw new Error(`The attached file is too large to read as text: ${path}`);
    const content=await readFile(file,"utf8");if(content.includes("\u0000"))throw new Error(`The attached file is binary: ${path}`);
    const lines=content.split(/\r?\n/),start=Math.max(1,Math.trunc(Number(startLine)||1)),lineCap=Math.max(1,Math.min(400,Math.trunc(Number(maxLines)||200)));
    if(start>Math.max(1,lines.length))throw new Error(`Source range starts after the end of ${path}, which has ${lines.length} lines`);
    const requestedEnd=endLine==null?start+lineCap-1:Math.max(start,Math.trunc(Number(endLine)||start));let end=Math.min(lines.length,requestedEnd,start+lineCap-1);
    const selected=[];let chars=0,truncated=false;
    for(let line=start;line<=end;line++){
      const value=lines[line-1]??"",cost=value.length+(selected.length?1:0);
      if(chars+cost>32_000){truncated=true;break}
      selected.push(value);chars+=cost;
    }
    end=start+selected.length-1;
    if(end<Math.min(lines.length,requestedEnd))truncated=true;
    return {path:file,startLine:start,endLine:end,totalLines:lines.length,content:selected.join("\n"),truncated};
  }
  // A message's parts as the relay built them (agent-relay acpPrompt): each file's path, and a document's extracted text.
  addPromptParts(parts=[]){
    for(const part of Array.isArray(parts)?parts:[]){
      if(part?.type==="resource_link"){this.add(fileUriPath(part.uri));this.add(part[PROMPT_TEXT_PATH])}
      this.add(part?.[PROMPT_IMAGE_PATH]);this.add(part?.[PROMPT_AUDIO_PATH]);
    }
  }
  // The files a thread's stored messages went with (agent-relay fileInputs), and the text of each document that has some, for a
  // session that starts on a thread with earlier messages (after a restart, say).
  addThread(thread,{home=null}={}){
    for(const turn of Array.isArray(thread?.turns)?thread.turns:[])for(const item of Array.isArray(turn?.items)?turn.items:[]){
      if(item?.type!=="userMessage"||!Array.isArray(item.content))continue;
      for(const part of item.content){
        if(!["mention","localImage","localAudio"].includes(part?.type)||typeof part.path!=="string")continue;
        this.add(part.path);
        if(home&&isDocumentTextPath(part.path))try{this.add(documentTextPath(part.path,{home,info:statSync(part.path)}))}catch{}
      }
    }
  }
}
