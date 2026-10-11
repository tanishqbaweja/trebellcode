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
// worded as the activity card words that error, hint included. A code with no text reads as the card reads it when the code
// carries a hint (a usage limit, a sign-in); without one the card's "Agent error" says nothing the pill does not. "" when the
// turn recorded none.
export function turnFailureText(turn){
  const error=turn?.error;
  if(typeof error==="string")return error.trim();
  if(!error||typeof error!=="object")return "";
  const notice=codexErrorNotice({error});
  return (String(error.additionalDetails??"").trim()||String(error.message??"").trim()||notice.hint)?notice.title:"";
}

// How finished turns ended, by turn id, from a page of history turns. Imported history reports durationMs 0, which is
// not a measurement, so it is dropped. completedAt (seconds) tells a later completion of a turn from a replay of one.
export function turnOutcomesFromTurns(turns=[]){
  const out={};
  for(const turn of turns||[]){
    const id=turn?.id;if(!id)continue;
    const status=turnOutcomeStatus(turn.status);if(!status)continue;
    const error=turnFailureText(turn),completedAt=positiveDuration(turn.completedAt);
    out[String(id)]={status,durationMs:positiveDuration(turn.durationMs),...(completedAt?{completedAt}:{}),...(error?{error}:{})};
  }
  return out;
}

// Adds a history page's outcomes for one thread. Facts this window already holds (a mode it sent, a duration it measured
// to the millisecond, the error it was sent) are kept over the page's values, unless the page holds a later completion of
// the turn than the one this window recorded (the relay runs an interrupted turn again after a restart): that one replaces
// it, error and all. A page never removes a turn's outcome.
export function mergeTurnOutcomes(current={},threadId,turns=[]){
  const outcomes=turnOutcomesFromTurns(turns);
  let next=current;
  for(const [turnId,outcome] of Object.entries(outcomes)){
    const key=turnInfoKey(threadId,turnId);if(!key)continue;
    const known=current?.[key]||{};
    const later=Boolean(known.status&&known.completedAt&&outcome.completedAt>known.completedAt),{error:knownError,...kept}=known;
    const merged=later?{...kept,...outcome}:{...kept,status:known.status||outcome.status,durationMs:known.durationMs??outcome.durationMs};
    const completedAt=later?outcome.completedAt:known.completedAt??outcome.completedAt;if(completedAt)merged.completedAt=completedAt;
    const error=later?outcome.error:knownError||outcome.error;if(error)merged.error=error;else delete merged.error;
    if(known.status===merged.status&&known.durationMs===merged.durationMs&&known.mode===merged.mode&&known.error===merged.error&&known.completedAt===merged.completedAt)continue;
    if(next===current)next={...current};
    next[key]=merged;
  }
  return next;
}

// What a turn's completion notification records (App's turn/completed): its status, the time this window measured (else the
// harness's), when it completed and the error it ended with. A repeated completion with the same status (a replay after a
// reconnect) keeps the first time and, when it sends none, the first error; a completion that changes the status ended the
// turn anew and replaces them. A turn that starts again has its outcome cleared first (turnStartedAgain).
export function recordTurnCompletion(known={},{status,durationMs=null,completedAt=null,error=""}={}){
  const replay=known?.status===status,{error:knownError,...kept}=known||{};
  const next={...kept,status,durationMs:(replay?known.durationMs:null)??durationMs??null,completedAt:(replay?known.completedAt:null)??completedAt??null};
  const ended=error||(replay?knownError:"");if(ended)next.error=ended;
  return next;
}

// A turn the harness starts again under the same id (the relay's restart recovery) has not ended any more: its recorded
// outcome goes, the mode it was sent with stays. Unchanged (the same object) when it had none.
export function turnStartedAgain(known){
  if(!known?.status)return known;
  const {status,durationMs,completedAt,error,...kept}=known;
  return kept;
}

// The thread's turn ids, oldest first, from a page of turns listed newest first (a history page, a page of outcomes).
export function turnIdsOldestFirst(turns=[]){
  return [...(turns||[])].reverse().map(turn=>String(turn?.id||"")).filter(Boolean);
}

// The turn order with turns added after it (a turn that just started, the turns this window saw start while a history page
// loaded), each once.
export function appendTurnOrder(order=[],turnIds=[]){
  const known=new Set((order||[]).map(String)),added=[...new Set((turnIds||[]).map(String).filter(id=>id&&!known.has(id)))];
  return added.length?[...(order||[]),...added]:order||[];
}

// The turn order with an older run of turns in front of it (an older page of turns, read newest first and given oldest first).
// A run that reaches into the known turns adds only the turns before them; one that lies inside them adds nothing.
export function prependTurnOrder(order=[],older=[]){
  const known=(order||[]).map(String),run=[...new Set((older||[]).map(String).filter(Boolean))];
  if(!run.length)return order||[];
  if(!known.length)return run;
  const at=run.indexOf(known[0]);
  if(at>=0)return at?[...run.slice(0,at),...known]:order;
  const seen=new Set(known);
  return run.some(id=>seen.has(id))?order:[...run,...known];
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

// The pill under a turn's last reply: how the turn ended, with its time when one was measured (a relay records whole seconds, so
// a turn under a second, like an imported one, reads "done").
export function turnOutcomePill(info){
  const status=turnOutcomeStatus(info?.status);if(!status)return null;
  const time=formatTurnDuration(info?.durationMs);
  if(status==="completed")return {label:time?"done · "+time:"done",tone:"ok"};
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

// The rows that end the turns which failed or were stopped before any reply, or completed without one, as lists keyed by the id
// of the row they follow: the heading the reply would have had, the pill, and the error the turn ended with ("Finished without a
// reply." for a completed turn). A turn with rows (its message, a thought) ends after its last row. A turn with none (a goal
// continuing, or a harness's wake turn, that failed before any item) ends after the rows of the turn before it in turnOrder (the
// thread's turn ids, oldest first), where those rows meet the next turn's rows in the loaded history, not across the history gap
// (gapBeforeId) nor before rows of a turn turnOrder does not hold; key "" when it opens the thread, the thread's start being
// loaded (startLoaded). Rows after one row keep the turns' order. A failure the live activity card lists (cardFailedTurnIds) has
// no row, so it shows once: in the card while it is on screen, here once the card moves to a later turn or after a reload. A
// stop always has its row: the card never says so. A turn whose steps are not all loaded (incompleteTurnIds) may have a reply
// that is not loaded either, so it never reads as finished without one; nor does a turn the relay's history import made
// ("import-…"): it keeps a conversation's messages only and calls every turn completed, an interrupted request too.
// latest: the row is the card's turn's own and reads below the card with the rest of that turn (conversation-order.js);
// never in a virtualized list, which keeps its order.
function turnEndPlacement(messages=[],{harnessLabel="",turnInfo=null,threadId=null,cardFailedTurnIds=null,cardTurnId=null,reorder=true,turnOrder=null,gapBeforeId=null,startLoaded=false,incompleteTurnIds=null}={}){
  const list=Array.isArray(messages)?messages:[];
  const firstRow=new Map(),lastRow=new Map(),lastUserRow=new Map(),replied=new Set();let lastUser=-1;
  list.forEach((message,index)=>{
    if(message?.role==="user")lastUser=index;
    const turnId=message?.turnId;if(!turnId)return;
    const id=String(turnId);if(!firstRow.has(id))firstRow.set(id,index);lastRow.set(id,index);
    if(message.role==="user")lastUserRow.set(id,index);
    if(message.role==="assistant")replied.add(id);
  });
  const ends=new Map(),card=cardTurnId==null?"":String(cardTurnId),gap=gapBeforeId==null?null:String(gapBeforeId);
  const incomplete=incompleteTurnIds instanceof Set?incompleteTurnIds:new Set((incompleteTurnIds||[]).map(String));
  const ending=turnId=>{
    const info=turnInfo?.[turnInfoKey(threadId,turnId)]||null,pill=turnOutcomePill(info);
    if(!pill||(pill.tone==="err"&&cardFailedTurnIds?.has?.(turnId)))return null;
    if(pill.tone==="ok")return incomplete.has(turnId)||turnId.startsWith("import-")?null:{info,pill,note:"Finished without a reply."};
    return {info,pill};
  };
  const add=(key,turnId,{info,pill,note=""},index)=>{
    const row={
      turnId,
      heading:harnessLabel?[harnessLabel,info.mode].filter(Boolean).join(" · "):"",
      outcomeLabel:pill.label,outcomeTone:pill.tone,
      message:String(info.error||note||""),
      latest:Boolean(reorder)&&index>=lastUser&&(!card||card===turnId),
    };
    const rows=ends.get(key);if(rows)rows.push(row);else ends.set(key,[row]);
  };
  for(const [turnId,index] of lastRow){
    const end=replied.has(turnId)?null:ending(turnId);
    if(end)add(String(list[index].id),turnId,end,index);
  }
  const order=[...new Set((turnOrder||[]).map(String).filter(Boolean))],before=[],after=[];
  for(let index=0,seen=-1;index<order.length;index++){before[index]=seen;if(lastRow.has(order[index]))seen=index}
  for(let index=order.length-1,seen=-1;index>=0;index--){after[index]=seen;if(lastRow.has(order[index]))seen=index}
  // Where a turn with no rows of its own sits: after the row at the index returned, -1 opening the thread, null when not known yet.
  const rowlessAt=position=>{
    const previous=before[position]<0?-1:lastRow.get(order[before[position]]),next=after[position]<0?-1:firstRow.get(order[after[position]]);
    if(previous>=0)return next>=0
      ?(next===previous+1&&String(list[next].id)!==gap?previous:null)
      :(list.slice(previous+1).every(message=>!message?.turnId)?previous:null);
    if(startLoaded&&(next===0?String(list[0].id)!==gap:next<0&&!list.length))return -1;
    return null;
  };
  order.forEach((turnId,position)=>{
    if(lastRow.has(turnId))return;
    const end=ending(turnId);if(!end)return;
    const at=rowlessAt(position);
    if(at!=null)add(at<0?"":String(list[at].id),turnId,end,at);
  });
  return {list,ends,firstRow,lastUserRow,order,rowlessAt,gap};
}

export function turnEndRows(messages=[],options={}){
  return turnEndPlacement(messages,options).ends;
}

// Everything the conversation shows around its rows for the turns: each turn's activity card (cardTurnIds: the turns with stored
// steps; liveCardTurnId, the one the live card shows, has none here) and the end rows above. before/after: lists keyed by the id
// of the row they precede or follow ("" opens the thread). A card reads where the live card does: after its turn's last user
// message (a message steered in stays above it), else before the turn's first row (a goal continuing), else, for the turn an item
// page cut (boundaryTurnId), at the top of the newest pages, else where the turn's end row would be. At one row the turns keep
// their order (turnOrder, else where their rows start), and a turn's card comes before its end row.
export function turnTrailers(messages=[],options={}){
  const {list,ends,firstRow,lastUserRow,order,rowlessAt,gap}=turnEndPlacement(messages,options);
  const before=new Map(),after=new Map(),push=(map,key,entry)=>{const entries=map.get(key);if(entries)entries.push(entry);else map.set(key,[entry])};
  for(const [key,rows] of ends)for(const row of rows)push(after,key,{kind:"end",...row});
  const positions=new Map(order.map((turnId,index)=>[turnId,index]));
  const boundary=options.boundaryTurnId==null?"":String(options.boundaryTurnId);
  const newestStart=gap!=null&&list.some(message=>String(message?.id)===gap)?gap:list.length?String(list[0].id):"";
  const live=options.liveCardTurnId==null?"":String(options.liveCardTurnId);
  for(const turnId of new Set((options.cardTurnIds||[]).map(String).filter(Boolean))){
    if(turnId===live)continue;
    if(lastUserRow.has(turnId)){push(after,String(list[lastUserRow.get(turnId)].id),{kind:"card",turnId});continue}
    if(firstRow.has(turnId)){push(before,String(list[firstRow.get(turnId)].id),{kind:"card",turnId});continue}
    if(turnId===boundary){if(newestStart)push(before,newestStart,{kind:"card",turnId});else push(after,"",{kind:"card",turnId});continue}
    const position=positions.get(turnId),at=position==null?null:rowlessAt(position);
    if(at!=null)push(after,at<0?"":String(list[at].id),{kind:"card",turnId});
  }
  const rank=turnId=>positions.has(turnId)?positions.get(turnId):null,start=turnId=>firstRow.has(turnId)?firstRow.get(turnId):Infinity;
  const compare=(left,right)=>{
    if(left.turnId!==right.turnId){
      const a=rank(left.turnId),b=rank(right.turnId);if(a!=null&&b!=null)return a-b;
      const c=start(left.turnId),d=start(right.turnId);if(c!==d)return c<d?-1:1;
    }
    return (left.kind==="card"?0:1)-(right.kind==="card"?0:1);
  };
  for(const entries of [...before.values(),...after.values()])if(entries.length>1)entries.sort(compare);
  return {before,after};
}

// The turns whose failure the live activity card lists: the row of a failed Codex turn ("codex-error-<turn id>") and the row of
// a harness's error notification for the turn ("error-<time>", its turnId in raw). Other error rows are not the turn's failure:
// a retry (the turn went on after it), an auto review's denial or time-out, a verification or queue error.
export function cardFailedTurnIds(events=[]){
  const ids=new Set();
  for(const event of events||[]){
    if(event?.kind!=="error")continue;
    const id=String(event.id||"");
    const turnId=id.startsWith("codex-error-")?id.slice("codex-error-".length):/^error-\d+$/.test(id)?event.raw?.turnId:null;
    if(turnId)ids.add(String(turnId));
  }
  return [...ids].sort();
}
