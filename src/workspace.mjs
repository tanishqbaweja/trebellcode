import { lstat, mkdir, open, readdir, readFile, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

const execFileAsync = promisify(execFile);
const SKIP = new Set([".git","node_modules","target","dist","build",".next",".cache","desktop-dist"]);

function remoteProfile(environments,environmentId){
  if(!environmentId||!environments)return null;
  const profile=environments.get(environmentId);
  return profile&&profile.type!=="local"?profile:null;
}

function remotePath(root,path){
  const base=posix.normalize(String(root||"/"));
  const value=String(path||"").trim();
  const absolute=value.startsWith("/")?posix.normalize(value):posix.normalize(posix.join(base,value));
  if(absolute!==base&&!absolute.startsWith(base.endsWith("/")?base:base+"/"))throw new Error("File is outside the active workspace");
  return {base,absolute};
}

function remoteFindArgs(root,depth,type){
  const args=[root,"-maxdepth",String(Math.max(1,Number(depth)||1)),"-mindepth","1","("];
  let first=true;
  for(const name of SKIP){
    if(!first)args.push("-o");
    args.push("-name",name);first=false;
  }
  args.push(")","-prune","-o","-type",type,"-print");
  return args;
}

function gitFileEntries(raw,root,{remote=false}={}){
  const value=String(raw||"");
  const paths=(value.includes("\0")?value.split("\0"):value.split(/\r?\n/)).map(item=>item.trim()).filter(Boolean);
  return paths.filter(relativePath=>{
    const parts=relativePath.replace(/\\/g,"/").split("/").filter(Boolean);
    return parts.length&&!parts.some(part=>SKIP.has(part))&&!parts.includes("..");
  }).map(relativePath=>{
    const normalized=remote?relativePath.replace(/\\/g,"/"):relativePath;
    const path=remote?posix.join(root,normalized):resolve(root,normalized);
    const name=remote?posix.basename(normalized):basename(normalized);
    return {name,path,relativePath:normalized,isDirectory:false,isFile:true,depth:Math.max(0,normalized.replace(/\\/g,"/").split("/").length-1)};
  });
}

function compactSearchText(value){return String(value||"").toLowerCase().replace(/[^a-z0-9]/g,"")}
function subsequenceScore(query,value){
  if(!query||!value)return null;
  let cursor=0,first=-1,previous=-2,gaps=0,streak=0;
  for(const character of query){
    const index=value.indexOf(character,cursor);if(index<0)return null;
    if(first<0)first=index;
    gaps+=Math.max(0,index-cursor);
    if(index===previous+1)streak++;
    previous=index;cursor=index+1;
  }
  return first*2+gaps*4+Math.max(0,value.length-query.length)*0.08-streak*1.5;
}

function workspaceSearchScore(entry,query){
  const needle=String(query||"").trim().toLowerCase().replace(/\\/g,"/");
  if(!needle)return null;
  const name=String(entry.name||"").toLowerCase().replace(/\\/g,"/");
  const path=String(entry.relativePath||entry.path||"").toLowerCase().replace(/\\/g,"/");
  if(name===needle)return 0;
  if(path===needle)return 2;
  if(name.startsWith(needle))return 10+(name.length-needle.length)*0.05;
  if(path.startsWith(needle))return 20+(path.length-needle.length)*0.03;
  const nameIndex=name.indexOf(needle);if(nameIndex>=0)return 30+nameIndex+(name.length-needle.length)*0.05;
  const pathIndex=path.indexOf(needle);if(pathIndex>=0)return 40+pathIndex+(path.length-needle.length)*0.03;
  const compactNeedle=compactSearchText(needle);if(!compactNeedle)return null;
  const nameFuzzy=subsequenceScore(compactNeedle,compactSearchText(name));
  const pathFuzzy=subsequenceScore(compactNeedle,compactSearchText(path));
  if(nameFuzzy==null&&pathFuzzy==null)return null;
  return Math.min(nameFuzzy==null?Infinity:60+nameFuzzy,pathFuzzy==null?Infinity:80+pathFuzzy);
}

export function rankWorkspaceSearchItems(entries,query,{limit=100}={}){
  const bounded=Math.max(1,Math.min(500,Number(limit)||100));
  return (entries||[]).filter(entry=>entry?.isFile!==false).map(entry=>({entry,score:workspaceSearchScore(entry,query)}))
    .filter(item=>item.score!=null&&Number.isFinite(item.score))
    .sort((a,b)=>a.score-b.score||String(a.entry.relativePath||a.entry.path||"").length-String(b.entry.relativePath||b.entry.path||"").length||String(a.entry.relativePath||a.entry.path||"").localeCompare(String(b.entry.relativePath||b.entry.path||"")))
    .slice(0,bounded).map(item=>item.entry);
}

async function localGitFiles(root){
  try{
    const {stdout}=await execFileAsync("git",["-C",root,"ls-files","-co","--exclude-standard","-z"],{windowsHide:true,maxBuffer:16*1024*1024,timeout:12000});
    return {available:true,entries:gitFileEntries(stdout,root)};
  }catch{return {available:false,entries:[]}}
}

async function remoteGitFiles(environments,environmentId,root){
  try{
    const result=await environments.executeArgv(environmentId,{command:"git",args:["-C",root,"ls-files","-co","--exclude-standard","-z"],cwd:"",timeoutMs:15000,maxOutput:16*1024*1024});
    return result.exitCode===0?{available:true,entries:gitFileEntries(result.stdout,root,{remote:true})}:{available:false,entries:[]};
  }catch{return {available:false,entries:[]}}
}

async function remoteTree(environments,environmentId,root,{depth=3,limit=500}={}){
  const profile=remoteProfile(environments,environmentId);if(!profile)return null;
  const base=posix.normalize(String(root||profile.cwd||"/"));
  const maxDepth=Math.max(1,Math.min(12,Number(depth)+1||4));
  const [dirs,files]=await Promise.all([
    environments.executeArgv(environmentId,{command:"find",args:remoteFindArgs(base,maxDepth,"d"),cwd:"",timeoutMs:15000}),
    environments.executeArgv(environmentId,{command:"find",args:remoteFindArgs(base,maxDepth,"f"),cwd:"",timeoutMs:15000}),
  ]);
  if(dirs.exitCode!==0||files.exitCode!==0)throw new Error(dirs.stderr||files.stderr||"Could not list remote workspace");
  const make=(raw,isDirectory)=>String(raw||"").split(/\r?\n/).filter(Boolean).map(full=>{
    const relativePath=posix.relative(base,full);
    return {name:posix.basename(full),path:full,relativePath,isDirectory,isFile:!isDirectory,depth:Math.max(0,relativePath.split("/").length-1)};
  }).filter(item=>item.relativePath&&!item.relativePath.startsWith("../"));
  const entries=[...make(dirs.stdout,true),...make(files.stdout,false)]
    .sort((a,b)=>Number(b.isDirectory)-Number(a.isDirectory)||a.relativePath.localeCompare(b.relativePath));
  return {root:base,entries:entries.slice(0,limit),truncated:entries.length>limit,environmentId};
}

export async function workspaceTree(root, { depth = 3, limit = 500 } = {}) {
  const absolute = resolve(root || process.cwd());
  const result = [];
  let remaining = limit;

  async function walk(dir, level) {
    if (level > depth || remaining <= 0) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (remaining-- <= 0) break;
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      result.push({
        name: entry.name,
        path: full,
        // "/" on every platform, as git ls-files and remote trees report it, so a Windows path reads src/a.js, not src\a.js.
        relativePath: full.slice(absolute.length + (absolute.endsWith("/") || absolute.endsWith("\\") ? 0 : 1)).split(sep).join("/"),
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        depth: level,
      });
      if (entry.isDirectory()) await walk(full, level + 1);
    }
  }
  await walk(absolute, 0);
  return { root: absolute, entries: result, truncated: remaining <= 0 };
}

export async function environmentWorkspaceTree(root,{depth=3,limit=500,environments=null,environmentId=null}={}){
  return await remoteTree(environments,environmentId,root,{depth,limit})||workspaceTree(root,{depth,limit});
}

// The Diff tab shows the working tree against HEAD, so a staged change shows as well as an unstaged one. A branch with no commit yet
// has no HEAD (git exits 128): the empty tree, SHA-1's or SHA-256's, which git knows without storing it, takes its place, and a
// repository that fails with both too keeps HEAD's own failure.
const EMPTY_TREES=["4b825dc642cb6eb9a060e54bf8d69288fbee4904","6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"];
async function diffAgainstHead(diff){
  try{return await diff("HEAD")}
  catch(error){
    if(error?.code!==128)throw error;
    for(const tree of EMPTY_TREES){try{return await diff(tree)}catch{}}
    throw error;
  }
}
// git status --short C-quotes a path holding a space, a quote, a backslash, a control character or (by default) a non-ASCII letter,
// whose UTF-8 bytes it writes in octal ("caf\303\251.txt"), as the UI's gitStatusPath reads it too.
const C_ESCAPES={a:7,b:8,t:9,n:10,v:11,f:12,r:13,'"':34,"\\":92};
function statusPath(text){
  if(!text.startsWith('"'))return text;
  const bytes=[];
  for(let index=1;index<text.length&&text[index]!=='"';){
    const octal=text[index]==="\\"?/^[0-7]{3}/.exec(text.slice(index+1,index+4)):null,escape=text[index]==="\\"?C_ESCAPES[text[index+1]]:undefined;
    if(octal){bytes.push(parseInt(octal[0],8));index+=4}
    else if(escape!==undefined){bytes.push(escape);index+=2}
    else{const char=String.fromCodePoint(text.codePointAt(index));bytes.push(...Buffer.from(char));index+=char.length}
  }
  return Buffer.from(bytes).toString("utf8");
}
// git diff writes more than the 4 MB the read keeps when a large file is staged or a change is big: what it wrote by then is shown,
// up to its last whole line, with a note line, and the list and the new files beside it. The whole read used to fail, and the Diff
// tab lost its list with it (Generate's commit text got no status and no diff either).
const DIFF_BYTES=4*1024*1024;
function cutDiff(text){return text.slice(0,text.lastIndexOf("\n")+1)+"\\ The rest of the diff is not shown: it is over 4 MB.\n"}
// git diff leaves out the files git does not track yet, which git status lists ("?? path", a new folder as "?? folder/"), so each one
// is shown here as git diff shows a file added with git add -N: its lines added, a binary file (a NUL byte in its first 8000 bytes,
// as git counts one, and only those are read) or a link by its target, which is not followed. Only a new folder's files take a git
// process to list; the files are read directly, and no more text than the Files view's 512 KB each, 4 MB and 200 files in all.
const NEW_FILE_BYTES=512_000,NEW_FILES_BYTES=4*1024*1024,NEW_FILES_MAX=200;
// New files in a folder the Files view leaves out (SKIP: node_modules, dist, build, ...) are named by their folder on a note line,
// and a new folder's own such folders are not even listed (-x), so a node_modules/ git does not ignore (packages installed before
// a .gitignore was written) no longer takes the 200 files before the agent's own files.
const SKIP_EXCLUDES=[...SKIP].filter(name=>name!==".git").flatMap(name=>["-x",name+"/"]);
function skippedFolder(path){
  const parts=path.split("/"),at=parts.findIndex((part,index)=>index<parts.length-1&&SKIP.has(part));
  return at<0?null:parts.slice(0,at+1).join("/")+"/";
}
function untrackedEntries(status){return String(status||"").split(/\r?\n/).filter(line=>line.startsWith("?? ")).map(line=>statusPath(line.slice(3)))}
function skippedNotes(status){return [...new Set(untrackedEntries(status).map(skippedFolder).filter(Boolean))].map(folder=>"\\ New files in "+folder+" are not shown.\n").join("")}
function restNote(rest){return rest>0?"\\ "+rest+" more new file"+(rest===1?" is":"s are")+" not shown.\n":""}
async function readNewFile(path,size){
  const handle=await open(path,"r");
  try{
    const head=Buffer.alloc(Math.min(size,8000)),{bytesRead}=await handle.read(head,0,head.length,0);
    if(head.subarray(0,bytesRead).includes(0))return {binary:true};
    return size>NEW_FILE_BYTES?{size}:{bytes:await handle.readFile()};
  }finally{await handle.close()}
}
function newFileDiff(path,{mode="100644",bytes=null,binary=false,size=0}){
  const head="diff --git a/"+path+" b/"+path+"\nnew file mode "+mode+"\n";
  if(binary)return head+"Binary files /dev/null and b/"+path+" differ\n";
  if(!bytes)return head+"File is too large to preview ("+Math.ceil(size/1024)+" KB)\n";
  if(!bytes.length)return head;
  const text=bytes.toString("utf8"),ends=text.endsWith("\n"),lines=(ends?text.slice(0,-1):text).split("\n");
  return head+"--- /dev/null\n+++ b/"+path+"\n@@ -0,0 +1"+(lines.length===1?"":","+lines.length)+" @@\n"+lines.map(line=>"+"+line+"\n").join("")+(ends?"":"\\ No newline at end of file\n");
}
async function newFilesDiff(cwd,status,listFolders){
  const entries=untrackedEntries(status).filter(path=>!skippedFolder(path));
  if(!entries.length)return skippedNotes(status);
  // A new folder's files take its place in git status's order.
  const folders=entries.filter(path=>path.endsWith("/")),listed=folders.length?String(await listFolders(folders)).split("\0").filter(path=>path&&!path.endsWith("/")):[];
  const inside=folder=>{const base=resolve(cwd,folder)+sep;return listed.filter(path=>resolve(cwd,path).startsWith(base))};
  const paths=entries.flatMap(path=>path.endsWith("/")?inside(path):[path]);
  let out="",budget=NEW_FILES_BYTES,shown=0,index=0;
  for(;index<paths.length&&shown<NEW_FILES_MAX&&budget>0;index++){
    const path=paths[index],full=join(cwd,path),info=await lstat(full).catch(()=>null);
    if(info?.isSymbolicLink()){const target=await readlink(full).catch(()=>null);if(target!==null){out+=newFileDiff(path,{mode:"120000",bytes:Buffer.from(target)});shown++}continue}
    if(!info?.isFile())continue;
    const read=await readNewFile(full,info.size).catch(()=>null);if(!read)continue;
    out+=newFileDiff(path,{mode:process.platform!=="win32"&&info.mode&0o111?"100755":"100644",...read});shown++;budget-=read.bytes?.length||0;
  }
  // The rest are counted on a note line, as git notes "\ No newline at end of file".
  return out+restNote(paths.length-index)+skippedNotes(status);
}
const OVER=error=>error?.code==="ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

export async function workspaceDiff(root,{gitFn=null}={}) {
  const cwd = resolve(root || process.cwd());
  // gitFn runs each git command (tests count them through it).
  const git=(args,maxBuffer)=>gitFn?gitFn(cwd,args,{maxBuffer}):execFileAsync("git",args,{cwd,windowsHide:true,maxBuffer});
  try {
    const statusRead=git(["status","--short"],512*1024).catch(()=>({stdout:""}));
    const { stdout, stderr } = await diffAgainstHead(base=>git(["diff","--no-ext-diff","--no-color",base,"--"],DIFF_BYTES).catch(error=>{
      if(!OVER(error))throw error;
      return {stdout:cutDiff(String(error.stdout||"")),stderr:String(error.stderr||"")};
    }));
    const { stdout: statusOut } = await statusRead;
    // A listing over its 4 MB keeps the paths it wrote whole.
    const added=await newFilesDiff(cwd,statusOut,folders=>git(["--literal-pathspecs","ls-files","--others","--exclude-standard",...SKIP_EXCLUDES,"-z","--",...folders],4*1024*1024).then(result=>result.stdout,error=>OVER(error)?String(error.stdout||"").replace(/[^\0]*$/,""):""));
    return { cwd, isGit: true, status: statusOut, diff: stdout+added, stderr };
  } catch (error) {
    // Outside a Git repository git diff takes its arguments as two paths to compare and, given none, prints its whole usage and
    // exits 129: the folder is named as not a repository instead.
    if (error?.code === 129) return { cwd, isGit: false, status: "", diff: "", error: "This folder is not a Git repository" };
    return { cwd, isGit: false, status: "", diff: "", error: error instanceof Error ? error.message : String(error) };
  }
}

// A remote environment's read has the local one's order and caps, in one session: first the staged and unstaged changes against
// HEAD (the empty tree on a branch with no commit yet), 4 MB of them at most, then the new files git does not track yet, in path
// order, as git diff shows them once added with git add -N to a copy of the index (removed after): 200 at most, one over 512 KB
// named with its size, 4 MB of text in all, none from a folder the Files view leaves out. The new files used to come in path order
// with the rest, so a large one could push the tracked edits out of the 2 MB a session kept. The lines between the parts ("\ <…>")
// are ones git diff never writes: its only line starting "\ " is "\ No newline at end of file".
const REMOTE_CUT="\\ <trebell: diff cut>",REMOTE_NEW="\\ <trebell: new files>",REMOTE_LEFT="\\ <trebell: new files left out>";
const REMOTE_DIFF_SCRIPT=[
  "cd \"./$(git rev-parse --show-cdup)\" || exit 1",
  "o=$(mktemp -d) || exit 1; trap 'rm -rf \"$o\"' EXIT; i=$o/index t=$o/diff l=$o/large c=$o/new w=$o/sizes; : >\"$l\"; : >\"$c\"; : >\"$w\"",
  "x=$(git rev-parse --git-path index) || exit 1",
  "if [ -f \"$x\" ]; then cp \"$x\" \"$i\" || exit 1; else rm -f \"$i\"; fi",
  "b=HEAD; git rev-parse -q --verify HEAD >/dev/null || b=$(git hash-object -t tree /dev/null)",
  // One byte more than the read keeps says that the diff was cut.
  "git diff --no-ext-diff --no-color \"$b\" -- | head -c "+(DIFF_BYTES+1)+" >\"$t\"",
  "d=$(wc -c <\"$t\"); d=${d##* }",
  "if [ \"$d\" -gt "+DIFF_BYTES+" ]; then head -c "+DIFF_BYTES+" \"$t\"; printf '\\n%s\\n' '"+REMOTE_CUT+"'; else cat \"$t\"; fi",
  "printf '%s\\n' '"+REMOTE_NEW+"'",
  // The first 200 new files, the rest counted, and the sizes of the regular ones among them from one wc, matched by name (one that
  // wc cannot read has no line): a process for each file took minutes where starting one is slow (sh on Windows, a loaded host).
  "git --literal-pathspecs ls-files --others --exclude-standard "+SKIP_EXCLUDES.map(word=>"'"+word+"'").join(" ")+" -z | tr '\\0' '\\n' | {",
  "  n=0; r=0; set --",
  "  while IFS= read -r f; do",
  "    if [ \"$n\" -ge "+NEW_FILES_MAX+" ]; then r=$((r+1)); continue; fi",
  "    if [ -L \"$f\" ]; then :; elif [ -f \"$f\" ]; then set -- \"$@\" \"./$f\"; else continue; fi",
  "    printf '%s\\n' \"$f\" >>\"$c\"; n=$((n+1))",
  "  done",
  "  if [ \"$#\" -gt 0 ]; then wc -c \"$@\" >\"$w\" 2>/dev/null; fi",
  "  set --; k=0; p=",
  "  exec 3<\"$w\"",
  "  while IFS= read -r f; do",
  "    if [ \"$k\" -ge "+NEW_FILES_BYTES+" ]; then r=$((r+1)); continue; fi",
  "    if [ ! -L \"$f\" ]; then",
  "      if [ -z \"$p\" ]; then IFS= read -r p <&3; p=${p#\"${p%%[! ]*}\"}; fi",
  "      [ \"${p#* }\" = \"./$f\" ] || continue",
  "      s=${p%% *}; p=",
  "      if [ \"$s\" -gt "+NEW_FILE_BYTES+" ]; then",
  "        if [ -x \"$f\" ]; then m=100755; else m=100644; fi",
  "        printf '%s %s %s\\n' \"$s\" \"$m\" \"$f\" >>\"$l\"; continue",
  "      fi",
  "      k=$((k+s))",
  "    fi",
  "    set -- \"$@\" \"$f\"",
  "  done <\"$c\"",
  "  exec 3<&-",
  "  if [ \"$#\" -gt 0 ]; then",
  "    GIT_INDEX_FILE=\"$i\" git --literal-pathspecs add --intent-to-add -- \"$@\" >/dev/null 2>&1",
  "    GIT_INDEX_FILE=\"$i\" git --literal-pathspecs diff --no-ext-diff --no-color \"$b\" -- \"$@\"",
  "  fi",
  "  printf '%s\\n' '"+REMOTE_LEFT+"'; cat \"$l\"; printf '%s\\n' \"$r\"",
  "}",
].join("\n");
// The script's output as the Diff tab shows it, its parts' lines read away: the cut diff ends at its last whole line with the local
// note, a file over 512 KB and the files left out are named as the local read names them, and so are the folders the Files view
// leaves out, from the session's git status. An output without the parts (the script stopped early) is shown as it came.
const lineAt=(text,line)=>{for(let at=text.indexOf(line);at>=0;at=text.indexOf(line,at+1))if((at===0||text[at-1]==="\n")&&(at+line.length===text.length||text[at+line.length]==="\n"))return at;return -1};
function remoteDiffText(out,status){
  const text=String(out||""),start=lineAt(text,REMOTE_NEW);
  if(start<0)return text;
  const cut=lineAt(text.slice(0,start),REMOTE_CUT),tracked=cut<0?text.slice(0,start):cutDiff(text.slice(0,Math.max(0,cut-1)));
  const rest=text.slice(start+REMOTE_NEW.length+1),left=lineAt(rest,REMOTE_LEFT);
  if(left<0)return tracked+rest;
  const meta=rest.slice(left+REMOTE_LEFT.length+1).split("\n").filter(Boolean),count=Number(meta.pop())||0;
  const large=meta.map(line=>/^(\d+) (\d+) (.+)$/.exec(line)).filter(Boolean).map(([,size,mode,path])=>newFileDiff(path,{mode,size:Number(size)})).join("");
  return tracked+rest.slice(0,left)+large+restNote(count)+skippedNotes(status);
}

export async function environmentWorkspaceDiff(root,{environments=null,environmentId=null}={}){
  const profile=remoteProfile(environments,environmentId);
  if(!profile)return workspaceDiff(root);
  const cwd=posix.normalize(String(root||profile.cwd||"/"));
  const inside=await environments.executeArgv(environmentId,{command:"git",args:["rev-parse","--show-toplevel"],cwd,timeoutMs:12000});
  if(inside.exitCode!==0)return {cwd,isGit:false,status:"",diff:"",error:(inside.stderr||inside.stdout||"Not a Git repository").trim(),environmentId};
  // Up to 4 MB of the diff and 4 MB of new files' text, with the + git puts before each line: the session keeps 2 MB unless told more.
  const [diff,status]=await Promise.all([
    environments.executeArgv(environmentId,{command:"sh",args:["-c",REMOTE_DIFF_SCRIPT],cwd,timeoutMs:20000,maxOutput:16*1024*1024}),
    environments.executeArgv(environmentId,{command:"git",args:["status","--short"],cwd,timeoutMs:12000}),
  ]);
  return {cwd,isGit:true,status:status.stdout||"",diff:remoteDiffText(diff.stdout||"",status.stdout||""),stderr:[diff.stderr,status.stderr].filter(Boolean).join("\n"),environmentId};
}

// A model's read of a text file over its limit (truncate) gets the file's first maxBytes instead of a refusal: cut after the last
// line break in their last quarter, or else before the UTF-8 character the limit would split, with the file's size and line count,
// so the model can read on by line range or another tool. A head holding a NUL byte keeps the refusal (a binary file has no lines
// to read on by), and a file over LINE_COUNT_MAX_BYTES is not read through to count its lines. Every other reader (an edit, a
// recovery snapshot, a preview) needs the file whole, so it is refused as before.
const LINE_COUNT_MAX_BYTES=64*1024*1024;
const tooLargeToPreview=size=>new Error(`File is too large to preview (${Math.ceil(size/1024)} KB)`);
function fileHead({path,name,size,head,totalLines=null,environmentId=null}){
  if(head.includes(0))throw tooLargeToPreview(size);
  const lastBreak=head.lastIndexOf(10);let end=lastBreak>=0&&lastBreak+1>=head.length*.75?lastBreak+1:head.length;
  if(end===head.length&&end>0){let lead=end-1;while(lead>0&&(head[lead]&0xc0)===0x80)lead--;if(lead+(head[lead]>=0xf0?4:head[lead]>=0xe0?3:head[lead]>=0xc0?2:1)>end)end=lead}
  let breaks=0;for(let at=head.indexOf(10);at>=0&&at<end;at=head.indexOf(10,at+1))breaks++;
  const whole=end>0&&head[end-1]===10,shownLines=breaks+(whole?0:1),lines=totalLines==null?"":`, ${totalLines} line${totalLines===1?"":"s"}`;
  const message=whole
    ?`The file is ${size} bytes${lines}; this read holds ${shownLines===1?"line 1":`lines 1-${shownLines}`} (${end} bytes). Read on from line ${shownLines+1} by line range or with a terminal command.`
    :`The file is ${size} bytes${lines}; this read holds its first ${end} bytes, which end inside line ${shownLines}. Read on from line ${shownLines} by line range or with a terminal command.`;
  return {path,name,size,truncated:true,...(totalLines==null?{}:{totalLines}),message,content:head.subarray(0,end).toString("utf8"),...(environmentId?{environmentId}:{})};
}
async function localFileHead(absolute,size,maxBytes){
  const handle=await open(absolute,"r");
  try{
    const head=Buffer.alloc(Math.min(size,maxBytes)),{bytesRead}=await handle.read(head,0,head.length,0);
    if(size>LINE_COUNT_MAX_BYTES)return {head:head.subarray(0,bytesRead)};
    // Only the size the read reports is counted: a file a running process still writes (a log) would otherwise add lines the
    // size does not hold, and a writer faster than the read would keep the count going.
    const chunk=Buffer.alloc(Math.min(size,1024*1024));let breaks=0,last=10;
    for(let position=0,read;position<size&&(read=(await handle.read(chunk,0,Math.min(chunk.length,size-position),position)).bytesRead)>0;position+=read){
      for(let at=chunk.indexOf(10);at>=0&&at<read;at=chunk.indexOf(10,at+1))breaks++;
      last=chunk[read-1];
    }
    return {head:head.subarray(0,bytesRead),totalLines:breaks+(last===10?0:1)};
  }finally{await handle.close()}
}
// A remote file's first bytes are streamed (never the whole file), and its lines are counted in its environment: wc -l counts the
// line breaks, and the second count is 1 when the file ends with one.
async function remoteFileHead(environments,environmentId,absolute,size,maxBytes){
  if(typeof environments.streamFile!=="function")throw tooLargeToPreview(size);
  const child=environments.streamFile(environmentId,absolute,{start:0,length:maxBytes}),chunks=[];let count=0;
  const closed=new Promise((resolveClose,reject)=>{child.once("error",reject);child.once("close",code=>code===0?resolveClose():reject(new Error("Could not read remote file")))});
  closed.catch(()=>{});
  try{
    for await(const chunk of child.stdout){const part=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);chunks.push(part);count+=part.length}
    await closed;
  }catch(error){child.kill?.();throw error}
  const head=Buffer.concat(chunks,count).subarray(0,maxBytes);
  if(size>LINE_COUNT_MAX_BYTES)return {head};
  const counted=typeof environments.executeArgv==="function"?await environments.executeArgv(environmentId,{command:"sh",args:["-c","wc -l < \"$1\"; tail -c 1 \"$1\" | wc -l","sh",absolute],cwd:"",timeoutMs:20000}).catch(()=>null):null;
  const [breaks,ends]=(counted?.exitCode===0?String(counted.stdout||""):"").trim().split(/\s+/).map(Number);
  return Number.isSafeInteger(breaks)&&(ends===0||ends===1)?{head,totalLines:breaks+(ends?0:1)}:{head};
}

export async function workspaceFile(filePath, maxBytes = 512_000, { truncate = false } = {}) {
  const absolute = resolve(filePath);
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error("Not a file");
  if (info.size > maxBytes) {
    if (!truncate) throw tooLargeToPreview(info.size);
    return fileHead({ path: absolute, name: basename(absolute), size: info.size, ...await localFileHead(absolute, info.size, maxBytes) });
  }
  const content = await readFile(absolute, "utf8");
  return { path: absolute, name: basename(absolute), content, size: info.size };
}

export async function environmentWorkspaceFile(filePath,maxBytes=512_000,{root=null,environments=null,environmentId=null,truncate=false}={}){
  const profile=remoteProfile(environments,environmentId);
  if(!profile)return workspaceFile(filePath,maxBytes,{truncate});
  const {absolute}=remotePath(root||profile.cwd||"/",filePath);
  const info=await environments.attachmentInfo(environmentId,absolute);
  if(info.size>maxBytes){
    if(!truncate)throw tooLargeToPreview(info.size);
    return fileHead({path:absolute,name:posix.basename(absolute),size:info.size,environmentId,...await remoteFileHead(environments,environmentId,absolute,info.size,maxBytes)});
  }
  const result=await environments.executeArgv(environmentId,{command:"cat",args:[absolute],cwd:"",timeoutMs:12000});
  if(result.exitCode!==0)throw new Error(result.stderr||"Could not read remote file");
  return {path:absolute,name:posix.basename(absolute),content:result.stdout,size:info.size,environmentId};
}


export async function workspaceSearch(root, query, { limit = 100 } = {}) {
  const absolute=resolve(root||process.cwd());
  const needle=String(query||"").trim();
  if(!needle) return {root:absolute,items:[]};
  const gitFiles=await localGitFiles(absolute);
  if(gitFiles.available)return {root:absolute,items:rankWorkspaceSearchItems(gitFiles.entries,needle,{limit}),source:"git"};
  const tree=await workspaceTree(absolute,{depth:12,limit:12000});
  return {root:absolute,items:rankWorkspaceSearchItems(tree.entries,needle,{limit}),source:"tree",truncated:tree.truncated};
}

export async function environmentWorkspaceSearch(root,query,{limit=100,environments=null,environmentId=null}={}){
  const profile=remoteProfile(environments,environmentId);
  if(!profile)return workspaceSearch(root,query,{limit});
  const absolute=posix.normalize(String(root||profile.cwd||"/"));
  const needle=String(query||"").trim();
  if(!needle)return {root:absolute,items:[],environmentId};
  const gitFiles=await remoteGitFiles(environments,environmentId,absolute);
  if(gitFiles.available)return {root:absolute,items:rankWorkspaceSearchItems(gitFiles.entries,needle,{limit}),environmentId,source:"git"};
  const tree=await remoteTree(environments,environmentId,absolute,{depth:12,limit:8000});
  return {root:absolute,items:rankWorkspaceSearchItems(tree.entries,needle,{limit}),environmentId,source:"tree",truncated:tree.truncated};
}

export async function workspaceWriteFile(filePath, content) {
  const absolute=resolve(filePath);
  await mkdir(join(absolute,".."),{recursive:true}).catch(()=>{});
  await writeFile(absolute,String(content??""),"utf8");
  return workspaceFile(absolute,2*1024*1024);
}

export async function environmentWorkspaceWriteFile(filePath,content,{root=null,environments=null,environmentId=null}={}){
  const profile=remoteProfile(environments,environmentId);
  if(!profile)return workspaceWriteFile(filePath,content);
  const {absolute}=remotePath(root||profile.cwd||"/",filePath);
  const bytes=Buffer.byteLength(String(content??""),"utf8");
  if(bytes>2*1024*1024)throw new Error("File is too large to edit (maximum 2 MB)");
  await environments.writeTextFile(environmentId,absolute,content);
  return environmentWorkspaceFile(absolute,2*1024*1024,{root:root||profile.cwd,environments,environmentId});
}

export function environmentWorkspacePath(root,filePath,{environments=null,environmentId=null}={}){
  const profile=remoteProfile(environments,environmentId);
  if(!profile)return {remote:false,root:resolve(root||process.cwd()),path:resolve(filePath||"")};
  const resolved=remotePath(root||profile.cwd||"/",filePath);
  return {remote:true,root:resolved.base,path:resolved.absolute,profile};
}

// Where a local path is on disk, through '..' and links, its last part included. A path not made yet is placed by its nearest
// folder that is there; a link that leads nowhere is refused, as writing through it would make its target wherever it points.
async function realPlace(path){
  try{return await realpath(path)}
  catch(error){
    if(error?.code!=="ENOENT"||dirname(path)===path)throw error;
    if(await lstat(path).then(()=>true,()=>false))throw new Error("File is outside the active workspace");
    return join(await realPlace(dirname(path)),basename(path));
  }
}
// A local file the Files editor reads or writes is one inside the project's own folder once both are placed on disk, as a remote
// one must stay inside its workspace: a path out of it by '..' or through a link is refused, so nothing outside is read or written.
async function insideLocalRoot({root,path}){
  const [top,place]=await Promise.all([realPlace(root),realPlace(path)]);
  const rel=relative(top,place);
  if(rel===".."||rel.startsWith(".."+sep)||isAbsolute(rel))throw new Error("File is outside the active workspace");
}
// The system's error for a local file the Files view reads, in plain words rather than its code and the file's full path: one that
// is not there says so by its name (the save still sees ENOENT), and one the system will not let Trebell read says that.
function plainFileError(path){
  return error=>{throw error?.code==="ENOENT"?Object.assign(new Error(basename(path)+" was not found"),{code:"ENOENT"}):error?.code==="EPERM"||error?.code==="EACCES"?Object.assign(new Error("Trebell is not allowed to read this file"),{code:error.code}):error};
}
// A local file the Files view reads, as text in the editor or from its raw address (a picture, video, sound or PDF): placed inside
// the project's folder first, so nothing outside it is read by either.
export async function localWorkspaceFileInfo(located){
  const plain=plainFileError(located.path);
  await insideLocalRoot(located).catch(plain);
  const info=await stat(located.path).catch(plain);
  if(!info.isFile())throw new Error("Not a file");
  return info;
}

// The Files panel's viewer and editor read a file as bytes (a remote one streams from its environment, so no byte is lost to text
// decoding on the way). It is text only when its bytes are UTF-8 with no NUL byte, so saving what the editor shows writes the same
// bytes back; anything else (an image, an archive, a UTF-16 or Latin-1 file) is binary, shown with its size and never as text.
// The version is a hash of the bytes read: a save names the version it edited, so a change made on disk since is never overwritten
// unseen.
async function editorBytes(filePath,maxBytes,{root=null,environments=null,environmentId=null}={}){
  const located=environmentWorkspacePath(root,filePath,{environments,environmentId});
  const name=located.remote?posix.basename(located.path):basename(located.path);
  let size;
  if(located.remote)size=(await environments.attachmentInfo(environmentId,located.path)).size;
  else size=(await localWorkspaceFileInfo(located)).size;
  const tooLarge=bytes=>new Error(`File is too large to preview (${Math.ceil(bytes/1024)} KB)`);
  if(size>maxBytes)throw tooLarge(size);
  if(!located.remote)return {located,name,bytes:await readFile(located.path).catch(plainFileError(located.path))};
  const child=environments.streamFile(environmentId,located.path),chunks=[];let count=0;
  // The read's end is awaited once the bytes are in; a failure that comes first is held for that await, never left unhandled.
  const closed=new Promise((resolveClose,reject)=>{child.once("error",reject);child.once("close",code=>code===0?resolveClose():reject(new Error("Could not read remote file")))});
  closed.catch(()=>{});
  try{
    for await(const chunk of child.stdout){count+=chunk.length;if(count>maxBytes)throw tooLarge(count);chunks.push(chunk)}
    await closed;
  }catch(error){child.kill?.();throw error}
  return {located,name,bytes:Buffer.concat(chunks,count)};
}
function editorView({located,name,bytes},environmentId=null){
  const binary=bytes.includes(0)||!isUtf8(bytes);
  return {path:located.path,name,size:bytes.length,version:createHash("sha256").update(bytes).digest("hex"),binary,content:binary?null:bytes.toString("utf8"),...(located.remote?{environmentId}:{})};
}

export async function environmentWorkspaceEditorFile(filePath,{maxBytes=512_000,root=null,environments=null,environmentId=null}={}){
  return editorView(await editorBytes(filePath,maxBytes,{root,environments,environmentId}),environmentId);
}

// Saves the editor's text over the version it edited (null: no file yet). A file that changed or went on disk since is not written:
// the answer says so and names the version there now (null when it is gone), which an Overwrite then saves over. A binary file is
// never saved over as text. On a remote environment a file that cannot be read counts as gone, as a missing file and a failed read
// look alike there.
export async function environmentWorkspaceEditorSave(filePath,content,{version=null,root=null,environments=null,environmentId=null}={}){
  const bytes=Buffer.from(String(content??""),"utf8");
  if(bytes.length>2*1024*1024)throw new Error("File is too large to edit (maximum 2 MB)");
  const located=environmentWorkspacePath(root,filePath,{environments,environmentId});
  // The read refuses a local path outside the project (that error is never taken for a missing file), so nothing is written there.
  const current=await editorBytes(filePath,32*1024*1024,{root,environments,environmentId}).then(read=>editorView(read),error=>{if(error?.code==="ENOENT"||located.remote)return null;throw error});
  if(current?.binary)throw new Error(current.name+" is a binary file, so it is not saved as text");
  const name=located.remote?posix.basename(located.path):basename(located.path);
  if((current?.version??null)!==(version||null))return {conflict:current?"changed":"deleted",version:current?.version??null,error:name+(current?" changed on disk after you opened it.":" was deleted on disk after you opened it.")};
  if(located.remote)await environments.writeTextFile(environmentId,located.path,bytes);
  else{await mkdir(dirname(located.path),{recursive:true});await writeFile(located.path,bytes)}
  return editorView({located,name,bytes},environmentId);
}
