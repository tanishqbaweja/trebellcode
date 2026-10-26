import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import * as gitService from "../src/git-service.mjs";
import { sourceControlGitAction, withSourceControlExecutor } from "../src/source-control-service.mjs";

const { createWorktree, git, removeWorktree, restoreWorktree } = gitService;
// git commands take seconds each on a host that benchmarks load (git-service.test.mjs), so the bound is a generous one for a stuck test.
const UNDER_LOAD={timeout:300_000};
// The race test's 96 adds, each with git's status read twice, the turn's key and a submodule update, take 31 to 36 s alone, so the load
// that ran tests of 3 to 25 s past bounds of 20 and 30 s would bring them near 300 s. Without the submodule updates they take 16 s but
// caught the race on the code before the turns in 1 run of 3, where with them every run failed, so the bound grows instead.
const MANY_ADDS={timeout:900_000};
const RETRY={recursive:true,force:true,maxRetries:30,retryDelay:100};
const samePath=path=>{const value=resolve(path);return process.platform==="win32"?value.toLowerCase():value};
const gate=()=>{let open=()=>{};const promise=new Promise(resolve=>{open=resolve});return {promise,open}};
// Lets every chain of promises that can go on do so (in-memory work only: no timers, no I/O), until check holds when one is given.
async function settled(check=null,message=""){for(let i=0;i<50&&!check?.();i++)await new Promise(resolve=>setImmediate(resolve));if(check)assert.ok(check(),message)}
// Waits for check to hold, for as long as git may take on a loaded host.
async function waitFor(check,message,ms=120_000){const end=Date.now()+ms;while(!check()&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(check(),message)}
// What promise gives, or late when it gives nothing within ms.
async function within(promise,ms,late){let timer;try{return await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(late),ms)})])}finally{clearTimeout(timer)}}
// Waits while check holds, for at most ms.
async function holds(check,ms){const end=Date.now()+ms;while(check()&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,20))}
async function committedRepository(repo,init=[]){
  await mkdir(repo,{recursive:true});await git(repo,["init",...init]);await git(repo,["config","user.email","trebell@example.test"]);await git(repo,["config","user.name","Trebell Test"]);
  await writeFile(join(repo,"README.md"),"seed\n");await git(repo,["add","README.md"]);await git(repo,["commit","-m","seed"]);
}
const listedWorktrees=async repo=>(await git(repo,["worktree","list","--porcelain"])).stdout.split(/\r?\n/).filter(line=>line.startsWith("worktree ")).map(line=>samePath(line.slice(9)));

// A multi-model send makes each model's worktree at once in one repository (the server's worktree-create, createWorktree, with the
// default submodule update). git worktree add is not safe at once there: an add that read the admin folder of another still being
// written failed with "failed to read .git/worktrees/<the other>/commondir", and that model never started. Before the turns, rounds
// of 24 adds at once failed so in every run of this test (rounds of 16 in half of them); the race is one of timing, so a run without
// a failure proves nothing.
test("worktrees made at once in one repository, as a multi-model send makes them, are all made and git lists every one",MANY_ADDS,async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-worktree-turns-")),repo=join(root,"repo");
  try{
    await committedRepository(repo);const made=[];
    for(let round=1;round<=4;round++){
      const paths=Array.from({length:24},(_,i)=>join(root,`repo-trebell-model-${round}-${i}`));
      const results=await Promise.allSettled(paths.map((path,i)=>createWorktree(repo,{branch:`trebell/model-${round}-${i}`,path,baseBranch:"HEAD"})));
      assert.deepEqual(results.filter(result=>result.status==="rejected").map(result=>result.reason.message),[],`round ${round}: every model's worktree is made`);
      made.push(...paths);const listed=await listedWorktrees(repo);
      assert.deepEqual(made.filter(path=>!listed.includes(samePath(path))),[],`round ${round}: git lists every worktree made`);
      assert.equal(listed.length,1+made.length,`round ${round}: the repository and its ${made.length} worktrees`);
    }
  }finally{await rm(root,RETRY)}
});

// An add's turn holds only git's bookkeeping: its checkout, 6.4 s of a 6.6 s add in a repository of 6,000 files, and its
// post-checkout hook run after the turn, beside the next model's add. With whole adds in turns, the third model of a send waited for
// the checkouts of the two before it. Here model A's checkout is held, by a filter that waits as a slow LFS smudge would.
test("a model's checkout runs after its add's turn, so the next model's worktree is made while it is held",UNDER_LOAD,async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-worktree-checkout-turn-")),repo=join(root,"repo"),gates=join(root,"gates");
  const first=join(root,"repo-trebell-model-a"),second=join(root,"repo-trebell-model-b"),open=tree=>writeFile(join(gates,basename(tree)),"");
  let firstAdd=null,secondAdd=null,firstMade=false;
  try{
    await committedRepository(repo);await mkdir(gates);
    await writeFile(join(repo,".gitattributes"),"held.txt filter=hold\n");await writeFile(join(repo,"held.txt"),"held\n");
    await git(repo,["add",".gitattributes","held.txt"]);await git(repo,["commit","-m","held"]);
    // held.txt checks out through a filter that waits for its worktree's gate (git runs it in the worktree's folder).
    await git(repo,["config","filter.hold.smudge",`while [ ! -e "${gates.replace(/\\/g,"/")}/$(basename "$PWD")" ]; do sleep 0.05; done; cat`]);
    await open(second);
    firstAdd=createWorktree(repo,{branch:"trebell/model-a",path:first,submodules:"none"});firstAdd.then(()=>{firstMade=true},()=>{});
    await waitFor(()=>existsSync(join(first,".git")),"model A's worktree is added, its checkout held");
    secondAdd=createWorktree(repo,{branch:"trebell/model-b",path:second,submodules:"none"});
    assert.equal(await within(secondAdd.then(()=>"made"),120_000,"waiting"),"made","model B's worktree is made while model A's checkout is held");
    assert.equal(firstMade,false,"model A's checkout is still held");
    await open(first);await firstAdd;
    for(const tree of [first,second])assert.equal(await readFile(join(tree,"held.txt"),"utf8"),"held\n",tree+" is checked out");
    assert.deepEqual((await listedWorktrees(repo)).slice(1).sort(),[first,second].map(samePath).sort());
  }finally{await open(first).catch(()=>{});await Promise.allSettled([firstAdd,secondAdd]);await rm(root,RETRY)}
});

// An add's turn lasts until git has written the new worktree's HEAD: the next add reads every worktree's HEAD to refuse a branch one has
// checked out ("already used by worktree"), and one that went on before that HEAD was written made a second worktree on the branch.
// With reftable refs the HEAD file is a stub until git commits the worktree's refs. Here model A's add is held in git's own transaction
// that sets its HEAD, by a reference-transaction hook that waits on a gate and leaves a mark, while an add of the same branch at another
// path waits for its turn.
for(const format of ["files","reftable"])test(`the next add waits for the new worktree's HEAD, so git refuses an add of the branch it checks out (${format} refs)`,UNDER_LOAD,async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-worktree-head-turn-")),repo=join(root,"repo"),hooks=join(root,"hooks"),marks=join(root,"marks");
  const first=join(root,"repo-a"),second=join(root,"repo-b"),gateFile=join(marks,"gate"),heldFile=join(marks,"held"),slashes=path=>path.replace(/\\/g,"/");
  const held=()=>existsSync(heldFile)?readFileSync(heldFile,"utf8").split("\n").filter(Boolean).length:0,secondAdmin=()=>existsSync(join(repo,".git","worktrees","repo-b"));
  let firstAdd=null,secondAdd=null;
  try{
    if(!(await git(root,["init","--ref-format="+format,"format-probe"],{allowFailure:true})).ok)return t.skip("this git has no --ref-format (git 2.45 and later have)");
    await committedRepository(repo,["--ref-format="+format]);await git(repo,["branch","shared"]);await mkdir(hooks);await mkdir(marks);
    await writeFile(join(hooks,"reference-transaction"),`#!/bin/sh\ninput=$(cat)\ncase "$1:$input" in\n  prepared:*" HEAD") echo held >> "${slashes(heldFile)}"; while [ -e "${slashes(gateFile)}" ]; do sleep 0.05; done ;;\nesac\nexit 0\n`,{mode:0o755});
    await writeFile(gateFile,"");await git(repo,["config","core.hooksPath",slashes(hooks)]);
    const started=Date.now();firstAdd=restoreWorktree(repo,{branch:"shared",path:first,submodules:"none"});firstAdd.catch(()=>{});
    await waitFor(()=>held()===1,"model A's add is held in the transaction that sets its HEAD");
    // Let go, model B's add would reach its own HEAD about as soon as model A's did: it has three times as long (5 s at least).
    const bound=Math.max(5_000,3*(Date.now()-started));
    secondAdd=restoreWorktree(repo,{branch:"shared",path:second,submodules:"none"});secondAdd.catch(()=>{});
    await holds(()=>held()===1&&!secondAdmin(),bound);
    assert.equal(held(),1,"model B's add does not reach its HEAD while model A's is held");assert.equal(secondAdmin(),false,"model B's add writes no admin folder while model A's HEAD is held");
    await rm(gateFile);
    await assert.rejects(secondAdd,/'shared' is already (used by worktree|checked out) at /);await firstAdd;
    assert.deepEqual((await listedWorktrees(repo)).slice(1),[samePath(first)],"one worktree on the branch");assert.equal(existsSync(second),false,"nothing of model B's worktree");
  }finally{await rm(gateFile,{force:true});await Promise.allSettled([firstAdd,secondAdd]);await rm(root,RETRY)}
});

// A remove git refuses deletes nothing: one with a file untracked, a locked one, one with a submodule checked out (unless forced), and the
// repository's own folder. Forced, they go.
test("a remove git refuses leaves the worktree where it was, and a forced one removes it",UNDER_LOAD,async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-worktree-remove-refused-")),repo=join(root,"repo"),library=join(root,"library");
  const untracked=join(root,"repo-untracked"),locked=join(root,"repo-locked"),withSubmodule=join(root,"repo-submodule");
  try{
    await committedRepository(library);await committedRepository(repo);
    await git(repo,["-c","protocol.file.allow=always","submodule","add",library,"library"]);await git(repo,["commit","-m","library"]);
    await createWorktree(repo,{branch:"untracked",path:untracked,submodules:"none"});await writeFile(join(untracked,"notes.txt"),"draft\n");
    await createWorktree(repo,{branch:"locked",path:locked,submodules:"none"});await git(repo,["worktree","lock",locked]);
    // The submodule update a worktree-create runs, with the file protocol a local submodule needs.
    await createWorktree(repo,{branch:"submodule",path:withSubmodule,submodules:"none"});await git(withSubmodule,["-c","protocol.file.allow=always","submodule","update","--init","--recursive"]);
    assert.ok(existsSync(join(withSubmodule,"library","README.md")),"the submodule is checked out");
    await assert.rejects(removeWorktree(repo,untracked),/contains modified or untracked files/);
    await assert.rejects(removeWorktree(repo,locked,{force:true}),/cannot remove a locked working tree/);
    await assert.rejects(removeWorktree(repo,withSubmodule),/working trees containing submodules cannot be moved or removed/);
    await assert.rejects(removeWorktree(repo,repo,{force:true}),/is a main working tree/);
    assert.equal(await readFile(join(untracked,"notes.txt"),"utf8"),"draft\n");
    for(const tree of [untracked,locked,withSubmodule,repo])assert.ok(existsSync(join(tree,"README.md")),tree+" is where it was");
    assert.ok(existsSync(join(withSubmodule,"library","README.md")),"its submodule too");
    assert.equal((await listedWorktrees(repo)).length,4,"git lists the repository and its three worktrees still");
    await removeWorktree(repo,untracked,{force:true});await git(repo,["worktree","unlock",locked]);await removeWorktree(repo,locked);await removeWorktree(repo,withSubmodule,{force:true});
    assert.deepEqual(await listedWorktrees(repo),[samePath(repo)]);assert.deepEqual(readdirSync(root).sort(),["library","repo"],"nothing of the worktrees is left");
  }finally{await rm(root,RETRY)}
});

// git's own check before a remove reads the worktree with it as the work tree, and refuses to delete its changes. A git status run in
// the worktree can read another folder, one the worktree's own config names as its core.worktree (extensions.worktreeConfig), and find
// nothing changed there: a remove that went by it deleted the changes.
test("a worktree whose config names another folder as its work tree is not removed while it has changes, and a forced remove removes it",UNDER_LOAD,async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-worktree-remove-configured-")),repo=join(root,"repo"),tree=join(root,"repo-configured");
  try{
    await committedRepository(repo);await git(repo,["config","extensions.worktreeConfig","true"]);await createWorktree(repo,{branch:"configured",path:tree,submodules:"none"});
    await writeFile(join(tree,"README.md"),"changed\n");await writeFile(join(tree,"notes.txt"),"draft\n");await git(tree,["config","--worktree","core.worktree",repo.replace(/\\/g,"/")]);
    await assert.rejects(removeWorktree(repo,tree),/contains modified or untracked files/);
    assert.equal(await readFile(join(tree,"README.md"),"utf8"),"changed\n");assert.equal(await readFile(join(tree,"notes.txt"),"utf8"),"draft\n");
    assert.deepEqual((await listedWorktrees(repo)).slice(1),[samePath(tree)],"git lists the worktree still");
    await removeWorktree(repo,tree,{force:true});
    assert.deepEqual(await listedWorktrees(repo),[samePath(repo)]);assert.deepEqual(readdirSync(root),["repo"],"nothing of the worktree is left");
  }finally{await rm(root,RETRY)}
});

// The turns themselves (worktreeTurn): the adds of one repository go one at a time in the order asked, those of two repositories go at
// once, and an add that fails lets the next one go.
test("worktree adds in one repository take turns, adds in two repositories go at once, and a failed add lets the next go",async()=>{
  const {worktreeTurn}=gitService;assert.equal(typeof worktreeTurn,"function","the adds of a repository have turns to take");
  const log=[],running=new Map();let most=0,mostAtOnce=0;
  const add=(key,name,{held=null,fails=false}={})=>worktreeTurn(key,async()=>{
    running.set(key,(running.get(key)||0)+1);most=Math.max(most,running.get(key));mostAtOnce=Math.max(mostAtOnce,[...running.values()].reduce((a,b)=>a+b,0));log.push("start "+name);
    try{if(held)await held.promise;if(fails)throw new Error(name+" could not be made");return name}
    finally{running.set(key,running.get(key)-1);log.push("end "+name)}
  });
  const a1Held=gate(),b1Held=gate();
  const a1=add("repo-a","a1",{held:a1Held}),a2=add("repo-a","a2",{fails:true}),a3=add("repo-a","a3"),b1=add("repo-b","b1",{held:b1Held}),b2=add("repo-b","b2");
  await settled(()=>log.includes("start a1")&&log.includes("start b1"),"the first add of each repository starts at once");await settled();
  assert.deepEqual(log,["start a1","start b1"],"the next adds of each repository wait for the first");
  b1Held.open();assert.equal(await b1,"b1");assert.equal(await b2,"b2");await settled();
  assert.deepEqual(log.filter(line=>/ a/.test(line)),["start a1"],"repository b's adds do not let repository a's go");
  a1Held.open();assert.equal(await a1,"a1");await assert.rejects(a2,{message:"a2 could not be made"});assert.equal(await a3,"a3");
  assert.deepEqual(log.filter(line=>/ a/.test(line)),["start a1","end a1","start a2","end a2","start a3","end a3"],"repository a's adds in the order asked, one after another");
  assert.deepEqual(log.filter(line=>/ b/.test(line)),["start b1","end b1","start b2","end b2"]);
  assert.equal(most,1,"never two adds of one repository at once");assert.equal(mostAtOnce,2,"the adds of two repositories at once");
});

// A repository's turns are its common git dir's, which its linked worktrees share (a send from a thread in a worktree adds in the same
// repository); another repository has its own. A repository on another host is known by its path there.
test("a repository's linked worktrees and subfolders share its turns, and another repository has its own",UNDER_LOAD,async()=>{
  const {worktreeTurnKey}=gitService;assert.equal(typeof worktreeTurnKey,"function","the adds of a repository have turns to take");
  const root=await mkdtemp(join(tmpdir(),"trebell-worktree-turn-keys-")),repo=join(root,"repo"),other=join(root,"other"),linked=join(root,"repo-linked");
  try{
    await committedRepository(repo);await committedRepository(other);await mkdir(join(repo,"src","deep"),{recursive:true});
    await createWorktree(repo,{branch:"linked",path:linked,submodules:"none"});
    const key=await worktreeTurnKey(repo);
    assert.equal(await worktreeTurnKey(linked),key,"a linked worktree");assert.equal(await worktreeTurnKey(join(repo,"src","deep")),key,"a subfolder");
    if(process.platform==="win32")assert.equal(await worktreeTurnKey(repo.toUpperCase()),key,"the repository spelled in capitals");
    assert.notEqual(await worktreeTurnKey(other),key,"another repository");
    const remote=(stdout,ok=true)=>({gitFn:async()=>({ok,stdout}),remote:true});
    assert.equal(await worktreeTurnKey("/srv/app",remote(".git\n")),"remote:/srv/app/.git");
    assert.equal(await worktreeTurnKey("/srv/app-trebell-model-a",remote("/srv/app/.git\n")),"remote:/srv/app/.git");
    assert.equal(await worktreeTurnKey("/srv/app",remote("",false)),"remote:/srv/app/.git","a git that cannot say");
  }finally{await rm(root,RETRY)}
});

// A remote environment's multi-model send makes its worktrees through source control (worktree-create on the environment's git): they
// take the same turns.
test("a remote environment's worktree adds in one repository take turns too",async()=>{
  const adds=[],held=[];let running=0,most=0;
  const executor={
    run:async(command,args)=>{
      if(command==="git"&&args[0]==="rev-parse"&&args[1]==="--show-toplevel")return {ok:true,code:0,stdout:"/srv/app\n",stderr:""};
      if(command==="git"&&args[0]==="rev-parse"&&args[1]==="--git-common-dir")return {ok:true,code:0,stdout:".git\n",stderr:""};
      if(command==="git"&&args[0]==="branch")return {ok:true,code:0,stdout:"main\n",stderr:""};
      if(command==="git"&&args[0]==="status")return {ok:true,code:0,stdout:"## main\n",stderr:""};
      if(command==="git"&&args[0]==="worktree"&&args[1]==="list")return {ok:true,code:0,stdout:"worktree /srv/app\nHEAD abc\nbranch refs/heads/main\n",stderr:""};
      if(command==="git"&&args[0]==="worktree"&&args[1]==="add"){
        running++;most=Math.max(most,running);adds.push(args[3]);const turn=gate();held.push(turn);
        await turn.promise;running--;return {ok:true,code:0,stdout:"",stderr:""};
      }
      return {ok:true,code:0,stdout:"",stderr:""};
    },
  };
  const models=["model-a","model-b","model-c"];
  const sends=models.map(model=>withSourceControlExecutor(executor,()=>sourceControlGitAction("/srv/app",{action:"worktree-create",name:"trebell/"+model,path:"/srv/app-trebell-"+model,startPoint:"main"})));
  for(let next=1;next<=models.length;next++){
    await settled(()=>adds.length>=next,"add "+next+" starts");await settled();
    assert.equal(adds.length,next,"add "+next+" goes alone, the others waiting their turn");
    held[next-1].open();
  }
  assert.equal((await Promise.all(sends)).length,models.length);
  assert.deepEqual([...adds].sort(),models.map(model=>"trebell/"+model));assert.equal(most,1,"never two adds of one repository at once");
});
