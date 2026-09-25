import { posix, win32 } from "node:path";

export const POLICY_ALLOW="ALLOW";
export const POLICY_CONFIRM="CONFIRM";
export const POLICY_REJECT="REJECT";

const PROFILES=new Set(["read-only","workspace-write","supervised","auto","full","isolated-environment"]);
const KINDS=new Set(["read","edit","execute","fetch","network","other"]);
const RISKS=new Set(["low","medium","high","critical"]);
const REVERSIBILITY=new Set(["not-applicable","full","partial","none"]);
const RISK_RANK={low:0,medium:1,high:2,critical:3};

export function normalizePolicyProfile(value){
  const profile=String(value||"supervised").trim().toLowerCase();
  if(["read","readonly","read_only"].includes(profile))return "read-only";
  if(["write","workspace","workspace_write","workspace-write","edits"].includes(profile))return "workspace-write";
  if(["guarded","auto-guarded","auto_guarded"].includes(profile))return "auto";
  if(["full-access","full_access"].includes(profile))return "full";
  if(["isolated","sandboxed","isolated_environment"].includes(profile))return "isolated-environment";
  return PROFILES.has(profile)?profile:"supervised";
}

export function normalizePolicyKind(value){
  const kind=String(value||"").trim().toLowerCase();
  if(["edit","write","file_write","file-write","workspace_write","workspace-write","patch"].includes(kind))return "edit";
  if(["read","readonly","read_only","read-only","glob","grep","search","list"].includes(kind))return "read";
  if(["execute","exec","bash","shell","terminal","command","process"].includes(kind))return "execute";
  if(["fetch","web","webfetch","web_fetch","browse"].includes(kind))return "fetch";
  if(["network","http","https","socket"].includes(kind))return "network";
  return KINDS.has(kind)?kind:"other";
}

function enumValue(value,allowed,fallback){const text=String(value??fallback).toLowerCase();return allowed.has(text)?text:fallback}
function normalizedPath(value){
  let path=String(value||"").trim().replace(/\\/g,"/").replace(/[/]{2,}/g,"/");if(!path)return "";
  path=posix.normalize(path);
  if(/^[a-z]:[/]/i.test(path))path=path[0].toLowerCase()+path.slice(1);
  return path.length>1?path.replace(/[/]+$/,""):path;
}
function pathPrefixMatches(path,prefix){
  const candidate=normalizedPath(path),root=normalizedPath(prefix);if(!candidate||!root)return false;
  const insensitive=/^[a-z]:[/]/i.test(candidate)&&/^[a-z]:[/]/i.test(root);
  const child=insensitive?candidate.toLowerCase():candidate,parent=insensitive?root.toLowerCase():root;
  return child===parent||child.startsWith(parent+"/");
}
export function policyPathInside(workspace,path){
  const rootText=String(workspace||"").trim(),candidateText=String(path||"").trim();if(!rootText||!candidateText)return null;
  const windows=/^[a-z]:[\\/]/i.test(rootText);
  const pathApi=windows?win32:rootText.startsWith("/")?posix:null;
  if(!pathApi)return null;
  const root=pathApi.resolve(rootText),candidate=pathApi.resolve(root,candidateText),relative=pathApi.relative(root,candidate);
  if(!relative)return true;
  return relative!==".."&&!relative.startsWith(".."+pathApi.sep)&&!pathApi.isAbsolute(relative);
}
function hostOf(value){
  const text=String(value||"").trim();if(!text)return "";
  try{return new URL(text.includes("://")?text:"https://"+text).hostname.toLowerCase()}catch{return text.toLowerCase().split(/[/:]/)[0]}
}
function inferPath(raw={}){
  for(const key of ["path","filePath","file_path","targetPath","target_path","cwd"]){if(raw?.[key])return String(raw[key])}
  return null;
}
function inferNetwork(raw={}){
  for(const key of ["url","uri","href","host","hostname","endpoint"]){if(raw?.[key])return String(raw[key])}
  return null;
}
function actionText(input={}){
  return String(input.action||input.tool||input.toolCall?.title||input.toolCall?.toolName||"").trim().slice(0,500);
}

export function classifyPolicyAction(input={}){
  const raw=input.rawInput||input.toolCall?.rawInput||input.toolCall?.arguments||{};
  const kind=normalizePolicyKind(input.kind||input.toolCall?.kind||input.permissionKind);
  let action=actionText(input);
  if(kind==="execute"&&raw?.command){
    const command=[Array.isArray(raw.command)?raw.command.map(String).join(" "):String(raw.command),...(Array.isArray(raw.args)?raw.args.map(String):[])].join(" ").trim();
    if(command&&!action.toLowerCase().includes(command.toLowerCase()))action=(action+" "+command).trim().slice(0,500);
  }
  const lower=action.toLowerCase();
  let risk=kind==="read"||kind==="fetch"?"low":kind==="edit"||kind==="execute"||kind==="network"?"medium":"medium";
  let reversibility=kind==="read"||kind==="fetch"?"not-applicable":kind==="edit"?"full":"partial";
  let idempotent=kind==="read"||kind==="fetch";
  let externalSideEffect=false;
  const externalTerms=["git push","publish","deploy","release","send","message","merge","create pull","create pr","upload"];
  if(externalTerms.some(term=>lower.includes(term))||lower==="push"||lower.startsWith("push ")){externalSideEffect=true;risk="high";reversibility="none";idempotent=false}
  const criticalTerms=["rm -rf","drop database","drop table","format disk","delete repository","destroy"];
  if(criticalTerms.some(term=>lower.includes(term))){risk="critical";reversibility="none";idempotent=false}
  const destructiveTerms=["delete","remove","reset --hard","force push"];
  if(destructiveTerms.some(term=>lower.includes(term))&&risk!=="critical"){risk="high";reversibility="partial";idempotent=false}
  const requestedPath=input.requestedPath||input.path||inferPath(raw),networkTarget=input.networkTarget||inferNetwork(raw);
  const explicitRisk=input.riskLevel||input.risk,explicitReversibility=input.reversibility;
  if(explicitRisk!=null)risk=enumValue(explicitRisk,RISKS,risk);
  if(explicitReversibility!=null)reversibility=enumValue(explicitReversibility,REVERSIBILITY,reversibility);
  if(input.idempotent!=null)idempotent=Boolean(input.idempotent);
  if(input.externalSideEffect!=null||input.externalSideEffects!=null)externalSideEffect=Boolean(input.externalSideEffect??input.externalSideEffects);
  const provenance=String(input.provenance||input.trust||"unknown").trim().toLowerCase()||"unknown";
  return {
    runtime:String(input.runtime||"").trim().toLowerCase()||null,action:action||kind,kind,
    requestedPath:requestedPath?String(requestedPath):null,workspace:input.workspace?String(input.workspace):null,
    pathInsideWorkspace:input.pathInsideWorkspace==null?policyPathInside(input.workspace,requestedPath):Boolean(input.pathInsideWorkspace),
    networkTarget:networkTarget?String(networkTarget):null,networkHost:hostOf(networkTarget),
    externalSideEffect,riskLevel:risk,reversibility,idempotent,provenance,
    environmentType:String(input.environmentType||"").trim().toLowerCase()||null,
    environmentIsolated:Boolean(input.environmentIsolated),
    requestedPermissionEscalation:Boolean(input.requestedPermissionEscalation),
    metadataKnown:Boolean(
      input.riskLevel!=null||input.risk!=null||input.reversibility!=null||input.idempotent!=null||
      input.externalSideEffect!=null||input.externalSideEffects!=null||requestedPath||networkTarget||
      input.provenance||input.trust||input.requestedPermissionEscalation
    ),
  };
}

function effect(value){
  const text=String(value||"").trim().toUpperCase();
  if(text==="ALLOW")return POLICY_ALLOW;if(text==="REJECT"||text==="DENY")return POLICY_REJECT;if(text==="CONFIRM"||text==="ASK")return POLICY_CONFIRM;return null;
}
function valueMatches(actual,wanted){
  if(Array.isArray(wanted))return wanted.map(String).includes(String(actual));
  return String(actual)===String(wanted);
}
function ruleMatches(rule,action){
  if(!rule||typeof rule!=="object")return false;
  if(rule.runtime!=null&&!valueMatches(action.runtime,rule.runtime))return false;
  if(rule.kind!=null&&!valueMatches(action.kind,rule.kind))return false;
  if(rule.action!=null&&!valueMatches(action.action,rule.action))return false;
  if(rule.actionPrefix!=null&&!String(action.action||"").toLowerCase().startsWith(String(rule.actionPrefix).toLowerCase()))return false;
  if(rule.pathPrefix!=null&&!pathPrefixMatches(action.requestedPath,rule.pathPrefix))return false;
  if(rule.networkHost!=null&&!valueMatches(action.networkHost,rule.networkHost))return false;
  if(rule.externalSideEffect!=null&&Boolean(rule.externalSideEffect)!==action.externalSideEffect)return false;
  if(rule.provenance!=null&&!valueMatches(action.provenance,rule.provenance))return false;
  if(rule.riskAtLeast!=null&&RISK_RANK[action.riskLevel]<(RISK_RANK[enumValue(rule.riskAtLeast,RISKS,"low")]??0))return false;
  return true;
}

function result(decision,reason,{profile,action,rule=null}={}){return {decision,reason,profile,action,rule}}

export function evaluatePolicy(input={}){
  const profile=normalizePolicyProfile(input.profile||input.permissionProfile||input.mode),action=classifyPolicyAction(input);
  if(profile==="read-only"&&action.requestedPermissionEscalation)return result(POLICY_REJECT,"Read Only profile rejects permission escalation.",{profile,action});
  if(profile!=="full"&&action.requestedPermissionEscalation&&action.provenance==="untrusted")return result(POLICY_REJECT,"Untrusted work cannot silently escalate permissions.",{profile,action});
  if(profile!=="full"&&action.pathInsideWorkspace===false&&["read","edit","execute"].includes(action.kind))return result(POLICY_REJECT,"Requested path is outside the active workspace boundary.",{profile,action});
  if(profile==="read-only"&&!["read","fetch"].includes(action.kind))return result(POLICY_REJECT,"Read Only profile rejects mutating or executable actions.",{profile,action});
  if(profile==="read-only"&&action.externalSideEffect)return result(POLICY_REJECT,"Read Only profile rejects external side effects.",{profile,action});

  for(const rule of Array.isArray(input.rules)?input.rules:[]){
    if(!ruleMatches(rule,action))continue;
    const decision=effect(rule.effect||rule.decision);if(decision)return result(decision,rule.reason||"Matched an explicit user policy rule.",{profile,action,rule});
  }

  if(profile==="full")return result(POLICY_ALLOW,"Full Access profile allows this action.",{profile,action});
  if(action.requestedPermissionEscalation)return result(POLICY_CONFIRM,"Permission escalation requires explicit confirmation.",{profile,action});
  if(profile==="read-only")return result(POLICY_ALLOW,"Read Only profile allows this non-mutating read.",{profile,action});
  if(profile==="workspace-write"){
    if(action.kind==="edit"&&!action.externalSideEffect&&RISK_RANK[action.riskLevel]<=RISK_RANK.medium)return result(POLICY_ALLOW,"Workspace Write allows bounded local edits.",{profile,action});
    return result(POLICY_CONFIRM,"Workspace Write requires confirmation for execution, network, external, or high-risk actions.",{profile,action});
  }
  if(profile==="isolated-environment"){
    if(!action.environmentIsolated)return result(POLICY_CONFIRM,"Isolated Environment profile requires a confirmed isolated runtime boundary.",{profile,action});
    if(action.externalSideEffect||RISK_RANK[action.riskLevel]>=RISK_RANK.high)return result(POLICY_CONFIRM,"External or high-risk actions still require confirmation inside isolation.",{profile,action});
    return result(POLICY_ALLOW,"Action is bounded by an isolated environment.",{profile,action});
  }
  if(profile==="auto"){
    if(action.riskLevel==="critical"&&(action.provenance==="untrusted"||action.externalSideEffect||action.reversibility==="none"))return result(POLICY_REJECT,"Auto/Guarded rejects critical untrusted or irreversible external actions.",{profile,action});
    if(action.metadataKnown&&(action.externalSideEffect||RISK_RANK[action.riskLevel]>=RISK_RANK.high||action.reversibility==="none"||action.requestedPermissionEscalation))return result(POLICY_CONFIRM,"Auto/Guarded requires confirmation for high-risk, irreversible, external, or escalating actions.",{profile,action});
    return result(POLICY_ALLOW,"Auto/Guarded allows actions without known elevated risk.",{profile,action});
  }
  return result(POLICY_CONFIRM,"Supervised profile requires confirmation.",{profile,action});
}
