import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeAgentSession, configureOpenCodeMcpServers, connectedOpenCodeModels, openCodeStartingVariant, openCode2ModelId, openCodeSubagentRules, openCodeLongRequestFetch, openCodeMessageId, openCodeMessageTime, openCodeModelVariants, openCodePermissionDisposition, openCodeSessionRules, openCodePrimaryAgents, openCodeRulesEndWith, openCodeSlashCommand, openCodeTrustedDirectories, waitForOpenCode2Models } from "../src/opencode-agent-session.mjs";

test("OpenCode 2 model ids keep the provider plus the model's native id verbatim",()=>{
  assert.equal(openCode2ModelId({providerID:"opencode",id:"big-pickle"}),"opencode/big-pickle");
  assert.equal(openCode2ModelId({providerID:"nvidia",id:"nvidia/nemotron-3.5-super-vl-120b-a12b"}),"nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b");
  assert.equal(openCode2ModelId({providerID:"huggingface",modelID:"zai-org/GLM-5.3-Flash"}),"huggingface/zai-org/GLM-5.3-Flash");
});

test("OpenCode 2 waits for a specifically selected model when a cold provider catalog arrives in stages",async()=>{
  let calls=0;
  const partial={data:[{providerID:"nvidia",id:"nvidia/nemotron-3.5-super-vl-120b-a12b"}]};
  const complete={data:[...partial.data,{providerID:"opencode",id:"big-pickle"}]};
  const client={model:{list:async()=>++calls<3?partial:complete}};
  const result=await waitForOpenCode2Models(client,{directory:"/repo"},{requiredModel:"opencode/big-pickle",timeoutMs:100,intervalMs:1});
  // The third read lists the model, and a fourth that agrees with it settles the list.
  assert.equal(calls,4);
  assert.equal(result.data.some(model=>openCode2ModelId(model)==="opencode/big-pickle"),true);
});

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
  assert.notEqual(openCodeMessageTime(calls[0].body.messageID),null,"Trebell names the user message in OpenCode's own ID format");
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

test("each Trebell mode is a set of OpenCode session rules",()=>{
  // OpenCode's evaluation: the agent's rules, then the session's; the last rule whose permission and pattern match decides.
  const glob=value=>new RegExp("^"+String(value).replace(/[.+^${}()|[\]\\]/g,"\\$&").replace(/\*/g,".*").replace(/\?/g,".")+"$");
  const decide=(rules,permission,pattern="src/app.js")=>[{permission:"*",pattern:"*",action:"allow"},...rules].findLast(rule=>glob(rule.permission).test(permission)&&glob(rule.pattern).test(pattern)).action;
  const table=mode=>{
    const rules=openCodeSessionRules(mode,{allowedTools:["trebell_repository_*"],trustedDirectories:["/tmp/opencode/*"]});
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
  // the shell or read tool, so no mode removes them from the session itself.
  const removedTools=rules=>["bash","read","edit"].filter(permission=>rules.findLast(rule=>glob(rule.permission).test(permission)&&rule.pattern==="*")?.action==="deny");
  for(const mode of ["supervised","edits","auto","read-only","full"])assert.deepEqual(removedTools(openCodeSessionRules(mode)).filter(tool=>tool!=="edit"),[],mode);
  assert.deepEqual(removedTools(openCodeSessionRules("read-only")),["edit"],"read only removes the edit tools");
  assert.deepEqual(table("full"),{bash:"allow",edit:"allow",read:"allow",env:"allow",envExample:"allow",webfetch:"allow",outside:"allow",trusted:"allow",repository:"allow",mcp:"allow",task:"allow"});
  // A subagent's session starts with only the parent's denies and folder rules: in the asking modes it gets no commands or edits, since
  // nobody could be asked for them there, and it keeps its read tools.
  const child=mode=>openCodeSessionRules(mode).filter(rule=>rule.action==="deny"||rule.permission==="external_directory");
  assert.deepEqual({bash:decide(child("supervised"),"bash"),edit:decide(child("supervised"),"edit"),read:decide(child("supervised"),"read")},{bash:"deny",edit:"deny",read:"allow"});
  assert.deepEqual({bash:decide(child("edits"),"bash"),edit:decide(child("edits"),"edit")},{bash:"deny",edit:"allow"});
  assert.deepEqual({bash:decide(child("read-only"),"bash"),edit:decide(child("read-only"),"edit"),read:decide(child("read-only"),"read")},{bash:"deny",edit:"deny",read:"allow"});
  assert.equal(decide(child("auto"),"bash"),"allow");
});

test("OpenCode rule updates are sent only when they change something, and a subagent keeps OpenCode's own rules last",()=>{
  const rules=openCodeSessionRules("supervised");
  assert.equal(openCodeRulesEndWith([{permission:"read",pattern:"*",action:"allow"},...rules],rules),true);
  assert.equal(openCodeRulesEndWith(rules.slice(1),rules),false);
  assert.equal(openCodeRulesEndWith([],[]),false);
  const nativeChild=[{permission:"bash",pattern:"*",action:"deny"},{permission:"todowrite",pattern:"*",action:"deny"},{permission:"task",pattern:"*",action:"deny"}];
  assert.deepEqual(openCodeSubagentRules(rules,nativeChild),[...rules,{permission:"todowrite",pattern:"*",action:"deny"},{permission:"task",pattern:"*",action:"deny"}]);
  assert.deepEqual(openCodeTrustedDirectories([
    {name:"build",permission:[{permission:"external_directory",pattern:"*",action:"ask"},{permission:"external_directory",pattern:"/tmp/opencode/*",action:"allow"}]},
    {name:"plan",permission:[{permission:"external_directory",pattern:"/tmp/opencode/*",action:"allow"},{permission:"external_directory",pattern:"/skills/*",action:"allow"},{permission:"edit",pattern:"*",action:"deny"}]},
  ]),["/skills/*","/tmp/opencode/*"],"sorted, whatever order OpenCode lists its folders in");
});

test("a mode's rules come in layers: a subagent's denies, then ask for the rest, each gated tool, the unasked tools, secrets, edits and trusted folders",()=>{
  const rule=(permission,action,pattern="*")=>({permission,pattern,action});
  // Each run of keys is sorted by name (the rules of distinct keys decide independently, so the order is Trebell's choice).
  const gated=["bash","codesearch","doom_loop","edit","external_directory","webfetch","websearch"];
  const unasked=["glob","grep","list","lsp","question","read","skill","task","todoread","todowrite"].map(tool=>rule(tool,"allow"));
  const secrets=action=>[rule("read",action,"*.env"),rule("read",action,"*.env.*"),rule("read","allow","*.env.example")];
  assert.deepEqual(openCodeSessionRules("supervised"),[...gated.map(tool=>rule(tool,"deny")),rule("*","ask"),...gated.map(tool=>rule(tool,"ask")),...unasked,...secrets("ask")]);
  assert.deepEqual(openCodeSessionRules("edits"),[...gated.filter(tool=>tool!=="edit").map(tool=>rule(tool,"deny")),rule("*","ask"),...gated.map(tool=>rule(tool,"ask")),...unasked,...secrets("ask"),rule("edit","allow")]);
  assert.deepEqual(openCodeSessionRules("auto"),[rule("*","ask"),...gated.map(tool=>rule(tool,"ask")),...unasked,...secrets("ask")]);
  const removed=gated.filter(tool=>tool!=="webfetch");
  assert.deepEqual(openCodeSessionRules("read-only"),[...removed.map(tool=>rule(tool,"deny")),rule("*","ask"),...removed.map(tool=>rule(tool,tool==="bash"?"ask":"deny")),...unasked,...secrets("deny")]);
  // The repository tools follow OpenCode's own unasked tools; trusted folders come last, each once in the order first given, as text,
  // with empty ones left out. Full mode allows everything and takes neither.
  const options={allowedTools:["trebell_repository_*"],trustedDirectories:["/b/*","","/a/*","/b/*"]};
  assert.deepEqual(openCodeSessionRules("edits",options).slice(-8),[rule("todowrite","allow"),rule("trebell_repository_*","allow"),...secrets("ask"),rule("edit","allow"),rule("external_directory","allow","/b/*"),rule("external_directory","allow","/a/*")]);
  assert.deepEqual(openCodeSessionRules("supervised",options).filter(item=>item.permission==="external_directory"&&item.pattern!=="*"),[rule("external_directory","allow","/b/*"),rule("external_directory","allow","/a/*")]);
  assert.deepEqual(openCodeSessionRules("full",options),[rule("*","allow"),rule("external_directory","allow")]);
  // A list option that is not a list counts as none, and the mode is read as the permission policy reads it.
  assert.deepEqual(openCodeSessionRules("supervised",{allowedTools:"bash",trustedDirectories:"/tmp/*"}),openCodeSessionRules("supervised"));
  assert.deepEqual(openCodeSessionRules("workspace-write"),openCodeSessionRules("edits"));
  assert.deepEqual(openCodeSessionRules("isolated"),openCodeSessionRules("auto"));
  assert.deepEqual(openCodeSessionRules("readonly"),openCodeSessionRules("read-only"));
  for(const mode of [undefined,"","something else"])assert.deepEqual(openCodeSessionRules(mode),openCodeSessionRules("supervised"),String(mode));
});

test("every OpenCode permission key is either one a mode decides or one that runs unasked, and each mode decides each key the same way whatever the order",()=>{
  const auto=openCodeSessionRules("auto"),pivot=auto.findIndex(rule=>rule.permission==="*");
  // The keys by where they are written down: OpenCode's permissions page, the SDK's PermissionConfig, and earlier releases.
  const documentedBy={
    permissionsPage:["read","edit","glob","grep","bash","task","todowrite","skill","lsp","question","webfetch","websearch","external_directory","doom_loop"],
    sdkPermissionConfig:["list","codesearch"],
    earlierReleases:["todoread"],
  };
  const documented=Object.values(documentedBy).flat();
  const decided=auto.filter((rule,index)=>index>pivot&&rule.action==="ask"&&rule.pattern==="*").map(rule=>rule.permission);
  const unasked=auto.filter(rule=>rule.action==="allow"&&rule.pattern==="*").map(rule=>rule.permission);
  assert.deepEqual([...decided,...unasked].sort(),[...documented].sort(),"each key once, in one of the two runs");
  // The last rule whose key and pattern match decides (OpenCode's "last matching rule winning"); anything unmatched is allowed.
  const decide=(rules,key)=>rules.findLast(rule=>(rule.permission==="*"||rule.permission===key)&&rule.pattern==="*")?.action??"allow";
  // What each mode decides, written per key: the guarded keys by name, the rest run unasked.
  const guarded=new Set(["bash","codesearch","doom_loop","edit","external_directory","webfetch","websearch"]);
  const expected={
    supervised:key=>guarded.has(key)?"ask":"allow",
    edits:key=>key==="edit"?"allow":guarded.has(key)?"ask":"allow",
    auto:key=>guarded.has(key)?"ask":"allow",
    "read-only":key=>key==="bash"||key==="webfetch"?"ask":guarded.has(key)?"deny":"allow",
    full:()=>"allow",
  };
  // A subagent starts with the parent's denials and folder rules: no guarded key where nobody could be asked, except edits in edits
  // mode and a URL fetch in read only mode, and other folders as the parent's session answers them.
  const forSubagent={
    supervised:key=>key==="external_directory"?"ask":guarded.has(key)?"deny":"allow",
    edits:key=>key==="external_directory"?"ask":guarded.has(key)&&key!=="edit"?"deny":"allow",
    auto:key=>key==="external_directory"?"ask":"allow",
    "read-only":key=>guarded.has(key)&&key!=="webfetch"?"deny":"allow",
    full:()=>"allow",
  };
  for(const mode of Object.keys(expected)){
    const rules=openCodeSessionRules(mode),child=rules.filter(rule=>rule.action==="deny"||rule.permission==="external_directory");
    for(const key of documented){
      assert.equal(decide(rules,key),expected[mode](key),`${mode}: ${key}`);
      assert.equal(decide(child,key),forSubagent[mode](key),`${mode} subagent: ${key}`);
    }
  }
});

test("a subagent keeps the parent's rules and then only the rules OpenCode added for it that it did not inherit",()=>{
  const rule=(permission,action,pattern="*")=>({permission,pattern,action});
  const parent=openCodeSessionRules("supervised",{trustedDirectories:["/tmp/opencode/*"]});
  // Inherited: the parent's denies and folder rules. An allow rule that only matches a parent's allow is OpenCode's own and stays,
  // as do repeats; a rule that is not a rule (null) stays too.
  const fromOpenCode=[rule("bash","deny"),rule("external_directory","allow","/tmp/opencode/*"),rule("read","allow"),rule("task","deny"),rule("task","deny"),null,rule("edit","deny","*.lock")];
  assert.deepEqual(openCodeSubagentRules(parent,fromOpenCode),[...parent,rule("read","allow"),rule("task","deny"),rule("task","deny"),null,rule("edit","deny","*.lock")]);
  // Only an exact match counts: the same tool with another pattern or action is OpenCode's own.
  assert.deepEqual(openCodeSubagentRules(parent,[rule("bash","ask"),rule("bash","deny","rm *")]),[...parent,rule("bash","ask"),rule("bash","deny","rm *")]);
  // Lists that are not lists count as empty.
  assert.deepEqual(openCodeSubagentRules(parent,null),parent);
  assert.deepEqual(openCodeSubagentRules(null,[rule("task","deny")]),[rule("task","deny")]);
  assert.deepEqual(openCodeSubagentRules(),[]);
});

test("a model starts on its only level, else on the level its provider starts on, else on none",()=>{
  assert.equal(openCodeStartingVariant("google",["low","high"]),"high");
  assert.equal(openCodeStartingVariant("google-vertex-anthropic",["high","max"]),"high");
  assert.equal(openCodeStartingVariant("vertex-google",["low","high"]),null,"a provider whose id only contains google");
  assert.equal(openCodeStartingVariant("anthropic",["low","medium"]),null);
  assert.equal(openCodeStartingVariant("openai",["low","medium","high"]),"medium");
  assert.equal(openCodeStartingVariant("opencode",["low","max"]),null);
  assert.equal(openCodeStartingVariant("anthropic",["max"]),"max","a single level whatever the provider");
  assert.equal(openCodeStartingVariant(null,["only"]),"only");
  for(const provider of ["openai","anthropic","nvidia",null,""])assert.equal(openCodeStartingVariant(provider,[]),null,String(provider));
  assert.equal(openCodeStartingVariant("openai","medium"),null,"levels that are not a list are none");
  assert.equal(openCodeStartingVariant("openai"),null);
  assert.equal(openCodeStartingVariant("Anthropic",["low","high"]),null,"provider ids are OpenCode's, compared as they are");
});

test("a message asks for a command when it is a slash, a name without another slash, and maybe arguments after a space",()=>{
  assert.deepEqual(openCodeSlashCommand("/review"),{name:"review",arguments:""});
  assert.deepEqual(openCodeSlashCommand("/review the diff"),{name:"review",arguments:"the diff"});
  assert.deepEqual(openCodeSlashCommand("/review   the diff\nand the tests"),{name:"review",arguments:"the diff\nand the tests"});
  assert.deepEqual(openCodeSlashCommand("/review\n\tsrc/a b"),{name:"review",arguments:"src/a b"},"a line break or tab ends the name too");
  assert.deepEqual(openCodeSlashCommand("/review "),{name:"review",arguments:""});
  assert.deepEqual(openCodeSlashCommand("/init.v2 a/b"),{name:"init.v2",arguments:"a/b"},"the arguments can hold slashes");
  for(const text of ["review","/","/ review","/src/app.js","/a/b c"," /review","",null,undefined])assert.equal(openCodeSlashCommand(text),null,String(text));
});

test("OpenCode model variants, default levels, primary agents and message IDs follow OpenCode",()=>{
  assert.deepEqual(openCodeModelVariants({variants:{low:{},high:{},"bad name":{},off:{disabled:true},"x.high_2":{}}}),["low","high","x.high_2"]);
  assert.deepEqual(openCodeModelVariants({}),[]);
  assert.equal(openCodeStartingVariant("opencode",["minimal","low","medium","high"]),"medium");
  assert.equal(openCodeStartingVariant("openai",["low","high"]),"high");
  assert.equal(openCodeStartingVariant("anthropic",["low","high","max"]),"high");
  assert.equal(openCodeStartingVariant("google-vertex",["low","medium"]),null);
  assert.equal(openCodeStartingVariant("nvidia",["thinking"]),"thinking");
  assert.equal(openCodeStartingVariant("nvidia",["a","b"]),null);
  assert.deepEqual(openCodePrimaryAgents([{name:"build",mode:"primary"},{name:"plan",mode:"all"},{name:"explore",mode:"subagent"},{name:"title",mode:"primary",hidden:true},null]).map(agent=>agent.name),["build","plan"]);
  // Re-pinned 2026-11-01: 14 base62 characters after the time, as OpenCode's own IDs carry (id.ts: its length of 26 less the 12 hex
  // digits). It was 28, a length that is not OpenCode's. A clock above 48 bits keeps its low 48, as OpenCode's six bytes do.
  const id=openCodeMessageId(0x123456789abn);
  assert.match(id,/^msg_0123456789ab[0-9A-Za-z]{14}$/);assert.equal(openCodeMessageTime(id),0x123456789abn);
  assert.equal(openCodeMessageTime(openCodeMessageId((1n<<48n)+5n)),5n);
  assert.equal(new Set(Array.from({length:50},()=>openCodeMessageId(1n).slice(16))).size,50,"each ID's random part is its own");
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
