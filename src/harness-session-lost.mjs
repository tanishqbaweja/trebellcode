// A harness that no longer has the conversation a thread saved: Claude Code's transcript is gone, OpenCode answers its session
// with 404, an ACP agent refuses session/load or session/resume. The session classes throw it only for that, so the relay can
// tell a lost conversation (it continues the thread in one fresh session) from a harness that
// cannot run at all (not installed, signed out, a process that did not start), which fails as it is. The relay never reads a
// harness's error text to decide.
export class HarnessSessionLostError extends Error{
  constructor(message,{harness=null,sessionId=null,code=undefined,cause=undefined}={}){
    super(message,cause===undefined?undefined:{cause});
    this.name="HarnessSessionLostError";this.harness=harness;this.sessionId=sessionId==null?null:String(sessionId);
    // The harness's own error code, as the error carried before (an ACP error's code).
    if(code!==undefined)this.code=code;
  }
}

export function isHarnessSessionLost(error){return error instanceof HarnessSessionLostError}
