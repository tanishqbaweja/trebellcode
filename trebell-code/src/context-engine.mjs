import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync=promisify(execFile);
const SKIP=new Set([".git","node_modules","target","dist","build",".next",".cache","desktop-dist","coverage","vendor"]);
const SOURCE_EXTENSIONS=new Set([".js",".jsx",".ts",".tsx",".mjs",".cjs",".py",".rs",".go",".java",".kt",".kts",".cs",".c",".h",".cc",".cpp",".cxx",".hpp",".hh",".rb",".php",".swift",".vue",".svelte"]);
const RESOLVE_EXTENSIONS=[".js",".jsx",".ts",".tsx",".mjs",".cjs",".py",".rs",".go",".java",".kt",".cs"];
const INSTRUCTION_NAMES=new Set(["AGENTS.md","CLAUDE.md"]);
const STOP_WORDS=new Set(["the","and","for","with","that","this","from","into","when","where","what","which","while","your","trebell","code","make","need","should","would","could","have","has","had","are","was","were","will","fix","add","use","using","work","working"]);

function tokenEstimate(value){return Math.ceil(String(value||"").length/4)}
function slash(value){return String(value||"").split(sep).join("/")}
function boundedNumber(value,fallback,min,max){const number=Number(value);return Number.isFinite(number)?Math.max(min,Math.min(max,number)):fallback}
async function mapLimit(items,limit,worker){
  const values=Array.from(items||[]),results=new Array(values.length),size=Math.max(1,Math.min(values.length||1,Number(limit)||1));let cursor=0;
  await Promise.all(Array.from({length:size},async()=>{
    for(;;){const index=cursor++;if(index>=values.length)return;results[index]=await worker(values[index],index)}
  }));
  return results;
}
function indexablePath(path){
  const parts=slash(path).split("/").filter(Boolean);
  return parts.length>0&&!parts.some(part=>SKIP.has(part))&&!parts.includes("..");
}

function taskTerms(task){
  const expanded=String(task||"").replace(/([a-z0-9])([A-Z])/g,"$1 $2").toLowerCase();
  return [...new Set(expanded.split(/[^a-z0-9_$-]+/).map(term=>term.replace(/^[-_$]+|[-_$]+$/g,"")).filter(term=>term.length>=3&&!STOP_WORDS.has(term)))].slice(0,32);
}

function pathTokens(path){return new Set(String(path||"").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))}

function sourceDefinition(line,extension){
  const patterns=[];
  if([".js",".jsx",".ts",".tsx",".mjs",".cjs",".vue",".svelte"].includes(extension))patterns.push(
    [/(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/,"function"],
    [/(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)\b/,"class"],
    [/(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/,"interface"],
    [/(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/,"type"],
    [/(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/,"enum"],
    [/(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,"function"],
  );
  else if(extension===".py")patterns.push([/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\b/,"function"],[/^\s*class\s+([A-Za-z_]\w*)\b/,"class"]);
  else if(extension===".rs")patterns.push([/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\b/,"function"],[/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_]\w*)\b/,"type"]);
  else if(extension===".go")patterns.push([/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\b/,"function"],[/^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/,"type"]);
  else if([".java",".kt",".kts",".cs",".c",".h",".cc",".cpp",".cxx",".hpp",".hh",".swift"].includes(extension))patterns.push(
    [/\b(?:class|interface|enum|struct|protocol)\s+([A-Za-z_]\w*)\b/,"type"],
    [/^\s*(?:public|private|protected|internal|static|final|virtual|override|async|inline|constexpr|suspend|open|abstract|sealed|extern|unsafe|\s)+\s*[A-Za-z_][\w<>,?\[\]:*&.\s]*\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:\{|=>|$)/,"function"],
  );
  else patterns.push([/^\s*(?:def|function|class)\s+([A-Za-z_]\w*)\b/,"symbol"]);
  for(const [pattern,kind] of patterns){const match=line.match(pattern);if(match)return{name:match[1],kind}}
  return null;
}

function importSpecifiers(content,extension){
  const specs=[];
  if([".js",".jsx",".ts",".tsx",".mjs",".cjs",".vue",".svelte"].includes(extension)){
    const patterns=[/\b(?:import|export)\b[\s\S]{0,400}?\bfrom\s*["']([^"']+)["']/g,/\brequire\(\s*["']([^"']+)["']\s*\)/g,/\bimport\(\s*["']([^"']+)["']\s*\)/g];
    for(const pattern of patterns)for(const match of content.matchAll(pattern))specs.push(match[1]);
  }else if(extension===".py"){
    for(const match of content.matchAll(/^\s*from\s+([.\w]+)\s+import\s+/gm))specs.push(match[1]);
    for(const match of content.matchAll(/^\s*import\s+([.\w]+)/gm))specs.push(match[1]);
  }
  return [...new Set(specs)].slice(0,300);
}

function parseSource(content,relativePath){
  const extension=extname(relativePath).toLowerCase(),lines=String(content||"").split(/\r?\n/),definitions=[];
  for(let index=0;index<lines.length&&definitions.length<500;index++){
    const found=sourceDefinition(lines[index],extension);if(found)definitions.push({...found,line:index+1,signature:lines[index].trim().slice(0,300)});
  }
  const references=new Map();
  const identifiers=String(content||"").match(/[A-Za-z_$][\w$]{2,}/g)||[];
  for(const name of identifiers.slice(0,40_000))references.set(name,Math.min(50,(references.get(name)||0)+1));
  return {definitions,references,imports:importSpecifiers(content,extension)};
}

async function fallbackFiles(root){
  const files=[];
  async function walk(dir){
    let entries=[];try{entries=await readdir(dir,{withFileTypes:true})}catch{return}
    for(const entry of entries){
      if(SKIP.has(entry.name))continue;
      const full=join(dir,entry.name);if(entry.isDirectory())await walk(full);else if(entry.isFile())files.push(slash(relative(root,full)));
      if(files.length>=20_000)return;
    }
  }
  await walk(root);return files;
}

async function discoverFiles(root){
  try{
    const {stdout}=await execFileAsync("git",["-C",root,"ls-files","-co","--exclude-standard","-z"],{windowsHide:true,maxBuffer:32*1024*1024,timeout:15_000});
    return String(stdout||"").split("\0").filter(Boolean).map(slash).filter(indexablePath);
  }catch{return fallbackFiles(root)}
}

async function gitState(root){
  try{
    const [{stdout:status},{stdout:diff}]=await Promise.all([
      execFileAsync("git",["-C",root,"status","--short"],{windowsHide:true,maxBuffer:1024*1024,timeout:12_000}),
      execFileAsync("git",["-C",root,"diff","--no-ext-diff","--no-color","--unified=1"],{windowsHide:true,maxBuffer:2*1024*1024,timeout:15_000}),
    ]);
    const changed=new Set(String(status||"").split(/\r?\n/).filter(Boolean).map(line=>slash(line.slice(3).replace(/^.* -> /,""))));
    return {isGit:true,changed,status:String(status||"").slice(0,12_000),diff:String(diff||"").slice(0,16_000)};
  }catch{return {isGit:false,changed:new Set(),status:"",diff:""}}
}

async function localMetadata(root,paths){
  const pairs=await mapLimit(paths,64,async relativePath=>{
    try{
      const info=await stat(resolve(root,relativePath));
      return info.isFile()?[relativePath,{size:info.size,version:String(info.mtimeMs)}]:null;
    }catch{return null}
  });
  return new Map(pairs.filter(Boolean));
}

async function localReadMany(root,paths){
  const pairs=await mapLimit(paths,32,async relativePath=>{
    try{return [relativePath,await readFile(resolve(root,relativePath),"utf8")]}catch{return null}
  });
  return new Map(pairs.filter(Boolean));
}

function localContextIo(root){
  const absolute=resolve(root);
  return {
    cacheKey:"local:"+absolute,
    root:absolute,
    discoverFiles:()=>discoverFiles(absolute),
    metadata:paths=>localMetadata(absolute,paths),
    readMany:paths=>localReadMany(absolute,paths),
    readText:path=>readFile(resolve(absolute,path),"utf8"),
    gitState:()=>gitState(absolute),
    relativeFocus:path=>slash(relative(absolute,resolve(absolute,path))).replace(/^\.\//,""),
  };
}

function remoteInput(paths){return paths.map(path=>"./"+String(path||"").replace(/^\.\//,"")).join("\0")+"\0"}
function decodeBase64(value){try{return Buffer.from(String(value||""),"base64").toString("utf8")}catch{return ""}}

export function createRemoteContextIo({environments,environmentId,root}={}){
  if(!environments||!environmentId)throw new Error("Remote context requires an environment");
  const absolute=posix.normalize(String(root||"/"));
  const run=options=>environments.executeArgv(environmentId,options);
  const runInput=options=>environments.executeArgvInput(environmentId,options);
  const discoverFiles=async()=>{
    const git=await run({command:"git",args:["-C",absolute,"ls-files","-co","--exclude-standard","-z"],cwd:"",timeoutMs:20_000,maxOutput:16*1024*1024});
    if(git.exitCode===0)return String(git.stdout||"").split("\0").filter(Boolean).map(path=>path.replace(/\\/g,"/")).filter(indexablePath);
    const args=[".","(","-name",".git","-o","-name","node_modules","-o","-name","target","-o","-name","dist","-o","-name","build","-o","-name",".next","-o","-name",".cache","-o","-name","desktop-dist","-o","-name","coverage","-o","-name","vendor",")","-prune","-o","-type","f","-print0"];
    const found=await run({command:"find",args,cwd:absolute,timeoutMs:25_000,maxOutput:16*1024*1024});
    if(found.exitCode!==0)throw new Error(found.stderr||"Could not list remote workspace for context indexing");
    return String(found.stdout||"").split("\0").filter(Boolean).map(path=>path.replace(/^\.\//,"")).filter(indexablePath);
  };
  const metadata=async paths=>{
    if(!paths.length)return new Map();
    const script="while IFS= read -r -d '' f; do [ -f \"$f\" ] || continue; if m=$(stat -c '%s\\t%y' \"$f\" 2>/dev/null); then :; else m=$(stat -f '%z\\t%m' \"$f\" 2>/dev/null) || continue; fi; printf '%s\\t' \"$m\"; printf '%s' \"${f#./}\" | base64 | tr -d '\\r\\n'; printf '\\n'; done";
    const result=await runInput({command:"bash",args:["-lc",script],input:remoteInput(paths),cwd:absolute,timeoutMs:30_000,maxOutput:8*1024*1024});
    if(result.exitCode!==0)throw new Error(result.stderr||"Could not inspect remote workspace files");
    const entries=[];
    for(const line of String(result.stdout||"").split(/\r?\n/)){
      if(!line)continue;const parts=line.split("\t");if(parts.length<3)continue;
      const size=Number(parts[0]),encoded=parts.at(-1),relativePath=decodeBase64(encoded);
      if(!relativePath||!Number.isFinite(size))continue;
      entries.push([relativePath,{size,version:parts.slice(1,-1).join("\t")}]);
    }
    return new Map(entries);
  };
  const readMany=async paths=>{
    const output=new Map();
    const script="while IFS= read -r -d '' f; do [ -f \"$f\" ] || continue; printf '%s\\t' \"$(printf '%s' \"${f#./}\" | base64 | tr -d '\\r\\n')\"; base64 < \"$f\" | tr -d '\\r\\n'; printf '\\n'; done";
    for(let offset=0;offset<paths.length;offset+=16){
      const batch=paths.slice(offset,offset+16);
      const result=await runInput({command:"bash",args:["-lc",script],input:remoteInput(batch),cwd:absolute,timeoutMs:45_000,maxOutput:12*1024*1024});
      if(result.exitCode!==0)throw new Error(result.stderr||"Could not read remote workspace files");
      for(const line of String(result.stdout||"").split(/\r?\n/)){
        if(!line)continue;const tab=line.indexOf("\t");if(tab<1)continue;
        const relativePath=decodeBase64(line.slice(0,tab));if(relativePath)output.set(relativePath,decodeBase64(line.slice(tab+1)));
      }
    }
    return output;
  };
  const remoteGitState=async()=>{
    const [status,diff]=await Promise.all([
      run({command:"git",args:["-C",absolute,"status","--short"],cwd:"",timeoutMs:15_000,maxOutput:1024*1024}),
      run({command:"git",args:["-C",absolute,"diff","--no-ext-diff","--no-color","--unified=1"],cwd:"",timeoutMs:20_000,maxOutput:2*1024*1024}),
    ]);
    if(status.exitCode!==0)return {isGit:false,changed:new Set(),status:"",diff:""};
    const changed=new Set(String(status.stdout||"").split(/\r?\n/).filter(Boolean).map(line=>line.slice(3).replace(/^.* -> /,"").replace(/\\/g,"/")));
    return {isGit:true,changed,status:String(status.stdout||"").slice(0,12_000),diff:diff.exitCode===0?String(diff.stdout||"").slice(0,16_000):""};
  };
  return {
    cacheKey:"remote:"+environmentId+":"+absolute,
    root:absolute,
    discoverFiles,
    metadata,
    readMany,
    readText:async relativePath=>{
      const target=posix.join(absolute,String(relativePath||"").replace(/^\.\//,""));
      if(target!==absolute&&!target.startsWith(absolute.endsWith("/")?absolute:absolute+"/"))throw new Error("Context file is outside the remote workspace");
      const result=await run({command:"head",args:["-c","65536",target],cwd:"",timeoutMs:15_000,maxOutput:128*1024});
      if(result.exitCode!==0)throw new Error(result.stderr||"Could not read remote context file");
      return String(result.stdout||"");
    },
    gitState:remoteGitState,
    relativeFocus:path=>{
      const raw=String(path||"");const target=raw.startsWith("/")?posix.normalize(raw):posix.normalize(posix.join(absolute,raw));
      const rel=posix.relative(absolute,target);return rel.startsWith("../")||posix.isAbsolute(rel)?"":rel;
    },
  };
}

function resolveImport(fromPath,spec,available){
  if(!spec)return null;
  let base;
  if(spec.startsWith("."))base=slash(join(dirname(fromPath),spec));
  else if(extname(fromPath).toLowerCase()===".py"){
    if(spec.startsWith("."))base=slash(join(dirname(fromPath),spec.replace(/^\.+/,match=>"../".repeat(Math.max(0,match.length-1)))));else base=spec.split(".").join("/");
  }else return null;
  base=base.replace(/^\.\//,"").replace(/\\/g,"/");
  const candidates=[base,...RESOLVE_EXTENSIONS.map(extension=>base+extension),...RESOLVE_EXTENSIONS.map(extension=>base+"/index"+extension)];
  return candidates.find(candidate=>available.has(candidate))||null;
}

function addEdge(edges,from,to,weight){
  if(!from||!to||from===to)return;
  let row=edges.get(from);if(!row){row=new Map();edges.set(from,row)}
  row.set(to,(row.get(to)||0)+weight);
}

function pageRank(nodes,edges,personalization,iterations=24,damping=0.85){
  if(!nodes.length)return new Map();
  const size=nodes.length,uniform=1/size,totalPersonal=[...personalization.values()].reduce((sum,value)=>sum+value,0)||size;
  const teleport=new Map(nodes.map(node=>[node,(personalization.get(node)||1)/totalPersonal]));
  let rank=new Map(nodes.map(node=>[node,uniform]));
  for(let iteration=0;iteration<iterations;iteration++){
    const next=new Map(nodes.map(node=>[node,(1-damping)*(teleport.get(node)||uniform)]));let dangling=0;
    for(const node of nodes){
      const row=edges.get(node),value=rank.get(node)||0,total=row?[...row.values()].reduce((sum,weight)=>sum+weight,0):0;
      if(!total){dangling+=value;continue}
      for(const [target,weight] of row)next.set(target,(next.get(target)||0)+damping*value*weight/total);
    }
    if(dangling)for(const node of nodes)next.set(node,(next.get(node)||0)+damping*dangling*(teleport.get(node)||uniform));
    rank=next;
  }
  return rank;
}

function relevanceFor(entry,terms,changed,focusSet){
  let score=0;const reasons=[];const lowerPath=entry.relativePath.toLowerCase(),tokens=pathTokens(lowerPath),base=basename(lowerPath);
  const focused=[...focusSet].some(path=>path===entry.relativePath||path.endsWith("/"+entry.relativePath)||entry.relativePath.endsWith("/"+path));
  if(focused){score+=90;reasons.push("explicitly attached or focused")}
  if(changed.has(entry.relativePath)){score+=35;reasons.push("currently changed in Git")}
  const pathMatches=terms.filter(term=>lowerPath.includes(term)||tokens.has(term));if(pathMatches.length){score+=Math.min(40,pathMatches.length*12);reasons.push("path matches task: "+pathMatches.slice(0,3).join(", "))}
  const symbolMatches=entry.parsed.definitions.filter(definition=>terms.some(term=>definition.name.toLowerCase().includes(term))).slice(0,6);
  if(symbolMatches.length){score+=Math.min(55,symbolMatches.length*16);reasons.push("defines task-related symbol"+(symbolMatches.length>1?"s":"")+": "+symbolMatches.map(item=>item.name).join(", "))}
  const sample=entry.sample.toLowerCase();const contentMatches=terms.filter(term=>sample.includes(term));if(contentMatches.length){score+=Math.min(22,contentMatches.length*5);reasons.push("contains task terms: "+contentMatches.slice(0,3).join(", "))}
  if(/(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\./i.test(entry.relativePath)){score+=terms.some(term=>lowerPath.includes(term))?18:2;reasons.push("test file")}
  return {score,reasons,symbolMatches};
}

function relevantExcerpt(content,entry,terms,maxChars=2600){
  const lines=String(content||"").split(/\r?\n/),anchors=[];
  for(const definition of entry.parsed.definitions){if(terms.some(term=>definition.name.toLowerCase().includes(term)))anchors.push(definition.line-1)}
  if(!anchors.length&&terms.length){
    for(let index=0;index<lines.length&&anchors.length<4;index++)if(terms.some(term=>lines[index].toLowerCase().includes(term)))anchors.push(index);
  }
  if(!anchors.length)anchors.push(...entry.parsed.definitions.slice(0,4).map(item=>item.line-1));
  const wanted=new Set();for(const anchor of anchors.slice(0,5))for(let index=Math.max(0,anchor-2);index<=Math.min(lines.length-1,anchor+4);index++)wanted.add(index);
  const selected=[...wanted].sort((a,b)=>a-b);let output="",previous=-2;
  for(const index of selected){if(index>previous+1)output+="  ...\n";output+=String(index+1).padStart(5)+" | "+lines[index].slice(0,500)+"\n";previous=index;if(output.length>=maxChars)break}
  return output.slice(0,maxChars).trimEnd();
}

function publicItem(entry,score,centrality,reasons,tokenCost){
  return {path:entry.relativePath,score:Number(score.toFixed(3)),centrality:Number(centrality.toFixed(6)),reasons,symbols:entry.parsed.definitions.slice(0,16),tokenEstimate:tokenCost};
}

export function planContextBudget({task="",focusPaths=[],tokensUsed=null,contextWindow=null,maxTokens=null,maxFiles=null}={}){
  const text=String(task||"").trim(),terms=taskTerms(text),focusCount=Array.isArray(focusPaths)?focusPaths.length:0;
  const broadIntent=/\b(?:architecture|architectural|across|codebase|repo(?:sitory)?|refactor|redesign|migrate|parity|end[- ]to[- ]end|integrat(?:e|ion)|system[- ]wide|all files|everywhere)\b/i.test(text);
  let complexityScore=0;
  if(text.length>220)complexityScore++;if(text.length>700)complexityScore++;
  if(terms.length>14)complexityScore++;if(terms.length>24)complexityScore++;
  if(focusCount>=2)complexityScore++;if(focusCount>=5)complexityScore++;
  if(broadIntent)complexityScore++;
  const complexity=complexityScore<=1?"focused":complexityScore>=3?"broad":"normal";
  const defaults=complexity==="focused"?{maxTokens:2800,maxFiles:12}:complexity==="broad"?{maxTokens:7000,maxFiles:24}:{maxTokens:5200,maxFiles:20};
  const used=Number(tokensUsed),windowSize=Number(contextWindow);
  const utilization=Number.isFinite(used)&&used>=0&&Number.isFinite(windowSize)&&windowSize>0?Math.max(0,Math.min(1,used/windowSize)):null;
  const remainingTokens=utilization==null?null:Math.max(0,windowSize-used);
  const reserveTokens=utilization==null?null:Math.max(4000,Math.min(16_000,Math.round(windowSize*.08)));
  let pressure="normal",tokenCap=defaults.maxTokens,fileCap=defaults.maxFiles,reason=complexity==="focused"?"short/focused task":complexity==="broad"?"broad cross-file task":"normal repository task";
  if(utilization!=null&&utilization>=0.85){pressure="critical";tokenCap=Math.min(tokenCap,1600);fileCap=Math.min(fileCap,8);reason="context window is at least 85% full"}
  else if(utilization!=null&&utilization>=0.70){pressure="tight";tokenCap=Math.min(tokenCap,2800);fileCap=Math.min(fileCap,12);reason="context window is at least 70% full"}
  else if(utilization!=null&&utilization>=0.40){pressure="balanced";tokenCap=Math.min(tokenCap,4400);fileCap=Math.min(fileCap,18);reason="context window is at least 40% full"}
  const explicitTokens=maxTokens!=null&&String(maxTokens)!=="",explicitFiles=maxFiles!=null&&String(maxFiles)!=="";
  const callerSkip=explicitTokens&&Number(maxTokens)<=0;
  const skip=callerSkip||(remainingTokens!=null&&reserveTokens!=null&&remainingTokens<reserveTokens+800);
  if(skip){pressure="exhausted";reason=callerSkip?"caller requested no repository injection":"context window only has the response safety reserve left"}
  const requestedTokenCap=explicitTokens&&Number(maxTokens)>0?boundedNumber(maxTokens,tokenCap,800,20_000):null;
  const requestedFileCap=explicitFiles&&Number(maxFiles)>0?boundedNumber(maxFiles,fileCap,4,80):null;
  const plannedTokens=skip?0:Math.round(requestedTokenCap==null?tokenCap:Math.min(tokenCap,requestedTokenCap));
  const plannedFiles=skip?0:Math.round(requestedFileCap==null?fileCap:Math.min(fileCap,requestedFileCap));
  return {
    mode:pressure==="normal"?complexity:pressure,skip,
    complexity,
    pressure,
    maxTokens:plannedTokens,
    maxFiles:plannedFiles,
    utilization:utilization==null?null:Number(utilization.toFixed(4)),
    utilizationPercent:utilization==null?null:Math.round(utilization*100),
    remainingTokens:remainingTokens==null?null:Math.round(remainingTokens),
    reserveTokens:reserveTokens==null?null:Math.round(reserveTokens),
    reason,
    cappedByCaller:Boolean(!skip&&((requestedTokenCap!=null&&requestedTokenCap<tokenCap)||(requestedFileCap!=null&&requestedFileCap<fileCap))),
  };
}

export class ContextEngine{
  constructor({maxFileBytes=256_000}={}){this.maxFileBytes=maxFileBytes;this.roots=new Map()}

  async #index(root,contextIo,git){
    const started=Date.now(),io=contextIo||localContextIo(root),absolute=io.root,cacheKey=io.cacheKey||absolute;
    const paths=(await io.discoverFiles()).slice(0,20_000),previous=this.roots.get(cacheKey)||new Map(),next=new Map();let reparsed=0,reused=0,skipped=0;
    const sourcePaths=paths.filter(relativePath=>SOURCE_EXTENSIONS.has(extname(relativePath).toLowerCase()));
    const inspect=(!previous.size||!git?.isGit)
      ?sourcePaths
      :sourcePaths.filter(relativePath=>!previous.has(relativePath)||git.changed.has(relativePath));
    const inspectSet=new Set(inspect);
    const metadata=await io.metadata(inspect);
    const toRead=[];
    for(const relativePath of sourcePaths){
      const cached=previous.get(relativePath);
      if(cached&&!inspectSet.has(relativePath)){next.set(relativePath,cached);reused++;continue}
      const info=metadata.get(relativePath);
      if(!info||info.size>this.maxFileBytes){skipped++;continue}
      if(cached&&cached.size===info.size&&cached.version===info.version){next.set(relativePath,cached);reused++;continue}
      toRead.push(relativePath);
    }
    const contents=await io.readMany(toRead,this.maxFileBytes);
    for(const relativePath of toRead){
      const info=metadata.get(relativePath),content=contents.get(relativePath);
      if(!info||typeof content!=="string"||content.includes("\0")){skipped++;continue}
      next.set(relativePath,{relativePath,size:info.size,version:info.version,sample:content.slice(0,64_000),parsed:parseSource(content,relativePath)});reparsed++;
    }
    this.roots.set(cacheKey,next);
    return {root:absolute,files:next,paths,reparsed,reused,skipped,inspected:inspect.length,durationMs:Date.now()-started,cacheKey};
  }

  async buildPacket({root,task="",focusPaths=[],maxTokens=null,maxFiles=null,tokensUsed=null,contextWindow=null,io=null}={}){
    if(!root)throw new Error("Context Engine requires a workspace path");
    const contextIo=io||localContextIo(root);
    const budgetPlan=planContextBudget({task,focusPaths,tokensUsed,contextWindow,maxTokens,maxFiles});
    if(budgetPlan.skip)return {
      id:`ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`,
      root:contextIo.root,task:String(task||""),generatedAt:Date.now(),tokenEstimate:0,maxTokens:0,
      items:[],injection:"",budget:budgetPlan,skipped:true,
      stats:{filesIndexed:0,reparsed:0,reused:0,skipped:0,inspected:0,graphEdges:0,durationMs:0,remote:Boolean(io),skippedByPressure:true},
    };
    const budget=budgetPlan.maxTokens,fileLimit=budgetPlan.maxFiles;
    const git=await contextIo.gitState();
    const index=await this.#index(root,contextIo,git);const terms=taskTerms(task),files=[...index.files.values()],available=new Set(index.files.keys());
    const definitionIndex=new Map();for(const entry of files)for(const definition of entry.parsed.definitions){let owners=definitionIndex.get(definition.name);if(!owners){owners=[];definitionIndex.set(definition.name,owners)}owners.push(entry.relativePath)}
    const edges=new Map(),relevance=new Map(),personalization=new Map(),focusSet=new Set((focusPaths||[]).map(path=>contextIo.relativeFocus(path)).filter(Boolean));
    for(const entry of files){
      const rank=relevanceFor(entry,terms,git.changed,focusSet);relevance.set(entry.relativePath,rank);personalization.set(entry.relativePath,1+rank.score);
      for(const spec of entry.parsed.imports){const target=resolveImport(entry.relativePath,spec,available);if(target)addEdge(edges,entry.relativePath,target,4)}
      for(const [name,count] of entry.parsed.references){const owners=definitionIndex.get(name);if(!owners||owners.length>4)continue;for(const owner of owners)addEdge(edges,entry.relativePath,owner,Math.min(4,Math.sqrt(count)))}
    }
    const centrality=pageRank(files.map(entry=>entry.relativePath),edges,personalization);
    const ranked=files.map(entry=>{
      const rel=relevance.get(entry.relativePath),central=centrality.get(entry.relativePath)||0;
      const combined=rel.score+central*250;return {entry,rel,central,combined};
    }).sort((a,b)=>b.combined-a.combined||b.central-a.central||a.entry.relativePath.localeCompare(b.entry.relativePath));

    const header=`Trebell repository context\nTask: ${String(task||"").trim()||"(no task text supplied)"}\nSelection is deterministic and bounded. Read files/tools for full source before editing.`;
    const likelyPaths=new Set(ranked.slice(0,Math.max(fileLimit*2,16)).map(candidate=>candidate.entry.relativePath));
    const instructionPaths=index.paths.filter(path=>{
      if(!INSTRUCTION_NAMES.has(basename(path)))return false;
      const directory=slash(dirname(path));if(directory==="."||directory==="")return true;
      return [...likelyPaths].some(candidate=>candidate.startsWith(directory+"/"));
    }).slice(0,20);
    const sections=[];let used=tokenEstimate(header)+20;
    if(instructionPaths.length){
      let block="Repository instructions:\n";
      for(const path of instructionPaths){try{const content=(await contextIo.readText(path)).slice(0,5000);block+=`\n### ${path}\n${content.trim()}\n`}catch{}}
      const cost=tokenEstimate(block);if(cost<budget*.35){sections.push(block.trim());used+=cost}
    }
    if(git.status){const block=`Current Git status:\n${git.status.trim()}${git.diff?`\n\nCurrent diff excerpt:\n${git.diff.trim()}`:""}`;const clipped=block.slice(0,12_000),cost=tokenEstimate(clipped);if(used+cost<budget*.55){sections.push(clipped);used+=cost}}

    const candidatePaths=ranked.slice(0,Math.max(fileLimit*2,16)).map(candidate=>candidate.entry.relativePath);
    const candidateContents=await contextIo.readMany(candidatePaths,this.maxFileBytes);
    const selected=[];
    for(const candidate of ranked){
      if(selected.length>=fileLimit)break;
      const {entry,rel,central,combined}=candidate;if(combined<=0&&selected.length>=Math.min(6,fileLimit))break;
      let content=candidateContents.get(entry.relativePath);
      if(typeof content!=="string"){try{content=await contextIo.readText(entry.relativePath)}catch{continue}}
      const excerpt=relevantExcerpt(content,entry,terms),symbols=entry.parsed.definitions.slice(0,20).map(item=>`${item.kind} ${item.name} (L${item.line})`).join(", ");
      const reasons=[...rel.reasons];if(central>1/Math.max(1,files.length)*1.35)reasons.push("structurally central in repository graph");
      const block=`### ${entry.relativePath}\nWhy selected: ${reasons.join("; ")||"repository structure"}\n${symbols?`Key symbols: ${symbols}\n`:""}${excerpt?`Relevant structure/excerpt:\n${excerpt}`:""}`.trim();
      const cost=tokenEstimate(block);if(used+cost>budget)continue;
      sections.push(block);used+=cost;selected.push(publicItem(entry,combined,central,reasons,cost));
    }

    const injection=[header,...sections].join("\n\n").trim();
    return {
      id:`ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`,
      root:index.root,task:String(task||""),generatedAt:Date.now(),tokenEstimate:tokenEstimate(injection),maxTokens:budget,
      items:selected,injection,budget:budgetPlan,
      stats:{filesIndexed:files.length,reparsed:index.reparsed,reused:index.reused,skipped:index.skipped,inspected:index.inspected,graphEdges:[...edges.values()].reduce((sum,row)=>sum+row.size,0),durationMs:index.durationMs,remote:Boolean(io)},
    };
  }
}

export { pageRank, parseSource, taskTerms, tokenEstimate };
