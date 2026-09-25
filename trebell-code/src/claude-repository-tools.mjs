import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  REPOSITORY_TOOL_DEFINITIONS,
  REPOSITORY_TOOL_INSTRUCTIONS,
  invokeRepositoryTool,
  repositoryToolHandlers,
} from "./repository-tool-catalog.mjs";

function repositoryTool(definition,handlers){
  return tool(
    definition.name,
    definition.description,
    definition.inputSchema,
    async args=>({content:[{type:"text",text:JSON.stringify(await invokeRepositoryTool(handlers,definition,args))}]}),
    {searchHint:definition.searchHint,annotations:definition.annotations},
  );
}

export { repositoryToolHandlers };

export function createClaudeRepositoryMcp({contextEngine,root,io=null,version="0.0.0"}={}){
  const handlers=repositoryToolHandlers({contextEngine,root,io});
  return createSdkMcpServer({
    name:"trebell_repository",
    version,
    instructions:REPOSITORY_TOOL_INSTRUCTIONS,
    tools:REPOSITORY_TOOL_DEFINITIONS.map(definition=>repositoryTool(definition,handlers)),
  });
}
