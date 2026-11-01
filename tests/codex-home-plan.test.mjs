import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CODEX_FOLDERS_SHARED_FROM_START, planCodexHomes, prepareCodexHome, setUpCodexHomes } from "../src/codex-home-layout.mjs";
import { remoteCodexHomeSetup } from "../src/environment-app-server.mjs";

// A folder link any account can make: a junction on Windows, a symlink elsewhere.
const folderLink=(target,path)=>symlink(target,path,process.platform==="win32"?"junction":"dir");
const pointsAt=async(path,target)=>resolve(dirname(path),await readlink(path))===resolve(target);
async function homes(prefix){
  const root=await mkdtemp(join(tmpdir(),prefix)),shared=join(root,"shared"),shadow=join(root,"shadow");
  await mkdir(shared,{recursive:true});await mkdir(shadow,{recursive:true});
  return {root,shared,shadow,cleanup:()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})};
}

test("a Codex profile with no home of its own runs on Codex's default home, and one with a home or a shadow home runs there",()=>{
  const fallback=join(tmpdir(),"trebell-default-codex");
  // No home: Codex keeps its default (no CODEX_HOME is set), which is still the home its threads continue in.
  assert.deepEqual(planCodexHomes({defaultHome:fallback}),{mode:"direct",sharedHomePath:resolve(fallback),effectiveHomePath:null,continuationKey:"codex:home:"+resolve(fallback)});
  // A home of spaces is no home.
  assert.equal(planCodexHomes({homePath:"   ",shadowHomePath:" ",defaultHome:fallback}).effectiveHomePath,null);
  const own=join(tmpdir(),"trebell-own-codex");
  assert.deepEqual(planCodexHomes({homePath:own,defaultHome:fallback}),{mode:"direct",sharedHomePath:resolve(own),effectiveHomePath:resolve(own),continuationKey:"codex:home:"+resolve(own)});
  // A shadow home with no home of its own lays its sign-in over the default home, and continues the default home's threads.
  const shadow=join(tmpdir(),"trebell-shadow-codex");
  assert.deepEqual(planCodexHomes({shadowHomePath:shadow,defaultHome:fallback}),{mode:"authOverlay",sharedHomePath:resolve(fallback),effectiveHomePath:resolve(shadow),continuationKey:"codex:home:"+resolve(fallback)});
  assert.equal(planCodexHomes({homePath:own,shadowHomePath:shadow}).continuationKey,"codex:home:"+resolve(own),"profiles over one shared home continue each other's threads");
});

test("a Codex home under a user this machine does not have refuses its profile with that home's message, the shared home's first",async()=>{
  const work=await mkdtemp(join(tmpdir(),"trebell-codex-plan-users-"));
  const unknown=name=>`Trebell could not find the home folder of the user ${name} on this machine, so it cannot use ~${name}/.codex.`;
  try{
    const both=planCodexHomes({homePath:"~trebell-no-such-user-a1/.codex",shadowHomePath:"~trebell-no-such-user-b2/.codex"});
    assert.equal(both.error,unknown("trebell-no-such-user-a1"));
    const shared=join(work,"shared");
    await assert.rejects(()=>prepareCodexHome({homePath:"~trebell-no-such-user-a1/.codex",shadowHomePath:join(work,"shadow")}),{message:unknown("trebell-no-such-user-a1")});
    await assert.rejects(()=>prepareCodexHome({homePath:shared,shadowHomePath:"~trebell-no-such-user-b2/.codex"}),{message:unknown("trebell-no-such-user-b2")});
    assert.deepEqual(await readdir(work),[],"neither the shadow home nor the shared home was made");
  }finally{await rm(work,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("preparing a Codex profile with one home makes nothing, and a shadow plan without a folder is refused",async()=>{
  const work=await mkdtemp(join(tmpdir(),"trebell-codex-plan-direct-"));
  try{
    const home=join(work,"own-home"),plan=await prepareCodexHome({homePath:home});
    assert.equal(plan.effectiveHomePath,resolve(home));
    assert.equal(existsSync(home),false,"the app-server's start makes a direct home itself");
    await assert.rejects(()=>setUpCodexHomes({mode:"authOverlay",sharedHomePath:join(work,"shared"),effectiveHomePath:null}),/The Codex shadow home has no folder set\./);
    assert.deepEqual(await readdir(work),[]);
  }finally{await rm(work,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

// Re-pinned with the rewrite from Codex 0.155.1's own source: each home now also keeps the cloud config cache Codex scopes to the
// signed-in account, the other two memory roots and an app-server daemon's folders (they were linked when the shared home had
// them).
test("a Codex shadow home keeps its own sign-in's files, process folders and memory roots, drops a model list linked from elsewhere, and links the rest",async()=>{
  const {root,shared,shadow,cleanup}=await homes("trebell-codex-plan-own-");
  try{
    for(const name of ["log","tmp","memories","memories_v2","memories_extensions","app-server-daemon","app-server-control"])await mkdir(join(shared,name),{recursive:true});
    await writeFile(join(shared,"models_cache.json"),"shared model list\n");await writeFile(join(shared,"cloud-config-bundle-cache.json"),"{}\n");
    await writeFile(join(shared,"history.jsonl"),"{}\n");
    const elsewhere=join(root,"elsewhere");await mkdir(elsewhere,{recursive:true});await folderLink(elsewhere,join(shadow,"models_cache.json"));
    await prepareCodexHome({homePath:shared,shadowHomePath:shadow});
    const entries=(await readdir(shadow)).sort();
    assert.deepEqual(entries,[...CODEX_FOLDERS_SHARED_FROM_START,"history.jsonl"].sort(),"the shared folders and the shared home's other entries, and nothing kept apart");
    for(const folder of CODEX_FOLDERS_SHARED_FROM_START)assert.equal(await pointsAt(join(shadow,folder),join(shared,folder)),true,folder);
    assert.equal(existsSync(join(elsewhere)),true,"removing the link left its target");
  }finally{await cleanup()}
});

test("a Codex shadow home makes a link that points elsewhere point at the shared home again, leaves a right one alone, and gives Codex's own lock folder over to the shared one",async()=>{
  const {root,shared,shadow,cleanup}=await homes("trebell-codex-plan-links-");
  try{
    const elsewhere=join(root,"elsewhere");await mkdir(elsewhere,{recursive:true});await writeFile(join(elsewhere,"keep.txt"),"kept\n");
    await folderLink(elsewhere,join(shadow,"sessions"));
    // Codex started in the shadow home before the shared home had its MCP sign-in locks.
    await mkdir(join(shadow,"mcp-oauth-locks"),{recursive:true});await writeFile(join(shadow,"mcp-oauth-locks","server.lock"),"");
    await mkdir(join(shared,"mcp-oauth-locks"),{recursive:true});await writeFile(join(shared,"mcp-oauth-locks","shared.lock"),"");
    const config={homePath:shared,shadowHomePath:shadow};
    await prepareCodexHome(config);
    assert.equal(await pointsAt(join(shadow,"sessions"),join(shared,"sessions")),true);
    assert.equal(await readFile(join(elsewhere,"keep.txt"),"utf8"),"kept\n","only the link was removed, never what it pointed at");
    assert.equal(await pointsAt(join(shadow,"mcp-oauth-locks"),join(shared,"mcp-oauth-locks")),true);
    assert.deepEqual(await readdir(join(shared,"mcp-oauth-locks")),["shared.lock"]);
    // A second start finds every link right and makes none again.
    const ids=async()=>Object.fromEntries(await Promise.all(CODEX_FOLDERS_SHARED_FROM_START.map(async folder=>[folder,(await lstat(join(shadow,folder),{bigint:true})).ino])));
    const before=await ids();await prepareCodexHome(config);
    assert.deepEqual(await ids(),before);
  }finally{await cleanup()}
});

test("a shared Codex home entry that is itself a link to a folder is linked into a shadow home as a folder",async()=>{
  const {root,shared,shadow,cleanup}=await homes("trebell-codex-plan-folder-link-");
  try{
    const prompts=join(root,"prompts-elsewhere");await mkdir(prompts,{recursive:true});await writeFile(join(prompts,"review.md"),"Review\n");
    await folderLink(prompts,join(shared,"prompts"));
    await prepareCodexHome({homePath:shared,shadowHomePath:shadow});
    assert.equal(await pointsAt(join(shadow,"prompts"),join(shared,"prompts")),true);
    assert.equal(await readFile(join(shadow,"prompts","review.md"),"utf8"),"Review\n","Codex opens it as the folder it is");
    assert.equal(await realpath(join(shadow,"prompts")),await realpath(prompts));
  }finally{await cleanup()}
});

test("a WSL or SSH shadow home links exactly the folders a local shadow home shares",()=>{
  const setup=remoteCodexHomeSetup({id:"codex-shadow",kind:"codex",homePath:"~/.codex-shared",shadowHomePath:"~/.codex-work"});
  const loop=setup.split("\n").find(line=>line.startsWith("for trebell_codex_entry in "));
  assert.ok(loop,setup);
  const names=[...loop.slice("for trebell_codex_entry in ".length).matchAll(/'([^']*)'/g)].map(match=>match[1]);
  assert.deepEqual(names,[...CODEX_FOLDERS_SHARED_FROM_START]);
  // Re-pinned: Codex 0.155.1 makes no sqlite or logs folder (its databases are files at the top of its home, its log folder is
  // log), so neither is made or linked any more. The list is in Trebell's order, threads first.
  assert.deepEqual(CODEX_FOLDERS_SHARED_FROM_START,["sessions","archived_sessions","worktrees","shell_snapshots","skills","plugins","cache","mcp-oauth-locks"]);
  assert.ok(Object.isFrozen(CODEX_FOLDERS_SHARED_FROM_START));
});
