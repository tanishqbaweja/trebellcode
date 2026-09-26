import test from "node:test";
import assert from "node:assert/strict";
import { runtimeStatusForKind } from "../ui/src/runtime-status.js";

test("runtime status selection never borrows the selected instance from another harness",()=>{
  const info={
    selectedRuntime:"native",selectedInstanceId:"native-default",
    statuses:[
      {id:"native-default",kind:"native",name:"Trebell Native",available:true,message:"Built into Trebell Code"},
      {id:"grok-default",kind:"grok",name:"Grok Build",available:false,installed:false,message:"grok is not installed"},
      {id:"opencode-default",kind:"opencode",name:"OpenCode",available:true,version:"1.18.32"},
    ],
  };
  assert.equal(runtimeStatusForKind(info,"grok",{preferSelected:true})?.id,"grok-default");
  assert.equal(runtimeStatusForKind(info,"grok",{preferSelected:true})?.message,"grok is not installed");
  assert.equal(runtimeStatusForKind(info,"native",{preferSelected:true})?.id,"native-default");
  assert.equal(runtimeStatusForKind(info,"opencode")?.id,"opencode-default");
});
