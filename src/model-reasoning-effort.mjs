export const REASONING_EFFORTS=Object.freeze(["none","minimal","low","medium","high","xhigh","max"]);
const ALLOWED=new Set(REASONING_EFFORTS);

export function normalizeReasoningEffort(value){
  const effort=String(value??"").trim().toLowerCase();
  return ALLOWED.has(effort)?effort:null;
}

// Codex advertises its own effort ids per model (for example "ultra"); keep them as Codex lists them, like T3 Code.
const CODEX_EFFORT=/^[a-z][a-z0-9_-]{0,31}$/;
// OpenCode's reasoning levels are its model variants, by the names OpenCode gives them (T3 Code's "variant" option); kept verbatim.
const OPENCODE_VARIANT=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function normalizeRuntimeReasoningEffort(runtime,value){
  if(runtime==="opencode"){const variant=String(value??"").trim();return OPENCODE_VARIANT.test(variant)?variant:null}
  if(runtime!=="codex")return normalizeReasoningEffort(value);
  const effort=String(value??"").trim().toLowerCase();
  return CODEX_EFFORT.test(effort)?effort:null;
}

export function modelReasoningEffortKey(runtime,provider,model){
  return [String(runtime||""),String(provider||""),String(model||"")].join(":");
}

function normalizedAdvertised(values=[],runtime=null){
  const out=[];
  for(const value of Array.isArray(values)?values:[]){
    const effort=normalizeRuntimeReasoningEffort(runtime,typeof value==="string"?value:(value?.reasoningEffort??value?.effort??value?.value??value?.id));
    if(effort&&!out.includes(effort))out.push(effort);
  }
  return out;
}

export function supportedReasoningEfforts(runtime,provider,model,metadata={}){
  const advertised=normalizedAdvertised(metadata?.reasoningEfforts||metadata?.supportedReasoningEfforts||[],runtime);
  if(advertised.length)return advertised;
  const id=String(model||"").trim().toLowerCase();
  if(runtime==="native"){
    if(provider==="openai"){
      if(/^gpt-6-(?:luna|sol)(?:$|-)/.test(id))return ["none","low","medium","high","xhigh","max"];
      if(/^gpt-6-astra(?:$|-)/.test(id))return ["low","medium","high","xhigh","max"];
      if(/^(?:gpt-5(?:\.|-|$)|o\d)/.test(id))return ["low","medium","high","xhigh"];
    }
    if(provider==="gemini")return ["low","medium","high"];
    if(provider==="anthropic"&&/(?:claude-(?:opus|sonnet)-(?:4-[6-9]|5)|claude-(?:fable|mythos)-5)/.test(id))return ["low","medium","high"];
    return [];
  }
  return runtime==="codex"?advertised:[];
}

export function defaultReasoningEffort(runtime,provider,model){
  return null;
}

export function configuredReasoningEffort(settings,runtime,provider,model){
  const configured=normalizeRuntimeReasoningEffort(runtime,settings?.modelReasoningEfforts?.[modelReasoningEffortKey(runtime,provider,model)]);
  return configured||defaultReasoningEffort(runtime,provider,model);
}
