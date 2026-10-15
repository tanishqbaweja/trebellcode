import React,{useEffect,useMemo,useRef,useState} from "react";
import { ExternalLink, X } from "lucide-react";

const PREF_KEY="trebell.preferredEditor";

export default function OpenInPicker({path,compact=false}){
  const [editors,setEditors]=useState([]);
  const [selected,setSelected]=useState(()=>localStorage.getItem(PREF_KEY)||"");
  const [busy,setBusy]=useState(false);
  // A failed Open belongs to the file and the editor it was for, as the header picker's does (useOpenInEditors): another file opened
  // or another editor chosen puts it away for good, and one that answers after such a change is not kept. The next Open and its
  // Dismiss put it away too.
  const [failure,setFailure]=useState(null);

  useEffect(()=>{
    let live=true;
    window.trebellDesktop?.openIn?.list?.().then(result=>{
      if(!live)return;
      const items=result?.editors||[];
      setEditors(items);
      const preferred=items.some(item=>item.id===selected)?selected:(items.find(item=>item.id!=="file-manager")?.id||items[0]?.id||"");
      setSelected(preferred);
    }).catch(()=>{if(live)setEditors([])});
    return()=>{live=false};
  },[]);

  const active=useMemo(()=>editors.find(item=>item.id===selected)||editors[0]||null,[editors,selected]);
  const target=path&&active?path+"\n"+active.id:"";
  const targetRef=useRef(target);
  useEffect(()=>{targetRef.current=target;setFailure(current=>current&&current.target!==target?null:current)},[target]);
  const error=failure?.target===target?failure.message:"";
  if(!path||!window.trebellDesktop?.openIn||!editors.length)return null;

  async function open(){
    if(!active)return;
    setBusy(true);setFailure(null);
    try{
      await window.trebellDesktop.openIn.open(path,active.id);
      localStorage.setItem(PREF_KEY,active.id);
    }catch(error){if(targetRef.current===target)setFailure({target,message:error?.message||String(error)||"Could not open externally."})}
    finally{setBusy(false)}
  }

  return <div className="open-in-wrap">
    <div className={compact?"open-in-picker compact":"open-in-picker"}>
      <button onClick={open} disabled={busy||!active} title={active?"Open in "+active.label:"Open externally"}><ExternalLink size={12}/>{!compact&&<span>{busy?"Opening…":"Open"}</span>}</button>
      <select value={active?.id||""} onChange={e=>{setSelected(e.target.value);localStorage.setItem(PREF_KEY,e.target.value)}} aria-label="Choose external editor">
        {editors.map(editor=><option key={editor.id} value={editor.id}>{editor.label}</option>)}
      </select>
    </div>
    {error&&<div className="open-in-error" role="alert"><span>{error}</span><button type="button" onClick={()=>setFailure(null)} aria-label="Dismiss open error" title="Dismiss"><X size={12}/></button></div>}
  </div>;
}
