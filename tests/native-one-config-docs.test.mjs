import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { nativeToolNamespaceOptions } from "../src/native-configuration.mjs";

// What the README, the benchmark page, the technical overview and the code's comments say about Native's one configuration matches what
// the code does (review of native-one-config, 2026-10-29).
const read=path=>readFile(new URL("../"+path,import.meta.url),"utf8");

test("the reply-streaming file says the runner bundles it and sends nothing different for it",async()=>{
  const [streaming,providerTurn,runner]=await Promise.all(["src/native-reply-streaming.mjs","src/native-provider-turn.mjs","benchmarks/harbor/native-harbor-run.mjs"].map(read));
  // The runner sends through the shared provider turn, which imports the reply-streaming file.
  assert.match(providerTurn,/from "\.\/native-reply-streaming\.mjs"/);assert.match(runner,/from "\.\.\/\.\.\/src\/native-provider-turn\.mjs"/);
  assert.doesNotMatch(streaming,/never\s+(?:\/\/\s*)?imports this file/,"the runner does import it");
  assert.match(streaming,/passes no stream observer/);
});

test("the technical overview's Tools row says output tools are in the first request only on prompt-caching providers",async()=>{
  assert.equal(nativeToolNamespaceOptions({stableOutputTools:false}).output,false);assert.equal(nativeToolNamespaceOptions({stableOutputTools:true}).output,true);
  const overview=await read("docs/technical/TECHNICAL_OVERVIEW.md");
  const tools=overview.split("\n").find(line=>line.startsWith("| Tools |"));
  assert.ok(tools,"the overview's Tools row");
  assert.doesNotMatch(tools,/output, workspace, terminal and background processes always/);
  assert.match(tools,/output tools from the first request on prompt-caching providers/);
  assert.match(tools,/never a link or a cited commit/);
  assert.ok(overview.split("\n").some(line=>line.startsWith("| Model |")&&/only `gpt-6-luna` has measured settings/.test(line)),"the overview names the measured model");
});

test("the README and the benchmark page say the measured settings are gpt-6-luna's, Native's OpenAI default",async()=>{
  const [readme,benchmarks]=await Promise.all(["README.md","BENCHMARKS.md"].map(read));
  assert.match(readme,/The benchmarks ran `gpt-6-luna` at Full access, which is Native's OpenAI default when your key lists it/);
  assert.match(benchmarks,/The measured settings are `gpt-6-luna`'s at Full access/);
  assert.match(benchmarks,/a GitHub link or a cited commit selects nothing/);
});

const overviewRow=(overview,name)=>overview.split("\n").find(line=>line.startsWith("| "+name+" |"))||"";

test("the overview and the benchmark page say the source-control rule is new and unmeasured, and that it also picks a Codex thread's tools",async()=>{
  const [overview,benchmarks]=await Promise.all(["docs/technical/TECHNICAL_OVERVIEW.md","BENCHMARKS.md"].map(read));
  assert.match(overviewRow(overview,"Tools"),/a new rule, narrowed from the product's word rule on 2026-10-29 and unmeasured, which also decides whether a Codex thread gets `trebell_source_control`, from its first message only/);
  assert.match(benchmarks,/a new rule, narrowed from the app's word rule on 2026-10-29 and unmeasured/);
});

test("the overview and the benchmark page say the long context on gpt-6-luna rests on the readouts",async()=>{
  const [overview,benchmarks]=await Promise.all(["docs/technical/TECHNICAL_OVERVIEW.md","BENCHMARKS.md"].map(read));
  assert.match(overviewRow(overview,"Long context on `gpt-6-luna`"),/rests on the readouts/);
  assert.match(overview,/what every readout ran without a fresh comparison/);
  assert.match(benchmarks,/the long context on `gpt-6-luna`[^.]*rest on the readouts/);
});

test("the benchmark page and the rule's comment say the source-control rule selects 3 of 200 Terminal-Bench Pro tasks, all Git tasks",async()=>{
  // Third review of native-one-config (2026-10-30): build-grpc-user-profile-service selected on a data store's "version control".
  const [benchmarks,configuration,overview]=await Promise.all(["BENCHMARKS.md","src/native-configuration.mjs","docs/technical/TECHNICAL_OVERVIEW.md"].map(read));
  assert.match(benchmarks,/1 of 89 Terminal-Bench 2\.0 tasks and 3 of 200 Terminal-Bench Pro tasks \(all Git tasks; "version control" counts only in Git's sense/);
  assert.match(configuration,/23 of 300 SWE-bench Multilingual, 1 of 89 Terminal-Bench 2\.0 and 3 of 200 Terminal-Bench Pro tasks \(Git\s+\/\/ tasks\)/);
  for(const doc of [benchmarks,configuration])assert.doesNotMatch(doc,/4 of 200/);
  assert.doesNotMatch(configuration,/the words' other senses select nothing: a commit an issue cites, a database transaction's commit, branch prediction, an nginx upstream, push notifications\. /);
  assert.match(overviewRow(overview,"Tools"),/nor a data store's version control/);
});

test("the overview and the benchmark page say the reasoning context rests on the readouts, not on fresh tasks",async()=>{
  // Third review of native-one-config (2026-10-30).
  const [overview,benchmarks]=await Promise.all(["docs/technical/TECHNICAL_OVERVIEW.md","BENCHMARKS.md"].map(read));
  assert.match(overviewRow(overview,"Reasoning"),/`current_turn` on OpenAI, which rests on the readouts/);
  assert.match(overviewRow(overview,"Reasoning"),/multi-message threads[^|]*never measured/);
  assert.match(benchmarks,/as does the OpenAI reasoning context, `current_turn`/);
  assert.match(benchmarks,/no gate and Max thinking were measured better on fresh tasks;/);
});

test("the overview and the benchmark page say Native's developer text has no web-research sentence",async()=>{
  const [overview,benchmarks,readme]=await Promise.all(["docs/technical/TECHNICAL_OVERVIEW.md","BENCHMARKS.md","README.md"].map(read));
  assert.match(overviewRow(overview,"Developer text"),/no web-research sentence/);
  assert.match(benchmarks,/the app's developer text without its web-research sentence/);
  for(const doc of [overview,benchmarks,readme])assert.doesNotMatch(doc,/Web research is available/);
});
