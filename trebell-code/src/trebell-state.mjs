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
    notifications: true,
    notificationSound: false,
    backgroundMode: false,
    keyboardShortcuts: {},
    keybindingRules: [],
    activeEnvironmentId: null,
    remoteAccessEnabled: false,
    remoteAccessPort: 3211,
    remoteAccessToken: "",
    modelProvider: "freebuff",
    onboardingComplete: false,
  },
  environments: [],
  stashes: [],
  checkpoints: [],
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
}
