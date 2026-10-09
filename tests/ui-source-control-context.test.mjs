import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createGitTextRequests, gitTextWriterKey, sourceControlContext, sourceControlContextCurrent, sourceControlErrorAfterContextChange, sourceControlRepositoryKey,
} from "../ui/src/source-control-context.js";

const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const base={projectPath:"H:/work/app",environmentId:null,agentRuntime:"opencode",agentRuntimeInstanceId:"opencode-default",provider:"openai",threadId:"thread-1"};
const paymentRequired={message:"OpenCode could not write the Git text: Payment Required: You have no remaining credits.",scope:"writer"};

test("a Windows project path names one repository whatever its slashes, case or trailing separator",()=>{
  assert.equal(sourceControlRepositoryKey("H:\\Work\\App\\"),sourceControlRepositoryKey("h:/work/app"));
  assert.notEqual(sourceControlRepositoryKey("/home/me/App"),sourceControlRepositoryKey("/home/me/app"),"POSIX paths keep their case");
  assert.notEqual(sourceControlRepositoryKey("H:/work/app"),sourceControlRepositoryKey("H:/work/app","ssh-box"),"the same path in another environment is another repository");
  assert.notEqual(sourceControlRepositoryKey("H:/work/app"),sourceControlRepositoryKey("H:/work/other"));
  assert.equal(sourceControlRepositoryKey("/"),sourceControlRepositoryKey("/"));
});

test("the Git text writer is the harness profile, or Native's model provider",()=>{
  assert.notEqual(gitTextWriterKey({agentRuntime:"opencode"}),gitTextWriterKey({agentRuntime:"grok"}));
  assert.equal(gitTextWriterKey({agentRuntime:"grok",provider:"openai"}),gitTextWriterKey({agentRuntime:"grok",provider:"anthropic"}),"a harness writes with its own account");
  assert.equal(gitTextWriterKey({agentRuntime:"grok"}),gitTextWriterKey({agentRuntime:"grok",agentRuntimeInstanceId:"grok-default"}));
  assert.notEqual(gitTextWriterKey({agentRuntime:"claude",agentRuntimeInstanceId:"claude-default"}),gitTextWriterKey({agentRuntime:"claude",agentRuntimeInstanceId:"claude-work"}),"another profile is another writer");
  assert.notEqual(gitTextWriterKey({agentRuntime:"native",provider:"openai"}),gitTextWriterKey({agentRuntime:"native",provider:"anthropic"}));
});

test("a Git text error from the previous harness clears when the harness changes",()=>{
  const opencode=sourceControlContext(base),grok=sourceControlContext({...base,agentRuntime:"grok",agentRuntimeInstanceId:"grok-default"});
  assert.equal(sourceControlErrorAfterContextChange(paymentRequired,opencode,grok),null);
  assert.equal(sourceControlContextCurrent(opencode,grok,"writer"),false,"an OpenCode request answered after the switch must not land");
  assert.equal(sourceControlContextCurrent(opencode,grok,"repository"),true,"repository work is not about the harness");
  const pushFailed={message:"Push failed: rejected",scope:"repository"};
  assert.equal(sourceControlErrorAfterContextChange(pushFailed,opencode,grok),pushFailed,"a repository error still describes the repository on screen");
});

test("a thread change clears only the thread's errors, and a repository change clears every error",()=>{
  const first=sourceControlContext(base),otherThread=sourceControlContext({...base,threadId:"thread-2"}),otherProject=sourceControlContext({...base,projectPath:"H:/work/other"});
  const linkFailed={message:"Could not sync linked pull requests: offline",scope:"thread"};
  const pushFailed={message:"Push failed: rejected",scope:"repository"};
  assert.equal(sourceControlErrorAfterContextChange(linkFailed,first,otherThread),null);
  assert.equal(sourceControlErrorAfterContextChange(paymentRequired,first,otherThread),paymentRequired);
  assert.equal(sourceControlErrorAfterContextChange(pushFailed,first,otherThread),pushFailed);
  for(const error of [linkFailed,paymentRequired,pushFailed])assert.equal(sourceControlErrorAfterContextChange(error,first,otherProject),null,error.scope);
  const sameProjectOtherSpelling=sourceControlContext({...base,projectPath:"h:\\WORK\\app\\"});
  assert.equal(sourceControlErrorAfterContextChange(pushFailed,first,sameProjectOtherSpelling),pushFailed,"the same repository spelled differently is not a change");
  assert.equal(sourceControlErrorAfterContextChange(null,first,otherProject),null);
  assert.equal(sourceControlErrorAfterContextChange({message:"",scope:"repository"},first,first),null);
  assert.equal(sourceControlContextCurrent(null,first),false);
});

test("commit text and pull request text are cancelled per kind, and a context change cancels both",()=>{
  const requests=createGitTextRequests();
  // Generate PR is still writing when Generate (commit text) is pressed: both answers must still land.
  const pr=requests.start("generate-pr"),commit=requests.start("generate");
  assert.equal(requests.current(pr),true,"asking for the commit text must not drop the pull request text");
  assert.equal(pr.controller.signal.aborted,false);
  assert.equal(requests.current(commit),true);
  // A second commit request replaces the first one of its kind only.
  const again=requests.start("generate");
  assert.equal(commit.controller.signal.aborted,true);
  assert.equal(requests.current(commit),false,"the replaced request's answer is ignored");
  assert.equal(requests.finish(commit),false,"and it no longer owns the busy state");
  assert.equal(requests.current(pr),true);
  assert.equal(requests.finish(again),true);
  assert.equal(requests.finish(again),false,"a request finishes once");
  // A harness, profile or repository change cancels every kind still in flight.
  const next=requests.start("generate");
  assert.deepEqual(requests.cancelAll().sort(),["generate","generate-pr"]);
  for(const request of [pr,next]){assert.equal(request.controller.signal.aborted,true);assert.equal(requests.current(request),false);assert.equal(requests.finish(request),false)}
  assert.deepEqual(requests.cancelAll(),[]);
  assert.equal(requests.current(null),false);
});

test("Source Control scopes its errors and cancels Git text written for a previous context",()=>{
  const panel=readFileSync(join(root,"ui","src","components","SourceControlPanel.jsx"),"utf8");
  assert.match(panel,/sourceControlErrorAfterContextChange\(current,previous,context\)/,"a context change filters the error on screen");
  assert.match(panel,/if\(!sourceControlContextCurrent\(previous,context,"writer"\)\)cancelTextRequests\(\)/,"a writer or repository change cancels Git text in flight");
  assert.match(panel,/const \[textRequests\]=useState\(createGitTextRequests\)/,"commit text and pull request text are tracked per kind");
  assert.ok(panel.includes('api("/api/git/commit-message",{method:"POST",body:environmentBody({cwd:projectPath,model}),signal:request.controller.signal})'),"the commit text request can be cancelled");
  assert.match(panel,/catch\(e\)\{if\(textRequests\.current\(request\)\)setError\(e\.message,"writer"\)\}/,"a Git text error is a writer error, shown only while its request is current");
  const app=readFileSync(join(root,"ui","src","App.jsx"),"utf8");
  assert.match(app,/<SourceControlPanel [^>]*agentRuntimeInstanceId=\{sourceControlRuntimeInstanceId\}/,"the panel knows which harness profile writes the text");
});

test("linked pull requests answered after a thread change update that thread, not the open one",()=>{
  const panel=readFileSync(join(root,"ui","src","components","SourceControlPanel.jsx"),"utf8");
  const sync=panel.slice(panel.indexOf("async function syncLinkedPullRequests("),panel.indexOf("async function loadViewed("));
  assert.match(sync,/if\(result\?\.links\)onLinkedPullRequestsChanged\?\.\(result\.links\);/,"a finished sync always reports its thread's links");
  assert.match(sync,/reportError\(started,[^;]+,"thread"\)/,"its error only shows while that thread is shown");
  const app=readFileSync(join(root,"ui","src","App.jsx"),"utf8");
  const apply=app.slice(app.indexOf("function applyThreadPullRequestLinks("),app.indexOf("async function linkPr("));
  // The render that started the link or sync still names the old thread, so its own activeThread would always match.
  assert.match(apply,/if\(activeThreadRef\.current\?\.id===threadId\)setLinkedPullRequests\(next\);/,"only the thread open now shows the links");
  assert.match(apply,/setThreadMeta\(previous=>\(\{\.\.\.previous,\[threadId\]:/,"the thread that asked keeps its links");
  assert.doesNotMatch(apply,/activeThread\?\.id===threadId/);
});

test("the goal panel starts afresh for another thread, and a late answer never lands in it",()=>{
  const app=readFileSync(join(root,"ui","src","App.jsx"),"utf8");
  const goal=app.slice(app.indexOf('if(rightPanelTab==="goal")'),app.indexOf('return <div className="runtime-surface">'));
  assert.match(goal,/const goalThreadId=activeThread\?\.id\|\|null/);
  assert.match(goal,/<GoalPanel key=\{goalThreadId\?"goal:"\+goalThreadId:"goal:none"\}/,"no earlier thread's error or draft stays on screen");
  assert.match(goal,/forGoalThread=apply=>next=>\{if\(goalThreadId&&activeThreadRef\.current\?\.id===goalThreadId\)apply\(next\)\}/,"a save that answers after another thread opened is not shown there");
  assert.match(goal,/onGoal=\{forGoalThread\(setGoal\)\}/);
  assert.match(goal,/onContinuity=\{forGoalThread\(setContinuity\)\}/);
  assert.doesNotMatch(goal,/onGoal=\{setGoal\}|onContinuity=\{setContinuity\}/);
});
