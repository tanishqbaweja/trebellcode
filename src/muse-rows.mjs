// What Trebell shows of Muse Code's items: each item's row in the relay's ACP shape (the fields acpToolFrame reads), how far the item
// got, a workflow's agents as rows under it, Muse's to-do list as the turn's plan, and which items show no row of their own.

const asText=value=>typeof value==="string"?value:value==null?"":String(value);
// The non-empty parts, a line each.
const lines=(...parts)=>parts.filter(Boolean).join("\n");
// A title with what it adds after a colon, when it adds anything.
const titled=(name,extra)=>extra?`${name}: ${extra}`:name;
// Whether a tool's name has any of these words in it, in any case.
const mentions=(name,words)=>{const lower=name.toLowerCase();return words.some(word=>lower.includes(word))};

// A label as one line: its text's first line, trimmed, cut to 72 characters (71 and an ellipsis). The session names an agent that
// asks for approval with the same label its row shows.
export function museLabel(value){
  const first=asText(value).trim().split(/\r?\n/)[0].trim();
  return first.length>72?`${first.slice(0,71)}…`:first;
}

// How far an item got: running, done, or failed for every other end Muse gives an item (failed, cancelled, handed off, timed out,
// rejected). A compaction that completed without compacting (an outcome of noop or unavailable) did not do its job.
export function museItemProgress(item={}){
  if(item.status==="inProgress")return "in_progress";
  const didItsJob=item.status==="completed"&&(item.kind!=="compaction"||!item.outcome||item.outcome==="compacted");
  return didItsJob?"completed":"failed";
}
// How far work got: a subagent whose result is in (controlStatus resultReady) is done, though Muse's item for it still runs.
export function museWorkProgress(item={}){
  if(item.kind==="subagent"&&item.status==="inProgress"&&item.controlStatus==="resultReady")return "completed";
  return museItemProgress(item);
}
// What a failed row says went wrong: Muse's reason, else the end Muse gave it.
function failureWords(item,progress){
  if(progress!=="failed")return "";
  return asText(item.failureReason)||`Muse Code reported ${item.status||"a failure"}.`;
}
function workflowName(item){
  const entry=museLabel(item.entryId);
  return entry?`Workflow ${entry}`:"Workflow";
}

// A subagent's row, titled by its role (else its objective, which is its prompt) with its result, and a workflow's, titled by its
// entry with its final summary (its fallback text while it runs).
function workRow(item){
  const progress=museWorkProgress(item),failure=failureWords(item,progress);
  let name,input,result;
  if(item.kind==="subagent"){
    name=`Subagent · ${museLabel(item.role)||museLabel(item.objective)||"Muse Code agent"}`;
    input={};
    if(item.objective)input.objective=asText(item.objective);
    if(item.role)input.role=asText(item.role);
    result=asText(item.result?.text??item.result?.summary);
  }else{
    name=workflowName(item);
    input=item.entryId?{workflow:asText(item.entryId)}:{};
    result=asText(item.finalSummary??(progress==="in_progress"?item.fallbackText:""));
  }
  return {toolCallId:asText(item.itemId),status:progress,kind:"other",title:titled(name,failure),rawInput:input,rawOutput:lines(failure,result)};
}

// A JSON object in a string (Muse's tool arguments and its shell's run record), or null: arguments are model-written and may not
// parse while they still stream.
function parsedObject(value){
  if(typeof value!=="string"||value.trim()==="")return null;
  let parsed;
  try{parsed=JSON.parse(value)}catch{return null}
  return parsed!==null&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed:null;
}

// What every kind of call's row reads from the item. running: a command Muse sent to the background still runs, though Muse may
// have settled its call as it went there, so its row runs on until Muse tells its end.
function readCall(item,running){
  const args=parsedObject(item.args),progress=museItemProgress(item);
  const status=running&&progress==="completed"?"in_progress":progress,failure=failureWords(item,status);
  const sources=[item.visibleOutput,item.result?.summary,item.text,Array.isArray(item.summary)?item.summary.join("\n"):undefined,item.finalSummary,item.fallbackText,item.objective];
  const body=sources.find(value=>value!=null)??"";
  return {
    item,args,status,failure,body,
    id:asText(item.itemId),
    tool:asText(item.tool||item.kind)||"tool",
    output:lines(failure,asText(body)),
    // The first of these arguments that is a string.
    named(...names){
      if(!args)return undefined;
      const name=names.find(key=>typeof args[key]==="string");
      return name===undefined?undefined:args[name];
    },
  };
}

// How Muse begins its words for a command it never started because its host cannot use its sandbox (Muse Code 1.4.13: the reason
// "environment failure: sandbox enforcement unavailable: ..." for its own shell, "environment failure: managed shell sandbox is
// unavailable" for the person's, and its output the same after "tool failed: "), and what the row says instead. Only words that
// begin so are Muse's: a command that ran keeps its own output, though its command or its output names them.
const SANDBOX_REFUSAL=/^(?:tool failed: )?environment failure: (?:sandbox enforcement unavailable|managed shell sandbox is unavailable)/i;
export const MUSE_SANDBOX_REFUSED_COMMAND="Muse Code did not run this command because its sandbox is not available. To let it run commands, switch this task to Full access, which runs them without the sandbox and without asking.";
// A command: Muse's shell, or the person's own (userShell), with its output and exit code. Muse's shell answers with a record of the
// run ({command, exit_code, output, ...}), kept whole as the row's output. One its sandbox kept from starting (failed with no record
// or exit code of a run, its reason or output beginning with Muse's refusal) says so in Trebell's words.
function commandParts(call){
  const {item}=call;
  const command=asText(item.commandText??call.named("command","cmd")??item.args??"");
  const parts={title:command||call.tool,input:call.args||{command},output:call.output};
  const record=parsedObject(item.visibleOutput),ran=Boolean(record)||Number.isInteger(item.exitCode);
  if(call.status==="failed"&&!ran&&[item.failureReason,call.body].some(value=>SANDBOX_REFUSAL.test(asText(value).trim())))return {...parts,output:MUSE_SANDBOX_REFUSED_COMMAND};
  if(record&&typeof record.output==="string")parts.output={...record,output:lines(call.failure,record.output)};
  if(Number.isInteger(item.exitCode))parts.exitCode=item.exitCode;
  return parts;
}
// A write, edit or patch of a named file: its exact old and new text as an ACP diff, or Muse's patch when it gives no new text. A
// call with no file is no edit.
function editParts(call){
  const path=call.named("file_path","path","filePath")?.trim();
  if(!path)return null;
  const parts={title:titled(call.tool,call.failure),input:call.args,output:call.output,locations:[{path}],content:[]};
  const newText=call.named("new_string","new_str","newStr","newText","content");
  if(newText!==undefined){
    const oldText=call.named("old_string","old_str","oldStr","oldText");
    parts.content=[oldText===undefined?{type:"diff",path,newText}:{type:"diff",path,oldText,newText}];
    return parts;
  }
  const diff=call.named("diff","patch","diffStr");
  if(diff!==undefined)parts.changes=[{path,kind:"update",diff}];
  return parts;
}
// A web search's hits as Muse's search tool answers them ({results: [{url, title, snippet}]}), or null when it named none.
function searchHits(body){
  const page=parsedObject(body);
  if(!page||!Array.isArray(page.results))return null;
  const hits=[];
  for(const hit of page.results){
    if(!hit||typeof hit!=="object")continue;
    const found={};
    if(typeof hit.url==="string"&&hit.url.trim())found.url=hit.url.trim();
    if(typeof hit.title==="string"&&hit.title.trim())found.title=hit.title.trim();
    if(typeof hit.snippet==="string"&&hit.snippet)found.snippet=hit.snippet;
    hits.push(found);
  }
  return hits;
}
// The results a web call shows: a search's hits, or the page or text it fetched as one result.
function webResults(call){
  if(call.item.tool==="web_search"&&!call.failure){
    const hits=searchHits(asText(call.body));
    if(hits)return hits;
  }
  if(!call.output)return [];
  const address=call.named("url")?.trim();
  return [address?{url:address,snippet:call.output}:{snippet:call.output}];
}
// Each result as its title and address, then its snippet; results apart by a blank line.
function resultsText(results){
  return results.map(hit=>{
    const head=hit.title?(hit.url?`${hit.title} (${hit.url})`:hit.title):hit.url||"";
    return head&&hit.snippet?`${head}\n${hit.snippet}`:head||hit.snippet||"";
  }).filter(block=>block!=="").join("\n\n");
}
function webParts(call){
  const query=call.named("query","url","pattern")?.trim(),results=webResults(call);
  return {
    title:titled(call.tool,query),input:call.args||{},output:query?{query,results}:{results},
    content:results.length?[{type:"content",content:{type:"text",text:resultsText(results)}}]:[],
  };
}

// The kinds of call rows, by the tool's name, in the order they are tried; a call none of them takes is a plain tool row.
const CALL_KINDS=[
  {kind:"execute",takes:call=>call.item.kind==="userShell"||mentions(asText(call.item.tool),["shell","bash","exec_command"]),parts:commandParts},
  {kind:"edit",takes:call=>call.item.kind==="toolCall"&&mentions(call.tool,["write","edit","patch"]),parts:editParts},
  {kind:"fetch",takes:call=>call.item.kind==="toolCall"&&mentions(call.tool,["web","browse","fetch"]),parts:webParts},
];
function plainParts(call){
  const {item}=call;
  return {title:titled(call.tool,call.failure),input:call.args||(item.args?{args:asText(item.args)}:{}),output:call.output};
}

// One Muse item as its row (an ACP tool call): work (a subagent or a workflow), a command, a file edit, a web call, or any other
// tool with its arguments and output.
export function museItemRow(item={},{running=false}={}){
  if(item.kind==="subagent"||item.kind==="workflow")return workRow(item);
  const call=readCall(item,running);
  let kind="other",parts=null;
  for(const candidate of CALL_KINDS){
    if(!candidate.takes(call))continue;
    parts=candidate.parts(call);
    if(parts){kind=candidate.kind;break}
  }
  const {title,input,output,...more}=parts||plainParts(call);
  return {toolCallId:call.id,status:call.status,kind,title,rawInput:input,rawOutput:output,...more};
}

// The rows of a workflow's agents, after the workflow's own, one per child id in the order Muse first lists it, as Muse sends every
// child again (its latest attempt) on each change. A child with an end is done when it completed with no failure kind, else failed;
// one with none is pending while scheduled and runs while the workflow does, and then ends as the workflow did. labels: each agent's
// last label by row id, which later revisions leave out.
export function museWorkflowAgentRows(item={},labels=new Map()){
  const children=new Map();
  for(const child of Array.isArray(item.children)?item.children:[]){
    if(child&&typeof child.childId==="string"&&child.childId!=="")children.set(child.childId,child);
  }
  const heading=workflowName(item),workflow=museItemProgress(item),rows=[];
  for(const child of children.values()){
    const id=`${asText(item.itemId)}:agent:${child.childId}`,label=museLabel(child.label);
    if(label)labels.set(id,label);
    const terminal=asText(child.terminal),reason=asText(child.failureReason)||asText(child.failureKind);
    let status;
    if(terminal)status=terminal==="completed"&&!asText(child.failureKind)?"completed":"failed";
    else if(workflow!=="in_progress")status=workflow;
    else status=child.status==="scheduled"?"pending":"in_progress";
    let failure="";
    if(status==="failed")failure=reason||(terminal?`Muse Code reported ${terminal}.`:"The workflow ended before this agent finished.");
    const agent=labels.get(id)||null;
    rows.push({
      toolCallId:id,status,kind:"other",title:titled(`${heading} · ${agent||`agent ${rows.length+1}`}`,failure),
      rawInput:{workflow:asText(item.entryId),agent,attempt:Number.isInteger(child.attempt)?child.attempt:null},rawOutput:reason,
    });
  }
  return rows;
}

// Muse's to-do list (session/todoListChanged, sent whole each time) as the turn's plan: its steps in order, without the ones Muse
// cancelled or left blank. An empty list clears the plan.
const PLAN_STATUS=new Map([["completed","completed"],["inProgress","in_progress"]]);
export function museTodoPlan(items=[]){
  const plan=[];
  if(!Array.isArray(items))return plan;
  for(const step of items){
    if(!step||typeof step.text!=="string"||step.status==="cancelled")continue;
    const content=step.text.trim();
    if(content)plan.push({content,status:PLAN_STATUS.get(step.status)??"pending"});
  }
  return plan;
}

// The calls whose result shows elsewhere: the to-do list as the plan, a question in the question dialog, a workflow on its own row.
const SHOWN_ELSEWHERE=["write_todos","request_user_input","workflow"];
// Items with no row: the person's own message, the reminder children Muse runs each model step, a compaction (its end settles
// /compact), and a call whose result shows elsewhere, unless it failed.
export function museShowsNoRow(item){
  switch(item.kind){
    case "userMessage":case "reminderChild":case "compaction":return true;
    case "toolCall":return SHOWN_ELSEWHERE.includes(item.tool)&&museItemProgress(item)!=="failed";
    default:return false;
  }
}
