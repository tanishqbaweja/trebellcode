// Browser-safe model provider ids and display labels. Keep in sync with MODEL_PROVIDERS in src/provider-manager.mjs, which imports node:fs and cannot load in the UI.
export const DEFAULT_MODEL_PROVIDER="openai";
export const MODEL_PROVIDER_LABELS=Object.freeze({openai:"OpenAI API",anthropic:"Anthropic API",gemini:"Google Gemini API",agentrouter:"AgentRouter",justworker:"JustWorker.icu",hcnsec:"HCNSec.cn",vyceai:"VyceAi"});
export const MODEL_PROVIDER_IDS=Object.freeze(Object.keys(MODEL_PROVIDER_LABELS));

export function modelProviderLabel(id){
  const raw=String(id??""),key=raw.trim().toLowerCase();
  return Object.hasOwn(MODEL_PROVIDER_LABELS,key)?MODEL_PROVIDER_LABELS[key]:raw;
}
