// An ACP agent's log excerpt, as an error or warning shows it, keeps no Google sign-in page address (T3 stderr.ts): its state and
// the local address it answers to become [sign-in-url]. Trebell Native's redaction (redactSecretText) leaves such an address as it
// was, and its other redactions are the same as before.
import test from "node:test";
import assert from "node:assert/strict";
import { AcpClient, sanitizeAcpStderrExcerpt } from "../src/acp-client.mjs";
import { redactSecretText, redactSignInUrls } from "../src/secret-redactor.mjs";

const SIGN_IN="https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture-client&state=oauth-state-value&redirect_uri=http://127.0.0.1:4567/&response_type=code";

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

test("Trebell Native's redaction leaves a sign-in address as it was, and redacts the rest as before",()=>{
  const text=["Read "+SIGN_IN,"Authorization: Bearer bearer-value","https://localhost/pair#token=PAIRSECRET"].join("\n");
  assert.equal(redactSecretText(text,{environment:{}}),["Read "+SIGN_IN,"Authorization: Bearer [redacted]","[pairing-url]"].join("\n"));
});
