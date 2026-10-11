import React,{useEffect,useState} from "react";
import { ExternalLink } from "lucide-react";

const PREF_KEY="trebell.preferredEditor";
const storedEditor=()=>{try{return localStorage.getItem(PREF_KEY)||""}catch{return ""}};
const storeEditor=id=>{try{localStorage.setItem(PREF_KEY,id)}catch{}};

// The editors the desktop app can open the project in and the one chosen, held once for every control that shows them: the
// workspace header's picker and its copy in the More actions menu then open the same editor, and a choice made in either is the
// other's as well. The choice is saved as trebell.preferredEditor, as OpenInPicker saves it. The editors are listed again each
// time `shown` turns true (the header is back), as a picker lists them when it mounts, so an editor installed meanwhile appears.
// open(path) resolves once the editor has started and rejects with the reason it could not, for the caller to show.
export function useOpenInEditors(shown=true){
  const [editors,setEditors]=useState([]);
  const [selected,setSelected]=useState(storedEditor);
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    if(!shown)return;
    let live=true;
    window.trebellDesktop?.openIn?.list?.().then(result=>{if(live)setEditors(result?.editors||[])}).catch(()=>{if(live)setEditors([])});
    return()=>{live=false};
  },[shown]);
  // The chosen editor while it is installed, else the first that is not the file manager.
  const active=editors.find(item=>item.id===selected)||editors.find(item=>item.id!=="file-manager")||editors[0]||null;
  const choose=id=>{setSelected(id);storeEditor(id)};
  async function open(path){
    if(!active||!path)return;
    setBusy(true);
    try{await window.trebellDesktop.openIn.open(path,active.id);storeEditor(active.id)}
    finally{setBusy(false)}
  }
  return {editors,active,busy,choose,open};
}

// The Open button and editor select for useOpenInEditors' state. By itself it opens the project and shows a failure beside the
// picker; with onOpen (the More actions menu, which closes on a chosen action) Open calls that instead. fold marks the header
// row's copy for header-fit.js.
export default function OpenInControl({openIn,path,fold,onOpen}){
  const [error,setError]=useState("");
  const {editors,active,busy}=openIn;
  if(!path||!window.trebellDesktop?.openIn||!editors.length)return null;
  async function open(){
    if(onOpen){onOpen();return}
    setError("");
    try{await openIn.open(path)}catch(error){setError(error?.message||String(error)||"Could not open externally.")}
  }
  return <div className="open-in-wrap" data-fold={fold}>
    <div className="open-in-picker">
      <button onClick={open} disabled={busy||!active} title={active?"Open in "+active.label:"Open externally"}><ExternalLink size={12}/><span>{busy?"Opening…":"Open"}</span></button>
      <select value={active?.id||""} onChange={e=>{openIn.choose(e.target.value);setError("")}} aria-label="Choose external editor">
        {editors.map(editor=><option key={editor.id} value={editor.id}>{editor.label}</option>)}
      </select>
    </div>
    {error&&<span className="open-in-error" role="alert">{error}</span>}
  </div>;
}
