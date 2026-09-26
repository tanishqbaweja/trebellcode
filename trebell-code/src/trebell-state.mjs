import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { trebellHome } from "./paths.mjs";
import { normalizeMcpServers } from "./mcp-registry.mjs";
import { redactSecretValue, withoutSecretEnvironment } from "./secret-redactor.mjs";
import { normalizeRecipes } from "./recipes.mjs";
import { normalizeProjectHooks } from "./project-hooks.mjs";
import { SqliteStateCollections,threadMetaCatalogProjection } from "./sqlite-state-collections.mjs";

const DEFAULT_STATE = Object.freeze({
  version: 2,
  projects: [],
  threadMeta: {},
  settings: {
    followUpMode: "queue",
    autoCompactContext: true,
    autoCompactThresholdPercent: 85,
    defaultModel: null,
    defaultPermissionMode: "supervised",
    defaultWorkspaceMode: "current",
    autoPull: false,
    sourceControlMergeMethod: "squash",
    sourceControlTextStyle: "repository",
    sourceControlTextModel: null,
    sourceControlCustomInstructions: "",
    sourceControlFollowTemplates: true,
    worktreeSubmodules: "recursive",
    worktreeCleanup: {mode:"off"},
    storageCleanup: {attachmentsAfterDays:null,terminalHistoryAfterDays:null},
    appearance: "dark",
    appearanceMode: "dark",
    panelAnimationMs: 0,
    customThemes: [],
    environmentThemeSelections: {},
    notifications: true,
    notificationSound: false,
    backgroundMode: false,
    continueThreadsAfterRestart: false,
    autoSettleMergedThreads: false,
    keyboardShortcuts: {},
    keybindingRules: [],
    activeEnvironmentId: null,
    activeProjectId: null,
    environmentDefaults: {},
    agentRuntime: "codex",
    agentRuntimeInstanceId: "codex-default",
    agentRuntimeInstances: [],
    customModels: [],
    modelPrices: {},
    mcpServers: [],
    modelProvider: "freebuff",
    onboardingComplete: false,
  },
  environments: [],
  stashes: [],
  checkpoints: [],
  usageRecords: [],
  verificationRecords: [],
  repositoryKnowledge: [],
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
function normalizeRetentionDays(value){
  if(value==null||value==="")return null;
  const numeric=Math.trunc(Number(value));
  return Number.isFinite(numeric)&&numeric>=1?Math.min(3650,numeric):null;
}
function normalizeStorageCleanup(value={}){
  const raw=value&&typeof value==="object"&&!Array.isArray(value)?value:{};
  return {
    attachmentsAfterDays:normalizeRetentionDays(raw.attachmentsAfterDays),
    terminalHistoryAfterDays:normalizeRetentionDays(raw.terminalHistoryAfterDays),
  };
}
function normalizeRuntimeInstances(value){
  if(!Array.isArray(value))return [];
  return value.slice(0,100).filter(item=>item&&typeof item==="object").map(item=>({...item,environment:withoutSecretEnvironment(item.environment)}));
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
function normalizeCloneJob(value){
  if(!value||typeof value!=="object")return null;
  const status=["running","cancelling","completed","failed","cancelled"].includes(String(value.status))?String(value.status):"failed";
  return {
    id:String(value.id||"").slice(0,120),url:String(value.url||"").slice(0,4000),status,
    progress:Math.max(0,Math.min(100,Number(value.progress)||0)),phase:String(value.phase||"").slice(0,120),
    error:value.error?String(value.error).slice(0,4000):null,startedAt:Number(value.startedAt)||Date.now(),
    completedAt:value.completedAt==null?null:Number(value.completedAt)||null,tempPath:value.tempPath?String(value.tempPath).slice(0,4000):null,
  };
}
export const PROJECT_SCOPED_SETTING_KEYS=Object.freeze([
  "defaultModel",
  "defaultPermissionMode",
  "defaultWorkspaceMode",
  "worktreeSubmodules",
  "worktreeCleanup",
  "autoPull",
  "sourceControlMergeMethod",
  "sourceControlTextStyle",
  "sourceControlTextModel",
  "sourceControlCustomInstructions",
  "sourceControlFollowTemplates",
]);
function normalizeScopedSetting(key,value){
  if(key==="defaultModel"){const text=String(value??"").trim();return text||null}
  if(key==="defaultPermissionMode")return ["supervised","edits","auto","full","read-only"].includes(String(value))?String(value):"supervised";
  if(key==="defaultWorkspaceMode")return ["current","worktree"].includes(String(value))?String(value):"current";
  if(key==="worktreeSubmodules")return ["recursive","top-level","none"].includes(String(value))?String(value):"recursive";
  if(key==="worktreeCleanup")return normalizeWorktreeCleanup(value);
  if(key==="sourceControlMergeMethod")return ["squash","merge","rebase"].includes(String(value))?String(value):"squash";
  if(key==="sourceControlTextStyle"){const text=String(value);if(text==="concise"||text==="descriptive")return "repository";return ["repository","conventional","custom"].includes(text)?text:"repository"}
  if(key==="sourceControlTextModel"){const text=String(value??"").trim();return text||null}
  if(key==="sourceControlCustomInstructions")return String(value??"").trim().slice(0,12000);
  if(key==="sourceControlFollowTemplates")return value!==false;
  if(key==="autoPull")return Boolean(value);
  return undefined;
}
function normalizeScopedObject(value={}){
  const out={};if(!value||typeof value!=="object"||Array.isArray(value))return out;
  for(const key of PROJECT_SCOPED_SETTING_KEYS)if(Object.prototype.hasOwnProperty.call(value,key))out[key]=normalizeScopedSetting(key,value[key]);
  return out;
}

export class TrebellStateStore {
  constructor(env=process.env){
    this.env=env;
    this.path=join(trebellHome(env),"ui-state.json");
    mkdirSync(dirname(this.path),{recursive:true});
    this.needsRewrite=false;
    this.state=this.#load();
    this.collections=null;
    try{
      const collections=new SqliteStateCollections(env);
      const legacy=redactSecretValue({threadMeta:this.state.threadMeta,checkpoints:this.state.checkpoints,usageRecords:this.state.usageRecords,verificationRecords:this.state.verificationRecords,repositoryKnowledge:this.state.repositoryKnowledge},{environment:env,maxDepth:20,maxArray:10000,maxFields:5000});
      const migrated=collections.importLegacy(legacy);this.collections=collections;
      this.state.threadMeta={};this.state.checkpoints=[];this.state.usageRecords=[];this.state.verificationRecords=[];this.state.repositoryKnowledge=[];
      if(migrated||this.legacyCollectionsPresent)this.needsRewrite=true;
    }catch{this.collections=null}
    if(this.needsRewrite)this.#save();
  }
  #load(){
    try{
      const parsed=JSON.parse(readFileSync(this.path,"utf8"));
      this.legacyCollectionsPresent=["threadMeta","checkpoints","usageRecords","verificationRecords","repositoryKnowledge"].some(key=>Object.prototype.hasOwnProperty.call(parsed,key));
      const rawSettings=parsed.settings&&typeof parsed.settings==="object"?parsed.settings:{};
      const retiredCompanionSetting=["agentDeviceAccess","remoteAccessEnabled","remoteAccessPort","remoteAccessToken"].some(key=>Object.prototype.hasOwnProperty.call(rawSettings,key))
        ||Object.values(rawSettings.environmentDefaults||{}).some(value=>value&&typeof value==="object"&&Object.prototype.hasOwnProperty.call(value,"agentDeviceAccess"))
        ||(Array.isArray(parsed.projects)&&parsed.projects.some(project=>project?.settingsOverrides&&Object.prototype.hasOwnProperty.call(project.settingsOverrides,"agentDeviceAccess")));
      if(retiredCompanionSetting)this.needsRewrite=true;
      const projects=Array.isArray(parsed.projects)?parsed.projects.map(project=>({
        ...project,
        environmentId:normalizeEnvironmentId(project?.environmentId),
        settingsOverrides:normalizeScopedObject(project?.settingsOverrides),
        cloneJob:normalizeCloneJob(project?.cloneJob),
      })):[];
      const settings={...clone(DEFAULT_STATE.settings),...rawSettings};
      delete settings.remoteAccessToken;
      delete settings.remoteAccessEnabled;
      delete settings.remoteAccessPort;
      delete settings.agentDeviceAccess;
      settings.environmentDefaults=Object.fromEntries(Object.entries(rawSettings.environmentDefaults||{}).map(([id,value])=>[String(id),normalizeScopedObject(value)]));
      if(Number(parsed.version||1)<2&&rawSettings.appearanceMode==="system")settings.appearanceMode="dark";
      settings.worktreeCleanup=normalizeWorktreeCleanup(settings.worktreeCleanup);
      settings.storageCleanup=normalizeStorageCleanup(settings.storageCleanup);
      settings.sourceControlMergeMethod=normalizeScopedSetting("sourceControlMergeMethod",settings.sourceControlMergeMethod);
      settings.sourceControlTextStyle=normalizeScopedSetting("sourceControlTextStyle",settings.sourceControlTextStyle);
      settings.sourceControlTextModel=normalizeScopedSetting("sourceControlTextModel",settings.sourceControlTextModel);
      settings.sourceControlCustomInstructions=normalizeScopedSetting("sourceControlCustomInstructions",settings.sourceControlCustomInstructions);
      settings.sourceControlFollowTemplates=normalizeScopedSetting("sourceControlFollowTemplates",settings.sourceControlFollowTemplates);
      const normalizedMcpServers=normalizeMcpServers(settings.mcpServers);
      if(JSON.stringify(rawSettings.mcpServers||[])!==JSON.stringify(normalizedMcpServers))this.needsRewrite=true;
      settings.mcpServers=normalizedMcpServers;
      const normalizedRuntimeInstances=normalizeRuntimeInstances(settings.agentRuntimeInstances);
      if(JSON.stringify(rawSettings.agentRuntimeInstances||[])!==JSON.stringify(normalizedRuntimeInstances))this.needsRewrite=true;
      settings.agentRuntimeInstances=normalizedRuntimeInstances;
      if(!Object.prototype.hasOwnProperty.call(rawSettings,"onboardingComplete")&&projects.length>0)settings.onboardingComplete=true;
      return {
        ...clone(DEFAULT_STATE),
        ...parsed,
        version:DEFAULT_STATE.version,
        settings,
        projects,
        threadMeta:parsed.threadMeta&&typeof parsed.threadMeta==="object"?parsed.threadMeta:{},
        environments:Array.isArray(parsed.environments)?parsed.environments.map(profile=>({...profile,enabled:profile?.enabled!==false})):[],
        stashes:Array.isArray(parsed.stashes)?parsed.stashes:[],
        checkpoints:Array.isArray(parsed.checkpoints)?parsed.checkpoints:[],
        usageRecords:Array.isArray(parsed.usageRecords)?parsed.usageRecords:[],
        verificationRecords:Array.isArray(parsed.verificationRecords)?parsed.verificationRecords:[],
        repositoryKnowledge:Array.isArray(parsed.repositoryKnowledge)?parsed.repositoryKnowledge:[],
      };
    }catch{this.legacyCollectionsPresent=false;return clone(DEFAULT_STATE);}
  }
  #save(){
    const tmp=this.path+".tmp";
    const persisted=this.collections?{...this.state}:this.state;
    if(this.collections){delete persisted.threadMeta;delete persisted.checkpoints;delete persisted.usageRecords;delete persisted.verificationRecords;delete persisted.repositoryKnowledge}
    writeFileSync(tmp,JSON.stringify(persisted,null,2),{encoding:"utf8",mode:0o600});
    renameSync(tmp,this.path);
  }
  snapshot({includeCollections=true,threadMetaView="full",threadMetaLimit=null}={}){
    const out=clone(this.state);
    if(threadMetaView==="catalog"&&threadMetaLimit!=null){const page=this.threadMetaCatalogPage({limit:threadMetaLimit});out.threadMeta=page.threadMeta;out.threadMetaNextCursor=page.nextCursor}
    else if(this.collections)out.threadMeta=threadMetaView==="catalog"?this.collections.threadMetaCatalogMap():this.collections.threadMetaMap();
    else if(threadMetaView==="catalog")out.threadMeta=Object.fromEntries(Object.entries(out.threadMeta||{}).map(([threadId,item])=>[threadId,threadMetaCatalogProjection(item)]));
    if(!includeCollections){delete out.checkpoints;delete out.usageRecords;delete out.verificationRecords;delete out.repositoryKnowledge;return out}if(!this.collections)return out;
    out.checkpoints=this.collections.checkpoints();out.usageRecords=this.collections.usage({since:0,limit:5000});out.verificationRecords=this.collections.verificationRecords({limit:1000});out.repositoryKnowledge=this.collections.knowledge({limit:5000});return out;
  }
  settings(){ return clone(this.state.settings); }
  environmentDefaults(environmentId=null){
    const base={
      defaultModel:normalizeScopedSetting("defaultModel",this.state.settings.defaultModel),
      defaultPermissionMode:normalizeScopedSetting("defaultPermissionMode",this.state.settings.defaultPermissionMode),
      defaultWorkspaceMode:normalizeScopedSetting("defaultWorkspaceMode",this.state.settings.defaultWorkspaceMode),
      worktreeSubmodules:normalizeScopedSetting("worktreeSubmodules",this.state.settings.worktreeSubmodules),
      worktreeCleanup:normalizeScopedSetting("worktreeCleanup",this.state.settings.worktreeCleanup),
      autoPull:Boolean(this.state.settings.autoPull),
      sourceControlMergeMethod:normalizeScopedSetting("sourceControlMergeMethod",this.state.settings.sourceControlMergeMethod),
      sourceControlTextStyle:normalizeScopedSetting("sourceControlTextStyle",this.state.settings.sourceControlTextStyle),
      sourceControlTextModel:normalizeScopedSetting("sourceControlTextModel",this.state.settings.sourceControlTextModel),
      sourceControlCustomInstructions:normalizeScopedSetting("sourceControlCustomInstructions",this.state.settings.sourceControlCustomInstructions),
      sourceControlFollowTemplates:normalizeScopedSetting("sourceControlFollowTemplates",this.state.settings.sourceControlFollowTemplates),
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
    if("remoteAccessToken" in patch){patch={...patch};delete patch.remoteAccessToken}
    if("remoteAccessEnabled" in patch){patch={...patch};delete patch.remoteAccessEnabled}
    if("remoteAccessPort" in patch){patch={...patch};delete patch.remoteAccessPort}
    if("agentDeviceAccess" in patch){patch={...patch};delete patch.agentDeviceAccess}
    if("worktreeSubmodules" in patch&&!['recursive','top-level','none'].includes(String(patch.worktreeSubmodules)))patch={...patch,worktreeSubmodules:'recursive'};
    if("worktreeCleanup" in patch)patch={...patch,worktreeCleanup:normalizeWorktreeCleanup(patch.worktreeCleanup)};
    if("storageCleanup" in patch)patch={...patch,storageCleanup:normalizeStorageCleanup(patch.storageCleanup)};
    if("sourceControlMergeMethod" in patch)patch={...patch,sourceControlMergeMethod:normalizeScopedSetting("sourceControlMergeMethod",patch.sourceControlMergeMethod)};
    if("sourceControlTextStyle" in patch)patch={...patch,sourceControlTextStyle:normalizeScopedSetting("sourceControlTextStyle",patch.sourceControlTextStyle)};
    if("sourceControlTextModel" in patch)patch={...patch,sourceControlTextModel:normalizeScopedSetting("sourceControlTextModel",patch.sourceControlTextModel)};
    if("sourceControlCustomInstructions" in patch)patch={...patch,sourceControlCustomInstructions:normalizeScopedSetting("sourceControlCustomInstructions",patch.sourceControlCustomInstructions)};
    if("sourceControlFollowTemplates" in patch)patch={...patch,sourceControlFollowTemplates:normalizeScopedSetting("sourceControlFollowTemplates",patch.sourceControlFollowTemplates)};
    if("mcpServers" in patch)patch={...patch,mcpServers:normalizeMcpServers(patch.mcpServers)};
    if("agentRuntimeInstances" in patch)patch={...patch,agentRuntimeInstances:normalizeRuntimeInstances(patch.agentRuntimeInstances)};
    if("panelAnimationMs" in patch){const value=Math.round(Number(patch.panelAnimationMs)||0);patch={...patch,panelAnimationMs:Math.max(0,Math.min(400,value))}}
    this.state.settings={...this.state.settings,...patch};
    this.#save();
    return this.settings();
  }
  environments(){ return clone(this.state.environments); }
  upsertEnvironment(profile={}){
    const id=String(profile.id||randomUUID());
    let item=this.state.environments.find(x=>x.id===id);
    if(item) Object.assign(item,profile,{id,enabled:profile.enabled===undefined?item.enabled!==false:profile.enabled!==false,updatedAt:Date.now()});
    else{
      item={...profile,id,enabled:profile.enabled!==false,createdAt:Number(profile.createdAt)||Date.now(),updatedAt:Date.now()};
      this.state.environments.push(item);
    }
    this.#save();
    return clone(item);
  }
  setEnvironmentEnabled(id,enabled){
    const item=this.state.environments.find(x=>x.id===id);
    if(!item)return null;
    item.enabled=enabled!==false;item.updatedAt=Date.now();this.#save();return clone(item);
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
  setProjectCloneJob(path,environmentId,cloneJob){
    const id=normalizeEnvironmentId(environmentId);const project=this.state.projects.find(item=>item.path===path&&normalizeEnvironmentId(item.environmentId)===id);
    if(!project)throw new Error("Project was not found");
    project.cloneJob=normalizeCloneJob(cloneJob);this.#save();return clone(project);
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
    if("cloneJob" in patch)project.cloneJob=normalizeCloneJob(patch.cloneJob);
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
    if(Array.isArray(patch.recipes))project.recipes=normalizeRecipes(patch.recipes).map(recipe=>({...recipe,id:recipe.id||randomUUID()}));
    else if(!Array.isArray(project.recipes))project.recipes=[];
    if(Array.isArray(patch.hooks))project.hooks=normalizeProjectHooks(patch.hooks).map(hook=>({...hook,id:hook.id||randomUUID()}));
    else if(!Array.isArray(project.hooks))project.hooks=[];
    this.#save();
    return clone(project);
  }
  removeProject(id){
    this.state.projects=this.state.projects.filter(p=>p.id!==id);
    this.#save();
  }
  threadMeta(threadId){
    if(this.collections)return clone(this.collections.threadMeta(threadId)||{});
    return clone(this.state.threadMeta[threadId]||{});
  }
  updateThreadMeta(threadId,patch={}){
    const current=this.collections?(this.collections.threadMeta(threadId)||{}):(this.state.threadMeta[threadId]||{});
    const next=redactSecretValue({...current,...patch,updatedAt:Date.now()},{environment:this.env,maxDepth:20,maxArray:10000,maxFields:5000});
    for(const [key,value] of Object.entries(next)) if(value===undefined) delete next[key];
    if(this.collections){this.collections.putThreadMeta(threadId,next);return clone(next)}
    this.state.threadMeta[threadId]=next;
    this.#save();
    return clone(next);
  }
  listThreadMeta(){ return clone(this.collections?this.collections.threadMetaMap():this.state.threadMeta); }
  threadMetaCatalogPage({limit=100,cursor=null}={}){
    if(this.collections)return clone(this.collections.threadMetaCatalogPage({limit,cursor}));
    const capped=Math.max(1,Math.min(1000,Number(limit)||100)),offset=String(cursor||"").startsWith("legacy:")?Math.max(0,Number(String(cursor).slice(7))||0):0;
    const rows=Object.entries(this.state.threadMeta||{}).map(([threadId,item])=>[threadId,threadMetaCatalogProjection(item)]).sort((left,right)=>(Number(right[1]?.updatedAt)||0)-(Number(left[1]?.updatedAt)||0)||String(right[0]).localeCompare(String(left[0])));
    const page=rows.slice(offset,offset+capped),nextOffset=offset+page.length;
    return {threadMeta:clone(Object.fromEntries(page)),nextCursor:nextOffset<rows.length?"legacy:"+nextOffset:null};
  }
  removeThreadMeta(threadId){
    if(this.collections)return this.collections.removeThreadMeta(threadId);
    if(!Object.prototype.hasOwnProperty.call(this.state.threadMeta,threadId))return false;
    delete this.state.threadMeta[threadId];this.#save();return true;
  }
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
    const item=redactSecretValue({id:checkpoint.id||randomUUID(),createdAt:Date.now(),...checkpoint},{environment:this.env,maxDepth:20,maxArray:1000,maxFields:2000});
    if(this.collections){this.collections.putCheckpoint(item);return clone(item)}
    this.state.checkpoints.unshift(item);
    this.state.checkpoints=this.state.checkpoints.slice(0,200);
    this.#save();
    return clone(item);
  }
  updateCheckpoint(id,patch){
    if(this.collections){const item=this.collections.checkpoint(id);if(!item)return null;const next=redactSecretValue({...item,...patch},{environment:this.env,maxDepth:20,maxArray:1000,maxFields:2000});this.collections.putCheckpoint(next);return clone(next)}
    const item=this.state.checkpoints.find(c=>c.id===id);
    if(!item) return null;
    Object.assign(item,redactSecretValue(patch,{environment:this.env,maxDepth:20,maxArray:1000,maxFields:2000}));
    this.#save();
    return clone(item);
  }
  checkpoints(threadId=null){
    if(this.collections)return clone(this.collections.checkpoints(threadId));
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
    if(this.collections){
      const previous=this.collections.usageRecord(record.id),stored=previous?{...previous,...record,model:record.model||previous.model,provider:record.provider||previous.provider,environmentId:record.environmentId??previous.environmentId??null}:record;
      this.collections.putUsage(stored);return clone(record);
    }
    const index=this.state.usageRecords.findIndex(item=>item.id===record.id);
    if(index>=0)this.state.usageRecords[index]={...this.state.usageRecords[index],...record,model:record.model||this.state.usageRecords[index].model,provider:record.provider||this.state.usageRecords[index].provider,environmentId:record.environmentId??this.state.usageRecords[index].environmentId??null};
    else this.state.usageRecords.push(record);
    this.state.usageRecords=this.state.usageRecords.sort((a,b)=>(b.at||0)-(a.at||0)).slice(0,5000);this.#save();return clone(record);
  }
  usage({days=30,limit=1000,environmentIds=undefined}={}){
    const horizon=Math.max(1,Math.min(3650,Number(days)||30));const since=Date.now()-horizon*86400000;
    const selected=Array.isArray(environmentIds)?new Set(environmentIds.map(normalizeEnvironmentId)):null;
    const records=this.collections?this.collections.usage({since,limit,environmentIds:Array.isArray(environmentIds)?environmentIds:undefined}):this.state.usageRecords.filter(item=>(item.at||0)>=since&&(!selected||selected.has(normalizeEnvironmentId(item.environmentId)))).slice(0,Math.max(1,Math.min(5000,Number(limit)||1000)));
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
  threadUsage(threadId,{since=0}={}){
    const id=String(threadId||""),start=Math.max(0,Number(since)||0),records=this.collections?this.collections.usage({since:start,limit:5000,threadId:id}):this.state.usageRecords.filter(item=>item.threadId===id&&Number(item.at||0)>=start);
    const total={totalTokens:0,inputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0,reasoningOutputTokens:0,costUsd:0,costKnown:0};
    const tokenKeys=["totalTokens","inputTokens","cachedInputTokens","cacheWriteInputTokens","outputTokens","reasoningOutputTokens"];
    for(const record of records)for(const key of tokenKeys)total[key]+=Number(record.usage?.[key]||0);
    for(const record of records)if(record.cost?.currency==="USD"&&Number.isFinite(Number(record.cost.amount))){total.costUsd+=Number(record.cost.amount);total.costKnown++}
    return {...total,turns:records.length,records:records.length};
  }
  clearUsage(){if(this.collections)return this.collections.clearUsage();const count=this.state.usageRecords.length;this.state.usageRecords=[];this.#save();return count}
  recordVerification(entry={}){
    const now=Number(entry.updatedAt)||Date.now(),environmentId=normalizeEnvironmentId(entry.environmentId),projectPath=entry.projectPath?String(entry.projectPath):null,threadId=entry.threadId?String(entry.threadId):null,turnId=entry.turnId?String(entry.turnId):null;
    const fallbackId=threadId&&turnId?`verification:${environmentId||"local"}:${threadId}:${turnId}`:randomUUID(),id=String(entry.id||fallbackId).slice(0,300),index=this.collections?-1:this.state.verificationRecords.findIndex(item=>item.id===id),previous=this.collections?this.collections.verificationRecord(id):(index>=0?this.state.verificationRecords[index]:null);
    const record=redactSecretValue({
      id,environmentId,projectPath,threadId,turnId,
      plan:entry.plan&&typeof entry.plan==="object"?clone(entry.plan):null,
      evidence:Array.isArray(entry.evidence)?clone(entry.evidence.slice(0,300)):[],
      assessment:entry.assessment&&typeof entry.assessment==="object"?clone(entry.assessment):null,
      status:String(entry.assessment?.status||entry.status||"incomplete"),risk:String(entry.assessment?.risk||entry.plan?.risk||entry.risk||"unknown"),
      createdAt:Number(previous?.createdAt)||Number(entry.createdAt)||now,updatedAt:now,
    },{environment:this.env,maxDepth:20,maxArray:2000,maxFields:5000});
    if(this.collections){this.collections.putVerification(record);return clone(record)}
    if(index>=0)this.state.verificationRecords[index]=record;else this.state.verificationRecords.unshift(record);
    this.state.verificationRecords=this.state.verificationRecords.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)).slice(0,1000);this.#save();return clone(record);
  }
  verificationRecords(options={}){
    const threadId=options.threadId==null?null:String(options.threadId),projectPath=options.projectPath==null?null:String(options.projectPath),hasEnvironment=Object.prototype.hasOwnProperty.call(options,"environmentId"),environmentId=normalizeEnvironmentId(options.environmentId),limit=Math.max(1,Math.min(1000,Number(options.limit)||100));
    if(this.collections)return clone(this.collections.verificationRecords({threadId,projectPath,hasEnvironment,environmentId,limit}));
    return clone(this.state.verificationRecords.filter(item=>(!threadId||item.threadId===threadId)&&(!projectPath||item.projectPath===projectPath)&&(!hasEnvironment||normalizeEnvironmentId(item.environmentId)===environmentId)).slice(0,limit));
  }
  upsertRepositoryKnowledge(entry={}){
    const now=Number(entry.updatedAt)||Date.now(),id=String(entry.id||randomUUID()).slice(0,300),index=this.collections?-1:this.state.repositoryKnowledge.findIndex(item=>item.id===id),previous=this.collections?this.collections.knowledgeRecord(id):(index>=0?this.state.repositoryKnowledge[index]:null);
    const record=redactSecretValue({
      id,
      projectPath:String(entry.projectPath||previous?.projectPath||"").slice(0,4000),
      environmentId:normalizeEnvironmentId(entry.environmentId??previous?.environmentId),
      category:String(entry.category||previous?.category||"other").slice(0,120),
      fact:String(entry.fact||previous?.fact||"").slice(0,8000),
      scope:String(entry.scope||previous?.scope||"repository").slice(0,1000),
      source:String(entry.source||previous?.source||"explicit").slice(0,120),
      confidence:entry.confidence==null?(previous?.confidence??null):Math.max(0,Math.min(1,Number(entry.confidence)||0)),
      status:["verified","stale","unverified"].includes(String(entry.status||previous?.status))?String(entry.status||previous?.status):"unverified",
      evidence:Array.isArray(entry.evidence)?clone(entry.evidence.slice(0,80)):clone(previous?.evidence||[]),
      lastVerifiedRevision:entry.lastVerifiedRevision==null?(previous?.lastVerifiedRevision||null):String(entry.lastVerifiedRevision||"").slice(0,200)||null,
      staleReason:entry.staleReason==null?(previous?.staleReason||null):String(entry.staleReason||"").slice(0,2000)||null,
      verifiedAt:entry.verifiedAt==null?(previous?.verifiedAt||null):(Number(entry.verifiedAt)||null),
      createdAt:Number(previous?.createdAt)||Number(entry.createdAt)||now,updatedAt:now,
    },{environment:this.env,maxDepth:20,maxArray:1000,maxFields:3000});
    if(!record.projectPath||!record.fact)throw new Error("Repository knowledge requires projectPath and fact.");
    if(this.collections){this.collections.putKnowledge(record);return clone(record)}
    if(index>=0)this.state.repositoryKnowledge[index]=record;else this.state.repositoryKnowledge.unshift(record);
    this.state.repositoryKnowledge=this.state.repositoryKnowledge.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)).slice(0,5000);this.#save();return clone(record);
  }
  repositoryKnowledge(options={}){
    const projectPath=options.projectPath==null?null:String(options.projectPath),hasEnvironment=Object.prototype.hasOwnProperty.call(options,"environmentId"),environmentId=normalizeEnvironmentId(options.environmentId),status=options.status==null?null:String(options.status),limit=Math.max(1,Math.min(5000,Number(options.limit)||200));
    if(this.collections)return clone(this.collections.knowledge({projectPath,hasEnvironment,environmentId,status,limit}));
    return clone(this.state.repositoryKnowledge.filter(item=>(!projectPath||item.projectPath===projectPath)&&(!hasEnvironment||normalizeEnvironmentId(item.environmentId)===environmentId)&&(!status||item.status===status)).slice(0,limit));
  }
  removeRepositoryKnowledge(id){
    if(this.collections)return this.collections.removeKnowledge(id);
    const key=String(id||""),before=this.state.repositoryKnowledge.length;this.state.repositoryKnowledge=this.state.repositoryKnowledge.filter(item=>item.id!==key);
    if(this.state.repositoryKnowledge.length!==before)this.#save();return before!==this.state.repositoryKnowledge.length;
  }
}
