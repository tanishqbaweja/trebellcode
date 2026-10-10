// What the conversation shows around a turn's replies: the first reply of a turn names the harness (and the access mode
// it was sent with, when this window sent it), and the last reply carries how the turn ended ("done · 3.2s"). Only real
// facts are shown: a mode nobody recorded and a duration nobody measured are left out, never guessed.

const PERMISSION_MODE_LABELS=Object.freeze({supervised:"Supervised",edits:"Auto-accept edits",auto:"Auto",full:"Full access","read-only":"Read only"});

export function permissionModeLabel(mode){
  return PERMISSION_MODE_LABELS[String(mode||"")]||"";
}

// Turn ids are only unique inside a thread, so facts are kept per thread and turn.
export function turnInfoKey(threadId,turnId){
  return threadId&&turnId?String(threadId)+"\u0000"+String(turnId):"";
}

// A finished turn's status as the conversation names it, or "" while it runs (or when the harness sent nothing usable).
export function turnOutcomeStatus(status){
  const value=String((typeof status==="string"?status:status?.type)||"").toLowerCase();
  if(value==="completed")return "completed";
  if(value==="interrupted"||value==="cancelled"||value==="canceled")return "interrupted";
  if(value==="failed"||value==="error")return "failed";
  return "";
}

function positiveDuration(value){
  if(value==null||value==="")return null;
  const number=Number(value);
  return Number.isFinite(number)&&number>0?number:null;
}

// How finished turns ended, by turn id, from a page of history turns. Imported history reports durationMs 0, which is
// not a measurement, so it is dropped.
export function turnOutcomesFromTurns(turns=[]){
  const out={};
  for(const turn of turns||[]){
    const id=turn?.id;if(!id)continue;
    const status=turnOutcomeStatus(turn.status);if(!status)continue;
    out[String(id)]={status,durationMs:positiveDuration(turn.durationMs)};
  }
  return out;
}

// Adds a history page's outcomes for one thread. Facts this window already holds (a mode it sent, or a duration it
// measured to the millisecond) are kept over the page's values; a page never removes anything.
export function mergeTurnOutcomes(current={},threadId,turns=[]){
  const outcomes=turnOutcomesFromTurns(turns);
  let next=current;
  for(const [turnId,outcome] of Object.entries(outcomes)){
    const key=turnInfoKey(threadId,turnId);if(!key)continue;
    const known=current?.[key]||{};
    const merged={...known,status:known.status||outcome.status,durationMs:known.durationMs??outcome.durationMs};
    if(known.status===merged.status&&known.durationMs===merged.durationMs&&known.mode===merged.mode)continue;
    if(next===current)next={...current};
    next[key]=merged;
  }
  return next;
}

export function formatTurnDuration(ms){
  const value=positiveDuration(ms);if(value==null)return "";
  if(value<10_000)return (Math.max(100,value)/1000).toFixed(1)+"s";
  const seconds=Math.round(value/1000);
  if(seconds<60)return seconds+"s";
  const minutes=Math.floor(seconds/60),restSeconds=seconds%60;
  if(minutes<60)return minutes+"m"+(restSeconds?" "+restSeconds+"s":"");
  const hours=Math.floor(minutes/60),restMinutes=minutes%60;
  return hours+"h"+(restMinutes?" "+restMinutes+"m":"");
}

// The pill under a turn's last reply. A completed turn without a measured duration gets none (the reply itself shows it
// finished); a stopped or failed turn always says so.
export function turnOutcomePill(info){
  const status=turnOutcomeStatus(info?.status);if(!status)return null;
  const time=formatTurnDuration(info?.durationMs);
  if(status==="completed")return time?{label:"done · "+time,tone:"ok"}:null;
  const word=status==="interrupted"?"stopped":"failed";
  return {label:time?word+" · "+time:word,tone:status==="interrupted"?"warn":"err"};
}

// Per assistant message id: the heading its row shows (first reply of a turn) and the outcome pill (last reply of a
// finished turn). Consecutive replies of one turn form a group; a user message in between starts a new group.
export function assistantRowDecorations(messages=[],{harnessLabel="",turnInfo=null,threadId=null}={}){
  const out=new Map();const list=Array.isArray(messages)?messages:[];
  for(let index=0;index<list.length;index++){
    const message=list[index];if(message?.role!=="assistant")continue;
    const turnId=message.turnId||null;
    const sameGroup=other=>other?.role==="assistant"&&(other.turnId||null)===turnId;
    const first=!sameGroup(list[index-1]),last=!sameGroup(list[index+1]);
    const info=turnId?(turnInfo?.[turnInfoKey(threadId,turnId)]||null):null;
    const heading=first&&harnessLabel?[harnessLabel,info?.mode].filter(Boolean).join(" · "):"";
    const pill=last?turnOutcomePill(info):null;
    if(!heading&&!pill)continue;
    out.set(String(message.id),{heading,outcomeLabel:pill?.label||"",outcomeTone:pill?.tone||""});
  }
  return out;
}
