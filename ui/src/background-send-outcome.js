// What came of a send that runs in the background, loaded once that is known (App.jsx sendInBackground and sendModelFanout): no
// other send needs it. A launch that failed has its draft stashed for a retry, marked to be checked first when its request may
// already have started; a draft no stash could keep goes back to the composer. The outcome shows in the view (addEvents) and as a
// desktop notice.

// A multi-model send once each of its launches has answered.
export async function settleModelFanout({results,fanout,draft,saveFailureStash,restoreFailedDraft,desktopNotify,addEvents}){
  const started=results.filter(item=>item.ok);const failed=results.filter(item=>!item.ok);const uncertain=failed.filter(item=>item.error?.trebellUncertain);
  const summary=[];
  if(started.length)summary.push({id:"fanout-started-"+Date.now(),kind:"tool",title:`Started ${started.length}/${fanout.length} model${started.length===1?"":"s"} in isolated worktrees`,status:"done",raw:{models:started.map(item=>item.modelId),threads:started.map(item=>item.result?.thread?.id).filter(Boolean)}});
  let stashSaved=0;const stashErrors=[];
  for(const item of failed){
    const guard=item.error?.trebellUncertain;const prefix=guard?`[CHECK EXISTING THREAD BEFORE RETRY · ${item.modelId}] `:`[${item.modelId}] `;
    const stash=await saveFailureStash({...draft,text:prefix+draft.text});
    if(stash.ok)stashSaved++;else stashErrors.push(`${item.modelId}: ${stash.error}`);
  }
  if(stashErrors.length)restoreFailedDraft(draft);
  if(failed.length){
    const detail=failed.map(item=>{const guard=item.error?.trebellUncertain;return `${item.modelId}: ${item.error?.message||item.error}${guard?.threadId?` · possible thread ${guard.threadId}`:guard?" · request may already have started":""}`}).join(" · ");
    const stashNote=stashErrors.length
      ?`${stashSaved}/${failed.length} failed draft${failed.length===1?"":"s"} stashed; ${stashErrors.length} restored to the composer because saving failed`
      :`${stashSaved} failed draft${stashSaved===1?" was":"s were"} stashed for retry`;
    summary.push({id:"fanout-error-"+Date.now(),kind:"error",title:uncertain.length?`${failed.length} model run${failed.length===1?" needs":"s need"} attention; ${uncertain.length} may already have started · ${stashNote}`:`${failed.length}/${fanout.length} model runs failed · ${stashNote}`,status:"done",raw:{detail,stashErrors}});
    desktopNotify("Multi-model run needs attention",uncertain.length?`${uncertain.length} request${uncertain.length===1?" may":"s may"} already have started. ${stashNote}.`:`${stashNote}.`);
  }else desktopNotify("Multi-model run started",`${started.length} background threads are running in isolated worktrees.`);
  if(summary.length)addEvents(summary);
}

// A background task whose launch failed.
export async function settleFailedBackgroundSend({error,draft,saveFailureStash,restoreFailedDraft,desktopNotify,addEvents}){
  const guard=error?.trebellUncertain;
  const guardedDraft=guard?{...draft,text:"[CHECK EXISTING THREAD BEFORE RETRY] "+draft.text}:draft;
  const possibleThread=guard?.threadId?" Possible thread: "+guard.threadId+".":"";
  const stash=await saveFailureStash(guardedDraft);
  if(stash.ok){
    const title=guard
      ?"Background may already be running."+possibleThread+" Check for an existing thread before retrying; draft stashed with warning."
      :"Background task failed; draft was stashed: "+(error.message||String(error));
    addEvents([{id:"background-error-"+Date.now(),kind:"error",title,status:"done",raw:{uncertain:guard||null,error:error?.message||String(error)}}]);
    desktopNotify(guard?"Background task needs attention":"Background task failed",guard?"Check for an existing background thread before retrying. The draft was stashed with a warning.":"The draft was saved to Trebell stash.");
  }else{
    restoreFailedDraft(draft);
    const title=guard
      ?"Background may already be running."+possibleThread+" stash save also failed: "+stash.error+". Draft restored; check for an existing thread before retrying."
      :"Background task failed; stash save also failed, so the draft was restored to the composer: "+(error.message||String(error))+" · Stash error: "+stash.error;
    addEvents([{id:"background-error-"+Date.now(),kind:"error",title,status:"done",raw:{taskError:error?.message||String(error),stashError:stash.error,uncertain:guard||null}}]);
    desktopNotify(guard?"Background task needs attention":"Background task failed",guard?"The draft was restored. Check for an existing background thread before retrying.":"The draft could not be saved to Trebell stash, so it was restored to the composer.");
  }
}
