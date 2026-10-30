// Codex works toward an active goal with turns it starts itself, the next one as soon as one ends. A goal still active once Codex
// has started no turn within CODEX_GOAL_CONTINUATION_GRACE_MS of a completed one (the model ended its work without meeting the goal)
// would read Active with nothing running, so it is paused. A very
// slow next turn could be paused too. timers: where setTimeout and clearTimeout are looked up as each wait starts, so a
// test's fake clock takes them.
export const CODEX_GOAL_CONTINUATION_GRACE_MS=5_000;

export function createCodexGoalContinuations({graceMs=CODEX_GOAL_CONTINUATION_GRACE_MS,timers=globalThis,expire=()=>{}}={}){
  // The threads waited for ({timer, context}), and those whose wait ended with expire answering false (nothing there to pause the goal
  // on), with that wait's context until take() or cancel().
  const waiting=new Map(),owed=new Map();
  function cancel(threadId){
    const id=String(threadId||""),wait=waiting.get(id),was=owed.delete(id);if(!wait)return was;
    waiting.delete(id);timers.clearTimeout(wait.timer);return true;
  }
  // A wait's context.windows, when it has them, gathers each window that can make the pause: one that hears of the same turn's end
  // too, or shows the thread while it waits.
  function follow(threadId,...windows){waiting.get(String(threadId||""))?.context.windows?.push(...windows)}
  return {
    // A thread's turn completed with its goal active: Codex is to start the goal's next turn within the grace. context goes to expire.
    turnCompleted(threadId,context={}){
      const id=String(threadId||"");if(!id)return;
      if(context.turnId!=null&&waiting.get(id)?.context.turnId===context.turnId){follow(id,...(context.windows||[]));return}
      cancel(id);
      const wait={context};wait.timer=timers.setTimeout(()=>{if(waiting.get(id)!==wait)return;waiting.delete(id);if(expire(id,context)===false)owed.set(id,context)},graceMs);
      wait.timer?.unref?.();waiting.set(id,wait);
    },
    follow,
    // The context of the pause owed for the thread, which the caller makes now: null when none is.
    take(threadId){const id=String(threadId||""),context=owed.get(id)||null;owed.delete(id);return context},
    // A turn started in the thread, its goal stopped being active, or the thread ended: nothing is waited for, nor owed.
    cancel,
    waiting:threadId=>waiting.has(String(threadId||"")),
    clear(){for(const wait of waiting.values())timers.clearTimeout(wait.timer);waiting.clear();owed.clear()},
  };
}
