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

// A runtime dependency whose npm release has no LICENSE or NOTICE file shows its source repository's license file, which Trebell Code
// ships in third-party-licenses/, instead of a line saying it shipped none: saxes's ISC notice is its copyright and permission notice.
test("a runtime dependency that ships no license file of its own shows its repository's, which Trebell Code ships",async()=>{
  resetLicenseCache();
  const {items}=await listLicenses();
  const notices=async name=>{const found=items.filter(item=>item.name===name);assert.ok(found.length,name);return Promise.all(found.map(async item=>(await licenseDetail(item.id)).text.replace(/\r\n/g,"\n")))};
  const lead="This package's npm release has no LICENSE or NOTICE file; this notice is from its source repository and ships with Trebell Code.\n\n";
  const [saxes]=await notices("saxes");
  assert.ok(saxes.startsWith(lead+"LICENSE\n=======\nThe ISC License\n\nCopyright (c) Contributors\n\nPermission to use, copy, modify, and/or distribute this software for any\npurpose with or without fee is hereby granted, provided that the above\ncopyright notice and this permission notice appear in all copies.\n"),saxes.slice(0,400));
  assert.match(saxes,/The ISC License\n\nCopyright \(c\) Isaac Z\. Schlueter and Contributors\n\nPermission to use, copy, modify/);
  // Codex's package and its platform build (0.155.1-win32-x64 here) each show Apache-2.0 and Codex's NOTICE.
  for(const text of await notices("@openai/codex")){
    assert.ok(text.startsWith(lead+"LICENSE\n=======\n"),text.slice(0,300));
    assert.match(text,/Apache License\n\s+Version 2\.0, January 2004/);
    // Codex's NOTICE spells its copyright line with no-break spaces.
    assert.match(text,/\n\nNOTICE\n======\nOpenAI Codex\nCopyright\s2025\sOpenAI\n/);
  }
  for(const name of ["@opencode-ai/sdk","@opencode/client"]){
    const [text]=await notices(name);
    assert.ok(text.startsWith(lead+"LICENSE\n=======\nMIT License\n\nCopyright (c) 2025 opencode\n\nPermission is hereby granted, free of charge"),name+": "+text.slice(0,300));
  }
  // No runtime dependency is left without its notice.
  const placeholders=[];
  for(const item of items.filter(item=>/^(?:Optional r|R)untime dependency$/.test(item.component)))if(/did not ship a separate LICENSE or NOTICE file/.test((await licenseDetail(item.id)).text))placeholders.push(item.id);
  assert.deepEqual(placeholders,[]);
  // A package that ships its own notice files shows those alone.
  const yauzl=items.find(item=>item.name==="yauzl");
  assert.match((await licenseDetail(yauzl.id)).text,/^LICENSE\n=======\nThe MIT License \(MIT\)\n\nCopyright \(c\) 2014 Josh Wolfe/);
});
