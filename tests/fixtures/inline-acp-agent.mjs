// An ACP agent written by the test itself, run over stdio by a real AcpClient, for the client's framing and its handling of what
// it cannot read: source is the agent's handler of each message m that Trebell sends, with send(message) writing one line as
// JSON.stringify writes it, raw(text) writing text as it is, update(sessionId,update) sending a session/update, and LS and PS
// standing for U+2028 and U+2029.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpClient } from "../../src/acp-client.mjs";

export async function inlineAcpAgent(t,source,options={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-inline-acp-")),fixture=join(root,"agent.mjs");
  await writeFile(fixture,String.raw`
import readline from "node:readline";
const LS=String.fromCharCode(0x2028),PS=String.fromCharCode(0x2029);
const send=message=>process.stdout.write(JSON.stringify(message)+"\n"),raw=text=>process.stdout.write(text);
const update=(sessionId,update)=>send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update}});
readline.createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);${source}});
`,"utf8");
  const client=new AcpClient({command:process.execPath,args:[fixture],cwd:root,timeoutMs:20_000,...options});
  const warnings=[];client.on("protocolWarning",warning=>warnings.push(warning));
  t.after(async()=>{await client.stop().catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})});
  return {client,warnings};
}

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// The promise's value, or a failure saying what never came, after ms.
export const within=(promise,ms,what)=>Promise.race([promise,sleep(ms).then(()=>{throw new Error(what+" never came")})]);

// The rejections nothing handled while the test ran (Node's default ends the process on the first), read once the ones already
// due have been told.
export function unhandledRejections(t){
  const seen=[],spy=reason=>seen.push(reason);process.on("unhandledRejection",spy);t.after(()=>process.off("unhandledRejection",spy));
  return async()=>{await new Promise(resolve=>setImmediate(resolve));return seen.map(reason=>String(reason?.stack||reason))};
}
