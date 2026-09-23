import React,{useEffect,useMemo,useState} from "react";
import { Blocks, Brain, CheckCircle2, FlaskConical, PlugZap, RefreshCw, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import { api } from "../api.js";
import { allowedWindowsSetupModes, windowsSandboxStatus, worldWritableWarningText } from "../windows-sandbox.js";

function Section({title,icon:Icon,count,children}){
  return <section className="capability-card"><div className="capability-card-head"><span><Icon size={15}/><strong>{title}</strong></span>{Number.isFinite(count)&&<em>{count}</em>}</div>{children}</section>;
}
function ErrorLine({value}){return value?<p className="capability-error">{value}</p>:null}
function formatBytes(value){
  const bytes=Number(value);if(!Number.isFinite(bytes)||bytes<0)return "Unavailable";
  if(bytes<1024)return bytes+" B";
  const units=["KB","MB","GB","TB"];let scaled=bytes,index=-1;
  do{scaled/=1024;index++}while(scaled>=1024&&index<units.length-1);
  return (scaled>=100?Math.round(scaled):scaled.toFixed(1))+" "+units[index];
}
function importResultSummary(results=[],prefix="Importing"){
  let successes=0,failures=0;const types=[];
  for(const result of results||[]){
    successes+=result?.successes?.length||0;failures+=result?.failures?.length||0;
    const type=String(result?.itemType||"").trim();if(type&&!types.includes(type))types.push(type);
  }
  const typeLabel=types.map(type=>type.replace(/[_-]+/g," ").toLowerCase()).join(", ");
  return [prefix+(typeLabel?" "+typeLabel:""),successes?successes+" imported":"",failures?failures+" failed":""].filter(Boolean).join(" · ");
}

export default function HarnessToolsPage({rpc,rpcStatus,projectPath,activeThread,skills=[],onHistoryImported,onSkillsRefresh,platform=""}){
  const [data,setData]=useState({permissions:[],mcp:[],marketplaces:[],apps:[],installedApps:[],hooks:[],features:[],sharedPlugins:[],loadedThreads:[],loadedThreadsMore:false,capabilities:null,account:null,rateLimits:null,usage:null,config:null,requirements:null,memory:null,diagnostics:null,windowsSandbox:null});
  const [errors,setErrors]=useState({});
  const [loading,setLoading]=useState(false);
  const [busy,setBusy]=useState("");
  const [marketplaceSource,setMarketplaceSource]=useState("");
  const [migrations,setMigrations]=useState(null);
  const [migrationHistory,setMigrationHistory]=useState({data:[],connectors:[]});
  const [migrationMessage,setMigrationMessage]=useState("");
  const [migrationImportId,setMigrationImportId]=useState(null);
  const [historyImport,setHistoryImport]=useState(null);
  const [historyMessage,setHistoryMessage]=useState("");
  const [mcpResult,setMcpResult]=useState(null);
  const [appDetail,setAppDetail]=useState(null);
  const [toolArgs,setToolArgs]=useState({});
  const [memoryMessage,setMemoryMessage]=useState("");
  const [memoryResetArmed,setMemoryResetArmed]=useState(false);
  const [sandboxPending,setSandboxPending]=useState("");
  const [sandboxMessage,setSandboxMessage]=useState("");
  const [sandboxWarning,setSandboxWarning]=useState("");
  const [skillRootsText,setSkillRootsText]=useState("");
  const [skillMessage,setSkillMessage]=useState("");
  const [pluginSearchTerm,setPluginSearchTerm]=useState("");
  const [pluginSearchScope,setPluginSearchScope]=useState("global");
  const [pluginSearchResults,setPluginSearchResults]=useState([]);
  const [pluginSearchCursor,setPluginSearchCursor]=useState(null);
  const [pluginSearchRan,setPluginSearchRan]=useState(false);
  const [pluginDetail,setPluginDetail]=useState(null);
  const [pluginSkillDetail,setPluginSkillDetail]=useState(null);
  const [pluginMessage,setPluginMessage]=useState("");
  const [configWarnings,setConfigWarnings]=useState([]);
  const [runtimeNotices,setRuntimeNotices]=useState([]);
  const [hookRuns,setHookRuns]=useState([]);
  const [authRecovery,setAuthRecovery]=useState(null);
  const [modelNotices,setModelNotices]=useState([]);

  function routedParams(params){
    const threadId=activeThread?.id;
    if(!threadId)return params;
    return {...(params&&typeof params==="object"&&!Array.isArray(params)?params:{}),_trebellThreadId:threadId};
  }
  async function request(name,params){return rpc.request(name,routedParams(params))}
  async function call(name,params){
    try{return await request(name,params)}
    catch(error){setErrors(prev=>({...prev,[name]:error.message||String(error)}));return null}
  }
  async function refresh(){
    if(!rpc||rpcStatus!=="connected")return;
    setLoading(true);setErrors({});
    const threadId=activeThread?.id||null;
    const [permissions,mcp,plugins,apps,installedApps,hooks,features,sharedPlugins,loadedThreads,capabilities,account,rateLimits,usage,config,requirements,memory,diagnostics,importHistories,windowsSandbox]=await Promise.all([
      call("permissionProfile/list",{limit:100,cwd:projectPath||null}),
      call("mcpServerStatus/list",{limit:100,detail:"full",threadId}),
      call("plugin/list",{cwds:projectPath?[projectPath]:[],forceRefetch:false}),
      call("app/list",{limit:100,threadId,forceRefetch:false}),
      call("app/installed",{threadId,forceRefresh:false}),
      call("hooks/list",{cwds:projectPath?[projectPath]:[]}),
      call("experimentalFeature/list",{limit:200,threadId}),
      call("plugin/share/list",{}),
      call("thread/loaded/list",{limit:100}),
      call("modelProvider/capabilities/read",{}),
      call("account/read",{refreshToken:false}),
      call("account/rateLimits/read",{excludeResetCreditDetails:true}),
      call("account/usage/read",threadId?{threadId}:{}),
      call("config/read",{includeLayers:true,cwd:projectPath||null}),
      call("configRequirements/read",{}),
      call("memory/status",{minConsolidatedThreads:20}),
      call("server/diagnostics",{}),
      call("externalAgentConfig/import/readHistories",{}),
      platform==="win32"?call("windowsSandbox/readiness",undefined):Promise.resolve(null),
    ]);
    setData({
      permissions:permissions?.data||[],
      mcp:mcp?.data||[],
      marketplaces:plugins?.marketplaces||[],
      apps:apps?.data||[],
      installedApps:installedApps?.apps||[],
      hooks:hooks?.data||[],
      features:features?.data||[],
      sharedPlugins:sharedPlugins?.data||[],
      loadedThreads:loadedThreads?.data||[],
      loadedThreadsMore:Boolean(loadedThreads?.nextCursor),
      capabilities:capabilities||null,
      account:account||null,
      rateLimits:rateLimits||null,
      usage:usage||null,
      config:config||null,
      requirements:requirements?.requirements||null,
      memory:memory||null,
      diagnostics:diagnostics||null,
      windowsSandbox:windowsSandbox||null,
    });
    if(importHistories)setMigrationHistory({data:importHistories.data||[],connectors:importHistories.connectors||[]});
    setLoading(false);
  }
  useEffect(()=>{refresh()},[rpc,rpcStatus,projectPath,activeThread?.id,platform]);
  useEffect(()=>{
    if(!rpc?.subscribeNotifications||rpcStatus!=="connected")return;
    let timer=null;const pending=new Set();let disposed=false;
    const flush=async()=>{
      timer=null;if(disposed)return;
      const kinds=[...pending];pending.clear();const threadId=activeThread?.id||null;
      if(kinds.includes("apps")){
        const installed=await call("app/installed",{threadId,forceRefresh:false});
        if(!disposed&&installed)setData(current=>({...current,installedApps:installed.apps||[]}));
      }
      if(kinds.includes("mcp")){
        const status=await call("mcpServerStatus/list",{limit:100,detail:"full",threadId});
        if(!disposed&&status)setData(current=>({...current,mcp:status.data||[]}));
      }
      if(kinds.includes("rateLimits")){
        const rateLimits=await call("account/rateLimits/read",{excludeResetCreditDetails:true});
        if(!disposed&&rateLimits)setData(current=>({...current,rateLimits}));
      }
      if(kinds.includes("account")){
        const account=await call("account/read",{refreshToken:false});
        if(!disposed&&account)setData(current=>({...current,account}));
      }
    };
    const schedule=kind=>{pending.add(kind);if(timer)clearTimeout(timer);timer=setTimeout(flush,100)};
    const unsubscribe=rpc.subscribeNotifications(message=>{
      if(message.method==="app/list/updated"){
        const apps=message.params?.data;
        if(Array.isArray(apps))setData(current=>({...current,apps}));
        schedule("apps");
      }else if(message.method==="mcpServer/startupStatus/updated"||message.method==="mcpServer/oauthLogin/completed"){
        schedule("mcp");
      }else if(message.method==="account/rateLimits/updated"){
        schedule("rateLimits");
      }else if(message.method==="account/updated"){
        schedule("account");
      }else if(message.method==="modelProvider/authRecoveryStarted"||message.method==="modelProvider/authRecoveryCompleted"){
        const params=message.params||{};
        if(activeThread?.id&&params.threadId!==activeThread.id)return;
        const active=message.method==="modelProvider/authRecoveryStarted";
        setAuthRecovery({active,provider:params.provider||"provider",message:params.message||""});
        if(!active)schedule("account");
      }else if(message.method==="model/rerouted"){
        const params=message.params||{};
        if(activeThread?.id&&params.threadId!==activeThread.id)return;
        const notice={id:"reroute:"+(params.turnId||Date.now()),kind:"reroute",title:(params.fromModel||"model")+" → "+(params.toModel||"model"),detail:params.reason||"Model rerouted"};
        setModelNotices(current=>[notice,...current.filter(item=>item.id!==notice.id)].slice(0,5));
      }else if(message.method==="model/safetyBuffering/updated"){
        const params=message.params||{};
        if(activeThread?.id&&params.threadId!==activeThread.id)return;
        const detail=[...(params.reasons||[]),params.fasterModel?"faster model: "+params.fasterModel:null].filter(Boolean).join(" · ");
        const notice={id:"safety:"+(params.turnId||Date.now()),kind:"safety",title:(params.model||"Model")+" safety buffering "+(params.showBufferingUi?"active":"cleared"),detail};
        setModelNotices(current=>[notice,...current.filter(item=>item.id!==notice.id)].slice(0,5));
      }else if(message.method==="model/verification"){
        const params=message.params||{};
        if(activeThread?.id&&params.threadId!==activeThread.id)return;
        const notice={id:"verify:"+(params.turnId||Date.now()),kind:"verification",title:"Model access verified",detail:(params.verifications||[]).join(", ")||"Verification completed"};
        setModelNotices(current=>[notice,...current.filter(item=>item.id!==notice.id)].slice(0,5));
      }else if(message.method==="configWarning"){
        const warning=message.params||{};
        setConfigWarnings(current=>[
          warning,
          ...current.filter(item=>!(item.summary===warning.summary&&item.path===warning.path&&item.details===warning.details)),
        ].slice(0,5));
      }else if(message.method==="warning"){
        const params=message.params||{};
        if(params.threadId&&activeThread?.id&&params.threadId!==activeThread.id)return;
        const notice={id:"warning:"+(params.threadId||"global")+":"+(params.message||""),kind:"warning",summary:params.message||"Codex warning",details:null};
        setRuntimeNotices(current=>[notice,...current.filter(item=>item.id!==notice.id)].slice(0,5));
      }else if(message.method==="deprecationNotice"){
        const params=message.params||{};
        const notice={id:"deprecation:"+(params.summary||""),kind:"deprecated",summary:params.summary||"Deprecated Codex capability",details:params.details||null};
        setRuntimeNotices(current=>[notice,...current.filter(item=>item.id!==notice.id)].slice(0,5));
      }else if(message.method==="externalAgentConfig/import/progress"&&message.params?.importId===migrationImportId){
        setMigrationMessage(importResultSummary(message.params?.itemTypeResults,"Importing"));
      }else if(message.method==="externalAgentConfig/import/completed"&&message.params?.importId===migrationImportId){
        setMigrationMessage(importResultSummary(message.params?.itemTypeResults,"Import complete"));
        setMigrationImportId(null);
        Promise.all([loadMigrationHistory(),loadExternalConfig()]).catch(error=>setErrors(prev=>({...prev,"externalAgentConfig/import":error.message||String(error)})));
      }else if((message.method==="hook/started"||message.method==="hook/completed")&&message.params?.run){
        const params=message.params;
        if(activeThread?.id&&params.threadId!==activeThread.id)return;
        setHookRuns(current=>{
          const next=[params.run,...current.filter(run=>run.id!==params.run.id)];
          return next.sort((a,b)=>Number(b.startedAt||0)-Number(a.startedAt||0)).slice(0,8);
        });
      }
    });
    return()=>{disposed=true;if(timer)clearTimeout(timer);unsubscribe?.()};
  },[rpc,rpcStatus,activeThread?.id,migrationImportId,projectPath]);
  useEffect(()=>{
    const completed=event=>{
      const detail=event.detail||{};setSandboxPending("");
      if(detail.success){setSandboxMessage(`${detail.mode==="elevated"?"Elevated":"Unelevated"} Windows sandbox setup completed.`);setErrors(prev=>({...prev,"windowsSandbox/setupStart":null}))}
      else{const error=detail.error||"Windows sandbox setup failed.";setSandboxMessage("");setErrors(prev=>({...prev,"windowsSandbox/setupStart":error}))}
      refresh();
    };
    const warning=event=>setSandboxWarning(worldWritableWarningText(event.detail||{}));
    window.addEventListener("trebell:windows-sandbox-setup",completed);window.addEventListener("trebell:windows-sandbox-warning",warning);
    return()=>{window.removeEventListener("trebell:windows-sandbox-setup",completed);window.removeEventListener("trebell:windows-sandbox-warning",warning)};
  },[rpc,rpcStatus,projectPath,activeThread?.id,platform]);

  const plugins=useMemo(()=>data.marketplaces.flatMap(m=>(m.plugins||[]).map(p=>({...p,marketplace:m}))),[data.marketplaces]);
  const installedAppsById=useMemo(()=>Object.fromEntries((data.installedApps||[]).map(app=>[app.id,app])),[data.installedApps]);
  const hookCount=data.hooks.reduce((n,x)=>n+(x.hooks?.length||0),0);

  async function reloadMcp(){
    if(!rpc)return;setBusy("mcp");
    try{await request("config/mcpServer/reload",undefined);await refresh()}finally{setBusy("")}
  }
  async function loginMcp(name){
    if(!rpc)return;setBusy("mcp:"+name);
    try{await request("mcpServer/oauth/login",{name,threadId:activeThread?.id||null});await refresh()}finally{setBusy("")}
  }
  async function togglePlugin(plugin){
    if(!rpc)return;setBusy("plugin:"+plugin.id);
    try{
      const nextInstalled=!plugin.installed;
      if(plugin.installed)await request("plugin/uninstall",{pluginId:plugin.id});
      else await request("plugin/install",{
        pluginName:plugin.name,
        marketplacePath:plugin.marketplace?.path||null,
        remoteMarketplaceName:plugin.marketplace?.path?null:(plugin.marketplace?.name||null),
        installAttemptId:crypto.randomUUID(),
      });
      setPluginSearchResults(current=>current.map(result=>result.plugin?.id===plugin.id?{...result,plugin:{...result.plugin,installed:nextInstalled}}:result));
      setPluginDetail(current=>current?.summary?.id===plugin.id?{...current,summary:{...current.summary,installed:nextInstalled}}:current);
      await refresh();
    }finally{setBusy("")}
  }
  async function searchPlugins({append=false}={}){
    const searchTerm=pluginSearchTerm.trim();if(!rpc||searchTerm.length<2)return;
    setBusy("plugin:search");setErrors(prev=>({...prev,"plugin/search":null}));if(!append)setPluginSearchRan(false);
    try{
      const result=await request("plugin/search",{searchTerm,scope:pluginSearchScope,cwds:projectPath?[projectPath]:null,cursor:append?pluginSearchCursor:null,limit:20});
      setPluginSearchResults(current=>append?[...current,...(result?.data||[])]:result?.data||[]);
      setPluginSearchCursor(result?.nextCursor||null);setPluginSearchRan(true);
    }catch(error){setErrors(prev=>({...prev,"plugin/search":error.message||String(error)}))}
    finally{setBusy("")}
  }
  async function readPlugin(plugin,marketplace={}){
    if(!rpc||!plugin?.name)return;setBusy("plugin:read:"+plugin.id);setErrors(prev=>({...prev,"plugin/read":null}));setPluginSkillDetail(null);
    try{
      const result=await request("plugin/read",{marketplacePath:marketplace.path||null,remoteMarketplaceName:marketplace.path?null:(marketplace.name||null),pluginName:plugin.name});
      setPluginDetail(result?.plugin||null);
    }catch(error){setErrors(prev=>({...prev,"plugin/read":error.message||String(error)}))}
    finally{setBusy("")}
  }
  async function readPluginSkill(skill){
    const remotePluginId=pluginDetail?.summary?.remotePluginId,remoteMarketplaceName=pluginDetail?.marketplaceName;
    if(!rpc||!remotePluginId||!remoteMarketplaceName||!skill?.name)return;
    setBusy("plugin:skill:"+skill.name);setErrors(prev=>({...prev,"plugin/skill/read":null}));
    try{const result=await request("plugin/skill/read",{remoteMarketplaceName,remotePluginId,skillName:skill.name});setPluginSkillDetail({name:skill.name,contents:result?.contents||""})}
    catch(error){setErrors(prev=>({...prev,"plugin/skill/read":error.message||String(error)}))}finally{setBusy("")}
  }
  async function refreshInstalledApps(){
    if(!rpc)return;setBusy("apps:installed");setErrors(prev=>({...prev,"app/installed":null}));
    try{
      const result=await request("app/installed",{threadId:activeThread?.id||null,forceRefresh:true});
      setData(current=>({...current,installedApps:result?.apps||[]}));
    }catch(error){setErrors(prev=>({...prev,"app/installed":error.message||String(error)}))}
    finally{setBusy("")}
  }
  async function reconcilePlugins(){
    if(!rpc)return;setBusy("plugin:reconcile");setPluginMessage("");setErrors(prev=>({...prev,"plugin/reconcile":null}));
    try{const result=await request("plugin/reconcile",{reason:"trebell-tools-refresh"});const changed=result?.changedPlugins?.length||0,failed=result?.failedRemotePluginIds?.length||0;setPluginMessage(`${changed} plugin change${changed===1?"":"s"} reconciled${failed?` · ${failed} failed`:""}.`);await refresh()}
    catch(error){setErrors(prev=>({...prev,"plugin/reconcile":error.message||String(error)}))}finally{setBusy("")}
  }
  async function shareLocalPlugin(plugin){
    const pluginPath=plugin?.source?.type==="local"?plugin.source.path:null;if(!rpc||!pluginPath)return;
    setBusy("share:"+plugin.id);setErrors(prev=>({...prev,"plugin/share/save":null}));
    try{await request("plugin/share/save",{pluginPath,...(plugin.remotePluginId?{remotePluginId:plugin.remotePluginId}:{}),discoverability:plugin.shareContext?.discoverability||"PRIVATE",shareTargets:(plugin.shareContext?.sharePrincipals||[]).filter(principal=>principal.role!=="owner"&&["reader","editor"].includes(principal.role)).map(principal=>({principalType:principal.principalType,principalId:principal.principalId,role:principal.role}))});await refresh()}
    catch(error){setErrors(prev=>({...prev,"plugin/share/save":error.message||String(error)}))}finally{setBusy("")}
  }
  async function checkoutSharedPlugin(item){
    const remotePluginId=item?.plugin?.remotePluginId;if(!rpc||!remotePluginId)return;setBusy("checkout:"+remotePluginId);
    try{await request("plugin/share/checkout",{remotePluginId});await refresh()}
    catch(error){setErrors(prev=>({...prev,"plugin/share/checkout":error.message||String(error)}))}finally{setBusy("")}
  }
  async function deleteSharedPlugin(item){
    const remotePluginId=item?.plugin?.remotePluginId;if(!rpc||!remotePluginId)return;setBusy("delete-share:"+remotePluginId);
    try{await request("plugin/share/delete",{remotePluginId});await refresh()}
    catch(error){setErrors(prev=>({...prev,"plugin/share/delete":error.message||String(error)}))}finally{setBusy("")}
  }
  async function updateShareDiscoverability(item,discoverability){
    const context=item?.plugin?.shareContext;const remotePluginId=item?.plugin?.remotePluginId||context?.remotePluginId;if(!rpc||!remotePluginId)return;setBusy("share-visibility:"+remotePluginId);
    const shareTargets=(context?.sharePrincipals||[]).filter(principal=>principal.role!=="owner"&&["reader","editor"].includes(principal.role)).map(principal=>({principalType:principal.principalType,principalId:principal.principalId,role:principal.role}));
    try{await request("plugin/share/updateTargets",{remotePluginId,discoverability,shareTargets});await refresh()}
    catch(error){setErrors(prev=>({...prev,"plugin/share/updateTargets":error.message||String(error)}))}finally{setBusy("")}
  }
  async function toggleFeature(feature){
    if(!rpc)return;setBusy("feature:"+feature.name);setErrors(prev=>({...prev,"experimentalFeature/enablement/set":null}));
    try{
      const result=await request("experimentalFeature/enablement/set",{enablement:{[feature.name]:!feature.enabled}});
      if(!Object.prototype.hasOwnProperty.call(result?.enablement||{},feature.name)){
        setErrors(prev=>({...prev,"experimentalFeature/enablement/set":feature.name+" is read-only through the app-server. Enable it in Codex config, then restart or refresh the runtime."}));
        return;
      }
      await refresh();
    }catch(error){setErrors(prev=>({...prev,"experimentalFeature/enablement/set":error.message||String(error)}))}
    finally{setBusy("")}
  }
  async function addMarketplace(){
    const source=marketplaceSource.trim();if(!source||!rpc)return;setBusy("marketplace:add");
    try{await request("marketplace/add",{source});setMarketplaceSource("");await refresh()}finally{setBusy("")}
  }
  async function removeMarketplace(name){
    if(!rpc||!name)return;setBusy("marketplace:"+name);
    try{await request("marketplace/remove",{marketplaceName:name});await refresh()}finally{setBusy("")}
  }
  async function upgradeMarketplace(name=null){
    if(!rpc)return;setBusy("marketplace:"+(name||"all"));
    try{await request("marketplace/upgrade",{marketplaceName:name});await refresh()}finally{setBusy("")}
  }
  async function loadExternalConfig(){
    const result=await request("externalAgentConfig/detect",{includeHome:true,cwds:projectPath?[projectPath]:[],maxSessionAgeDays:90,maxSessions:100});
    setMigrations(result);return result;
  }
  async function loadMigrationHistory(){
    const result=await request("externalAgentConfig/import/readHistories",{});
    setMigrationHistory({data:result?.data||[],connectors:result?.connectors||[]});return result;
  }
  async function detectExternalConfig(){
    if(!rpc)return;setBusy("migration:detect");setMigrationMessage("");setErrors(prev=>({...prev,"externalAgentConfig/detect":null}));
    try{await Promise.all([loadExternalConfig(),loadMigrationHistory()])}
    catch(error){setErrors(prev=>({...prev,"externalAgentConfig/detect":error.message||String(error)}))}finally{setBusy("")}
  }
  async function importExternalConfig(){
    if(!rpc||!migrations?.items?.length)return;setBusy("migration:import");setMigrationMessage("");setErrors(prev=>({...prev,"externalAgentConfig/import":null}));
    try{
      const started=await request("externalAgentConfig/import",{migrationItems:migrations.items,source:"trebell-code"});
      const importId=started?.importId;if(!importId)throw new Error("Codex did not return an import id.");
      setMigrationImportId(importId);
      setMigrationMessage("Import started. Waiting for Codex to finish…");
    }catch(error){setMigrationImportId(null);setErrors(prev=>({...prev,"externalAgentConfig/import":error.message||String(error)}))}
    finally{setBusy("")}
  }
  async function scanHistory(){
    setBusy("history:scan");setHistoryMessage("");
    try{setHistoryImport(await api("/api/history-import"))}
    catch(error){setHistoryMessage(error.message||String(error))}
    finally{setBusy("")}
  }
  async function importHistory(sessionIds){
    const ids=(sessionIds||[]).filter(Boolean);if(!ids.length)return;
    setBusy("history:import");setHistoryMessage("");
    try{
      const result=await api("/api/history-import",{method:"POST",body:{sessionIds:ids.slice(0,50)}});
      const imported=(result.results||[]).filter(item=>item.status==="imported").length;
      const skipped=(result.results||[]).filter(item=>item.status==="skipped").length;
      const failed=(result.results||[]).filter(item=>item.status==="error").length;
      setHistoryMessage([imported&&`${imported} imported`,skipped&&`${skipped} already imported`,failed&&`${failed} failed`].filter(Boolean).join(" · ")||"Nothing changed");
      await scanHistory();await onHistoryImported?.(result);
    }catch(error){setHistoryMessage(error.message||String(error))}
    finally{setBusy("")}
  }
  async function readResource(server,resource){
    if(!rpc)return;setBusy("resource:"+resource.uri);
    try{const result=await request("mcpServer/resource/read",{threadId:activeThread?.id||null,server:server.name,uri:resource.uri});setMcpResult({title:`${server.name} · ${resource.name||resource.uri}`,value:result})}
    catch(error){setMcpResult({title:"MCP resource error",value:{error:error.message}})}finally{setBusy("")}
  }
  async function runMcpTool(server,toolName){
    if(!rpc||!activeThread?.id)return;
    let args={};const raw=toolArgs[server.name+":"+toolName]?.trim();if(raw){try{args=JSON.parse(raw)}catch{setMcpResult({title:"Invalid tool arguments",value:{error:"Arguments must be valid JSON."}});return}}
    setBusy("tool:"+server.name+":"+toolName);
    try{const result=await request("mcpServer/tool/call",{threadId:activeThread.id,server:server.name,tool:toolName,arguments:args});setMcpResult({title:`${server.name} · ${toolName}`,value:result})}
    catch(error){setMcpResult({title:"MCP tool error",value:{error:error.message}})}finally{setBusy("")}
  }
  async function readApp(app){
    if(!rpc||!app?.id)return;setBusy("app:"+app.id);setErrors(prev=>({...prev,"app/read":null}));
    try{
      const result=await request("app/read",{appIds:[app.id],threadId:activeThread?.id||null,includeTools:true});
      const detail=result?.apps?.[0];if(!detail)throw new Error(result?.missingAppIds?.includes(app.id)?"Connector metadata is unavailable":"Codex did not return connector metadata");setAppDetail({...app,...detail});
    }catch(error){setErrors(prev=>({...prev,"app/read":error.message||String(error)}))}finally{setBusy("")}
  }
  async function setThreadMemoryMode(mode){
    if(!rpc||!activeThread?.id)return;
    setBusy("memory:"+mode);setMemoryMessage("");setErrors(prev=>({...prev,"thread/memoryMode/set":null}));
    try{
      await request("thread/memoryMode/set",{threadId:activeThread.id,mode});
      setMemoryMessage(`Memory ${mode} for this thread.`);
    }catch(error){setErrors(prev=>({...prev,"thread/memoryMode/set":error.message||String(error)}))}
    finally{setBusy("")}
  }
  async function resetMemory(){
    if(!rpc)return;
    if(!memoryResetArmed){setMemoryResetArmed(true);setMemoryMessage("Click Confirm reset to clear the current Codex memory store.");return}
    setBusy("memory:reset");setErrors(prev=>({...prev,"memory/reset":null}));setMemoryMessage("");
    try{await request("memory/reset",undefined);setMemoryMessage("Codex memory was reset.");setMemoryResetArmed(false);await refresh()}
    catch(error){setErrors(prev=>({...prev,"memory/reset":error.message||String(error)}))}
    finally{setBusy("")}
  }
  async function setupWindowsSandbox(mode){
    if(!rpc||platform!=="win32"||sandboxPending)return;
    setBusy("windows-sandbox:"+mode);setSandboxMessage("");setErrors(prev=>({...prev,"windowsSandbox/setupStart":null}));
    try{
      const result=await request("windowsSandbox/setupStart",{mode,cwd:projectPath||null});
      if(result?.started!==true)throw new Error("Codex did not start Windows sandbox setup.");
      setSandboxPending(mode);setSandboxMessage(`${mode==="elevated"?"Elevated":"Unelevated"} setup started. Windows may ask for permission; Trebell will wait for Codex to report completion.`);
    }catch(error){setErrors(prev=>({...prev,"windowsSandbox/setupStart":error.message||String(error)}))}
    finally{setBusy("")}
  }
  async function toggleSkill(skill){
    if(!rpc||!skill?.path)return;
    const next=skill.enabled===false;setBusy("skill:"+skill.path);setSkillMessage("");setErrors(prev=>({...prev,"skills/config/write":null}));
    try{
      const result=await request("skills/config/write",{path:skill.path,name:null,enabled:next});
      setSkillMessage(`${skill.name||"Skill"} is now ${result?.effectiveEnabled===false?"disabled":"enabled"}. This setting is saved in Codex config.`);
      await onSkillsRefresh?.();
    }catch(error){setErrors(prev=>({...prev,"skills/config/write":error.message||String(error)}))}
    finally{setBusy("")}
  }
  async function applySkillRoots(){
    if(!rpc)return;
    const extraRoots=[...new Set(skillRootsText.split(/\r?\n/).map(value=>value.trim()).filter(Boolean))];
    setBusy("skill-roots");setSkillMessage("");setErrors(prev=>({...prev,"skills/extraRoots/set":null}));
    try{
      await request("skills/extraRoots/set",{extraRoots});
      setSkillMessage(extraRoots.length?`${extraRoots.length} runtime skill root${extraRoots.length===1?"":"s"} applied. They reset when this Codex app-server restarts.`:"Runtime-only extra skill roots cleared.");
      await onSkillsRefresh?.();
    }catch(error){setErrors(prev=>({...prev,"skills/extraRoots/set":error.message||String(error)}))}
    finally{setBusy("")}
  }

  if(rpcStatus!=="connected")return <div className="empty-state"><Wrench size={28}/><strong>Codex harness is not connected</strong><span>Capabilities will appear when app-server is ready.</span></div>;

  return <div className="capabilities-page">
    <div className="capabilities-toolbar"><div><h2>Harness capabilities</h2><p>Live inventory from the bundled Codex app-server. These are real runtime capabilities, not a hard-coded parity list.</p></div><button onClick={refresh} disabled={loading}><RefreshCw size={13}/>{loading?"Refreshing…":"Refresh"}</button></div>

    <div className="capability-grid">
      <Section title="Account & usage" icon={Sparkles}>
        {data.account?<div className="capability-kv">
          <div><span>Authentication</span><strong>{data.account.account?.type|| (data.account.requiresOpenaiAuth?"Sign-in required":"External provider")}</strong></div>
          {data.account.account?.email&&<div><span>Account</span><strong>{data.account.account.email}</strong></div>}
          {data.account.account?.planType&&<div><span>Plan</span><strong>{data.account.account.planType}</strong></div>}
          {data.usage?.summary?.lifetimeTokens!=null&&<div><span>Lifetime tokens</span><strong>{Number(data.usage.summary.lifetimeTokens).toLocaleString()}</strong></div>}
          {data.usage?.summary?.currentStreakDays!=null&&<div><span>Active streak</span><strong>{String(data.usage.summary.currentStreakDays)} days</strong></div>}
          {data.rateLimits?.rateLimits?.primary&&<div><span>Primary usage</span><strong>{Math.round(Number(data.rateLimits.rateLimits.primary.usedPercent)||0)}%</strong></div>}
          {data.rateLimits?.rateLimits?.secondary&&<div><span>Secondary usage</span><strong>{Math.round(Number(data.rateLimits.rateLimits.secondary.usedPercent)||0)}%</strong></div>}
        </div>:<p>Codex did not return account metadata for this inference route.</p>}
        {authRecovery&&<p className="capability-status">{authRecovery.active?"Recovering":"Recovered"} {authRecovery.provider} authentication{authRecovery.message?": "+authRecovery.message:""}</p>}
        <ErrorLine value={errors["account/read"]}/><ErrorLine value={errors["account/rateLimits/read"]}/><ErrorLine value={errors["account/usage/read"]}/>
      </Section>

      <Section title="Codex memory" icon={Brain}>
        {data.memory?<div className="capability-kv">
          <div><span>Consolidated threads</span><strong>{Number(data.memory.v2ConsolidatedThreads||0).toLocaleString()}</strong></div>
          <div><span>V2 memory readiness</span><strong>{data.memory.v2Ready?"Ready":"Building"}</strong></div>
        </div>:<p>Memory readiness is unavailable from this Codex runtime.</p>}
        <p>Readiness uses Codex's default threshold of 20 consolidated threads. This status reports readiness only; it does not expose memory contents.</p>
        <div className="capability-actions">
          <button onClick={()=>setThreadMemoryMode("enabled")} disabled={!!busy||!activeThread?.id}>Enable for this thread</button>
          <button onClick={()=>setThreadMemoryMode("disabled")} disabled={!!busy||!activeThread?.id}>Disable for this thread</button>
          <button onClick={resetMemory} disabled={!!busy}>{memoryResetArmed?"Confirm reset":"Reset memory"}</button>
          {memoryResetArmed&&<button onClick={()=>{setMemoryResetArmed(false);setMemoryMessage("")}} disabled={!!busy}>Cancel</button>}
        </div>
        {!activeThread?.id&&<p>Select a thread to change its memory mode.</p>}
        {memoryMessage&&<p className="capability-status">{memoryMessage}</p>}
        <ErrorLine value={errors["memory/status"]}/><ErrorLine value={errors["thread/memoryMode/set"]}/><ErrorLine value={errors["memory/reset"]}/>
      </Section>

      <Section title="Codex runtime health" icon={Sparkles} count={data.diagnostics?.gauges?.length||0}>
        {data.diagnostics?<div className="capability-kv">
          <div><span>Process</span><strong>PID {data.diagnostics.process?.id||"?"}</strong></div>
          <div><span>Resident memory</span><strong>{formatBytes(data.diagnostics.process?.residentMemoryBytes)}</strong></div>
          {data.diagnostics.process?.physicalFootprintBytes!=null&&<div><span>Physical footprint</span><strong>{formatBytes(data.diagnostics.process.physicalFootprintBytes)}</strong></div>}
          <div><span>Loaded sessions</span><strong>{data.loadedThreads.length.toLocaleString()}{data.loadedThreadsMore?"+":""}</strong></div>
          {["core.threads.live","core.turns.active","mcp.connections.live"].map(name=>{const gauge=(data.diagnostics.gauges||[]).find(item=>item.name===name);return gauge?<div key={name}><span>{name==="core.threads.live"?"Live threads":name==="core.turns.active"?"Active turns":"MCP connections"}</span><strong>{Number(gauge.value||0).toLocaleString()}</strong></div>:null})}
        </div>:<p>Process diagnostics are unavailable from this Codex runtime.</p>}
        {data.loadedThreads.length>0&&<details className="capability-details"><summary>Loaded session IDs</summary><pre>{data.loadedThreads.join("\n")}{data.loadedThreadsMore?"\n…more loaded sessions not shown":""}</pre></details>}
        {data.diagnostics?.gauges?.length>0&&<details className="capability-details"><summary>All runtime gauges</summary><pre>{data.diagnostics.gauges.map(gauge=>gauge.name+": "+Number(gauge.value||0).toLocaleString()).join("\n")}</pre></details>}
        <ErrorLine value={errors["server/diagnostics"]}/><ErrorLine value={errors["thread/loaded/list"]}/>
      </Section>

      {platform==="win32"&&<Section title="Windows sandbox" icon={ShieldCheck}>
        {data.windowsSandbox?(()=>{const status=windowsSandboxStatus(data.windowsSandbox.status);return <div className="capability-kv"><div><span>Native sandbox</span><strong>{status.label}</strong></div><div><span>Managed setup modes</span><strong>{allowedWindowsSetupModes(data.requirements).length?allowedWindowsSetupModes(data.requirements).map(mode=>mode==="elevated"?"Elevated":"Unelevated").join(" · "):"Policy-managed"}</strong></div></div>})():<p>Windows sandbox readiness is unavailable from this Codex runtime.</p>}
        {data.windowsSandbox&&<p>{windowsSandboxStatus(data.windowsSandbox.status).detail}</p>}
        {data.windowsSandbox?.status!=="ready"&&<div className="capability-actions">
          <button onClick={()=>setupWindowsSandbox("unelevated")} disabled={!!busy||!!sandboxPending||!allowedWindowsSetupModes(data.requirements).includes("unelevated")}>{sandboxPending==="unelevated"?"Setting up…":"Set up unelevated"}</button>
          <button onClick={()=>setupWindowsSandbox("elevated")} disabled={!!busy||!!sandboxPending||!allowedWindowsSetupModes(data.requirements).includes("elevated")}>{sandboxPending==="elevated"?"Setting up…":"Set up elevated"}</button>
        </div>}
        {sandboxMessage&&<p className="capability-status">{sandboxMessage}</p>}
        {sandboxWarning&&<p className="capability-error">{sandboxWarning}</p>}
        <ErrorLine value={errors["windowsSandbox/readiness"]}/><ErrorLine value={errors["windowsSandbox/setupStart"]}/><ErrorLine value={errors["configRequirements/read"]}/>
      </Section>}

      <Section title="Configuration layers" icon={ShieldCheck} count={data.config?.layers?.length||0}>
        <div className="capability-list">{(data.config?.layers||[]).map((layer,index)=><div key={String(layer.name)+index}><div><strong>{String(layer.name)}</strong><span>{layer.disabledReason||`version ${layer.version}`}</span></div><em className={layer.disabledReason?"":"ok"}>{layer.disabledReason?"disabled":"active"}</em></div>)}</div>
        {configWarnings.length>0&&<div className="capability-list config-warning-list">{configWarnings.map((warning,index)=><div key={(warning.path||"global")+":"+(warning.summary||index)}><div><strong>{warning.summary||"Configuration warning"}</strong><span>{warning.details||warning.path||"Codex reported a configuration warning."}</span></div><em>warning</em></div>)}</div>}
        {runtimeNotices.length>0&&<div className="capability-list runtime-notice-list">{runtimeNotices.map(notice=><div key={notice.id}><div><strong>{notice.summary}</strong><span>{notice.details||"Reported by the Codex runtime."}</span></div><em>{notice.kind}</em></div>)}</div>}
        {data.config&&<details className="capability-details"><summary>Effective config</summary><pre>{JSON.stringify(data.config.config,null,2)}</pre></details>}
        <ErrorLine value={errors["config/read"]}/>
      </Section>

      <Section title="Provider capabilities" icon={Sparkles}>
        {data.capabilities?<div className="capability-badges">
          <span className={data.capabilities.namespaceTools?"ok":""}>Namespace tools</span>
          <span className={data.capabilities.webSearch?"ok":""}>Web search</span>
          <span className={data.capabilities.imageGeneration?"ok":""}>Image generation</span>
        </div>:<p>No capability report available.</p>}
        {modelNotices.length>0&&<><p className="capability-status">{modelNotices[0].title}{modelNotices[0].detail?" · "+modelNotices[0].detail:""}</p><details className="capability-details"><summary>Recent model routing & safety · {modelNotices.length}</summary><div className="capability-list">{modelNotices.map(notice=><div key={notice.id}><div><strong>{notice.title}</strong><span>{notice.detail||notice.kind}</span></div><em>{notice.kind}</em></div>)}</div></details></>}
        <ErrorLine value={errors["modelProvider/capabilities/read"]}/>
      </Section>

      <Section title="Permission profiles" icon={ShieldCheck} count={data.permissions.length}>
        <div className="capability-list">{data.permissions.map(p=><div key={p.id}><div><strong>{p.id}</strong><span>{p.description||"Codex permission profile"}</span></div><em className={p.allowed?"ok":""}>{p.allowed?"allowed":"blocked"}</em></div>)}</div>
        <ErrorLine value={errors["permissionProfile/list"]}/>
      </Section>

      <Section title="MCP servers" icon={PlugZap} count={data.mcp.length}>
        <div className="capability-actions"><button onClick={reloadMcp} disabled={!!busy}><RefreshCw size={12}/> Reload MCP</button></div>
        <div className="capability-list">{data.mcp.map(server=><div className="mcp-server-row" key={server.name}><div><strong>{server.name}</strong><span>{server.runtimeStatus||"unknown"} · {Object.keys(server.tools||{}).length} tools · {(server.resources||[]).length} resources</span></div><div className="capability-inline-actions"><em className={server.runtimeStatus==="connected"?"ok":""}>{server.authStatus||"unknown auth"}</em>{server.authStatus==="notLoggedIn"&&<button onClick={()=>loginMcp(server.name)} disabled={!!busy}>Sign in</button>}</div>{((server.resources||[]).length>0||Object.keys(server.tools||{}).length>0)&&<details className="mcp-server-details"><summary>Resources & tools</summary>
          {(server.resources||[]).map(resource=><div className="mcp-resource" key={resource.uri}><span>{resource.name||resource.uri}</span><button onClick={()=>readResource(server,resource)} disabled={!!busy}>Read</button></div>)}
          {Object.entries(server.tools||{}).map(([toolName,tool])=><div className="mcp-tool" key={toolName}><div><strong>{toolName}</strong><span>{tool?.description||"MCP tool"}</span></div><input value={toolArgs[server.name+":"+toolName]||""} onChange={e=>setToolArgs(prev=>({...prev,[server.name+":"+toolName]:e.target.value}))} placeholder='JSON arguments, e.g. {"query":"..."}'/><button onClick={()=>runMcpTool(server,toolName)} disabled={!!busy||!activeThread?.id}>Run</button></div>)}
        </details>}</div>)}</div>
        {mcpResult&&<details className="capability-details" open><summary>{mcpResult.title}</summary><pre>{JSON.stringify(mcpResult.value,null,2)}</pre></details>}
        <ErrorLine value={errors["mcpServerStatus/list"]}/>
      </Section>

      <Section title="Skills" icon={Wrench} count={skills.length}>
        <p>Enable or disable discovered skills with Codex's native config API. Disabled skills stay visible so they can be turned back on.</p>
        <div className="capability-list skill-list">{skills.map(s=><div key={s.path||s.name}><div><strong>{s.interface?.displayName||s.name}</strong><span>{s.interface?.shortDescription||s.shortDescription||s.description||s.path}{s.scope?` · ${s.scope}`:""}</span></div><button className={s.enabled!==false?"active":""} onClick={()=>toggleSkill(s)} disabled={!!busy||!s.path}>{busy==="skill:"+s.path?"Saving…":s.enabled===false?"Off":"On"}</button></div>)}</div>
        {!skills.length&&<p>No skills were discovered for this workspace.</p>}
        <div className="skill-roots-editor"><label><strong>Runtime-only extra roots</strong><span>One absolute skill-directory path per line. Applying replaces this Codex process's extra roots; restarting the app-server clears them.</span></label><textarea value={skillRootsText} onChange={e=>setSkillRootsText(e.target.value)} placeholder={platform==="win32"?"C:\\Users\\me\\skills\nD:\\shared-skills":"/home/me/skills\n/opt/shared-skills"}/><div className="capability-actions"><button onClick={applySkillRoots} disabled={!!busy}>{busy==="skill-roots"?"Applying…":"Apply runtime roots"}</button>{skillRootsText&&<button onClick={()=>setSkillRootsText("")} disabled={!!busy}>Clear draft</button>}</div></div>
        {skillMessage&&<p className="capability-status">{skillMessage}</p>}
        <ErrorLine value={errors["skills/config/write"]}/><ErrorLine value={errors["skills/extraRoots/set"]}/>
      </Section>

      <Section title="Plugins" icon={Blocks} count={plugins.length}>
        <div className="plugin-search-controls"><input value={pluginSearchTerm} onChange={e=>{setPluginSearchTerm(e.target.value);setPluginSearchResults([]);setPluginSearchCursor(null);setPluginSearchRan(false);setPluginDetail(null);setPluginSkillDetail(null)}} onKeyDown={e=>{if(e.key==="Enter")searchPlugins()}} placeholder="Search plugin catalog"/><select value={pluginSearchScope} onChange={e=>{setPluginSearchScope(e.target.value);setPluginSearchResults([]);setPluginSearchCursor(null);setPluginSearchRan(false);setPluginDetail(null);setPluginSkillDetail(null)}}><option value="global">Global</option><option value="workspace">Workspace</option><option value="personal">Personal</option></select><button onClick={()=>searchPlugins()} disabled={!!busy||pluginSearchTerm.trim().length<2}>{busy==="plugin:search"?"Searching…":"Search"}</button><button onClick={reconcilePlugins} disabled={!!busy}>Reconcile</button></div>
        {pluginSearchResults.length>0&&<div className="capability-list plugin-search-results">{pluginSearchResults.map(result=>{const plugin=result.plugin||{};const marketplace={name:result.marketplaceName,path:result.marketplacePath};return <div key={(result.marketplaceName||"")+":"+(plugin.id||plugin.name)}><div><strong>{plugin.interface?.displayName||plugin.name}</strong><span>{plugin.interface?.shortDescription||plugin.interface?.longDescription||result.marketplaceName}{plugin.version?" · "+plugin.version:""}</span></div><div className="capability-inline-actions"><button onClick={()=>readPlugin(plugin,marketplace)} disabled={!!busy}>Details</button><button onClick={()=>togglePlugin({...plugin,marketplace})} disabled={!!busy||plugin.availability==="unavailable"}>{plugin.installed?"Uninstall":"Install"}</button></div></div>})}</div>}
        {pluginSearchCursor&&<div className="capability-actions"><button onClick={()=>searchPlugins({append:true})} disabled={!!busy}>Load more</button></div>}
        {pluginSearchRan&&!pluginSearchResults.length&&!busy&&!errors["plugin/search"]&&<p>No plugins matched this search.</p>}
        {!pluginSearchRan&&<div className="capability-list">{plugins.map(plugin=><div key={plugin.marketplace.name+":"+plugin.id}><div><strong>{plugin.interface?.displayName||plugin.name}</strong><span>{plugin.marketplace.name}{plugin.version?" · "+plugin.version:""}{plugin.shareContext?.shareUrl?" · shared":""}</span></div><div className="capability-inline-actions"><button onClick={()=>readPlugin(plugin,plugin.marketplace)} disabled={!!busy}>Details</button>{plugin.source?.type==="local"&&<button onClick={()=>shareLocalPlugin(plugin)} disabled={!!busy}>{plugin.shareContext?.remotePluginId?"Update share":"Share privately"}</button>}<button onClick={()=>togglePlugin(plugin)} disabled={!!busy||plugin.availability==="unavailable"}>{plugin.installed?"Uninstall":"Install"}</button></div></div>)}</div>}
        {!pluginSearchRan&&!plugins.length&&<p>No plugin catalog is available in this runtime.</p>}
        {pluginDetail&&<div className="plugin-detail"><div className="plugin-detail-head"><div><strong>{pluginDetail.summary?.interface?.displayName||pluginDetail.summary?.name}</strong><span>{pluginDetail.marketplaceName}{pluginDetail.summary?.version?` · ${pluginDetail.summary.version}`:""}{pluginDetail.summary?.interface?.developerName?` · ${pluginDetail.summary.interface.developerName}`:""}</span></div><button onClick={()=>{setPluginDetail(null);setPluginSkillDetail(null)}}>Close</button></div>{(pluginDetail.description||pluginDetail.summary?.interface?.longDescription)&&<p>{pluginDetail.description||pluginDetail.summary.interface.longDescription}</p>}{pluginDetail.summary?.interface?.capabilities?.length>0&&<div className="capability-badges">{pluginDetail.summary.interface.capabilities.map(capability=><span className="ok" key={capability}>{capability}</span>)}</div>}<div className="plugin-detail-counts"><span>{pluginDetail.skills?.length||0} skills</span><span>{pluginDetail.hooks?.length||0} hooks</span><span>{pluginDetail.apps?.length||0} apps</span><span>{pluginDetail.mcpServers?.length||0} MCP servers</span><span>{pluginDetail.scheduledTasks?.length||0} scheduled tasks</span></div>{pluginDetail.skills?.length>0&&<div className="plugin-detail-skills">{pluginDetail.skills.map(skill=><div key={skill.name}><div><strong>{skill.interface?.displayName||skill.name}</strong><span>{skill.interface?.shortDescription||skill.shortDescription||skill.description}</span></div>{pluginDetail.summary?.remotePluginId&&pluginDetail.marketplaceName&&<button onClick={()=>readPluginSkill(skill)} disabled={!!busy}>{busy==="plugin:skill:"+skill.name?"Reading…":"Read skill"}</button>}</div>)}</div>}{pluginSkillDetail&&<details className="capability-details" open><summary>{pluginSkillDetail.name} · SKILL.md</summary><pre>{pluginSkillDetail.contents||"No skill contents were returned."}</pre></details>}</div>}
        {pluginMessage&&<p className="capability-status">{pluginMessage}</p>}
        <ErrorLine value={errors["plugin/list"]}/><ErrorLine value={errors["plugin/search"]}/><ErrorLine value={errors["plugin/read"]}/><ErrorLine value={errors["plugin/skill/read"]}/><ErrorLine value={errors["plugin/reconcile"]}/><ErrorLine value={errors["plugin/share/save"]}/>
      </Section>

      <Section title="Shared plugins" icon={Blocks} count={data.sharedPlugins.length}>
        <p>Codex plugin sharing is account-backed. Local plugins are first shared privately; visibility can then be changed without inventing recipients.</p>
        <div className="capability-list shared-plugin-list">{data.sharedPlugins.map(item=>{const plugin=item.plugin||{};const context=plugin.shareContext||{};const remotePluginId=plugin.remotePluginId||context.remotePluginId;return <div key={remotePluginId||plugin.id}><div><strong>{plugin.name||plugin.id}</strong><span>{plugin.version||plugin.localVersion||"shared plugin"}{context.creatorName?` · ${context.creatorName}`:""}</span></div><div className="capability-inline-actions">{context.shareUrl&&<button onClick={()=>window.open(context.shareUrl,"_blank","noopener,noreferrer")}>Open</button>}{!item.localPluginPath&&remotePluginId&&<button onClick={()=>checkoutSharedPlugin(item)} disabled={!!busy}>Checkout</button>}{context.discoverability&&<select value={context.discoverability} onChange={e=>updateShareDiscoverability(item,e.target.value)} disabled={!!busy}><option value="PRIVATE">Private</option><option value="UNLISTED">Unlisted</option><option value="LISTED">Listed</option></select>}{remotePluginId&&<button onClick={()=>deleteSharedPlugin(item)} disabled={!!busy}>Delete share</button>}</div></div>})}</div>
        {!data.sharedPlugins.length&&!errors["plugin/share/list"]&&<p>No shared plugins were returned for this account.</p>}
        <ErrorLine value={errors["plugin/share/list"]}/><ErrorLine value={errors["plugin/share/checkout"]}/><ErrorLine value={errors["plugin/share/delete"]}/><ErrorLine value={errors["plugin/share/updateTargets"]}/>
      </Section>

      <Section title="Marketplaces" icon={Blocks} count={data.marketplaces.length}>
        <div className="capability-actions marketplace-add"><input value={marketplaceSource} onChange={e=>setMarketplaceSource(e.target.value)} placeholder="Git URL or local marketplace source"/><button onClick={addMarketplace} disabled={!!busy||!marketplaceSource.trim()}>Add</button><button onClick={()=>upgradeMarketplace(null)} disabled={!!busy||!data.marketplaces.length}>Upgrade all</button></div>
        <div className="capability-list">{data.marketplaces.map(marketplace=><div key={marketplace.name}><div><strong>{marketplace.interface?.displayName||marketplace.name}</strong><span>{marketplace.path||`${(marketplace.plugins||[]).length} catalog plugins`}</span></div><div className="capability-inline-actions"><button onClick={()=>upgradeMarketplace(marketplace.name)} disabled={!!busy}>Upgrade</button>{marketplace.path&&<button onClick={()=>removeMarketplace(marketplace.name)} disabled={!!busy}>Remove</button>}</div></div>)}</div>
      </Section>

      <Section title="Apps / connectors" icon={CheckCircle2} count={data.apps.length}>
        <div className="connector-runtime-summary"><span>{data.installedApps.length} installed · {data.installedApps.filter(app=>app.callable).length} callable now</span><button onClick={refreshInstalledApps} disabled={!!busy}>{busy==="apps:installed"?"Refreshing…":"Refresh runtime"}</button></div>
        <div className="capability-list">{data.apps.map(app=>{const runtime=installedAppsById[app.id];const status=runtime?(runtime.callable?"callable":runtime.enabled?"installed":"disabled"):(app.isEnabled?"catalog only":"disabled");return <div key={app.id}><div><strong>{app.name}</strong><span>{app.description||app.id}</span></div><div className="capability-inline-actions"><em className={runtime?.callable?"ok":""}>{status}</em><button onClick={()=>readApp(app)} disabled={busy==="app:"+app.id}>Details</button></div></div>})}</div>
        {!data.apps.length&&<p>No app connectors reported by Codex.</p>}
        {appDetail&&<div className="app-detail"><div className="app-detail-head"><div><strong>{appDetail.name}</strong><span>{appDetail.distributionChannel||appDetail.id}</span></div><button onClick={()=>setAppDetail(null)}>Close</button></div>{appDetail.description&&<p>{appDetail.description}</p>}{appDetail.pluginDisplayNames?.length>0&&<p>Provided by: {appDetail.pluginDisplayNames.join(", ")}</p>}{appDetail.installUrl&&<button className="setting-action" onClick={()=>window.open(appDetail.installUrl,"_blank","noopener,noreferrer")}>Open install page</button>}{appDetail.toolSummaries?.length>0&&<div className="app-tools">{appDetail.toolSummaries.map(tool=><div key={tool.name}><div><strong>{tool.title||tool.name}</strong><span>{tool.description||tool.name}</span></div><em className={tool.isEnabled?"ok":""}>{tool.isEnabled?(tool.isReadOnly?"read only":"enabled"):(tool.disabledReason||"disabled")}</em></div>)}</div>}</div>}
        <ErrorLine value={errors["app/list"]}/><ErrorLine value={errors["app/installed"]}/><ErrorLine value={errors["app/read"]}/>
      </Section>

      <Section title="Hooks" icon={Wrench} count={hookCount}>
        <div className="capability-list">{data.hooks.flatMap(entry=>(entry.hooks||[]).map((hook,index)=><div key={entry.cwd+":"+index}><div><strong>{hook.name||hook.event||"Hook"}</strong><span>{entry.cwd}</span></div><em className="ok">loaded</em></div>))}</div>
        {!hookCount&&<p>No project hooks loaded.</p>}
        {hookRuns.length>0&&<details className="capability-details" open><summary>Recent hook runs · {hookRuns.length}</summary><div className="capability-list hook-run-list">{hookRuns.map(run=><div key={run.id}><div><strong>{run.eventName||run.id}</strong><span>{run.statusMessage||run.sourcePath||run.handlerType||"Hook execution"}</span></div><em className={run.status==="completed"||run.status==="success"?"ok":""}>{run.durationMs!=null?`${Number(run.durationMs).toLocaleString()} ms`:run.status||"running"}</em></div>)}</div></details>}
        <ErrorLine value={errors["hooks/list"]}/>
      </Section>

      <Section title="Experimental features" icon={FlaskConical} count={data.features.length}>
        <div className="capability-list feature-list">{data.features.map(feature=><div key={feature.name}><div><strong>{feature.displayName||feature.name}</strong><span>{feature.description||feature.stage}</span></div><button className={feature.enabled?"active":""} onClick={()=>toggleFeature(feature)} disabled={!!busy}>{feature.enabled?"On":"Off"}</button></div>)}</div>
        <ErrorLine value={errors["experimentalFeature/list"]}/><ErrorLine value={errors["experimentalFeature/enablement/set"]}/>
      </Section>

      <Section title="Conversation history" icon={RefreshCw} count={historyImport?.sessions?.length||0}>
        <p>Copy recent local Codex and Claude conversations into Trebell. Source transcripts stay untouched; imported Codex sessions become independent Trebell forks.</p>
        <div className="capability-actions">
          <button onClick={scanHistory} disabled={!!busy}>{busy==="history:scan"?"Scanning…":"Scan history"}</button>
          {(historyImport?.sessions||[]).some(item=>!item.alreadyImported&&(item.source!=="codex"||historyImport.codexImportAvailable))&&<button onClick={()=>importHistory((historyImport.sessions||[]).filter(item=>!item.alreadyImported&&(item.source!=="codex"||historyImport.codexImportAvailable)).map(item=>item.id))} disabled={!!busy}>{busy==="history:import"?"Importing…":"Import available"}</button>}
        </div>
        <div className="capability-list history-import-list">{(historyImport?.sessions||[]).slice(0,30).map(item=><div key={item.id}><div><strong>{item.title||"Untitled conversation"}</strong><span>{item.source==="codex"?"Codex":"Claude"} · {item.cwd}</span></div><div className="capability-inline-actions"><em className={item.alreadyImported?"ok":""}>{item.alreadyImported?"imported":item.source==="codex"&&!historyImport.codexImportAvailable?"needs local Codex":"available"}</em>{!item.alreadyImported&&(item.source!=="codex"||historyImport.codexImportAvailable)&&<button onClick={()=>importHistory([item.id])} disabled={!!busy}>Import</button>}</div></div>)}</div>
        {historyImport&&!(historyImport.sessions||[]).length&&<p>No recent local agent history was found.</p>}
        {historyMessage&&<p className="capability-status">{historyMessage}</p>}
      </Section>

      <Section title="Import agent configuration" icon={RefreshCw} count={migrations?.items?.length||0}>
        <p>Detect reusable configuration from supported external coding agents in your home directory and this workspace.</p>
        <div className="capability-actions"><button onClick={detectExternalConfig} disabled={!!busy||!!migrationImportId}>Scan</button>{migrations?.items?.length>0&&<button onClick={importExternalConfig} disabled={!!busy||!!migrationImportId}>{migrationImportId?"Importing…":"Import "+migrations.items.length+" items"}</button>}</div>
        <div className="capability-list">{(migrations?.items||[]).map((item,index)=><div key={index}><div><strong>{item.description||String(item.itemType)}</strong><span>{item.cwd||"User scope"}</span></div><em>{String(item.itemType)}</em></div>)}</div>
        {(migrations?.connectors||[]).length>0&&<p>{migrations.connectors.length} connector candidate{migrations.connectors.length===1?"":"s"} detected.</p>}
        {migrationMessage&&<p className="capability-status">{migrationMessage}</p>}
        {(migrationHistory.data||[]).length>0&&<details className="capability-details"><summary>Previous native imports · {migrationHistory.data.length}</summary><div className="capability-list migration-history-list">{migrationHistory.data.slice(0,8).map(entry=>{const successes=entry.successes?.length||0,failures=entry.failures?.length||0;return <div key={entry.importId}><div><strong>{entry.providerId||"External agent import"}</strong><span>{new Date(Number(entry.completedAtMs)||0).toLocaleString()} · {successes} imported{failures?" · "+failures+" failed":""}</span></div><em className={failures?"":"ok"}>{failures?"review":"done"}</em></div>})}</div></details>}
        {(migrationHistory.connectors||[]).length>0&&<details className="capability-details"><summary>Imported connector candidates · {migrationHistory.connectors.length}</summary><div className="capability-list">{migrationHistory.connectors.map(item=><div key={item.name}><div><strong>{item.name}</strong><span>{Number(item.sessionCount||0).toLocaleString()} imported session{Number(item.sessionCount||0)===1?"":"s"}</span></div><em>candidate</em></div>)}</div></details>}
        <ErrorLine value={errors["externalAgentConfig/detect"]}/><ErrorLine value={errors["externalAgentConfig/import"]}/><ErrorLine value={errors["externalAgentConfig/import/readHistories"]}/>
      </Section>
    </div>
  </div>;
}
