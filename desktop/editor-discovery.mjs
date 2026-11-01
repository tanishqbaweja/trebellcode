import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { posix, win32 } from "node:path";
import { windowsCommandShimTarget } from "../src/windows-command-shim.mjs";

// The editors "Open in" can start, in the order the picker lists them: with no saved choice the picker takes the first one this
// machine has. Visual Studio Code and the builds of it come first (Microsoft's two, then the open-source one, then other
// vendors' editors made from it, by name), then Zed and Sublime Text, then JetBrains' IDEs by name.
// Each entry has the id the picker saves as trebell.preferredEditor (an id that shipped never changes, so a saved choice still
// matches), the label the picker shows, the shell commands its vendor (or a packager) names it by, and the layout its installer
// leaves on disk, which says where to look when no command is on PATH.
const vscodeBuild=(id,label,commands,{folder,program,bundle})=>({id,label,commands,layout:"vscode-build",folder,program,bundle});
const jetbrainsIde=(launcher,product)=>({id:launcher,label:product,commands:[launcher],layout:"jetbrains",product,launcher});

export const EDITOR_SPECS=Object.freeze([
  vscodeBuild("vscode","Visual Studio Code",["code"],{folder:"Microsoft VS Code",program:"Code.exe",bundle:"Visual Studio Code"}),
  vscodeBuild("vscode-insiders","Visual Studio Code Insiders",["code-insiders"],
    {folder:"Microsoft VS Code Insiders",program:"Code - Insiders.exe",bundle:"Visual Studio Code - Insiders"}),
  vscodeBuild("vscodium","VSCodium",["codium"],{folder:"VSCodium",program:"VSCodium.exe",bundle:"VSCodium"}),
  // "antigravity" first: since 2026 Google's terminal agent is also installed as agy, and only the editor is called antigravity.
  vscodeBuild("antigravity","Antigravity",["antigravity","agy"],{folder:"Antigravity",program:"Antigravity.exe",bundle:"Antigravity"}),
  vscodeBuild("cursor","Cursor",["cursor"],{folder:"cursor",program:"Cursor.exe",bundle:"Cursor"}),
  vscodeBuild("kiro","Kiro",["kiro"],{folder:"Kiro",program:"Kiro.exe",bundle:"Kiro"}),
  vscodeBuild("trae","Trae",["trae"],{folder:"Trae",program:"Trae.exe",bundle:"Trae"}),
  vscodeBuild("windsurf","Windsurf",["windsurf"],{folder:"Windsurf",program:"Windsurf.exe",bundle:"Windsurf"}),
  // Zed's docs: distributions often rename its binary zeditor or zedit (zed is also ZFS's event daemon).
  {id:"zed",label:"Zed",commands:["zed","zeditor","zedit"],layout:"zed"},
  {id:"sublime-text",label:"Sublime Text",commands:["subl"],layout:"sublime-text"},
  jetbrainsIde("aqua","Aqua"),
  jetbrainsIde("clion","CLion"),
  jetbrainsIde("datagrip","DataGrip"),
  jetbrainsIde("dataspell","DataSpell"),
  jetbrainsIde("goland","GoLand"),
  jetbrainsIde("idea","IntelliJ IDEA"),
  jetbrainsIde("phpstorm","PhpStorm"),
  jetbrainsIde("pycharm","PyCharm"),
  jetbrainsIde("rider","Rider"),
  jetbrainsIde("rubymine","RubyMine"),
  jetbrainsIde("rustrover","RustRover"),
  jetbrainsIde("webstorm","WebStorm"),
].map(entry=>Object.freeze({...entry,commands:Object.freeze([...entry.commands])})));

// Every command the catalog names, once, in catalog order: what the one where (or which) launch of a discovery is given.
export const editorCommandNames=()=>[...new Set(EDITOR_SPECS.flatMap(entry=>entry.commands))];

// ---- Where installers put things -------------------------------------------------------------------------------------------

// Sub-folder names of a folder, from readDirectory's answer (Dirent-like entries, or bare names, which count as folders). A
// link counts too (an app linked into /Applications); whether the launcher inside exists decides. Unreadable: none.
function subfolderNames(readDirectory,folder){
  let entries;
  try{entries=readDirectory(folder,{withFileTypes:true})}catch{return []}
  const names=[];
  for(const entry of entries||[]){
    if(typeof entry==="string")names.push(entry);
    else if(entry?.name&&(entry.isDirectory?.()||entry.isSymbolicLink?.()))names.push(entry.name);
  }
  return names;
}

// Where Windows installers put programs: per user under %LOCALAPPDATA%\Programs, for everyone under Program Files (each once).
function windowsProgramRoots(env){
  const roots=[env.LOCALAPPDATA?win32.join(env.LOCALAPPDATA,"Programs"):"",env.ProgramFiles,env["ProgramFiles(x86)"],env.ProgramW6432];
  return [...new Set(roots.filter(Boolean))];
}

// macOS apps: the person's own Applications folder, then the machine's.
function macAppRoots(env){
  return [env.HOME?posix.join(env.HOME,"Applications"):"","/Applications"].filter(Boolean);
}

// The folders a Linux package or install script puts commands in. An app started from a desktop menu can have a shorter PATH
// than a shell has, so these are looked in directly as well.
function linuxCommandFolders(env){
  return [env.HOME?posix.join(env.HOME,".local","bin"):"","/usr/local/bin","/usr/bin","/snap/bin"].filter(Boolean);
}

// The version a JetBrains folder name ends with ("IntelliJ IDEA 2026.2" -> [2026,2], a Toolbox build "262.100" -> [262,100]).
function trailingVersion(name){
  const words=name.trim().split(" "),last=words[words.length-1];
  const parts=last.split(".");
  return parts.length>1&&parts.every(part=>part!==""&&[...part].every(ch=>ch>="0"&&ch<="9"))?parts.map(Number):null;
}
// Newest first: a folder with no version (Toolbox 2 keeps one folder per IDE and updates it in place) before versioned ones,
// higher versions before lower. Otherwise the order folders were read in.
function newestFirst(names){
  const ranked=names.map((name,at)=>({name,at,version:trailingVersion(name)}));
  ranked.sort((left,right)=>{
    if(!left.version||!right.version)return (left.version?1:0)-(right.version?1:0)||left.at-right.at;
    for(let i=0;i<Math.max(left.version.length,right.version.length);i++){
      const gap=(right.version[i]??0)-(left.version[i]??0);
      if(gap)return gap;
    }
    return left.at-right.at;
  });
  return ranked.map(item=>item.name);
}

// A JetBrains install folder or app is named after its product, alone or followed by a space and an edition or version
// ("IntelliJ IDEA 2026.2", "PyCharm Community Edition 2024.3", "IntelliJ IDEA CE.app"), at times with the vendor in front
// ("JetBrains Rider 2025.1"). Letter case is not significant (neither file system cares).
function namesJetbrainsProduct(name,product){
  let bare=name.toLowerCase();
  if(bare.endsWith(".app"))bare=bare.slice(0,-".app".length);
  if(bare.startsWith("jetbrains "))bare=bare.slice("jetbrains ".length);
  const wanted=product.toLowerCase();
  return bare===wanted||bare.startsWith(wanted+" ");
}

// JetBrains' Windows launchers in an install's bin folder: <launcher>64.exe, and <launcher>.exe in older 32-bit builds.
const jetbrainsWindowsLaunchers=(bin,launcher)=>[win32.join(bin,launcher+"64.exe"),win32.join(bin,launcher+".exe")];

// The Toolbox App before 2.0 kept each IDE in a tree of its own, %LOCALAPPDATA%\JetBrains\Toolbox\apps\<tool>\<channel>\<build>.
// The walk reads at most this many folders, so a large tree costs a bounded number of reads.
const TOOLBOX_TREE_READS=200;
function olderToolboxLaunchers(entry,place){
  if(!place.env.LOCALAPPDATA)return [];
  const apps=win32.join(place.env.LOCALAPPDATA,"JetBrains","Toolbox","apps");
  let reads=TOOLBOX_TREE_READS;
  const below=folder=>reads-->0?place.subfolders(folder):[];
  const launchers=[];
  for(const tool of below(apps)){
    for(const channel of below(win32.join(apps,tool))){
      const channelFolder=win32.join(apps,tool,channel);
      for(const build of newestFirst(below(channelFolder)))launchers.push(...jetbrainsWindowsLaunchers(win32.join(channelFolder,build,"bin"),entry.launcher));
    }
  }
  return launchers;
}

// The installer layouts, each with where its programs are on each system (Linux: anything that is neither Windows nor macOS).
// Each answers the paths to try, best first.
const LAYOUTS={
  "vscode-build":{
    // <root>\<install folder>\<Product>.exe; the build's bin folder holds only launcher scripts.
    win32:(entry,place)=>place.programRoots.map(root=>win32.join(root,entry.folder,entry.program)),
    // <Product>.app/Contents/Resources/app/bin holds the command scripts; builds of VS Code keep its own script, code, there too.
    darwin:(entry,place)=>place.appRoots.flatMap(root=>{
      const scripts=posix.join(root,entry.bundle+".app","Contents","Resources","app","bin");
      return [...new Set([...entry.commands,"code"])].map(command=>posix.join(scripts,command));
    }),
    linux:()=>[],
  },
  zed:{
    // Zed's installer: <root>\Zed\Zed.exe, with its command-line program in bin\zed.exe.
    win32:(_entry,place)=>place.programRoots.flatMap(root=>[win32.join(root,"Zed","Zed.exe"),win32.join(root,"Zed","bin","zed.exe")]),
    // What Zed's "install cli" links as zed.
    darwin:(_entry,place)=>place.appRoots.map(root=>posix.join(root,"Zed.app","Contents","MacOS","cli")),
    // Zed's install script unpacks into ~/.local/zed.app.
    linux:(_entry,place)=>place.env.HOME?[posix.join(place.env.HOME,".local","zed.app","bin","zed")]:[],
  },
  "sublime-text":{
    win32:(_entry,place)=>place.programRoots.map(root=>win32.join(root,"Sublime Text","subl.exe")),
    darwin:(_entry,place)=>place.appRoots.map(root=>posix.join(root,"Sublime Text.app","Contents","SharedSupport","bin","subl")),
    linux:()=>[],
  },
  jetbrains:{
    // The standalone installer: <Program Files>\JetBrains\<Product> <version>; Toolbox 2: %LOCALAPPDATA%\Programs\<Product>.
    // Then the older Toolbox tree.
    win32:(entry,place)=>[
      ...place.programRoots.flatMap(root=>[root,win32.join(root,"JetBrains")]).flatMap(folder=>
        newestFirst(place.subfolders(folder).filter(name=>namesJetbrainsProduct(name,entry.product)))
          .flatMap(name=>jetbrainsWindowsLaunchers(win32.join(folder,name,"bin"),entry.launcher))),
      ...olderToolboxLaunchers(entry,place),
    ],
    // Any app in an Applications folder named for the product, then the script the Toolbox App writes.
    darwin:(entry,place)=>[
      ...place.appRoots.flatMap(root=>
        newestFirst(place.subfolders(root).filter(name=>name.toLowerCase().endsWith(".app")&&namesJetbrainsProduct(name,entry.product)))
          .map(name=>posix.join(root,name,"Contents","MacOS",entry.launcher))),
      ...(place.env.HOME?[posix.join(place.env.HOME,"Library","Application Support","JetBrains","Toolbox","scripts",entry.launcher)]:[]),
    ],
    // The Toolbox App's scripts, under $XDG_DATA_HOME (an absolute path only, as the XDG spec says) or ~/.local/share.
    linux:(entry,place)=>{
      const given=place.env.XDG_DATA_HOME;
      const data=given&&posix.isAbsolute(given)?given:place.env.HOME?posix.join(place.env.HOME,".local","share"):"";
      return data?[posix.join(data,"JetBrains","Toolbox","scripts",entry.launcher)]:[];
    },
  },
};

// The paths where an entry's program would be on this system, best first.
function installedPaths(entry,place){
  const system=place.platform==="win32"||place.platform==="darwin"?place.platform:"linux";
  const own=LAYOUTS[entry.layout]?.[system]?.(entry,place)||[];
  if(system!=="linux")return own;
  return [...linuxCommandFolders(place.env).flatMap(folder=>entry.commands.map(command=>posix.join(folder,command))),...own];
}

// ---- Commands on PATH ------------------------------------------------------------------------------------------------------

const pathFinder=platform=>platform==="win32"?"where":"which";
// The paths a finder printed, one per line (where ends its lines with CR LF).
const outputLines=stdout=>`${stdout??""}`.split("\n").map(line=>line.trim()).filter(line=>line!=="");
// The extensions Windows runs a bare command name with: PATHEXT, else Windows' own default list.
const runnableExtensions=env=>(env.PATHEXT||".COM;.EXE;.BAT;.CMD").split(";").map(extension=>extension.trim().toLowerCase()).filter(extension=>extension.startsWith("."));

// Runs where (Windows) or which (elsewhere) on names, hidden, and answers whether it failed and the paths it printed.
function askPathFinder(names,{platform,env,exec,timeout}){
  let settle;
  const answered=new Promise(resolve=>{settle=resolve});
  const finished=(error,stdout)=>settle({failed:Boolean(error),paths:outputLines(stdout)});
  exec(pathFinder(platform),names,{windowsHide:true,timeout,env},finished);
  return answered;
}

// One command's matches on PATH, first first (none: an empty list).
export async function findCommand(command,{platform=process.platform,env=process.env,exec=execFile}={}){
  const answer=await askPathFinder([command],{platform,env,exec,timeout:2500});
  return answer.failed?[]:answer.paths;
}

// The command a printed path answers, of the ones asked for: its file name, and on Windows also its file name without an
// extension Windows runs it by (where prints code.cmd for code).
function commandAnsweredBy(commands,{platform,env}){
  const asked=new Map();
  for(const command of commands)asked.set(command.toLowerCase(),command);
  const paths=platform==="win32"?win32:posix,runnable=platform==="win32"?runnableExtensions(env):[];
  return printed=>{
    const file=paths.basename(printed).toLowerCase();
    if(asked.has(file))return asked.get(file);
    const extension=paths.extname(file);
    return runnable.includes(extension)?asked.get(file.slice(0,file.length-extension.length)):undefined;
  };
}

// Every command's matches from one launch: where and which both take many names. where prints each name's matches in PATH
// order, one name after another, and exits 1 only when it found none; which exits 1 when any name is missing, so what they
// print counts whatever the exit. Answers a Map from command to its matches, first first.
export async function findCommands(commands,{platform=process.platform,env=process.env,exec=execFile}={}){
  const answeredBy=commandAnsweredBy(commands,{platform,env});
  const {paths}=await askPathFinder(commands,{platform,env,exec,timeout:5000});
  const byCommand=new Map(commands.map(command=>[command,[]]));
  for(const printed of paths)byCommand.get(answeredBy(printed))?.push(printed);
  // Only the commands found.
  for(const [command,found] of byCommand)if(found.length===0)byCommand.delete(command);
  return byCommand;
}

// A launcher that a build of VS Code puts in its bin folder (<command>.cmd) runs the editor's program by a path from its own
// folder: "%~dp0..\Code.exe" for VS Code, "%~dp0..\..\..\Cursor.exe" for Cursor. The first such program that exists. Batch
// variables ignore letter case, so %~DP0 is the same folder.
const OWN_FOLDER='"%~dp0';
function programBehindVscodeLauncher(launcher,{readFile,exists}){
  let text;
  try{text=String(readFile(launcher)??"")}catch{return null}
  const lower=text.toLowerCase();
  for(let at=lower.indexOf(OWN_FOLDER);at>=0;at=lower.indexOf(OWN_FOLDER,at+OWN_FOLDER.length)){
    const close=text.indexOf('"',at+OWN_FOLDER.length);
    if(close<0)return null;
    const relative=text.slice(at+OWN_FOLDER.length,close);
    if(relative.includes("%")||!relative.toLowerCase().endsWith(".exe"))continue;
    const program=win32.join(win32.dirname(launcher),relative);
    if(isThere(exists,program))return program;
  }
  return null;
}

// What spawn can start on Windows, of a command's matches: an .exe or .com as it is; a .cmd or .bat through the program it runs
// (npm's launchers, then VS Code's). Anything else (VS Code's extensionless bin\code, which where lists first) is passed over.
function windowsStartable(matches,io){
  for(const match of matches){
    const extension=win32.extname(match).toLowerCase();
    if(extension===".exe"||extension===".com")return match;
    if(extension!==".cmd"&&extension!==".bat")continue;
    const program=windowsCommandShimTarget(match,{platform:"win32",read:io.readFile,exists:io.exists})||programBehindVscodeLauncher(match,io);
    if(program)return program;
  }
  return null;
}

// Editors never live in an sbin folder; a zed there is ZFS's event daemon.
const inSbin=path=>posix.basename(posix.dirname(path))==="sbin";

function isThere(exists,path){
  try{return Boolean(path)&&Boolean(exists(path))}catch{return false}
}

// ---- Finding editors -------------------------------------------------------------------------------------------------------

// One catalog entry's program, or null. A command on PATH that can start wins; then the places its installer uses; then a
// command on PATH that cannot start as it is, so the editor is still listed (and its Open says why it did not start).
export async function resolveEditorExecutable(entry,{
  platform=process.platform,
  env=process.env,
  exists=existsSync,
  readDirectory=readdirSync,
  readFile=path=>readFileSync(path,"utf8"),
  commandFinder=findCommand,
}={}){
  const io={exists,readFile};
  let lastResort=null;
  for(const command of entry.commands){
    const answer=await commandFinder(command,{platform,env});
    let matches=(Array.isArray(answer)?answer:[answer]).filter(Boolean).map(String);
    if(platform!=="win32")matches=matches.filter(match=>!inSbin(match));
    const startable=platform==="win32"?windowsStartable(matches,io):matches[0];
    if(startable)return startable;
    lastResort??=matches[0]??null;
  }
  const place={platform,env,programRoots:windowsProgramRoots(env),appRoots:macAppRoots(env),subfolders:folder=>subfolderNames(readDirectory,folder)};
  return installedPaths(entry,place).find(path=>isThere(exists,path))??lastResort;
}

// The editors this machine has, as {id,label,executable}, in catalog order. One where (or which) launch looks up every command,
// and each folder is read at most once.
export async function discoverEditors(options={}){
  const platform=options.platform??process.platform,env=options.env??process.env;
  let commandFinder=options.commandFinder;
  if(!commandFinder){
    const matches=await findCommands(editorCommandNames(),{platform,env,exec:options.exec??execFile});
    commandFinder=async command=>matches.get(command)??null;
  }
  const read=options.readDirectory??readdirSync,folders=new Map();
  const readDirectory=folder=>{
    if(!folders.has(folder)){let entries=[];try{entries=read(folder,{withFileTypes:true})||[]}catch{}folders.set(folder,entries)}
    return folders.get(folder);
  };
  const found=[];
  for(const entry of EDITOR_SPECS){
    const executable=await resolveEditorExecutable(entry,{...options,platform,env,commandFinder,readDirectory});
    if(executable)found.push({id:entry.id,label:entry.label,executable});
  }
  return found;
}

// The editors found stay for the app run: the header lists them whenever it shows, and Open looks its editor up again. They are
// found again after ten minutes (an editor installed meanwhile shows up), or at once with refresh (an Open that could not start
// asks for it). Calls made while a discovery runs share it; one that fails is not kept. Each caller gets its own copies.
const KEEP_EDITORS_MS=10*60_000;
let kept=null;
export function listEditors({refresh=false,now=Date.now,discover=discoverEditors}={}){
  const time=now();
  if(refresh||!kept||time-kept.since>=KEEP_EDITORS_MS){
    let editors;
    try{editors=Promise.resolve(discover())}catch(error){editors=Promise.reject(error)}
    const current={since:time,editors};
    editors.catch(()=>{if(kept===current)kept=null});
    kept=current;
  }
  return kept.editors.then(list=>list.map(editor=>({...editor})));
}

// Why an editor did not start, in words: spawn's own "spawn <path> ENOENT" says neither what happened nor to which editor.
function notStartedBecause(error,executable){
  if(error?.code==="ENOENT")return `it is no longer at ${executable}.`;
  if(error?.code)return `${executable} could not be run.`;
  return error?.message||String(error);
}

// Starts the editor on path and resolves once its process exists, or rejects with the reason ("Could not start <label>: ...").
// The editor runs detached with no pipes, as its own launchers start it: on Windows a child that is not detached sits in
// Trebell's kill-on-close job and would end when Trebell quits, and output piped back would fill a buffer nobody reads. It is
// not started hidden: windowsHide puts SW_HIDE in the start-up info, which a GUI program's first ShowWindow takes (a VS Code that
// was not running kept its window hidden); detached already gives a console program no console window.
export function startEditor(editor,path,{spawnFn=spawn}={}){
  return new Promise((resolve,reject)=>{
    const refuse=error=>reject(new Error(`Could not start ${editor.label}: ${notStartedBecause(error,editor.executable)}`));
    let child;
    try{child=spawnFn(editor.executable,[path],{detached:true,stdio:"ignore"})}catch(error){refuse(error);return}
    child.once("error",refuse);
    child.once("spawn",()=>{child.unref?.();resolve()});
  });
}
