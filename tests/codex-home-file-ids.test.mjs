import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCodexHome } from "../src/codex-home-layout.mjs";

// NTFS gives each file a 64-bit id, past 2^53 once its record has been reused often (most new files under H:\temp are), and two
// such ids can be one Number. A shadow home's own config.toml then read as the hard link Windows makes to the shared one, and the
// profile started with it instead of being refused. The ids here are faked through lstat (syncBuiltinESMExports carries the swap
// into the module's named import), so the check does not wait on the disk's luck.
test("a shadow home's own file is refused even when its id and the shared file's are one Number",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-codex-file-ids-")),shared=join(root,"shared"),shadow=join(root,"shadow");
  const realLstat=fs.promises.lstat,sharedConfig=join(shared,"config.toml"),shadowConfig=join(shadow,"config.toml");
  // 2^60+1 and 2^60+2 differ as BigInts and are the same Number.
  const ids=new Map([[sharedConfig,2n**60n+1n],[shadowConfig,2n**60n+2n]]);
  try{
    await mkdir(shared,{recursive:true});await mkdir(shadow,{recursive:true});
    await writeFile(sharedConfig,"shared\n");await writeFile(shadowConfig,"local\n");
    fs.promises.lstat=async(path,options)=>{
      const stats=await realLstat(path,options),id=ids.get(String(path));
      if(id==null)return stats;
      return Object.assign(Object.create(Object.getPrototypeOf(stats)),stats,options?.bigint?{dev:7n,ino:id}:{dev:7,ino:Number(id)});
    };
    syncBuiltinESMExports();
    await assert.rejects(()=>prepareCodexHome({homePath:shared,shadowHomePath:shadow}),/The Codex shadow home cannot link 'config\.toml': .* is already there and is not a link\./);
  }finally{
    fs.promises.lstat=realLstat;syncBuiltinESMExports();
    await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250});
  }
});
