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

// Why the access level refused a call unasked, in the person's words, by the reason policy-engine.mjs gave, or null for any other
// reason (input a tool does not take, a tool the thread does not have): the call's row then says it was not allowed and why, rather
// than that it failed.
const NOT_ALLOWED_WORDS=new Map([
  ["Read Only profile rejects mutating or executable actions.","Read only does not allow changes or commands."],
  ["Read Only profile rejects external side effects.","Read only does not allow actions that reach outside this computer."],
  ["Read Only profile rejects permission escalation.","Read only does not allow more access than it gives."],
  ["Requested path is outside the active workspace boundary.","it is outside the project folder, which this access level does not allow."],
  ["This Trebell tool requires Full Access mode.","only Full access allows it."],
  ["Untrusted work cannot silently escalate permissions.","work from an untrusted source cannot take more access."],
  ["Matched an explicit user policy rule.","a rule in your settings does not allow it."],
]);
export function notAllowedWords(reason){
  const said=String(reason||"").trim();
  return NOT_ALLOWED_WORDS.get(said)||(said.startsWith("Auto/Guarded rejects ")?"Auto does not allow a risky action that cannot be undone.":null);
}
// permissionDisposition's refusal in the person's words: why the access level refuses the call (deny), or null when it does not.
export function permissionRefusalWords(mode,kind,{readOnlyAllowsRead=true,...policyInput}={}){
  const profile=normalizePermissionMode(mode),action=normalizePermissionKind(kind);
  if(profile==="read-only"&&action==="read"&&!readOnlyAllowsRead)return "Read only does not allow it.";
  const result=evaluatePolicy({profile,kind:action,...policyInput});
  return result.decision===POLICY_REJECT?notAllowedWords(result.reason)||"this access level does not allow it.":null;
}
