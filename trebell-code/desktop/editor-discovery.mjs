import { existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { posix, win32 } from "node:path";

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

export async function resolveEditorExecutable(spec,{
  platform=process.platform,
  env=process.env,
  exists=existsSync,
  readDirectory=readdirSync,
  commandFinder=findCommand,
}={}){
  for(const command of spec.commands){
    const found=await commandFinder(command,{platform,env});
    if(found)return found;
  }
  const candidates=[
    ...standardCandidates(spec,{platform,env,readDirectory}),
    ...toolboxCandidates(spec,{platform,env,readDirectory}),
  ];
  for(const candidate of candidates)try{if(candidate&&exists(candidate))return candidate}catch{}
  return null;
}

export async function discoverEditors(options={}){
  const editors=[];
  for(const spec of EDITOR_SPECS){
    const executable=await resolveEditorExecutable(spec,options);
    if(executable)editors.push({id:spec.id,label:spec.label,executable});
  }
  return editors;
}
