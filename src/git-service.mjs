import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";

const execFileAsync=promisify(execFile);

// git follows a refusal with hint: lines for a person at a terminal: the commands to run next and the setting that turns the hint
// off ("Disable this message with …"). A failure says git's reason without them; one that is all hints keeps them. A color git was
// set to give its hints (color.advice=always) is taken off first, so they are known as hints too.
// Some refusals the Git panel meets often give their reason only in those hints, or only as commands to type, so these say it in
// plain words instead: a Pull from a branch that has diverged or has no upstream, and anything from no branch at all. A Push the
// remote refused for its newer commits says it before git's other lines, which name the branch and the remote.
const PLAIN_REASONS=[
  {test:/^ ! \[rejected\] .*\((?:fetch first|non-fast-forward)\)$/m,reason:"The remote has commits this branch does not have. Pull them first, then push again.",before:true},
  {test:/^fatal: Not possible to fast-forward, aborting\.$/m,reason:"This branch and its upstream have diverged, each with commits the other does not have."},
  {test:/^There is no tracking information for the current branch\.$/m,reason:"This branch has no upstream yet. Push it first to create one."},
  {test:/^(?:fatal: )?You are not currently on a branch\.$/m,reason:"Not on a branch: switch to a branch first."},
];
export function gitReason(text){
  const all=String(text??"").replace(/\x1b\[[0-9;]*[A-Za-z]/g,"").replace(/\r\n?/g,"\n").trim();
  const reason=all.split("\n").filter(line=>!line.startsWith("hint:")).join("\n").trim()||all;
  const plain=PLAIN_REASONS.find(item=>item.test.test(all));
  return plain?(plain.before?plain.reason+"\n"+reason:plain.reason):reason;
}
// git writes its messages in English, the C locale's, whatever locale the person's own is: the Git panel is in English, and
// gitReason reads git's English, "hint:" among it (git translates that too). Only the messages change: an LC_ALL, which would
// override LC_MESSAGES, gives its value to the other categories instead, so file names, sorting and dates in a hook stay as they were.
export function gitEnvironment(env=process.env){
  const next={...env};
  if(next.LC_ALL){for(const name of ["LC_CTYPE","LC_COLLATE","LC_NUMERIC","LC_TIME","LC_MONETARY"])if(!next[name])next[name]=next.LC_ALL;delete next.LC_ALL}
  next.LC_MESSAGES="C";
  return next;
}
async function run(command,args,{cwd,env=process.env,timeout=120000,maxBuffer=8*1024*1024,allowFailure=false}={}){
  try{
    const result=await execFileAsync(command,args,{cwd,env:command==="git"?gitEnvironment(env):env,windowsHide:true,timeout,maxBuffer});
    return {ok:true,stdout:result.stdout||"",stderr:result.stderr||""};
  }catch(error){
    if(!allowFailure) throw new Error(gitReason(error.stderr||error.stdout||error.message||String(error)));
    return {ok:false,stdout:error.stdout||"",stderr:error.stderr||error.message||"",code:error.code??1};
  }
}
export async function git(cwd,args,opts={}){ return run("git",args,{cwd,...opts}); }

// The repository part of a folder's gitInfo (root, branch, branches, upstream, remotes, worktrees) is kept while the files git reads
// it from are unchanged, for at most 30 s: HEAD from the git dir (so a linked worktree or a submodule reads its own), and config,
// packed-refs, refs/heads, refs/remotes (the upstream needs its ref) and worktrees from the common dir. git replaces a ref through a
// lock file in its own folder, which changes that folder's modification time, so every folder below the refs (a commit on
// feature/x, a new branch in it) counts too. The worktree list reads the main worktree's HEAD from the common dir, and in worktrees
// the folder (a worktree added or removed) and each worktree's HEAD and gitdir (its path, which git worktree move and repair write
// in place), but not each worktree's folder: that is a linked worktree's git dir, which holds its index, and every status that may
// write the index (the full read's, an agent's git add) creates and removes the index lock there. A reftable repository
// (--ref-format=reftable, the default planned for Git 3) keeps every ref, HEAD among them, in a reftable folder instead, where git
// replaces tables.list on each update: the common dir's holds the branches and the main worktree's HEAD, and each linked
// worktree's folder has its own for its HEAD; .git/HEAD and refs/heads are stubs that never change. A warm poll then runs only git
// status, which is read every time. The stats run in parallel off the event loop (about 900 of them with 300 worktrees), and a
// linked worktree's reftable only where the common dir has one.
// A caller's own env (a checkpoint's) can point git elsewhere, so only calls without one are kept.
const GIT_INFO_REUSE_MS=30_000;
const STATUS_ARGS=["status","--porcelain=v1","-b"];
const repositoryParts=new Map();
// The folder asked about and each one above it below the root: git looks in each for a repository of its own (a .git, or a bare
// repository's HEAD) before it reaches the root, so a git init, a clone or a new worktree there makes the next poll read everything.
function foldersBelowRoot(base,root){
  const folders=[],top=resolve(root),same=process.platform==="win32"?(a,b)=>a.toLowerCase()===b.toLowerCase():(a,b)=>a===b;
  for(let folder=base;!same(folder,top);){folders.push(folder);const parent=dirname(folder);if(parent===folder)break;folder=parent}
  return folders;
}
async function repositorySignature(gitDir,commonDir,base,root){
  const add=async(path,depth=0)=>{
    let info;try{info=await stat(path)}catch{return "-"}
    const part=info.mtimeMs+":"+info.size+":"+info.ino;if(depth<=0||!info.isDirectory())return part;
    let entries=[];try{entries=await readdir(path,{withFileTypes:true})}catch{}
    return [part,...await Promise.all(entries.filter(entry=>entry.isDirectory()).map(entry=>add(join(path,entry.name),depth-1)))].join("|");
  };
  const all=(...parts)=>Promise.all(parts).then(list=>list.join("|"));
  const worktrees=join(commonDir,"worktrees"),commonTables=await add(join(commonDir,"reftable","tables.list"));
  let linked=[];try{linked=(await readdir(worktrees,{withFileTypes:true})).filter(entry=>entry.isDirectory())}catch{}
  return all(
    add(join(gitDir,"HEAD")),add(join(gitDir,"config.worktree")),add(join(commonDir,"config")),add(join(commonDir,"packed-refs")),
    add(join(commonDir,"refs","heads"),16),add(join(commonDir,"refs","remotes"),16),add(join(commonDir,"HEAD")),add(worktrees),
    ...linked.map(entry=>all(entry.name,add(join(worktrees,entry.name,"HEAD")),add(join(worktrees,entry.name,"gitdir")),commonTables==="-"?"":add(join(worktrees,entry.name,"reftable","tables.list")))),
    add(join(gitDir,"reftable","tables.list")),commonTables,
    ...foldersBelowRoot(base,root).map(folder=>all(add(join(folder,".git")),add(join(folder,"HEAD")))),
  );
}
// A warm poll's status never takes git's optional index lock, so a poll every 3.5 s does not hold the lock an agent's git add or
// commit needs (git fails at once when it is held) or rewrite the index and wake file watchers. The full read, at most 30 s apart,
// lets status take it: a file written again with the same content (a build, a formatter, a copy) differs from its index entry only
// in its times, and git reads and hashes it on every status until one that may write the index records them.
const statusOptions=opts=>({...opts,env:{...(opts.env||process.env),GIT_OPTIONAL_LOCKS:"0"},allowFailure:true});
function gitInfoResult(base,part,statusRes){
  const statusLines=statusRes.stdout.split(/\r?\n/).filter(Boolean);
  return {
    isGit:true,cwd:base,root:part.root,branch:part.branch,
    upstream:part.upstream,
    branches:[...part.branches],
    status:statusLines.slice(1).map(line=>({code:line.slice(0,2),path:line.slice(3)})),
    statusHeader:statusLines[0]||"",
    remotes:part.remotes.map(item=>({...item})),worktrees:part.worktrees.map(item=>({...item})),
  };
}

// A cold read takes the repository part from the git dir's own files, read the way git reads them, and asks git only for what the
// files leave open: reftable refs, config this strict reading does not take (an include, URL rewriting, an unusual line, config from
// outside the repository that names remotes or branches), an upstream whose short name git would spell otherwise, a worktree
// whose gitdir is relative, a symbolic-ref chain longer than three, and a read during which packed-refs changed. A field left
// undefined below is git's to answer. Every read is asynchronous: a repository with 300 worktrees has 600 admin files.
const readText=path=>readFile(path,"utf8").catch(()=>null);
const byteOrder=(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
const gitBool=value=>value===null||(value!==undefined&&/^(true|yes|on|[1-9]\d*)$/i.test(String(value).trim()));
const symref=text=>text!==null&&text.startsWith("ref:")?text.slice(4).trim():null;
// git's check_refname_format: no component starting with ".", no "..", control characters, space, ~ ^ : ? * [ \ or "@{", no component
// ending in ".lock", no empty component, no trailing "/" or ".".
const BAD_REF=/(^|\/)\.|\.\.|[\x00-\x20\x7f~^:?*[\\]|@\{|\.lock(\/|$)|\/\/|^\/|[/.]$/;
// git's value syntax: quotes toggle, \\ \" \n \t \b are escapes, an unquoted # or ; starts a comment, and unquoted blanks are kept
// inside the value and dropped at its ends. undefined where git reports an error or the value continues on the next line.
function configValue(raw){
  let out="",blank="",quote=false;
  for(let i=0;i<raw.length;i++){
    const c=raw[i];
    if(!quote&&(c==="#"||c===";"))break;
    if(!quote&&(c===" "||c==="\t"||c==="\r")){if(out)blank+=c;continue}
    out+=blank;blank="";
    if(c==="\\"){const escaped={"\\":"\\",'"':'"',n:"\n",t:"\t",b:"\b"}[raw[++i]];if(escaped===undefined)return undefined;out+=escaped}
    else if(c==='"')quote=!quote;
    else out+=c;
  }
  return quote?undefined:out;
}
// [section] and [section "subsection"] headers, key = value entries (a key alone is git's true) and comments. A legacy
// [section.sub] header, a key after a header on its line, a value git rejects or continues, a valueless remote, branch or url key,
// or an include makes the file odd.
function parseGitConfig(text){
  const entries=[];let section=null,subsection="",odd=false;
  for(const line of (text||"").replace(/^\uFEFF/,"").split(/\r?\n/)){
    const m=line.match(/^[ \t]*(?:\[([A-Za-z0-9-]+)(?:[ \t]+"((?:[^"\\]|\\.)*)")?\][ \t]*(?:[#;].*)?|([A-Za-z][A-Za-z0-9-]*)[ \t]*(?:=(.*))?|[#;].*)?$/);
    if(!m){odd=true;continue}
    if(m[1]){section=m[1].toLowerCase();subsection=(m[2]??"").replace(/\\(.)/g,"$1");odd||=section==="include"||section==="includeif";continue}
    if(!m[3])continue;
    const value=m[4]===undefined?null:configValue(m[4]);
    if(section===null||value===undefined||(value===null&&/^(remote|branch|url)$/.test(section))){odd=true;continue}
    entries.push({section,subsection,key:m[3].toLowerCase(),value});
  }
  return {entries,odd};
}
function configView(entries){
  const values=(section,subsection,key)=>entries.filter(e=>e.section===section&&e.subsection===subsection&&e.key===key).map(e=>e.value);
  return {entries,values,last:(...key)=>values(...key).at(-1)};
}
let systemConfig;
// The system config of the git on PATH: <prefix>/etc/gitconfig (Git for Windows: <install>/etc/gitconfig), /etc/gitconfig for /usr.
function systemConfigPath(){
  if(systemConfig!==undefined)return systemConfig;systemConfig="/etc/gitconfig";
  for(const dir of String(process.env.PATH||"").split(delimiter)){
    if(!dir||!existsSync(join(dir,process.platform==="win32"?"git.exe":"git")))continue;
    let prefix=dirname(dir);if(/^(mingw32|mingw64|clangarm64)$/i.test(basename(prefix)))prefix=dirname(prefix);
    if(process.platform==="win32"||prefix!=="/usr")systemConfig=join(prefix,"etc","gitconfig");break;
  }
  return systemConfig;
}
// git's home folder: HOME, or where HOME is unset on Windows, HOMEDRIVE plus HOMEPATH while that folder exists and USERPROFILE
// otherwise, as Git for Windows sets it at startup (a server not started from Git Bash has no HOME).
async function gitHome(env){
  if(env.HOME)return env.HOME;
  if(process.platform==="win32"){
    if(env.HOMEDRIVE&&env.HOMEPATH&&await stat(env.HOMEDRIVE+env.HOMEPATH).then(info=>info.isDirectory(),()=>false))return env.HOMEDRIVE+env.HOMEPATH;
    if(env.USERPROFILE)return env.USERPROFILE;
  }
  return homedir();
}
// Config from outside the repository (git -c, the global and system files) that configures a remote or a branch, rewrites URLs or
// includes other files leaves remotes and the upstream to git; branch.sort and the like do not.
async function outsideConfig(env){
  if(env.GIT_CONFIG_PARAMETERS||Number(env.GIT_CONFIG_COUNT)>0)return true;
  const home=await gitHome(env),files=env.GIT_CONFIG_GLOBAL!==undefined?[env.GIT_CONFIG_GLOBAL]:[env.XDG_CONFIG_HOME?join(env.XDG_CONFIG_HOME,"git","config"):join(home,".config","git","config"),join(home,".gitconfig")];
  if(!gitBool(env.GIT_CONFIG_NOSYSTEM))files.push(env.GIT_CONFIG_SYSTEM??systemConfigPath(),process.platform==="win32"&&env.PROGRAMDATA?join(env.PROGRAMDATA,"Git","config"):"");
  const texts=await Promise.all(files.filter(Boolean).map(readText));
  return texts.some(text=>{if(!text)return false;const {entries,odd}=parseGitConfig(text);return odd||entries.some(e=>e.section==="url"||((e.section==="remote"||e.section==="branch")&&e.subsection))});
}
// The loose refs below a folder as git lists them: entries starting with "." and lock files are not refs.
async function looseRefNames(dir,prefix=""){
  let entries=[];try{entries=await readdir(dir,{withFileTypes:true})}catch{}
  const lists=await Promise.all(entries.filter(entry=>!entry.name.startsWith(".")&&!entry.name.endsWith(".lock")).map(entry=>entry.isDirectory()?looseRefNames(join(dir,entry.name),prefix+entry.name+"/"):entry.isFile()?[prefix+entry.name]:[]));
  return lists.flat();
}
function mapFetchRef(source,fetchSpecs){
  for(let spec of fetchSpecs){spec=spec.replace(/^\+/,"");const [from,to]=spec.split(":");if(!from||!to)continue;
    const star=from.indexOf("*");if(star<0){if(from===source)return to;continue}
    const before=from.slice(0,star),after=from.slice(star+1);if(!source.startsWith(before)||!source.endsWith(after))continue;
    const middle=source.slice(before.length,source.length-after.length);return to.replace("*",middle);
  }
  return null;
}
// git remote -v: remotes by name, each with its first url to fetch from and every pushurl (or else every url) to push to; a remote
// with no url is its bare name, as git prints it. An empty url (which resets the list) is git's to read.
function directRemotes(config){
  const names=[...new Set(config.entries.filter(e=>e.section==="remote"&&e.subsection).map(e=>e.subsection))].sort(byteOrder),out=[];
  for(const name of names){
    const urls=config.values("remote",name,"url"),push=config.values("remote",name,"pushurl");if([...urls,...push].includes(""))return undefined;
    out.push(urls.length?{name,url:urls[0],kind:"fetch"}:{raw:name+"\t"});for(const url of push.length?push:urls)out.push({name,url,kind:"push"});
  }
  return out;
}
const parseRemotes=text=>text.split(/\r?\n/).filter(Boolean).map(line=>{const m=line.match(/^(\S+)\t(.*) \((fetch|push)\)(?: \[[^\]]*\])?$/);return m?{name:m[1],url:m[2],kind:m[3]}:{raw:line}});
// packed-refs holds "<id> <ref>" lines (a "^<id>" line peels the tag above it). Only branches and remote-tracking refs are read
// whole: tags are most of a big file (50,000 of them took about 30 ms of the event loop as one parse), and the few other names the
// upstream check asks about are found by name.
const HEX=/^[0-9a-fA-F]+$/;
function packedBranchesAndRemotes(text,size){
  const refs=new Map();
  for(let start=0;start<text.length;){
    let end=text.indexOf("\n",start);if(end<0)end=text.length;
    const name=start+size+1;
    if(text.charCodeAt(start+size)===32&&(text.startsWith("refs/heads/",name)||text.startsWith("refs/remotes/",name))){
      const id=text.slice(start,start+size);if(HEX.test(id))refs.set(text.slice(name,text[end-1]==="\r"?end-1:end),id.toLowerCase());
    }
    start=end+1;
  }
  return refs;
}
function packedLine(text,ref,size){
  for(let at=text.indexOf(" "+ref);at>=0;at=text.indexOf(" "+ref,at+1)){
    const start=at-size,end=at+1+ref.length;
    if(start<0||(start>0&&text[start-1]!=="\n")||(end<text.length&&text[end]!=="\n"&&text[end]!=="\r"))continue;
    const id=text.slice(start,at);if(HEX.test(id))return id.toLowerCase();
  }
  return null;
}
const fileStamp=path=>stat(path).then(info=>info.mtimeMs+":"+info.size+":"+info.ino,()=>"-");
// git's @{upstream}: branch.<name>.remote (the last) and .merge (the first), the merge ref mapped through that remote's fetch
// refspecs (taken as it is for remote "."), and only while that ref exists; named as rev-parse --abbrev-ref names it.
async function directUpstream(config,branch,resolveRef){
  if(!branch)return null;
  const remote=config.last("branch",branch,"remote"),merge=config.values("branch",branch,"merge")[0];if(!remote||!merge)return null;
  const specs=remote==="."?[]:config.values("remote",remote,"fetch");
  if(specs.some(spec=>spec.startsWith("^"))||(remote==="."&&!merge.startsWith("refs/")))return undefined;
  const ref=remote==="."?merge:mapFetchRef(merge,specs);if(!ref||!await resolveRef(ref))return null;
  const start=["refs/remotes/","refs/heads/"].find(prefix=>ref.startsWith(prefix));if(!start)return undefined;
  const short=ref.slice(start.length),others=["refs/","refs/tags/","refs/heads/","refs/remotes/"].map(prefix=>prefix+short).concat("refs/remotes/"+short+"/HEAD").filter(name=>name!==ref);
  return (await Promise.all(others.map(name=>resolveRef(name)))).some(Boolean)?undefined:short;
}
// git's fspathcmp as a sort key: bytes, ASCII case folded under core.ignoreCase, and on Windows a directory separator (either one)
// before any other character, as Git for Windows compares paths.
function pathSortKey(path,lower){
  const bytes=Buffer.from(lower?path.replace(/[A-Z]/g,c=>c.toLowerCase()):path);
  if(process.platform==="win32")for(let i=0;i<bytes.length;i++)if(bytes[i]===47||bytes[i]===92)bytes[i]=0;
  return bytes;
}
// git worktree list: the main worktree first, at the common dir's real path without its /.git (git's own spelling, which is how the
// root is spelled; a bare repository lists only that), then each worktrees/<id> whose gitdir file names a folder, by path as git
// sorts them. A relative gitdir (worktree.useRelativePaths) is git's to resolve.
async function directWorktrees(commonDir,commonPath,config,headOf){
  const bare=gitBool(config.last("core","","bare")),lower=gitBool(config.last("core","","ignorecase"));
  const mainState=bare?{bare:true}:await headOf(join(commonDir,"HEAD"));if(!mainState)return undefined;
  const main={path:commonPath.replace(/\/\.git$/,"").replace(/\/\.$/,""),...mainState};
  const admin=join(commonDir,"worktrees");let ids=[];try{ids=(await readdir(admin,{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>entry.name)}catch{}
  const linked=await Promise.all(ids.map(async id=>{
    const [gitdir,state]=await Promise.all([readText(join(admin,id,"gitdir")),headOf(join(admin,id,"HEAD"))]);
    const path=(gitdir||"").replace(/\s+$/,"").replace(/\/\.git$/,"");
    return !path?null:isAbsolute(path)&&state?{key:pathSortKey(path,lower),entry:{path,...state}}:undefined;
  }));
  if(linked.includes(undefined))return undefined;
  return [main,...linked.filter(Boolean).sort((a,b)=>Buffer.compare(a.key,b.key)).map(item=>item.entry)];
}
// git reads loose refs before packed-refs, so a git pack-refs (gc --auto and maintenance run one) never hides a ref: it writes the
// new packed-refs before it deletes the loose files. These reads go the other way, so a read during which packed-refs changed is
// git's to answer.
async function directRepository(gitDir,commonDir,commonPath,env){
  const packedPath=join(commonDir,"packed-refs"),packedStamp=await fileStamp(packedPath);
  const [configText,headText,packedText,ownTables,commonTables,outside,legacy]=await Promise.all([
    readText(join(commonDir,"config")),readText(join(gitDir,"HEAD")),readText(packedPath),
    readText(join(gitDir,"reftable","tables.list")),readText(join(commonDir,"reftable","tables.list")),outsideConfig(env),
    Promise.all(["remotes","branches"].map(name=>readdir(join(commonDir,name)).then(list=>list.length>0,()=>false))).then(list=>list.some(Boolean)),
  ]);
  // config.worktree counts only with extensions.worktreeConfig, as in git.
  let {entries,odd}=parseGitConfig(configText);
  if(gitBool(configView(entries).last("extensions","","worktreeconfig"))){const own=parseGitConfig(await readText(join(gitDir,"config.worktree")));entries=[...entries,...own.entries];odd||=own.odd}
  const config=configView(entries),out={},ownRules=!odd&&!outside&&!legacy;
  if(ownRules&&!entries.some(e=>e.section==="url"))out.remotes=directRemotes(config);
  if(ownTables!==null||commonTables!==null)return out;
  const size=/^sha256$/i.test(config.last("extensions","","objectformat")??"")?64:40,zero="0".repeat(size),idPattern=new RegExp(`^[0-9a-fA-F]{${size}}(?!\\S)`);
  const packed=packedBranchesAndRemotes(packedText||"",size),packedId=name=>name.startsWith("refs/heads/")||name.startsWith("refs/remotes/")?packed.get(name)||null:packedText?packedLine(packedText,name,size):null;
  const loose=new Map(),looseHeads=new Set(await looseRefNames(join(commonDir,"refs","heads"))),idOf=text=>{const id=idPattern.exec(text)?.[0].toLowerCase();return id&&id!==zero?id:null};
  const looseText=name=>{if(!loose.has(name))loose.set(name,readText(join(commonDir,...name.split("/"))));return loose.get(name)};
  // A loose ref (an object id, or ref: another ref) hides its packed-refs line; null where git's reading finds no object id. A branch
  // with no loose file is not opened.
  const resolveRef=async(name,depth=0)=>{
    if(depth>5||BAD_REF.test(name))return null;
    if(name.startsWith("refs/heads/")&&!looseHeads.has(name.slice(11)))return packedId(name);
    const text=await looseText(name),target=symref(text);
    return text===null?packedId(name):target!==null?resolveRef(target,depth+1):idOf(text);
  };
  // The ref a symbolic ref ends at, as git follows it: HEAD naming refs/heads/master, which holds "ref: refs/heads/main" (a branch
  // alias made with git symbolic-ref), is on main. packed-refs holds no symbolic refs. A chain longer than three, or a name git
  // rejects, is git's to answer (undefined).
  const finalRef=async(name,depth=0)=>{
    if(depth>3||BAD_REF.test(name))return undefined;
    if(name.startsWith("refs/heads/")&&!looseHeads.has(name.slice(11)))return name;
    const target=symref(await looseText(name));
    return target===null?name:finalRef(target,depth+1);
  };
  // A worktree's HEAD as git worktree list prints it: its commit (all zeros on an unborn branch) and the ref it ends at, without
  // refs/heads/.
  const headOf=async file=>{
    const text=await readText(file),ref=symref(text);if(ref===null)return {head:(text!==null&&idOf(text))||zero};
    const end=await finalRef(ref);return end===undefined?undefined:{head:await resolveRef(ref)||zero,branch:end.replace(/^refs\/heads\//,"")};
  };
  const headRef=symref(headText),headEnd=headRef===null?null:await finalRef(headRef);
  if(headEnd!==undefined)out.branch=headEnd?.startsWith("refs/heads/")?headEnd.slice(11):null;
  const names=new Set([...looseHeads,...[...packed.keys()].filter(ref=>ref.startsWith("refs/heads/")).map(ref=>ref.slice(11))]);
  out.branches=(await Promise.all([...names].map(async name=>await resolveRef("refs/heads/"+name)?name:null))).filter(Boolean).sort(byteOrder);
  if(ownRules&&out.branch!==undefined)out.upstream=await directUpstream(config,out.branch,resolveRef);
  if(!odd)out.worktrees=await directWorktrees(commonDir,commonPath,config,headOf);
  return await fileStamp(packedPath)===packedStamp?out:{};
}
function parseWorktrees(text){
  const worktrees=[];let current=null;
  for(const line of text.split(/\r?\n/)){if(line.startsWith("worktree ")){if(current)worktrees.push(current);current={path:line.slice(9)}}else if(current&&line.startsWith("HEAD "))current.head=line.slice(5);else if(current&&line.startsWith("branch "))current.branch=line.slice(7).replace(/^refs\/heads\//,"");else if(current&&line==="bare")current.bare=true}
  if(current)worktrees.push(current);
  return worktrees;
}

// gitFn runs each git command (tests count them through it); fresh reads the repository part again.
export async function gitInfo(cwd,{gitFn=git,fresh=false,...opts}={}){
  const base=resolve(cwd),cacheable=!opts.env,known=cacheable?repositoryParts.get(base):null;
  if(known&&!fresh&&Date.now()-known.at<GIT_INFO_REUSE_MS&&await repositorySignature(known.gitDir,known.commonDir,base,known.root)===known.signature){
    const statusRes=await gitFn(known.root,STATUS_ARGS,statusOptions(opts));
    if(statusRes.ok)return gitInfoResult(base,known,statusRes);
  }
  const rootRes=await gitFn(base,["rev-parse","--show-toplevel","--absolute-git-dir","--git-common-dir"],{...opts,allowFailure:true});
  if(!rootRes.ok){repositoryParts.delete(base);return {isGit:false,cwd:base,root:null,branch:null,branches:[],status:[],remotes:[],worktrees:[]}}
  const [root,gitDir="",commonLine=""]=rootRes.stdout.split(/\r?\n/).map(line=>line.trim());
  const commonDir=commonLine?resolve(base,commonLine):"",direct=isAbsolute(gitDir)&&!!commonDir,ask=args=>gitFn(root,args,{...opts,allowFailure:true});
  const statusPromise=ask(STATUS_ARGS);
  // Read before the repository part, so a change while it is read makes the next poll read everything again.
  const signature=cacheable&&direct?await repositorySignature(gitDir,commonDir,base,root):null;
  // git prints the common dir relative to the folder only in the main worktree, where it is the git dir.
  const read=direct?await directRepository(gitDir,commonDir,isAbsolute(commonLine)?commonLine:gitDir,opts.env||process.env):{};
  const [branchRes,branchesRes,remoteRes,worktreeRes,upstreamRes]=await Promise.all([
    read.branch===undefined&&ask(["branch","--show-current"]),
    !read.branches&&ask(["for-each-ref","--format=%(refname:short)","refs/heads"]),
    !read.remotes&&ask(["remote","-v"]),
    !read.worktrees&&ask(["worktree","list","--porcelain"]),
    read.upstream===undefined&&ask(["rev-parse","--abbrev-ref","--symbolic-full-name","@{u}"]),
  ]);
  const part={root,branch:branchRes?branchRes.stdout.trim()||null:read.branch,upstream:upstreamRes?(upstreamRes.ok?upstreamRes.stdout.trim():null):read.upstream,
    branches:branchesRes?branchesRes.stdout.split(/\r?\n/).filter(Boolean):read.branches,remotes:remoteRes?parseRemotes(remoteRes.stdout):read.remotes,worktrees:worktreeRes?parseWorktrees(worktreeRes.stdout):read.worktrees};
  const statusRes=await statusPromise;
  if(signature)repositoryParts.set(base,{...part,at:Date.now(),gitDir,commonDir,signature});else repositoryParts.delete(base);
  return gitInfoResult(base,part,statusRes);
}

export async function cloneRepository(url,destination){
  const dest=resolve(destination);
  await mkdir(dirname(dest),{recursive:true});
  await run("git",["clone",url,dest],{cwd:dirname(dest),timeout:10*60_000,maxBuffer:16*1024*1024});
  return gitInfo(dest,{fresh:true});
}
export async function initializeRepository(cwd){
  const target=resolve(cwd);await mkdir(target,{recursive:true});
  await git(target,["init"]);return gitInfo(target,{fresh:true});
}
export async function createBranch(cwd,name,{checkout=true,startPoint=null}={}){
  const args=checkout?["switch","-c",name]:["branch",name];
  if(startPoint) args.push(startPoint);
  await git(cwd,args); return gitInfo(cwd,{fresh:true});
}
export async function switchBranch(cwd,name){ await git(cwd,["switch",name]); return gitInfo(cwd,{fresh:true}); }
// A commit git refuses (a hook, say) fails with git's own words; with nothing staged git would print a status listing instead, so
// that case is named here. A merge in progress (MERGE_HEAD) is concluded even so, as git commit does: its conflicts resolved by
// keeping this branch's side leave the index as HEAD has it, and the merge commit is still what finishes it.
export async function commitAll(cwd,message){
  await git(cwd,["add","-A"]);
  if((await git(cwd,["diff","--cached","--quiet"],{allowFailure:true})).ok&&!(await git(cwd,["rev-parse","-q","--verify","MERGE_HEAD"],{allowFailure:true})).ok)throw new Error("Nothing to commit: the working tree has no changes.");
  await git(cwd,["commit","-m",message]);
  return gitInfo(cwd,{fresh:true});
}
export async function fetchRepo(cwd){ await git(cwd,["fetch","--all","--prune"]); return gitInfo(cwd,{fresh:true}); }
export async function pullRepo(cwd){ await git(cwd,["pull","--ff-only"]); return gitInfo(cwd,{fresh:true}); }
export async function pushRepo(cwd,{setUpstream=false}={}){
  const info=await gitInfo(cwd);
  const args=setUpstream&&info.branch?["push","-u","origin",info.branch]:["push"];
  await git(cwd,args); return gitInfo(cwd,{fresh:true});
}
export async function safeAutoPull(cwd){
  let info=await gitInfo(cwd);
  if(!info.isGit) return {ok:false,reason:"not_git",info};
  if(info.status.length) return {ok:false,reason:"dirty",info};
  if(!info.upstream) return {ok:false,reason:"no_upstream",info};
  if(!info.branch)return {ok:false,reason:"detached",info};
  const slash=info.upstream.indexOf("/");if(slash<=0)return {ok:false,reason:"invalid_upstream",info};
  const remote=info.upstream.slice(0,slash);
  const fetched=await git(info.root,["fetch",remote,"--prune"],{allowFailure:true,timeout:120000});
  if(!fetched.ok)return {ok:false,reason:"fetch_failed",error:(fetched.stderr||fetched.stdout||"Git fetch failed").trim(),info};
  info=await gitInfo(info.root);
  if(info.status.length)return {ok:false,reason:"dirty",info};
  let defaultBranch=null;
  const head=await git(info.root,["symbolic-ref","refs/remotes/"+remote+"/HEAD","--short"],{allowFailure:true});
  if(head.ok&&head.stdout.trim()){const short=head.stdout.trim();defaultBranch=short.startsWith(remote+"/")?short.slice(remote.length+1):short}
  if(!defaultBranch){
    const shown=await git(info.root,["remote","show",remote],{allowFailure:true,timeout:120000});
    defaultBranch=shown.ok?(shown.stdout.match(/^\s*HEAD branch:\s*(\S+)\s*$/m)?.[1]||null):null;
  }
  if(!defaultBranch)return {ok:false,reason:"default_branch_unknown",info};
  if(info.branch!==defaultBranch)return {ok:false,reason:"not_default_branch",defaultBranch,info};
  const counts=await git(info.root,["rev-list","--left-right","--count",info.upstream+"...HEAD"],{allowFailure:true});
  if(!counts.ok)return {ok:false,reason:"compare_failed",error:(counts.stderr||counts.stdout||"Could not compare upstream").trim(),defaultBranch,info};
  const [behindRaw,aheadRaw]=counts.stdout.trim().split(/\s+/);const behind=Number(behindRaw)||0,ahead=Number(aheadRaw)||0;
  if(ahead>0)return {ok:false,reason:"local_commits",ahead,behind,defaultBranch,info};
  if(behind===0)return {ok:true,changed:false,ahead,behind,defaultBranch,info};
  await git(info.root,["pull","--ff-only"]);
  return {ok:true,changed:true,ahead:0,behind,defaultBranch,info:await gitInfo(info.root,{fresh:true})};
}
export function worktreeSubmoduleArgs(mode="recursive"){
  if(mode==="none")return null;
  return mode==="top-level"?["submodule","update","--init"]:["submodule","update","--init","--recursive"];
}
export async function createWorktree(cwd,{branch,path,baseBranch=null,submodules="recursive"}){
  const info=await gitInfo(cwd);
  if(!info.isGit) throw new Error("Workspace is not a Git repository");
  const dest=resolve(path);
  const args=["worktree","add"];
  if(branch){ args.push("-b",branch); }
  args.push(dest);
  if(baseBranch) args.push(baseBranch);
  await git(info.root,args,{timeout:180000});
  const submoduleArgs=worktreeSubmoduleArgs(submodules);
  if(submoduleArgs)await git(dest,submoduleArgs,{timeout:10*60_000,maxBuffer:16*1024*1024});
  return {worktree:dest,submodules:submodules||"recursive",info:await gitInfo(info.root,{fresh:true})};
}
export async function restoreWorktree(cwd,{branch,path,submodules="recursive"}){
  const info=await gitInfo(cwd);if(!info.isGit)throw new Error("Source workspace is not a Git repository");
  const dest=resolve(path);const branchName=String(branch||"").trim();if(!branchName)throw new Error("Managed worktree branch is missing");
  await git(info.root,["worktree","add",dest,branchName],{timeout:180000});
  const submoduleArgs=worktreeSubmoduleArgs(submodules);if(submoduleArgs)await git(dest,submoduleArgs,{timeout:10*60_000,maxBuffer:16*1024*1024});
  return {worktree:dest,submodules,info:await gitInfo(info.root,{fresh:true})};
}
export async function removeWorktree(cwd,path,{force=false}={}){
  const info=await gitInfo(cwd);
  const args=["worktree","remove"];
  if(force) args.push("--force");
  args.push(resolve(path));
  await git(info.root,args,{timeout:180000});
  return gitInfo(info.root,{fresh:true});
}
export async function sourceControlDiagnostics(cwd){
  const [gitVersion,ghVersion,ghAuth]=await Promise.all([
    run("git",["--version"],{cwd,allowFailure:true}),
    run("gh",["--version"],{cwd,allowFailure:true}),
    run("gh",["auth","status"],{cwd,allowFailure:true}),
  ]);
  return {
    git:{installed:gitVersion.ok,version:(gitVersion.stdout||gitVersion.stderr).split(/\r?\n/)[0]||null},
    github:{installed:ghVersion.ok,version:(ghVersion.stdout||"").split(/\r?\n/)[0]||null,authenticated:ghAuth.ok,detail:(ghAuth.stdout||ghAuth.stderr).trim()},
  };
}
export async function listPullRequests(cwd){
  const result=await run("gh",["pr","list","--limit","50","--json","number,title,state,isDraft,url,headRefName,baseRefName,author,reviewDecision,statusCheckRollup"],{cwd,allowFailure:true,maxBuffer:4*1024*1024});
  if(!result.ok) return {ok:false,error:(result.stderr||result.stdout).trim(),items:[]};
  try{return {ok:true,items:JSON.parse(result.stdout)}}catch{return {ok:false,error:"Could not parse gh output",items:[]}}
}
export async function createPullRequest(cwd,{title,body="",base=null,draft=false}){
  const args=["pr","create","--title",title,"--body",body];
  if(base) args.push("--base",base);
  if(draft) args.push("--draft");
  const result=await run("gh",args,{cwd});
  return {url:result.stdout.trim()};
}

export async function pullRequestDetail(cwd,number){
  const result=await run("gh",["pr","view",String(number),"--json","number,title,body,state,isDraft,url,headRefName,baseRefName,author,reviewDecision,statusCheckRollup,comments,reviews,files,commits"],{cwd,allowFailure:true,maxBuffer:8*1024*1024});
  if(!result.ok) return {ok:false,error:(result.stderr||result.stdout).trim(),item:null};
  try{return {ok:true,item:JSON.parse(result.stdout)}}catch{return {ok:false,error:"Could not parse gh output",item:null}}
}
export async function commentOnPullRequest(cwd,number,body){
  const result=await run("gh",["pr","comment",String(number),"--body",body],{cwd});
  return {ok:true,url:result.stdout.trim()};
}
export async function reviewPullRequest(cwd,number,{event="COMMENT",body=""}={}){
  const flag=event==="APPROVE"?"--approve":event==="REQUEST_CHANGES"?"--request-changes":"--comment";
  const args=["pr","review",String(number),flag];
  if(body) args.push("--body",body);
  await run("gh",args,{cwd});
  return {ok:true};
}
export async function mergePullRequest(cwd,number,{method="squash",auto=false}={}){
  const flag=method==="merge"?"--merge":method==="rebase"?"--rebase":"--squash";
  const args=["pr","merge",String(number),flag];
  if(auto) args.push("--auto"); else args.push("--delete-branch");
  const result=await run("gh",args,{cwd});
  return {ok:true,output:(result.stdout||result.stderr).trim()};
}

export async function updatePullRequestBranch(cwd,number,{rebase=true}={}){
  const args=["pr","update-branch",String(number)];
  if(rebase) args.push("--rebase");
  const result=await run("gh",args,{cwd,allowFailure:true,maxBuffer:4*1024*1024});
  if(!result.ok) throw new Error((result.stderr||result.stdout||"Could not update PR branch").trim());
  return {ok:true,output:(result.stdout||result.stderr).trim()};
}
