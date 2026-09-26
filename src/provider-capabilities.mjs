const STATUS=new Set(["supported","unsupported","unverified"]);

function feature(status,reason){
  const value=STATUS.has(status)?status:"unverified";
  return Object.freeze({status:value,reason:String(reason||"").slice(0,500)});
}

const PROXY_UNVERIFIED="The configured Trebell provider is a third-party compatibility endpoint; upstream API features are not assumed to survive the proxy without provider documentation or a live Trebell verification.";

const COMMON_PROXY=Object.freeze({
  promptCaching:feature("unverified",PROXY_UNVERIFIED),
  explicitCacheControl:feature("unverified",PROXY_UNVERIFIED),
  previousResponseContinuation:feature("unverified",PROXY_UNVERIFIED),
  persistentConnection:feature("unverified",PROXY_UNVERIFIED),
  nativeCompaction:feature("unverified",PROXY_UNVERIFIED),
  parallelToolCalls:feature("unverified","Trebell can request parallel tool calls, but provider/model behavior must be verified per route."),
  cacheUsageBreakdown:feature("supported","Trebell normalizes cache read/write fields when the provider returns them; absence of fields or zero values is not treated as a cache hit."),
});

const CAPABILITIES=Object.freeze({
  freebuff:Object.freeze({
    ...COMMON_PROXY,
    promptCaching:feature("unverified","Freebuff is served through Trebell's local compatibility bridge; cache behavior depends on the authenticated upstream route and must be measured."),
    previousResponseContinuation:feature("unverified","The bridge speaks a Responses-compatible protocol but Trebell has not verified server-side continuation through this route."),
    persistentConnection:feature("unsupported","The current Trebell Freebuff bridge integration does not expose a persistent Responses WebSocket transport."),
  }),
  agentrouter:Object.freeze({
    ...COMMON_PROXY,
    previousResponseContinuation:feature("unverified","AgentRouter accepts a Responses-shaped API, but Trebell has not verified that previous_response_id semantics are preserved by this proxy."),
    persistentConnection:feature("unsupported","The current AgentRouter integration uses HTTPS Responses requests, not a persistent WebSocket transport."),
  }),
  justworker:Object.freeze({
    ...COMMON_PROXY,
    explicitCacheControl:feature("unverified","The route is Anthropic-Messages-compatible, but Trebell has not verified cache_control support through JustWorker."),
    previousResponseContinuation:feature("unsupported","The current Anthropic Messages compatibility path is stateless from Trebell's perspective."),
    persistentConnection:feature("unsupported","The current JustWorker integration uses HTTPS Messages requests."),
  }),
  hcnsec:Object.freeze({
    ...COMMON_PROXY,
    previousResponseContinuation:feature("unsupported","The current HCNSec Chat Completions compatibility path is stateless from Trebell's perspective."),
    persistentConnection:feature("unsupported","The current HCNSec integration uses HTTPS Chat Completions requests."),
  }),
  vyceai:Object.freeze({
    ...COMMON_PROXY,
    promptCaching:feature("unverified","A controlled Trebell live run on 2026-09-26 observed zero cached input tokens across repeated stable prefixes; this is evidence of no observed hit, not proof that the proxy can never cache."),
    explicitCacheControl:feature("unsupported","The current Vyce integration exposes an OpenAI Chat Completions compatibility route and Trebell has no verified explicit cache-control mechanism for it."),
    previousResponseContinuation:feature("unsupported","The current Vyce Chat Completions route has no verified server-side continuation mechanism in Trebell."),
    persistentConnection:feature("unsupported","The current Vyce integration uses HTTPS Chat Completions requests."),
    nativeCompaction:feature("unsupported","No provider-native compaction API is verified on the current Vyce Chat Completions route."),
  }),
});

export function providerCapabilities(providerId){
  const id=String(providerId||"freebuff").trim().toLowerCase();
  const value=CAPABILITIES[id]||COMMON_PROXY;
  return {
    promptCaching:{...value.promptCaching},
    explicitCacheControl:{...value.explicitCacheControl},
    previousResponseContinuation:{...value.previousResponseContinuation},
    persistentConnection:{...value.persistentConnection},
    nativeCompaction:{...value.nativeCompaction},
    parallelToolCalls:{...value.parallelToolCalls},
    cacheUsageBreakdown:{...value.cacheUsageBreakdown},
  };
}

export function providerFeatureEnabled(providerId,featureName){
  return providerCapabilities(providerId)?.[featureName]?.status==="supported";
}

