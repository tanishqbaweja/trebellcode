import React,{useEffect,useMemo,useState} from "react";
import { Blocks, CheckCircle2, FlaskConical, PlugZap, RefreshCw, ShieldCheck, Sparkles, Wrench } from "lucide-react";

function Section({title,icon:Icon,count,children}){
  return <section className="capability-card"><div className="capability-card-head"><span><Icon size={15}/><strong>{title}</strong></span>{Number.isFinite(count)&&<em>{count}</em>}</div>{children}</section>;
}
function ErrorLine({value}){return value?<p className="capability-error">{value}</p>:null}

export default function HarnessToolsPage({rpc,rpcStatus,projectPath,activeThread,skills=[]}){
  const [data,setData]=useState({permissions:[],mcp:[],marketplaces:[],apps:[],hooks:[],features:[],capabilities:null});
  const [errors,setErrors]=useState({});
  const [loading,setLoading]=useState(false);
  const [busy,setBusy]=useState("");

  async function call(name,params){
    try{return await rpc.request(name,params)}
    catch(error){setErrors(prev=>({...prev,[name]:error.message||String(error)}));return null}
  }
  async function refresh(){
    if(!rpc||rpcStatus!=="connected")return;
    setLoading(true);setErrors({});
    const threadId=activeThread?.id||null;
    const [permissions,mcp,plugins,apps,hooks,features,capabilities]=await Promise.all([
      call("permissionProfile/list",{limit:100,cwd:projectPath||null}),
      call("mcpServerStatus/list",{limit:100,detail:"full",threadId}),
      call("plugin/list",{cwds:projectPath?[projectPath]:[],forceRefetch:false}),
      call("app/list",{limit:100,threadId,forceRefetch:false}),
      call("hooks/list",{cwds:projectPath?[projectPath]:[]}),
      call("experimentalFeature/list",{limit:200,threadId}),
      call("modelProvider/capabilities/read",{}),
    ]);
    setData({
      permissions:permissions?.data||[],
      mcp:mcp?.data||[],
      marketplaces:plugins?.marketplaces||[],
      apps:apps?.data||[],
      hooks:hooks?.data||[],
      features:features?.data||[],
      capabilities:capabilities||null,
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

  if(rpcStatus!=="connected")return <div className="empty-state"><Wrench size={28}/><strong>Codex harness is not connected</strong><span>Capabilities will appear when app-server is ready.</span></div>;

  return <div className="capabilities-page">
    <div className="capabilities-toolbar"><div><h2>Harness capabilities</h2><p>Live inventory from the bundled Codex app-server. These are real runtime capabilities, not a hard-coded parity list.</p></div><button onClick={refresh} disabled={loading}><RefreshCw size={13}/>{loading?"Refreshing…":"Refresh"}</button></div>

    <div className="capability-grid">
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
        <div className="capability-list">{data.mcp.map(server=><div key={server.name}><div><strong>{server.name}</strong><span>{server.runtimeStatus||"unknown"} · {Object.keys(server.tools||{}).length} tools · {(server.resources||[]).length} resources</span></div><div className="capability-inline-actions"><em className={server.runtimeStatus==="connected"?"ok":""}>{server.authStatus||"unknown auth"}</em>{server.authStatus==="notLoggedIn"&&<button onClick={()=>loginMcp(server.name)} disabled={!!busy}>Sign in</button>}</div></div>)}</div>
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

      <Section title="Apps / connectors" icon={CheckCircle2} count={data.apps.length}>
        <div className="capability-list">{data.apps.map(app=><div key={app.id}><div><strong>{app.name}</strong><span>{app.description||app.id}</span></div><em className={app.isAccessible&&app.isEnabled?"ok":""}>{app.isEnabled?(app.isAccessible?"ready":"restricted"):"disabled"}</em></div>)}</div>
        {!data.apps.length&&<p>No app connectors reported by Codex.</p>}
        <ErrorLine value={errors["app/list"]}/>
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
    </div>
  </div>;
}
