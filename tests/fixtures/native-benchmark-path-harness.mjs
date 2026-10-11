// The Harbor benchmark runner's provider path, rebuilt from benchmarks/harbor/trebell-native-runner.mjs (its session
// options and its providerTurn) over the real ProviderManager and the real OpenAiResponsesWebSocket. Only the socket and
// fetch underneath are scripted, so every byte the runner would send and everything it would record can be compared
// against tests/fixtures/native-benchmark-path-parity.json.
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeAgentSession } from "../../src/native-agent-session.mjs";
import { attachNativePromptProvenance } from "../../src/native-request-metrics.mjs";
import { nativeSystemPrompt } from "../../src/native-system-prompt.mjs";
import { NativeToolOutputStore } from "../../src/native-tool-output-store.mjs";
import { OpenAiResponsesWebSocket } from "../../src/openai-responses-websocket.mjs";
import { platformDynamicToolNamespaces } from "../../src/platform-tool-catalog.mjs";
import { ProviderManager } from "../../src/provider-manager.mjs";
import { TREBELL_USER_AGENT } from "../../src/version.mjs";

export const BENCHMARK_PATH_FIXTURE_URL=new URL("./native-benchmark-path-parity.json",import.meta.url);
// Events also carry their epoch time as "at".
const TIMING_KEY=/Ms$|Latency|At$|^at$|^created$/;
const MODEL="gpt-6-luna";
const RANGE_SOURCE="export function range(start,end){\n  const out=[];\n  for(let i=start;i<end;i++)out.push(i);\n  return out;\n}\n";

// Only timing keys are dropped; every other value is compared as recorded.
export function stripTiming(value){
  if(Array.isArray(value))return value.map(stripTiming);
  if(!value||typeof value!=="object")return value;
  const out={};for(const [key,child] of Object.entries(value))if(!TIMING_KEY.test(key))out[key]=stripTiming(child);return out;
}
function plain(value){return value===undefined?null:stripTiming(JSON.parse(JSON.stringify(value)))}
// The User-Agent is recorded by name so a version bump elsewhere does not rewrite the fixture; any other value is kept as sent.
function recordedHeaders(headers={}){
  const out={};for(const [key,value] of Object.entries(headers||{}))out[key]=key.toLowerCase()==="user-agent"&&value===TREBELL_USER_AGENT?"<TREBELL_USER_AGENT>":value;return out;
}

const usage=(input,output,cached=0,reasoning=0)=>({input_tokens:input,input_tokens_details:{cached_tokens:cached},output_tokens:output,output_tokens_details:{reasoning_tokens:reasoning},total_tokens:input+output});
function terminal(id,output,tokens,{withOutput}){
  return {type:"response.completed",response:{id,object:"response",model:MODEL,status:"completed",service_tier:"priority",reasoning:{effort:"max",context:"current_turn"},...(withOutput?{output}:{}),usage:tokens}};
}
function reasoningItem(index,id){
  const item={id,type:"reasoning",summary:[]};
  return {events:[{type:"response.output_item.added",output_index:index,item},{type:"response.output_item.done",output_index:index,item}],item};
}
function messageItem(index,id,phase,chunks){
  const text=chunks.join(""),item={id,type:"message",role:"assistant",status:"completed",...(phase?{phase}:{}),content:[{type:"output_text",text,annotations:[]}]};
  return {
    item,
    events:[
      {type:"response.output_item.added",output_index:index,item:{id,type:"message",role:"assistant",status:"in_progress",...(phase?{phase}:{}),content:[]}},
      {type:"response.content_part.added",output_index:index,item_id:id,content_index:0,part:{type:"output_text",text:"",annotations:[]}},
      ...chunks.map(delta=>({type:"response.output_text.delta",output_index:index,item_id:id,content_index:0,delta})),
      {type:"response.output_text.done",output_index:index,item_id:id,content_index:0,text},
      {type:"response.output_item.done",output_index:index,item},
    ],
  };
}
function functionCallItem(index,id,callId,name,args){
  const item={id,type:"function_call",status:"completed",call_id:callId,name,arguments:args};
  return {
    item,
    events:[
      {type:"response.output_item.added",output_index:index,item:{...item,status:"in_progress",arguments:""}},
      {type:"response.function_call_arguments.delta",output_index:index,item_id:id,delta:args},
      {type:"response.function_call_arguments.done",output_index:index,item_id:id,arguments:args},
      {type:"response.output_item.done",output_index:index,item},
    ],
  };
}
function reply(transport,id,parts,tokens){
  const output=parts.map(part=>part.item);
  return {transport,events:[{type:"response.created",response:{id,object:"response",model:MODEL,status:"in_progress"}},...parts.flatMap(part=>part.events),terminal(id,output,tokens,{withOutput:transport==="https"})]};
}

const EXPLAIN_PROMPT="Explain what src/range.mjs does and how it treats the end value. Do not change any files.";
const FINAL_CHUNKS=[
  "`range(start, end)` builds an array of consecutive integers. It starts at `start` and keeps pushing ",
  "`i` while `i < end`, so the end value itself is never included: `range(1, 3)` returns `[1, 2]`.\n\n",
  "That makes it a half-open range, the same convention as `Array.prototype.slice` and Python's `range`. ",
  "Callers that want the end value included need `range(start, end + 1)`, and a call with `end <= start` ",
  "returns an empty array because the loop condition is false on the first check.",
];
const commentary=index=>messageItem(index,"msg_commentary_1","commentary",["I'll read the module before answering."]);
const readCall=index=>functionCallItem(index,"fc_read_1","call_read_1","trebell_workspace__read_file",'{"path":"src/range.mjs"}');
const finalAnswer=(index,id="msg_final_1")=>messageItem(index,id,"final_answer",FINAL_CHUNKS);
const readTool={"trebell_workspace/read_file":()=>({path:"src/range.mjs",name:"range.mjs",size:RANGE_SOURCE.length,content:RANGE_SOURCE})};

export const BENCHMARK_PATH_SCENARIOS={
  // (a) a commentary preamble and a tool call, then the final answer, over the WebSocket.
  websocket_tool_then_answer:{
    prompt:EXPLAIN_PROMPT,tools:readTool,
    replies:[
      reply("ws","resp_a1",[reasoningItem(0,"rs_a1"),commentary(1),readCall(2)],usage(2100,64,0,32)),
      reply("ws","resp_a2",[reasoningItem(0,"rs_a2"),finalAnswer(1)],usage(2300,180,2048,48)),
    ],
  },
  // (b) the same over HTTPS server-sent events.
  sse_tool_then_answer:{
    prompt:EXPLAIN_PROMPT,tools:readTool,env:{TREBELL_OPENAI_RESPONSES_WEBSOCKET:"0"},
    replies:[
      reply("https","resp_b1",[reasoningItem(0,"rs_b1"),commentary(1),readCall(2)],usage(2100,64,0,32)),
      reply("https","resp_b2",[reasoningItem(0,"rs_b2"),finalAnswer(1,"msg_final_b")],usage(2300,180,2048,48)),
    ],
  },
  // (c) a retryable WebSocket server_error, then the retry over HTTPS while the socket cools down.
  websocket_server_error_then_https:{
    prompt:EXPLAIN_PROMPT,tools:readTool,
    replies:[
      {transport:"ws",events:[{type:"error",error:{type:"server_error",code:"server_error",message:"The server had an error while processing your request.",param:null}}]},
      reply("https","resp_c2",[reasoningItem(0,"rs_c2"),finalAnswer(1,"msg_final_c")],usage(2100,180,0,48)),
    ],
  },
  // (d) the semantic completion gate lane (TREBELL_HARBOR_SEMANTIC_GATE=1): read, edit, answer, then the gate's verdict.
  gate_lane_verdict:{
    prompt:"Fix the off-by-one bug in src/range.mjs so range(1,3) includes 3.",semanticCompletionGate:true,
    tools:{
      ...readTool,
      "trebell_workspace/replace_text":()=>({success:true,path:"src/range.mjs",replacements:1}),
    },
    replies:[
      reply("ws","resp_d1",[reasoningItem(0,"rs_d1"),readCall(1)],usage(2100,40,0,16)),
      reply("ws","resp_d2",[reasoningItem(0,"rs_d2"),functionCallItem(1,"fc_edit_1","call_edit_1","trebell_workspace__replace_text",'{"path":"src/range.mjs","old_text":"i<end","new_text":"i<=end"}')],usage(2200,60,2048,24)),
      reply("ws","resp_d3",[reasoningItem(0,"rs_d3"),messageItem(1,"msg_final_d","final_answer",["Changed the loop condition in `src/range.mjs` from `i<end` to `i<=end`, so `range(1,3)` now returns `[1, 2, 3]`."])],usage(2300,50,2048,16)),
      reply("ws","resp_d4",[reasoningItem(0,"rs_d4"),messageItem(1,"msg_gate_d",null,['{"status":"complete","unresolved":[],"reason":"The edit makes the end value inclusive as requested."}'])],usage(2500,40,2048,16)),
    ],
  },
  // (e) the WebSocket drops after text deltas; the loop's retry goes over HTTPS.
  websocket_drop_after_text_then_https:{
    prompt:EXPLAIN_PROMPT,tools:readTool,
    replies:[
      {transport:"ws",drop:true,events:reply("ws","resp_e1",[reasoningItem(0,"rs_e1"),finalAnswer(1,"msg_partial_e")],usage(2100,180)).events.filter(event=>event.type!=="response.completed").slice(0,-3)},
      reply("https","resp_e2",[reasoningItem(0,"rs_e2"),finalAnswer(1,"msg_final_e")],usage(2100,180,0,48)),
    ],
  },
};

const tick=()=>new Promise(resolve=>setImmediate(resolve));

function scriptedTransport(scenario,record){
  const queue=[...scenario.replies];
  const next=transport=>{
    const item=queue.shift();
    if(!item)throw new Error(`Unexpected ${transport} provider request #${record.requestOrder.length+1}`);
    if(item.transport!==transport)throw new Error(`Provider request #${record.requestOrder.length+1} went over ${transport}; the script expected ${item.transport}`);
    record.requestOrder.push(transport);return item;
  };
  class RecordingSocket extends EventEmitter{
    static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
    constructor(url,options){
      super();this.readyState=RecordingSocket.CONNECTING;
      record.wsConnections.push({url,headers:recordedHeaders(options?.headers),followRedirects:options?.followRedirects??null});
      queueMicrotask(()=>{this.readyState=RecordingSocket.OPEN;this.emit("open")});
    }
    send(value){
      if(this.readyState!==RecordingSocket.OPEN)throw new Error("closed");
      const payload=String(value);record.wsPayloads.push(payload);
      const lane=JSON.parse(payload).stream_id,item=next("ws");
      void (async()=>{
        for(const event of item.events){await tick();if(this.readyState!==RecordingSocket.OPEN)return;this.emit("message",JSON.stringify({...event,stream_id:lane}))}
        if(item.drop){await tick();this.readyState=RecordingSocket.CLOSED;this.emit("close",1006,"scripted drop")}
      })();
    }
    terminate(){if(this.readyState===RecordingSocket.CLOSED)return;this.readyState=RecordingSocket.CLOSED;this.emit("close",1006,"terminated")}
    close(){this.terminate()}
  }
  const fetchFn=async(url,init={})=>{
    record.fetches.push({url:String(url),method:init.method||"GET",headers:recordedHeaders(init.headers),body:typeof init.body==="string"?init.body:null});
    const item=next("https"),encoder=new TextEncoder(),blocks=item.events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);let index=0;
    const body=new ReadableStream({async pull(controller){await tick();if(index<blocks.length)controller.enqueue(encoder.encode(blocks[index++]));else controller.close()}});
    return new Response(body,{status:200,headers:{"content-type":"text/event-stream; charset=utf-8","x-request-id":"req_golden_"+record.fetches.length}});
  };
  return {RecordingSocket,fetchFn,remaining:()=>queue.length};
}

// sessionOptions and turnOptions let a later case run the same path with extra wiring; the golden cases pass neither.
export async function runBenchmarkPathScenario(name,{sessionOptions=null,prepareRequest=null,turnOptions=null}={}){
  const scenario=BENCHMARK_PATH_SCENARIOS[name];if(!scenario)throw new Error("Unknown benchmark path scenario: "+name);
  const home=await mkdtemp(join(tmpdir(),"trebell-benchmark-path-"));
  const record={requestOrder:[],wsConnections:[],wsPayloads:[],fetches:[],updates:[],events:[],toolCalls:[],responses:[],result:null,error:null};
  const env={OPENAI_API_KEY:"golden-fixture-key",TREBELL_HOME:home,...(scenario.env||{})};
  const scripted=scriptedTransport(scenario,record);
  const manager=new ProviderManager({env,fetchFn:scripted.fetchFn,openAiResponsesWebSocketFactory:options=>new OpenAiResponsesWebSocket({...options,WebSocketClass:scripted.RecordingSocket})});
  // The runner's settings with nothing set in its environment: gpt-6-luna, max effort, the fast tier, the server's reasoning context.
  const provider="openai",model=MODEL,reasoningEffort="max",serviceTier="fast",reasoningContext=null,contextWindow=272_000,compactionThreshold=245_000;
  const tools=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,output:true,workspaceTools:true,terminal:true,process:true,browser:false,computer:false,sourceControl:false,delegation:false});
  const outputStore=new NativeToolOutputStore({directory:join(home,"trebell-output"),environment:env});
  const session=new NativeAgentSession({
    cwd:"/workspace/golden",
    provider,
    model,
    semanticCompletionGate:scenario.semanticCompletionGate===true,
    contextWindow,
    openAiServerCompactionThreshold:compactionThreshold,
    reasoningEffort,
    serviceTier:serviceTier==="default"?null:serviceTier,
    tools,
    permissionMode:"full",
    toolOutputStore:outputStore,
    onEvent:event=>record.events.push(plain(event)),
    onUpdate:update=>record.updates.push(plain(update)),
    executeTool:async call=>{
      record.toolCalls.push(plain({id:call.id,namespace:call.namespace,name:call.name,arguments:call.arguments}));
      const handler=scenario.tools?.[call.namespace+"/"+call.name];if(!handler)throw new Error("Unscripted tool "+call.namespace+"/"+call.name);
      return handler(call.arguments);
    },
    initialMessages:[{role:"system",content:nativeSystemPrompt({tools,permissionMode:"full",projectless:false})}],
    providerTurn:async request=>{
      const source=typeof prepareRequest==="function"?prepareRequest(request):request;
      const response=await manager.turn(provider,{...source,provider,model,reasoningContext},{signal:request.signal,streamResponses:true,...(typeof turnOptions==="function"?turnOptions(request):{})});
      record.responses.push(plain(response));
      return response;
    },
    ...(sessionOptions||{}),
  });
  try{
    await session.start({providerSessionId:"trebell-harbor",model});
    const userParts=[scenario.prompt],prompt=[attachNativePromptProvenance({type:"text",text:scenario.prompt},{kind:"user_input",userParts})];
    try{record.result=plain(await session.prompt(prompt,{maxModelTurns:500,maxToolCalls:5000,maxWallTimeMs:null}))}
    catch(error){record.error=plain({message:String(error?.message||error),code:error?.code??null})}
    record.unusedReplies=scripted.remaining();
    return record;
  }finally{
    await session.close().catch(()=>{});manager.close();
    await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:50});
  }
}
