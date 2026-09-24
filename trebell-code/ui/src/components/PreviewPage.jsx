import React,{useEffect,useRef,useState} from "react";
import { ExternalLink, Globe2, RefreshCw, Camera, MousePointer2, Eye, X, Radar, ArrowLeft, ArrowRight, MonitorSmartphone, Circle, Square, RotateCw, History } from "lucide-react";
import { api } from "../api.js";

const VIEWPORTS=[
  {id:"desktop",label:"Desktop",width:1440,height:900},
  {id:"laptop",label:"Laptop",width:1280,height:800},
  {id:"tablet",label:"Tablet",width:820,height:1180},
  {id:"mobile",label:"Mobile",width:390,height:844},
];
function historyKey(projectPath){return "trebell:browser-history:v1:"+String(projectPath||"global")}
function normalizedHistoryUrl(value){try{const parsed=new URL(value);if(!/^https?:$/.test(parsed.protocol))return null;parsed.username="";parsed.password="";return parsed.href}catch{return null}}

export default function PreviewPage({projectPath,onAttachText,onAttachImage,onAttachFile}){
  const [draft,setDraft]=useState("http://localhost:3000");
  const [url,setUrl]=useState("");
  const [key,setKey]=useState(0);
  const [snapshot,setSnapshot]=useState(null);
  const [busy,setBusy]=useState("");
  const [selectedRef,setSelectedRef]=useState(null);
  const [annotation,setAnnotation]=useState("");
  const [lastAttached,setLastAttached]=useState("");
  const [cookieStatus,setCookieStatus]=useState("");
  const [browserImports,setBrowserImports]=useState(null);
  const [importOpen,setImportOpen]=useState(false);
  const [servers,setServers]=useState([]);
  const [serverError,setServerError]=useState("");
  const [browserError,setBrowserError]=useState("");
  const [browserState,setBrowserState]=useState({open:false,url:"",title:"",canGoBack:false,canGoForward:false,loading:false,width:1280,height:800});
  const [viewport,setViewport]=useState({width:1280,height:800});
  const [history,setHistory]=useState([]);
  const [recording,setRecording]=useState(false);
  const [recordingSince,setRecordingSince]=useState(0);
  const [recordingSeconds,setRecordingSeconds]=useState(0);
  const [previewZoom,setPreviewZoom]=useState(1);
  const recorderRef=useRef(null);const streamRef=useRef(null);const chunksRef=useRef([]);const urlInputRef=useRef(null);

  function remember(nextUrl,title=""){
    const normalized=normalizedHistoryUrl(nextUrl);if(!normalized)return;
    setHistory(current=>{
      const next=[{url:normalized,title:String(title||"").slice(0,512),lastVisitedAt:Date.now()},...current.filter(item=>item.url!==normalized)].slice(0,50);
      try{localStorage.setItem(historyKey(projectPath),JSON.stringify(next))}catch{}
      return next;
    });
  }

  async function discover(){
    setBusy("servers");setServerError("");
    try{
      const data=await api("/api/preview/servers");
      setServers(data.servers||[]);
      if(data.error)setServerError(data.error);
    }catch(error){setServerError(error.message||String(error))}
    finally{setBusy("")}
  }

  useEffect(()=>{discover()},[]);
  useEffect(()=>{
    try{const parsed=JSON.parse(localStorage.getItem(historyKey(projectPath))||"[]");setHistory(Array.isArray(parsed)?parsed.slice(0,50):[])}catch{setHistory([])}
  },[projectPath]);
  useEffect(()=>{
    const browser=window.trebellDesktop?.browser;if(!browser)return;
    let disposed=false;
    browser.state?.().then(state=>{if(!disposed&&state){setBrowserError("");setBrowserState(state);if(state.width&&state.height)setViewport({width:state.width,height:state.height});if(state.url)remember(state.url,state.title)}}).catch(error=>{if(!disposed)setBrowserError(error?.message||String(error)||"Could not read Agent Browser state.")});
    const unsubscribe=browser.onState?.(state=>{if(disposed||!state)return;setBrowserState(state);if(state.width&&state.height)setViewport({width:state.width,height:state.height});if(state.url)remember(state.url,state.title)});
    return()=>{disposed=true;unsubscribe?.()};
  },[projectPath]);
  useEffect(()=>{
    if(!recording){setRecordingSeconds(0);return}
    const tick=()=>setRecordingSeconds(Math.max(0,Math.floor((Date.now()-recordingSince)/1000)));tick();const timer=setInterval(tick,500);return()=>clearInterval(timer);
  },[recording,recordingSince]);
  useEffect(()=>()=>{try{if(recorderRef.current?.state!=="inactive")recorderRef.current.stop()}catch{};for(const track of streamRef.current?.getTracks?.()||[])track.stop()},[]);
  useEffect(()=>{
    const open=event=>{
      const next=String(event.detail||"").trim();
      if(!next)return;
      setDraft(next);setUrl(next);setKey(k=>k+1);
    };
    window.addEventListener("trebell:preview-open",open);
    return()=>window.removeEventListener("trebell:preview-open",open);
  },[]);
  useEffect(()=>{
    const command=event=>{
      const action=event.detail?.action;
      if(action==="focusUrl"){urlInputRef.current?.focus();urlInputRef.current?.select?.();return}
      if(action==="zoomIn"){setPreviewZoom(value=>Math.min(2,Math.round((value+.1)*10)/10));return}
      if(action==="zoomOut"){setPreviewZoom(value=>Math.max(.5,Math.round((value-.1)*10)/10));return}
      if(action==="resetZoom"){setPreviewZoom(1);return}
      if(action==="refresh"){
        setKey(value=>value+1);
        window.trebellDesktop?.browser?.reload?.().then(state=>{setBrowserError("");if(state)setBrowserState(state)}).catch(error=>setBrowserError(error?.message||String(error)||"Could not reload Agent Browser."));
      }
    };
    window.addEventListener("trebell:preview-command",command);
    return()=>window.removeEventListener("trebell:preview-command",command);
  },[]);

  function normalized(){let next=draft.trim();if(next&&!/^https?:\/\//i.test(next))next="http://"+next;return next}
  function go(){const next=normalized();setUrl(next);if(next)remember(next)}
  async function openAgentUrl(next){
    if(!next)return;setBusy("open");
    try{const state=await window.trebellDesktop?.browser?.navigate?.(next);setBrowserError("");setUrl(next);remember(next,state?.title);setSnapshot(await window.trebellDesktop?.browser?.snapshot?.())}
    catch(error){setBrowserError(error?.message||String(error)||"Could not open Agent Browser.")}
    finally{setBusy("")}
  }
  async function agentOpen(){return openAgentUrl(normalized())}
  async function inspect(){setBusy("inspect");try{const next=await window.trebellDesktop?.browser?.snapshot?.();setBrowserError("");setSnapshot(next);if(selectedRef&&!next?.elements?.some(el=>el.ref===selectedRef))setSelectedRef(null)}catch(error){setBrowserError(error?.message||String(error)||"Could not inspect Agent Browser.")}finally{setBusy("")}}
  async function capture(){setBusy("capture");try{const shot=await window.trebellDesktop?.browser?.screenshot?.();setBrowserError("");if(shot?.dataUrl)await onAttachImage?.(shot.dataUrl)}catch(error){setBrowserError(error?.message||String(error)||"Could not capture Agent Browser.")}finally{setBusy("")}}
  async function importCookies(){
    setBusy("cookies");setCookieStatus("");
    try{
      const result=await window.trebellDesktop?.browser?.importCookies?.();
      if(!result){setCookieStatus("Cookie import is unavailable in this build");return}
      if(result.canceled){setCookieStatus("Cookie import canceled");return}
      setCookieStatus("Imported "+result.imported+" cookie"+(result.imported===1?"":"s")+(result.failed?" · "+result.failed+" failed":""));
    }catch(error){setCookieStatus("Cookie import failed: "+String(error?.message||error))}
    finally{setBusy("")}
  }
  async function openProfileImport(){
    const browser=window.trebellDesktop?.browser;if(!browser?.importSources){setCookieStatus("Browser profile import is unavailable in this build");return}
    setBusy("profiles");setCookieStatus("");
    try{const result=await browser.importSources();setBrowserImports(result||{sources:[]});setImportOpen(true)}
    catch(error){setCookieStatus("Profile detection failed: "+String(error?.message||error))}
    finally{setBusy("")}
  }
  async function importProfile(source,profile){
    const browser=window.trebellDesktop?.browser;if(!browser?.importProfile)return;
    setBusy("profile:"+profile.id);setCookieStatus("");
    try{
      const result=await browser.importProfile(source.id,profile.id);
      setCookieStatus(`Imported ${result.imported||0} cookie${result.imported===1?"":"s"} from ${result.profileName||profile.name}${result.skipped?` · ${result.skipped} encrypted/partitioned skipped`:""}${result.failed?` · ${result.failed} failed`:""}`);
      setImportOpen(false);
    }catch(error){setCookieStatus("Profile import failed: "+String(error?.message||error))}
    finally{setBusy("")}
  }
  async function navigateHistory(direction){
    const browser=window.trebellDesktop?.browser;if(!browser)return;setBusy(direction);
    try{const state=direction==="back"?await browser.back?.():direction==="forward"?await browser.forward?.():await browser.reload?.();setBrowserError("");if(state){setBrowserState(state);if(state.url){setDraft(state.url);setUrl(state.url);remember(state.url,state.title)}}}
    catch(error){setBrowserError(error?.message||String(error)||"Agent Browser navigation failed.")}
    finally{setBusy("")}
  }
  async function applyViewport(width,height){
    const next={width:Math.max(320,Math.min(3840,Number(width)||1280)),height:Math.max(240,Math.min(2160,Number(height)||800))};setViewport(next);
    try{const state=await window.trebellDesktop?.browser?.setViewport?.(next.width,next.height);setBrowserError("");if(state)setBrowserState(state)}
    catch(error){setBrowserError(error?.message||String(error)||"Could not resize Agent Browser.")}
  }
  async function startRecording(){
    const browser=window.trebellDesktop?.browser;if(!browser?.armRecording||!navigator.mediaDevices?.getDisplayMedia||typeof MediaRecorder==="undefined")throw new Error("Browser recording is unavailable in this build.");
    setBusy("recording");
    try{
      await browser.armRecording();
      const stream=await navigator.mediaDevices.getDisplayMedia({audio:false,video:{frameRate:{ideal:30,max:30}}});streamRef.current=stream;
      const choices=["video/mp4;codecs=avc1","video/webm;codecs=vp9","video/webm;codecs=vp8","video/webm"];
      const mimeType=choices.find(type=>MediaRecorder.isTypeSupported(type))||"";const recorder=new MediaRecorder(stream,mimeType?{mimeType}:undefined);chunksRef.current=[];recorderRef.current=recorder;
      recorder.ondataavailable=event=>{if(event.data?.size)chunksRef.current.push(event.data)};
      recorder.start(1000);setRecordingSince(Date.now());setRecording(true);
    }finally{setBusy("")}
  }
  async function stopRecording(){
    const recorder=recorderRef.current;if(!recorder)return;setBusy("recording-stop");
    try{
      const stopped=new Promise(resolve=>{recorder.addEventListener("stop",resolve,{once:true});if(recorder.state!=="inactive")recorder.stop();else resolve()});await stopped;
      for(const track of streamRef.current?.getTracks?.()||[])track.stop();
      const type=recorder.mimeType||chunksRef.current[0]?.type||"video/webm";const blob=new Blob(chunksRef.current,{type});
      if(blob.size>0&&onAttachFile){const ext=type.includes("mp4")?"mp4":"webm";await onAttachFile(new File([blob],`browser-recording-${Date.now()}.${ext}`,{type}),{kind:"browser",label:"Browser recording",detail:`${recordingSeconds}s · ${(blob.size/1024/1024).toFixed(1)} MB`})}
    }finally{recorderRef.current=null;streamRef.current=null;chunksRef.current=[];setRecording(false);setBusy("")}
  }
  async function attachElement(element,note=""){
    const cleanNote=String(note||"").trim();
    const lines=["Browser element context","URL: "+(snapshot?.url||url),"Title: "+(snapshot?.title||""),"Element ref: "+element.ref,"Tag: "+element.tag,"Text: "+(element.text||""),"Href: "+(element.href||"")];
    if(cleanNote)lines.push("","Annotation: "+cleanNote);
    setBrowserError("");
    try{
      await onAttachText?.((cleanNote?"browser-annotation-":"browser-element-")+element.ref+".txt",lines.join("\n"),{kind:"browser",label:(cleanNote?"Annotated ":"Browser ")+element.ref,detail:cleanNote||(element.text||element.tag||"").slice(0,70)});
      setLastAttached(cleanNote?"Annotation attached":"Element context attached");
      return true;
    }catch(error){
      setLastAttached("");
      setBrowserError(error?.message||String(error)||"Could not attach browser context.");
      return false;
    }
  }
  const selectedElement=(snapshot?.elements||[]).find(el=>el.ref===selectedRef)||null;
  const desktopBrowserAvailable=Boolean(window.trebellDesktop?.browser);
  return <div className="preview-page">
    <div className="preview-bar"><Globe2 size={15}/>{desktopBrowserAvailable&&<><button title="Back" disabled={!browserState.canGoBack||!!busy} onClick={()=>navigateHistory("back")}><ArrowLeft size={13}/></button><button title="Forward" disabled={!browserState.canGoForward||!!busy} onClick={()=>navigateHistory("forward")}><ArrowRight size={13}/></button></>}<input ref={urlInputRef} value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()} placeholder="http://localhost:3000" title={"Preview zoom "+Math.round(previewZoom*100)+"%"}/><button onClick={go}>Preview</button>{desktopBrowserAvailable&&<button title="Reload agent browser" onClick={()=>navigateHistory("reload")} disabled={!!busy}><RefreshCw size={13}/></button>}{url&&<button onClick={()=>window.open(url,"_blank")}><ExternalLink size={13}/></button>}</div>

    {desktopBrowserAvailable&&<div className="browser-device-toolbar"><MonitorSmartphone size={13}/><select value={VIEWPORTS.find(item=>item.width===viewport.width&&item.height===viewport.height)?.id||"custom"} onChange={e=>{const preset=VIEWPORTS.find(item=>item.id===e.target.value);if(preset)applyViewport(preset.width,preset.height)}}><option value="custom">Custom</option>{VIEWPORTS.map(item=><option key={item.id} value={item.id}>{item.label} · {item.width}×{item.height}</option>)}</select><input type="number" min="320" max="3840" value={viewport.width} onChange={e=>setViewport(v=>({...v,width:e.target.value}))} onBlur={()=>applyViewport(viewport.width,viewport.height)}/><span>×</span><input type="number" min="240" max="2160" value={viewport.height} onChange={e=>setViewport(v=>({...v,height:e.target.value}))} onBlur={()=>applyViewport(viewport.width,viewport.height)}/><button title="Rotate viewport" onClick={()=>applyViewport(viewport.height,viewport.width)}><RotateCw size={12}/></button><button className={recording?"recording active":"recording"} disabled={!!busy&&!recording} onClick={()=>recording?stopRecording().catch(error=>setCookieStatus(error.message)):startRecording().catch(error=>setCookieStatus(error.message))}>{recording?<Square size={11}/>:<Circle size={11}/>} {recording?`Stop ${recordingSeconds}s`:"Record"}</button></div>}

    {history.length>0&&<details className="browser-history"><summary><History size={12}/> Recent pages</summary><div>{history.slice(0,12).map(item=><button key={item.url} onClick={()=>{setDraft(item.url);openAgentUrl(item.url)}}><span><strong>{item.title||new URL(item.url).host}</strong><small>{item.url}</small></span><time>{new Date(item.lastVisitedAt).toLocaleString()}</time></button>)}</div></details>}

    <div className="preview-discovery">
      <div className="preview-discovery-head"><span><Radar size={13}/> Local dev servers</span><button onClick={discover} disabled={busy==="servers"}><RefreshCw size={12}/> Detect</button></div>
      {servers.length?<><div className="preview-server-list">{servers.map(server=><button key={server.port} onClick={()=>{setDraft(server.url);setUrl(server.url);setKey(k=>k+1)}}><strong>:{server.port}</strong><span>{server.contentType||"HTTP "+server.status}</span></button>)}</div>{serverError&&<div className="inline-error" role="alert">{serverError}</div>}</>:<p>{serverError||"No common local web server detected. Start your dev action, then scan again."}</p>}
    </div>

    {desktopBrowserAvailable?<><div className="agent-browser-toolbar"><button onClick={agentOpen} disabled={!!busy}><Globe2 size={13}/> Open agent browser</button><button onClick={()=>Promise.resolve().then(()=>window.trebellDesktop.browser.show?.()).then(()=>setBrowserError("")).catch(error=>setBrowserError(error?.message||String(error)||"Could not show Agent Browser."))}><Eye size={13}/> Show browser</button><button onClick={inspect} disabled={!!busy}><MousePointer2 size={13}/> Inspect elements</button><button onClick={capture} disabled={!!busy}><Camera size={13}/> Attach screenshot</button><button onClick={openProfileImport} disabled={!!busy}>Import profile</button><button onClick={importCookies} disabled={!!busy}>Import cookie JSON</button><button onClick={()=>Promise.resolve().then(()=>window.trebellDesktop.browser.close?.()).then(()=>{setBrowserError("");setSnapshot(null);setSelectedRef(null);setAnnotation("");setLastAttached("");setCookieStatus("")}).catch(error=>setBrowserError(error?.message||String(error)||"Could not close Agent Browser."))}><X size={13}/> Close</button>{cookieStatus&&<span className="browser-cookie-status" data-testid="browser-cookie-status">{cookieStatus}</span>}</div>{browserError&&<div className="browser-action-error" role="alert">{browserError}</div>}</>:<div className="agent-browser-unavailable"><strong>Desktop Agent Browser is unavailable here</strong><span>The hosted UI still supports iframe previews, local dev-server detection, and recent-page history.</span></div>}
    {importOpen&&<div className="browser-profile-import" data-testid="browser-profile-import"><div className="browser-profile-import-head"><div><strong>Import signed-in browser session</strong><span>One-time cookie copy into Trebell Agent Browser.</span></div><button onClick={()=>setImportOpen(false)}><X size={12}/></button></div>{(browserImports?.sources||[]).length?(browserImports.sources||[]).map(source=><section key={source.id}><div><strong>{source.name}</strong><span>{source.running?"Close the browser before importing.":source.installed?`${source.profiles?.length||0} profile${source.profiles?.length===1?"":"s"} found`:"No readable profiles found"}</span></div>{(source.profiles||[]).map(profile=><button key={profile.id} disabled={source.running||!!busy} onClick={()=>importProfile(source,profile)}><span>{profile.name}</span><small>{source.running?"Browser running":"Import"}</small></button>)}</section>):<p>No supported browser profiles were found. On Windows, Firefox and Helium are supported; cookie JSON remains available as a fallback.</p>}</div>}
    <div className={"preview-layout"+(desktopBrowserAvailable?"":" hosted")}><div className="preview-frame">{url?<iframe key={key} title="Trebell preview" src={url} style={{transform:"scale("+previewZoom+")",transformOrigin:"0 0",width:(100/previewZoom)+"%",height:(100/previewZoom)+"%"}}/>:<div className="preview-empty-state"><Globe2 size={18}/><strong>No preview open</strong><span>Enter a local or web URL above to preview it here.</span></div>}</div>
      {desktopBrowserAvailable&&<aside className="browser-inspector"><h3>Agent browser</h3>{snapshot?<><p><strong>{snapshot.title||"Untitled"}</strong><span>{snapshot.url}</span></p><div className="browser-elements">{(snapshot.elements||[]).map(el=><button className={selectedRef===el.ref?"active":""} key={el.ref} onClick={()=>{setSelectedRef(el.ref);setLastAttached("")}}><code>{el.ref}</code><span>{el.text||el.tag}</span><small>{el.tag}{el.href?" · link":""}</small></button>)}</div>{selectedElement&&<div className="browser-annotation" data-testid="preview-annotation"><div><strong>Annotate {selectedElement.ref}</strong><span>{selectedElement.text||selectedElement.tag}</span></div><textarea value={annotation} onChange={e=>setAnnotation(e.target.value)} placeholder="Add a note or instruction for the agent about this element…"/><div className="annotation-actions"><button onClick={()=>attachElement(selectedElement)}>Attach context</button><button className="primary" disabled={!annotation.trim()} onClick={async()=>{if(await attachElement(selectedElement,annotation))setAnnotation("")}}>Attach annotation</button>{lastAttached&&<span>{lastAttached}</span>}</div></div>}</>:<div className="empty-inspector">Open the agent browser and inspect the page to see model-addressable elements.</div>}</aside>}
    </div>
    <p className="preview-note">{desktopBrowserAvailable?"Trebell detects common localhost dev servers automatically. The iframe is a visual preview; Agent Browser gives the active coding agent DOM-aware browser control, and desktop Computer Use is available in Full access mode.":"Trebell detects common localhost dev servers automatically. This hosted surface provides iframe previews; Agent Browser and Computer Use are desktop capabilities."}</p>
  </div>;
}
