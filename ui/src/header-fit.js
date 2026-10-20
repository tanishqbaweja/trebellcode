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
// data-fit 6 with one more action folded at each level. From level 3 on the crumb gets its shortened name back (data-crumb
// "short", as level 2 shows it) wherever the title keeps its room beside it: a later level often frees more than the title needs
// (the theme and palette buttons take 68px), and the crumb kept only its icon beside a whole title. At level 3 its name would be
// level 2 again, so it is tried at level 4: the theme and palette buttons step aside before the crumb's name does. A title little
// longer than the readable width has its room only whole, wherever a level gives it that: cut to the readable width it would lose
// only its last word, which can be all that tells it from the thread beside it ("Repo task one" beside "Repo task two").
export const HEADER_FIT_LEVELS=6;
export const TITLE_READABLE_WIDTH=80;
// How much longer than the readable width a title can be and still have its room only whole.
export const TITLE_SHORT_MARGIN=40;
// The level from which the project crumb keeps only its icon.
export const CRUMB_ICON_LEVEL=3;
// The foldable actions by their data-fold, the first to fold first. Each one's row control and its More actions menu item
// carry the same data-fold; a folded one is marked data-folded, which hides it from the row and shows it in the menu.
export const HEADER_FOLD_ORDER=["goal","terminal","review","script","open-in","source"];

// Whether the title shows enough of itself: all of it, or at least the readable width of a title longer than that by more
// than TITLE_SHORT_MARGIN.
export function titleHasRoom({clientWidth=0,scrollWidth=0}={},readable=TITLE_READABLE_WIDTH){
  return clientWidth+1>=(scrollWidth>readable+TITLE_SHORT_MARGIN?readable:scrollWidth);
}
// Whether the title shows at least the readable width (or all of itself): what a short title keeps where no level shows it whole.
export function titleReadable({clientWidth=0,scrollWidth=0}={},readable=TITLE_READABLE_WIDTH){
  return clientWidth+1>=Math.min(scrollWidth,readable);
}

// The first level at which the title has room; when none gives it room, the first at which it is readable, else the last level:
// apply(level) sets a level, and titleRoom() and readable() measure the header after it.
export function fitLevel(apply,titleRoom,levels=HEADER_FIT_LEVELS,readable=()=>false){
  let first=-1;
  for(let level=0;level<levels;level++){apply(level);if(titleRoom())return level;if(first<0&&readable())first=level}
  if(first<0)return levels-1;
  apply(first);return first;
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
    // Each level is measured with the crumb it draws; the crumb's shortened name is tried once the level is found, at level 3 with
    // the theme and palette buttons set aside as at level 4 (level 3 with it would be level 2 again, where the title had no room).
    if(header.dataset.crumb)delete header.dataset.crumb;
    const level=fitLevel(apply,()=>!title||titleHasRoom(title),HEADER_FIT_LEVELS+foldable.length,()=>titleReadable(title));
    if(title&&level>=CRUMB_ICON_LEVEL){apply(Math.max(level,CRUMB_ICON_LEVEL+1));header.dataset.crumb="short";if(!titleHasRoom(title)){delete header.dataset.crumb;apply(level)}}
  };
  fit();
  const resize=typeof ResizeObserver==="function"?new ResizeObserver(fit):null;resize?.observe(header);
  // Only text and elements count: the level and the folds are attributes, so writing them never re-runs the fit.
  const contents=typeof MutationObserver==="function"?new MutationObserver(fit):null;contents?.observe(header,{childList:true,subtree:true,characterData:true});
  const fonts=typeof document!=="undefined"?document.fonts:null;fonts?.addEventListener?.("loadingdone",fit);
  return ()=>{resize?.disconnect();contents?.disconnect();fonts?.removeEventListener?.("loadingdone",fit)};
}
