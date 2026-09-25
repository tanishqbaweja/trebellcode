import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export function repositoryToolHandlers({contextEngine,root,io=null}={}){
  if(!contextEngine)throw new Error("Repository tools require a Context Engine");
  if(!root)throw new Error("Repository tools require a workspace root");
  return {
    searchSymbols:({query,limit=40})=>contextEngine.searchSymbols({root,io,query,limit}),
    fileRelations:({path})=>contextEngine.fileRelations({root,io,path}),
  };
}

export function createClaudeRepositoryMcp({contextEngine,root,io=null,version="0.0.0"}={}){
  const handlers=repositoryToolHandlers({contextEngine,root,io});
  return createSdkMcpServer({
    name:"trebell_repository",
    version,
    instructions:"Use these deterministic Trebell repository-index tools for symbol discovery and structural relationships before doing broad manual exploration.",
    tools:[
      tool("search_symbols","Find repository symbol definitions by name or signature.",{query:z.string().min(1),limit:z.number().int().min(1).max(100).optional()},async args=>({content:[{type:"text",text:JSON.stringify(await handlers.searchSymbols(args))}]}),{searchHint:"repository symbols definitions"}),
      tool("file_relations","Inspect a source file's definitions, imports, importers, cross-file symbol references, and related tests.",{path:z.string().min(1)},async args=>({content:[{type:"text",text:JSON.stringify(await handlers.fileRelations(args))}]}),{searchHint:"repository imports references tests"}),
    ],
  });
}
