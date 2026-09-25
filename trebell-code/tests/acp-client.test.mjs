import test from "node:test";
import assert from "node:assert/strict";
import { AcpClient, ACP_STDERR_TAIL_MAX_CHARS, appendAcpStderrTail, defaultAcpClientCapabilities, sanitizeAcpStderrExcerpt } from "../src/acp-client.mjs";

test("ACP initialization advertises only client features Trebell actually handles",()=>{
  assert.deepEqual(defaultAcpClientCapabilities(),{
    fs:{readTextFile:true,writeTextFile:true},
    terminal:true,
    auth:{terminal:true},
    plan:{},
    session:{compaction:{}},
    elicitation:{form:{},url:{}},
  });
});

test("ACP stderr tail stays bounded and redacts secrets before surfacing",()=>{
  const prefix="x".repeat(ACP_STDERR_TAIL_MAX_CHARS);
  assert.equal(appendAcpStderrTail(prefix,"abc"),prefix.slice(3)+"abc");
  const home=process.platform==="win32"?"C:\\Users\\ada":"/home/ada";
  const value=sanitizeAcpStderrExcerpt([
    "Invalid project config at "+home+"/.cursor/cli.json",
    "Authorization: Bearer secret-token-value",
    "Visit http://localhost:5733/pair#token=ABCDEF",
    "openai=sk-proj-abcdefghijklmnopqrstuvwxyz012345",
    "x-api-key: private-api-key",
  ].join("\n"),{...process.env,HOME:home,USERPROFILE:home});
  assert.match(value,/~\/\.cursor\/cli\.json/);
  assert.match(value,/Bearer \[redacted\]/);
  assert.match(value,/\[pairing-url\]/);
  assert.doesNotMatch(value,/secret-token-value|ABCDEF|sk-proj-|private-api-key/);
});

test("ACP startup failures include the useful stderr instead of a generic closed-session error",async()=>{
  const home=process.platform==="win32"?"C:\\Users\\fixture":"/home/fixture";
  const source=[
    "process.stderr.write("+JSON.stringify("Invalid project config at "+home+"/.cursor/cli.json: schema validation failed. Unrecognized key(s): 'approvalMode', 'sandbox'\nAuthorization: Bearer secret-startup-token\n")+");",
    "process.exit(1);",
  ].join("");
  const client=new AcpClient({command:process.execPath,args:["-e",source],env:{...process.env,HOME:home,USERPROFILE:home},timeoutMs:3000});
  let failure=null;
  try{await client.start();await client.initialize()}catch(error){failure=error}
  assert.ok(failure);
  assert.match(failure.message,/cli\.json/);
  assert.match(failure.message,/Unrecognized key/);
  assert.match(failure.message,/approvalMode/);
  assert.doesNotMatch(failure.message,/secret-startup-token/);
  assert.doesNotMatch(failure.message,/ACP runtime is not connected/);
  await client.stop().catch(()=>{});
});
