import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { trebellHome } from "./paths.mjs";

const DEFAULT_STATE = Object.freeze({
  version: 2,
  projects: [],
  threadMeta: {},
  settings: {
    followUpMode: "queue",
    defaultModel: null,
    defaultPermissionMode: "supervised",
    defaultWorkspaceMode: "current",
    autoPull: false,
    worktreeSubmodules: "recursive",
    worktreeCleanup: {mode:"off"},
    appearance: "dark",
    appearanceMode: "dark",
    panelAnimationMs: 0,
    customThemes: [],
    environmentThemeSelections: {},
    notifications: true,
    notificationSound: false,
    backgroundMode: false,
    continueThreadsAfterRestart: false,
    agentDeviceAccess: false,
    keyboardShortcuts: {},
    keybindingRules: [],
    activeEnvironmentId: null,
    activeProjectId: null,
    environmentDefaults: {},
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
function normalizeCleanupRules(rules={}){
  const rawDays=rules?.worktreeAfterDays;const numeric=rawDays==null?null:Math.trunc(Number(rawDays));const worktreeAfterDays=Number.isFinite(numeric)&&numeric>=1?Math.min(3650,numeric):null;
  return {worktreeAfterDays,worktreeOnMerge:Boolean(rules?.worktreeOnMerge),worktreeOnDelete:Boolean(rules?.worktreeOnDelete),worktreeUnchanged:Boolean(rules?.worktreeUnchanged)};
}
function normalizeWorktreeCleanup(value,{allowNull=false}={}){
  if(value==null)return allowNull?null:{mode:"off"};
  if(value?.mode==="custom")return {mode:"custom",rules:normalizeCleanupRules(value.rules)};
  return {mode:"off"};
}
function normalizePullRequestViewedFiles(value){
  if(!value||typeof value!=="object"||Array.isArray(value))return {};
  const out={};
  for(const [key,record] of Object.entries(value).slice(-80)){
    if(!record||typeof record!=="object")continue;const files={};
    for(const [path,mark] of Object.entries(record.files||{}).slice(-1200)){
      const safe=String(path||"").slice(0,1200);if(!safe||!mark||typeof mark!=="object")continue;
      files[safe]={revision:String(mark.revision||"").slice(0,200),viewedAt:Number(mark.viewedAt)||Date.now()};
    }
    out[String(key).slice(0,200)]={headSha:String(record.headSha||"").slice(0,200),files,updatedAt:Number(record.updatedAt)||Date.now()};
  }
  return out;
}
function normalizeEnvironmentId(value){const text=String(value??"").trim();return text||null}
export const PROJECT_SCOPED_SETTING_KEYS=Object.freeze([
  "defaultModel",
  "defaultPermissionMode",
  "defaultWorkspaceMode",
  "worktreeSubmodules",
  "worktreeCleanup",
  "autoPull",
  "agentDeviceAccess",
]);
function normalizeScopedSetting(key,value){
  if(key==="defaultModel"){const text=String(value??"").trim();return text||null}
  if(key==="defaultPermissionMode")return ["supervised","edits","auto","full","read-only"].includes(String(value))?String(value):"supervised";
  if(key==="defaultWorkspaceMode")return ["current","worktree"].includes(String(value))?String(value):"current";
  if(key==="worktreeSubmodules")return ["recursive","top-level","none"].includes(String(value))?String(value):"recursive";
  if(key==="worktreeCleanup")return normalizeWorktreeCleanup(value);
  if(key==="autoPull"||key==="agentDeviceAccess")return Boolean(value);
  return undefined;
}
function normalizeScopedObject(value={}){
  const out={};if(!value||typeof value!=="object"||Array.isArray(value))return out;
  for(const key of PROJECT_SCOPED_SETTING_KEYS)if(Object.prototype.hasOwnProperty.call(value,key))out[key]=normalizeScopedSetting(key,value[key]);
  return out;
}

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
      const projects=Array.isArray(parsed.projects)?parsed.projects.map(project=>({
        ...project,
        environmentId:normalizeEnvironmentId(project?.environmentId),
        settingsOverrides:normalizeScopedObject(project?.settingsOverrides),
      })):[];
      const settings={...clone(DEFAULT_STATE.settings),...rawSettings};
      settings.environmentDefaults=Object.fromEntries(Object.entries(rawSettings.environmentDefaults||{}).map(([id,value])=>[String(id),normalizeScopedObject(value)]));
      if(Number(parsed.version||1)<2&&rawSettings.appearanceMode==="system")settings.appearanceMode="dark";
      settings.worktreeCleanup=normalizeWorktreeCleanup(settings.worktreeCleanup);
      if(!Object.prototype.hasOwnProperty.call(rawSettings,"onboardingComplete")&&projects.length>0)settings.onboardingComplete=true;
      return {
        ...clone(DEFAULT_STATE),
        ...parsed,
        version:DEFAULT_STATE.version,
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
  environmentDefaults(environmentId=null){
    const base={
      defaultModel:normalizeScopedSetting("defaultModel",this.state.settings.defaultModel),
      defaultPermissionMode:normalizeScopedSetting("defaultPermissionMode",this.state.settings.defaultPermissionMode),
      defaultWorkspaceMode:normalizeScopedSetting("defaultWorkspaceMode",this.state.settings.defaultWorkspaceMode),
      worktreeSubmodules:normalizeScopedSetting("worktreeSubmodules",this.state.settings.worktreeSubmodules),
      worktreeCleanup:normalizeScopedSetting("worktreeCleanup",this.state.settings.worktreeCleanup),
      autoPull:Boolean(this.state.settings.autoPull),
      agentDeviceAccess:Boolean(this.state.settings.agentDeviceAccess),
    };
    const id=normalizeEnvironmentId(environmentId);if(!id)return clone(base);
    return {...clone(base),...clone(this.state.settings.environmentDefaults?.[id]||{})};
  }
  projectSettings(path,environmentId=null){
    const project=this.project(path,environmentId);const defaults=this.environmentDefaults(environmentId);const overrides={...(project?.settingsOverrides||{})};
    if(project){
      if(!Object.prototype.hasOwnProperty.call(overrides,"defaultModel")&&project.defaultModel)overrides.defaultModel=project.defaultModel;
      if(!Object.prototype.hasOwnProperty.call(overrides,"defaultPermissionMode")&&project.permissionMode)overrides.defaultPermissionMode=project.permissionMode;
      if(!Object.prototype.hasOwnProperty.call(overrides,"defaultWorkspaceMode")&&project.workspaceMode)overrides.defaultWorkspaceMode=project.workspaceMode;
      if(!Object.prototype.hasOwnProperty.call(overrides,"worktreeSubmodules")&&project.worktreeSubmodules)overrides.worktreeSubmodules=project.worktreeSubmodules;
      if(!Object.prototype.hasOwnProperty.call(overrides,"worktreeCleanup")&&project.worktreeCleanup!=null)overrides.worktreeCleanup=project.worktreeCleanup;
    }
    return {defaults:clone(defaults),overrides:clone(overrides),effective:{...clone(defaults),...clone(overrides)}};
  }
  updateEnvironmentDefaults(environmentId,patch={},resetKeys=[]){
    const id=normalizeEnvironmentId(environmentId);const clean=normalizeScopedObject(patch);
    if(!id){
      const direct={};
      for(const [key,value] of Object.entries(clean))direct[key==="defaultWorkspaceMode"?"defaultWorkspaceMode":key]=value;
      for(const key of resetKeys||[])if(PROJECT_SCOPED_SETTING_KEYS.includes(key))direct[key]=clone(DEFAULT_STATE.settings[key==="defaultWorkspaceMode"?"defaultWorkspaceMode":key]);
      return this.updateSettings(direct);
    }
    const all={...(this.state.settings.environmentDefaults||{})};const current={...(all[id]||{})};
    Object.assign(current,clean);for(const key of resetKeys||[])delete current[key];
    if(Object.keys(current).length)all[id]=current;else delete all[id];
    this.state.settings.environmentDefaults=all;this.#save();return this.environmentDefaults(id);
  }
  updateProjectSettings(path,environmentId,patch={},resetKeys=[]){
    const project=this.state.projects.find(item=>item.path===path&&normalizeEnvironmentId(item.environmentId)===normalizeEnvironmentId(environmentId));
    if(!project)throw new Error("Project was not found");
    const next={...(project.settingsOverrides||{}),...normalizeScopedObject(patch)};for(const key of resetKeys||[])delete next[key];
    project.settingsOverrides=next;
    const mirror={environmentId:normalizeEnvironmentId(environmentId),settingsOverrides:next};
    if(Object.prototype.hasOwnProperty.call(next,"defaultModel")||resetKeys.includes("defaultModel"))mirror.defaultModel=next.defaultModel??null;
    if(Object.prototype.hasOwnProperty.call(next,"defaultPermissionMode")||resetKeys.includes("defaultPermissionMode"))mirror.permissionMode=next.defaultPermissionMode??null;
    if(Object.prototype.hasOwnProperty.call(next,"defaultWorkspaceMode")||resetKeys.includes("defaultWorkspaceMode"))mirror.workspaceMode=next.defaultWorkspaceMode??null;
    if(Object.prototype.hasOwnProperty.call(next,"worktreeSubmodules")||resetKeys.includes("worktreeSubmodules"))mirror.worktreeSubmodules=next.worktreeSubmodules??null;
    if(Object.prototype.hasOwnProperty.call(next,"worktreeCleanup")||resetKeys.includes("worktreeCleanup"))mirror.worktreeCleanup=next.worktreeCleanup??null;
    return {project:this.touchProject(path,mirror),...this.projectSettings(path,environmentId)};
  }
  updateSettings(patch={}){
    if("worktreeSubmodules" in patch&&!['recursive','top-level','none'].includes(String(patch.worktreeSubmodules)))patch={...patch,worktreeSubmodules:'recursive'};
    if("worktreeCleanup" in patch)patch={...patch,worktreeCleanup:normalizeWorktreeCleanup(patch.worktreeCleanup)};
    if("panelAnimationMs" in patch){const value=Math.round(Number(patch.panelAnimationMs)||0);patch={...patch,panelAnimationMs:Math.max(0,Math.min(400,value))}}
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
  project(path,environmentId=null){
    const id=normalizeEnvironmentId(environmentId);
    return clone(this.state.projects.find(project=>project.path===path&&normalizeEnvironmentId(project.environmentId)===id)||null);
  }
  touchProject(path,patch={}){
    const now=Date.now();
    const name=patch.name??null;
    const environmentId=normalizeEnvironmentId(patch.environmentId);
    let project=this.state.projects.find(p=>p.path===path&&normalizeEnvironmentId(p.environmentId)===environmentId);
    if(!project){
      project={id:randomUUID(),path,environmentId,name:name||path.split(/[\\/]/).filter(Boolean).pop()||path,createdAt:now,lastOpenedAt:now,scripts:[],settingsOverrides:{}};
      this.state.projects.push(project);
    }
    if("settingsOverrides" in patch)project.settingsOverrides=normalizeScopedObject(patch.settingsOverrides);
    else if(!project.settingsOverrides||typeof project.settingsOverrides!=="object")project.settingsOverrides={};
    project.environmentId=environmentId;
    project.lastOpenedAt=now;
    if("name" in patch&&patch.name!=null) project.name=String(patch.name);
    if("defaultModel" in patch){project.defaultModel=patch.defaultModel?String(patch.defaultModel):null;if(project.defaultModel)project.settingsOverrides.defaultModel=normalizeScopedSetting("defaultModel",project.defaultModel);else delete project.settingsOverrides.defaultModel}
    if("permissionMode" in patch){project.permissionMode=patch.permissionMode?String(patch.permissionMode):null;if(project.permissionMode)project.settingsOverrides.defaultPermissionMode=normalizeScopedSetting("defaultPermissionMode",project.permissionMode);else delete project.settingsOverrides.defaultPermissionMode}
    if("workspaceMode" in patch){project.workspaceMode=patch.workspaceMode?String(patch.workspaceMode):null;if(project.workspaceMode)project.settingsOverrides.defaultWorkspaceMode=normalizeScopedSetting("defaultWorkspaceMode",project.workspaceMode);else delete project.settingsOverrides.defaultWorkspaceMode}
    if("worktreeSubmodules" in patch){
      const mode=patch.worktreeSubmodules==null?null:String(patch.worktreeSubmodules);
      project.worktreeSubmodules=["recursive","top-level","none"].includes(mode)?mode:null;
      if(project.worktreeSubmodules)project.settingsOverrides.worktreeSubmodules=project.worktreeSubmodules;else delete project.settingsOverrides.worktreeSubmodules;
    }
    if("worktreeCleanup" in patch){project.worktreeCleanup=normalizeWorktreeCleanup(patch.worktreeCleanup,{allowNull:true});if(project.worktreeCleanup!=null)project.settingsOverrides.worktreeCleanup=project.worktreeCleanup;else delete project.settingsOverrides.worktreeCleanup}
    if("managedWorktree" in patch){
      const raw=patch.managedWorktree;
      project.managedWorktree=raw&&typeof raw==="object"?{
        root:String(raw.root||""),branch:String(raw.branch||""),baseBranch:String(raw.baseBranch||""),submodules:["recursive","top-level","none"].includes(raw.submodules)?raw.submodules:"recursive",
        createdAt:Number(raw.createdAt)||Date.now(),cleanedAt:raw.cleanedAt==null?null:Number(raw.cleanedAt)||null,cleanupReason:raw.cleanupReason?String(raw.cleanupReason):null,
      }:null;
    }
    if("pullRequestViewedFiles" in patch)project.pullRequestViewedFiles=normalizePullRequestViewedFiles(patch.pullRequestViewedFiles);
    if("icon" in patch){
      const raw=patch.icon;
      if(!raw) project.icon=null;
      else if(typeof raw==="object"){
        const kind=["emoji","monogram","image"].includes(raw.kind)?raw.kind:null;
        const color=/^#[0-9a-f]{6}$/i.test(String(raw.color||""))?String(raw.color).toLowerCase():"#7c5cff";
        let value=String(raw.value||"").trim();
        if(kind==="emoji")value=value.slice(0,16);
        else if(kind==="monogram")value=value.replace(/[^a-z0-9]/gi,"").slice(0,2).toUpperCase();
        else if(kind==="image"&&(!/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(value)||value.length>2_000_000))value="";
        project.icon=kind&&value?{kind,value,color}:null;
      }
    }
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
      environmentId:normalizeEnvironmentId(entry.environmentId),
      threadId:entry.threadId?String(entry.threadId):null,turnId:entry.turnId?String(entry.turnId):null,at:now,
      usage:{
        totalTokens:Number(usage.totalTokens||0)||0,inputTokens:Number(usage.inputTokens||0)||0,cachedInputTokens:Number(usage.cachedInputTokens||0)||0,
        cacheWriteInputTokens:Number(usage.cacheWriteInputTokens||0)||0,outputTokens:Number(usage.outputTokens||0)||0,reasoningOutputTokens:Number(usage.reasoningOutputTokens||0)||0,
      },
      cost:entry.cost&&Number.isFinite(Number(entry.cost.amount))?{amount:Number(entry.cost.amount),currency:String(entry.cost.currency||"USD")}:null,
    };
    const index=this.state.usageRecords.findIndex(item=>item.id===record.id);
    if(index>=0)this.state.usageRecords[index]={...this.state.usageRecords[index],...record,model:record.model||this.state.usageRecords[index].model,provider:record.provider||this.state.usageRecords[index].provider,environmentId:record.environmentId??this.state.usageRecords[index].environmentId??null};
    else this.state.usageRecords.push(record);
    this.state.usageRecords=this.state.usageRecords.sort((a,b)=>(b.at||0)-(a.at||0)).slice(0,5000);this.#save();return clone(record);
  }
  usage({days=30,limit=1000,environmentIds=undefined}={}){
    const horizon=Math.max(1,Math.min(3650,Number(days)||30));const since=Date.now()-horizon*86400000;
    const selected=Array.isArray(environmentIds)?new Set(environmentIds.map(normalizeEnvironmentId)):null;
    const records=this.state.usageRecords.filter(item=>(item.at||0)>=since&&(!selected||selected.has(normalizeEnvironmentId(item.environmentId)))).slice(0,Math.max(1,Math.min(5000,Number(limit)||1000)));
    const total={totalTokens:0,inputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0,reasoningOutputTokens:0,costUsd:0,costKnown:0};
    const models={},runtimes={},daily={},environments={};
    for(const record of records){
      for(const key of ["totalTokens","inputTokens","cachedInputTokens","cacheWriteInputTokens","outputTokens","reasoningOutputTokens"])total[key]+=Number(record.usage?.[key]||0);
      if(record.cost?.currency==="USD"&&Number.isFinite(Number(record.cost.amount))){total.costUsd+=Number(record.cost.amount);total.costKnown++}
      const modelKey=record.model||"Unknown model";const runtimeKey=record.runtime||"unknown";const day=new Date(record.at).toISOString().slice(0,10);
      for(const [bucket,key] of [[models,modelKey],[runtimes,runtimeKey],[daily,day]]){if(!bucket[key])bucket[key]={tokens:0,costUsd:0,turns:0};bucket[key].tokens+=Number(record.usage?.totalTokens||0);bucket[key].turns++;if(record.cost?.currency==="USD")bucket[key].costUsd+=Number(record.cost.amount||0)}
      const environmentKey=normalizeEnvironmentId(record.environmentId)||"local";
      if(!environments[environmentKey])environments[environmentKey]={tokens:0,costUsd:0,turns:0};
      environments[environmentKey].tokens+=Number(record.usage?.totalTokens||0);environments[environmentKey].turns++;
      if(record.cost?.currency==="USD")environments[environmentKey].costUsd+=Number(record.cost.amount||0);
    }
    return {days:horizon,total,models,runtimes,daily,environments,environmentIds:selected?[...selected]:null,records:clone(records)};
  }
  clearUsage(){const count=this.state.usageRecords.length;this.state.usageRecords=[];this.#save();return count}
}
