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

// The facts a command adds under its command line: the exit code (a non-zero one reads as a failure), the folder it ran in and
// how long it took. A harness that reports none of them adds nothing.
export function commandFacts(raw){
  const facts=[],exit=raw?.exitCode;
  const code=typeof exit==="number"?exit:typeof exit==="string"&&/^-?\d+$/.test(exit.trim())?Number(exit):null;
  if(Number.isInteger(code))facts.push({key:"exit",label:"exit "+code,tone:code===0?"ok":"err"});
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

const CHANGE_KINDS={add:"added",added:"added",create:"added",created:"added",delete:"deleted",deleted:"deleted",remove:"deleted",update:"edited",updated:"edited",edit:"edited",modify:"edited",modified:"edited",move:"moved",moved:"moved",rename:"moved",renamed:"moved"};

// Each file a change step touched: its path, what happened to it (added, edited, deleted or moved, with the new path), and its
// diff, capped so a huge rewrite stays a quick read.
export function fileChangeRows(changes){
  return (Array.isArray(changes)?changes:[]).filter(change=>change&&typeof change==="object").map(change=>{
    const kindName=String(typeof change.kind==="string"?change.kind:change.kind?.type||change.type||"").toLowerCase();
    const movePath=text(change.kind?.move_path||change.kind?.movePath||change.move_path||change.movePath).trim();
    const kind=movePath?"moved":CHANGE_KINDS[kindName]||"";
    const all=text(change.diff).trim()?diffLines(change.diff,kind):textChangeLines(change.oldText,change.newText);
    const shown=all.length>DIFF_LINE_LIMIT?[...all.slice(0,DIFF_LINE_LIMIT),{text:"… "+(all.length-DIFF_LINE_LIMIT)+" more lines",tone:"meta"}]:all;
    return {path:text(change.path).trim(),kind,movePath,lines:shown};
  }).filter(row=>row.path||row.lines.length);
}

// The Runtime panel's "N/M steps complete": a step is finished once it no longer runs, whether it succeeded, failed or was
// declined, and a notice row (a warning) never runs at all.
const UNFINISHED_STEP_STATUSES=new Set(["running","pending","inProgress"]);
export function finishedActivitySteps(events){
  return (events||[]).filter(event=>!UNFINISHED_STEP_STATUSES.has(event?.status)).length;
}
