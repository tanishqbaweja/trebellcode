import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildUi, bundleReport } from "../scripts/perf/lib/bundle.mjs";

// B11: the KB the UI build ships, raw and gzip: what index.html loads before the app can run (the entry script and its static
// imports, and the CSS), and the chunks loaded later. The build goes to a gitignored folder of the checkout, on the checkout's drive.
// The Markdown renderer loads after the first paint (LazyChatMarkdown.jsx), so its 159 KB count with the lazy chunks. The lazy
// limit then grew by what the right-panel and dialog fixes (lane B+C) add to the lazy chunks and by what moved out of the first
// bundle to keep it at 640 / 200, and again by what lane A adds to the lazy chunks and by Trebell's tool catalog, which moved out
// of the first bundle for the same reason, so its headroom stays 7.4 / 1.6 KB, as on main before lane A. It grew once more by what
// the post-merge fixes (tools, relay, pages, threads) add to the lazy chunks and by what comes of a background send or a multi-model
// send (background-send-outcome.js), which moved out of the first bundle when those fixes together took it over 200 KB gzip: its
// headroom stays 7.4 / 1.6 KB. Then by what the fixes since add to the lazy chunks and by the app's question dialogs (ask-dialog.js),
// which moved out of the first bundle when the UI re-map fixes (D1-D15) took it over 200 KB gzip: its headroom stays 7.4 / 1.6 KB.
// Then by what App does around a turn beyond showing it (turn-support.js) and what a person does to threads (thread-actions.js),
// which moved out of the first bundle, to load at idle after the first paint, when it stood at 199.9 KB gzip with seven UI fix
// lanes still to add to it, to give them 8 KB gzip of room: its headroom is 6.8 / 1.4 KB.
const B11={initialJs:{rawKB:640,gzipKB:200},initialCss:{rawKB:690,gzipKB:102},lazyJs:{rawKB:731.5,gzipKB:238.1}};
const repoRoot=fileURLToPath(new URL("../",import.meta.url)),buildDir=join(repoRoot,".trebell-budgets"),outDir=join(buildDir,"ui-dist");

test("B11: the UI bundle stays within its budget",{timeout:240_000},async()=>{
  try{
    const built=await buildUi({repoRoot,outDir}),report=bundleReport({outDir,modules:built.modules});
    console.log("B11 bundle:",JSON.stringify({initialJs:report.initialJs,initialCss:report.initialCss,lazyJs:report.lazyJs}));
    for(const [part,limits] of Object.entries(B11))for(const [measure,limit] of Object.entries(limits))assert.ok(report[part][measure]<=limit,`${part} ${measure} ${report[part][measure]} is over ${limit}`);
  }finally{rmSync(buildDir,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
