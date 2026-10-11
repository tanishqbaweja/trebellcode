import test from "node:test";
import assert from "node:assert/strict";
import { agentName, countLabel, failureText, humanizeIdentifier, importFailures, importResultSummary, listCount, mcpAuthLabel } from "../ui/src/display-labels.js";

test("a failure names its action before the reason, and only once",()=>{
  assert.equal(failureText("Could not clear local usage history",new Error("Deliberate usage clear failure")),"Could not clear local usage history: Deliberate usage clear failure");
  assert.equal(failureText("Could not load usage","  HTTP 500 "),"Could not load usage: HTTP 500");
  // No reason at all still says what failed.
  assert.equal(failureText("Could not load usage",new Error("")),"Could not load usage.");
  assert.equal(failureText("Could not load usage",null),"Could not load usage.");
  // A reason the server already words with the action is shown as it came, in any letter case, not after a second copy.
  assert.equal(failureText("Could not clear local usage history",new Error("Could not clear local usage history: the usage file is read-only")),"Could not clear local usage history: the usage file is read-only");
  assert.equal(failureText("Could not load usage",new Error("could not load usage.")),"could not load usage.");
  assert.equal(failureText("Windows sandbox setup failed","Windows sandbox setup failed"),"Windows sandbox setup failed");
  // Another failure, or one that only shares the first words, is a reason: the action still comes first.
  assert.equal(failureText("Could not use the reset credit",new Error("Could not connect to Codex app-server")),"Could not use the reset credit: Could not connect to Codex app-server");
  assert.equal(failureText("Could not load usage",new Error("Could not load usages.json")),"Could not load usage: Could not load usages.json");
  assert.equal(failureText("Windows sandbox setup failed",undefined),"Windows sandbox setup failed.");
});

test("each import failure reads as its kind, the runtime's message and its stage",()=>{
  const results=[
    {itemType:"SKILLS",successes:[{}],failures:[]},
    {itemType:"MCP_SERVER_CONFIG",successes:[],failures:[{itemType:"MCP_SERVER_CONFIG",errorType:"invalid_config",failureStage:"write",message:"One connector could not be imported."}]},
    // A failure without its own type takes its result's; one without a message falls back to its error type.
    {itemType:"AGENTS_MD",failures:[{errorType:"permission_denied"},{},null,"bad"]},
  ];
  assert.deepEqual(importFailures(results),[
    {type:"MCP server config",message:"One connector could not be imported.",stage:"Write"},
    {type:"AGENTS.md",message:"Permission denied",stage:""},
    {type:"AGENTS.md",message:"Could not be imported.",stage:""},
  ]);
  // A history entry's flat failure list.
  assert.deepEqual(importFailures([{failures:[{itemType:"HOOKS",message:"Hook path is outside the workspace."}]}]),[{type:"Hooks",message:"Hook path is outside the workspace.",stage:""}]);
  assert.deepEqual(importFailures([{failures:[{message:"No type"}]}]),[{type:"Item",message:"No type",stage:""}]);
  assert.deepEqual(importFailures(undefined),[]);assert.deepEqual(importFailures([null,{failures:null}]),[]);
});

test("a count names one thing in the singular and any other number in the plural",()=>{
  assert.equal(countLabel(1,"skill"),"1 skill");
  assert.equal(countLabel(0,"skill"),"0 skills");
  assert.equal(countLabel(3,"scheduled task"),"3 scheduled tasks");
  assert.equal(countLabel(2,"MCP server"),"2 MCP servers");
  assert.equal(countLabel(1,"catalog plugin"),"1 catalog plugin");
  assert.equal(countLabel(undefined,"hook"),"0 hooks");
  assert.equal(countLabel("2","app"),"2 apps");
  assert.equal(countLabel(2,"entry","entries"),"2 entries");
});

test("a list card's count speaks for the rows on screen or a list that loaded empty, and waits otherwise",()=>{
  // Not loaded yet: no count, whether or not a read is running or failed.
  assert.equal(listCount(null),undefined);
  assert.equal(listCount(undefined,{loading:true}),undefined);
  assert.equal(listCount(null,{error:"Could not load hooks: offline"}),undefined);
  // Rows on screen are counted while they are read again and beside a failed read, which keeps them.
  assert.equal(listCount([1,2]),2);
  assert.equal(listCount([1,2],{loading:true}),2);
  assert.equal(listCount([1],{error:"Could not load MCP servers: offline"}),1);
  // A list that loaded empty reads 0, but not while it is read again or once that read failed.
  assert.equal(listCount([]),0);
  assert.equal(listCount([],{loading:true}),undefined);
  assert.equal(listCount([],{error:"Could not load MCP servers: offline"}),undefined);
  assert.equal(listCount([],{error:true}),undefined);
  assert.equal(listCount([],{loading:false,error:null}),0);
  // A card that counts something other than the list's items (hooks inside their entries) gives that count by the same rule.
  assert.equal(listCount([{hooks:[]},{hooks:[]}],{count:0}),0);
  assert.equal(listCount([{hooks:[]}],{count:0,loading:true}),undefined);
  assert.equal(listCount([{hooks:[1,2,3]}],{count:3,loading:true}),3);
  assert.equal(listCount([],{count:undefined}),0);
});

test("a runtime identifier reads as words, and prose comes through unchanged",()=>{
  assert.equal(humanizeIdentifier("highRiskCyberActivity"),"High risk cyber activity");
  assert.equal(humanizeIdentifier("userRisk"),"User risk");
  assert.equal(humanizeIdentifier("trustedAccessForCyber"),"Trusted access for cyber");
  assert.equal(humanizeIdentifier("mcp_server_config"),"MCP server config");
  assert.equal(humanizeIdentifier("SKILLS"),"Skills");
  assert.equal(humanizeIdentifier("skills"),"Skills");
  assert.equal(humanizeIdentifier("api-key"),"API key");
  assert.equal(humanizeIdentifier("oauthUrl"),"OAuth URL");
  assert.equal(humanizeIdentifier("AGENTS_MD"),"AGENTS.md");
  assert.equal(humanizeIdentifier("agentsMd"),"AGENTS.md");
  assert.equal(humanizeIdentifier("The model was rerouted for safety."),"The model was rerouted for safety.");
  assert.equal(humanizeIdentifier("gpt-6-luna → gpt-6"),"gpt-6-luna → gpt-6");
  assert.equal(humanizeIdentifier("  "),"");
  assert.equal(humanizeIdentifier(null),"");
  assert.equal(humanizeIdentifier(undefined),"");
});

test("a coding agent is named by its product name, and an unknown agent id reads as words",()=>{
  assert.equal(agentName("claude"),"Claude Code");
  assert.equal(agentName("Codex"),"Codex");
  assert.equal(agentName("opencode"),"OpenCode");
  assert.equal(agentName("some_agent"),"Some agent");
  assert.equal(agentName(""),"");
});

test("an MCP server's sign-in state is named for a person, and an unknown state is not left blank",()=>{
  assert.equal(mcpAuthLabel("unsupported"),"No sign-in");
  assert.equal(mcpAuthLabel("notLoggedIn"),"Sign-in required");
  assert.equal(mcpAuthLabel("loggedIn"),"Signed in");
  assert.equal(mcpAuthLabel("bearerToken"),"Bearer token");
  assert.equal(mcpAuthLabel("oAuth"),"OAuth");
  assert.equal(mcpAuthLabel("oauth"),"OAuth");
  assert.equal(mcpAuthLabel("deviceCodePending"),"Device code pending");
  assert.equal(mcpAuthLabel(""),"Sign-in unknown");
  assert.equal(mcpAuthLabel(undefined),"Sign-in unknown");
});

test("an import summary names the imported kinds once, with counts only when they are not zero",()=>{
  const results=[
    {itemType:"SKILLS",successes:[{name:"a"}],failures:[]},
    {itemType:"MCP_SERVER_CONFIG",successes:[],failures:[{name:"b",error:"bad"}]},
    {itemType:"SKILLS",successes:[],failures:[]},
  ];
  assert.equal(importResultSummary(results,"Import complete"),"Import complete · Skills, MCP server config · 1 imported · 1 failed");
  assert.equal(importResultSummary([{itemType:"AGENTS_MD",successes:[{},{}],failures:[]}],"Import complete"),"Import complete · AGENTS.md · 2 imported");
  assert.equal(importResultSummary([]),"Importing");
  assert.equal(importResultSummary(undefined),"Importing");
  assert.equal(importResultSummary([null,{itemType:" ",successes:null,failures:undefined}]),"Importing");
});
