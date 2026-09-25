const MODES=new Set(["supervised","edits","auto","full","read-only"]);
const KINDS=new Set(["read","edit","execute","fetch","network","other"]);

export function normalizePermissionMode(value){
  const mode=String(value||"supervised").trim().toLowerCase();
  return MODES.has(mode)?mode:"supervised";
}

export function normalizePermissionKind(value){
  const kind=String(value||"").trim().toLowerCase();
  if(["edit","write","file_write","file-write","workspace_write","workspace-write"].includes(kind))return "edit";
  if(["read","readonly","read_only","read-only"].includes(kind))return "read";
  if(["execute","exec","bash","shell","terminal","command"].includes(kind))return "execute";
  if(["fetch","web","webfetch","web_fetch"].includes(kind))return "fetch";
  if(["network","http","https"].includes(kind))return "network";
  return KINDS.has(kind)?kind:"other";
}

export function permissionDisposition(mode,kind,{readOnlyAllowsRead=true}={}){
  const profile=normalizePermissionMode(mode),action=normalizePermissionKind(kind);
  if(profile==="full"||profile==="auto")return "allow";
  if(profile==="edits")return action==="edit"?"allow":"ask";
  if(profile==="read-only")return readOnlyAllowsRead&&action==="read"?"allow":"deny";
  return "ask";
}
