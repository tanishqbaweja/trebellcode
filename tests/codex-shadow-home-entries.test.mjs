import test from "node:test";
import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { prepareCodexHome } from "../src/codex-home-layout.mjs";

// Two entries a Codex shadow home meets in real use (T3 Code's CodexHomeLayout): Finder's .DS_Store, which macOS writes into every
// folder it opens, the shadow home's too, and the SQLite maintenance lock Codex makes in a shadow home it starts in before the
// shared home has one. With either one a real file in both homes, the profile could not start: "Cannot create Codex shadow home
// entry … because … already exists and is not a symlink."
async function homes(prefix){
  const root=await mkdtemp(join(tmpdir(),prefix)),shared=join(root,"shared"),shadow=join(root,"shadow");
  await mkdir(shared,{recursive:true});await mkdir(shadow,{recursive:true});
  return {root,shared,shadow,cleanup:()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})};
}
const exists=path=>access(path).then(()=>true,()=>false);
// The shadow entry is the shared one: a symlink to it, or the hard link Windows makes without symlink rights (codex-home-layout).
async function linkedTo(path,target){
  const entry=await lstat(path);
  if(entry.isSymbolicLink())return resolve(dirname(path),await readlink(path))===resolve(target);
  const shared=await lstat(target);return entry.dev===shared.dev&&Boolean(entry.ino)&&entry.ino===shared.ino;
}

test("a Codex shadow home keeps Finder's .DS_Store of its own through every start, and never links the shared one",async()=>{
  const {shared,shadow,cleanup}=await homes("trebell-codex-shadow-finder-");
  const sharedMetadata=join(shared,".DS_Store"),shadowMetadata=join(shadow,".DS_Store");
  try{
    await writeFile(sharedMetadata,"shared Finder metadata");await writeFile(shadowMetadata,"shadow Finder metadata");await writeFile(join(shadow,"auth.json"),'{"shadow":true}\n');
    const config={homePath:shared,shadowHomePath:shadow};
    await prepareCodexHome(config);
    assert.equal(await readFile(shadowMetadata,"utf8"),"shadow Finder metadata","the shadow home's own Finder metadata stays as it was");
    // A shadow home without one gets no link to the shared one: Finder makes its own when it opens the folder.
    await rm(shadowMetadata,{force:true});
    await prepareCodexHome(config);
    assert.equal(await exists(shadowMetadata),false);
    await writeFile(shadowMetadata,"shadow Finder metadata");
    await prepareCodexHome(config);await prepareCodexHome(config);
    assert.equal(await readFile(sharedMetadata,"utf8"),"shared Finder metadata");
    assert.equal(await readFile(shadowMetadata,"utf8"),"shadow Finder metadata");
    assert.equal((await lstat(shadowMetadata)).isSymbolicLink(),false);
    assert.equal(await readFile(join(shadow,"auth.json"),"utf8"),'{"shadow":true}\n',"the shadow home's sign-in stays private");
    assert.equal(await linkedTo(join(shadow,"sessions"),join(shared,"sessions")),true,"shared state is still linked");
  }finally{await cleanup()}
});

test("a SQLite maintenance lock Codex made in a shadow home before the shared home had one gives way to the shared lock",async()=>{
  const {shared,shadow,cleanup}=await homes("trebell-codex-shadow-sqlite-lock-");
  const sharedLock=join(shared,".sqlite-maintenance.lock"),shadowLock=join(shadow,".sqlite-maintenance.lock");
  try{
    await writeFile(sharedLock,"");await writeFile(shadowLock,"");
    await prepareCodexHome({homePath:shared,shadowHomePath:shadow});
    assert.equal(await linkedTo(shadowLock,sharedLock),true,"the shadow home's lock is the shared one");
    // A later start finds the link and leaves it.
    await prepareCodexHome({homePath:shared,shadowHomePath:shadow});
    assert.equal(await linkedTo(shadowLock,sharedLock),true);
    // Any other entry Codex shares still refuses a local file in its place, as before.
    await writeFile(join(shared,"config.toml"),"shared\n");await writeFile(join(shadow,"config.toml"),"local\n");
    await assert.rejects(()=>prepareCodexHome({homePath:shared,shadowHomePath:shadow}),/Cannot create Codex shadow home entry 'config\.toml' because .* already exists and is not a symlink\./);
  }finally{await cleanup()}
});
