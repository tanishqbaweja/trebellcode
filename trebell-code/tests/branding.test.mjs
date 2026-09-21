import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here=dirname(fileURLToPath(import.meta.url));
const root=join(here,"..");

function canonicalPng(){
  const encoded=[1,2,3,4]
    .map(index=>readFileSync(join(root,"branding",`icon.part${index}.b64`),"utf8").trim())
    .join("");
  return {encoded,png:Buffer.from(encoded,"base64")};
}

test("canonical Trebell icon drives Windows packaging, favicon and every in-app brand surface",async()=>{
  const {png}=canonicalPng();
  assert.equal(png.subarray(0,8).toString("hex"),"89504e470d0a1a0a","Canonical branding payload is not a PNG.");
  assert.equal(png.readUInt32BE(16),256,"Canonical icon width must be 256px for Windows icon generation.");
  assert.equal(png.readUInt32BE(20),256,"Canonical icon height must be 256px for Windows icon generation.");

  await import("../scripts/prepare-branding.mjs?branding-test="+Date.now());

  for(const relative of ["build/icon.png","ui/public/trebell-code-icon.png","ui/public/favicon.png"]){
    assert.deepEqual(readFileSync(join(root,relative)),png,`${relative} is not byte-identical to the canonical Trebell Code icon.`);
  }

  const pkg=JSON.parse(readFileSync(join(root,"package.json"),"utf8"));
  assert.equal(pkg.build?.win?.icon,"build/icon.png","Windows packaging must use the canonical generated icon.");

  const index=readFileSync(join(root,"ui","index.html"),"utf8");
  const app=readFileSync(join(root,"ui","src","App.jsx"),"utf8");
  const sidebar=readFileSync(join(root,"ui","src","components","ThreadSidebar.jsx"),"utf8");
  const settings=readFileSync(join(root,"ui","src","components","SettingsPage.jsx"),"utf8");
  assert.match(index,/href="\/favicon\.png"/);
  assert.match(app,/src="\/trebell-code-icon\.png"/);
  assert.match(sidebar,/src="\/trebell-code-icon\.png"/);
  assert.match(settings,/src="\/trebell-code-icon\.png"/);
});
