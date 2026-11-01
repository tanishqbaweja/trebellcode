import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createGuiServer } from "../src/gui-server.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { git } from "../src/git-service.mjs";
import { gitTextStyleNote } from "../src/git-text-style.mjs";

// The style note of a Git text prompt follows the project's Git text style: the repository's own habits (the default), Conventional
// Commits for commit subjects (pull request titles stay free) or the project's own instructions exactly as saved.
const NOTES={
  repository:{
    commit:"Follow the habits this repository's commit history and guidance files show in this message, such as form, letter case, tense, prefixes and length. If it shows none, write a short, plain subject saying what the change does.",
    review:"Follow the conventions this repository shows in this message (its recent commit subjects, guidance files and pull request template, when they are included), in the title as well as the body. If it shows none, give a short, plain title and a plain description of the change.",
  },
  conventional:{
    commit:"Write the subject as a Conventional Commits header: a type, a scope in parentheses if one applies, a colon and a space, then a short description. Use the most specific type that is true of the whole change (feat, fix, docs, refactor, perf, test, build, ci, style or chore) rather than a broader one, and leave the scope out unless the whole diff clearly belongs to one named part of the code.",
    review:"Commits in this project follow Conventional Commits, but the pull request title does not have to: make it short, specific and in plain words, with a type prefix only where it reads naturally.",
  },
};
const OWN_RULES={
  commit:"This project has its own instructions for Git text. Apply them, exactly as written below, to this commit subject:",
  review:"This project has its own instructions for Git text. Apply them, exactly as written below, to this pull request title and description:",
};
const NO_OWN_RULES="No custom instructions are saved for this project: describe what the change does in plain, specific words.";
const KINDS=["commit","review"];

test("each Git text style gives its own note for a commit subject and for pull request text",()=>{
  for(const style of ["repository","conventional"])for(const kind of KINDS)assert.equal(gitTextStyleNote({style,kind,customInstructions:"Ignored unless custom."}),NOTES[style][kind],style+" "+kind);
  for(const kind of KINDS){
    assert.equal(gitTextStyleNote({style:"custom",kind,customInstructions:"Use the ticket number as a prefix."}),OWN_RULES[kind]+"\nUse the ticket number as a prefix.");
    assert.equal(gitTextStyleNote({style:"custom",kind,customInstructions:""}),NO_OWN_RULES);
  }
  // A missing or unknown style (the store's older concise and descriptive) reads as the repository's; any kind but review is a commit.
  assert.equal(gitTextStyleNote(),NOTES.repository.commit);
  assert.equal(gitTextStyleNote({style:"concise",kind:"review"}),NOTES.repository.review);
  assert.equal(gitTextStyleNote({style:"conventional",kind:"pull"}),NOTES.conventional.commit);
});

test("custom Git text instructions reach the note exactly as saved, and white space alone counts as none",()=>{
  const saved="Subject: lower case, no final period.\n\n- Body: \"what\" and `why` as bullets, 72 columns.\n  Indented lines stay indented; symbols like <>&$ {} too.";
  for(const kind of KINDS){
    const note=gitTextStyleNote({style:"custom",kind,customInstructions:saved});
    assert.equal(note.slice(OWN_RULES[kind].length+1),saved);assert.ok(note.startsWith(OWN_RULES[kind]+"\n"));
    for(const blank of ["   ","\n\t\n",undefined,null,42])assert.equal(gitTextStyleNote({style:"custom",kind,customInstructions:blank}),NO_OWN_RULES);
  }
});

test("a commit note never names pull requests and no note opens a guidance heading",()=>{
  // Stand-in writers tell the pull request prompt from the commit prompt by "pull request"; "### <file>" lines are the guidance sections.
  for(const style of ["repository","conventional","custom","other"])for(const customInstructions of ["","Lead with the ticket number, then the verb."]){
    const commit=gitTextStyleNote({style,kind:"commit",customInstructions}),review=gitTextStyleNote({style,kind:"review",customInstructions});
    assert.doesNotMatch(commit,/pull request/i,style);
    for(const note of [commit,review]){assert.doesNotMatch(note,/^#{1,6} /m);assert.doesNotMatch(note,/\u2014/);assert.ok(note.length<600)}
  }
});

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("the Git text prompt carries the project's style note after its first line, and the repository's context only for its own style",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-git-text-style-"));
  const repo=join(home,"repo");await mkdir(repo,{recursive:true});
  await git(repo,["init"]);await git(repo,["config","user.email","git-text@example.test"]);await git(repo,["config","user.name","Git Text"]);
  await writeFile(join(repo,"AGENTS.md"),"Write subjects in the past tense.\n");
  await writeFile(join(repo,"notes.txt"),"before\n");await git(repo,["add","."]);await git(repo,["commit","-m","Added the style fixture"]);
  await writeFile(join(repo,"notes.txt"),"after: style-diff-marker\n");
  await writeFile(join(home,"ui-state.json"),JSON.stringify({settings:{agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",modelProvider:"openai",onboardingComplete:true,sourceControlTextStyle:"conventional"}}));
  await mkdir(join(home,"codex"),{recursive:true});
  const env={...process.env,TREBELL_HOME:home,CODEX_HOME:join(home,"codex"),CLAUDE_CONFIG_DIR:join(home,"claude-config"),TREBELL_HISTORY_DISABLE_CLAUDE:"1",OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  // No harness runs: every status check answers as a ready harness would, and the writer is a stand-in that keeps each prompt.
  const probe=AgentRuntimeManager.prototype.probe;
  AgentRuntimeManager.prototype.probe=async function(instanceOrKind){
    const instance=typeof instanceOrKind==="string"?this.instances().find(item=>item.kind===instanceOrKind):instanceOrKind;
    return {id:instance?.id,kind:instance?.kind,name:instance?.kind,available:true,installed:true,authenticated:true,version:"fixture"};
  };
  const prompts=[];
  const harnessTextGenerator=async options=>{prompts.push(options.prompt);return {text:/pull request/.test(options.prompt)?'{"title":"Styled","body":"Styled body."}':"docs: styled subject",model:"sonnet",runtime:"claude",name:"Claude Code"}};
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  let gui=null;
  try{
    gui=await createGuiServer({port,appPort,mock:false,env,fetchFn:async()=>{throw new Error("No model provider request is expected")},harnessTextGenerator});
    const post=(path,body)=>fetch(gui.url+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    const write=async()=>{
      const commit=await post("/api/git/commit-message",{cwd:repo,environmentId:null});assert.equal(commit.status,200);
      const review=await post("/api/git/review-text",{cwd:repo,environmentId:null});assert.equal(review.status,200);
      const [subject,text]=await Promise.all([commit.json(),review.json()]);assert.equal(subject.style,text.style);
      return {commit:prompts.at(-2),review:prompts.at(-1),style:text.style};
    };
    const opens=(prompt,first,note)=>assert.ok(prompt.startsWith(first+"\n\n"+note+"\n\n"),"the note follows the first line:\n"+prompt.slice(0,700));
    const COMMIT_FIRST="Write one Git commit subject for the current change.",REVIEW_FIRST="Generate a pull request title and description for the current change.";

    let written=await write();assert.equal(written.style,"conventional");
    opens(written.commit,COMMIT_FIRST,NOTES.conventional.commit);opens(written.review,REVIEW_FIRST,NOTES.conventional.review);
    for(const prompt of [written.commit,written.review])assert.doesNotMatch(prompt,/Recent commit subjects:|Repository guidance:/);
    // The commit subject is written from the working tree's diff (pull request text from the branch's commits, here none yet).
    assert.match(written.commit,/style-diff-marker/);

    // Saved with white space around it: the store trims it, and the note carries the rest exactly.
    const saved="Subject: lower case, no final period.\n- Body: \"what\" and `why` as bullets.";
    assert.equal((await post("/api/settings",{sourceControlTextStyle:"custom",sourceControlCustomInstructions:"\n  "+saved+"  \n"})).status,200);
    written=await write();assert.equal(written.style,"custom");
    opens(written.commit,COMMIT_FIRST,OWN_RULES.commit+"\n"+saved);opens(written.review,REVIEW_FIRST,OWN_RULES.review+"\n"+saved);
    for(const prompt of [written.commit,written.review])assert.doesNotMatch(prompt,/Recent commit subjects:|Repository guidance:/);

    assert.equal((await post("/api/settings",{sourceControlCustomInstructions:""})).status,200);
    written=await write();opens(written.commit,COMMIT_FIRST,NO_OWN_RULES);opens(written.review,REVIEW_FIRST,NO_OWN_RULES);

    assert.equal((await post("/api/settings",{sourceControlTextStyle:"repository"})).status,200);
    written=await write();assert.equal(written.style,"repository");
    opens(written.commit,COMMIT_FIRST,NOTES.repository.commit);opens(written.review,REVIEW_FIRST,NOTES.repository.review);
    for(const prompt of [written.commit,written.review]){
      assert.match(prompt,/Recent commit subjects:\n- Added the style fixture\n/);
      assert.match(prompt,/Repository guidance:\n### AGENTS\.md\nWrite subjects in the past tense\./);
    }
    assert.equal(prompts.length,8);
  }finally{
    AgentRuntimeManager.prototype.probe=probe;
    if(gui)await gui.close();
    await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});
