import test from "node:test";
import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CODEX_FOLDERS_SHARED_FROM_START, prepareCodexHome } from "../src/codex-home-layout.mjs";

// How a shadow home treats the entries Codex 0.155.1 puts in its home (codex-rs at the tag rust-v0.155.1): what is made in the
// shared home first, what each home keeps for itself, and which of Codex's lock folders give way.

async function withHomes(label,body){
  const root=await mkdtemp(join(tmpdir(),`trebell-codex-entries-${label}-`));
  const shared=join(root,"shared"),shadow=join(root,"shadow");
  await mkdir(shared);await mkdir(shadow);
  try{await body({shared,shadow,start:()=>prepareCodexHome({homePath:shared,shadowHomePath:shadow})})}
  finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
}
const linksTo=async(path,target)=>(await lstat(path)).isSymbolicLink()&&resolve(dirname(path),await readlink(path))===resolve(target);
const isOwnFolder=async path=>{const found=await lstat(path);return found.isDirectory()&&!found.isSymbolicLink()};

test("a new shared home gets only the folders shared from the start: no sqlite or logs folder, no thread writer locks, no .tmp",()=>withHomes("fresh",async({shared,shadow,start})=>{
  await start();
  assert.deepEqual((await readdir(shared)).sort(),[...CODEX_FOLDERS_SHARED_FROM_START].sort());
  assert.deepEqual((await readdir(shadow)).sort(),[...CODEX_FOLDERS_SHARED_FROM_START].sort());
  for(const folder of CODEX_FOLDERS_SHARED_FROM_START)assert.equal(await linksTo(join(shadow,folder),join(shared,folder)),true,folder);
}));

test("thread writer locks a shadow home made first stay its own until the shared home has some, then give way to the shared ones",()=>withHomes("writer-locks",async({shared,shadow,start})=>{
  const own=join(shadow,"thread-writer-locks"),writerLocksInShared=join(shared,"thread-writer-locks");
  await mkdir(own);await writeFile(join(own,"thread-in-shadow.lock"),"");
  await start();
  assert.equal(await isOwnFolder(own),true,"with no shared folder to link to, the shadow home's own stays");
  await assert.rejects(lstat(writerLocksInShared),{code:"ENOENT"},"the shared home is not given one");
  await mkdir(writerLocksInShared);await writeFile(join(writerLocksInShared,".coordination.lock"),"");
  await start();
  assert.equal(await linksTo(own,writerLocksInShared),true,"the shadow home's own folder gave way to the shared one");
  assert.deepEqual(await readdir(writerLocksInShared),[".coordination.lock"],"nothing of the shadow home's own folder reached the shared one");
  await start();
  assert.equal(await linksTo(own,writerLocksInShared),true,"a later start keeps the link");
}));

test("each home keeps its own sign-in cache, process folders and memory roots, and a shadow home's copies stay as they are",()=>withHomes("own",async({shared,shadow,start})=>{
  const folders=["memories","memories_v2","memories_extensions","app-server-daemon","app-server-control","log","tmp"];
  for(const home of [shared,shadow]){
    for(const folder of folders){await mkdir(join(home,folder));await writeFile(join(home,folder,"note.txt"),home===shared?"shared\n":"shadow\n")}
    await writeFile(join(home,"cloud-config-bundle-cache.json"),home===shared?"{\"for\":\"shared\"}\n":"{\"for\":\"shadow\"}\n");
  }
  await start();await start();
  for(const folder of folders){
    assert.equal(await isOwnFolder(join(shadow,folder)),true,folder);
    assert.equal(await readFile(join(shadow,folder,"note.txt"),"utf8"),"shadow\n",folder);
  }
  assert.equal((await lstat(join(shadow,"cloud-config-bundle-cache.json"))).isSymbolicLink(),false);
  assert.equal(await readFile(join(shadow,"cloud-config-bundle-cache.json"),"utf8"),"{\"for\":\"shadow\"}\n");
}));

test("names each home keeps that the shadow home lacks are not given to it from the shared home",()=>withHomes("own-missing",async({shared,shadow,start})=>{
  for(const folder of ["memories_v2","app-server-daemon","app-server-control"])await mkdir(join(shared,folder));
  await writeFile(join(shared,"cloud-config-bundle-cache.json"),"{}\n");
  await start();
  for(const name of ["memories_v2","app-server-daemon","app-server-control","cloud-config-bundle-cache.json"])await assert.rejects(lstat(join(shadow,name)),{code:"ENOENT"},name);
}));

// Trebell 2.0.0 to 2.1.2 linked these names into a local shadow home. Such a link to the shared home's entry of the same name goes,
// so Codex makes the shadow home's own; a link at one of them that points anywhere else stays, and so does a link at a name no
// release linked (log, memories), which only the person can have made, wherever it points.
test("a link a release made at a name each home keeps goes, and the shared entry and the person's own links stay",()=>withHomes("own-old-links",async({shared,shadow,start})=>{
  const folders=["memories_v2","app-server-daemon"],windows=process.platform==="win32";
  for(const folder of folders){await mkdir(join(shared,folder));await writeFile(join(shared,folder,"note.txt"),"shared\n");await symlink(join(shared,folder),join(shadow,folder),windows?"junction":"dir")}
  await writeFile(join(shared,"cloud-config-bundle-cache.json"),"{}\n");
  try{await symlink(join(shared,"cloud-config-bundle-cache.json"),join(shadow,"cloud-config-bundle-cache.json"),"file")}
  catch{await link(join(shared,"cloud-config-bundle-cache.json"),join(shadow,"cloud-config-bundle-cache.json"))}
  const elsewhere=join(dirname(shared),"elsewhere");await mkdir(elsewhere);await symlink(elsewhere,join(shadow,"memories"),windows?"junction":"dir");
  await mkdir(join(shared,"log"));await symlink(join(shared,"log"),join(shadow,"log"),windows?"junction":"dir");
  await start();
  for(const name of [...folders,"cloud-config-bundle-cache.json"])await assert.rejects(lstat(join(shadow,name)),{code:"ENOENT"},name);
  for(const folder of folders)assert.equal(await readFile(join(shared,folder,"note.txt"),"utf8"),"shared\n",folder);
  assert.equal(await readFile(join(shared,"cloud-config-bundle-cache.json"),"utf8"),"{}\n");
  assert.equal((await lstat(join(shadow,"memories"))).isSymbolicLink(),true,"a link that points elsewhere stays");
  assert.equal((await lstat(join(shadow,"log"))).isSymbolicLink(),true,"the person's link at a name no release linked stays");
}));

test("a folder shared from the start that the shadow home holds as its own is refused and left as it was",()=>withHomes("own-shared",async({shadow,start})=>{
  await mkdir(join(shadow,"sessions"));await writeFile(join(shadow,"sessions","kept.jsonl"),"{}\n");
  await assert.rejects(start(),{message:`The Codex shadow home cannot link 'sessions': '${join(shadow,"sessions")}' is already there and is not a link.`});
  assert.equal(await readFile(join(shadow,"sessions","kept.jsonl"),"utf8"),"{}\n");
}));
