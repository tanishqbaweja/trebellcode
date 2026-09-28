import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,"..");
const entry=resolve(root,"benchmarks","harbor","trebell-native-runner.mjs");
const outfile=resolve(root,"benchmarks","harbor","dist","trebell-native-agent.mjs");

await mkdir(dirname(outfile),{recursive:true});
await build({
  entryPoints:[entry],
  outfile,
  bundle:true,
  platform:"node",
  format:"esm",
  target:"node22",
  banner:{js:"import { createRequire as __trebellCreateRequire } from 'node:module'; const require = __trebellCreateRequire(import.meta.url);"},
});
console.log(outfile);
