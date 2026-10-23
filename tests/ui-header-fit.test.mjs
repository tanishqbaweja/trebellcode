import test from "node:test";
import assert from "node:assert/strict";
import { fitLevel, fitState, foldableActions, HEADER_FIT_LEVELS, HEADER_FOLD_ORDER, observeHeaderFit, TITLE_READABLE_WIDTH, titleReadable, titleWhole, titleWidths } from "../ui/src/header-fit.js";

// The headers below are models: the title's box shows shown px of its text's whole px, which widths hands the fit as the title's
// measure would.
const widths=title=>({shown:title.shown,whole:title.whole});

test("a title is whole when it shows all of itself, and readable when it shows at least the readable width, however long it is",()=>{
  assert.equal(titleWhole({shown:40,whole:40}),true);
  assert.equal(titleWhole({shown:0,whole:120}),false);
  // A box any part of a pixel narrower than its text cuts it: the ellipsis shows. clientWidth and scrollWidth, whole pixels, read
  // the 84.36px box of the 85.39px "Repo task one" as 84 of 85, which was counted whole ("Repo task o…" beside the Git inspector at
  // 1144), and a box 0.03px short as 85 of 85.
  assert.equal(titleWhole({shown:84.359375,whole:85.390625}),false);
  assert.equal(titleWhole({shown:85.359375,whole:85.390625}),false);
  assert.equal(titleWhole({shown:85.390625,whole:85.390625}),true);
  // "Repo task one" at 80 of its 85px reads "Repo task …", as "Repo task two" would: readable, not whole. So does "Repo task
  // number one" at 80 of its 131px beside "Repo task number two".
  assert.equal(titleWhole({shown:80,whole:85}),false);
  assert.equal(titleReadable({shown:80,whole:85}),true);
  assert.equal(titleWhole({shown:80,whole:131}),false);
  assert.equal(titleReadable({shown:80,whole:131}),true);
  assert.equal(titleReadable({shown:TITLE_READABLE_WIDTH,whole:600}),true);
  assert.equal(titleReadable({shown:TITLE_READABLE_WIDTH-2,whole:600}),false);
  assert.equal(titleReadable({shown:40,whole:40}),true);
});

test("the title is measured to the fraction of a pixel: its content box against its text's whole width, which a Range keeps while the ellipsis cuts it",()=>{
  const saved={getComputedStyle:globalThis.getComputedStyle,document:globalThis.document},range={selectNodeContents(node){range.node=node},getBoundingClientRect:()=>({width:85.390625})};
  try{
    globalThis.getComputedStyle=()=>({paddingLeft:"2px",paddingRight:"1.5px",borderLeftWidth:"0px",borderRightWidth:"0.5px"});
    globalThis.document={createRange:()=>range};
    const title={getBoundingClientRect:()=>({width:88.359375})};
    assert.deepEqual(titleWidths(title),{shown:84.359375,whole:85.390625});
    assert.equal(range.node,title);
  }finally{for(const [key,value] of Object.entries(saved))if(value===undefined)delete globalThis[key];else globalThis[key]=value}
});

test("the header takes the first level that shows the title whole, however many actions it folds, else the first that leaves it readable, else the last",()=>{
  // Whole from level 2: once the last level shows it whole, the levels are tried again from the first.
  const tried=[];
  assert.equal(fitLevel(level=>tried.push(level),()=>tried.at(-1)>=2),2);
  assert.deepEqual(tried,[0,HEADER_FIT_LEVELS-1,0,1,2]);
  // Whole at the first level: no other is tried.
  const first=[];
  assert.equal(fitLevel(level=>first.push(level),()=>true),0);
  assert.deepEqual(first,[0]);
  // No level shows it whole, and it is readable from level 2: level 2, though later ones show more of it.
  const readable=[];
  assert.equal(fitLevel(level=>readable.push(level),()=>false,HEADER_FIT_LEVELS,()=>readable.at(-1)>=2),2);
  assert.deepEqual(readable,[0,HEADER_FIT_LEVELS-1,0,1,2]);
  // Whole only once two actions fold, readable once one does: two fold, which show it whole. (One folded, "Repo task one" read 80
  // of its 85px at 1140 beside the 460px inspector, while 1136, where one fold left it under the readable width, folded two and
  // showed it whole.)
  const folds=[];
  assert.equal(fitLevel(level=>folds.push(level),()=>folds.at(-1)>=HEADER_FIT_LEVELS+1,HEADER_FIT_LEVELS+3,()=>folds.at(-1)>=HEADER_FIT_LEVELS),HEADER_FIT_LEVELS+1);
  // Whole only once three fold, readable once one does: three fold, and the header is left there. (Folding only one past what the
  // readable width needs, "Repo task number one" read 80 of its 135px at 1140 beside the 460px inspector with one action folded,
  // while 1136, where one fold left it under the readable width, folded three and showed it whole.)
  const far=[];
  assert.equal(fitLevel(level=>far.push(level),()=>far.at(-1)>=HEADER_FIT_LEVELS+2,HEADER_FIT_LEVELS+3,()=>far.at(-1)>=HEADER_FIT_LEVELS),HEADER_FIT_LEVELS+2);
  assert.equal(far.at(-1),HEADER_FIT_LEVELS+2);
  // The same where a narrower window leaves the title under the readable width until two fold: three fold all the same.
  const narrower=[];
  assert.equal(fitLevel(level=>narrower.push(level),()=>narrower.at(-1)>=HEADER_FIT_LEVELS+2,HEADER_FIT_LEVELS+3,()=>narrower.at(-1)>=HEADER_FIT_LEVELS+1),HEADER_FIT_LEVELS+2);
  // Whole only once every action folds, readable from the last level that folds nothing: every action folds.
  const every=[];
  assert.equal(fitLevel(level=>every.push(level),()=>every.at(-1)>=HEADER_FIT_LEVELS+5,HEADER_FIT_LEVELS+6,()=>every.at(-1)>=HEADER_FIT_LEVELS-1),HEADER_FIT_LEVELS+5);
  assert.equal(every.at(-1),HEADER_FIT_LEVELS+5);
  // Readable only once every action folds: there is no fold after the last.
  const all=[];
  assert.equal(fitLevel(level=>all.push(level),()=>false,HEADER_FIT_LEVELS+2,()=>all.at(-1)>=HEADER_FIT_LEVELS+1),HEADER_FIT_LEVELS+1);
  assert.equal(all.at(-1),HEADER_FIT_LEVELS+1);
  // Whole once one action folds, readable from the last level that folds nothing: the first fold, which adds no button (More
  // actions shows from level 4, where the theme and palette buttons step aside into it), shows it whole, as that level did before
  // More actions showed there. (The header stopped at the last level that folds nothing, the title cut, while a narrower window,
  // where that level left it under the readable width, folded the action and showed it whole.) The last level tells whether any
  // level shows it whole.
  const firstFold=[];
  assert.equal(fitLevel(level=>firstFold.push(level),()=>firstFold.at(-1)>=HEADER_FIT_LEVELS,HEADER_FIT_LEVELS+3,()=>firstFold.at(-1)>=HEADER_FIT_LEVELS-1),HEADER_FIT_LEVELS);
  assert.deepEqual(firstFold,[0,HEADER_FIT_LEVELS+2,...Array.from({length:HEADER_FIT_LEVELS+1},(_,level)=>level)]);
  // No action to fold: the last level that folds nothing tells.
  const noFold=[];
  assert.equal(fitLevel(level=>noFold.push(level),()=>false,HEADER_FIT_LEVELS,()=>noFold.at(-1)>=HEADER_FIT_LEVELS-1),HEADER_FIT_LEVELS-1);
  assert.equal(noFold[1],HEADER_FIT_LEVELS-1);
  // Neither, at any level: the last one.
  const none=[];
  assert.equal(fitLevel(level=>none.push(level),()=>false,HEADER_FIT_LEVELS+2),HEADER_FIT_LEVELS+1);
  assert.equal(none.at(-1),HEADER_FIT_LEVELS+1);
});

test("a header is fitted again from the first level, so a wider window gets its labels back",()=>{
  // Each level gives the title 60px more; the header starts 190px too narrow, then widens.
  let shortfall=190,whole=200;
  const header={dataset:{},querySelector:()=>({get shown(){return Math.max(0,Math.min(whole,200-shortfall+60*Number(header.dataset.fit)))},get whole(){return whole}})};
  const stop=observeHeaderFit(header,{widths});
  // Level 2 leaves the 200px title 130px, past the readable width, and level 4 shows it whole: the header takes level 4.
  assert.equal(header.dataset.fit,"4");
  stop();
  // A 600px title no level that folds nothing shows whole: the header takes level 2, the first that leaves it the readable width.
  whole=600;observeHeaderFit(header,{widths})();
  assert.equal(header.dataset.fit,"2");
  whole=200;shortfall=0;observeHeaderFit(header,{widths})();
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
// the crumb's icon alone 33px, the theme and palette buttons 34px (they step aside into More actions, whose button takes the room
// of one of them; gains can set others) and the count-only chip 34px; then each folded action 34px. The crumb's shortened name
// (data-crumb) takes its 33px back. fitted(base,title) fits it with the title that wide and level 0 leaving it base px, and says
// what the header shows; shown() is how much of the title it shows.
function crumbHeader(){
  const control=fold=>{const attributes=new Set();return {dataset:{fold},hasAttribute:name=>attributes.has(name),toggleAttribute:(name,on)=>{if(on)attributes.add(name);else attributes.delete(name);return on}}};
  const controls=["goal","terminal","review"].map(control);
  const folded=()=>controls.filter(node=>node.hasAttribute("data-folded")).map(node=>node.dataset.fold);
  let gains=[0,20,40,73,107,141],base=0,whole=85;
  const header={dataset:{},querySelectorAll:()=>controls,querySelector:()=>({get shown(){
    const fit=Number(header.dataset.fit),count=folded().length;
    const room=base+gains[Math.min(fit,gains.length-1)]+34*count-(header.dataset.crumb==="short"?33:0);
    return Math.max(0,Math.min(whole,room));
  },get whole(){return whole}})};
  return {
    fitted:(width,title=85)=>{base=width;whole=title;observeHeaderFit(header,{widths})();return {fit:header.dataset.fit,crumb:header.dataset.crumb,folded:folded()}},
    shown:()=>header.querySelector().shown,
    setGains:next=>{gains=next},
  };
}

test("from the level where the project crumb keeps only its icon, the crumb gets its shortened name back wherever the title keeps what the level gave it, the theme and palette buttons stepping aside into More actions for it at level 3",()=>{
  const {fitted,setGains}=crumbHeader();
  // At 1280 beside the Git inspector level 2 leaves the 85px "Repo task one" 80px ("Repo task …", as "Repo task two" reads) and
  // level 3 shows it whole. The crumb's name there would be level 2 again, so the header takes level 4 for it: the theme and
  // palette buttons step aside into More actions for the crumb's name, which it keeps beside the whole title.
  assert.deepEqual(fitted(40),{fit:"4",crumb:"short",folded:[]});
  // So does a title of any length: a 300px one no level shows whole, which level 3 first leaves the readable width, takes level 4
  // the same way, the crumb's name leaving it readable.
  assert.deepEqual(fitted(10,300),{fit:"4",crumb:"short",folded:[]});
  // Level 3 leaves the title 83px and level 4 shows it whole, which the crumb's name would cut to 84px, where the title's ellipsis
  // would show. The crumb keeps its icon.
  assert.deepEqual(fitted(10),{fit:"4",crumb:undefined,folded:[]});
  // Level 3 leaves the title 73px, and level 4 shows it whole; the crumb's name would cut it to 74px (1240 wide): the crumb keeps
  // its icon. (With the theme and palette buttons gone and no More actions button in their place, it had room for its name there.)
  assert.deepEqual(fitted(0),{fit:"4",crumb:undefined,folded:[]});
  // Level 4 leaves the title 57px and the count-only chip shows it whole; the crumb's name would cut it to 58px.
  assert.deepEqual(fitted(-50),{fit:"5",crumb:undefined,folded:[]});
  // No level that folds nothing shows the title whole (the count-only chip leaves it 82px, as beside the 460px inspector at 1176),
  // and the first fold, which adds no button, does: one action folds, and the crumb's name would cut it to 83px. (The header took
  // level 5, the first that leaves it readable, and the title read 82 of its 85px.)
  assert.deepEqual(fitted(-59),{fit:String(HEADER_FIT_LEVELS),crumb:undefined,folded:["goal"]});
  // The count-only chip leaves the title 78px, under its readable width: one action folds, which shows it whole, and the crumb's
  // name would cut it to 79px.
  assert.deepEqual(fitted(-63),{fit:String(HEADER_FIT_LEVELS),crumb:undefined,folded:["goal"]});
  // A title no level that folds nothing shows whole has its room at the readable width: at 1280 level 2 (the 80px it had), and
  // where two folded actions give it 112px, the crumb's name comes back only where the title keeps a readable width.
  assert.deepEqual(fitted(40,300),{fit:"2",crumb:undefined,folded:[]});
  assert.deepEqual(fitted(-97,300),{fit:String(HEADER_FIT_LEVELS),crumb:"short",folded:["goal","terminal"]});
  assert.deepEqual(fitted(-110,300),{fit:String(HEADER_FIT_LEVELS),crumb:undefined,folded:["goal","terminal"]});
  // No level that folds nothing gives the 85px title 80px: actions fold until it is readable, which two folds leave it whole, and
  // the crumb's name would cut it to 79px.
  assert.deepEqual(fitted(-97),{fit:String(HEADER_FIT_LEVELS),crumb:undefined,folded:["goal","terminal"]});
  // The count-only chip leaves the title 46px and one fold 80px, readable but cut ("Repo task …" beside the 460px inspector at
  // 1140): a second action folds, which shows it whole, as two do just narrower, where one fold leaves it under the readable width.
  assert.deepEqual(fitted(-95),{fit:String(HEADER_FIT_LEVELS),crumb:undefined,folded:["goal","terminal"]});
  // Wider again, the crumb's name is the one levels 0 to 2 give it, and the header says nothing more.
  fitted(-63);assert.deepEqual(fitted(50),{fit:"2",crumb:undefined,folded:[]});
  // Where level 4 frees nothing (no theme or palette buttons), the crumb's name there would cut the title level 3 shows whole:
  // the header goes back to level 3, the crumb keeping its icon.
  setGains([0,20,40,73,73,107]);
  assert.deepEqual(fitted(12),{fit:"3",crumb:undefined,folded:[]});
  // Level 3 leaves the title 84px of its 85, which its ellipsis cuts, and level 4 all of it, which the crumb's name would cut to
  // 78px: level 4, the crumb keeping its icon.
  setGains([0,20,40,73,100,134]);
  assert.deepEqual(fitted(11),{fit:"4",crumb:undefined,folded:[]});
});

test("a box any part of a pixel narrower than its text cuts the title, so the header folds one action more where that shows it whole, and the crumb's name takes no part of a pixel from a whole title",()=>{
  const {fitted,shown}=crumbHeader();
  // "Repo task one" (85.39px) beside the Git inspector and two linked pull requests: one fold leaves it 84.36px at 1144, which
  // clientWidth and scrollWidth read as 84 of 85, and 85.36px at 1145, 85 of 85. Both read "Repo task o…", and two folds show it
  // whole, as at 1140. (The header counted a title a pixel short as whole and folded one.) Beside the whole title the crumb's name
  // would leave it 85.36px at 1144, where the crumb keeps its icon, and 86.36px at 1145, where it gets its name back.
  assert.deepEqual(fitted(-90.640625,85.390625),{fit:String(HEADER_FIT_LEVELS),crumb:undefined,folded:["goal","terminal"]});
  assert.equal(shown(),85.390625);
  assert.deepEqual(fitted(-89.640625,85.390625),{fit:String(HEADER_FIT_LEVELS),crumb:"short",folded:["goal","terminal"]});
  assert.equal(shown(),85.390625);
  // Where one fold leaves the box as wide as its text, that fold shows it whole.
  assert.deepEqual(fitted(-89.609375,85.390625),{fit:String(HEADER_FIT_LEVELS),crumb:undefined,folded:["goal"]});
  assert.equal(shown(),85.390625);
});

test("the crumb's shortened name never cuts a title its icon leaves whole, and a title past 120px shows whole where a level that folds nothing gives it that",()=>{
  const {fitted}=crumbHeader();
  // "Repo task number one" (131px) beside "Repo task number two", 20px narrower than 1280 beside the Git inspector: level 4 leaves
  // it 127px and the count-only chip shows it whole, and the crumb's name would cut it to 128px; at 1240 to 108px ("Repo task
  // numb…", as "Repo task number two" reads). The crumb keeps its icon. (Its name came back wherever the title kept the readable
  // width, so it cut a title its icon left whole.)
  assert.deepEqual(fitted(20,131),{fit:"5",crumb:undefined,folded:[]});
  assert.deepEqual(fitted(0,131),{fit:"5",crumb:undefined,folded:[]});
  // At 1280 levels 2 and 3 cut it, and level 4 shows it whole; the crumb's name would cut it to 114px, so the crumb keeps its icon.
  // (Past 120px a title had its room at the readable width: the header stopped at level 2, 80px of it reading "Repo task …".)
  assert.deepEqual(fitted(40,131),{fit:"4",crumb:undefined,folded:[]});
  // Just past 120px as just short of it: no length tells a title's room.
  assert.deepEqual(fitted(40,118),{fit:"4",crumb:undefined,folded:[]});
  assert.deepEqual(fitted(40,122),{fit:"4",crumb:undefined,folded:[]});
});

test("a title any level shows whole shows whole, however many actions that folds, so a wider column never cuts a title a narrower one shows whole, nor folds more actions beside it",()=>{
  const {fitted,shown}=crumbHeader();
  // "Repo task number one" (131px): one fold leaves it 79px, readable but cut, two 113px and three all of it. Three fold, as they
  // do a pixel narrower, where one fold leaves it under the readable width. (The header folded one, cut it to 79px and read "Repo
  // task …", as "Repo task number two" does.)
  assert.deepEqual(fitted(-96,131),{fit:String(HEADER_FIT_LEVELS),crumb:undefined,folded:["goal","terminal","review"]});
  assert.equal(shown(),131);
  assert.deepEqual(fitted(-97,131),{fit:String(HEADER_FIT_LEVELS),crumb:undefined,folded:["goal","terminal","review"]});
  // The count-only chip leaves it 79px and one fold 113px: two fold, as they do a pixel narrower. (The header stopped at the
  // count-only chip and cut it to 79px.)
  assert.deepEqual(fitted(-62,131),{fit:String(HEADER_FIT_LEVELS),crumb:undefined,folded:["goal","terminal"]});
  assert.equal(shown(),131);
  assert.deepEqual(fitted(-63,131),{fit:String(HEADER_FIT_LEVELS),crumb:undefined,folded:["goal","terminal"]});
  // Column by column from 150px too narrow for level 0 to give the title anything: once a title shows whole it does in every wider
  // column, folding no more actions than in the narrower one. A title no level shows whole keeps the readable width.
  for(const title of [85,131,300]){
    let before=null;
    for(let base=-150;base<=100;base++){
      const state=fitted(base,title),now={whole:shown()>=title,folds:state.folded.length};
      if(before?.whole)assert.ok(now.whole,`the ${title}px title shows whole ${base}px from level 0's room, as it does a pixel narrower`);
      if(before?.whole)assert.ok(now.folds<=before.folds,`the ${title}px title folds ${now.folds} actions ${base}px from level 0's room, ${before.folds} a pixel narrower`);
      if(!now.whole)assert.ok(shown()+1>=Math.min(title,80)||state.folded.length===3,`the ${title}px title is readable ${base}px from level 0's room, or every action is folded`);
      before=now;
    }
  }
  // Where a title first shows whole, with every action folded, a pixel narrower no level shows it whole, and the header keeps
  // the readable width with fewer actions folded: the one place a wider column folds more.
  assert.deepEqual(fitted(57,300),{fit:String(HEADER_FIT_LEVELS),crumb:undefined,folded:["goal","terminal","review"]});
  assert.equal(shown(),300);
  assert.deepEqual(fitted(56,300),{fit:"2",crumb:undefined,folded:[]});
});

test("a header folds only as many actions as its title needs, and gives them back as it widens",()=>{
  const control=fold=>{const attributes=new Set();return {dataset:{fold},hasAttribute:name=>attributes.has(name),toggleAttribute:(name,on)=>{if(on)attributes.add(name);else attributes.delete(name);return on}}};
  // The row's six actions and, as while the menu is open, the menu items of two of them.
  const controls=[...["source","open-in","script","review","terminal","goal"].map(control),control("terminal"),control("goal")];
  const folded=()=>[...new Set(controls.filter(node=>node.hasAttribute("data-folded")).map(node=>node.dataset.fold))];
  // Each level up to the last that folds nothing gives the title 20px (level 4 sets the theme and palette buttons aside for the More
  // actions button); each folded action gives 34px.
  let base=-80;
  const header={dataset:{},querySelectorAll:()=>controls,querySelector:()=>({get shown(){
    const state=Math.min(Number(header.dataset.fit),HEADER_FIT_LEVELS-1),count=folded().length;
    return Math.max(0,base+20*state+34*count);
  },whole:600})};
  observeHeaderFit(header,{widths})();
  // Level 5 leaves 20px, one fold 54px, two 88px: past the readable width.
  assert.equal(header.dataset.fit,String(HEADER_FIT_LEVELS));
  assert.deepEqual(new Set(folded()),new Set(["goal","terminal"]));
  // The menu items of the folded actions are marked too.
  assert.equal(controls.filter(node=>node.hasAttribute("data-folded")).length,4);
  // Wider, level 4 is enough: nothing stays folded.
  base=0;observeHeaderFit(header,{widths})();
  assert.equal(header.dataset.fit,"4");
  assert.deepEqual(folded(),[]);
  // Too narrow for any number of folds: every action folds.
  base=-400;observeHeaderFit(header,{widths})();
  assert.equal(header.dataset.fit,String(HEADER_FIT_LEVELS));
  assert.deepEqual(new Set(folded()),new Set(HEADER_FOLD_ORDER));
});
