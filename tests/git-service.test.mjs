import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitInfo, commitAll, createBranch, createWorktree, pullRepo, pushRepo, removeWorktree, safeAutoPull, worktreeSubmoduleArgs } from "../src/git-service.mjs";
import { withGermanColoredGit } from "./fixtures/git-catalog.mjs";

// Each test runs up to two dozen git commands, which take seconds each on a host that benchmarks load: the 20 s and 30 s bounds these
// tests had ran out there (on one CPU at idle priority every one did), though alone they pass in 3 to 25 s. The bound is a generous
// one for a stuck test, and git's own 120 s per command (git-service run) still ends a hung command. A folder git has just used can
// be held a moment longer on Windows, so the removal retries for longer too.
const UNDER_LOAD={timeout:300_000};
const RETRY={recursive:true,force:true,maxRetries:30,retryDelay:100};

test("a commit git refuses fails with git's reason, and a commit with nothing to commit says so",UNDER_LOAD,async()=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-commit-"));
  try{
    await git(dir,["init"]);await git(dir,["config","user.email","trebell@example.test"]);await git(dir,["config","user.name","Trebell Test"]);
    // Nothing staged yet, not even a first commit.
    await assert.rejects(()=>commitAll(dir,"Empty start"),{message:"Nothing to commit: the working tree has no changes."});
    await writeFile(join(dir,"a.txt"),"hello\n");await commitAll(dir,"First");
    // A pre-commit hook that refuses: its own words are the reason, and no commit is made.
    await writeFile(join(dir,".git","hooks","pre-commit"),"#!/bin/sh\necho 'the hook refuses this commit' >&2\nexit 1\n");
    await writeFile(join(dir,"a.txt"),"changed\n");
    await assert.rejects(()=>commitAll(dir,"Refused"),{message:"the hook refuses this commit"});
    assert.equal((await git(dir,["log","--format=%s"])).stdout.trim(),"First");
    await rm(join(dir,".git","hooks","pre-commit"));
    const committed=await commitAll(dir,"Accepted");
    assert.equal(committed.status.length,0);assert.equal((await git(dir,["log","-1","--format=%s"])).stdout.trim(),"Accepted");
    await assert.rejects(()=>commitAll(dir,"Nothing here"),{message:"Nothing to commit: the working tree has no changes."});
  }finally{await rm(dir,RETRY)}
});

// git follows a refusal with hint: lines for a person at a terminal (the commands to run next, the setting that turns the hint off).
// The Git panel shows the error after "Could not …", so it is git's reason alone.
// A Pull or a Push git refuses gives its reason only in those hints, and a Pull from a branch with no upstream, or from no branch at
// all, only as commands to type: each of these says it in plain words instead. A refused Push keeps git's other lines after it.
test("a refused branch name, Pull or Push fails with git's reason in plain words, without the hints git adds for a terminal",UNDER_LOAD,async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-git-hints-"));const origin=join(root,"origin.git"),work=join(root,"work"),peer=join(root,"peer");
  try{
    await git(root,["init","--bare","--initial-branch=main",origin]);
    await mkdir(work,{recursive:true});await git(work,["init","-b","main"]);await git(work,["config","user.email","trebell@example.test"]);await git(work,["config","user.name","Trebell Test"]);
    await writeFile(join(work,"shared.txt"),"base\n");await git(work,["add","shared.txt"]);await git(work,["commit","-m","Base"]);await git(work,["remote","add","origin",origin]);await git(work,["push","-u","origin","main"]);
    await git(root,["clone",origin,peer]);await git(peer,["config","user.email","peer@example.test"]);await git(peer,["config","user.name","Peer"]);
    await writeFile(join(peer,"shared.txt"),"base\npeer\n");await git(peer,["commit","-am","Peer"]);await git(peer,["push"]);
    // Committed on both sides, so the branch and origin/main have gone both ways.
    await writeFile(join(work,"shared.txt"),"base\nmine\n");await git(work,["commit","-am","Mine"]);await git(work,["fetch"]);
    await assert.rejects(()=>createBranch(work,"bad..name"),{message:"fatal: 'bad..name' is not a valid branch name"});
    await assert.rejects(()=>pullRepo(work),{message:"This branch and its upstream have diverged, each with commits the other does not have."});
    await assert.rejects(()=>pushRepo(work),error=>{
      assert.match(error.message,/^The remote has commits this branch does not have\. Pull them first, then push again\.\nTo .+\n ! \[rejected\] +\S+ -> main \(non-fast-forward\)\nerror: failed to push some refs to '.+'$/);
      return true;
    });
    // A branch made here has no upstream until it is pushed, and HEAD can be on no branch at all.
    await createBranch(work,"feature/no-upstream");
    await assert.rejects(()=>pullRepo(work),{message:"This branch has no upstream yet. Push it first to create one."});
    await git(work,["switch","--detach","HEAD"]);
    await assert.rejects(()=>pullRepo(work),{message:"Not on a branch: switch to a branch first."});
    await assert.rejects(()=>pushRepo(work),{message:"Not on a branch: switch to a branch first."});
  }finally{await rm(root,RETRY)}
});

// git translates its messages, "hint:" among them, and colors its hints when its config says so: the person's own locale and config
// reach it. gitReason reads git's English, and the panel is in English, so git answers in English whatever the locale says; a hint
// in color is still a hint.
test("a refusal reads the same under a German locale and with hints in color",UNDER_LOAD,async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-git-locale-"));const work=join(root,"work");
  try{
    await mkdir(work,{recursive:true});await git(work,["init","-b","main"]);await git(work,["config","user.email","trebell@example.test"]);await git(work,["config","user.name","Trebell Test"]);
    await writeFile(join(work,"a.txt"),"a\n");await git(work,["add","a.txt"]);await git(work,["commit","-m","Base"]);
    await withGermanColoredGit(join(root,"locale"),async()=>{
      await assert.rejects(()=>createBranch(work,"bad..name"),{message:"fatal: 'bad..name' is not a valid branch name"});
      await assert.rejects(()=>pullRepo(work),{message:"This branch has no upstream yet. Push it first to create one."});
    });
  }finally{await rm(root,RETRY)}
});

// The Git panel's Commit in a merge stopped on a conflict that the person resolved by keeping this branch's side: the index then
// matches HEAD, and the commit still concludes the merge, as git commit does.
test("a commit concludes a merge whose conflicts were resolved by keeping this branch's side",UNDER_LOAD,async()=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-merge-commit-"));
  try{
    await git(dir,["init","--initial-branch=main"]);await git(dir,["config","user.email","trebell@example.test"]);await git(dir,["config","user.name","Trebell Test"]);
    await writeFile(join(dir,"notes.txt"),"base\n");await commitAll(dir,"Base");
    await git(dir,["switch","-c","other"]);await writeFile(join(dir,"notes.txt"),"theirs\n");await commitAll(dir,"Theirs");
    await git(dir,["switch","main"]);await writeFile(join(dir,"notes.txt"),"ours\n");await commitAll(dir,"Ours");
    const merge=await git(dir,["merge","other"],{allowFailure:true});
    assert.equal(merge.ok,false,"the merge stopped on its conflict");
    assert.match((await git(dir,["status","--porcelain"])).stdout,/^UU notes\.txt/m);
    await writeFile(join(dir,"notes.txt"),"ours\n");
    const committed=await commitAll(dir,"Merge other, keeping ours");
    assert.equal(committed.status.length,0);
    assert.equal((await git(dir,["rev-list","--parents","-n","1","HEAD"])).stdout.trim().split(" ").length,3,"HEAD is a merge commit");
    assert.equal((await git(dir,["log","-1","--format=%s"])).stdout.trim(),"Merge other, keeping ours");
    assert.equal((await git(dir,["rev-parse","-q","--verify","MERGE_HEAD"],{allowFailure:true})).ok,false,"the merge is concluded");
    // With the merge concluded, nothing is left to commit, and Commit says so again.
    await assert.rejects(()=>commitAll(dir,"Nothing here"),{message:"Nothing to commit: the working tree has no changes."});
  }finally{await rm(dir,RETRY)}
});

test("Git service reports status and branch operations",UNDER_LOAD,async()=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-git-"));
  try{
    await git(dir,["init"]);
    await git(dir,["config","user.email","trebell@example.test"]);
    await git(dir,["config","user.name","Trebell Test"]);
    await writeFile(join(dir,"a.txt"),"hello");
    await git(dir,["add","a.txt"]);
    await git(dir,["commit","-m","init"]);
    let info=await gitInfo(dir);
    assert.equal(info.isGit,true);
    assert.equal(info.status.length,0);
    await createBranch(dir,"feature-test");
    info=await gitInfo(dir);
    assert.equal(info.branch,"feature-test");
  }finally{await rm(dir,RETRY);}
});

test("worktree submodule policy maps to exact Git commands",()=>{
  assert.deepEqual(worktreeSubmoduleArgs("recursive"),["submodule","update","--init","--recursive"]);
  assert.deepEqual(worktreeSubmoduleArgs("top-level"),["submodule","update","--init"]);
  assert.equal(worktreeSubmoduleArgs("none"),null);
  assert.deepEqual(worktreeSubmoduleArgs("unexpected"),["submodule","update","--init","--recursive"]);
});

test("worktree creation records the selected submodule policy",UNDER_LOAD,async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-worktree-root-"));
  const worktree=root+"-child";
  try{
    await git(root,["init"]);await git(root,["config","user.email","trebell@example.test"]);await git(root,["config","user.name","Trebell Test"]);
    await writeFile(join(root,"file.txt"),"base");await git(root,["add","file.txt"]);await git(root,["commit","-m","base"]);
    const created=await createWorktree(root,{branch:"trebell-test-worktree",path:worktree,submodules:"none"});
    assert.equal(created.worktree,worktree);assert.equal(created.submodules,"none");assert.equal((await gitInfo(worktree)).branch,"trebell-test-worktree");
  }finally{await rm(worktree,RETRY).catch(()=>{});await rm(root,RETRY)}
});

test("non-forced worktree removal preserves dirty delegated work for inspection",UNDER_LOAD,async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-dirty-worktree-root-")),worktree=root+"-child";
  try{
    await git(root,["init"]);await git(root,["config","user.email","trebell@example.test"]);await git(root,["config","user.name","Trebell Test"]);
    await writeFile(join(root,"file.txt"),"base\n");await git(root,["add","file.txt"]);await git(root,["commit","-m","base"]);
    await createWorktree(root,{branch:"trebell-dirty-worktree",path:worktree,submodules:"none"});
    await writeFile(join(worktree,"file.txt"),"setup changed this before failing\n");
    await assert.rejects(()=>removeWorktree(root,worktree),/modified|changes|force/i);
    assert.equal(await readFile(join(worktree,"file.txt"),"utf8"),"setup changed this before failing\n");
    await removeWorktree(root,worktree,{force:true});
  }finally{await rm(worktree,RETRY).catch(()=>{});await rm(root,RETRY)}
});

test("safe auto-pull updates only a clean default branch with no local commits",UNDER_LOAD,async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-autopull-"));const origin=join(root,"origin.git"),seed=join(root,"seed"),checkout=join(root,"checkout");
  try{
    await mkdir(seed,{recursive:true});
    await git(root,["init","--bare","--initial-branch=main",origin]);
    await git(seed,["init","-b","main"]);await git(seed,["config","user.email","trebell@example.test"]);await git(seed,["config","user.name","Trebell Test"]);
    await writeFile(join(seed,"value.txt"),"one\n");await git(seed,["add","value.txt"]);await git(seed,["commit","-m","one"]);await git(seed,["remote","add","origin",origin]);await git(seed,["push","-u","origin","main"]);
    await git(root,["clone",origin,checkout]);await git(checkout,["config","user.email","trebell@example.test"]);await git(checkout,["config","user.name","Trebell Test"]);
    await writeFile(join(seed,"value.txt"),"two\n");await git(seed,["add","value.txt"]);await git(seed,["commit","-m","two"]);await git(seed,["push"]);
    const pulled=await safeAutoPull(checkout);assert.equal(pulled.ok,true);assert.equal(pulled.changed,true);assert.equal(pulled.defaultBranch,"main");assert.equal(await readFile(join(checkout,"value.txt"),"utf8"),"two\n");
    await git(checkout,["switch","-c","feature"]);await git(checkout,["branch","--set-upstream-to=origin/main","feature"]);
    const feature=await safeAutoPull(checkout);assert.equal(feature.ok,false);assert.equal(feature.reason,"not_default_branch");
    await git(checkout,["switch","main"]);await writeFile(join(checkout,"local.txt"),"local\n");await git(checkout,["add","local.txt"]);await git(checkout,["commit","-m","local"]);
    const ahead=await safeAutoPull(checkout);assert.equal(ahead.ok,false);assert.equal(ahead.reason,"local_commits");assert.equal(ahead.ahead,1);
  }finally{await rm(root,RETRY)}
});

// A cold gitInfo reads the repository part from the git dir's files. Each test below builds a repository the way a person or a tool
// leaves one and compares that part with git's own answers, asked the way gitInfo asked before (one command per field); the remote
// lines are read whole, so a URL with a space or a partial clone's filter is a remote, not a raw line.
async function gitsOwnAnswer(dir,opts={}){
  const ask=args=>git(dir,args,{allowFailure:true,...opts});
  const branch=(await ask(["branch","--show-current"])).stdout.trim()||null,upstream=await ask(["rev-parse","--abbrev-ref","--symbolic-full-name","@{u}"]);
  const branches=(await ask(["for-each-ref","--format=%(refname:short)","refs/heads"])).stdout.split(/\r?\n/).filter(Boolean);
  const remotes=(await ask(["remote","-v"])).stdout.split(/\r?\n/).filter(Boolean).map(line=>{const m=line.match(/^(\S+)\t(.*) \((fetch|push)\)(?: \[[^\]]*\])?$/);return m?{name:m[1],url:m[2],kind:m[3]}:{raw:line}});
  const worktrees=[];let current=null;
  for(const line of (await ask(["worktree","list","--porcelain"])).stdout.split(/\r?\n/)){if(line.startsWith("worktree ")){if(current)worktrees.push(current);current={path:line.slice(9)}}else if(current&&line.startsWith("HEAD "))current.head=line.slice(5);else if(current&&line.startsWith("branch "))current.branch=line.slice(7).replace(/^refs\/heads\//,"");else if(current&&line==="bare")current.bare=true}
  if(current)worktrees.push(current);
  return {branch,upstream:upstream.ok?upstream.stdout.trim():null,branches,remotes,worktrees};
}
const repositoryPart=({branch,upstream,branches,remotes,worktrees})=>({branch,upstream,branches,remotes,worktrees});
const sameAsGit=async(dir,label,opts={})=>assert.deepEqual(repositoryPart(await gitInfo(dir,{fresh:true,...opts})),await gitsOwnAnswer(dir,opts),label);
const gitCommands=async(dir,opts={})=>{const calls=[];await gitInfo(dir,{fresh:true,...opts,gitFn:(cwd,args,options)=>{calls.push(args[0]);return git(cwd,args,options)}});return calls};
async function committedRepository(dir,{branch="main",init=[]}={}){
  await mkdir(dir,{recursive:true});await git(dir,["init","-q","-b",branch,...init]);
  await git(dir,["config","user.email","trebell@example.test"]);await git(dir,["config","user.name","Trebell Test"]);
  await writeFile(join(dir,"a.txt"),"a\n");await git(dir,["add","a.txt"]);await git(dir,["commit","-qm","a"]);
}

// The Git panel finds the folder's own worktree by its root (a detached one shows its commit), so paths are git's, forward slashes
// on Windows, in git's order. A bare repository's own folder comes first and only as bare; a separate git dir is listed where git
// lists it; a relative gitdir is git's to resolve.
test("gitInfo lists worktrees as git worktree list does: paths, order, unborn and detached heads, bare and separate git dirs",UNDER_LOAD,async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-worktrees-")),main=join(root,"main");
  try{
    await mkdir(main);await git(main,["init","-q","-b","main"]);
    assert.equal((await gitInfo(main,{fresh:true})).worktrees[0].head,"0".repeat(40),"an unborn branch has git's all-zeros commit");await sameAsGit(main,"unborn");
    await git(main,["config","user.email","trebell@example.test"]);await git(main,["config","user.name","Trebell Test"]);
    await writeFile(join(main,"a.txt"),"a\n");await git(main,["add","a.txt"]);await git(main,["commit","-qm","a"]);
    // The admin folders (named after each folder) sort the other way round from the paths.
    await git(main,["worktree","add","-q","-b","late",join(root,"aaa","zzz-wt")]);await git(main,["worktree","add","-q","-b","early",join(root,"zzz","aaa-wt")]);
    const detached=join(root,"detached");await git(main,["worktree","add","-q","--detach",detached]);
    // Git for Windows sorts a directory separator before any other character (w/x, "w b", w-c, W_d), and folds case under ignoreCase.
    for(const name of ["w b","w-c",join("w","x"),"W_d"])await git(main,["worktree","add","-q","--detach",join(root,name)]);
    assert.deepEqual(await gitCommands(main),["rev-parse","status"]);
    await git(main,["config","core.ignoreCase",process.platform==="win32"?"false":"true"]);await sameAsGit(main,"core.ignoreCase the other way");
    await git(main,["config","core.ignoreCase",process.platform==="win32"?"true":"false"]);
    await sameAsGit(main,"main checkout");await sameAsGit(detached,"detached linked worktree");
    const info=await gitInfo(detached,{fresh:true});
    assert.equal(info.worktrees.find(item=>item.path===info.root)?.head,(await git(detached,["rev-parse","HEAD"])).stdout.trim(),"the detached worktree finds itself by its root");
    if(process.platform==="win32")await sameAsGit(main.toLowerCase(),"the main checkout asked about in another letter case");
    if((await git(main,["worktree","add","-q","--relative-paths","-b","relative",join(root,"relative")],{allowFailure:true})).ok)await sameAsGit(main,"a worktree with a relative gitdir");
    const bare=join(root,"bare.git"),bareLinked=join(root,"bare-wt");
    await git(root,["clone","-q","--bare",main,bare]);await git(bare,["worktree","add","-q",bareLinked,"late"]);await sameAsGit(bareLinked,"a bare repository's linked worktree");
    const separate=join(root,"separate"),separateLinked=join(root,"separate-wt");
    await committedRepository(separate,{init:["--separate-git-dir",join(root,"separate.git")]});await git(separate,["worktree","add","-q","-b","side",separateLinked]);
    await sameAsGit(separate,"a separate git dir");await sameAsGit(separateLinked,"a separate git dir's linked worktree");
  }finally{await rm(root,RETRY)}
});

// Push sets the upstream and auto-pull fetches only where git has one: none once the remote-tracking ref is gone (Fetch prunes a
// merged pull request's branch) or where no fetch refspec maps the merge ref, the first of two merge values, and a reftable
// repository's too.
test("gitInfo's upstream is git's @{upstream}",UNDER_LOAD,async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-upstream-")),origin=join(root,"origin.git"),clone=join(root,"clone");
  try{
    await git(root,["init","-q","--bare","-b","main",origin]);await committedRepository(clone);
    await git(clone,["remote","add","origin",origin]);await git(clone,["push","-q","-u","origin","main"]);await sameAsGit(clone,"main tracks origin/main");
    await git(clone,["switch","-q","-c","feature"]);await git(clone,["push","-q","-u","origin","feature"]);
    assert.equal((await gitInfo(clone,{fresh:true})).upstream,"origin/feature");
    await git(origin,["branch","-D","feature"]);await git(clone,["fetch","-q","--prune"]);
    assert.equal((await gitInfo(clone,{fresh:true})).upstream,null,"the tracking ref is gone");await sameAsGit(clone,"the tracking ref is gone");
    await git(clone,["remote","add","narrow",origin]);await git(clone,["config","remote.narrow.fetch","+refs/heads/main:refs/remotes/narrow/main"]);await git(clone,["fetch","-q","narrow"]);
    const tracking=async(name,remote,...merges)=>{
      await git(clone,["switch","-q","-c",name,"main"]);await git(clone,["config","branch."+name+".remote",remote]);
      for(const merge of merges)await git(clone,["config","--add","branch."+name+".merge",merge]);
      await sameAsGit(clone,name);
    };
    // An unmapped merge ref has no upstream even where a tracking ref of that name exists, and a refspec into another namespace
    // names the ref it maps to.
    await git(clone,["update-ref","refs/remotes/narrow/feat","main"]);
    await git(clone,["remote","add","renamed",origin]);await git(clone,["config","remote.renamed.fetch","+refs/heads/*:refs/remotes/elsewhere/*"]);await git(clone,["fetch","-q","renamed"]);
    await tracking("narrow-main","narrow","refs/heads/main");await tracking("narrow-topic","narrow","refs/heads/feat");await tracking("renamed-main","renamed","refs/heads/main");
    assert.equal((await gitInfo(clone,{fresh:true})).upstream,"elsewhere/main");
    await tracking("url-remote","https://example.invalid/r.git","refs/heads/main");await tracking("unknown-remote","nosuch","refs/heads/main");
    await tracking("two-merges","origin","refs/heads/main","refs/heads/feature");await tracking("gone","origin","refs/heads/feature");
    await tracking("local",".","refs/heads/main");
    // A local branch named like the tracking ref makes git spell the upstream remotes/origin/main. git for-each-ref calls that branch
    // heads/origin/main; the branch list keeps origin/main, the name git switch takes.
    await git(clone,["branch","origin/main","main"]);await git(clone,["switch","-q","main"]);
    const ambiguous=await gitInfo(clone,{fresh:true});assert.equal(ambiguous.upstream,"remotes/origin/main");assert.equal(ambiguous.upstream,(await gitsOwnAnswer(clone)).upstream);
    assert.ok(ambiguous.branches.includes("origin/main"));
    const table=join(root,"table");
    if((await git(root,["init","-q","--ref-format=reftable","-b","main",table],{allowFailure:true})).ok){
      await git(table,["config","user.email","trebell@example.test"]);await git(table,["config","user.name","Trebell Test"]);
      await writeFile(join(table,"t.txt"),"t\n");await git(table,["add","t.txt"]);await git(table,["commit","-qm","t"]);
      await git(table,["remote","add","origin",origin]);await git(table,["push","-q","-u","origin","main:table-main"]);
      assert.equal((await gitInfo(table,{fresh:true})).upstream,"origin/table-main");await sameAsGit(table,"a reftable repository");
    }
  }finally{await rm(root,RETRY)}
});

// The branch picker lists what git for-each-ref lists: not a lock file (git holds refs/heads/<name>.lock while it writes a ref) nor
// a file that is no ref (empty, garbage, a bad name, desktop.ini), loose refs over packed ones, in git's byte order.
test("gitInfo's branches are git for-each-ref's",UNDER_LOAD,async()=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-branches-"));
  try{
    await committedRepository(dir);
    for(const name of ["packed/deep","alpha","Zeta","u-\u{1F680}","u-\uFF01"])await git(dir,["branch",name]);
    await git(dir,["pack-refs","--all"]);await git(dir,["branch","-D","alpha"]);await git(dir,["branch","loose"]);
    const head=(await git(dir,["rev-parse","HEAD"])).stdout.trim(),heads=join(dir,".git","refs","heads");
    for(const [name,text] of [["main.lock",head+"\n"],["empty-ref",""],["garbage","not a ref\n"],["desktop.ini","[.ShellClassInfo]\n"],["main~",head+"\n"],["zeros","0".repeat(40)+"\n"]])await writeFile(join(heads,name),text);
    await sameAsGit(dir,"branches");assert.deepEqual(await gitCommands(dir),["rev-parse","status"]);
    // A loose ref hides its packed line: main's new commit (packed main still names the old one), and a broken loose file over a
    // packed branch.
    await rm(join(heads,"main.lock"));await writeFile(join(dir,"b.txt"),"b\n");await git(dir,["add","b.txt"]);await git(dir,["commit","-qm","b"]);await writeFile(join(heads,"Zeta"),"not a ref\n");
    const info=await gitInfo(dir,{fresh:true});assert.equal(info.worktrees[0].head,(await git(dir,["rev-parse","HEAD"])).stdout.trim());assert.ok(!info.branches.includes("Zeta"));
    await sameAsGit(dir,"loose refs over packed ones");
  }finally{await rm(dir,RETRY)}
});

// A branch alias (git symbolic-ref refs/heads/master refs/heads/main) checked out is main to git: its upstream, its worktree entry,
// and Push's -u (set only without an upstream). An alias of a remote-tracking ref is no branch.
test("gitInfo follows a branch alias to the branch git names",UNDER_LOAD,async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-alias-")),origin=join(root,"origin.git"),clone=join(root,"clone");
  try{
    await git(root,["init","-q","--bare","-b","main",origin]);await committedRepository(clone);
    await git(clone,["remote","add","origin",origin]);await git(clone,["push","-q","-u","origin","main"]);
    await git(clone,["symbolic-ref","refs/heads/master","refs/heads/main"]);await git(clone,["checkout","-q","master"]);
    const info=await gitInfo(clone,{fresh:true});assert.equal(info.branch,"main");assert.equal(info.upstream,"origin/main");assert.equal(info.worktrees[0].branch,"main");
    await sameAsGit(clone,"HEAD on an alias of main");
    const linked=join(root,"linked");await git(clone,["worktree","add","-q","-b","side",linked]);await git(linked,["symbolic-ref","HEAD","refs/heads/master"]);
    await sameAsGit(linked,"a linked worktree on the alias");await sameAsGit(clone,"the main checkout lists it");
    await git(clone,["symbolic-ref","refs/heads/tracking","refs/remotes/origin/main"]);await git(clone,["symbolic-ref","HEAD","refs/heads/tracking"]);
    assert.equal((await gitInfo(clone,{fresh:true})).branch,null);await sameAsGit(clone,"HEAD on an alias of a remote-tracking ref");
  }finally{await rm(root,RETRY)}
});

// A big packed-refs is mostly tags, so the cold read keeps only its branch and remote-tracking lines; the upstream's spelling still
// sees a packed tag of the same name.
test("gitInfo reads a packed-refs file of many tags as git does",UNDER_LOAD,async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-packed-")),origin=join(root,"origin.git"),clone=join(root,"clone");
  try{
    await git(root,["init","-q","--bare","-b","main",origin]);await committedRepository(clone);
    await git(clone,["remote","add","origin",origin]);await git(clone,["push","-q","-u","origin","main"]);await git(clone,["branch","topic"]);
    await git(clone,["pack-refs","--all"]);
    const head=(await git(clone,["rev-parse","HEAD"])).stdout.trim(),packed=join(clone,".git","packed-refs");
    await appendFile(packed,Array.from({length:5000},(_,i)=>`${head} refs/tags/t${String(i).padStart(5,"0")}\n`).join(""));
    await sameAsGit(clone,"5,000 packed tags");assert.deepEqual(await gitCommands(clone),["rev-parse","status"]);
    await git(clone,["tag","origin/main"]);await git(clone,["pack-refs","--all"]);
    assert.equal((await gitInfo(clone,{fresh:true})).upstream,"remotes/origin/main");await sameAsGit(clone,"a packed tag named like the upstream");
  }finally{await rm(root,RETRY)}
});

// With no HOME (a server not started from Git Bash), Git for Windows reads the global config from HOMEDRIVE plus HOMEPATH while that
// folder exists, so a URL rule there is git's to apply.
test("gitInfo finds the global config where Git for Windows looks without HOME",{...UNDER_LOAD,skip:process.platform!=="win32"},async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-home-")),home=join(root,"share"),dir=join(root,"repo");
  try{
    await mkdir(home);await writeFile(join(home,".gitconfig"),'[url "https://share.example.invalid/"]\n\tinsteadOf = hshare:\n');
    await committedRepository(dir);await git(dir,["remote","add","origin","hshare:owner/repo.git"]);
    const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^(HOME|GIT_CONFIG_GLOBAL|XDG_CONFIG_HOME)$/i.test(name)));
    Object.assign(env,{HOMEDRIVE:home.slice(0,2),HOMEPATH:home.slice(2)});
    assert.equal((await gitInfo(dir,{fresh:true,env})).remotes[0].url,"https://share.example.invalid/owner/repo.git");await sameAsGit(dir,"HOMEDRIVE and HOMEPATH",{env});
  }finally{await rm(root,RETRY)}
});

// The Projects page groups and heads projects by the first fetch URL. git's value syntax applies to every value (git clone of a
// Windows path writes its backslashes escaped); config.worktree counts only with extensions.worktreeConfig; URL rewriting and
// config this strict reading does not take are git's to answer.
test("gitInfo's remotes are git remote -v's",UNDER_LOAD,async()=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-remotes-")),config=join(dir,".git","config");
  try{
    await committedRepository(dir);
    await git(dir,["remote","add","win","H:\\temp\\nospace\\x.git"]);await git(dir,["remote","add","spaced","H:/Some Folder/repo.git"]);
    await git(dir,["config","remote.two.url","https://example.invalid/one.git"]);await git(dir,["config","--add","remote.two.url","https://example.invalid/two.git"]);
    await git(dir,["config","remote.pushed.url","https://example.invalid/fetch.git"]);await git(dir,["config","remote.pushed.pushurl","https://example.invalid/push.git"]);
    await git(dir,["config","remote.nourl.fetch","+refs/heads/*:refs/remotes/nourl/*"]);
    await appendFile(config,'[remote "hash"]\n\turl = https://example.invalid/c#d.git\n\tpushurl = "https://example.invalid/a #b" ; a comment\n');
    await sameAsGit(dir,"remotes read from the files");assert.deepEqual(await gitCommands(dir),["rev-parse","status"]);
    await writeFile(join(dir,".git","config.worktree"),'[remote "wtonly"]\n\turl = https://example.invalid/wt.git\n');await sameAsGit(dir,"config.worktree without the extension");
    await git(dir,["config","extensions.worktreeConfig","true"]);await sameAsGit(dir,"config.worktree with the extension");
    await git(dir,["config","url.https://rewritten.example.invalid/.insteadOf","short:"]);await git(dir,["remote","add","rewritten","short:owner/repo.git"]);await sameAsGit(dir,"insteadOf");
    await git(dir,["config","--remove-section","url.https://rewritten.example.invalid/"]);
    const global=join(dir,"global.gitconfig");await writeFile(global,'[url "https://global.example.invalid/"]\n\tinsteadOf = gshort:\n');await git(dir,["remote","add","global","gshort:owner/repo.git"]);
    await sameAsGit(dir,"insteadOf in the global config",{env:{...process.env,GIT_CONFIG_GLOBAL:global}});
    await appendFile(config,'[remote "inline"] url = https://example.invalid/inline.git\n[remote.legacy]\n\turl = https://example.invalid/legacy.git\n');await sameAsGit(dir,"a key on a header line and a legacy header");
  }finally{await rm(dir,RETRY)}
});
