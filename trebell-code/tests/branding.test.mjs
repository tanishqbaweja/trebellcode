import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here=dirname(fileURLToPath(import.meta.url));
const root=join(here,"..");

function canonicalBase64(){
  return [1,2,3,4]
    .map(index=>readFileSync(join(root,"branding",`icon.part${index}.b64`),"utf8").trim())
    .join("");
}

test("canonical Trebell icon is a valid 256px PNG and all packaged UI artwork matches it",()=>{
  const encoded=canonicalBase64();
  const png=Buffer.from(encoded,"base64");
  assert.equal(png.subarray(1,4).toString("ascii"),"PNG","Canonical branding payload is not a PNG.");
  assert.equal(png.readUInt32BE(16),256,"Canonical icon width must be 256px for Windows ICO generation.");
  assert.equal(png.readUInt32BE(20),256,"Canonical icon height must be 256px for Windows ICO generation.");

  for(const relative of ["build/icon.svg","ui/public/trebell-code-icon.svg"]){
    const svg=readFileSync(join(root,relative),"utf8");
    assert.ok(svg.includes(`data:image/png;base64,${encoded}`),`${relative} is not using the canonical Trebell Code icon.`);
  }
});
