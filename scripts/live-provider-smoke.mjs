import { ProviderManager, MODEL_PROVIDERS } from "../src/provider-manager.mjs";
import { createLiveSmokeGuard } from "../src/live-smoke-policy.mjs";

const REQUEST_MARKER="TREBELL_PROVIDER_SMOKE_OK";
const ALL_PROVIDERS=["openai","anthropic","gemini","agentrouter","justworker","hcnsec","vyceai"];
const requested=String(process.env.TREBELL_PROVIDER_SMOKE_ONLY||"").split(",").map(value=>value.trim().toLowerCase()).filter(Boolean);
const PROVIDERS=requested.length?ALL_PROVIDERS.filter(provider=>requested.includes(provider)):ALL_PROVIDERS;
const PREFERRED_MODELS={
  openai:["gpt-5.6","gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna"],
  anthropic:["claude-opus-5","claude-sonnet-5","claude-opus-4-8","claude-sonnet-4-6"],
  gemini:["gemini-3.8-flash"],
  agentrouter:["gpt-6-astra","deepseek-v4-flash","claude-opus-5","claude-opus-4-8"],
  justworker:["claude-opus-4-8"],
  hcnsec:["glm-5.3"],
  vyceai:["deepseek-v4-flash","deepseek-v4.1"],
};
const TURN_TIMEOUT_MS={openai:70_000,anthropic:70_000,gemini:70_000,agentrouter:70_000,justworker:70_000,hcnsec:210_000,vyceai:70_000};

const guard=createLiveSmokeGuard({provider:"configured-providers",model:"provider-defaults",runtime:"native",maxTurns:PROVIDERS.length,timeoutMs:300_000});
const manager=new ProviderManager({env:process.env,requestTimeoutMs:Math.max(...Object.values(TURN_TIMEOUT_MS))});
const results=[];

function chooseModel(provider,catalog){
  const models=Array.isArray(catalog?.models)?catalog.models:[];
  const defaultModel=models.includes(catalog?.defaultModel)?catalog.defaultModel:null;
  return (PREFERRED_MODELS[provider]||[]).find(model=>models.includes(model))||defaultModel||models[0]||MODEL_PROVIDERS[provider]?.staticModels?.[0]||null;
}

for(const provider of PROVIDERS){
  const status=manager.status(provider);
  if(!status.hasKey){results.push({provider,ok:false,skipped:true,reason:"API key is not configured"});continue}
  let catalog;
  try{catalog=await guard.withTimeout(manager.models(provider),provider+" model discovery")}
  catch(error){results.push({provider,ok:false,phase:"models",error:error?.message||String(error)});continue}
  const model=chooseModel(provider,catalog);
  if(!model){results.push({provider,ok:false,phase:"models",error:"No model is available"});continue}
  guard.consumeTurn(provider+" smoke turn");
  const started=performance.now();
  try{
    const timeoutMs=TURN_TIMEOUT_MS[provider]||70_000;
    const response=await guard.withTimeout(manager.turn(provider,{
      model,
      messages:[{role:"user",content:`Reply exactly ${REQUEST_MARKER}. Do not use tools.`}],
      tools:[],
      toolChoice:"none",
      // Reasoning-capable providers can spend a small output budget entirely
      // on hidden reasoning and legitimately return an empty visible answer.
      // Keep the smoke bounded, but leave enough room for the marker too.
      maxOutputTokens:256,
    },{signal:AbortSignal.timeout(timeoutMs)}),provider+" model turn");
    results.push({provider,model,ok:String(response?.text||"").includes(REQUEST_MARKER),reply:String(response?.text||"").trim().slice(0,160),latencyMs:Math.round(performance.now()-started),usage:response?.usage||null,telemetry:response?.telemetry||null});
  }catch(error){results.push({provider,model,ok:false,phase:"turn",latencyMs:Math.round(performance.now()-started),error:error?.message||String(error),status:error?.status||null,retryable:Boolean(error?.retryable)})}
}

const report={ok:results.every(item=>item.ok||item.skipped),results,fingerprint:guard.fingerprint()};
console.log(JSON.stringify(report,null,2));
if(!report.ok)process.exitCode=1;
