const RISKS=new Set(["low","medium","high","critical"]);
const REVERSIBILITY=new Set(["not-applicable","full","partial","none"]);
const SCALES=new Set(["low","medium","high","unknown"]);
const WORKSPACE_REQUIREMENTS=new Set(["none","optional","required"]);
const ENVIRONMENT_REQUIREMENTS=new Set(["any","local","remote"]);

function enumValue(value,allowed,fallback,label){
  const normalized=String(value??fallback);if(!allowed.has(normalized))throw new Error(`Invalid ${label}: ${normalized}`);return normalized;
}

export function defineToolPolicy(value={}){
  const readOnly=Boolean(value.readOnly),policy={
    permissions:Object.freeze([...new Set((value.permissions||[]).map(item=>String(item).trim()).filter(Boolean))]),
    risk:enumValue(value.risk,RISKS,"low","tool risk"),
    reversibility:enumValue(value.reversibility,REVERSIBILITY,readOnly?"not-applicable":"partial","tool reversibility"),
    idempotent:value.idempotent==null?readOnly:Boolean(value.idempotent),
    externalSideEffects:Boolean(value.externalSideEffects),
    workspace:enumValue(value.workspace,WORKSPACE_REQUIREMENTS,"required","workspace requirement"),
    environment:enumValue(value.environment,ENVIRONMENT_REQUIREMENTS,"any","environment requirement"),
    cost:enumValue(value.cost,SCALES,"low","tool cost"),
    latency:enumValue(value.latency,SCALES,"low","tool latency"),
    progressiveDisclosure:value.progressiveDisclosure!==false,
    readOnly,
    openWorld:Boolean(value.openWorld),
  };
  if(readOnly&&policy.externalSideEffects)throw new Error("Read-only tools cannot declare external side effects");
  return Object.freeze(policy);
}

export function mcpAnnotationsForPolicy(policy){
  const value=defineToolPolicy(policy);
  return Object.freeze({
    readOnlyHint:value.readOnly,
    destructiveHint:value.readOnly?false:value.risk==="high"||value.risk==="critical",
    idempotentHint:Boolean(value.idempotent),
    openWorldHint:Boolean(value.openWorld),
  });
}

export const REPOSITORY_READ_POLICY=defineToolPolicy({
  permissions:["repository:read"],risk:"low",reversibility:"not-applicable",idempotent:true,externalSideEffects:false,
  workspace:"required",environment:"any",cost:"low",latency:"low",progressiveDisclosure:true,readOnly:true,openWorld:false,
});
