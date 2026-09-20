import React,{useMemo,useState} from "react";
import { HelpCircle, Paperclip, X } from "lucide-react";

export default function QuestionModal({request,onSubmit,onCancel,pickFiles}){
  const questions=request?.params?.questions||[];
  const initial=useMemo(()=>Object.fromEntries(questions.map(q=>[q.id,[]])),[request]);
  const [answers,setAnswers]=useState(initial);
  const [files,setFiles]=useState([]);
  if(!request)return null;
  async function attach(){const picked=await pickFiles?.();if(picked?.length)setFiles(prev=>[...new Set([...prev,...picked])])}
  return <div className="modal-backdrop"><div className="question-modal">
    <div className="modal-head"><div><HelpCircle size={18}/><strong>Agent needs input</strong></div><button onClick={onCancel}><X size={17}/></button></div>
    {questions.map(q=><div className="question-block" key={q.id}><label>{q.header&&<small>{q.header}</small>}<strong>{q.question}</strong></label>
      {q.options?.length>0&&<div className="question-options">{q.options.map(opt=><button className={answers[q.id]?.includes(opt.label)?"active":""} key={opt.label} onClick={()=>setAnswers(prev=>({...prev,[q.id]:[opt.label]}))}>{opt.label}<span>{opt.description}</span></button>)}</div>}
      <input placeholder="Custom answer…" value={answers[q.id]?.find(a=>!q.options?.some(o=>o.label===a))||""} onChange={e=>setAnswers(prev=>({...prev,[q.id]:e.target.value?[e.target.value]:[]}))}/>
    </div>)}
    <div className="question-files">{files.map(path=><span key={path}>{path.split(/[\\/]/).pop()}</span>)}<button onClick={attach}><Paperclip size={12}/> Attach files</button></div>
    <div className="modal-actions"><button onClick={onCancel}>Cancel</button><button className="primary" onClick={()=>onSubmit(answers,files)}>Submit</button></div>
  </div></div>;
}
