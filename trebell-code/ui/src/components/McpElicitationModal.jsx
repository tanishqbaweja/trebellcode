import React,{useMemo,useState} from "react";
import { ExternalLink, PlugZap, ShieldCheck, X } from "lucide-react";
import {
  buildMcpApprovalResponse,
  buildUserVerificationResponse,
  coerceElicitationFormContent,
  elicitationApprovalDetails,
  elicitationFormFields,
  isAcpElicitation,
  elicitationSupportsPersist,
  mcpElicitationKind,
  buildElicitationResponse,
} from "../mcp-elicitation.js";

function pretty(value){
  if(typeof value==="string")return value;
  try{return JSON.stringify(value)}catch{return String(value)}
}

export default function McpElicitationModal({request,onResolve,onVerify,verificationAvailable=true}){
  const kind=mcpElicitationKind(request);
  const params=request?.params||{};
  const acp=isAcpElicitation(request);
  const details=useMemo(()=>elicitationApprovalDetails(request),[request]);
  const fields=useMemo(()=>elicitationFormFields(request),[request]);
  const [values,setValues]=useState(()=>Object.fromEntries(fields.map(field=>[field.id,field.defaultValue])));
  const [error,setError]=useState("");
  const [verificationBusy,setVerificationBusy]=useState(false);
  const [resolveBusy,setResolveBusy]=useState(false);
  if(!request)return null;

  async function resolve(response){
    if(resolveBusy)return false;
    setError("");setResolveBusy(true);
    try{await onResolve?.(response);return true}
    catch(err){setError("Could not answer app request: "+(err?.message||String(err)));return false}
    finally{setResolveBusy(false)}
  }
  async function submitForm(){
    try{await resolve(acp?buildElicitationResponse(request,"once",coerceElicitationFormContent(fields,values)):{action:"accept",content:coerceElicitationFormContent(fields,values),_meta:null})}
    catch(err){setError(err?.message||String(err))}
  }
  async function openUrl(){
    let parsed;
    try{
      parsed=new URL(String(params.url||""));
      const local=["localhost","127.0.0.1","::1"].includes(parsed.hostname);
      if(parsed.protocol!=="https:"&&!(parsed.protocol==="http:"&&local))throw new Error("Only HTTPS links (or local development HTTP links) can be opened.");
    }catch(err){setError(err?.message||"The app supplied an invalid URL.");return}
    window.open(parsed.href,"_blank","noopener,noreferrer");
    if(acp)await resolve(buildElicitationResponse(request,"once"));
  }
  async function verify(){
    if(!onVerify||!verificationAvailable)return;
    setError("");setVerificationBusy(true);
    try{await resolve(buildUserVerificationResponse(await onVerify(request)))}
    catch(err){setError(err?.message||String(err))}
    finally{setVerificationBusy(false)}
  }

  const message=String(params.message||"").trim();
  const title=kind==="approval"?"Approve app action":kind==="url"?"App needs browser input":kind==="verification"?"Verification required":"App needs input";
  return <div className="modal-backdrop" data-testid="mcp-elicitation"><div className="mcp-elicitation-modal">
    <div className="modal-head"><div>{kind==="approval"?<ShieldCheck size={18}/>:<PlugZap size={18}/>}<strong>{title}</strong></div><button disabled={resolveBusy||verificationBusy} onClick={()=>resolve(acp?buildElicitationResponse(request,"cancel"):buildMcpApprovalResponse("cancel"))} aria-label="Cancel app request"><X size={17}/></button></div>
    {error&&<div className="inline-error" role="alert">{error}</div>}

    {kind==="approval"&&<>
      <div className="mcp-approval-hero">
        <div><span>App</span><strong>{details.connectorName}</strong>{details.connectorDescription&&<p>{details.connectorDescription}</p>}</div>
        <div><span>Action</span><strong>{details.toolTitle}</strong>{details.toolDescription&&<p>{details.toolDescription}</p>}</div>
      </div>
      {details.message&&<p className="mcp-elicitation-message">{details.message}</p>}
      {details.displayParams.length>0&&<div className="mcp-approval-params">{details.displayParams.map(item=><div key={item.name}><span>{item.label}</span><code>{pretty(item.value)}</code></div>)}</div>}
      <div className="mcp-approval-note">Only approve if you expect this app action. “Always allow” changes future approval behavior for this tool, not Trebell’s global permission mode.</div>
      <div className="mcp-approval-actions">
        <button disabled={resolveBusy} onClick={()=>resolve(buildMcpApprovalResponse("cancel"))}>Cancel tool</button>
        <button className="approve" disabled={resolveBusy} onClick={()=>resolve(buildMcpApprovalResponse("once"))}>Allow once</button>
        {elicitationSupportsPersist(request,"session")&&<button className="approve" disabled={resolveBusy} onClick={()=>resolve(buildMcpApprovalResponse("session"))}>Allow session</button>}
        {elicitationSupportsPersist(request,"always")&&<button className="approve strong" disabled={resolveBusy} onClick={()=>resolve(buildMcpApprovalResponse("always"))}>Always allow</button>}
      </div>
    </>}

    {kind==="form"&&<>
      {message&&<p className="mcp-elicitation-message">{message}</p>}
      {fields.length>0?<div className="mcp-form-fields">{fields.map(field=><label key={field.id}>{field.label}{field.required&&<em>required</em>}{field.description&&<small>{field.description}</small>}
        {field.type==="select"?<select value={values[field.id]??""} onChange={event=>{const option=field.options.find(item=>String(item.value)===event.target.value);setValues(current=>({...current,[field.id]:option?.value??event.target.value}))}}><option value="">Select…</option>{field.options.map(option=><option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}</select>
          :field.type==="multiselect"?<div className="mcp-multiselect">{field.options.map(option=>{const selected=(values[field.id]||[]).some(value=>String(value)===String(option.value));return <label key={String(option.value)}><input type="checkbox" checked={selected} onChange={event=>setValues(current=>{const list=Array.isArray(current[field.id])?current[field.id]:[];return {...current,[field.id]:event.target.checked?[...list.filter(value=>String(value)!==String(option.value)),option.value]:list.filter(value=>String(value)!==String(option.value))}})}/>{option.label}</label>})}</div>
          :field.type==="boolean"?<span className="mcp-boolean"><input type="checkbox" checked={Boolean(values[field.id])} onChange={event=>setValues(current=>({...current,[field.id]:event.target.checked}))}/> Enabled</span>
          :<input type={field.secret?"password":field.type==="number"?"number":field.format==="email"?"email":field.format==="uri"?"url":"text"} min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={field.maxLength} step={field.integer?1:undefined} value={values[field.id]??""} onChange={event=>setValues(current=>({...current,[field.id]:event.target.value}))}/>}
      </label>)}</div>:<p className="mcp-elicitation-message">This MCP server is asking permission to continue.</p>}
      <div className="modal-actions"><span>{params.serverName||"MCP server"}</span><button disabled={resolveBusy} onClick={()=>resolve(acp?buildElicitationResponse(request,"decline"):buildMcpApprovalResponse("decline"))}>Decline</button>{fields.length>0?<button className="primary" disabled={resolveBusy} onClick={submitForm}>Submit</button>:<button className="primary" disabled={resolveBusy} onClick={()=>resolve(acp?buildElicitationResponse(request,"once"):buildMcpApprovalResponse("once"))}>Allow</button>}</div>
    </>}

    {kind==="url"&&<>
      {message&&<p className="mcp-elicitation-message">{message}</p>}
      <div className="mcp-url-card"><code>{params.url}</code>{!acp&&<button onClick={openUrl}><ExternalLink size={12}/> Open link</button>}</div>
      <p className="mcp-approval-note">{acp?"Opening the link tells the agent you consented to the out-of-band flow. Trebell never reads what you enter there; the agent can report completion separately.":"Trebell does not mark the request complete just because the link was opened. Confirm only after you finish the requested step in your browser."}</p>
      <div className="modal-actions"><span>{params.serverName||"MCP server"}</span><button disabled={resolveBusy} onClick={()=>resolve(acp?buildElicitationResponse(request,"decline"):buildMcpApprovalResponse("decline"))}>Decline</button>{acp?<button className="primary" disabled={resolveBusy} onClick={openUrl}><ExternalLink size={12}/> Open & continue</button>:<button className="primary" disabled={resolveBusy} onClick={()=>resolve(buildMcpApprovalResponse("once"))}>I completed it</button>}</div>
    </>}

    {kind==="verification"&&<>
      <p className="mcp-elicitation-message">{params.title||message||"This request requires device-backed verification."}</p>
      {params.description&&<p className="mcp-approval-note">{params.description}</p>}
      {!verificationAvailable&&<div className="inline-error">Device verification is unavailable for remote workspaces.</div>}
      {verificationAvailable&&!onVerify&&<div className="inline-error">This Trebell runtime cannot request a native verification proof.</div>}
      <div className="modal-actions"><span>{params.serverName||"MCP server"}</span><button disabled={verificationBusy||resolveBusy} onClick={()=>resolve(buildMcpApprovalResponse("cancel"))}>Cancel request</button>{verificationAvailable&&onVerify&&<button className="primary" disabled={verificationBusy||resolveBusy} onClick={verify}>{verificationBusy?"Verifying…":"Verify with device"}</button>}</div>
    </>}

    {kind==="unsupported"&&<>
      <div className="inline-error">This MCP server requested an elicitation mode this Trebell build does not understand: {String(params.mode||"unknown")}.</div>
      <div className="modal-actions"><span>{params.serverName||"MCP server"}</span><button disabled={resolveBusy} onClick={()=>resolve(buildMcpApprovalResponse("cancel"))}>Cancel request</button></div>
    </>}
  </div></div>;
}
