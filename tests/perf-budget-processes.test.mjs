import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { CheckpointService } from "../src/checkpoint-service.mjs";
import { discoverEditors, listEditors } from "../desktop/editor-discovery.mjs";
import { git, gitInfo } from "../src/git-service.mjs";

// Process budgets for the child processes Trebell starts while it sits idle (goal.md section 6; perf plan budgets B6-B8). Each one
// counts launches through an injected runner, so the numbers do not depend on how busy the machine is.

// A `codex app-server` that answers initialize and account/read as a signed-out Codex does, over the same stdio JSON lines.
function fakeCodexAppServer(){
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  let buffer="";
  child.stdin.on("data",chunk=>{
    buffer+=String(chunk);let index;
    while((index=buffer.indexOf("\n"))>=0){
      const message=JSON.parse(buffer.slice(0,index));buffer=buffer.slice(index+1);
      if(message.id===undefined)continue;
      const result=message.method==="initialize"?{userAgent:"codex_cli_rs/0.200.0"}:{account:null,requiresOpenaiAuth:true};
      child.stdout.write(JSON.stringify({id:message.id,result})+"\n");
    }
  });
  child.kill=()=>{setImmediate(()=>child.emit("exit",0))};
  return child;
}
// Every harness CLI launch a probe makes, by runtime, through a remote environment (the runner the manager already takes).
function countingEnvironment(){
  const launches={},count=command=>{launches[command]=(launches[command]||0)+1};
  const profile={id:"ssh-budget",type:"ssh",cwd:"/srv/app"};
  const answers={
    cursor:args=>args[0]==="about"?JSON.stringify({userEmail:"dev@example.test"}):"2026.09.26-dd393fe\n",
    grok:args=>args[0]==="models"?"You are logged in\n- grok-4.6\n":"grok 1.2.0\n",
    opencode:args=>args[0]==="auth"?"— 2 credentials\n":"1.18.31\n",
    claude:args=>args[0]==="auth"?JSON.stringify({loggedIn:true}):"2.1.0 (Claude Code)\n",
    codex:()=>"codex-cli 0.200.0\n",
  };
  const runtime=command=>command==="cursor-agent"?"cursor":command;
  return {launches,profile,environments:{
    get:id=>id===profile.id?profile:null,
    executeArgv:async(_id,{command,args})=>{count(runtime(command));return {exitCode:0,stdout:answers[runtime(command)]?.(args)??"",stderr:""}},
    spawnArgv:(_id,{command})=>{count(runtime(command));return fakeCodexAppServer()},
  }};
}

test("B7: twelve Settings polls in a minute launch each ready harness CLI at most 3 times",async()=>{
  const {launches,profile,environments}=countingEnvironment();
  let clock=1_000_000;
  const manager=new AgentRuntimeManager({state:{settings:()=>({activeEnvironmentId:profile.id})},environments,platform:"linux",env:{PATH:"/usr/bin",HOME:"/home/test"},now:()=>clock});
  for(const kind of ["claude","cursor","grok","opencode"]){
    // /api/runtime probes the active harness on every 5-s poll; a thread start's probe in the same minute is one more of these.
    for(let poll=0;poll<12;poll++){const status=await manager.probe(kind);assert.equal(status.available,true,kind);clock+=5000}
  }
  // Before the probe cache every poll probed again: 24 launches in 12 polls for each.
  for(const kind of ["claude","cursor","grok","opencode"])assert.ok((launches[kind]||0)<=3,kind+" launched "+launches[kind]+" times in 12 polls");
  // A ready answer is reused for a minute, then the harness is asked again.
  const before={...launches};clock+=61_000;
  assert.equal((await manager.probe("grok")).available,true);
  assert.equal(launches.grok,before.grok+2,"after a minute the version check and the sign-in check run again");
});

test("B7: a harness that cannot run is asked again at every poll, so a sign-in outside Trebell counts at once",async()=>{
  const {launches,profile,environments}=countingEnvironment();
  let clock=1_000_000;
  const manager=new AgentRuntimeManager({state:{settings:()=>({activeEnvironmentId:profile.id})},environments,platform:"linux",env:{PATH:"/usr/bin",HOME:"/home/test"},now:()=>clock});
  // Codex here is signed out. Each poll reads its account again, as before the probe cache; a remote profile keeps no version
  // answer, so it checks that too (a local one keeps it until the binary changes, which leaves the account read).
  for(let poll=0;poll<12;poll++){const status=await manager.probe("codex");assert.equal(status.authenticated,false);clock+=5000}
  assert.equal(launches.codex,24);
});

test("B7: Settings' own check asks again at once, and probes that overlap share one launch",async()=>{
  const {launches,profile,environments}=countingEnvironment();
  const manager=new AgentRuntimeManager({state:{settings:()=>({activeEnvironmentId:profile.id})},environments,platform:"linux",env:{PATH:"/usr/bin",HOME:"/home/test"}});
  const [first,second]=await Promise.all([manager.probe("grok"),manager.probe("grok")]);
  assert.equal(launches.grok,2,"two overlapping probes run one version check and one models check");
  assert.deepEqual(first,second);assert.notEqual(first,second,"each caller gets its own copy");
  await manager.probe("grok",{fresh:true});
  assert.equal(launches.grok,4,"a fresh probe launches again");
  await manager.snapshot();
  assert.equal(launches.grok,6,"the Settings listing checks every harness again");
  await manager.probe("grok");
  assert.equal(launches.grok,6,"and what it found is reused");
});

// A small repository with a commit, two branches, a remote and an untracked file, as a project folder looks.
async function fixtureRepository(prefix){
  const dir=await mkdtemp(join(tmpdir(),prefix));
  await git(dir,["init","-q","-b","main"]);await git(dir,["config","user.email","trebell@example.test"]);await git(dir,["config","user.name","Trebell Test"]);
  await writeFile(join(dir,"a.txt"),"hello\n");await git(dir,["add","a.txt"]);await git(dir,["commit","-qm","init"]);
  await git(dir,["branch","feature/one"]);await git(dir,["remote","add","origin","https://example.invalid/repo.git"]);
  await writeFile(join(dir,"draft.txt"),"untracked\n");
  return dir;
}
const countingGit=()=>{const calls=[];return {calls,gitFn:(cwd,args,options)=>{calls.push(args.join(" "));return git(cwd,args,options)}}};

test("B6: a warm /api/git/info poll starts one git process",{timeout:30_000},async()=>{
  const dir=await fixtureRepository("trebell-git-budget-");
  try{
    const {calls,gitFn}=countingGit();
    const cold=await gitInfo(dir,{gitFn});assert.equal(cold.isGit,true);assert.equal(cold.branch,"main");
    assert.equal(calls.length,7,"a cold read runs what every poll ran before");
    calls.length=0;
    const warm=await gitInfo(dir,{gitFn});
    assert.deepEqual(warm,cold);
    // The UI polls every 3.5 s while a project thread is open: 7 processes each poll was about 120 a minute.
    assert.deepEqual(calls,["status --porcelain=v1 -b"]);
  }finally{await rm(dir,{recursive:true,force:true})}
});

// What a warm poll answers equals a full read after each change a person or an agent makes to the repository.
test("B6: gitInfo's kept repository part follows checkout, commit, new branches, remotes, worktrees and submodules",{timeout:180_000},async()=>{
  const dir=await fixtureRepository("trebell-git-cache-"),linked=dir+"-linked",library=dir+"-library";
  try{
    const same=async(cwd,label)=>{const {calls,gitFn}=countingGit();const warm=await gitInfo(cwd,{gitFn});assert.deepEqual(warm,await gitInfo(cwd,{fresh:true}),label);return calls.length};
    await gitInfo(dir);
    assert.equal(await same(dir,"no change"),1);
    await git(dir,["switch","-q","feature/one"]);assert.equal((await gitInfo(dir)).branch,"feature/one");await same(dir,"checkout");
    await writeFile(join(dir,"a.txt"),"changed\n");assert.deepEqual((await gitInfo(dir)).status.map(item=>item.path),["a.txt","draft.txt"]);
    await git(dir,["commit","-qam","change"]);await same(dir,"commit");
    await git(dir,["branch","topic"]);assert.ok((await gitInfo(dir)).branches.includes("topic"));await same(dir,"new branch");
    await git(dir,["branch","feature/two"]);assert.ok((await gitInfo(dir)).branches.includes("feature/two"));await same(dir,"a branch in an existing folder");
    await git(dir,["remote","add","upstream","https://example.invalid/upstream.git"]);assert.equal((await gitInfo(dir)).remotes.length,4);await same(dir,"remote add");
    await git(dir,["update-ref","refs/remotes/origin/main","HEAD"]);assert.equal((await gitInfo(dir)).upstream,null);await same(dir,"a remote ref");
    await git(dir,["config","branch.feature/one.remote","origin"]);await git(dir,["config","branch.feature/one.merge","refs/heads/main"]);
    assert.equal((await gitInfo(dir)).upstream,"origin/main");await same(dir,"upstream set");
    // A linked worktree reads its own HEAD through its git dir; the main folder sees it in the worktree list.
    await git(dir,["worktree","add","-q","-b","side",linked]);
    assert.equal((await gitInfo(dir)).worktrees.length,2);await same(dir,"worktree add");
    await gitInfo(linked);await git(linked,["switch","-q","-c","side-two"]);
    assert.equal((await gitInfo(linked)).branch,"side-two");await same(linked,"switch in the linked worktree");
    // A submodule's HEAD lives in the parent's .git/modules.
    await mkdir(library);await git(library,["init","-q","-b","main"]);await git(library,["config","user.email","trebell@example.test"]);await git(library,["config","user.name","Trebell Test"]);
    await writeFile(join(library,"lib.txt"),"lib\n");await git(library,["add","lib.txt"]);await git(library,["commit","-qm","lib"]);
    await git(dir,["-c","protocol.file.allow=always","submodule","add","-q",library,"lib"]);
    const sub=join(dir,"lib");assert.equal((await gitInfo(sub)).branch,"main");
    await git(sub,["switch","-q","-c","lib-topic"]);assert.equal((await gitInfo(sub)).branch,"lib-topic");await same(sub,"switch in the submodule");
  }finally{
    await rm(linked,{recursive:true,force:true,maxRetries:10,retryDelay:100});await rm(library,{recursive:true,force:true,maxRetries:10,retryDelay:100});
    await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

// git finds a repository in the folder asked about, or in a folder between it and the root, before the root's: a project folder
// inside another repository that becomes one of its own (an agent's git init, a clone) is that repository at the next poll.
test("B6: a folder below the root that becomes its own repository is answered as that repository at the next poll",{timeout:60_000},async()=>{
  const dir=await fixtureRepository("trebell-git-nested-"),app=join(dir,"apps","web");
  try{
    await mkdir(app,{recursive:true});await writeFile(join(app,"main.js"),"x\n");
    const same=async label=>{const {calls,gitFn}=countingGit();const polled=await gitInfo(app,{gitFn});assert.deepEqual(polled,await gitInfo(app,{fresh:true}),label);return calls.length};
    await gitInfo(app);
    assert.equal(await same("no change"),1,"a warm poll of a folder below the root still starts one git process");
    await git(join(dir,"apps"),["init","-q","-b","apps"]);await same("git init in a folder between");
    await git(app,["init","-q","-b","trunk"]);
    assert.equal((await gitInfo(app)).branch,"trunk");assert.deepEqual((await gitInfo(app)).status,[{code:"??",path:"main.js"}]);
    await same("git init in the project folder");
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});

// git 2.45 and later can keep refs in reftable (git init --ref-format=reftable, init.defaultRefFormat, git refs migrate), the default
// planned for Git 3. Such a repository's .git/HEAD always reads "ref: refs/heads/.invalid" and refs/heads is a stub file: a switch
// or a new branch made in an agent's shell or a terminal changes only reftable/, the common dir's or a linked worktree's own.
test("B6: gitInfo's kept repository part follows switches, new branches and worktrees in a reftable repository",{timeout:60_000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-git-reftable-")),linked=dir+"-linked";
  try{
    if(!(await git(dir,["init","-q","--ref-format=reftable","-b","main"],{allowFailure:true})).ok){t.skip("this git has no reftable support");return}
    await git(dir,["config","user.email","trebell@example.test"]);await git(dir,["config","user.name","Trebell Test"]);
    await writeFile(join(dir,"a.txt"),"hello\n");await git(dir,["add","a.txt"]);await git(dir,["commit","-qm","init"]);
    const same=async(cwd,label)=>{const {calls,gitFn}=countingGit();const warm=await gitInfo(cwd,{gitFn});assert.deepEqual(warm,await gitInfo(cwd,{fresh:true}),label);return calls.length};
    assert.equal((await gitInfo(dir)).branch,"main");
    assert.equal(await same(dir,"no change"),1,"a warm poll of a reftable repository still starts one git process");
    await git(dir,["switch","-q","-c","feature/login"]);
    const switched=await gitInfo(dir);assert.equal(switched.branch,"feature/login");assert.ok(switched.branches.includes("feature/login"));await same(dir,"switch to a new branch");
    await git(dir,["branch","topic"]);assert.ok((await gitInfo(dir)).branches.includes("topic"));await same(dir,"new branch");
    await git(dir,["switch","-q","main"]);assert.equal((await gitInfo(dir)).branch,"main");await same(dir,"switch to a branch that exists");
    // A linked worktree keeps its HEAD in its own reftable/ below the common dir's worktrees folder.
    await git(dir,["worktree","add","-q","-b","side",linked]);assert.equal((await gitInfo(dir)).worktrees.length,2);await same(dir,"worktree add");
    await gitInfo(linked);await git(linked,["switch","-q","topic"]);
    assert.equal((await gitInfo(linked)).branch,"topic");await same(linked,"switch in the linked worktree");
    // A switch also rewrites the worktree's index beside its reftable folder; a HEAD change alone (symbolic-ref) touches only that folder.
    await gitInfo(dir,{fresh:true});await git(linked,["symbolic-ref","HEAD","refs/heads/side"]);
    assert.ok((await gitInfo(dir)).worktrees.some(item=>item.branch==="side"),"the main folder lists the linked worktree on its new branch");
    await same(dir,"a HEAD change in the linked worktree");
  }finally{await rm(linked,{recursive:true,force:true,maxRetries:10,retryDelay:100});await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});

// A build, a formatter or a copy that writes tracked files again with the same content changes only their times, and git status
// reads and hashes each such file until a status that may write the index records them. The warm polls stay off the index lock (an
// agent's git add or commit fails at once while it is held); the full read, at most 30 s later, takes it.
test("B6: a file written again with the same content is recorded by the next full read, so later polls do not hash it again",{timeout:60_000},async()=>{
  const dir=await fixtureRepository("trebell-git-rewrite-"),file=join(dir,"a.txt"),at=Math.floor(Date.now()/1000)-100,now=Date.now;
  const recorded=async()=>Number(/mtime:\s*(\d+)/.exec((await git(dir,["ls-files","--debug","--","a.txt"])).stdout)?.[1]);
  const statuses=[],gitFn=(cwd,args,options)=>{if(args[0]==="status")statuses.push(options.env?.GIT_OPTIONAL_LOCKS??"may lock");return git(cwd,args,options)};
  try{
    await utimes(file,at,at);await git(dir,["update-index","-q","--refresh"]);assert.equal(await recorded(),at);
    await gitInfo(dir,{gitFn});
    await writeFile(file,"hello\n");await utimes(file,at+50,at+50);
    await gitInfo(dir,{gitFn});assert.equal(await recorded(),at,"a warm poll leaves the index alone");
    Date.now=()=>now()+30_000;
    await gitInfo(dir,{gitFn});assert.equal(await recorded(),at+50,"the full read at the 30-s age records the file's new time");
    assert.deepEqual(statuses,["may lock","0","may lock"]);
  }finally{Date.now=now;await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});

// A checkpoint's tree as create() recorded it before it reused the repository's index: a fresh index read from HEAD, then add -A.
async function treeFromHead(repo,exclusions=[]){
  const env={...process.env,GIT_INDEX_FILE:repo+"-from-head-index"};
  try{
    const head=await git(repo,["rev-parse","--verify","-q","HEAD"],{allowFailure:true});
    await git(repo,head.ok?["read-tree","HEAD"]:["read-tree","--empty"],{env});
    await git(repo,["add","-A","--",".",...exclusions],{env});
    return (await git(repo,["write-tree"],{env})).stdout.trim();
  }finally{await rm(env.GIT_INDEX_FILE,{force:true})}
}
// Committed, staged, unstaged, deleted, untracked, ignored, force-added and intent-to-add files, as an agent's work leaves a repo.
async function checkpointFixture(prefix){
  const dir=await fixtureRepository(prefix),write=(path,text)=>writeFile(join(dir,path),text);
  await mkdir(join(dir,"dir"));await mkdir(join(dir,"build"));
  await write(".gitignore","*.log\nbuild/\n");await write("b.txt","b\n");await write("c.txt","c\n");await write("dir/d.txt","d\n");
  await write("keep.log","committed although ignored\n");await write("dropped.log","committed, then untracked\n");
  await git(dir,["add",".gitignore","b.txt","c.txt","dir/d.txt"]);await git(dir,["add","-f","keep.log","dropped.log"]);await git(dir,["commit","-qm","more"]);
  await write("a.txt","staged\n");await git(dir,["add","a.txt"]);await write("a.txt","staged, then changed again\n");
  await write("b.txt","unstaged\n");await rm(join(dir,"c.txt"));await git(dir,["rm","-q","--cached","dropped.log"]);
  await write("dir/new.txt","untracked\n");await write("debug.log","ignored\n");await write("build/out.bin","ignored\n");
  await write("forced.log","force-added\n");await git(dir,["add","-f","forced.log"]);await write("ita.txt","intent to add\n");await git(dir,["add","-N","ita.txt"]);
  return dir;
}
const checkpointState=()=>({addCheckpoint:item=>({...item,createdAt:1}),checkpoints:()=>[],updateCheckpoint:()=>null});

test("B8: a checkpoint of a project folder starts at most 6 git processes",{timeout:60_000},async()=>{
  const dir=await checkpointFixture("trebell-checkpoint-budget-");
  try{
    const {calls,gitFn}=countingGit();
    const service=new CheckpointService({state:checkpointState(),env:{...process.env,TREBELL_HOME:dir+"-home"},gitFn,gitInfoFn:(cwd,options)=>gitInfo(cwd,{...options,gitFn})});
    const checkpoint=await service.create({cwd:dir});assert.equal(checkpoint.supported,true);
    // One rev-parse for the root, the index and HEAD, then read-tree, add, write-tree, commit-tree and update-ref. It was 13: gitInfo's
    // 7 for the root alone and a rev-parse HEAD of its own.
    assert.ok(calls.length<=6,calls.length+" git processes: "+calls.join(", "));
    assert.ok(calls.includes("read-tree --reset HEAD"),"the index was seeded from the repository's own");
  }finally{await rm(dir,{recursive:true,force:true});await rm(dir+"-home",{recursive:true,force:true})}
});

test("B8: a checkpoint's tree equals a fresh read of HEAD plus add -A, in every index state",{timeout:180_000},async()=>{
  const dir=await checkpointFixture("trebell-checkpoint-tree-");
  try{
    const {calls,gitFn}=countingGit(),service=new CheckpointService({state:checkpointState(),env:{...process.env,TREBELL_HOME:dir+"-home"},gitFn});
    // seeded says which way the checkpoint read its index: from the repository's own, or afresh from HEAD.
    const same=async(label,exclusions,{seeded=true,repo=dir}={})=>{
      calls.length=0;const expected=await treeFromHead(repo,exclusions),checkpoint=await service.create({cwd:repo===dir?join(dir,"dir"):repo});
      assert.equal((await git(repo,["rev-parse",checkpoint.commit+"^{tree}"])).stdout.trim(),expected,label);
      assert.equal(calls.includes("read-tree --reset HEAD"),seeded,label+": "+calls.join(", "));
    };
    await same("staged, unstaged, deleted, untracked, ignored, force-added and intent-to-add files");
    const nested=join(dir,"nested");await mkdir(nested);await git(nested,["init","-q","-b","main"]);
    await git(nested,["-c","user.email=t@example.test","-c","user.name=T","commit","-q","--allow-empty","-m","nested"]);
    await same("a nested repository with a commit");
    const empty=join(dir,"empty-nested");await mkdir(empty);await git(empty,["init","-q"]);await writeFile(join(empty,"private.txt"),"not captured\n");
    await same("a nested repository without a commit",[":(exclude,literal)empty-nested/"]);
    await rm(empty,{recursive:true,force:true});
    // Flags that keep add -A from reading a file: the checkpoint still records what is on disk.
    await git(dir,["update-index","--assume-unchanged","b.txt"]);await writeFile(join(dir,"b.txt"),"changed under assume-unchanged\n");
    await same("an assume-unchanged file changed on disk",[],{seeded:false});
    await git(dir,["update-index","--no-assume-unchanged","b.txt"]);await git(dir,["update-index","--skip-worktree","dir/d.txt"]);
    await writeFile(join(dir,"dir","d.txt"),"changed under skip-worktree\n");
    await same("a skip-worktree file changed on disk",[],{seeded:false});
    await git(dir,["update-index","--no-skip-worktree","dir/d.txt"]);
    await git(dir,["update-index","--index-version","4"]);await writeFile(join(dir,"dir","d.txt"),"changed again\n");
    await same("an index in version 4, whose paths are prefix-compressed");
    // A merge stopped on a conflict leaves unmerged entries in the index.
    await git(dir,["add","-A"]);await git(dir,["commit","-qm","everything"]);await git(dir,["switch","-q","-c","other","HEAD~1"]);
    await writeFile(join(dir,"a.txt"),"other side\n");await git(dir,["commit","-qam","other"]);await git(dir,["switch","-q","main"]);
    await git(dir,["merge","other"],{allowFailure:true});
    assert.match((await git(dir,["ls-files","-u"])).stdout,/a\.txt/);
    await same("unmerged entries after a conflicted merge");
    const wide=dir+"-sha256";await mkdir(wide);await git(wide,["init","-q","--object-format=sha256"]);
    await writeFile(join(wide,"a.txt"),"a\n");await git(wide,["add","a.txt"]);await git(wide,["-c","user.email=t@example.test","-c","user.name=T","commit","-qm","a"]);
    await writeFile(join(wide,"a.txt"),"changed\n");await writeFile(join(wide,"b.txt"),"new\n");
    try{await same("a repository with SHA-256 object names",[],{repo:wide})}finally{await rm(wide,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});await rm(dir+"-home",{recursive:true,force:true})}
});

// git trusts an entry's stat data only when the entry is older than the index file, and compares the content of one as new as the
// index (racily clean): a file an agent writes, git status refreshes and the agent writes again in the same second at the same size
// differs from its entry only in content. The checkpoint's copy of the index must keep that, or add -A skips the file and Edit from
// here would restore the older content.
const noLocks={...process.env,GIT_OPTIONAL_LOCKS:"0"};
async function racyCheckpoint(dir){
  assert.match((await git(dir,["status","--porcelain"],{env:noLocks})).stdout,/^ M a\.txt$/m,"git status sees the edit");
  const checkpoint=await new CheckpointService({state:checkpointState(),env:{...process.env,TREBELL_HOME:dir+"-home"}}).create({cwd:dir});
  assert.equal((await git(dir,["show",checkpoint.commit+":a.txt"])).stdout,"HELLO\n","the checkpoint holds the file as it is on disk");
  assert.equal((await git(dir,["rev-parse",checkpoint.commit+"^{tree}"])).stdout.trim(),await treeFromHead(dir));
}
test("B8: a checkpoint keeps a same-size edit git tells apart only by its content, with the times set",{timeout:60_000},async()=>{
  const dir=await fixtureRepository("trebell-checkpoint-racy-"),file=join(dir,"a.txt"),at=Math.floor(Date.now()/1000)-100;
  try{
    // The index and the entry it keeps for a.txt share one second, set in the past so the test waits for no clock.
    await utimes(file,at,at);await git(dir,["update-index","-q","--refresh"],{allowFailure:true});await utimes(join(dir,".git","index"),at,at);
    await writeFile(file,"HELLO\n");await utimes(file,at,at);
    await racyCheckpoint(dir);
  }finally{await rm(dir,{recursive:true,force:true});await rm(dir+"-home",{recursive:true,force:true})}
});
test("B8: a checkpoint keeps a same-size edit made in the second git refreshed the index",{timeout:60_000},async t=>{
  const dir=await fixtureRepository("trebell-checkpoint-racy-clock-"),file=join(dir,"a.txt");
  try{
    // Written, refreshed (an agent's or an editor's git status, diff or add) and written again, all within one wall-clock second.
    let oneSecond=false;
    for(let attempt=0;attempt<5&&!oneSecond;attempt++){
      while(Date.now()%1000>50)await new Promise(resolve=>setTimeout(resolve,5));
      const start=Date.now();
      await writeFile(file,"hello\n");await git(dir,["update-index","-q","--refresh"],{allowFailure:true});await writeFile(file,"HELLO\n");
      oneSecond=Math.floor(start/1000)===Math.floor(Date.now()/1000);
    }
    if(!oneSecond){t.skip("the machine was too busy to fit the three steps in one second");return}
    // The checkpoint comes later, as a send's does, so its copy of the index is written in a later second.
    await new Promise(resolve=>setTimeout(resolve,1200));
    await racyCheckpoint(dir);
  }finally{await rm(dir,{recursive:true,force:true});await rm(dir+"-home",{recursive:true,force:true})}
});

// Editor discovery runs on Electron's main process each time the chat header's Open-in control shows and again on each Open.
test("M8: one editor discovery starts one where launch, and the kept list none",async()=>{
  // It was 22, one where.exe (which on macOS and Linux) per editor command, one after another.
  const launches=[];
  const exec=(file,args,_options,callback)=>{launches.push([file,...args]);callback(Object.assign(new Error("not found"),{code:1}),"","INFO: Could not find files for the given pattern(s).\r\n")};
  const editors=await discoverEditors({platform:"win32",env:{LOCALAPPDATA:"C:\\Users\\dev\\AppData\\Local"},exec,exists:()=>false,readDirectory:()=>[]});
  assert.deepEqual(editors,[]);
  assert.equal(launches.length,1);assert.equal(launches[0].length,23,"where gets all 22 commands at once");
  let clock=1_000_000;launches.length=0;
  const discover=()=>discoverEditors({platform:"win32",env:{},exec,exists:()=>false,readDirectory:()=>[]});
  await listEditors({refresh:true,now:()=>clock,discover});clock+=5*60_000;await listEditors({now:()=>clock,discover});
  assert.equal(launches.length,1,"the header showing again within ten minutes starts no process");
});
