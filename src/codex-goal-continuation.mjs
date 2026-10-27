// Codex works toward an active goal with turns it starts itself, the next one as soon as one ends. A goal still active once Codex
// has started no turn within CODEX_GOAL_CONTINUATION_GRACE_MS of a completed one (the model ended its work without meeting the goal)
// would read Active with nothing running, so it is paused (T3 cc0b86ddf pauseUncontinuedGoal, CODEX_GOAL_CONTINUATION_GRACE). A very
// slow next turn could be paused too, as T3 accepts. timers: where setTimeout and clearTimeout are looked up as each wait starts, so a
// test's fake clock takes them.
export const CODEX_GOAL_CONTINUATION_GRACE_MS=5_000;

export function createCodexGoalContinuations({graceMs=CODEX_GOAL_CONTINUATION_GRACE_MS,timers=globalThis,expire=()=>{}}={}){
  const waiting=new Map();
  function cancel(threadId){
    const id=String(threadId||""),timer=waiting.get(id);if(timer===undefined)return false;
    waiting.delete(id);timers.clearTimeout(timer);return true;
  }
  return {
    // A thread's turn completed with its goal active: Codex is to start the goal's next turn within the grace. context goes to expire.
    turnCompleted(threadId,context={}){
      const id=String(threadId||"");if(!id)return;cancel(id);
      const timer=timers.setTimeout(()=>{if(waiting.get(id)!==timer)return;waiting.delete(id);expire(id,context)},graceMs);
      timer?.unref?.();waiting.set(id,timer);
    },
    // A turn started in the thread, its goal stopped being active, or the thread ended: nothing is waited for.
    cancel,
    waiting:threadId=>waiting.has(String(threadId||"")),
    clear(){for(const timer of waiting.values())timers.clearTimeout(timer);waiting.clear()},
  };
}
