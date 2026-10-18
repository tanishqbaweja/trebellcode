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
  assert.deepEqual(fitState(HEADER_FIT_LEVELS-1,foldable),{fit:HEADER_FIT_LEVELS-1,folded:[]});
  assert.deepEqual(fitState(HEADER_FIT_LEVELS,foldable),{fit:HEADER_FIT_LEVELS,folded:["goal"]});
  assert.deepEqual(fitState(HEADER_FIT_LEVELS+1,foldable),{fit:HEADER_FIT_LEVELS,folded:["goal","terminal"]});
  assert.deepEqual(fitState(HEADER_FIT_LEVELS+9,foldable),{fit:HEADER_FIT_LEVELS,folded:foldable});
  assert.deepEqual(fitState(3),{fit:3,folded:[]});
});

test("past the level where the project crumb keeps only its icon, the crumb gets its shortened name back wherever the title keeps its room",()=>{
  const control=fold=>{const attributes=new Set();return {dataset:{fold},hasAttribute:name=>attributes.has(name),toggleAttribute:(name,on)=>{if(on)attributes.add(name);else attributes.delete(name);return on}}};
  const controls=["goal","terminal","review"].map(control);
  const folded=()=>controls.filter(node=>node.hasAttribute("data-folded")).map(node=>node.dataset.fold);
  // The room each level gives the 85px title: the labels 20px, the folded chip 20px, the crumb's icon alone 33px, the theme and
  // palette buttons 68px and the count-only chip 34px; then each folded action 34px, the first paying for the More actions
  // button. The crumb's shortened name (data-crumb) takes its 33px back.
  const gains=[0,20,40,73,141,175];
  let base=0;
  const header={dataset:{},querySelectorAll:()=>controls,querySelector:()=>({get clientWidth(){
    const fit=Number(header.dataset.fit),count=folded().length;
    const room=base+gains[Math.min(fit,gains.length-1)]+(count?34*(count-1):0)-(header.dataset.crumb==="short"?33:0);
    return Math.max(0,Math.min(85,room));
  },scrollWidth:85})};
  const fitted=width=>{base=width;observeHeaderFit(header)();return {fit:header.dataset.fit,crumb:header.dataset.crumb,folded:folded()}};
  // The title has room at level 3: the crumb keeps its icon, as its name is what level 2 gave it and the title had no room there.
  assert.deepEqual(fitted(10),{fit:"3",crumb:undefined,folded:[]});
  // Level 3 leaves the title 73px, and level 4 shows it whole with room left for the crumb's shortened name (1240 wide).
  assert.deepEqual(fitted(0),{fit:"4",crumb:"short",folded:[]});
  // Level 4 leaves the title 82px, and the crumb's name would cut it to 49px: the crumb keeps its icon.
  assert.deepEqual(fitted(-59),{fit:"4",crumb:undefined,folded:[]});
  // Level 4 leaves the title 78px; the count-only chip gives it 112px, and the crumb's name still leaves it a readable width.
  assert.deepEqual(fitted(-63),{fit:"5",crumb:"short",folded:[]});
  // Two folded actions give the title 112px, and the crumb's name comes back only where the title keeps a readable width.
  assert.deepEqual(fitted(-97),{fit:String(HEADER_FIT_LEVELS),crumb:"short",folded:["goal","terminal"]});
  assert.deepEqual(fitted(-110),{fit:String(HEADER_FIT_LEVELS),crumb:undefined,folded:["goal","terminal"]});
  // Wider again, the crumb's name is the one levels 0 to 2 give it, and the header says nothing more.
  fitted(-63);assert.deepEqual(fitted(50),{fit:"2",crumb:undefined,folded:[]});
});

test("a header folds only as many actions as its title needs, and gives them back as it widens",()=>{
  const control=fold=>{const attributes=new Set();return {dataset:{fold},hasAttribute:name=>attributes.has(name),toggleAttribute:(name,on)=>{if(on)attributes.add(name);else attributes.delete(name);return on}}};
  // The row's six actions and, as while the menu is open, the menu items of two of them.
  const controls=[...["source","open-in","script","review","terminal","goal"].map(control),control("terminal"),control("goal")];
  const folded=()=>[...new Set(controls.filter(node=>node.hasAttribute("data-folded")).map(node=>node.dataset.fold))];
  // Each level up to the last that folds nothing gives the title 20px; each folded action gives 34px, but the first pays for the
  // More actions button.
  let base=-80;
  const header={dataset:{},querySelectorAll:()=>controls,querySelector:()=>({get clientWidth(){
    const state=Math.min(Number(header.dataset.fit),HEADER_FIT_LEVELS-1),count=folded().length;
    return Math.max(0,base+20*state+(count?34*(count-1):0));
  },scrollWidth:600})};
  observeHeaderFit(header)();
  // Level 5 leaves 20px, one fold 20px, two 54px, three 88px: past the readable width.
  assert.equal(header.dataset.fit,String(HEADER_FIT_LEVELS));
  assert.deepEqual(new Set(folded()),new Set(["goal","terminal","review"]));
  // The menu items of the folded actions are marked too.
  assert.equal(controls.filter(node=>node.hasAttribute("data-folded")).length,5);
  // Wider, level 4 is enough: nothing stays folded.
  base=0;observeHeaderFit(header)();
  assert.equal(header.dataset.fit,"4");
  assert.deepEqual(folded(),[]);
  // Too narrow for any number of folds: every action folds.
  base=-400;observeHeaderFit(header)();
  assert.equal(header.dataset.fit,String(HEADER_FIT_LEVELS));
  assert.deepEqual(new Set(folded()),new Set(HEADER_FOLD_ORDER));
});
