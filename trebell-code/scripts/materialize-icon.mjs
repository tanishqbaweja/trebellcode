import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const encoded=[1,2,3,4]
  .map(index=>readFileSync(join(root,"branding",`icon.part${index}.b64`),"utf8").trim())
  .join("");
const png=Buffer.from(encoded,"base64");
if(png.subarray(0,8).toString("hex")!=="89504e470d0a1a0a")throw new Error("Canonical Trebell branding payload is not a PNG");
const output=join(root,"build","icon.png");
mkdirSync(dirname(output),{recursive:true});
writeFileSync(output,png);
console.log(`Materialized Trebell Code icon: ${output} (${png.length} bytes)`);
