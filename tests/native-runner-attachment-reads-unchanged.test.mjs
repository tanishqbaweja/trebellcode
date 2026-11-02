import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextEngine } from "../src/context-engine.mjs";
import { NativeAgentSession } from "../src/native-agent-session.mjs";
import { createNativeBuiltins } from "../src/native-builtins.mjs";
import { nativePolicyContext } from "../src/native-configuration.mjs";
import { createNativeToolExecutor } from "../src/native-tool-executor.mjs";
import { authorizePlatformToolCall } from "../src/shared-tool-gateway.mjs";

// Benchmarked Native is shipped Native. L10-8 lets the app's Native read a thread's attachments where they are, through an attachedFile
// list the relay hands the gateway and the built-in tools, and names a document's extracted text in Native's line for it. The benchmark
// runner (benchmarks/harbor/trebell-native-runner.mjs: Full access, no restarts, no approvals) hands neither, and its prompts are text,
// so what it does is unchanged: these digests were taken on 40f024d6, before the change, and hold after it.
const digest=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("the runner's provider requests are byte-identical: a text prompt, and a linked file with no extracted text",async()=>{
  const requests=[];
  const session=new NativeAgentSession({
    cwd:"/repo",provider:"openai",model:"gpt-test",
    providerTurn:async request=>{requests.push(JSON.stringify(request));return {id:"resp-"+requests.length,provider:"openai",model:"gpt-test",text:"Done.",toolCalls:[],usage:{inputTokens:4,outputTokens:2,totalTokens:6}}},
    executeTool:async()=>{throw new Error("not used")},initialMessages:[{role:"system",content:"Trebell Native system prompt."}],
  });
  await session.start({providerSessionId:"native_fixed",model:"gpt-test"});
  await session.prompt([{type:"text",text:"Fix the failing test in src/app.js."}],{messageId:"user-1"});
  await session.prompt([{type:"text",text:"Read this too."},{type:"resource_link",uri:"file:///repo/notes.txt",name:"notes.txt"}],{messageId:"user-2"});
  assert.equal(requests.length,2);
  if(process.env.TREBELL_PRINT_DIGESTS)console.log("requests",digest(requests));
  assert.equal(digest(requests),"bd6e423f6cd39e017e84414a75a20661c1001df631810939132df8a00a190b11");
});

test("the runner's tool decisions and arguments are unchanged for reads in and out of the workspace",()=>{
  const calls=[
    {namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/app.js"}},
    {namespace:"trebell_workspace",name:"read_file",arguments:{path:"/workspace/src/app.js"}},
    {namespace:"trebell_workspace",name:"read_file",arguments:{path:"/etc/passwd"}},
    {namespace:"trebell_workspace",name:"read_file",arguments:{path:"/root/.trebell/attachments/1761500000000-ab12cd34-report.docx.txt"}},
    {namespace:"trebell_workspace",name:"read_file",arguments:{path:"../outside/secret.txt"}},
    {namespace:"trebell_workspace",name:"list",arguments:{path:"/root/.trebell/attachments"}},
    {namespace:"trebell_repo",name:"read_source",arguments:{path:"/root/.trebell/attachments/notes.txt"}},
  ];
  const decisions=[];
  for(const permissionProfile of ["full","supervised","read-only"])for(const call of calls){
    const authorization=authorizePlatformToolCall(call,{permissionProfile,workspace:"/app",projectAvailable:true});
    decisions.push({decision:authorization.decision,reason:authorization.reason,arguments:authorization.arguments,inside:authorization.action?.pathInsideWorkspace??null,requested:authorization.action?.requestedPath??null});
  }
  if(process.env.TREBELL_PRINT_DIGESTS)console.log("decisions",digest(decisions));
  assert.equal(digest(decisions),"a2bff3107ef0a53ebf54ab460791a8e764416f758ce9a0aa2cc3ce77ddb7d6c5");
});

// The app hands the executor attachedSource, which reads a range of an attached file's lines; the runner builds its executor without it
// (native-harbor-run.mjs: Full access, no approvals), so every read_source reads the project through the repository, as on 40f024d6.
test("the runner's read_source reads the project and refuses a file outside it, with the same results",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-runner-source-"));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250}));
  const repo=join(root,"repo");await mkdir(join(repo,"src"),{recursive:true});await writeFile(join(repo,"src","app.js"),"export const answer = 42;\n");
  await writeFile(join(root,"outside.txt"),"outside\n");
  const executor=createNativeToolExecutor({contextEngine:new ContextEngine(),root:repo,repository:true,projectAvailable:true,
    policyContext:nativePolicyContext({permissionProfile:"full",workspace:repo,projectAvailable:true}),executeShared:async()=>{throw new Error("not used")}});
  // Each result as the model is given it, with the temporary folder's path written as <root> and every separator as /.
  const outcome=async path=>JSON.stringify(await executor({namespace:"trebell_repo",name:"read_source",arguments:{path}})).split(JSON.stringify(root).slice(1,-1)).join("<root>").split("\\\\").join("/");
  const results=[await outcome("src/app.js"),await outcome(join(root,"outside.txt")),await outcome("../outside.txt")];
  if(process.env.TREBELL_PRINT_DIGESTS)console.log("sources",JSON.stringify(results));
  assert.equal(digest(results),"6b1920331158309ea061a0a81fc4516f271007ce94237cd8b2ce46874c53d28c");
  // And so does every search_code, a search scoped to a file outside the project too.
  const search=async args=>JSON.stringify(await executor({namespace:"trebell_repo",name:"search_code",arguments:args})).split(JSON.stringify(root).slice(1,-1)).join("<root>").split("\\\\").join("/");
  const searches=[await search({query:"answer"}),await search({query:"outside",path:join(root,"outside.txt")}),await search({query:"outside",path:"../outside.txt"})];
  if(process.env.TREBELL_PRINT_DIGESTS)console.log("searches",JSON.stringify(searches));
  assert.equal(digest(searches),"8b9b43c44678e7ccccf300c22b3207227465e3b2381f96dc246e8cbe79631301");
});

test("the runner's built-in read_file reads in the workspace and refuses a file outside it, with the same results",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-runner-reads-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=join(root,"repo");await mkdir(join(repo,"src"),{recursive:true});await writeFile(join(repo,"src","app.js"),"export const answer = 42;\n");
  await writeFile(join(root,"outside.txt"),"outside\n");
  const execute=createNativeBuiltins({root:repo});
  const outcome=async path=>execute({namespace:"trebell_workspace",name:"read_file",arguments:{path}}).then(result=>({content:result.content,size:result.size,truncated:result.truncated??null}),error=>({error:error.message}));
  const results=[await outcome("src/app.js"),await outcome(join(root,"outside.txt")),await outcome("../outside.txt")];
  assert.deepEqual(results,[{content:"export const answer = 42;\n",size:26,truncated:null},{error:"Path is outside the active workspace"},{error:"Path is outside the active workspace"}]);
});
