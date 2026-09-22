import { createHash } from "node:crypto";

export function prViewedKey(provider,number){return `${String(provider||"unknown").toLowerCase()}:${Number(number)||0}`}
export function prFilePath(file){return String(file?.path||file?.newPath||file?.new_path||file?.filename||"").trim()}
export function prFileRevision(file,headSha=null){
  const path=prFilePath(file);const head=String(headSha||"").trim();if(head)return head;
  const stable={path,additions:Number(file?.additions||file?.lines_added||0),deletions:Number(file?.deletions||file?.lines_removed||0),status:file?.status||file?.type||null,patch:file?.patch||file?.diff||null};
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
export function viewedStates(files,record={},headSha=null){
  const marks=record?.files&&typeof record.files==="object"?record.files:{};
  return (files||[]).map(file=>{const path=prFilePath(file),mark=marks[path];let state="unviewed";if(mark){state=mark.revision===prFileRevision(file,headSha)?"viewed":"dismissed"}return {path,state}}).filter(item=>item.path);
}
export function updateViewedRecord(files,record={},headSha=null,updates=[]){
  const next={headSha:String(headSha||""),files:{...(record?.files||{})},updatedAt:Date.now()};const byPath=new Map((files||[]).map(file=>[prFilePath(file),file]));
  for(const update of updates||[]){const path=String(update?.path||"").trim();if(!path||!byPath.has(path))continue;if(update.viewed===false)delete next.files[path];else next.files[path]={revision:prFileRevision(byPath.get(path),headSha),viewedAt:Date.now()}}
  return next;
}
