import test from "node:test";
import assert from "node:assert/strict";
import { agentName, countLabel, humanizeIdentifier, importResultSummary, mcpAuthLabel } from "../ui/src/display-labels.js";

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
