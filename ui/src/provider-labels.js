// Browser-safe model provider ids and display labels. Keep in sync with MODEL_PROVIDERS in src/provider-manager.mjs, which imports node:fs and cannot load in the UI.
export const DEFAULT_MODEL_PROVIDER="openai";
export const MODEL_PROVIDER_LABELS=Object.freeze({openai:"OpenAI API",anthropic:"Anthropic API",gemini:"Google Gemini API",xai:"xAI API",meta:"Meta Model API",agentrouter:"AgentRouter",justworker:"JustWorker.icu",hcnsec:"HCNSec.cn",vyceai:"VyceAi"});
export const MODEL_PROVIDER_IDS=Object.freeze(Object.keys(MODEL_PROVIDER_LABELS));
// The model catalog's error for a provider without a key (ProviderManager.models): a next step, not a failure. After a
// refused key check the catalog says why instead.
export const MISSING_PROVIDER_KEY="API key required";

export function modelProviderLabel(id){
  const raw=String(id??""),key=raw.trim().toLowerCase();
  return Object.hasOwn(MODEL_PROVIDER_LABELS,key)?MODEL_PROVIDER_LABELS[key]:raw;
}
