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
// Then by what lane R4A's fixes to the terminal drawer's tab row (its fades at an edge with tabs past it, a tab brought in clear of
// them and a press on a close button under one) add to the lazy chunks, 1.5 / 0.7 KB, which took them 0.4 KB gzip over it: its
// headroom stays 1.8 / 0.3 KB, as on main before lane R4A.
// Then by what lane R5A's fixes add to the lazy chunks, 0.1 / 0.2 KB (Snooze's Until field setting its min when it shows and when it
// loses focus, and the new name of the first bundle's script in the import line of the 40 lazy chunks that load it, which their
// header and toast fixes change),
// which took them 0.1 KB gzip over it: its headroom stays 1.0 / 0.1 KB, as on main before lane R5A.
// Then by what lane R5C's fixes add to the lazy chunks, 1.1 / 0.4 KB (the Tools page naming a slow or cut-off action on its own row,
// Settings' Capture now taking one SnapShot a press, and Record clearing the last recording's error line), which took them 0.1 /
// 0.3 KB over it: its headroom stays 1.0 / 0.1 KB, as on main before lane R5C.
// Then by what round 6's fix lanes R6E and R6Y add to the lazy chunks, 3.4 / 1.4 KB (the Goal and Browser panels naming a slow write
// on the button pressed and keeping the keyboard there, the execution trace's "match these filters" state with Clear filters, one
// action a press on the Environments page and History's Retry and Load older threads, the Tools page's busy labels and kept focus,
// and Settings search titles that wrap), which took them 2.4 / 1.4 KB over it: its headroom stays 1.0 / 0.0 KB, as on main before
// round 6. The three lanes add 0.4 / 0.2 KB to the first bundle (now 199.2 of its 200 KB gzip), and lane R6X nothing to the lazy
// chunks.
// Then by what round 7's fix lane R7A adds to the lazy chunks, 3.4 / 1.2 KB (the Goal panel's and the Tools page's writes and
// actions kept on their way outside the page, with what lands while the person is away said once they are drawn again, the Browser
// panel's profile list keeping the keyboard, the Settings search opening tall results at their top clear of the error alert and
// offering only the cards the harness draws, and History's first-page error kept clear of the list), which took them 2.4 / 1.2 KB
// over it: its headroom stays 1.0 / 0.0 KB, as on main before round 7. Lane R7B adds 0.6 / 0.2 KB to the first bundle (the composer
// menus' dismissal kept with the draft in App; now 199.4 of its 200 KB gzip) and nothing to the lazy chunks.
// Then by what round 8's fix lanes add to the lazy chunks, 1.2 / 0.5 KB (lane R8A's: the Goal panel's refusals kept through another
// thread's opening and its busy button brought into view above the goal's bar, and the Tools page's details, search results and
// history import that land while the person is away shown once it is drawn again; lane R8B's 0.1 KB gzip is the first bundle's new
// name in them), which took them 0.2 / 0.5 KB over it: its headroom stays 1.0 / 0.0 KB, as on main before round 8. Lane R8B adds
// 1.2 / 0.5 KB to the first bundle (letters typed while an @ file imports kept, the whole word replaced by the file, and the right
// panel docked or overlaid at every width; now 199.9 of its 200 KB gzip), and lane R8C changes no UI code.
// Then by what round 9's fix lanes add to the lazy chunks, 9.8 / 3.9 KB, which took them 8.8 / 3.9 KB over it: most of it is lane
// R9B's room in the first bundle (the Cite button, the find bar and the threads' searches loaded at idle after the first paint, and
// the thread-move, snooze and /goal helpers moved to the lazy chunks that use them), the rest the Tools page's searches and skill
// reads kept for the page drawn again (R9A) and the right panel's handles (R9C). Its headroom stays 1.0 / 0.0 KB, as on main before
// round 9. The first bundle went down, 624.9 / 199.9 to 619.2 / 198.3 KB, with the composer's @-menu fixes (R9B) in it.
// Then by what round 10's fix lanes add to the lazy chunks, 0.6 / 0.2 KB (the Tools page's Close and search box waiting while a
// skill read or Load more runs (R10A), the palette's thread-search failure line with its Reload (R10B)), which took them 0.2 KB gzip
// over it: its headroom stays 1.0 / 0.0 KB, as on main before round 10. The first bundle grew 619.2 / 198.3 to 619.8 / 198.6 KB
// with the composer's @-menu, Cite and queued-follow-up fixes (R10B) and the right panel's and terminal drawer's sizes (R10C).
// Then by what round 11's fix lanes add to the lazy chunks, 0.2 / 0.1 KB (Tab and Shift+Tab on Cite going on from the text selected
// in any reply (R11A), and the first bundle's new name in the import line of the lazy chunks that load it), which took them 0.1 KB
// gzip over it: its headroom stays 1.0 / 0.0 KB, as on main before round 11. The first bundle grew 619.8 / 198.6 to 622.0 / 199.4 KB
// with the composer's @-menu fixes (R11C), Cite's place in Tab's order (R11A) and the composer held under the header (R11B).
// Then by what the first wave of the T3 Code port adds to the lazy chunks, 0.5 / 0.3 KB (Settings' harness and profile rows saying
// what a version check that did not answer, or a custom API endpoint, found, and the runtime profile editor's note on the proxy and
// toolchain variables (T3I), and Antigravity's questions answered only by their choices (T3A); Muse Code's name in Settings, Usage
// and Environments (T3M) about evens out), which took them 0.2 KB gzip over it: its headroom stays 1.0 / 0.1 KB, as on main before
// the port. The first bundle grew 623.0 / 199.7 to 623.3 / 199.8 KB with Muse Code in App's harness lists (T3M).
// Then (2026-10-28) by what the second wave of the port adds to the lazy chunks, 3.9 / 1.6 KB (T3M2 only the first bundle's new name
// in the import lines of the lazy chunks that load it, 0.0 / 0.1 KB; T3D 0.4 / 0.2 KB, Settings' Update to a harness's newer release
// and Muse Code's windows on Usage; T3K 3.5 / 1.3 KB, Antigravity's Gemini API key form and the Codex goal commands sent while a
// thread compacts), and by what moved into them out of the first bundle, 10.5 / 3.7 KB, when T3K took it to 624.3 / 200.1 KB with
// lanes T3O and the one after it still to add to it: the right panel's Runtime tab, History's list and the threads' message search,
// loaded at idle right after the first paint with the Cite button (idle-parts.js), and the palette's commands, which come with the
// palette's own code (palette-actions.js), since neither the first screen nor a thread's first draw needs them before the person
// opens them or a search runs, and what is opened before then asks for its code at once and says it is loading meanwhile. The
// approval card a harness waits on stays in the first bundle. They took them 13.4 / 5.1 KB over it: its headroom stays 1.0 / 0.1 KB,
// as on main before the second wave. The first bundle went down, 624.3 / 200.1 to 615.8 / 197.8 KB, with 2.2 KB gzip of room for
// those two lanes. Lane T3O then added 0.1 / 0.0 KB to the lazy chunks (OpenCode's server-refusal and catalog wording in Settings)
// and nothing to the first bundle (615.7 / 197.8 KB): the lazy chunks read 780.1 / 257.8 KB, 0.9 / 0.2 KB under the limit.
// The last lane of the port, T3S, then added 2.2 / 0.7 KB to the first bundle (617.9 / 198.5 KB: Muse Code's work that runs past
// its turn kept live on that turn's card, its compaction's wait and Stop, and an attached document's extracted text named in Codex's
// input) and 0.0 / 0.1 KB to the lazy chunks (the first bundle's new name in their import lines): 780.1 / 257.9 KB, 0.9 / 0.1 KB
// under the limit.
// Trebell Native's xAI and Meta Model API providers then added 0.2 / 0.1 KB to the first bundle (618.1 / 198.6 KB: their labels and
// the Thinking levels Meta documents for its models) and 0.2 / -0.1 KB to the lazy chunks (Settings' notes and search terms for
// them, and the first bundle's new name in their import lines): 780.3 / 257.8 KB, 0.7 / 0.2 KB under the limit.
// Each harness's sign-in choice in Settings (Sign in or its provider's API key, with the key's field on its row) in place of
// Antigravity's own key form then added nothing to the first bundle (618.1 / 198.6 KB) and 0.3 / 0.1 KB to the lazy chunks:
// 780.6 / 257.9 KB, 0.4 / 0.1 KB under the limit (and 1.1 / 0.2 KB to the CSS: 681.9 / 98.6 KB).
// That row's repairs (a key Trebell reads from the environment said as from its variable, and Remove key on the row) then added
// nothing to the first bundle and 0.2 / 0.1 KB to the lazy chunks: 780.8 / 258.0 KB, 0.2 / 0.0 KB under the limit (the Settings
// chunk 47 gzip bytes from its next 0.1 KB).
// Native's one configuration (src/native-configuration.mjs, shared with the benchmark runner) then added 0.7 / 0.2 KB to the first
// bundle (618.6 / 198.7 KB: the measured Thinking default, and the tool selection and developer text the window now reads from it)
// and took 0.0 / 0.1 KB from the lazy chunks: 780.1 / 257.8 KB, 0.9 / 0.2 KB under the limit.
// Its repair (review of native-one-config) then added 1.9 / 0.8 KB to the first bundle (620.5 / 199.5 KB, 0.5 KB gzip of room left:
// the source-control rule that reads Git work a message asks for instead of the bare words, and the Thinking picker that lists a
// measured model's level instead of a Default) and 0.0 / 0.1 KB to the lazy chunks (the first bundle's new name in their import
// lines): 780.1 / 257.9 KB, 0.9 / 0.1 KB under the limit.
// Its second repair then added 0.4 / 0.1 KB to the first bundle (620.9 / 199.6 KB, 0.4 KB gzip of room left: the everyday Git asks the
// source-control rule selects again, read in linear time, and the developer text's web-research sentence kept for other harnesses
// only) and took 0.0 / 0.1 KB from the lazy chunks (the first bundle's new name in their import lines): 780.1 / 257.8 KB, 0.9 / 0.2 KB
// under the limit.
// Its third repair then added 0.3 / 0.1 KB to the first bundle (621.2 / 199.7 KB, 0.3 KB gzip of room left: 347 bytes raw and 89
// gzip, all of them the source-control rule's close variants of everyday Git asks and its narrower version control) and nothing to the
// lazy chunks: 780.1 / 257.8 KB, 0.9 / 0.2 KB under the limit.
// Its fourth repair then added 0.3 / 0.1 KB to the first bundle (621.5 / 199.8 KB, 0.2 KB gzip of room left: the source-control
// rule's asks followed by a comma and thanks or an if, when or once clause, and setting up version control) and nothing to the lazy
// chunks: 780.1 / 257.8 KB.
// Then (2026-10-30) by what the five changes landed together on land/r17 add to the lazy chunks, 3.6 / 1.1 KB (the keys lane 0.9 /
// 0.2, R13A 2.1 / 0.8, R13B 0.0 / -0.1, R13C 0.6 / 0.2, Native's one configuration 0.0 / 0.0, each measured at its merge), and by
// what moved into them out of the first bundle, 29.3 / 10.0 KB, when those changes took it from 617.9 / 198.5 to 627.6 / 202.2 KB
// (the keys lane 0.2 / 0.1, R13A's Muse Code turns, compactions and rows 3.5 / 1.4, R13B's rows 1.4 / 0.5, R13C's composer menus
// and pickers 1.1 / 0.4, Native's one configuration with its source-control rule and Thinking default 3.5 / 1.3), with R13S still
// to add to it: what the person starts around a turn (a send in the background or to several models, a delegated task, a queued
// follow-up's Send now, Edit from here, Compact, a desktop SnapShot attached) into turn-support.js, a thread's history beyond its
// first page (Load earlier messages, the find bar's search, History's pages) and the sidebar's search and Cite's action into
// idle-parts.js, and a linked thread opened from the Source panel into thread-actions.js, since none of it runs before the person
// does it: what is done before its script has come waits for it, and what cannot load it says so in loadFailed's words. A send
// waits for turn-support.js before its message shows only when its thread's context is full enough to compact first. Its headroom
// stays 0.9 / 0.1 KB, as on main before them. The first bundle went down, 627.6 / 202.2 to 608.5 / 196.9 KB, with 3.1 KB gzip of
// room for R13S and the next round.
// Its repair (2026-10-30, review of that move) then made what those scripts do happen once per press and only where it was pressed:
// pressed again while it is on its way, also while its script is still coming, it joins the press on its way, and pressed before its
// script has come it is done only in the view it was pressed in (whenLoaded in App; a send in the background holds the composer,
// Sending…, meanwhile). It made room for that by moving two cards' own actions into those cards, which are drawn, and so loaded,
// before they can be pressed: a denied action's Allow anyway into GuardianDenialCard.jsx and an app's device verification into
// McpElicitationModal.jsx. The first bundle went down again, 608.5 / 196.9 to 607.7 / 196.8 KB (3.2 KB gzip of room for R13S and
// the next round), and the lazy chunks went up 1.5 / 0.4 KB to 814.5 / 269.4 KB (the two cards' actions 1.4 / 0.5, the delegation
// in turn-support.js 0.1 / 0.0, the Settings chunk's import line 0.0 / -0.1), and their limit with them, its headroom still
// 0.9 / 0.1 KB.
const B11={initialJs:{rawKB:640,gzipKB:200},initialCss:{rawKB:690,gzipKB:102},lazyJs:{rawKB:815.4,gzipKB:269.5}};
const repoRoot=fileURLToPath(new URL("../",import.meta.url)),buildDir=join(repoRoot,".trebell-budgets"),outDir=join(buildDir,"ui-dist");

test("B11: the UI bundle stays within its budget",{timeout:240_000},async()=>{
  try{
    const built=await buildUi({repoRoot,outDir}),report=bundleReport({outDir,modules:built.modules});
    console.log("B11 bundle:",JSON.stringify({initialJs:report.initialJs,initialCss:report.initialCss,lazyJs:report.lazyJs}));
    for(const [part,limits] of Object.entries(B11))for(const [measure,limit] of Object.entries(limits))assert.ok(report[part][measure]<=limit,`${part} ${measure} ${report[part][measure]} is over ${limit}`);
  }finally{rmSync(buildDir,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
});
