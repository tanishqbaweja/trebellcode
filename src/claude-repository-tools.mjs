import {
  REPOSITORY_TOOL_DEFINITIONS,
  REPOSITORY_TOOL_INSTRUCTIONS,
  invokeRepositoryTool,
  repositoryToolHandlers as sharedRepositoryToolHandlers,
} from "./repository-tool-catalog.mjs";

// The Claude Agent SDK hosts the repository MCP server; it loads with the first Claude Code thread that starts, not with the server
// (budget B25).
let claudeAgentSdk=null;
const loadClaudeAgentSdk=()=>claudeAgentSdk??=import("@anthropic-ai/claude-agent-sdk");

export const repositoryToolHandlers=sharedRepositoryToolHandlers;

function claudeRepositoryTool(tool,definition,handlers){
  return tool(
    definition.name,
    definition.description,
    definition.inputSchema,
    async args=>({content:[{type:"text",text:JSON.stringify(await invokeRepositoryTool(handlers,definition,args))}]}),
    {searchHint:definition.searchHint,annotations:definition.annotations},
  );
}

export async function createClaudeRepositoryMcp({contextEngine,root,io=null,knowledgeService=null,environmentId=null,version="0.0.0"}={}){
  const {createSdkMcpServer,tool}=await loadClaudeAgentSdk();
  const handlers=sharedRepositoryToolHandlers({contextEngine,root,io,knowledgeService,environmentId});
  return createSdkMcpServer({
    name:"trebell_repository",
    version,
    instructions:REPOSITORY_TOOL_INSTRUCTIONS,
    tools:REPOSITORY_TOOL_DEFINITIONS.map(definition=>claudeRepositoryTool(tool,definition,handlers)),
  });
}
