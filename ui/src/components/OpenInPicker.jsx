import React,{useEffect,useMemo,useState} from "react";
import { ExternalLink } from "lucide-react";

const PREF_KEY="trebell.preferredEditor";

export default function OpenInPicker({path,compact=false}){
  const [editors,setEditors]=useState([]);
  const [selected,setSelected]=useState(()=>localStorage.getItem(PREF_KEY)||"");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");

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
  if(!path||!window.trebellDesktop?.openIn||!editors.length)return null;

  async function open(){
    if(!active)return;
    setBusy(true);setError("");
    try{
      await window.trebellDesktop.openIn.open(path,active.id);
      localStorage.setItem(PREF_KEY,active.id);
    }catch(error){setError(error?.message||String(error)||"Could not open externally.")}
    finally{setBusy(false)}
  }

  return <div className="open-in-wrap">
    <div className={compact?"open-in-picker compact":"open-in-picker"}>
      <button onClick={open} disabled={busy||!active} title={active?"Open in "+active.label:"Open externally"}><ExternalLink size={12}/>{!compact&&<span>{busy?"Opening…":"Open"}</span>}</button>
      <select value={active?.id||""} onChange={e=>{setSelected(e.target.value);setError("");localStorage.setItem(PREF_KEY,e.target.value)}} aria-label="Choose external editor">
        {editors.map(editor=><option key={editor.id} value={editor.id}>{editor.label}</option>)}
      </select>
    </div>
    {error&&<span className="open-in-error" role="alert">{error}</span>}
  </div>;
}
