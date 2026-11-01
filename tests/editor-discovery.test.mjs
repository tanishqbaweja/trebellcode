import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { EDITOR_SPECS, discoverEditors, editorCommandNames, listEditors, resolveEditorExecutable, startEditor } from "../desktop/editor-discovery.mjs";

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
  assert.deepEqual(launches,[["/opt/zed",["/repo"],{detached:true,stdio:"ignore"}]],"no windowsHide: a GUI editor's first ShowWindow would take its SW_HIDE");
  const missing=child();
  // The reason is said in words, not as spawn's "spawn <path> ENOENT" (lane H, p110: Open in Zed after Zed.exe was removed).
  await assert.rejects(startEditor({label:"Visual Studio Code",executable:"D:\\VS Code\\bin\\code"},"D:\\repo",{spawnFn:()=>{setImmediate(()=>missing.emit("error",Object.assign(new Error("spawn D:\\VS Code\\bin\\code ENOENT"),{code:"ENOENT"})));return missing}}),
    {message:"Could not start Visual Studio Code: it is no longer at D:\\VS Code\\bin\\code."});
  await assert.rejects(startEditor({label:"Cursor",executable:"C:\\Cursor\\cursor.cmd"},"C:\\repo",{spawnFn:()=>{throw Object.assign(new Error("spawn EINVAL"),{code:"EINVAL"})}}),{message:"Could not start Cursor: C:\\Cursor\\cursor.cmd could not be run."});
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

// A GUI program's first ShowWindow takes the show state in its start-up info, where windowsHide puts SW_HIDE. The stand-in editor
// is an Electron app that creates its window shown, as VS Code and Cursor do for a window that is not maximized, writes whether
// Windows shows it (renamed into place, so the test never reads half of it) and quits at once; the window sits off screen and
// transparent. A start with windowsHide shows the stand-in can tell.
const electron=new URL("../node_modules/electron/dist/electron.exe",import.meta.url);
test("an editor that Open starts shows its window",{skip:process.platform!=="win32"||!existsSync(electron)||Boolean(process.env.ELECTRON_RUN_AS_NODE),timeout:90_000},async t=>{
  const folder=await mkdtemp(join(tmpdir(),"trebell-editor-window-")),result=join(folder,"result.json"),executable=fileURLToPath(electron);
  const shown=async start=>{
    await rm(result,{force:true});await start();
    for(const until=Date.now()+60_000;!existsSync(result)&&Date.now()<until;)await new Promise(resolve=>setTimeout(resolve,50));
    return existsSync(result)?JSON.parse(readFileSync(result,"utf8")).visible:null;
  };
  try{
    await writeFile(join(folder,"package.json"),JSON.stringify({name:"trebell-stand-in-editor",version:"1.0.0",main:"main.cjs"}));
    await writeFile(join(folder,"main.cjs"),`const {app,BrowserWindow}=require("electron"),{renameSync,writeFileSync}=require("node:fs"),{join}=require("node:path");
for(const name of ["userData","sessionData","crashDumps","logs"])app.setPath(name,join(__dirname,"data-"+process.pid,name));
app.commandLine.appendSwitch("disable-gpu");
app.whenReady().then(()=>{const win=new BrowserWindow({show:true,x:-32000,y:-32000,width:200,height:100,opacity:0,skipTaskbar:true});writeFileSync(join(__dirname,"result.tmp"),JSON.stringify({visible:win.isVisible()}));renameSync(join(__dirname,"result.tmp"),join(__dirname,"result.json"));app.exit(0)});
`);
    const hidden=await shown(()=>{spawn(executable,[folder],{detached:true,stdio:"ignore",windowsHide:true}).unref()});
    assert.notEqual(hidden,null,"the stand-in editor started");
    if(hidden){t.skip("this Electron shows its window whatever the start-up info says, so the stand-in cannot tell");return}
    // Open passes the folder as the editor's only argument; Electron runs it as the app.
    assert.equal(await shown(()=>startEditor({label:"Stand-in editor",executable},folder)),true,"the window of the editor Open started shows");
  }finally{await new Promise(resolve=>setTimeout(resolve,1000));await rm(folder,{recursive:true,force:true,maxRetries:20,retryDelay:200})}
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

// The order is the picker's: with no saved choice it opens the first editor found. The ids are what it saves, so an id that
// shipped stays with its editor.
test("the editor list runs from Visual Studio Code and its builds to Zed and Sublime Text to JetBrains' IDEs, each id and command once",()=>{
  assert.deepEqual(EDITOR_SPECS.map(entry=>entry.id),["vscode","vscode-insiders","vscodium","antigravity","cursor","kiro","trae","windsurf","zed","sublime-text",
    "aqua","clion","datagrip","dataspell","goland","idea","phpstorm","pycharm","rider","rubymine","rustrover","webstorm"]);
  const commands=EDITOR_SPECS.flatMap(entry=>entry.commands);
  assert.equal(new Set(commands).size,commands.length,"no command belongs to two editors");
  assert.deepEqual(editorCommandNames(),commands);
  assert.deepEqual(EDITOR_SPECS.find(entry=>entry.id==="zed").commands,["zed","zeditor","zedit"]);
});

const lookIn=(folders,files)=>({exists:path=>files.includes(path),readDirectory:path=>(folders[path]||[]).map(dir)});
const found=editors=>Object.fromEntries(editors.map(editor=>[editor.id,editor.executable]));

test("macOS discovery finds app bundles in either Applications folder when PATH has no command",async()=>{
  const files=["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code","/Users/dev/Applications/Zed.app/Contents/MacOS/cli",
    "/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl","/Users/dev/Applications/IntelliJ IDEA CE.app/Contents/MacOS/idea",
    "/Applications/JetBrains Rider.app/Contents/MacOS/rider","/Users/dev/Library/Application Support/JetBrains/Toolbox/scripts/pycharm"];
  const folders={"/Users/dev/Applications":["Zed.app","IntelliJ IDEA CE.app"],"/Applications":["Visual Studio Code.app","Sublime Text.app","JetBrains Rider.app","Riderless.app"]};
  const editors=await discoverEditors({platform:"darwin",env:{HOME:"/Users/dev"},commandFinder:missingCommand,...lookIn(folders,files)});
  assert.deepEqual(found(editors),{vscode:files[0],zed:files[1],"sublime-text":files[2],idea:files[3],pycharm:files[5],rider:files[4]});
});

test("Windows discovery finds Zed, Sublime Text and Toolbox 2 installs, and the newest of two JetBrains versions",async()=>{
  const env={LOCALAPPDATA:"C:\\Users\\dev\\AppData\\Local",ProgramFiles:"C:\\Program Files",ProgramW6432:"C:\\Program Files"};
  const programs="C:\\Users\\dev\\AppData\\Local\\Programs",jetbrains="C:\\Program Files\\JetBrains";
  const files=[programs+"\\Zed\\Zed.exe","C:\\Program Files\\Sublime Text\\subl.exe",programs+"\\Rider\\bin\\rider64.exe",
    jetbrains+"\\IntelliJ IDEA 2025.1\\bin\\idea64.exe",jetbrains+"\\IntelliJ IDEA 2026.2\\bin\\idea64.exe",jetbrains+"\\PyCharm Community Edition 2024.3\\bin\\pycharm64.exe"];
  const folders={[programs]:["Zed","Rider"],[jetbrains]:["IntelliJ IDEA 2025.1","IntelliJ IDEA 2026.2","PyCharm Community Edition 2024.3"]};
  const editors=await discoverEditors({platform:"win32",env,commandFinder:missingCommand,...lookIn(folders,files)});
  assert.deepEqual(found(editors),{zed:files[0],"sublime-text":files[1],idea:files[4],pycharm:files[5],rider:files[2]});
});

test("Linux discovery skips ZFS's zed in sbin for a packaged zeditor, and finds Zed's own install and Toolbox scripts",async()=>{
  const which=(stdout)=>(file,args,_options,callback)=>callback(null,stdout,"");
  const packaged=await discoverEditors({platform:"linux",env:{HOME:"/home/dev"},exec:which("/usr/sbin/zed\n/usr/bin/zeditor\n"),exists:()=>false,readDirectory:()=>[]});
  assert.deepEqual(found(packaged),{zed:"/usr/bin/zeditor"});
  const own=["/home/dev/.local/zed.app/bin/zed","/data/JetBrains/Toolbox/scripts/idea","/home/dev/.local/share/JetBrains/Toolbox/scripts/goland"];
  const installed=await discoverEditors({platform:"linux",env:{HOME:"/home/dev",XDG_DATA_HOME:"/data"},exec:which(""),exists:path=>own.includes(path),readDirectory:()=>[]});
  assert.deepEqual(found(installed),{zed:own[0],idea:own[1]});
  // A relative XDG_DATA_HOME is not a valid one, so the default folder is used.
  const relative=await discoverEditors({platform:"linux",env:{HOME:"/home/dev",XDG_DATA_HOME:"data"},exec:which(""),exists:path=>own.includes(path),readDirectory:()=>[]});
  assert.deepEqual(found(relative),{zed:own[0],goland:own[2]});
});

// Google's terminal agent installs as agy too; the editor's own antigravity launcher is taken when both are on PATH.
test("Windows discovery takes the Antigravity editor's launcher over an agy that may be the terminal agent",async()=>{
  const exec=(_file,_args,_options,callback)=>callback(null,"C:\\Ide\\bin\\antigravity.cmd\r\nC:\\Tools\\agy.exe\r\n","");
  const editors=await discoverEditors({platform:"win32",env:{PATHEXT:".EXE;.CMD"},exec,exists:path=>path==="C:\\Ide\\Antigravity.exe",
    readFile:path=>path==="C:\\Ide\\bin\\antigravity.cmd"?"@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n\"%~DP0..\\Antigravity.exe\" \"%~DP0..\\resources\\app\\out\\cli.js\" %*\r\n":"",
    readDirectory:()=>[]});
  assert.deepEqual(found(editors),{antigravity:"C:\\Ide\\Antigravity.exe"});
});

test("the older Toolbox tree is read a bounded number of folders deep and wide",async()=>{
  // 1000 tools, each with a channel holding a build: every folder below apps answers one sub-folder, down to the builds.
  const apps="C:\\Users\\dev\\AppData\\Local\\JetBrains\\Toolbox\\apps",depth=path=>path.slice(apps.length).split("\\").length-1;
  let reads=0;
  const readDirectory=path=>{if(!path.startsWith(apps))return [];reads++;return path===apps?Array.from({length:1000},(_,i)=>dir("tool-"+i)):depth(path)<3?[dir("x-"+depth(path))]:[]};
  assert.equal(await resolveEditorExecutable(EDITOR_SPECS.find(entry=>entry.id==="idea"),{platform:"win32",env:{LOCALAPPDATA:"C:\\Users\\dev\\AppData\\Local"},commandFinder:missingCommand,exists:()=>false,readDirectory}),null);
  assert.ok(reads>=100&&reads<=200,`${reads} folders read`);
});

test("a discovery that fails is not kept, so the next list looks for the editors again",async()=>{
  let clock=9_000_000,discoveries=0;
  const zed={id:"zed",label:"Zed",executable:"/opt/zed"};
  const discover=async()=>{discoveries++;if(discoveries===1)throw new Error("where did not answer");return [zed]};
  await assert.rejects(listEditors({refresh:true,now:()=>clock,discover}),{message:"where did not answer"});
  clock+=1000;
  assert.deepEqual(await listEditors({now:()=>clock,discover}),[zed]);
  assert.equal(discoveries,2);
});
