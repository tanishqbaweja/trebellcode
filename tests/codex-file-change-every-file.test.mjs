// Trebell's policy decides a Codex file change from every file it touches, however many: a large change (a codemod of hundreds of
// files) with one file outside the workspace, or under a path a rule denies, is refused even when that file comes after the first 200.
// Only the approval card's list of files stops at 200, saying how many more there are. The server runs in mock mode with a fake
// Codex app-server (fixtures/codex-gui-fake.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { startCodexGui, until } from "./fixtures/codex-gui-fake.mjs";

const changesOf=(home,count,{at=null,path=null}={})=>Array.from({length:count},(_,index)=>({path:index===at?path:join(home,"src","file-"+index+".js"),kind:{type:"update"},diff:""}));

test("a Codex file change is decided from every file it touches, and its card lists 200 and says how many more",async()=>{
  const fixture=await startCodexGui("trebell-file-change-every-"),{upstream,home}=fixture,threadId="codemod-thread",askedId="codemod-asked";
  try{
    // Auto: Trebell allows edits inside the workspace, so only the files outside it or under a denied path stop a change.
    await fixture.thread(threadId,{permissionProfile:"auto"});await fixture.thread(askedId,{permissionProfile:"supervised"});
    await fetch(fixture.gui.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({policyRules:[{runtime:"codex",kind:"edit",pathPrefix:join(home,"vendor"),effect:"deny",reason:"Vendored code is updated by its own tool."}]})});
    const window=await fixture.window();await window.request("initialize",{clientInfo:{name:"file-change-every"}});
    const started=(thread,id,changes)=>{const from=window.notifications("item/started").length;upstream.notify("item/started",{threadId:thread,turnId:"turn-1",item:{type:"fileChange",id,status:"inProgress",changes}});return until(()=>window.notifications("item/started").length>from)};
    const decide=async(thread,id,changes)=>{assert.ok(await started(thread,id,changes));const asked=upstream.ask("item/fileChange/requestApproval",{threadId:thread,turnId:"turn-1",itemId:id,startedAtMs:Date.now()});return asked};
    const outside=await decide(threadId,"codemod-1",changesOf(home,250,{at:229,path:join(home,"..","elsewhere.js")}));
    assert.ok(await until(()=>outside.answers().length===1,5000));
    assert.deepEqual(outside.answers()[0].result,{decision:"decline"},"the 230th file is outside the workspace");
    const denied=await decide(threadId,"codemod-2",changesOf(home,250,{at:240,path:join(home,"vendor","lib.js")}));
    assert.ok(await until(()=>denied.answers().length===1,5000));
    assert.deepEqual(denied.answers()[0].result,{decision:"decline"},"the 241st file is under a denied path");
    const inside=await decide(threadId,"codemod-3",changesOf(home,250));
    assert.ok(await until(()=>inside.answers().length===1,5000));assert.deepEqual(inside.answers()[0].result,{decision:"accept"},"every file inside is allowed");
    // In Supervised the change asks: its card lists the first 200 files and how many more it touches.
    const asks=()=>window.requests("item/fileChange/requestApproval");
    await decide(askedId,"codemod-4",changesOf(home,250));
    assert.ok(await until(()=>asks().length===1,5000));
    assert.equal(asks()[0].params.trebellFileChanges.length,200);assert.equal(asks()[0].params.trebellFileChangesMore,50);
    assert.equal(asks()[0].params.trebellFileChanges[199].path,join("src","file-199.js"));
  }finally{await fixture.close()}
});
