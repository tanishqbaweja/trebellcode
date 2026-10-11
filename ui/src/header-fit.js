// The workspace header keeps the open thread named. The project crumb gives way first (the stylesheet shrinks it before the
// title); when the title would still be cut below a readable width, the labelled actions (branch, Review, Stop, the project
// action and the Open-in picker) go icon-only, then the project crumb keeps only its icon while several linked pull requests
// fold into the first one's chip, then the theme and command palette buttons step aside (the palette, Settings and the sidebar's
// "Search or jump to" reach both), and last the pull request chip keeps only its icon and count (its tooltip names them all).
// The header is measured, so any branch name, project action, number of linked pull requests or window width is covered, not
// only the widths a breakpoint was tuned for. Levels: 0 everything labelled, 1 labelled actions icon-only, 2 the project crumb
// icon-only and one pull request chip, 3 also without the theme and palette buttons, 4 the pull request chip without numbers.
export const HEADER_FIT_LEVELS=5;
export const TITLE_READABLE_WIDTH=80;

// Whether the title shows enough of itself: all of it, or at least the readable width.
export function titleHasRoom({clientWidth=0,scrollWidth=0}={},readable=TITLE_READABLE_WIDTH){
  return clientWidth+1>=Math.min(scrollWidth,readable);
}

// The first level at which the title has room (the last level when none gives it room): apply(level) sets a level and
// titleRoom() measures the header after it.
export function fitLevel(apply,titleRoom,levels=HEADER_FIT_LEVELS){
  for(let level=0;level<levels-1;level++){apply(level);if(titleRoom())return level}
  apply(levels-1);return levels-1;
}

// Keeps a header element fitted as it resizes (window, sidebar or inspector) and as its contents change (a thread opens, a turn
// starts and Stop appears, the branch changes, the Open-in picker finds its editors), and once web fonts finish loading. The
// level is written to data-fit; the returned function stops watching.
export function observeHeaderFit(header,{titleSelector=".thread-title-button strong"}={}){
  if(!header)return ()=>{};
  const apply=level=>{const value=String(level);if(header.dataset.fit!==value)header.dataset.fit=value};
  const fit=()=>{const title=header.querySelector(titleSelector);fitLevel(apply,()=>!title||titleHasRoom(title))};
  fit();
  const resize=typeof ResizeObserver==="function"?new ResizeObserver(fit):null;resize?.observe(header);
  // Only text and elements count: the level itself is an attribute, so writing it never re-runs the fit.
  const contents=typeof MutationObserver==="function"?new MutationObserver(fit):null;contents?.observe(header,{childList:true,subtree:true,characterData:true});
  const fonts=typeof document!=="undefined"?document.fonts:null;fonts?.addEventListener?.("loadingdone",fit);
  return ()=>{resize?.disconnect();contents?.disconnect();fonts?.removeEventListener?.("loadingdone",fit)};
}
