// Text that can reach a model is redacted as Trebell 2.1.2 redacted it, the release Trebell Native was benchmarked with, so Native
// reads what it read there. Each line below is made up; beside it is the text 2.1.2 gave for it, called as the shared tool gateway
// calls the redactor on a tool's result. The wider shapes are for text only a person reads (secret-redactor-shapes.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { redactSecretText, redactSecretValue, showsRedactionMark } from "../src/secret-redactor.mjs";

const asToolResult=value=>redactSecretValue(value,{environment:{},maxDepth:12,maxArray:500,maxFields:1000});

const AS_2_1_2=[
  ["curl -H \"Authorization: token 0123456789abcdef42\" https://api.github.example/user",
    "curl -H \"Authorization: token 0123456789abcdef42\" https://api.github.example/user"],
  ["Authorization: token gto_fixture42 then",
    "Authorization: token gto_fixture42 then"],
  ["Proxy-Authorization: Negotiate YIIGhgYGfixture42",
    "Proxy-Authorization: Negotiate YIIGhgYGfixture42"],
  ["Authorization: Digest abc123def456",
    "Authorization: Digest abc123def456"],
  ["{\"Authorization\": \"0123456789abcdefghij\"}",
    "{\"Authorization\": \"0123456789abcdefghij\"}"],
  ["headers = {'Authorization': 'token abc123def456ghi789jkl'}",
    "headers = {'Authorization': 'token abc123def456ghi789jkl'}"],
  ["headers = {\"x-goog-api-key\": \"AIzaFixture42\"}",
    "headers = {\"x-goog-api-key\": \"AIzaFixture42\"}"],
  ["x-goog-api-key: AIzaFixture42",
    "x-goog-api-key: [redacted]"],
  ["headers = {\"x-api-key\": \"abcd1234efgh5678ijkl\"}",
    "headers = {\"x-api-key\": \"abcd1234efgh5678ijkl\"}"],
  ["PRIVATE-TOKEN: glpat-fixture42",
    "PRIVATE-TOKEN: glpat-fixture42"],
  ["curl --header \"PRIVATE-TOKEN: glpat-fixture42\" https://gitlab.example/api/v4/projects",
    "curl --header \"PRIVATE-TOKEN: glpat-fixture42\" https://gitlab.example/api/v4/projects"],
  ["  PRIVATE-TOKEN: hunter2",
    "  PRIVATE-TOKEN: hunter2"],
  ["authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
    "authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"],
  ["SLACK_APP_TOKEN=xapp-1-A0FIXTURE-42-abcdef",
    "SLACK_APP_TOKEN=xapp-1-A0FIXTURE-42-abcdef"],
  ["xwfp-1-abc0123456789",
    "xwfp-1-abc0123456789"],
  ["d=xoxd-abc%2Fdef%3D0123",
    "d=[redacted]%2Fdef%3D0123"],
  ["xoxe.xoxp-1-abc123",
    "xoxe.[redacted]"],
  ["xoxz-4 xoxA-5 xox-1",
    "[redacted] [redacted] xox-1"],
  ["authorization: basic Zm9vOmJhcg==",
    "Authorization: Basic [redacted]"],
  ["authorization: bearer abc123",
    "authorization: Bearer [redacted]"],
  ["Use a bearer token here",
    "Use a Bearer [redacted] here"],
  ["X-API-KEY:   fixture0123456789",
    "x-api-key: [redacted]"],
  ["curl -H \"Authorization: Basic Zm9vOmJhcg==\" https://example.test",
    "curl -H \"Authorization: Basic [redacted] https://example.test"],
  ["Authorization: Basic $(printf user:pass | base64)",
    "Authorization: Basic [redacted] user:pass | base64)"],
  ["x-api-key: $ANTHROPIC_API_KEY",
    "x-api-key: [redacted]"],
  ["Bearer\n  plainword",
    "Bearer [redacted]"],
  ["token_type: bearer\n  expires_in: 3600",
    "token_type: Bearer [redacted]: 3600"],
  ["bearer abc~def",
    "Bearer [redacted]~def"],
  ["open https://trebell.example/pair#abcdef0123456789",
    "open [pairing-url]"],
  ["see \"http://b/pair#c\" <http://d/pair#e>",
    "see \"[pairing-url] <[pairing-url]"],
  ["sk-abcdefghij and sk-abcdefgh1",
    "[redacted] and [redacted]"],
  ["OPENAI_API_KEY_EXAMPLE sk-proj-Ab1cD2eF3gH4-x_yZ",
    "OPENAI_API_KEY_EXAMPLE [redacted]x_yZ"],
  ["sk-abcdef1h",
    "[redacted]"],
  ["ghp_abc123 ghp_a1_b2 github_pat_11AB_cd",
    "[redacted] ghp_a1_b2 [redacted]"],
  ["api_key = abc123",
    "api_key = [redacted]"],
  ["--token abc123",
    "--token [redacted]"],
  ["https://user:pass@example.com/x",
    "https://[redacted]@example.com/x"],
];

test("each line of a tool's result reads as 2.1.2 gave it",()=>{
  for(const [line,shown] of AS_2_1_2)assert.equal(asToolResult(line),shown,line);
});

test("a tool's result object keeps its form, its secret keys and flag values going as 2.1.2 sent them",()=>{
  const text="PRIVATE-TOKEN: glpat-fixture42\nAuthorization: token abc123secret";
  assert.deepEqual(asToolResult({content:[{type:"text",text}],command:["git","--token","t0k3n"],apiKey:"z"}),
    {content:[{type:"text",text}],command:["git","--token","[redacted]"],apiKey:"[redacted]"});
});

test("a command quoted to a gate writes home folders as 2.1.2 did: HOME, USERPROFILE, then the account's home",()=>{
  const environment={HOME:"/home/ada",USERPROFILE:"/home/ada/work"};
  assert.equal(redactSecretText(" cat /home/ada/work/x /home/adam/y ",{environment,redactHomes:true,trim:true}),"cat ~/work/x ~m/y");
  const windows={USERPROFILE:["C:","Users","ada"].join(String.fromCharCode(92))};
  assert.equal(redactSecretText("C:/Users/ada/x",{environment:windows,redactHomes:true}),"C:/Users/ada/x","only as written");
});

test("the marks of text a model reads are [redacted] and [pairing-url], in any case",()=>{
  for(const text of ["[redacted]","x [REDACTED] y","[pairing-url]","[Pairing-URL]"])assert.equal(showsRedactionMark(text),true,text);
  for(const text of ["redacted","[redacted pairing link]","[redacted sign-in link]","[pairing]",""])
    assert.equal(showsRedactionMark(text),false,text);
});

test("text only a person reads takes the wider shapes",()=>{
  const forPeople=text=>redactSecretText(text,{environment:{},forPeople:true});
  assert.equal(forPeople("Authorization: token gto_fixture42 then"),"Authorization: token [redacted] then");
  assert.equal(forPeople("PRIVATE-TOKEN: glpat-fixture42"),"PRIVATE-TOKEN: [redacted]");
  assert.equal(forPeople("open https://trebell.example/pair#abc"),"open [redacted pairing link]");
  assert.equal(redactSecretValue({text:"xwfp-1-abc0123456789"},{environment:{},forPeople:true}).text,"[redacted]");
});
