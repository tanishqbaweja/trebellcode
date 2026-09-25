import React,{useEffect,useMemo,useRef,useState} from "react";
import { CircleStop, Download, Home, Keyboard, Moon, Play, RefreshCw, RotateCw, Smartphone, Sun, Undo2 } from "lucide-react";
import { api } from "../api.js";
import { startVisibilityPoll } from "../visibility-poll.js";

export default function DevicePanel(){
  const [data,setData]=useState({capabilities:{android:{available:false},ios:{available:false}},devices:[],avds:[]});
  const [selected,setSelected]=useState("");
  const [shot,setShot]=useState(null);
  const [text,setText]=useState("");
  const [busy,setBusy]=useState("");
  const [toolBusy,setToolBusy]=useState("");
  const [toolUpdates,setToolUpdates]=useState(null);
  const [message,setMessage]=useState("");
  const imageRef=useRef(null);
  const current=useMemo(()=>data.devices.find(device=>device.id===selected)||null,[data.devices,selected]);

  async function refresh(){
    try{
      const next=await api("/api/devices");setData(next);setSelected(value=>value&&next.devices.some(device=>device.id===value)?value:(next.devices.find(device=>device.running)?.id||next.devices[0]?.id||""));
    }catch(error){setMessage(error.message)}
  }
  async function refreshShot(){if(!selected)return;try{setShot(await api("/api/device/screenshot?id="+encodeURIComponent(selected)))}catch(error){setMessage(error.message)}}
  useEffect(()=>{const poll=startVisibilityPoll(refresh,{intervalMs:5000});return()=>poll.dispose()},[]);
  useEffect(()=>{setShot(null);if(!selected)return;const poll=startVisibilityPoll(refreshShot,{intervalMs:1200});return()=>poll.dispose()},[selected]);

  async function act(action,args={}){
    if(!selected)return false;setBusy(action);setMessage("");
    try{
      const result=await api("/api/device/action",{method:"POST",body:{id:selected,action,args}});
      if(action==="foreground")setMessage(result.foreground||"Foreground app unavailable");
      await refreshShot();return true;
    }catch(error){setMessage(error.message);return false}
    finally{setBusy("")}
  }
  async function startAvd(avd){setBusy("start");setMessage("");try{await api("/api/device/start",{method:"POST",body:{avd}});setMessage(`Starting ${avd}…`);setTimeout(refresh,2000)}catch(error){setMessage(error.message)}finally{setBusy("")}}
  async function checkToolUpdates({announce=true}={}){
    setToolBusy("check");if(announce)setMessage("");
    try{
      const next=await api("/api/device/tool-updates");setToolUpdates(next);
      if(announce){
        if(next.error)setMessage(next.error);
        else if(!next.available)setMessage(next.reason||"Android SDK update checks are unavailable.");
        else if(!(next.updates||[]).length)setMessage("Android Platform-Tools and Emulator are up to date.");
        else setMessage(`${next.updates.length} Android tool update${next.updates.length===1?" is":"s are"} available.`);
      }
      return next;
    }catch(error){if(announce)setMessage(error.message);return null}
    finally{setToolBusy("")}
  }
  async function updateTool(tool){
    const update=toolUpdates?.updates?.find(item=>item.id===tool);
    setToolBusy(tool);setMessage(`Updating ${update?.label||tool}…`);
    try{
      await api("/api/device/tool-update",{method:"POST",body:{tool}});
      const label=update?.label||tool;
      setToolUpdates(current=>current?{...current,updates:(current.updates||[]).filter(item=>item.id!==tool)}:current);
      setMessage(`${label} updated successfully.`);
      await refresh();
      try{
        const next=await api("/api/device/tool-updates");
        setToolUpdates(next);
      }catch(error){
        setMessage(`${label} updated successfully, but could not refresh tool update status: ${error.message||String(error)}`);
      }
    }catch(error){setMessage(error.message)}
    finally{setToolBusy("")}
  }
  function tap(event){if(!shot?.width||!shot?.height||!imageRef.current||!selected)return;const rect=imageRef.current.getBoundingClientRect();const x=(event.clientX-rect.left)/rect.width*shot.width;const y=(event.clientY-rect.top)/rect.height*shot.height;act("tap",{x,y})}
  const androidTools=data.capabilities?.android?.tools||[];
  const updateByTool=useMemo(()=>Object.fromEntries((toolUpdates?.updates||[]).map(item=>[item.id,item])),[toolUpdates]);

  return <div className="device-panel">
    <div className="device-toolbar"><select value={selected} onChange={e=>setSelected(e.target.value)}><option value="">Choose simulator</option>{data.devices.map(device=><option value={device.id} key={device.id}>{device.name} · {device.platform} · {device.state}</option>)}</select><button onClick={refresh}><RefreshCw size={13}/></button></div>
    <div className="device-tooling">
      <div className="device-tooling-head"><div><strong>Android tools</strong><span>Detected locally. Updates run only when you choose one.</span></div><button onClick={()=>checkToolUpdates()} disabled={!!toolBusy||!data.capabilities?.android?.sdkManagerAvailable}><RefreshCw size={12}/>{toolBusy==="check"?"Checking…":"Check updates"}</button></div>
      <div className="device-tool-list">{androidTools.map(tool=>{const update=updateByTool[tool.id];return <div key={tool.id}><span><strong>{tool.label}</strong><small>{tool.installed?(tool.version||"Installed"):"Not found"}{update?` · ${update.availableVersion} available`:""}</small></span>{update&&tool.id!=="sdkmanager"?<button onClick={()=>updateTool(tool.id)} disabled={!!toolBusy}><Download size={11}/>{toolBusy===tool.id?"Updating…":"Update"}</button>:<em>{tool.installed?"Ready":"Missing"}</em>}</div>})}</div>
      {!data.capabilities?.android?.sdkManagerAvailable&&<p>Install Android command-line tools (sdkmanager) to check or apply Platform-Tools and Emulator updates from Trebell.</p>}
    </div>
    {!data.capabilities?.android?.available&&!data.capabilities?.ios?.available&&<div className="device-setup"><Smartphone size={26}/><strong>No simulator tooling detected</strong><p>Android needs Platform-Tools (adb) and an emulator. iOS Simulator requires macOS with Xcode.</p></div>}
    {!selected&&data.avds?.length>0&&<div className="device-avds"><strong>Android virtual devices</strong>{data.avds.map(avd=><button key={avd} onClick={()=>startAvd(avd)} disabled={!!busy}><Play size={12}/> {avd}</button>)}</div>}
    {selected&&<>
      <div className="device-screen-wrap">{shot?.dataUrl?<img ref={imageRef} src={shot.dataUrl} alt={current?.name||"Simulator"} onClick={tap}/>:<div className="device-loading">Loading simulator screen…</div>}</div>
      <div className="device-controls">
        {current?.platform==="android"&&<><button onClick={()=>act("key",{key:"back"})}><Undo2 size={13}/> Back</button><button onClick={()=>act("key",{key:"home"})}><Home size={13}/> Home</button><button onClick={()=>act("key",{key:"recents"})}>Recents</button><button onClick={()=>act("rotate",{rotation:1})}><RotateCw size={13}/> Rotate</button><button onClick={()=>act("theme",{dark:true})}><Moon size={13}/></button><button onClick={()=>act("theme",{dark:false})}><Sun size={13}/></button><button onClick={()=>act("foreground")}>Foreground app</button></>}
        {current?.platform==="ios"&&<button onClick={()=>act("poweroff")}><CircleStop size={13}/> Power off</button>}
      </div>
      {current?.platform==="android"&&<div className="device-type"><Keyboard size={13}/><input value={text} onChange={e=>setText(e.target.value)} onKeyDown={async e=>{if(e.key==="Enter"&&text&&await act("type",{text}))setText("")}} placeholder="Type into focused emulator control"/><button onClick={async()=>{if(text&&await act("type",{text}))setText("")}}>Send</button></div>}
    </>}
    {message&&<div className="inline-status">{message}</div>}
  </div>;
}
