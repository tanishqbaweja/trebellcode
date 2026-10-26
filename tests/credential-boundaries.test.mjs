// Trebell never reads a harness's stored sign-in to act for it, and never poses as another app's client (the owner's rule).
// T3 Code has three probes that do, and Trebell does not port them:
// - claudeResetCredits.ts reads Claude Code's <CLAUDE_CONFIG_DIR>/.credentials.json (claudeAiOauth.accessToken) and calls
//   Anthropic's OAuth API as claude-cli/<version>. Anthropic: "developers may not collect, store, or intermediate Claude.ai
//   credentials or session tokens".
// - cliproxyApi.ts sends the subscription's OAuth calls through a proxy as claude-code/<version>.
// - antigravityUsageLimits.ts reads Antigravity's acp_token.json (its OAuth client secret and refresh token) and calls Google's
//   internal quota endpoints as Antigravity's own client (aidev_client), the use Antigravity's terms (section 6) name.
// Cursor's usage read went out as the Cursor CLI (x-cursor-client-type: cli) too. This scan of Trebell's server and desktop code
// fails on any of them and names the file and line it found.
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAgentRuntimeUsage } from "../src/agent-usage-limits.mjs";

const ROOT=fileURLToPath(new URL("..",import.meta.url));
const SCANNED=["src","desktop"];

// What each rule finds, and what code that has it would do.
const RULES=[
  [/\.credentials\.json/,"reads Claude Code's stored Claude.ai login (.credentials.json)"],
  [/claudeAiOauth/,"reads the Claude.ai OAuth token (claudeAiOauth)"],
  [/claude-cli\//i,"poses as the Claude Code CLI (a claude-cli/ user agent)"],
  [/claude-code\/(?:v?\d|\$\{|["'`]\s*\+)/i,"poses as Claude Code (a claude-code/<version> user agent)"],
  [/\boauth-20\d\d-\d\d-\d\d\b/,"sends Anthropic's OAuth beta flag, which only a Claude.ai login carries"],
  [/x-cursor-client-type/i,"poses as the Cursor CLI (x-cursor-client-type)"],
  [/aidev_client/i,"poses as Antigravity's own client (aidev_client)"],
];
// Calls that only build a path, and the one call that may take Antigravity's token file: access(), which checks that it exists.
const PATH_BUILDERS=new Set(["join","resolve","joinPath","path.join","path.resolve","posix.join","win32.join"]);
const EXISTENCE_CHECKS=new Set(["access","fs.access","fsp.access","promises.access","fs.promises.access"]);
// Words whose parentheses are no call.
const NOT_CALLS=new Set(["if","for","while","switch","catch","return","typeof","await","void","delete","in","of","do","else","case","throw","yield"]);

const lineOf=(text,index)=>text.slice(0,index).split("\n").length;
const lineText=(text,index)=>text.split("\n")[lineOf(text,index)-1].trim().slice(0,200);

// Every call whose parentheses hold text[index], innermost first, back to the start of its statement.
function enclosingCalls(text,index){
  const calls=[];let depth=0;
  for(let at=index-1;at>=0;at--){
    const char=text[at];
    if(char===")"||char==="]"||char==="}"){depth++;continue}
    if(char==="("||char==="["||char==="{"){
      if(depth>0){depth--;continue}
      if(char==="("){
        const before=text.slice(Math.max(0,at-200),at),callee=/([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\s*$/.exec(before)?.[1]?.replaceAll("?.",".");
        // A function's parameter list starts the statement; a grouping or a keyword's parentheses are no call.
        if(/\bfunction\s*[\w$]*\s*$/.test(before))break;
        if(callee&&!NOT_CALLS.has(callee))calls.push(callee);
        continue;
      }
      // An object or array literal goes on outward; a block ends the statement.
      if(char==="["||/(?:[(,:=?[]|\breturn)\s*$/.test(text.slice(Math.max(0,at-20),at)))continue;
      break;
    }
    if(depth===0&&char===";")break;
  }
  return calls;
}
// The call that takes text[index] other than to build a path or check that it exists, if any.
const readerOf=(text,index)=>enclosingCalls(text,index).find(call=>!PATH_BUILDERS.has(call)&&!EXISTENCE_CHECKS.has(call));

// A file may name acp_token.json only to build its path and check that it exists. A path kept under a name
// (tokenPath=join(root,"acp_token.json")) is held to the same wherever that name is used in its file, and wherever another
// file reads it as a property (auth.tokenPath).
function tokenFileFindings(files){
  const findings=[],bound=new Map();
  const found=(file,text,index,what,reader)=>findings.push({file,line:lineOf(text,index),why:`reads Antigravity's acp_token.json (${what} goes to ${reader}(); only access() may check that it exists)`,text:lineText(text,index)});
  for(const {file,text} of files)for(const match of text.matchAll(/acp_token\.json/g)){
    const reader=readerOf(text,match.index);
    if(reader){found(file,text,match.index,"its path",reader);continue}
    if(enclosingCalls(text,match.index).some(call=>EXISTENCE_CHECKS.has(call)))continue;
    // A path built here: the name it is kept under is the last one assigned before it in its statement.
    const statement=text.slice(0,match.index).split(/[;\n]/).at(-1);
    const name=[...statement.matchAll(/([A-Za-z_$][\w$]*)\s*(?:=(?![=>])|:(?!:))/g)].at(-1)?.[1];
    if(name)bound.set(name,file);
  }
  for(const [name,home] of bound)for(const {file,text} of files){
    // Its own file uses the bare name; any file can read it as a property.
    const uses=new RegExp(file===home?`(?<![\\w$])${name}(?![\\w$])`:`(?<=[\\w$)\\]]\\??\\.)${name}(?![\\w$])`,"g");
    for(const match of text.matchAll(uses)){const reader=readerOf(text,match.index);if(reader)found(file,text,match.index,name,reader)}
  }
  return findings;
}

function scan(files){
  const findings=[];
  for(const {file,text} of files)text.split("\n").forEach((line,index)=>{
    for(const [pattern,why] of RULES)if(pattern.test(line))findings.push({file,line:index+1,why,text:line.trim().slice(0,200)});
  });
  return [...findings,...tokenFileFindings(files)];
}
const describe=finding=>`${finding.file}:${finding.line}: ${finding.why}\n    ${finding.text}`;

async function sources(){
  const files=[];
  for(const folder of SCANNED){
    for(const entry of await readdir(join(ROOT,folder),{recursive:true})){
      if(!/\.(?:mjs|cjs|js)$/.test(entry))continue;
      const file=(folder+"/"+entry).replaceAll("\\","/");
      files.push({file,text:await readFile(join(ROOT,folder,entry),"utf8")});
    }
  }
  return files;
}

test("no Trebell code reads a harness's stored Claude.ai or Antigravity login or poses as another app's client",async()=>{
  const files=await sources();
  assert.ok(files.some(item=>item.file==="src/agent-usage-limits.mjs")&&files.some(item=>item.file==="src/antigravity-runtime-installer.mjs"),"the scan reads src/");
  const findings=scan(files);
  assert.equal(findings.length,0,"\n"+findings.map(describe).join("\n"));
});

test("the scan names the file and line of each thing it stops, and leaves Trebell's own names and install paths alone",()=>{
  const files=[
    // T3's claudeResetCredits.ts and cliproxyApi.ts, in short.
    {file:"src/reset-credits.mjs",text:[
      'const stored=JSON.parse(await readFile(join(configDir,".credentials.json"),"utf8"));',
      "const token=stored.claudeAiOauth?.accessToken;",
      'const headers={"user-agent":`claude-cli/${version} (external, cli)`,"anthropic-beta":"oauth-2025-04-20"};',
    ].join("\n")},
    {file:"src/proxy-usage.mjs",text:'await fetch(url,{headers:{"User-Agent":"claude-code/2.1.273"}});'},
    {file:"src/cursor-usage.mjs",text:'const headers={"content-type":"application/json","x-cursor-client-type":"cli"};'},
    // T3's antigravityUsageLimits.ts, in short.
    {file:"src/agy-usage.mjs",text:[
      'const raw=await readFile(join(home,".gemini","antigravity-acp","acp_token.json"),"utf8");',
      'const agent="antigravity/hub/1.0.0 (aidev_client; windows)";',
    ].join("\n")},
    // The existence check Trebell makes, then a read of the same path, and another file reading the path it returns.
    {file:"src/agy-state.mjs",text:[
      'const root=join(home,"antigravity-acp"),settingsPath=join(root,"settings.json"),tokenPath=join(root,"acp_token.json");',
      "let tokenPresent=false;try{await access(tokenPath);tokenPresent=true}catch{}",
      'const token=JSON.parse(await readFile(tokenPath,"utf8"));',
      "return {tokenPresent,settingsPath,tokenPath};",
    ].join("\n")},
    {file:"src/agy-elsewhere.mjs",text:"const state=await readState();\nconst copy=await readFile(state?.tokenPath);"},
    // Trebell's own client name, the Claude Code package's install paths and Claude Code's own command are no one else's identity.
    {file:"src/own.mjs",text:[
      "const app=`trebell-code/${version}`,cli=join(root,\"node_modules\",\"@anthropic-ai\",\"claude-code\",\"cli.js\");",
      'const manifest="@anthropic-ai/claude-code/package.json",login=["claude","auth","login"];',
    ].join("\n")},
  ];
  const found=scan(files).map(finding=>`${finding.file}:${finding.line} ${finding.why.split(" (")[0]}`).sort();
  assert.deepEqual(found,[
    "src/agy-elsewhere.mjs:2 reads Antigravity's acp_token.json",
    "src/agy-state.mjs:3 reads Antigravity's acp_token.json",
    "src/agy-usage.mjs:1 reads Antigravity's acp_token.json",
    "src/agy-usage.mjs:2 poses as Antigravity's own client",
    "src/cursor-usage.mjs:1 poses as the Cursor CLI",
    "src/proxy-usage.mjs:1 poses as Claude Code",
    "src/reset-credits.mjs:1 reads Claude Code's stored Claude.ai login",
    "src/reset-credits.mjs:2 reads the Claude.ai OAuth token",
    "src/reset-credits.mjs:3 poses as the Claude Code CLI",
    "src/reset-credits.mjs:3 sends Anthropic's OAuth beta flag, which only a Claude.ai login carries",
  ]);
  // A failure says where and what: the file and line, the reason and the line's code.
  const [first]=scan([files[4]]);
  assert.equal(describe(first),"src/agy-state.mjs:3: reads Antigravity's acp_token.json (tokenPath goes to readFile(); only access() may check that it exists)\n    const token=JSON.parse(await readFile(tokenPath,\"utf8\"));");
});

test("Antigravity's usage limits stay unsupported, without opening its token file or calling anyone",async()=>{
  const reads=[],calls=[];
  const usage=await readAgentRuntimeUsage("antigravity",{environment:{GEMINI_HOME:"/home/me/.gemini"},platform:"linux",home:"/home/me",joinPath:join,
    readText:async path=>{reads.push(path);return "{}"},fetchImpl:async url=>{calls.push(url);return Response.json({})}});
  assert.deepEqual(usage.windows,[]);assert.deepEqual(usage.unavailable,{reason:"unsupported"});
  assert.deepEqual(reads,[]);assert.deepEqual(calls,[]);
});

test("Claude Code's plan usage comes only from Claude Code's own probe, never from its stored login or a call of Trebell's",async()=>{
  const reads=[],calls=[];let probes=0;
  await readAgentRuntimeUsage("claude",{environment:{CLAUDE_CONFIG_DIR:"/home/me/.claude"},platform:"linux",home:"/home/me",joinPath:join,
    readText:async path=>{reads.push(path);return "{}"},fetchImpl:async url=>{calls.push(url);return Response.json({})},
    readCapabilities:async()=>{probes++;return {usage:{rate_limits_available:false}}}});
  assert.equal(probes,1);assert.deepEqual(reads,[]);assert.deepEqual(calls,[]);
});
