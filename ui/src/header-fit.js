// The workspace header keeps the open thread named. The project crumb gives way first (the stylesheet shrinks it before the
// title); while the title is still cut, the labelled actions (branch, Review, Stop, the project action and the Open-in picker)
// go icon-only, then several linked pull requests fold into the first one's chip while the project crumb may shrink to its first
// letter, then the project crumb keeps only its icon, then the theme and command palette buttons step aside into the More actions
// menu, which shows from there on (its items switch the theme and open the palette), then the pull request chip keeps only its
// icon and count (its tooltip names them all), and last the actions fold into that menu one at a time,
// from the end of the row, until the title shows whole, or where no level shows it whole, until it has a readable width: beside the
// desktop window's minimum width and a wide inspector, a row of icons alone leaves the title no room, and folding no more than the
// title needs keeps the rest where they were (a turn's Stop button moves an action or two, not the whole row). Stop and the
// inspector toggle never fold. The header is measured, so any branch name, project action, number of linked pull requests or
// window width is covered, not only the widths a breakpoint was tuned for. Levels: 0 everything labelled, 1 labelled actions
// icon-only, 2 one pull request chip and the project crumb down to its first letter, 3 the project crumb icon-only, 4 the theme and
// palette buttons in the More actions menu, 5 the pull request chip without numbers, then data-fit 6 with one more action folded
// at each level.
// The title shows whole wherever a level gives it that, at the first such level, however long it is and however many actions that
// folds: cut to the readable width (80px) it can lose just the words that tell it from the thread beside it ("Repo task one"
// beside "Repo task two", or "Repo task number one" beside "Repo task number two"). Each level leaves the title at least the room
// of the one before and gives it more in a wider main column, so a title shown whole in one column is shown whole in every wider
// one, at the same level or an earlier one. Taking a level that folds only so far past the readable width (one action, or none)
// left a band of titles whole or cut by where the width fell, the wider window cutting what the narrower one showed: a fold leaves
// the title the readable width and less than an action's room more, and the next fold whole only up to that much longer ("Repo
// task one" read 80 of its 85px at 1140 beside the 460px inspector with one action folded, while 1136 folded two and showed it
// whole; folding one further, "Repo task number one" read 80 of its 135px at 1140 while 1136 folded three). Where no level shows
// it whole, the header takes the first level that leaves it the readable width, folding actions only as far as that needs; so
// where a title first shows whole, with every action folded, a column a pixel narrower keeps the readable width with fewer of
// them folded.
// From level 3 on the crumb gets its shortened name back (data-crumb "short", as level 2 shows it) wherever the title keeps what
// the level gave it beside it, all of itself or its readable width, so the crumb's name never cuts a title its icon leaves whole: a
// later level often frees more than the title needs, and the crumb kept only its icon beside a whole title. At level 3 its name
// would be level 2 again, so the header takes level 4 for it, the theme and palette buttons stepping aside into More actions for
// the crumb's name: a header whose title fits at level 3 shows level 4 with the crumb's shortened name, for a title of any length,
// and level 3 shows only where the room level 4 frees does not hold that name.
// Whole is measured to the fraction of a pixel, as the ellipsis shows as soon as the text overflows its box at all. clientWidth and
// scrollWidth are whole pixels: the fit read a box of 84.36px for 85.39px of text as 84 of 85 and counted that whole, so the pixel
// or two below where a level first shows the title whole read "Repo task o…" ("Repo task one" at 1144 beside the Git inspector and
// two linked pull requests with one action folded, while 1140 folded two and showed it whole; a box 0.03px short reads 85 of 85).
export const HEADER_FIT_LEVELS=6;
export const TITLE_READABLE_WIDTH=80;
// The level from which the project crumb keeps only its icon.
export const CRUMB_ICON_LEVEL=3;
// The foldable actions by their data-fold, the first to fold first. Each one's row control and its More actions menu item
// carry the same data-fold; a folded one is marked data-folded, which hides it from the row and shows it in the menu.
export const HEADER_FOLD_ORDER=["goal","terminal","review","script","open-in","source"];

// Whether the title shows all of itself: its text (whole) no wider than its box (shown).
export function titleWhole({shown=0,whole=0}={}){
  return shown>=whole;
}
// Whether the title shows at least the readable width (or all of itself): what a title keeps where no level shows it whole.
export function titleReadable({shown=0,whole=0}={},readable=TITLE_READABLE_WIDTH){
  return shown+1>=Math.min(whole,readable);
}
// The width of the title's content box (shown) and of its text (whole), to the fraction of a pixel. A Range keeps the text's
// whole width while the ellipsis cuts it.
export function titleWidths(title){
  const style=getComputedStyle(title),text=document.createRange();text.selectNodeContents(title);
  const edges=["paddingLeft","paddingRight","borderLeftWidth","borderRightWidth"].reduce((sum,key)=>sum+parseFloat(style[key]),0);
  return {shown:title.getBoundingClientRect().width-edges,whole:text.getBoundingClientRect().width};
}

// The level the header takes: the first at which the title shows whole, when one does, else the first at which it is readable,
// folding actions as far as that needs, else the last level. Each level leaves the title at least the room of the one before, so
// the last (every action folded, or the last that folds nothing where no action can fold) tells whether any of them shows it
// whole. apply(level) sets a level, and whole() and readable() measure the header after it; the header is left at the level
// returned.
export function fitLevel(apply,whole,levels=HEADER_FIT_LEVELS,readable=whole){
  apply(0);if(whole())return 0;
  apply(levels-1);
  const fits=whole()?whole:readable;
  for(let level=0;level<levels;level++){apply(level);if(fits())return level}
  return levels-1;
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
// shortened name back is marked data-crumb; widths(title) measures the title. The returned function stops watching.
export function observeHeaderFit(header,{titleSelector=".thread-title-button strong",foldOrder=HEADER_FOLD_ORDER,widths=titleWidths}={}){
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
    // the theme and palette buttons set aside into More actions as at level 4 (level 3 with it would be level 2 again), and kept
    // where the title keeps what it had there with the crumb's icon: all of it for a title the found level shows whole, or its
    // readable width.
    if(header.dataset.crumb)delete header.dataset.crumb;
    const whole=()=>!title||titleWhole(widths(title)),readable=()=>!title||titleReadable(widths(title));
    const level=fitLevel(apply,whole,HEADER_FIT_LEVELS+foldable.length,readable);
    if(title&&level>=CRUMB_ICON_LEVEL){
      const keeps=whole()?whole:readable;
      apply(Math.max(level,CRUMB_ICON_LEVEL+1));header.dataset.crumb="short";
      if(!keeps()){delete header.dataset.crumb;apply(level)}
    }
  };
  fit();
  const resize=typeof ResizeObserver==="function"?new ResizeObserver(fit):null;resize?.observe(header);
  // Only text and elements count: the level and the folds are attributes, so writing them never re-runs the fit.
  const contents=typeof MutationObserver==="function"?new MutationObserver(fit):null;contents?.observe(header,{childList:true,subtree:true,characterData:true});
  const fonts=typeof document!=="undefined"?document.fonts:null;fonts?.addEventListener?.("loadingdone",fit);
  return ()=>{resize?.disconnect();contents?.disconnect();fonts?.removeEventListener?.("loadingdone",fit)};
}
