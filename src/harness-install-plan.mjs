import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { posix, win32 } from "node:path";

// Which tool put a harness binary where it is, and so which tool may update it. Trebell updates two kinds itself: a global npm
// install (npm install -g into the prefix whose node_modules holds the package) and a binary the harness's own installer placed
// (Claude Code's `claude update`, Codex's `codex update` for the standalone tree in its home, Grok Build's `grok update` for one
// in its home, OpenCode's `opencode upgrade`). Every other install (WinGet, Homebrew, mise, pnpm, bun, Yarn, Volta, Vite+, a
// project's node_modules, a folder nothing explains) stays the person's, with the tool and its command named when they are
// known: an updater that does not own the binary would put a second copy beside it.

const SEMVER=/^v?(\d+)\.(\d+)\.(\d+)$/;

// ---- Paths, folder by folder.
// A path cut at its slashes (backslashes count as slashes): `as` keeps each folder as spelled, `low` is for comparing.
function segments(path){
  const as=String(path||"").replaceAll("\\","/").split("/");
  return {as,low:as.map(name=>name.toLowerCase())};
}
// A run of folder names, each a name or a list of names any of which will do, compared with low from index at.
const fits=(name,want)=>Array.isArray(want)?want.includes(name):name===want;
const runAt=(low,run,at)=>run.every((want,offset)=>fits(low[at+offset],want));
// The path has the folders of run somewhere after its first segment, and goes on past them.
function hasFolders(low,run){
  for(let at=1;at+run.length<low.length;at++)if(runAt(low,run,at))return true;
  return false;
}
// The path's last segments are run, with a slash before the first of them.
function endsIn(low,run){
  const at=low.length-run.length;
  return at>=1&&runAt(low,run,at);
}
const trimSlashes=text=>String(text||"").replaceAll("\\","/").replace(/\/+$/,"");
// The path lies in folder (letter case aside): the folder, without trailing slashes, then a slash.
function inside(path,folder){
  const root=trimSlashes(folder).toLowerCase();
  return root!==""&&String(path||"").replaceAll("\\","/").toLowerCase().startsWith(root+"/");
}
// An environment variable looked up by name in any letter case, trimmed ("" when unset): on Windows the same variable can come
// as ProgramFiles, PROGRAMFILES or programfiles, depending on what started the process.
function envNamed(env,name){
  const entry=Object.entries(env||{}).find(([key])=>key.toUpperCase()===name.toUpperCase());
  return entry?String(entry[1]||"").trim():"";
}

// ---- What the folders say.
// WinGet's id in a Packages\<id>_<source> folder the path goes on past (the text before the first "_", the source after it), or
// null.
const packageId=folder=>{const [id,...source]=folder.split("_");return id&&source.join("_")?id:null};
function wingetId(path){
  const {as,low}=segments(path);
  const at=low.findIndex((name,index)=>index>=1&&index+3<low.length&&name==="winget"&&low[index+1]==="packages"&&packageId(as[index+2]));
  return at<0?null:packageId(as[at+2]);
}
// The Homebrew keg a path lies in: a formula's Cellar/<name>/<version>/ or a cask's Caskroom/<name>/<version>/ folder (the last
// one, letter case aside), with Homebrew's prefix before it.
const kegKind=name=>name==="cellar"?"formula":name==="caskroom"?"cask":null;
function brewKeg(path){
  const {as,low}=segments(path);
  const at=low.findLastIndex((name,index)=>index>=1&&index+3<low.length&&kegKind(name)&&as[index+1]&&as[index+2]);
  return at<0?null:{kind:kegKind(low[at]),name:as[at+1],prefix:as.slice(0,at).join("/")};
}
// npm's global prefix for packageName at path: npm keeps a global package in <prefix>/lib/node_modules/<package>/ on Linux and
// macOS and in <prefix>\node_modules\<package>\ on Windows, where its command launchers sit in the prefix itself. A package
// inside another package or a project is not npm's global, nor is a mise tool's own folder (only mise's Node holds npm globals).
function npmPrefixOf(path,packageName,{platform,command,exists}){
  if(!packageName)return null;
  const {as,low}=segments(path),windows=platform==="win32";
  const run=[...(windows?[]:["lib"]),"node_modules",...String(packageName).toLowerCase().split("/")];
  let at=low.length-run.length-1;
  while(at>=1&&!runAt(low,run,at))at--;
  if(at<1)return null;
  // A node_modules folder between two slashes before it: a package in a package.
  if(low.slice(1,at-1).includes("node_modules"))return null;
  const [mise,installs,tool,version]=low.slice(at-4,at);
  if(at>=5&&mise==="mise"&&installs==="installs"&&tool&&version&&tool!=="node")return null;
  const length=as.slice(0,at).join("/").length,prefix=length?String(path).slice(0,length):"/";
  if(!windows)return prefix;
  // On Windows npm's launcher for the command (command.cmd, the sh script, command.ps1) proves the prefix.
  return command&&[".cmd","",".ps1"].some(extension=>exists(win32.join(prefix,command+extension)))?prefix:null;
}
// On Windows the file found may be npm's launcher in the prefix (codex.cmd): its folder is the prefix when the package's manifest
// is in that folder's node_modules.
function launcherFolderPrefix(found,packageName,{platform,exists}){
  if(platform!=="win32"||!found||!packageName)return null;
  const folder=win32.dirname(String(found));
  return exists(win32.join(folder,"node_modules",...String(packageName).split("/"),"package.json"))?folder:null;
}
// A shebang script that hands its tool to mise: the word mise, then white space, then x or exec (`mise x claude -- claude`).
const WORD=/\w/;
function handsToMise(text){
  const endsWithMise=word=>word.endsWith("mise")&&!WORD.test(word.charAt(word.length-5));
  const opensWith=(word,verb)=>word.startsWith(verb)&&!WORD.test(word.charAt(verb.length));
  return text.startsWith("#!")&&text.split(/\s+/).some((word,index,words)=>index+1<words.length&&endsWithMise(word)&&["x","exec"].some(verb=>opensWith(words[index+1],verb)));
}
// The text of a file small enough to be a wrapper script, or "" for one larger than WRAPPER_TEXT_LIMIT, a folder or a file that
// cannot be read. Reads no more than one byte past the limit.
const WRAPPER_TEXT_LIMIT=16*1024;
function launcherText(path){
  let handle=null;
  try{
    handle=openSync(path,"r");
    const buffer=Buffer.alloc(WRAPPER_TEXT_LIMIT+1);let filled=0;
    for(let got=1;got&&filled<buffer.length;filled+=got)got=readSync(handle,buffer,filled,buffer.length-filled,null);
    return filled>WRAPPER_TEXT_LIMIT?"":buffer.toString("utf8",0,filled);
  }catch{return ""}
  finally{if(handle!=null)try{closeSync(handle)}catch{}}
}

// ---- Who updates the binary: each judge returns an owner or null, and the first owner stands.
const PERSONS={method:"manual",by:null,command:null};
// Package managers with homes of their own for what a person installs globally, which only they update. Each entry has:
// - update: the command that installs a package again at its latest version, which is how each updates a global in place;
// - usual: the folders its documentation names for those homes when nothing moves them (runs of folder names in lower case, a
//   list being any of its names), from Windows to the others, executables before packages. Found anywhere in a path;
// - homeVariable, with launchers and packages: the variable that moves the home, and the folders under a home it names that are
//   the manager's own: launchers holds its executables (a file directly in one), packages its global packages (anything below).
//   Only those count: a variable can name a folder other installers share too, such as /usr/local.
// From each manager's own documentation or source:
// - bun: ~/.bun, executables in bin and packages in install/global; with BUN_INSTALL, $BUN_INSTALL/bin and
//   $BUN_INSTALL/install/global (oven-sh/bun, src/install/PackageManager/PackageManagerOptions.rs).
// - pnpm: its home in the per-user data folder (AppData/Local/pnpm, Library/pnpm, or pnpm under an XDG data folder such as
//   ~/.local/share or /usr/local/share), packages in its global folder. With PNPM_HOME, pnpm 10 links executables into the home
//   itself and pnpm 11 into its bin; packages go to $PNPM_HOME/global (pnpm.io's settings for each). pnpm 10 runs a dependency's
//   build script only when told to (--allow-build, from 10.4), and Claude Code needs its own to put its native binary in place.
// - Vite+: vite-plus in the per-user data folder (AppData's Local or Roaming, or share under XDG's), earlier releases .vite-plus in
//   the home folder, executables in its bin. VP_HOME holds the bin folder and the data, whose packages folder keeps each global
//   package (voidzero-dev/vite-plus: crates/vp_shared/src/env_config.rs, crates/vp_global_cli/src/commands/env/config.rs).
// - Yarn 1 (the release with yarn global): executables in AppData/Local/Yarn/bin or .yarn/bin, packages in Yarn/Data/global or
//   yarn/global under the configuration folder. No variable moves them.
const KEEPERS=[
  {by:"bun",update:name=>`bun add -g ${name}@latest`,usual:[[".bun","bin"],[".bun","install","global"]],
    homeVariable:"BUN_INSTALL",launchers:["bin"],packages:["install/global"]},
  {by:"pnpm",update:name=>`pnpm add -g --allow-build=${name} ${name}@latest`,usual:[["appdata","local","pnpm"],["library","pnpm"],["share","pnpm"],["pnpm","global"]],
    homeVariable:"PNPM_HOME",launchers:["","bin"],packages:["global"]},
  {by:"Vite+",update:name=>`vp install -g ${name}@latest`,usual:[["appdata",["local","roaming"],"vite-plus","bin"],["share","vite-plus","bin"],[".vite-plus","bin"]],
    homeVariable:"VP_HOME",launchers:["bin"],packages:["packages"]},
  {by:"Yarn",update:name=>`yarn global add ${name}@latest`,usual:[["appdata","local","yarn","bin"],[".yarn","bin"],["yarn","data","global"],["yarn","global"]],
    homeVariable:null,launchers:[],packages:[]},
];
const keptBy=(keeper,seen)=>({method:"manual",by:keeper.by,command:keeper.update(seen.packageName)});
// The path's file sits directly in folder (letter case aside), not in a folder below it.
function directlyIn(path,folder){
  const text=String(path||"").replaceAll("\\","/"),cut=text.lastIndexOf("/"),want=trimSlashes(folder);
  return cut>0&&want!==""&&text.slice(0,cut).toLowerCase()===want.toLowerCase();
}
// Whether one of the paths lies in the keeper's own folders under the home its variable names in the environment Trebell got.
function inNamedHome(keeper,seen){
  const home=keeper.homeVariable?trimSlashes(envNamed(seen.env,keeper.homeVariable)):"";
  if(!home)return false;
  const under=folder=>folder?`${home}/${folder}`:home;
  return seen.paths.some(path=>keeper.launchers.some(folder=>directlyIn(path,under(folder)))||keeper.packages.some(folder=>inside(path,under(folder))));
}
// npm's own layout explains the binary (npm's folders documentation): the package in a prefix's global packages and the command's
// link (the path found, else the first one given) in that prefix's executables, <prefix>/bin on Linux and macOS and the prefix
// itself on Windows; or, on Windows, the path found is npm's launcher with the package's folder beside it.
function npmLaidOut(seen){
  const windows=seen.platform==="win32",prefix=npmPrefixOf(seen.real,seen.packageName,seen);
  if(windows&&launcherFolderPrefix(seen.found,seen.packageName,seen))return true;
  return prefix!=null&&directlyIn(seen.paths[0],windows?prefix:`${trimSlashes(prefix)}/bin`);
}
const VOLTA_SHIMS=new Set(["volta-shim","volta-shim.exe"]);
const JUDGES=[
  // WinGet installs per user under %LOCALAPPDATA%\Microsoft\WinGet and per machine under %ProgramFiles%\WinGet (or the x86 one),
  // putting command links in Links and each package in Packages\<id>_<source>. A binary there is WinGet's to update: Claude
  // Code's own `claude update` reports success on it and changes nothing.
  function winget(seen){
    if(seen.platform!=="win32")return null;
    const local=envNamed(seen.env,"LOCALAPPDATA");
    const roots=[local&&local+"/Microsoft",envNamed(seen.env,"ProgramFiles"),envNamed(seen.env,"ProgramFiles(x86)")].filter(Boolean);
    const kept=seen.paths.some(path=>roots.some(root=>["Links","Packages"].some(folder=>inside(path,`${trimSlashes(root)}/WinGet/${folder}`))));
    if(!kept)return null;
    const id=seen.paths.map(wingetId).find(Boolean);
    return {method:"manual",by:"WinGet",command:id?`winget upgrade ${id}`:null};
  },
  // The harness's own installer, unless mise runs what is there (a launcher where a native install goes can hand over to mise).
  function ownInstaller(seen){
    const lows=seen.views.map(view=>view.low);
    let owner=null;
    if(seen.kind==="claude"&&lows.some(low=>endsIn(low,[".local","bin",["claude","claude.exe"]])||hasFolders(low,[".local","share","claude"])))owner={method:"native",args:["update"]};
    else if(seen.kind==="opencode"&&lows.some(low=>endsIn(low,[".opencode","bin",["opencode","opencode.exe"]])))owner={method:"native",args:["upgrade"]};
    else if(seen.kind==="codex"&&seen.codexHome&&seen.paths.some(path=>inside(path,`${trimSlashes(seen.codexHome)}/packages/standalone`)))owner={method:"native",args:["update"],env:{CODEX_HOME:seen.codexHome}};
    else if(seen.kind==="grok"&&seen.grokHome&&seen.paths.some(path=>inside(path,seen.grokHome)))owner={method:"native",args:["update"]};
    return owner&&!seen.mise?owner:null;
  },
  // Every tool Volta installs runs through its shim, whatever folder holds the link to it.
  seen=>VOLTA_SHIMS.has(seen.realView.low.at(-1))?{method:"manual",by:"Volta",command:`volta install ${seen.packageName}@latest`}:null,
  // A manager's usual folders, before npm: Yarn's global folder on Windows holds a node_modules that npm's reading below would
  // take for a prefix.
  function usualHome(seen){
    const keeper=KEEPERS.find(item=>seen.views.some(({low})=>item.usual.some(run=>hasFolders(low,run))));
    return keeper?keptBy(keeper,seen):null;
  },
  // A home a manager's variable names is the weakest sign, as the variable may name a folder other installers share: it gives
  // way when npm's own layout, mise or a Homebrew keg explains the binary. It is still asked before npm, because each Vite+
  // global package is laid out like an npm prefix of its own (under VP_HOME/packages, its link in VP_HOME/bin).
  function namedHome(seen){
    const keeper=KEEPERS.find(item=>inNamedHome(item,seen));
    return keeper&&!npmLaidOut(seen)&&!seen.mise&&!seen.keg?keptBy(keeper,seen):null;
  },
  // Asked before mise and Homebrew: a package installed with npm install -g by a Node that Homebrew or mise provides sits in
  // their folders, yet npm is what updates it.
  function npm(seen){
    const prefix=npmPrefixOf(seen.real,seen.packageName,seen)||launcherFolderPrefix(seen.found,seen.packageName,seen);
    return prefix?{method:"npm",prefix}:null;
  },
  seen=>seen.mise?{method:"manual",by:"mise",command:null}:null,
  seen=>seen.keg?{method:"manual",by:"Homebrew",command:`brew upgrade ${seen.keg.kind==="cask"?"--cask ":""}${seen.keg.name}`}:null,
];

// Decides who updates a harness, from up to three paths: found (the file the profile names, or the one PATH gives), binary (what
// an npm launcher starts) and real (that binary with its links resolved). The answer takes one of three shapes:
// - {method:"npm",prefix}: Trebell reinstalls it with npm into that global prefix;
// - {method:"native",args,env?}: the harness updates itself when its binary runs with args (and env);
// - {method:"manual",by,command}: the person updates it with the tool in by, command being the line to run, each null when
//   not known.
// codexHome is the profile's shared Codex home, whose packages/standalone tree `codex update` maintains; grokHome is the folder
// `grok update` installs into. exists tells whether a file is there; read returns a small launcher's text (launcherText).
export function harnessInstallOwner(kind,{paths,packageName,command=kind,platform=process.platform,env={},codexHome=null,grokHome=null,exists=existsSync,read=launcherText}={}){
  const given=[];
  for(const path of [paths?.found,paths?.binary,paths?.real])if(path&&!given.includes(path))given.push(path);
  if(!given.length)return {...PERSONS};
  const real=paths.real||given.at(-1),views=given.map(segments);
  let mise,keg;
  const seen={kind,packageName,command,platform,env,codexHome,grokHome,exists,paths:given,views,real,realView:segments(real),found:paths.found,
    get keg(){if(keg===undefined)keg=brewKeg(real);return keg},
    // mise runs it: a path in mise's installs or shims, mise itself from Homebrew, or a script that hands over to mise (read last).
    get mise(){
      if(mise===undefined)mise=views.some(({low})=>hasFolders(low,["mise",["installs","shims"]]))||(this.keg?.kind==="formula"&&this.keg.name.toLowerCase()==="mise")||handsToMise(String(read(real)||""));
      return mise;
    },
  };
  for(const judge of JUDGES){const owner=judge(seen);if(owner)return owner}
  return {...PERSONS};
}
// The version npm recorded for packageName in its global prefix, from the package's manifest there (<prefix>\node_modules\<package>
// on Windows, <prefix>/lib/node_modules/<package> elsewhere), or null: none, or a prerelease Trebell's version checks cannot compare.
export function npmRecordedVersion(prefix,packageName,{platform=process.platform,read=path=>readFileSync(path,"utf8")}={}){
  if(!prefix||!packageName)return null;
  const paths=platform==="win32"?win32:posix,manifest=paths.join(String(prefix),...(platform==="win32"?[]:["lib"]),"node_modules",...packageName.split("/"),"package.json");
  try{const version=String(JSON.parse(read(manifest))?.version||"").trim();return SEMVER.test(version)?version.replace(/^v/,""):null}catch{return null}
}
// The arguments of npm's global install of packageName, pinned to version when one is given and into prefix when the install has
// one. The package's own install script is allowed by name: npm 12 skips every script not allowed that way, and Claude Code and
// OpenCode use theirs to put their native binary in place (an npm before 12 at most warns that it does not know the flag).
export function npmInstallArgs(packageName,version=null,prefix=null){
  const args=["install","-g"];
  if(prefix)args.push("--prefix",prefix);
  args.push("--allow-scripts="+packageName,version?`${packageName}@${version}`:packageName);
  return args;
}
// A command as the person would type it, a word with spaces or shell characters quoted.
export function shownCommand(command,args=[],platform=process.platform){
  const quote=word=>/^[\w./:\\@=+,-]+$/.test(word)?word:platform==="win32"?`"${word}"`:`'${word.replaceAll("'","'\\''")}'`;
  return [command,...args].map(word=>quote(String(word))).join(" ");
}
// Who installed a binary, said in Settings and in a refused update: the tool and, when it is known, the command that updates it
// (pnpm takes --allow-build from 10.4 on, and an older pnpm refuses an option it does not know). Settings shows what is between
// backticks as code.
function installedBy(by,command){
  if(!command)return `installed by ${by}: update it with ${by}`;
  return `installed by ${by}: run \`${command}\` to update it${command.includes(" --allow-build=")?" (pnpm 10.4 or later; on an older pnpm, leave out `--allow-build`)":""}`;
}
// What Settings says of a newer release that Trebell does not install itself: the release, the file the profile runs,
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
// The newest release npm's registry names for packageName, or null when it could not be read. line:
// the newest of that major (an OpenCode updates only within its own): its latest when that is of the line, else the newest stable one
// of the line that the package's document lists, which is read only then (it lists every release: some MB). timeoutMs: Trebell's
// own 3 s, over thirty times the 0.06-0.09 s npm's registry took to answer a /latest read here (2026-11-01).
export async function registryRelease(fetchImpl,packageName,{timeoutMs=3000,line=null}={}){
  const read=async(path,accept,ms)=>{const response=await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(packageName)}${path}`,{headers:{accept},signal:AbortSignal.timeout(ms)});return response?.ok?await response.json():null};
  try{
    const body=await read("/latest","application/json",timeoutMs),version=typeof body?.version==="string"?body.version.trim():"";
    const latest=SEMVER.test(version)?version.replace(/^v/,""):null;
    if(!latest||line==null||Number(SEMVER.exec(latest)[1])===line)return latest;
    const document=await read("","application/vnd.npm.install-v1+json",Math.max(timeoutMs,15_000));
    return newestListed(JSON.stringify(Object.keys(document?.versions||{}).filter(item=>Number(SEMVER.exec(item)?.[1])===line)));
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
