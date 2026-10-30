import { nativeModelSettings } from "./native-configuration.mjs";

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
// Muse Code's levels are the Muse Session Protocol's, Ultra included, without None, which Meta's provider refuses.
export const MUSE_REASONING_EFFORTS=Object.freeze(["minimal","low","medium","high","xhigh","max","ultra"]);
export function normalizeRuntimeReasoningEffort(runtime,value){
  if(runtime==="opencode"){const variant=String(value??"").trim();return OPENCODE_VARIANT.test(variant)?variant:null}
  if(runtime==="muse"){const effort=String(value??"").trim().toLowerCase();return MUSE_REASONING_EFFORTS.includes(effort)?effort:null}
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
      // Point releases (gpt-6.1-sol, OpenAI's default model): the Responses API accepts Low through Max and rejects None.
      if(/^gpt-6\.\d+-(?:luna|sol|astra)(?:$|-)/.test(id))return ["low","medium","high","xhigh","max"];
      // Live, the Responses API refuses a level outside the model's own list with HTTP 400 and the turn fails: the o-series,
      // gpt-5 (with its mini and nano) and gpt-5.1 stop at High, gpt-5-pro takes only High and later -pro models start at
      // Medium.
      if(/^o\d/.test(id))return ["low","medium","high"];
      if(/^gpt-5-pro(?:$|-)/.test(id))return ["high"];
      if(/^gpt-5\.\d+-pro(?:$|-)/.test(id))return ["medium","high","xhigh"];
      if(/^gpt-5(?:-mini|-nano)?(?:$|-\d)|^gpt-5\.1(?:$|-)/.test(id))return ["low","medium","high"];
      if(/^gpt-5(?:\.|-|$)/.test(id))return ["low","medium","high","xhigh"];
    }
    // Gemini's thinking levels belong to a model: without one (no key, so no catalog) there is nothing to set them on.
    if(provider==="gemini")return id?["low","medium","high"]:[];
    if(provider==="anthropic"&&/(?:claude-(?:opus|sonnet)-(?:4-[6-9]|5)|claude-(?:fable|mythos)-5)/.test(id))return ["low","medium","high"];
    // Meta's catalog lists no levels. Its Responses API takes Minimal to Extra High (Muse Spark refuses None), and Muse Wonder and
    // Muse Spark 1.3 also Max, which Spark 1.3's Contributor mode does not offer (dev.meta.ai/docs/models). xAI lists its own.
    if(provider==="meta"&&/^muse-(?:spark|wonder)-/.test(id))return ["minimal","low","medium","high","xhigh",...(/^muse-wonder-|^muse-spark-1\.3(?!.*contributor)/.test(id)?["max"]:[])];
    return [];
  }
  return runtime==="codex"?advertised:[];
}

// Native's effort when the person picked none: the level a model was measured with (native-configuration.mjs: max for gpt-6-luna),
// else none, so the provider's own default applies.
export function defaultReasoningEffort(runtime,provider,model){
  return runtime==="native"?nativeModelSettings({provider,model}).reasoningEffort:null;
}

// metadata is the model's catalog row, which may list its own levels. Native sends a saved level to the provider as is, and
// OpenAI refuses one outside the model's list with HTTP 400, failing the turn: a level saved before that list narrowed
// (Extra High on gpt-5) gives way to the provider default.
export function configuredReasoningEffort(settings,runtime,provider,model,metadata={}){
  const configured=normalizeRuntimeReasoningEffort(runtime,settings?.modelReasoningEfforts?.[modelReasoningEffortKey(runtime,provider,model)]);
  if(configured&&runtime==="native"&&!supportedReasoningEfforts(runtime,provider,model,metadata).includes(configured))return defaultReasoningEffort(runtime,provider,model);
  return configured||defaultReasoningEffort(runtime,provider,model);
}

// The composer's Thinking picker for a model: the level it shows (the saved one, else the level a message runs at) and whether it
// offers a Default option. A model with a measured level (Max on gpt-6-luna) offers none: its default is one of the levels it lists, so
// a Default there would show that level and never stay chosen (review of native-one-config, 2026-10-29). Elsewhere Default stands
// for the provider's own level.
export function reasoningEffortPicker(settings,runtime,provider,model,metadata={}){
  const measured=defaultReasoningEffort(runtime,provider,model);
  return {value:configuredReasoningEffort(settings,runtime,provider,model,metadata)||"",defaultOption:!measured,defaultLevel:measured||null};
}
