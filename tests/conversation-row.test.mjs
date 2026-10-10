import test from "node:test";
import assert from "node:assert/strict";
import { sameConversationMessageRowProps } from "../ui/src/conversation-row.js";

function props(message,extra={}){
  return {
    message,
    activeFind:false,
    allowRevert:true,
    projectPath:"/repo",
    environmentId:null,
    threadId:"thread-1",
    onEditFromHere:edit,
    ...extra,
  };
}
function edit(){}

test("conversation row memoization accepts reconstructed messages with unchanged visible fields",()=>{
  const first=props({id:"m1",role:"assistant",text:"Same answer",turnId:"turn-1",irrelevant:{changed:true}});
  const second=props({id:"m1",role:"assistant",text:"Same answer",turnId:"turn-1",irrelevant:{changed:false}});
  assert.equal(sameConversationMessageRowProps(first,second),true);
});

test("conversation row memoization rerenders for visible or navigation changes",()=>{
  const base=props({id:"m1",role:"assistant",text:"Answer",turnId:"turn-1"});
  assert.equal(sameConversationMessageRowProps(base,props({...base.message,text:"Updated answer"})),false);
  assert.equal(sameConversationMessageRowProps(base,props(base.message,{activeFind:true})),false);
  assert.equal(sameConversationMessageRowProps(base,props(base.message,{projectPath:"/other"})),false);
  assert.equal(sameConversationMessageRowProps(base,props(base.message,{threadId:"thread-2"})),false);
});

test("conversation row memoization rerenders when the turn heading or outcome pill changes",()=>{
  const base=props({id:"m1",role:"assistant",text:"Answer",turnId:"turn-1"},{heading:"Codex"});
  assert.equal(sameConversationMessageRowProps(base,props(base.message,{heading:"Codex"})),true);
  assert.equal(sameConversationMessageRowProps(base,props(base.message,{heading:"Codex · Supervised"})),false);
  assert.equal(sameConversationMessageRowProps(base,props(base.message,{heading:"Codex",outcomeLabel:"done · 2.1s",outcomeTone:"ok"})),false);
  const done=props(base.message,{heading:"Codex",outcomeLabel:"stopped",outcomeTone:"warn"});
  assert.equal(sameConversationMessageRowProps(done,props(base.message,{heading:"Codex",outcomeLabel:"stopped",outcomeTone:"err"})),false);
  assert.equal(sameConversationMessageRowProps(props(base.message),props(base.message,{heading:"",outcomeLabel:""})),true);
});
