import React,{useEffect,useRef,useState} from "react";
import { ExternalLink } from "lucide-react";

const PREF_KEY="trebell.preferredEditor";
const storedEditor=()=>{try{return localStorage.getItem(PREF_KEY)||""}catch{return ""}};
const storeEditor=id=>{try{localStorage.setItem(PREF_KEY,id)}catch{}};

// The editors the desktop app can open the project at path in and the one chosen, held once for every control that shows them:
// the workspace header's picker and its copy in the More actions menu then open the same editor, and a choice made in either is
// the other's as well. The choice is saved as trebell.preferredEditor, as OpenInPicker saves it. The editors are listed again each
// time `shown` turns true (the header is back), as a picker lists them when it mounts, so an editor installed meanwhile appears.
// open() resolves once the editor has started. A failed open({inline:true}) (the row's picker) is kept as error, for the picker to
// show beside itself; any other failed Open rejects, for its caller to report. The error lasts only until something replaces it:
// the next Open from either copy, or another editor or project, so the row never shows a failure the last Open has superseded.
export function useOpenInEditors(path,shown=true){
  const [editors,setEditors]=useState([]);
  const [selected,setSelected]=useState(storedEditor);
  const [busy,setBusy]=useState(false);
  const [failure,setFailure]=useState(null);
  useEffect(()=>{
    if(!shown)return;
    let live=true;
    window.trebellDesktop?.openIn?.list?.().then(result=>{if(live)setEditors(result?.editors||[])}).catch(()=>{if(live)setEditors([])});
    return()=>{live=false};
  },[shown]);
  // The chosen editor while it is installed, else the first that is not the file manager.
  const active=editors.find(item=>item.id===selected)||editors.find(item=>item.id!=="file-manager")||editors[0]||null;
  // What Open would do now. A failure kept for something else is dropped, and one that answers after the project or editor
  // changed is not kept, so neither can come back with its project.
  const target=path&&active?path+"\n"+active.id:"";
  const targetRef=useRef(target);
  useEffect(()=>{targetRef.current=target;setFailure(current=>current&&current.target!==target?null:current)},[target]);
  const choose=id=>{setSelected(id);storeEditor(id)};
  async function open({inline=false}={}){
    if(!target)return;
    setBusy(true);setFailure(null);
    try{await window.trebellDesktop.openIn.open(path,active.id);storeEditor(active.id)}
    catch(error){if(!inline)throw error;if(targetRef.current===target)setFailure({target,message:error?.message||String(error)||"Could not open externally."})}
    finally{setBusy(false)}
  }
  return {path,editors,active,busy,error:failure?.target===target?failure.message:"",choose,open};
}

// The Open button and editor select for useOpenInEditors' state. By itself it opens the project and shows its failure beside the
// picker; with onOpen (the More actions menu, which closes on a chosen action and leaves the report to the app) Open calls that
// instead and no failure is drawn. fold marks the header row's copy for header-fit.js.
export default function OpenInControl({openIn,fold,onOpen}){
  const {path,editors,active,busy,error}=openIn;
  if(!path||!window.trebellDesktop?.openIn||!editors.length)return null;
  return <div className="open-in-wrap" data-fold={fold}>
    <div className="open-in-picker">
      <button onClick={onOpen||(()=>openIn.open({inline:true}))} disabled={busy||!active} title={active?"Open in "+active.label:"Open externally"}><ExternalLink size={12}/><span>{busy?"Opening…":"Open"}</span></button>
      <select value={active?.id||""} onChange={e=>openIn.choose(e.target.value)} aria-label="Choose external editor">
        {editors.map(editor=><option key={editor.id} value={editor.id}>{editor.label}</option>)}
      </select>
    </div>
    {!onOpen&&error&&<span className="open-in-error" role="alert">{error}</span>}
  </div>;
}
