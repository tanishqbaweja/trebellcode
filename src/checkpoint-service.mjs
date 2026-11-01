import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { chmod, copyFile, lstat, mkdir, readFile, readlink, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { trebellHome } from "./paths.mjs";
import { git, gitInfo } from "./git-service.mjs";
import { buildRuntimeEnvironment } from "./runtime-environment.mjs";

const CHECKPOINT_NESTED_REPO_MAX_CANDIDATES=64;
const NESTED_GIT_ENV_KEYS=["GIT_DIR","GIT_WORK_TREE","GIT_COMMON_DIR","GIT_INDEX_FILE","GIT_OBJECT_DIRECTORY","GIT_ALTERNATE_OBJECT_DIRECTORIES"];
const CHECKPOINT_GIT_ENV_KEYS=["EMAIL","GIT_AUTHOR_NAME","GIT_AUTHOR_EMAIL","GIT_COMMITTER_NAME","GIT_COMMITTER_EMAIL","GIT_CONFIG_GLOBAL","GIT_CONFIG_SYSTEM","GIT_CONFIG_NOSYSTEM","GIT_CEILING_DIRECTORIES","GIT_DISCOVERY_ACROSS_FILESYSTEM"];
// A checkpoint must outlive a crash or a power cut once Trebell records it. git config's core.fsync documents "committed" as the
// mode that hardens what git commit and similar commands write (today the objects and the refs), which is what a checkpoint's add,
// write-tree, commit-tree and update-ref write; core.fsyncMethod=fsync asks for a full flush of each file even when the person's
// own configuration chose a lighter one (writeout-only, or batch, which the documentation calls as safe as fsync only on some
// file systems).
const CHECKPOINT_DURABLE_WRITE=["-c","core.fsync=committed","-c","core.fsyncMethod=fsync"];
// With no user.name or user.email and a host name git cannot make an email from, commit-tree refuses, and every turn lost its
// file checkpoint (live tour, 2026-10-14). A checkpoint is Trebell's own ref, so that commit is made again under this identity;
// an identity the person has set (git config or GIT_AUTHOR_* / GIT_COMMITTER_*) still names every checkpoint it can.
const CHECKPOINT_FALLBACK_IDENTITY=["-c","user.name=Trebell Code","-c","user.email=checkpoints@trebell.invalid"];
const isMissingIdentityError=error=>/identity unknown|unable to auto-detect email address|empty ident name/i.test(String(error?.message||error||""));
// The restores that can still be taken back (undoRestore), and for how long: Edit from here takes one back within seconds.
const RESTORE_UNDO_KEEP_COUNT=8,RESTORE_UNDO_KEEP_MS=30*60_000;

// ---- Races: a checkpoint's Git command is run again only when it lost a race with another process, which passes by itself.
// Any other failure would come back the same.
// git 2.50.1 writes a failed system call on one line: what it was doing, then ": " and the C library's words for the error
// (usage.c's fmt_with_err), after "fatal: " or "error: ", perhaps closed by a full stop. Two errors are races, each after its
// own kind of step:
// - "File exists" (EEXIST) on making a lock: "Unable to create '<path>.lock'" (lockfile.c), behind "cannot lock ref '<ref>': "
//   for a ref (refs/files-backend.c). Someone else's git holds the lock: the person's own, an editor's or another checkpoint's.
// - "No such file or directory" (ENOENT) on reading a file git had just listed: "unable to stat '<path>'" (read-cache.c), or a
//   read call with the path in double quotes, open("<path>") and readlink("<path>") (object-file.c), and lstat or stat written
//   the same way. An agent, a build or a formatter removed it in between.
// A path may itself hold ": " (a repository in "/home/dev/my: project", a file "notes/q&a: today.md"), so the step can begin
// at the start of the line or after any ": " in it; the line counts when the rest of it from one of those places is the step.
const READING_CALLS=["open","readlink","lstat","stat"];
const isBlank=char=>/\s/.test(char);
// The text of what was thrown: an Error's message, or the value itself; "" for nothing.
const thrownText=error=>error?String(error.message||error):"";
// git's words are plain ASCII, so only A-Z are lowered: a Kelvin sign or a long s must not turn into a k or an s of them.
const asciiLowered=text=>text.replace(/[A-Z]+/g,run=>run.toLowerCase());
// The span from..to of line without the quotes around it, when it is a name in matching quotes (' or ") with something
// inside; null otherwise.
function insideQuotes(line,from,to){
  const quote=line[from];
  return to-from>=3&&(quote==="'"||quote==="\"")&&line[to-1]===quote?[from+1,to-1]:null;
}
// Making a lock: "unable to create " and the lock's name, quoted or bare, ending in ".lock" after at least one character.
function makesLock(line,from,to){
  const lead="unable to create ";
  if(!line.startsWith(lead,from))return false;
  const [start,stop]=insideQuotes(line,from+lead.length,to)||[from+lead.length,to];
  return stop-start>".lock".length&&line.startsWith(".lock",stop-".lock".length);
}
// Reading a listed file: "unable to stat " and the name in quotes, or a reading call, "(", the name in quotes and ")".
function readsListedFile(line,from,to){
  const stat="unable to stat ";
  if(line.startsWith(stat,from))return insideQuotes(line,from+stat.length,to)!==null;
  const call=READING_CALLS.find(name=>line.startsWith(name+"(",from));
  return Boolean(call)&&line[to-1]===")"&&insideQuotes(line,from+call.length+1,to-1)!==null;
}
// The step each race's error follows, by the words that end the line.
const RACE_ENDINGS=[[": file exists",makesLock],[": no such file or directory",readsListedFile]];
// Whether step matches line from one of the places a step can begin (the start, or after any ": ", blanks skipped) to stop.
// Each place is judged against the fixed end, so a line of megabytes is read in one pass.
function stepFrom(line,stop,step){
  for(let at=0;;){
    while(at<stop&&isBlank(line[at]))at++;
    if(at<stop&&step(line,at,stop))return true;
    const colon=line.indexOf(": ",at);
    if(colon<0||colon+2>=stop)return false;
    at=colon+2;
  }
}
function lineIsRace(line){
  // Full stops and blanks (a carriage return among them) at the end do not count; neither do blanks before the error's ": ".
  let end=line.length;
  while(end>0&&(line[end-1]==="."||isBlank(line[end-1])))end--;
  const ending=RACE_ENDINGS.find(([words])=>end>=words.length&&line.startsWith(words,end-words.length));
  if(!ending)return false;
  let stop=end-ending[0].length;
  while(stop>0&&isBlank(line[stop-1]))stop--;
  return stepFrom(line,stop,ending[1]);
}
// A failure may hold several lines (warnings, the failed call, a summary): one race among them is enough.
export function isTransientCheckpointGitError(error){
  return asciiLowered(thrownText(error)).split("\n").some(lineIsRace);
}

// Whether a copy of the repository's own index can seed a checkpoint's index. read-tree --reset HEAD over the copy gives the same
// entries as a fresh read of HEAD but keeps the stat data of files whose content matches, so add -A hashes only the files that
// changed instead of every file. An entry marked assume-unchanged or skip-worktree would keep add -A from reading that file even
// when it changed on disk, and a split or sparse index points at other files, so those take the fresh read as before. The walk
// tries both hash sizes and trusts only a walk that ends exactly at the checksum.
function reusableIndex(buffer){
  if(buffer.length<12||buffer.toString("latin1",0,4)!=="DIRC")return false;
  const version=buffer.readUInt32BE(4),count=buffer.readUInt32BE(8);
  if(version<2||version>4)return false;
  const walk=hashSize=>{
    let offset=12,blocked=false;
    for(let entry=0;entry<count;entry++){
      let at=offset+40+hashSize;if(at+2>buffer.length)return null;
      const mode=buffer.readUInt32BE(offset+24),flags=buffer.readUInt16BE(at);at+=2;
      if(flags&0x8000||(mode&0o170000)===0o040000)blocked=true;
      if(flags&0x4000){if(version<3||at+2>buffer.length)return null;if(buffer.readUInt16BE(at)&0x4000)blocked=true;at+=2}
      if(version===4){while(at<buffer.length&&buffer[at]&0x80)at++;const end=buffer.indexOf(0,at+1);if(end<0)return null;offset=end+1}
      else{const length=flags&0xfff,end=length<0xfff?at+length:buffer.indexOf(0,at);if(end<0||end>=buffer.length)return null;offset+=(end-offset+8)&~7}
    }
    while(offset+8<=buffer.length-hashSize){
      const name=buffer.toString("latin1",offset,offset+4);if(name==="link"||name==="sdir")blocked=true;
      offset+=8+buffer.readUInt32BE(offset+4);
    }
    return offset===buffer.length-hashSize?!blocked:null;
  };
  return walk(20)??walk(32)??false;
}

// A path in the worktree as a restore may find it: its lstat, or null when nothing is there.
const lstatOrNull=path=>lstat(path).catch(error=>{if(error?.code==="ENOENT"||error?.code==="ENOTDIR")return null;throw error});
// One path of a worktree, kept before a restore: a file's own bytes (copied to copyPath) and mode, a symbolic link's target, or that it
// is absent. A folder (a submodule) is not kept (skip).
async function keepFile(root,rel,copyPath){
  const path=join(root,rel),info=await lstatOrNull(path);
  if(!info)return {rel};
  if(info.isSymbolicLink())return {rel,link:await readlink(path)};
  if(!info.isFile())return {rel,skip:true};
  await copyFile(path,copyPath);
  return {rel,copy:copyPath,mode:info.mode};
}
// Whether a kept path already is as it was kept: the same bytes and executable bit, the same link, or still absent.
async function isKept(root,file){
  if(file.skip)return true;
  const path=join(root,file.rel),info=await lstatOrNull(path);
  if(!file.copy&&file.link==null)return !info;
  if(!info)return false;
  if(file.link!=null)return info.isSymbolicLink()&&await readlink(path)===file.link;
  if(!info.isFile()||(info.mode&0o111)!==(file.mode&0o111)||info.size!==(await stat(file.copy)).size)return false;
  const [current,kept]=await Promise.all([readFile(path),readFile(file.copy)]);
  return current.equals(kept);
}
const listed=items=>items.slice(0,3).join(", ")+(items.length>3?` and ${items.length-3} more`:"");
// A path's state as a write would change it: its kind, size, modification time and file id, or absent.
const fileState=info=>info?[info.isSymbolicLink()?"link":info.isFile()?"file":"other",info.size,info.mtimeMs,info.ino].join(":"):"absent";
async function putFileBack(root,file){
  const path=join(root,file.rel),info=await lstatOrNull(path);
  // A link or a file that is not to be there goes first: a copy onto a link would write through it.
  if(info&&(!file.copy||info.isSymbolicLink()))await rm(path,{force:true});
  if(file.copy){await mkdir(dirname(path),{recursive:true});await copyFile(file.copy,path);await chmod(path,file.mode&0o777).catch(()=>{})}
  else if(file.link!=null){await mkdir(dirname(path),{recursive:true});await symlink(file.link,path)}
}

// Edit from here puts a checkpoint's files back only where nothing but the work of the thread that made it can be lost: a worktree
// Trebell made and still keeps, which that thread still works in and no other thread works in, whether in the folder itself, in a
// folder inside it or in one that holds it. Anything else is refused before a file is read or written, in words the window shows
// after "Could not restore the files, so the conversation was not changed: ".
const NOT_RESTORED={
  threadMoved:"This thread no longer works in the folder its checkpoint was taken in.",
  notOwnWorktree:"Files go back only in a worktree Trebell made for the thread, and this folder is not one. Go back in the conversation only, and leave the files as they are.",
  folderShared:"Another thread also works in this folder, so putting the files back could undo its changes. Go back in the conversation only, and leave the files as they are.",
};
// Whether a way from one folder to another (path.relative's answer) stays in it: the same folder, or one below it.
const staysInside=(way,{sep:mark,isAbsolute:absolute})=>way===""||(way!==".."&&!way.startsWith(".."+mark)&&!absolute(way));
// How a restore tells folders apart. On this computer a folder is its real path (links and junctions followed), a folder that is gone
// has none, and every thread and project counts. Over an environment a folder is its path written with forward slashes and
// normalized, without a slash at its end unless it is the root, and only the threads and projects on that environment count.
function folderRules(environmentId){
  if(!environmentId)return {name:path=>path?realpath(path).catch(()=>null):null,paths:{relative,sep,isAbsolute},counts:()=>true};
  return {
    name:path=>{const plain=posix.normalize(String(path||"").replace(/\\/g,"/"));return plain.length>1&&plain.endsWith("/")?plain.slice(0,-1):plain},
    paths:posix,
    counts:item=>(item?.environmentId||null)===environmentId,
  };
}
// The folder a checkpoint's files can go back to (environmentId: the environment its files are reached over, or none on this
// computer). The checks run in this order, and the first that fails is the answer: the thread asking is the one that made the
// checkpoint, its folder is still there, the thread still works in it, it is a worktree Trebell keeps, and no other thread is in it.
async function restorableFolder(state,checkpoint,threadId,environmentId){
  if(!threadId||checkpoint.threadId!==threadId)throw new Error("Checkpoint file restore is allowed only from the thread that created this checkpoint.");
  const rules=folderRules(environmentId),folder=await rules.name(checkpoint.root);
  if(!folder)throw new Error("Checkpoint repository is unavailable");
  const thread=state.threadMeta?.(threadId)||{};
  if(!rules.counts(thread)||await rules.name(thread.cwd)!==folder)throw new Error(NOT_RESTORED.threadMoved);
  const kept=(state.projects?.()||[]).filter(project=>project?.managedWorktree&&!project.managedWorktree.cleanedAt&&rules.counts(project));
  if(!(await Promise.all(kept.map(project=>rules.name(project.path)))).includes(folder))throw new Error(NOT_RESTORED.notOwnWorktree);
  const others=Object.entries(state.listThreadMeta?.()||{}).filter(([id,other])=>id!==threadId&&other?.cwd&&!other.deletedAt&&rules.counts(other));
  for(const place of await Promise.all(others.map(([,other])=>rules.name(other.cwd)))){
    if(place&&(staysInside(rules.paths.relative(folder,place),rules.paths)||staysInside(rules.paths.relative(place,folder),rules.paths)))throw new Error(NOT_RESTORED.folderShared);
  }
  return folder;
}

export class CheckpointService{
  #undos=new Map();
  constructor({state,env=process.env,gitFn=git,gitInfoFn=gitInfo,environments=null,sleepFn=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
    this.state=state;this.env=env;this.gitFn=gitFn;this.gitInfoFn=gitInfoFn;this.environments=environments;this.sleepFn=sleepFn;
  }
  async #captureGit(cwd,args,options={}){
    let lastError=null;
    for(let attempt=0;attempt<3;attempt++){
      try{return await this.gitFn(cwd,args,options)}
      catch(error){
        lastError=error;
        if(attempt>=2||!isTransientCheckpointGitError(error))throw error;
        await this.sleepFn(75);
      }
    }
    throw lastError;
  }
  #durable(args){return [...CHECKPOINT_DURABLE_WRITE,...args]}
  async #commitTree(run,args){
    try{return await run(this.#durable(args))}
    catch(error){if(!isMissingIdentityError(error))throw error;return run([...CHECKPOINT_FALLBACK_IDENTITY,...this.#durable(args)])}
  }
  #localGitEnv(overrides={}){return {...buildRuntimeEnvironment("native",{parent:this.env,approved:CHECKPOINT_GIT_ENV_KEYS}),...overrides}}
  #remoteProfile(environmentId){return environmentId?this.environments?.get?.(environmentId)||null:null}
  #usesRemoteIo(environmentId){return Boolean(environmentId&&this.#remoteProfile(environmentId)?.type!=="local")}
  async #remoteExec(environmentId,{command,args=[],cwd=null,allowFailure=false,timeoutMs=120000,maxOutput=8*1024*1024}={}){
    if(!this.#remoteProfile(environmentId))throw new Error("Remote checkpoint environment is unavailable");
    const result=await this.environments.executeArgv(environmentId,{command,args,cwd,timeoutMs,maxOutput});
    const exitCode=Number(result?.exitCode),ok=Number.isFinite(exitCode)&&exitCode===0&&!result?.timedOut,normalized={ok,stdout:String(result?.stdout||""),stderr:String(result?.stderr||""),code:Number.isFinite(exitCode)?exitCode:1};
    if(!ok&&!allowFailure)throw new Error((normalized.stderr||normalized.stdout||`${command} failed`).trim());
    return normalized;
  }
  async #remoteGit(environmentId,cwd,args,{allowFailure=false,indexPath=null}={}){
    const command=indexPath?"env":"git",argv=indexPath?[`GIT_INDEX_FILE=${indexPath}`,"git",...args]:args;
    return this.#remoteExec(environmentId,{command,args:argv,cwd,allowFailure});
  }
  async #remoteGitInfo(environmentId,cwd){
    const base=String(cwd||"").trim(),root=await this.#remoteGit(environmentId,base,["rev-parse","--show-toplevel"],{allowFailure:true});
    if(!root.ok)return {isGit:false,cwd:base,root:null};
    const branch=await this.#remoteGit(environmentId,root.stdout.trim(),["branch","--show-current"],{allowFailure:true});
    return {isGit:true,cwd:base,root:root.stdout.trim(),branch:branch.stdout.trim()||null};
  }
  async #remoteTempDir(environmentId,cwd){
    const created=await this.#remoteExec(environmentId,{command:"mktemp",args:["-d","-t","trebell-checkpoint.XXXXXX"],cwd});
    const path=created.stdout.trim();if(!path)throw new Error("Remote checkpoint temporary directory was empty");return path;
  }
  async #cleanupRemoteTemp(environmentId,path,cwd){
    if(!path)return;await this.#remoteExec(environmentId,{command:"rm",args:["-rf","--",path],cwd,allowFailure:true,timeoutMs:30000,maxOutput:64*1024}).catch(()=>{});
  }
  async #stageCheckpoint(root,childEnv){
    const stageArgs=["add","-A","--","."];
    let stageError;
    try{return await this.#captureGit(root,this.#durable(stageArgs),{env:childEnv})}
    catch(error){
      stageError=error;
      if(!/does not have a commit checked out/i.test(String(error?.message||error||"")))throw error;
    }
    const untracked=await this.#captureGit(root,["ls-files","--others","--exclude-standard","-z","--","."],{env:childEnv});
    const candidates=String(untracked.stdout||"").split("\0").filter(entry=>entry.endsWith("/"));
    if(candidates.length>CHECKPOINT_NESTED_REPO_MAX_CANDIDATES)throw stageError;
    const nestedEnv=this.#localGitEnv();for(const key of NESTED_GIT_ENV_KEYS)delete nestedEnv[key];
    const exclusions=[];
    for(const entry of candidates){
      const nestedCwd=join(root,entry);
      try{await stat(join(nestedCwd,".git"))}catch{continue}
      const head=await this.gitFn(nestedCwd,["rev-parse","--verify","HEAD"],{allowFailure:true,env:nestedEnv});
      if(!head.ok)exclusions.push(":(exclude,literal)"+entry);
    }
    if(!exclusions.length)throw stageError;
    return this.#captureGit(root,this.#durable([...stageArgs,...exclusions]),{env:childEnv});
  }
  async #stageRemoteCheckpoint(environmentId,root,indexPath){
    const stageArgs=["add","-A","--","."];
    let stageError;
    try{return await this.#remoteGit(environmentId,root,this.#durable(stageArgs),{indexPath})}
    catch(error){stageError=error;if(!/does not have a commit checked out/i.test(String(error?.message||error||"")))throw error}
    const untracked=await this.#remoteGit(environmentId,root,["ls-files","--others","--exclude-standard","-z","--","."],{indexPath});
    const candidates=String(untracked.stdout||"").split("\0").filter(entry=>entry.endsWith("/"));
    if(candidates.length>CHECKPOINT_NESTED_REPO_MAX_CANDIDATES)throw stageError;
    const exclusions=[];
    for(const entry of candidates){
      const nestedCwd=posix.join(root,entry),gitMarker=posix.join(nestedCwd,".git");
      const marker=await this.#remoteExec(environmentId,{command:"test",args:["-e",gitMarker],cwd:root,allowFailure:true,maxOutput:1024});if(!marker.ok)continue;
      const head=await this.#remoteGit(environmentId,nestedCwd,["rev-parse","--verify","HEAD"],{allowFailure:true});if(!head.ok)exclusions.push(":(exclude,literal)"+entry);
    }
    if(!exclusions.length)throw stageError;
    return this.#remoteGit(environmentId,root,this.#durable([...stageArgs,...exclusions]),{indexPath});
  }
  async #createRemote({cwd,threadId=null,label=null,environmentId}){
    const info=await this.#remoteGitInfo(environmentId,cwd);if(!info.isGit)return {supported:false,reason:"not_git",environmentId};
    const id=randomUUID(),tmpDir=await this.#remoteTempDir(environmentId,info.root),indexPath=posix.join(tmpDir,"index");
    try{
      const head=await this.#remoteGit(environmentId,info.root,["rev-parse","HEAD"],{allowFailure:true});
      if(head.ok)await this.#remoteGit(environmentId,info.root,["read-tree","HEAD"],{indexPath});else await this.#remoteGit(environmentId,info.root,["read-tree","--empty"],{indexPath});
      await this.#stageRemoteCheckpoint(environmentId,info.root,indexPath);
      const tree=(await this.#remoteGit(environmentId,info.root,this.#durable(["write-tree"]),{indexPath})).stdout.trim();
      const args=["commit-tree",tree,"-m",label||"Trebell Code checkpoint"];if(head.ok)args.push("-p",head.stdout.trim());
      const commit=(await this.#commitTree(gitArgs=>this.#remoteGit(environmentId,info.root,gitArgs),args)).stdout.trim(),ref=`refs/trebell/checkpoints/${id}`;
      await this.#remoteGit(environmentId,info.root,this.#durable(["update-ref",ref,commit]));
      const item=this.state.addCheckpoint({id,threadId,root:info.root,commit,ref,label:label||null,environmentId});
      return {supported:true,...item};
    }finally{await this.#cleanupRemoteTemp(environmentId,tmpDir,info.root)}
  }
  async create({cwd,threadId=null,label=null,environmentId=null}){
    if(environmentId&&!this.#remoteProfile(environmentId))throw new Error("Checkpoint environment is unavailable");
    if(this.#usesRemoteIo(environmentId))return this.#createRemote({cwd,threadId,label,environmentId});
    const baseEnv=this.#localGitEnv(),captured=await this.#captureLocal(cwd,label,baseEnv);
    if(!captured)return {supported:false,reason:"not_git"};
    const {id,root,commit}=captured,ref=`refs/trebell/checkpoints/${id}`;
    await this.#captureGit(root,this.#durable(["update-ref",ref,commit]),{env:baseEnv});
    const item=this.state.addCheckpoint({id,threadId,root,commit,ref,label:label||null,environmentId:environmentId||null});
    return {supported:true,...item};
  }
  // The worktree as it is, as a commit of every file add -A takes (tracked and untracked ones, not ignored ones), with the root and the
  // path of the repository's own index; null outside a git repository. Nothing records it: create() gives it a ref and a checkpoint.
  async #captureLocal(cwd,label,baseEnv){
    // One rev-parse gives the root, the repository's own index and HEAD; an unborn branch prints the first two and exits 1.
    const found=await this.gitFn(cwd,["rev-parse","--show-toplevel","--git-path","index","--verify","-q","HEAD"],{allowFailure:true,env:baseEnv});
    const [root="",repositoryIndex="",headLine=""]=String(found.stdout||"").split(/\r?\n/).map(line=>line.trim());
    if(!root||!repositoryIndex||(!found.ok&&found.code!==1)) return null;
    const info={root},head={ok:found.ok&&Boolean(headLine),stdout:headLine};
    const id=randomUUID();
    const tmpDir=join(trebellHome(this.env),"checkpoints");
    await mkdir(tmpDir,{recursive:true});
    const indexPath=join(tmpDir,`index-${id}`);
    const childEnv={...baseEnv,GIT_INDEX_FILE:indexPath};
    try{
      // git trusts an entry's stat data only when the entry is older than the index file it reads, and compares the content of one as
      // new as that file (racily clean: written again in the same second, at the same size). The copy takes the repository index's
      // time, to the second and read before the content, so those entries are compared as git status compares them.
      const source=resolve(cwd,repositoryIndex);
      const seed=head.ok?await stat(source).then(async({mtimeMs})=>{
        const buffer=await readFile(source);if(!reusableIndex(buffer))return false;
        const seconds=Math.floor(mtimeMs/1000);await writeFile(indexPath,buffer);await utimes(indexPath,seconds,seconds);return true;
      }).catch(()=>rm(indexPath,{force:true}).then(()=>false,()=>false)):false;
      if(seed)await this.#captureGit(info.root,["read-tree","--reset","HEAD"],{env:childEnv});
      else if(head.ok) await this.#captureGit(info.root,["read-tree","HEAD"],{env:childEnv}); else await this.#captureGit(info.root,["read-tree","--empty"],{env:childEnv});
      await this.#stageCheckpoint(info.root,childEnv);
      const tree=(await this.#captureGit(info.root,this.#durable(["write-tree"]),{env:childEnv})).stdout.trim();
      const args=["commit-tree",tree,"-m",label||"Trebell Code checkpoint"];
      if(head.ok) args.push("-p",head.stdout.trim());
      const commit=(await this.#commitTree(gitArgs=>this.#captureGit(info.root,gitArgs,{env:childEnv}),args)).stdout.trim();
      return {id,root:info.root,commit,repositoryIndex:source};
    }finally{
      await rm(indexPath,{force:true}).catch(()=>{});
      await rm(indexPath+".lock",{force:true}).catch(()=>{});
    }
  }
  list(threadId=null){return this.state.checkpoints(threadId);}
  link(id,patch){return this.state.updateCheckpoint(id,patch);}
  async #changedPathsRemote(cp){
    const environmentId=cp.environmentId,info=await this.#remoteGitInfo(environmentId,cp.root);if(!info.isGit)throw new Error("Checkpoint repository is unavailable");
    const tmpDir=await this.#remoteTempDir(environmentId,info.root),indexPath=posix.join(tmpDir,"index");
    try{
      await this.#remoteGit(environmentId,info.root,["read-tree",cp.commit],{indexPath});
      await this.#remoteGit(environmentId,info.root,["update-index","--refresh"],{indexPath,allowFailure:true});
      const modified=await this.#remoteGit(environmentId,info.root,["diff-files","--name-only","-z","--"],{indexPath});
      const untracked=await this.#remoteGit(environmentId,info.root,["ls-files","--others","--exclude-standard","-z","--"],{indexPath});
      const checkpointTree=await this.#remoteGit(environmentId,info.root,["ls-tree","-r","--name-only","-z",cp.commit]);
      const normalizePaths=value=>String(value||"").split("\0").map(item=>item.replace(/\\/g,"/").trim()).filter(Boolean),trackedAtCheckpoint=new Set(normalizePaths(checkpointTree.stdout));
      const paths=[...new Set([...normalizePaths(modified.stdout),...normalizePaths(untracked.stdout).filter(path=>!trackedAtCheckpoint.has(path))])].sort((a,b)=>a.localeCompare(b));
      return {checkpoint:cp,root:info.root,paths};
    }finally{await this.#cleanupRemoteTemp(environmentId,tmpDir,info.root)}
  }
  async changedPaths(id,{threadId=null}={}){
    const cp=this.state.checkpoints().find(item=>item.id===id);
    if(!cp)throw new Error("Checkpoint not found");
    if(threadId&&cp.threadId!==threadId)throw new Error("Checkpoint change inspection is allowed only from the thread that created this checkpoint.");
    if(this.#usesRemoteIo(cp.environmentId))return this.#changedPathsRemote(cp);
    const baseEnv=this.#localGitEnv(),info=await this.gitInfoFn(cp.root,{env:baseEnv});
    if(!info.isGit)throw new Error("Checkpoint repository is unavailable");
    const tmpDir=join(trebellHome(this.env),"checkpoints");
    await mkdir(tmpDir,{recursive:true});
    const indexPath=join(tmpDir,`compare-index-${randomUUID()}`);
    const childEnv={...baseEnv,GIT_INDEX_FILE:indexPath};
    try{
      await this.#captureGit(info.root,["read-tree",cp.commit],{env:childEnv});
      await this.gitFn(info.root,["update-index","--refresh"],{env:childEnv,allowFailure:true});
      const [modified,untracked,checkpointTree]=await Promise.all([
        this.#captureGit(info.root,["diff-files","--name-only","-z","--"],{env:childEnv}),
        this.#captureGit(info.root,["ls-files","--others","--exclude-standard","-z","--"],{env:childEnv}),
        this.#captureGit(info.root,["ls-tree","-r","--name-only","-z",cp.commit],{env:childEnv}),
      ]);
      const normalizePaths=value=>String(value||"").split("\0").map(item=>item.replace(/\\/g,"/").trim()).filter(Boolean);
      const trackedAtCheckpoint=new Set(normalizePaths(checkpointTree.stdout));
      const paths=[...new Set([
        ...normalizePaths(modified.stdout),
        ...normalizePaths(untracked.stdout).filter(path=>!trackedAtCheckpoint.has(path)),
      ])].sort((a,b)=>a.localeCompare(b));
      return {checkpoint:cp,root:info.root,paths};
    }finally{
      await rm(indexPath,{force:true}).catch(()=>{});
      await rm(indexPath+".lock",{force:true}).catch(()=>{});
    }
  }
  // The files of a checkpoint reached over an environment go back in root, the folder restorableFolder answered.
  async #restoreRemote(cp,root){
    const environmentId=cp.environmentId,info=await this.#remoteGitInfo(environmentId,root);if(!info.isGit)throw new Error("Checkpoint repository is unavailable");
    await this.#remoteGit(environmentId,root,["restore","--source",cp.commit,"--staged","--worktree","--","."]);
    const trackedAtCheckpoint=new Set(String((await this.#remoteGit(environmentId,root,["ls-tree","-r","--name-only","-z",cp.commit])).stdout||"").split("\0").filter(Boolean));
    const untracked=String((await this.#remoteGit(environmentId,root,["ls-files","--others","--exclude-standard","-z"])).stdout||"").split("\0").filter(Boolean);
    for(const rel of untracked){if(trackedAtCheckpoint.has(rel))continue;await this.#remoteExec(environmentId,{command:"rm",args:["-rf","--",rel],cwd:root,allowFailure:true,timeoutMs:30000,maxOutput:64*1024})}
    return {ok:true,checkpoint:cp,info:await this.#remoteGitInfo(environmentId,root)};
  }
  // The worktree and the index made to match a commit for every path git does not ignore: each file the commit holds is written as it
  // holds it, and a tracked file it lacks is removed, as is each untracked file it lacks that was kept (#keepLocal) before. A file that
  // appeared since (a turn that started meanwhile wrote it) stays. A file that could not be removed fails the restore.
  async #restoreLocalTree(root,commit,baseEnv,kept){
    await this.gitFn(root,["restore","--source",commit,"--staged","--worktree","--","."],{env:baseEnv});
    const tracked=new Set(String((await this.gitFn(root,["ls-tree","-r","--name-only","-z",commit],{env:baseEnv})).stdout||"").split("\0").filter(Boolean)),failed=[];
    for(const file of kept.files)if(file.untracked&&!tracked.has(file.rel))await rm(join(root,file.rel),{force:true}).catch(error=>failed.push(file.rel+" ("+(error?.code||error?.message||error)+")"));
    if(failed.length)throw new Error("Could not remove "+listed(failed)+".");
  }
  // What a restore to a commit can change, kept before it so that it can be put back exactly: every path whose index entry differs from
  // the commit's (diff-index --cached), whose file differs from its index entry by stat or content (diff-files, not refreshed, so a
  // file touched since the index last read it counts too), and every untracked file, each copied as it is on disk (no line-ending
  // conversion or clean filter, as a commit of them had) or noted as absent; and the index's own bytes. A nested repository (an
  // untracked folder with its own .git, which ls-files names with a slash) cannot be kept. A few are kept, for a while: Edit from here
  // takes one back only when the rewind that follows the restore is refused.
  async #keepLocal(root,commit,threadId,baseEnv){
    const paths=async args=>String((await this.#captureGit(root,args,{env:baseEnv})).stdout||"").split("\0").filter(Boolean);
    const [indexPath,staged,changed,untracked]=await Promise.all([
      this.#captureGit(root,["rev-parse","--git-path","index"],{env:baseEnv}).then(found=>resolve(root,String(found.stdout||"").trim())),
      paths(["diff-index","--cached","--name-only","-z","--no-renames",commit,"--"]),
      paths(["diff-files","--name-only","-z","--no-renames","--"]),
      paths(["ls-files","--others","--exclude-standard","-z","--"]),
    ]);
    const index=await readFile(indexPath).catch(error=>{if(error?.code==="ENOENT")return null;throw error});
    const id=randomUUID(),dir=join(trebellHome(this.env),"checkpoints","undo-"+id),files=[];
    await mkdir(dir,{recursive:true});
    const untrackedFiles=new Set(untracked);
    try{for(const rel of new Set([...staged,...changed,...untracked]))if(!rel.endsWith("/"))files.push({...await keepFile(root,rel,join(dir,String(files.length))),untracked:untrackedFiles.has(rel)})}
    catch(error){await rm(dir,{recursive:true,force:true}).catch(()=>{});throw error}
    const now=Date.now(),kept={id,threadId,root,dir,files,indexPath,index,keptAt:now};
    for(const entry of [...this.#undos.values()])if(now-entry.keptAt>RESTORE_UNDO_KEEP_MS)this.#forget(entry);
    this.#undos.set(kept.id,kept);
    while(this.#undos.size>RESTORE_UNDO_KEEP_COUNT)this.#forget(this.#undos.values().next().value);
    return kept;
  }
  #forget(kept){this.#undos.delete(kept.id);void rm(kept.dir,{recursive:true,force:true}).catch(()=>{})}
  // Every kept file as it was (its own bytes and mode, a link, or absent), then the index's own bytes, going on past one that cannot be
  // put back (another program holds it); a file that already is as it was (the restore could not replace it) counts as put back. A
  // restore that went through noted each file as it left it (restored): one changed since then (a turn's own work) is left as it is.
  // Answers the files that could not be put back (failed) and the ones left (changedSince).
  async #putBack(kept){
    const failed=[],changedSince=[];
    for(const file of kept.files){
      try{
        if(await isKept(kept.root,file))continue;
        if(kept.restored&&fileState(await lstatOrNull(join(kept.root,file.rel)))!==kept.restored.get(file.rel)){changedSince.push(file.rel);continue}
        await putFileBack(kept.root,file);
      }catch(error){failed.push(file.rel+" ("+(error?.code||error?.message||error)+")")}
    }
    try{if(kept.index)await writeFile(kept.indexPath,kept.index);else await rm(kept.indexPath,{force:true})}
    catch(error){failed.push("the index ("+(error?.code||error?.message||error)+")")}
    return {failed,changedSince};
  }
  // The files go back to the checkpoint, or stay exactly as they were: a restore that fails part-way (git restore wrote some files
  // and stopped, a file could not be removed) puts back what it changed, and the error says whether that worked (filesPutBack). The
  // answer's undoId takes the restore back (undoRestore).
  async restore(id,{threadId=null}={}){
    const cp=this.state.checkpoints().find(item=>item.id===id);
    if(!cp) throw new Error("Checkpoint not found");
    const remote=this.#usesRemoteIo(cp.environmentId),folder=await restorableFolder(this.state,cp,threadId,remote?cp.environmentId:null);
    if(remote)return this.#restoreRemote(cp,folder);
    const baseEnv=this.#localGitEnv(),info=await this.gitInfoFn(cp.root,{env:baseEnv});
    if(!info.isGit) throw new Error("Checkpoint repository is unavailable");
    const kept=await this.#keepLocal(cp.root,cp.commit,threadId,baseEnv);
    try{
      await this.#restoreLocalTree(cp.root,cp.commit,baseEnv,kept);
      kept.restored=new Map();for(const file of kept.files)kept.restored.set(file.rel,fileState(await lstatOrNull(join(cp.root,file.rel))));
    }catch(error){
      kept.restored=null;const message=error?.message||String(error),{failed}=await this.#putBack(kept);
      if(failed.length){this.#undos.delete(kept.id);throw Object.assign(new Error(message+" Putting the files back as they were failed too, for "+listed(failed)+"; their bytes are kept in "+kept.dir+".",{cause:error}),{filesPutBack:false})}
      this.#forget(kept);
      throw Object.assign(new Error(message,{cause:error}),{filesPutBack:true});
    }
    return {ok:true,checkpoint:cp,undoId:kept.id,info:await this.gitInfoFn(cp.root,{env:baseEnv})};
  }
  // Takes a restore back, once: every file as it was before it, the index too, except a file changed since the restore (a turn that
  // started meanwhile), which keeps that change and is named (changedSince). Edit from here does so when the harness refuses the
  // rewind that follows the restore, so the files never stay at the checkpoint with the conversation as it was.
  async undoRestore(undoId,{threadId=null}={}){
    const kept=this.#undos.get(String(undoId||""));
    if(!kept)throw new Error("The files from before this restore are no longer kept.");
    if(!threadId||kept.threadId!==threadId)throw new Error("A restore can be taken back only from the thread that made it.");
    // One that could not put every file back stays kept, so it can be taken back again.
    const {failed,changedSince}=await this.#putBack(kept);
    if(failed.length)throw new Error("Could not put every file back as it was: "+listed(failed)+".");
    this.#forget(kept);
    return {ok:true,...(changedSince.length?{changedSince}:{})};
  }
}
