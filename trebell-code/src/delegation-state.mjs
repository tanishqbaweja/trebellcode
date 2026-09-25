const PERMISSIONS=new Set(["inherit","read-only","workspace-write","supervised","full"]);
const ISOLATIONS=new Set(["auto","inherit","shared","worktree"]);

function positiveInteger(value,{max=1_000_000}={}){
  if(value==null||value==="")return null;
  const number=Number(value);if(!Number.isInteger(number)||number<=0)throw new Error("Delegation budget values must be positive whole numbers");
  return Math.min(max,number);
}
function positiveNumber(value,{max=1_000_000}={}){
  if(value==null||value==="")return null;
  const number=Number(value);if(!Number.isFinite(number)||number<=0)throw new Error("Delegation cost budget must be a positive number");
  return Math.min(max,number);
}
function boundedText(value,max){return String(value??"").trim().slice(0,max)}
function budget(raw={}){
  const value=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw:{};
  return {
    tokenBudget:positiveInteger(value.tokenBudget,{max:1_000_000_000}),
    timeBudgetMinutes:positiveInteger(value.timeBudgetMinutes,{max:525_600}),
    turnBudget:positiveInteger(value.turnBudget,{max:500}),
    toolCallBudget:positiveInteger(value.toolCallBudget,{max:1000}),
    childAgentBudget:positiveInteger(value.childAgentBudget,{max:100}),
    costBudgetUsd:positiveNumber(value.costBudgetUsd),
  };
}

export function normalizeDelegationRequest(input={}){
  const task=boundedText(input.task,8000);if(!task)throw new Error("Delegation task is required");
  const requestedPermission=String(input.permissions??input.permission??"inherit");
  const permission=PERMISSIONS.has(requestedPermission)?requestedPermission:"inherit";
  const permissions=permission==="inherit"?"supervised":permission;
  const requestedIsolation=String(input.isolation||"auto"),isolationValue=ISOLATIONS.has(requestedIsolation)?requestedIsolation:"auto";
  const isolation=["shared","inherit"].includes(isolationValue)?"inherit":"worktree";
  const ownership=Array.isArray(input.ownership)?input.ownership.map(item=>boundedText(item,500)).filter(Boolean).slice(0,50):[];
  return {
    task,permission,permissions,isolation,requestedIsolation:isolationValue,ownership,
    model:boundedText(input.model,300)||null,
    context:boundedText(typeof input.context==="string"?input.context:input.context?.text,12_000)||null,
    budget:budget(input.budget),
    label:boundedText(input.label,180)||null,
  };
}

export function delegationPolicies(permissions="supervised",cwd=null){
  const mode=PERMISSIONS.has(String(permissions))?String(permissions):"supervised";
  if(mode==="read-only")return {approvalPolicy:"on-request",sandbox:"read-only",sandboxPolicy:{type:"readOnly",networkAccess:false}};
  if(mode==="full")return {approvalPolicy:"never",sandbox:"danger-full-access",sandboxPolicy:{type:"dangerFullAccess"}};
  if(mode==="workspace-write")return {approvalPolicy:"on-request",sandbox:"workspace-write",sandboxPolicy:{type:"workspaceWrite",writableRoots:cwd?[cwd]:[],networkAccess:true,excludeTmpdirEnvVar:false,excludeSlashTmp:false}};
  return {approvalPolicy:"on-request",sandbox:"workspace-write",sandboxPolicy:{type:"workspaceWrite",writableRoots:cwd?[cwd]:[],networkAccess:true,excludeTmpdirEnvVar:false,excludeSlashTmp:false}};
}

export function delegationGoalPatch(spec){
  const normalized=normalizeDelegationRequest(spec);
  return {
    objective:normalized.task,status:"active",
    constraints:[
      `Delegated worker permission profile: ${normalized.permissions}`,
      `Delegated worker isolation: ${normalized.isolation}`,
      ...(normalized.ownership.length?[`Delegated ownership: ${normalized.ownership.join(", ")}`]:[]),
    ],
    validationExpectations:[],completionConditions:[],
    ...normalized.budget,
  };
}

export function delegationContextValue({parentThreadId,spec}={}){
  if(!spec)return "";
  const lines=[
    "Trebell delegated task",
    parentThreadId&&("Parent thread: "+String(parentThreadId)),
    "Task:\n"+spec.task,
    "Permission profile: "+spec.permissions,
    "Isolation: "+spec.isolation,
    spec.ownership?.length&&("Ownership:\n"+spec.ownership.map(item=>"- "+item).join("\n")),
    spec.context&&("Delegation context:\n"+spec.context),
    "Work independently within the delegated task. Do not broaden scope silently. Report concrete results, unresolved issues, and any changes that need reconciliation back to the parent.",
  ].filter(Boolean);
  return lines.join("\n\n").slice(0,16_000);
}
