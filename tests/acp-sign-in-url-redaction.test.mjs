// An ACP agent's log excerpt, as an error or warning shows it, keeps no Google sign-in page address: the link, with its state and
// the local address it answers to, becomes [redacted sign-in link]. Trebell Native's redaction (redactSecretText) leaves such an
// address as it was, and its other redactions are the same as before. A chat whose agent exits as it starts says so in plain words:
// the harness, its exit code and what it printed, and for a log that asks for a Google sign-in, where the harness signs in instead of
// that link.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpAgentSession } from "../src/acp-agent-session.mjs";
import { AcpClient } from "../src/acp-client.mjs";
import { agentLogExcerpt, hideGoogleSignInLinks } from "../src/agent-log.mjs";
import { redactSecretText } from "../src/secret-redactor.mjs";
import { ACCOUNT_CHOOSER_LINE, BEARER_LINE, GOOGLE_SIGN_IN_URL, HIDDEN_IN_EXCERPT, PAIRING_LINE, SIGN_IN_LINE } from "./fixtures/agent-log-lines.mjs";

const AGENT=fileURLToPath(new URL("./fixtures/antigravity-acp-agent.mjs",import.meta.url));
const KEY="AIzaSyTrebellFixtureKey0123456789abcdef";
// The agent's log of a start that asks for a Google sign-in, as the stand-in prints it.
const SIGNED_OUT_LOG=SIGN_IN_LINE[0]+"\n";
const printed=lines=>lines.map(([line])=>line).join("\n"),shown=lines=>lines.map(([,line])=>line).join("\n");

test("an accounts.google.com address in an ACP agent's log excerpt becomes [redacted sign-in link]",()=>{
  const lines=[SIGN_IN_LINE,BEARER_LINE,PAIRING_LINE,ACCOUNT_CHOOSER_LINE];
  const excerpt=agentLogExcerpt(printed(lines),{});
  assert.equal(excerpt,shown(lines),"each line keeps its words, each address and token becomes its marker in place");
  assert.doesNotMatch(excerpt,HIDDEN_IN_EXCERPT);
  assert.equal(hideGoogleSignInLinks("before "+GOOGLE_SIGN_IN_URL+" after"),"before [redacted sign-in link] after","only the address changes");
});

test("an agent that exits after printing a sign-in page's address fails without it",async()=>{
  const log="Opening a browser for Google sign-in: "+GOOGLE_SIGN_IN_URL+"\n";
  const client=new AcpClient({command:process.execPath,args:["-e",`process.stderr.write(${JSON.stringify(log)},()=>process.exit(3))`],timeoutMs:5000});
  let failure=null;
  try{await client.start();await client.initialize()}catch(error){failure=error}finally{await client.stop()}
  assert.ok(failure,"the start failed");
  assert.match(failure.message,/^ACP runtime exited code=3/);
  assert.match(failure.message,/Opening a browser for Google sign-in: \[redacted sign-in link\]$/m);
  assert.doesNotMatch(failure.message,HIDDEN_IN_EXCERPT);
});

// A chat's session as the relay starts one, its harness the stand-in for Antigravity's server exiting as scenario says, with no Gemini
// API key but the one given; errors() are the runtime errors it reported.
async function exitingSession(t,runtime,scenario,key=null){
  const root=await mkdtemp(join(tmpdir(),"trebell-acp-start-exit-")),path=join(root,"scenario.json");await writeFile(path,JSON.stringify(scenario));
  const env={...process.env,TEMP:root,TMP:root,TREBELL_AGY_SCENARIO:path};delete env.GEMINI_API_KEY;delete env.GOOGLE_API_KEY;if(key)env.GEMINI_API_KEY=key;
  const updates=[],session=new AcpAgentSession({runtime,command:process.execPath,args:[AGENT],cwd:root,env,onUpdate:params=>updates.push(params.update)});
  t.after(async()=>{await session.close().catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})});
  return {session,errors:()=>updates.filter(update=>update.sessionUpdate==="runtime_error").map(update=>update.message)};
}

test("a chat whose agent exits as it starts names the harness, its exit code and what it printed, and points to its sign-in instead of a hidden link",async t=>{
  const signIn=await exitingSession(t,"cursor",{exitAt:"initialize",exitCode:3,stderr:SIGNED_OUT_LOG});
  const said="Cursor stopped as it started, with exit code 3, asking for a Google sign-in. Sign in to Cursor in Settings, then try again.";
  await assert.rejects(signIn.session.start(),{message:said});
  assert.deepEqual(signIn.errors(),[said],"its runtime error says the same");
  // Antigravity with its key, exiting as it resumes the conversation: what it printed after how it ended, the key redacted.
  const resumed=await exitingSession(t,"antigravity",{exitAt:"session/resume",exitCode:4,stderr:"RuntimeError: conversation store is locked by "+KEY+"\n"},KEY);
  await assert.rejects(resumed.session.start({providerSessionId:"agy-thread"}),{message:"Antigravity stopped as it started, with exit code 4: RuntimeError: conversation store is locked by [redacted]"});
  // One that printed nothing, and an Antigravity whose key was saved but that asked for a Google sign-in.
  await assert.rejects((await exitingSession(t,"grok",{exitAt:"initialize",exitCode:3})).session.start(),{message:"Grok Build stopped as it started, with exit code 3."});
  await assert.rejects((await exitingSession(t,"antigravity",{exitAt:"initialize",exitCode:3,stderr:ACCOUNT_CHOOSER_LINE[0]+"\n"},KEY)).session.start(),
    {message:"Antigravity stopped as it started, with exit code 3, asking for a Google sign-in, though it runs on the Google Gemini API key saved in Settings. Check that key there, then try again."});
});

// Setting the thread's model is a start's last step (Cursor sets one on every start, Antigravity for a thread with a chosen model): a
// harness whose process ends there stopped as it started too, and says so in the same plain words, its runtime error as well, where it
// read "Antigravity could not switch to model '…': ACP runtime exited code=3 signal=null" and the hidden link.
test("an agent that exits as the start sets the thread's model says so as one that exits as it starts",async t=>{
  const said="Antigravity stopped as it started, with exit code 3, asking for a Google sign-in, though it runs on the Google Gemini API key saved in Settings. Check that key there, then try again.";
  const switching=await exitingSession(t,"antigravity",{exitAt:"session/set_config_option",exitCode:3,stderr:SIGNED_OUT_LOG},KEY);
  await assert.rejects(switching.session.start({model:"gemini-fixture-pro"}),{message:said});
  assert.deepEqual(switching.errors(),[said],"its runtime error says the same");
  // One that printed what went wrong: its exit code and what it printed, the key redacted.
  const crashed=await exitingSession(t,"antigravity",{exitAt:"session/set_config_option",exitCode:5,stderr:"RuntimeError: model store is locked by "+KEY+"\n"},KEY);
  await assert.rejects(crashed.session.start({model:"gemini-fixture-pro"}),{message:"Antigravity stopped as it started, with exit code 5: RuntimeError: model store is locked by [redacted]"});
});

// Re-pinned note: text Native's model reads is redacted as 2.1.2 redacted it, so a Bearer token goes up to a ~ and a pairing link
// becomes [pairing-url]; the fixture's other forms are those of text only a person reads.
test("Trebell Native's redaction leaves a sign-in address as it was, and redacts the rest as before",()=>{
  const lines=[[SIGN_IN_LINE[0],SIGN_IN_LINE[0]],[ACCOUNT_CHOOSER_LINE[0],ACCOUNT_CHOOSER_LINE[0]],
    [BEARER_LINE[0],"GET /v1/models answered 401, retrying with Authorization: Bearer [redacted]~t/x=="],
    [PAIRING_LINE[0],"Remote control is on: pair a device at [pairing-url] within 10 minutes"]];
  assert.equal(redactSecretText(printed(lines),{environment:{}}),shown(lines));
});
