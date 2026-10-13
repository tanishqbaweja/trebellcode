// What an expanded activity row prints besides its title, read from the item the harness sent (Codex, a relay harness or
// Native): the command line a step ran with its exit code, folder and duration, and each file a change touched with its kind
// and diff.

const DIFF_LINE_LIMIT=400;
const CONTEXT_LINES=2;
const text=value=>typeof value==="string"?value:"";
const joined=value=>Array.isArray(value)?value.map(String).join(" "):text(value);
const lines=value=>value.replace(/\r\n?/g,"\n").replace(/\n$/,"").split("\n");

// The command line the step ran. A relay harness titles a command with what it does ("Run the unit tests") and keeps the line it
// ran in rawInput, which is printed instead when it has one.
export function commandLine(raw){
  const input=raw?.rawInput;
  const ran=(typeof input==="string"?input:joined(input?.command)||joined(input?.cmd)).trim();
  return ran||joined(raw?.command).trim();
}

// 42 ms, 1.3 s, 12 s, 2 min 5 s.
export function durationLabel(ms){
  if(ms==null||ms==="")return "";
  const value=Number(ms);if(!Number.isFinite(value)||value<0)return "";
  if(value<1000)return Math.round(value)+" ms";
  if(value<10_000)return (Math.round(value/100)/10).toFixed(1)+" s";
  const seconds=Math.round(value/1000);if(seconds<60)return seconds+" s";
  return Math.floor(seconds/60)+" min"+(seconds%60?" "+seconds%60+" s":"");
}

// The exit code a command reported (a number, or a numeric string from a relay harness), or null.
export function exitCodeOf(raw){
  const exit=raw?.exitCode;
  const code=typeof exit==="number"?exit:typeof exit==="string"&&/^-?\d+$/.test(exit.trim())?Number(exit):null;
  return Number.isInteger(code)?code:null;
}

// The timeline status of a harness item: running while Codex or the relay marks it "inProgress", done once "completed". A
// command that exited non-zero failed, whatever its harness called it: Codex already reports it failed, while a relay harness
// reports every finished tool call completed, which would put "done" over a red exit code.
export function activityItemStatus(item){
  const status=item?.status;
  if(status==="completed")return item.type==="commandExecution"&&(exitCodeOf(item)??0)!==0?"failed":"done";
  if(status==="inProgress")return "running";
  return status||"running";
}

// The facts a command adds under its command line: the exit code (a non-zero one reads as a failure), the folder it ran in and
// how long it took. A harness that reports none of them adds nothing.
export function commandFacts(raw){
  const facts=[],code=exitCodeOf(raw);
  if(code!=null)facts.push({key:"exit",label:"exit "+code,tone:code===0?"ok":"err"});
  const cwd=text(raw?.cwd).trim();if(cwd)facts.push({key:"cwd",label:cwd,title:"Ran in "+cwd});
  const duration=durationLabel(raw?.durationMs);if(duration)facts.push({key:"duration",label:duration,title:"Took "+duration});
  return facts;
}

function diffTone(line){
  if(/^(diff --git |index |new file mode |deleted file mode |similarity index |rename (from|to) |--- |\+\+\+ )/.test(line))return "meta";
  if(line.startsWith("@@"))return "hunk";
  if(line.startsWith("+"))return "add";
  if(line.startsWith("-"))return "del";
  return "ctx";
}
const DIFF_HEADER=/^(diff --git |--- |\+\+\+ |@@ )/m;

// A unified diff as tinted lines. Codex sends an added or deleted file's whole text as its "diff": those lines read as added or
// removed ones (unless they already are diff lines).
export function diffLines(diff,kind=""){
  const value=text(diff);if(!value.trim())return [];
  const all=lines(value),sign=kind==="added"?"+":kind==="deleted"?"-":"";
  if(sign&&!DIFF_HEADER.test(value)&&!all.every(line=>!line||line.startsWith(sign)))return all.map(line=>({text:sign+line,tone:sign==="+"?"add":"del"}));
  return all.map(line=>({text:line,tone:diffTone(line)}));
}

// A harness that sends the text before and after an edit (ACP): the lines that differ, with up to two unchanged lines around them.
export function textChangeLines(oldText,newText){
  const before=typeof oldText==="string"&&oldText.length?lines(oldText):[],after=typeof newText==="string"&&newText.length?lines(newText):[];
  let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;
  let end=0;while(end<before.length-start&&end<after.length-start&&before[before.length-1-end]===after[after.length-1-end])end++;
  if(start===before.length&&start===after.length)return [];
  const from=Math.max(0,start-CONTEXT_LINES),rows=[];
  if(before.length&&from>0)rows.push({text:"@@ line "+(from+1)+" @@",tone:"hunk"});
  for(const line of before.slice(from,start))rows.push({text:" "+line,tone:"ctx"});
  for(const line of before.slice(start,before.length-end))rows.push({text:"-"+line,tone:"del"});
  for(const line of after.slice(start,after.length-end))rows.push({text:"+"+line,tone:"add"});
  for(const line of after.slice(after.length-end,after.length-end+CONTEXT_LINES))rows.push({text:" "+line,tone:"ctx"});
  return rows;
}

// At most DIFF_LINE_LIMIT lines of a diff, then how many more there are: a huge rewrite (a lockfile) stays a quick read and a
// quick render, however often it updates.
function capped(rows){
  return rows.length>DIFF_LINE_LIMIT?[...rows.slice(0,DIFF_LINE_LIMIT),{text:"… "+(rows.length-DIFF_LINE_LIMIT).toLocaleString("en-US")+" more lines",tone:"meta"}]:rows;
}

// A turn's workspace diff (turn/diff/updated), capped as a change's diff is.
export function turnDiffLines(diff){
  return capped(diffLines(diff));
}

const CHANGE_KINDS={add:"added",added:"added",create:"added",created:"added",delete:"deleted",deleted:"deleted",remove:"deleted",update:"edited",updated:"edited",edit:"edited",modify:"edited",modified:"edited",move:"moved",moved:"moved",rename:"moved",renamed:"moved"};

// Each file a change step touched: its path, what happened to it (added, edited, deleted or moved, with the new path), and its
// diff, capped.
export function fileChangeRows(changes){
  return (Array.isArray(changes)?changes:[]).filter(change=>change&&typeof change==="object").map(change=>{
    const kindName=String(typeof change.kind==="string"?change.kind:change.kind?.type||change.type||"").toLowerCase();
    const movePath=text(change.kind?.move_path||change.kind?.movePath||change.move_path||change.movePath).trim();
    const kind=movePath?"moved":CHANGE_KINDS[kindName]||"";
    const all=text(change.diff).trim()?diffLines(change.diff,kind):textChangeLines(change.oldText,change.newText);
    return {path:text(change.path).trim(),kind,movePath,lines:capped(all)};
  }).filter(row=>row.path||row.lines.length);
}

// A Trebell Native exact edit (trebell_workspace/replace_text, one pair or an edits list) that went through, as a file change: the
// file it changed and the diff Trebell returned for it. An edit that failed, is still running or carries no diff has none (null),
// and its row keeps showing the call itself.
export function nativeEditChanges(item){
  if(item?.type!=="dynamicToolCall"||item.namespace!=="trebell_workspace"||item.tool!=="replace_text"||item.status==="failed")return null;
  const output=item.rawOutput&&typeof item.rawOutput==="object"&&!Array.isArray(item.rawOutput)?item.rawOutput:null,diff=text(output?.diff);
  if(!diff.trim()||output.success===false)return null;
  let input=item.arguments;if(typeof input==="string"){try{input=JSON.parse(input)}catch{input=null}}
  const path=text(input?.path).trim()||text(output.path).trim();
  return [{path,kind:"edit",diff}];
}

// The Runtime panel's "N/M steps complete": a step is complete once it has an outcome. It succeeded, failed or was declined, or
// it is a notice (a warning or an error row, or a verification whose checks could not run). A step that runs or waits to run is
// not, and neither is a planned verification (incomplete) whose checks have not run yet, nor a status this list does not know.
const FINISHED_STEP_STATUSES=new Set(["done","completed","failed","declined","error","warning","cancelled","canceled","interrupted"]);
export function finishedActivitySteps(events){
  return (events||[]).filter(event=>FINISHED_STEP_STATUSES.has(event?.status)).length;
}
