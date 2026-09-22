import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { trebellHome } from "./paths.mjs";

const DEFAULT_STATE = Object.freeze({
  version: 1,
  projects: [],
  threadMeta: {},
  settings: {
    followUpMode: "queue",
    defaultPermissionMode: "supervised",
    autoPull: false,
    appearance: "dark",
    appearanceMode: "system",
    notifications: true,
    notificationSound: false,
    backgroundMode: false,
    agentDeviceAccess: false,
    keyboardShortcuts: {},
    keybindingRules: [],
    activeEnvironmentId: null,
    remoteAccessEnabled: false,
    remoteAccessPort: 3211,
    remoteAccessToken: "",
    agentRuntime: "codex",
    agentRuntimeInstanceId: "codex-default",
    agentRuntimeInstances: [],
    customModels: [],
    modelPrices: {},
    modelProvider: "freebuff",
    onboardingComplete: false,
  },
  environments: [],
  stashes: [],
  checkpoints: [],
  usageRecords: [],
});

function clone(value){ return JSON.parse(JSON.stringify(value)); }

export class TrebellStateStore {
  constructor(env=process.env){
    this.path=join(trebellHome(env),"ui-state.json");
    mkdirSync(dirname(this.path),{recursive:true});
    this.state=this.#load();
  }
  #load(){
    try{
      const parsed=JSON.parse(readFileSync(this.path,"utf8"));
      const rawSettings=parsed.settings&&typeof parsed.settings==="object"?parsed.settings:{};
      const projects=Array.isArray(parsed.projects)?parsed.projects:[];
      const settings={...clone(DEFAULT_STATE.settings),...rawSettings};
      if(!Object.prototype.hasOwnProperty.call(rawSettings,"onboardingComplete")&&projects.length>0)settings.onboardingComplete=true;
      return {
        ...clone(DEFAULT_STATE),
        ...parsed,
        settings,
        projects,
        threadMeta:parsed.threadMeta&&typeof parsed.threadMeta==="object"?parsed.threadMeta:{},
        environments:Array.isArray(parsed.environments)?parsed.environments:[],
        stashes:Array.isArray(parsed.stashes)?parsed.stashes:[],
        checkpoints:Array.isArray(parsed.checkpoints)?parsed.checkpoints:[],
        usageRecords:Array.isArray(parsed.usageRecords)?parsed.usageRecords:[],
      };
    }catch{return clone(DEFAULT_STATE);}
  }
  #save(){
    const tmp=this.path+".tmp";
    writeFileSync(tmp,JSON.stringify(this.state,null,2),{encoding:"utf8",mode:0o600});
    renameSync(tmp,this.path);
  }
  snapshot(){ return clone(this.state); }
  settings(){ return clone(this.state.settings); }
  updateSettings(patch={}){
    this.state.settings={...this.state.settings,...patch};
    this.#save();
    return this.settings();
  }
  environments(){ return clone(this.state.environments); }
  upsertEnvironment(profile={}){
    const id=String(profile.id||randomUUID());
    let item=this.state.environments.find(x=>x.id===id);
    if(item) Object.assign(item,profile,{id,updatedAt:Date.now()});
    else{
      item={...profile,id,createdAt:Number(profile.createdAt)||Date.now(),updatedAt:Date.now()};
      this.state.environments.push(item);
    }
    this.#save();
    return clone(item);
  }
  removeEnvironment(id){
    const before=this.state.environments.length;
    this.state.environments=this.state.environments.filter(x=>x.id!==id);
    if(this.state.environments.length!==before)this.#save();
    return before!==this.state.environments.length;
  }
  projects(){ return clone(this.state.projects).sort((a,b)=>(b.lastOpenedAt||0)-(a.lastOpenedAt||0)); }
  touchProject(path,patch={}){
    const now=Date.now();
    const name=patch.name??null;
    let project=this.state.projects.find(p=>p.path===path);
    if(!project){
      project={id:randomUUID(),path,name:name||path.split(/[\\/]/).filter(Boolean).pop()||path,createdAt:now,lastOpenedAt:now,scripts:[]};
      this.state.projects.push(project);
    }
    project.lastOpenedAt=now;
    if("name" in patch&&patch.name!=null) project.name=String(patch.name);
    if("defaultModel" in patch) project.defaultModel=patch.defaultModel?String(patch.defaultModel):null;
    if("permissionMode" in patch) project.permissionMode=patch.permissionMode?String(patch.permissionMode):null;
    if("workspaceMode" in patch) project.workspaceMode=patch.workspaceMode?String(patch.workspaceMode):null;
    if(Array.isArray(patch.scripts)){
      project.scripts=patch.scripts.slice(0,30).map((script,index)=>({
        id:String(script?.id||randomUUID()),
        name:String(script?.name||`Action ${index+1}`).trim().slice(0,80)||`Action ${index+1}`,
        command:String(script?.command||"").trim().slice(0,8000),
        previewUrl:script?.previewUrl?String(script.previewUrl).trim().slice(0,1000):null,
        autoOpenPreview:Boolean(script?.autoOpenPreview),
        runOnWorktreeCreate:Boolean(script?.runOnWorktreeCreate),
        waitForSetup:Boolean(script?.waitForSetup),
      })).filter(script=>script.command);
    }else if(!Array.isArray(project.scripts)) project.scripts=[];
    if("preferredScriptId" in patch) project.preferredScriptId=patch.preferredScriptId?String(patch.preferredScriptId):null;
    if(project.preferredScriptId&&!project.scripts.some(script=>script.id===project.preferredScriptId))project.preferredScriptId=null;
    this.#save();
    return clone(project);
  }
  removeProject(id){
    this.state.projects=this.state.projects.filter(p=>p.id!==id);
    this.#save();
  }
  threadMeta(threadId){
    return clone(this.state.threadMeta[threadId]||{});
  }
  updateThreadMeta(threadId,patch={}){
    const current=this.state.threadMeta[threadId]||{};
    const next={...current,...patch,updatedAt:Date.now()};
    for(const [key,value] of Object.entries(next)) if(value===undefined) delete next[key];
    this.state.threadMeta[threadId]=next;
    this.#save();
    return clone(next);
  }
  listThreadMeta(){ return clone(this.state.threadMeta); }
  addStash({text="",attachments=[],contextChips=[],projectPath=null}={}){
    const stash={id:randomUUID(),text,attachments,contextChips,projectPath,createdAt:Date.now()};
    this.state.stashes.unshift(stash);
    this.state.stashes=this.state.stashes.slice(0,50);
    this.#save();
    return clone(stash);
  }
  listStashes(){ return clone(this.state.stashes); }
  removeStash(id){
    this.state.stashes=this.state.stashes.filter(s=>s.id!==id);
    this.#save();
  }
  addCheckpoint(checkpoint){
    const item={id:checkpoint.id||randomUUID(),createdAt:Date.now(),...checkpoint};
    this.state.checkpoints.unshift(item);
    this.state.checkpoints=this.state.checkpoints.slice(0,200);
    this.#save();
    return clone(item);
  }
  updateCheckpoint(id,patch){
    const item=this.state.checkpoints.find(c=>c.id===id);
    if(!item) return null;
    Object.assign(item,patch);
    this.#save();
    return clone(item);
  }
  checkpoints(threadId=null){
    const items=threadId?this.state.checkpoints.filter(c=>c.threadId===threadId):this.state.checkpoints;
    return clone(items);
  }
  recordUsage(entry={}){
    const usage=entry.usage||{};const now=Number(entry.at)||Date.now();
    const record={
      id:String(entry.id||`${entry.runtime||"unknown"}:${entry.threadId||"unknown"}:${entry.turnId||"unknown"}`),
      runtime:String(entry.runtime||"unknown"),provider:entry.provider?String(entry.provider):null,model:entry.model?String(entry.model):null,
      threadId:entry.threadId?String(entry.threadId):null,turnId:entry.turnId?String(entry.turnId):null,at:now,
      usage:{
        totalTokens:Number(usage.totalTokens||0)||0,inputTokens:Number(usage.inputTokens||0)||0,cachedInputTokens:Number(usage.cachedInputTokens||0)||0,
        cacheWriteInputTokens:Number(usage.cacheWriteInputTokens||0)||0,outputTokens:Number(usage.outputTokens||0)||0,reasoningOutputTokens:Number(usage.reasoningOutputTokens||0)||0,
      },
      cost:entry.cost&&Number.isFinite(Number(entry.cost.amount))?{amount:Number(entry.cost.amount),currency:String(entry.cost.currency||"USD")}:null,
    };
    const index=this.state.usageRecords.findIndex(item=>item.id===record.id);
    if(index>=0)this.state.usageRecords[index]={...this.state.usageRecords[index],...record,model:record.model||this.state.usageRecords[index].model,provider:record.provider||this.state.usageRecords[index].provider};
    else this.state.usageRecords.push(record);
    this.state.usageRecords=this.state.usageRecords.sort((a,b)=>(b.at||0)-(a.at||0)).slice(0,5000);this.#save();return clone(record);
  }
  usage({days=30,limit=1000}={}){
    const horizon=Math.max(1,Math.min(3650,Number(days)||30));const since=Date.now()-horizon*86400000;
    const records=this.state.usageRecords.filter(item=>(item.at||0)>=since).slice(0,Math.max(1,Math.min(5000,Number(limit)||1000)));
    const total={totalTokens:0,inputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0,reasoningOutputTokens:0,costUsd:0,costKnown:0};
    const models={},runtimes={},daily={};
    for(const record of records){
      for(const key of ["totalTokens","inputTokens","cachedInputTokens","cacheWriteInputTokens","outputTokens","reasoningOutputTokens"])total[key]+=Number(record.usage?.[key]||0);
      if(record.cost?.currency==="USD"&&Number.isFinite(Number(record.cost.amount))){total.costUsd+=Number(record.cost.amount);total.costKnown++}
      const modelKey=record.model||"Unknown model";const runtimeKey=record.runtime||"unknown";const day=new Date(record.at).toISOString().slice(0,10);
      for(const [bucket,key] of [[models,modelKey],[runtimes,runtimeKey],[daily,day]]){if(!bucket[key])bucket[key]={tokens:0,costUsd:0,turns:0};bucket[key].tokens+=Number(record.usage?.totalTokens||0);bucket[key].turns++;if(record.cost?.currency==="USD")bucket[key].costUsd+=Number(record.cost.amount||0)}
    }
    return {days:horizon,total,models,runtimes,daily,records:clone(records)};
  }
  clearUsage(){const count=this.state.usageRecords.length;this.state.usageRecords=[];this.#save();return count}
}
