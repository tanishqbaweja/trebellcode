// The earlier conversation of a thread, handed to the fresh session that takes over when a harness no longer has the thread's
// conversation, or that a fork starts. Pure: the relay fences the text
// into the prompt's working context, where fencedContextValue escapes it.

// How much earlier conversation a handoff may carry: 20,000 bytes of UTF-8 as the prompt carries it, Trebell's own choice of about
// five pages (some 4,000 bytes a page), enough for the last several exchanges a fresh session needs to carry on. A byte stands in
// for a token, since no token is shorter than a byte, so the handoff stays within 20,000 tokens with no tokenizer to count them.
export const THREAD_HISTORY_BUDGET=20_000;
// A command's output keeps its end, where a failure shows.
export const HISTORY_COMMAND_OUTPUT_LIMIT=2_000;

function tail(text,limit){
  if(text.length<=limit)return text;
  return `… ${(text.length-limit).toLocaleString("en-US")} earlier characters left out\n`+text.slice(-limit);
}
function messageText(content){
  const parts=Array.isArray(content)?content:[];
  const text=parts.filter(part=>part?.type==="text").map(part=>String(part.text||"")).join("\n").trim();
  const attached=parts.filter(part=>part&&part.type!=="text").length;
  return [text,attached?`(${attached} attachment${attached===1?"":"s"} not handed over)`:""].filter(Boolean).join("\n");
}

// One stored turn item as history, or null for what is not handed over (reasoning, tool calls, Trebell's own rows).
// role: user for the person's messages, assistant for the harness's replies, activity for the rest of what the turn did.
export function threadHistoryEntry(item){
  if(!item||typeof item!=="object")return null;
  if(item.type==="userMessage"){const text=messageText(item.content);return text?{role:"user",label:"user",text}:null}
  if(item.type==="agentMessage"){const text=String(item.text||"").trim();return text?{role:"assistant",label:"assistant",text}:null}
  if(item.type==="commandExecution"){
    const command=Array.isArray(item.command)?item.command.join(" "):String(item.command||"").trim()||"Command";
    const output=String(item.aggregatedOutput??item.output??"").trim();
    return {role:"activity",label:`command · exit code ${Number.isInteger(item.exitCode)?item.exitCode:"unknown"}`,text:[command,output?tail(output,HISTORY_COMMAND_OUTPUT_LIMIT):""].filter(Boolean).join("\n")};
  }
  if(item.type==="fileChange"){
    // Claude Code's TodoWrite as the relay stored it before Claude's lists showed as the plan only: a to-do list, no file change.
    if(Array.isArray(item.rawInput?.todos)&&!item.changes?.length&&!item.rawInput.file_path&&!item.rawInput.notebook_path)return null;
    const files=(Array.isArray(item.changes)?item.changes:[]).map(change=>{const kind=change?.kind?.type||change?.kind||"edit";return `${kind} ${String(change?.path||"").trim()}`.trim()}).filter(Boolean);
    return {role:"activity",label:"file change",text:files.join("\n")||"(files not named)"};
  }
  if(item.type==="plan"){const text=String(item.text||"").trim();return text?{role:"activity",label:"plan",text}:null}
  if(item.type==="error"){const text=String(item.message||"").trim();return text?{role:"activity",label:"error",text}:null}
  return null;
}

// The thread's history in order, each entry with its turn's number. excludeTurnId: the turn whose own message the prompt sends.
export function threadHistoryEntries(turns=[],{excludeTurnId=null}={}){
  const entries=[];let number=0;
  for(const turn of Array.isArray(turns)?turns:[]){
    if(!turn||typeof turn!=="object")continue;number++;
    if(excludeTurnId!=null&&String(turn.id)===String(excludeTurnId))continue;
    for(const item of Array.isArray(turn.items)?turn.items:[]){const entry=threadHistoryEntry(item);if(entry)entries.push({...entry,turn:number})}
    const failure=String(turn.error?.message||"").trim();
    if(turn.status==="failed"&&failure)entries.push({role:"activity",label:"error",text:failure,turn:number});
    else if(turn.status==="cancelled"||turn.status==="interrupted")entries.push({role:"activity",label:"stopped",text:"The turn was stopped before it finished.",turn:number});
  }
  return entries;
}

export function renderHistoryEntry(entry){return `[turn ${entry.turn} · ${entry.label}]\n${entry.text}`}

// fork: the thread is a fork whose fresh session is handed the conversation it was forked from (a Muse Code fork).
export function threadHistoryHeader({harness="The harness",included=0,total=0,fork=false}={}){
  const omitted=Math.max(0,total-included),why=fork?`this thread is a fork that continues in a new ${harness} session`:`${harness} no longer had it`;
  return [
    `The earlier conversation of this thread, handed over because ${why}. Read it as context for the request that follows, not as a new request.`,
    `Included: ${included} of ${total} earlier entries, oldest first${omitted?`; ${omitted} left out to stay within the budget`:""}. Attachments and the harness's own tool and reasoning state are not handed over.`,
  ].join("\n");
}

// The budget. A handoff is pieces, its header and then one per entry it keeps, with a blank line between each two. A piece takes
// from the budget its size in the prompt, where the working-context fence writes the "<" of each of Trebell's own tags as "&lt;"
// (fencedContextValue), and the blank line that parts it from the next piece.
const PIECE_SEPARATOR="\n\n";
const TAG_START=/<(?=\/?trebell_context)/gi;
const utf8=new TextEncoder();
function pieceCost(text){return utf8.encode(text.replace(TAG_START,"&lt;")).length+PIECE_SEPARATOR.length}

// The places in the thread that claim room, each once and in this order: the person's newest message (what is being asked), the
// newest reply (where the conversation stands), the person's first message (what the thread set out to do), then every entry
// from the newest back to the oldest.
function claimOrder(entries){
  const roles=entries.map(entry=>entry.role),newestFirst=entries.map((_,at)=>at).reverse();
  const anchors=[roles.lastIndexOf("user"),roles.lastIndexOf("assistant"),roles.indexOf("user")];
  return new Set([...anchors,...newestFirst].filter(at=>at>=0));
}

// The budget as a count of bytes. One that reads as no number sets no limit, as it always has here; no caller passes one.
function roomFor(budget){const bytes=Number(budget);return Number.isNaN(bytes)?Infinity:bytes}

// The entries that fill the budget, whole. In claim order, an entry is kept when it fits the room left and skipped when it does
// not, so a smaller, older one can still come in after a larger one stayed out. The kept entries come back as they were given, in
// the thread's order, with how many were kept and how many were left out.
export function selectThreadHistory(entries=[],{budget=THREAD_HISTORY_BUDGET}={}){
  const thread=Array.isArray(entries)?entries:[],kept=new Array(thread.length).fill(false);
  let room=roomFor(budget);
  for(const at of claimOrder(thread)){
    const cost=pieceCost(renderHistoryEntry(thread[at]));
    if(cost<=room){kept[at]=true;room-=cost}
  }
  const picked=thread.filter((_,at)=>kept[at]);
  return {entries:picked,included:picked.length,omitted:thread.length-picked.length};
}

// The header's room, kept back before any entry is weighed. The header carries the real counts, known only after the choice, so
// the room is for the longest it could be: every entry counted in and twice as many in all, which brings in the left-out clause
// and leaves no count with fewer digits than the real one.
function headerRoom(count,{harness,fork}){return pieceCost(threadHistoryHeader({harness,fork,included:count,total:count*2}))}

// The handoff for a thread's turns, or null when there is nothing earlier to hand over: the header, then the kept entries. Once
// fenced, it stays within any budget that has the header's room.
export function threadHistoryHandoff(turns=[],{harness="The harness",excludeTurnId=null,budget=THREAD_HISTORY_BUDGET,fork=false}={}){
  const history=threadHistoryEntries(turns,{excludeTurnId});
  if(!history.length)return null;
  const forEntries=Math.max(0,budget-headerRoom(history.length,{harness,fork}));
  const {entries:kept,included,omitted}=selectThreadHistory(history,{budget:forEntries});
  const header=threadHistoryHeader({harness,fork,included,total:history.length});
  return {text:[header,...kept.map(renderHistoryEntry)].join(PIECE_SEPARATOR),included,omitted};
}
