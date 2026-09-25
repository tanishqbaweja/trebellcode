import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export function repositoryToolHandlers({contextEngine,root,io=null}={}){
  if(!contextEngine)throw new Error("Repository tools require a Context Engine");
  if(!root)throw new Error("Repository tools require a workspace root");
  return {
    searchSymbols:({query,limit=40})=>contextEngine.searchSymbols({root,io,query,limit}),
    searchFiles:({query,limit=80})=>contextEngine.searchFiles({root,io,query,limit}),
    repositoryMap:({query="",limit=60})=>contextEngine.repositoryMap({root,io,query,limit}),
    fileRelations:({path})=>contextEngine.fileRelations({root,io,path}),
    relatedTests:({path=null,name=null,limit=80})=>contextEngine.relatedTests({root,io,path,name,limit}),
    callHierarchy:({name,path=null,limit=120})=>contextEngine.callHierarchy({root,io,name,path,limit}),
    diagnostics:({path,limit=100,semantic=false})=>contextEngine.diagnostics({root,io,path,limit,semantic}),
    languageSymbol:({path,line=1,column=1,operation="definition",limit=100})=>contextEngine.languageSymbol({root,io,path,line,column,operation,limit}),
    symbolReferences:({name,path=null,limit=120})=>contextEngine.symbolReferences({root,io,name,path,limit}),
    searchCode:({query,regex=false,caseSensitive=false,limit=80})=>contextEngine.searchCode({root,io,query,regex,caseSensitive,limit}),
    readSource:({path,startLine=1,endLine=null,maxLines=200})=>contextEngine.readSourceRange({root,io,path,startLine,endLine,maxLines}),
    gitContext:()=>contextEngine.gitContext({root,io}),
    gitHistory:({path="",limit=20})=>contextEngine.gitHistory({root,io,path,limit}),
    gitBlame:({path,startLine=1,endLine=null,maxLines=120})=>contextEngine.gitBlame({root,io,path,startLine,endLine,maxLines}),
  };
}

export function createClaudeRepositoryMcp({contextEngine,root,io=null,version="0.0.0"}={}){
  const handlers=repositoryToolHandlers({contextEngine,root,io});
  return createSdkMcpServer({
    name:"trebell_repository",
    version,
    instructions:"Use these deterministic Trebell repository-index tools for symbol discovery, structural relationships, bounded source retrieval, and Git context before doing broad manual exploration.",
    tools:[
      tool("search_symbols","Find repository symbol definitions by name or signature.",{query:z.string().min(1),limit:z.number().int().min(1).max(100).optional()},async args=>({content:[{type:"text",text:JSON.stringify(await handlers.searchSymbols(args))}]}),{searchHint:"repository symbols definitions"}),
      tool("search_files","Find repository files by path or basename with deterministic ranking.",{query:z.string().min(1).max(500),limit:z.number().int().min(1).max(200).optional()},async args=>({content:[{type:"text",text:JSON.stringify(await handlers.searchFiles(args))}]}),{searchHint:"repository files paths filenames"}),
      tool("repo_map","Inspect a bounded structural repository map ranked by task relevance and graph centrality.",{query:z.string().max(1000).optional(),limit:z.number().int().min(1).max(120).optional()},async args=>({content:[{type:"text",text:JSON.stringify(await handlers.repositoryMap(args))}]}),{searchHint:"repository map architecture structure modules central files"}),
      tool("file_relations","Inspect a source file's definitions, imports, importers, cross-file symbol references, and related tests.",{path:z.string().min(1)},async args=>({content:[{type:"text",text:JSON.stringify(await handlers.fileRelations(args))}]}),{searchHint:"repository imports references tests"}),
      tool("related_tests","Find tests structurally related to a source path or exact symbol definition.",{path:z.string().min(1).optional(),name:z.string().min(1).max(256).optional(),limit:z.number().int().min(1).max(200).optional()},async args=>({content:[{type:"text",text:JSON.stringify(await handlers.relatedTests(args))}]}),{searchHint:"repository related tests coverage source symbol"}),
      tool("call_hierarchy","Find bounded lexical AST callers and callees for a JavaScript or TypeScript symbol. Results are explicit lexical evidence, not full LSP semantic resolution.",{name:z.string().min(1).max(256),path:z.string().min(1).optional(),limit:z.number().int().min(1).max(200).optional()},async args=>({content:[{type:"text",text:JSON.stringify(await handlers.callHierarchy(args))}]}),{searchHint:"repository callers callees call hierarchy functions constructors"}),
      tool("diagnostics","Parse an indexed JavaScript or TypeScript source file and return bounded syntax diagnostics. Optionally ask the project-local TypeScript compiler for semantic diagnostics without installing anything or starting an always-on language server.",{path:z.string().min(1),limit:z.number().int().min(1).max(200).optional(),semantic:z.boolean().optional()},async args=>({content:[{type:"text",text:JSON.stringify(await handlers.diagnostics(args))}]}),{searchHint:"repository diagnostics syntax parser errors typescript semantic type errors"}),
      tool("language_symbol","Ask the project-local TypeScript language service for a semantic definition, references, or quick info at an exact source position. Returns unsupported instead of installing TypeScript when the project does not provide it.",{path:z.string().min(1),line:z.number().int().min(1),column:z.number().int().min(1).optional(),operation:z.enum(["definition","references","quick_info"]),limit:z.number().int().min(1).max(200).optional()},async args=>({content:[{type:"text",text:JSON.stringify(await handlers.languageSymbol(args))}]}),{searchHint:"typescript semantic definition references quick info type hover language intelligence"}),
      tool("symbol_references","Find bounded repository occurrences of a symbol, marking known definition lines and whether locations are AST- or text-backed.",{name:z.string().min(1).max(256),path:z.string().min(1).optional(),limit:z.number().int().min(1).max(200).optional()},async args=>({content:[{type:"text",text:JSON.stringify(await handlers.symbolReferences(args))}]}),{searchHint:"repository symbol references usages occurrences"}),
      tool("search_code","Search indexed repository source text with bounded literal or regular-expression matching.",{query:z.string().min(1).max(1000),regex:z.boolean().optional(),caseSensitive:z.boolean().optional(),limit:z.number().int().min(1).max(200).optional()},async args=>({content:[{type:"text",text:JSON.stringify(await handlers.searchCode(args))}]}),{searchHint:"repository code text exact regex search"}),
      tool("read_source","Read a bounded line range from an indexed repository source file.",{path:z.string().min(1),startLine:z.number().int().min(1).optional(),endLine:z.number().int().min(1).optional(),maxLines:z.number().int().min(1).max(400).optional()},async args=>({content:[{type:"text",text:JSON.stringify(await handlers.readSource(args))}]}),{searchHint:"repository source lines range"}),
      tool("git_context","Read bounded current Git status, changed paths, HEAD, and workspace diff.",{},async()=>({content:[{type:"text",text:JSON.stringify(await handlers.gitContext())}]}),{searchHint:"repository git diff status changes"}),
      tool("git_history","Read bounded repository or file Git history.",{path:z.string().min(1).optional(),limit:z.number().int().min(1).max(100).optional()},async args=>({content:[{type:"text",text:JSON.stringify(await handlers.gitHistory(args))}]}),{searchHint:"repository git history commits file history"}),
      tool("git_blame","Read bounded line-level Git blame for an indexed source file.",{path:z.string().min(1),startLine:z.number().int().min(1).optional(),endLine:z.number().int().min(1).optional(),maxLines:z.number().int().min(1).max(200).optional()},async args=>({content:[{type:"text",text:JSON.stringify(await handlers.gitBlame(args))}]}),{searchHint:"repository git blame authors commits lines"}),
    ],
  });
}
