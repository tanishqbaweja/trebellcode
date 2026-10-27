import { existsSync, readFileSync, statSync } from "node:fs";
import { win32 } from "node:path";

// Who installed a harness binary, judged from where it is (T3 Code's maintenance resolver), and so what updates it: npm into the
// global prefix that holds its package, or the harness's own updater for a binary its own installer put in place (Claude Code's
// `claude update`, Codex's `codex update` for the standalone tree in its home, Grok Build's `grok update` for one in its home,
// OpenCode's `opencode upgrade`). Any other install (WinGet, Homebrew, mise, pnpm, bun, Yarn, Volta, Vite+, a project's
// node_modules, a folder nothing proves) is the person's to update with the tool that installed it, named when it is known:
// Trebell never guesses an updater, as one the binary is not its own installs a second copy beside it.

const slashed=path=>String(path||"").replaceAll("\\","/");
const folded=path=>slashed(path).toLowerCase();
const under=(path,folder)=>{const root=folded(folder).replace(/\/+$/,"");return Boolean(root)&&folded(path).startsWith(root+"/")};
// A value of env whatever the letter case of its name (Windows spells ProgramFiles as it likes).
const envValue=(env,name)=>{const key=Object.keys(env||{}).find(item=>item.toUpperCase()===name.toUpperCase());return key?String(env[key]||"").trim():""};
const SEMVER=/^v?(\d+)\.(\d+)\.(\d+)$/;

// npm's global prefix that holds packageName at path: <prefix>/lib/node_modules/<package>/, and <prefix>\node_modules\<package>\
// beside npm's launcher for command on Windows (T3 npmGlobalPrefixFromCommandPath). Never a package inside another package or a
// project, nor a mise tool's own folder: only globals under mise's Node are npm's.
export function npmGlobalPrefix(path,packageName,{platform=process.platform,command=null,exists=existsSync}={}){
  const lower=folded(path),windows=platform==="win32";
  const segment=(windows?"/node_modules/":"/lib/node_modules/")+String(packageName||"").toLowerCase()+"/",index=lower.lastIndexOf(segment);
  if(!packageName||index<0||lower.slice(0,index).includes("/node_modules/"))return null;
  const tool=/\/mise\/installs\/([^/]+)\/[^/]+$/.exec(lower.slice(0,index))?.[1];
  if(tool&&tool!=="node")return null;
  const prefix=index===0?"/":String(path).slice(0,index);
  if(windows&&!(command&&[command+".cmd",command,command+".ps1"].some(name=>exists(win32.join(prefix,name)))))return null;
  return prefix;
}
// The prefix of a launcher npm wrote on Windows, proven by its package's manifest beside it (T3 resolveNpmGlobalPrefix).
function npmLauncherPrefix(launcher,packageName,{platform,exists}){
  if(platform!=="win32"||!launcher||!packageName)return null;
  const folder=win32.dirname(String(launcher));
  return exists(win32.join(folder,"node_modules",...packageName.split("/"),"package.json"))?folder:null;
}
// A Homebrew keg or cask a real path lies in (T3 homebrewOwnershipFromCommandPath).
export function homebrewKeg(path){
  const match=/^(.*)\/(cellar|caskroom)\/([^/]+)\/[^/]+\//i.exec(slashed(path));
  return match?{kind:match[2].toLowerCase()==="cellar"?"formula":"cask",name:match[3],prefix:match[1]}:null;
}
// WinGet's own folders, %LOCALAPPDATA%\Microsoft\WinGet for one user and %ProgramFiles%\WinGet for the machine: its Links, and the
// Packages\<id>_<source> folder each package lives in. `claude update` exits 0 there without updating (T3's 1ffa2cbb4).
function winGetInstall(paths,env){
  const local=envValue(env,"LOCALAPPDATA"),roots=[local&&local+"/Microsoft",envValue(env,"ProgramFiles"),envValue(env,"ProgramFiles(x86)")].filter(Boolean).map(root=>folded(root).replace(/\/+$/,"")+"/winget/");
  if(!paths.some(path=>roots.some(root=>folded(path).startsWith(root+"links/")||folded(path).startsWith(root+"packages/"))))return null;
  const id=paths.map(path=>/\/winget\/packages\/([^/_]+)_[^/]+\//i.exec(slashed(path))?.[1]).find(Boolean)||null;
  return {by:"WinGet",command:id?`winget upgrade ${id}`:null};
}
const MISE_WRAPPER_MAX_BYTES=16*1024;
// A small launcher's text (a script that runs another program), or "" for a large or unreadable file.
export function readLauncher(path){try{return statSync(path).size>MISE_WRAPPER_MAX_BYTES?"":readFileSync(path,"utf8")}catch{return ""}}
// Installs other package managers keep, which update only through them: their global bins and stores (T3's resolver).
function packageManagerInstall(paths,real,packageName){
  const has=test=>paths.some(path=>test(folded(path)));
  if(has(path=>/\/(?:\.vite-plus|\.local\/share\/vite-plus|appdata\/local\/vite-plus)\/bin\//.test(path)))return {by:"Vite+",command:`vp i -g ${packageName}`};
  if(has(path=>path.includes("/.bun/bin/")))return {by:"bun",command:`bun add -g ${packageName}@latest`};
  // pnpm 10 runs no build script it was not told to (10.4 and later take --allow-build), and Claude Code's puts its binary in place.
  if(has(path=>["/.local/share/pnpm/","/library/pnpm/","/local/share/pnpm/","/appdata/local/pnpm/","/pnpm/global/"].some(part=>path.includes(part))))return {by:"pnpm",command:`pnpm add -g --allow-build=${packageName} ${packageName}@latest`};
  if(has(path=>/\/yarn\/(?:data\/)?global\/node_modules\//.test(path)))return {by:"Yarn",command:`yarn global add ${packageName}@latest`};
  if(/^volta-shim(?:\.exe)?$/.test(folded(real).split("/").pop()))return {by:"Volta",command:`volta install ${packageName}@latest`};
  return null;
}
const CLAUDE_NATIVE=path=>path.endsWith("/.local/bin/claude")||path.endsWith("/.local/bin/claude.exe")||path.includes("/.local/share/claude/");
const OPENCODE_NATIVE=path=>path.endsWith("/.opencode/bin/opencode")||path.endsWith("/.opencode/bin/opencode.exe");

// What installed the binary at paths: the file the profile names or PATH finds (found), the binary that starts behind an npm
// launcher (binary) and its real path (real). Returns {method:"npm",prefix}, {method:"native",args,env?} (the harness's own updater,
// run as binary) or {method:"manual",by,command} (the tool that installed it and its command, each null when unknown).
// codexHome: the profile's shared Codex home, whose packages/standalone tree `codex update` keeps (T3 c25ba721a); grokHome: Grok's
// home, where `grok update` installs (T3 Grok driver).
export function harnessInstallOwner(kind,{paths,packageName,command=kind,platform=process.platform,env={},codexHome=null,grokHome=null,exists=existsSync,read=readLauncher}={}){
  const all=[...new Set([paths?.found,paths?.binary,paths?.real].filter(Boolean))];
  if(!all.length)return {method:"manual",by:null,command:null};
  const real=paths.real||all.at(-1);
  const winget=platform==="win32"?winGetInstall(all,env):null;if(winget)return {method:"manual",...winget};
  const keg=homebrewKeg(real),script=read(real);
  // A launcher where a native install goes can still hand over to a mise-owned install (T3 762813c17).
  const mise=all.some(path=>/\/mise\/(?:installs|shims)\//.test(folded(path)))||(keg?.kind==="formula"&&keg.name.toLowerCase()==="mise")||(script.startsWith("#!")&&/\bmise\s+(?:x|exec)\b/.test(script));
  if(!mise){
    const folds=all.map(folded);
    if(kind==="claude"&&folds.some(CLAUDE_NATIVE))return {method:"native",args:["update"]};
    if(kind==="opencode"&&folds.some(OPENCODE_NATIVE))return {method:"native",args:["upgrade"]};
    if(kind==="codex"&&codexHome&&all.some(path=>under(path,slashed(codexHome).replace(/\/+$/,"")+"/packages/standalone")))return {method:"native",args:["update"],env:{CODEX_HOME:codexHome}};
    if(kind==="grok"&&grokHome&&all.some(path=>under(path,grokHome)))return {method:"native",args:["update"]};
  }
  const manager=packageManagerInstall(all,real,packageName);if(manager)return {method:"manual",...manager};
  // npm's proof outranks a Homebrew keg the package lies under: a global of Homebrew's Node is npm's.
  const prefix=npmGlobalPrefix(real,packageName,{platform,command,exists})||npmLauncherPrefix(paths.found,packageName,{platform,exists});
  if(prefix)return {method:"npm",prefix};
  if(mise)return {method:"manual",by:"mise",command:null};
  if(keg)return {method:"manual",by:"Homebrew",command:`brew upgrade ${keg.kind==="cask"?"--cask ":""}${keg.name}`};
  return {method:"manual",by:null,command:null};
}
// npm's install of packageName (at version, into prefix for an install that has one) with its install script allowed: npm 12 runs
// no install script unless allowed, and Claude Code's puts its native binary in place (T3 allows the one package's; an older npm
// only warns about the flag).
export function npmInstallArgs(packageName,version=null,prefix=null){
  return ["install","-g",...(prefix?["--prefix",prefix]:[]),"--allow-scripts="+packageName,version?packageName+"@"+version:packageName];
}
// A command as the person would type it, a word with spaces or shell characters quoted.
export function shownCommand(command,args=[],platform=process.platform){
  const quote=word=>/^[\w./:\\@=+,-]+$/.test(word)?word:platform==="win32"?`"${word}"`:`'${word.replaceAll("'","'\\''")}'`;
  return [command,...args].map(word=>quote(String(word))).join(" ");
}
// Who installed a binary, said in Settings and in a refused update: the tool and, when it is known, the command that updates it.
function installedBy(by,command){return command?`installed by ${by}: run \`${command}\` to update it`:`installed by ${by}: update it with ${by}`}
// What Settings says of a newer release that Trebell does not install itself (T3 96d354ae8): the release, the file the profile runs,
// and who installed it with its command when they are known.
export function manualUpdateText({name,latest,binary,by=null,command=null}){
  return by?`${name} ${latest} is available. This profile runs ${binary}, ${installedBy(by,command)}.`
    :`${name} ${latest} is available. This profile runs ${binary}, and Trebell Code cannot tell what installed it: update it the way you installed it.`;
}
// Why an update was refused for an install Trebell does not update itself.
export function manualUpdateRefusal({name,binary,by=null,command=null}){
  return by?`Trebell Code does not update the ${name} at ${binary}, ${installedBy(by,command)}. Nothing was installed.`
    :`Trebell Code updates ${/^[aeiou]/i.test(name)?"an":"a"} ${name} installed by npm or by ${name}'s own installer, and cannot tell what installed ${binary}: update it the way you installed it. Nothing was installed.`;
}
// The newest release npm's registry names for packageName (T3 fetchNpmLatestVersion: 4 s), or null when it could not be read.
export async function registryRelease(fetchImpl,packageName,{timeoutMs=4000}={}){
  try{
    const response=await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,{headers:{accept:"application/json"},signal:AbortSignal.timeout(timeoutMs)});
    if(!response?.ok)return null;
    const body=await response.json(),version=typeof body?.version==="string"?body.version.trim():"";
    return SEMVER.test(version)?version.replace(/^v/,""):null;
  }catch{return null}
}
// The newest of the versions `npm view <package>@<range> version --json` prints: one string, or a list when several match.
export function newestListed(output){
  let value;try{value=JSON.parse(String(output||"").trim())}catch{value=String(output||"").trim().replace(/^["']|["']$/g,"")}
  const parts=version=>SEMVER.exec(String(version||"").trim())?.slice(1).map(Number)||null;
  return (Array.isArray(value)?value:[value]).filter(version=>parts(version)).reduce((best,version)=>{
    if(!best)return String(version).trim().replace(/^v/,"");
    const [a,b]=[parts(version),parts(best)],newer=a[0]-b[0]||a[1]-b[1]||a[2]-b[2];
    return newer>0?String(version).trim().replace(/^v/,""):best;
  },null);
}
