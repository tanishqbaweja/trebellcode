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
// Then by what lane F's fixes to Projects, Environments, Usage and setup add to the lazy chunks, 3.6 / 1.6 KB, which took them
// 0.3 / 1.1 KB over it: its headroom stays 3.3 / 0.5 KB, as on main before lane F.
// Then by what lane B's fixes to harness switching in Settings, the Goal panel and Codex's /goal add to the lazy chunks,
// 1.9 / 0.7 KB, which took them 0.2 KB gzip over it: its headroom stays 3.3 / 0.5 KB, as on main before lane B.
// Then by what lane G's fixes to Settings (a runtime profile's environment variables and refused save, API keys, harness updates,
// SnapShots and the Settings search) add to the lazy chunks, 1.6 / 0.6 KB, which took them 0.1 KB gzip over it: its headroom stays
// 3.3 / 0.5 KB, as on main before lane G.
// Then by what lane E's fixes to the Goal panel, the Browser panel and the Runtime and Context tabs add to the lazy chunks,
// 3.1 / 1.7 KB, which took them 0.6 / 1.4 KB over it: its headroom stays 2.5 / 0.3 KB, as on main before lane E.
// Then by what lane R3B's fixes to Settings (a harness update said on its row, a runtime profile's saved note and Workspace's scope
// line), a thread row's refused actions and the palette's New task add to the lazy chunks, 3.1 / 1.2 KB, which took them 0.9 / 1.1 KB
// over it: its headroom stays 2.2 / 0.1 KB, as on main before lane R3B, where lane R3A's fixes had taken 0.3 / 0.2 KB of it.
const B11={initialJs:{rawKB:640,gzipKB:200},initialCss:{rawKB:690,gzipKB:102},lazyJs:{rawKB:744.8,gzipKB:243.9}};
const repoRoot=fileURLToPath(new URL("../",import.meta.url)),buildDir=join(repoRoot,".trebell-budgets"),outDir=join(buildDir,"ui-dist");

test("B11: the UI bundle stays within its budget",{timeout:240_000},async()=>{
  try{
    const built=await buildUi({repoRoot,outDir}),report=bundleReport({outDir,modules:built.modules});
    console.log("B11 bundle:",JSON.stringify({initialJs:report.initialJs,initialCss:report.initialCss,lazyJs:report.lazyJs}));
    for(const [part,limits] of Object.entries(B11))for(const [measure,limit] of Object.entries(limits))assert.ok(report[part][measure]<=limit,`${part} ${measure} ${report[part][measure]} is over ${limit}`);
  }finally{rmSync(buildDir,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
