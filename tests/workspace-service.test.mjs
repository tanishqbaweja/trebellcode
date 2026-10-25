import test from "node:test";
import assert from "node:assert/strict";
import fsPromises, { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { promisify } from "node:util";
import {
  environmentWorkspaceDiff,
  environmentWorkspaceEditorFile,
  environmentWorkspaceEditorSave,
  environmentWorkspaceFile,
  environmentWorkspaceSearch,
  environmentWorkspaceTree,
  environmentWorkspaceWriteFile,
  workspaceDiff,
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
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250});}
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
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250});}
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
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250});}
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
      if(options.command==="sh"&&options.args[0]==="-c"&&options.args[1].includes("git diff"))return {exitCode:0,stdout:"+remote change\n",stderr:""};
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
  assert.equal(diff.diff,"+remote change\n");
  const saved=await environmentWorkspaceWriteFile("/srv/app/src/index.js","export const changed=2;\n",{...options,root:"/srv/app"});
  assert.equal(environments.writes[0].path,"/srv/app/src/index.js");
  assert.equal(saved.environmentId,"ssh-a");
  await assert.rejects(()=>environmentWorkspaceFile("/etc/passwd",512000,{...options,root:"/srv/app"}),/outside the active workspace/i);
  await assert.rejects(()=>environmentWorkspaceFile("/srv/app/large.txt",512000,{...options,root:"/srv/app"}),/too large/i);
});

// A model's read (truncate) of a text file over its limit: the first bytes, cut after a line break near the limit or else before
// the character the limit would split, with the file's size and line count; every other reader keeps the refusal.
const FORTY_LINES=Array.from({length:40},(_,index)=>`line ${String(index+1).padStart(2,"0")}`),FORTY_LINES_TEXT=FORTY_LINES.join("\n")+"\n";
test("a model's read of a text file over its limit gets the file's first bytes, cut at a line or a character, with its size and line count",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-workspace-head-"));
  try{
    const path=join(dir,"notes.txt");await writeFile(path,FORTY_LINES_TEXT,"utf8");
    await assert.rejects(()=>environmentWorkspaceFile(path,100),/too large to preview/i,"a reader that needs the whole file keeps the refusal");
    // 100 bytes hold 12 whole 8-byte lines and 4 bytes of line 13: the cut is after line 12, as that break is near the limit.
    const head=await environmentWorkspaceFile(path,100,{truncate:true});
    assert.equal(head.content,FORTY_LINES.slice(0,12).join("\n")+"\n");
    assert.equal(head.truncated,true);assert.equal(head.size,320);assert.equal(head.totalLines,40);
    assert.match(head.message,/lines 1-12\b/);assert.match(head.message,/from line 13\b/);
    const wide=join(dir,"wide.txt");await writeFile(wide,"€".repeat(50),"utf8");
    const cut=await environmentWorkspaceFile(wide,10,{truncate:true});
    assert.equal(cut.content,"€€€","a line longer than the limit is cut before the character the limit would split");
    assert.equal(cut.size,150);assert.equal(cut.totalLines,1);assert.match(cut.message,/inside line 1\b/);
    const binary=join(dir,"data.bin");await writeFile(binary,Buffer.concat([Buffer.from("PK"),Buffer.alloc(200)]));
    await assert.rejects(()=>environmentWorkspaceFile(binary,100,{truncate:true}),/too large to preview/i,"a binary file keeps the refusal, having no lines to read on by");
    assert.equal((await environmentWorkspaceFile(path,320,{truncate:true})).content,FORTY_LINES_TEXT,"a file within the limit is read whole");
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("a model's read of a text file that grows while it is read counts the lines of the size it reports, and stops there",async()=>{
  // A log a running process still writes: lines appended once the count has begun are not counted, so the line count agrees
  // with the size the read gives, and a writer faster than the read cannot keep the count going.
  const dir=await mkdtemp(join(tmpdir(),"trebell-workspace-grow-")),original=fsPromises.open;let reads=0;
  try{
    const path=join(dir,"server.log");await writeFile(path,FORTY_LINES_TEXT,"utf8");
    fsPromises.open=async(...args)=>{
      const handle=await original(...args),read=handle.read.bind(handle);
      handle.read=(...readArgs)=>{if(++reads===2)appendFileSync(path,"request served\n".repeat(1000));return read(...readArgs)};
      return handle;
    };
    syncBuiltinESMExports();
    const head=await environmentWorkspaceFile(path,100,{truncate:true});
    assert.equal(head.size,320);assert.equal(head.totalLines,40);assert.match(head.message,/^The file is 320 bytes, 40 lines;/);
    assert.equal(head.content,FORTY_LINES.slice(0,12).join("\n")+"\n");
  }finally{fsPromises.open=original;syncBuiltinESMExports();await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("a model's read of a remote text file over its limit streams only the first bytes and counts the lines in the environment",async()=>{
  const bytes=Buffer.from(FORTY_LINES_TEXT),calls=[];
  const environments={
    get:id=>id==="ssh-a"?{id:"ssh-a",name:"Build box",type:"ssh",cwd:"/srv/app"}:null,
    attachmentInfo:async(_id,path)=>({path,size:bytes.length,environmentId:"ssh-a"}),
    streamFile:(_id,path,range)=>{calls.push(["stream",path,range]);const child=new EventEmitter();child.stdout=Readable.from([bytes.subarray(range.start,range.start+range.length)]);child.stdout.once("end",()=>setImmediate(()=>child.emit("close",0)));return child},
    executeArgv:async(_id,options)=>{calls.push(["exec",options.command,options.args]);return {exitCode:0,stdout:"      40\n1\n",stderr:""}},
  };
  const head=await environmentWorkspaceFile("/srv/app/notes.txt",100,{root:"/srv/app",environments,environmentId:"ssh-a",truncate:true});
  assert.equal(head.content,FORTY_LINES.slice(0,12).join("\n")+"\n");assert.equal(head.truncated,true);assert.equal(head.size,320);assert.equal(head.totalLines,40);assert.equal(head.environmentId,"ssh-a");
  assert.deepEqual(calls[0],["stream","/srv/app/notes.txt",{start:0,length:100}],"only the first bytes leave the environment");
  assert.equal(calls.some(([kind,command])=>kind==="exec"&&command==="cat"),false);
  await assert.rejects(()=>environmentWorkspaceFile("/srv/app/notes.txt",100,{root:"/srv/app",environments,environmentId:"ssh-a"}),/too large to preview/i);
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
    assert.equal((await environmentWorkspaceEditorSave(join(dir,"bom.txt"),text.content,{root:dir,version:text.version})).version,text.version);
    assert.ok((await readFile(join(dir,"bom.txt"))).equals(bom),"saving what was read writes the same bytes back");
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250});}
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
  assert.equal((await environmentWorkspaceEditorSave("/srv/app/src/index.js",text.content,{...options,version:text.version})).version,text.version);
  assert.ok(files.get("/srv/app/src/index.js").equals(code));
  await assert.rejects(()=>environmentWorkspaceEditorFile("/etc/passwd",options),/outside the active workspace/i);
  // A connection that fails before the file has streamed fails the read, and only the read.
  const failing={...options.environments,streamFile:()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>{};setImmediate(()=>{child.emit("error",new Error("ssh: connection reset"));setTimeout(()=>child.stdout.end(),20)});return child}};
  await assert.rejects(()=>environmentWorkspaceEditorFile("/srv/app/src/index.js",{...options,environments:failing}),/connection reset/);
});

test("a Files editor save names the version it edited, and a file that changed or went on disk since is not written",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-workspace-version-"));
  try{
    const path=join(dir,"notes.txt");
    await writeFile(path,"one\n");
    const opened=await environmentWorkspaceEditorFile(path,{root:dir});
    // An agent writes the file while it is open: the save of the old version writes nothing and names what is there now.
    await writeFile(path,"agent\n");
    const changed=await environmentWorkspaceEditorSave(path,"mine\n",{root:dir,version:opened.version});
    assert.deepEqual(changed,{conflict:"changed",version:(await environmentWorkspaceEditorFile(path,{root:dir})).version,error:"notes.txt changed on disk after you opened it."});
    assert.equal(await readFile(path,"utf8"),"agent\n");
    // A save with no version is a save over nothing, so it never writes over a file either.
    assert.equal((await environmentWorkspaceEditorSave(path,"mine\n",{root:dir})).conflict,"changed");
    // Overwrite names the version the refusal named; the next save names the version that one wrote.
    const overwritten=await environmentWorkspaceEditorSave(path,"mine\n",{root:dir,version:changed.version});
    assert.equal(await readFile(path,"utf8"),"mine\n");assert.equal(overwritten.content,"mine\n");
    await environmentWorkspaceEditorSave(path,"mine twice\n",{root:dir,version:overwritten.version});
    assert.equal(await readFile(path,"utf8"),"mine twice\n");
    // A file deleted since it was opened is not made again by a save of its old version, only by one made over no file.
    const before=(await environmentWorkspaceEditorFile(path,{root:dir})).version;
    await rm(path);
    assert.deepEqual(await environmentWorkspaceEditorSave(path,"again\n",{root:dir,version:before}),{conflict:"deleted",version:null,error:"notes.txt was deleted on disk after you opened it."});
    await assert.rejects(()=>readFile(path),{code:"ENOENT"});
    await environmentWorkspaceEditorSave(path,"again\n",{root:dir,version:null});
    assert.equal(await readFile(path,"utf8"),"again\n");
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250});}
  // On a remote environment too.
  const files=new Map([["/srv/app/notes.txt",Buffer.from("one\n")]]),options={environments:remoteFiles(files),environmentId:"ssh-a",root:"/srv/app"};
  const opened=await environmentWorkspaceEditorFile("/srv/app/notes.txt",options);
  files.set("/srv/app/notes.txt",Buffer.from("agent\n"));
  const changed=await environmentWorkspaceEditorSave("/srv/app/notes.txt","mine\n",{...options,version:opened.version});
  assert.equal(changed.conflict,"changed");assert.equal(files.get("/srv/app/notes.txt").toString(),"agent\n");
  files.delete("/srv/app/notes.txt");
  assert.equal((await environmentWorkspaceEditorSave("/srv/app/notes.txt","mine\n",{...options,version:changed.version})).conflict,"deleted");
  assert.equal(files.has("/srv/app/notes.txt"),false);
});


test("the Files editor reads and saves a local file only inside the project's folder, once '..' and links are resolved",async()=>{
  const base=await mkdtemp(join(tmpdir(),"trebell-workspace-inside-"));
  try{
    const dir=join(base,"project"),away=join(base,"away"),outside={message:"File is outside the active workspace"};
    await mkdir(join(dir,"src"),{recursive:true});await mkdir(away);await mkdir(join(base,"project-other"));
    await writeFile(join(away,"secret.txt"),"secret\n");await writeFile(join(dir,"src","a.js"),"a\n");await writeFile(join(base,"project-other","b.txt"),"b\n");
    // Folder links (junctions on Windows, which need no special rights): out of the project, into it, and to a folder not there.
    await symlink(away,join(dir,"linked-away"),"junction");await symlink(join(dir,"src"),join(dir,"linked-src"),"junction");
    await symlink(join(away,"not-made"),join(dir,"dangling"),"junction");
    // A file link needs those rights on Windows, so it is checked where it can be made.
    const fileLink=await symlink(join(away,"secret.txt"),join(dir,"secret-link.txt"),"file").then(()=>true,error=>{if(error.code==="EPERM")return false;throw error});
    // Outside by its path, by '..', through a link, or in a sibling folder whose name starts with the project's: neither read nor written.
    const outsidePaths=[join(away,"secret.txt"),join(dir,"src","..","..","away","secret.txt"),join(dir,"linked-away","secret.txt"),join(base,"project-other","b.txt"),...(fileLink?[join(dir,"secret-link.txt")]:[])];
    for(const path of outsidePaths){
      await assert.rejects(()=>environmentWorkspaceEditorFile(path,{root:dir}),outside,path);
      await assert.rejects(()=>environmentWorkspaceEditorSave(path,"mine\n",{root:dir}),outside,path);
    }
    assert.equal(await readFile(join(away,"secret.txt"),"utf8"),"secret\n");assert.equal(await readFile(join(base,"project-other","b.txt"),"utf8"),"b\n");
    // A new file outside is not made, through a link or through a link to a folder that is not there.
    for(const path of [join(dir,"linked-away","new.txt"),join(dir,"dangling","new.txt"),join(dir,"..","new.txt")])await assert.rejects(()=>environmentWorkspaceEditorSave(path,"mine\n",{root:dir,version:null}),outside,path);
    await assert.rejects(()=>stat(join(away,"new.txt")),{code:"ENOENT"});await assert.rejects(()=>stat(join(away,"not-made")),{code:"ENOENT"});await assert.rejects(()=>stat(join(base,"new.txt")),{code:"ENOENT"});
    // Inside, everything works as before: a file, the same file through a link that stays inside, a new file in new folders,
    // and the project opened by a link to its folder.
    const opened=await environmentWorkspaceEditorFile(join(dir,"src","a.js"),{root:dir});assert.equal(opened.content,"a\n");
    assert.equal((await environmentWorkspaceEditorFile(join(dir,"linked-src","a.js"),{root:dir})).content,"a\n");
    assert.equal((await environmentWorkspaceEditorSave(join(dir,"src","a.js"),"b\n",{root:dir,version:opened.version})).content,"b\n");
    await environmentWorkspaceEditorSave(join(dir,"docs","new","notes.md"),"new\n",{root:dir,version:null});
    assert.equal(await readFile(join(dir,"docs","new","notes.md"),"utf8"),"new\n");
    await symlink(dir,join(base,"project-link"),"junction");
    assert.equal((await environmentWorkspaceEditorFile(join(base,"project-link","src","a.js"),{root:join(base,"project-link")})).content,"b\n");
  }finally{await rm(base,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

// A repository as an agent's turn leaves it, for the Diff tab: a committed file edited, an edit and a new file staged, and new files
// git does not track yet (one with no newline at its end, an empty one, a binary one, one too large to preview, one whose name git
// quotes), beside a file .gitignore leaves out.
async function agentWorkRepository(prefix){
  const dir=await mkdtemp(join(tmpdir(),prefix)),run=args=>execFileAsync("git",args,{cwd:dir,windowsHide:true});
  await run(["init","-q","-b","main"]);await run(["config","user.email","diff@example.test"]);await run(["config","user.name","Diff Test"]);await run(["config","core.autocrlf","false"]);
  await mkdir(join(dir,"src"));await writeFile(join(dir,"README.md"),"# Seed\n");await writeFile(join(dir,"src","app.js"),"export const answer = 42;\n");await writeFile(join(dir,".gitignore"),"*.log\n");
  await run(["add","-A"]);await run(["commit","-qm","seed"]);
  await writeFile(join(dir,"src","app.js"),"export const answer = 43;\n");
  await writeFile(join(dir,"README.md"),"# Seeded\n");await writeFile(join(dir,"src","staged.js"),"export const staged = true;\n");await run(["add","README.md","src/staged.js"]);
  const added={"src/from-agent.js":"export const fromAgent = true;\n","notes.txt":"one\ntwo","empty.txt":"","blob.bin":Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13])};
  for(const [path,content] of Object.entries(added))await writeFile(join(dir,path),content);
  await writeFile(join(dir,"café notes.txt"),"caf\n");await writeFile(join(dir,"big.txt"),"x".repeat(600_000));await writeFile(join(dir,"debug.log"),"left out\n");
  return {dir,run,added:Object.keys(added)};
}
const countingGit=()=>{const calls=[];return {calls,gitFn:(cwd,args,options)=>{calls.push(args.join(" "));return execFileAsync("git",args,{cwd,windowsHide:true,...options})}}};
// The folders the Files view leaves out, which a new folder's listing leaves out too.
const SKIPPED="-x node_modules/ -x target/ -x dist/ -x build/ -x .next/ -x .cache/ -x desktop-dist/";

test("the Diff tab's read shows staged changes and each new file's lines as git diff shows a file added with git add -N, in two git processes",{timeout:60_000},async()=>{
  const {dir,added}=await agentWorkRepository("trebell-workspace-diff-");
  try{
    const {calls,gitFn}=countingGit();
    const read=await workspaceDiff(dir,{gitFn});
    assert.equal(read.isGit,true);
    // Each new file reads as git diff shows it once added with git add -N (to a copy of the index), but for git's index line.
    const env={...process.env,GIT_INDEX_FILE:join(dir,".git","index-intent")};await copyFile(join(dir,".git","index"),env.GIT_INDEX_FILE);
    await execFileAsync("git",["add","-N","--",...added],{cwd:dir,env,windowsHide:true});
    const own=(await execFileAsync("git",["diff","--no-ext-diff","--no-color","HEAD","--",...added],{cwd:dir,env,windowsHide:true})).stdout.replace(/^index 0+\.\.[0-9a-f]+\n/gm,"");
    const blocks=own.split(/(?=^diff --git )/m);
    assert.equal(blocks.length,added.length);
    for(const block of blocks)assert.ok(read.diff.includes(block),"the new file as git shows it:\n"+block);
    // The edit and the new file staged show beside the edit that is not.
    assert.match(read.diff,/\n-# Seed\n\+# Seeded\n/);
    assert.match(read.diff,/diff --git a\/src\/staged\.js b\/src\/staged\.js\nnew file mode 100644\n[^]*?\n\+export const staged = true;\n/);
    assert.match(read.diff,/\n-export const answer = 42;\n\+export const answer = 43;\n/);
    assert.deepEqual(calls,["status --short","diff --no-ext-diff --no-color HEAD --"],"the status and one diff against HEAD; the new files are read directly");
    // A name git quotes is shown as it is, a file over the Files view's 512 KB is named with its size, and an ignored file is left out.
    assert.match(read.diff,/diff --git a\/café notes\.txt b\/café notes\.txt\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/café notes\.txt\n@@ -0,0 \+1 @@\n\+caf\n/);
    assert.match(read.diff,/diff --git a\/big\.txt b\/big\.txt\nnew file mode 100644\nFile is too large to preview \(586 KB\)\n/);
    assert.doesNotMatch(read.diff,/debug\.log/);
    // The list is git status's, as it was.
    assert.match(read.status,/^\?\? src\/from-agent\.js$/m);assert.match(read.status,/^\?\? "caf\\303\\251 notes\.txt"$/m);
    // A new folder's files are listed by one more git process and shown in its place, its ignored files left out.
    await mkdir(join(dir,"docs","guide"),{recursive:true});await writeFile(join(dir,"docs","guide","intro.md"),"# Intro\n");await writeFile(join(dir,"docs","trace.log"),"left out\n");
    calls.length=0;
    const folder=await workspaceDiff(dir,{gitFn});
    assert.deepEqual(calls,["status --short","diff --no-ext-diff --no-color HEAD --","--literal-pathspecs ls-files --others --exclude-standard "+SKIPPED+" -z -- docs/"]);
    assert.match(folder.diff,/\ndiff --git a\/docs\/guide\/intro\.md b\/docs\/guide\/intro\.md\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/docs\/guide\/intro\.md\n@@ -0,0 \+1 @@\n\+# Intro\n/);
    assert.doesNotMatch(folder.diff,/trace\.log/);
    assert.ok(folder.diff.indexOf("a/docs/guide/intro.md")<folder.diff.indexOf("a/empty.txt"),"the folder's files take its place in git status's order");
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("on a branch with no commit yet the Diff tab's read shows the staged files against the empty tree, and a plain folder says it is no repository",{timeout:30_000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-workspace-unborn-")),plain=await mkdtemp(join(tmpdir(),"trebell-workspace-plain-")),run=args=>execFileAsync("git",args,{cwd:dir,windowsHide:true});
  try{
    await run(["init","-q","-b","main"]);await run(["config","core.autocrlf","false"]);
    await writeFile(join(dir,"staged.txt"),"staged\n");await run(["add","staged.txt"]);await writeFile(join(dir,"staged.txt"),"staged, then edited\n");await writeFile(join(dir,"new.txt"),"new\n");
    const {calls,gitFn}=countingGit();
    const read=await workspaceDiff(dir,{gitFn});
    assert.equal(read.isGit,true);assert.equal(read.error,undefined);
    assert.match(read.diff,/^diff --git a\/staged\.txt b\/staged\.txt\nnew file mode 100644\n[^]*?\n\+staged, then edited\n/);
    assert.match(read.diff,/\ndiff --git a\/new\.txt b\/new\.txt\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/new\.txt\n@@ -0,0 \+1 @@\n\+new\n$/);
    assert.equal(read.status,"AM staged.txt\n?? new.txt\n");
    assert.deepEqual(calls,["status --short","diff --no-ext-diff --no-color HEAD --","diff --no-ext-diff --no-color 4b825dc642cb6eb9a060e54bf8d69288fbee4904 --"]);
    assert.deepEqual(await workspaceDiff(plain),{cwd:plain,isGit:false,status:"",diff:"",error:"This folder is not a Git repository"});
  }finally{for(const folder of [dir,plain])await rm(folder,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("the Diff tab's read shows 200 new files at most and counts the rest on a note line",{timeout:60_000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-workspace-many-")),run=args=>execFileAsync("git",args,{cwd:dir,windowsHide:true});
  try{
    await run(["init","-q","-b","main"]);
    for(let index=0;index<203;index++)await writeFile(join(dir,"new-"+String(index).padStart(3,"0")+".txt"),"line "+index+"\n");
    const read=await workspaceDiff(dir);
    assert.equal((read.diff.match(/^diff --git /gm)||[]).length,200);
    assert.ok(read.diff.endsWith("diff --git a/new-199.txt b/new-199.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new-199.txt\n@@ -0,0 +1 @@\n+line 199\n\\ 3 more new files are not shown.\n"),read.diff.slice(-200));
    assert.equal(read.status.split("\n").filter(Boolean).length,203,"the list still names every one");
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

// git diff can write more than the 4 MB the read keeps: here a large file is staged beside an unstaged edit and a new file. What
// git wrote by then shows, up to its last whole line, with a note that the rest does not, and the list and the new file beside it.
// The whole read used to fail: the Diff tab said "Could not load changes" and lost its list too, and Generate's commit text got an
// empty status and an empty diff.
test("a diff over the 4 MB the Diff tab's read keeps shows what fits with a note, beside the whole list and the new files",{timeout:60_000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-workspace-big-diff-")),run=args=>execFileAsync("git",args,{cwd:dir,windowsHide:true});
  try{
    await run(["init","-q","-b","main"]);await run(["config","user.email","diff@example.test"]);await run(["config","user.name","Diff Test"]);await run(["config","core.autocrlf","false"]);
    await writeFile(join(dir,"app.js"),"export const answer = 42;\n");await run(["add","-A"]);await run(["commit","-qm","seed"]);
    await writeFile(join(dir,"app.js"),"export const answer = 43;\n");
    const data=JSON.stringify({rows:Array.from({length:150_000},(_,index)=>({id:index,name:"row "+index}))},null,1);
    assert.ok(Buffer.byteLength(data)>5*1024*1024);
    await writeFile(join(dir,"data.json"),data);await run(["add","data.json"]);await writeFile(join(dir,"notes.md"),"# Notes\n");
    const read=await workspaceDiff(dir);
    assert.equal(read.isGit,true);assert.equal(read.error,undefined);
    assert.equal(read.status," M app.js\nA  data.json\n?? notes.md\n","the whole list");
    assert.match(read.diff,/^diff --git a\/app\.js b\/app\.js\n[^]*?\n-export const answer = 42;\n\+export const answer = 43;\n/);
    assert.match(read.diff,/\ndiff --git a\/data\.json b\/data\.json\nnew file mode 100644\n/);
    const note="\\ The rest of the diff is not shown: it is over 4 MB.\n",at=read.diff.indexOf(note);
    assert.ok(at>0,"a note says the rest is not shown");
    // Up to its last whole line: the line before the note is one of the file's own.
    const shown=read.diff.slice(0,at),last=shown.slice(shown.lastIndexOf("\n",shown.length-2)+1,-1);
    assert.ok(Buffer.byteLength(shown)<=4*1024*1024);
    assert.ok(last.startsWith("+")&&data.split("\n").includes(last.slice(1)),"a whole line of data.json: "+JSON.stringify(last));
    assert.equal(read.diff.slice(at+note.length),"diff --git a/notes.md b/notes.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1 @@\n+# Notes\n","the new file after it");
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

// A node_modules/ git does not ignore (packages an agent installed before it wrote a .gitignore) sorts before package.json and src/:
// its files took the 200 new files shown, and the agent's own were only counted on the note line. A new folder the Files view leaves
// out is named on a note line instead and not listed, and one inside a new folder is not listed either.
test("new files in a folder the Files view leaves out are named, not shown, so they never crowd out the agent's own",{timeout:120_000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-workspace-skipped-")),run=args=>execFileAsync("git",args,{cwd:dir,windowsHide:true});
  try{
    await run(["init","-q","-b","main"]);await run(["config","user.email","diff@example.test"]);await run(["config","user.name","Diff Test"]);await run(["config","core.autocrlf","false"]);
    await writeFile(join(dir,"README.md"),"# Seed\n");await run(["add","-A"]);await run(["commit","-qm","seed"]);
    for(let index=0;index<300;index++){await mkdir(join(dir,"node_modules","pkg-"+index),{recursive:true});await writeFile(join(dir,"node_modules","pkg-"+index,"index.js"),"module.exports = "+index+";\n")}
    await writeFile(join(dir,"package.json"),"{\"name\":\"app\"}\n");await mkdir(join(dir,"src"));await writeFile(join(dir,"src","index.js"),"console.log(\"app\");\n");
    await mkdir(join(dir,"web","node_modules","dep"),{recursive:true});await mkdir(join(dir,"web","src"));
    await writeFile(join(dir,"web","node_modules","dep","index.js"),"module.exports = 1;\n");await writeFile(join(dir,"web","src","app.js"),"export default 1;\n");
    const {calls,gitFn}=countingGit();
    const read=await workspaceDiff(dir,{gitFn});
    assert.equal(read.status,"?? node_modules/\n?? package.json\n?? src/\n?? web/\n");
    assert.deepEqual(read.diff.match(/^diff --git a\/\S+/gm),["diff --git a/package.json","diff --git a/src/index.js","diff --git a/web/src/app.js"],"the agent's files, none of the packages'");
    assert.ok(read.diff.endsWith("+export default 1;\n\\ New files in node_modules/ are not shown.\n"),read.diff.slice(-200));
    assert.deepEqual(calls,["status --short","diff --no-ext-diff --no-color HEAD --","--literal-pathspecs ls-files --others --exclude-standard "+SKIPPED+" -z -- src/ web/"],"node_modules/ is never listed");
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

// The shell a remote environment runs its commands in: sh, or on Windows the one Git for Windows ships.
async function posixShell(){
  if(process.platform!=="win32")return "sh";
  const sh=join(dirname(dirname(dirname((await execFileAsync("git",["--exec-path"],{windowsHide:true})).stdout.trim()))),"bin","sh.exe");
  return existsSync(sh)?sh:null;
}
// The read's script now runs about twenty commands where it ran eight (the caps below), each of which sh on Windows starts slowly on
// a loaded host: two reads and the repository's setup took over the 60 s this test had there, as they take under 40 s alone.
test("a remote environment's Diff tab read shows its staged changes and new files from one session's git diff, and leaves its index as it was",{timeout:180_000},async t=>{
  const shell=await posixShell();if(!shell){t.skip("no POSIX shell to run the remote script in");return}
  const {dir,run,added}=await agentWorkRepository("trebell-workspace-remote-diff-"),unborn=await mkdtemp(join(tmpdir(),"trebell-workspace-remote-unborn-"));
  try{
    // An environment whose commands run here, through the shell a host would run them in.
    const sessions=[],environments={
      get:id=>id==="ssh-a"?{id:"ssh-a",name:"Build box",type:"ssh",cwd:dir}:null,
      executeArgv:async(_id,{command,args,cwd})=>{sessions.push(command+" "+args[0]);return execFileAsync(command==="sh"?shell:command,args,{cwd,windowsHide:true,maxBuffer:8*1024*1024}).then(result=>({exitCode:0,...result}),error=>({exitCode:error.code,stdout:error.stdout||"",stderr:error.stderr||""}))},
    };
    const before=(await run(["status","--porcelain"])).stdout;
    const read=await environmentWorkspaceDiff(dir,{environments,environmentId:"ssh-a"});
    assert.equal(read.isGit,true);
    assert.match(read.diff,/\n\+\+\+ b\/src\/from-agent\.js\n@@ -0,0 \+1 @@\n\+export const fromAgent = true;\n/);
    for(const path of added)assert.match(read.diff,new RegExp("^diff --git a/"+path.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+" b/","m"),path);
    assert.match(read.diff,/\nBinary files \/dev\/null and b\/blob\.bin differ\n/);
    assert.match(read.diff,/\n-# Seed\n\+# Seeded\n/);assert.match(read.diff,/\n\+export const staged = true;\n/);assert.match(read.diff,/\n-export const answer = 42;\n\+export const answer = 43;\n/);
    assert.doesNotMatch(read.diff,/debug\.log/);
    assert.deepEqual(sessions,["git rev-parse","sh -c","git status"],"three sessions, as before: the new files come with the diff");
    assert.equal((await run(["status","--porcelain"])).stdout,before,"the repository's own index is left as it was");
    // A branch with no commit yet is compared with the empty tree.
    await execFileAsync("git",["init","-q","-b","main"],{cwd:unborn,windowsHide:true});await writeFile(join(unborn,"first.txt"),"first\n");
    const first=await environmentWorkspaceDiff(unborn,{environments,environmentId:"ssh-a"});
    assert.match(first.diff,/^diff --git a\/first\.txt b\/first\.txt\nnew file mode 100644\n[^]*?\n\+first\n/);
  }finally{for(const folder of [dir,unborn])await rm(folder,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

// A remote environment's read keeps the local one's order and caps. A session keeps 2 MB of output unless told more and drops the rest
// without a word (runProcess), and the new files used to come in path order with the rest: a 3 MB new data/run.csv, which sorts
// before src/, filled it and the edit to src/app.js was gone. Now the tracked changes come first, a new file over 512 KB is named
// with its size, 200 new files at most are shown with the rest counted, and node_modules/ is named, not listed.
test("a remote environment's Diff tab read shows the tracked changes first and caps the new files as the local read does",{timeout:180_000},async t=>{
  const shell=await posixShell();if(!shell){t.skip("no POSIX shell to run the remote script in");return}
  const dir=await mkdtemp(join(tmpdir(),"trebell-workspace-remote-caps-")),run=args=>execFileAsync("git",args,{cwd:dir,windowsHide:true});
  try{
    await run(["init","-q","-b","main"]);await run(["config","user.email","diff@example.test"]);await run(["config","user.name","Diff Test"]);await run(["config","core.autocrlf","false"]);
    await mkdir(join(dir,"src"));await writeFile(join(dir,"src","app.js"),"export const answer = 42;\n");await run(["add","-A"]);await run(["commit","-qm","seed"]);
    await writeFile(join(dir,"src","app.js"),"export const answer = 43;\n");
    await mkdir(join(dir,"data"));await writeFile(join(dir,"data","run.csv"),"a,b\n".repeat(750_000));
    await mkdir(join(dir,"notes"));for(let index=0;index<203;index++)await writeFile(join(dir,"notes","note-"+String(index).padStart(3,"0")+".txt"),"note "+index+"\n");
    await mkdir(join(dir,"node_modules","left-pad"),{recursive:true});await writeFile(join(dir,"node_modules","left-pad","index.js"),"module.exports = 1;\n");
    // An environment whose commands run here through the shell a host would run them in, keeping as much output as runProcess does.
    const kept={},environments={
      get:id=>id==="ssh-a"?{id:"ssh-a",name:"Build box",type:"ssh",cwd:dir}:null,
      executeArgv:async(_id,{command,args,cwd,maxOutput=2*1024*1024})=>{
        const result=await execFileAsync(command==="sh"?shell:command,args,{cwd,windowsHide:true,maxBuffer:64*1024*1024}).then(done=>({exitCode:0,...done}),error=>({exitCode:error.code,stdout:error.stdout||"",stderr:error.stderr||""}));
        const keep=text=>Buffer.from(String(text||"")).subarray(0,maxOutput).toString("utf8").replace(/\r/g,"").trimEnd();
        kept[command]=Buffer.byteLength(String(result.stdout||""));
        return {...result,stdout:keep(result.stdout),stderr:keep(result.stderr)};
      },
    };
    const before=(await run(["status","--porcelain"])).stdout;
    const read=await environmentWorkspaceDiff(dir,{environments,environmentId:"ssh-a"});
    assert.equal(read.isGit,true);
    assert.match(read.diff,/^diff --git a\/src\/app\.js b\/src\/app\.js\n[^]*?\n-export const answer = 42;\n\+export const answer = 43;\n/,"the edit first");
    assert.match(read.diff,/\ndiff --git a\/data\/run\.csv b\/data\/run\.csv\nnew file mode 100644\nFile is too large to preview \(2930 KB\)\n/);
    assert.match(read.diff,/\ndiff --git a\/notes\/note-000\.txt b\/notes\/note-000\.txt\nnew file mode 100644\n[^]*?\n\+note 0\n/);
    assert.equal((read.diff.match(/^diff --git a\/notes\//gm)||[]).length,199,"200 new files with data/run.csv");
    assert.doesNotMatch(read.diff,/note-199\.txt|node_modules\/left-pad/);
    assert.ok(read.diff.endsWith("\\ 4 more new files are not shown.\n\\ New files in node_modules/ are not shown.\n"),read.diff.slice(-300));
    assert.ok(kept.sh<2*1024*1024,"all of it is under what a session keeps ("+kept.sh+" bytes)");
    assert.equal((await run(["status","--porcelain"])).stdout,before,"the repository's own index is left as it was");
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});
