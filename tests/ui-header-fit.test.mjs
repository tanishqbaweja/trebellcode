import test from "node:test";
import assert from "node:assert/strict";
import { fitLevel, HEADER_FIT_LEVELS, observeHeaderFit, TITLE_READABLE_WIDTH, titleHasRoom } from "../ui/src/header-fit.js";

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
