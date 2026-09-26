const RUNTIMES=new Set(["native","codex","claude","opencode","cursor","grok","antigravity"]);

function text(value,max=4000){return String(value??"").trim().slice(0,max)}
function runtime(value,fallback=null){const key=String(value||"").trim().toLowerCase();return RUNTIMES.has(key)?key:fallback}
function runtimeFromInstance(value){
  const key=String(value||"").trim().toLowerCase();
  return [...RUNTIMES].find(name=>key===name||key.startsWith(name+"-"))||null;
}
function epoch(value){const number=Number(value);return Number.isFinite(number)&&number>0?number:Date.now()/1000}
function safeStatus(status){
  const type=typeof status==="string"?status:status?.type;
  if(!type||type==="active")return {type:"idle"};
  return typeof status==="object"?{...status,type}: {type};
}

export function threadCatalogRuntime(thread,meta={},fallback=null){
  return runtime(meta?.runtime||thread?.trebellRuntime||thread?.runtime||meta?.trebellContext?.runtime,runtimeFromInstance(meta?.runtimeInstanceId)||fallback);
}

export function threadCatalogSnapshot(thread,{runtime:runtimeHint=null,provider=null}={}){
  if(!thread?.id)return null;
  const owner=threadCatalogRuntime(thread,{},runtimeHint);
  return {
    id:String(thread.id),
    name:text(thread.name,500)||null,
    preview:text(thread.preview,1000)||null,
    cwd:text(thread.cwd,4000)||null,
    model:text(thread.model,500)||null,
    updatedAt:epoch(thread.updatedAt),
    createdAt:epoch(thread.createdAt||thread.updatedAt),
    status:safeStatus(thread.status),
    section:thread.section?.id||thread.section?.name?{id:text(thread.section?.id||thread.section?.name,300),name:text(thread.section?.name||thread.section?.id,300)}:null,
    projectId:text(thread.projectId,500)||null,
    runtime:owner,
    provider:text(provider,200)||null,
  };
}

export function threadFromCatalogMeta(threadId,meta={}){
  if(meta?.deletedAt||meta?.archived)return null;
  const snapshot=meta?.threadSnapshot&&typeof meta.threadSnapshot==="object"?meta.threadSnapshot:null;
  const owner=runtime(meta?.runtime||snapshot?.runtime||meta?.trebellContext?.runtime,runtimeFromInstance(meta?.runtimeInstanceId));
  if(!snapshot&&!owner)return null;
  const id=String(snapshot?.id||threadId||"").trim();if(!id)return null;
  return {
    id,
    name:text(snapshot?.name,500)||null,
    preview:text(snapshot?.preview,1000)||null,
    cwd:text(snapshot?.cwd||meta?.cwd,4000)||null,
    model:text(snapshot?.model||meta?.model,500)||null,
    updatedAt:epoch(snapshot?.updatedAt||meta?.updatedAt||meta?.lastOpenedAt),
    createdAt:epoch(snapshot?.createdAt||meta?.createdAt||snapshot?.updatedAt),
    status:safeStatus(snapshot?.status),
    section:snapshot?.section||null,
    projectId:snapshot?.projectId||null,
    trebellRuntime:owner,
    trebellProvider:text(snapshot?.provider||meta?.provider,200)||null,
    __trebellCatalog:true,
  };
}

export function threadsFromCatalogMeta(threadMeta={}){
  return Object.entries(threadMeta||{}).map(([id,meta])=>threadFromCatalogMeta(id,meta)).filter(Boolean).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
}

export function decorateCatalogThread(thread,{runtime:runtimeHint=null,provider=null}={}){
  if(!thread?.id)return thread;
  const owner=threadCatalogRuntime(thread,{},runtimeHint);
  return {...thread,trebellRuntime:owner,trebellProvider:text(provider,200)||thread.trebellProvider||null};
}

export function mergeThreadCatalog(existing=[],incoming=[],{runtime:runtimeHint=null,provider=null,threadMeta={}}={}){
  const map=new Map();
  for(const thread of existing||[]){
    if(!thread?.id)continue;
    const meta=threadMeta?.[thread.id]||{};if(meta.deletedAt||meta.archived)continue;
    map.set(String(thread.id),thread);
  }
  for(const raw of incoming||[]){
    if(!raw?.id)continue;
    const thread=decorateCatalogThread(raw,{runtime:runtimeHint,provider}),previous=map.get(String(thread.id));
    map.set(String(thread.id),previous?{...previous,...thread}:thread);
  }
  for(const thread of threadsFromCatalogMeta(threadMeta)){
    if(!map.has(String(thread.id)))map.set(String(thread.id),thread);
  }
  return [...map.values()].sort((a,b)=>(Number(b.updatedAt)||0)-(Number(a.updatedAt)||0));
}

export function catalogMetaPatch(thread,{runtime:runtimeHint=null,provider=null,runtimeInstanceId=null}={}){
  const snapshot=threadCatalogSnapshot(thread,{runtime:runtimeHint,provider});
  if(!snapshot)return {};
  return {
    runtime:snapshot.runtime,
    provider:snapshot.provider,
    runtimeInstanceId:runtimeInstanceId||thread?.runtimeInstanceId||thread?.providerMeta?.runtimeInstanceId||null,
    model:snapshot.model,
    threadSnapshot:snapshot,
  };
}

export function sameCatalogSnapshot(left,right){
  return JSON.stringify(left||null)===JSON.stringify(right||null);
}
