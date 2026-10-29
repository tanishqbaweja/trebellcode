// Which providers stream a Trebell Native reply into the app as it is written. OpenAI's turn already streams over its
// WebSocket or SSE lane, so it only needs the observer. A chat provider streams only once a live check showed its streamed
// text, usage and tool calls match its JSON replies; until then it keeps its JSON request. The benchmark runner bundles this file
// (through src/native-provider-turn.mjs) but passes no stream observer, and nativeStreamOptions adds options only with one, so
// nothing here changes what the runner sends (tests/native-one-config-parity.test.mjs compares drafts on and off byte for byte).
// Live check of 2026-10-11 (scripts/live-native-reply-streaming.mjs): JustWorker stays off because its stream reports the
// billed input tokens only in message_delta while the adapter reads them from message_start, so a streamed turn would
// under-count its usage; HCNSec stays off because it did not answer at all during the check (JSON or streamed).
export const NATIVE_CHAT_REPLY_STREAMING=Object.freeze([]);
// These providers stay on JSON replies whatever the allowlist says.
export const NATIVE_CHAT_REPLY_STREAMING_BLOCKED=Object.freeze(["vyceai","agentrouter"]);

for(const provider of NATIVE_CHAT_REPLY_STREAMING_BLOCKED)if(NATIVE_CHAT_REPLY_STREAMING.includes(provider))throw new Error(`Native reply streaming cannot allow blocked provider ${provider}`);

// The ProviderManager.turn options that let a provider call pass its reply text on as it streams.
export function nativeStreamOptions(provider,onStream){
  if(typeof onStream!=="function")return {};
  const id=String(provider||"").trim().toLowerCase();
  if(NATIVE_CHAT_REPLY_STREAMING_BLOCKED.includes(id))return {};
  if(id==="openai")return {onStream};
  if(NATIVE_CHAT_REPLY_STREAMING.includes(id))return {streamChat:true,onStream};
  return {};
}
