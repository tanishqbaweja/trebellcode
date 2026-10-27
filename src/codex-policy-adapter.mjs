import { posix, win32 } from "node:path";
import { evaluatePolicy, policyPathInside, POLICY_ALLOW, POLICY_CONFIRM, POLICY_REJECT } from "./policy-engine.mjs";

const APPROVAL_METHODS=new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
]);

function commandText(value){
  if(Array.isArray(value))return value.map(String).join(" ");
  return String(value||"").trim();
}
function approvalKind(method,params={}){
  if(method==="item/fileChange/requestApproval"||method==="applyPatchApproval")return "edit";
  if(method==="item/commandExecution/requestApproval"||method==="execCommandApproval")return params.networkApprovalContext?"network":"execute";
  return "other";
}
function approvalAction(message){
  const params=message?.params||{},method=message?.method||"";
  return commandText(params.command)||String(params.reason||params.path||params.networkApprovalContext?.host||method);
}
function requestedPath(params={}){
  return params.path||params.filePath||params.file_path||params.cwd||null;
}
function networkTarget(params={}){
  const net=params.networkApprovalContext;if(!net)return params.url||null;
  return net.host?(String(net.protocol||"https")+"://"+String(net.host)):null;
}

export function isCodexApprovalRequest(message){return Boolean(message?.method&&Object.prototype.hasOwnProperty.call(message,"id")&&APPROVAL_METHODS.has(message.method))}

// The files a Codex file change touches, each {path, kind (add, delete or update), movePath}: a fileChange item's changes
// ([{path, kind:{type, move_path}}], from its item/started) or a legacy applyPatchApproval's fileChanges ({path: {type, move_path}}).
// Codex's v2 approval request names no file (T3 21cbec39d: "Modern approval requests omit paths").
export function codexFileChanges(changes){
  const entries=Array.isArray(changes)?changes.map(change=>[change?.path,change?.kind]):changes&&typeof changes==="object"?Object.entries(changes):[];
  return entries.filter(([path])=>typeof path==="string"&&path.trim()).map(([path,kind])=>({
    path,kind:String((typeof kind==="string"?kind:kind?.type)||"update").toLowerCase(),movePath:kind&&typeof kind==="object"&&kind.move_path?String(kind.move_path):null,
  }));
}

// A file as a person knows it: from the workspace when it is inside it, else as Codex named it.
export function workspaceFilePath(workspace,path){
  const root=String(workspace||"").trim(),file=String(path||"");if(!root||!file||!policyPathInside(root,file))return file;
  const api=/^[a-z]:[\\/]/i.test(root)?win32:posix,base=api.resolve(root);
  return api.relative(base,api.resolve(base,file))||file;
}

// files: the files a file change touches (codexFileChanges). Each is decided as the path asked for, a move's new path too: one
// rejected rejects the change, and one to confirm asks, the decision of a person's rule first (its rule), as "Allow session" never
// answers what a rule asks about.
export function codexApprovalPolicyDecision(message,{profile="supervised",workspace=null,rules=[],provenance="unknown",files=[]}={}){
  if(!isCodexApprovalRequest(message))return null;
  const params=message.params||{},permissionEscalation=message.method==="item/permissions/requestApproval";
  const decide=path=>evaluatePolicy({
    profile,runtime:"codex",workspace,
    action:approvalAction(message),kind:approvalKind(message.method,params),rawInput:params,
    requestedPath:path,networkTarget:networkTarget(params),
    requestedPermissionEscalation:permissionEscalation,
    provenance:params?._meta?.provenance||params.provenance||provenance,
    externalSideEffect:params?._meta?.externalSideEffect,
    riskLevel:params?._meta?.riskLevel,reversibility:params?._meta?.reversibility,idempotent:params?._meta?.idempotent,
    rules,
  });
  const paths=(Array.isArray(files)?files:[]).flatMap(file=>[file?.path,file?.movePath]).filter(Boolean);
  if(!paths.length)return decide(requestedPath(params));
  const decisions=paths.map(decide);
  return decisions.find(item=>item.decision===POLICY_REJECT)||decisions.find(item=>item.decision===POLICY_CONFIRM&&item.rule)||decisions.find(item=>item.decision===POLICY_CONFIRM)||decisions[0];
}

export function codexApprovalResponse(message,decision){
  const allow=decision===POLICY_ALLOW||decision==="ALLOW"||decision===true;
  const method=message?.method,params=message?.params||{};
  if(method==="item/permissions/requestApproval")return {permissions:allow?(params.permissions||{}):{},scope:"turn"};
  if(method==="applyPatchApproval"||method==="execCommandApproval")return {decision:allow?"approved":{denied:{rejection:"rejected by Trebell policy"}}};
  return {decision:allow?"accept":"decline"};
}

export function resolveCodexApprovalByPolicy(message,context={}){
  const policy=codexApprovalPolicyDecision(message,context);if(!policy||policy.decision===POLICY_CONFIRM)return {handled:false,policy};
  return {handled:true,policy,result:codexApprovalResponse(message,policy.decision)};
}

export { POLICY_ALLOW, POLICY_CONFIRM, POLICY_REJECT };
