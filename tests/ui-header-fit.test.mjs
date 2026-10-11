import test from "node:test";
import assert from "node:assert/strict";
import { fitLevel, fitState, foldableActions, HEADER_FIT_LEVELS, HEADER_FOLD_ORDER, observeHeaderFit, TITLE_READABLE_WIDTH, titleHasRoom } from "../ui/src/header-fit.js";

test("a title has room when it shows all of itself or at least the readable width",()=>{
  assert.equal(titleHasRoom({clientWidth:40,scrollWidth:40}),true);
  assert.equal(titleHasRoom({clientWidth:TITLE_READABLE_WIDTH,scrollWidth:600}),true);
  assert.equal(titleHasRoom({clientWidth:TITLE_READABLE_WIDTH-2,scrollWidth:600}),false);
  assert.equal(titleHasRoom({clientWidth:0,scrollWidth:120}),false);
});

test("the header takes the first level that gives the title room, and the last when none does",()=>{
  const tried=[];
  assert.equal(fitLevel(level=>tried.push(level),()=>tried.at(-1)>=2),2);
  assert.deepEqual(tried,[0,1,2]);
  const all=[];
  assert.equal(fitLevel(level=>all.push(level),()=>false),HEADER_FIT_LEVELS-1);
  assert.deepEqual(all,Array.from({length:HEADER_FIT_LEVELS},(_,index)=>index));
  assert.equal(fitLevel(()=>{},()=>true),0);
});

test("a header is fitted again from the first level, so a wider window gets its labels back",()=>{
  // Each level gives the title 60px more; the header starts 190px too narrow, then widens.
  let shortfall=190;
  const header={dataset:{},querySelector:()=>({get clientWidth(){return Math.max(0,200-shortfall+60*Number(header.dataset.fit))},scrollWidth:200})};
  const stop=observeHeaderFit(header);
  // Level 1 leaves the title 70px of its 200, level 2 130px: past the readable width.
  assert.equal(header.dataset.fit,"2");
  stop();
  shortfall=0;observeHeaderFit(header)();
  assert.equal(header.dataset.fit,"0");
  // A header without a title (no thread open yet) stays at the first level.
  const empty={dataset:{},querySelector:()=>null};observeHeaderFit(empty)();
  assert.equal(empty.dataset.fit,"0");
  assert.doesNotThrow(()=>observeHeaderFit(null)());
});

test("the actions fold from the end of the row, each once, and only the ones the header holds",()=>{
  assert.deepEqual(HEADER_FOLD_ORDER,["goal","terminal","review","script","open-in","source"]);
  // The row's control and its menu item carry the same data-fold.
  assert.deepEqual(foldableActions(["source","open-in","script","review","terminal","goal","goal","terminal"]),HEADER_FOLD_ORDER);
  assert.deepEqual(foldableActions(["source","terminal","palette"]),["terminal","source"]);
  assert.deepEqual(foldableActions([]),[]);
});

test("each level past the last non-folding one folds one more action, up to all of them",()=>{
  const foldable=["goal","terminal","source"];
  assert.deepEqual(fitState(0,foldable),{fit:0,folded:[]});
  assert.deepEqual(fitState(HEADER_FIT_LEVELS-1,foldable),{fit:4,folded:[]});
  assert.deepEqual(fitState(HEADER_FIT_LEVELS,foldable),{fit:5,folded:["goal"]});
  assert.deepEqual(fitState(HEADER_FIT_LEVELS+1,foldable),{fit:5,folded:["goal","terminal"]});
  assert.deepEqual(fitState(HEADER_FIT_LEVELS+9,foldable),{fit:5,folded:foldable});
  assert.deepEqual(fitState(3),{fit:3,folded:[]});
});

test("a header folds only as many actions as its title needs, and gives them back as it widens",()=>{
  const control=fold=>{const attributes=new Set();return {dataset:{fold},hasAttribute:name=>attributes.has(name),toggleAttribute:(name,on)=>{if(on)attributes.add(name);else attributes.delete(name);return on}}};
  // The row's six actions and, as while the menu is open, the menu items of two of them.
  const controls=[...["source","open-in","script","review","terminal","goal"].map(control),control("terminal"),control("goal")];
  const folded=()=>[...new Set(controls.filter(node=>node.hasAttribute("data-folded")).map(node=>node.dataset.fold))];
  // Each level to 4 gives the title 20px; each folded action gives 34px, but the first pays for the More actions button.
  let base=-60;
  const header={dataset:{},querySelectorAll:()=>controls,querySelector:()=>({get clientWidth(){
    const state=Math.min(Number(header.dataset.fit),4),count=folded().length;
    return Math.max(0,base+20*state+(count?34*(count-1):0));
  },scrollWidth:600})};
  observeHeaderFit(header)();
  // Level 4 leaves 20px, one fold 20px, two 54px, three 88px: past the readable width.
  assert.equal(header.dataset.fit,"5");
  assert.deepEqual(new Set(folded()),new Set(["goal","terminal","review"]));
  // The menu items of the folded actions are marked too.
  assert.equal(controls.filter(node=>node.hasAttribute("data-folded")).length,5);
  // Wider, level 4 is enough: nothing stays folded.
  base=0;observeHeaderFit(header)();
  assert.equal(header.dataset.fit,"4");
  assert.deepEqual(folded(),[]);
  // Too narrow for any number of folds: every action folds.
  base=-400;observeHeaderFit(header)();
  assert.equal(header.dataset.fit,"5");
  assert.deepEqual(new Set(folded()),new Set(HEADER_FOLD_ORDER));
});
