import test from "node:test";
import assert from "node:assert/strict";
import { redactSecretText, redactSecretValue } from "../src/secret-redactor.mjs";

test("secret redactor removes common credential formats and exact secret env values",()=>{
  const environment={HOME:"/home/ada",CUSTOM_SERVICE_TOKEN:"odd-value-not-shaped-like-a-known-token"};
  const text=redactSecretText([
    "path=/home/ada/project",
    "Authorization: Bearer bearer-value",
    "x-api-key: private-key",
    "token=ghp_abcdefghijklmnopqrstuvwxyz",
    "custom=odd-value-not-shaped-like-a-known-token",
    "https://localhost/pair#token=PAIRSECRET",
    "https://runner:opaque-password@example.test/repository.git",
  ].join("\n"),{environment,redactHomes:true});
  assert.match(text,/path=~\/project/);
  assert.match(text,/Bearer \[redacted\]/);
  assert.match(text,/\[pairing-url\]/);
  assert.doesNotMatch(text,/bearer-value|private-key|ghp_|odd-value-not-shaped|PAIRSECRET|opaque-password/);
  assert.match(text,/https:\/\/\[redacted\]@example\.test\/repository\.git/);
});

test("secret redactor recursively scrubs sensitive keys and CLI flag values",()=>{
  const value=redactSecretValue({
    authorization:"Bearer nope",
    nested:{clientSecret:"top-secret",note:"safe"},
    command:["tool","--token","plain-token","--flag","safe"],
  });
  assert.equal(value.authorization,"[redacted]");
  assert.equal(value.nested.clientSecret,"[redacted]");
  assert.equal(value.nested.note,"safe");
  assert.deepEqual(value.command,["tool","--token","[redacted]","--flag","safe"]);
});
