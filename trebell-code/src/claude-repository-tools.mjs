import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export function repositoryToolHandlers({contextEngine,root,io=null}={}){
  if(!contextEngine)throw new Error("Repository tools require a Context Engine");
  if(!root)throw new Error("Repository tools require a workspace root");
  return {
    searchSymbols:({query,limit=40})=>contextEngine.searchSymbols({root,io,query,limit}),
    fileRelations:({path})=>contextEngine.fileRelations({root,io,path}),
    searchCode:({query,regex=false,caseSensitive=false,limit=80})=>contextEngine.searchCode({root,io,query,regex,caseSensitive,limit}),
    readSource:({path,startLine=1,endLine=null,maxLines=200})=>contextEngine.readSourceRange({root,io,path,startLine,endLine,maxLines}),
    gitContext:()=>contextEngine.gitContext({root,io}),
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
      tool("search_code","Search indexed repository source text with bounded literal or regular-expression matching.",{query:z.string().min(1).max(1000),regex:z.boolean().optional(),caseSensitive:z.boolean().optional(),limit:z.number().int().min(1).max(200).optional()},async args=>({content:[{type:"text",text:JSON.stringify(await handlers.searchCode(args))}]}),{searchHint:"repository code text exact regex search"}),
      tool("read_source","Read a bounded line range from an indexed repository source file.",{path:z.string().min(1),startLine:z.number().int().min(1).optional(),endLine:z.number().int().min(1).optional(),maxLines:z.number().int().min(1).max(400).optional()},async args=>({content:[{type:"text",text:JSON.stringify(await handlers.readSource(args))}]}),{searchHint:"repository source lines range"}),
      tool("git_context","Read bounded current Git status, changed paths, HEAD, and workspace diff.",{},async()=>({content:[{type:"text",text:JSON.stringify(await handlers.gitContext())}]}),{searchHint:"repository git diff status changes"}),
    ],
  });
}
