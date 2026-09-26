import test from "node:test";
import assert from "node:assert/strict";
import { browserVerificationReceipt, normalizeBrowserVerificationReceipt } from "../src/browser-verification-evidence.mjs";

test("browser verification receipts keep bounded facts and drop screenshot bytes and page content",()=>{
  const shot=browserVerificationReceipt({tool:"screenshot",callId:"shot-1",success:true,result:{dataUrl:"data:image/png;base64,SECRET_BYTES",url:"https://example.test/private?token=SECRET",title:"Private",width:390,height:844}});
  assert.deepEqual(shot,{namespace:"trebell_browser",tool:"screenshot",success:true,callId:"shot-1",screenshot:true,width:390,height:844});assert.doesNotMatch(JSON.stringify(shot),/SECRET|example\.test/);
  const runtime=browserVerificationReceipt({tool:"runtime",result:{consoleErrors:[{message:"private"}],networkFailures:[{url:"private"},{url:"private2"}],width:1280,height:800,viewports:[{width:1280,height:800},{width:390,height:844}]}});assert.deepEqual(runtime,{namespace:"trebell_browser",tool:"runtime",success:true,consoleErrorCount:1,networkFailureCount:2,width:1280,height:800,viewportCount:2});
});

test("browser verification receipts distinguish interaction success from failed browser work",()=>{
  assert.equal(browserVerificationReceipt({tool:"click",success:true,result:{ok:true}}).passed,true);assert.equal(browserVerificationReceipt({tool:"click",success:true,result:{ok:false}}).passed,false);assert.equal(browserVerificationReceipt({tool:"open",success:false}).passed,false);
});

test("browser evidence normalization rejects other namespaces and ignores unknown fields",()=>{
  assert.throws(()=>normalizeBrowserVerificationReceipt({namespace:"trebell_terminal",tool:"run"}),/Only Trebell browser/i);
  const clean=normalizeBrowserVerificationReceipt({namespace:"trebell_browser",tool:"screenshot",success:true,screenshot:true,width:390,height:844,dataUrl:"SECRET",url:"SECRET"});assert.deepEqual(clean,{namespace:"trebell_browser",tool:"screenshot",success:true,screenshot:true,width:390,height:844});
});
