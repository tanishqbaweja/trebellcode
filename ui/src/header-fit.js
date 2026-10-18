// The workspace header keeps the open thread named. The project crumb gives way first (the stylesheet shrinks it before the
// title); when the title would still be cut below a readable width, the labelled actions (branch, Review, Stop, the project
// action and the Open-in picker) go icon-only, then several linked pull requests fold into the first one's chip while the
// project crumb may shrink to its first letter, then the project crumb keeps only its icon (the fold alone often gives the title
// its room, and the crumb then keeps a shortened name beside it), then the theme and command palette buttons step aside (the
// palette, Settings and the sidebar's "Search or jump to" reach both), then the pull request chip keeps only its icon and count
// (its tooltip names them all), and last the actions fold into the More actions menu one at a time, from the end of the row,
// until the title has room: beside the desktop window's minimum width and a wide inspector, a row of icons alone leaves the
// title no room, and folding no more than the title needs keeps the rest where they were (a turn's Stop button moves an action
// or two, not the whole row). Stop and the inspector toggle never fold. The header is measured, so any branch name, project
// action, number of linked pull requests or window width is covered, not only the widths a breakpoint was tuned for. Levels:
// 0 everything labelled, 1 labelled actions icon-only, 2 one pull request chip and the project crumb down to its first letter,
// 3 the project crumb icon-only, 4 also without the theme and palette buttons, 5 the pull request chip without numbers, then
// data-fit 6 with one more action folded at each level. Past level 3 the crumb gets its shortened name back (data-crumb "short",
// as level 2 shows it) wherever the title keeps its room beside it: a later level often frees more than the title needs (the
// theme and palette buttons take 68px), and the crumb kept only its icon beside a whole title.
export const HEADER_FIT_LEVELS=6;
export const TITLE_READABLE_WIDTH=80;
// The level from which the project crumb keeps only its icon.
export const CRUMB_ICON_LEVEL=3;
// The foldable actions by their data-fold, the first to fold first. Each one's row control and its More actions menu item
// carry the same data-fold; a folded one is marked data-folded, which hides it from the row and shows it in the menu.
export const HEADER_FOLD_ORDER=["goal","terminal","review","script","open-in","source"];

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

// The actions the header holds that can fold (data-fold values, each counted once), in the order they fold.
export function foldableActions(ids,foldOrder=HEADER_FOLD_ORDER){
  const present=new Set(ids);
  return foldOrder.filter(id=>present.has(id));
}

// What a level shows: its data-fit and the actions folded at it. Past the last non-folding level each level folds one more.
export function fitState(level,foldable=[]){
  const folded=Math.max(0,Math.min(foldable.length,level-HEADER_FIT_LEVELS+1));
  return {fit:Math.min(level,HEADER_FIT_LEVELS),folded:foldable.slice(0,folded)};
}

// Keeps a header element fitted as it resizes (window, sidebar or inspector) and as its contents change (a thread opens, a turn
// starts and Stop appears, the branch changes, the Open-in picker finds its editors, the More actions menu opens), and once web
// fonts finish loading. The level is written to data-fit, the folded actions are marked data-folded and a crumb given its
// shortened name back is marked data-crumb; the returned function stops watching.
export function observeHeaderFit(header,{titleSelector=".thread-title-button strong",foldOrder=HEADER_FOLD_ORDER}={}){
  if(!header)return ()=>{};
  const fit=()=>{
    const title=header.querySelector(titleSelector),marked=[...(header.querySelectorAll?.("[data-fold]")||[])];
    const foldable=foldableActions(marked.map(node=>node.dataset.fold),foldOrder);
    const apply=level=>{
      const state=fitState(level,foldable),value=String(state.fit);
      if(header.dataset.fit!==value)header.dataset.fit=value;
      for(const node of marked){const folded=state.folded.includes(node.dataset.fold);if(node.hasAttribute("data-folded")!==folded)node.toggleAttribute("data-folded",folded)}
    };
    // Each level is measured with the crumb it draws; the crumb's shortened name is tried once the level is found. At level 3 it
    // would be level 2 again, where the title had no room.
    if(header.dataset.crumb)delete header.dataset.crumb;
    const level=fitLevel(apply,()=>!title||titleHasRoom(title),HEADER_FIT_LEVELS+foldable.length);
    if(title&&level>CRUMB_ICON_LEVEL){header.dataset.crumb="short";if(!titleHasRoom(title))delete header.dataset.crumb}
  };
  fit();
  const resize=typeof ResizeObserver==="function"?new ResizeObserver(fit):null;resize?.observe(header);
  // Only text and elements count: the level and the folds are attributes, so writing them never re-runs the fit.
  const contents=typeof MutationObserver==="function"?new MutationObserver(fit):null;contents?.observe(header,{childList:true,subtree:true,characterData:true});
  const fonts=typeof document!=="undefined"?document.fonts:null;fonts?.addEventListener?.("loadingdone",fit);
  return ()=>{resize?.disconnect();contents?.disconnect();fonts?.removeEventListener?.("loadingdone",fit)};
}
