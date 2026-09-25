export const REMOTE_SCOPES=Object.freeze([
  "status","threads:read","threads:write","approvals","environments:read","environments:execute",
]);
export const DEFAULT_REMOTE_SCOPES=REMOTE_SCOPES;
const KNOWN=new Set(REMOTE_SCOPES);

export function normalizeRemoteScopes(value,{fallback=DEFAULT_REMOTE_SCOPES}={}){
  const source=Array.isArray(value)?value:fallback,out=[];
  for(const item of source||[]){
    const scope=String(item||"").trim();if(!KNOWN.has(scope)||out.includes(scope))continue;out.push(scope);
  }
  return out;
}
export function hasRemoteScope(session,scope){return Boolean(session&&normalizeRemoteScopes(session.scopes).includes(scope))}

const READ_RPC=new Set([
  "thread/list","thread/read","thread/resume","thread/items/list","thread/turns/list","thread/searchOccurrences",
  "thread/attachment/list","thread/queue/list","thread/timeline/list","thread/goal/get","thread/continuity/get",
  "thread/verification/get","thread/runtimeInstances/list","collaborationMode/list","skills/list",
]);
const HANDSHAKE_RPC=new Set(["initialize","initialized"]);

export function remoteRpcScope(method){
  const name=String(method||"");
  if(HANDSHAKE_RPC.has(name))return null;
  if(READ_RPC.has(name))return "threads:read";
  if(name.startsWith("thread/")||name.startsWith("turn/")||name.startsWith("review/")||name.startsWith("collaborationMode/"))return "threads:write";
  return false;
}

export function remoteServerRequestScope(method){
  const name=String(method||"");
  if(/requestApproval|Approval$/i.test(name)||name==="mcpServer/elicitation/request")return "approvals";
  if(name==="item/tool/requestUserInput")return "threads:write";
  return false;
}

export function remoteDeniedServerResult(method){
  const name=String(method||"");
  if(name==="item/permissions/requestApproval")return {permissions:{},scope:"turn"};
  if(name==="mcpServer/elicitation/request")return {action:"cancel",content:null,_meta:null};
  if(name==="item/tool/requestUserInput")return {answers:{}};
  return {decision:"decline"};
}
