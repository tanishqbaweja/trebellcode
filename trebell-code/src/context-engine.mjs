import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parse as parseJavaScriptAst } from "@babel/parser";

const execFileAsync=promisify(execFile);
const SKIP=new Set([".git","node_modules","target","dist","build",".next",".cache","desktop-dist","coverage","vendor"]);
const SOURCE_EXTENSIONS=new Set([".js",".jsx",".ts",".tsx",".mjs",".cjs",".py",".rs",".go",".java",".kt",".kts",".cs",".c",".h",".cc",".cpp",".cxx",".hpp",".hh",".rb",".php",".swift",".vue",".svelte"]);
const BABEL_SOURCE_EXTENSIONS=new Set([".js",".jsx",".ts",".tsx",".mjs",".cjs"]);
const RESOLVE_EXTENSIONS=[".js",".jsx",".ts",".tsx",".mjs",".cjs",".py",".rs",".go",".java",".kt",".cs"];
const INSTRUCTION_NAMES=new Set(["AGENTS.md","CLAUDE.md"]);
const STOP_WORDS=new Set(["the","and","for","with","that","this","from","into","when","where","what","which","while","your","trebell","code","make","need","should","would","could","have","has","had","are","was","were","will","fix","add","use","using","work","working"]);
const TYPESCRIPT_DIAGNOSTICS_SCRIPT=`const fs=require("fs"),path=require("path");
const root=path.resolve(process.argv[1]||"."),requested=path.resolve(root,process.argv[2]||""),limit=Math.max(1,Math.min(300,Number(process.argv[3])||100));
const out=value=>process.stdout.write(JSON.stringify(value));
const tsPath=path.join(root,"node_modules","typescript","lib","typescript.js");
if(!fs.existsSync(tsPath)){out({available:false,configured:false,reason:"Project-local TypeScript is not installed"});process.exit(0)}
try{
  const ts=require(tsPath),configPath=ts.findConfigFile(root,ts.sys.fileExists,"tsconfig.json");
  if(!configPath){out({available:true,configured:false,version:ts.version,reason:"No tsconfig.json was found"});process.exit(0)}
  const read=ts.readConfigFile(configPath,ts.sys.readFile),parsed=ts.parseJsonConfigFileContent(read.config||{},ts.sys,path.dirname(configPath),{noEmit:true,incremental:false,composite:false},configPath),options={...parsed.options,noEmit:true,incremental:false,composite:false};
  delete options.tsBuildInfoFile;
  const program=ts.createProgram({rootNames:parsed.fileNames,options,projectReferences:parsed.projectReferences}),all=[...(read.error?[read.error]:[]),...(parsed.errors||[]),...ts.getPreEmitDiagnostics(program)];
  const relativeRequested=path.relative(root,requested).replace(/\\\\/g,"/"),category=value=>value===0?"warning":value===1?"error":value===2?"suggestion":"message";
  const rows=all.map(diagnostic=>{const file=diagnostic.file?.fileName?path.resolve(diagnostic.file.fileName):null,position=file&&Number.isFinite(diagnostic.start)?diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start):null;return{path:file?path.relative(root,file).replace(/\\\\/g,"/"):null,line:position?position.line+1:null,column:position?position.character+1:null,severity:category(diagnostic.category),code:"TS"+diagnostic.code,message:ts.flattenDiagnosticMessageText(diagnostic.messageText,"\\n")}}),matching=rows.filter(row=>row.path===relativeRequested||row.path===null);
  out({available:true,configured:true,version:ts.version,configPath:path.relative(root,configPath).replace(/\\\\/g,"/"),included:Boolean(program.getSourceFile(requested)),projectDiagnosticCount:rows.length,diagnostics:matching.slice(0,limit),truncated:matching.length>limit});
}catch(error){out({available:true,configured:false,failed:true,reason:String(error?.stack||error?.message||error)})}`;
const TYPESCRIPT_SYMBOL_SCRIPT=`const fs=require("fs"),path=require("path");
const root=path.resolve(process.argv[1]||"."),requested=path.resolve(root,process.argv[2]||""),line=Math.max(1,Number(process.argv[3])||1),column=Math.max(1,Number(process.argv[4])||1),operation=String(process.argv[5]||"definition"),limit=Math.max(1,Math.min(300,Number(process.argv[6])||100));
const out=value=>process.stdout.write(JSON.stringify(value)),tsPath=path.join(root,"node_modules","typescript","lib","typescript.js");
if(!fs.existsSync(tsPath)){out({available:false,configured:false,reason:"Project-local TypeScript is not installed"});process.exit(0)}
try{
  const ts=require(tsPath),configPath=ts.findConfigFile(root,ts.sys.fileExists,"tsconfig.json");if(!configPath){out({available:true,configured:false,version:ts.version,reason:"No tsconfig.json was found"});process.exit(0)}
  const read=ts.readConfigFile(configPath,ts.sys.readFile),parsed=ts.parseJsonConfigFileContent(read.config||{},ts.sys,path.dirname(configPath),{noEmit:true,incremental:false,composite:false},configPath),options={...parsed.options,noEmit:true,incremental:false,composite:false};delete options.tsBuildInfoFile;
  const files=[...new Set([...(parsed.fileNames||[]),requested].filter(file=>fs.existsSync(file)))],snapshot=file=>{try{return ts.ScriptSnapshot.fromString(fs.readFileSync(file,"utf8"))}catch{return undefined}},host={getCompilationSettings:()=>options,getScriptFileNames:()=>files,getScriptVersion:()=>"0",getScriptSnapshot:snapshot,getCurrentDirectory:()=>root,getDefaultLibFileName:value=>ts.getDefaultLibFilePath(value),fileExists:ts.sys.fileExists,readFile:ts.sys.readFile,readDirectory:ts.sys.readDirectory,directoryExists:ts.sys.directoryExists,getDirectories:ts.sys.getDirectories,useCaseSensitiveFileNames:()=>ts.sys.useCaseSensitiveFileNames,getNewLine:()=>ts.sys.newLine};
  const service=ts.createLanguageService(host,ts.createDocumentRegistry?ts.createDocumentRegistry():undefined),program=service.getProgram(),source=program?.getSourceFile(requested);if(!source){out({available:true,configured:true,version:ts.version,included:false,reason:"Requested file is not available to the TypeScript language service"});process.exit(0)}
  const position=source.getPositionOfLineAndCharacter(line-1,column-1),location=(fileName,span,extra={})=>{const absolute=path.resolve(fileName),file=program.getSourceFile(absolute)||program.getSourceFile(fileName);if(!file)return{path:path.relative(root,absolute).replace(/\\\\/g,"/"),line:null,column:null,length:Number(span?.length)||0,...extra};const point=file.getLineAndCharacterOfPosition(span.start);return{path:path.relative(root,absolute).replace(/\\\\/g,"/"),line:point.line+1,column:point.character+1,length:Number(span?.length)||0,...extra}};
  if(operation==="definition"){const definitions=service.getDefinitionAtPosition(requested,position)||[];out({available:true,configured:true,version:ts.version,included:true,operation,data:definitions.slice(0,limit).map(item=>location(item.fileName,item.textSpan,{name:item.name||null,kind:item.kind||null,containerName:item.containerName||null})),truncated:definitions.length>limit});process.exit(0)}
  if(operation==="references"){const groups=service.findReferences(requested,position)||[],rows=[],total=groups.reduce((sum,group)=>sum+(group.references||[]).length,0);for(const group of groups)for(const item of group.references||[]){if(rows.length>=limit)break;rows.push(location(item.fileName,item.textSpan,{isDefinition:Boolean(item.isDefinition),isWriteAccess:Boolean(item.isWriteAccess)}))}out({available:true,configured:true,version:ts.version,included:true,operation,data:rows,truncated:total>rows.length});process.exit(0)}
  if(operation==="quick_info"){const info=service.getQuickInfoAtPosition(requested,position),display=value=>ts.displayPartsToString?ts.displayPartsToString(value||[]):(value||[]).map(part=>part.text||"").join("");out({available:true,configured:true,version:ts.version,included:true,operation,data:info?{kind:info.kind||null,kindModifiers:info.kindModifiers||null,display:display(info.displayParts),documentation:display(info.documentation)}:null});process.exit(0)}
  const hierarchyItem=item=>{if(!item)return null;const base=location(item.file,item.selectionSpan||item.span,{name:item.name||null,kind:item.kind||null,kindModifiers:item.kindModifiers||null,containerName:item.containerName||null});return{...base,spanLength:Number(item.span?.length)||0,selectionLength:Number(item.selectionSpan?.length)||0}};
  if(operation==="callers"){
    if(typeof service.provideCallHierarchyIncomingCalls!=="function"){out({available:true,configured:true,version:ts.version,included:true,operation,unsupported:true,reason:"Project TypeScript does not expose call hierarchy"});process.exit(0)}
    const calls=service.provideCallHierarchyIncomingCalls(requested,position)||[],rows=calls.slice(0,limit).map(call=>({from:hierarchyItem(call.from),fromSpans:(call.fromSpans||[]).slice(0,40).map(span=>location(call.from.file,span))}));out({available:true,configured:true,version:ts.version,included:true,operation,data:rows,truncated:calls.length>limit});process.exit(0)
  }
  if(operation==="callees"){
    if(typeof service.provideCallHierarchyOutgoingCalls!=="function"){out({available:true,configured:true,version:ts.version,included:true,operation,unsupported:true,reason:"Project TypeScript does not expose call hierarchy"});process.exit(0)}
    const calls=service.provideCallHierarchyOutgoingCalls(requested,position)||[],rows=calls.slice(0,limit).map(call=>({to:hierarchyItem(call.to),fromSpans:(call.fromSpans||[]).slice(0,40).map(span=>location(requested,span))}));out({available:true,configured:true,version:ts.version,included:true,operation,data:rows,truncated:calls.length>limit});process.exit(0)
  }
  out({available:true,configured:true,version:ts.version,failed:true,reason:"Unsupported language symbol operation"});
}catch(error){out({available:true,configured:false,failed:true,reason:String(error?.stack||error?.message||error)})}`;

function tokenEstimate(value){return Math.ceil(String(value||"").length/4)}
function slash(value){return String(value||"").split(sep).join("/")}
function boundedNumber(value,fallback,min,max){const number=Number(value);return Number.isFinite(number)?Math.max(min,Math.min(max,number)):fallback}
async function mapLimit(items,limit,worker){
  const values=Array.from(items||[]),results=new Array(values.length),size=Math.max(1,Math.min(values.length||1,Number(limit)||1));let cursor=0;
  await Promise.all(Array.from({length:size},async()=>{
    for(;;){const index=cursor++;if(index>=values.length)return;results[index]=await worker(values[index],index)}
  }));
  return results;
}
function indexablePath(path){
  const parts=slash(path).split("/").filter(Boolean);
  return parts.length>0&&!parts.some(part=>SKIP.has(part))&&!parts.includes("..");
}

function taskTerms(task){
  const expanded=String(task||"").replace(/([a-z0-9])([A-Z])/g,"$1 $2").toLowerCase();
  return [...new Set(expanded.split(/[^a-z0-9_$-]+/).map(term=>term.replace(/^[-_$]+|[-_$]+$/g,"")).filter(term=>term.length>=3&&!STOP_WORDS.has(term)))].slice(0,32);
}

function pathTokens(path){return new Set(String(path||"").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))}

function sourceDefinition(line,extension){
  const patterns=[];
  if([".js",".jsx",".ts",".tsx",".mjs",".cjs",".vue",".svelte"].includes(extension))patterns.push(
    [/(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/,"function"],
    [/(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)\b/,"class"],
    [/(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/,"interface"],
    [/(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/,"type"],
    [/(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/,"enum"],
    [/(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,"function"],
  );
  else if(extension===".py")patterns.push([/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\b/,"function"],[/^\s*class\s+([A-Za-z_]\w*)\b/,"class"]);
  else if(extension===".rs")patterns.push([/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\b/,"function"],[/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_]\w*)\b/,"type"]);
  else if(extension===".go")patterns.push([/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\b/,"function"],[/^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/,"type"]);
  else if([".java",".kt",".kts",".cs",".c",".h",".cc",".cpp",".cxx",".hpp",".hh",".swift"].includes(extension))patterns.push(
    [/\b(?:class|interface|enum|struct|protocol)\s+([A-Za-z_]\w*)\b/,"type"],
    [/^\s*(?:public|private|protected|internal|static|final|virtual|override|async|inline|constexpr|suspend|open|abstract|sealed|extern|unsafe|\s)+\s*[A-Za-z_][\w<>,?\[\]:*&.\s]*\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:\{|=>|$)/,"function"],
  );
  else patterns.push([/^\s*(?:def|function|class)\s+([A-Za-z_]\w*)\b/,"symbol"]);
  for(const [pattern,kind] of patterns){const match=line.match(pattern);if(match)return{name:match[1],kind}}
  return null;
}

function importSpecifiers(content,extension){
  const specs=[];
  if([".js",".jsx",".ts",".tsx",".mjs",".cjs",".vue",".svelte"].includes(extension)){
    const patterns=[/\b(?:import|export)\b[\s\S]{0,400}?\bfrom\s*["']([^"']+)["']/g,/\brequire\(\s*["']([^"']+)["']\s*\)/g,/\bimport\(\s*["']([^"']+)["']\s*\)/g];
    for(const pattern of patterns)for(const match of content.matchAll(pattern))specs.push(match[1]);
  }else if(extension===".py"){
    for(const match of content.matchAll(/^\s*from\s+([.\w]+)\s+import\s+/gm))specs.push(match[1]);
    for(const match of content.matchAll(/^\s*import\s+([.\w]+)/gm))specs.push(match[1]);
  }
  return [...new Set(specs)].slice(0,300);
}

function parserVersion(relativePath){return BABEL_SOURCE_EXTENSIONS.has(extname(relativePath).toLowerCase())?"babel-js-v1":"regex-v1"}

function bindingNames(node,out=[]){
  if(!node||typeof node!=="object")return out;
  if(node.type==="Identifier"){out.push(node.name);return out}
  if(node.type==="RestElement")return bindingNames(node.argument,out);
  if(node.type==="AssignmentPattern")return bindingNames(node.left,out);
  if(node.type==="ArrayPattern"){for(const item of node.elements||[])bindingNames(item,out);return out}
  if(node.type==="ObjectPattern"){
    for(const property of node.properties||[]){
      if(property?.type==="RestElement")bindingNames(property.argument,out);
      else bindingNames(property?.value,out);
    }
  }
  return out;
}

function javascriptParserPlugins(relativePath){
  const extension=extname(relativePath).toLowerCase(),plugins=["decorators-legacy"];
  if(extension===".jsx"||extension===".tsx")plugins.push("jsx");
  if(extension===".ts"||extension===".tsx")plugins.push("typescript");
  return plugins;
}

function parseJavaScriptSource(content,relativePath){
  const ast=parseJavaScriptAst(String(content||""),{sourceType:"unambiguous",errorRecovery:true,plugins:javascriptParserPlugins(relativePath)});
  const lines=String(content||"").split(/\r?\n/),definitions=[],references=new Map(),imports=new Set(),seenDefinitions=new Set();
  const addDefinition=(name,kind,node)=>{
    const value=String(name||"");if(!value||definitions.length>=500)return;
    const line=Number(node?.loc?.start?.line)||1,key=kind+"\0"+value+"\0"+line;if(seenDefinitions.has(key))return;seenDefinitions.add(key);
    definitions.push({name:value,kind,line,signature:String(lines[line-1]||"").trim().slice(0,300)});
  };
  const addImport=value=>{const spec=String(value||"").trim();if(spec&&imports.size<300)imports.add(spec)};
  const visit=node=>{
    if(!node||typeof node!=="object")return;
    if(node.type==="Identifier")references.set(node.name,Math.min(50,(references.get(node.name)||0)+1));
    if(node.type==="ImportDeclaration"||node.type==="ExportAllDeclaration")addImport(node.source?.value);
    else if(node.type==="ExportNamedDeclaration"&&node.source)addImport(node.source.value);
    else if(node.type==="TSImportEqualsDeclaration"&&node.moduleReference?.type==="TSExternalModuleReference")addImport(node.moduleReference.expression?.value);
    else if(node.type==="ImportExpression")addImport(node.source?.value);
    else if(node.type==="CallExpression"){
      const dynamicImport=node.callee?.type==="Import",commonJs=node.callee?.type==="Identifier"&&node.callee.name==="require";
      if(dynamicImport||commonJs)addImport(node.arguments?.[0]?.value);
    }
    if(node.type==="FunctionDeclaration"&&node.id)addDefinition(node.id.name,"function",node);
    else if(node.type==="ClassDeclaration"&&node.id)addDefinition(node.id.name,"class",node);
    else if(node.type==="TSInterfaceDeclaration"&&node.id)addDefinition(node.id.name,"interface",node);
    else if(node.type==="TSTypeAliasDeclaration"&&node.id)addDefinition(node.id.name,"type",node);
    else if(node.type==="TSEnumDeclaration"&&node.id)addDefinition(node.id.name,"enum",node);
    else if(node.type==="VariableDeclarator"&&["ArrowFunctionExpression","FunctionExpression"].includes(node.init?.type))for(const name of bindingNames(node.id))addDefinition(name,"function",node);
    for(const [key,value] of Object.entries(node)){
      if(["loc","start","end","extra","errors","comments","tokens"].includes(key)||!value)continue;
      if(Array.isArray(value)){for(const child of value)if(child&&typeof child==="object"&&typeof child.type==="string")visit(child)}
      else if(typeof value==="object"&&typeof value.type==="string")visit(value);
    }
  };
  visit(ast.program);
  return {definitions,references,imports:[...imports],parser:"babel"};
}

function javascriptIdentifierLines(content,relativePath,name){
  const wanted=String(name||""),lines=new Set(),ast=parseJavaScriptAst(String(content||""),{sourceType:"unambiguous",errorRecovery:true,plugins:javascriptParserPlugins(relativePath)});
  const visit=node=>{
    if(!node||typeof node!=="object")return;
    if(node.type==="Identifier"&&node.name===wanted){const line=Number(node?.loc?.start?.line)||0;if(line>0)lines.add(line)}
    for(const [key,value] of Object.entries(node)){
      if(["loc","start","end","extra","errors","comments","tokens"].includes(key)||!value)continue;
      if(Array.isArray(value)){for(const child of value)if(child&&typeof child==="object"&&typeof child.type==="string")visit(child)}
      else if(typeof value==="object"&&typeof value.type==="string")visit(value);
    }
  };
  visit(ast.program);return [...lines].sort((a,b)=>a-b);
}

function javascriptCallSites(content,relativePath){
  const calls=[],ast=parseJavaScriptAst(String(content||""),{sourceType:"unambiguous",errorRecovery:true,plugins:javascriptParserPlugins(relativePath)});
  const keyName=node=>node?.type==="Identifier"?node.name:node?.type==="StringLiteral"?node.value:null;
  const calleeName=node=>{
    if(node?.type==="Identifier")return node.name;
    if(node?.type==="MemberExpression"&&!node.computed)return keyName(node.property);
    if(node?.type==="OptionalMemberExpression"&&!node.computed)return keyName(node.property);
    return null;
  };
  const visit=(node,scope=null,className=null)=>{
    if(!node||typeof node!=="object")return;
    let nextScope=scope,nextClass=className;
    if(node.type==="ClassDeclaration"&&node.id){nextClass=node.id.name;nextScope=node.id.name}
    else if(node.type==="FunctionDeclaration"&&node.id)nextScope=node.id.name;
    else if(["ClassMethod","ClassPrivateMethod"].includes(node.type)){const method=keyName(node.key);if(method)nextScope=nextClass?nextClass+"."+method:method}
    else if(node.type==="ObjectMethod"){const method=keyName(node.key);if(method)nextScope=method}
    else if(node.type==="VariableDeclarator"&&["ArrowFunctionExpression","FunctionExpression"].includes(node.init?.type)){const names=bindingNames(node.id);if(names.length)nextScope=names[0]}
    if(node.type==="CallExpression"||node.type==="OptionalCallExpression"||node.type==="NewExpression"){
      const callee=calleeName(node.callee),line=Number(node?.loc?.start?.line)||0;if(callee&&line>0)calls.push({caller:nextScope||scope||null,callee,line,kind:node.type==="NewExpression"?"construct":"call"});
    }
    for(const [key,value] of Object.entries(node)){
      if(["loc","start","end","extra","errors","comments","tokens"].includes(key)||!value)continue;
      if(Array.isArray(value)){for(const child of value)if(child&&typeof child==="object"&&typeof child.type==="string")visit(child,nextScope,nextClass)}
      else if(typeof value==="object"&&typeof value.type==="string")visit(value,nextScope,nextClass);
    }
  };
  visit(ast.program);return calls.slice(0,4000);
}

function javascriptSyntaxDiagnostics(content,relativePath){
  const normalize=error=>({severity:"error",message:String(error?.message||"JavaScript parser error").replace(/\s*\(\d+:\d+\)\s*$/,""),line:Number(error?.loc?.line)||1,column:Math.max(1,(Number(error?.loc?.column)||0)+1),code:error?.reasonCode||error?.code||null});
  try{
    const ast=parseJavaScriptAst(String(content||""),{sourceType:"unambiguous",errorRecovery:true,plugins:javascriptParserPlugins(relativePath)});
    return (ast.errors||[]).map(normalize);
  }catch(error){return [normalize(error)]}
}

function textualIdentifierLines(content,name){
  const escaped=String(name||"").replace(/[|\\{}()[\]^$+*?.-]/g,"\\$&"),pattern=new RegExp("(^|[^A-Za-z0-9_$])"+escaped+"(?=$|[^A-Za-z0-9_$])");
  const lines=String(content||"").split(/\r?\n/),matches=[];
  for(let index=0;index<lines.length;index++)if(pattern.test(lines[index]))matches.push(index+1);
  return matches;
}

function parseSource(content,relativePath){
  const extension=extname(relativePath).toLowerCase(),lines=String(content||"").split(/\r?\n/),definitions=[];
  if(BABEL_SOURCE_EXTENSIONS.has(extension)){
    try{return parseJavaScriptSource(content,relativePath)}catch{}
  }
  for(let index=0;index<lines.length&&definitions.length<500;index++){
    const found=sourceDefinition(lines[index],extension);if(found)definitions.push({...found,line:index+1,signature:lines[index].trim().slice(0,300)});
  }
  const references=new Map();
  const identifiers=String(content||"").match(/[A-Za-z_$][\w$]{2,}/g)||[];
  for(const name of identifiers.slice(0,40_000))references.set(name,Math.min(50,(references.get(name)||0)+1));
  return {definitions,references,imports:importSpecifiers(content,extension),parser:"regex"};
}

async function fallbackFiles(root){
  const files=[];
  async function walk(dir){
    let entries=[];try{entries=await readdir(dir,{withFileTypes:true})}catch{return}
    for(const entry of entries){
      if(SKIP.has(entry.name))continue;
      const full=join(dir,entry.name);if(entry.isDirectory())await walk(full);else if(entry.isFile())files.push(slash(relative(root,full)));
      if(files.length>=20_000)return;
    }
  }
  await walk(root);return files;
}

async function discoverFiles(root){
  try{
    const {stdout}=await execFileAsync("git",["-C",root,"ls-files","-co","--exclude-standard","-z"],{windowsHide:true,maxBuffer:32*1024*1024,timeout:15_000});
    return String(stdout||"").split("\0").filter(Boolean).map(slash).filter(indexablePath);
  }catch{return fallbackFiles(root)}
}

async function gitState(root){
  try{
    const [{stdout:status},{stdout:diff},headResult]=await Promise.all([
      execFileAsync("git",["-C",root,"status","--short"],{windowsHide:true,maxBuffer:1024*1024,timeout:12_000}),
      execFileAsync("git",["-C",root,"diff","--no-ext-diff","--no-color","--unified=1"],{windowsHide:true,maxBuffer:2*1024*1024,timeout:15_000}),
      execFileAsync("git",["-C",root,"rev-parse","HEAD"],{windowsHide:true,maxBuffer:64*1024,timeout:8_000}).catch(()=>({stdout:""})),
    ]);
    const changed=new Set(String(status||"").split(/\r?\n/).filter(Boolean).map(line=>slash(line.slice(3).replace(/^.* -> /,""))));
    return {isGit:true,head:String(headResult?.stdout||"").trim()||null,changed,status:String(status||"").slice(0,12_000),diff:String(diff||"").slice(0,16_000)};
  }catch{return {isGit:false,head:null,changed:new Set(),status:"",diff:""}}
}

async function localMatchingFiles(root,{query,regex=false,caseSensitive=false,limit=120}={}){
  const args=["-C",root,"grep","-l","-z","-I","--untracked","--exclude-standard"];
  if(!caseSensitive)args.push("-i");args.push(regex?"-E":"-F","-e",String(query||""),"--");
  try{
    const {stdout}=await execFileAsync("git",args,{windowsHide:true,maxBuffer:4*1024*1024,timeout:20_000});
    return String(stdout||"").split("\0").filter(Boolean).map(slash).filter(indexablePath).slice(0,Math.max(1,Math.min(500,Number(limit)||120)));
  }catch(error){
    if(Number(error?.code)===1)return [];
    throw error;
  }
}

function parseGitHistory(output){
  const data=[];
  for(const record of String(output||"").split("\x1e")){
    const value=record.replace(/^\r?\n/,"");if(!value)continue;
    const [commit,author,email,time,...subject]=value.split("\x1f");if(!commit)continue;
    data.push({commit,author:author||"",email:email||"",timestamp:Number(time)||0,subject:subject.join("\x1f").trim()});
  }
  return data;
}

function parseGitBlame(output){
  const data=[];let current=null;
  for(const line of String(output||"").split(/\r?\n/)){
    const header=line.match(/^(\^?[0-9a-f]{40,64})\s+\d+\s+(\d+)(?:\s+\d+)?$/i);
    if(header){current={commit:header[1].replace(/^\^/,""),line:Number(header[2]),author:"",email:"",timestamp:0,summary:"",text:""};continue}
    if(!current)continue;
    if(line.startsWith("author "))current.author=line.slice(7);
    else if(line.startsWith("author-mail "))current.email=line.slice(12).replace(/^<|>$/g,"");
    else if(line.startsWith("author-time "))current.timestamp=Number(line.slice(12))||0;
    else if(line.startsWith("summary "))current.summary=line.slice(8);
    else if(line.startsWith("\t")){current.text=line.slice(1);data.push(current);current=null}
  }
  return data;
}

async function localGitHistory(root,{path="",limit=20}={}){
  const capped=Math.max(1,Math.min(100,Number(limit)||20)),args=["-C",root,"log","--no-decorate","-n"+capped,"--format=%x1e%H%x1f%an%x1f%ae%x1f%at%x1f%s"];
  if(path)args.push("--",path);
  try{
    const {stdout}=await execFileAsync("git",args,{windowsHide:true,maxBuffer:2*1024*1024,timeout:20_000});
    return parseGitHistory(stdout).slice(0,capped);
  }catch(error){
    if(Number(error?.code)===128)return [];
    throw error;
  }
}

async function localGitBlame(root,{path,startLine=1,endLine=null,maxLines=120}={}){
  const start=Math.max(1,Math.trunc(Number(startLine)||1)),cap=Math.max(1,Math.min(200,Math.trunc(Number(maxLines)||120))),end=Math.max(start,Math.min(start+cap-1,Math.trunc(Number(endLine)||start+cap-1)));
  const {stdout}=await execFileAsync("git",["-C",root,"blame","--line-porcelain","-L"+start+","+end,"--",path],{windowsHide:true,maxBuffer:4*1024*1024,timeout:20_000});
  return parseGitBlame(stdout).slice(0,cap);
}

function parseTypeScriptDiagnosticsOutput(stdout){
  try{return JSON.parse(String(stdout||"{}"))}catch{return {available:false,configured:false,failed:true,reason:"TypeScript diagnostic adapter returned invalid output"}}
}

async function localTypeScriptDiagnostics(root,{path,limit=100}={}){
  try{
    const {stdout}=await execFileAsync(process.execPath,["-e",TYPESCRIPT_DIAGNOSTICS_SCRIPT,resolve(root),String(path||""),String(Math.max(1,Math.min(300,Number(limit)||100)))],{cwd:resolve(root),windowsHide:true,maxBuffer:4*1024*1024,timeout:30_000});
    return parseTypeScriptDiagnosticsOutput(stdout);
  }catch(error){
    const parsed=parseTypeScriptDiagnosticsOutput(error?.stdout);if(parsed?.available||parsed?.reason!=="TypeScript diagnostic adapter returned invalid output")return parsed;
    return {available:false,configured:false,failed:true,reason:error?.killed?"TypeScript diagnostics timed out":String(error?.stderr||error?.message||"TypeScript diagnostics failed").slice(0,2000)};
  }
}

async function localTypeScriptSymbol(root,{path,line=1,column=1,operation="definition",limit=100}={}){
  try{
    const {stdout}=await execFileAsync(process.execPath,["-e",TYPESCRIPT_SYMBOL_SCRIPT,resolve(root),String(path||""),String(line),String(column),String(operation),String(Math.max(1,Math.min(300,Number(limit)||100)))],{cwd:resolve(root),windowsHide:true,maxBuffer:4*1024*1024,timeout:30_000});
    return parseTypeScriptDiagnosticsOutput(stdout);
  }catch(error){
    const parsed=parseTypeScriptDiagnosticsOutput(error?.stdout);if(parsed?.available||parsed?.reason!=="TypeScript diagnostic adapter returned invalid output")return parsed;
    return {available:false,configured:false,failed:true,reason:error?.killed?"TypeScript language query timed out":String(error?.stderr||error?.message||"TypeScript language query failed").slice(0,2000)};
  }
}

async function localMetadata(root,paths){
  const pairs=await mapLimit(paths,64,async relativePath=>{
    try{
      const info=await stat(resolve(root,relativePath));
      return info.isFile()?[relativePath,{size:info.size,version:String(info.mtimeMs)}]:null;
    }catch{return null}
  });
  return new Map(pairs.filter(Boolean));
}

async function localReadMany(root,paths){
  const pairs=await mapLimit(paths,32,async relativePath=>{
    try{return [relativePath,await readFile(resolve(root,relativePath),"utf8")]}catch{return null}
  });
  return new Map(pairs.filter(Boolean));
}

function localContextIo(root){
  const absolute=resolve(root);
  return {
    cacheKey:"local:"+absolute,
    root:absolute,
    discoverFiles:()=>discoverFiles(absolute),
    metadata:paths=>localMetadata(absolute,paths),
    readMany:paths=>localReadMany(absolute,paths),
    readText:path=>readFile(resolve(absolute,path),"utf8"),
    searchPaths:options=>localMatchingFiles(absolute,options),
    gitHistory:options=>localGitHistory(absolute,options),
    gitBlame:options=>localGitBlame(absolute,options),
    typeScriptDiagnostics:options=>localTypeScriptDiagnostics(absolute,options),
    typeScriptSymbol:options=>localTypeScriptSymbol(absolute,options),
    gitState:()=>gitState(absolute),
    changedSince:async(fromHead,toHead)=>{
      if(!fromHead||!toHead||fromHead===toHead)return new Set();
      const {stdout}=await execFileAsync("git",["-C",absolute,"diff","--name-only","-z",fromHead,toHead,"--"],{windowsHide:true,maxBuffer:16*1024*1024,timeout:20_000});
      return new Set(String(stdout||"").split("\0").filter(Boolean).map(slash));
    },
    relativeFocus:path=>slash(relative(absolute,resolve(absolute,path))).replace(/^\.\//,""),
  };
}

function remoteInput(paths){return paths.map(path=>"./"+String(path||"").replace(/^\.\//,"")).join("\0")+"\0"}
function decodeBase64(value){try{return Buffer.from(String(value||""),"base64").toString("utf8")}catch{return ""}}

export function createRemoteContextIo({environments,environmentId,root}={}){
  if(!environments||!environmentId)throw new Error("Remote context requires an environment");
  const absolute=posix.normalize(String(root||"/"));
  const run=options=>environments.executeArgv(environmentId,options);
  const runInput=options=>environments.executeArgvInput(environmentId,options);
  const discoverFiles=async()=>{
    const git=await run({command:"git",args:["-C",absolute,"ls-files","-co","--exclude-standard","-z"],cwd:"",timeoutMs:20_000,maxOutput:16*1024*1024});
    if(git.exitCode===0)return String(git.stdout||"").split("\0").filter(Boolean).map(path=>path.replace(/\\/g,"/")).filter(indexablePath);
    const args=[".","(","-name",".git","-o","-name","node_modules","-o","-name","target","-o","-name","dist","-o","-name","build","-o","-name",".next","-o","-name",".cache","-o","-name","desktop-dist","-o","-name","coverage","-o","-name","vendor",")","-prune","-o","-type","f","-print0"];
    const found=await run({command:"find",args,cwd:absolute,timeoutMs:25_000,maxOutput:16*1024*1024});
    if(found.exitCode!==0)throw new Error(found.stderr||"Could not list remote workspace for context indexing");
    return String(found.stdout||"").split("\0").filter(Boolean).map(path=>path.replace(/^\.\//,"")).filter(indexablePath);
  };
  const metadata=async paths=>{
    if(!paths.length)return new Map();
    const script="while IFS= read -r -d '' f; do [ -f \"$f\" ] || continue; if m=$(stat -c '%s\\t%y' \"$f\" 2>/dev/null); then :; else m=$(stat -f '%z\\t%m' \"$f\" 2>/dev/null) || continue; fi; printf '%s\\t' \"$m\"; printf '%s' \"${f#./}\" | base64 | tr -d '\\r\\n'; printf '\\n'; done";
    const result=await runInput({command:"bash",args:["-lc",script],input:remoteInput(paths),cwd:absolute,timeoutMs:30_000,maxOutput:8*1024*1024});
    if(result.exitCode!==0)throw new Error(result.stderr||"Could not inspect remote workspace files");
    const entries=[];
    for(const line of String(result.stdout||"").split(/\r?\n/)){
      if(!line)continue;const parts=line.split("\t");if(parts.length<3)continue;
      const size=Number(parts[0]),encoded=parts.at(-1),relativePath=decodeBase64(encoded);
      if(!relativePath||!Number.isFinite(size))continue;
      entries.push([relativePath,{size,version:parts.slice(1,-1).join("\t")}]);
    }
    return new Map(entries);
  };
  const readMany=async paths=>{
    const output=new Map();
    const script="while IFS= read -r -d '' f; do [ -f \"$f\" ] || continue; printf '%s\\t' \"$(printf '%s' \"${f#./}\" | base64 | tr -d '\\r\\n')\"; base64 < \"$f\" | tr -d '\\r\\n'; printf '\\n'; done";
    for(let offset=0;offset<paths.length;offset+=16){
      const batch=paths.slice(offset,offset+16);
      const result=await runInput({command:"bash",args:["-lc",script],input:remoteInput(batch),cwd:absolute,timeoutMs:45_000,maxOutput:12*1024*1024});
      if(result.exitCode!==0)throw new Error(result.stderr||"Could not read remote workspace files");
      for(const line of String(result.stdout||"").split(/\r?\n/)){
        if(!line)continue;const tab=line.indexOf("\t");if(tab<1)continue;
        const relativePath=decodeBase64(line.slice(0,tab));if(relativePath)output.set(relativePath,decodeBase64(line.slice(tab+1)));
      }
    }
    return output;
  };
  const remoteGitState=async()=>{
    const [status,diff,head]=await Promise.all([
      run({command:"git",args:["-C",absolute,"status","--short"],cwd:"",timeoutMs:15_000,maxOutput:1024*1024}),
      run({command:"git",args:["-C",absolute,"diff","--no-ext-diff","--no-color","--unified=1"],cwd:"",timeoutMs:20_000,maxOutput:2*1024*1024}),
      run({command:"git",args:["-C",absolute,"rev-parse","HEAD"],cwd:"",timeoutMs:10_000,maxOutput:64*1024}),
    ]);
    if(status.exitCode!==0)return {isGit:false,head:null,changed:new Set(),status:"",diff:""};
    const changed=new Set(String(status.stdout||"").split(/\r?\n/).filter(Boolean).map(line=>line.slice(3).replace(/^.* -> /,"").replace(/\\/g,"/")));
    return {isGit:true,head:head.exitCode===0?String(head.stdout||"").trim()||null:null,changed,status:String(status.stdout||"").slice(0,12_000),diff:diff.exitCode===0?String(diff.stdout||"").slice(0,16_000):""};
  };
  const searchPaths=async({query,regex=false,caseSensitive=false,limit=120}={})=>{
    const args=["-C",absolute,"grep","-l","-z","-I","--untracked","--exclude-standard"];
    if(!caseSensitive)args.push("-i");args.push(regex?"-E":"-F","-e",String(query||""),"--");
    const result=await run({command:"git",args,cwd:"",timeoutMs:25_000,maxOutput:4*1024*1024});
    if(result.exitCode===1)return [];
    if(result.exitCode!==0)throw new Error(result.stderr||"Could not search remote repository text");
    return String(result.stdout||"").split("\0").filter(Boolean).map(path=>path.replace(/\\/g,"/")).filter(indexablePath).slice(0,Math.max(1,Math.min(500,Number(limit)||120)));
  };
  const gitHistory=async({path="",limit=20}={})=>{
    const capped=Math.max(1,Math.min(100,Number(limit)||20)),args=["-C",absolute,"log","--no-decorate","-n"+capped,"--format=%x1e%H%x1f%an%x1f%ae%x1f%at%x1f%s"];
    if(path)args.push("--",path);
    const result=await run({command:"git",args,cwd:"",timeoutMs:25_000,maxOutput:2*1024*1024});
    if(result.exitCode===128)return [];
    if(result.exitCode!==0)throw new Error(result.stderr||"Could not read remote Git history");
    return parseGitHistory(result.stdout).slice(0,capped);
  };
  const gitBlame=async({path,startLine=1,endLine=null,maxLines=120}={})=>{
    const start=Math.max(1,Math.trunc(Number(startLine)||1)),cap=Math.max(1,Math.min(200,Math.trunc(Number(maxLines)||120))),end=Math.max(start,Math.min(start+cap-1,Math.trunc(Number(endLine)||start+cap-1)));
    const result=await run({command:"git",args:["-C",absolute,"blame","--line-porcelain","-L"+start+","+end,"--",path],cwd:"",timeoutMs:25_000,maxOutput:4*1024*1024});
    if(result.exitCode!==0)throw new Error(result.stderr||"Could not read remote Git blame");
    return parseGitBlame(result.stdout).slice(0,cap);
  };
  const typeScriptDiagnostics=async({path,limit=100}={})=>{
    const result=await run({command:"node",args:["-e",TYPESCRIPT_DIAGNOSTICS_SCRIPT,absolute,String(path||""),String(Math.max(1,Math.min(300,Number(limit)||100)))],cwd:"",timeoutMs:35_000,maxOutput:4*1024*1024});
    if(result.exitCode!==0)return {available:false,configured:false,failed:true,reason:result.timedOut?"TypeScript diagnostics timed out":String(result.stderr||"Remote TypeScript diagnostics failed").slice(0,2000)};
    return parseTypeScriptDiagnosticsOutput(result.stdout);
  };
  const typeScriptSymbol=async({path,line=1,column=1,operation="definition",limit=100}={})=>{
    const result=await run({command:"node",args:["-e",TYPESCRIPT_SYMBOL_SCRIPT,absolute,String(path||""),String(line),String(column),String(operation),String(Math.max(1,Math.min(300,Number(limit)||100)))],cwd:"",timeoutMs:35_000,maxOutput:4*1024*1024});
    if(result.exitCode!==0)return {available:false,configured:false,failed:true,reason:result.timedOut?"TypeScript language query timed out":String(result.stderr||"Remote TypeScript language query failed").slice(0,2000)};
    return parseTypeScriptDiagnosticsOutput(result.stdout);
  };
  return {
    cacheKey:"remote:"+environmentId+":"+absolute,
    root:absolute,
    discoverFiles,
    metadata,
    readMany,
    searchPaths,
    gitHistory,
    gitBlame,
    typeScriptDiagnostics,
    typeScriptSymbol,
    readText:async relativePath=>{
      const target=posix.join(absolute,String(relativePath||"").replace(/^\.\//,""));
      if(target!==absolute&&!target.startsWith(absolute.endsWith("/")?absolute:absolute+"/"))throw new Error("Context file is outside the remote workspace");
      const result=await run({command:"head",args:["-c","65536",target],cwd:"",timeoutMs:15_000,maxOutput:128*1024});
      if(result.exitCode!==0)throw new Error(result.stderr||"Could not read remote context file");
      return String(result.stdout||"");
    },
    gitState:remoteGitState,
    changedSince:async(fromHead,toHead)=>{
      if(!fromHead||!toHead||fromHead===toHead)return new Set();
      const result=await run({command:"git",args:["-C",absolute,"diff","--name-only","-z",String(fromHead),String(toHead),"--"],cwd:"",timeoutMs:25_000,maxOutput:16*1024*1024});
      if(result.exitCode!==0)throw new Error(result.stderr||"Could not compare remote Git revisions for context indexing");
      return new Set(String(result.stdout||"").split("\0").filter(Boolean).map(path=>path.replace(/\\/g,"/")));
    },
    relativeFocus:path=>{
      const raw=String(path||"");const target=raw.startsWith("/")?posix.normalize(raw):posix.normalize(posix.join(absolute,raw));
      const rel=posix.relative(absolute,target);return rel.startsWith("../")||posix.isAbsolute(rel)?"":rel;
    },
  };
}

function resolveImport(fromPath,spec,available){
  if(!spec)return null;
  let base;
  if(spec.startsWith("."))base=slash(join(dirname(fromPath),spec));
  else if(extname(fromPath).toLowerCase()===".py"){
    if(spec.startsWith("."))base=slash(join(dirname(fromPath),spec.replace(/^\.+/,match=>"../".repeat(Math.max(0,match.length-1)))));else base=spec.split(".").join("/");
  }else return null;
  base=base.replace(/^\.\//,"").replace(/\\/g,"/");
  const candidates=[base,...RESOLVE_EXTENSIONS.map(extension=>base+extension),...RESOLVE_EXTENSIONS.map(extension=>base+"/index"+extension)];
  return candidates.find(candidate=>available.has(candidate))||null;
}

function addEdge(edges,from,to,weight){
  if(!from||!to||from===to)return;
  let row=edges.get(from);if(!row){row=new Map();edges.set(from,row)}
  row.set(to,(row.get(to)||0)+weight);
}

function pageRank(nodes,edges,personalization,iterations=24,damping=0.85){
  if(!nodes.length)return new Map();
  const size=nodes.length,uniform=1/size,totalPersonal=[...personalization.values()].reduce((sum,value)=>sum+value,0)||size;
  const teleport=new Map(nodes.map(node=>[node,(personalization.get(node)||1)/totalPersonal]));
  let rank=new Map(nodes.map(node=>[node,uniform]));
  for(let iteration=0;iteration<iterations;iteration++){
    const next=new Map(nodes.map(node=>[node,(1-damping)*(teleport.get(node)||uniform)]));let dangling=0;
    for(const node of nodes){
      const row=edges.get(node),value=rank.get(node)||0,total=row?[...row.values()].reduce((sum,weight)=>sum+weight,0):0;
      if(!total){dangling+=value;continue}
      for(const [target,weight] of row)next.set(target,(next.get(target)||0)+damping*value*weight/total);
    }
    if(dangling)for(const node of nodes)next.set(node,(next.get(node)||0)+damping*dangling*(teleport.get(node)||uniform));
    rank=next;
  }
  return rank;
}

function relevanceFor(entry,terms,changed,focusSet){
  let score=0;const reasons=[];const lowerPath=entry.relativePath.toLowerCase(),tokens=pathTokens(lowerPath),base=basename(lowerPath);
  const focused=[...focusSet].some(path=>path===entry.relativePath||path.endsWith("/"+entry.relativePath)||entry.relativePath.endsWith("/"+path));
  if(focused){score+=90;reasons.push("explicitly attached or focused")}
  if(changed.has(entry.relativePath)){score+=35;reasons.push("currently changed in Git")}
  const pathMatches=terms.filter(term=>lowerPath.includes(term)||tokens.has(term));if(pathMatches.length){score+=Math.min(40,pathMatches.length*12);reasons.push("path matches task: "+pathMatches.slice(0,3).join(", "))}
  const symbolMatches=entry.parsed.definitions.filter(definition=>terms.some(term=>definition.name.toLowerCase().includes(term))).slice(0,6);
  if(symbolMatches.length){score+=Math.min(55,symbolMatches.length*16);reasons.push("defines task-related symbol"+(symbolMatches.length>1?"s":"")+": "+symbolMatches.map(item=>item.name).join(", "))}
  const sample=entry.sample.toLowerCase();const contentMatches=terms.filter(term=>sample.includes(term));if(contentMatches.length){score+=Math.min(22,contentMatches.length*5);reasons.push("contains task terms: "+contentMatches.slice(0,3).join(", "))}
  if(/(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\./i.test(entry.relativePath)){score+=terms.some(term=>lowerPath.includes(term))?18:2;reasons.push("test file")}
  return {score,reasons,symbolMatches};
}

function repositoryGraph(files,{terms=[],changed=new Set(),focusSet=new Set()}={}){
  const available=new Set(files.map(entry=>entry.relativePath)),definitionIndex=new Map(),edges=new Map(),relevance=new Map(),personalization=new Map();
  for(const entry of files)for(const definition of entry.parsed.definitions||[]){let owners=definitionIndex.get(definition.name);if(!owners){owners=[];definitionIndex.set(definition.name,owners)}owners.push(entry.relativePath)}
  for(const entry of files){
    const rank=relevanceFor(entry,terms,changed,focusSet);relevance.set(entry.relativePath,rank);personalization.set(entry.relativePath,1+rank.score);
    for(const spec of entry.parsed.imports||[]){const target=resolveImport(entry.relativePath,spec,available);if(target)addEdge(edges,entry.relativePath,target,4)}
    for(const [name,count] of entry.parsed.references||[]){const owners=definitionIndex.get(name);if(!owners||owners.length>4)continue;for(const owner of owners)addEdge(edges,entry.relativePath,owner,Math.min(4,Math.sqrt(count)))}
  }
  const centrality=pageRank(files.map(entry=>entry.relativePath),edges,personalization),edgeCount=[...edges.values()].reduce((sum,row)=>sum+row.size,0);
  return {available,definitionIndex,edges,relevance,centrality,edgeCount};
}

function relevantExcerpt(content,entry,terms,maxChars=2600){
  const lines=String(content||"").split(/\r?\n/),anchors=[];
  for(const definition of entry.parsed.definitions){if(terms.some(term=>definition.name.toLowerCase().includes(term)))anchors.push(definition.line-1)}
  if(!anchors.length&&terms.length){
    for(let index=0;index<lines.length&&anchors.length<4;index++)if(terms.some(term=>lines[index].toLowerCase().includes(term)))anchors.push(index);
  }
  if(!anchors.length)anchors.push(...entry.parsed.definitions.slice(0,4).map(item=>item.line-1));
  const wanted=new Set();for(const anchor of anchors.slice(0,5))for(let index=Math.max(0,anchor-2);index<=Math.min(lines.length-1,anchor+4);index++)wanted.add(index);
  const selected=[...wanted].sort((a,b)=>a-b);let output="",previous=-2;
  for(const index of selected){if(index>previous+1)output+="  ...\n";output+=String(index+1).padStart(5)+" | "+lines[index].slice(0,500)+"\n";previous=index;if(output.length>=maxChars)break}
  return output.slice(0,maxChars).trimEnd();
}

function excerptNeedsFullSource(entry,terms){
  if(!entry||Number(entry.size||0)<=String(entry.sample||"").length)return false;
  const sampleLines=String(entry.sample||"").split(/\r?\n/).length;
  const matching=entry.parsed?.definitions?.filter(definition=>terms.some(term=>definition.name.toLowerCase().includes(term)))||[];
  return matching.some(definition=>Number(definition.line||0)>sampleLines);
}

function publicItem(entry,score,centrality,reasons,tokenCost){
  return {path:entry.relativePath,score:Number(score.toFixed(3)),centrality:Number(centrality.toFixed(6)),reasons,symbols:entry.parsed.definitions.slice(0,16),parser:entry.parsed.parser||"regex",tokenEstimate:tokenCost};
}

async function boundedInstructionBlock(contextIo,paths,maxTokens){
  const unique=[...new Set(paths||[])];if(!unique.length||maxTokens<=0)return "";
  const depth=path=>slash(dirname(path)).split("/").filter(part=>part&&part!==".").length;
  const ordered=unique.sort((a,b)=>depth(a)-depth(b)||a.localeCompare(b));
  const prefix="Repository instructions (scoped; nested files override broader guidance):\n";
  const maxChars=Math.max(256,Math.floor(maxTokens)*4),chunks=[];let remaining=Math.max(0,maxChars-prefix.length);
  for(let index=0;index<ordered.length&&remaining>80;index++){
    const path=ordered[index],left=ordered.length-index,header=`### ${path}\n`,marker="\n[truncated by Trebell context budget]";
    let content="";try{content=String(await contextIo.readText(path)||"").trim()}catch{continue}
    if(!content)continue;
    const share=Math.max(96,Math.floor(remaining/left)),contentLimit=Math.max(32,share-header.length-(content.length>share?marker.length:0));
    let clipped=content.slice(0,contentLimit);if(clipped.length<content.length)clipped=clipped.trimEnd()+marker;
    let chunk=header+clipped;if(chunk.length>remaining)chunk=chunk.slice(0,remaining);
    if(chunk.length<=header.length)continue;
    chunks.push(chunk);remaining-=chunk.length+2;
  }
  const block=chunks.length?prefix+"\n"+chunks.join("\n\n"):"";
  return tokenEstimate(block)<=maxTokens?block:block.slice(0,Math.max(0,Math.floor(maxTokens)*4));
}

export function planContextBudget({task="",focusPaths=[],tokensUsed=null,contextWindow=null,maxTokens=null,maxFiles=null}={}){
  const text=String(task||"").trim(),terms=taskTerms(text),focusCount=Array.isArray(focusPaths)?focusPaths.length:0;
  const broadIntent=/\b(?:architecture|architectural|across|codebase|repo(?:sitory)?|refactor|redesign|migrate|parity|end[- ]to[- ]end|integrat(?:e|ion)|system[- ]wide|all files|everywhere)\b/i.test(text);
  let complexityScore=0;
  if(text.length>220)complexityScore++;if(text.length>700)complexityScore++;
  if(terms.length>14)complexityScore++;if(terms.length>24)complexityScore++;
  if(focusCount>=2)complexityScore++;if(focusCount>=5)complexityScore++;
  if(broadIntent)complexityScore++;
  const complexity=complexityScore<=1?"focused":complexityScore>=3?"broad":"normal";
  const defaults=complexity==="focused"?{maxTokens:2800,maxFiles:12}:complexity==="broad"?{maxTokens:7000,maxFiles:24}:{maxTokens:5200,maxFiles:20};
  const used=Number(tokensUsed),windowSize=Number(contextWindow);
  const utilization=Number.isFinite(used)&&used>=0&&Number.isFinite(windowSize)&&windowSize>0?Math.max(0,Math.min(1,used/windowSize)):null;
  const remainingTokens=utilization==null?null:Math.max(0,windowSize-used);
  const reserveTokens=utilization==null?null:Math.max(4000,Math.min(16_000,Math.round(windowSize*.08)));
  let pressure="normal",tokenCap=defaults.maxTokens,fileCap=defaults.maxFiles,reason=complexity==="focused"?"short/focused task":complexity==="broad"?"broad cross-file task":"normal repository task";
  if(utilization!=null&&utilization>=0.85){pressure="critical";tokenCap=Math.min(tokenCap,1600);fileCap=Math.min(fileCap,8);reason="context window is at least 85% full"}
  else if(utilization!=null&&utilization>=0.70){pressure="tight";tokenCap=Math.min(tokenCap,2800);fileCap=Math.min(fileCap,12);reason="context window is at least 70% full"}
  else if(utilization!=null&&utilization>=0.40){pressure="balanced";tokenCap=Math.min(tokenCap,4400);fileCap=Math.min(fileCap,18);reason="context window is at least 40% full"}
  const explicitTokens=maxTokens!=null&&String(maxTokens)!=="",explicitFiles=maxFiles!=null&&String(maxFiles)!=="";
  const callerSkip=explicitTokens&&Number(maxTokens)<=0;
  const skip=callerSkip||(remainingTokens!=null&&reserveTokens!=null&&remainingTokens<reserveTokens+800);
  if(skip){pressure="exhausted";reason=callerSkip?"caller requested no repository injection":"context window only has the response safety reserve left"}
  const requestedTokenCap=explicitTokens&&Number(maxTokens)>0?boundedNumber(maxTokens,tokenCap,800,20_000):null;
  const requestedFileCap=explicitFiles&&Number(maxFiles)>0?boundedNumber(maxFiles,fileCap,4,80):null;
  const plannedTokens=skip?0:Math.round(requestedTokenCap==null?tokenCap:Math.min(tokenCap,requestedTokenCap));
  const plannedFiles=skip?0:Math.round(requestedFileCap==null?fileCap:Math.min(fileCap,requestedFileCap));
  return {
    mode:pressure==="normal"?complexity:pressure,skip,
    complexity,
    pressure,
    maxTokens:plannedTokens,
    maxFiles:plannedFiles,
    utilization:utilization==null?null:Number(utilization.toFixed(4)),
    utilizationPercent:utilization==null?null:Math.round(utilization*100),
    remainingTokens:remainingTokens==null?null:Math.round(remainingTokens),
    reserveTokens:reserveTokens==null?null:Math.round(reserveTokens),
    reason,
    cappedByCaller:Boolean(!skip&&((requestedTokenCap!=null&&requestedTokenCap<tokenCap)||(requestedFileCap!=null&&requestedFileCap<fileCap))),
  };
}

export class ContextEngine{
  constructor({maxFileBytes=256_000}={}){this.maxFileBytes=maxFileBytes;this.roots=new Map();this.gitStates=new Map()}

  async #indexed(root,io=null){
    if(!root)throw new Error("Context Engine requires a workspace path");
    const contextIo=io||localContextIo(root),git=await contextIo.gitState(),index=await this.#index(root,contextIo,git);
    return {contextIo,git,index};
  }

  async #index(root,contextIo,git){
    const started=Date.now(),io=contextIo||localContextIo(root),absolute=io.root,cacheKey=io.cacheKey||absolute;
    const paths=(await io.discoverFiles()).slice(0,20_000),previous=this.roots.get(cacheKey)||new Map(),previousGit=this.gitStates.get(cacheKey)||null,next=new Map();let reparsed=0,reused=0,skipped=0;
    const sourcePaths=paths.filter(relativePath=>SOURCE_EXTENSIONS.has(extname(relativePath).toLowerCase()));
    const currentHead=String(git?.head||"").trim()||null,previousHead=String(previousGit?.head||"").trim()||null;
    const revisionChanged=Boolean(previous.size&&git?.isGit&&currentHead&&previousHead&&currentHead!==previousHead);
    const revisionUnknown=Boolean(previous.size&&git?.isGit&&(!currentHead||!previousHead));
    const dirtyPaths=new Set([...(git?.changed||[]),...(previousGit?.changed||[])]);
    let revisionPaths=null;
    if(revisionChanged&&typeof io.changedSince==="function"){
      try{revisionPaths=await io.changedSince(previousHead,currentHead)}catch{}
    }
    const inspect=(!previous.size||!git?.isGit||revisionUnknown||(revisionChanged&&!revisionPaths))
      ?sourcePaths
      :sourcePaths.filter(relativePath=>!previous.has(relativePath)||previous.get(relativePath)?.parserVersion!==parserVersion(relativePath)||dirtyPaths.has(relativePath)||(revisionChanged&&revisionPaths.has(relativePath)));
    const inspectSet=new Set(inspect);
    const metadata=await io.metadata(inspect);
    const toRead=[];
    for(const relativePath of sourcePaths){
      const cached=previous.get(relativePath);
      if(cached&&!inspectSet.has(relativePath)){next.set(relativePath,cached);reused++;continue}
      const info=metadata.get(relativePath);
      if(!info||info.size>this.maxFileBytes){skipped++;continue}
      const parser=parserVersion(relativePath);
      if(cached&&cached.parserVersion===parser&&cached.size===info.size&&cached.version===info.version){next.set(relativePath,cached);reused++;continue}
      toRead.push(relativePath);
    }
    const contents=await io.readMany(toRead,this.maxFileBytes);
    for(const relativePath of toRead){
      const info=metadata.get(relativePath),content=contents.get(relativePath);
      if(!info||typeof content!=="string"||content.includes("\0")){skipped++;continue}
      next.set(relativePath,{relativePath,size:info.size,version:info.version,parserVersion:parserVersion(relativePath),sample:content.slice(0,64_000),parsed:parseSource(content,relativePath)});reparsed++;
    }
    this.roots.set(cacheKey,next);this.gitStates.set(cacheKey,{head:currentHead,changed:new Set(git?.changed||[])});
    return {root:absolute,files:next,paths,reparsed,reused,skipped,inspected:inspect.length,durationMs:Date.now()-started,cacheKey,revisionChanged,revisionUnknown,revisionDiffUsed:Boolean(revisionChanged&&revisionPaths)};
  }

  async buildPacket({root,task="",focusPaths=[],maxTokens=null,maxFiles=null,tokensUsed=null,contextWindow=null,io=null}={}){
    if(!root)throw new Error("Context Engine requires a workspace path");
    const contextIo=io||localContextIo(root);
    const budgetPlan=planContextBudget({task,focusPaths,tokensUsed,contextWindow,maxTokens,maxFiles});
    if(budgetPlan.skip)return {
      id:`ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`,
      root:contextIo.root,task:String(task||""),generatedAt:Date.now(),tokenEstimate:0,maxTokens:0,
      items:[],injection:"",budget:budgetPlan,skipped:true,
      stats:{filesIndexed:0,reparsed:0,reused:0,skipped:0,inspected:0,graphEdges:0,durationMs:0,remote:Boolean(io),skippedByPressure:true},
    };
    const budget=budgetPlan.maxTokens,fileLimit=budgetPlan.maxFiles;
    const git=await contextIo.gitState();
    const index=await this.#index(root,contextIo,git);const terms=taskTerms(task),files=[...index.files.values()],focusSet=new Set((focusPaths||[]).map(path=>contextIo.relativeFocus(path)).filter(Boolean));
    const {edges,relevance,centrality,edgeCount}=repositoryGraph(files,{terms,changed:git.changed,focusSet});
    const ranked=files.map(entry=>{
      const rel=relevance.get(entry.relativePath),central=centrality.get(entry.relativePath)||0;
      const combined=rel.score+central*250;return {entry,rel,central,combined};
    }).sort((a,b)=>b.combined-a.combined||b.central-a.central||a.entry.relativePath.localeCompare(b.entry.relativePath));

    const header=`Trebell repository context\nTask: ${String(task||"").trim()||"(no task text supplied)"}\nSelection is deterministic and bounded. Read files/tools for full source before editing.`;
    const likelyPaths=new Set(ranked.slice(0,Math.max(fileLimit*2,16)).map(candidate=>candidate.entry.relativePath));
    const instructionPaths=index.paths.filter(path=>{
      if(!INSTRUCTION_NAMES.has(basename(path)))return false;
      const directory=slash(dirname(path));if(directory==="."||directory==="")return true;
      return [...likelyPaths].some(candidate=>candidate.startsWith(directory+"/"));
    }).slice(0,20);
    const sections=[];let used=tokenEstimate(header)+20;
    if(instructionPaths.length){
      const instructionBudget=Math.max(160,Math.min(Math.floor(budget*.35),budget-used-80));
      const block=await boundedInstructionBlock(contextIo,instructionPaths,instructionBudget),cost=tokenEstimate(block);
      if(block&&cost>0&&used+cost<=budget){sections.push(block.trim());used+=cost}
    }
    if(git.status){const block=`Current Git status:\n${git.status.trim()}${git.diff?`\n\nCurrent diff excerpt:\n${git.diff.trim()}`:""}`;const clipped=block.slice(0,12_000),cost=tokenEstimate(clipped);if(used+cost<budget*.55){sections.push(clipped);used+=cost}}

    const selected=[];
    for(const candidate of ranked){
      if(selected.length>=fileLimit)break;
      const {entry,rel,central,combined}=candidate;if(combined<=0&&selected.length>=Math.min(6,fileLimit))break;
      let excerpt=relevantExcerpt(entry.sample,entry,terms);
      if(excerptNeedsFullSource(entry,terms)){
        try{excerpt=relevantExcerpt(await contextIo.readText(entry.relativePath),entry,terms)}catch{}
      }
      const symbols=entry.parsed.definitions.slice(0,20).map(item=>`${item.kind} ${item.name} (L${item.line})`).join(", ");
      const reasons=[...rel.reasons];if(central>1/Math.max(1,files.length)*1.35)reasons.push("structurally central in repository graph");
      const block=`### ${entry.relativePath}\nWhy selected: ${reasons.join("; ")||"repository structure"}\n${symbols?`Key symbols: ${symbols}\n`:""}${excerpt?`Relevant structure/excerpt:\n${excerpt}`:""}`.trim();
      const cost=tokenEstimate(block);if(used+cost>budget)continue;
      sections.push(block);used+=cost;selected.push(publicItem(entry,combined,central,reasons,cost));
    }

    const injection=[header,...sections].join("\n\n").trim();
    return {
      id:`ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`,
      root:index.root,task:String(task||""),generatedAt:Date.now(),tokenEstimate:tokenEstimate(injection),maxTokens:budget,
      items:selected,injection,budget:budgetPlan,
      stats:{filesIndexed:files.length,reparsed:index.reparsed,reused:index.reused,skipped:index.skipped,inspected:index.inspected,graphEdges:edgeCount,durationMs:index.durationMs,remote:Boolean(io),revisionChanged:index.revisionChanged,revisionUnknown:index.revisionUnknown,revisionDiffUsed:index.revisionDiffUsed},
    };
  }

  async searchSymbols({root,query="",limit=40,io=null}={}){
    const needle=String(query||"").trim().toLowerCase();if(!needle)throw new Error("Symbol search requires a query");
    const {index}=await this.#indexed(root,io);const capped=Math.max(1,Math.min(200,Number(limit)||40)),matches=[];
    for(const entry of index.files.values()){
      for(const definition of entry.parsed.definitions||[]){
        const name=String(definition.name||""),lower=name.toLowerCase(),signature=String(definition.signature||""),path=entry.relativePath.toLowerCase();
        let score=0;if(lower===needle)score=100;else if(lower.startsWith(needle))score=85;else if(lower.includes(needle))score=70;else if(signature.toLowerCase().includes(needle))score=45;else if(path.includes(needle))score=25;else continue;
        matches.push({path:entry.relativePath,name,kind:definition.kind,line:definition.line,signature,parser:entry.parsed.parser||"regex",score});
      }
    }
    return {query:String(query),data:matches.sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)||a.path.localeCompare(b.path)).slice(0,capped),indexedFiles:index.files.size};
  }

  async searchFiles({root,query="",limit=80,io=null}={}){
    const raw=String(query||"").trim(),needle=raw.toLowerCase();if(!needle)throw new Error("File search requires a query");
    if(raw.length>500)throw new Error("File search query is too long");
    const {index}=await this.#indexed(root,io),capped=Math.max(1,Math.min(200,Number(limit)||80)),matches=[];
    for(const path of index.paths){
      const lower=path.toLowerCase(),base=basename(lower);let score=0;
      if(lower===needle)score=120;else if(base===needle)score=110;else if(base.startsWith(needle))score=95;else if(lower.startsWith(needle))score=85;else if(base.includes(needle))score=75;else if(lower.includes(needle))score=60;else continue;
      matches.push({path,score,indexedSource:index.files.has(path),extension:extname(path).toLowerCase()||null});
    }
    return {query:raw,data:matches.sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path)).slice(0,capped),filesDiscovered:index.paths.length,indexedFiles:index.files.size};
  }

  async repositoryMap({root,query="",limit=60,io=null}={}){
    if(String(query||"").length>1000)throw new Error("Repository map query is too long");
    const {git,index}=await this.#indexed(root,io),files=[...index.files.values()],terms=taskTerms(query),capped=Math.max(1,Math.min(120,Number(limit)||60));
    const {available,edges,relevance,centrality,edgeCount}=repositoryGraph(files,{terms,changed:git.changed||new Set(),focusSet:new Set()}),incoming=new Map();
    for(const [from,row] of edges)for(const to of row.keys()){let sources=incoming.get(to);if(!sources){sources=new Set();incoming.set(to,sources)}sources.add(from)}
    const data=files.map(entry=>{
      const rel=relevance.get(entry.relativePath)||{score:0,reasons:[]},central=centrality.get(entry.relativePath)||0,imports=(entry.parsed.imports||[]).map(specifier=>({specifier,target:resolveImport(entry.relativePath,specifier,available)})).filter(item=>item.target).slice(0,20);
      return {path:entry.relativePath,score:Number((rel.score+central*250).toFixed(3)),centrality:Number(central.toFixed(6)),reasons:rel.reasons,parser:entry.parsed.parser||"regex",definitions:(entry.parsed.definitions||[]).slice(0,16),imports,incoming:(incoming.get(entry.relativePath)||new Set()).size,outgoing:(edges.get(entry.relativePath)||new Map()).size,test:/(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\./i.test(entry.relativePath)};
    }).sort((a,b)=>b.score-a.score||b.centrality-a.centrality||a.path.localeCompare(b.path)).slice(0,capped);
    return {query:String(query||""),data,indexedFiles:index.files.size,graphEdges:edgeCount,changed:[...(git.changed||[])].slice(0,200)};
  }

  async relatedTests({root,path=null,name=null,limit=80,io=null}={}){
    if(!String(path||"").trim()&&!String(name||"").trim())throw new Error("Related tests require a path or symbol name");
    if(String(name||"").length>256)throw new Error("Related test symbol name is too long");
    const {contextIo,index}=await this.#indexed(root,io),available=new Set(index.files.keys()),targets=[];
    if(String(path||"").trim()){
      const requested=contextIo.relativeFocus(path)||slash(String(path||"").replace(/^\.\//,""));if(!index.files.has(requested))throw new Error(`Context file is not indexed: ${path}`);targets.push(requested);
    }
    if(String(name||"").trim())for(const entry of index.files.values())if((entry.parsed.definitions||[]).some(item=>item.name===String(name).trim()))targets.push(entry.relativePath);
    const uniqueTargets=[...new Set(targets)].slice(0,40);if(!uniqueTargets.length)return {path:path==null?null:String(path),name:name==null?null:String(name),targets:[],data:[],indexedFiles:index.files.size};
    const targetNames=new Map(uniqueTargets.map(target=>[target,new Set((index.files.get(target)?.parsed.definitions||[]).map(item=>item.name))])),testLike=value=>/(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\./i.test(value),tests=new Map();
    for(const candidate of index.files.values()){
      if(!testLike(candidate.relativePath))continue;
      const reasons=[];
      for(const target of uniqueTargets){
        if((candidate.parsed.imports||[]).some(specifier=>resolveImport(candidate.relativePath,specifier,available)===target))reasons.push(`imports ${target}`);
        const names=targetNames.get(target);if(names?.size)for(const referenced of candidate.parsed.references?.keys?.()||[])if(names.has(referenced)){reasons.push(`references ${referenced}`);break}
      }
      if(reasons.length)tests.set(candidate.relativePath,[...new Set(reasons)]);
    }
    const capped=Math.max(1,Math.min(200,Number(limit)||80)),data=[...tests].map(([testPath,reasons])=>({path:testPath,reasons})).sort((a,b)=>a.path.localeCompare(b.path)).slice(0,capped);
    return {path:path==null?null:String(path),name:name==null?null:String(name),targets:uniqueTargets,data,indexedFiles:index.files.size,truncated:tests.size>capped};
  }

  async callHierarchy({root,name="",path=null,limit=120,io=null}={}){
    const symbol=String(name||"").trim();if(!symbol)throw new Error("Call hierarchy requires a symbol name");
    if(symbol.length>256)throw new Error("Call hierarchy symbol name is too long");
    const {contextIo,index}=await this.#indexed(root,io),capped=Math.max(1,Math.min(200,Number(limit)||120));let requested=null;
    if(path!=null&&String(path).trim()){
      requested=contextIo.relativeFocus(path)||slash(String(path||"").replace(/^\.\//,""));if(!index.files.has(requested))throw new Error(`Context file is not indexed: ${path}`);
    }
    const definitions=[];
    for(const entry of index.files.values())for(const definition of entry.parsed.definitions||[])if(definition.name===symbol&&(!requested||entry.relativePath===requested))definitions.push({path:entry.relativePath,...definition,parser:entry.parsed.parser||"regex"});
    const candidates=[...index.files.values()].filter(entry=>BABEL_SOURCE_EXTENSIONS.has(extname(entry.relativePath).toLowerCase())&&((entry.parsed.references||new Map()).has(symbol)||(entry.parsed.definitions||[]).some(item=>item.name===symbol))).slice(0,240);
    const contents=await contextIo.readMany(candidates.map(entry=>entry.relativePath)),callers=[],callees=[];
    for(const entry of candidates){
      const content=contents.get(entry.relativePath);if(typeof content!=="string")continue;let sites=[];try{sites=javascriptCallSites(content,entry.relativePath)}catch{continue}
      const lines=content.split(/\r?\n/);
      for(const site of sites){
        if(site.callee===symbol&&callers.length<capped)callers.push({path:entry.relativePath,line:site.line,caller:site.caller,kind:site.kind,text:String(lines[site.line-1]||"").slice(0,600),precision:"ast-lexical"});
        if(site.caller===symbol&&callees.length<capped)callees.push({path:entry.relativePath,line:site.line,callee:site.callee,kind:site.kind,text:String(lines[site.line-1]||"").slice(0,600),precision:"ast-lexical"});
      }
    }
    return {name:symbol,path:requested,definitions:definitions.slice(0,80),callers,callees,indexedFiles:index.files.size,supportedFiles:candidates.length,truncated:callers.length>=capped||callees.length>=capped,precision:"ast-lexical",semantic:false};
  }

  async diagnostics({root,path,limit=100,semantic=false,io=null}={}){
    const {contextIo,index}=await this.#indexed(root,io),requested=contextIo.relativeFocus(path)||slash(String(path||"").replace(/^\.\//,""));
    const entry=index.files.get(requested);if(!entry)throw new Error(`Context file is not indexed: ${path}`);
    const extension=extname(requested).toLowerCase(),capped=Math.max(1,Math.min(200,Number(limit)||100));
    if(!BABEL_SOURCE_EXTENSIONS.has(extension))return {path:requested,supported:false,engine:null,semantic:false,semanticRequested:Boolean(semantic),semanticDiagnostics:[],diagnostics:[],reason:`No deterministic Trebell diagnostics adapter is configured for ${extension||"this file type"}`};
    const contents=await contextIo.readMany([requested]),content=contents.get(requested);if(typeof content!=="string")throw new Error(`Could not read context file: ${path}`);
    const diagnostics=javascriptSyntaxDiagnostics(content,requested);
    let semanticResult=null;
    if(semantic&&typeof contextIo.typeScriptDiagnostics==="function"){
      try{semanticResult=await contextIo.typeScriptDiagnostics({path:requested,limit:capped})}
      catch(error){semanticResult={available:false,configured:false,failed:true,reason:String(error?.message||error)}}
    }
    const semanticReady=Boolean(semanticResult?.available&&semanticResult?.configured&&!semanticResult?.failed),semanticDiagnostics=Array.isArray(semanticResult?.diagnostics)?semanticResult.diagnostics.slice(0,capped):[];
    return {path:requested,supported:true,engine:"babel-parser",semantic:semanticReady,semanticRequested:Boolean(semantic),semanticEngine:semanticReady?"typescript":null,semanticInfo:semanticResult,semanticDiagnostics,diagnostics:diagnostics.slice(0,capped),truncated:diagnostics.length>capped||Boolean(semanticResult?.truncated)};
  }

  async languageSymbol({root,path,line=1,column=1,operation="definition",limit=100,io=null}={}){
    const allowed=new Set(["definition","references","quick_info","callers","callees"]),mode=String(operation||"definition");if(!allowed.has(mode))throw new Error(`Unsupported language symbol operation: ${mode}`);
    const {contextIo,index}=await this.#indexed(root,io),requested=contextIo.relativeFocus(path)||slash(String(path||"").replace(/^\.\//,""));
    const entry=index.files.get(requested);if(!entry)throw new Error(`Context file is not indexed: ${path}`);
    const extension=extname(requested).toLowerCase();if(!BABEL_SOURCE_EXTENSIONS.has(extension))return {path:requested,line:Number(line)||1,column:Number(column)||1,operation:mode,supported:false,engine:null,semantic:false,data:[],reason:`No semantic Trebell language adapter is configured for ${extension||"this file type"}`};
    if(typeof contextIo.typeScriptSymbol!=="function")return {path:requested,line:Number(line)||1,column:Number(column)||1,operation:mode,supported:false,engine:null,semantic:false,data:[],reason:"TypeScript language queries are unavailable for this workspace"};
    const row=Math.max(1,Math.trunc(Number(line)||1)),col=Math.max(1,Math.trunc(Number(column)||1)),capped=Math.max(1,Math.min(200,Number(limit)||100));let result;
    try{result=await contextIo.typeScriptSymbol({path:requested,line:row,column:col,operation:mode,limit:capped})}catch(error){result={available:false,configured:false,failed:true,reason:String(error?.message||error)}}
    const ready=Boolean(result?.available&&result?.configured&&!result?.failed&&!result?.unsupported);
    return {path:requested,line:row,column:col,operation:mode,supported:ready,engine:ready?"typescript":null,semantic:ready,version:result?.version||null,included:result?.included??null,data:result?.data??(mode==="quick_info"?null:[]),truncated:Boolean(result?.truncated),info:result,reason:ready?null:(result?.reason||"Project-local TypeScript language service is unavailable")};
  }

  async fileRelations({root,path,io=null}={}){
    const {contextIo,index}=await this.#indexed(root,io),available=new Set(index.files.keys());
    const requested=contextIo.relativeFocus(path)||slash(String(path||"").replace(/^\.\//,""));
    const entry=index.files.get(requested);if(!entry)throw new Error(`Context file is not indexed: ${path}`);
    const imports=(entry.parsed.imports||[]).map(specifier=>({specifier,target:resolveImport(entry.relativePath,specifier,available)}));
    const importers=[],referencedSymbols=[],referencedBy=[];
    const owners=new Map();for(const candidate of index.files.values())for(const definition of candidate.parsed.definitions||[]){let list=owners.get(definition.name);if(!list){list=[];owners.set(definition.name,list)}list.push(candidate.relativePath)}
    for(const candidate of index.files.values()){
      if(candidate.relativePath!==entry.relativePath){
        for(const specifier of candidate.parsed.imports||[])if(resolveImport(candidate.relativePath,specifier,available)===entry.relativePath){importers.push({path:candidate.relativePath,specifier});break}
      }
    }
    for(const [name,count] of entry.parsed.references||[]){
      const targets=(owners.get(name)||[]).filter(target=>target!==entry.relativePath);if(!targets.length||targets.length>4)continue;
      for(const target of targets)referencedSymbols.push({name,target,count});
    }
    const definedNames=new Set((entry.parsed.definitions||[]).map(item=>item.name));
    if(definedNames.size){
      for(const candidate of index.files.values()){
        if(candidate.relativePath===entry.relativePath)continue;
        for(const [name,count] of candidate.parsed.references||[])if(definedNames.has(name))referencedBy.push({name,path:candidate.relativePath,count});
      }
    }
    const testLike=path=>/(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\./i.test(path);
    const relatedTests=[...new Set([
      ...importers.filter(item=>testLike(item.path)).map(item=>item.path),
      ...referencedBy.filter(item=>testLike(item.path)).map(item=>item.path),
    ])].slice(0,80);
    return {
      path:entry.relativePath,parser:entry.parsed.parser||"regex",definitions:(entry.parsed.definitions||[]).slice(0,200),
      imports:imports.slice(0,200),importers:importers.slice(0,200),referencedSymbols:referencedSymbols.sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name)).slice(0,200),
      referencedBy:referencedBy.sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name)).slice(0,200),relatedTests,indexedFiles:index.files.size,
    };
  }

  async symbolReferences({root,name="",path=null,limit=120,io=null}={}){
    const symbol=String(name||"").trim();if(!symbol)throw new Error("Symbol references require a name");
    if(symbol.length>256)throw new Error("Symbol reference name is too long");
    const {contextIo,index}=await this.#indexed(root,io),resultLimit=Math.max(1,Math.min(200,Number(limit)||120));
    let candidates=[...index.files.values()].filter(entry=>(entry.parsed.references||new Map()).has(symbol)||(entry.parsed.definitions||[]).some(item=>item.name===symbol));
    if(path!=null&&String(path).trim()){
      const requested=contextIo.relativeFocus(path)||slash(String(path||"").replace(/^\.\//,"")),entry=index.files.get(requested);
      if(!entry)throw new Error(`Context file is not indexed: ${path}`);
      candidates=[entry];
    }
    candidates=candidates.slice(0,240);
    const contents=await contextIo.readMany(candidates.map(entry=>entry.relativePath)),data=[];let matchedFiles=0;
    for(const entry of candidates){
      const content=contents.get(entry.relativePath);if(typeof content!=="string")continue;
      let lines=[],precision="text";
      if(BABEL_SOURCE_EXTENSIONS.has(extname(entry.relativePath).toLowerCase())){try{lines=javascriptIdentifierLines(content,entry.relativePath,symbol);precision="ast"}catch{lines=textualIdentifierLines(content,symbol)}}
      else lines=textualIdentifierLines(content,symbol);
      if(!lines.length)continue;matchedFiles++;
      const sourceLines=content.split(/\r?\n/),definitionLines=new Set((entry.parsed.definitions||[]).filter(item=>item.name===symbol).map(item=>Number(item.line)));
      for(const line of lines){
        data.push({path:entry.relativePath,line,text:String(sourceLines[line-1]||"").slice(0,600),definition:definitionLines.has(line),parser:entry.parsed.parser||"regex",precision});
        if(data.length>=resultLimit)break;
      }
      if(data.length>=resultLimit)break;
    }
    return {name:symbol,path:path==null?null:String(path),data,indexedFiles:index.files.size,matchedFiles,truncated:data.length>=resultLimit};
  }

  async gitHistory({root,path="",limit=20,io=null}={}){
    const {contextIo,index}=await this.#indexed(root,io);if(typeof contextIo.gitHistory!=="function")throw new Error("Git history is unavailable for this workspace");
    let requested="";
    if(String(path||"").trim()){
      requested=contextIo.relativeFocus(path)||slash(String(path||"").replace(/^\.\//,""));
      if(!requested||requested.startsWith("../")||!new Set(index.paths).has(requested))throw new Error(`Context path is outside or unknown to the repository: ${path}`);
    }
    const capped=Math.max(1,Math.min(100,Number(limit)||20)),data=await contextIo.gitHistory({path:requested,limit:capped});
    return {path:requested||null,data:data.slice(0,capped),indexedFiles:index.files.size};
  }

  async gitBlame({root,path,startLine=1,endLine=null,maxLines=120,io=null}={}){
    const {contextIo,index}=await this.#indexed(root,io);if(typeof contextIo.gitBlame!=="function")throw new Error("Git blame is unavailable for this workspace");
    const requested=contextIo.relativeFocus(path)||slash(String(path||"").replace(/^\.\//,""));
    if(!index.files.has(requested))throw new Error(`Context file is not indexed: ${path}`);
    const start=Math.max(1,Math.trunc(Number(startLine)||1)),cap=Math.max(1,Math.min(200,Math.trunc(Number(maxLines)||120))),rows=await contextIo.gitBlame({path:requested,startLine:start,endLine,maxLines:cap});
    return {path:requested,startLine:start,endLine:rows.length?rows.at(-1).line:start-1,data:rows.slice(0,cap),indexedFiles:index.files.size};
  }

  async searchCode({root,query="",regex=false,caseSensitive=false,limit=80,io=null}={}){
    const needle=String(query||"");if(!needle.trim())throw new Error("Code search requires a query");
    if(needle.length>1000)throw new Error("Code search query is too long");
    let expression=null;
    if(regex){try{expression=new RegExp(needle,caseSensitive?"":"i")}catch(error){throw new Error("Invalid code search regular expression: "+error.message)}}
    const {contextIo,index}=await this.#indexed(root,io),resultLimit=Math.max(1,Math.min(200,Number(limit)||80)),candidateLimit=Math.max(40,Math.min(240,resultLimit*3));
    const foldedNeedle=caseSensitive?needle:needle.toLowerCase();
    const matchesLine=line=>regex?expression.test(line):(caseSensitive?line.includes(needle):line.toLowerCase().includes(foldedNeedle));
    let candidates=[],source="index-sample",complete=false;
    if(typeof contextIo.searchPaths==="function"){
      try{
        const found=await contextIo.searchPaths({query:needle,regex:Boolean(regex),caseSensitive:Boolean(caseSensitive),limit:candidateLimit+1});
        complete=found.length<=candidateLimit;candidates=found.slice(0,candidateLimit).filter(path=>index.files.has(path));source="git-grep";
      }catch{}
    }
    if(source!=="git-grep")candidates=[...index.files.values()].filter(entry=>String(entry.sample||"").split(/\r?\n/).some(matchesLine)).map(entry=>entry.relativePath).slice(0,candidateLimit);
    const contents=await contextIo.readMany(candidates),data=[];let matchedFiles=0;
    for(const path of candidates){
      const content=contents.get(path);if(typeof content!=="string")continue;
      const lines=content.split(/\r?\n/);let fileMatches=0;
      for(let lineIndex=0;lineIndex<lines.length;lineIndex++){
        if(!matchesLine(lines[lineIndex]))continue;
        if(fileMatches++===0)matchedFiles++;
        data.push({path,line:lineIndex+1,text:lines[lineIndex].slice(0,600)});
        if(fileMatches>=20||data.length>=resultLimit)break;
      }
      if(data.length>=resultLimit)break;
    }
    return {query:needle,regex:Boolean(regex),caseSensitive:Boolean(caseSensitive),data,indexedFiles:index.files.size,matchedFiles,source,complete:complete&&data.length<resultLimit,truncated:!complete||data.length>=resultLimit};
  }

  async readSourceRange({root,path,startLine=1,endLine=null,maxLines=200,io=null}={}){
    const {contextIo,index}=await this.#indexed(root,io),requested=contextIo.relativeFocus(path)||slash(String(path||"").replace(/^\.\//,""));
    if(!index.files.has(requested))throw new Error(`Context file is not indexed: ${path}`);
    const contents=await contextIo.readMany([requested]),content=contents.get(requested);if(typeof content!=="string")throw new Error(`Could not read context file: ${path}`);
    const lines=content.split(/\r?\n/),start=Math.max(1,Math.trunc(Number(startLine)||1)),lineCap=Math.max(1,Math.min(400,Math.trunc(Number(maxLines)||200)));
    if(start>Math.max(1,lines.length))throw new Error(`Source range starts after the end of ${requested}`);
    const requestedEnd=endLine==null?start+lineCap-1:Math.max(start,Math.trunc(Number(endLine)||start));let end=Math.min(lines.length,requestedEnd,start+lineCap-1);
    const selected=[];let chars=0,truncated=false;
    for(let line=start;line<=end;line++){
      const value=lines[line-1]??"",cost=value.length+(selected.length?1:0);
      if(chars+cost>32_000){truncated=true;break}
      selected.push(value);chars+=cost;
    }
    if(selected.length)end=start+selected.length-1;else end=start-1;
    if(end<Math.min(lines.length,requestedEnd))truncated=true;
    return {path:requested,startLine:start,endLine:end,totalLines:lines.length,content:selected.join("\n"),truncated};
  }

  async gitContext({root,io=null,maxStatusChars=12_000,maxDiffChars=16_000}={}){
    if(!root)throw new Error("Context Engine requires a workspace path");
    const contextIo=io||localContextIo(root),git=await contextIo.gitState();
    return {
      root:contextIo.root,isGit:Boolean(git?.isGit),head:git?.head||null,changed:[...(git?.changed||[])].slice(0,300),
      status:String(git?.status||"").slice(0,Math.max(0,Math.min(32_000,Number(maxStatusChars)||12_000))),
      diff:String(git?.diff||"").slice(0,Math.max(0,Math.min(64_000,Number(maxDiffChars)||16_000))),
    };
  }
}

export { pageRank, parseSource, taskTerms, tokenEstimate };
