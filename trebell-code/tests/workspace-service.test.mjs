import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  environmentWorkspaceDiff,
  environmentWorkspaceFile,
  environmentWorkspaceSearch,
  environmentWorkspaceTree,
  environmentWorkspaceWriteFile,
  workspaceSearch,
  workspaceWriteFile,
} from "../src/workspace.mjs";

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

function remoteEnvironment(){
  const writes=[];
  return {
    writes,
    get:id=>id==="ssh-a"?{id:"ssh-a",name:"Build box",type:"ssh",cwd:"/srv/app"}:null,
    attachmentInfo:async(_id,path)=>({path,size:path.endsWith("large.txt")?800000:18,environmentId:"ssh-a"}),
    writeTextFile:async(_id,path,content)=>{writes.push({path,content});return {path,size:String(content).length}},
    executeArgv:async(_id,options)=>{
      if(options.command==="find"&&options.args.includes("d"))return {exitCode:0,stdout:"/srv/app/src\n/srv/app/docs\n",stderr:""};
      if(options.command==="find"&&options.args.includes("f"))return {exitCode:0,stdout:"/srv/app/src/index.js\n/srv/app/README.md\n",stderr:""};
      if(options.command==="cat")return {exitCode:0,stdout:"export const ok=1;\n",stderr:""};
      if(options.command==="git"&&options.args[0]==="rev-parse")return {exitCode:0,stdout:"/srv/app\n",stderr:""};
      if(options.command==="git"&&options.args[0]==="diff")return {exitCode:0,stdout:"+remote change\n",stderr:""};
      if(options.command==="git"&&options.args[0]==="status")return {exitCode:0,stdout:" M src/index.js\n",stderr:""};
      throw new Error("unexpected remote command "+options.command+" "+options.args.join(" "));
    },
  };
}

test("remote workspace tree, search, read, diff and write stay inside the selected environment",async()=>{
  const environments=remoteEnvironment();
  const options={environments,environmentId:"ssh-a"};
  const tree=await environmentWorkspaceTree("/srv/app",{...options,depth:3,limit:20});
  assert.equal(tree.root,"/srv/app");
  assert.deepEqual(tree.entries.map(item=>[item.relativePath,item.isDirectory]),[
    ["docs",true],["src",true],["README.md",false],["src/index.js",false],
  ]);
  const search=await environmentWorkspaceSearch("/srv/app","index",{...options,limit:10});
  assert.deepEqual(search.items.map(item=>item.path),["/srv/app/src/index.js"]);
  const file=await environmentWorkspaceFile("/srv/app/src/index.js",512000,{...options,root:"/srv/app"});
  assert.equal(file.content,"export const ok=1;\n");
  const diff=await environmentWorkspaceDiff("/srv/app",options);
  assert.equal(diff.isGit,true);
  assert.equal(diff.status," M src/index.js\n");
  const saved=await environmentWorkspaceWriteFile("/srv/app/src/index.js","export const changed=2;\n",{...options,root:"/srv/app"});
  assert.equal(environments.writes[0].path,"/srv/app/src/index.js");
  assert.equal(saved.environmentId,"ssh-a");
  await assert.rejects(()=>environmentWorkspaceFile("/etc/passwd",512000,{...options,root:"/srv/app"}),/outside the active workspace/i);
  await assert.rejects(()=>environmentWorkspaceFile("/srv/app/large.txt",512000,{...options,root:"/srv/app"}),/too large/i);
});
