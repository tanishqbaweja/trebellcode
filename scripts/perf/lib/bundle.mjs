// Builds the UI with the repository's Vite config (plus source maps, for profile attribution) into the run directory and reports
// the bundle: what index.html loads before the app can run (entry script, its static imports and CSS), each chunk's raw, gzip
// and brotli bytes, the largest modules in the initial chunks, and the lazy chunks.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";

export async function buildUi({repoRoot,outDir}){
  const { build }=await import("vite");
  const modules={};
  const started=performance.now();
  await build({
    configFile:join(repoRoot,"ui","vite.config.mjs"),logLevel:"warn",
    build:{outDir,emptyOutDir:true,sourcemap:true},
    plugins:[{name:"perf-chunk-modules",generateBundle(_options,bundle){
      for(const [file,chunk] of Object.entries(bundle)){
        if(chunk.type!=="chunk")continue;
        modules[file]={isEntry:chunk.isEntry,isDynamicEntry:chunk.isDynamicEntry,imports:chunk.imports,dynamicImports:chunk.dynamicImports,
          modules:Object.entries(chunk.modules).map(([id,info])=>({id:id.replace(/\\/g,"/").replace(/^.*?(node_modules\/|ui\/src\/)/,"$1"),bytes:info.renderedLength})).sort((a,b)=>b.bytes-a.bytes)};
      }
    }}],
  });
  return {buildMs:Math.round(performance.now()-started),modules};
}

const sizes=buffer=>({raw:buffer.length,gzip:gzipSync(buffer,{level:9}).length,brotli:brotliCompressSync(buffer,{params:{[constants.BROTLI_PARAM_QUALITY]:11}}).length});
const kb=value=>Number((value/1024).toFixed(1));

export function bundleReport({outDir,modules}){
  const assets=join(outDir,"assets"),files=readdirSync(assets).filter(name=>!name.endsWith(".map"));
  const html=readFileSync(join(outDir,"index.html"),"utf8");
  const referenced=[...html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)].map(match=>match[1]);
  // The initial set: what index.html names plus the static imports of those scripts, transitively.
  const initial=new Set(referenced);const queue=[...referenced];
  while(queue.length){const file=queue.shift();for(const next of modules["assets/"+file]?.imports||[]){const name=next.replace(/^assets\//,"");if(!initial.has(name)){initial.add(name);queue.push(name)}}}
  const rows=files.map(name=>{const buffer=readFileSync(join(assets,name)),size=sizes(buffer);return {file:name,kind:name.endsWith(".css")?"css":name.endsWith(".js")?"js":"asset",initial:initial.has(name),rawKB:kb(size.raw),gzipKB:kb(size.gzip),brotliKB:kb(size.brotli)}}).sort((a,b)=>b.rawKB-a.rawKB);
  const total=(filter)=>{const pick=rows.filter(filter);return {files:pick.length,rawKB:kb(pick.reduce((s,r)=>s+r.rawKB*1024,0)),gzipKB:kb(pick.reduce((s,r)=>s+r.gzipKB*1024,0)),brotliKB:kb(pick.reduce((s,r)=>s+r.brotliKB*1024,0))}};
  const initialModules=[];for(const name of initial){const info=modules["assets/"+name];if(!info)continue;for(const module of info.modules)initialModules.push({chunk:name,...module})}
  initialModules.sort((a,b)=>b.bytes-a.bytes);
  const byPackage={};for(const module of initialModules){const key=/^node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(module.id)?.[1]||module.id.split("/").slice(0,3).join("/");byPackage[key]=(byPackage[key]||0)+module.bytes}
  const fonts=rows.filter(row=>/\.(woff2?|ttf)$/.test(row.file));
  return {
    initialJs:total(row=>row.initial&&row.kind==="js"),initialCss:total(row=>row.initial&&row.kind==="css"),lazyJs:total(row=>!row.initial&&row.kind==="js"),fonts:total(row=>/\.(woff2?|ttf)$/.test(row.file)),
    files:rows,initialTopModules:initialModules.slice(0,30).map(module=>({...module,kB:kb(module.bytes)})),
    initialByPackageKB:Object.fromEntries(Object.entries(byPackage).sort((a,b)=>b[1]-a[1]).slice(0,25).map(([key,value])=>[key,kb(value)])),
    lazyChunks:rows.filter(row=>!row.initial&&row.kind==="js").map(row=>({file:row.file,rawKB:row.rawKB,gzipKB:row.gzipKB,topModules:(modules["assets/"+row.file]?.modules||[]).slice(0,5).map(module=>module.id)})),
    fontFiles:fonts.length,distBytes:files.reduce((sum,name)=>sum+statSync(join(assets,name)).size,0),
  };
}
