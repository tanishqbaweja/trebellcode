import test from "node:test";
import assert from "node:assert/strict";
import { commandFacts, commandLine, diffLines, durationLabel, fileChangeRows, finishedActivitySteps, textChangeLines } from "../ui/src/activity-details.js";

test("a command prints the line it ran: the relay's rawInput line over a descriptive title",()=>{
  assert.equal(commandLine({command:"test -f missing.txt"}),"test -f missing.txt");
  assert.equal(commandLine({command:["git","status","--short"]}),"git status --short");
  assert.equal(commandLine({command:"Run the unit tests",rawInput:{command:"npm test -- --grep auth",description:"Run the unit tests"}}),"npm test -- --grep auth");
  assert.equal(commandLine({command:"List files",rawInput:{cmd:["ls","-la"]}}),"ls -la");
  assert.equal(commandLine({command:"Build",rawInput:"npm run build"}),"npm run build");
  assert.equal(commandLine({command:"Build",rawInput:{timeout:30}}),"Build");
  assert.equal(commandLine(null),"");
});

test("a command's facts: exit code, folder and duration, each only when the harness reported it",()=>{
  assert.deepEqual(commandFacts({exitCode:1,cwd:"/work/notes",durationMs:42}),[
    {key:"exit",label:"exit 1",tone:"err"},
    {key:"cwd",label:"/work/notes",title:"Ran in /work/notes"},
    {key:"duration",label:"42 ms",title:"Took 42 ms"},
  ]);
  assert.deepEqual(commandFacts({exitCode:0}),[{key:"exit",label:"exit 0",tone:"ok"}]);
  assert.deepEqual(commandFacts({exitCode:"3"}).map(fact=>fact.label),["exit 3"]);
  // A relay command has no folder or duration until the harness reports one: nothing is made up.
  assert.deepEqual(commandFacts({exitCode:null,cwd:"",durationMs:null}),[]);
  assert.deepEqual(commandFacts({exitCode:"failed",durationMs:"soon"}),[]);
});

test("durations read in the unit that fits",()=>{
  assert.equal(durationLabel(0),"0 ms");
  assert.equal(durationLabel(999.6),"1000 ms");
  assert.equal(durationLabel(1250),"1.3 s");
  assert.equal(durationLabel(12_400),"12 s");
  assert.equal(durationLabel(59_600),"1 min");
  assert.equal(durationLabel(125_000),"2 min 5 s");
  assert.equal(durationLabel(null),"");
  assert.equal(durationLabel(-5),"");
});

test("a file change lists every file with what happened to it and its diff",()=>{
  const rows=fileChangeRows([
    {path:"notes/todo.md",kind:{type:"add"},diff:"remember the milk\n- and the bread\n"},
    {path:"src/app.js",kind:{type:"update",move_path:"src/main.js"},diff:"@@ -1,2 +1,2 @@\n-const a=1;\n+const a=2;\n keep();"},
    {path:"old.txt",kind:"delete",diff:"gone\n"},
    {path:"src/auth.js",kind:"update",oldText:"a\nb\nc\nd\ne\nf\n",newText:"a\nb\nc\nD\ne\nf\n"},
    {path:"README.md",kind:"edit"},
    null,
    {path:"",kind:"edit"},
  ]);
  assert.deepEqual(rows.map(row=>[row.path,row.kind,row.movePath]),[
    ["notes/todo.md","added",""],["src/app.js","moved","src/main.js"],["old.txt","deleted",""],["src/auth.js","edited",""],["README.md","edited",""],
  ]);
  // Codex sends an added file's text as its diff: every line reads as added, even one that starts with "-".
  assert.deepEqual(rows[0].lines,[{text:"+remember the milk",tone:"add"},{text:"+- and the bread",tone:"add"}]);
  assert.deepEqual(rows[1].lines.map(line=>line.tone),["hunk","del","add","ctx"]);
  assert.deepEqual(rows[2].lines,[{text:"-gone",tone:"del"}]);
  assert.deepEqual(rows[3].lines,[{text:"@@ line 2 @@",tone:"hunk"},{text:" b",tone:"ctx"},{text:" c",tone:"ctx"},{text:"-d",tone:"del"},{text:"+D",tone:"add"},{text:" e",tone:"ctx"},{text:" f",tone:"ctx"}]);
  assert.deepEqual(rows[4].lines,[]);
});

test("an added file whose diff already has diff lines is not signed twice",()=>{
  assert.deepEqual(diffLines("+remember the milk","added"),[{text:"+remember the milk",tone:"add"}]);
  assert.deepEqual(diffLines("--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+x","added").map(line=>line.tone),["meta","meta","hunk","add"]);
  assert.deepEqual(diffLines("",""),[]);
});

test("text before and after an edit: a new file is all added lines, an unchanged one has none",()=>{
  assert.deepEqual(textChangeLines(undefined,"one\ntwo\n"),[{text:"+one",tone:"add"},{text:"+two",tone:"add"}]);
  assert.deepEqual(textChangeLines("same\n","same\n"),[]);
  assert.deepEqual(textChangeLines("gone",""),[{text:"-gone",tone:"del"}]);
});

test("a long diff is capped with a count of the lines left out",()=>{
  const diff=Array.from({length:450},(_,index)=>"+line "+index).join("\n");
  const [row]=fileChangeRows([{path:"big.txt",kind:"add",diff}]);
  assert.equal(row.lines.length,401);
  assert.deepEqual(row.lines.at(-1),{text:"… 50 more lines",tone:"meta"});
});

test("finished steps count every step that no longer runs, notice rows included",()=>{
  const events=[{status:"error"},{status:"done"},{status:"failed"},{status:"warning"},{status:"done"},{status:"declined"}];
  assert.equal(finishedActivitySteps(events),6);
  assert.equal(finishedActivitySteps([...events,{status:"running"},{status:"pending"}]),6);
  assert.equal(finishedActivitySteps(null),0);
});
