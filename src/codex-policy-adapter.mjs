import { evaluatePolicy, POLICY_ALLOW, POLICY_CONFIRM, POLICY_REJECT } from "./policy-engine.mjs";

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

export function codexApprovalPolicyDecision(message,{profile="supervised",workspace=null,rules=[],provenance="unknown"}={}){
  if(!isCodexApprovalRequest(message))return null;
  const params=message.params||{},permissionEscalation=message.method==="item/permissions/requestApproval";
  return evaluatePolicy({
    profile,runtime:"codex",workspace,
    action:approvalAction(message),kind:approvalKind(message.method,params),rawInput:params,
    requestedPath:requestedPath(params),networkTarget:networkTarget(params),
    requestedPermissionEscalation:permissionEscalation,
    provenance:params?._meta?.provenance||params.provenance||provenance,
    externalSideEffect:params?._meta?.externalSideEffect,
    riskLevel:params?._meta?.riskLevel,reversibility:params?._meta?.reversibility,idempotent:params?._meta?.idempotent,
    rules,
  });
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
