// Word, Excel, PowerPoint, OpenDocument, RTF, EPUB and notebook files are archives or markup that a harness's own tools would read as
// bytes. Trebell reads the text of an attached one once and keeps it in a plain text file that every harness is told of
// in the line that names the document (attachment-line.mjs). This module says where that file is, finds it, makes it when asked, and
// builds the command of the process that does the reading (document-text-worker.mjs). The document is untrusted, so that process is
// hidden, has no shell, none of the server's keys and a small heap, and is stopped after 15 s.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BOUNDS, documentKind } from "./document-reading.mjs";
import { buildRuntimeEnvironment } from "./runtime-environment.mjs";

// The script the reading process runs, beside this module, and execFile as a promise of what that process prints.
const WORKER_SCRIPT=fileURLToPath(new URL("./document-text-worker.mjs",import.meta.url));
const execFileAsync=promisify(execFile);

// How the worker exits for a document it will not read (corrupt, encrypted, not what its name says, or without text): such a document
// is not tried again. Any other failure is the system's and is tried again a second later.
export const DOCUMENT_REJECTED=2;

const LIMITS=Object.freeze({
  workerHeapMb:192,
  workerMs:15_000,
  // The most the reader prints: its text at up to 4 bytes a character in UTF-8, and room for its closing note.
  workerOutputBytes:BOUNDS.textCharacters*4+4096,
  // Trebell's own 2 s: the reads one send makes of a document (each prompt and its chips) meet one failure once, and a person who
  // fixed the file and sends again a moment later has it read anew.
  retryAfterMs:2_000,
  failuresKept:1_024,
});

// Whether the file at path is a kind of document whose text Trebell reads (document-reading.mjs lists the kinds).
export function isDocumentTextPath(path){
  return documentKind(extname(String(path??"")))!==null;
}

// The text file of the document at path, whose stat is info. An upload already in Trebell's attachments folder has it right beside it
// (<upload>.txt), so the cleanup of old uploads removes both together. A file from the person's own folders has it in the attachments
// folder instead, since nothing is ever written beside the person's files, under a name made from the file's path, modification time
// and size: once the file changes its text is read again. These names are what earlier versions wrote, so their text files are found.
export function documentTextPath(path,{home,info}){
  const document=resolve(String(path)),attachments=resolve(home,"attachments");
  if(relative(attachments,dirname(document))==="")return `${document}.txt`;
  const stamp=createHash("sha256").update([document,info.mtimeMs,info.size].join("\0")).digest("hex").slice(0,32);
  return join(attachments,`${stamp}-${basename(document).replace(/[^\w.-]/g,"_").slice(-100)}.txt`);
}

// The document behind path as this module uses it, {document, size, largestFile, textFile}, or null when there is nothing to read: no
// Trebell home to keep text in, a file of another kind, or no regular file at path. largestFile is the most of its kind that is read.
async function locate(path,home){
  if(!home||!isDocumentTextPath(path))return null;
  const document=resolve(String(path)),info=await stat(document).catch(()=>null);
  if(!info||!info.isFile())return null;
  return {document,size:info.size,largestFile:documentKind(extname(document)).largestFile,textFile:documentTextPath(document,{home,info})};
}
async function isRegularFile(path){
  try{return (await stat(path)).isFile()}catch{return false}
}

// The text file already made for the document at path, or null. Nothing is read here and nothing waits, so a turn can name the text
// without waiting on a reading: the composer's taking in of a file and its check of a message make the text (ensureDocumentText).
export async function extractedDocumentText(path,{home=null}={}){
  const found=await locate(path,home);
  return found&&await isRegularFile(found.textFile)?found.textFile:null;
}

// Runs the jobs given to it one at a time, each after the one before has settled, so one failing never holds up the rest.
class OneAtATime{
  #queue=[];
  #busy=false;
  run(job){
    return new Promise((done,fail)=>{this.#queue.push({job,done,fail});if(!this.#busy)this.#drain()});
  }
  async #drain(){
    this.#busy=true;
    while(this.#queue.length){
      const {job,done,fail}=this.#queue.shift();
      try{done(await job())}catch(error){fail(error)}
    }
    this.#busy=false;
  }
}

// The documents whose last reading failed, by their text file, and how. One the worker refused stays refused; after any other failure
// a document waits retryAfterMs before it is tried again. At most limit documents are kept: a document that fails again counts as
// the newest, and past the limit the one kept longest is forgotten first. Exported for its tests.
export class FailedExtractions{
  #failures=new Map();
  #limit;
  #retryAfterMs;
  constructor({limit=LIMITS.failuresKept,retryAfterMs=LIMITS.retryAfterMs}={}){
    this.#limit=limit;this.#retryAfterMs=retryAfterMs;
  }
  get size(){return this.#failures.size}
  // Whether the document must not be tried at the time at (ms).
  blocks(textFile,at){
    const failure=this.#failures.get(textFile);
    return failure!==undefined&&(failure.refused||at-failure.at<this.#retryAfterMs);
  }
  record(textFile,{refused,at}){
    this.#failures.delete(textFile);
    for(const oldest of this.#failures.keys()){
      if(this.#failures.size<this.#limit)break;
      this.#failures.delete(oldest);
    }
    this.#failures.set(textFile,{refused:Boolean(refused),at});
  }
}

const readings=new OneAtATime(),failed=new FailedExtractions();

// The text file of the document at path, made now when there is none yet, or null: a file of another kind, a document larger than its
// kind is read at (50 MiB, 20 MiB for a notebook), one the worker refused and one whose reading failed less than a second ago get none. Text already there is used as it is, without
// waiting for other documents; documents are read one at a time. The person's file is only ever read.
// home: Trebell's home, whose attachments folder keeps the text. env, now and worker stand in for the process's own in tests.
export async function ensureDocumentText(path,{home=null,env=process.env,now=Date.now,worker=WORKER_SCRIPT}={}){
  const found=await locate(path,home);
  if(!found)return null;
  if(await isRegularFile(found.textFile))return found.textFile;
  if(found.size>found.largestFile)return null;
  return readings.run(()=>readDocument(found,{env,now,worker}));
}

// One document's turn: another call may have made its text while this one waited, and a recent failure holds it back.
async function readDocument({document,textFile},{env,now,worker}){
  if(await isRegularFile(textFile))return textFile;
  if(failed.blocks(textFile,now()))return null;
  const outcome=await runWorker(document,{env,worker}).then(text=>({text}),error=>({error}));
  if("error" in outcome){
    failed.record(textFile,{refused:outcome.error?.code===DOCUMENT_REJECTED,at:now()});
    return null;
  }
  return await putInPlace(textFile,outcome.text)?textFile:null;
}

// Writes text to <textFile>.part and renames that onto textFile, so no reader ever sees half of it; true once it is there. The .part
// file is removed whatever happened.
async function putInPlace(textFile,text){
  const partial=textFile+".part";
  const placed=await mkdir(dirname(textFile),{recursive:true})
    .then(()=>writeFile(partial,text,"utf8"))
    .then(()=>rename(partial,textFile))
    .then(()=>true,()=>false);
  await rm(partial,{force:true}).catch(()=>{});
  return placed;
}

// The command that reads one document: Trebell's own Node (Electron's, run as Node, in the desktop app) with the heap limit on its
// command line, hidden and with no shell. Its environment is the baseline every internal child of Trebell's gets (PATH, the temp
// folders, the locale), so none of the server's keys, tokens or NODE_OPTIONS reach the process that opens an untrusted file.
export function documentTextCommand(path,{env=process.env,worker=WORKER_SCRIPT,electron=Boolean(process.versions?.electron)}={}){
  const environment={...buildRuntimeEnvironment("native",{parent:env}),...(electron?{ELECTRON_RUN_AS_NODE:"1"}:{})};
  return {
    file:process.execPath,
    args:[`--max-old-space-size=${LIMITS.workerHeapMb}`,worker,path,extname(path).toLowerCase()],
    options:{timeout:LIMITS.workerMs,maxBuffer:LIMITS.workerOutputBytes,encoding:"utf8",windowsHide:true,shell:false,env:environment},
  };
}
async function runWorker(document,{env,worker}){
  const {file,args,options}=documentTextCommand(document,{env,worker});
  return (await execFileAsync(file,args,options)).stdout;
}
