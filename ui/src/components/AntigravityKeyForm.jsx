import React,{useEffect,useRef,useState} from "react";
import { api } from "../api.js";
import { openWebLink } from "../web-link.js";

const AI_STUDIO_KEYS="https://aistudio.google.com/apikey";

// What the line under the harness list says once a key is saved or removed: the Antigravity chats open on the key before were stopped
// (the server's stoppedChats), as each kept the key it started with.
function answerText(result,removed){
  const count=Number(result?.stoppedChats)||0,chats=count===1?"The Antigravity chat":`The ${count} Antigravity chats`,were=count===1?"was":"were";
  if(removed)return "Gemini API key removed."+(count?` ${chats} open on it ${were} stopped.`:"");
  return "Gemini API key saved, and Antigravity opened a session with it. Google checks the key with the first chat message."+(count?` ${chats} open on the earlier key ${were} stopped, and ${count===1?"goes":"go"} on with this key at the next message.`:"");
}

// Antigravity's sign-in in Settings: a Gemini API key from Google AI Studio, the route Google recommends for third-party apps.
// Trebell saves the key once Antigravity has signed in with it, and never shows it again: the field only says that one is saved.
// saved: whether a key is saved. onAnswer(result, said) takes the server's answer, with the harness list in it, and what to say of it.
export default function AntigravityKeyForm({saved=false,instanceId=null,onAnswer,onClose}){
  const [key,setKey]=useState(""),[busy,setBusy]=useState(""),[refusal,setRefusal]=useState(""),field=useRef(null);
  useEffect(()=>{field.current?.focus();field.current?.scrollIntoView?.({block:"nearest"})},[]);
  async function send(action){
    if(busy||(action==="login"&&!key.trim()))return;
    setBusy(action);setRefusal("");
    try{
      const result=await api("/api/agent-runtime-auth",{method:"POST",body:{action,runtime:"antigravity",instanceId,...(action==="login"?{apiKey:key.trim()}:{})}});
      setKey("");onAnswer?.(result,answerText(result,action==="remove-key"));
    }catch(error){setRefusal(error.message||String(error))}
    finally{setBusy("")}
  }
  return <div className="runtime-profile-editor" data-testid="antigravity-key-form">
    <label>Antigravity · Gemini API key<input ref={field} type="password" autoComplete="off" spellCheck={false} value={key} disabled={Boolean(busy)} onChange={event=>setKey(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();if(!event.repeat)send("login")}else if(event.key==="Escape"&&!busy){event.preventDefault();onClose?.()}}} placeholder={saved?"Saved key ••••••••":"Paste a Gemini API key"}/></label>
    <p>Trebell Code runs Antigravity on a Gemini API key from Google AI Studio, billed to that key: the route Google recommends for third-party apps. A Google account's sign-in through a third-party app falls under Google's Antigravity terms, so Trebell Code does not offer it.</p>
    <div className="provider-key-actions">
      <button className="setting-action" onClick={()=>send("login")} disabled={!key.trim()||Boolean(busy)} aria-busy={busy==="login"?"true":undefined}>{busy==="login"?"Checking key…":"Save key and sign in"}</button>
      {saved&&<button onClick={()=>send("remove-key")} disabled={Boolean(busy)}>{busy==="remove-key"?"Removing…":"Remove key"}</button>}
      <button onClick={()=>openWebLink(AI_STUDIO_KEYS)}>Get a key in Google AI Studio</button>
      <button onClick={onClose} disabled={Boolean(busy)}>Close</button>
    </div>
    {busy==="login"&&<p role="status">Antigravity is starting with the key. This takes about half a minute, and up to 5 minutes on a slow network.</p>}
    {refusal&&<p className="provider-status-error" role="alert">{refusal}</p>}
  </div>;
}
