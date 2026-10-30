// A Codex turn's token usage across all its model requests. Each thread/tokenUsage/updated carries the thread's running total
// (total) and the newest request's usage (last), and a turn that calls tools makes a request after each, so recording last kept only
// one request of the turn. A running turn counts the growth of the thread's total instead: last when there is no earlier total,
// or when a counter went down (the thread loaded again, or compacted),
// and an update for a turn that is not running only moves the thread's total along. The growth counts only from a total of the same
// turn: a thread runs one turn at a time, so two totals of one turn hold nothing between them but its own requests, while the total
// before a turn's first one can be from before a gap in what this server got (every window that showed the thread closed, and Codex
// ran on), and then holds the requests of turns that ran in it too. A turn's first update counts its own request (last), which in an
// unbroken stream is the same as the growth.
const FIELDS=["totalTokens","inputTokens","cachedInputTokens","cacheWriteInputTokens","outputTokens","reasoningOutputTokens"];
const counts=usage=>Object.fromEntries(FIELDS.map(key=>[key,Math.max(0,Number(usage?.[key])||0)]));

export function createCodexTurnUsage({threadLimit=500,seenLimit=64}={}){
  // By thread: the last total seen and the turn whose update it came with, the totals seen lately, and the running turn's sum.
  const threads=new Map();
  return {
    // The usage so far of the running turn the update counts toward (Codex counts cache reads and writes inside input tokens, and
    // reasoning inside output), or null when it counts toward none.
    update({threadId,turnId,tokenUsage,running=false}={}){
      const id=String(threadId||""),turn=String(turnId||"");if(!id||!turn||!tokenUsage?.total)return null;
      const thread=threads.get(id)||{baseline:null,baselineTurn:null,seen:[],turnId:null,sum:null};threads.delete(id);threads.set(id,thread);
      while(threads.size>threadLimit)threads.delete(threads.keys().next().value);
      // Every window that shows the thread gets each update on its own connection, in any order: a total seen already counted.
      const current=counts(tokenUsage.total),key=FIELDS.map(field=>current[field]).join(",");if(thread.seen.includes(key))return null;
      thread.seen.push(key);if(thread.seen.length>seenLimit)thread.seen.shift();
      const previous=thread.baselineTurn===turn?thread.baseline:null;thread.baseline=current;thread.baselineTurn=turn;
      if(!running){if(thread.turnId===turn)thread.turnId=thread.sum=null;return null}
      const delta=!previous||FIELDS.some(field=>current[field]<previous[field])?counts(tokenUsage.last):Object.fromEntries(FIELDS.map(field=>[field,current[field]-previous[field]]));
      if(thread.turnId!==turn){thread.turnId=turn;thread.sum=counts({})}
      for(const field of FIELDS)thread.sum[field]+=delta[field];
      const sum=thread.sum;if(FIELDS.every(field=>!sum[field]))return null;
      return {...sum,cachedInputTokens:Math.min(sum.inputTokens,sum.cachedInputTokens),cacheWriteInputTokens:Math.min(sum.inputTokens,sum.cacheWriteInputTokens),reasoningOutputTokens:Math.min(sum.outputTokens,sum.reasoningOutputTokens)};
    },
  };
}
