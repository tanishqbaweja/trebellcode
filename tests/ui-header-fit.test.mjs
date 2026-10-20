import test from "node:test";
import assert from "node:assert/strict";
import { fitLevel, fitState, foldableActions, HEADER_FIT_LEVELS, HEADER_FOLD_ORDER, observeHeaderFit, TITLE_READABLE_WIDTH, titleReadable, titleWhole } from "../ui/src/header-fit.js";

test("a title is whole when it shows all of itself, and readable when it shows at least the readable width, however long it is",()=>{
  assert.equal(titleWhole({clientWidth:40,scrollWidth:40}),true);
  assert.equal(titleWhole({clientWidth:84,scrollWidth:85}),true);
  assert.equal(titleWhole({clientWidth:0,scrollWidth:120}),false);
  // "Repo task one" at 80 of its 85px reads "Repo task …", as "Repo task two" would: readable, not whole. So does "Repo task
  // number one" at 80 of its 131px beside "Repo task number two".
  assert.equal(titleWhole({clientWidth:80,scrollWidth:85}),false);
  assert.equal(titleReadable({clientWidth:80,scrollWidth:85}),true);
  assert.equal(titleWhole({clientWidth:80,scrollWidth:131}),false);
  assert.equal(titleReadable({clientWidth:80,scrollWidth:131}),true);
  assert.equal(titleReadable({clientWidth:TITLE_READABLE_WIDTH,scrollWidth:600}),true);
  assert.equal(titleReadable({clientWidth:TITLE_READABLE_WIDTH-2,scrollWidth:600}),false);
  assert.equal(titleReadable({clientWidth:40,scrollWidth:40}),true);
});

test("the header takes the first level that shows the title whole among those that fold nothing, else the first that leaves it readable, else the last",()=>{
  // Whole from level 2: once the last level that folds nothing shows it whole, the levels are tried again from the first.
  const tried=[];
  assert.equal(fitLevel(level=>tried.push(level),()=>tried.at(-1)>=2),2);
  assert.deepEqual(tried,[0,HEADER_FIT_LEVELS-1,0,1,2]);
  // Whole at the first level: no other is tried.
  const first=[];
  assert.equal(fitLevel(level=>first.push(level),()=>true),0);
  assert.deepEqual(first,[0]);
  // No level that folds nothing shows it whole, and it is readable from level 2: level 2, though later ones show more of it.
  const readable=[];
  assert.equal(fitLevel(level=>readable.push(level),()=>false,HEADER_FIT_LEVELS,()=>readable.at(-1)>=2),2);
  assert.deepEqual(readable,[0,HEADER_FIT_LEVELS-1,0,1,2]);
  // Whole only once two actions fold, readable once one does: one folds, no more than readable needs.
  const folds=[];
  assert.equal(fitLevel(level=>folds.push(level),()=>folds.at(-1)>=HEADER_FIT_LEVELS+1,HEADER_FIT_LEVELS+3,()=>folds.at(-1)>=HEADER_FIT_LEVELS),HEADER_FIT_LEVELS);
  // Neither, at any level: the last one.
  const none=[];
  assert.equal(fitLevel(level=>none.push(level),()=>false,HEADER_FIT_LEVELS+2),HEADER_FIT_LEVELS+1);
  assert.equal(none.at(-1),HEADER_FIT_LEVELS+1);
});

test("a header is fitted again from the first level, so a wider window gets its labels back",()=>{
  // Each level gives the title 60px more; the header starts 190px too narrow, then widens.
  let shortfall=190,whole=200;
  const header={dataset:{},querySelector:()=>({get clientWidth(){return Math.max(0,Math.min(whole,200-shortfall+60*Number(header.dataset.fit)))},get scrollWidth(){return whole}})};
  const stop=observeHeaderFit(header);
  // Level 2 leaves the 200px title 130px, past the readable width, and level 4 shows it whole: the header takes level 4.
  assert.equal(header.dataset.fit,"4");
  stop();
  // A 600px title no level that folds nothing shows whole: the header takes level 2, the first that leaves it the readable width.
  whole=600;observeHeaderFit(header)();
  assert.equal(header.dataset.fit,"2");
  whole=200;shortfall=0;observeHeaderFit(header)();
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

// A header with a crumb and three foldable actions. The room each level gives the title: the labels 20px, the folded chip 20px,
// the crumb's icon alone 33px, the theme and palette buttons 68px (gains can set others) and the count-only chip 34px; then each
// folded action 34px, the first paying for the More actions button. The crumb's shortened name (data-crumb) takes its 33px back.
// fitted(base,title) fits it with the title that wide and level 0 leaving it base px, and says what the header shows.
function crumbHeader(){
  const control=fold=>{const attributes=new Set();return {dataset:{fold},hasAttribute:name=>attributes.has(name),toggleAttribute:(name,on)=>{if(on)attributes.add(name);else attributes.delete(name);return on}}};
  const controls=["goal","terminal","review"].map(control);
  const folded=()=>controls.filter(node=>node.hasAttribute("data-folded")).map(node=>node.dataset.fold);
  let gains=[0,20,40,73,141,175],base=0,whole=85;
  const header={dataset:{},querySelectorAll:()=>controls,querySelector:()=>({get clientWidth(){
    const fit=Number(header.dataset.fit),count=folded().length;
    const room=base+gains[Math.min(fit,gains.length-1)]+(count?34*(count-1):0)-(header.dataset.crumb==="short"?33:0);
    return Math.max(0,Math.min(whole,room));
  },get scrollWidth(){return whole}})};
  return {
    fitted:(width,title=85)=>{base=width;whole=title;observeHeaderFit(header)();return {fit:header.dataset.fit,crumb:header.dataset.crumb,folded:folded()}},
    setGains:next=>{gains=next},
  };
}

test("from the level where the project crumb keeps only its icon, the crumb gets its shortened name back wherever the title keeps what the level gave it, the theme and palette buttons stepping aside for it at level 3",()=>{
  const {fitted,setGains}=crumbHeader();
  // At 1280 beside the Git inspector level 2 leaves the 85px "Repo task one" 80px ("Repo task …", as "Repo task two" reads) and
  // level 3 shows it whole. The crumb's name there would be level 2 again, so the header takes level 4 for it: the theme and
  // palette buttons step aside for the crumb's name, which it keeps beside the whole title.
  assert.deepEqual(fitted(40),{fit:"4",crumb:"short",folded:[]});
  // So does a title of any length: a 300px one no level shows whole, which level 3 first leaves the readable width, takes level 4
  // the same way, the crumb's name leaving it readable.
  assert.deepEqual(fitted(10,300),{fit:"4",crumb:"short",folded:[]});
  // Level 3 leaves the title 83px: level 4 shows it whole, the crumb's name with it.
  assert.deepEqual(fitted(10),{fit:"4",crumb:"short",folded:[]});
  // Level 3 leaves the title 73px, and level 4 shows it whole with room left for the crumb's shortened name (1240 wide).
  assert.deepEqual(fitted(0),{fit:"4",crumb:"short",folded:[]});
  // Level 4 shows it whole, and the crumb's name would cut it to 58px: the crumb keeps its icon.
  assert.deepEqual(fitted(-50),{fit:"4",crumb:undefined,folded:[]});
  // Level 4 leaves the title 82px and the count-only chip shows it whole, the crumb keeping its icon, as its name would cut the
  // title to 83px.
  assert.deepEqual(fitted(-59),{fit:"5",crumb:undefined,folded:[]});
  // Level 4 leaves the title 78px; the count-only chip shows it whole, and the crumb's name would cut it to 79px.
  assert.deepEqual(fitted(-63),{fit:"5",crumb:undefined,folded:[]});
  // A title no level that folds nothing shows whole has its room at the readable width: at 1280 level 2 (the 80px it had), and
  // where two folded actions give it 112px, the crumb's name comes back only where the title keeps a readable width.
  assert.deepEqual(fitted(40,300),{fit:"2",crumb:undefined,folded:[]});
  assert.deepEqual(fitted(-97,300),{fit:String(HEADER_FIT_LEVELS),crumb:"short",folded:["goal","terminal"]});
  assert.deepEqual(fitted(-110,300),{fit:String(HEADER_FIT_LEVELS),crumb:undefined,folded:["goal","terminal"]});
  // No level that folds nothing gives the 85px title 80px: actions fold until it is readable, which two folds leave it whole, and
  // the crumb's name would cut it to 79px.
  assert.deepEqual(fitted(-97),{fit:String(HEADER_FIT_LEVELS),crumb:undefined,folded:["goal","terminal"]});
  // Wider again, the crumb's name is the one levels 0 to 2 give it, and the header says nothing more.
  fitted(-63);assert.deepEqual(fitted(50),{fit:"2",crumb:undefined,folded:[]});
  // Where level 4 frees nothing (no theme or palette buttons), the crumb's name there would cut the title level 3 shows whole:
  // the header goes back to level 3, the crumb keeping its icon.
  setGains([0,20,40,73,73,107]);
  assert.deepEqual(fitted(12),{fit:"3",crumb:undefined,folded:[]});
});

test("the crumb's shortened name never cuts a title its icon leaves whole, and a title past 120px shows whole where a level that folds nothing gives it that",()=>{
  const {fitted}=crumbHeader();
  // "Repo task number one" (131px) beside "Repo task number two", 20px narrower than 1280 beside the Git inspector: level 4 shows it
  // whole, and the crumb's name would cut it to 128px; at 1240 to 108px ("Repo task numb…", as "Repo task number two" reads). The
  // crumb keeps its icon. (Its name came back wherever the title kept the readable width, so it cut a title its icon left whole.)
  assert.deepEqual(fitted(20,131),{fit:"4",crumb:undefined,folded:[]});
  assert.deepEqual(fitted(0,131),{fit:"4",crumb:undefined,folded:[]});
  // At 1280 levels 2 and 3 cut it, and level 4 shows it whole with the crumb's name beside it. (Past 120px a title had its room at
  // the readable width: the header stopped at level 2, 80px of it reading "Repo task …".)
  assert.deepEqual(fitted(40,131),{fit:"4",crumb:"short",folded:[]});
  // Just past 120px as just short of it: no length tells a title's room.
  assert.deepEqual(fitted(40,118),{fit:"4",crumb:"short",folded:[]});
  assert.deepEqual(fitted(40,122),{fit:"4",crumb:"short",folded:[]});
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
