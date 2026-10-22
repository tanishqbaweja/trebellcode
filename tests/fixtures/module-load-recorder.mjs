// Preloaded with `node --import <this file>`: writes the URL of every module the process resolves, ESM imports and CommonJS
// requires alike (module.registerHooks runs on the loading thread), once each, as a line of the file TREBELL_MODULE_LOAD_LOG
// names. A test reads the file to see which packages the process has loaded so far, from the process itself.
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

const log=process.env.TREBELL_MODULE_LOAD_LOG,seen=new Set();
if(log)registerHooks({
  resolve(specifier,context,nextResolve){
    const resolved=nextResolve(specifier,context),url=String(resolved?.url||"");
    if(url&&!seen.has(url)){seen.add(url);appendFileSync(log,url+"\n")}
    return resolved;
  },
});
