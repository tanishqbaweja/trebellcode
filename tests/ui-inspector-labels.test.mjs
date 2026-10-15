import test from "node:test";
import assert from "node:assert/strict";
import { actionError, actionErrorUnlessNamed, asSentence, distinctPathParts, distinctTextParts, gitStatusBadge, gitStatusEntry, gitStatusPath, gitUpstreamSync, pullRequestChecks, splitPath, workspaceChanged } from "../ui/src/inspector-labels.js";

test("the branch header of git status reads as how far the branch is from its upstream",()=>{
  assert.deepEqual(gitUpstreamSync("## main...origin/main"),{ahead:0,behind:0,gone:false,label:"up to date"});
  assert.deepEqual(gitUpstreamSync("## main...origin/main [behind 1]"),{ahead:0,behind:1,gone:false,label:"1 commit behind"});
  assert.deepEqual(gitUpstreamSync("## main...origin/main [behind 3]"),{ahead:0,behind:3,gone:false,label:"3 commits behind"});
  assert.deepEqual(gitUpstreamSync("## feature/x...origin/feature/x [ahead 2]"),{ahead:2,behind:0,gone:false,label:"2 commits ahead"});
  assert.deepEqual(gitUpstreamSync("## main...origin/main [ahead 1, behind 2]"),{ahead:1,behind:2,gone:false,label:"1 ahead, 2 behind"});
  assert.deepEqual(gitUpstreamSync("## main...origin/main [gone]"),{ahead:0,behind:0,gone:true,label:"upstream branch is gone"});
  // No upstream, no branch, no commits yet: nothing to compare.
  for(const header of ["## main","## HEAD (no branch)","## No commits yet on master","",undefined])assert.equal(gitUpstreamSync(header),null);
});

test("pull request checks read as a name and passed, failed, pending or skipped, whatever the host sends",()=>{
  assert.deepEqual(pullRequestChecks([
    {__typename:"CheckRun",name:"unit-tests",status:"COMPLETED",conclusion:"FAILURE"},
    {__typename:"CheckRun",name:"e2e",status:"COMPLETED",conclusion:"TIMED_OUT"},
    {__typename:"CheckRun",name:"lint",status:"IN_PROGRESS",conclusion:""},
    {__typename:"CheckRun",name:"queued",status:"QUEUED"},
    {__typename:"CheckRun",name:"build",status:"COMPLETED",conclusion:"SUCCESS"},
    {__typename:"CheckRun",name:"docs",status:"COMPLETED",conclusion:"SKIPPED"},
    {__typename:"StatusContext",context:"ci/deploy",state:"PENDING"},
    {__typename:"StatusContext",context:"ci/legacy",state:"ERROR"},
    {id:55,status:"failed",ref:"main"},
    {id:56,status:"running"},
    {id:57,status:"success"},
    null,
  ]).map(check=>[check.name,check.state,check.detail]),[
    ["unit-tests","failed","FAILURE"],["e2e","failed","TIMED_OUT"],["lint","pending","IN_PROGRESS"],["queued","pending","QUEUED"],["build","passed","SUCCESS"],["docs","skipped","SKIPPED"],
    ["ci/deploy","pending","PENDING"],["ci/legacy","failed","ERROR"],["Pipeline #55","failed","FAILED"],["Pipeline #56","pending","RUNNING"],["Pipeline #57","passed","SUCCESS"],
  ]);
  assert.deepEqual(pullRequestChecks(undefined),[]);
  assert.deepEqual(pullRequestChecks("not a list"),[]);
});

test("a reason followed by another sentence ends as a sentence",()=>{
  assert.equal(asSentence("Deliberate context refresh failure"),"Deliberate context refresh failure.");
  for(const done of ["Index failed.","Index failed!","Why did it fail?","Still indexing…","It said \"stop.\"","(see the log.)"])assert.equal(asSentence(done),done);
  assert.equal(asSentence("  Request timed out (30s)  "),"Request timed out (30s).");
  assert.equal(asSentence("Context engine unavailable:"),"Context engine unavailable.");
  assert.equal(asSentence("Retry later; "),"Retry later.");
  assert.equal(asSentence(""),"");
  assert.equal(asSentence(null),"");
});

test("sibling names keep the part where they differ apart from the start they share",()=>{
  // Folders named <repo>-<branch>, and their branches, differ only at the end. A short end is kept whole.
  assert.deepEqual(distinctTextParts(["trebell-feature-inspector-review-panels","trebell-feature-inspector-review-polish","Trebell"]),
    [{lead:"trebell-feature-inspector-review-",tail:"panels",keep:6},{lead:"trebell-feature-inspector-review-",tail:"polish",keep:6},{lead:"",tail:"Trebell",keep:7}]);
  assert.deepEqual(distinctTextParts(["feature/inspector-review-panels","feature/inspector-review-polish","main","detached","detached"]).map(part=>part.tail),["panels","polish","main","detached","detached"]);
  assert.deepEqual(distinctTextParts(["Trebell-0c178972","Trebell-0d6387c0"]),[{lead:"Trebell-",tail:"0c178972",keep:8},{lead:"Trebell-",tail:"0d6387c0",keep:8}]);
  // A long end keeps room for the character that differs, 6 after it and the ellipsis: a hash ("0d63a1b4…"), or "review/keep-t…"
  // where the branch goes on with "/" instead of its sibling's "-".
  assert.deepEqual(distinctTextParts(["trebell/thread-0c178972","trebell/thread-0d63a1b4-review-the-inspector-panels"])[1],{lead:"trebell/thread-",tail:"0d63a1b4-review-the-inspector-panels",keep:9});
  assert.deepEqual(distinctTextParts(["feature/inspector-review/keep-the-current-branch","feature/inspector-review-panels"])[0],{lead:"feature/inspector-",tail:"review/keep-the-current-branch",keep:14});
  // A long word where they part is split at the letter that differs, so the tail starts with the difference.
  assert.deepEqual(distinctTextParts(["build-artifactsnapshot20261011a","build-artifactsnapshot20261011b"]).map(part=>part.tail),["a","b"]);
  // A name that starts another keeps its last word; one that shares nothing, or only one character, is all tail.
  assert.deepEqual(distinctTextParts(["feature-review","feature-review-polish"]),[{lead:"feature-",tail:"review",keep:6},{lead:"feature-",tail:"review-polish",keep:13}]);
  assert.deepEqual(distinctTextParts(["alpha","beta"]),[{lead:"",tail:"alpha",keep:5},{lead:"",tail:"beta",keep:4}]);
  assert.deepEqual(distinctTextParts(["-x","-y"]).map(part=>part.lead),["",""]);
  // Letters outside ASCII are word characters, and a surrogate pair is never split.
  assert.deepEqual(distinctTextParts(["projet-équipe-café","projet-équipe-thé"]).map(part=>part.tail),["café","thé"]);
  for(const part of distinctTextParts(["notes-😀a","notes-😁a"]))assert.doesNotMatch(part.tail,/^[\uDC00-\uDFFF]/);
  // Nothing is lost: lead and tail are the text again, and the tail is never asked for more room than it takes.
  for(const texts of [["a/b/c","a/b/d"],["",""],["x"],["same","same"],["repo","repo-2"]])for(const [index,part] of distinctTextParts(texts).entries()){
    assert.equal(part.lead+part.tail,texts[index]);assert.ok(part.keep<=part.tail.length);
  }
  assert.deepEqual(distinctTextParts(),[]);
});

test("a reason that already names what failed is not prefixed a second time",()=>{
  const gitText=/\bGit text\b/i;
  assert.equal(actionErrorUnlessNamed("Could not generate the commit message",new Error("fetch failed"),gitText),"Could not generate the commit message: fetch failed");
  assert.equal(actionErrorUnlessNamed("Could not generate the commit message",new Error("OpenCode returned an empty reply. Try again."),gitText),"Could not generate the commit message: OpenCode returned an empty reply. Try again.");
  // Harness writers' errors as the server words them.
  for(const reason of ["OpenCode could not write the Git text: Payment Required: Insufficient balance.","Grok Build did not return the Git text within 90 seconds. Try again, or choose a faster Grok Build model.","Cursor cannot write Git text in Trebell Code"])
    assert.equal(actionErrorUnlessNamed("Could not generate the pull request text",new Error(reason),gitText),reason);
  assert.equal(actionErrorUnlessNamed("Could not generate the commit message",new Error(""),gitText),"Could not generate the commit message.");
  const linkedThread=/\blinked thread\b/i;
  assert.equal(actionErrorUnlessNamed("Could not open the linked thread",new Error("Could not load linked thread: thread not found"),linkedThread),"Could not load linked thread: thread not found");
  assert.equal(actionErrorUnlessNamed("Could not open the linked thread",new Error("The agent harness is not connected."),linkedThread),"Could not open the linked thread: The agent harness is not connected.");
});

test("git status paths are unquoted back to their names",()=>{
  // What git status --short printed for these names (core.quotePath on, the default).
  assert.equal(gitStatusPath('"New folder/"'),"New folder/");
  assert.equal(gitStatusPath('"docs/my notes.txt"'),"docs/my notes.txt");
  assert.equal(gitStatusPath('"caf\\303\\251.txt"'),"café.txt");
  assert.equal(gitStatusPath('"\\346\\226\\207\\344\\273\\266/\\360\\237\\230\\200.md"'),"文件/😀.md");
  assert.equal(gitStatusPath('"say \\"hi\\" \\\\ tab\\there.txt"'),'say "hi" \\ tab\there.txt');
  // With core.quotePath off, a non-ASCII name arrives as UTF-8 text, quoted only when it also holds a space.
  assert.equal(gitStatusPath("café.txt"),"café.txt");
  assert.equal(gitStatusPath('"café menu.txt"'),"café menu.txt");
  // Plain paths, renames with either side quoted, and an untracked folder stay readable.
  assert.equal(gitStatusPath("src/app.js"),"src/app.js");
  assert.equal(gitStatusPath("capcut-network-capture/"),"capcut-network-capture/");
  assert.equal(gitStatusPath("src/old.js -> src/new.js"),"src/old.js -> src/new.js");
  assert.equal(gitStatusPath('"old name.txt" -> "new name.txt"'),"old name.txt -> new name.txt");
  assert.equal(gitStatusPath('old.txt -> "new name.txt"'),"old.txt -> new name.txt");
  assert.equal(gitStatusPath('"old name.txt" -> new.txt'),"old name.txt -> new.txt");
  assert.equal(gitStatusPath(""),"");
  // A quote git never closed loses only its opening mark.
  assert.equal(gitStatusPath('"unfinished name'),"unfinished name");
});

test("a git status line splits into its code and unquoted path",()=>{
  assert.deepEqual(gitStatusEntry('?? "New folder/"'),{code:"??",path:"New folder/"});
  assert.deepEqual(gitStatusEntry(" M src/app.js"),{code:" M",path:"src/app.js"});
  assert.deepEqual(gitStatusEntry('R  "old name.txt" -> "new name.txt"'),{code:"R ",path:"old name.txt -> new name.txt"});
  // The name an untracked folder shows once unquoted: the folder, not a quote mark.
  assert.deepEqual(splitPath(gitStatusEntry('?? "New folder/"').path),{dir:"",sep:"",name:"New folder/"});
  assert.deepEqual(splitPath(gitStatusEntry('?? "docs/my notes.txt"').path),{dir:"docs",sep:"/",name:"my notes.txt"});
});

test("inspector errors name the failed action before the server's reason",()=>{
  assert.equal(actionError("Could not refresh the diff",new Error("EPERM: operation not permitted")),"Could not refresh the diff: EPERM: operation not permitted");
  assert.equal(actionError("Could not open notes.txt","File is too large to preview (600 KB)"),"Could not open notes.txt: File is too large to preview (600 KB)");
  // No reason at all still reads as a sentence instead of "…: " or "…: Error".
  assert.equal(actionError("Could not open the worktree",new Error("")),"Could not open the worktree.");
  assert.equal(actionError("Could not push",null),"Could not push.");
});

test("untracked paths get one badge that does not collide with git's unmerged U",()=>{
  for(const code of ["??","?? "])assert.deepEqual(gitStatusBadge(code),{label:"N",kind:"added",title:"Untracked: new, not added to Git yet (git status ??)"});
  for(const code of ["UU","AA","DD","AU","UA","DU","UD"]){
    const badge=gitStatusBadge(code);
    assert.equal(badge.kind,"conflict",code);assert.equal(badge.label,code);assert.match(badge.title,/^Conflict/);
  }
  assert.notEqual(gitStatusBadge("??").label,"U");
});

test("git status badges drop the column padding and name the status",()=>{
  assert.deepEqual(gitStatusBadge(" M"),{label:"M",kind:"modified",title:"Modified (git status M)"});
  assert.deepEqual(gitStatusBadge("M "),{label:"M",kind:"modified",title:"Modified (git status M)"});
  assert.deepEqual(gitStatusBadge("MM"),{label:"MM",kind:"modified",title:"Modified (git status MM)"});
  assert.deepEqual(gitStatusBadge("A "),{label:"A",kind:"added",title:"Added (git status A)"});
  assert.deepEqual(gitStatusBadge(" D"),{label:"D",kind:"deleted",title:"Deleted (git status D)"});
  assert.deepEqual(gitStatusBadge("R "),{label:"R",kind:"renamed",title:"Renamed (git status R)"});
  assert.deepEqual(gitStatusBadge("C "),{label:"C",kind:"renamed",title:"Copied (git status C)"});
  assert.deepEqual(gitStatusBadge(" T"),{label:"T",kind:"modified",title:"Type changed (git status T)"});
  assert.equal(gitStatusBadge("").label,"M");
});

test("a path splits into its folder and name, and an untracked folder keeps its name",()=>{
  assert.deepEqual(splitPath("ui/src/App.jsx"),{dir:"ui/src",sep:"/",name:"App.jsx"});
  assert.deepEqual(splitPath("README.md"),{dir:"",sep:"",name:"README.md"});
  // git status reports an untracked folder as "name/": the name is the folder, not an empty string after the slash.
  assert.deepEqual(splitPath("capcut-network-capture/"),{dir:"",sep:"",name:"capcut-network-capture/"});
  assert.deepEqual(splitPath("tests/fixtures/new-dir/"),{dir:"tests/fixtures",sep:"/",name:"new-dir/"});
  assert.deepEqual(splitPath("C:\\Users\\dev\\repo"),{dir:"C:\\Users\\dev",sep:"\\",name:"repo"});
  for(const path of ["ui/src/App.jsx","capcut-network-capture/","tests/fixtures/new-dir/","C:\\Users\\dev\\repo","/srv/app","/"]){
    const {dir,sep,name}=splitPath(path);assert.equal(dir+sep+name,path,path);
  }
});

test("sibling paths lead with the segments that tell them apart",()=>{
  const worktrees=["H:/Github Repositories/Trebell","C:/Users/dev/.devspace/worktrees/Trebell-0c178972","C:/Users/dev/.devspace/worktrees/Trebell-0d6387c0"];
  assert.deepEqual(distinctPathParts(worktrees).map(part=>part.name),["Trebell","Trebell-0c178972","Trebell-0d6387c0"]);
  assert.deepEqual(distinctPathParts(worktrees)[1],{dir:"C:/Users/dev/.devspace/worktrees",sep:"/",name:"Trebell-0c178972"});
  // Same folder name under different parents: one more segment each.
  assert.deepEqual(distinctPathParts(["/work/a/repo","/work/b/repo","/work/c/other"]).map(part=>part.name),["a/repo","b/repo","other"]);
  assert.deepEqual(distinctPathParts(["D:\\wt\\one\\app","D:\\wt\\two\\app"]),[{dir:"D:\\wt",sep:"\\",name:"one\\app"},{dir:"D:\\wt",sep:"\\",name:"two\\app"}]);
  // A single path, or two identical ones, never loses text.
  assert.deepEqual(distinctPathParts(["/srv/app"]),[{dir:"/srv",sep:"/",name:"app"}]);
  for(const part of distinctPathParts(["/same/path","/same/path"]))assert.equal(part.dir+part.sep+part.name,"/same/path");
  assert.deepEqual(distinctPathParts(),[]);
});

test("a file change, the turn's diff or its end changes the open thread's workspace, and nothing else does",()=>{
  const open="thread-open";
  for(const [message,threadId] of [
    [{method:"item/fileChange/outputDelta",params:{threadId:open,itemId:"edit-1",delta:"+line"}},open],
    [{method:"item/fileChange/patchUpdated",params:{threadId:open,itemId:"edit-1"}},open],
    [{method:"item/completed",params:{threadId:open,item:{type:"fileChange",id:"edit-1"}}},open],
    [{method:"turn/diff/updated",params:{threadId:open,diff:""}},open],
    [{method:"turn/completed",params:{threadId:open,turn:{id:"turn-1"}}},open],
    // A notification that names no thread is the workspace's, with a thread open or none.
    [{method:"turn/completed",params:{}},open],[{method:"turn/diff/updated",params:{}},null],
  ])assert.equal(workspaceChanged(message,threadId),true,JSON.stringify(message));
  for(const [message,threadId] of [
    [{method:"turn/completed",params:{threadId:"another-thread"}},open],
    [{method:"item/completed",params:{threadId:open,item:{type:"fileChange"}}},null],
    [{method:"item/completed",params:{threadId:open,item:{type:"agentMessage",id:"reply"}}},open],
    [{method:"item/agentMessage/delta",params:{threadId:open,delta:"More text."}},open],
    [{method:"turn/started",params:{threadId:open}},open],
    [null,open],[{},open],
  ])assert.equal(workspaceChanged(message,threadId),false,JSON.stringify(message));
});
