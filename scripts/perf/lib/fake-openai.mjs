// A scripted OpenAI Responses endpoint for the perf server: it answers https://api.openai.com/v1/* in-process (the server tap routes
// fetch here), so a Trebell Native turn streams a long reply through the real provider adapter, relay and UI with no network call.
// Replies are Markdown of a chosen size streamed as response.output_text.delta events at a chosen pace; the completion gate gets
// a "complete" verdict; /models lists the perf model.
export const PERF_MODEL="gpt-5.6";

const WORDS="the relay keeps each turn in order while the session writes its reply and the store saves every item once the call returns so a reader sees the same history after a reload".split(" ");
function sentence(seed,words=14){let out=[];for(let i=0;i<words;i++)out.push(WORDS[(seed*7+i*13)%WORDS.length]);const text=out.join(" ");return text[0].toUpperCase()+text.slice(1)+"."}

// Markdown of about `bytes` characters with the block kinds a coding reply has: headings, paragraphs with inline code and links,
// bullet and numbered lists, fenced code, and a table.
export function markdownReply(bytes,{seed=1}={}){
  const blocks=[];let size=0,index=0;
  while(size<bytes){
    const kind=index%6;let block="";
    if(kind===0)block="## Step "+(index/6+1)+": "+sentence(seed+index,5).replace(/\.$/,"");
    else if(kind===1)block=sentence(seed+index)+" See `src/agent-relay.mjs` and [the store](src/agent-thread-store.mjs) for the "+sentence(seed+index+1,6).toLowerCase()+" "+sentence(seed+index+2,18);
    else if(kind===2)block=Array.from({length:4},(_,i)=>"- "+sentence(seed+index+i,9)+" (`item-"+i+"`)").join("\n");
    else if(kind===3)block="```js\n"+Array.from({length:8},(_,i)=>"const value"+i+" = store.get(threadId)?.turns?.at(-1)?.items?.length ?? "+i+"; // "+sentence(seed+i,4)).join("\n")+"\n```";
    else if(kind===4)block="| Column | Before | After |\n| --- | --- | --- |\n"+Array.from({length:4},(_,i)=>"| row "+i+" | "+(i*17)+" ms | "+(i*5)+" ms |").join("\n");
    else block=Array.from({length:3},(_,i)=>(i+1)+". "+sentence(seed+index+i,11)).join("\n");
    blocks.push(block);size+=block.length+2;index++;
  }
  return blocks.join("\n\n").slice(0,bytes);
}

const GATE_VERDICT=JSON.stringify({status:"complete",progress:"improved",edit_support:"unsupported",mutation_safety:"allowed",recovery_mode:"none",constraint_audit:[],unresolved:[],reason:"The perf turn did what it was asked."});

function usage(outputChars){const output=Math.max(1,Math.round(outputChars/4));return {input_tokens:1200,input_tokens_details:{cached_tokens:0},output_tokens:output,output_tokens_details:{reasoning_tokens:0},total_tokens:1200+output}}
function completed(id,model,text){return {type:"response.completed",response:{id,object:"response",model,status:"completed",output:[{type:"message",id:"msg_"+id,role:"assistant",status:"completed",content:[{type:"output_text",text,annotations:[]}]}],usage:usage(text.length)}}}
const sse=event=>"event: "+event.type+"\ndata: "+JSON.stringify(event)+"\n\n";

// A fetch handler: script() returns the next reply plan {bytes,chunk,intervalMs} (or null for a short reply); log receives a
// summary of every call.
export function createFakeOpenAi({script,log}){
  let calls=0;
  return async function fakeOpenAi(url,init={}){
    const path=new URL(url).pathname,method=String(init.method||"GET").toUpperCase();
    if(path.endsWith("/models"))return new Response(JSON.stringify({object:"list",data:[{id:PERF_MODEL,object:"model",owned_by:"perf"},{id:"gpt-5.6-mini",object:"model",owned_by:"perf"}]}),{status:200,headers:{"content-type":"application/json"}});
    if(!(path.endsWith("/responses")&&method==="POST"))return new Response(JSON.stringify({error:{message:"perf fake: no route "+method+" "+path}}),{status:404,headers:{"content-type":"application/json"}});
    const raw=typeof init.body==="string"?init.body:init.body?Buffer.from(init.body).toString("utf8"):"";
    let body={};try{body=JSON.parse(raw)}catch{}
    const id="resp_perf_"+(++calls),model=String(body.model||PERF_MODEL),gate=raw.includes("trebell_completion_gate");
    const plan=gate?null:script();
    const text=gate?GATE_VERDICT:plan?markdownReply(plan.bytes,{seed:calls}):"Done. The perf turn finished.";
    const chunk=Math.max(1,Number(plan?.chunk)||text.length),intervalMs=Math.max(0,Number(plan?.intervalMs)||0);
    log?.({at:Date.now(),id,gate,stream:Boolean(body.stream),requestBytes:raw.length,replyBytes:text.length,chunk,intervalMs,tools:Array.isArray(body.tools)?body.tools.length:0,inputItems:Array.isArray(body.input)?body.input.length:0});
    const encoder=new TextEncoder();
    if(!body.stream)return new Response(JSON.stringify(completed(id,model,text).response),{status:200,headers:{"content-type":"application/json"}});
    let offset=0,timer=null;
    const stream=new ReadableStream({
      start(controller){
        controller.enqueue(encoder.encode(sse({type:"response.created",response:{id,model,status:"in_progress",output:[]}})+sse({type:"response.output_item.added",output_index:0,item:{type:"message",id:"msg_"+id,role:"assistant",status:"in_progress",content:[]}})));
        const step=()=>{
          if(offset>=text.length){controller.enqueue(encoder.encode(sse({type:"response.output_text.done",output_index:0,content_index:0,text})+sse(completed(id,model,text))));controller.close();return}
          const delta=text.slice(offset,offset+chunk);offset+=delta.length;
          controller.enqueue(encoder.encode(sse({type:"response.output_text.delta",output_index:0,content_index:0,item_id:"msg_"+id,delta})));
          timer=setTimeout(step,intervalMs);
        };
        step();
      },
      cancel(){clearTimeout(timer)},
    });
    return new Response(stream,{status:200,headers:{"content-type":"text/event-stream"}});
  };
}
