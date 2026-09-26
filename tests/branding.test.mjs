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

function scriptChainIncludes(scripts,name,wanted,seen=new Set()){
  if(seen.has(name))return false;seen.add(name);
  const script=String(scripts?.[name]||"");
  if(new RegExp(`(?:^|\\s)npm\\s+run\\s+${wanted.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}(?:\\s|$)`).test(script))return true;
  for(const match of script.matchAll(/(?:^|\s)npm\s+run\s+([\w:-]+)/g))if(scriptChainIncludes(scripts,match[1],wanted,seen))return true;
  return false;
}

test("canonical Trebell icon drives Windows packaging, favicon and every in-app brand surface",()=>{
  const encoded=canonicalBase64();
  const png=Buffer.from(encoded,"base64");
  assert.equal(png.subarray(0,8).toString("hex"),"89504e470d0a1a0a","Canonical branding payload is not a PNG.");
  assert.equal(png.readUInt32BE(16),256,"Canonical icon width must be 256px.");
  assert.equal(png.readUInt32BE(20),256,"Canonical icon height must be 256px.");

  for(const relative of ["build/icon.svg","ui/public/trebell-code-icon.svg"]){
    const svg=readFileSync(join(root,relative),"utf8");
    assert.ok(svg.includes(`data:image/png;base64,${encoded}`),`${relative} is not using the canonical Trebell Code icon.`);
  }

  const pkg=JSON.parse(readFileSync(join(root,"package.json"),"utf8"));
  assert.equal(pkg.build?.win?.icon,"build/icon.ico","Windows packaging must use the materialized canonical Trebell icon.");
  assert.equal(pkg.build?.nsis?.installerIcon,"build/icon.ico");
  assert.equal(pkg.build?.nsis?.uninstallerIcon,"build/icon.ico");
  assert.equal(pkg.build?.nsis?.installerHeaderIcon,"build/icon.ico");
  assert.equal(scriptChainIncludes(pkg.scripts,"desktop:dist","prepare:icon"),true,"Desktop packaging must materialize the canonical icon before electron-builder, directly or through its platform build script.");

  const index=readFileSync(join(root,"ui","index.html"),"utf8");
  const app=readFileSync(join(root,"ui","src","App.jsx"),"utf8");
  const sidebar=readFileSync(join(root,"ui","src","components","ThreadSidebar.jsx"),"utf8");
  const settings=readFileSync(join(root,"ui","src","components","SettingsPage.jsx"),"utf8");
  assert.match(index,/href="\/trebell-code-icon\.svg"/);
  assert.match(app,/src="\/trebell-code-icon\.svg"/);
  assert.match(sidebar,/src="\/trebell-code-icon\.svg"/);
  assert.match(settings,/src="\/trebell-code-icon\.svg"/);
});
