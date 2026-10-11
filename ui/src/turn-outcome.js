// What the conversation shows around a turn's replies: the first reply of a turn names the harness (and the access mode
// it was sent with, when this window sent it), and the last reply carries how the turn ended ("done · 3.2s"). A turn that
// failed or was stopped before any reply ends with a row of its own saying so. Only real facts are shown: a mode nobody
// recorded, a duration nobody measured and an error nobody sent are left out, never guessed.
import { codexErrorNotice } from "./codex-turn-options.js";

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

// The error a turn ended with (Turn.error: Codex sends {message, additionalDetails, codexErrorInfo}, the relay {message}),
// worded as the activity card words that error, hint included. "" when the turn recorded none.
export function turnFailureText(turn){
  const error=turn?.error;
  if(typeof error==="string")return error.trim();
  if(!error||typeof error!=="object"||!(String(error.additionalDetails??"").trim()||String(error.message??"").trim()))return "";
  return codexErrorNotice({error}).title;
}

// How finished turns ended, by turn id, from a page of history turns. Imported history reports durationMs 0, which is
// not a measurement, so it is dropped.
export function turnOutcomesFromTurns(turns=[]){
  const out={};
  for(const turn of turns||[]){
    const id=turn?.id;if(!id)continue;
    const status=turnOutcomeStatus(turn.status);if(!status)continue;
    const error=turnFailureText(turn);
    out[String(id)]={status,durationMs:positiveDuration(turn.durationMs),...(error?{error}:{})};
  }
  return out;
}

// Adds a history page's outcomes for one thread. Facts this window already holds (a mode it sent, a duration it measured
// to the millisecond, the error it was sent) are kept over the page's values; a page never removes anything.
// failuresOnly takes only the failed and stopped turns (a thread opened on item pages: see App's resumeWithBoundedHistory).
export function mergeTurnOutcomes(current={},threadId,turns=[],{failuresOnly=false}={}){
  const outcomes=turnOutcomesFromTurns(turns);
  let next=current;
  for(const [turnId,outcome] of Object.entries(outcomes)){
    if(failuresOnly&&outcome.status==="completed")continue;
    const key=turnInfoKey(threadId,turnId);if(!key)continue;
    const known=current?.[key]||{};
    const merged={...known,status:known.status||outcome.status,durationMs:known.durationMs??outcome.durationMs};
    const error=known.error||outcome.error;if(error)merged.error=error;
    if(known.status===merged.status&&known.durationMs===merged.durationMs&&known.mode===merged.mode&&known.error===merged.error)continue;
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
// finished turn). Consecutive replies of one turn form a group; a user message in between starts a new group, a thought does not.
export function assistantRowDecorations(messages=[],{harnessLabel="",turnInfo=null,threadId=null}={}){
  const out=new Map();const list=(Array.isArray(messages)?messages:[]).filter(message=>message?.role!=="reasoning");
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

// The rows that end a turn which failed or was stopped before any reply, by the id of the turn's last row (its message or a
// thought), which the outcome row follows: the heading its reply would have had, the pill, and the error it ended with. A
// turn whose failure the live activity card lists (cardFailedTurnIds) has none, so the failure shows once: in the card while
// it is on screen, here once the card moves to a later turn or after a reload. latest: the row is the card's turn's own and
// reads below the card with the rest of that turn (conversation-order.js); never in a virtualized list, which keeps its order.
export function turnEndRows(messages=[],{harnessLabel="",turnInfo=null,threadId=null,cardFailedTurnIds=null,cardTurnId=null,reorder=true}={}){
  const list=Array.isArray(messages)?messages:[];
  const lastRow=new Map(),replied=new Set();let lastUser=-1;
  list.forEach((message,index)=>{
    if(message?.role==="user")lastUser=index;
    const turnId=message?.turnId;if(!turnId)return;
    lastRow.set(String(turnId),index);
    if(message.role==="assistant")replied.add(String(turnId));
  });
  const out=new Map(),card=cardTurnId==null?"":String(cardTurnId);
  for(const [turnId,index] of lastRow){
    if(replied.has(turnId)||cardFailedTurnIds?.has?.(turnId))continue;
    const info=turnInfo?.[turnInfoKey(threadId,turnId)]||null,pill=turnOutcomePill(info);
    if(!pill||pill.tone==="ok")continue;
    out.set(String(list[index].id),{
      turnId,
      heading:harnessLabel?[harnessLabel,info.mode].filter(Boolean).join(" · "):"",
      outcomeLabel:pill.label,outcomeTone:pill.tone,
      message:String(info.error||""),
      latest:Boolean(reorder)&&index>=lastUser&&(!card||card===turnId),
    });
  }
  return out;
}

// The turns whose failure the live activity card lists: an error row raised for the turn (an error notification carries its
// turnId; a failed Codex turn's row is "codex-error-<turn id>"). A retry row is not the failure: the turn went on after it.
export function cardFailedTurnIds(events=[]){
  const ids=new Set();
  for(const event of events||[]){
    if(event?.kind!=="error")continue;
    const id=String(event.id||"");if(id.startsWith("codex-retry-"))continue;
    const turnId=id.startsWith("codex-error-")?id.slice("codex-error-".length):event.raw?.turnId;
    if(turnId)ids.add(String(turnId));
  }
  return [...ids].sort();
}
