// Words for counts and runtime identifiers shown in the Tools page.

export function countLabel(count,singular,plural=singular+"s"){const value=Number(count)||0;return value+" "+(value===1?singular:plural)}

const IDENTIFIER_WORDS={mcp:"MCP",api:"API",url:"URL",uri:"URI",id:"ID",oauth:"OAuth",ssh:"SSH",json:"JSON"};
// An API identifier ("highRiskCyberActivity", "mcp_server_config") as the words a person reads ("High risk cyber activity",
// "MCP server config"). Text that is already prose, with spaces or punctuation, is shown as it came.
export function humanizeIdentifier(value){
  const text=String(value||"").trim();
  if(!/^[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*$/.test(text))return text;
  if(/^agents[_-]?md$/i.test(text))return "AGENTS.md";
  const words=text.replace(/([a-z0-9])([A-Z])/g,"$1 $2").split(/[\s_-]+/).filter(Boolean).map(word=>IDENTIFIER_WORDS[word.toLowerCase()]||word.toLowerCase());
  return words.map((word,index)=>index===0?word.slice(0,1).toUpperCase()+word.slice(1):word).join(" ");
}

// A coding agent by the id a runtime reports for it ("claude" in an import history entry is Claude Code).
const AGENT_NAMES={native:"Trebell Native",codex:"Codex",claude:"Claude Code",cursor:"Cursor",grok:"Grok Build",opencode:"OpenCode",antigravity:"Antigravity"};
export function agentName(id){const text=String(id||"").trim();return AGENT_NAMES[text.toLowerCase()]||humanizeIdentifier(text)}

// MCP server sign-in states as the runtimes report them (Codex's McpAuthStatus), named for people.
const MCP_AUTH_LABELS={unsupported:"No sign-in",notLoggedIn:"Sign-in required",loggedIn:"Signed in",bearerToken:"Bearer token",oAuth:"OAuth",oauth:"OAuth"};
export function mcpAuthLabel(status){return status?MCP_AUTH_LABELS[status]||humanizeIdentifier(status):"Sign-in unknown"}

// Each failed item of an external agent-config import as a person reads it: its kind ("MCP server config"), what went
// wrong (the runtime's message, else its error type) and the stage it failed at. Takes per-type results, or
// [{failures}] for a history entry, whose failures carry their own item type.
export function importFailures(results=[]){
  const rows=[];
  for(const result of Array.isArray(results)?results:[]){
    for(const failure of Array.isArray(result?.failures)?result.failures:[]){
      if(!failure||typeof failure!=="object")continue;
      rows.push({
        type:humanizeIdentifier(failure.itemType||result.itemType)||"Item",
        message:String(failure.message||"").trim()||humanizeIdentifier(failure.errorType)||"Could not be imported.",
        stage:humanizeIdentifier(failure.failureStage),
      });
    }
  }
  return rows;
}

// "Import complete · Skills, MCP server config · 1 imported · 1 failed" for an external agent-config import.
export function importResultSummary(results=[],prefix="Importing"){
  let successes=0,failures=0;const types=[];
  for(const result of results||[]){
    successes+=result?.successes?.length||0;failures+=result?.failures?.length||0;
    const type=String(result?.itemType||"").trim();if(type&&!types.includes(type))types.push(type);
  }
  return [prefix,types.map(humanizeIdentifier).join(", "),successes?successes+" imported":"",failures?failures+" failed":""].filter(Boolean).join(" · ");
}
