import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { documentTextPath, isDocumentTextPath } from "./document-text.mjs";
import { fileUriPath } from "./file-uri.mjs";
import { PROMPT_AUDIO_PATH, PROMPT_IMAGE_PATH, PROMPT_TEXT_PATH } from "./prompt-attachments.mjs";

// The files a Trebell Native thread's messages carried on this machine, and the text Trebell extracted from its documents
// (document-text.mjs): the files its read tool opens wherever they are, at every access level, since the person gave them to the
// thread (the gateway's and the built-in tools' attachedFile). Only these exact files: no other file beside them, no folder of
// them and no other thread's attachments, and no other tool reaches them.
export class NativeAttachedFiles{
  #files=new Map();
  #platform;
  constructor({platform=process.platform}={}){this.#platform=platform}
  #key(path){const full=resolve(path);return this.#platform==="win32"?full.toLowerCase():full}
  add(path){
    const text=typeof path==="string"?path.trim():"";
    if(text&&isAbsolute(text))this.#files.set(this.#key(text),resolve(text));
  }
  // The attached file an absolute path names, as it was attached, or null.
  find(path){
    const text=typeof path==="string"?path.trim():"";
    return text&&isAbsolute(text)?this.#files.get(this.#key(text))??null:null;
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
