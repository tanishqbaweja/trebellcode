function inputPath(item){
  if(!item||typeof item!=="object")return null;
  if(["localImage","localAudio","mention","skill"].includes(item.type)&&item.path)return String(item.path);
  return null;
}

function inputContextChip(item){
  if(!item||typeof item!=="object"||!item.path)return null;
  if(item.type==="mention")return {path:String(item.path),kind:"file",label:String(item.name||String(item.path).split(/[\\/]/).pop()||"File"),detail:String(item.path)};
  if(item.type==="skill")return {path:String(item.path),kind:"skill",label:String(item.name||"Skill"),detail:String(item.path)};
  return null;
}

export function nativeQueueUnavailable(error){
  const message=String(error?.message||error||"").toLowerCase();
  return /method not found|unknown method|user message queue is unavailable|queue is unavailable|experimental method/.test(message);
}

export function shouldUseRuntimeNativeQueue({agentRuntime="",nativeQueue=false,projectless=false}={}){
  if(!nativeQueue)return false;
  return String(agentRuntime||"").toLowerCase()==="native"||Boolean(projectless);
}

export function queuedSubmissionDraft(submission={}){
  const input=Array.isArray(submission.input)?submission.input:[];
  const textParts=input.filter(item=>item?.type==="text"&&typeof item.text==="string").map(item=>item.text).filter(Boolean);
  const attachments=[...new Set(input.map(inputPath).filter(Boolean))];
  const contextChips=input.map(inputContextChip).filter(Boolean);
  const unsupported=input.some(item=>item&&!(["text","localImage","localAudio","mention","skill"].includes(item.type)));
  const text=textParts.join("\n").trim();
  return {
    id:String(submission.id||""),
    text:text||"Queued attachment",
    draftText:text,
    attachments,
    contextChips,
    model:null,
    native:true,
    input,
    clientUserMessageId:submission.clientUserMessageId?String(submission.clientUserMessageId):"",
    editable:!unsupported&&Boolean(text),
  };
}

export function mergeNativeQueue(previous=[],submissions=[]){
  return (submissions||[]).map(submission=>{
    const next=queuedSubmissionDraft(submission);
    const existing=(previous||[]).find(item=>item?.native&&(item.id===next.id||(next.clientUserMessageId&&item.clientUserMessageId===next.clientUserMessageId)));
    return existing?{...next,contextChips:existing.contextChips||[],model:existing.model||null}:next;
  });
}

export function reorderQueue(items,id,direction){
  const current=[...(items||[])];const index=current.findIndex(item=>item?.id===id);const target=index+Number(direction||0);
  if(index<0||target<0||target>=current.length)return current;
  [current[index],current[target]]=[current[target],current[index]];return current;
}
