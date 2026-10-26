import test from "node:test";
import assert from "node:assert/strict";
import { boundedTextareaHeight, resizeTextarea } from "../ui/src/textarea-size.js";

test("composer textarea height stays between its minimum and maximum",()=>{
  assert.equal(boundedTextareaHeight(12),40);
  assert.equal(boundedTextareaHeight(96.2),97);
  assert.equal(boundedTextareaHeight(900),160);
});

test("textarea resize applies bounded height and overflow",()=>{
  const node={scrollHeight:94,style:{}};
  assert.equal(resizeTextarea(node),94);
  assert.equal(node.style.height,"94px");
  assert.equal(node.style.overflowY,"hidden");
  node.scrollHeight=240;
  assert.equal(resizeTextarea(node),160);
  assert.equal(node.style.height,"160px");
  assert.equal(node.style.overflowY,"auto");
});

test("a draft its box shows less of than it holds scrolls, and is measured without its scrollbar",()=>{
  // The composer above the terminal drawer gives a six-line draft (142px) 77px of room (its clientHeight): the draft scrolls, and the
  // next measure is taken with the scrollbar off, as it is taken before the draft first scrolls.
  const measuredWith=[],node={style:{},clientHeight:77,get scrollHeight(){measuredWith.push(this.style.overflowY);return 142}};
  assert.equal(resizeTextarea(node),142);
  assert.equal(node.style.height,"142px");
  assert.equal(node.style.overflowY,"auto");
  node.clientHeight=142;
  assert.equal(resizeTextarea(node),142);
  assert.equal(node.style.overflowY,"hidden");
  assert.deepEqual(measuredWith,["hidden","hidden"]);
});
