import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceSearch, workspaceWriteFile } from "../src/workspace.mjs";

test("workspace search and write are backed by real files",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-workspace-"));
  try{
    const path=join(dir,"src","example.js");
    await workspaceWriteFile(path,"export const value = 1;\n");
    const result=await workspaceSearch(dir,"example");
    assert.equal(result.items.length,1);
    assert.equal(result.items[0].path,path);
  }finally{await rm(dir,{recursive:true,force:true});}
});
