import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
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
    return {changed,status:String(status||"").slice(0,12_000),diff:String(diff||"").slice(0,16_000)};
  }catch{return {changed:new Set(),status:"",diff:""}}
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

export class ContextEngine{
  constructor({maxFileBytes=256_000}={}){this.maxFileBytes=maxFileBytes;this.roots=new Map()}

  async #index(root){
    const started=Date.now(),absolute=resolve(root),paths=await discoverFiles(absolute),previous=this.roots.get(absolute)||new Map(),next=new Map();let reparsed=0,reused=0,skipped=0;
    for(const relativePath of paths.slice(0,20_000)){
      const extension=extname(relativePath).toLowerCase();if(!SOURCE_EXTENSIONS.has(extension)){continue}
      const full=resolve(absolute,relativePath);let info;try{info=await stat(full)}catch{continue}
      if(!info.isFile()||info.size>this.maxFileBytes){skipped++;continue}
      const cached=previous.get(relativePath);if(cached&&cached.size===info.size&&cached.mtimeMs===info.mtimeMs){next.set(relativePath,cached);reused++;continue}
      let content;try{content=await readFile(full,"utf8")}catch{skipped++;continue}
      if(content.includes("\0")){skipped++;continue}
      next.set(relativePath,{relativePath,full,size:info.size,mtimeMs:info.mtimeMs,sample:content.slice(0,64_000),parsed:parseSource(content,relativePath)});reparsed++;
    }
    this.roots.set(absolute,next);return {root:absolute,files:next,paths,reparsed,reused,skipped,durationMs:Date.now()-started};
  }

  async buildPacket({root,task="",focusPaths=[],maxTokens=7000,maxFiles=24}={}){
    if(!root)throw new Error("Context Engine requires a workspace path");
    const budget=Math.round(boundedNumber(maxTokens,7000,800,20_000)),fileLimit=Math.round(boundedNumber(maxFiles,24,4,80));
    const [index,git]=await Promise.all([this.#index(root),gitState(resolve(root))]);const terms=taskTerms(task),files=[...index.files.values()],available=new Set(index.files.keys());
    const definitionIndex=new Map();for(const entry of files)for(const definition of entry.parsed.definitions){let owners=definitionIndex.get(definition.name);if(!owners){owners=[];definitionIndex.set(definition.name,owners)}owners.push(entry.relativePath)}
    const edges=new Map(),relevance=new Map(),personalization=new Map(),focusSet=new Set((focusPaths||[]).map(path=>slash(relative(index.root,resolve(index.root,path))).replace(/^\.\//,"")));
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
      for(const path of instructionPaths){try{const content=(await readFile(resolve(index.root,path),"utf8")).slice(0,5000);block+=`\n### ${path}\n${content.trim()}\n`}catch{}}
      const cost=tokenEstimate(block);if(cost<budget*.35){sections.push(block.trim());used+=cost}
    }
    if(git.status){const block=`Current Git status:\n${git.status.trim()}${git.diff?`\n\nCurrent diff excerpt:\n${git.diff.trim()}`:""}`;const clipped=block.slice(0,12_000),cost=tokenEstimate(clipped);if(used+cost<budget*.55){sections.push(clipped);used+=cost}}

    const selected=[];
    for(const candidate of ranked){
      if(selected.length>=fileLimit)break;
      const {entry,rel,central,combined}=candidate;if(combined<=0&&selected.length>=Math.min(6,fileLimit))break;
      let content;try{content=await readFile(entry.full,"utf8")}catch{continue}
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
      items:selected,injection,
      stats:{filesIndexed:files.length,reparsed:index.reparsed,reused:index.reused,skipped:index.skipped,graphEdges:[...edges.values()].reduce((sum,row)=>sum+row.size,0),durationMs:index.durationMs},
    };
  }
}

export { pageRank, parseSource, taskTerms, tokenEstimate };
