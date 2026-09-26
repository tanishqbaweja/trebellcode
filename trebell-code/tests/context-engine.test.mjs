import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ContextEngine, createRemoteContextIo, pageRank, parseSource, planContextBudget } from "../src/context-engine.mjs";

test("JavaScript and TypeScript structure uses a real parser with graceful regex fallback",()=>{
  const parsed=parseSource(`
import {
  rotateRefreshToken as rotate,
  type Token,
} from "./token.js";
export { verifyToken } from "./token.js";
export interface SessionOptions { token: Token }
export type SessionState = "fresh" | "expired";
export enum SessionMode { Strict, Relaxed }
export const createSession =
  (options: SessionOptions) => rotate(options.token);
const misleading = "GhostSymbol";
// GhostComment should not become a reference either.
`,"src/session.ts");
  assert.equal(parsed.parser,"babel");
  assert.deepEqual(parsed.imports,["./token.js"]);
  const definitions=new Map(parsed.definitions.map(item=>[item.name,item.kind]));
  assert.equal(definitions.get("SessionOptions"),"interface");
  assert.equal(definitions.get("SessionState"),"type");
  assert.equal(definitions.get("SessionMode"),"enum");
  assert.equal(definitions.get("createSession"),"function");
  assert.ok(parsed.references.has("rotateRefreshToken"),"aliased import should retain the exported symbol relationship");
  assert.equal(parsed.references.has("GhostSymbol"),false,"string contents must not create structural references");
  assert.equal(parsed.references.has("GhostComment"),false,"comments must not create structural references");

  const fallback=parseSource("function broken( {", "src/broken.js");
  assert.equal(fallback.parser,"regex");
  assert.ok(fallback.definitions.some(item=>item.name==="broken"));
});

test("context budgeting is deterministic and shrinks repository injection as the active context fills",()=>{
  const focused=planContextBudget({task:"Rename the save button"});
  assert.equal(focused.mode,"focused");assert.equal(focused.maxTokens,2800);assert.equal(focused.maxFiles,12);
  const broad=planContextBudget({task:"Refactor the repository architecture end-to-end across the codebase, integrations, tests, and runtime adapters so the system-wide context flow is consistent.",focusPaths:["a.js","b.js","c.js","d.js","e.js"]});
  assert.equal(broad.mode,"broad");assert.equal(broad.maxTokens,7000);assert.equal(broad.maxFiles,24);
  const tight=planContextBudget({task:"Continue the refactor",tokensUsed:75_000,contextWindow:100_000});
  assert.equal(tight.mode,"tight");assert.equal(tight.maxTokens,2800);assert.equal(tight.maxFiles,12);assert.equal(tight.utilizationPercent,75);
  const critical=planContextBudget({task:"Continue",tokensUsed:90_000,contextWindow:100_000});
  assert.equal(critical.mode,"critical");assert.equal(critical.maxTokens,1600);assert.equal(critical.maxFiles,8);assert.equal(critical.skip,false);
  const exhausted=planContextBudget({task:"Continue",tokensUsed:93_000,contextWindow:100_000});
  assert.equal(exhausted.mode,"exhausted");assert.equal(exhausted.maxTokens,0);assert.equal(exhausted.maxFiles,0);assert.equal(exhausted.skip,true);
  assert.equal(exhausted.remainingTokens,7000);assert.equal(exhausted.reserveTokens,8000);
  const explicit=planContextBudget({task:"Continue",tokensUsed:90_000,contextWindow:100_000,maxTokens:1900,maxFiles:9});
  assert.equal(explicit.maxTokens,1600);assert.equal(explicit.maxFiles,8);assert.equal(explicit.cappedByCaller,false);
  const capped=planContextBudget({task:"Refactor repository architecture",maxTokens:1200,maxFiles:6});
  assert.equal(capped.maxTokens,1200);assert.equal(capped.maxFiles,6);assert.equal(capped.cappedByCaller,true);
});

test("exhausted context budget skips repository I/O entirely",async()=>{
  const engine=new ContextEngine();let touched=false;
  const io={
    root:"/srv/app",cacheKey:"fixture:/srv/app",
    discoverFiles:async()=>{touched=true;return []},
    metadata:async()=>{touched=true;return new Map()},
    readMany:async()=>{touched=true;return new Map()},
    readText:async()=>{touched=true;return ""},
    gitState:async()=>{touched=true;return {isGit:true,changed:new Set(),status:"",diff:""}},
    relativeFocus:path=>path,
  };
  const packet=await engine.buildPacket({root:"/srv/app",io,task:"Continue",tokensUsed:93_000,contextWindow:100_000});
  assert.equal(packet.skipped,true);assert.equal(packet.injection,"");assert.equal(packet.tokenEstimate,0);
  assert.equal(packet.stats.skippedByPressure,true);assert.equal(touched,false);
});

test("pre-cancelled context builds stop before repository I/O",async()=>{
  const engine=new ContextEngine(),controller=new AbortController();let touched=false;controller.abort();
  const io={
    root:"/srv/app",cacheKey:"fixture:/srv/app",
    discoverFiles:async()=>{touched=true;return []},metadata:async()=>{touched=true;return new Map()},readMany:async()=>{touched=true;return new Map()},readText:async()=>{touched=true;return ""},
    gitState:async()=>{touched=true;return {isGit:false,head:null,changed:new Set(),status:"",diff:""}},relativeFocus:path=>path,
  };
  await assert.rejects(engine.buildPacket({root:"/srv/app",io,task:"Inspect auth",signal:controller.signal}),error=>error?.name==="AbortError");
  assert.equal(touched,false);
});

test("cancelled indexing never publishes a partial cache",async()=>{
  const engine=new ContextEngine(),controller=new AbortController(),paths=["src/a.js","src/b.js"];let readCalls=0;
  const contents=new Map([
    ["src/a.js","export function alpha(){ return 1; }\n"],
    ["src/b.js","import { alpha } from './a.js'; export function beta(){ return alpha(); }\n"],
  ]);
  const io={
    root:"/srv/app",cacheKey:"fixture:/cancelled-index",
    discoverFiles:async()=>paths,
    metadata:async requested=>new Map(requested.map(path=>[path,{size:contents.get(path).length,version:"v1"}])),
    readMany:async(requested,_maxBytes,{signal}={})=>{
      readCalls++;
      if(signal)await new Promise((resolve,reject)=>{
        const timer=setTimeout(resolve,100);
        signal.addEventListener("abort",()=>{clearTimeout(timer);const error=new Error("cancelled");error.name="AbortError";reject(error)},{once:true});
      });
      return new Map(requested.map(path=>[path,contents.get(path)]));
    },
    readText:async path=>contents.get(path)||"",
    gitState:async()=>({isGit:false,head:null,changed:new Set(),status:"",diff:""}),
    relativeFocus:path=>path,
  };
  const pending=engine.buildPacket({root:"/srv/app",io,task:"Inspect alpha and beta",signal:controller.signal});
  setTimeout(()=>controller.abort(),10);
  await assert.rejects(pending,error=>error?.name==="AbortError");
  const retry=await engine.buildPacket({root:"/srv/app",io,task:"Inspect alpha and beta"});
  assert.equal(retry.stats.filesIndexed,2);assert.equal(retry.stats.reparsed,2);assert.equal(retry.stats.reused,0);assert.equal(readCalls,2);
});

const execFileAsync=promisify(execFile);

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"trebell-context-"));
  await mkdir(join(root,"src","auth"),{recursive:true});
  await mkdir(join(root,"tests"),{recursive:true});
  await writeFile(join(root,"AGENTS.md"),"Keep authentication changes covered by tests.\n","utf8");
  await writeFile(join(root,"src","auth","token.js"),`export function rotateRefreshToken(token) {\n  return token + "-rotated";\n}\nexport function verifyToken(token) { return Boolean(token); }\n`,"utf8");
  await writeFile(join(root,"src","auth","session.js"),`import { rotateRefreshToken } from "./token.js";\nexport class RefreshSession {\n  refresh(token) { return rotateRefreshToken(token); }\n}\n`,"utf8");
  await writeFile(join(root,"src","server.js"),`import { RefreshSession } from "./auth/session.js";\nexport function startServer() { return new RefreshSession(); }\n`,"utf8");
  await writeFile(join(root,"tests","auth-refresh.test.js"),`import { RefreshSession } from "../src/auth/session.js";\nexport function testRefresh() { return new RefreshSession().refresh("x"); }\n`,"utf8");
  await execFileAsync("git",["init","-q"],{cwd:root});
  await execFileAsync("git",["add","."],{cwd:root});
  return root;
}

test("context engine ranks task-relevant code, instructions and tests under a hard budget",async()=>{
  const root=await fixture();
  try{
    const engine=new ContextEngine();
    const packet=await engine.buildPacket({root,task:"Fix the refresh token session bug",maxTokens:1800,maxFiles:8});
    assert.ok(packet.tokenEstimate<=1800,`packet used ${packet.tokenEstimate} tokens`);
    assert.match(packet.injection,/Keep authentication changes covered by tests/);
    assert.match(packet.instructionInjection,/Keep authentication changes covered by tests/);
    assert.doesNotMatch(packet.untrustedInjection,/Keep authentication changes covered by tests/);
    assert.match(packet.untrustedInjection,/untrusted data/i);
    assert.match(packet.untrustedInjection,/src\/auth\/session\.js/);
    const paths=packet.items.map(item=>item.path);
    assert.ok(paths.includes("src/auth/session.js"),paths.join(", "));
    assert.ok(paths.includes("src/auth/token.js"),paths.join(", "));
    assert.ok(paths.includes("tests/auth-refresh.test.js"),paths.join(", "));
    const session=packet.items.find(item=>item.path==="src/auth/session.js");
    assert.equal(session.parser,"babel");
    assert.ok(session.reasons.some(reason=>/task-related symbol|task terms|path matches/i.test(reason)));
    assert.ok(packet.stats.graphEdges>=3);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("context engine exposes deterministic symbol and file relationship queries",async()=>{
  const root=await fixture();
  try{
    const engine=new ContextEngine();
    const symbols=await engine.searchSymbols({root,query:"RefreshSession"});
    assert.equal(symbols.data[0].path,"src/auth/session.js");
    assert.equal(symbols.data[0].name,"RefreshSession");
    assert.equal(symbols.data[0].kind,"class");
    assert.equal(symbols.data[0].parser,"babel");

    const files=await engine.searchFiles({root,query:"session"});
    assert.ok(files.data.some(item=>item.path==="src/auth/session.js"&&item.indexedSource===true));
    const repoMap=await engine.repositoryMap({root,query:"refresh session",limit:8});
    assert.ok(repoMap.graphEdges>=3);
    assert.ok(repoMap.data.some(item=>item.path==="src/auth/session.js"&&item.definitions.some(definition=>definition.name==="RefreshSession")));
    assert.ok(repoMap.data.some(item=>item.path==="src/auth/token.js"));

    const relations=await engine.fileRelations({root,path:"src/auth/session.js"});
    assert.ok(relations.imports.some(item=>item.specifier==="./token.js"&&item.target==="src/auth/token.js"));
    assert.ok(relations.importers.some(item=>item.path==="src/server.js"));
    assert.ok(relations.importers.some(item=>item.path==="tests/auth-refresh.test.js"));
    assert.ok(relations.referencedSymbols.some(item=>item.name==="rotateRefreshToken"&&item.target==="src/auth/token.js"));
    assert.ok(relations.referencedBy.some(item=>item.name==="RefreshSession"&&item.path==="src/server.js"));
    assert.deepEqual(relations.relatedTests,["tests/auth-refresh.test.js"]);
    const references=await engine.symbolReferences({root,name:"RefreshSession"});
    assert.ok(references.data.some(item=>item.path==="src/auth/session.js"&&item.definition===true&&item.precision==="ast"));
    assert.ok(references.data.some(item=>item.path==="src/server.js"&&item.line===2&&item.definition===false&&item.precision==="ast"));
    assert.ok(references.data.some(item=>item.path==="tests/auth-refresh.test.js"&&item.precision==="ast"));
    const relatedByPath=await engine.relatedTests({root,path:"src/auth/session.js"});
    assert.deepEqual(relatedByPath.data.map(item=>item.path),["tests/auth-refresh.test.js"]);
    const relatedBySymbol=await engine.relatedTests({root,name:"RefreshSession"});
    assert.deepEqual(relatedBySymbol.data.map(item=>item.path),["tests/auth-refresh.test.js"]);
    const classCalls=await engine.callHierarchy({root,name:"RefreshSession"});
    assert.equal(classCalls.semantic,false);assert.equal(classCalls.precision,"ast-lexical");
    assert.ok(classCalls.callers.some(item=>item.path==="src/server.js"&&item.caller==="startServer"&&item.kind==="construct"));
    assert.ok(classCalls.callers.some(item=>item.path==="tests/auth-refresh.test.js"&&item.caller==="testRefresh"));
    const serverCalls=await engine.callHierarchy({root,name:"startServer"});
    assert.ok(serverCalls.callees.some(item=>item.callee==="RefreshSession"&&item.kind==="construct"));
    await assert.rejects(()=>engine.relatedTests({root}),/path or symbol name/i);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("context engine discovers repository-declared and conventional project commands",async()=>{
  const root=await fixture();
  try{
    await writeFile(join(root,"package.json"),JSON.stringify({packageManager:"pnpm@10.0.0",scripts:{test:"node --test",build:"vite build",lint:"eslint .",dev:"vite"}},null,2),"utf8");
    await writeFile(join(root,"Makefile"),"verify:\n\t@echo verify\nbuild-native:\n\t@echo build\n","utf8");
    await writeFile(join(root,"Cargo.toml"),"[package]\nname = \"fixture\"\nversion = \"0.1.0\"\n","utf8");
    await writeFile(join(root,"pyproject.toml"),"[tool.pytest.ini_options]\naddopts = \"-q\"\n","utf8");
    const engine=new ContextEngine(),commands=await engine.projectCommands({root});
    const declared=commands.declared.map(item=>item.command),conventional=commands.conventional.map(item=>item.command);
    assert.ok(declared.includes("pnpm run test"));assert.ok(declared.includes("pnpm run build"));assert.ok(declared.includes("make verify"));
    assert.equal(commands.declared.find(item=>item.command==="pnpm run lint").confidence,"declared");
    assert.ok(conventional.includes("cargo test"));assert.ok(conventional.includes("cargo check"));assert.ok(conventional.includes("python -m pytest"));
    assert.equal(commands.conventional.find(item=>item.command==="cargo test").confidence,"convention");
    assert.ok(commands.manifests.includes("package.json"));assert.ok(commands.manifests.includes("Cargo.toml"));
  }finally{await rm(root,{recursive:true,force:true})}
});

test("context engine builds risk-aware verification plans from repo changes and related tests",async()=>{
  const root=await fixture();
  try{
    await writeFile(join(root,"package.json"),JSON.stringify({packageManager:"pnpm@10.0.0",scripts:{test:"node --test",build:"vite build"}},null,2),"utf8");
    const engine=new ContextEngine(),plan=await engine.verificationPlan({root,paths:["src/auth/session.js"]});
    assert.equal(plan.pathSource,"explicit");
    assert.deepEqual(plan.paths,["src/auth/session.js"]);
    assert.equal(plan.risk,"high");
    assert.equal(plan.categories.auth,true);
    assert.deepEqual(plan.relatedTests,["tests/auth-refresh.test.js"]);
    assert.ok(plan.steps.some(step=>step.id==="diagnostics"));
    assert.ok(plan.steps.some(step=>step.id==="targeted_tests"&&step.command==="pnpm run test"));
    assert.ok(plan.steps.some(step=>step.id==="build"&&step.command==="pnpm run build"));
    assert.ok(plan.steps.some(step=>step.id==="integration"&&step.required===true));
  }finally{await rm(root,{recursive:true,force:true})}
});

test("context engine exposes bounded code search, source ranges, and Git context",async()=>{
  const root=await fixture();
  try{
    const padding="// filler line\n".repeat(5200),marker="export const DistantNeedle = 42;\n";
    await writeFile(join(root,"src","large.js"),padding+marker,"utf8");
    await execFileAsync("git",["add","src/large.js"],{cwd:root});
    const engine=new ContextEngine();
    const literal=await engine.searchCode({root,query:"distantneedle",limit:10});
    assert.equal(literal.source,"git-grep");
    assert.equal(literal.data.length,1);
    assert.equal(literal.data[0].path,"src/large.js");
    assert.ok(literal.data[0].line>5000,"search must inspect the full indexed file, not only the 64 KB cache sample");
    const regex=await engine.searchCode({root,query:"DistantNeedle\\s*=\\s*42",regex:true,caseSensitive:true,limit:10});
    assert.equal(regex.data[0].line,literal.data[0].line);

    const source=await engine.readSourceRange({root,path:"src/large.js",startLine:literal.data[0].line,endLine:literal.data[0].line+20,maxLines:4});
    assert.equal(source.startLine,literal.data[0].line);
    assert.ok(source.endLine-source.startLine<4);
    assert.match(source.content,/DistantNeedle = 42/);
    await assert.rejects(()=>engine.readSourceRange({root,path:"../outside.js",startLine:1}),/not indexed/i);

    await writeFile(join(root,"src","auth","session.js"),`import { rotateRefreshToken } from "./token.js";\nexport class RefreshSession { refresh(token) { return rotateRefreshToken(token); } }\nexport const gitContextMarker = true;\n`,"utf8");
    const git=await engine.gitContext({root});
    assert.equal(git.isGit,true);
    assert.ok(git.changed.includes("src/auth/session.js"));
    assert.match(git.status,/src\/auth\/session\.js/);
    assert.match(git.diff,/gitContextMarker/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("context engine exposes honest bounded JavaScript TypeScript Python and Go syntax diagnostics",async()=>{
  const root=await fixture();
  try{
    await writeFile(join(root,"src","broken.ts"),"export const broken: string = ;\n","utf8");
    await writeFile(join(root,"src","typed.ts"),"export const typed: string = 1;\n","utf8");
    await writeFile(join(root,"src","tool.py"),"def tool():\n    return True\n","utf8");
    await writeFile(join(root,"src","broken.py"),"def broken(:\n    return True\n","utf8");
    await writeFile(join(root,"src","tool.go"),"package fixture\nfunc Add(a int, b int) int { return a + b }\n","utf8");
    await writeFile(join(root,"src","broken.go"),"package fixture\nfunc Broken( {\n","utf8");
    const engine=new ContextEngine(),broken=await engine.diagnostics({root,path:"src/broken.ts"});
    assert.equal(broken.supported,true);assert.equal(broken.engine,"babel-parser");assert.equal(broken.semantic,false);assert.ok(broken.diagnostics.length>=1);
    assert.equal(broken.diagnostics[0].severity,"error");assert.ok(broken.diagnostics[0].line>=1);assert.ok(broken.diagnostics[0].column>=1);
    const valid=await engine.diagnostics({root,path:"src/auth/session.js"});
    assert.equal(valid.supported,true);assert.deepEqual(valid.diagnostics,[]);
    const pythonValid=await engine.diagnostics({root,path:"src/tool.py",semantic:true});
    if(pythonValid.supported){
      assert.equal(pythonValid.engine,"python-ast");assert.equal(pythonValid.semantic,false);assert.equal(pythonValid.semanticRequested,true);assert.deepEqual(pythonValid.diagnostics,[]);assert.match(pythonValid.semanticInfo.reason,/Pyright/i);
      const pythonBroken=await engine.diagnostics({root,path:"src/broken.py"});
      assert.equal(pythonBroken.supported,true);assert.equal(pythonBroken.engine,"python-ast");assert.equal(pythonBroken.diagnostics[0].code,"PY_SYNTAX");assert.equal(pythonBroken.diagnostics[0].severity,"error");assert.ok(pythonBroken.diagnostics[0].line>=1);
    }else assert.match(pythonValid.reason,/python interpreter/i);
    const goValid=await engine.diagnostics({root,path:"src/tool.go",semantic:true});
    if(goValid.supported){
      assert.equal(goValid.engine,"gofmt");assert.equal(goValid.semantic,false);assert.equal(goValid.semanticRequested,true);assert.deepEqual(goValid.diagnostics,[]);
      const goBroken=await engine.diagnostics({root,path:"src/broken.go"});assert.equal(goBroken.supported,true);assert.equal(goBroken.engine,"gofmt");assert.equal(goBroken.diagnostics[0].code,"GO_SYNTAX");assert.equal(goBroken.diagnostics[0].severity,"error");assert.ok(goBroken.diagnostics[0].line>=1);assert.ok(goBroken.diagnostics[0].column>=1);
    }else assert.match(goValid.reason,/gofmt/i);
    await mkdir(join(root,"node_modules","pyright"),{recursive:true});
    await writeFile(join(root,"node_modules","pyright","index.js"),`const target=process.argv.at(-1);process.stdout.write(JSON.stringify({version:"fixture-pyright",generalDiagnostics:[{file:target,severity:"error",message:"Fixture Python type mismatch",rule:"reportAssignmentType",range:{start:{line:0,character:4},end:{line:0,character:8}}}],summary:{filesAnalyzed:1,errorCount:1,warningCount:0,informationCount:0}}));\n`,"utf8");
    const pyright=await engine.diagnostics({root,path:"src/tool.py",semantic:true});
    assert.equal(pyright.semantic,true);assert.equal(pyright.semanticEngine,"pyright");assert.equal(pyright.semanticInfo.version,"fixture-pyright");assert.equal(pyright.semanticDiagnostics[0].code,"reportAssignmentType");assert.equal(pyright.semanticDiagnostics[0].line,1);assert.match(pyright.semanticDiagnostics[0].message,/type mismatch/i);
    await mkdir(join(root,"node_modules","typescript","lib"),{recursive:true});
    await writeFile(join(root,"tsconfig.json"),"{}\n","utf8");
    await writeFile(join(root,"node_modules","typescript","lib","typescript.js"),`const fs=require("fs"),path=require("path");
const makeProgram=rootNames=>{const fileName=rootNames[0],file={fileName,getLineAndCharacterOfPosition:position=>({line:0,character:position}),getPositionOfLineAndCharacter:(_line,column)=>column};return{file,getSourceFile:value=>path.resolve(value)===path.resolve(fileName)?file:undefined}};
module.exports={version:"fixture-ts",sys:{fileExists:fs.existsSync,readFile:p=>fs.readFileSync(p,"utf8"),readDirectory:()=>[],directoryExists:fs.existsSync,getDirectories:()=>[],useCaseSensitiveFileNames:true,newLine:"\\n"},ScriptSnapshot:{fromString:text=>({text})},findConfigFile:root=>path.join(root,"tsconfig.json"),readConfigFile:()=>({config:{}}),parseJsonConfigFileContent:(_c,_s,base)=>({fileNames:[path.join(base,"src","typed.ts")],options:{},errors:[],projectReferences:[]}),createProgram:({rootNames})=>makeProgram(rootNames),getPreEmitDiagnostics:program=>[{file:program.file,start:13,category:1,code:2322,messageText:"Type mismatch"}],flattenDiagnosticMessageText:value=>Array.isArray(value)?value.map(item=>item.text||item).join(""):String(value),displayPartsToString:value=>(value||[]).map(item=>item.text||"").join(""),getDefaultLibFilePath:()=>"",createDocumentRegistry:()=>({}),createLanguageService:host=>{const program=makeProgram(host.getScriptFileNames()),item={name:"typed",kind:"function",kindModifiers:"export",file:program.file.fileName,span:{start:10,length:10},selectionSpan:{start:13,length:5},containerName:"module"},diagnostic={file:program.file,start:13,length:5,category:1,code:2322,messageText:"Type mismatch"};return{getProgram:()=>program,getDefinitionAtPosition:()=>[{fileName:program.file.fileName,textSpan:{start:13,length:5},name:"typed",kind:"const",containerName:""}],findReferences:()=>[{definition:{},references:[{fileName:program.file.fileName,textSpan:{start:13,length:5},isDefinition:true,isWriteAccess:true},{fileName:program.file.fileName,textSpan:{start:20,length:5},isDefinition:false,isWriteAccess:false}]}],getQuickInfoAtPosition:()=>({kind:"const",kindModifiers:"export",displayParts:[{text:"const typed: string"}],documentation:[{text:"fixture docs"}]}),provideCallHierarchyIncomingCalls:()=>[{from:item,fromSpans:[{start:20,length:5}]}],provideCallHierarchyOutgoingCalls:()=>[{to:item,fromSpans:[{start:25,length:5}]}],getSyntacticDiagnostics:()=>[],getSemanticDiagnostics:()=>[diagnostic],getSuggestionDiagnostics:()=>[],getCodeFixesAtPosition:()=>[{fixName:"fixType",description:"Replace number with string",fixId:"fixType",fixAllDescription:"Fix all type mismatches",changes:[{fileName:program.file.fileName,textChanges:[{span:{start:29,length:1},newText:"\\\"1\\\""}]}],commands:[{type:"fixture-command",packageName:"fixture-package",file:program.file.fileName}]}],getRenameInfo:()=>({canRename:true,displayName:"typed",fullDisplayName:"typed",kind:"const",kindModifiers:"export",triggerSpan:{start:13,length:5}}),findRenameLocations:()=>[{fileName:program.file.fileName,textSpan:{start:13,length:5}},{fileName:program.file.fileName,textSpan:{start:20,length:5},prefixText:"prefix_",suffixText:"_suffix"}],organizeImports:()=>[{fileName:program.file.fileName,textChanges:[{span:{start:0,length:0},newText:"import { helper } from './helper.js';\\n"}]}]}}};\n`,"utf8");
    const semantic=await engine.diagnostics({root,path:"src/typed.ts",semantic:true});
    assert.equal(semantic.semantic,true);assert.equal(semantic.semanticEngine,"typescript");assert.equal(semantic.semanticInfo.version,"fixture-ts");assert.equal(semantic.semanticInfo.included,true);
    assert.deepEqual(semantic.diagnostics,[]);assert.equal(semantic.semanticDiagnostics[0].code,"TS2322");assert.equal(semantic.semanticDiagnostics[0].path,"src/typed.ts");
    const definition=await engine.languageSymbol({root,path:"src/typed.ts",line:1,column:14,operation:"definition"});
    assert.equal(definition.supported,true);assert.equal(definition.semantic,true);assert.equal(definition.engine,"typescript");assert.equal(definition.data[0].path,"src/typed.ts");assert.equal(definition.data[0].name,"typed");
    const references=await engine.languageSymbol({root,path:"src/typed.ts",line:1,column:14,operation:"references"});
    assert.equal(references.data.length,2);assert.equal(references.data[0].isDefinition,true);assert.equal(references.data[1].isWriteAccess,false);
    const quickInfo=await engine.languageSymbol({root,path:"src/typed.ts",line:1,column:14,operation:"quick_info"});
    assert.equal(quickInfo.data.display,"const typed: string");assert.equal(quickInfo.data.documentation,"fixture docs");
    const callers=await engine.languageSymbol({root,path:"src/typed.ts",line:1,column:14,operation:"callers"});
    assert.equal(callers.data[0].from.name,"typed");assert.equal(callers.data[0].from.path,"src/typed.ts");assert.equal(callers.data[0].fromSpans[0].column,21);
    const callees=await engine.languageSymbol({root,path:"src/typed.ts",line:1,column:14,operation:"callees"});
    assert.equal(callees.data[0].to.name,"typed");assert.equal(callees.data[0].fromSpans[0].column,26);
    const actions=await engine.codeActions({root,path:"src/typed.ts",line:1,column:14,codes:["TS2322"]});
    assert.equal(actions.supported,true);assert.equal(actions.engine,"typescript");assert.equal(actions.diagnostics[0].code,"TS2322");assert.equal(actions.actions[0].fixName,"fixType");
    assert.equal(actions.actions[0].requiresCommand,true);assert.equal(actions.actions[0].commands[0].packageName,"fixture-package");assert.equal(actions.actions[0].changes[0].file,"src/typed.ts");assert.equal(actions.actions[0].changes[0].textChanges[0].newText,"\"1\"");
    const rename=await engine.renamePreview({root,path:"src/typed.ts",line:1,column:14,newName:"renamed"});
    assert.equal(rename.supported,true);assert.equal(rename.semantic,true);assert.equal(rename.canRename,true);assert.equal(rename.displayName,"typed");assert.equal(rename.trigger.column,14);
    assert.equal(rename.locations.length,2);assert.equal(rename.locations[0].newText,"renamed");assert.equal(rename.locations[1].newText,"prefix_renamed_suffix");
    const organized=await engine.organizeImports({root,path:"src/typed.ts"});
    assert.equal(organized.supported,true);assert.equal(organized.semantic,true);assert.equal(organized.engine,"typescript");assert.equal(organized.editCount,1);
    assert.equal(organized.changes[0].file,"src/typed.ts");assert.equal(organized.changes[0].textChanges[0].newText,"import { helper } from './helper.js';\n");
    await assert.rejects(()=>engine.renamePreview({root,path:"src/typed.ts",line:1,column:14,newName:""}),/requires a new name/i);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("project-local diagnostic tooling cannot read unrelated Trebell parent secrets",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-context-env-")),secret="context-private-"+Date.now(),leakPath=join(root,"leaked-secret.txt");
  try{
    await mkdir(join(root,"src"),{recursive:true});await mkdir(join(root,"node_modules","typescript","lib"),{recursive:true});
    await writeFile(join(root,"src","typed.ts"),"export const typed: string = 'safe';\n","utf8");
    await writeFile(join(root,"tsconfig.json"),"{}\n","utf8");
    await writeFile(join(root,"node_modules","typescript","lib","typescript.js"),
      "const fs=require('fs');if(process.env.CONTEXT_PRIVATE_SECRET)fs.writeFileSync("+JSON.stringify(leakPath)+",process.env.CONTEXT_PRIVATE_SECRET);throw new Error('fixture stop');\n","utf8");
    const engine=new ContextEngine({env:{...process.env,CONTEXT_PRIVATE_SECRET:secret}});
    const result=await engine.diagnostics({root,path:"src/typed.ts",semantic:true});
    assert.equal(result.supported,true);assert.equal(result.semantic,false);
    const leaked=await readFile(leakPath,"utf8").catch(error=>error?.code==="ENOENT"?null:Promise.reject(error));
    assert.equal(leaked,null,"project-local diagnostic code must not inherit unrelated parent secrets");
  }finally{await rm(root,{recursive:true,force:true})}
});

test("context engine exposes bounded Git history and blame",async()=>{
  const root=await fixture();
  try{
    await execFileAsync("git",["-c","user.name=Trebell Test","-c","user.email=trebell@example.test","commit","-qm","Initial fixture"],{cwd:root});
    await writeFile(join(root,"src","auth","session.js"),"import { rotateRefreshToken } from \"./token.js\";\nexport class RefreshSession {\n  refresh(token) { return rotateRefreshToken(token); }\n}\n// second revision\n","utf8");
    await execFileAsync("git",["add","src/auth/session.js"],{cwd:root});
    await execFileAsync("git",["-c","user.name=Trebell Test","-c","user.email=trebell@example.test","commit","-qm","Update refresh session"],{cwd:root});
    const engine=new ContextEngine(),history=await engine.gitHistory({root,path:"src/auth/session.js",limit:5});
    assert.equal(history.data.length,2);assert.equal(history.data[0].subject,"Update refresh session");assert.equal(history.data[1].subject,"Initial fixture");
    const blame=await engine.gitBlame({root,path:"src/auth/session.js",startLine:1,endLine:5,maxLines:5});
    assert.equal(blame.data.length,5);assert.equal(blame.data[0].author,"Trebell Test");assert.equal(blame.data.at(-1).text,"// second revision");assert.equal(blame.data.at(-1).summary,"Update refresh session");
    await assert.rejects(()=>engine.gitHistory({root,path:"../outside.txt"}),/outside or unknown/i);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("large scoped repository instructions are bounded without dropping nested guidance",async()=>{
  const root=await fixture();
  try{
    await writeFile(join(root,"AGENTS.md"),"ROOT_SENTINEL keep authentication behavior safe.\n"+"root guidance filler\n".repeat(900),"utf8");
    await writeFile(join(root,"src","auth","AGENTS.md"),"NESTED_SENTINEL auth files require refresh-token coverage.\n"+"nested guidance filler\n".repeat(500),"utf8");
    const packet=await new ContextEngine().buildPacket({root,task:"Fix the refresh token session bug",maxTokens:1200,maxFiles:6});
    assert.ok(packet.tokenEstimate<=1200,`packet used ${packet.tokenEstimate} tokens`);
    assert.match(packet.injection,/ROOT_SENTINEL/);
    assert.match(packet.injection,/NESTED_SENTINEL/);
    assert.match(packet.injection,/nested files override broader guidance/);
    assert.match(packet.injection,/truncated by Trebell context budget/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("context engine reuses unchanged files and reparses only changed files",async()=>{
  const root=await fixture();
  try{
    const engine=new ContextEngine();
    const first=await engine.buildPacket({root,task:"refresh session"});
    assert.ok(first.stats.reparsed>=4);
    const second=await engine.buildPacket({root,task:"refresh session"});
    assert.equal(second.stats.reparsed,0);
    assert.ok(second.stats.reused>=4);
    await new Promise(resolve=>setTimeout(resolve,20));
    await writeFile(join(root,"src","auth","session.js"),`import { rotateRefreshToken } from "./token.js";\nexport class RefreshSession { refresh(token) { return rotateRefreshToken(token); } }\nexport const changed = true;\n`,"utf8");
    const third=await engine.buildPacket({root,task:"refresh session"});
    assert.equal(third.stats.reparsed,1);
    assert.ok(third.stats.reused>=3);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("clean Git workspaces skip per-file metadata scans after the first context packet",async()=>{
  const root=await fixture();
  try{
    await execFileAsync("git",["-c","user.name=Trebell Test","-c","user.email=trebell@example.test","commit","-m","baseline","-q"],{cwd:root});
    const engine=new ContextEngine();
    const first=await engine.buildPacket({root,task:"refresh session"});
    assert.ok(first.stats.inspected>=4);
    const second=await engine.buildPacket({root,task:"refresh session"});
    assert.equal(second.stats.inspected,0);
    assert.equal(second.stats.reparsed,0);
    assert.ok(second.stats.reused>=4);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("context cache invalidates clean tracked files when Git HEAD changes",async()=>{
  const root=await fixture();
  try{
    await execFileAsync("git",["-c","user.name=Trebell Test","-c","user.email=trebell@example.test","commit","-m","baseline","-q"],{cwd:root});
    const engine=new ContextEngine();
    const first=await engine.buildPacket({root,task:"refresh session revision marker",maxTokens:1800,maxFiles:8});
    assert.equal(first.stats.revisionChanged,false);
    await writeFile(join(root,"src","auth","session.js"),`import { rotateRefreshToken } from "./token.js";\nexport class RefreshSession { refresh(token) { return rotateRefreshToken(token); } }\nexport const revisionMarker = "HEAD_TWO_MARKER";\n`,"utf8");
    await execFileAsync("git",["add","src/auth/session.js"],{cwd:root});
    await execFileAsync("git",["-c","user.name=Trebell Test","-c","user.email=trebell@example.test","commit","-m","second","-q"],{cwd:root});
    const second=await engine.buildPacket({root,task:"refresh session revisionMarker",maxTokens:1800,maxFiles:8});
    assert.equal(second.stats.revisionChanged,true);
    assert.equal(second.stats.revisionDiffUsed,true);
    assert.equal(second.stats.inspected,1,"a clean one-file revision change should only inspect the changed source path");
    assert.equal(second.stats.reparsed,1);
    assert.match(second.injection,/HEAD_TWO_MARKER/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("context cache rechecks files that were dirty when they become clean at the same HEAD",async()=>{
  const root=await fixture();
  try{
    await execFileAsync("git",["-c","user.name=Trebell Test","-c","user.email=trebell@example.test","commit","-m","baseline","-q"],{cwd:root});
    const engine=new ContextEngine();
    await engine.buildPacket({root,task:"refresh session reset marker",maxTokens:1800,maxFiles:8});
    await writeFile(join(root,"src","auth","session.js"),`export class RefreshSession {}\nexport const dirtyResetMarker = "DIRTY_CACHE_MARKER";\n`,"utf8");
    const dirty=await engine.buildPacket({root,task:"refresh session dirtyResetMarker",maxTokens:1800,maxFiles:8});
    assert.match(dirty.injection,/DIRTY_CACHE_MARKER/);
    await execFileAsync("git",["checkout","--","src/auth/session.js"],{cwd:root});
    const restored=await engine.buildPacket({root,task:"refresh session dirtyResetMarker",maxTokens:1800,maxFiles:8});
    assert.equal(restored.stats.revisionChanged,false);
    assert.equal(restored.stats.reparsed,1,"the previously dirty path must be re-read after reset");
    assert.doesNotMatch(restored.injection,/DIRTY_CACHE_MARKER/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("weighted PageRank makes depended-on files more central",()=>{
  const nodes=["server.js","session.js","token.js"];
  const edges=new Map([
    ["server.js",new Map([["session.js",4]])],
    ["session.js",new Map([["token.js",4]])],
  ]);
  const rank=pageRank(nodes,edges,new Map(nodes.map(node=>[node,1])));
  assert.ok(rank.get("token.js")>rank.get("server.js"));
});

test("remote context indexing uses bounded environment I/O and reuses unchanged source files",async()=>{
  const root="/srv/app";
  const files=new Map([
    ["AGENTS.md","Keep authentication changes covered by tests.\n"],
    ["package.json",JSON.stringify({packageManager:"npm@11.0.0",scripts:{test:"node --test",build:"node build.mjs"}})],
    ["src/auth/token.js",'export function rotateRefreshToken(token) {\n  return token + "-rotated";\n}\n'],
    ["src/auth/session.js",'import { rotateRefreshToken } from "./token.js";\nexport class RefreshSession {\n  refresh(token) { return rotateRefreshToken(token); }\n}\n'],
    ["src/server.js",'import { RefreshSession } from "./auth/session.js";\nexport function startServer() { return new RefreshSession(); }\n'],
    ["src/tool.py","def tool(:\n    return True\n"],
    ["src/tool.go","package fixture\nfunc Tool() bool { return true }\n"],
    ["src/broken.go","package fixture\nfunc Broken( {\n"],
    ["tests/auth-refresh.test.js",'import { RefreshSession } from "../src/auth/session.js";\nexport function testRefresh() { return new RefreshSession().refresh("x"); }\n'],
  ]);
  const versions=new Map([...files.keys()].map(path=>[path,"v1"]));let status="",metadataCalls=0,contentCalls=0;
  const ok=stdout=>({exitCode:0,stdout,stderr:"",timedOut:false});
  const environments={
    async executeArgv(_id,{command,args=[]}){
      if(command==="git"&&args.includes("ls-files"))return ok([...files.keys()].join("\0")+"\0");
      if(command==="git"&&args.includes("grep")){
        const pattern=String(args[args.indexOf("-e")+1]||"").toLowerCase();
        const matches=[...files].filter(([,content])=>String(content).toLowerCase().includes(pattern)).map(([path])=>path);
        return matches.length?ok(matches.join("\0")+"\0"):{exitCode:1,stdout:"",stderr:"",timedOut:false};
      }
      if(command==="git"&&args.includes("log"))return ok("\x1e"+"a".repeat(40)+"\x1fRemote Tester\x1fremote@example.test\x1f1700000000\x1fRemote history\n");
      if(command==="git"&&args.includes("blame"))return ok("b".repeat(40)+" 1 1 1\nauthor Remote Tester\nauthor-mail <remote@example.test>\nauthor-time 1700000000\nsummary Remote history\nfilename src/auth/session.js\n\timport { rotateRefreshToken } from \"./token.js\";\n");
      if(command==="git"&&args.includes("status"))return ok(status);
      if(command==="git"&&args.includes("diff"))return ok(status?"diff --git a/src/auth/session.js b/src/auth/session.js\n":"");
      if(command==="git"&&args.includes("rev-parse"))return ok("remote-head-1\n");
      if(command==="python3"||command==="python")return ok(JSON.stringify({available:true,version:"3.fixture",diagnostics:[{severity:"error",code:"PY_SYNTAX",message:"invalid syntax",line:1,column:10,endLine:1,endColumn:11}]}));
      if(command==="gofmt"){
        const target=String(args[0]||"");return target.endsWith("broken.go")?{exitCode:2,stdout:"",stderr:`${target}:2:14: expected ')', found '{'`,timedOut:false}:ok("package fixture\n\nfunc Tool() bool { return true }\n");
      }
      if(command==="node"&&args[0]==="-e"){
        if(String(args[1]||"").includes("node_modules\",\"pyright"))return ok(JSON.stringify({available:true,configured:true,version:"remote-pyright",diagnostics:[{path:"src/tool.py",severity:"error",code:"reportArgumentType",message:"Remote Pyright fixture",line:1,column:1,endLine:1,endColumn:4}],projectDiagnosticCount:1,truncated:false,summary:{filesAnalyzed:1,errorCount:1}}));
        if(String(args[1]||"").includes("getCodeFixesAtPosition"))return ok(JSON.stringify({available:true,configured:true,version:"remote-ts",included:true,diagnostics:[{code:"TS9000",severity:"error",line:2,column:1,length:14,message:"Remote semantic fixture"}],actions:[{fixName:"remoteFix",description:"Fix remote fixture",requiresCommand:false,commands:[],changes:[{file:"src/auth/session.js",isNewFile:false,textChanges:[{path:"src/auth/session.js",line:2,column:1,length:14,newText:"export class FixedSession",newTextTruncated:false}]}]}],truncated:false,requestedCodes:[9000]}));
        if(String(args[1]||"").includes("organizeImports"))return ok(JSON.stringify({available:true,configured:true,version:"remote-ts",included:true,operation:"organize_imports",changes:[{file:"src/auth/session.js",textChanges:[{path:"src/auth/session.js",line:1,column:1,length:0,newText:"import { helper } from './helper.js';\n"}]}],editCount:1,truncated:false}));
        if(String(args[1]||"").includes("findRenameLocations"))return ok(JSON.stringify({available:true,configured:true,version:"remote-ts",included:true,canRename:true,newName:String(args[6]||""),displayName:"RefreshSession",fullDisplayName:"RefreshSession",kind:"class",kindModifiers:"export",trigger:{line:2,column:14,length:14},locations:[{path:"src/auth/session.js",line:2,column:14,length:14,prefixText:"",suffixText:"",newText:String(args[6]||"")},{path:"src/server.js",line:1,column:10,length:14,prefixText:"",suffixText:"",newText:String(args[6]||"")}],truncated:false}));
        const operation=args[6];
        if(["definition","references","quick_info","callers","callees"].includes(operation))return ok(JSON.stringify({available:true,configured:true,version:"remote-ts",included:true,operation,data:operation==="quick_info"?{kind:"class",display:"class RefreshSession",documentation:"remote fixture"}:operation==="callers"?[{from:{path:"src/server.js",line:2,column:10,name:"startServer"},fromSpans:[{path:"src/server.js",line:2,column:25,length:14}]}]:operation==="callees"?[{to:{path:"src/auth/token.js",line:1,column:17,name:"rotateRefreshToken"},fromSpans:[{path:"src/auth/session.js",line:3,column:27,length:18}]}]:[{path:"src/auth/session.js",line:2,column:14,length:14,name:"RefreshSession"}],truncated:false}));
        return ok(JSON.stringify({available:true,configured:true,version:"remote-ts",configPath:"tsconfig.json",included:true,projectDiagnosticCount:1,diagnostics:[{path:"src/auth/session.js",line:2,column:1,severity:"error",code:"TS9000",message:"Remote semantic fixture"}],truncated:false}));
      }
      if(command==="head"){
        const target=String(args.at(-1)||""),relativePath=target.slice(root.length+1);
        return files.has(relativePath)?ok(files.get(relativePath)):({exitCode:1,stdout:"",stderr:"missing",timedOut:false});
      }
      return {exitCode:1,stdout:"",stderr:"unexpected "+command,timedOut:false};
    },
    async executeArgvInput(_id,{command,args=[],input=""}){
      assert.equal(command,"bash");const script=String(args[1]||"");
      const paths=String(input).split("\0").filter(Boolean).map(path=>path.replace(/^\.\//,""));
      if(script.includes("stat -c")){
        metadataCalls++;
        return ok(paths.filter(path=>files.has(path)).map(path=>[
          Buffer.byteLength(files.get(path),"utf8"),
          versions.get(path),
          Buffer.from(path,"utf8").toString("base64"),
        ].join("\t")).join("\n")+"\n");
      }
      contentCalls++;
      return ok(paths.filter(path=>files.has(path)).map(path=>[
        Buffer.from(path,"utf8").toString("base64"),
        Buffer.from(files.get(path),"utf8").toString("base64"),
      ].join("\t")).join("\n")+"\n");
    },
  };
  const io=createRemoteContextIo({environments,environmentId:"ssh-fixture",root});
  const engine=new ContextEngine();
  const first=await engine.buildPacket({root,io,task:"Fix the refresh token session bug",maxTokens:1800,maxFiles:8});
  assert.equal(first.stats.remote,true);assert.ok(first.stats.reparsed>=4);assert.match(first.injection,/Keep authentication changes covered by tests/);
  assert.ok(first.items.some(item=>item.path==="src/auth/session.js"));
  const afterFirstMetadata=metadataCalls,afterFirstContent=contentCalls;
  const second=await engine.buildPacket({root,io,task:"Fix the refresh token session bug",maxTokens:1800,maxFiles:8});
  assert.equal(second.stats.reparsed,0);assert.ok(second.stats.reused>=4);
  assert.equal(metadataCalls,afterFirstMetadata,"clean Git state should not restat cached remote source files");
  assert.equal(contentCalls,afterFirstContent,"clean remote packets should reuse indexed source samples instead of rereading candidate files");
  const remoteSearch=await engine.searchCode({root,io,query:"rotateRefreshToken",limit:10});
  assert.equal(remoteSearch.source,"git-grep");assert.ok(remoteSearch.data.some(item=>item.path==="src/auth/session.js"));
  const remoteFiles=await engine.searchFiles({root,io,query:"session"});
  assert.ok(remoteFiles.data.some(item=>item.path==="src/auth/session.js"));
  const remoteMap=await engine.repositoryMap({root,io,query:"refresh session",limit:8});
  assert.ok(remoteMap.graphEdges>=3);assert.ok(remoteMap.data.some(item=>item.path==="src/auth/session.js"));
  const remoteCommands=await engine.projectCommands({root,io});
  assert.ok(remoteCommands.declared.some(item=>item.command==="npm run test"&&item.confidence==="declared"));
  assert.ok(remoteCommands.declared.some(item=>item.command==="npm run build"));
  const remoteVerification=await engine.verificationPlan({root,io,paths:["src/auth/session.js"]});
  assert.equal(remoteVerification.risk,"high");assert.deepEqual(remoteVerification.relatedTests,["tests/auth-refresh.test.js"]);
  assert.ok(remoteVerification.steps.some(item=>item.id==="targeted_tests"&&item.command==="npm run test"));
  assert.ok(remoteVerification.steps.some(item=>item.id==="build"&&item.command==="npm run build"));
  const remoteTests=await engine.relatedTests({root,io,path:"src/auth/session.js"});
  assert.deepEqual(remoteTests.data.map(item=>item.path),["tests/auth-refresh.test.js"]);
  const remoteCalls=await engine.callHierarchy({root,io,name:"RefreshSession"});
  assert.ok(remoteCalls.callers.some(item=>item.path==="src/server.js"&&item.caller==="startServer"));
  const remoteDiagnostics=await engine.diagnostics({root,io,path:"src/auth/session.js"});
  assert.equal(remoteDiagnostics.supported,true);assert.deepEqual(remoteDiagnostics.diagnostics,[]);
  const remotePythonDiagnostics=await engine.diagnostics({root,io,path:"src/tool.py",semantic:true});
  assert.equal(remotePythonDiagnostics.supported,true);assert.equal(remotePythonDiagnostics.engine,"python-ast");assert.equal(remotePythonDiagnostics.diagnostics[0].code,"PY_SYNTAX");assert.equal(remotePythonDiagnostics.semantic,true);assert.equal(remotePythonDiagnostics.semanticEngine,"pyright");assert.equal(remotePythonDiagnostics.semanticInfo.version,"remote-pyright");assert.equal(remotePythonDiagnostics.semanticDiagnostics[0].code,"reportArgumentType");
  const remoteGoDiagnostics=await engine.diagnostics({root,io,path:"src/tool.go",semantic:true});assert.equal(remoteGoDiagnostics.supported,true);assert.equal(remoteGoDiagnostics.engine,"gofmt");assert.equal(remoteGoDiagnostics.semantic,false);assert.deepEqual(remoteGoDiagnostics.diagnostics,[]);
  const remoteGoBroken=await engine.diagnostics({root,io,path:"src/broken.go"});assert.equal(remoteGoBroken.supported,true);assert.equal(remoteGoBroken.diagnostics[0].code,"GO_SYNTAX");assert.equal(remoteGoBroken.diagnostics[0].line,2);assert.equal(remoteGoBroken.diagnostics[0].column,14);
  const remoteSemantic=await engine.diagnostics({root,io,path:"src/auth/session.js",semantic:true});
  assert.equal(remoteSemantic.semantic,true);assert.equal(remoteSemantic.semanticInfo.version,"remote-ts");assert.equal(remoteSemantic.semanticDiagnostics[0].code,"TS9000");
  const remoteDefinition=await engine.languageSymbol({root,io,path:"src/auth/session.js",line:2,column:14,operation:"definition"});
  assert.equal(remoteDefinition.supported,true);assert.equal(remoteDefinition.data[0].name,"RefreshSession");assert.equal(remoteDefinition.version,"remote-ts");
  const remoteCallers=await engine.languageSymbol({root,io,path:"src/auth/session.js",line:2,column:14,operation:"callers"});
  assert.equal(remoteCallers.data[0].from.name,"startServer");
  const remoteCallees=await engine.languageSymbol({root,io,path:"src/auth/session.js",line:2,column:14,operation:"callees"});
  assert.equal(remoteCallees.data[0].to.name,"rotateRefreshToken");
  const remoteActions=await engine.codeActions({root,io,path:"src/auth/session.js",line:2,column:1,codes:[9000]});
  assert.equal(remoteActions.supported,true);assert.equal(remoteActions.actions[0].fixName,"remoteFix");assert.equal(remoteActions.actions[0].changes[0].file,"src/auth/session.js");
  const remoteOrganized=await engine.organizeImports({root,io,path:"src/auth/session.js"});
  assert.equal(remoteOrganized.supported,true);assert.equal(remoteOrganized.editCount,1);assert.equal(remoteOrganized.changes[0].file,"src/auth/session.js");
  const remoteRename=await engine.renamePreview({root,io,path:"src/auth/session.js",line:2,column:14,newName:"RenewedSession"});
  assert.equal(remoteRename.supported,true);assert.equal(remoteRename.canRename,true);assert.equal(remoteRename.locations.length,2);assert.equal(remoteRename.locations[0].newText,"RenewedSession");
  const remoteSource=await engine.readSourceRange({root,io,path:"src/auth/session.js",startLine:1,endLine:2});
  assert.match(remoteSource.content,/rotateRefreshToken/);assert.equal(remoteSource.endLine,2);
  const remoteReferences=await engine.symbolReferences({root,io,name:"RefreshSession",limit:10});
  assert.ok(remoteReferences.data.some(item=>item.path==="src/server.js"&&item.precision==="ast"));
  const remoteHistory=await engine.gitHistory({root,io,path:"src/auth/session.js",limit:3});
  assert.equal(remoteHistory.data[0].subject,"Remote history");
  const remoteBlame=await engine.gitBlame({root,io,path:"src/auth/session.js",startLine:1,endLine:1,maxLines:1});
  assert.equal(remoteBlame.data[0].author,"Remote Tester");
  files.set("src/auth/session.js",files.get("src/auth/session.js")+"export const changed = true;\n");versions.set("src/auth/session.js","v2");status=" M src/auth/session.js\n";
  const third=await engine.buildPacket({root,io,task:"refresh session",maxTokens:1800,maxFiles:8});
  assert.equal(third.stats.reparsed,1);assert.ok(third.stats.reused>=3);
  const remoteGit=await engine.gitContext({root,io});assert.equal(remoteGit.isGit,true);assert.ok(remoteGit.changed.includes("src/auth/session.js"));
});

test("remote context cancellation stops later read batches",async()=>{
  const root="/srv/remote-cancel",controller=new AbortController(),paths=Array.from({length:33},(_,index)=>`src/file-${index}.js`);let batches=0;
  const ok=stdout=>({exitCode:0,stdout,stderr:"",timedOut:false});
  const environments={
    async executeArgv(){return ok("")},
    async executeArgvInput(_id,{input=""}){
      batches++;
      await new Promise(resolve=>setTimeout(resolve,25));
      const requested=String(input).split("\0").filter(Boolean).map(path=>path.replace(/^\.\//,""));
      return ok(requested.map(path=>[
        Buffer.from(path,"utf8").toString("base64"),
        Buffer.from(`export const value = ${JSON.stringify(path)};\n`,"utf8").toString("base64"),
      ].join("\t")).join("\n")+"\n");
    },
  };
  const io=createRemoteContextIo({environments,environmentId:"ssh-cancel",root});
  const pending=io.readMany(paths,256_000,{signal:controller.signal});
  setTimeout(()=>controller.abort(),5);
  await assert.rejects(pending,error=>error?.name==="AbortError");
  assert.equal(batches,1,"cancellation should prevent the second and third remote read batches from launching");
});

test("context excerpts fall back to the full file when a relevant symbol is beyond the cached sample",async()=>{
  const root="/srv/large",padding="// padding\n".repeat(7000),content=padding+"export function distantTarget() { return 42; }\n";
  let fullReads=0;
  const io={
    root,cacheKey:"large-fixture",
    discoverFiles:async()=>["src/large.js"],
    metadata:async()=>new Map([["src/large.js",{size:Buffer.byteLength(content),version:"v1"}]]),
    readMany:async()=>new Map([["src/large.js",content]]),
    readText:async()=>{fullReads++;return content},
    gitState:async()=>({isGit:true,changed:new Set(),status:"",diff:""}),
    relativeFocus:path=>path,
  };
  const packet=await new ContextEngine().buildPacket({root,io,task:"Fix distantTarget",maxTokens:1600,maxFiles:4});
  assert.equal(fullReads,1);
  assert.match(packet.injection,/distantTarget/);
  assert.ok(packet.items.some(item=>item.path==="src/large.js"));
});
