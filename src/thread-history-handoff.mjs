// The earlier conversation of a thread, handed to the fresh session that takes over when a harness no longer has the thread's
// conversation, or that a fork starts (T3 Code's full_thread_summary handoff, in Trebell's words). Pure: the relay fences the text
// into the prompt's working context, where fencedContextValue escapes it.

// T3's default handoff cap of 16k tokens, counted as UTF-8 bytes: one byte per token errs on the safe side.
export const THREAD_HISTORY_BUDGET=16_000;
// A command's output keeps its end, where a failure shows.
export const HISTORY_COMMAND_OUTPUT_LIMIT=2_000;

const encoder=new TextEncoder();
// fencedContextValue escapes each of Trebell's own tags in the value, three bytes more each, so a cost holds after escaping.
function fencedBytes(text){return encoder.encode(text).length+3*(text.match(/<\/?trebell_context/gi)||[]).length}

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

// Picks what fits the budget whole, in T3's order: the latest user message, the latest reply, the first user message, then the
// rest from newest to oldest. An entry too large for what is left is omitted whole and counted. The picked entries keep their order.
export function selectThreadHistory(entries=[],{budget=THREAD_HISTORY_BUDGET}={}){
  const list=Array.isArray(entries)?entries:[],chosen=new Set();let remaining=budget;
  const add=index=>{
    if(index<0||index>=list.length||chosen.has(index))return;
    const cost=fencedBytes(renderHistoryEntry(list[index]))+2;if(cost>remaining)return;
    chosen.add(index);remaining-=cost;
  };
  add(list.findLastIndex(entry=>entry.role==="user"));
  add(list.findLastIndex(entry=>entry.role==="assistant"));
  add(list.findIndex(entry=>entry.role==="user"));
  for(let index=list.length-1;index>=0;index--)add(index);
  return {entries:list.filter((_,index)=>chosen.has(index)),included:chosen.size,omitted:list.length-chosen.size};
}

// The handoff for a thread's turns, or null when there is nothing earlier to hand over. The budget covers the header too,
// reserved at its widest so the counts can never push the text past it.
export function threadHistoryHandoff(turns=[],{harness="The harness",excludeTurnId=null,budget=THREAD_HISTORY_BUDGET,fork=false}={}){
  const entries=threadHistoryEntries(turns,{excludeTurnId});if(!entries.length)return null;
  const reserve=fencedBytes(threadHistoryHeader({harness,included:entries.length,total:entries.length*2,fork}))+2;
  const picked=selectThreadHistory(entries,{budget:Math.max(0,budget-reserve)});
  const text=[threadHistoryHeader({harness,included:picked.included,total:entries.length,fork}),...picked.entries.map(renderHistoryEntry)].join("\n\n");
  return {text,included:picked.included,omitted:picked.omitted};
}
