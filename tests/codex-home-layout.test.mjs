import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { prepareCodexHome, resolveCodexHomeLayout } from "../src/codex-home-layout.mjs";

test("Codex direct home preserves continuation identity",()=>{
  const layout=resolveCodexHomeLayout({homePath:"/tmp/shared-codex"});
  assert.equal(layout.mode,"direct");assert.equal(layout.sharedHomePath,resolve("/tmp/shared-codex"));assert.equal(layout.continuationKey,`codex:home:${resolve("/tmp/shared-codex")}`);
});

test("Codex shadow home shares state but keeps auth private",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-codex-shadow-")),shared=join(root,"shared"),shadow=join(root,"shadow");
  try{
    await mkdir(shared,{recursive:true});await mkdir(shadow,{recursive:true});await writeFile(join(shared,"config.toml"),'model="shared"\n');await writeFile(join(shadow,"auth.json"),'{"shadow":true}\n');await writeFile(join(shadow,"models_cache.json"),"private-cache\n");
    const layout=await prepareCodexHome({homePath:shared,shadowHomePath:shadow});assert.equal(layout.mode,"authOverlay");assert.equal(layout.effectiveHomePath,resolve(shadow));
    const configPath=join(shadow,"config.toml"),sharedConfig=join(shared,"config.toml");
    if((await lstat(configPath)).isSymbolicLink())assert.equal(resolve(dirname(configPath),await readlink(configPath)),resolve(sharedConfig));
    else{const [a,b]=await Promise.all([lstat(configPath),lstat(sharedConfig)]);assert.equal(a.ino,b.ino)}
    const sessionsPath=join(shadow,"sessions");assert.equal(resolve(dirname(sessionsPath),await readlink(sessionsPath)),resolve(join(shared,"sessions")));
    assert.equal(await readFile(join(shadow,"auth.json"),"utf8"),'{"shadow":true}\n');
    assert.equal(await readFile(join(shadow,"models_cache.json"),"utf8"),"private-cache\n");
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Codex shadow home refuses shared/private path conflicts",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-codex-shadow-conflict-")),shared=join(root,"shared"),shadow=join(root,"shadow");
  try{
    await assert.rejects(()=>prepareCodexHome({homePath:shared,shadowHomePath:shared}),/must be different/i);
    await mkdir(shared,{recursive:true});await mkdir(shadow,{recursive:true});await writeFile(join(shared,"config.toml"),"shared\n");await writeFile(join(shadow,"config.toml"),"local\n");
    await assert.rejects(()=>prepareCodexHome({homePath:shared,shadowHomePath:shadow}),/already exists and is not a symlink/i);
    await rm(join(shadow,"config.toml"),{force:true});
    const authTarget=join(root,"auth-target");await mkdir(authTarget,{recursive:true});await symlink(authTarget,join(shadow,"auth.json"),process.platform==="win32"?"junction":"dir");
    await assert.rejects(()=>prepareCodexHome({homePath:shared,shadowHomePath:shadow}),/auth\.json.*real file/i);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

// ~name is the home folder of the user name, as a shell expands it. Trebell took a local Codex home typed as ~name/... as a folder named
// ~name where it runs, while ~ and ~/... went to the person's home: the person's own name is now their home (and, on Linux and other
// Unix systems, any user /etc/passwd names), and a user Trebell cannot find is refused with a message before any folder is made.
const ownName=(()=>{try{return userInfo().username}catch{return ""}})();
test("a local Codex home under the person's own user name is in their home folder, as one under ~ is",{skip:!/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(ownName)&&"this user name is not one a shell spells after ~"},()=>{
  const layout=resolveCodexHomeLayout({homePath:`~${ownName}/.codex-shared`,shadowHomePath:`~${ownName}/.codex-work`});
  assert.equal(layout.sharedHomePath,join(homedir(),".codex-shared"));
  assert.equal(layout.effectiveHomePath,join(homedir(),".codex-work"));
  assert.equal(layout.continuationKey,`codex:home:${join(homedir(),".codex-shared")}`);
  assert.equal(layout.error,undefined);
});

test("a local Codex home under a user Trebell cannot find is refused with a message, and no folder is made for it",async()=>{
  const work=await mkdtemp(join(tmpdir(),"trebell-codex-named-home-")),previous=process.cwd();
  const path="~trebell-no-such-user-7f3a/.codex";
  const message="Trebell could not find the home folder of the user trebell-no-such-user-7f3a on this machine, so it cannot use ~trebell-no-such-user-7f3a/.codex.";
  // A relative path is placed where Trebell runs, so the test runs in a folder of its own.
  process.chdir(work);
  try{
    const shadowed=await prepareCodexHome({homePath:join(work,"shared"),shadowHomePath:path}).then(()=>null,error=>error);
    const direct=await prepareCodexHome({homePath:path}).then(()=>null,error=>error);
    assert.deepEqual(await readdir(work),[],"no folder is made: neither one named ~trebell-no-such-user-7f3a where Trebell runs nor the shared home");
    assert.equal(shadowed?.message,message);
    assert.equal(direct?.message,message);
    assert.equal(resolveCodexHomeLayout({homePath:path}).error,message,"the layout says why it cannot be used");
  }finally{process.chdir(previous);await rm(work,{recursive:true,force:true,maxRetries:20,retryDelay:50})}
});

test("on Linux and other Unix systems another user's home is the one /etc/passwd names, and on Windows only the person's own name is found",async()=>{
  const { homeFromPasswd, localHomePath }=await import("../src/local-home-path.mjs");
  const passwd="root:x:0:0:root:/root:/bin/bash\nbob:x:1001:1001:Bob,,,:/home/bob:/bin/bash\n# a comment\n\n";
  assert.equal(homeFromPasswd(passwd,"bob"),"/home/bob");
  assert.equal(homeFromPasswd(passwd,"alice"),null);
  const linux={platform:"linux",home:"/home/me",userName:()=>"me",lookupHome:name=>homeFromPasswd(passwd,name)};
  assert.deepEqual(localHomePath("~bob/.codex",linux),{path:"/home/bob/.codex"});
  assert.deepEqual(localHomePath("~bob",linux),{path:"/home/bob"});
  assert.deepEqual(localHomePath("~me/.codex",linux),{path:"/home/me/.codex"});
  assert.deepEqual(localHomePath("~/.codex",linux),{path:"/home/me/.codex"});
  assert.deepEqual(localHomePath("~",linux),{path:"/home/me"});
  assert.deepEqual(localHomePath("~alice/.codex",linux),{path:"~alice/.codex",error:"Trebell could not find the home folder of the user alice on this machine, so it cannot use ~alice/.codex."});
  // A tilde a user name does not follow, and any other path, stays as it was written.
  for(const raw of ["~-x/y","~bob\\.codex","~$USER/x","/srv/codex","codex-home",""])assert.deepEqual(localHomePath(raw,linux),{path:raw});
  const windows={platform:"win32",home:"C:\\Users\\Me",userName:()=>"me",lookupHome:()=>{throw new Error("Windows has no /etc/passwd to read")}};
  assert.deepEqual(localHomePath("~Me\\.codex",windows),{path:"C:\\Users\\Me\\.codex"});
  assert.deepEqual(localHomePath("~me/.codex",windows),{path:"C:\\Users\\Me\\.codex"});
  assert.deepEqual(localHomePath("~\\.codex",windows),{path:"C:\\Users\\Me\\.codex"});
  assert.equal(localHomePath("~bob\\.codex",windows).error,"Trebell could not find the home folder of the user bob on this machine, so it cannot use ~bob\\.codex.");
});
