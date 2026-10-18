export function approvalResponse(request,decision){
  if(request?.method==="item/permissions/requestApproval")return {permissions:decision==="decline"?{}:(request.params?.permissions||{}),scope:decision==="acceptForSession"?"session":"turn"};
  if(request?.method==="applyPatchApproval"||request?.method==="execCommandApproval")return {decision:decision==="decline"?{denied:{rejection:"rejected by user"}}:decision==="acceptForSession"?"approved_for_session":"approved"};
  return {decision};
}

// The second click of a double click whose first answered a request lands on the next request, which comes up in its place under the
// pointer. The browser counts it a click of its own (detail 1) once the pointer moved a few pixels between the clicks, so the next
// request takes no click near the one that answered (24 px) within the double-click time (500 ms, the Windows default). A key press
// clicks with detail 0 and is left alone: the next request's controls do not have the focus.
let lastAnswer=null;
export function answeringClick(event){
  if(!answerableClick(event))return false;
  if(event?.detail>0)lastAnswer={x:event.clientX,y:event.clientY,at:event.timeStamp};
  return true;
}
// Whether a click may answer, noting nothing: for a control that can refuse its click without answering, as a form's Submit does
// with a required field left empty. It notes the click with answeringClick once it answers, so a click it refused keeps no click
// after it from answering (the person fills the field in and presses Submit again at once).
export function answerableClick(event){
  if(!(event?.detail>0))return true;
  return !(lastAnswer&&event.timeStamp-lastAnswer.at<500&&Math.hypot(event.clientX-lastAnswer.x,event.clientY-lastAnswer.y)<24);
}
