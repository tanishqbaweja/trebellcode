import React,{useRef,useState} from "react";
import { CheckCircle2, MessageSquare, Send, X, XCircle } from "lucide-react";

export default function PullRequestComposer({canComment=true,canReview=false,canRequestChanges=false,busy=false,onComment,onReview}){
  const [open,setOpen]=useState(false);
  const [mode,setMode]=useState(canComment?"comment":"review");
  const [comment,setComment]=useState("");
  const [review,setReview]=useState("");
  const [verdict,setVerdict]=useState("APPROVE");
  const textareaRef=useRef(null);
  const hasReview=Boolean(canReview);
  const hasComment=Boolean(canComment);
  if(!hasComment&&!hasReview)return null;

  function openComposer(){
    setMode(hasComment?"comment":"review");
    setOpen(true);
    setTimeout(()=>textareaRef.current?.focus(),0);
  }
  async function submitComment(){
    const body=comment.trim();if(!body||busy)return;
    const ok=await onComment?.(body);if(ok===false)return;setComment("");setOpen(false);
  }
  async function submitReview(){
    const body=review.trim();if(busy)return;
    if(verdict==="REQUEST_CHANGES"&&!body)return;
    const ok=await onReview?.({event:verdict,body});if(ok===false)return;setReview("");setOpen(false);
  }

  return <div className="pr-composer-wrap">
    <button type="button" className="pr-composer-trigger" onClick={openComposer} disabled={busy}><MessageSquare size={12}/>{hasReview?"Comment / review":"Comment"}</button>
    {open&&<div className="pr-composer" data-testid="pr-composer">
      <div className="pr-composer-head">
        {hasComment&&hasReview?<div className="pr-composer-modes" role="tablist" aria-label="Pull request composer mode">
          <button type="button" role="tab" aria-selected={mode==="comment"} className={mode==="comment"?"active":""} onClick={()=>setMode("comment")}>Comment</button>
          <button type="button" role="tab" aria-selected={mode==="review"} className={mode==="review"?"active":""} onClick={()=>setMode("review")}>Review</button>
        </div>:<strong>{mode==="review"?"Review pull request":"Comment on pull request"}</strong>}
        <button type="button" className="pr-composer-close" aria-label="Close pull request composer" onClick={()=>setOpen(false)}><X size={12}/></button>
      </div>
      {mode==="comment"?<div className="pr-composer-form">
        <textarea ref={textareaRef} aria-label="Pull request comment" value={comment} onChange={event=>setComment(event.target.value)} placeholder="Leave a comment…" onKeyDown={event=>{if(event.key==="Enter"&&(event.ctrlKey||event.metaKey)&&!event.shiftKey){event.preventDefault();submitComment()}}}/>
        <div className="pr-composer-submit"><span>Ctrl/Cmd+Enter to post</span><button type="button" disabled={!comment.trim()||busy} onClick={submitComment}><Send size={11}/>{busy?"Posting…":"Comment"}</button></div>
      </div>:<div className="pr-composer-form">
        <textarea ref={textareaRef} aria-label="Review summary" value={review} onChange={event=>setReview(event.target.value)} placeholder={verdict==="REQUEST_CHANGES"?"Explain what needs to change…":"Optional review summary…"}/>
        <div className="pr-composer-submit">
          <select aria-label="Review verdict" value={verdict} onChange={event=>setVerdict(event.target.value)}>
            <option value="APPROVE">Approve</option>
            {canRequestChanges&&<option value="REQUEST_CHANGES">Request changes</option>}
          </select>
          <button type="button" disabled={busy||(verdict==="REQUEST_CHANGES"&&!review.trim())} onClick={submitReview}>{verdict==="REQUEST_CHANGES"?<XCircle size={11}/>:<CheckCircle2 size={11}/>} {busy?"Submitting…":"Submit review"}</button>
        </div>
      </div>}
    </div>}
  </div>;
}
