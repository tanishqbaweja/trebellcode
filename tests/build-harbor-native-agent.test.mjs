import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync=promisify(execFile);
const script=fileURLToPath(new URL("../scripts/build-harbor-native-agent.mjs",import.meta.url));
const buildInto=outfile=>execFileAsync(process.execPath,[script,outfile],{windowsHide:true});

test("a rebuild leaves a bundle that already has the same bytes untouched, and replaces a stale one whole",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-bundle-"));
  try{
    const outfile=join(dir,"dist","trebell-native-agent.mjs");
    await buildInto(outfile);
    const bundle=await readFile(outfile),built=await stat(outfile);
    assert.ok(bundle.length>0);
    await new Promise(done=>setTimeout(done,50));
    await buildInto(outfile);
    assert.equal((await stat(outfile)).mtimeMs,built.mtimeMs,"the second build rewrote a bundle whose bytes were already there");
    await writeFile(outfile,"stale");
    await buildInto(outfile);
    assert.ok((await readFile(outfile)).equals(bundle));
    assert.deepEqual(await readdir(join(dir,"dist")),["trebell-native-agent.mjs"]);
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("builds racing in one clone never show a reader a partial bundle",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"trebell-bundle-"));
  try{
    const outfile=join(dir,"dist","trebell-native-agent.mjs");
    await buildInto(outfile);
    const bundle=await readFile(outfile);
    await writeFile(outfile,"stale");
    let building=true;
    const builds=Promise.all([1,2,3].map(()=>buildInto(outfile))).finally(()=>{building=false});
    const seen=new Set();
    while(building){
      const bytes=await readFile(outfile);
      seen.add(bytes.equals(bundle)?"bundle":String(bytes)==="stale"?"stale":`partial ${bytes.length} bytes`);
      await new Promise(done=>setImmediate(done));
    }
    await builds;
    assert.deepEqual([...seen].filter(kind=>kind.startsWith("partial")),[]);
    assert.ok((await readFile(outfile)).equals(bundle));
    assert.deepEqual(await readdir(join(dir,"dist")),["trebell-native-agent.mjs"]);
  }finally{await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});
