// An ACP agent's log excerpt, as an error or warning shows it, keeps no Google sign-in page address (T3 stderr.ts): its state and
// the local address it answers to become [sign-in-url]. Trebell Native's redaction (redactSecretText) leaves such an address as it
// was, and its other redactions are the same as before. A chat whose agent exits as it starts says so in plain words: the harness,
// its exit code and what it printed, and for a log that asks for a Google sign-in, where the harness signs in instead of that link.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpAgentSession } from "../src/acp-agent-session.mjs";
import { AcpClient, sanitizeAcpStderrExcerpt } from "../src/acp-client.mjs";
import { redactSecretText, redactSignInUrls } from "../src/secret-redactor.mjs";

const SIGN_IN="https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture-client&state=oauth-state-value&redirect_uri=http://127.0.0.1:4567/&response_type=code";
const AGENT=fileURLToPath(new URL("./fixtures/antigravity-acp-agent.mjs",import.meta.url));
const KEY="AIzaSyTrebellFixtureKey0123456789abcdef";

test("an accounts.google.com address in an ACP agent's log excerpt becomes [sign-in-url]",()=>{
  const excerpt=sanitizeAcpStderrExcerpt([
    "Open the following link to authenticate the ACP server: "+SIGN_IN,
    "Authorization: Bearer secret-token-value",
    "Visit http://localhost:5733/pair#token=ABCDEF for pairing",
    "Sign in again: http://accounts.google.com/signin?continue=https%3A%2F%2Fexample.test",
  ].join("\n"));
  assert.match(excerpt,/authenticate the ACP server: \[sign-in-url\]$/m);
  assert.match(excerpt,/Sign in again: \[sign-in-url\]$/m);
  assert.doesNotMatch(excerpt,/oauth-state-value|127\.0\.0\.1:4567|accounts\.google\.com/);
  assert.match(excerpt,/Bearer \[redacted\]/);assert.match(excerpt,/\[pairing-url\]/);assert.doesNotMatch(excerpt,/secret-token-value|ABCDEF/);
  assert.equal(redactSignInUrls("see "+SIGN_IN+" then"),"see [sign-in-url] then");
});

test("an agent that exits after printing a sign-in page's address fails without it",async()=>{
  const client=new AcpClient({command:process.execPath,args:["-e",`process.stderr.write(${JSON.stringify("Waiting for "+SIGN_IN+"\n")},()=>process.exit(3))`],timeoutMs:5000});
  let failure=null;
  try{await client.start();await client.initialize()}catch(error){failure=error}finally{await client.stop()}
  assert.ok(failure,"the start failed");
  assert.match(failure.message,/^ACP runtime exited code=3/);
  assert.match(failure.message,/Waiting for \[sign-in-url\]/);
  assert.doesNotMatch(failure.message,/oauth-state-value/);
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
  const signIn=await exitingSession(t,"cursor",{exitAt:"initialize",exitCode:3,stderr:"Open the following link to authenticate the ACP server: "+SIGN_IN+"\n"});
  const said="Cursor stopped as it started, with exit code 3, asking for a Google sign-in. Sign in to Cursor in Settings, then try again.";
  await assert.rejects(signIn.session.start(),{message:said});
  assert.deepEqual(signIn.errors(),[said],"its runtime error says the same");
  // Antigravity with its key, exiting as it resumes the conversation: what it printed after how it ended, the key redacted.
  const resumed=await exitingSession(t,"antigravity",{exitAt:"session/resume",exitCode:4,stderr:"RuntimeError: conversation store is locked by "+KEY+"\n"},KEY);
  await assert.rejects(resumed.session.start({providerSessionId:"agy-thread"}),{message:"Antigravity stopped as it started, with exit code 4: RuntimeError: conversation store is locked by [redacted]"});
  // One that printed nothing, and an Antigravity whose key was saved but that asked for a Google sign-in.
  await assert.rejects((await exitingSession(t,"grok",{exitAt:"initialize",exitCode:3})).session.start(),{message:"Grok Build stopped as it started, with exit code 3."});
  await assert.rejects((await exitingSession(t,"antigravity",{exitAt:"initialize",exitCode:3,stderr:"Waiting for "+SIGN_IN+"\n"},KEY)).session.start(),
    {message:"Antigravity stopped as it started, with exit code 3, asking for a Google sign-in, which Trebell Code does not offer: it runs Antigravity on the Gemini API key saved in Settings. Check that key there, then try again."});
});

// Setting the thread's model is a start's last step (Cursor sets one on every start, Antigravity for a thread with a chosen model): a
// harness whose process ends there stopped as it started too, and says so in the same plain words, its runtime error as well, where it
// read "Antigravity could not switch to model '…': ACP runtime exited code=3 signal=null" and the hidden link.
test("an agent that exits as the start sets the thread's model says so as one that exits as it starts",async t=>{
  const said="Antigravity stopped as it started, with exit code 3, asking for a Google sign-in, which Trebell Code does not offer: it runs Antigravity on the Gemini API key saved in Settings. Check that key there, then try again.";
  const switching=await exitingSession(t,"antigravity",{exitAt:"session/set_config_option",exitCode:3,stderr:"Open the following link to authenticate the ACP server: "+SIGN_IN+"\n"},KEY);
  await assert.rejects(switching.session.start({model:"gemini-fixture-pro"}),{message:said});
  assert.deepEqual(switching.errors(),[said],"its runtime error says the same");
  // One that printed what went wrong: its exit code and what it printed, the key redacted.
  const crashed=await exitingSession(t,"antigravity",{exitAt:"session/set_config_option",exitCode:5,stderr:"RuntimeError: model store is locked by "+KEY+"\n"},KEY);
  await assert.rejects(crashed.session.start({model:"gemini-fixture-pro"}),{message:"Antigravity stopped as it started, with exit code 5: RuntimeError: model store is locked by [redacted]"});
});

test("Trebell Native's redaction leaves a sign-in address as it was, and redacts the rest as before",()=>{
  const text=["Read "+SIGN_IN,"Authorization: Bearer bearer-value","https://localhost/pair#token=PAIRSECRET"].join("\n");
  assert.equal(redactSecretText(text,{environment:{}}),["Read "+SIGN_IN,"Authorization: Bearer [redacted]","[pairing-url]"].join("\n"));
});
