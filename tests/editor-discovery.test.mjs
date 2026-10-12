import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { EDITOR_SPECS, discoverEditors, listEditors, resolveEditorExecutable, startEditor } from "../desktop/editor-discovery.mjs";

const missingCommand=async()=>null;
const dir=name=>({name,isDirectory:()=>true});

test("editor discovery covers the broader desktop editor set",()=>{
  const ids=new Set(EDITOR_SPECS.map(item=>item.id));
  for(const id of ["cursor","trae","kiro","vscode","vscodium","windsurf","zed","antigravity","idea","aqua","clion","datagrip","dataspell","goland","phpstorm","pycharm","rider","rubymine","rustrover","webstorm"])assert.equal(ids.has(id),true,id);
});

test("Windows editor discovery finds normal GUI installs even when PATH has no launcher",async()=>{
  const env={LOCALAPPDATA:"C:\\Users\\dev\\AppData\\Local",ProgramFiles:"C:\\Program Files"};
  const expected=win32.join(env.LOCALAPPDATA,"Programs","Microsoft VS Code","Code.exe");
  const spec=EDITOR_SPECS.find(item=>item.id==="vscode");
  const resolved=await resolveEditorExecutable(spec,{platform:"win32",env,commandFinder:missingCommand,exists:path=>path===expected,readDirectory:()=>[]});
  assert.equal(resolved,expected);
});

test("Windows JetBrains discovery scans versioned install directories outside PATH",async()=>{
  const env={LOCALAPPDATA:"C:\\Users\\dev\\AppData\\Local",ProgramFiles:"C:\\Program Files"};
  const jetbrains=win32.join(env.ProgramFiles,"JetBrains");
  const expected=win32.join(jetbrains,"IntelliJ IDEA 2026.2","bin","idea64.exe");
  const spec=EDITOR_SPECS.find(item=>item.id==="idea");
  const resolved=await resolveEditorExecutable(spec,{
    platform:"win32",env,commandFinder:missingCommand,
    exists:path=>path===expected,
    readDirectory:path=>path===jetbrains?[dir("IntelliJ IDEA 2026.2")]:[],
  });
  assert.equal(resolved,expected);
});

test("Windows JetBrains discovery reaches bounded Toolbox app installs",async()=>{
  const env={LOCALAPPDATA:"C:\\Users\\dev\\AppData\\Local"};
  const root=win32.join(env.LOCALAPPDATA,"JetBrains","Toolbox","apps");
  const a=win32.join(root,"IDEA-U"),b=win32.join(a,"ch-0"),version=win32.join(b,"262.100"),bin=win32.join(version,"bin");
  const expected=win32.join(bin,"idea64.exe");
  const map=new Map([[root,[dir("IDEA-U")]],[a,[dir("ch-0")]],[b,[dir("262.100")]],[version,[dir("bin")]],[bin,[]]]);
  const spec=EDITOR_SPECS.find(item=>item.id==="idea");
  const resolved=await resolveEditorExecutable(spec,{platform:"win32",env,commandFinder:missingCommand,exists:path=>path===expected,readDirectory:path=>map.get(path)||[]});
  assert.equal(resolved,expected);
});

test("editor discovery still prefers a real PATH launcher when available",async()=>{
  const spec=EDITOR_SPECS.find(item=>item.id==="zed");
  const resolved=await resolveEditorExecutable(spec,{platform:"linux",env:{HOME:"/home/dev"},commandFinder:async command=>command==="zed"?"/opt/bin/zed":null,exists:()=>false,readDirectory:()=>[]});
  assert.equal(resolved,"/opt/bin/zed");
});

test("discoverEditors omits editors that are not actually installed",async()=>{
  const result=await discoverEditors({platform:"linux",env:{HOME:"/home/dev"},commandFinder:missingCommand,exists:()=>false,readDirectory:()=>[]});
  assert.deepEqual(result,[]);
});

// where lists VS Code's extensionless bin\code before bin\code.cmd; execFile could not start the first, and Open answered ok.
test("Windows discovery skips an extensionless shim that where lists first and takes the program its .cmd launcher runs",async()=>{
  const bin="D:\\Apps\\Microsoft VS Code\\bin",program="D:\\Apps\\Microsoft VS Code\\Code.exe",calls=[];
  const exec=(file,args,_options,callback)=>{calls.push([file,...args]);callback(null,bin+"\\code\r\n"+bin+"\\code.cmd\r\nC:\\Tools\\agy.exe\r\n","INFO: Could not find \"cursor\".\r\n")};
  const editors=await discoverEditors({platform:"win32",env:{PATHEXT:".COM;.EXE;.BAT;.CMD"},exec,
    readFile:path=>path===bin+"\\code.cmd"?"@echo off\r\n\"%~dp0..\\Code.exe\" \"%~dp0..\\resources\\app\\out\\cli.js\" %*\r\n":"",
    exists:path=>path===program,readDirectory:()=>[]});
  assert.deepEqual(editors.map(editor=>editor.id+"="+editor.executable),["vscode="+program,"antigravity=C:\\Tools\\agy.exe"]);
  assert.equal(calls.length,1,"one where launch looks up every editor");
  assert.equal(calls[0][0],"where");assert.ok(calls[0].includes("code")&&calls[0].includes("idea")&&calls[0].includes("zeditor"));
});

test("an editor that cannot be started is reported instead of answered as opened",async()=>{
  const child=()=>{const emitter=new EventEmitter();emitter.unref=()=>{emitter.unrefed=true};return emitter};
  const started=child(),launches=[];
  const opening=startEditor({label:"Zed",executable:"/opt/zed"},"/repo",{spawnFn:(...launch)=>{launches.push(launch);setImmediate(()=>started.emit("spawn"));return started}});
  await opening;assert.equal(started.unrefed,true);
  assert.deepEqual(launches,[["/opt/zed",["/repo"],{detached:true,stdio:"ignore",windowsHide:true}]]);
  const missing=child();
  await assert.rejects(startEditor({label:"Visual Studio Code",executable:"D:\\VS Code\\bin\\code"},"D:\\repo",{spawnFn:()=>{setImmediate(()=>missing.emit("error",Object.assign(new Error("spawn D:\\VS Code\\bin\\code ENOENT"),{code:"ENOENT"})));return missing}}),
    /Could not start Visual Studio Code: spawn .* ENOENT/);
  await assert.rejects(startEditor({label:"Cursor",executable:"C:\\Cursor\\cursor.cmd"},"C:\\repo",{spawnFn:()=>{throw Object.assign(new Error("spawn EINVAL"),{code:"EINVAL"})}}),/Could not start Cursor: spawn EINVAL/);
});

// On Windows a child that is not detached sits in the opener's kill-on-close job, so quitting Trebell would end the editor it opened.
test("an editor that Open started keeps running after the app that opened it quits",{timeout:30_000},async()=>{
  const folder=await mkdtemp(join(tmpdir(),"trebell-editor-life-")),editor=join(folder,"editor.cjs"),pidFile=join(folder,"editor.pid");
  try{
    // A stand-in editor writes its process id and stays; a stand-in for Electron's main process opens it and quits at once.
    await writeFile(editor,"require('fs').writeFileSync(process.env.TREBELL_EDITOR_PID_FILE,String(process.pid));setTimeout(()=>{},20000);\n");
    const opener=`const {startEditor}=await import(process.argv[1]);await startEditor({label:"Stand-in editor",executable:process.execPath},process.argv[2]);const {existsSync}=await import("node:fs");const until=Date.now()+10000;while(!existsSync(process.argv[3])&&Date.now()<until)await new Promise(r=>setTimeout(r,50));process.exit(0)`;
    const quit=spawnSync(process.execPath,["--input-type=module","-e",opener,new URL("../desktop/editor-discovery.mjs",import.meta.url).href,editor,pidFile],{windowsHide:true,env:{...process.env,TREBELL_EDITOR_PID_FILE:pidFile},timeout:20000});
    assert.equal(quit.status,0,String(quit.stderr));assert.ok(existsSync(pidFile),"the editor started");
    const pid=Number(readFileSync(pidFile,"utf8"));await new Promise(resolve=>setTimeout(resolve,500));
    let alive=true;try{process.kill(pid,0)}catch{alive=false}
    if(alive)process.kill(pid);
    assert.equal(alive,true,"the editor ended when the process that opened it quit");
  }finally{await rm(folder,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});

test("the editor list is kept for the app run, shared while it is found, and found again after ten minutes or on refresh",async()=>{
  let clock=5_000_000,discoveries=0;
  const discover=async()=>{discoveries++;return [{id:"zed",label:"Zed",executable:"/opt/zed"}]};
  const options={now:()=>clock,discover};
  const [first,second]=await Promise.all([listEditors({...options,refresh:true}),listEditors(options)]);
  assert.equal(discoveries,1);assert.deepEqual(first,second);assert.notEqual(first[0],second[0],"each caller gets its own copy");
  clock+=9*60_000;await listEditors(options);assert.equal(discoveries,1);
  clock+=60_000;await listEditors(options);assert.equal(discoveries,2);
  await listEditors({...options,refresh:true});assert.equal(discoveries,3);
});
