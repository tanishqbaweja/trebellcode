import React from "react";
import { Search } from "lucide-react";

// The find bar of the open thread (Ctrl+F). Nothing before a find needs it, so App loads it at idle after the first paint
// (idle-parts.js, B11).
// covered: another thread's opening state is up. The bar belongs to the thread being left, so it hides without closing (a failed open
// brings it back with its query) and cannot be used meanwhile. Escape closes it from its field and from its buttons alike.
// Previous and Next match only say they are off (aria-disabled), at the first or the last match and while more matches load, so the
// keyboard stays on the one in use: a press there does nothing (stepThreadFind), Space never types into the field, and Escape from
// it closes the bar. One that is off is out of Tab's order, as a disabled button is, so Tab from the field reaches one that steps.
export default function ThreadFindBar({state,covered=false,inputRef,barRef,onQuery,onPrevious,onNext,onClose}){
  if(!state.open)return null;
  const previousOff=state.loading||state.index<=0,nextOff=state.loading||!state.results.length||(state.index>=state.results.length-1&&!state.nextCursor);
  const current=state.index>=0?state.results[state.index]:null;
  const range=current?.snippetMatchRange||{};const start=Math.max(0,Number(range.start)||0),end=Math.max(start,Number(range.end)||0);
  const snippet=String(current?.snippet||"");
  return <div className={"thread-find-bar"+(covered?" opening-covered":"")} data-testid="thread-find-bar" ref={barRef} inert={covered} onKeyDown={event=>{if(event.key==="Escape"&&!event.defaultPrevented){event.preventDefault();onClose()}}}>
    <Search size={13}/><input ref={inputRef} data-testid="thread-find-input" value={state.query} onChange={event=>onQuery(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();event.shiftKey?onPrevious():onNext()}}} placeholder="Find in this thread"/>
    <span className="thread-find-count">{state.loading?"Searching…":state.error?"Error":state.results.length?`${state.index+1} / ${state.results.length}${state.nextCursor?"+":""}`:state.query.trim().length>=2?"No matches":""}</span>
    <button type="button" onClick={onPrevious} aria-disabled={previousOff} tabIndex={previousOff?-1:undefined} aria-label="Previous match">↑</button><button type="button" onClick={onNext} aria-disabled={nextOff} tabIndex={nextOff?-1:undefined} aria-label="Next match">↓</button><button type="button" onClick={onClose} aria-label="Close find">×</button>
    {(current||state.error)&&<div className="thread-find-snippet">{state.error?state.error:<>{snippet.slice(0,start)}<mark>{snippet.slice(start,end)}</mark>{snippet.slice(end)}</>}</div>}
  </div>;
}
