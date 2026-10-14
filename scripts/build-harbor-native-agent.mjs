import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,"..");
const entry=resolve(root,"benchmarks","harbor","trebell-native-runner.mjs");
const outfile=resolve(process.argv[2]||resolve(root,"benchmarks","harbor","dist","trebell-native-agent.mjs"));

// Every benchmark run rebuilds the bundle when it starts, and two runs in one clone can build at the same moment: a
// Native rerun and a Codex pair hold different locks. Writing in place let one run hash the bundle while the other was
// rewriting it (a report carried the empty-file hash on 2026-10-14). So the bundle is built in memory and left alone
// when its bytes are already there; otherwise it goes to a temporary file that is renamed into place.
const result=await build({
  entryPoints:[entry],
  outfile,
  write:false,
  bundle:true,
  platform:"node",
  format:"esm",
  target:"node22",
  banner:{js:"import { createRequire as __trebellCreateRequire } from 'node:module'; const require = __trebellCreateRequire(import.meta.url);"},
});
if(result.outputFiles.length!==1||!result.outputFiles[0].contents.length)throw new Error(`esbuild produced ${result.outputFiles.length} output files for ${outfile}, expected one non-empty bundle`);
const bytes=Buffer.from(result.outputFiles[0].contents);
const current=await readFile(outfile).catch(()=>null);
if(!current?.equals(bytes)){
  await mkdir(dirname(outfile),{recursive:true});
  const temporary=`${outfile}.${process.pid}.tmp`;
  await writeFile(temporary,bytes);
  // Windows refuses to replace a file that another process holds open without delete sharing, so retry for a while.
  for(let attempt=1;;attempt++){
    try{await rename(temporary,outfile);break}
    catch(error){
      if(attempt>=40||!["EPERM","EACCES","EBUSY"].includes(error?.code)){await rm(temporary,{force:true});throw error}
      await new Promise(done=>setTimeout(done,250));
    }
  }
}
console.log(outfile);
