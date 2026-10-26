// An ACP harness that answers a session's setup with auth_required (-32000) is signed in once with its own advertised method, and
// the setup runs once more (T3 authenticateAfterRequired, selectAcpAgentAuthMethod and resolveGrokAuthMethodId): Grok with its API
// key when XAI_API_KEY is set, as xAI documents for headless clients, else with its cached login; Cursor, and any other agent, with
// the first method it runs itself, such as Cursor's cursor_login. A method initialize did not list, a sign-in the harness refuses
// and a harness still signed out after it keep the start's failure; Antigravity is never signed in from a session.
import test from "node:test";
import assert from "node:assert/strict";
import { HarnessSessionLostError } from "../src/harness-session-lost.mjs";
import { acpRelay, acpSession, scriptedAcp, select } from "./fixtures/scripted-acp.mjs";

const GROK_METHODS=[{id:"cached_token",name:"Grok login"},{id:"xai.api_key",name:"xAI API key"}];
const GROK={initialize:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}}},authMethods:GROK_METHODS},sessionNew:{sessionId:"grok-session"}};
const CURSOR_LOGIN={id:"cursor_login",name:"Cursor Login",description:"Authenticate using existing Cursor login credentials."};
const CURSOR={initialize:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[CURSOR_LOGIN]},sessionNew:{sessionId:"cursor-session",configOptions:[select("mode","mode","agent",["agent","plan","ask"]),select("model","model","default",[["default","Auto"]])]}};
const AUTH_REQUIRED=error=>error?.code===-32000&&error.message==="Authentication required";
// The requests the harness was sent, in order, with each sign-in's method.
const asked=log=>log.filter(entry=>entry.method&&entry.id!=null).map(entry=>entry.method==="authenticate"?`authenticate ${entry.params.methodId}`:entry.method);
// The harness's environment with or without an xAI API key; the session's env is the one its process starts with.
function keyed(fx,key){const env={...fx.env};delete env.XAI_API_KEY;if(key)env.XAI_API_KEY=key;return {...fx,env}}

test("a Grok profile signed in only with XAI_API_KEY starts its session once Grok signs in with xai.api_key",async t=>{
  const fx=keyed(await scriptedAcp(t,{...GROK,signIn:{methodId:"xai.api_key",env:"XAI_API_KEY"},prompts:[{}]}),"xai-fixture-key");
  const {session}=acpSession(t,fx,{runtime:"grok"});
  const started=await session.start();
  assert.equal(started.session.sessionId,"grok-session");assert.equal(session.sessionId,"grok-session");
  assert.deepEqual(asked(await fx.log()),["initialize","session/new","authenticate xai.api_key","session/new"]);
  assert.deepEqual(await session.prompt([{type:"text",text:"hi"}]),{stopReason:"end_turn"},"the session runs turns");
});

test("Grok without an API key signs in with its cached login, and a resumed conversation is resumed again after it",async t=>{
  const fx=keyed(await scriptedAcp(t,{...GROK,signIn:{methodId:"cached_token"}}),null);
  const {session}=acpSession(t,fx,{runtime:"grok"});
  const started=await session.start({providerSessionId:"thread-conversation"});
  assert.equal(started.session.sessionId,"thread-conversation");
  assert.deepEqual(asked(await fx.log()),["initialize","session/resume","authenticate cached_token","session/resume"]);
});

test("Cursor signs in with its own cursor_login, passing over a method it does not run itself, and loads the conversation again",async t=>{
  const terminal={id:"cursor_terminal",name:"Log in in a terminal",type:"terminal",args:["login"]};
  const fx=await scriptedAcp(t,{...CURSOR,initialize:{...CURSOR.initialize,authMethods:[terminal,CURSOR_LOGIN]},signIn:{methodId:"cursor_login"}});
  const {session}=acpSession(t,fx,{runtime:"cursor"});
  await session.start({providerSessionId:"cursor-thread"});
  assert.equal(session.sessionId,"cursor-thread");
  assert.deepEqual(asked(await fx.log()).slice(0,4),["initialize","session/load","authenticate cursor_login","session/load"]);
});

test("a sign-in method initialize did not list keeps the start's failure, and nothing signs in",async t=>{
  const cases=[
    ["grok",{...GROK.initialize,authMethods:[GROK_METHODS[0]]},"xai-fixture-key","the key method is not listed: no other method stands in"],
    ["grok",{...GROK.initialize,authMethods:undefined},null,"no methods at all"],
    ["cursor",{...CURSOR.initialize,authMethods:[{id:"cursor_terminal",name:"Log in in a terminal",type:"terminal"},{id:"cursor_env",name:"API key",type:"env_var"}]},null,"only methods the agent does not run itself"],
  ];
  for(const [runtime,initialize,key,why] of cases){
    const fx=keyed(await scriptedAcp(t,{...(runtime==="grok"?GROK:CURSOR),initialize,signIn:{methodId:"xai.api_key"}}),key);
    const {session}=acpSession(t,fx,{runtime});
    await assert.rejects(session.start(),AUTH_REQUIRED,why);
    assert.deepEqual(asked(await fx.log()),["initialize","session/new"],why);
  }
});

test("a sign-in the harness refuses fails the start in the harness's own words, and the setup is not asked again",async t=>{
  const fx=keyed(await scriptedAcp(t,{...GROK,signIn:{methodId:"xai.api_key",env:"XAI_API_KEY"},errors:{authenticate:{code:-32603,message:"Internal error",data:{message:"Invalid API key: the key was revoked"}}}}),"xai-revoked-key");
  const {session}=acpSession(t,fx,{runtime:"grok"});
  await assert.rejects(session.start(),error=>error.message==="Grok Build could not sign in with 'xai.api_key': Invalid API key: the key was revoked"&&error.code===-32603);
  assert.deepEqual(asked(await fx.log()),["initialize","session/new","authenticate xai.api_key"]);
});

test("a harness still signed out after its sign-in fails as before, with one sign-in and one more setup",async t=>{
  const fx=await scriptedAcp(t,{...CURSOR,signIn:{methodId:"cursor_login",keepRefusing:true}});
  const {session}=acpSession(t,fx,{runtime:"cursor"});
  await assert.rejects(session.start({providerSessionId:"cursor-thread"}),error=>!(error instanceof HarnessSessionLostError)&&error.code===-32000&&/^Cursor could not resume this conversation: Authentication required$/.test(error.message));
  assert.deepEqual(asked(await fx.log()),["initialize","session/load","authenticate cursor_login","session/load"]);
  const fresh=await scriptedAcp(t,{...CURSOR,signIn:{methodId:"cursor_login",keepRefusing:true}});
  const other=acpSession(t,fresh,{runtime:"cursor"});
  await assert.rejects(other.session.start(),AUTH_REQUIRED);
  assert.deepEqual(asked(await fresh.log()),["initialize","session/new","authenticate cursor_login","session/new"]);
});

test("Antigravity is never signed in from a session: its Google login stays Settings' own",async t=>{
  const fx=await scriptedAcp(t,{initialize:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{}}},authMethods:[{id:"oauth-personal",name:"Log in with Google"},{id:"gemini-api-key",name:"Use Gemini API key"}]},sessionNew:{sessionId:"agy-session"},signIn:{methodId:"oauth-personal"}});
  const {session}=acpSession(t,fx,{runtime:"antigravity"});
  await assert.rejects(session.start(),AUTH_REQUIRED);
  assert.deepEqual(asked(await fx.log()),["initialize","session/new"]);
});

test("a Grok thread on a profile with only XAI_API_KEY runs its turn after Grok signs in with the key",async t=>{
  const fx=keyed(await scriptedAcp(t,{...GROK,signIn:{methodId:"xai.api_key",env:"XAI_API_KEY"},prompts:[{steps:[{update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Signed in with the key."}}}]}]}),"xai-fixture-key");
  const {rpc,next,threadStore}=await acpRelay(t,"grok",fx);
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"});
  const completed=next(message=>message.method==="turn/completed");
  await rpc("turn/start",{threadId:started.thread.id,input:[{type:"text",text:"hello"}]});
  assert.equal((await completed).params.turn.status,"completed");
  const thread=threadStore.get(started.thread.id);
  assert.equal(thread.providerSessionId,"grok-session");
  assert.ok(thread.turns.at(-1).items.some(item=>item.type==="agentMessage"&&/Signed in with the key\./.test(item.text||"")),"the turn shows Grok's reply");
  const log=asked(await fx.log());
  assert.deepEqual(log.filter(method=>method.startsWith("authenticate")),["authenticate xai.api_key"],"one sign-in");
  assert.deepEqual(log.filter(method=>method==="session/new"),["session/new","session/new"]);
});
