import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve,relative,isAbsolute,sep } from "node:path";

const execFileAsync=promisify(execFile);
const CATEGORIES=new Set(["architecture","convention","command","deployment","auth","data-flow","entry-point","terminology","failure-mode","decision","other"]);
const STATUSES=new Set(["verified","stale","unverified"]);

function text(value,max=4000){return String(value??"").trim().slice(0,max)}
function confidence(value){
  const number=Number(value);return Number.isFinite(number)?Math.max(0,Math.min(1,number)):null;
}
function normalizeEvidenceItem(item={}){
  const path=text(item.path,1200);if(!path)return null;
  return {
    path:path.replace(/\\/g,"/"),
    symbol:text(item.symbol,500)||null,
    fingerprint:text(item.fingerprint,128)||null,
    missing:Boolean(item.missing),
  };
}

export function normalizeRepositoryKnowledge(entry={},previous=null,now=Date.now()){
  const prior=previous&&typeof previous==="object"?previous:{};
  const fact=text(entry.fact??prior.fact,8000);if(!fact)throw new Error("Repository knowledge fact is required.");
  const projectPath=text(entry.projectPath??prior.projectPath,4000);if(!projectPath)throw new Error("Repository knowledge projectPath is required.");
  const category=CATEGORIES.has(String(entry.category||prior.category))?String(entry.category||prior.category):"other";
  const status=STATUSES.has(String(entry.status||prior.status))?String(entry.status||prior.status):"unverified";
  const evidence=Array.isArray(entry.evidence)?entry.evidence:Array.isArray(prior.evidence)?prior.evidence:[];
  return {
    id:text(entry.id??prior.id,300)||null,
    projectPath,
    environmentId:(entry.environmentId??prior.environmentId??null)==null?null:text(entry.environmentId??prior.environmentId,300)||null,
    category,
    fact,
    scope:text(entry.scope??prior.scope,1000)||"repository",
    source:text(entry.source??prior.source,120)||"explicit",
    confidence:confidence(entry.confidence??prior.confidence),
    status,
    evidence:evidence.map(normalizeEvidenceItem).filter(Boolean).slice(0,80),
    lastVerifiedRevision:text(entry.lastVerifiedRevision??prior.lastVerifiedRevision,200)||null,
    staleReason:text(entry.staleReason??prior.staleReason,2000)||null,
    createdAt:Number(prior.createdAt)||Number(entry.createdAt)||now,
    updatedAt:now,
    verifiedAt:entry.verifiedAt==null?(Number(prior.verifiedAt)||null):(Number(entry.verifiedAt)||null),
  };
}

function hash(content){return createHash("sha256").update(content).digest("hex")}
function safeRelative(root,path){
  const absolute=isAbsolute(path)?resolve(path):resolve(root,path),rel=relative(resolve(root),absolute);
  if(rel.startsWith(".."+sep)||rel===".."||isAbsolute(rel))throw new Error("Knowledge evidence path must stay inside the repository.");
  return rel.replace(/\\/g,"/");
}

async function localGitState(root){
  try{
    const {stdout}=await execFileAsync("git",["-C",root,"rev-parse","HEAD"],{windowsHide:true,maxBuffer:128*1024,timeout:10_000});
    return {head:String(stdout||"").trim()||null};
  }catch{return {head:null}}
}

async function localReadMany(root,paths){
  const out=new Map();
  for(const path of paths){
    try{
      const value=await readFile(resolve(root,path));out.set(path,value);
    }catch{}
  }
  return out;
}

export async function captureRepositoryKnowledgeEvidence({root,evidence=[],io=null}={}){
  const base=resolve(String(root||""));if(!base)throw new Error("Repository root is required.");
  const normalized=(Array.isArray(evidence)?evidence:[]).map(normalizeEvidenceItem).filter(Boolean).slice(0,80).map(item=>({...item,path:safeRelative(base,item.path)}));
  const paths=[...new Set(normalized.map(item=>item.path))];
  const gitState=io?.remoteGitState?await io.remoteGitState():await localGitState(base);
  const contents=io?.readMany?await io.readMany(paths):await localReadMany(base,paths);
  const fingerprints=new Map();
  for(const path of paths){
    const content=contents.get(path);
    if(content==null)fingerprints.set(path,null);
    else fingerprints.set(path,hash(Buffer.isBuffer(content)?content:Buffer.from(String(content))));
  }
  return {
    revision:gitState?.head||null,
    evidence:normalized.map(item=>{
      const fingerprint=fingerprints.get(item.path)||null;
      return {...item,fingerprint,missing:!fingerprint};
    }),
  };
}

export function assessRepositoryKnowledgeFreshness(entry,current){
  const stored=Array.isArray(entry?.evidence)?entry.evidence:[],latest=Array.isArray(current?.evidence)?current.evidence:[];
  if(!stored.length)return {status:"unverified",stale:false,reason:"No supporting evidence was recorded."};
  const byPath=new Map(latest.map(item=>[item.path,item]));
  const changed=[],missing=[];
  for(const evidence of stored){
    const now=byPath.get(evidence.path);
    if(!now||now.missing||!now.fingerprint){missing.push(evidence.path);continue}
    if(!evidence.fingerprint||now.fingerprint!==evidence.fingerprint)changed.push(evidence.path);
  }
  if(missing.length||changed.length){
    const pieces=[];if(changed.length)pieces.push("changed: "+changed.join(", "));if(missing.length)pieces.push("missing: "+missing.join(", "));
    return {status:"stale",stale:true,reason:"Supporting evidence changed ("+pieces.join("; ")+").",changed,missing};
  }
  return {status:"verified",stale:false,reason:"Supporting evidence still matches.",changed:[],missing:[]};
}

export async function refreshRepositoryKnowledgeEntry(entry,{root,io=null,now=Date.now()}={}){
  const captured=await captureRepositoryKnowledgeEvidence({root:root||entry.projectPath,evidence:entry.evidence,io});
  const assessment=assessRepositoryKnowledgeFreshness(entry,captured);
  return normalizeRepositoryKnowledge({
    ...entry,
    status:assessment.status,
    lastVerifiedRevision:captured.revision||entry.lastVerifiedRevision||null,
    staleReason:assessment.stale?assessment.reason:null,
    verifiedAt:assessment.status==="verified"?now:entry.verifiedAt,
  },entry,now);
}

export async function verifyRepositoryKnowledgeEntry(entry,{root,io=null,now=Date.now()}={}){
  const captured=await captureRepositoryKnowledgeEvidence({root:root||entry.projectPath,evidence:entry.evidence,io});
  const hasMissing=captured.evidence.some(item=>item.missing);
  return normalizeRepositoryKnowledge({
    ...entry,
    evidence:captured.evidence,
    status:hasMissing?"unverified":"verified",
    lastVerifiedRevision:captured.revision,
    staleReason:hasMissing?"One or more supporting evidence files could not be read.":null,
    verifiedAt:hasMissing?null:now,
  },entry,now);
}

export function repositoryKnowledgeContext(entries=[],{limit=20}={}){
  const selected=(Array.isArray(entries)?entries:[]).filter(item=>item?.status!=="stale").slice(0,Math.max(1,Math.min(100,Number(limit)||20)));
  if(!selected.length)return "";
  const lines=[
    "Durable Trebell repository knowledge",
    "These are saved repository facts. Verified facts still match their recorded evidence; unverified facts may lack supporting evidence. Stale facts are omitted. Inspect source when a fact is important to the current change.",
  ];
  for(const item of selected){
    const evidence=(item.evidence||[]).map(source=>source.path+(source.symbol?"#"+source.symbol:"")).slice(0,5).join(", ");
    lines.push("- ["+item.category+"] "+item.fact+" · status: "+(item.status||"unverified")+(item.scope?" · scope: "+item.scope:"")+(evidence?" · evidence: "+evidence:"")+(item.lastVerifiedRevision?" · verified revision: "+item.lastVerifiedRevision.slice(0,12):""));
  }
  return lines.join("\n").slice(0,16_000);
}

function tokens(value){
  return new Set(String(value||"").toLowerCase().match(/[a-z0-9_.-]{2,}/g)||[]);
}
export function selectRepositoryKnowledge(entries=[],{query="",limit=20,includeUnverified=true,includeStale=false}={}){
  const wanted=tokens(query),cap=Math.max(1,Math.min(100,Number(limit)||20));
  return (Array.isArray(entries)?entries:[])
    .filter(item=>(includeStale||item?.status!=="stale")&&(includeUnverified||item?.status==="verified"))
    .map((item,index)=>{
      const hay=tokens([item.category,item.scope,item.fact,...(item.evidence||[]).flatMap(evidence=>[evidence.path,evidence.symbol])].filter(Boolean).join(" "));
      let overlap=0;for(const token of wanted)if(hay.has(token))overlap++;
      const statusScore=item.status==="verified"?3:1,confidenceScore=item.confidence==null?0:Number(item.confidence)*2,recency=Math.min(2,Math.max(0,(Number(item.updatedAt)||0)/1e15));
      return {item,index,score:wanted.size?overlap*10+statusScore+confidenceScore:statusScore+confidenceScore+recency};
    })
    .sort((a,b)=>b.score-a.score||Number(b.item.updatedAt||0)-Number(a.item.updatedAt||0)||a.index-b.index)
    .slice(0,cap)
    .map(entry=>entry.item);
}
