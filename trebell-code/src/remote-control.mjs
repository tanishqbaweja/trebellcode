import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { timingSafeEqual } from "node:crypto";
import { attachCodexRelay } from "./codex-relay.mjs";

function json(res,status,body){
  const data=Buffer.from(JSON.stringify(body));
  res.writeHead(status,{
    "content-type":"application/json; charset=utf-8",
    "content-length":String(data.length),
    "cache-control":"no-store",
    "x-content-type-options":"nosniff",
  });
  res.end(data);
}

async function readJson(req,maxBytes=1024*1024){
  let body="";
  for await(const chunk of req){
    body+=chunk;
    if(Buffer.byteLength(body,"utf8")>maxBytes) throw new Error("request_too_large");
  }
  if(!body)return {};
  return JSON.parse(body);
}

function authToken(req,url){
  const header=String(req.headers.authorization||"");
  if(header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return url.searchParams.get("token")||"";
}

function sameToken(actual,expected){
  const a=Buffer.from(String(actual));
  const b=Buffer.from(String(expected));
  return a.length===b.length&&a.length>0&&timingSafeEqual(a,b);
}

function lanUrls(port,fragmentKey=null,fragmentValue=null){
  const result=[];
  const seen=new Set();
  for(const entries of Object.values(networkInterfaces())){
    for(const info of entries||[]){
      if(info.family!=="IPv4"||info.internal)continue;
      const fragment=fragmentKey&&fragmentValue?"#"+encodeURIComponent(fragmentKey)+"="+encodeURIComponent(fragmentValue):"";
      const url="http://"+info.address+":"+port+"/"+fragment;
      if(!seen.has(url)){seen.add(url);result.push(url)}
    }
  }
  return result;
}

function mobileHtml(){
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">",
    "<title>Trebell Remote</title>",
    "<style>",
    "*{box-sizing:border-box}body{margin:0;background:#0b0d12;color:#e7e9ef;font:14px system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:760px;margin:auto;padding:18px;display:grid;gap:12px}header{display:flex;align-items:center;justify-content:space-between;gap:10px}h1{font-size:20px;margin:0}small,.muted{color:#858b99}.card{border:1px solid #292e3a;background:#11151d;border-radius:14px;padding:14px;display:grid;gap:10px}input,select,textarea,button{font:inherit;border-radius:10px;border:1px solid #343a48;background:#0b0f16;color:#e2e5ec}input,select,textarea{width:100%;padding:10px}textarea{min-height:100px;resize:vertical}button{padding:10px 13px;cursor:pointer}button.primary{background:#6a43a3;border-color:#855abf}button:disabled{opacity:.45}.row{display:flex;gap:8px;align-items:center}.row>*{min-width:0}.grow{flex:1}.status{font-size:12px;color:#9da4b3}.ok{color:#8bd09d}.bad{color:#df8d9a}.threads{display:grid;gap:6px;max-height:220px;overflow:auto}.thread{padding:9px;text-align:left}.thread.active{border-color:#8356b8;background:#20162c}pre{margin:0;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto;background:#090c12;border-radius:10px;padding:10px;color:#bfc6d4}.output{min-height:80px}@media(max-width:520px){main{padding:12px}.row.stack{display:grid;grid-template-columns:1fr}button{min-height:43px}}</style>",
    "</head><body><main>",
    "<header><div><h1>Trebell Remote</h1><div class=\"muted\">Control your desktop harness from this device</div></div><div id=\"connection\" class=\"status\">Disconnected</div></header>",
    "<section class=\"card\"><div class=\"row stack\"><input id=\"token\" class=\"grow\" type=\"password\" placeholder=\"Device session token\"><button id=\"connect\" class=\"primary\">Connect</button></div><div id=\"status\" class=\"status\"></div></section>",
    "<section class=\"card\"><div class=\"row\"><strong class=\"grow\">Threads</strong><button id=\"refreshThreads\">Refresh</button><button id=\"newThread\">New</button></div><div id=\"threads\" class=\"threads\"></div></section>",
    "<section class=\"card\"><div class=\"row stack\"><select id=\"permission\"><option value=\"supervised\">Supervised</option><option value=\"auto\">Auto</option><option value=\"full\">Full access</option><option value=\"read-only\">Read only</option></select><input id=\"cwd\" placeholder=\"Workspace path\"></div><textarea id=\"prompt\" placeholder=\"Ask Trebell to do something…\"></textarea><div class=\"row\"><button id=\"stop\">Stop</button><button id=\"send\" class=\"primary grow\">Send</button></div><pre id=\"transcript\" class=\"output\"></pre></section>",
    "<section class=\"card\"><strong>Remote environments</strong><div class=\"row stack\"><select id=\"environment\" class=\"grow\"></select><button id=\"probe\">Test</button></div><input id=\"command\" placeholder=\"Command to run\"><button id=\"runCommand\">Run command</button><pre id=\"commandOutput\" class=\"output\"></pre></section>",
    "</main><script>",
    "(function(){",
    "const $=id=>document.getElementById(id);let ws=null,pending=new Map(),seq=1,activeThread=null,activeTurn=null,statusData=null;",
    "const hash=new URLSearchParams(location.hash.replace(/^#/,''));let pairToken=hash.get('pair')||'';const saved=localStorage.getItem('trebellRemoteSession')||localStorage.getItem('trebellRemoteToken')||'';$('token').value=saved;if(pairToken||hash.get('token'))history.replaceState(null,'',location.pathname);",
    "function token(){return $('token').value.trim()}",
    "function api(path,options={}){return fetch(path,{...options,headers:{'content-type':'application/json','authorization':'Bearer '+token(),...(options.headers||{})},body:options.body?JSON.stringify(options.body):undefined}).then(async r=>{const t=await r.text();const d=t?JSON.parse(t):{};if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d})}",
    "function request(method,params={}){return new Promise((resolve,reject)=>{const id=seq++;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);reject(new Error(method+' timed out'))}},20000)})}",
    "function respond(id,result,error){ws.send(JSON.stringify(error?{id,error}:{id,result}))}",
    "function approvalResult(msg,accept){if(msg.method==='item/permissions/requestApproval')return {permissions:accept?(msg.params?.permissions||{}):{},scope:'turn'};return {decision:accept?'accept':'decline'}}",
    "function mcpElicitationResult(msg){const p=msg.params||{},meta=p._meta||{};if(p.mode==='openai/userVerification')return {action:'cancel',content:null,_meta:null};if(p.mode==='url'){if(p.url&&confirm((p.message||'This app needs a browser step.')+'\\n\\nOpen the link now?'))window.open(p.url,'_blank','noopener,noreferrer');return {action:confirm('Did you complete the requested browser step?')?'accept':'decline',content:null,_meta:null}}if(['form','openai/form','openaiForm'].includes(p.mode)){if(meta.codex_approval_kind==='mcp_tool_call'){const actor=meta.connector_name||meta.connector_id||p.serverName||'app',tool=meta.tool_title||meta.tool_name||'tool';const persist=Array.isArray(meta.persist)?meta.persist:[meta.persist].filter(Boolean);const allowed=['once',...(persist.includes('session')?['session']:[]),...(persist.includes('always')?['always']:[]),'cancel'];const choice=(prompt('Allow '+actor+' to run '+tool+'?\\nChoose: '+allowed.join(' / '),'once')||'cancel').trim().toLowerCase();if(choice==='session'&&persist.includes('session'))return {action:'accept',content:null,_meta:{persist:'session'}};if(choice==='always'&&persist.includes('always'))return {action:'accept',content:null,_meta:{persist:'always'}};return choice==='once'?{action:'accept',content:null,_meta:null}:{action:'cancel',content:null,_meta:null}}const schema=p.requestedSchema||{},properties=schema.properties||{},content={};for(const [name,field] of Object.entries(properties)){if(field.type==='boolean')content[name]=confirm(field.title||field.description||name);else{const value=prompt(field.title||field.description||name,field.default==null?'':String(field.default));if(value==null)return {action:'cancel',content:null,_meta:null};content[name]=field.type==='number'||field.type==='integer'?Number(value):value}}return {action:'accept',content,_meta:null}}return {action:'cancel',content:null,_meta:null}}",
    "function handleServerRequest(msg){if(msg.method==='item/tool/requestUserInput'){const answers={};for(const q of msg.params?.questions||[]){const a=prompt(q.question||q.header||'Trebell needs input','')||'';answers[q.id]={answers:a?[a]:[]}}respond(msg.id,{answers});return}if(msg.method==='mcpServer/elicitation/request'){respond(msg.id,mcpElicitationResult(msg));return}if(msg.method.includes('requestApproval')||msg.method==='applyPatchApproval'||msg.method==='execCommandApproval'){const ok=confirm(msg.params?.reason||msg.params?.command||msg.params?.path||'Allow this Trebell action?');respond(msg.id,approvalResult(msg,ok));return}respond(msg.id,null,{code:-32601,message:'Unsupported mobile request: '+msg.method})}",
    "function onMessage(event){let msg;try{msg=JSON.parse(event.data)}catch{return}if(msg.id!=null&&pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(new Error(msg.error.message||'RPC error')):p.resolve(msg.result);return}if(msg.id!=null&&msg.method){handleServerRequest(msg);return}const p=msg.params||{};if(msg.method==='turn/started'){activeTurn=p.turn?.id||p.turnId;$('connection').textContent='Working…'}if(msg.method==='turn/completed'){activeTurn=null;$('connection').textContent='Connected';loadThreads()}if(msg.method==='item/agentMessage/delta')$('transcript').textContent+=(p.delta||p.text||'');if(msg.method==='item/completed'&&p.item?.type==='agentMessage'&&p.item.text){$('transcript').textContent+=($('transcript').textContent?'\\n':'')+p.item.text}}",
    "function preset(mode){if(mode==='full')return {sandbox:'danger-full-access',approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}};if(mode==='read-only')return {sandbox:'read-only',approvalPolicy:'on-request',sandboxPolicy:{type:'readOnly',networkAccess:false}};if(mode==='auto')return {sandbox:'workspace-write',approvalPolicy:'untrusted',sandboxPolicy:{type:'workspaceWrite',writableRoots:[$('cwd').value||statusData?.cwd||''],networkAccess:true,excludeTmpdirEnvVar:false,excludeSlashTmp:false}};return {sandbox:'workspace-write',approvalPolicy:'on-request',sandboxPolicy:{type:'workspaceWrite',writableRoots:[$('cwd').value||statusData?.cwd||''],networkAccess:true,excludeTmpdirEnvVar:false,excludeSlashTmp:false}}}",
    "async function connect(){if(pairToken){const paired=await fetch('/api/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:pairToken,name:navigator.userAgentData?.platform||navigator.platform||'Remote browser'})}).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error||'Pairing failed');return d});pairToken='';$('token').value=paired.token;localStorage.setItem('trebellRemoteSession',paired.token);localStorage.removeItem('trebellRemoteToken')}const t=token();if(!t)return alert('Open a pairing link from your Trebell host or enter a device session token');localStorage.setItem('trebellRemoteSession',t);statusData=await api('/api/status');const harness=statusData.agentRuntime||'codex';const providerLabel=harness==='codex'?(statusData.provider||'freebuff'):harness;$('status').textContent='Desktop '+statusData.version+' · '+providerLabel+(statusData.providerReady?' ready':' not ready');$('cwd').value=statusData.cwd||'';const proto=location.protocol==='https:'?'wss:':'ws:';ws=new WebSocket(proto+'//'+location.host+'/api/codex/ws?token='+encodeURIComponent(t));ws.onmessage=onMessage;ws.onclose=()=>{$('connection').textContent='Disconnected';$('connection').className='status bad'};await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=()=>reject(new Error('WebSocket connection failed'))});await request('initialize',{clientInfo:{name:'trebell-mobile',title:'Trebell Remote',version:statusData.version},capabilities:{experimentalApi:true,mcpServerOpenaiFormElicitation:true,extensions:{'openai/form':{},'openai/elicitation':{form:{}}}}});ws.send(JSON.stringify({method:'initialized',params:{}}));$('connection').textContent='Connected';$('connection').className='status ok';await Promise.all([loadThreads(),loadEnvironments()])}",
    "function transcriptLines(entries){const text=[];for(const entry of entries||[]){const item=entry?.item||entry;if(item?.type==='userMessage'&&item.text)text.push('You: '+item.text);if(item?.type==='agentMessage'&&item.text)text.push('Trebell: '+item.text)}return text}",
    "async function loadThreadTranscript(th){const params={threadId:th.id,model:statusData.model||null,modelProvider:statusData?.provider||'freebuff',cwd:th.cwd||null};const resumed=await request('thread/resume',{...params,excludeTurns:true});$('cwd').value=resumed.thread?.cwd||th.cwd||$('cwd').value;let cursor=resumed.itemsBackwardsCursor||null,entries=[],pages=0;while(cursor&&pages<4){const page=await request('thread/items/list',{threadId:th.id,cursor,limit:100,sortDirection:'desc'});entries.push(...(page.data||[]));cursor=page.nextCursor||null;pages++}if(entries.length){$('transcript').textContent=transcriptLines(entries.reverse()).join('\\n\\n');return}if(resumed.thread?.historyMode==='paginated'){$('transcript').textContent='';return}const legacy=await request('thread/resume',{...params,excludeTurns:false});const legacyEntries=[];for(const turn of legacy.thread?.turns||[])for(const item of turn.items||[])legacyEntries.push({turnId:turn.id,item});$('transcript').textContent=transcriptLines(legacyEntries).join('\\n\\n')}",
    "async function loadThreads(){if(!ws||ws.readyState!==1)return;const r=await request('thread/list',{limit:50,sortKey:'updated_at',sortDirection:'desc'});const box=$('threads');box.innerHTML='';for(const th of r.data||[]){const b=document.createElement('button');b.className='thread'+(activeThread===th.id?' active':'');b.textContent=th.name||th.preview||th.id;b.onclick=async()=>{activeThread=th.id;box.querySelectorAll('.thread').forEach(x=>x.classList.remove('active'));b.classList.add('active');await loadThreadTranscript(th)};box.appendChild(b)}}",
    "async function send(){if(!ws||ws.readyState!==1)return alert('Connect first');const text=$('prompt').value.trim();if(!text)return;const p=preset($('permission').value);let threadId=activeThread;if(!threadId){const started=await request('thread/start',{model:statusData.model,modelProvider:statusData?.provider||'freebuff',cwd:$('cwd').value||statusData.cwd,approvalPolicy:p.approvalPolicy,sandbox:p.sandbox,ephemeral:false,threadSource:'trebell-mobile'});threadId=started.thread.id;activeThread=threadId}const result=await request('turn/start',{threadId,model:statusData.model,cwd:$('cwd').value||statusData.cwd,approvalPolicy:p.approvalPolicy,sandboxPolicy:p.sandboxPolicy,input:[{type:'text',text,textElements:[]}]});activeTurn=result.turn?.id||null;$('prompt').value='';$('transcript').textContent+=($('transcript').textContent?'\\n\\n':'')+'You: '+text+'\\nTrebell: '}",
    "async function stop(){if(activeThread&&activeTurn)await request('turn/interrupt',{threadId:activeThread,turnId:activeTurn}).catch(()=>{});activeTurn=null}",
    "async function loadEnvironments(){const d=await api('/api/environments');const s=$('environment');s.innerHTML='';for(const e of d.profiles||[]){const o=document.createElement('option');o.value=e.id;o.textContent=e.name+' · '+e.type;s.appendChild(o)}}",
    "async function runEnv(probe){const id=$('environment').value;if(!id)return;const d=probe?await api('/api/environment/probe',{method:'POST',body:{id}}):await api('/api/environment/execute',{method:'POST',body:{id,command:$('command').value}});$('commandOutput').textContent=(d.stdout||'')+(d.stderr?'\\n'+d.stderr:'')}",
    "$('connect').onclick=()=>connect().catch(e=>{$('status').textContent=e.message;$('status').className='status bad'});$('refreshThreads').onclick=()=>loadThreads().catch(e=>alert(e.message));$('newThread').onclick=()=>{activeThread=null;$('transcript').textContent='';document.querySelectorAll('.thread').forEach(x=>x.classList.remove('active'))};$('send').onclick=()=>send().catch(e=>alert(e.message));$('stop').onclick=()=>stop();$('runCommand').onclick=()=>runEnv(false).catch(e=>alert(e.message));$('probe').onclick=()=>runEnv(true).catch(e=>alert(e.message));if(saved||pairToken)connect().catch(e=>{$('status').textContent=e.message});",
    "})();",
    "</script></body></html>"
  ].join("");
}

export async function createRemoteControlServer({
  port=3211,
  token,
  version="0.0.0",
  appPort=23456,
  targetUrl=null,
  authStore=null,
  enabled=()=>true,
  getStatus=async()=>({}),
  environments,
  host="0.0.0.0",
}={}){
  if(!token) throw new Error("Remote control access token is required");
  if(!environments) throw new Error("Remote control requires an environment manager");
  const authorized=(req,url)=>{
    const raw=authToken(req,url);return sameToken(raw,token)||Boolean(authStore?.authenticate(raw));
  };
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url||"/","http://127.0.0.1");
    if(url.pathname==="/"&&req.method==="GET"){
      const html=Buffer.from(mobileHtml());
      res.writeHead(200,{
        "content-type":"text/html; charset=utf-8",
        "content-length":String(html.length),
        "cache-control":"no-store",
        "content-security-policy":"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:",
        "x-frame-options":"DENY",
      });
      return res.end(html);
    }
    if(url.pathname==="/api/pair"&&req.method==="POST"){
      if(!authStore)return json(res,404,{error:"pairing_unavailable"});
      try{const body=await readJson(req);return json(res,200,authStore.exchangePairing(body.token,{name:body.name,userAgent:req.headers["user-agent"]||""}))}
      catch(error){return json(res,401,{error:error.message||"pairing_failed"})}
    }
    if(!authorized(req,url)) return json(res,401,{error:"unauthorized"});
    try{
      if(url.pathname==="/api/status"&&req.method==="GET") return json(res,200,{version,...await getStatus()});
      if(url.pathname==="/api/environments"&&req.method==="GET") return json(res,200,await environments.discover());
      if(url.pathname==="/api/environment/probe"&&req.method==="POST"){
        const body=await readJson(req);
        return json(res,200,await environments.probe(body.id));
      }
      if(url.pathname==="/api/environment/execute"&&req.method==="POST"){
        const body=await readJson(req);
        return json(res,200,await environments.execute(body.id,body));
      }
      return json(res,404,{error:"not_found"});
    }catch(error){
      return json(res,400,{error:error.message||String(error)});
    }
  });

  const relay=attachCodexRelay(server,{
    targetUrl:targetUrl||("ws://127.0.0.1:"+appPort),
    enabled,
    authorize:(request,url)=>authorized(request,url),
  });

  await new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(port,host,resolve);
  });
  const address=server.address();
  const actualPort=typeof address==="object"&&address?address.port:port;
  return {
    port:actualPort,
    urls:lanUrls(actualPort),
    createPairing:()=>{
      if(!authStore)throw new Error("Pairing is unavailable");
      const grant=authStore.createPairing();return {...grant,urls:lanUrls(actualPort,"pair",grant.token)};
    },
    devices:()=>authStore?.listDevices?.()||[],
    revokeDevice:id=>authStore?.revokeDevice?.(id)||false,
    close:async()=>{
      relay.close();
      await new Promise(resolve=>server.close(resolve));
    },
  };
}
