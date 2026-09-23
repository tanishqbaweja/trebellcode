import { test,expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createRemoteControlServer } from "../../src/remote-control.mjs";

const auditDir=fileURLToPath(new URL("../../visual-audit/",import.meta.url));mkdirSync(auditDir,{recursive:true});
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("Trebell Remote pages bounded item history instead of hydrating full Codex turns",async({page})=>{
  test.setTimeout(30_000);
  const calls=[];let notificationSocket=null,threadVisible=true;
  const thread={id:"remote-history",name:"Remote bounded history",preview:"Mobile history fixture",historyMode:"paginated",cwd:"C:\\fixture\\repo",createdAt:Date.now()/1000-20,updatedAt:Date.now()/1000,turns:[]};
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});const sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{
    sockets.add(ws);notificationSocket=ws;ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));if(message.id==null||!message.method)return;calls.push(message);let result={};
      if(message.method==="initialize")result={userAgent:"remote-history-fixture"};
      else if(message.method==="collaborationMode/list")result={data:[
        {name:"Plan",mode:"plan",model:null,reasoning_effort:"medium"},
        {name:"Default",mode:"default",model:null,reasoning_effort:null},
      ]};
      else if(message.method==="thread/list")result={data:threadVisible?[thread]:[],nextCursor:null};
      else if(message.method==="thread/resume"){
        if(message.params.excludeTurns===false)throw new Error("paginated fixture must not request full turns");
        result={thread,itemsBackwardsCursor:"cursor-latest",turnsBackwardsCursor:"turn-cursor",collaborationMode:{mode:"plan",settings:{model:"freebuff/test/coding-fast",reasoning_effort:"medium",developer_instructions:null}}};
      }else if(message.method==="thread/items/list"&&message.params.cursor==="cursor-latest")result={data:[
        {turnId:"turn-2",item:{id:"a2",type:"agentMessage",text:"Second answer"}},
        {turnId:"turn-2",item:{id:"u2",type:"userMessage",text:"Second question"}},
      ],nextCursor:"cursor-older",backwardsCursor:"cursor-latest"};
      else if(message.method==="thread/items/list"&&message.params.cursor==="cursor-older")result={data:[
        {turnId:"turn-1",item:{id:"a1",type:"agentMessage",text:"First answer"}},
        {turnId:"turn-1",item:{id:"u1",type:"userMessage",text:"First question"}},
      ],nextCursor:null,backwardsCursor:"cursor-older"};
      else if(message.method==="turn/start")result={turn:{id:"turn-3",status:"inProgress"}};
      ws.send(JSON.stringify({id:message.id,result}));
    });
  });
  const upstreamPort=await freePort();await new Promise((resolve,reject)=>upstreamHttp.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const environments={discover:async()=>({profiles:[]}),probe:async()=>({ok:true}),execute:async()=>({stdout:"",stderr:""})};
  const remote=await createRemoteControlServer({
    port:0,token:"remote-e2e-token",version:"remote-e2e",targetUrl:"ws://127.0.0.1:"+upstreamPort,enabled:()=>true,environments,host:"127.0.0.1",
    getStatus:async()=>({agentRuntime:"codex",provider:"freebuff",providerReady:true,model:"freebuff/test/coding-fast",cwd:thread.cwd}),
  });
  try{
    await page.setViewportSize({width:390,height:844});
    await page.goto("http://127.0.0.1:"+remote.port+"/");
    await page.evaluate(()=>localStorage.setItem("trebellRemoteSession","remote-e2e-token"));
    await page.reload();
    await expect(page.locator("#connection")).toHaveText("Connected");
    const collaborationMode=page.locator("#collaborationMode");await expect(collaborationMode).toBeVisible();await expect(collaborationMode).toHaveValue("default");
    await page.getByRole("button",{name:"Remote bounded history"}).click();
    await expect(collaborationMode).toHaveValue("plan");
    await expect(page.locator("#transcript")).toHaveText("You: First question\n\nTrebell: First answer\n\nYou: Second question\n\nTrebell: Second answer");
    const resume=calls.find(call=>call.method==="thread/resume");expect(resume?.params?.excludeTurns).toBe(true);
    const pages=calls.filter(call=>call.method==="thread/items/list");expect(pages.map(call=>call.params.cursor)).toEqual(["cursor-latest","cursor-older"]);expect(pages.every(call=>call.params.limit===100&&call.params.sortDirection==="desc")).toBe(true);
    expect(calls.some(call=>call.method==="thread/resume"&&call.params?.excludeTurns===false)).toBe(false);
    const bounds=await page.locator("main").evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));expect(bounds.scroll).toBeLessThanOrEqual(bounds.client+1);
    await page.screenshot({path:auditDir+"remote-bounded-history-390x844.png",fullPage:true});
    await collaborationMode.selectOption("default");await page.locator("#prompt").fill("Continue with the implementation");await page.locator("#send").click();
    await expect.poll(()=>calls.filter(call=>call.method==="turn/start").length).toBe(1);
    const turnStart=calls.find(call=>call.method==="turn/start");expect(turnStart?.params?.collaborationMode).toEqual({mode:"default",settings:{model:"freebuff/test/coding-fast",reasoning_effort:null,developer_instructions:null}});
    notificationSocket.send(JSON.stringify({method:"thread/settings/updated",params:{threadId:thread.id,settings:{collaborationMode:{mode:"plan",settings:{model:"freebuff/test/coding-fast",reasoning_effort:"medium",developer_instructions:null}}}}}));
    await expect(collaborationMode).toHaveValue("plan");
    const listCallsBefore=calls.filter(call=>call.method==="thread/list").length;threadVisible=false;notificationSocket.send(JSON.stringify({method:"thread/deleted",params:{threadId:thread.id}}));
    await expect.poll(()=>calls.filter(call=>call.method==="thread/list").length).toBeGreaterThan(listCallsBefore);
    await expect(page.getByRole("button",{name:"Remote bounded history"})).toHaveCount(0);await expect(page.locator("#transcript")).toHaveText("");
  }finally{
    await remote.close();
    for(const socket of sockets)try{socket.terminate()}catch{}
    upstreamWss.close();await new Promise(resolve=>upstreamHttp.close(resolve));
  }
});
