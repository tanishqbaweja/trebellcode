import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import {
  environmentWorkspaceDiff,
  environmentWorkspaceEditorFile,
  environmentWorkspaceEditorSave,
  environmentWorkspaceFile,
  environmentWorkspaceSearch,
  environmentWorkspaceTree,
  environmentWorkspaceWriteFile,
  workspaceSearch,
  workspaceWriteFile,
} from "../src/workspace.mjs";

const execFileAsync=promisify(execFile);

test("a folder without Git lists and finds files by forward-slash relative paths on every platform",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-workspace-tree-"));
  try{
    await workspaceWriteFile(join(dir,"src","components","UserCard.jsx"),"export const UserCard=()=>null;\n");
    const result=await workspaceSearch(dir,"UserCard");
    assert.equal(result.source,"tree");
    assert.equal(result.items[0].relativePath,"src/components/UserCard.jsx");
    assert.equal(result.items[0].path,join(dir,"src","components","UserCard.jsx"));
    const tree=await environmentWorkspaceTree(dir,{depth:3,limit:20});
    assert.deepEqual(tree.entries.map(item=>item.relativePath),["src","src/components","src/components/UserCard.jsx"]);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("workspace search and write are backed by real files",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-workspace-"));
  try{
    const path=join(dir,"src","example.js");
    await workspaceWriteFile(path,"export const value = 1;\n");
    const result=await workspaceSearch(dir,"example");
    assert.equal(result.items.length,1);
    assert.equal(result.items[0].path,path);
    const fuzzy=await workspaceSearch(dir,"exjs");
    assert.equal(fuzzy.items[0].path,path);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("workspace search uses Git discovery and fuzzy ranking beyond the old tree depth",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-workspace-git-"));
  try{
    await execFileAsync("git",["init","-q"],{cwd:dir});
    const deep=join(dir,"src","components","nested","a","b","c","d","e","f","UserCard.jsx");
    const compare=join(dir,"src","utils","compareUsers.js");
    await workspaceWriteFile(deep,"export const UserCard=()=>null;\n");
    await workspaceWriteFile(compare,"export function compareUsers(){}\n");
    const userCard=await workspaceSearch(dir,"ucard",{limit:10});
    assert.equal(userCard.source,"git");
    assert.equal(userCard.items[0].path,deep);
    const users=await workspaceSearch(dir,"cmpusr",{limit:10});
    assert.equal(users.items[0].path,compare);
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
      if(options.command==="git"&&options.args.includes("ls-files"))return {exitCode:0,stdout:"src/index.js\0README.md\0",stderr:""};
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
  const fuzzySearch=await environmentWorkspaceSearch("/srv/app","sidx",{...options,limit:10});
  assert.equal(fuzzySearch.source,"git");
  assert.deepEqual(fuzzySearch.items.map(item=>item.path),["/srv/app/src/index.js"]);
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

// A remote environment holding `files` (path: bytes), streamed as its cat would stream them.
function remoteFiles(files){
  return {
    get:id=>id==="ssh-a"?{id:"ssh-a",name:"Build box",type:"ssh",cwd:"/srv/app"}:null,
    attachmentInfo:async(_id,path)=>{if(!files.has(path))throw new Error("Attachment does not exist in Build box");return {path,size:files.get(path).length,environmentId:"ssh-a"}},
    streamFile:(_id,path)=>{const child=new EventEmitter();child.stdout=Readable.from([files.get(path)]);child.stdout.once("end",()=>setImmediate(()=>child.emit("close",0)));return child},
    writeTextFile:async(_id,path,bytes)=>{files.set(path,Buffer.from(bytes));return {path,size:bytes.length}},
  };
}

test("the Files editor reads bytes that are not UTF-8 text as binary, and never saves text over them",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-workspace-binary-"));
  try{
    // A PNG header (NUL bytes), and a Latin-1 "é", which is no UTF-8 sequence; and text with a BOM and CRLF lines, which stay.
    const png=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13]),latin=Buffer.from("café\n","latin1"),bom=Buffer.from("﻿naïve “text”\r\nline two\r\n","utf8");
    for(const [name,bytes] of [["logo.png",png],["latin1.txt",latin],["bom.txt",bom]])await writeFile(join(dir,name),bytes);
    for(const [name,size] of [["logo.png",12],["latin1.txt",5]]){
      const file=await environmentWorkspaceEditorFile(join(dir,name),{root:dir});
      assert.equal(file.binary,true,name);assert.equal(file.size,size,name);assert.equal(file.content,null,name);
      await assert.rejects(()=>environmentWorkspaceEditorSave(join(dir,name),"text",{root:dir}),{message:name+" is a binary file, so it is not saved as text"});
    }
    assert.ok((await readFile(join(dir,"logo.png"))).equals(png));assert.ok((await readFile(join(dir,"latin1.txt"))).equals(latin));
    const text=await environmentWorkspaceEditorFile(join(dir,"bom.txt"),{root:dir});
    assert.equal(text.binary,false);assert.equal(text.content,"﻿naïve “text”\r\nline two\r\n");
    await environmentWorkspaceEditorSave(join(dir,"bom.txt"),text.content,{root:dir});
    assert.ok((await readFile(join(dir,"bom.txt"))).equals(bom),"saving what was read writes the same bytes back");
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("a remote file reaches the Files editor byte for byte, binary ones as binary",async()=>{
  const blob=Buffer.from([0x50,0x4b,0x03,0x04,0,0,0xff]),code=Buffer.from("export const ok=1;\r\n\r\n","utf8");
  const files=new Map([["/srv/app/dist/app.zip",blob],["/srv/app/src/index.js",code]]);
  const options={environments:remoteFiles(files),environmentId:"ssh-a",root:"/srv/app"};
  const binary=await environmentWorkspaceEditorFile("/srv/app/dist/app.zip",options);
  assert.equal(binary.binary,true);assert.equal(binary.size,7);assert.equal(binary.content,null);assert.equal(binary.environmentId,"ssh-a");
  await assert.rejects(()=>environmentWorkspaceEditorSave("/srv/app/dist/app.zip","text",options),{message:"app.zip is a binary file, so it is not saved as text"});
  assert.ok(files.get("/srv/app/dist/app.zip").equals(blob));
  // Carriage returns and the trailing blank line survive the trip, so saving the text unchanged writes the same bytes.
  const text=await environmentWorkspaceEditorFile("/srv/app/src/index.js",options);
  assert.equal(text.content,"export const ok=1;\r\n\r\n");
  await environmentWorkspaceEditorSave("/srv/app/src/index.js",text.content,options);
  assert.ok(files.get("/srv/app/src/index.js").equals(code));
  await assert.rejects(()=>environmentWorkspaceEditorFile("/etc/passwd",options),/outside the active workspace/i);
});

