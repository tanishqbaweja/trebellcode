import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuntimeEnvironment } from "./runtime-environment.mjs";

// An attached Word, Excel, PowerPoint, OpenDocument, RTF, EPUB or Jupyter notebook file is an archive or markup that an agent's tools
// read as bytes, so Trebell extracts its text once into a file in its attachments folder that every harness is told of ("(text
// extracted to: …)"). The extraction runs in a process of its own on Trebell's own Node,
// hidden and without a shell, under a 192 MB heap and 15 s, one at a time: the file is untrusted (a zip bomb, XML nested or repeated
// without end).
export const DOCUMENT_TEXT_EXTENSIONS=Object.freeze(new Set([".docx",".xlsx",".pptx",".odt",".ods",".odp",".rtf",".epub",".ipynb"]));
const WORKER=fileURLToPath(new URL("./document-text-worker.mjs",import.meta.url));
const MAX_INPUT_BYTES=16*1024*1024,TIMEOUT_MS=15_000,MAX_OUTPUT_BYTES=4*1024*1024+1024,HEAP_MB=192,RETRY_MS=1000,FAILURES_KEPT=1024;
// The worker's exit code for a document it refused: corrupt, encrypted, not what its name says or with no text. It is not tried again.
export const DOCUMENT_REJECTED=2;

export const isDocumentTextPath=path=>DOCUMENT_TEXT_EXTENSIONS.has(extname(String(path||"")).toLowerCase());
const isFile=path=>stat(path).then(info=>info.isFile(),()=>false);

// Where the text of the file at path goes. An upload Trebell saved in its attachments folder keeps it beside it (<file>.txt), and it
// goes with the upload. A file the person attached from their own folders keeps it in the attachments folder, never beside their
// file, by the file's path, modification time and size, so a file changed since it was attached has its text extracted again.
export function documentTextPath(path,{home,info}){
  const file=resolve(String(path)),folder=resolve(home,"attachments");
  if(relative(folder,dirname(file))==="")return file+".txt";
  const key=createHash("sha256").update(`${file}\0${info.mtimeMs}\0${info.size}`).digest("hex").slice(0,32);
  return join(folder,`${key}-${basename(file).replace(/[^a-zA-Z0-9._-]/g,"_").slice(-100)}.txt`);
}

// The file the text of the document at path was extracted to, or null while it has none: nothing is extracted here. A message's
// prompt names it this way, and so does a send's second check of its
// files: attaching the file and the first check of a message about to go extract it (ensureDocumentText), so a send extracts at
// most once.
export async function extractedDocumentText(path,{home=null}={}){
  if(!home||!isDocumentTextPath(path))return null;
  const file=resolve(String(path)),info=await stat(file).catch(()=>null);
  if(!info?.isFile())return null;
  const sidecar=documentTextPath(file,{home,info});
  return await isFile(sidecar)?sidecar:null;
}

// The text extracted from the document at path, or null: a file that is no document, a document over 16 MB or one the worker
// refused gets none, and the person's file is never changed. A failure of the system's is tried again a second later.
// home: Trebell's home, whose attachments folder keeps the text. worker and env are the process's, for tests.
const failures=new Map();let turn=Promise.resolve();
export async function ensureDocumentText(path,{home=null,env=process.env,now=Date.now,worker=WORKER}={}){
  if(!home||!isDocumentTextPath(path))return null;
  const file=resolve(String(path)),info=await stat(file).catch(()=>null);
  if(!info?.isFile())return null;
  const sidecar=documentTextPath(file,{home,info});
  if(await isFile(sidecar))return sidecar;
  if(info.size>MAX_INPUT_BYTES)return null;
  const run=turn.then(async()=>{
    if(await isFile(sidecar))return sidecar;
    if((failures.get(sidecar)??0)>now())return null;
    let text;
    try{text=await extract(file,{env,worker})}
    catch(error){
      if(failures.size>=FAILURES_KEPT)failures.delete(failures.keys().next().value);
      failures.set(sidecar,error?.code===DOCUMENT_REJECTED?Infinity:now()+RETRY_MS);
      return null;
    }
    const pending=sidecar+".part";
    try{await mkdir(dirname(sidecar),{recursive:true});await writeFile(pending,text,"utf8");await rename(pending,sidecar);return sidecar}
    catch{return null}
    finally{await rm(pending,{force:true}).catch(()=>{})}
  });
  turn=run.catch(()=>{});
  return run;
}

// The worker's command: Trebell's own Node (Electron's, run as Node, in the desktop app) with the heap limit on its command line,
// hidden on Windows and with no shell between. The document is untrusted, so its process gets the baseline every internal child of
// Trebell's gets (PATH, the temp folders, the locale), and none of the server's keys, tokens or NODE_OPTIONS.
export function documentTextCommand(path,{env=process.env,worker=WORKER,electron=Boolean(process.versions?.electron)}={}){
  const environment=buildRuntimeEnvironment("native",{parent:env});
  if(electron)environment.ELECTRON_RUN_AS_NODE="1";
  return {file:process.execPath,args:[`--max-old-space-size=${HEAP_MB}`,worker,path,extname(path).toLowerCase()],options:{timeout:TIMEOUT_MS,maxBuffer:MAX_OUTPUT_BYTES,encoding:"utf8",windowsHide:true,shell:false,env:environment}};
}
function extract(path,options){
  const {file,args,options:spawnOptions}=documentTextCommand(path,options);
  return new Promise((resolveText,reject)=>execFile(file,args,spawnOptions,(error,stdout)=>error?reject(error):resolveText(stdout)));
}
