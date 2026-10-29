import { NATIVE_REPLY_STREAM } from "./native-agent-session.mjs";
import { NATIVE_REASONING_CONTEXT, nativeProviderTurnOptions } from "./native-configuration.mjs";
import { nativeStreamOptions } from "./native-reply-streaming.mjs";

// One Native provider turn, as the app (src/gui-server.mjs) and the benchmark runner (benchmarks/harbor/native-harbor-run.mjs) both
// send it: the transport options and the reasoning context of src/native-configuration.mjs. An OpenAI request that names no reasoning
// context gets the shared one (the same value the provider manager would fill in, now said here). A request the session wants to show
// as it streams carries its observer under a Symbol; the provider gets the request without it (its other Symbol keys stay, the
// identity caches are keyed by them) and only the options say how to stream.
export function nativeProviderTurn(manager,request={},{provider=request?.provider}={}){
  const base=provider==="openai"&&!String(request.reasoningContext||"").trim()?{...request,reasoningContext:NATIVE_REASONING_CONTEXT}:request;
  const options={signal:request.signal,...nativeProviderTurnOptions(provider)};
  if(typeof base[NATIVE_REPLY_STREAM]!=="function")return manager.turn(provider,base,options);
  const {[NATIVE_REPLY_STREAM]:onStream,...providerRequest}=base;
  return manager.turn(provider,providerRequest,{...options,...nativeStreamOptions(provider,onStream)});
}
