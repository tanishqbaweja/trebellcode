import test from "node:test";
import assert from "node:assert/strict";
import { licenseDetail, listLicenses, resetLicenseCache } from "../src/license-service.mjs";

test("license inventory reflects installed runtime packages",async()=>{
  resetLicenseCache();
  const all=await listLicenses();
  assert.ok(all.total>20);
  const react=all.items.find(item=>item.name==="react");
  const codex=all.items.find(item=>item.name==="@openai/codex");
  assert.ok(react,"React license entry should exist");
  assert.ok(codex,"Codex license entry should exist");
  assert.match(react.license,/MIT/i);
  assert.match(codex.license,/Apache-2\.0|Apache/i);
  assert.equal("directory" in react,false);
});

test("license detail returns installed notice text and supports search",async()=>{
  const result=await listLicenses({query:"react MIT"});
  const react=result.items.find(item=>item.name==="react");
  assert.ok(react);
  const detail=await licenseDetail(react.id);
  assert.match(detail.text,/MIT License/i);
  assert.match(detail.text,/copyright/i);
  assert.equal("directory" in detail,false);
});
