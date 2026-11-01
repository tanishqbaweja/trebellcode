// What the redaction of text only a person reads (forPeople) does at the edges of each shape it hides, in the order it hides them,
// and what an agent's log keeps and quotes: the cases the other redaction tests leave out. Text a model reads is redacted as 2.1.2
// redacted it (secret-redactor-model.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { PAIRING_LINK_MARK, redactSecretText, replaceWebAddresses, showsRedactionMark } from "../src/secret-redactor.mjs";
import { AGENT_LOG_KEPT_CHARS, SIGN_IN_LINK_MARK, agentLogExcerpt, excerptAskedForSignIn, extendAgentLog, hideGoogleSignInLinks } from "../src/agent-log.mjs";

const plain=text=>redactSecretText(text,{environment:{},forPeople:true});
const homes=(text,environment)=>redactSecretText(text,{environment,redactHomes:true,forPeople:true});

test("the text loses its NUL characters, and home folders go only when asked, the longest first",()=>{
  assert.equal(plain("a\0b\0"),"ab");
  assert.equal(homes("/home/ada/work/x /home/ada/y",{HOME:"/home/ada/work",USERPROFILE:"/home/ada"}),"~/x ~/y");
  assert.equal(homes("/home/ada/work/x /home/ada/y",{HOME:"/home/ada",USERPROFILE:"/home/ada/work"}),"~/x ~/y","a home inside another goes whole");
  assert.equal(redactSecretText("/home/ada/work/x",{environment:{HOME:"/home/ada/work"}}),"/home/ada/work/x");
  assert.equal(homes("/a/b C:\\x D:/y",{HOME:"/",USERPROFILE:"C:\\"}),"/a/b C:\\x D:/y","a root is never a home folder");
  assert.equal(homes("x/y ~/z",{HOME:"x",USERPROFILE:"~"}),"x/y ~/z","nor a folder that is not absolute");
});

test("a home folder goes only where it ends, without its trailing separators, in both slash spellings",()=>{
  assert.equal(homes("/home/ada/x /home/adam/y /home/ada. /home/ada",{HOME:"/home/ada/"}),"~/x /home/adam/y ~. ~");
  assert.equal(homes("C:\\Users\\mira\\x C:/Users/mira/y C:\\Users\\miranda",{USERPROFILE:"C:\\Users\\mira"}),"~\\x ~/y C:\\Users\\miranda");
});

test("the environment's secret values go longest first, from six characters, and a list given for them is used as it is",()=>{
  const environment={A_TOKEN:"abcdef",B_TOKEN:"abcdefgh",C_TOKEN:"abcde",PLAIN:"plainvalue"};
  assert.equal(redactSecretText("abcdefgh abcdef abcde plainvalue",{environment}),"[redacted] [redacted] abcde plainvalue");
  assert.equal(redactSecretText("one two",{environment:{X_TOKEN:"one two"},_environmentSecrets:["two"]}),"one [redacted]");
  assert.equal(redactSecretText("  key: \tpadded-secret  ",{environment:{X_TOKEN:" \tpadded-secret "},trim:true}),"key:[redacted]","trim comes after the values");
});

test("a pairing link goes whole wherever its scheme starts, the address ending at white space, a quote, < > or a backtick",()=>{
  assert.equal(plain("xhttps://a/pair#b c"),"x"+PAIRING_LINK_MARK+" c");
  assert.equal(plain("HTTP://A/PAIR#X"),PAIRING_LINK_MARK);
  assert.equal(plain("http://pair#x"),"http://pair#x","the slash before pair# must come after ://");
  assert.equal(plain("http://a http://b/pair#c"),"http://a "+PAIRING_LINK_MARK);
  assert.equal(plain("https://x/?next=http://b/pair#c"),PAIRING_LINK_MARK,"a pairing link inside another address takes the outer one");
  assert.equal(plain('"http://b/pair#c" <http://d/pair#e> `http://f/pair#g`'),`"${PAIRING_LINK_MARK}" <${PAIRING_LINK_MARK}> \`${PAIRING_LINK_MARK}\``);
  const long="http://".repeat(100_000);
  assert.equal(plain(long),long,"a long run of schemes takes linear time");
});

test("the user part of an address goes, wherever its scheme starts",()=>{
  assert.equal(plain("git+ssh://user@host:repo"),"git+ssh://[redacted]@host:repo");
  assert.equal(plain("a://b://c@d"),"a://b://[redacted]@d");
  assert.equal(plain("-://u@h https://host/a@b"),"-://u@h https://host/a@b");
});

test("web addresses are read once each, from their first scheme, and kept when the picker keeps them",()=>{
  const seen=[];
  assert.equal(replaceWebAddresses("a https://x/?u=http://y b HTTP://Z",address=>{seen.push(address);return null}),"a https://x/?u=http://y b HTTP://Z");
  assert.deepEqual(seen,["https://x/?u=http://y","HTTP://Z"]);
  assert.equal(replaceWebAddresses("go http://a/b now",()=>"<link>"),"go <link> now");
});

test("an Authorization header keeps its name and scheme as printed and loses the credential",()=>{
  assert.equal(plain("authorization: bearer abc.def/ghi+j=k-l_m next"),"authorization: bearer [redacted] next");
  assert.equal(plain("Authorization:Basic dXNlcjpwYXNz rest"),"Authorization:Basic [redacted] rest");
  assert.equal(plain("Proxy-Authorization: Negotiate YIIGhgYGKwYBBQUC"),"Proxy-Authorization: Negotiate [redacted]");
  assert.equal(plain("Authorization: token gto_fixture42 then"),"Authorization: token [redacted] then");
  assert.equal(plain('{"Authorization":"Basic Zm9vOmJhcg=="}'),'{"Authorization":"Basic [redacted]"}');
  // Re-pinned note: without a scheme word only a JWT goes now, as typed code writes the same shape (authorization: Uint8Array).
  assert.equal(plain("Authorization: abc123secret sent"),"Authorization: abc123secret sent","a value without a scheme word stays");
  assert.equal(plain("Authorization: token OAUTH-TOKEN"),"Authorization: token OAUTH-TOKEN","a placeholder in capitals after token stays");
  assert.equal(plain('curl -H "Authorization: Bearer $OPENAI_API_KEY"'),'curl -H "Authorization: Bearer $OPENAI_API_KEY"',"a variable's name is no credential");
});

test("a Bearer token goes whole wherever it is printed, ~ and = included, the scheme as printed",()=>{
  assert.equal(plain("bearer abc~def"),"bearer [redacted]");
  assert.equal(plain("sent BEARER\tq+w/e=r== to it"),"sent BEARER\t[redacted] to it");
  assert.equal(plain("then Bearer [redacted] again"),"then Bearer [redacted] again","a mark is no token");
  assert.equal(plain("Bearer\nTOKEN123"),"Bearer\n[redacted]","a token on the next line");
  assert.equal(plain("Bearer\n  eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln"),"Bearer\n  [redacted]","a JWT on the next line");
});

// A line that ends in the word bearer is often not a header: the next line keeps its words unless they look issued.
test("a word on the line after bearer stays unless it has a credential's shape",()=>{
  for(const text of [
    "// the token goes in as a bearer\n// <token> in the WebSocket handshake",
    "      scheme: bearer\n      bearerFormat: JWT",
    "the bearer\nof the token",
  ])assert.equal(plain(text),text);
});

test("key headers lose their value to the next white space or quote, name as printed",()=>{
  assert.equal(plain("X-API-KEY:abc def"),"X-API-KEY:[redacted] def");
  assert.equal(plain("x-goog-api-key: AIzaSyFixture_0123 next"),"x-goog-api-key: [redacted] next");
  assert.equal(plain("PRIVATE-TOKEN: glpat-fixture-0123"),"PRIVATE-TOKEN: [redacted]");
  // Re-pinned: this short string with a comma and a semicolon was hidden only because it was quoted. A quoted value is now judged
  // by its shape like any other, so a placeholder such as this one stays, and a key-shaped one still goes.
  assert.equal(plain("'x-api-key': 'k,1;2'"),"'x-api-key': 'k,1;2'");
  assert.equal(plain("'x-api-key': 'a1b2c3d4e5f6g7h8i9'"),"'x-api-key': '[redacted]'");
  assert.equal(plain("x-api-key: sk-ant-api03-abcdefghijklmnop, next"),"x-api-key: [redacted], next","a comma after a header line's value stays");
  assert.equal(plain("sent X-API-KEY:[redacted] once"),"sent X-API-KEY:[redacted] once","a mark is no key");
});

// Native's tools pass every file they read through the redactor, so source code that names these headers must come back as it is
// written: a copy of it that an edit is matched against, or a file written back whole, would otherwise carry the mark.
test("code that names an Authorization or key header keeps its words, and a value with a credential's shape still goes",()=>{
  const code=[
    "def view(request, authorization: str = None):",
    'headers = {"Authorization": f"token {self.token}"}',
    "{ headers: { Authorization: apiKey } }",
    '{"x-api-key": key, "x-goog-api-key": apiKey}',
    "'PRIVATE-TOKEN': token,",
    "authorization: Optional[str]",
    "authorization: enabled",
    "headers:{Authorization:basicAuth(server.password)}",
    "{Authorization:await bitbucketAuthorization()}",
    "authorization: this.authorizationHeaderValue2",
    "const h={Authorization:`Bearer ${token}`}",
    '{"x-api-key": "${API_KEY}"}',
    // Placeholders tests write in strings, member chains, and a value that ends like an object entry.
    'headers={"Authorization": "invalid"}',
    'headers={"Authorization": "Basic notabase64token"}',
    '{"x-api-key": "wrong"}',
    "  Authorization: base64Auth,",
    "{ authorization: requestContext.headers.authorization }",
    "res.set({ Accept: 'text/plain', 'X-API-Key': 'tobi' })",
    'request({headers:{Authorization:"token fixture-token"}})',
    // A real line break, so this file's own text keeps the case too.
    `{
  authorization: authHeader2
}`,
    'Authorization: Digest username="Mufasa", realm="http-auth@example.org"',
    // Typed declarations with no semicolon or comma after the type.
    `interface H {
  authorization: Uint8Array
  host: string
}`,
    `class Creds(BaseModel):
    authorization: Base64Str
    user: str`,
    "async def f(authorization: OAuth2PasswordBearer = Depends(s)):",
    "let authorization: Sha256Digest = digest(body)",
    "authorization: AUTH_TOKEN_2",
    "authorization: Token = Depends(get_token)",
  ];
  for(const line of code)assert.equal(plain(line),line);
  // Re-pinned note: a bare value without a scheme word is no longer judged by its shape; only a JWT goes (next line).
  assert.equal(plain("Authorization: s3cr3tvalue then"),"Authorization: s3cr3tvalue then","no scheme word, no JWT");
  // Re-pinned note: this value still goes, now because it is random-looking text of 20 characters (a string must reach 16), not
  // because a quoted value was always taken.
  assert.equal(plain('"Authorization": "0123456789abcdefghij"'),'"Authorization": "[redacted]"',"a string with a key's shape");
  assert.equal(plain('{"Authorization": "Basic YTpi"}'),'{"Authorization": "Basic [redacted]"}',"a Basic string that decodes to user:pass");
  assert.equal(plain("sent authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln first"),"sent authorization: [redacted] first","a JWT, to its end");
  assert.equal(plain('{"x-goog-api-key": "AIzaSyFixture_0123"}'),'{"x-goog-api-key": "[redacted]"}');
  assert.equal(plain('curl -H "Authorization: token abc123secret" https://api.example.test'),'curl -H "Authorization: token [redacted]" https://api.example.test',
    "a header line in a quoted shell argument");
});

test("issued tokens go by the prefix their issuer documents, as words of their own, case as written",()=>{
  // Re-pinned note: GitHub's program-issued gho_, ghu_, ghs_ and ghr_ tokens stay as printed, as 2.1.2 left them, and ghp_ takes
  // letters and digits only, GitHub's base62.
  assert.equal(plain("ghp_abc ghp_ github_pat_ab_c gho_a1 ghu_b2 ghs_c3 ghr_d4 ghx_e5"),"[redacted] ghp_ [redacted] gho_a1 ghu_b2 ghs_c3 ghr_d4 ghx_e5");
  assert.equal(plain("ghp_a1_b2"),"ghp_a1_b2","a ghp_ word that goes on with _ is a name");
  assert.equal(plain("my_ghp_abc"),"my_ghp_abc","a prefix inside a word is no token");
  for(const line of ["ghs_count = len(x)","gho_users.append(u)","ghr_version=0.16.2","xapp-settings.json","xwfp-runner.yml"])
    assert.equal(plain(line),line,"a name in code that starts like a token stays");
  assert.equal(plain("xoxb-1-2 xoxp-3 xox-1 xoxz-4 xapp-1-A0B xoxe.xoxp-1-abc xoxe-1-def"),"[redacted] [redacted] xox-1 xoxz-4 [redacted] [redacted] [redacted]");
  assert.equal(plain("xwfp-1-abc xoxe.xapp-1-A2 xoxe.xoxb-1-b3 xoxa-2-c4 xoxr-d5"),"[redacted] [redacted] [redacted] [redacted] [redacted]");
  assert.equal(plain("xoxc-1234-5678-abcdef xoxd-abcdef xoxs-1234-abc"),"[redacted] [redacted] [redacted]","the browser's client token and cookie, and xoxs-");
  assert.equal(plain("Cookie: d=xoxd-KZgwvDbq9N2m2hU%2FHYNnL1nRaKz%2BfFwMr8Q0Wq%3D%3D; d-s=1700000000"),"Cookie: d=[redacted]; d-s=1700000000",
    "a d cookie goes whole, its percent escapes included");
});

// Re-pinned note: an sk- key now takes letters, digits and - only and ends its word, with 9 after the prefix and a digit among them
// (was 16 with _ and no digit asked).
test("an sk- key needs 9 letters, digits or - after its prefix, a digit among them, and ends its word, and a key holding another token goes once",()=>{
  assert.equal(plain("sk-abcdef1h sk-learning"),"sk-abcdef1h sk-learning","8 is too few");
  assert.equal(plain("sk-abcdef1hi"),"[redacted]");
  assert.equal(plain("sk-abcdefghi sk-abcdefghijklmnop"),"sk-abcdefghi sk-abcdefghijklmnop","no digit, no key");
  assert.equal(plain("sk-abcdefgh1jklmnop- sk-SK sk-learn"),"[redacted]- sk-SK sk-learn","a hyphen after the key stays");
  assert.equal(plain("SK-abcdefghijklmnop"),"SK-abcdefghijklmnop");
  assert.equal(plain("sk-ant-api03-Ab1cD2eF3gH4-x_y"),"[redacted]-x_y","to the last hyphen before a run that goes on with _");
  assert.equal(plain("sk-proj-Ab_cD-eF_gH0123456789"),"sk-proj-Ab_cD-eF_gH0123456789","too short before its first _");
  assert.equal(plain("sk-abcdefgh-xoxb-123456"),"[redacted]");
  for(const line of ['<div class="sk-toggleable__content fitted">',"element.closest('.sk-toggleable__content');",
    "#$id input.sk-toggleable__control:checked~label.sk-toggleable__label-arrow:before {",
    `f'<input class="sk-toggleable__control sk-hidden--visually" id="{est_id}" '`,'<a class="sk-estimator-doc-link fitted">'])
    assert.equal(plain(line),line,"scikit-learn's CSS classes stay");
});

test("a named secret's value stops at white space, a comma or a semicolon, and a secret flag's value goes",()=>{
  assert.equal(plain("password = hunter2, next"),"password = [redacted], next");
  assert.equal(plain("API-KEY:abc;def"),"API-KEY:[redacted];def");
  assert.equal(plain("--TOKEN\tabc def"),"--TOKEN\t[redacted] def");
  assert.equal(plain("--tokens abc"),"--tokens abc");
});

// Re-pinned note: the mark test serves text a model reads, so it knows that text's marks, [redacted] and [pairing-url], as 2.1.2
// did; the marks of text only a person reads are not among them.
test("a redaction mark of text a model reads is told in any case",()=>{
  for(const text of ["[redacted]","x [REDACTED] y","[pairing-url]"])assert.equal(showsRedactionMark(text),true,text);
  for(const text of ["redacted","[redactedx]","[pairing]","",PAIRING_LINK_MARK,SIGN_IN_LINK_MARK])assert.equal(showsRedactionMark(text),false,text);
});

test("a sign-in link goes only where asked, also inside another address, on Google's own sign-in host only",()=>{
  assert.equal(hideGoogleSignInLinks("Bearer abc https://example.test/?next=https://accounts.google.com/o  "),"Bearer abc https://example.test/?next="+SIGN_IN_LINK_MARK+"  ");
  assert.equal(plain("https://accounts.google.com/o"),"https://accounts.google.com/o");
  assert.equal(hideGoogleSignInLinks("https://accounts.google.com.example/x HTTPS://ACCOUNTS.GOOGLE.COM:443/o https://u@accounts.google.com"),
    "https://accounts.google.com.example/x "+SIGN_IN_LINK_MARK+" "+SIGN_IN_LINK_MARK);
  assert.equal(hideGoogleSignInLinks('open "https://accounts.google.com/signin?x=1".'),`open "${SIGN_IN_LINK_MARK}".`);
  const long="https://accounts.google.co".repeat(20_000);
  assert.equal(hideGoogleSignInLinks(long),long,"a long run of near misses takes linear time");
});

test("an excerpt hides secrets first, then the sign-in link the secret sat in, and trims last",()=>{
  assert.equal(agentLogExcerpt("  https://accounts.google.com/?x-api-key:abc  ",{}),SIGN_IN_LINK_MARK);
  assert.equal(agentLogExcerpt("\0 X-Api-Key: k1 \0",{}),"X-Api-Key: [redacted]");
  assert.equal(excerptAskedForSignIn(agentLogExcerpt("Sign in: http://accounts.google.com/AccountChooser",{})),true);
  assert.equal(excerptAskedForSignIn(agentLogExcerpt("listening on http://127.0.0.1:4000",{})),false);
});

test("an agent's log keeps its newest 4,096 characters, a Buffer read as text and a missing piece as nothing",()=>{
  assert.equal(AGENT_LOG_KEPT_CHARS,4096);
  assert.equal(extendAgentLog("ab",Buffer.from("cd")),"abcd");
  assert.equal(extendAgentLog(undefined,"x"),"x");
  assert.equal(extendAgentLog(null,null),"");
  const full="y".repeat(4096);
  assert.equal(extendAgentLog("",full),full);
  assert.equal(extendAgentLog("z",full),full);
  assert.equal(extendAgentLog(full,"z"),full.slice(1)+"z");
});
