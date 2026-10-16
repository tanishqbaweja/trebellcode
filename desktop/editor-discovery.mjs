import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { posix, win32 } from "node:path";
import { windowsCommandShimTarget } from "../src/windows-command-shim.mjs";

const JETBRAINS_NAMES={
  idea:["IntelliJ IDEA","IntelliJ IDEA CE","IntelliJ IDEA Ultimate"],
  aqua:["Aqua"],
  clion:["CLion"],
  datagrip:["DataGrip"],
  dataspell:["DataSpell"],
  goland:["GoLand"],
  phpstorm:["PhpStorm"],
  pycharm:["PyCharm","PyCharm CE"],
  rider:["Rider","JetBrains Rider"],
  rubymine:["RubyMine"],
  rustrover:["RustRover"],
  webstorm:["WebStorm"],
};

export const EDITOR_SPECS=[
  {id:"cursor",label:"Cursor",commands:["cursor"],windowsName:"Cursor"},
  {id:"trae",label:"Trae",commands:["trae"],windowsName:"Trae"},
  {id:"kiro",label:"Kiro",commands:["kiro"],windowsName:"Kiro"},
  {id:"vscode",label:"Visual Studio Code",commands:["code"],windowsName:"Microsoft VS Code",windowsExecutable:"Code.exe",macNames:["Visual Studio Code"]},
  {id:"vscode-insiders",label:"VS Code Insiders",commands:["code-insiders"],windowsName:"Microsoft VS Code Insiders",windowsExecutable:"Code - Insiders.exe",macNames:["Visual Studio Code - Insiders"]},
  {id:"vscodium",label:"VSCodium",commands:["codium"],windowsName:"VSCodium"},
  {id:"windsurf",label:"Windsurf",commands:["windsurf"],windowsName:"Windsurf"},
  {id:"zed",label:"Zed",commands:["zed","zeditor"],windowsName:"Zed"},
  {id:"antigravity",label:"Antigravity",commands:["agy"],windowsName:"Antigravity"},
  ...Object.entries(JETBRAINS_NAMES).map(([id,names])=>({id,label:names[0],commands:[id],jetbrains:true,installNames:names})),
];

function safeDirectoryEntries(path,readDirectory){
  try{return readDirectory(path,{withFileTypes:true})||[]}catch{return []}
}

function platformPath(platform){return platform==="win32"?win32:posix}

function standardCandidates(spec,{platform,env,readDirectory}){
  const path=platformPath(platform);const candidates=[];
  if(platform==="win32"){
    const roots=[
      env.LOCALAPPDATA?path.join(env.LOCALAPPDATA,"Programs"):null,
      env.ProgramFiles||null,
      env["ProgramFiles(x86)"]||null,
      env.ProgramW6432||null,
    ].filter(Boolean);
    if(spec.jetbrains){
      const command=spec.commands[0],names=spec.installNames||[spec.label];
      for(const root of roots){
        for(const directory of [root,path.join(root,"JetBrains")]){
          for(const entry of safeDirectoryEntries(directory,readDirectory)){
            const name=typeof entry==="string"?entry:entry?.name;
            const isDirectory=typeof entry==="string"?true:entry?.isDirectory?.();
            if(!name||!isDirectory||!names.some(prefix=>name===prefix||name.startsWith(prefix+" ")))continue;
            candidates.push(path.join(directory,name,"bin",command+"64.exe"),path.join(directory,name,"bin",command+".exe"));
          }
        }
      }
    }else{
      const name=spec.windowsName||spec.label;
      const executable=spec.windowsExecutable||name+".exe";
      for(const root of roots)candidates.push(path.join(root,name,executable),path.join(root,name,"bin",executable));
      if(spec.id==="zed")for(const root of roots)candidates.push(path.join(root,name,"zed.exe"),path.join(root,name,"bin","zed.exe"));
    }
  }else if(platform==="darwin"){
    const home=env.HOME||env.USERPROFILE||"";
    const roots=[home?path.join(home,"Applications"):null,"/Applications"].filter(Boolean);
    const names=spec.installNames||spec.macNames||[spec.label];
    for(const root of roots){
      for(const name of names){
        const contents=path.join(root,name+".app","Contents");
        if(spec.jetbrains)candidates.push(path.join(contents,"MacOS",spec.commands[0]));
        else if(spec.id==="zed")candidates.push(path.join(contents,"MacOS","cli"));
        else{
          for(const command of spec.commands)candidates.push(path.join(contents,"Resources","app","bin",command));
          candidates.push(path.join(contents,"Resources","app","bin","code"));
        }
      }
    }
    if(spec.jetbrains&&home)candidates.push(path.join(home,"Library","Application Support","JetBrains","Toolbox","scripts",spec.commands[0]));
  }else{
    const home=env.HOME||"";
    const roots=[home?path.join(home,".local","bin"):null,"/usr/local/bin","/usr/bin","/snap/bin"].filter(Boolean);
    if(spec.jetbrains){
      const dataHome=env.XDG_DATA_HOME||(home?path.join(home,".local","share"):null);
      if(dataHome)roots.push(path.join(dataHome,"JetBrains","Toolbox","scripts"));
    }
    for(const root of roots)for(const command of spec.commands)candidates.push(path.join(root,command));
  }
  return candidates;
}

function toolboxCandidates(spec,{platform,env,readDirectory,maxEntries=800}){
  if(platform!=="win32"||!spec.jetbrains||!env.LOCALAPPDATA)return [];
  const root=win32.join(env.LOCALAPPDATA,"JetBrains","Toolbox","apps");
  const queue=[{path:root,depth:0}];const candidates=[];let seen=0;
  const commands=spec.commands;
  while(queue.length&&seen<maxEntries){
    const current=queue.shift();
    for(const entry of safeDirectoryEntries(current.path,readDirectory)){
      if(seen++>=maxEntries)break;
      const name=typeof entry==="string"?entry:entry?.name;
      const isDirectory=typeof entry==="string"?true:entry?.isDirectory?.();
      if(!name||!isDirectory)continue;
      const full=win32.join(current.path,name);
      if(name.toLowerCase()==="bin"){
        for(const command of commands)candidates.push(win32.join(full,command+"64.exe"),win32.join(full,command+".exe"));
      }else if(current.depth<5)queue.push({path:full,depth:current.depth+1});
    }
  }
  return candidates;
}

export function findCommand(command,{platform=process.platform,env=process.env,exec=execFile}={}){
  return new Promise(resolve=>{
    const finder=platform==="win32"?"where":"which";
    exec(finder,[command],{windowsHide:true,timeout:2500,env},(error,stdout)=>{
      if(error)return resolve(null);
      resolve(String(stdout||"").split(/\r?\n/).map(value=>value.trim()).find(Boolean)||null);
    });
  });
}

// where.exe and which both take several names, so one launch answers every editor's commands. where prints each name's matches
// in PATH order, grouped by name, and exits 1 only when it found none; which exits 1 when any name is missing. What they printed
// counts either way. Each command maps to its matches, first match first.
export function findCommands(commands,{platform=process.platform,env=process.env,exec=execFile}={}){
  const path=platformPath(platform),wanted=new Map(commands.map(command=>[command.toLowerCase(),command]));
  const extensions=platform==="win32"?String(env.PATHEXT||".COM;.EXE;.BAT;.CMD").toLowerCase().split(";").filter(Boolean):[];
  return new Promise(resolve=>{
    exec(platform==="win32"?"where":"which",commands,{windowsHide:true,timeout:5000,env},(_error,stdout)=>{
      const found=new Map();
      for(const line of String(stdout||"").split(/\r?\n/).map(value=>value.trim()).filter(Boolean)){
        const name=path.basename(line).toLowerCase(),extension=path.extname(name);
        const command=wanted.get(name)||(extensions.includes(extension)?wanted.get(name.slice(0,-extension.length)):undefined);
        if(command)found.set(command,[...(found.get(command)||[]),line]);
      }
      resolve(found);
    });
  });
}

// Electron editors put a bin\<name>.cmd beside an extensionless shell script, and the .cmd runs the editor's own program
// ("%~dp0..\Code.exe" for VS Code, "%~dp0..\..\..\Cursor.exe" for Cursor), which opens a folder it is given.
const LAUNCHER_PROGRAM=/"%~dp0([^"%]+\.exe)"/i;
function launcherProgram(match,{readFile,exists}){
  if(!/\.(?:cmd|bat)$/i.test(match))return null;
  let text="";try{text=readFile(match)}catch{return null}
  const found=text.match(LAUNCHER_PROGRAM);if(!found)return null;
  const program=win32.normalize(win32.join(win32.dirname(match),found[1]));
  try{return exists(program)?program:null}catch{return null}
}
// What execFile can start on Windows: an .exe or .com as it is, and a .cmd or .bat launcher through the program it runs. where
// lists VS Code's extensionless bin\code first, which execFile cannot start at all.
function windowsLaunchable(matches,{readFile,exists}){
  for(const match of matches){
    if(/\.(?:exe|com)$/i.test(match))return match;
    const target=windowsCommandShimTarget(match,{platform:"win32",read:readFile,exists})||launcherProgram(match,{readFile,exists});
    if(target)return target;
  }
  return null;
}

export async function resolveEditorExecutable(spec,{
  platform=process.platform,
  env=process.env,
  exists=existsSync,
  readDirectory=readdirSync,
  readFile=path=>readFileSync(path,"utf8"),
  commandFinder=findCommand,
}={}){
  // A finder answers a path or, from findCommands, every match; on Windows the first one execFile can start wins, then the
  // standard install folders, and only then a match it cannot start, which still names the editor as before.
  let unstartable=null;
  for(const command of spec.commands){
    const found=await commandFinder(command,{platform,env});
    const matches=Array.isArray(found)?found:found?[found]:[];
    const launchable=platform==="win32"?windowsLaunchable(matches,{readFile,exists}):matches[0];
    if(launchable)return launchable;
    unstartable||=matches[0]||null;
  }
  const candidates=[
    ...standardCandidates(spec,{platform,env,readDirectory}),
    ...toolboxCandidates(spec,{platform,env,readDirectory}),
  ];
  for(const candidate of candidates)try{if(candidate&&exists(candidate))return candidate}catch{}
  return unstartable;
}

// One where (or which) launch for every editor's commands, and each folder the install scans look in is read once.
export async function discoverEditors(options={}){
  const {platform=process.platform,env=process.env,exec=execFile,readDirectory=readdirSync}=options;
  const found=options.commandFinder?null:await findCommands(EDITOR_SPECS.flatMap(spec=>spec.commands),{platform,env,exec});
  const commandFinder=options.commandFinder||(async command=>found.get(command)||null);
  const folders=new Map(),readOnce=path=>{if(!folders.has(path))folders.set(path,safeDirectoryEntries(path,readDirectory));return folders.get(path)};
  const editors=[];
  for(const spec of EDITOR_SPECS){
    const executable=await resolveEditorExecutable(spec,{...options,commandFinder,readDirectory:readOnce});
    if(executable)editors.push({id:spec.id,label:spec.label,executable});
  }
  return editors;
}

// The editors found are kept for the app run: the header lists them each time it shows and Open looks its editor up again. An
// editor installed meanwhile shows within 10 minutes, or at the next list after refresh (an Open that could not start asks for
// one). Calls that overlap share one discovery.
const EDITOR_LIST_REUSE_MS=10*60_000;
let editorList=null;
export function listEditors({refresh=false,now=Date.now,discover=discoverEditors}={}){
  if(refresh||!editorList||now()-editorList.at>=EDITOR_LIST_REUSE_MS){
    const pending=discover().catch(error=>{if(editorList?.pending===pending)editorList=null;throw error});
    editorList={at:now(),pending};
  }
  return editorList.pending.then(editors=>editors.map(editor=>({...editor})));
}

// Starts the editor and resolves once its process exists. A launch that fails (the file is gone, or Windows cannot start it
// directly) rejects with the reason instead of answering as opened. The editor runs detached with no pipes, as its own launchers
// start it (VS Code's cli.js): on Windows a child that is not detached is in Trebell's kill-on-close job and ends when Trebell
// quits, and output piped back would fill a buffer nobody reads. It is not started hidden either: windowsHide puts SW_HIDE in the
// start-up info, which a GUI program's first ShowWindow takes, so a VS Code that was not running kept its window hidden; detached
// already starts a console program with no console window.
export function startEditor(editor,path,{spawnFn=spawn}={}){
  return new Promise((resolve,reject)=>{
    // In words, not spawn's own "spawn <path> ENOENT": a program that is gone, or one that cannot be run directly.
    const reason=error=>error?.code==="ENOENT"?`it is no longer at ${editor.executable}.`:error?.code?`${editor.executable} could not be run.`:(error?.message||String(error));
    const fail=error=>reject(new Error("Could not start "+editor.label+": "+reason(error)));
    let child;
    try{child=spawnFn(editor.executable,[path],{detached:true,stdio:"ignore"})}catch(error){fail(error);return}
    child.once("error",fail);
    child.once("spawn",()=>{child.unref?.();resolve()});
  });
}
