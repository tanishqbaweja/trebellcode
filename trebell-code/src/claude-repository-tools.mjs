import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  REPOSITORY_TOOL_DEFINITIONS,
  REPOSITORY_TOOL_INSTRUCTIONS,
  invokeRepositoryTool,
  repositoryToolHandlers as sharedRepositoryToolHandlers,
} from "./repository-tool-catalog.mjs";

export const repositoryToolHandlers=sharedRepositoryToolHandlers;

function claudeRepositoryTool(definition,handlers){
  return tool(
    definition.name,
    definition.description,
    definition.inputSchema,
    async args=>({content:[{type:"text",text:JSON.stringify(await invokeRepositoryTool(handlers,definition,args))}]}),
    {searchHint:definition.searchHint,annotations:definition.annotations},
  );
}

export function createClaudeRepositoryMcp({contextEngine,root,io=null,knowledgeService=null,environmentId=null,version="0.0.0"}={}){
  const handlers=sharedRepositoryToolHandlers({contextEngine,root,io,knowledgeService,environmentId});
  return createSdkMcpServer({
    name:"trebell_repository",
    version,
    instructions:REPOSITORY_TOOL_INSTRUCTIONS,
    tools:REPOSITORY_TOOL_DEFINITIONS.map(definition=>claudeRepositoryTool(definition,handlers)),
  });
}
