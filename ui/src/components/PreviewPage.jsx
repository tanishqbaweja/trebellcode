import React,{useEffect,useRef,useState,useSyncExternalStore} from "react";
import { ExternalLink, Globe2, RefreshCw, Camera, MousePointer2, Eye, X, Radar, ArrowLeft, ArrowRight, MonitorSmartphone, Circle, Square, RotateCw, History, Unplug } from "lucide-react";
import { api } from "../api.js";
import { openWebLink } from "../web-link.js";
import { takeRequestedPreview } from "../preview-open.js";
import { ignorePressRest } from "./ThreadSidebar.jsx";

const VIEWPORTS=[
  {id:"desktop",label:"Desktop",width:1440,height:900},
  {id:"laptop",label:"Laptop",width:1280,height:800},
  {id:"tablet",label:"Tablet",width:820,height:1180},
  {id:"mobile",label:"Mobile",width:390,height:844},
];
function historyKey(projectPath){return "trebell:browser-history:v1:"+String(projectPath||"global")}
// A preview target must parse as an http(s) URL with a host; anything else would only load a blank frame.
// Chromium percent-encodes a space in a host ("not%20a%20url") instead of rejecting it, so an encoded host is invalid too.
function previewableUrl(value){try{const parsed=new URL(value);return /^https?:$/.test(parsed.protocol)&&Boolean(parsed.hostname)&&!parsed.hostname.includes("%")}catch{return false}}
const INVALID_PREVIEW_URL="Enter a valid web address, such as http://localhost:3000.";
function normalizedHistoryUrl(value){try{const parsed=new URL(value);if(!/^https?:$/.test(parsed.protocol))return null;parsed.username="";parsed.password="";return parsed.href}catch{return null}}
// The shell answers an import that set none of the cookies it tried (a JSON array of entries that are not cookies) with its counts and
// each cookie's reason, not a rejection. That import failed: what it says, with the first reason, or "" for one that set some.
function noneSet(result,from=""){
  const failed=Number(result?.failed)||0,skipped=Number(result?.skipped)||0,why=String(result?.errors?.[0]||"").replace(/\.\s*$/,"");
  if(result?.imported||!failed)return "";
  return (failed===1?"the cookie"+from+" could not be set":"none of the "+failed+" cookies"+from+" could be set")+(why?" ("+why+")":"")+(skipped?"; "+skipped+" encrypted or partitioned cookie"+(skipped===1?" was":"s were")+" skipped":"")+".";
}
// What the panel shows is kept while another tab is open or the panel is closed, and comes back with it: a look at Files used to
// reset it while the agent browser still showed the page. The panel shown reads it as it is set, also by one that went away
// meanwhile, so what lands then (the page an Open agent browser pressed before it went opens, and that page's elements) shows.
const kept={draft:"http://localhost:3000",url:"",snapshot:null,selectedRef:null,annotation:"",shown:{pages:[],at:-1},previewZoom:1,phase:"idle"},keptListeners=new Set();
function setKept(next){Object.assign(kept,next);for(const listener of keptListeners)listener()}
function onKept(listener){keptListeners.add(listener);return()=>keptListeners.delete(listener)}
function useKept(name){return [useSyncExternalStore(onKept,()=>kept[name]),next=>setKept({[name]:typeof next==="function"?next(kept[name]):next})]}
// The agent browser's elements belong to the page it showed when they were read: that window (one closed and opened again on the
// same address is another) at that address. A state of any other page drops them, live or as the panel comes back, so Attach
// context never attaches an element of a page the agent browser no longer shows, whose ref may name another element there now.
function samePage(state,shot){return state.windowId===shot.windowId&&state.url===shot.url}
// A recording goes on while another tab is open or the panel is closed, and comes back with the panel, as it records the agent
// browser's window, not the panel: it used to end unsaved when the panel went. Its phase (kept.phase: idle, starting, recording, or
// stopping while it is saved) is every panel's, so one opened again while a recording starts or is saved offers no second Record
// or Stop, and reads Record once it is saved. rec holds the recording going on, with chunks of its own.
const rec={since:0};
// A press records, stops or attaches once, as a thread's menu item runs: the rest of it (the second click of a double click, Enter
// held) does nothing. Record and Stop are one button, so the second click landed on the Stop of the recording the first click had
// started once the shell armed it, and stopped it at once; and an element's attach can land before the second click comes, which
// attached it again.
function pressOnce(event){if(event.target.closest("button"))ignorePressRest(!event.detail)}

export default function PreviewPage({projectPath,onAttachText,onAttachImage,onAttachFile}){
  const [draft,setDraft]=useKept("draft");
  const [url,setUrl]=useKept("url");
  const [key,setKey]=useState(0);
  const [snapshot,setSnapshot]=useKept("snapshot");
  const [busy,setBusy]=useState("");
  const [selectedRef,setSelectedRef]=useKept("selectedRef");
  const [annotation,setAnnotation]=useKept("annotation");
  const [lastAttached,setLastAttached]=useState("");
  const [cookieStatus,setCookieStatus]=useState("");
  const [browserImports,setBrowserImports]=useState(null);
  const [importOpen,setImportOpen]=useState(false);
  const [servers,setServers]=useState([]);
  const [serverError,setServerError]=useState("");
  const [browserError,setBrowserError]=useState("");
  const [urlError,setUrlError]=useState("");
  // Back and Forward step through the addresses this preview has shown, as a browser's do; the agent browser keeps its own
  // history. They used to step the agent browser and show its page, so Back after typing an address went to an older agent page.
  const [shown,setShown]=useKept("shown");
  const [unanswered,setUnanswered]=useState("");
  const [viewport,setViewport]=useState({width:1280,height:800});
  const [history,setHistory]=useState([]);
  const [phase]=useKept("phase"),recording=phase==="recording"||phase==="stopping";
  const [recordingSeconds,setRecordingSeconds]=useState(0);
  const [previewZoom,setPreviewZoom]=useKept("previewZoom");
  const urlInputRef=useRef(null),attaching=useRef(new Set());

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
    const take=state=>{if(disposed||!state)return;if(state.open===false||kept.snapshot&&!samePage(state,kept.snapshot))dropPage();if(state.width&&state.height)setViewport({width:state.width,height:state.height});if(state.url)remember(state.url,state.title)};
    browser.state?.().then(state=>{if(!disposed&&state)setBrowserError("");take(state)}).catch(error=>{if(!disposed)setBrowserError(error?.message||String(error)||"Could not read Agent Browser state.")});
    const unsubscribe=browser.onState?.(take);
    return()=>{disposed=true;unsubscribe?.()};
  },[projectPath]);
  useEffect(()=>{
    if(phase!=="recording"){setRecordingSeconds(0);return}
    const tick=()=>setRecordingSeconds(Math.max(0,Math.floor((Date.now()-rec.since)/1000)));tick();const timer=setInterval(tick,500);return()=>clearInterval(timer);
  },[phase]);
  // An address asked for before the panel was drawn (an action's Open preview opens the panel and asks at once) is shown as it opens.
  useEffect(()=>{
    const open=next=>{
      if(!next)return;
      setDraft(next);show(next);setKey(k=>k+1);
    };
    const requested=event=>open(takeRequestedPreview()||String(event.detail||"").trim());
    open(takeRequestedPreview());
    window.addEventListener("trebell:preview-open",requested);
    return()=>window.removeEventListener("trebell:preview-open",requested);
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
        window.trebellDesktop?.browser?.reload?.().then(()=>setBrowserError("")).catch(error=>setBrowserError(error?.message||String(error)||"Could not reload Agent Browser."));
      }
    };
    window.addEventListener("trebell:preview-command",command);
    return()=>window.removeEventListener("trebell:preview-command",command);
  },[]);
  // A frame pointed at an address where nothing listens stays blank, so the address is asked for once as the frame loads it and the
  // preview says when nothing answered. Any answer counts, whatever its status.
  useEffect(()=>{
    if(!url)return;let live=true;
    fetch(url,{method:"HEAD",mode:"no-cors",cache:"no-store"}).then(()=>{if(live)setUnanswered("")},()=>{if(live)setUnanswered(url)});
    return()=>{live=false};
  },[url,key]);

  // Only a bare address gets the http:// prefix; another scheme ("file:///...") is kept so the check above rejects it.
  function normalized(){let next=draft.trim();if(next&&!/^https?:\/\//i.test(next)&&!/^[a-z][a-z0-9+.-]*:\/\//i.test(next))next="http://"+next;return next}
  // A new address drops the pages after the one shown, as a browser's history does.
  function show(next){setUrl(next);setShown(current=>current.pages[current.at]===next?current:{pages:[...current.pages.slice(0,current.at+1),next],at:current.at+1})}
  function step(by){const at=shown.at+by,next=shown.pages[at];if(!next)return;setShown(current=>({...current,at}));setDraft(next);setUrlError("");setUrl(next)}
  // Preview loads the address shown again, so one that did not answer is asked again once its server is up.
  function go(){const next=normalized();if(next&&!previewableUrl(next)){setUrlError(INVALID_PREVIEW_URL);return}setUrlError("");if(!next){setUrl("");return}if(next===url)setKey(value=>value+1);show(next);remember(next)}
  // The page opened comes with its own elements, none of them chosen: the element chosen on the page before, and its note, go.
  async function openAgentUrl(next){
    if(!next)return;setBusy("open");
    try{const state=await window.trebellDesktop?.browser?.navigate?.(next);setBrowserError("");show(next);remember(next,state?.title);const shot=await window.trebellDesktop?.browser?.snapshot?.();dropPage();setSnapshot(shot)}
    catch(error){setBrowserError(error?.message||String(error)||"Could not open Agent Browser.")}
    finally{setBusy("")}
  }
  async function agentOpen(){const next=normalized();if(next&&!previewableUrl(next)){setUrlError(INVALID_PREVIEW_URL);return}setUrlError("");return openAgentUrl(next)}
  async function inspect(){setBusy("inspect");try{const next=await window.trebellDesktop?.browser?.snapshot?.();setBrowserError("");setSnapshot(next);if(selectedRef&&!next?.elements?.some(el=>el.ref===selectedRef))setSelectedRef(null)}catch(error){setBrowserError(error?.message||String(error)||"Could not inspect Agent Browser.")}finally{setBusy("")}}
  async function capture(){setBusy("capture");try{const shot=await window.trebellDesktop?.browser?.screenshot?.();setBrowserError("");if(shot?.dataUrl)await onAttachImage?.(shot.dataUrl)}catch(error){setBrowserError(error?.message||String(error)||"Could not capture Agent Browser.")}finally{setBusy("")}}
  // An import's notice shows in the status line under the toolbar; what it could not do shows in the error line, as the panel's other
  // failures do, in full and in the error colour, and so does an import that set none of the cookies it tried (noneSet).
  async function importCookies(){
    setBusy("cookies");setCookieStatus("");setBrowserError("");
    try{
      const result=await window.trebellDesktop?.browser?.importCookies?.();
      if(!result){setBrowserError("Cookie import is unavailable in this build.");return}
      if(result.canceled){setCookieStatus("Cookie import canceled");return}
      const none=noneSet(result);if(none){setBrowserError("Cookie import failed: "+none);return}
      setCookieStatus("Imported "+result.imported+" cookie"+(result.imported===1?"":"s")+(result.failed?" · "+result.failed+" failed":""));
    }catch(error){setBrowserError("Cookie import failed: "+String(error?.message||error))}
    finally{setBusy("")}
  }
  async function openProfileImport(){
    const browser=window.trebellDesktop?.browser;if(!browser?.importSources){setCookieStatus("");setBrowserError("Browser profile import is unavailable in this build.");return}
    setBusy("profiles");setCookieStatus("");setBrowserError("");
    try{const result=await browser.importSources();setBrowserImports(result||{sources:[]});setImportOpen(true)}
    catch(error){setBrowserError("Profile detection failed: "+String(error?.message||error))}
    finally{setBusy("")}
  }
  async function importProfile(source,profile){
    const browser=window.trebellDesktop?.browser;if(!browser?.importProfile)return;
    setBusy("profile:"+profile.id);setCookieStatus("");setBrowserError("");
    try{
      const result=await browser.importProfile(source.id,profile.id);
      const none=noneSet(result," from "+(result?.profileName||profile.name));if(none){setBrowserError("Profile import failed: "+none);return}
      setCookieStatus(`Imported ${result.imported||0} cookie${result.imported===1?"":"s"} from ${result.profileName||profile.name}${result.skipped?` · ${result.skipped} encrypted/partitioned skipped`:""}${result.failed?` · ${result.failed} failed`:""}`);
      setImportOpen(false);
    }catch(error){setBrowserError("Profile import failed: "+String(error?.message||error))}
    finally{setBusy("")}
  }
  async function reloadAgent(){
    const browser=window.trebellDesktop?.browser;if(!browser)return;setBusy("reload");
    try{const state=await browser.reload?.();setBrowserError("");if(state?.url){setDraft(state.url);show(state.url);remember(state.url,state.title)}}
    catch(error){setBrowserError(error?.message||String(error)||"Could not reload Agent Browser.")}
    finally{setBusy("")}
  }
  // A width or height typed in the device toolbar applies on Enter, as an address does, and when the field is left.
  async function applyViewport(width,height){
    const next={width:Math.max(320,Math.min(3840,Number(width)||1280)),height:Math.max(240,Math.min(2160,Number(height)||800))};setViewport(next);
    try{await window.trebellDesktop?.browser?.setViewport?.(next.width,next.height);setBrowserError("")}
    catch(error){setBrowserError(error?.message||String(error)||"Could not resize Agent Browser.")}
  }
  // Record starts one recording: in a panel that read Record while another was starting it starts nothing more.
  async function startRecording(){
    if(kept.phase!=="idle")return;
    const browser=window.trebellDesktop?.browser;if(!browser?.armRecording||!navigator.mediaDevices?.getDisplayMedia||typeof MediaRecorder==="undefined")throw new Error("Browser recording is unavailable in this build.");
    setKept({phase:"starting"});setBusy("recording");let stream=null;
    try{
      await browser.armRecording();
      stream=await navigator.mediaDevices.getDisplayMedia({audio:false,video:{frameRate:{ideal:30,max:30}}});
      const choices=["video/webm;codecs=vp9","video/webm;codecs=vp8","video/webm","video/mp4;codecs=avc1"];
      const mimeType=choices.find(type=>MediaRecorder.isTypeSupported(type))||"",recorder=new MediaRecorder(stream,mimeType?{mimeType}:undefined),chunks=[];
      recorder.ondataavailable=event=>{if(event.data?.size)chunks.push(event.data)};
      recorder.start(250);Object.assign(rec,{since:Date.now(),recorder,stream,chunks});stream=null;setKept({phase:"recording"});
    }finally{for(const track of stream?.getTracks()||[])try{track.stop()}catch{}if(kept.phase==="starting")setKept({phase:"idle"});setBusy("")}
  }
  // A recording is saved once: Stop pressed again while it is being saved (Enter pressed twice) saves nothing more, and a panel
  // opened again meanwhile reads Saving, then Record. It used to save it again, and the panel opened again kept reading Stop.
  async function stopRecording(){
    if(kept.phase!=="recording")return;
    const {recorder,stream,chunks,since}=rec,seconds=Math.max(0,Math.floor((Date.now()-since)/1000));setKept({phase:"stopping"});setBusy("recording-stop");
    try{
      const stopped=new Promise((resolve,reject)=>{
        let settled=false;
        const finish=callback=>{if(settled)return;settled=true;clearTimeout(timeout);callback()};
        const timeout=setTimeout(()=>finish(()=>reject(new Error("Browser recording did not stop in time. Try recording again."))),3000);
        recorder.addEventListener("stop",()=>setTimeout(()=>finish(resolve),50),{once:true});
        if(recorder.state!=="inactive"){
          try{recorder.requestData()}catch{}
          setTimeout(()=>{if(recorder.state!=="inactive")try{recorder.stop()}catch(error){finish(()=>reject(error))}},60);
        }else finish(resolve);
      });
      await stopped;
      const type=recorder.mimeType||chunks[0]?.type||"video/webm";const blob=new Blob(chunks,{type});
      if(!blob.size)throw new Error("Browser recording produced no encoded video. Record for a little longer and try again.");
      if(onAttachFile){const ext=type.includes("mp4")?"mp4":"webm";await onAttachFile(new File([blob],`browser-recording-${Date.now()}.${ext}`,{type}),{kind:"browser",label:"Browser recording",detail:`${seconds}s · ${(blob.size/1024/1024).toFixed(1)} MB`})}
    }finally{
      for(const track of stream?.getTracks?.()||[])try{track.stop()}catch{}
      Object.assign(rec,{recorder:null,stream:null,chunks:null});setKept({phase:"idle"});setBusy("");
    }
  }
  // What is being attached (an element of a page, with its note) is attached once at a time: a press for it while it is on its way
  // (Enter pressed twice) attaches nothing more. Another element, or another note, still attaches meanwhile, and each says it was
  // attached under its own element only: a guard for every attach left the second undone, under the first one's notice.
  async function attachElement(element,note=""){
    const cleanNote=String(note||"").trim(),what=[snapshot?.url,element.ref,cleanNote].join("\n");
    if(attaching.current.has(what))return false;attaching.current.add(what);
    const lines=["Browser element context","URL: "+(snapshot?.url||url),"Title: "+(snapshot?.title||""),"Element ref: "+element.ref,"Tag: "+element.tag,"Text: "+(element.text||""),"Href: "+(element.href||"")];
    if(cleanNote)lines.push("","Annotation: "+cleanNote);
    setBrowserError("");
    try{
      await onAttachText?.((cleanNote?"browser-annotation-":"browser-element-")+element.ref+".txt",lines.join("\n"),{kind:"browser",label:(cleanNote?"Annotated ":"Browser ")+element.ref,detail:cleanNote||(element.text||element.tag||"").slice(0,70)});
      setLastAttached({ref:element.ref,text:cleanNote?"Annotation attached":"Element context attached"});
      return true;
    }catch(error){
      setLastAttached("");
      setBrowserError(error?.message||String(error)||"Could not attach browser context.");
      return false;
    }finally{attaching.current.delete(what)}
  }
  // The agent browser closed, by its Close here, outside the panel or while the panel was away (as its state says), takes its page's
  // elements with it, so none of them can be attached.
  function dropPage(){setSnapshot(null);setSelectedRef(null);setAnnotation("");setLastAttached("")}
  const selectedElement=(snapshot?.elements||[]).find(el=>el.ref===selectedRef)||null;
  const desktopBrowserAvailable=Boolean(window.trebellDesktop?.browser);
  return <div className="preview-page">
    <div className="preview-bar"><Globe2 size={15}/>{desktopBrowserAvailable&&<><button title="Back" disabled={shown.at<1||!!busy} onClick={()=>step(-1)}><ArrowLeft size={13}/></button><button title="Forward" disabled={shown.at>=shown.pages.length-1||!!busy} onClick={()=>step(1)}><ArrowRight size={13}/></button></>}<input ref={urlInputRef} value={draft} onChange={e=>{setDraft(e.target.value);if(urlError)setUrlError("")}} onKeyDown={e=>e.key==="Enter"&&go()} aria-label="Page address" aria-invalid={urlError?"true":undefined} placeholder="http://localhost:3000" title={"Preview zoom "+Math.round(previewZoom*100)+"%"}/><button onClick={go}>Preview</button>{desktopBrowserAvailable&&<button title="Reload agent browser" onClick={reloadAgent} disabled={!!busy}><RefreshCw size={13}/></button>}{url&&<button aria-label="Open in browser" title="Open in browser" onClick={()=>openWebLink(url)}><ExternalLink size={13}/></button>}</div>
    {urlError&&<div className="inline-error preview-url-error" role="alert">{urlError}</div>}

    {desktopBrowserAvailable&&<div className="browser-device-toolbar"><MonitorSmartphone size={13}/><select aria-label="Viewport preset" value={VIEWPORTS.find(item=>item.width===viewport.width&&item.height===viewport.height)?.id||"custom"} onChange={e=>{const preset=VIEWPORTS.find(item=>item.id===e.target.value);if(preset)applyViewport(preset.width,preset.height)}}><option value="custom">Custom</option>{VIEWPORTS.map(item=><option key={item.id} value={item.id}>{item.label} · {item.width}×{item.height}</option>)}</select><input type="number" aria-label="Viewport width" min="320" max="3840" value={viewport.width} onChange={e=>setViewport(v=>({...v,width:e.target.value}))} onBlur={()=>applyViewport(viewport.width,viewport.height)} onKeyDown={e=>e.key==="Enter"&&applyViewport(viewport.width,viewport.height)}/><span>×</span><input type="number" aria-label="Viewport height" min="240" max="2160" value={viewport.height} onChange={e=>setViewport(v=>({...v,height:e.target.value}))} onBlur={()=>applyViewport(viewport.width,viewport.height)} onKeyDown={e=>e.key==="Enter"&&applyViewport(viewport.width,viewport.height)}/><button title="Rotate viewport" onClick={()=>applyViewport(viewport.height,viewport.width)}><RotateCw size={12}/></button><button className={recording?"recording active":"recording"} disabled={phase==="starting"||phase==="stopping"||!recording&&!!busy} onClick={event=>{pressOnce(event);(recording?stopRecording():startRecording()).catch(error=>setBrowserError(error?.message||String(error)))}}>{recording?<Square size={11}/>:<Circle size={11}/>} {phase==="stopping"?"Saving…":recording?`Stop ${recordingSeconds}s`:"Record"}</button></div>}

    {history.length>0&&<details className="browser-history"><summary><History size={12}/> Recent pages</summary><div>{history.slice(0,12).map(item=><button key={item.url} onClick={()=>{setDraft(item.url);openAgentUrl(item.url)}}><span><strong>{item.title||new URL(item.url).host}</strong><small>{item.url}</small></span><time>{new Date(item.lastVisitedAt).toLocaleString()}</time></button>)}</div></details>}

    <div className="preview-discovery">
      <div className="preview-discovery-head"><span><Radar size={13}/> Local dev servers</span><button onClick={discover} disabled={busy==="servers"}><RefreshCw size={12}/> Detect</button></div>
      {servers.length?<><div className="preview-server-list">{servers.map(server=><button key={server.port} onClick={()=>{setDraft(server.url);show(server.url);setKey(k=>k+1)}}><strong>:{server.port}</strong><span>{server.contentType||"HTTP "+server.status}</span></button>)}</div>{serverError&&<div className="inline-error" role="alert">{serverError}</div>}</>:<p>{serverError||"No common local web server detected. Start your dev action, then scan again."}</p>}
    </div>

    {desktopBrowserAvailable?<><div className="agent-browser-toolbar"><button onClick={agentOpen} disabled={!!busy}><Globe2 size={13}/> Open agent browser</button><button onClick={()=>Promise.resolve().then(()=>window.trebellDesktop.browser.show?.()).then(()=>setBrowserError("")).catch(error=>setBrowserError(error?.message||String(error)||"Could not show Agent Browser."))}><Eye size={13}/> Show browser</button><button onClick={inspect} disabled={!!busy}><MousePointer2 size={13}/> Inspect elements</button><button onClick={capture} disabled={!!busy}><Camera size={13}/> Attach screenshot</button><button onClick={openProfileImport} disabled={!!busy}>Import profile</button><button onClick={importCookies} disabled={!!busy}>Import cookie JSON</button><button onClick={()=>Promise.resolve().then(()=>window.trebellDesktop.browser.close?.()).then(()=>{setBrowserError("");dropPage();setCookieStatus("")}).catch(error=>setBrowserError(error?.message||String(error)||"Could not close Agent Browser."))}><X size={13}/> Close</button>{cookieStatus&&<span className="browser-cookie-status" role="status" data-testid="browser-cookie-status">{cookieStatus}</span>}</div>{browserError&&<div className="browser-action-error" role="alert">{browserError}</div>}</>:<div className="agent-browser-unavailable"><strong>Desktop Agent Browser is unavailable here</strong><span>The hosted UI still supports iframe previews, local dev-server detection, and recent-page history.</span></div>}
    {importOpen&&<div className="browser-profile-import" data-testid="browser-profile-import"><div className="browser-profile-import-head"><div><strong>Import signed-in browser session</strong><span>One-time cookie copy into Trebell Agent Browser.</span></div><button aria-label="Close profile import" title="Close profile import" onClick={()=>setImportOpen(false)}><X size={12}/></button></div>{(browserImports?.sources||[]).length?(browserImports.sources||[]).map(source=><section key={source.id}><div><strong>{source.name}</strong><span>{source.running?"Close the browser before importing.":source.installed?`${source.profiles?.length||0} profile${source.profiles?.length===1?"":"s"} found`:"No readable profiles found"}</span></div>{(source.profiles||[]).map(profile=><button key={profile.id} disabled={source.running||!!busy} onClick={()=>importProfile(source,profile)}><span>{profile.name}</span><small>{source.running?"Browser running":"Import"}</small></button>)}</section>):<p>No supported browser profiles were found. On Windows, Firefox and Helium are supported; cookie JSON remains available as a fallback.</p>}</div>}
    <div className={"preview-layout"+(desktopBrowserAvailable?"":" hosted")}><div className="preview-frame">{!url?<div className="preview-empty-state"><Globe2 size={18}/><strong>No preview open</strong><span>Enter a local or web URL above to preview it here.</span></div>:unanswered===url?<div className="preview-empty-state preview-unanswered" role="alert"><Unplug size={18}/><strong>Nothing answered at {url}</strong><span>Start the server for this address, then press Preview to try again.</span></div>:<iframe key={key} title="Trebell preview" src={url} style={{transform:"scale("+previewZoom+")",transformOrigin:"0 0",width:(100/previewZoom)+"%",height:(100/previewZoom)+"%"}}/>}</div>
      {desktopBrowserAvailable&&<aside className="browser-inspector"><h3>Agent browser</h3>{snapshot?<><p><strong>{snapshot.title||"Untitled"}</strong><span>{snapshot.url}</span></p><div className="browser-elements">{(snapshot.elements||[]).map(el=><button className={selectedRef===el.ref?"active":""} key={el.ref} onClick={()=>{setSelectedRef(el.ref);setLastAttached("")}}><code>{el.ref}</code><span>{el.text||el.tag}</span><small>{el.tag}{el.href?" · link":""}</small></button>)}</div>{selectedElement&&<div className="browser-annotation" data-testid="preview-annotation"><div><strong>Annotate {selectedElement.ref}</strong><span>{selectedElement.text||selectedElement.tag}</span></div><textarea value={annotation} onChange={e=>setAnnotation(e.target.value)} placeholder="Add a note or instruction for the agent about this element…"/><div className="annotation-actions" onClick={pressOnce}><button onClick={()=>attachElement(selectedElement)}>Attach context</button>{/* The note attached is emptied, unless another was typed while it was on its way. */}<button className="primary" disabled={!annotation.trim()} onClick={async()=>{const sent=annotation;if(await attachElement(selectedElement,sent))setAnnotation(current=>current===sent?"":current)}}>Attach annotation</button>{lastAttached?.ref===selectedElement.ref&&<span>{lastAttached.text}</span>}</div></div>}</>:<div className="empty-inspector">Open the agent browser and inspect the page to see model-addressable elements.</div>}</aside>}
    </div>
    <p className="preview-note">{desktopBrowserAvailable?"Trebell detects common localhost dev servers automatically. The iframe is a visual preview; Agent Browser gives the active coding agent DOM-aware browser control, and desktop Computer Use is available in Full access mode.":"Trebell detects common localhost dev servers automatically. This hosted surface provides iframe previews; Agent Browser and Computer Use are desktop capabilities."}</p>
  </div>;
}
