import React,{useEffect,useMemo,useState} from "react";
import { Blocks, CheckCircle2, FlaskConical, PlugZap, RefreshCw, ShieldCheck, Sparkles, Wrench } from "lucide-react";

function Section({title,icon:Icon,count,children}){
  return <section className="capability-card"><div className="capability-card-head"><span><Icon size={15}/><strong>{title}</strong></span>{Number.isFinite(count)&&<em>{count}</em>}</div>{children}</section>;
}
function ErrorLine({value}){return value?<p className="capability-error">{value}</p>:null}

export default function HarnessToolsPage({rpc,rpcStatus,projectPath,activeThread,skills=[]}){
  const [data,setData]=useState({permissions:[],mcp:[],marketplaces:[],apps:[],hooks:[],features:[],capabilities:null,account:null,rateLimits:null,usage:null,config:null});
  const [errors,setErrors]=useState({});
  const [loading,setLoading]=useState(false);
  const [busy,setBusy]=useState("");
  const [marketplaceSource,setMarketplaceSource]=useState("");
  const [migrations,setMigrations]=useState(null);
  const [mcpResult,setMcpResult]=useState(null);
  const [appDetail,setAppDetail]=useState(null);
  const [toolArgs,setToolArgs]=useState({});

  async function call(name,params){
    try{return await rpc.request(name,params)}
    catch(error){setErrors(prev=>({...prev,[name]:error.message||String(error)}));return null}
  }
  async function refresh(){
    if(!rpc||rpcStatus!=="connected")return;
    setLoading(true);setErrors({});
    const threadId=activeThread?.id||null;
    const [permissions,mcp,plugins,apps,hooks,features,capabilities,account,rateLimits,usage,config]=await Promise.all([
      call("permissionProfile/list",{limit:100,cwd:projectPath||null}),
      call("mcpServerStatus/list",{limit:100,detail:"full",threadId}),
      call("plugin/list",{cwds:projectPath?[projectPath]:[],forceRefetch:false}),
      call("app/list",{limit:100,threadId,forceRefetch:false}),
      call("hooks/list",{cwds:projectPath?[projectPath]:[]}),
      call("experimentalFeature/list",{limit:200,threadId}),
      call("modelProvider/capabilities/read",{}),
      call("account/read",{refreshToken:false}),
      call("account/rateLimits/read",{excludeResetCreditDetails:true}),
      call("account/usage/read",threadId?{threadId}:{}),
      call("config/read",{includeLayers:true,cwd:projectPath||null}),
    ]);
    setData({
      permissions:permissions?.data||[],
      mcp:mcp?.data||[],
      marketplaces:plugins?.marketplaces||[],
      apps:apps?.data||[],
      hooks:hooks?.data||[],
      features:features?.data||[],
      capabilities:capabilities||null,
      account:account||null,
      rateLimits:rateLimits||null,
      usage:usage||null,
      config:config||null,
    });
    setLoading(false);
  }
  useEffect(()=>{refresh()},[rpc,rpcStatus,projectPath,activeThread?.id]);

  const plugins=useMemo(()=>data.marketplaces.flatMap(m=>(m.plugins||[]).map(p=>({...p,marketplace:m}))),[data.marketplaces]);
  const hookCount=data.hooks.reduce((n,x)=>n+(x.hooks?.length||0),0);

  async function reloadMcp(){
    if(!rpc)return;setBusy("mcp");
    try{await rpc.request("config/mcpServer/reload",undefined);await refresh()}finally{setBusy("")}
  }
  async function loginMcp(name){
    if(!rpc)return;setBusy("mcp:"+name);
    try{await rpc.request("mcpServer/oauth/login",{name,threadId:activeThread?.id||null});await refresh()}finally{setBusy("")}
  }
  async function togglePlugin(plugin){
    if(!rpc)return;setBusy("plugin:"+plugin.id);
    try{
      if(plugin.installed)await rpc.request("plugin/uninstall",{pluginId:plugin.id});
      else await rpc.request("plugin/install",{
        pluginName:plugin.name,
        marketplacePath:plugin.marketplace?.path||null,
        remoteMarketplaceName:plugin.marketplace?.path?null:(plugin.marketplace?.name||null),
        installAttemptId:crypto.randomUUID(),
      });
      await refresh();
    }finally{setBusy("")}
  }
  async function toggleFeature(feature){
    if(!rpc)return;setBusy("feature:"+feature.name);
    try{await rpc.request("experimentalFeature/enablement/set",{enablement:{[feature.name]:!feature.enabled}});await refresh()}finally{setBusy("")}
  }
  async function addMarketplace(){
    const source=marketplaceSource.trim();if(!source||!rpc)return;setBusy("marketplace:add");
    try{await rpc.request("marketplace/add",{source});setMarketplaceSource("");await refresh()}finally{setBusy("")}
  }
  async function removeMarketplace(name){
    if(!rpc||!name)return;setBusy("marketplace:"+name);
    try{await rpc.request("marketplace/remove",{marketplaceName:name});await refresh()}finally{setBusy("")}
  }
  async function upgradeMarketplace(name=null){
    if(!rpc)return;setBusy("marketplace:"+(name||"all"));
    try{await rpc.request("marketplace/upgrade",{marketplaceName:name});await refresh()}finally{setBusy("")}
  }
  async function detectExternalConfig(){
    if(!rpc)return;setBusy("migration:detect");
    try{const result=await rpc.request("externalAgentConfig/detect",{includeHome:true,cwds:projectPath?[projectPath]:[],maxSessionAgeDays:90,maxSessions:100});setMigrations(result)}
    catch(error){setErrors(prev=>({...prev,"externalAgentConfig/detect":error.message||String(error)}))}finally{setBusy("")}
  }
  async function importExternalConfig(){
    if(!rpc||!migrations?.items?.length)return;setBusy("migration:import");
    try{await rpc.request("externalAgentConfig/import",{migrationItems:migrations.items,source:"trebell-code"});await detectExternalConfig()}
    catch(error){setErrors(prev=>({...prev,"externalAgentConfig/import":error.message||String(error)}))}finally{setBusy("")}
  }
  async function readResource(server,resource){
    if(!rpc)return;setBusy("resource:"+resource.uri);
    try{const result=await rpc.request("mcpServer/resource/read",{threadId:activeThread?.id||null,server:server.name,uri:resource.uri});setMcpResult({title:`${server.name} · ${resource.name||resource.uri}`,value:result})}
    catch(error){setMcpResult({title:"MCP resource error",value:{error:error.message}})}finally{setBusy("")}
  }
  async function runMcpTool(server,toolName){
    if(!rpc||!activeThread?.id)return;
    let args={};const raw=toolArgs[server.name+":"+toolName]?.trim();if(raw){try{args=JSON.parse(raw)}catch{setMcpResult({title:"Invalid tool arguments",value:{error:"Arguments must be valid JSON."}});return}}
    setBusy("tool:"+server.name+":"+toolName);
    try{const result=await rpc.request("mcpServer/tool/call",{threadId:activeThread.id,server:server.name,tool:toolName,arguments:args});setMcpResult({title:`${server.name} · ${toolName}`,value:result})}
    catch(error){setMcpResult({title:"MCP tool error",value:{error:error.message}})}finally{setBusy("")}
  }
  async function readApp(app){
    if(!rpc||!app?.id)return;setBusy("app:"+app.id);setErrors(prev=>({...prev,"app/read":null}));
    try{
      const result=await rpc.request("app/read",{appIds:[app.id],threadId:activeThread?.id||null,includeTools:true});
      const detail=result?.apps?.[0];if(!detail)throw new Error(result?.missingAppIds?.includes(app.id)?"Connector metadata is unavailable":"Codex did not return connector metadata");setAppDetail({...app,...detail});
    }catch(error){setErrors(prev=>({...prev,"app/read":error.message||String(error)}))}finally{setBusy("")}
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
        <ErrorLine value={errors["account/read"]}/><ErrorLine value={errors["account/rateLimits/read"]}/><ErrorLine value={errors["account/usage/read"]}/>
      </Section>

      <Section title="Configuration layers" icon={ShieldCheck} count={data.config?.layers?.length||0}>
        <div className="capability-list">{(data.config?.layers||[]).map((layer,index)=><div key={String(layer.name)+index}><div><strong>{String(layer.name)}</strong><span>{layer.disabledReason||`version ${layer.version}`}</span></div><em className={layer.disabledReason?"":"ok"}>{layer.disabledReason?"disabled":"active"}</em></div>)}</div>
        {data.config&&<details className="capability-details"><summary>Effective config</summary><pre>{JSON.stringify(data.config.config,null,2)}</pre></details>}
        <ErrorLine value={errors["config/read"]}/>
      </Section>

      <Section title="Provider capabilities" icon={Sparkles}>
        {data.capabilities?<div className="capability-badges">
          <span className={data.capabilities.namespaceTools?"ok":""}>Namespace tools</span>
          <span className={data.capabilities.webSearch?"ok":""}>Web search</span>
          <span className={data.capabilities.imageGeneration?"ok":""}>Image generation</span>
        </div>:<p>No capability report available.</p>}
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
        <div className="capability-list">{skills.map(s=><div key={s.path||s.name}><div><strong>{s.name}</strong><span>{s.description||s.path}</span></div><em className="ok">enabled</em></div>)}</div>
        {!skills.length&&<p>No enabled skills found for this workspace.</p>}
      </Section>

      <Section title="Plugins" icon={Blocks} count={plugins.length}>
        <div className="capability-list">{plugins.map(plugin=><div key={plugin.marketplace.name+":"+plugin.id}><div><strong>{plugin.name}</strong><span>{plugin.marketplace.name}{plugin.version?" · "+plugin.version:""}</span></div><button onClick={()=>togglePlugin(plugin)} disabled={!!busy||plugin.availability==="unavailable"}>{plugin.installed?"Uninstall":"Install"}</button></div>)}</div>
        {!plugins.length&&<p>No plugin catalog is available in this runtime.</p>}
        <ErrorLine value={errors["plugin/list"]}/>
      </Section>

      <Section title="Marketplaces" icon={Blocks} count={data.marketplaces.length}>
        <div className="capability-actions marketplace-add"><input value={marketplaceSource} onChange={e=>setMarketplaceSource(e.target.value)} placeholder="Git URL or local marketplace source"/><button onClick={addMarketplace} disabled={!!busy||!marketplaceSource.trim()}>Add</button><button onClick={()=>upgradeMarketplace(null)} disabled={!!busy||!data.marketplaces.length}>Upgrade all</button></div>
        <div className="capability-list">{data.marketplaces.map(marketplace=><div key={marketplace.name}><div><strong>{marketplace.interface?.displayName||marketplace.name}</strong><span>{marketplace.path||`${(marketplace.plugins||[]).length} catalog plugins`}</span></div><div className="capability-inline-actions"><button onClick={()=>upgradeMarketplace(marketplace.name)} disabled={!!busy}>Upgrade</button>{marketplace.path&&<button onClick={()=>removeMarketplace(marketplace.name)} disabled={!!busy}>Remove</button>}</div></div>)}</div>
      </Section>

      <Section title="Apps / connectors" icon={CheckCircle2} count={data.apps.length}>
        <div className="capability-list">{data.apps.map(app=><div key={app.id}><div><strong>{app.name}</strong><span>{app.description||app.id}</span></div><div className="capability-inline-actions"><em className={app.isAccessible&&app.isEnabled?"ok":""}>{app.isEnabled?(app.isAccessible?"ready":"restricted"):"disabled"}</em><button onClick={()=>readApp(app)} disabled={busy==="app:"+app.id}>Details</button></div></div>)}</div>
        {!data.apps.length&&<p>No app connectors reported by Codex.</p>}
        {appDetail&&<div className="app-detail"><div className="app-detail-head"><div><strong>{appDetail.name}</strong><span>{appDetail.distributionChannel||appDetail.id}</span></div><button onClick={()=>setAppDetail(null)}>Close</button></div>{appDetail.description&&<p>{appDetail.description}</p>}{appDetail.pluginDisplayNames?.length>0&&<p>Provided by: {appDetail.pluginDisplayNames.join(", ")}</p>}{appDetail.installUrl&&<button className="setting-action" onClick={()=>window.open(appDetail.installUrl,"_blank","noopener,noreferrer")}>Open install page</button>}{appDetail.toolSummaries?.length>0&&<div className="app-tools">{appDetail.toolSummaries.map(tool=><div key={tool.name}><div><strong>{tool.title||tool.name}</strong><span>{tool.description||tool.name}</span></div><em className={tool.isEnabled?"ok":""}>{tool.isEnabled?(tool.isReadOnly?"read only":"enabled"):(tool.disabledReason||"disabled")}</em></div>)}</div>}</div>}
        <ErrorLine value={errors["app/list"]}/><ErrorLine value={errors["app/read"]}/>
      </Section>

      <Section title="Hooks" icon={Wrench} count={hookCount}>
        <div className="capability-list">{data.hooks.flatMap(entry=>(entry.hooks||[]).map((hook,index)=><div key={entry.cwd+":"+index}><div><strong>{hook.name||hook.event||"Hook"}</strong><span>{entry.cwd}</span></div><em className="ok">loaded</em></div>))}</div>
        {!hookCount&&<p>No project hooks loaded.</p>}
        <ErrorLine value={errors["hooks/list"]}/>
      </Section>

      <Section title="Experimental features" icon={FlaskConical} count={data.features.length}>
        <div className="capability-list feature-list">{data.features.map(feature=><div key={feature.name}><div><strong>{feature.displayName||feature.name}</strong><span>{feature.description||feature.stage}</span></div><button className={feature.enabled?"active":""} onClick={()=>toggleFeature(feature)} disabled={!!busy}>{feature.enabled?"On":"Off"}</button></div>)}</div>
        <ErrorLine value={errors["experimentalFeature/list"]}/>
      </Section>

      <Section title="Import agent configuration" icon={RefreshCw} count={migrations?.items?.length||0}>
        <p>Detect reusable configuration from supported external coding agents in your home directory and this workspace.</p>
        <div className="capability-actions"><button onClick={detectExternalConfig} disabled={!!busy}>Scan</button>{migrations?.items?.length>0&&<button onClick={importExternalConfig} disabled={!!busy}>Import {migrations.items.length} items</button>}</div>
        <div className="capability-list">{(migrations?.items||[]).map((item,index)=><div key={index}><div><strong>{item.description||String(item.itemType)}</strong><span>{item.cwd||"User scope"}</span></div><em>{String(item.itemType)}</em></div>)}</div>
        {(migrations?.connectors||[]).length>0&&<p>{migrations.connectors.length} connector candidate{migrations.connectors.length===1?"":"s"} detected.</p>}
        <ErrorLine value={errors["externalAgentConfig/detect"]}/><ErrorLine value={errors["externalAgentConfig/import"]}/>
      </Section>
    </div>
  </div>;
}
