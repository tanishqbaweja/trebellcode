import { existsSync, readFileSync } from "node:fs";
import { win32 } from "node:path";

// Windows command launchers (.cmd and .bat files) and the program behind them. Node will not spawn a launcher without a shell:
// since the fix for CVE-2024-27980 it throws EINVAL. A caller that starts a configured executable directly therefore gets the
// program the launcher runs: a native .exe always, and a JavaScript file only when the caller runs it with Node itself
// (allowScripts). exact takes nothing but the launcher npm writes for a native program, so that program can run without cmd.exe
// and end with the process that started it; a launcher that sets anything up first is left to run as it is.

// npm writes <bin>.cmd beside its node_modules folder. For a bin that is a native program the launcher opens with these lines,
// then has one more that runs the program from the launcher's own folder with every argument:
//   "%dp0%\node_modules\<package>\<bin>.exe"   %*
const NPM_NATIVE_LAUNCHER_OPENING=`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0`;
const RUN_FROM_OWN_FOLDER='"%dp0%\\';

const asText=value=>String(value||"").trim();
const endsWithAny=(path,suffixes)=>{const lower=path.toLowerCase();return suffixes.some(suffix=>lower.endsWith(suffix))};

// The launcher a command names, when there is one to read: on Windows, an absolute path to a .cmd or .bat file.
function launcherPath(command,platform){
  const path=asText(command);
  return platform==="win32"&&endsWithAny(path,[".cmd",".bat"])&&win32.isAbsolute(path)?path:null;
}

function launcherText(path,read){
  try{return String(read(path)??"")}catch{return null}
}

// The program npm's run line names, written as it is: the quoted path after %dp0%\, then one or more spaces and %* and nothing
// else. The path holds no other variable and ends in .exe.
function programOnRunLine(line){
  const close=line.startsWith(RUN_FROM_OWN_FOLDER)?line.indexOf('"',RUN_FROM_OWN_FOLDER.length):-1;
  if(close===-1)return null;
  const program=line.slice(RUN_FROM_OWN_FOLDER.length,close);
  const native=program.length>".exe".length&&program.endsWith(".exe")&&!program.includes("%");
  return native&&/^ +%\*$/.test(line.slice(close+1))?program:null;
}

// The program of a launcher that is npm's for a native program, line for line (a blank line does nothing in a batch file, so
// blank lines are skipped), relative to the launcher's folder; null for any other launcher.
function npmNativeLauncherProgram(text){
  const lines=text.split(/\r?\n/).filter(line=>line!=="");
  const runLine=lines.pop();
  return lines.join("\n")===NPM_NATIVE_LAUNCHER_OPENING?programOnRunLine(runLine):null;
}

// When a reference to the launcher's own folder and a backslash start at index at, the index just past that backslash; else -1.
// The folder is %~dp0 (the folder of the running batch file) or the %dp0% variable npm's launcher sets from it; the tilde and
// the closing percent sign are each optional, and dp0 may be in either case. Without the backslash it is not how npm names a
// path (an editor's "%~dp0..\Code.exe" or Muse's "%~dp0muse-bin.exe" have their own readers).
function ownFolderEnd(text,at){
  let index=at;
  if(text[index++]!=="%")return -1;
  if(text[index]==="~")index++;
  if(text.slice(index,index+3).toLowerCase()!=="dp0")return -1;
  index+=3;
  if(text[index]==="%")index++;
  return text[index]==="\\"?index+1:-1;
}

// The paths a launcher names inside its own folder, in its order: each quoted string that opens with the folder and holds no
// other variable. A quote that opens none is passed over, and a path's closing quote opens nothing.
function ownFolderPaths(text){
  const paths=[];
  let quote=text.indexOf('"');
  while(quote>=0){
    let resume=quote+1;
    const start=ownFolderEnd(text,quote+1),close=start<0?-1:text.indexOf('"',start);
    if(close>start){
      const path=text.slice(start,close);
      if(!path.includes("%")){paths.push(path);resume=close+1}
    }
    quote=text.indexOf('"',resume);
  }
  return paths;
}

// 0 for a native program, 1 for a JavaScript file the caller can run with Node itself, null for anything else. Node itself is
// never the program: npm's launcher of a script names the node.exe beside it only to run the script with it.
function programRank(path,allowScripts){
  if(endsWithAny(path,["\\node","\\node.exe"]))return null;
  if(endsWithAny(path,[".exe"]))return 0;
  return allowScripts&&endsWithAny(path,[".js",".cjs",".mjs"])?1:null;
}

// The first program that exists, native programs before scripts and each in the launcher's order; null when there is none.
function firstProgram(paths,{allowScripts,exists}){
  const ranked=paths.map(path=>({path,rank:programRank(path,allowScripts)})).filter(item=>item.rank!==null);
  ranked.sort((left,right)=>left.rank-right.rank);
  for(const {path} of ranked)if(exists(path))return path;
  return null;
}

// The program to start instead of a Windows launcher, as an absolute path, or null to start the command as it is.
export function windowsCommandShimTarget(command,{platform=process.platform,allowScripts=false,exact=false,read=path=>readFileSync(path,"utf8"),exists=existsSync}={}){
  const launcher=launcherPath(command,platform);
  // npm writes .cmd launchers only.
  if(!launcher||(exact&&!endsWithAny(launcher,[".cmd"])))return null;
  const text=launcherText(launcher,read);
  if(text===null)return null;
  const folder=win32.dirname(launcher);
  if(exact){
    // Only the program the run line names: no other path in the launcher is looked at.
    const program=npmNativeLauncherProgram(text);
    if(program===null)return null;
    const path=win32.join(folder,program);
    return exists(path)?path:null;
  }
  return firstProgram(ownFolderPaths(text).map(path=>win32.join(folder,path)),{allowScripts,exists});
}

// The program behind a Windows launcher, else the command as it was given (trimmed), so a failure names what was configured.
export function resolveWindowsCommandShim(command,options={}){
  return windowsCommandShimTarget(command,options)??asText(command);
}
