import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { attachCodexRelay } from "../../src/codex-relay.mjs";

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});

// A Codex app-server that keeps the turns it runs, so a reload reads them back: it opens threads on item pages (with a turn
// cursor beside them, as Codex does) and answers turn/start by running the next scripted turn. An item page holds the items
// of pageTurns turns (or pageItems items, cutting through turns) and a turn page outcomeTurns turns (all of them by default),
// newest first. thread/items/list with a turnId reads that turn alone, in the order asked for; failTurnItems makes that call
// fail. messageOnlyPages leaves every item but messages and thoughts out of the item pages, as Codex builds without tool items do;
// timeline then serves every item on thread/timeline/list, in one page. calls logs every request. A step can start a turn of
// the harness's own, with no user message, as a goal continuing does.
export async function startCodexHarness(thread,script,{seed=[],pageTurns=Infinity,pageItems=null,outcomeTurns=Infinity,failTurnItems=false,messageOnlyPages=false,timeline=false}={}){
  const turns=[...seed],calls=[];let socket=null,interrupt=null,userSteps=0;
  const paged=items=>messageOnlyPages?items.filter(item=>["userMessage","agentMessage","reasoning"].includes(item.type)):items;
  const emit=message=>socket?.send(JSON.stringify(message));
  const now=()=>Math.floor(Date.now()/1000);
  const toolsFor=turn=>({
    emit:value=>emit(value),threadId:thread.id,
    finish:(status,extra={})=>{Object.assign(turn,{status,completedAt:now(),durationMs:2100,...extra});emit({method:"turn/completed",params:{threadId:thread.id,turn:{...turn}}})},
    onInterrupt:handler=>{interrupt=handler},
    startOwnTurn:step=>{
      const own={id:"codex-turn-"+(turns.length+1),status:"inProgress",startedAt:now(),completedAt:null,durationMs:null,error:null,items:[]};
      turns.push(own);emit({method:"turn/started",params:{threadId:thread.id,turn:{...own,items:[]}}});setTimeout(()=>step(own,toolsFor(own)),60);
    },
  });
  // A cursor "<kind>@<n>" starts a page n turns back from the newest; the page names the cursor of the one before it.
  const pageOf=(kind,cursor,size)=>{
    const [name,offset]=String(cursor||"").split("@"),start=Number(offset);if(name!==kind||!Number.isInteger(start))return {data:[],next:null};
    const end=start+size;return {data:[...turns].reverse().slice(start,end),next:end<turns.length?kind+"@"+end:null};
  };
  const upstreamHttp=createServer(),wss=new WebSocketServer({noServer:true});
  upstreamHttp.on("upgrade",(req,raw,head)=>wss.handleUpgrade(req,raw,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    socket=ws;ws.on("message",raw=>{
      const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;
      const params=message.params||{};let result={},after=null;calls.push({method:message.method,params});
      if(message.method==="initialize")result={userAgent:"turn-failure-codex-fixture"};
      else if(message.method==="thread/list")result={data:[{...thread,turns:[]}],nextCursor:null};
      else if(message.method==="thread/resume")result=params.excludeTurns===false?{thread:{...thread,turns}}:{thread:{...thread,turns:[],historyMode:"paginated"},itemsBackwardsCursor:turns.length?"items@0":null,turnsBackwardsCursor:turns.length?"turns@0":null};
      else if(message.method==="thread/items/list"&&params.turnId){
        if(failTurnItems){ws.send(JSON.stringify({id:message.id,error:{code:-32000,message:"This turn's items could not be read."}}));return}
        const turn=turns.find(entry=>entry.id===params.turnId),entries=paged(turn?.items||[]).map(item=>({turnId:turn.id,item})),ordered=String(params.sortDirection||"asc")==="desc"?entries.reverse():entries;
        const start=Number(String(params.cursor||"").split("@")[1])||0,end=start+Math.max(1,Math.min(500,Number(params.limit)||100));
        result={data:ordered.slice(start,end),nextCursor:end<ordered.length?"turn-items@"+end:null,backwardsCursor:null};
      }
      else if(message.method==="thread/items/list"&&pageItems){
        const entries=[...turns].reverse().flatMap(turn=>paged(turn.items).map(item=>({turnId:turn.id,item})).reverse()),[name,offset]=String(params.cursor||"").split("@"),start=Number(offset),end=start+pageItems;
        result=name==="items"&&Number.isInteger(start)?{data:entries.slice(start,end),nextCursor:end<entries.length?"items@"+end:null,backwardsCursor:"items@0"}:{data:[],nextCursor:null,backwardsCursor:"items@0"};
      }
      else if(message.method==="thread/items/list"){const page=pageOf("items",params.cursor,pageTurns);result={data:page.data.flatMap(turn=>paged(turn.items).map(item=>({turnId:turn.id,item})).reverse()),nextCursor:page.next,backwardsCursor:"items@0"}}
      else if(message.method==="thread/turns/list"){const page=pageOf("turns",params.cursor,outcomeTurns);result={data:page.data.map(turn=>({...turn,items:params.itemsView==="notLoaded"?[]:turn.items,itemsView:params.itemsView||"summary"})),nextCursor:page.next,backwardsCursor:null}}
      else if(message.method==="turn/start"){
        const step=script[userSteps++],id="codex-turn-"+(turns.length+1),text=(params.input||[]).map(part=>part?.text||"").join("");
        const turn={id,status:"inProgress",startedAt:now(),completedAt:null,durationMs:null,error:null,items:[{id:"user-"+id,type:"userMessage",content:[{type:"text",text}]}]};
        turns.push(turn);result={turn:{...turn,items:[]}};after=()=>step(turn,toolsFor(turn));
      }
      else if(message.method==="turn/interrupt"){const handler=interrupt;interrupt=null;after=()=>handler?.()}
      else if(message.method==="thread/goal/get")result={goal:null};
      else if(message.method==="thread/attachment/list"||message.method==="thread/queue/list")result={data:[],nextCursor:null};
      else if(message.method==="thread/timeline/list")result={data:timeline?turns.flatMap(turn=>[{type:"turnStarted",turnId:turn.id},...turn.items.map(item=>({type:"item",turnId:turn.id,item})),...(turn.status==="inProgress"?[]:[{type:"turnCompleted",turnId:turn.id}])]):[],nextCursor:null,activeRealtimeSessionAtPageStart:null};
      else if(message.method==="skills/list"||message.method==="collaborationMode/list"||message.method==="threadSection/list")result={data:[]};
      else if(message.method==="thread/runtimeInstances/list")result={supported:false,currentInstanceId:null,items:[]};
      else if(message.method==="thread/unsubscribe")result={status:"unsubscribed"};
      ws.send(JSON.stringify({id:message.id,result}));
      if(after)setTimeout(after,60);
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachCodexRelay(relayHttp,{targetUrl:"ws://127.0.0.1:"+upstreamPort});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayHttp.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  return {
    wsUrl:"ws://127.0.0.1:"+relayPort+"/api/codex/ws",turns,calls,
    async close(){relay.close();try{socket?.terminate()}catch{}wss.close();await Promise.all([new Promise(resolve=>relayHttp.close(resolve)),new Promise(resolve=>upstreamHttp.close(resolve))])},
  };
}

// The app's own API answered for a Codex window on the harness, with the thread outside any project.
export async function routeCodexApp(page,harness,thread){
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"openai",defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",followUpMode:"queue"};
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"codex",agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:process.cwd(),platform:process.platform,version:"turn-failure-codex",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[],threadMeta:{[thread.id]:{projectless:true,environmentId:null}}}));
  await page.route(/\/api\/models$/,route=>json(route,{models:["test/coding-fast"],metadata:{provider:"openai",models:[{id:"test/coding-fast",name:"Coding Fast",provider:"openai",agent:"Codex"}]}}));
  await page.route(/\/api\/projects(?:\?.*)?$/,route=>json(route,{projects:[]}));
  await page.route(/\/api\/thread-meta(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?route.request().postDataJSON()?.patch||{}:{projectless:true,environmentId:null}));
  await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>json(route,{supported:false}));
  await page.route(/\/api\/verification\/plan-turn$/,route=>json(route,{supported:false}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.route(/\/api\/recovery$/,route=>json(route,{enabled:false,items:[]}));
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
}
