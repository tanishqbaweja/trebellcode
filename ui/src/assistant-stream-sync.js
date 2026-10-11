// How a live assistant delta applies to the reply text already on screen. state.chars counts the characters shown since the
// live text was last cleared; state.desynced means a frame was missed or repeated, so later frames cannot be placed.
// A delta without an offset (Codex, Claude Code, the ACP harnesses, a Native reply sent whole) is appended as it always was.
// A Native draft delta says where it starts: it is appended only when that is where the shown text ends. Offset 0 starts a
// new draft over whatever is shown, so a missed reset or a stale count heals itself; any other mismatch is set aside until
// the next reset, new draft or completed message.
export const EMPTY_ASSISTANT_STREAM=Object.freeze({chars:0,desynced:false});

export function assistantStreamDelta(state=EMPTY_ASSISTANT_STREAM,delta="",offset=undefined){
  const text=String(delta||""),chars=Number(state?.chars)||0,desynced=state?.desynced===true;
  if(offset==null)return {restart:false,append:text,state:{chars:chars+text.length,desynced}};
  const start=Number(offset);
  if(!Number.isSafeInteger(start)||start<0)return {restart:false,append:"",state:{chars,desynced:true}};
  if(start===0&&(chars!==0||desynced))return {restart:true,append:text,state:{chars:text.length,desynced:false}};
  if(desynced||start!==chars)return {restart:false,append:"",state:{chars,desynced:true}};
  return {restart:false,append:text,state:{chars:chars+text.length,desynced:false}};
}
