import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuiServer } from "../src/gui-server.mjs";

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(condition,timeoutMs,what){
  for(const deadline=Date.now()+timeoutMs;!condition();){if(Date.now()>deadline)throw new Error("Timed out waiting for "+what);await sleep(20)}
}

// Playwright's request context, like Node's own keep-alive agent and the browser, keeps a connection open between requests and sends
// the next one on it. Node's HTTP server closes a kept-alive connection after 5 s without a request by default (and 1 s more of
// keepAliveTimeoutBuffer on Node 24), so a request sent on it at that moment met a socket the server was closing (ECONNRESET). The GUI
// server keeps an idle connection longer than its clients do.
test("a request on a kept-alive connection that sat idle for more than 5 s is answered on the same connection",{timeout:90_000},async t=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-keep-alive-"));
  await writeFile(join(home,"ui-state.json"),JSON.stringify({settings:{agentRuntime:"native",agentRuntimeInstanceId:"native-default",onboardingComplete:true}}));
  const env={...process.env,TREBELL_HOME:home,TREBELL_HISTORY_DISABLE_CLAUDE:"1",OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const gui=await createGuiServer({port,appPort,mock:true,env});
  const socket=connect(port,"127.0.0.1");
  t.after(async()=>{socket.destroy();await gui.close();await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100})});
  await once(socket,"connect");
  let received="",closedByServer=false;
  socket.setEncoding("latin1");socket.on("data",chunk=>{received+=chunk});socket.on("end",()=>{closedByServer=true});socket.on("error",()=>{});
  const answers=()=>received.split("HTTP/1.1 200 OK").length-1;
  const request=`GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`;
  socket.write(request);
  await until(()=>answers()>=1&&received.includes('{"ok":true}'),20_000,"the first answer");
  assert.doesNotMatch(received,/^connection: close/im,"the first answer keeps the connection open");
  // Idle for longer than Node's default keep-alive timeout with its buffer, as a test or a page between two requests.
  await sleep(7_500);
  assert.equal(closedByServer,false,"the server kept the idle connection open");
  socket.write(request);
  await until(()=>answers()>=2||closedByServer,20_000,"the second answer");
  assert.equal(answers(),2,"the second request is answered on the same connection");
  assert.ok(Number(/^keep-alive: timeout=(\d+)/im.exec(received)?.[1])>=60,"the server says it keeps an idle connection for a minute or more");
  assert.equal(gui.server.headersTimeout>gui.server.keepAliveTimeout,true,"the header timeout outlasts the keep-alive timeout");
});
