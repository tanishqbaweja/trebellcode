import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const encoded=[1,2,3,4]
  .map(index=>readFileSync(join(root,"branding",`icon.part${index}.b64`),"utf8").trim())
  .join("");
const png=Buffer.from(encoded,"base64");
if(png.subarray(0,8).toString("hex")!=="89504e470d0a1a0a")throw new Error("Canonical Trebell branding payload is not a PNG");

const outputDir=join(root,"build");
mkdirSync(outputDir,{recursive:true});
const pngOutput=join(outputDir,"icon.png");
writeFileSync(pngOutput,png);

// A 256x256 Windows ICO may contain the PNG payload directly. Writing the
// container ourselves keeps the canonical pixels unchanged and avoids a
// platform-dependent image conversion helper during Linux cross-builds.
const header=Buffer.alloc(6);
header.writeUInt16LE(0,0);
header.writeUInt16LE(1,2);
header.writeUInt16LE(1,4);
const entry=Buffer.alloc(16);
entry.writeUInt8(0,0); // 0 means 256px
entry.writeUInt8(0,1); // 0 means 256px
entry.writeUInt8(0,2);
entry.writeUInt8(0,3);
entry.writeUInt16LE(1,4);
entry.writeUInt16LE(32,6);
entry.writeUInt32LE(png.length,8);
entry.writeUInt32LE(header.length+entry.length,12);
const ico=Buffer.concat([header,entry,png]);
const icoOutput=join(outputDir,"icon.ico");
writeFileSync(icoOutput,ico);

console.log(`Materialized Trebell Code icons: ${pngOutput} (${png.length} bytes), ${icoOutput} (${ico.length} bytes)`);
