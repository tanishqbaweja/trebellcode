// The activity card of every turn of the open thread, kept per turn: the rows of its steps (oldest first), whether all of them
// are loaded and how many of them are the turn's first steps (head, once find has read them). Rows come from the history pages
// the window already reads (item pages, turn pages, a find hit's turn) and from the live card once its turn ends; a turn with no
// stored tool items has no card, nothing is guessed. Only the newest turn of an opened thread may be read once more, when the
// first item page cut it (see App's openThreadInternal).
import { activityRow, isCardItem, restoredRow, storedRow } from "./activity-item.js";
import { toolEventFailed } from "./tool-event-status.js";

const NO_ROWS=Object.freeze([]);
const turnKey=value=>value==null?"":String(value);

export function emptyTurnActivity(threadId=null){
  return {threadId,turns:{},boundaryTurnId:null};
}

// rowsByTurn adds one item to its turn's rows: an item with no id is left out (a position-based id would differ from page to
// page and show the step twice), one already listed is replaced where it stands. A turn the entries name gets its list even
// when it has no card item, so its completeness is still recorded. The active turn's steps keep their running status.
function addItem(rowsByTurn,ids,turnId,item,activeTurnId){
  if(!rowsByTurn[turnId]){rowsByTurn[turnId]=[];ids[turnId]=new Map()}
  if(!isCardItem(item)||item.id==null||item.id==="")return;
  const row=restoredRow(activityRow(item,{turnId}));
  const kept=turnId===activeTurnId?row:storedRow(row),index=ids[turnId].get(String(item.id));
  if(index==null){ids[turnId].set(String(item.id),rowsByTurn[turnId].length);rowsByTurn[turnId].push(kept)}
  else rowsByTurn[turnId][index]=kept;
}

// Item entries ({turnId, item}) read oldest first. turnId keeps only that turn's entries (a page asked for one turn).
export function cardRowsFromItemEntries(entries=[],{activeTurnId=null,turnId=null}={}){
  const out={},ids={},active=turnKey(activeTurnId),only=turnKey(turnId);
  for(const entry of entries||[]){
    const id=turnKey(entry?.turnId);if(!id||!entry?.item||(only&&id!==only))continue;
    addItem(out,ids,id,entry.item,active);
  }
  return out;
}

// Turns read oldest first, each with its items (a turn page read in full, a whole thread).
export function cardRowsFromTurns(turns=[],{activeTurnId=null}={}){
  const out={},ids={},active=turnKey(activeTurnId);
  for(const turn of turns||[]){
    const id=turnKey(turn?.id);if(!id)continue;
    if(!out[id]){out[id]=[];ids[id]=new Map()}
    for(const item of turn.items||[])addItem(out,ids,id,item,active);
  }
  return out;
}

// Which turns of an item page (entries newest first) hold all their items. A page reads a turn's newest items first, so only its
// oldest turn can be cut: it is whole when its user message is on the page or nothing older is left.
export function itemPageCompleteness(entries=[],nextCursor=null){
  const out={};let oldest="";
  for(const entry of entries||[]){const id=turnKey(entry?.turnId);if(!id)continue;out[id]=true;oldest=id}
  if(oldest&&nextCursor)out[oldest]=(entries||[]).some(entry=>turnKey(entry?.turnId)===oldest&&entry?.item?.type==="userMessage");
  return out;
}

// The turn an item page may have cut (its oldest), while older pages remain.
export function itemPageBoundaryTurnId(entries=[],nextCursor=null){
  if(!nextCursor)return null;
  for(let index=(entries||[]).length-1;index>=0;index--){const id=turnKey(entries[index]?.turnId);if(id)return id}
  return null;
}

function sameRow(left,right){
  if(left===right)return true;
  if(!left||!right||left.id!==right.id||left.kind!==right.kind||left.title!==right.title||left.status!==right.status||left.output!==right.output||left.turnId!==right.turnId)return false;
  if(left.raw===right.raw)return true;
  try{return JSON.stringify(left.raw)===JSON.stringify(right.raw)}catch{return false}
}
function sameRows(left,right){
  return left===right||(left.length===right.length&&left.every((row,index)=>sameRow(row,right[index])));
}

// A turn holds at most its first steps (head of them, read by find from the turn's start) and its last ones (every other read goes
// back from the turn's end: the open page, older pages, the turn's own newest-first page), so the steps a read adds lie between
// the two: a known step is updated where it stands, the others (in their order) go after the first steps.
function placedRows(rows,incoming,head){
  if(!incoming?.length)return rows;
  const index=new Map(rows.map((row,at)=>[String(row.id),at])),added=[],addedIds=new Set();let updated=null;
  for(const row of incoming){
    const id=String(row.id),at=index.get(id);
    if(at==null){if(!addedIds.has(id)){addedIds.add(id);added.push(row)}continue}
    if(sameRow(rows[at],row))continue;
    if(!updated)updated=rows.slice();updated[at]=row;
  }
  if(!added.length&&!updated)return rows;
  const kept=updated||rows;
  return added.length?[...kept.slice(0,head),...added,...kept.slice(head)]:kept;
}

// Adds rows by turn to the store. mode "older" adds steps read back from a turn's end, "first" its first steps (find reads them
// oldest first), and "replace" makes the incoming rows the turn's (a whole turn read at once, a live card sealed). complete is a
// flag per turn or one for all: a turn once whole stays whole, except under "replace", which sets it, and a read that reaches the
// steps held from the other end leaves nothing between them. The same store when nothing changed; untouched turns keep their arrays.
export function mergeTurnActivity(store,rowsByTurn={},{mode="older",complete=false}={}){
  const turns=store?.turns||{};let next=null;
  for(const [turnId,incoming] of Object.entries(rowsByTurn||{})){
    const known=turns[turnId],held=known?.rows||NO_ROWS,list=Array.isArray(incoming)?incoming:NO_ROWS,head=Math.min(known?.head||0,held.length);
    const flag=complete&&typeof complete==="object"?Boolean(complete[turnId]):Boolean(complete);
    const rows=mode==="replace"?(sameRows(held,list)?held:list):placedRows(held,list,head);
    let nextHead=Math.min(head,rows.length),met=false;
    if(mode!=="replace"&&list.length){
      const heldAt=new Map(held.map((row,at)=>[String(row.id),at]));
      met=list.some(row=>{const at=heldAt.get(String(row.id));return at!=null&&(mode==="first"?at>=head:at<head)});
      if(mode==="first"){const at=new Map(rows.map((row,index)=>[String(row.id),index]));for(const row of list)nextHead=Math.max(nextHead,(at.get(String(row.id))??-1)+1)}
    }
    const whole=mode==="replace"?flag:Boolean(known?.complete)||flag||met;
    if(known&&rows===known.rows&&whole===known.complete&&nextHead===(known.head||0))continue;
    if(!next)next={...turns};
    next[turnId]=nextHead?{rows,complete:whole,head:nextHead}:{rows,complete:whole};
  }
  return next?{...store,turns:next}:store;
}

// The card's head: "1 step", "12 steps", with " · some steps not loaded" while the turn is not whole, and how many steps failed.
export function activitySummary(rows=[],{complete=true}={}){
  const list=Array.isArray(rows)?rows:[],count=list.length;
  return {text:(count===1?"1 step":count.toLocaleString("en-US")+" steps")+(complete?"":" · some steps not loaded"),failed:list.filter(toolEventFailed).length};
}

// The turn whose card opens by itself: none while a sent message waits for its turn, else the thread's newest turn by the turn
// order, by the messages, or by the cards held.
export function newestCardTurnId({messages=[],turnOrder=null,turns=null}={}){
  const list=Array.isArray(messages)?messages:[],last=list.at(-1);
  if(last?.role==="user"&&!last.turnId)return null;
  const ordered=(turnOrder||[]).map(turnKey).filter(Boolean);if(ordered.length)return ordered.at(-1);
  for(let index=list.length-1;index>=0;index--){const id=turnKey(list[index]?.turnId);if(id)return id}
  const held=Object.keys(turns||{}).filter(id=>turns[id]?.rows?.length);
  return held.at(-1)||null;
}

// The turns that have a card, those whose steps (and maybe reply) are not all loaded, and those whose steps are all compactions (the
// turn Compact runs, a harness's own /compact): their card says how they ended.
export function storeCardTurnIds(store){
  return Object.keys(store?.turns||{}).filter(id=>store.turns[id]?.rows?.length);
}
export function storeIncompleteTurnIds(store){
  return Object.keys(store?.turns||{}).filter(id=>store.turns[id]&&!store.turns[id].complete);
}
export function storeCompactionTurnIds(store){
  return Object.keys(store?.turns||{}).filter(id=>{const rows=store.turns[id]?.rows;return rows?.length>0&&rows.every(row=>row?.kind==="contextCompaction")});
}
