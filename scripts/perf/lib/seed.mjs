// A Trebell home with the data a long-time user has, written through the real stores (the server reads it as its own): Trebell
// Native as the harness on the OpenAI provider (the fake in fake-openai.mjs answers it), one project at a small real git repository,
// a sidebar of `threads` threads, one thread of `longTurns` turns, one turn of `bigTurnItems` items, a short thread and a thread for
// streamed turns. External harness threads (claude, opencode, cursor, grok) are added when asked, to see what opening one starts.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentThreadStore } from "../../../src/agent-thread-store.mjs";
import { TrebellStateStore } from "../../../src/trebell-state.mjs";
import { catalogMetaPatch } from "../../../ui/src/thread-catalog.js";
import { markdownReply, PERF_MODEL } from "./fake-openai.mjs";

const git=(cwd,args)=>execFileSync("git",args,{cwd,windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,GIT_TERMINAL_PROMPT:"0"}});

// A small real repository: this checkout's src, ui/src, tests, desktop and docs at HEAD, committed once.
export function seedRepository(repoRoot,dir){
  if(existsSync(join(dir,".git")))return dir;
  mkdirSync(dir,{recursive:true});const tar=join(dir,"..","perf-repo.tar");
  git(repoRoot,["archive","--format=tar","-o",tar,"HEAD","src","ui/src","tests","desktop","docs"]);
  execFileSync(process.platform==="win32"?"C:\\Windows\\System32\\tar.exe":"tar",["-xf",tar,"-C",dir],{windowsHide:true,stdio:"ignore"});rmSync(tar,{force:true});
  git(dir,["init","-q","-b","main"]);git(dir,["add","-A"]);git(dir,["-c","user.name=perf","-c","user.email=perf@example.invalid","commit","-qm","Seed the perf repository"]);
  git(dir,["branch","feature/perf-a"]);git(dir,["branch","feature/perf-b"]);
  writeFileSync(join(dir,"src","perf-dirty.mjs"),"export const dirty=true;\n");
  return dir;
}

const userItem=(turnId,text)=>({type:"userMessage",id:"user-"+turnId,clientId:null,content:[{type:"text",text}]});
const reasoningItem=(id,text)=>({type:"reasoning",id,summary:[text],content:[]});
const commandItem=(id,command,output)=>({type:"commandExecution",id,command,cwd:"",processId:null,source:"agent",status:"completed",commandActions:[],aggregatedOutput:output,exitCode:0,durationMs:420});
const fileChangeItem=(id,path,lines)=>({type:"fileChange",id,status:"completed",changes:[{path,kind:"update",diff:"@@ -1,"+lines+" +1,"+lines+" @@\n"+Array.from({length:lines},(_,i)=>(i%2?"+":"-")+"  const value"+i+" = compute("+i+");").join("\n")+"\n"}]});
const replyItem=(id,text)=>({type:"agentMessage",id,text});
const outputLines=(count,seed)=>Array.from({length:count},(_,i)=>"ok "+(seed*31+i)+" tests/agent-relay.test.mjs > keeps the turn order ("+(i*3+seed)%97+" ms)").join("\n")+"\n";

function turn(id,{user,items,startedAt}){return {id,status:"completed",startedAt,completedAt:startedAt+40,durationMs:40000,error:null,items:[userItem(id,user),...items]}}
// A turn as a Native coding turn leaves it: a thought, one or two commands, sometimes an edit, and a Markdown reply.
export function codingTurn(id,index,startedAt,{marker=null,replyBytes=900}={}){
  const items=[reasoningItem(id+"-r",markdownReply(260,{seed:index}).replace(/[#`|]/g,""))];
  items.push(commandItem(id+"-c1","npm test -- tests/agent-relay.test.mjs",outputLines(6+index%10,index)));
  if(index%3===0)items.push(fileChangeItem(id+"-f","src/agent-relay.mjs",6+index%8));
  if(index%4===1)items.push(commandItem(id+"-c2","git diff --stat",outputLines(3,index+1)));
  items.push(replyItem(id+"-a",(marker?marker+"\n\n":"")+markdownReply(replyBytes+(index%7)*120,{seed:index+3})));
  return turn(id,{user:"Turn "+index+": "+markdownReply(140,{seed:index+9}).replace(/[#`|\n]/g," "),items,startedAt});
}
// One long turn of `count` items: tool calls with output, edits, thoughts and short commentary, then the final reply.
function bigTurn(id,count,startedAt,marker){
  const items=[];
  for(let i=0;items.length<count-1;i++){
    const kind=i%5;
    if(kind===0)items.push(reasoningItem(id+"-r"+i,markdownReply(220,{seed:i}).replace(/[#`|]/g,"")));
    else if(kind===1)items.push(commandItem(id+"-c"+i,"node --test tests/part-"+i+".test.mjs",outputLines(4+i%30,i)));
    else if(kind===2)items.push(fileChangeItem(id+"-f"+i,"src/module-"+(i%40)+".mjs",4+i%12));
    else if(kind===3)items.push(commandItem(id+"-g"+i,"rg -n \"handleUpdate\" src",outputLines(2+i%6,i+5)));
    else items.push(replyItem(id+"-m"+i,markdownReply(160,{seed:i+1}).replace(/^#+ /,"")));
  }
  items.push(replyItem(id+"-final",marker+"\n\n"+markdownReply(2400,{seed:7})));
  return turn(id,{user:"Refactor the relay so each tool call is written once.",items,startedAt});
}

export const PERF_THREADS=Object.freeze({long:"Perf long thread",big:"Perf big turn",short:"Perf short thread",stream:"Perf stream target"});
export const marker=name=>"PERFMARK "+name.replace(/\s+/g,"-");

export function seedHome({home,repo,threads=500,longTurns=1000,bigTurnItems=600,externalRuntimes=[]}={}){
  mkdirSync(home,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env),store=new AgentThreadStore(env);
  if(store.list().length)return describe(store,state,repo);
  state.updateSettings({onboardingComplete:true,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",defaultModel:PERF_MODEL,appearance:"dark",appearanceMode:"dark",defaultPermissionMode:"auto",defaultWorkspaceMode:"current",followUpMode:"queue",activeEnvironmentId:null});
  state.touchProject(repo,{name:"perf-repo"});
  const providerMeta={runtimeInstanceId:"native-default",modelProvider:"openai",permissionProfile:"auto",projectless:false,environmentId:null};
  const now=Math.floor(Date.now()/1000);let sequence=0;
  const save=(name,turns,{updatedAt,runtime="native",meta=providerMeta,model=PERF_MODEL}={})=>{
    const thread=store.importHistory({runtime,cwd:repo,providerSessionId:"perf-"+runtime+"-"+(++sequence),model,name,preview:name,providerMeta:{...meta,runtimeInstanceId:runtime+"-default"},turns,createdAt:updatedAt-3600,updatedAt});
    state.updateThreadMeta(thread.id,{projectless:false,environmentId:null,cwd:repo,runtime,runtimeInstanceId:runtime+"-default",...catalogMetaPatch(thread,{runtime,provider:runtime==="native"?"openai":runtime,runtimeInstanceId:runtime+"-default"})});
    return thread;
  };
  // Filler threads first (older), so the named threads sort to the top of the sidebar.
  for(let i=0;i<threads-4-externalRuntimes.length;i++){
    const name="Perf filler "+String(i).padStart(4,"0"),count=1+(i%4),start=now-86400*30+i*600;
    save(name,Array.from({length:count},(_,t)=>codingTurn("filler-"+i+"-"+t,i+t,start+t*60,{marker:t===count-1?marker(name):null,replyBytes:500})),{updatedAt:start+count*60});
  }
  for(const runtime of externalRuntimes){const name="Perf "+runtime+" thread";save(name,[codingTurn(runtime+"-0",1,now-7200,{marker:marker(name),replyBytes:400})],{updatedAt:now-7000,runtime,model:null})}
  save(PERF_THREADS.short,Array.from({length:3},(_,t)=>codingTurn("short-"+t,t,now-5000+t*60,{marker:t===2?marker(PERF_THREADS.short):null})),{updatedAt:now-4000});
  save(PERF_THREADS.big,[bigTurn("big-0",bigTurnItems,now-3000,marker(PERF_THREADS.big))],{updatedAt:now-2900});
  save(PERF_THREADS.long,Array.from({length:longTurns},(_,t)=>codingTurn("long-"+t,t,now-86400*7+t*300,{marker:t===longTurns-1?marker(PERF_THREADS.long):null})),{updatedAt:now-2000});
  save(PERF_THREADS.stream,[codingTurn("stream-0",0,now-1000,{marker:marker(PERF_THREADS.stream)})],{updatedAt:now-900});
  return describe(store,state,repo);
}

function describe(store,state,repo){
  const list=store.list(),byName=Object.fromEntries(list.map(thread=>[thread.name,thread.id]));
  const sizes={};for(const name of Object.values(PERF_THREADS)){const thread=store.get(byName[name]);sizes[name]={id:byName[name],turns:thread?.turns?.length||0,items:(thread?.turns||[]).reduce((sum,turn)=>sum+(turn.items?.length||0),0),historyBytes:JSON.stringify(thread?.turns||[]).length}}
  return {repo,threadCount:list.length,byName,sizes,projects:state.projects().map(project=>({id:project.id,path:project.path,name:project.name}))};
}
