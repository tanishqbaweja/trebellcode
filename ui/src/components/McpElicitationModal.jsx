import React,{useEffect,useMemo,useRef,useState} from "react";
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

// Validate in field order so the first problem on screen is the one reported. The shared coercion checks required
// values, lengths, ranges and item counts; the schema's email and uri formats were rendered as email/url inputs but
// never checked, so "not-an-email" was sent to the app as a valid answer.
function firstFormProblem(fields,values){
  for(const field of fields){
    try{coerceElicitationFormContent([field],values)}catch(err){return {id:field.id,message:err?.message||String(err)}}
    if(!["email","uri"].includes(field.format)||["number","boolean","select","multiselect"].includes(field.type))continue;
    const text=String(values?.[field.id]??"").trim();
    if(!text)continue;
    if(field.format==="email"&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text))return {id:field.id,message:`${field.label} must be a valid email address`};
    if(field.format==="uri"){try{new URL(text)}catch{return {id:field.id,message:`${field.label} must be a full URL, such as https://example.com`}}}
  }
  return null;
}

// Modal focus: move focus into the dialog when it opens and keep Tab/Shift+Tab inside it, so keyboard users cannot
// reach (and activate) controls behind the backdrop. Focus that sits inside another open modal is left alone.
function useModalFocus(ref,active,focusOnOpen=true){
  useEffect(()=>{
    const node=ref.current;if(!active||!node)return;
    if(focusOnOpen&&!node.contains(document.activeElement))node.focus({preventScroll:true});
    const onKey=event=>{
      if(event.key!=="Tab"||event.defaultPrevented)return;
      const current=document.activeElement,owner=current?.closest?.('[aria-modal="true"]');
      if(owner&&owner!==node)return;
      const items=[...node.querySelectorAll("button,input,select,textarea,a[href],[tabindex]")].filter(item=>item.tabIndex>=0&&!item.disabled&&item.getClientRects().length);
      if(!items.length){event.preventDefault();node.focus();return}
      const first=items[0],last=items[items.length-1];
      if(!node.contains(current)||current===node){event.preventDefault();(event.shiftKey?last:first).focus()}
      else if(event.shiftKey&&current===first){event.preventDefault();last.focus()}
      else if(!event.shiftKey&&current===last){event.preventDefault();first.focus()}
    };
    document.addEventListener("keydown",onKey,true);
    return()=>document.removeEventListener("keydown",onKey,true);
  },[ref,active,focusOnOpen]);
}

export default function McpElicitationModal({request,onResolve,onVerify,verificationAvailable=true,verificationUnavailableReason=""}){
  const kind=mcpElicitationKind(request);
  const params=request?.params||{};
  const acp=isAcpElicitation(request);
  const details=useMemo(()=>elicitationApprovalDetails(request),[request]);
  const fields=useMemo(()=>elicitationFormFields(request),[request]);
  const [values,setValues]=useState(()=>Object.fromEntries(fields.map(field=>[field.id,field.defaultValue])));
  const [error,setError]=useState("");
  const [invalidField,setInvalidField]=useState(null);
  const [verificationBusy,setVerificationBusy]=useState(false);
  const [resolveBusy,setResolveBusy]=useState(false);
  const dialogRef=useRef(null);
  const errorRef=useRef(null);
  useModalFocus(dialogRef,Boolean(request));
  // The error sits under the header; bring it into view when it appears after submitting from a scrolled-down form.
  useEffect(()=>{if(error)errorRef.current?.scrollIntoView?.({block:"nearest"})},[error]);
  if(!request)return null;

  async function resolve(response){
    if(resolveBusy)return false;
    setError("");setResolveBusy(true);
    try{await onResolve?.(response);return true}
    catch(err){setError("Could not answer app request: "+(err?.message||String(err)));return false}
    finally{setResolveBusy(false)}
  }
  // Editing a field clears the previous validation error, which otherwise stayed on screen after the field was fixed.
  function edit(update){setValues(update);setError("");setInvalidField(null)}
  async function submitForm(){
    const problem=firstFormProblem(fields,values);
    if(problem){setError(problem.message);setInvalidField(problem.id);errorRef.current?.scrollIntoView?.({block:"nearest"});return}
    try{await resolve(acp?buildElicitationResponse(request,"once",coerceElicitationFormContent(fields,values)):{action:"accept",content:coerceElicitationFormContent(fields,values),_meta:null})}
    catch(err){setError(err?.message||String(err));errorRef.current?.scrollIntoView?.({block:"nearest"})}
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
  return <div className="modal-backdrop" data-testid="mcp-elicitation"><div className={"mcp-elicitation-modal kind-"+kind} role="dialog" aria-modal="true" aria-labelledby="mcp-elicitation-title" ref={dialogRef} tabIndex={-1}>
    <div className="modal-head"><div><span className="modal-head-icon">{kind==="approval"?<ShieldCheck size={16}/>:<PlugZap size={16}/>}</span><strong id="mcp-elicitation-title">{title}</strong></div><button className="modal-close" disabled={resolveBusy||verificationBusy} onClick={()=>resolve(acp?buildElicitationResponse(request,"cancel"):buildMcpApprovalResponse("cancel"))} aria-label="Cancel app request"><X size={16}/></button></div>
    {error&&<div className="inline-error" role="alert" ref={errorRef}>{error}</div>}

    {kind==="approval"&&<>
      <div className="mcp-approval-hero">
        <div><span>App</span><strong>{details.connectorName}</strong>{details.connectorDescription&&<p>{details.connectorDescription}</p>}</div>
        <div><span>Action</span><strong>{details.toolTitle}</strong>{details.toolDescription&&<p>{details.toolDescription}</p>}</div>
      </div>
      {details.message&&<p className="mcp-elicitation-message">{details.message}</p>}
      {details.displayParams.length>0&&<div className="mcp-approval-params">{details.displayParams.map(item=><div key={item.name}><span>{item.label}</span><code>{pretty(item.value)}</code></div>)}</div>}
      <div className="mcp-approval-note">Only approve if you expect this app action. “Always allow” changes future approval behavior for this tool, not Trebell’s global permission mode.</div>
      <div className="mcp-approval-actions">
        <button className="tb-btn mcp-cancel" disabled={resolveBusy} onClick={()=>resolve(buildMcpApprovalResponse("cancel"))}>Cancel tool</button>
        {elicitationSupportsPersist(request,"always")&&<button className="tb-btn tb-btn--outline approve strong" disabled={resolveBusy} onClick={()=>resolve(buildMcpApprovalResponse("always"))}>Always allow</button>}
        {elicitationSupportsPersist(request,"session")&&<button className="tb-btn tb-btn--outline approve" disabled={resolveBusy} onClick={()=>resolve(buildMcpApprovalResponse("session"))}>Allow session</button>}
        <button className="tb-btn tb-btn--primary approve allow-once" disabled={resolveBusy} onClick={()=>resolve(buildMcpApprovalResponse("once"))}>Allow once</button>
      </div>
    </>}

    {kind==="form"&&<>
      {message&&<p className="mcp-elicitation-message">{message}</p>}
      {fields.length>0?<div className="mcp-form-fields">{fields.map(field=>{
        // A multiselect holds its own option labels; wrapping it in an outer <label> made a click on the field title
        // toggle the first option, so it is a labelled group instead.
        const Field=field.type==="multiselect"?"div":"label";
        return <Field className={"mcp-field type-"+(field.type||"text")+(invalidField===field.id?" invalid":"")} key={field.id} {...(field.type==="multiselect"?{role:"group","aria-label":field.label}:{})}><span className="mcp-field-label">{field.label}{field.required&&<em>required</em>}</span>{field.description&&<small>{field.description}</small>}
        {field.type==="select"?<select className="tb-select" aria-invalid={invalidField===field.id||undefined} value={values[field.id]??""} onChange={event=>{const option=field.options.find(item=>String(item.value)===event.target.value);edit(current=>({...current,[field.id]:option?.value??event.target.value}))}}><option value="">Select…</option>{field.options.map(option=><option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}</select>
          :field.type==="multiselect"?<div className="mcp-multiselect">{field.options.map(option=>{const selected=(values[field.id]||[]).some(value=>String(value)===String(option.value));return <label key={String(option.value)} className={selected?"selected":""}><input type="checkbox" checked={selected} onChange={event=>edit(current=>{const list=Array.isArray(current[field.id])?current[field.id]:[];return {...current,[field.id]:event.target.checked?[...list.filter(value=>String(value)!==String(option.value)),option.value]:list.filter(value=>String(value)!==String(option.value))}})}/>{option.label}</label>})}</div>
          :field.type==="boolean"?<span className="mcp-boolean"><input type="checkbox" checked={Boolean(values[field.id])} onChange={event=>edit(current=>({...current,[field.id]:event.target.checked}))}/> Enabled</span>
          :<input className="tb-input" aria-invalid={invalidField===field.id||undefined} type={field.secret?"password":field.type==="number"?"number":field.format==="email"?"email":field.format==="uri"?"url":"text"} min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={field.maxLength} step={field.integer?1:undefined} value={values[field.id]??""} onChange={event=>edit(current=>({...current,[field.id]:event.target.value}))}/>}
      </Field>})}</div>:<p className="mcp-elicitation-message">This MCP server is asking permission to continue.</p>}
      <div className="modal-actions"><span>{params.serverName||"MCP server"}</span><button className="tb-btn" disabled={resolveBusy} onClick={()=>resolve(acp?buildElicitationResponse(request,"decline"):buildMcpApprovalResponse("decline"))}>Decline</button>{fields.length>0?<button className="tb-btn tb-btn--primary primary" disabled={resolveBusy} onClick={submitForm}>Submit</button>:<button className="tb-btn tb-btn--primary primary" disabled={resolveBusy} onClick={()=>resolve(acp?buildElicitationResponse(request,"once"):buildMcpApprovalResponse("once"))}>Allow</button>}</div>
    </>}

    {kind==="url"&&<>
      {message&&<p className="mcp-elicitation-message">{message}</p>}
      <div className="mcp-url-card"><code>{params.url}</code>{!acp&&<button className="tb-btn tb-btn--sm" onClick={openUrl}><ExternalLink size={12}/> Open link</button>}</div>
      <p className="mcp-approval-note">{acp?"Opening the link tells the agent you consented to the out-of-band flow. Trebell never reads what you enter there; the agent can report completion separately.":"Trebell does not mark the request complete just because the link was opened. Confirm only after you finish the requested step in your browser."}</p>
      <div className="modal-actions"><span>{params.serverName||"MCP server"}</span><button className="tb-btn" disabled={resolveBusy} onClick={()=>resolve(acp?buildElicitationResponse(request,"decline"):buildMcpApprovalResponse("decline"))}>Decline</button>{acp?<button className="tb-btn tb-btn--primary primary" disabled={resolveBusy} onClick={openUrl}><ExternalLink size={12}/> Open & continue</button>:<button className="tb-btn tb-btn--primary primary" disabled={resolveBusy} onClick={()=>resolve(buildMcpApprovalResponse("once"))}>I completed it</button>}</div>
    </>}

    {kind==="verification"&&<>
      <p className="mcp-elicitation-message">{params.title||message||"This request requires device-backed verification."}</p>
      {params.description&&<p className="mcp-approval-note">{params.description}</p>}
      {!verificationAvailable&&<div className="inline-error">{verificationUnavailableReason||"Device verification is unavailable for this runtime or workspace."}</div>}
      {verificationAvailable&&!onVerify&&<div className="inline-error">This Trebell runtime cannot request a native verification proof.</div>}
      <div className="modal-actions"><span>{params.serverName||"MCP server"}</span><button className="tb-btn" disabled={verificationBusy||resolveBusy} onClick={()=>resolve(buildMcpApprovalResponse("cancel"))}>Cancel request</button>{verificationAvailable&&onVerify&&<button className="tb-btn tb-btn--primary primary" disabled={verificationBusy||resolveBusy} onClick={verify}>{verificationBusy?"Verifying…":"Verify with device"}</button>}</div>
    </>}

    {kind==="unsupported"&&<>
      <div className="inline-error">This MCP server requested an elicitation mode this Trebell build does not understand: {String(params.mode||"unknown")}.</div>
      <div className="modal-actions"><span>{params.serverName||"MCP server"}</span><button className="tb-btn" disabled={resolveBusy} onClick={()=>resolve(buildMcpApprovalResponse("cancel"))}>Cancel request</button></div>
    </>}
  </div></div>;
}
