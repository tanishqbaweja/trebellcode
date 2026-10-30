import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createGuiServer } from "../src/gui-server.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { git } from "../src/git-service.mjs";

// The prompt a harness writes commit and pull request text from carries the repository's AGENTS.md, CLAUDE.md and CONTRIBUTING.md,
// up to 6,000 characters each. CLAUDE.md is often a link to AGENTS.md or a copy of it: the same guidance then
// went twice. A file that says what one already added says is now left out; one that says something else still goes.
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
const sections=prompt=>[...String(prompt).matchAll(/^### (\S+)$/gm)].map(match=>match[1]);

test("Git text sends the repository's guidance once when CLAUDE.md repeats AGENTS.md, and CLAUDE.md again once it says something else",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-git-text-guidance-"));
  const repo=join(home,"repo");await mkdir(repo,{recursive:true});
  await git(repo,["init"]);await git(repo,["config","user.email","git-text@example.test"]);await git(repo,["config","user.name","Git Text"]);
  const agents="Use imperative commit subjects.\nKeep each subject under 72 characters.\n";
  await writeFile(join(repo,"AGENTS.md"),agents);
  // A copy that differs only in the blank lines around it is the same guidance.
  await writeFile(join(repo,"CLAUDE.md"),"\n"+agents+"\n\n");
  await writeFile(join(repo,"CONTRIBUTING.md"),"Run npm test before you push.\n");
  await writeFile(join(repo,"notes.txt"),"before\n");await git(repo,["add","."]);await git(repo,["commit","-m","Add the guidance"]);
  await writeFile(join(repo,"notes.txt"),"after: guidance-diff-marker\n");
  await writeFile(join(home,"ui-state.json"),JSON.stringify({settings:{agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",modelProvider:"openai",onboardingComplete:true,sourceControlTextStyle:"repository"}}));
  await mkdir(join(home,"codex"),{recursive:true});
  const env={...process.env,TREBELL_HOME:home,CODEX_HOME:join(home,"codex"),CLAUDE_CONFIG_DIR:join(home,"claude-config"),TREBELL_HISTORY_DISABLE_CLAUDE:"1",OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  // No harness runs here: every status check answers as a ready harness would, and the harness writing the text is a stand-in.
  const probe=AgentRuntimeManager.prototype.probe;
  AgentRuntimeManager.prototype.probe=async function(instanceOrKind){
    const instance=typeof instanceOrKind==="string"?this.instances().find(item=>item.kind===instanceOrKind):instanceOrKind;
    return {id:instance?.id,kind:instance?.kind,name:instance?.kind,available:true,installed:true,authenticated:true,version:"fixture"};
  };
  const prompts=[];
  const harnessTextGenerator=async options=>{prompts.push(options.prompt);return {text:/pull request/.test(options.prompt)?'{"title":"Guidance once","body":"Written once."}':"docs: send the guidance once",model:"sonnet",runtime:"claude",name:"Claude Code"}};
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  let gui=null;
  try{
    gui=await createGuiServer({port,appPort,mock:false,env,fetchFn:async()=>{throw new Error("No model provider request is expected")},harnessTextGenerator});
    const post=(path,body)=>fetch(gui.url+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    assert.equal((await post("/api/git/commit-message",{cwd:repo,environmentId:null})).status,200);
    assert.equal((await post("/api/git/review-text",{cwd:repo,environmentId:null})).status,200);
    assert.match(prompts[0],/Write one Git commit subject[\s\S]*guidance-diff-marker/);assert.match(prompts[1],/Generate a pull request title and description/);
    for(const prompt of prompts){
      assert.deepEqual(sections(prompt),["AGENTS.md","CONTRIBUTING.md"],"CLAUDE.md repeats AGENTS.md, so the guidance goes once");
      assert.equal(prompt.split("Use imperative commit subjects.").length-1,1);
    }
    // CLAUDE.md that says something of its own goes with the rest.
    await writeFile(join(repo,"CLAUDE.md"),"Mention the Claude Code model in the body.\n");
    assert.equal((await post("/api/git/commit-message",{cwd:repo,environmentId:null})).status,200);
    assert.deepEqual(sections(prompts.at(-1)),["AGENTS.md","CLAUDE.md","CONTRIBUTING.md"]);
    assert.match(prompts.at(-1),/### CLAUDE\.md\nMention the Claude Code model in the body\./);
    assert.equal(prompts.length,3);
  }finally{
    AgentRuntimeManager.prototype.probe=probe;
    if(gui)await gui.close();
    await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});
