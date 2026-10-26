import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as gitService from "../src/git-service.mjs";
import { sourceControlGitAction, withSourceControlExecutor } from "../src/source-control-service.mjs";

const { createWorktree, git } = gitService;
// git commands take seconds each on a host that benchmarks load (git-service.test.mjs), so the bound is a generous one for a stuck test.
const UNDER_LOAD={timeout:300_000};
const RETRY={recursive:true,force:true,maxRetries:30,retryDelay:100};
const samePath=path=>{const value=resolve(path);return process.platform==="win32"?value.toLowerCase():value};
const gate=()=>{let open=()=>{};const promise=new Promise(resolve=>{open=resolve});return {promise,open}};
// Lets every chain of promises that can go on do so (in-memory work only: no timers, no I/O), until check holds when one is given.
async function settled(check=null,message=""){for(let i=0;i<50&&!check?.();i++)await new Promise(resolve=>setImmediate(resolve));if(check)assert.ok(check(),message)}
async function committedRepository(repo){
  await mkdir(repo,{recursive:true});await git(repo,["init"]);await git(repo,["config","user.email","trebell@example.test"]);await git(repo,["config","user.name","Trebell Test"]);
  await writeFile(join(repo,"README.md"),"seed\n");await git(repo,["add","README.md"]);await git(repo,["commit","-m","seed"]);
}
const listedWorktrees=async repo=>(await git(repo,["worktree","list","--porcelain"])).stdout.split(/\r?\n/).filter(line=>line.startsWith("worktree ")).map(line=>samePath(line.slice(9)));

// A multi-model send makes each model's worktree at once in one repository (the server's worktree-create, createWorktree, with the
// default submodule update). git worktree add is not safe at once there: an add that read the admin folder of another still being
// written failed with "failed to read .git/worktrees/<the other>/commondir", and that model never started. Before the turns, rounds
// of 24 adds at once failed so in every run of this test (rounds of 16 in half of them); the race is one of timing, so a run without
// a failure proves nothing.
test("worktrees made at once in one repository, as a multi-model send makes them, are all made and git lists every one",UNDER_LOAD,async()=>{
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
