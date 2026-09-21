import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderManager } from "../src/provider-manager.mjs";

const apiKey=String(process.env.TREBELL_TEST_VYCE_API_KEY||process.env.VYCEAI_API_KEY||"").trim();
if(!apiKey){
  throw new Error("Set TREBELL_TEST_VYCE_API_KEY or VYCEAI_API_KEY before running the live Vyce validation.");
}

const root=mkdtempSync(join(tmpdir(),"trebell-vyce-smoke-"));
try{
  const manager=new ProviderManager({env:{...process.env,TREBELL_HOME:root,VYCEAI_API_KEY:apiKey}});
  const catalog=await manager.models("vyceai");
  assert.ok(catalog.models.includes("deepseek-v4.1"),"Vyce /v1/models did not advertise deepseek-v4.1.");

  const result=await manager.directChat("vyceai",{
    model:"deepseek-v4.1",
    prompt:"Reply with exactly: TREBELL_VYCE_OK",
  });
  assert.match(String(result.text||""),/TREBELL_VYCE_OK/i,"deepseek-v4.1 did not return the expected smoke-test marker.");

  console.log(JSON.stringify({ok:true,provider:"vyceai",model:"deepseek-v4.1",catalogSource:catalog.source},null,2));
}finally{
  rmSync(root,{recursive:true,force:true});
}
