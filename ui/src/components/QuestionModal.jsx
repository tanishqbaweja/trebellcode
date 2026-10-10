import React,{useEffect,useMemo,useRef,useState} from "react";
import { HelpCircle, Paperclip, X } from "lucide-react";

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

// Browser uploads are stored as "<timestamp>-<hash>-<name>"; show the original name, like the composer shelf does.
function attachmentName(path){
  const name=String(path||"").split(/[\\/]/).pop()||"attachment";
  return name.replace(/^\d{10,}-[0-9a-f]{8}-(?=.)/i,"");
}
// A long name lost its end (and so its extension) to the chip's ellipsis; keep a short extension visible after it.
function attachmentParts(path){
  const name=attachmentName(path),dot=name.lastIndexOf(".");
  return dot>0&&name.length-dot<=10?[name.slice(0,dot),name.slice(dot)]:[name,""];
}

export default function QuestionModal({request,onSubmit,onCancel,pickFiles}){
  const questions=request?.params?.questions||[];
  const initial=useMemo(()=>Object.fromEntries(questions.map(q=>[q.id,[]])),[request]);
  const [answers,setAnswers]=useState(initial);
  const [filesByQuestion,setFilesByQuestion]=useState(()=>Object.fromEntries(questions.map(q=>[q.id,[]])));
  const [busy,setBusy]=useState("");
  const [submitError,setSubmitError]=useState("");
  const [attachError,setAttachError]=useState("");
  const dialogRef=useRef(null);
  // App swaps in a newer question without remounting this modal. Start it from a clean slate instead of carrying the
  // previous question's choices and attachments over (they were shown, counted and submitted for the wrong question).
  const [shownRequest,setShownRequest]=useState(request);
  if(shownRequest!==request){
    setShownRequest(request);
    setAnswers(Object.fromEntries(questions.map(q=>[q.id,[]])));
    setFilesByQuestion(Object.fromEntries(questions.map(q=>[q.id,[]])));
    setSubmitError("");setAttachError("");
  }
  useEffect(()=>{dialogRef.current?.scrollTo?.(0,0)},[request]);
  useEffect(()=>{if(submitError||attachError)dialogRef.current?.querySelector(".inline-error")?.scrollIntoView?.({block:"nearest"})},[submitError,attachError]);
  useModalFocus(dialogRef,Boolean(request));
  if(!request)return null;
  const fileCount=Object.values(filesByQuestion).reduce((sum,items)=>sum+(items?.length||0),0);
  async function attach(questionId){
    if(fileCount>=100)return;
    setBusy(questionId);setAttachError("");
    try{
      const picked=await pickFiles?.();if(!picked?.length)return;
      setFilesByQuestion(prev=>{
        const room=Math.max(0,100-Object.values(prev).reduce((sum,items)=>sum+(items?.length||0),0));
        const next=[...new Set([...(prev[questionId]||[]),...picked.slice(0,room)])];
        return {...prev,[questionId]:next};
      });
    }catch(error){setAttachError("Could not attach files: "+(error?.message||String(error)))}
    finally{setBusy("")}
  }
  async function cancel(){
    if(busy)return;
    setAttachError("");setSubmitError("");setBusy("cancel");
    try{await onCancel?.()}
    catch(error){setSubmitError(error?.message||String(error))}
    finally{setBusy("")}
  }
  function chooseOption(q,label){
    setAnswers(prev=>{
      const current=prev[q.id]||[];
      if(q.allowMultiple){const selected=current.includes(label)?current.filter(value=>value!==label):[...current,label];return {...prev,[q.id]:selected}}
      return {...prev,[q.id]:[label]};
    });
  }
  function setCustom(q,value){
    setAnswers(prev=>{
      const current=(prev[q.id]||[]).filter(answer=>q.options?.some(option=>option.label===answer));
      return {...prev,[q.id]:value?[...current,value]:current};
    });
  }
  return <div className="modal-backdrop"><div className="question-modal" role="dialog" aria-modal="true" aria-labelledby="question-modal-title" ref={dialogRef} tabIndex={-1}>
    <div className="modal-head"><div><span className="modal-head-icon"><HelpCircle size={16}/></span><strong id="question-modal-title">Agent needs input</strong></div><button className="modal-close" onClick={cancel} disabled={Boolean(busy)} aria-label="Close question" title="Close question"><X size={16}/></button></div>
    {questions.map(q=><div className="question-block" key={q.id}><label>{q.header&&<small>{q.header}</small>}<strong>{q.question}</strong></label>
      {q.options?.length>0&&<div className={"question-options"+(q.allowMultiple?" multiple":"")}>{q.options.map(opt=><button className={answers[q.id]?.includes(opt.label)?"active":""} aria-pressed={Boolean(answers[q.id]?.includes(opt.label))} key={opt.label} onClick={()=>chooseOption(q,opt.label)}>{opt.label}{opt.description&&<span>{opt.description}</span>}</button>)}</div>}
      <input className="tb-input" placeholder="Custom answer…" value={answers[q.id]?.find(a=>!q.options?.some(o=>o.label===a))||""} onChange={e=>setCustom(q,e.target.value)}/>
      <div className="question-files">{(filesByQuestion[q.id]||[]).map(path=>{const [stem,ext]=attachmentParts(path);return <span key={path} title={path}><Paperclip size={11}/><em>{stem}</em>{ext&&<em className="question-file-ext">{ext}</em>}<button type="button" title="Remove attachment" onClick={()=>setFilesByQuestion(prev=>({...prev,[q.id]:(prev[q.id]||[]).filter(item=>item!==path)}))}><X size={11}/></button></span>})}<button type="button" className="tb-btn tb-btn--sm question-attach" onClick={()=>attach(q.id)} disabled={busy===q.id||fileCount>=100}><Paperclip size={13}/> {busy===q.id?"Choosing…":"Attach files"}</button></div>
    </div>)}
    {attachError&&<div className="inline-error" role="alert">{attachError}</div>}
    {submitError&&<div className="inline-error" role="alert">{submitError}</div>}
    <div className="modal-actions"><span>{fileCount?`${fileCount}/100 attached`:""}</span><button className="tb-btn" onClick={cancel} disabled={Boolean(busy)}>{busy==="cancel"?"Cancelling…":"Cancel"}</button><button className="tb-btn tb-btn--primary primary" disabled={Boolean(busy)} onClick={async()=>{setAttachError("");setSubmitError("");setBusy("submit");try{await onSubmit(answers,filesByQuestion)}catch(error){setSubmitError(error?.message||String(error))}finally{setBusy("")}}}>{busy==="submit"?"Submitting…":"Submit"}</button></div>
  </div></div>;
}
