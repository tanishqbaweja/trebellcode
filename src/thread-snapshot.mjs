// A thread's catalog snapshot as Trebell's state keeps it: the fields a sidebar shows before a live listing arrives, each one
// bounded. The server hands the page its catalog in this shape, and the page compares a fresh listing in it, so a thread the
// server already holds is not posted again on every load.
export function boundedText(value,max=1000){const text=String(value??"").trim();return text?text.slice(0,max):null}
export function compactThreadSnapshot(value){
  if(!value||typeof value!=="object")return null;
  const section=value.section&&typeof value.section==="object"?{id:boundedText(value.section.id,300),name:boundedText(value.section.name,300)}:null;
  const status=value.status&&typeof value.status==="object"?{type:boundedText(value.status.type,80),activeFlags:Array.isArray(value.status.activeFlags)?value.status.activeFlags.slice(0,20).map(item=>String(item).slice(0,100)):[]}:null;
  return {id:boundedText(value.id,500),name:boundedText(value.name,500),preview:boundedText(value.preview,1000),cwd:boundedText(value.cwd,4000),model:boundedText(value.model,500),updatedAt:Number(value.updatedAt)||0,createdAt:Number(value.createdAt)||0,...(status?{status}:{}),...(section?{section}:{}),projectId:boundedText(value.projectId,500),runtime:boundedText(value.runtime,80),provider:boundedText(value.provider,200)};
}
