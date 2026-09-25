import { evaluatePolicy, normalizePolicyKind, normalizePolicyProfile, POLICY_ALLOW, POLICY_REJECT } from "./policy-engine.mjs";

export function normalizePermissionMode(value){
  const profile=normalizePolicyProfile(value);
  if(profile==="workspace-write")return "edits";
  if(profile==="isolated-environment")return "auto";
  return profile;
}

export function normalizePermissionKind(value){
  return normalizePolicyKind(value);
}

export function permissionDisposition(mode,kind,{readOnlyAllowsRead=true,...policyInput}={}){
  const profile=normalizePermissionMode(mode),action=normalizePermissionKind(kind);
  if(profile==="read-only"&&action==="read"&&!readOnlyAllowsRead)return "deny";
  const decision=evaluatePolicy({profile,kind:action,...policyInput}).decision;
  return decision===POLICY_ALLOW?"allow":decision===POLICY_REJECT?"deny":"ask";
}
