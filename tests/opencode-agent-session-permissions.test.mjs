import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeAgentSession, configureOpenCodeMcpServers, connectedOpenCodeModels, inferOpenCodeDefaultVariant, openCodeChildPermissionRules, openCodeLongRequestFetch, openCodeMessageId, openCodeMessageTime, openCodeModelVariants, openCodePermissionDisposition, openCodePermissionRules, openCodePrimaryAgents, openCodeRulesEndWith, openCodeTrustedDirectories } from "../src/opencode-agent-session.mjs";

test("OpenCode model selection stays inside connected providers instead of picking the first global provider",()=>{
  const catalog=connectedOpenCodeModels({
    connected:["huggingface","nvidia","opencode"],
    default:{deepinfra:"zai/should-not-be-used",huggingface:"zai-org/GLM-5.3-Flash",nvidia:"z-ai/glm-5.3-flash",opencode:"big-pickle"},
    all:[
      {id:"deepinfra",models:{bad:{id:"zai/should-not-be-used"}}},
      {id:"huggingface",models:{good:{id:"zai-org/GLM-5.3-Flash",limit:{context:131072}}}},
      {id:"nvidia",models:{other:{id:"z-ai/glm-5.3-flash"}}},
      {id:"opencode",models:{free:{id:"big-pickle"}}},
    ],
  });
  assert.equal(catalog.preferred,"huggingface/zai-org/GLM-5.3-Flash");
  assert.equal(catalog.models.some(item=>item.providerID==="deepinfra"),false);
  assert.deepEqual(new Set(catalog.models.map(item=>item.providerID)),new Set(["huggingface","nvidia","opencode"]));
});

test("OpenCode permission events follow Trebell shared policy using provider permission types",()=>{
  assert.equal(openCodePermissionDisposition("full","bash"),"allow");
  assert.equal(openCodePermissionDisposition("auto","webfetch"),"allow");
  assert.equal(openCodePermissionDisposition("edits","edit"),"allow");
  assert.equal(openCodePermissionDisposition("edits","write"),"allow");
  assert.equal(openCodePermissionDisposition("edits","bash"),"ask");
  assert.equal(openCodePermissionDisposition("edits","webfetch"),"ask");
  assert.equal(openCodePermissionDisposition("edits","unknown-provider-permission"),"ask");
  assert.equal(openCodePermissionDisposition("supervised","edit"),"ask");
});

test("OpenCode read-only keeps its conservative deny-on-permission behavior",()=>{
  assert.equal(openCodePermissionDisposition("read-only","read"),"deny");
  assert.equal(openCodePermissionDisposition("read-only","edit"),"deny");
  assert.equal(openCodePermissionDisposition("read-only","bash"),"deny");
});

const ID_U1="msg_00000000100000000000000000000000000000",ID_A1="msg_00000000200000000000000000000000000000",ID_U2="msg_00000000300000000000000000000000000000";
const listed=ids=>({data:ids.map(([id,role])=>({info:{id,role},parts:[]}))});

test("OpenCode fork, rewind and compaction map to the real SDK session operations",async()=>{
  const calls=[];
  const session=new OpenCodeAgentSession({cwd:"/repo"});
  session.sessionId="session-1";session.model="provider-a/model-a";session.modelMap.set("provider-a/model-a",{providerID:"provider-a",modelID:"model-a"});
  const source=[[ID_U1,"user"],[ID_A1,"assistant"],[ID_U2,"user"]],copies={"forked-session":[["msg_c1","user"],["msg_c2","assistant"],["msg_c3","user"]],"rewound-session":[["msg_r1","user"],["msg_r2","assistant"]]};
  session.client={session:{
    messages:async request=>{calls.push(["messages",request.path.id]);return listed(copies[request.path.id]||source)},
    fork:async request=>{calls.push(["fork",request]);return {data:{id:request.body.messageID?"rewound-session":"forked-session"}}},
    update:async request=>{calls.push(["update",request.path.id]);return {data:{id:request.path.id,permission:request.body.permission}}},
    revert:async request=>{calls.push(["revert",request]);return {data:{}}},
    summarize:async request=>{calls.push(["summarize",request]);return {data:{ok:true}}},
  }};
  const forked=await session.fork();
  assert.equal(forked.sessionId,"forked-session");assert.deepEqual(forked.messageIds,[[ID_U1,"msg_c1"],[ID_A1,"msg_c2"],[ID_U2,"msg_c3"]]);
  const rewound=await session.rewind(ID_U2);
  assert.equal(rewound.sessionId,"rewound-session");assert.deepEqual(rewound.messageIds,[[ID_U1,"msg_r1"],[ID_A1,"msg_r2"]]);
  assert.equal(session.sessionId,"rewound-session");
  assert.deepEqual(await session.compact(),{ok:true});
  assert.deepEqual(calls,[
    ["messages","session-1"],["fork",{path:{id:"session-1"},query:{directory:"/repo"},body:{}}],["messages","forked-session"],
    // A rewind copies the messages before the turn into a new session (OpenCode's revert would also undo files).
    ["messages","session-1"],["fork",{path:{id:"session-1"},query:{directory:"/repo"},body:{messageID:ID_U2}}],["messages","rewound-session"],["update","rewound-session"],
    // Compaction waits for a whole model call, so it uses the transport without Node fetch's five-minute header deadline.
    ["summarize",{path:{id:"rewound-session"},query:{directory:"/repo"},body:{providerID:"provider-a",modelID:"model-a"},fetch:openCodeLongRequestFetch}],
  ]);
});

test("OpenCode appends bounded Trebell runtime context through its native system field",async()=>{
  const calls=[],session=new OpenCodeAgentSession({cwd:"/repo"});
  session.sessionId="session-1";session.model="openai/gpt-5";
  session.modelMap.set("openai/gpt-5",{providerID:"openai",modelID:"gpt-5"});
  session.client={session:{prompt:async request=>{calls.push(request);return {data:{info:{id:"assistant-1",parentID:request.body.messageID,tokens:{}},parts:[]}}}}};
  const result=await session.prompt([{type:"text",text:"Fix the parser"}],{messageId:"user-1"});
  assert.equal(calls.length,1);
  assert.equal(calls[0].body.parts[0].text,"Fix the parser");
  assert.match(calls[0].body.messageID,/^msg_[0-9a-f]{12}/,"Trebell names the user message in OpenCode's own ID format");
  assert.equal(result.providerMessageId,calls[0].body.messageID);
  assert.equal(calls[0].fetch,openCodeLongRequestFetch);
  assert.match(calls[0].body.system,/Trebell Code/);
  assert.match(calls[0].body.system,/OpenCode harness/);
  assert.match(calls[0].body.system,/openai\/gpt-5/);
});

test("OpenCode advertised controls surface SDK failures instead of pretending success",async()=>{
  const session=new OpenCodeAgentSession({cwd:"/repo"});session.sessionId="session-1";session.model="provider-a/model-a";session.modelMap.set("provider-a/model-a",{providerID:"provider-a",modelID:"model-a"});
  const copied=[[ID_U1,"user"]];
  session.client={session:{
    messages:async request=>listed(request.path.id==="session-1"?[[ID_U1,"user"],[ID_A1,"assistant"],[ID_U2,"user"]]:copied),
    fork:async()=>({error:{message:"fork unavailable"}}),summarize:async()=>({error:{message:"summary failed"}}),
  }};
  await assert.rejects(()=>session.fork(),/fork unavailable/i);
  await assert.rejects(()=>session.rewind(ID_U2),/fork unavailable/i);
  // A fork that did not keep the conversation as it was is not used.
  session.client.session.fork=async()=>({data:{id:"short-fork"}});
  await assert.rejects(()=>session.fork(),/did not copy this conversation/i);
  await assert.rejects(()=>session.rewind(ID_U2),/did not keep the conversation up to this turn/i);
  assert.equal(session.sessionId,"session-1");
  await assert.rejects(()=>session.compact(),/summary failed/i);
  session.model="unknown";session.modelMap.clear();await assert.rejects(()=>session.compact(),/select a model/i);
});

test("each Trebell mode is a set of OpenCode session rules (T3 Code's openCodePermissionRules)",()=>{
  // OpenCode's evaluation: the agent's rules, then the session's; the last rule whose permission and pattern match decides.
  const glob=value=>new RegExp("^"+String(value).replace(/[.+^${}()|[\]\\]/g,"\\$&").replace(/\*/g,".*").replace(/\?/g,".")+"$");
  const decide=(rules,permission,pattern="src/app.js")=>[{permission:"*",pattern:"*",action:"allow"},...rules].findLast(rule=>glob(rule.permission).test(permission)&&glob(rule.pattern).test(pattern)).action;
  const table=mode=>{
    const rules=openCodePermissionRules(mode,{allowedTools:["trebell_repository_*"],trustedDirectories:["/tmp/opencode/*"]});
    return {
      bash:decide(rules,"bash","npm test"),edit:decide(rules,"edit"),read:decide(rules,"read"),env:decide(rules,"read","app/.env"),envExample:decide(rules,"read","app/.env.example"),
      webfetch:decide(rules,"webfetch","https://example.test"),outside:decide(rules,"external_directory","/elsewhere/*"),trusted:decide(rules,"external_directory","/tmp/opencode/*"),
      repository:decide(rules,"trebell_repository_search_symbols"),mcp:decide(rules,"github_create_issue"),task:decide(rules,"task","general"),
    };
  };
  assert.deepEqual(table("supervised"),{bash:"ask",edit:"ask",read:"allow",env:"ask",envExample:"allow",webfetch:"ask",outside:"ask",trusted:"allow",repository:"allow",mcp:"ask",task:"allow"});
  assert.deepEqual(table("edits"),{...table("supervised"),edit:"allow"});
  assert.deepEqual(table("auto"),table("supervised"),"auto asks as supervised does; Trebell's policy answers");
  // Read only asks for commands, and Trebell's read-only policy refuses each one; edits, searches and other folders are removed.
  assert.deepEqual(table("read-only"),{bash:"ask",edit:"deny",read:"allow",env:"deny",envExample:"allow",webfetch:"ask",outside:"deny",trusted:"allow",repository:"allow",mcp:"ask",task:"allow"});
  assert.equal(openCodePermissionDisposition("read-only","bash"),"deny","every command a read-only session asks for is refused unasked");
  // OpenCode leaves out of the request a tool whose last "*" rule denies it, and OpenCode Zen's free tier refuses a request without
  // the shell or read tool, so no mode removes them from the session itself (T3 Code never denies shell or read).
  const removedTools=rules=>["bash","read","edit"].filter(permission=>rules.findLast(rule=>glob(rule.permission).test(permission)&&rule.pattern==="*")?.action==="deny");
  for(const mode of ["supervised","edits","auto","read-only","full"])assert.deepEqual(removedTools(openCodePermissionRules(mode)).filter(tool=>tool!=="edit"),[],mode);
  assert.deepEqual(removedTools(openCodePermissionRules("read-only")),["edit"],"read only removes the edit tools");
  assert.deepEqual(table("full"),{bash:"allow",edit:"allow",read:"allow",env:"allow",envExample:"allow",webfetch:"allow",outside:"allow",trusted:"allow",repository:"allow",mcp:"allow",task:"allow"});
  // A subagent's session starts with only the parent's denies and folder rules: in the asking modes it gets no commands or edits, since
  // nobody could be asked for them there, and it keeps its read tools (T3's leading "*" deny would leave it none).
  const child=mode=>openCodePermissionRules(mode).filter(rule=>rule.action==="deny"||rule.permission==="external_directory");
  assert.deepEqual({bash:decide(child("supervised"),"bash"),edit:decide(child("supervised"),"edit"),read:decide(child("supervised"),"read")},{bash:"deny",edit:"deny",read:"allow"});
  assert.deepEqual({bash:decide(child("edits"),"bash"),edit:decide(child("edits"),"edit")},{bash:"deny",edit:"allow"});
  assert.deepEqual({bash:decide(child("read-only"),"bash"),edit:decide(child("read-only"),"edit"),read:decide(child("read-only"),"read")},{bash:"deny",edit:"deny",read:"allow"});
  assert.equal(decide(child("auto"),"bash"),"allow");
});

test("OpenCode rule updates are sent only when they change something, and a subagent keeps OpenCode's own rules last",()=>{
  const rules=openCodePermissionRules("supervised");
  assert.equal(openCodeRulesEndWith([{permission:"read",pattern:"*",action:"allow"},...rules],rules),true);
  assert.equal(openCodeRulesEndWith(rules.slice(1),rules),false);
  assert.equal(openCodeRulesEndWith([],[]),false);
  const nativeChild=[{permission:"bash",pattern:"*",action:"deny"},{permission:"todowrite",pattern:"*",action:"deny"},{permission:"task",pattern:"*",action:"deny"}];
  assert.deepEqual(openCodeChildPermissionRules(rules,nativeChild),[...rules,{permission:"todowrite",pattern:"*",action:"deny"},{permission:"task",pattern:"*",action:"deny"}]);
  assert.deepEqual(openCodeTrustedDirectories([
    {name:"build",permission:[{permission:"external_directory",pattern:"*",action:"ask"},{permission:"external_directory",pattern:"/tmp/opencode/*",action:"allow"}]},
    {name:"plan",permission:[{permission:"external_directory",pattern:"/tmp/opencode/*",action:"allow"},{permission:"external_directory",pattern:"/skills/*",action:"allow"},{permission:"edit",pattern:"*",action:"deny"}]},
  ]),["/skills/*","/tmp/opencode/*"],"sorted, whatever order OpenCode lists its folders in");
});

test("OpenCode model variants, default levels, primary agents and message IDs follow OpenCode and T3 Code",()=>{
  assert.deepEqual(openCodeModelVariants({variants:{low:{},high:{},"bad name":{},off:{disabled:true},"x.high_2":{}}}),["low","high","x.high_2"]);
  assert.deepEqual(openCodeModelVariants({}),[]);
  assert.equal(inferOpenCodeDefaultVariant("opencode",["minimal","low","medium","high"]),"medium");
  assert.equal(inferOpenCodeDefaultVariant("openai",["low","high"]),"high");
  assert.equal(inferOpenCodeDefaultVariant("anthropic",["low","high","max"]),"high");
  assert.equal(inferOpenCodeDefaultVariant("google-vertex",["low","medium"]),null);
  assert.equal(inferOpenCodeDefaultVariant("nvidia",["thinking"]),"thinking");
  assert.equal(inferOpenCodeDefaultVariant("nvidia",["a","b"]),null);
  assert.deepEqual(openCodePrimaryAgents([{name:"build",mode:"primary"},{name:"plan",mode:"all"},{name:"explore",mode:"subagent"},{name:"title",mode:"primary",hidden:true},null]).map(agent=>agent.name),["build","plan"]);
  const id=openCodeMessageId(0x123456789abn);
  assert.match(id,/^msg_0123456789ab[0-9A-Za-z]{28}$/);assert.equal(openCodeMessageTime(id),0x123456789abn);
  assert.equal(openCodeMessageTime("101b36f4-70d2-447a-b28f-b0dff2796f59"),null);
});

test("OpenCode repository MCP setup uses the SDK MCP endpoint and reports setup failures honestly",async()=>{
  const calls=[],client={mcp:{add:async request=>{
    calls.push(request);
    if(request.body.name==="broken")return {error:{message:"MCP launch failed"}};
    return {data:{[request.body.name]:{status:"connected"}}};
  }}};
  const local={type:"local",command:["node","repo.mjs"],environment:{TREBELL_REPOSITORY_ROOT:"/repo"},enabled:true,timeout:15_000};
  const results=await configureOpenCodeMcpServers(client,{cwd:"/repo",servers:[{name:"trebell_repository",config:local},{name:"broken",config:local}]});
  assert.deepEqual(calls,[
    {query:{directory:"/repo"},body:{name:"trebell_repository",config:local}},
    {query:{directory:"/repo"},body:{name:"broken",config:local}},
  ]);
  assert.deepEqual(results[0],{name:"trebell_repository",configured:true,status:{status:"connected"}});
  assert.equal(results[1].configured,false);assert.match(results[1].error,/MCP launch failed/);
});
