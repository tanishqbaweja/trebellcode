// The capability read's details the probe tests leave open: where the administrator's managed-mcp.json is looked for on any
// platform and with the real look, the environment and options of a read for a Claude Code started here or elsewhere, its input
// that never offers a message, the usage deadline and usage failures that are not errors, a close that throws, and when an
// account answer reads as signed out, rule by rule. Claude Code is scripted through the SDK's query: nothing is started.
import test from "node:test";
import assert from "node:assert/strict";
import { capabilityReadOptions, readClaudeCodeCapabilities } from "../src/claude-capabilities.mjs";
import { adminMcpFilePath, adminMcpFilePresent } from "../src/claude-managed-mcp.mjs";

// answer: the initialize answer; usage(args): the plan usage read; close(): the runtime's close. runs: each read's prompt and options.
function scriptedClaude({answer={models:[],commands:[],agents:[]},usage=async()=>null,close=()=>{}}={}){
  const runs=[];
  const query=({prompt,options})=>{
    const run={prompt,options,usageAsked:[]};runs.push(run);
    return {
      initializationResult:async()=>answer,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:args=>{run.usageAsked.push(args);return usage(args)},
      close,
    };
  };
  return {query,runs};
}
const read=(input={})=>readClaudeCodeCapabilities({command:"claude",managedMcpExists:()=>false,...input});
const turns=async count=>{for(let i=0;i<count;i++)await new Promise(resolve=>setImmediate(resolve))};

test("the administrator's managed-mcp.json is looked for in /etc/claude-code on every platform but macOS and Windows, and any answer of the look counts as yes or no",async()=>{
  for(const platform of ["linux","freebsd","openbsd","sunos","aix","android","toString",null])assert.equal(adminMcpFilePath(platform),"/etc/claude-code/managed-mcp.json",String(platform));
  assert.equal(adminMcpFilePath(),adminMcpFilePath(process.platform),"this machine's platform by default");
  for(const [answer,said] of [["yes",true],[1,true],[0,false],["",false],[null,false],[undefined,false]])assert.equal(await adminMcpFilePresent({platform:"darwin",exists:()=>answer}),said,JSON.stringify(answer));
  assert.equal(await adminMcpFilePresent({platform:"darwin",exists:()=>Promise.reject(new Error("EPERM"))}),false,"a rejected look counts as no file");
  // The real look, on this machine: whatever it finds, it answers yes or no.
  assert.equal(typeof await adminMcpFilePresent(),"boolean");
  assert.equal(typeof await adminMcpFilePresent({platform:"linux"}),"boolean");
});

// CLAUDE_CODE_AUTO_CONNECT_IDE is "false", the value Claude Code's documentation gives for no IDE connection. It was "0", which
// Claude Code reads the same way (its documentation: 0 and false both turn an on/off variable off).
test("the read's environment sets its three settings over the caller's, leaves FORCE_CODE_TERMINAL out and does not change the caller's",()=>{
  // The caller's environment, with values of its own for each of the read's settings and for FORCE_CODE_TERMINAL.
  const env=Object.fromEntries([["PATH","/usr/bin"],["FORCE_CODE_TERMINAL","1"],["CLAUDE_CODE_AUTO_CONNECT_IDE","1"],["CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL","0"],["ENABLE_CLAUDEAI_MCP_SERVERS","true"],["CLAUDE_CONFIG_DIR","/home/u/.claude"]]),before={...env};
  const options=capabilityReadOptions({command:"claude",env,abortController:new AbortController()});
  assert.deepEqual(options.env,{PATH:"/usr/bin",CLAUDE_CODE_AUTO_CONNECT_IDE:"false",CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL:"1",ENABLE_CLAUDEAI_MCP_SERVERS:"false",CLAUDE_CONFIG_DIR:"/home/u/.claude"});
  assert.deepEqual(env,before);assert.notEqual(options.env,env);
  const settingsOnly={ENABLE_CLAUDEAI_MCP_SERVERS:"false",CLAUDE_CODE_AUTO_CONNECT_IDE:"false",CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL:"1"};
  assert.deepEqual(capabilityReadOptions({command:"claude",env:null,abortController:new AbortController()}).env,settingsOnly);
  assert.deepEqual(capabilityReadOptions({command:"claude",abortController:new AbortController()}).env,settingsOnly);
});

test("a Claude Code started elsewhere is named as given and started by the caller's spawner, and one started here has no spawner",()=>{
  const spawnProcess=()=>{},abortController=new AbortController();
  // Spaces around the command show which way it went: the shim resolution for this machine trims it, the remote command is as given.
  const remote=capabilityReadOptions({command:" /opt/claude/bin/claude ",cwd:"/srv/repo",spawnProcess,abortController});
  assert.equal(remote.pathToClaudeCodeExecutable," /opt/claude/bin/claude ");
  assert.equal(remote.spawnClaudeCodeProcess,spawnProcess);assert.equal(remote.abortController,abortController);
  assert.equal(remote.cwd,"/srv/repo");assert.equal(remote.strictMcpConfig,true);
  assert.equal(capabilityReadOptions({command:" /opt/claude/bin/claude ",abortController}).pathToClaudeCodeExecutable,"/opt/claude/bin/claude");
  const local=capabilityReadOptions({command:"claude",abortController});
  assert.equal(Object.hasOwn(local,"spawnClaudeCodeProcess"),false);assert.equal(Object.hasOwn(local,"cwd"),false);
  assert.equal(local.persistSession,false);assert.deepEqual(local.allowedTools,[]);
  assert.equal(typeof local.stderr,"function");assert.equal(local.stderr("Warning: something\n"),undefined,"Claude Code's stderr is dropped");
});

test("the read's input offers no message, and ends at once when it is first read after the read is over",async()=>{
  const {query,runs}=scriptedClaude({answer:{models:[{value:"default",displayName:"Default"}],commands:[],agents:[]}});
  const answer=await read({query,withPlanUsage:false});
  assert.deepEqual(answer.models,[{value:"default",displayName:"Default"}]);
  assert.equal(runs[0].options.abortController.signal.aborted,true);
  const offered=[];
  for await(const message of runs[0].prompt)offered.push(message);
  assert.deepEqual(offered,[]);
  assert.deepEqual(runs[0].usageAsked,[],"usage not asked");
});

test("a plan usage read that never answers ends after 15 seconds, with the rest of the answer kept",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  let asked=false;
  const {query,runs}=scriptedClaude({answer:{models:[{value:"default",displayName:"Default"}],commands:[{name:"review"}],agents:[],account:{email:"person@example.test"}},usage:()=>{asked=true;return new Promise(()=>{})}});
  let settled=false;
  const reading=read({query});reading.then(()=>{settled=true},()=>{settled=true});
  for(let i=0;i<50&&!asked;i++)await turns(1);
  assert.equal(asked,true);assert.deepEqual(runs[0].usageAsked,[{skipBehaviors:true}]);
  t.mock.timers.tick(14_999);await turns(5);
  assert.equal(settled,false,"still waiting just before its deadline");
  t.mock.timers.tick(1);
  const answer=await reading;
  assert.equal(answer.usage,null);assert.equal(answer.usageError,"Claude Code did not report usage in time.");
  assert.deepEqual(answer.commands,[{name:"review"}]);assert.deepEqual(answer.account,{email:"person@example.test"});assert.equal(answer.signedOut,false);
});

test("a plan usage failure that is not an error is reported as text, and the usage answer is kept as Claude Code gave it",async()=>{
  for(const [thrown,said] of [["quota exceeded","quota exceeded"],[{code:7},"[object Object]"],[new Error(""),"Error"],[null,"null"]]){
    const {query}=scriptedClaude({usage:async()=>{throw thrown}});
    const answer=await read({query});
    assert.equal(answer.usage,null);assert.equal(answer.usageError,said);
  }
  const plan={session:{},rate_limits_available:false,rate_limits:null};
  const {query}=scriptedClaude({usage:async()=>plan});
  const answer=await read({query});
  assert.equal(answer.usage,plan);assert.equal(answer.usageError,null);
});

test("an initialize answer without lists or an account object reads as empty lists and no account, not signed out",async()=>{
  for(const account of ["person@example.test",42,true,undefined,null]){
    const {query}=scriptedClaude({answer:{models:"default",commands:null,agents:{},account}});
    const answer=await read({query,withPlanUsage:false});
    assert.deepEqual([answer.models,answer.commands,answer.agents,answer.account,answer.signedOut],[[],[],[],null,false],String(account));
    assert.equal(typeof answer.checkedAt,"string");assert.equal(Number.isNaN(Date.parse(answer.checkedAt)),false);
  }
  const {query}=scriptedClaude({answer:null});
  const empty=await read({query,withPlanUsage:false});
  assert.deepEqual([empty.models,empty.commands,empty.agents,empty.account,empty.signedOut,empty.usage,empty.usageError],[[],[],[],null,false,null,null]);
});

test("a close that throws is ignored, and a read that fails still stops Claude Code",async()=>{
  const {query}=scriptedClaude({close:()=>{throw new Error("already closed")}});
  assert.deepEqual((await read({query,withPlanUsage:false})).models,[]);
  let closed=0,options=null;
  const failing=input=>{options=input.options;return {initializationResult:async()=>{throw new Error("Claude Code exited with code 1")},close(){closed++}}};
  await assert.rejects(read({query:failing}),/exited with code 1/);
  assert.equal(closed,1);assert.equal(options.abortController.signal.aborted,true);
  const throwing=input=>{options=input.options;throw new Error("spawn ENOENT")};
  await assert.rejects(read({query:throwing}),/spawn ENOENT/);
  assert.equal(options.abortController.signal.aborted,true);
});

test("an account reads as signed out only with tokenSource none, a first-party API, no API key, email or plan, and no custom endpoint",async()=>{
  const cases=[
    [{tokenSource:"none"},{},true],
    [{tokenSource:"none",apiProvider:"firstParty"},{},true],
    [{tokenSource:"none",apiProvider:undefined},{},true],
    [{tokenSource:"none",apiProvider:null},{},false],
    [{tokenSource:"none",apiProvider:"vertex"},{},false],
    [{tokenSource:"none",apiProvider:"gateway"},{},false],
    [{tokenSource:"none",apiKeySource:"none"},{},true],
    [{tokenSource:"none",apiKeySource:""},{},true],
    [{tokenSource:"none",apiKeySource:"apiKeyHelper"},{},false],
    [{tokenSource:"none",email:""},{},true],
    [{tokenSource:"none",subscriptionType:""},{},true],
    [{tokenSource:"none",organization:"Example Org"},{},true],
    [{tokenSource:"None"},{},false],
    [{tokenSource:"claude.ai"},{},false],
    [{tokenSource:"none"},{ANTHROPIC_BASE_URL:"  https://gateway.example.test/v1  "},false],
    [{tokenSource:"none"},{ANTHROPIC_BASE_URL:" https://gateway.example.test/v1　"},false],
    [{tokenSource:"none"},{ANTHROPIC_BASE_URL:"http://localhost:8080"},false],
    [{tokenSource:"none"},{ANTHROPIC_BASE_URL:"ftp://files.example.test/"},true],
    [{tokenSource:"none"},{ANTHROPIC_BASE_URL:"HTTPS://API.ANTHROPIC.COM:8443/v1"},true],
    [{tokenSource:"none"},{ANTHROPIC_BASE_URL:"api.anthropic.com"},true],
    [{tokenSource:"none"},{ANTHROPIC_BASE_URL:""},true],
  ];
  for(const [account,env,said] of cases){
    const {query}=scriptedClaude({answer:{models:[],commands:[],agents:[],account}});
    assert.equal((await read({query,env,withPlanUsage:false})).signedOut,said,JSON.stringify([account,env]));
  }
});

// Windows matches variable names whatever their letter case, so a caller's copy of a name the read decides, in other letters,
// must neither win over the read's value nor bring back the variable the read takes out.
test("the read decides its four variables whatever letter case the caller's environment spells them in",()=>{
  // Each decided name in letters of its own, with the value it would have the caller's way; two kept variables beside them.
  const respelled=["enable_claudeai_mcp_servers=true","Claude_Code_Auto_Connect_IDE=true","claude_code_ide_skip_auto_install=0","Force_Code_Terminal=1","force_code_terminal="];
  const env=Object.fromEntries([...respelled,"Path=C:/Windows","CLAUDE_CONFIG_DIR=C:/Users/u/.claude"].map(entry=>entry.split("=")));
  const before={...env};
  assert.deepEqual(capabilityReadOptions({command:"claude",env,abortController:new AbortController()}).env,{
    Path:"C:/Windows",CLAUDE_CONFIG_DIR:"C:/Users/u/.claude",
    ENABLE_CLAUDEAI_MCP_SERVERS:"false",CLAUDE_CODE_AUTO_CONNECT_IDE:"false",CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL:"1",
  });
  assert.deepEqual(env,before,"the caller's environment is left as it was");
});

test("two reads share no option object or list, so one read's options cannot change another's",()=>{
  const abortController=new AbortController();
  const first=capabilityReadOptions({command:"claude",env:{PATH:"/usr/bin"},abortController}),second=capabilityReadOptions({command:"claude",env:{PATH:"/usr/bin"},abortController});
  assert.deepEqual(first,second);
  for(const key of ["env","settingSources","settings","allowedTools","mcpServers"])assert.notEqual(first[key],second[key],key);
  first.settingSources.push("flag");first.mcpServers.extra={command:"x"};first.env.PATH="/changed";
  assert.deepEqual([second.settingSources,second.mcpServers,second.env.PATH],[["user","project","local"],{},"/usr/bin"]);
});

test("a usage request that throws before it returns, or an SDK without one, costs the answer only its usage",async()=>{
  const answer={models:[{value:"default",displayName:"Default"}],commands:[{name:"review"}],agents:[],account:{email:"person@example.test"}};
  const throwsAtOnce=()=>({initializationResult:async()=>answer,usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:()=>{throw new Error("the usage read broke off")},close(){}});
  const atOnce=await read({query:throwsAtOnce});
  assert.deepEqual([atOnce.models,atOnce.commands,atOnce.usage,atOnce.usageError],[answer.models,answer.commands,null,"the usage read broke off"]);
  const olderSdk=()=>({initializationResult:async()=>answer,close(){}});
  const older=await read({query:olderSdk});
  assert.deepEqual([older.models,older.account,older.usage],[answer.models,answer.account,null]);
  assert.match(older.usageError,/usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET is not a function/);
});

test("Claude Code's input ends when a read fails, also while Claude Code is waiting on it",async()=>{
  let waiting=null,offered=0;
  const failing=({prompt})=>{
    waiting=(async()=>{for await(const _ of prompt)offered++})();
    return {initializationResult:async()=>{throw new Error("Claude Code exited with code 1")},close(){}};
  };
  await assert.rejects(read({query:failing}),/exited with code 1/);
  await waiting;
  assert.equal(offered,0);
});
