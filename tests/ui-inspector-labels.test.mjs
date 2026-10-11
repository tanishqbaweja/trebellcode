import test from "node:test";
import assert from "node:assert/strict";
import { actionError, actionErrorUnlessNamed, asSentence, distinctPathParts, distinctTextParts, fileNameParts, gitStatusBadge, gitStatusEntry, gitStatusPath, splitPath } from "../ui/src/inspector-labels.js";

test("a changed file's name is cut in the middle, keeping the end that tells it apart and its extension",()=>{
  const cut=names=>fileNameParts(names).map(({lead,tail})=>[lead,tail]);
  // Names alike to their last characters keep their own ends, from the start of the word where they part.
  assert.deepEqual(cut(["artifact_1791317470236_d6b22939.png","artifact_1791317477991_ae1a8b66.png","google_startups_window.png","capcut-network-capture/"]),
    [["artifact_1791317470236_","d6b22939.png"],["artifact_1791317477991_","ae1a8b66.png"],["google_startups_","window.png"],["capcut-network-","capture/"]]);
  assert.deepEqual(cut(["tool-activity.js","tool-activity-summary.js","native-agent-session-recovery.mjs","native-agent-session-recorder.mjs"]),
    [["tool-","activity.js"],["tool-activity-","summary.js"],["native-agent-session-","recovery.mjs"],["native-agent-session-","recorder.mjs"]]);
  // The tail starts at the nearer word: the next one when the word it falls in starts far back or is the name's own start.
  assert.deepEqual(cut(["ui-tool-activity.test.mjs","package-lock.json","tool-activity.js"]).slice(0,2),[["ui-tool-activity.","test.mjs"],["package-","lock.json"]]);
  // Names that differ in the middle keep where they part, even past the extension's room.
  assert.deepEqual(cut(["workspace-panel-dark-1280x800.png","workspace-panel-light-1280x800.png"]),[["workspace-panel-","dark-1280x800.png"],["workspace-panel-","light-1280x800.png"]]);
  // Short names, one word and its extension, dotfiles and names alike in full are not cut in the middle at all.
  for(const name of ["goal.md","package.json","visual.spec.js","README",".gitignore","verylongname.png"])assert.deepEqual(cut([name,"package-lock.json","visual-tour.spec.js"])[0],["",name]);
  assert.deepEqual(cut(["index.js","index.js"]),[["","index.js"],["","index.js"]]);
  // A long word with no boundary near is cut inside it, so the extension stays; a cut never splits a surrogate pair or leaves a lead
  // of one character.
  assert.deepEqual(cut(["supercalifragilisticexpialidocious.ts"]),[["supercalifragilisticexpialid","ocious.ts"]]);
  for(const [lead,tail] of cut(["notes-😀😀😀😀😀😀😀😀😀a.txt","notes-😀😀😀😀😀😀😀😀😁a.txt","ab.txt"])){assert.doesNotMatch(tail,/^[\uDC00-\uDFFF]/);assert.ok(lead.length!==1)}
  // Nothing is lost, for any list.
  for(const names of [["a/b.js","b.js"],["",""],["x"],["same.txt","same.txt"],["é-long-name-thing.md","é-long-name-other.md"]])for(const [index,{lead,tail}] of fileNameParts(names).entries())assert.equal(lead+tail,names[index]);
  assert.deepEqual(fileNameParts(),[]);
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
