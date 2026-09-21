import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root=join(import.meta.dirname,"..");
const branding=join(root,"branding");
const encoded=[1,2,3,4]
  .map(index=>readFileSync(join(branding,`icon.part${index}.b64`),"utf8").trim())
  .join("");
const png=Buffer.from(encoded,"base64");
const signature=png.subarray(0,8).toString("hex");
if(signature!=="89504e470d0a1a0a"||png.length<10000){
  throw new Error("Canonical Trebell Code icon payload is invalid.");
}

const outputs=[
  join(root,"build","icon.png"),
  join(root,"ui","public","trebell-code-icon.png"),
  join(root,"ui","public","favicon.png"),
];
for(const target of outputs){
  mkdirSync(target.slice(0,target.lastIndexOf(/[\\/]/.test(target)?"\\":"/")), {recursive:true});
}

// dirname without adding another dependency/import.
for(const target of outputs){
  const slash=Math.max(target.lastIndexOf("/"),target.lastIndexOf("\\"));
  mkdirSync(target.slice(0,slash),{recursive:true});
  writeFileSync(target,png);
}
console.log(`Prepared canonical Trebell Code icon (${png.length} bytes).`);
