import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as gitService from "../src/git-service.mjs";

const { createWorktree, git, removeWorktree } = gitService;
// git commands take seconds each on a host that benchmarks load (git-service.test.mjs), so the bound is a generous one for a stuck test.
const UNDER_LOAD={timeout:300_000};
const RETRY={recursive:true,force:true,maxRetries:30,retryDelay:100};
const samePath=path=>{const value=resolve(path);return process.platform==="win32"?value.toLowerCase():value};
const listedWorktrees=async repo=>(await git(repo,["worktree","list","--porcelain"])).stdout.split(/\r?\n/).filter(line=>line.startsWith("worktree ")).map(line=>samePath(line.slice(9)));
// What a link is on Windows, by the reparse tag fsutil reads: Node's lstat calls a junction and a symbolic link alike a link.
const linkKind=path=>{const tag=/0x([0-9a-f]{8})/i.exec(execFileSync("fsutil",["reparsepoint","query",path],{encoding:"utf8",windowsHide:true}))?.[1]?.toLowerCase();return tag==="a0000003"?"junction":tag==="a000000c"?"symbolic link":tag};

// A repository whose node_modules/ is ignored, a worktree of it, and a folder outside both that holds keep.txt, all in a folder the
// test makes under the OS temp folder: every link a test makes is in that folder and points only into it.
async function fixture(name){
  const root=await mkdtemp(join(tmpdir(),`trebell-remove-links-${name}-`)),repo=join(root,"repo"),tree=join(root,"repo-tree"),outside=join(root,"outside");
  await mkdir(repo,{recursive:true});await git(repo,["init"]);await git(repo,["config","user.email","trebell@example.test"]);await git(repo,["config","user.name","Trebell Test"]);
  await writeFile(join(repo,".gitignore"),"node_modules/\n");await writeFile(join(repo,"README.md"),"seed\n");await git(repo,["add","."]);await git(repo,["commit","-m","seed"]);
  await createWorktree(repo,{branch:"tree",path:tree,submodules:"none"});await mkdir(outside);await writeFile(join(outside,"keep.txt"),"keep\n");
  return {root,repo,tree,outside,shared:join(tree,"node_modules","shared")};
}
const linkShared=async f=>{await mkdir(join(f.tree,"node_modules"),{recursive:true});await symlink(f.outside,f.shared,"junction")};
// A directory or file symbolic link needs developer mode (or an administrator) on Windows; a junction does not.
async function canSymlink(root){const probe=join(root,"symlink-probe");try{await symlink(root,probe,"dir")}catch(error){if(error?.code==="EPERM")return false;throw error}await unlink(probe);return true}
function assertOutsideWhole(f){assert.deepEqual(readdirSync(f.outside),["keep.txt"],"the folder outside the worktree holds what it held");assert.equal(readFileSync(join(f.outside,"keep.txt"),"utf8"),"keep\n","keep.txt is still there")}
function assertJunctionInPlace(f){
  assert.equal(lstatSync(f.shared).isSymbolicLink(),true,"the junction is still in the worktree");assert.equal(samePath(readlinkSync(f.shared)),samePath(f.outside),"pointing where it did");
  if(process.platform==="win32")assert.equal(linkKind(f.shared),"junction","a junction still");
  assert.equal(readFileSync(join(f.shared,"keep.txt"),"utf8"),"keep\n","its target whole");assertOutsideWhole(f);
}

// git for Windows deletes a worktree it removes by walking its folders, and it takes a junction (what mklink /J, npm link and pnpm make
// for a folder) for a folder: it went into one and deleted what its target held, here a folder outside the worktree, forced or not
// (node_modules/ is ignored, so nothing stops a remove). A junction whose target was gone, or that its walk reached after deleting its
// target in the same tree, made git fail ("Directory not empty") once it had deleted the rest and the worktree's admin entry. A
// symbolic link it deletes as a link, so those two cases held before too.
const LINKS=[
  {name:"a junction in its ignored node_modules to a folder outside it",make:linkShared},
  {name:"a junction nested deeper",make:async f=>{const lib=join(f.tree,"node_modules","@scope","pkg","lib");await mkdir(lib,{recursive:true});await symlink(f.outside,join(lib,"linked"),"junction")}},
  {name:"a junction to a folder in the same worktree that git's walk reaches after it",make:async f=>{const real=join(f.tree,"node_modules","real");await mkdir(real,{recursive:true});await writeFile(join(real,"inner.txt"),"inner\n");await symlink(real,join(f.tree,"node_modules","zlink"),"junction")}},
  {name:"a dangling junction",make:async f=>{await mkdir(join(f.tree,"node_modules"));await symlink(join(f.root,"missing"),join(f.tree,"node_modules","gone"),"junction")}},
  {name:"a file symbolic link",symbolic:true,make:async f=>{await mkdir(join(f.tree,"node_modules"));await symlink(join(f.outside,"keep.txt"),join(f.tree,"node_modules","keep.txt"),"file")}},
  {name:"a directory symbolic link",symbolic:true,make:async f=>{await mkdir(join(f.tree,"node_modules"));await symlink(f.outside,f.shared,"dir")}},
  {name:"a relative directory symbolic link",symbolic:true,make:async f=>{await mkdir(join(f.tree,"node_modules"));await symlink(join("..","..","outside"),f.shared,"dir")}},
];
for(const link of LINKS)for(const force of [false,true])test(`removing a worktree that holds ${link.name}${force?", forced,":""} removes the worktree and its admin entry and leaves the folder outside it as it was`,UNDER_LOAD,async t=>{
  const f=await fixture("case");
  try{
    if(link.symbolic&&!await canSymlink(f.root))return t.skip("this machine refuses to make symbolic links (EPERM: Windows without developer mode)");
    await link.make(f);await removeWorktree(f.repo,f.tree,{force});
    assert.equal(existsSync(f.tree),false,"the worktree is gone");assert.equal(existsSync(join(f.repo,".git","worktrees","repo-tree")),false,"its admin entry is gone");
    assert.deepEqual(await listedWorktrees(f.repo),[samePath(f.repo)],"git lists the repository alone");assertOutsideWhole(f);
  }finally{await rm(f.root,RETRY)}
});

// A remove git cannot finish, a file in the worktree held open by another program (Windows refuses to delete it), still went through
// the junction first: the folder outside was empty by the time git gave up. Now the junction is out before git starts, and stays out of
// what git leaves (git has deleted the worktree's admin entry by then, so what is left is no worktree).
test("a remove git cannot finish, a file in the worktree held open, leaves the folder a junction in it points to as it was",UNDER_LOAD,async t=>{
  if(process.platform!=="win32")return t.skip("a file held open stops a delete only on Windows");
  const f=await fixture("held");let holder=null;
  try{
    await linkShared(f);await mkdir(join(f.tree,"src"));const held=join(f.tree,"src","open.txt");await writeFile(held,"open\n");
    holder=spawn("powershell.exe",["-NoProfile","-NonInteractive","-Command",`$f=[System.IO.File]::Open('${held}','Open','ReadWrite','Read'); Write-Output 'held'; Start-Sleep -Seconds 120`],{windowsHide:true,stdio:["ignore","pipe","ignore"]});
    await new Promise((resolve,reject)=>{let text="";holder.stdout.on("data",chunk=>{text+=chunk;if(text.includes("held"))resolve()});holder.once("exit",()=>reject(new Error("the file could not be held open")))});
    await assert.rejects(removeWorktree(f.repo,f.tree,{force:true}),/failed to delete/);
    assertOutsideWhole(f);assert.equal(existsSync(f.shared),false,"the junction is not put back into what git left");
  }finally{holder?.kill();await new Promise(resolve=>setTimeout(resolve,500));await rm(f.root,RETRY)}
});

// A remove git refuses before it deletes anything is refused here with git's own words, and nothing in the worktree changes: its
// junction stays, pointing where it did, its target whole. git checks a lock first (forced or not: Trebell never forces twice), then,
// unless forced, a submodule checked out and the changes git status shows.
test("a remove of a worktree with an untracked file and a junction is refused with git's message, the junction left as it was",UNDER_LOAD,async()=>{
  const f=await fixture("untracked");
  try{
    await linkShared(f);await writeFile(join(f.tree,"notes.txt"),"draft\n");
    await assert.rejects(removeWorktree(f.repo,f.tree),{message:`fatal: '${f.tree}' contains modified or untracked files, use --force to delete it`});
    assertJunctionInPlace(f);assert.equal(readFileSync(join(f.tree,"notes.txt"),"utf8"),"draft\n");assert.deepEqual((await listedWorktrees(f.repo)).slice(1),[samePath(f.tree)],"git lists the worktree still");
    await removeWorktree(f.repo,f.tree,{force:true});assert.equal(existsSync(f.tree),false,"forced, it goes");assertOutsideWhole(f);
  }finally{await rm(f.root,RETRY)}
});
// git's check reads the tree with its links in it: a junction outside node_modules shows what it points to as untracked files.
test("a remove of a worktree whose one change is a junction git status reads as untracked is refused with git's message unless forced",UNDER_LOAD,async()=>{
  const f=await fixture("untracked-link");
  try{
    f.shared=join(f.tree,"shared");await symlink(f.outside,f.shared,"junction");
    await assert.rejects(removeWorktree(f.repo,f.tree),{message:`fatal: '${f.tree}' contains modified or untracked files, use --force to delete it`});
    assertJunctionInPlace(f);assert.deepEqual((await listedWorktrees(f.repo)).slice(1),[samePath(f.tree)],"git lists the worktree still");
    await removeWorktree(f.repo,f.tree,{force:true});assert.equal(existsSync(f.tree),false,"forced, it goes");assertOutsideWhole(f);
  }finally{await rm(f.root,RETRY)}
});
test("a remove of a locked worktree with a junction is refused with git's message, forced or not, the junction left as it was",UNDER_LOAD,async()=>{
  const f=await fixture("locked");
  try{
    await linkShared(f);await git(f.repo,["worktree","lock","--reason","on a stick",f.tree]);
    for(const force of [false,true])await assert.rejects(removeWorktree(f.repo,f.tree,{force}),{message:"fatal: cannot remove a locked working tree, lock reason: on a stick\nuse 'remove -f -f' to override or unlock first"});
    await git(f.repo,["worktree","unlock",f.tree]);await git(f.repo,["worktree","lock",f.tree]);
    await assert.rejects(removeWorktree(f.repo,f.tree,{force:true}),{message:"fatal: cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first"});
    assertJunctionInPlace(f);assert.deepEqual((await listedWorktrees(f.repo)).slice(1),[samePath(f.tree)],"git lists the worktree still");
    await git(f.repo,["worktree","unlock",f.tree]);await removeWorktree(f.repo,f.tree);assert.equal(existsSync(f.tree),false,"unlocked, it goes");assertOutsideWhole(f);
  }finally{await rm(f.root,RETRY)}
});
// git refuses a worktree whose submodule is checked out: one updated in it (its git dir in the worktree's admin folder, modules/) and
// one cloned into it by hand (its own .git folder), which only the worktree's index names.
for(const kind of ["updated","cloned"])test(`a remove of a worktree with a junction and a submodule ${kind} in it is refused with git's message unless forced`,UNDER_LOAD,async()=>{
  const f=await fixture("submodule-"+kind),library=join(f.root,"library");
  try{
    await mkdir(library);await git(library,["init"]);await git(library,["config","user.email","trebell@example.test"]);await git(library,["config","user.name","Trebell Test"]);
    await writeFile(join(library,"lib.txt"),"lib\n");await git(library,["add","."]);await git(library,["commit","-m","library"]);
    await git(f.repo,["-c","protocol.file.allow=always","submodule","add",library,"library"]);await git(f.repo,["commit","-m","library"]);
    await git(f.tree,["merge","--ff-only",(await git(f.repo,["branch","--show-current"])).stdout.trim()]);
    if(kind==="updated")await git(f.tree,["-c","protocol.file.allow=always","submodule","update","--init"]);else await git(f.root,["clone",library,join(f.tree,"library")]);
    await linkShared(f);assert.ok(existsSync(join(f.tree,"library","lib.txt")),"the submodule is checked out");
    await assert.rejects(removeWorktree(f.repo,f.tree),{message:"fatal: working trees containing submodules cannot be moved or removed"});
    assertJunctionInPlace(f);assert.ok(existsSync(join(f.tree,"library","lib.txt")),"its submodule too");
    await removeWorktree(f.repo,f.tree,{force:true});assert.equal(existsSync(f.tree),false,"forced, it goes");assertOutsideWhole(f);
  }finally{await rm(f.root,RETRY)}
});

// The junctions are taken out only once git's checks have passed, and git refuses a remove after that only if the worktree changed in
// between (here a lock taken meanwhile): its junctions go back as they were, the same target, a junction still.
test("a remove git refuses once the junctions are out puts them back as they were",UNDER_LOAD,async()=>{
  const {removeWorktreeKeepingLinks}=gitService;assert.equal(typeof removeWorktreeKeepingLinks,"function","a remove that takes the links out first");
  const f=await fixture("put-back");
  try{
    await linkShared(f);const nested=join(f.tree,"node_modules","@scope","linked");await mkdir(join(f.tree,"node_modules","@scope"));await symlink(f.outside,nested,"junction");
    const gitFn=async(cwd,args,options)=>{if(args[0]==="worktree"&&args[1]==="remove"){assert.equal(existsSync(f.shared),false,"the junction is out while git removes");await git(f.repo,["worktree","lock","--reason","taken meanwhile",f.tree])}return git(cwd,args,options)};
    const result=await removeWorktreeKeepingLinks(f.repo,f.tree,{gitFn});
    assert.equal(result.ok,false,"git refuses");assert.match(result.stderr,/cannot remove a locked working tree, lock reason: taken meanwhile/);
    assertJunctionInPlace(f);assert.equal(samePath(readlinkSync(nested)),samePath(f.outside));if(process.platform==="win32")assert.equal(linkKind(nested),"junction");
    assert.deepEqual((await listedWorktrees(f.repo)).slice(1),[samePath(f.tree)],"git lists the worktree still");
  }finally{await rm(f.root,RETRY)}
});

// A worktree with no junction in it goes to git as before: one git worktree remove, with --force when forced.
test("a worktree without a junction is removed by git's one command, as before",UNDER_LOAD,async()=>{
  const {removeWorktreeKeepingLinks}=gitService;assert.equal(typeof removeWorktreeKeepingLinks,"function","a remove that takes the links out first");
  for(const force of [false,true]){
    const f=await fixture("plain");
    try{
      await mkdir(join(f.tree,"node_modules","pkg"),{recursive:true});await writeFile(join(f.tree,"node_modules","pkg","index.js"),"x\n");
      const calls=[],gitFn=(cwd,args,options)=>{calls.push(args);return git(cwd,args,options)};
      assert.equal((await removeWorktreeKeepingLinks(f.repo,f.tree,{force,gitFn})).ok,true);
      assert.deepEqual(calls,[["worktree","remove",...(force?["--force"]:[]),f.tree]]);assert.equal(existsSync(f.tree),false);
    }finally{await rm(f.root,RETRY)}
  }
});
