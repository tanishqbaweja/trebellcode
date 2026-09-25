import { z } from "zod";
import { mcpAnnotationsForPolicy, REPOSITORY_READ_POLICY } from "./tool-policy.mjs";

export const REPOSITORY_TOOL_ANNOTATIONS=mcpAnnotationsForPolicy(REPOSITORY_READ_POLICY);
export const REPOSITORY_TOOL_INSTRUCTIONS="Use these deterministic Trebell repository-index tools for symbol discovery, structural relationships, bounded source retrieval, semantic evidence, durable project knowledge, verification, and Git context before doing broad manual exploration.";

export function repositoryToolHandlers({contextEngine,root,io=null,knowledgeService=null,environmentId=null}={}){
  if(!contextEngine)throw new Error("Repository tools require a Context Engine");
  if(!root)throw new Error("Repository tools require a workspace root");
  return {
    searchSymbols:({query,limit=40})=>contextEngine.searchSymbols({root,io,query,limit}),
    searchFiles:({query,limit=80})=>contextEngine.searchFiles({root,io,query,limit}),
    repositoryMap:({query="",limit=60})=>contextEngine.repositoryMap({root,io,query,limit}),
    projectCommands:({limit=120})=>contextEngine.projectCommands({root,io,limit}),
    verificationPlan:({paths=null,riskHints=[],capabilities={}})=>contextEngine.verificationPlan({root,io,paths,riskHints,capabilities}),
    verificationAssess:({plan,evidence=[]})=>contextEngine.assessVerification({plan,evidence}),
    verificationNext:({plan,evidence=[]})=>contextEngine.nextVerificationAction({plan,evidence}),
    fileRelations:({path})=>contextEngine.fileRelations({root,io,path}),
    relatedTests:({path=null,name=null,limit=80})=>contextEngine.relatedTests({root,io,path,name,limit}),
    callHierarchy:({name,path=null,limit=120})=>contextEngine.callHierarchy({root,io,name,path,limit}),
    diagnostics:({path,limit=100,semantic=false})=>contextEngine.diagnostics({root,io,path,limit,semantic}),
    languageSymbol:({path,line=1,column=1,operation="definition",limit=100})=>contextEngine.languageSymbol({root,io,path,line,column,operation,limit}),
    codeActions:({path,line=1,column=1,limit=20,codes=[]})=>contextEngine.codeActions({root,io,path,line,column,limit,codes}),
    organizeImports:({path,limit=200})=>contextEngine.organizeImports({root,io,path,limit}),
    renamePreview:({path,line=1,column=1,newName,limit=200})=>contextEngine.renamePreview({root,io,path,line,column,newName,limit}),
    symbolReferences:({name,path=null,limit=120})=>contextEngine.symbolReferences({root,io,name,path,limit}),
    searchCode:({query,regex=false,caseSensitive=false,limit=80})=>contextEngine.searchCode({root,io,query,regex,caseSensitive,limit}),
    readSource:({path,startLine=1,endLine=null,maxLines=200})=>contextEngine.readSourceRange({root,io,path,startLine,endLine,maxLines}),
    gitContext:()=>contextEngine.gitContext({root,io}),
    gitHistory:({path="",limit=20})=>contextEngine.gitHistory({root,io,path,limit}),
    gitBlame:({path,startLine=1,endLine=null,maxLines=120})=>contextEngine.gitBlame({root,io,path,startLine,endLine,maxLines}),
    knowledgeList:({query="",limit=20,includeUnverified=true})=>knowledgeService
      ?{supported:true,entries:knowledgeService.list({projectPath:root,environmentId,query,limit,includeUnverified})}
      :{supported:false,reason:"Repository knowledge is unavailable for this runtime."},
    knowledgeContext:async({query="",limit=20,refresh=true})=>knowledgeService
      ?{supported:true,...await knowledgeService.context({projectPath:root,environmentId,query,limit,refresh})}
      :{supported:false,reason:"Repository knowledge is unavailable for this runtime.",entries:[],context:""},
  };
}

function definition(name,handler,description,inputSchema,searchHint){
  return Object.freeze({name,handler,description,inputSchema,searchHint,policy:REPOSITORY_READ_POLICY,annotations:REPOSITORY_TOOL_ANNOTATIONS});
}

export const REPOSITORY_TOOL_DEFINITIONS=Object.freeze([
  definition("search_symbols","searchSymbols","Find repository symbol definitions by name or signature.",{query:z.string().min(1),limit:z.number().int().min(1).max(100).optional()},"repository symbols definitions"),
  definition("search_files","searchFiles","Find repository files by path or basename with deterministic ranking.",{query:z.string().min(1).max(500),limit:z.number().int().min(1).max(200).optional()},"repository files paths filenames"),
  definition("repo_map","repositoryMap","Inspect a bounded structural repository map ranked by task relevance and graph centrality.",{query:z.string().max(1000).optional(),limit:z.number().int().min(1).max(120).optional()},"repository map architecture structure modules central files"),
  definition("project_commands","projectCommands","Discover bounded repository-declared build, test, lint, typecheck, format, dev, and start commands plus clearly labeled ecosystem conventions.",{limit:z.number().int().min(1).max(240).optional()},"repository project commands scripts build test lint typecheck package manager make just cargo go pytest maven gradle"),
  definition("verification_plan","verificationPlan","Build a deterministic risk-aware verification plan from changed or explicit paths, related tests, and discovered project commands. This plans evidence only; it does not execute commands or spawn reviewer models.",{paths:z.array(z.string().min(1)).max(200).optional(),riskHints:z.array(z.string().min(1).max(80)).max(20).optional(),capabilities:z.object({diagnostics:z.boolean().optional(),semanticDiagnostics:z.boolean().optional()}).optional()},"verification plan changed files risk tests build browser screenshot integration evidence"),
  definition("verification_assess","verificationAssess","Assess recorded verification evidence against a verification plan and return verified, failed, blocked, or incomplete completion state. This is deterministic and does not execute commands or call another model.",{plan:z.record(z.string(),z.unknown()),evidence:z.array(z.record(z.string(),z.unknown())).max(300).optional()},"verification evidence completion status passed failed blocked missing repair"),
  definition("verification_next","verificationNext","Choose the next deterministic verification action from a plan and recorded evidence: verify the cheapest missing required step, repair a failure, resolve a blocker, or complete. Independent review remains advisory.",{plan:z.record(z.string(),z.unknown()),evidence:z.array(z.record(z.string(),z.unknown())).max(300).optional()},"verification next action repair blocker cheapest remaining step complete same agent loop"),
  definition("file_relations","fileRelations","Inspect a source file's definitions, imports, importers, cross-file symbol references, and related tests.",{path:z.string().min(1)},"repository imports references tests"),
  definition("related_tests","relatedTests","Find tests structurally related to a source path or exact symbol definition.",{path:z.string().min(1).optional(),name:z.string().min(1).max(256).optional(),limit:z.number().int().min(1).max(200).optional()},"repository related tests coverage source symbol"),
  definition("call_hierarchy","callHierarchy","Find bounded lexical AST callers and callees for a JavaScript or TypeScript symbol. Results are explicit lexical evidence, not full LSP semantic resolution.",{name:z.string().min(1).max(256),path:z.string().min(1).optional(),limit:z.number().int().min(1).max(200).optional()},"repository callers callees call hierarchy functions constructors"),
  definition("diagnostics","diagnostics","Parse an indexed JavaScript or TypeScript source file and return bounded syntax diagnostics. Optionally ask the project-local TypeScript compiler for semantic diagnostics without installing anything or starting an always-on language server.",{path:z.string().min(1),limit:z.number().int().min(1).max(200).optional(),semantic:z.boolean().optional()},"repository diagnostics syntax parser errors typescript semantic type errors"),
  definition("language_symbol","languageSymbol","Ask the project-local TypeScript language service for a semantic definition, references, quick info, callers, or callees at an exact source position. Returns unsupported instead of installing TypeScript when the project does not provide it.",{path:z.string().min(1),line:z.number().int().min(1),column:z.number().int().min(1).optional(),operation:z.enum(["definition","references","quick_info","callers","callees"]),limit:z.number().int().min(1).max(200).optional()},"typescript semantic definition references quick info type hover callers callees call hierarchy language intelligence"),
  definition("code_actions","codeActions","Ask the project-local TypeScript language service for bounded non-mutating code fixes at an exact diagnostic position. Returns proposed text edits and flags extra commands without executing them.",{path:z.string().min(1),line:z.number().int().min(1),column:z.number().int().min(1).optional(),limit:z.number().int().min(1).max(100).optional(),codes:z.array(z.number().int()).max(50).optional()},"typescript code actions code fixes quick fix diagnostic edits repair"),
  definition("organize_imports","organizeImports","Ask the project-local TypeScript language service for bounded non-mutating import-organization edits for one indexed JS/TS file.",{path:z.string().min(1),limit:z.number().int().min(1).max(500).optional()},"typescript organize imports remove unused imports sort imports refactor edits"),
  definition("rename_preview","renamePreview","Ask the project-local TypeScript language service to validate a semantic rename and return the exact bounded edits without changing files.",{path:z.string().min(1),line:z.number().int().min(1),column:z.number().int().min(1).optional(),newName:z.string().min(1).max(256),limit:z.number().int().min(1).max(500).optional()},"typescript semantic rename symbol refactor preview exact edits"),
  definition("symbol_references","symbolReferences","Find bounded repository occurrences of a symbol, marking known definition lines and whether locations are AST- or text-backed.",{name:z.string().min(1).max(256),path:z.string().min(1).optional(),limit:z.number().int().min(1).max(200).optional()},"repository symbol references usages occurrences"),
  definition("search_code","searchCode","Search indexed repository source text with bounded literal or regular-expression matching.",{query:z.string().min(1).max(1000),regex:z.boolean().optional(),caseSensitive:z.boolean().optional(),limit:z.number().int().min(1).max(200).optional()},"repository code text exact regex search"),
  definition("read_source","readSource","Read a bounded line range from an indexed repository source file.",{path:z.string().min(1),startLine:z.number().int().min(1).optional(),endLine:z.number().int().min(1).optional(),maxLines:z.number().int().min(1).max(400).optional()},"repository source lines range"),
  definition("git_context","gitContext","Read bounded current Git status, changed paths, HEAD, and workspace diff.",{},"repository git diff status changes"),
  definition("git_history","gitHistory","Read bounded repository or file Git history.",{path:z.string().min(1).optional(),limit:z.number().int().min(1).max(100).optional()},"repository git history commits file history"),
  definition("git_blame","gitBlame","Read bounded line-level Git blame for an indexed source file.",{path:z.string().min(1),startLine:z.number().int().min(1).optional(),endLine:z.number().int().min(1).optional(),maxLines:z.number().int().min(1).max(200).optional()},"repository git blame authors commits lines"),
  definition("knowledge_list","knowledgeList","List bounded durable Trebell repository facts relevant to the current task. Stale facts are excluded.",{query:z.string().max(1000).optional(),limit:z.number().int().min(1).max(100).optional(),includeUnverified:z.boolean().optional()},"repository durable knowledge architecture conventions decisions commands evidence"),
  definition("knowledge_context","knowledgeContext","Retrieve bounded task-relevant durable repository knowledge and refresh evidence-backed facts before returning them.",{query:z.string().max(1000).optional(),limit:z.number().int().min(1).max(100).optional(),refresh:z.boolean().optional()},"repository knowledge context verified evidence stale facts decisions conventions"),
]);

export function repositoryDynamicToolNamespace(){
  return [{
    type:"namespace",
    name:"trebell_repo",
    description:"Query Trebell's deterministic repository intelligence, verification helpers, Git evidence, and durable evidence-backed repository knowledge.",
    tools:REPOSITORY_TOOL_DEFINITIONS.map(definition=>{
      const inputSchema=z.toJSONSchema(z.object(definition.inputSchema));
      delete inputSchema.$schema;
      return {type:"function",name:definition.name,description:definition.description,inputSchema};
    }),
  }];
}

export function invokeRepositoryTool(handlers,definition,args={}){
  const handler=handlers?.[definition?.handler];
  if(typeof handler!=="function")throw new Error(`Repository tool handler is unavailable: ${definition?.name||"unknown"}`);
  return handler(args||{});
}
