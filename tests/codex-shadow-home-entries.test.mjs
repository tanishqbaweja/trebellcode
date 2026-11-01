import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { prepareCodexHome } from "../src/codex-home-layout.mjs";

// Two entries that real use leaves in both homes of a Codex profile with a shadow home, and that once stopped the profile from
// starting, because the shadow home's entry was already there and was not a link:
// - Finder writes a .DS_Store into every folder it opens on a Mac. It holds the view settings of that one folder, so each home
//   keeps its own, and a shadow home without one is not given the shared home's.
// - A lock file Codex makes at the top of whichever home it starts in, a new shadow home's too while the shared home has none.
//   A lock guards state the two homes share, so once the shared home has one, the shadow home's gives way to it. Codex names each
//   lock file it takes *.lock; Codex 0.155.1 keeps its own in folders (see codex-home-entries), so the name used here is made up.
//   Re-pinned with the rewrite from Codex 0.155.1's source: these cases used a SQLite maintenance lock that release does not make.

// Runs body with a shared home and a shadow home of their own under the system temp folder. start() prepares the shadow home
// as every start of the profile does (its app-server, its sign-in and its account check); entry(name) is that name's path in each.
async function inCodexHomes(label,body){
  const root=await mkdtemp(join(tmpdir(),`trebell-codex-${label}-`));
  const homes={shared:join(root,"shared"),shadow:join(root,"shadow")};
  await Promise.all([mkdir(homes.shared),mkdir(homes.shadow)]);
  const start=()=>prepareCodexHome({homePath:homes.shared,shadowHomePath:homes.shadow});
  const entry=name=>({shared:join(homes.shared,name),shadow:join(homes.shadow,name)});
  try{await body({homes,start,entry})}
  finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
}

// Whether two names reach one file, as a symbolic link and the hard link Windows makes without symlink rights both do. File ids
// are read as BigInts: NTFS ids pass 2^53, where two of them can be one Number.
async function oneFile(a,b){
  const [first,second]=await Promise.all([stat(a,{bigint:true}),stat(b,{bigint:true})]);
  return first.ino!==0n&&first.dev===second.dev&&first.ino===second.ino;
}
// A plain file in its own right: not a link of any kind (a hard link is told apart by oneFile).
async function ownFile(path){
  const found=await lstat(path);return found.isFile()&&!found.isSymbolicLink();
}
// A .DS_Store as Finder writes it starts with 00 00 00 01 and the magic "Bud1"; the rest tells the two homes' apart here.
const finderFile=folder=>Buffer.concat([Buffer.from([0,0,0,1]),Buffer.from("Bud1","latin1"),Buffer.from(`view settings of ${folder}`)]);
// While body runs, a symbolic link to a file is refused with EPERM, as Windows does without symlink rights (Developer Mode off and
// not an administrator); folders still get theirs. A file is told by what the target is, whatever type the caller passes.
async function withFileSymlinksRefused(body){
  const realSymlink=fs.promises.symlink;
  fs.promises.symlink=async(target,path,type)=>{
    const found=await stat(resolve(dirname(String(path)),String(target))).catch(()=>null);
    if(found?.isFile())throw Object.assign(new Error(`EPERM: operation not permitted, symlink '${target}' -> '${path}'`),{code:"EPERM",syscall:"symlink"});
    return realSymlink(target,path,type);
  };
  syncBuiltinESMExports();
  try{await body()}finally{fs.promises.symlink=realSymlink;syncBuiltinESMExports()}
}

test("each home of a Codex profile keeps Finder's .DS_Store of its own on every start, and the rest of the shadow home is still set up",()=>inCodexHomes("finder-both",async({homes,start,entry})=>{
  const finder=entry(".DS_Store"),signIn=entry("auth.json").shadow,ownSignIn='{"profile":"work","signedIn":true}\n';
  await writeFile(finder.shared,finderFile("the shared home"));
  await writeFile(finder.shadow,finderFile("the shadow home"));
  await writeFile(signIn,ownSignIn);
  for(const round of [1,2,3]){
    await start();
    assert.equal(await ownFile(finder.shadow),true,`start ${round}: the shadow home's .DS_Store is not a link`);
    assert.equal(await oneFile(finder.shadow,finder.shared),false,`start ${round}: the shadow home's .DS_Store is not the shared home's file`);
    assert.deepEqual(await readFile(finder.shadow),finderFile("the shadow home"),`start ${round}: the shadow home's .DS_Store is unchanged`);
    assert.deepEqual(await readFile(finder.shared),finderFile("the shared home"),`start ${round}: the shared home's .DS_Store is unchanged`);
  }
  assert.equal(await readFile(signIn,"utf8"),ownSignIn,"the shadow home's sign-in stays its own");
  // The shared folders are still linked: a session Codex writes in the shared home is there in the shadow home.
  await writeFile(join(homes.shared,"sessions","written-in-the-shared-home.jsonl"),"{}\n");
  assert.equal(await readFile(join(homes.shadow,"sessions","written-in-the-shared-home.jsonl"),"utf8"),"{}\n");
}));

test("a Codex shadow home without a .DS_Store is given none from the shared home",()=>inCodexHomes("finder-shared",async({start,entry})=>{
  const finder=entry(".DS_Store");
  await writeFile(finder.shared,finderFile("the shared home"));
  await start();await start();
  await assert.rejects(lstat(finder.shadow),{code:"ENOENT"},"no .DS_Store entry, not even a link, is made in the shadow home");
  assert.deepEqual(await readFile(finder.shared),finderFile("the shared home"));
}));

test("a Codex lock file made in a shadow home first stays until the shared home has one, then gives way to the shared lock",()=>inCodexHomes("top-lock",async({start,entry})=>{
  const lock=entry("home-upkeep.lock");
  // Codex started in the new shadow home before it ever ran in the shared home.
  await writeFile(lock.shadow,"");
  await start();
  assert.equal(await ownFile(lock.shadow),true,"with no shared lock to link to, the shadow home's own lock stays where it is");
  await assert.rejects(lstat(lock.shared),{code:"ENOENT"},"preparing puts no lock in the shared home either: the shadow home's is linked nowhere");
  // Codex then ran in the shared home as well and made the shared lock.
  await writeFile(lock.shared,"");
  await start();
  assert.equal(await oneFile(lock.shadow,lock.shared),true,"the shadow home's lock is now the shared one");
  await start();
  assert.equal(await oneFile(lock.shadow,lock.shared),true,"a later start keeps the shared lock in place");
  // One lock for both homes: what the shared home's holds reads back through the shadow home's name.
  await writeFile(lock.shared,"maintenance by process 4242\n");
  assert.equal(await readFile(lock.shadow,"utf8"),"maintenance by process 4242\n");
}));

test("on Windows without symlink rights the shadow home's lock file gives way to a hard link of the shared lock, which later starts keep",{skip:process.platform!=="win32"&&"only Windows links a file with a hard link when its symbolic link is refused"},()=>inCodexHomes("top-lock-hard-link",async({start,entry})=>withFileSymlinksRefused(async()=>{
  const lock=entry("home-upkeep.lock");
  await writeFile(lock.shadow,"");await writeFile(lock.shared,"");
  for(const round of [1,2]){
    await start();
    assert.equal((await lstat(lock.shadow)).isSymbolicLink(),false,`start ${round}: the shadow home's lock is a hard link, not a symbolic one`);
    assert.equal(await oneFile(lock.shadow,lock.shared),true,`start ${round}: the shadow home's lock is the shared file`);
  }
  await writeFile(lock.shared,"maintenance by process 5150\n");
  assert.equal(await readFile(lock.shadow,"utf8"),"maintenance by process 5150\n");
})));

test("any other entry a Codex shadow home shares, kept there as a file of its own, is still refused and left as it was",()=>inCodexHomes("own-config",async({start,entry})=>{
  const config=entry("config.toml");
  await writeFile(config.shared,'model = "shared-model"\n');
  await writeFile(config.shadow,'model = "shadow-model"\n');
  await assert.rejects(start(),{message:`The Codex shadow home cannot link 'config.toml': '${config.shadow}' is already there and is not a link.`});
  assert.equal(await readFile(config.shadow,"utf8"),'model = "shadow-model"\n',"the refusal leaves the shadow home's own config.toml as it was");
}));
