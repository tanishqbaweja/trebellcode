import React,{useMemo,useState} from "react";
import { HelpCircle, Paperclip, X } from "lucide-react";

export default function QuestionModal({request,onSubmit,onCancel,pickFiles}){
  const questions=request?.params?.questions||[];
  const initial=useMemo(()=>Object.fromEntries(questions.map(q=>[q.id,[]])),[request]);
  const [answers,setAnswers]=useState(initial);
  const [filesByQuestion,setFilesByQuestion]=useState(()=>Object.fromEntries(questions.map(q=>[q.id,[]])));
  const [busy,setBusy]=useState("");
  const [submitError,setSubmitError]=useState("");
  if(!request)return null;
  const fileCount=Object.values(filesByQuestion).reduce((sum,items)=>sum+(items?.length||0),0);
  async function attach(questionId){
    if(fileCount>=100)return;
    setBusy(questionId);
    try{
      const picked=await pickFiles?.();if(!picked?.length)return;
      setFilesByQuestion(prev=>{
        const room=Math.max(0,100-Object.values(prev).reduce((sum,items)=>sum+(items?.length||0),0));
        const next=[...new Set([...(prev[questionId]||[]),...picked.slice(0,room)])];
        return {...prev,[questionId]:next};
      });
    }finally{setBusy("")}
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
  return <div className="modal-backdrop"><div className="question-modal">
    <div className="modal-head"><div><HelpCircle size={18}/><strong>Agent needs input</strong></div><button onClick={onCancel}><X size={17}/></button></div>
    {questions.map(q=><div className="question-block" key={q.id}><label>{q.header&&<small>{q.header}</small>}<strong>{q.question}</strong></label>
      {q.options?.length>0&&<div className="question-options">{q.options.map(opt=><button className={answers[q.id]?.includes(opt.label)?"active":""} key={opt.label} onClick={()=>chooseOption(q,opt.label)}>{opt.label}<span>{opt.description}</span></button>)}</div>}
      <input placeholder="Custom answer…" value={answers[q.id]?.find(a=>!q.options?.some(o=>o.label===a))||""} onChange={e=>setCustom(q,e.target.value)}/>
      <div className="question-files">{(filesByQuestion[q.id]||[]).map(path=><span key={path}>{path.split(/[\\/]/).pop()}<button type="button" title="Remove attachment" onClick={()=>setFilesByQuestion(prev=>({...prev,[q.id]:(prev[q.id]||[]).filter(item=>item!==path)}))}><X size={10}/></button></span>)}<button type="button" onClick={()=>attach(q.id)} disabled={busy===q.id||fileCount>=100}><Paperclip size={12}/> {busy===q.id?"Choosing…":"Attach files"}</button></div>
    </div>)}
    {submitError&&<div className="inline-error">{submitError}</div>}
    <div className="modal-actions"><span>{fileCount?`${fileCount}/100 attached`:""}</span><button onClick={onCancel}>Cancel</button><button className="primary" disabled={busy==="submit"} onClick={async()=>{setSubmitError("");setBusy("submit");try{await onSubmit(answers,filesByQuestion)}catch(error){setSubmitError(error?.message||String(error))}finally{setBusy("")}}}>{busy==="submit"?"Submitting…":"Submit"}</button></div>
  </div></div>;
}
