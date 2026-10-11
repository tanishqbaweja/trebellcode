// Live checks for Trebell Native reply streaming (spec C9): whether a provider's streamed reply carries the same text, usage
// and tool calls as its JSON reply, arrives as it is written, and shows as drafts in a Native session. A chat provider joins
// NATIVE_CHAT_REPLY_STREAMING only on a pass. Keys come from the environment, as scripts/live-provider-smoke.mjs reads them,
// and nothing here prints one. At most six provider calls per lane.
//   node --env-file-if-exists=.env scripts/live-native-reply-streaming.mjs --live --lanes=openai-ws,openai-sse,justworker,hcnsec
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createLiveSmokeGuard } from "../src/live-smoke-policy.mjs";
import { NATIVE_REPLY_STREAM, NativeAgentSession } from "../src/native-agent-session.mjs";
import { OpenAiResponsesWebSocket } from "../src/openai-responses-websocket.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";
import { redactSecretText } from "../src/secret-redactor.mjs";

const LANES={
  "openai-ws":{provider:"openai",models:["gpt-5.6","gpt-5.6-terra","gpt-5.6-luna"],env:{TREBELL_OPENAI_RESPONSES_WEBSOCKET:"1"}},
  "openai-sse":{provider:"openai",models:["gpt-5.6","gpt-5.6-terra","gpt-5.6-luna"],env:{TREBELL_OPENAI_RESPONSES_WEBSOCKET:"0"}},
  justworker:{provider:"justworker",models:["claude-opus-4-8"]},
  hcnsec:{provider:"hcnsec",models:["glm-5.3"]},
};
const CALLS_PER_LANE=6,TURN_TIMEOUT_MS=240_000;
const EXPLAIN="Explain in about 300 words how a half-open range like range(start, end) works, why slice and range use it, and what goes wrong with an inclusive end. Plain prose in three paragraphs, no code blocks.";
const ECHO={type:"namespace",name:"live",tools:[{name:"echo",description:"Echo the given text back to the caller.",parameters:{type:"object",properties:{text:{type:"string",description:"The text to echo."}},required:["text"]}}]};
const LOOKUP={type:"namespace",name:"live",tools:[{name:"lookup",description:"Look up a programming term and return its short definition.",parameters:{type:"object",properties:{term:{type:"string",description:"The term to look up."}},required:["term"]}}]};
const SESSION_PROMPT="Look up the term half-open range with the lookup tool, then explain in two short paragraphs what it means and why slice and range use it. Do not change any files.";

const lanes=String(process.argv.find(arg=>arg.startsWith("--lanes="))?.slice(8)||Object.keys(LANES).join(",")).split(",").map(value=>value.trim()).filter(Boolean);
for(const lane of lanes)if(!LANES[lane])throw new Error("Unknown lane "+lane);
const root=String(process.env.TREBELL_LIVE_STREAM_ROOT||"").trim()||tmpdir();
const clean=value=>redactSecretText(String(value?.message||value||""),{trim:true}).slice(0,400);
const usageOf=response=>({input:Number(response?.usage?.inputTokens)||0,output:Number(response?.usage?.outputTokens)||0});
const textOf=events=>events.filter(event=>event.type==="text").map(event=>event.delta).join("");

async function runLane(name){
  const lane=LANES[name],provider=lane.provider,home=mkdtempSync(join(root,"live-stream-"+name+"-"));
  const guard=createLiveSmokeGuard({provider,model:lane.models[0],runtime:"native",maxTurns:CALLS_PER_LANE,timeoutMs:600_000});
  // For diagnosis only: which phase OpenAI puts on the message items it announces.
  const phases=new Set();
  const notePhase=event=>{if(event?.type==="response.output_item.added"&&event.item?.type==="message")phases.add(event.item.phase??"(none)")};
  class TappedSocket extends WebSocket{constructor(...args){super(...args);this.on("message",data=>{try{notePhase(JSON.parse(String(data)))}catch{}})}}
  const fetchFn=async(input,init)=>{
    const response=await fetch(input,init);
    if(provider!=="openai"||!response.body||!String(response.headers.get("content-type")||"").includes("event-stream"))return response;
    const [forward,tap]=response.body.tee();
    void (async()=>{const reader=tap.getReader(),decoder=new TextDecoder();let buffer="";try{for(;;){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let index;while((index=buffer.indexOf("\n\n"))>=0){const block=buffer.slice(0,index);buffer=buffer.slice(index+2);for(const line of block.split("\n"))if(line.startsWith("data:"))try{notePhase(JSON.parse(line.slice(5)))}catch{}}}}catch{}})();
    return new Response(forward,{status:response.status,statusText:response.statusText,headers:response.headers});
  };
  const manager=new ProviderManager({env:{...process.env,...(lane.env||{}),TREBELL_HOME:home},fetchFn,requestTimeoutMs:TURN_TIMEOUT_MS,openAiResponsesWebSocketFactory:options=>new OpenAiResponsesWebSocket({...options,WebSocketClass:TappedSocket})});
  const report={lane:name,provider,model:null,calls:0,wires:[],checks:{},pass:false};
  const call=async(label,run)=>{guard.consumeTurn(label);report.calls++;const result=await guard.withTimeout(run(AbortSignal.timeout(TURN_TIMEOUT_MS)),label);report.wires.push(result?.telemetry?.wireApi||null);return result};
  // OpenAI streams on its Responses lane either way; a chat provider is streamed only with streamChat.
  const streamed=onStream=>provider==="openai"?{streamResponses:true,onStream}:{streamChat:true,onStream};
  const plain=provider==="openai"?{streamResponses:true}:{};
  const effort=provider==="openai"?{reasoningEffort:"low",metadata:{sessionId:"live-stream-"+name}}:{};
  try{
    if(!manager.status(provider).hasKey)throw new Error("No API key is configured for "+provider);
    const catalog=await guard.withTimeout(manager.models(provider),"model discovery"),models=Array.isArray(catalog?.models)?catalog.models:[];
    const model=lane.models.find(item=>models.includes(item))||catalog?.defaultModel||models[0];if(!model)throw new Error("No model is available");report.model=model;

    // 1-3. The same explanation streamed and as one reply: same text, usage, and text that arrives as it is written.
    const request={model,messages:[{role:"user",content:EXPLAIN}],tools:[],toolChoice:"none",maxOutputTokens:2000,...effort};
    const events=[];let started=performance.now();
    const live=await call("streamed explanation",signal=>manager.turn(provider,request,{signal,...streamed(event=>events.push({...event,at:performance.now()-started}))}));
    const totalMs=performance.now()-started,texts=events.filter(event=>event.type==="text");
    const whole=await call("explanation as one reply",signal=>manager.turn(provider,request,{signal,...plain}));
    report.checks.text={pass:Boolean(live.text)&&textOf(events)===live.text,chars:live.text.length,textEvents:texts.length,plainChars:String(whole.text||"").length};
    const a=usageOf(live),b=usageOf(whole);
    report.checks.usage={pass:a.input>0&&a.output>0&&b.input>0&&b.output>0&&Math.abs(a.input-b.input)<=0.02*Math.max(a.input,b.input),streamed:a,plain:b};
    const firstMs=texts[0]?.at??null,lastMs=texts.at(-1)?.at??null;
    report.checks.buffering={pass:firstMs!=null&&firstMs<totalMs/2&&texts.length>=20,firstTextMs:Math.round(firstMs??-1),lastTextMs:Math.round(lastMs??-1),totalMs:Math.round(totalMs),textSpreadMs:firstMs==null?null:Math.round(lastMs-firstMs)};

    // 4. A forced tool call streamed and as one reply: the stream says tool_call, the calls match and carry ids.
    const toolRequest={model,messages:[{role:"user",content:"Call the echo tool once with the text trebell-stream-check. Do not answer in text."}],tools:[ECHO],toolChoice:{namespace:"live",name:"echo"},maxOutputTokens:600,...effort};
    const toolEvents=[];
    const liveTool=await call("streamed tool call",signal=>manager.turn(provider,toolRequest,{signal,...streamed(event=>toolEvents.push(event))}));
    const wholeTool=await call("tool call as one reply",signal=>manager.turn(provider,toolRequest,{signal,...plain}));
    const shape=calls=>(calls||[]).map(item=>{let args=item.arguments;try{args=JSON.parse(item.arguments)}catch{}return {namespace:item.namespace||null,name:item.name,arguments:args}});
    const toolAt=toolEvents.findIndex(event=>event.type==="tool_call");
    report.checks.tool={
      pass:toolAt>=0&&toolEvents.slice(toolAt+1).every(event=>event.type!=="text")&&liveTool.toolCalls?.length>0&&liveTool.toolCalls.every(item=>String(item.id||"").trim())&&JSON.stringify(shape(liveTool.toolCalls))===JSON.stringify(shape(wholeTool.toolCalls)),
      toolCallEvent:toolAt>=0,textAfterToolCall:toolAt>=0?toolEvents.slice(toolAt+1).filter(event=>event.type==="text").length:null,ids:(liveTool.toolCalls||[]).map(item=>Boolean(String(item.id||"").trim())),streamed:shape(liveTool.toolCalls),plain:shape(wholeTool.toolCalls),
    };

    // 5. A Native session with drafts on, wired as the app wires it, on a read-only prompt that uses one tool.
    const updates=[],returns=[];started=performance.now();
    const session=new NativeAgentSession({
      cwd:home,provider,model,semanticCompletionGate:true,streamDrafts:true,permissionMode:"full",tools:[LOOKUP],...(provider==="openai"?{reasoningEffort:"low"}:{}),
      executeTool:async()=>({term:"half-open range",definition:"A range that includes its start and excludes its end, written [start, end)."}),
      onUpdate:update=>updates.push({...update.update,at:performance.now()-started}),
      providerTurn:async item=>{
        const {[NATIVE_REPLY_STREAM]:onStream,...providerRequest}=item;
        const response=await call("session call",signal=>manager.turn(provider,{...providerRequest,provider,model},{signal:AbortSignal.any([signal,item.signal].filter(Boolean)),...(typeof onStream==="function"?streamed(onStream):plain)}));
        returns.push(performance.now()-started);return response;
      },
    });
    await session.start({providerSessionId:"live-stream-"+name,model});
    let promptError=null;
    try{await session.prompt([{type:"text",text:SESSION_PROMPT}],{maxModelTurns:CALLS_PER_LANE-4,maxToolCalls:2})}catch(error){promptError=clean(error)}finally{await session.close().catch(()=>{})}
    const drafts=updates.filter(update=>String(update.sessionUpdate).startsWith("agent_message_draft_")),final=updates.find(update=>update.sessionUpdate==="agent_message_chunk")?.content?.text||"";
    const lastReset=drafts.map(update=>update.sessionUpdate).lastIndexOf("agent_message_draft_reset"),shown=drafts.slice(lastReset+1).map(update=>update.content?.text||"").join("");
    const firstDraft=drafts.find(update=>update.sessionUpdate==="agent_message_draft_delta");
    report.checks.session={
      pass:!promptError&&Boolean(final)&&Boolean(firstDraft)&&firstDraft.at<(returns.at(-1)??Infinity)&&shown===final,
      error:promptError,providerCalls:returns.length,draftDeltas:drafts.filter(update=>update.sessionUpdate==="agent_message_draft_delta").length,
      revealedThenWithdrawn:drafts.filter(update=>update.sessionUpdate==="agent_message_draft_reset").map(update=>update.reason),
      firstDraftMs:firstDraft?Math.round(firstDraft.at):null,lastCallReturnedMs:returns.length?Math.round(returns.at(-1)):null,finalEqualsDrafts:shown===final,finalChars:final.length,
    };
    if(provider==="openai")report.messagePhases=[...phases];
    report.pass=Object.values(report.checks).every(check=>check.pass);
  }catch(error){report.error=clean(error)}
  finally{manager.close?.();rmSync(home,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
  return report;
}

const results=[];for(const lane of lanes)results.push(await runLane(lane));
console.log(JSON.stringify({ok:results.every(item=>item.pass),results},null,2));
if(!results.every(item=>item.pass))process.exitCode=1;
