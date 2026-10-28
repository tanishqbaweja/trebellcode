import React,{useRef} from "react";
import { ShieldCheck } from "lucide-react";
import { answeringClick } from "../approval-utils.js";
import { ignorePressRest } from "./ThreadSidebar.jsx";

// The card of a command, file change or access a harness asks to approve, in the conversation and on the Runtime tab. Nothing on the
// first screen asks anything, so App loads it at idle right after the first paint (idle-parts.js, B11), before a request can come
// from a thread the person opened: from then on it shows the moment the request comes. One that comes before then (a harness that asks
// its waiting request again of the page that just opened) waits for that load, as a question waits for its dialog; the harness waits
// on the answer either way.
// threadLabel names the task that asked when it is not the open thread, so nobody approves a command without knowing whose it is.
// A card answers once, and only to a click aimed at it: the second click of a double click (its click count is 2, or it lands where
// the first did, answeringClick) was aimed at the card before, which the first click answered, and the next card has come up under
// the pointer. The rest of that press does nothing either (ignorePressRest), as on an app request's buttons: with no card after it,
// the second click lands on the conversation, which slides under the pointer, and would select a word there.
export default function ApprovalCard({request,onResolve,threadLabel=""}){
  const answered=useRef(false);
  if(!request)return null;
  const answer=(event,decision)=>{if(answered.current||event.detail>1||!answeringClick(event))return;answered.current=true;Promise.resolve(onResolve(request,decision)).then(result=>{if(!result)answered.current=false})};
  const p=request.params||{};
  const permissions=request.method==="item/permissions/requestApproval";
  const network=permissions?p.permissions?.network:null;const fileSystem=permissions?p.permissions?.fileSystem:null;
  const title=permissions?"Additional access requested":request.method.includes("fileChange")||request.method==="applyPatchApproval"?"File changes need approval":p.networkApprovalContext?.host?"Network access needs approval":"Command needs approval";
  // The command is shown even when the harness gives a reason, so nobody approves "Run the tests" without seeing what runs. A file
  // change lists the files it touches, which the server finds for Codex's request (trebellFileChanges), with or without a reason.
  const commandText=Array.isArray(p.command)?p.command.map(part=>String(part)).join(" "):typeof p.command==="string"?p.command:"";
  const files=Array.isArray(p.trebellFileChanges)?p.trebellFileChanges:[];
  const networkTarget=p.networkApprovalContext?.host?`${p.networkApprovalContext.protocol||"network"}://${p.networkApprovalContext.host}`:"";
  const detail=permissions?[network&&"Network access",fileSystem&&"Filesystem access"].filter(Boolean).join(" + "):(networkTarget||p.reason||commandText||p.path||(files.length?"":request.method));
  const showCommand=!permissions&&Boolean(commandText.trim())&&detail!==commandText;
  const approvalOptions=Array.isArray(p.approvalOptions)?p.approvalOptions.filter(option=>option&&typeof option.decision==="string"&&option.label):[];
  return <div className="approval-card"><div className="card-title"><ShieldCheck size={16}/><strong>{title}</strong></div>{threadLabel&&<p className="approval-thread" data-testid="approval-thread">Waiting in {threadLabel}</p>}{(detail||!files.length)&&<p>{detail||p.reason||request.method}</p>}{showCommand&&<pre className="approval-command" data-testid="approval-command"><code>{commandText}</code></pre>}{files.length>0&&<pre className="approval-command" data-testid="approval-files"><code>{files.map(file=>file.movePath?"Move "+file.path+" to "+file.movePath:({add:"Add",delete:"Delete"}[file.kind]||"Edit")+" "+file.path).join("\n")+(p.trebellFileChangesMore>0?"\n…and "+p.trebellFileChangesMore+" more file"+(p.trebellFileChangesMore>1?"s":""):"")}</code></pre>}{permissions&&<pre className="approval-permissions">{JSON.stringify(p.permissions||{},null,2)}</pre>}{approvalOptions.filter(option=>option.warning).map(option=><small key={"warning-"+option.decision}>{option.label}: {option.warning}</small>)}<div className="approval-actions" onClick={event=>{if(event.target.closest("button"))ignorePressRest(!event.detail)}}>{approvalOptions.length
    // An ACP harness's own choices, in its order and wording (T3 grokApprovalOptions / antigravityApprovalOptions).
    ?approvalOptions.map(option=><button key={option.decision} className={option.decision==="accept"?"approve":undefined} onClick={event=>answer(event,option.decision)}>{option.label}</button>)
    // A Codex card's Allow session covers every later command, or file change, of its thread's session (trebellSessionScope).
    :<><button onClick={event=>answer(event,"decline")}>Deny</button><button onClick={event=>answer(event,"acceptForSession")}>{{command:"Allow commands this session",fileChange:"Allow edits this session"}[p.trebellSessionScope]||"Allow session"}</button><button className="approve" onClick={event=>answer(event,"accept")}>Allow once</button></>}</div></div>;
}
