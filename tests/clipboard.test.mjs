import test from "node:test";
import assert from "node:assert/strict";
import { writeClipboardText } from "../ui/src/clipboard.js";

test("clipboard helper uses the modern Clipboard API when available",async()=>{
  let copied="";
  const navigatorObj={clipboard:{writeText:async text=>{copied=text}}};
  assert.equal(await writeClipboardText("hello",{navigatorObj,documentObj:null}),true);
  assert.equal(copied,"hello");
});

test("clipboard helper falls back to execCommand when Clipboard API is missing",async()=>{
  let appended=null,command="",removed=false,selected=false;
  const input={style:{},setAttribute(){},focus(){},select(){selected=true},remove(){removed=true}};
  const documentObj={
    body:{appendChild(node){appended=node}},
    createElement(tag){assert.equal(tag,"textarea");return input},
    execCommand(value){command=value;return true},
  };
  assert.equal(await writeClipboardText("fallback",{navigatorObj:{},documentObj}),true);
  assert.equal(appended,input);
  assert.equal(input.value,"fallback");
  assert.equal(command,"copy");
  assert.equal(selected,true);
  assert.equal(removed,true);
});

test("clipboard helper reports failure when no copy mechanism exists",async()=>{
  assert.equal(await writeClipboardText("nope",{navigatorObj:{},documentObj:null}),false);
  assert.equal(await writeClipboardText("",{navigatorObj:{},documentObj:null}),false);
});
