import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { nativeRequestMetrics, NATIVE_PROMPT_PROVENANCE, NATIVE_TOOL_SCHEMA_FINGERPRINT } from "./native-request-metrics.mjs";
import { platformToolAllowedByAllowlist } from "./shared-tool-gateway.mjs";
import { nativeCommandSemanticError, normalizeNativeCommandArguments } from "./native-command-argv.mjs";
import { redactSecretText } from "./secret-redactor.mjs";
import { coolVirtualizedToolContent } from "./native-tool-history.mjs";
import { NATIVE_OPENAI_CONTINUATION_IDENTITY } from "./openai-response-continuation.mjs";
import { NATIVE_CHAT_MESSAGE_CACHE_IDENTITY } from "./provider-turn.mjs";

const NATIVE_TOOL_OBSERVATION_OUTPUT=Symbol("trebell.native.tool-observation-output");
const DIRECT_EXACT_READ_MAX_BYTES=12*1024;
const DIRECT_EXACT_LIST_MAX_BYTES=12*1024;
const DIRECT_GIT_STATUS_MAX_BYTES=12*1024;
const TERMINAL_TOOL_TIMEOUT_DEFAULT_MS=30_000;
const TERMINAL_TOOL_TIMEOUT_MAX_MS=300_000;
const TERMINAL_TOOL_WATCHDOG_ABORT_GRACE_MS=500;
const TERMINAL_TOOL_WATCHDOG_SETTLE_GRACE_MS=3_500;
const ACTION_TURN_MAX_OUTPUT_TOKENS=32_768;

function abortError(signal){
  const reason=signal?.reason;if(reason?.name==="AbortError")return reason;
  const error=new Error(reason instanceof Error?(reason.message||"Native agent turn was cancelled."):String(reason||"Native agent turn was cancelled."));error.name="AbortError";return error;
}

function toolCallMarkupOnly(value){
  const text=String(value||"").trim();
  return /^<tool_call>[^]*<[/]tool_call>$/i.test(text);
}
function throwIfAborted(signal){if(signal?.aborted)throw abortError(signal)}

function boundedInteger(value,fallback,{min=1,max=10_000}={}){
  const number=Math.trunc(Number(value));return Number.isFinite(number)?Math.max(min,Math.min(max,number)):fallback;
}

function outputLimitFinishReason(response={}){
  const finish=String(response?.finishReason||"").trim().toLowerCase(),incomplete=String(response?.raw?.incomplete_details?.reason||"").trim().toLowerCase();
  if(["max_output_tokens","max_tokens","length"].includes(incomplete))return incomplete;
  if(["max_output_tokens","max_tokens","length"].includes(finish))return finish;
  return finish==="incomplete"&&!incomplete?finish:null;
}

function safeArguments(value){
  if(value&&typeof value==="object"&&!Array.isArray(value))return value;
  try{const parsed=JSON.parse(String(value||"{}"));return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed:{}}
  catch{return {}}
}

function sha256Text(value){return createHash("sha256").update(String(value??""),"utf8").digest("hex")}

function terminalToolTimeoutMs(namespace,name,args={}){
  if(namespace!=="trebell_terminal"||name!=="run")return null;
  return boundedInteger(args.timeout_ms,TERMINAL_TOOL_TIMEOUT_DEFAULT_MS,{min:1000,max:TERMINAL_TOOL_TIMEOUT_MAX_MS});
}

export function nativeTerminalAuditMetadata(namespace,name,args={}){
  if(namespace!=="trebell_terminal"||name!=="run")return null;
  const normalized=normalizeNativeCommandArguments(args),command=String(normalized.command||"").trim(),argv=Array.isArray(normalized.args)?normalized.args.map(value=>String(value)):[],raw=[command,...argv].join(" ");
  const redacted=redactSecretText(raw,{redactHomes:true,trim:true}).slice(0,1200);
  const executable=String(command).split(/[\\/]/).pop()?.slice(0,120)||null;
  const urls=[...redacted.matchAll(/https?:\/\/[^\s'"<>]+/gi)].map(match=>match[0].slice(0,300));
  const hosts=[...new Set(urls.map(value=>{try{return new URL(value).hostname.toLowerCase()}catch{return null}}).filter(Boolean))].slice(0,20);
  const networkLike=/(?:^|\s)(?:curl|wget|git\s+(?:clone|fetch|pull)|npm\s+(?:install|i|view|info|pack)|pnpm\s+(?:install|add)|yarn\s+(?:add|install)|pip\d*\s+install|python\s+-m\s+pip\s+install|apt(?:-get)?\s+(?:install|update)|apk\s+add|brew\s+install|invoke-webrequest|irm|iwr)(?:\s|$)/i.test(redacted)||urls.length>0;
  const packageManager=/(?:^|\s)(?:npm|pnpm|yarn|pip\d*|apt|apt-get|apk|brew)(?:\s|$)/i.test(redacted);
  const sqlMutationLike=/\b(?:insert\s+into|update\s+[A-Za-z0-9_."`\[\]-]+\s+set|delete\s+from|merge\s+into|replace\s+into|truncate\s+table|alter\s+table|drop\s+(?:table|database|schema)|create\s+(?:table|database|schema))\b/i.test(raw);
  const remoteSqlClient=/(?:^|[\s"'])(?:psql|mysql|mariadb|sqlcmd)(?:[\s"']|$)/i.test(raw);
  const gatewayMarker=/\b(?:dbgw(?:\.py)?|database[_ -]?gateway|writeback)\b/i.test(raw);
  const gatewayWritebackLike=gatewayMarker&&/\b(?:writeback|SQL_EXEC|apply|commit)\b/i.test(raw)&&/\b(?:exec|apply|commit|write|SQL_EXEC)\b/i.test(raw);
  const remoteWriteCli=/(?:^|\s)(?:git\s+push|docker\s+push|npm\s+publish|pnpm\s+publish|kubectl\s+(?:apply|delete|replace|patch)|terraform\s+(?:apply|destroy)|gh\s+(?:pr\s+merge|release\s+create))(?:\s|$)/i.test(raw);
  const httpWriteCli=/(?:^|\s)(?:curl|invoke-webrequest|irm|iwr)\b[\s\S]{0,800}\b(?:-X|--request|Method)\s*[=:]?\s*(?:POST|PUT|PATCH|DELETE)\b/i.test(raw);
  const pythonHttpWrite=/\brequests\s*\.\s*(?:post|put|patch|delete)\s*\(|\burllib\.request\.Request\s*\([\s\S]{0,1200}?\bmethod\s*=\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i.test(raw);
  const nodeHttpWrite=/\bfetch\s*\([\s\S]{0,1200}?\bmethod\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i.test(raw);
  const httpWriteLike=httpWriteCli||pythonHttpWrite||nodeHttpWrite;
  const persistentMutationLike=remoteWriteCli||httpWriteLike||(sqlMutationLike&&(remoteSqlClient||gatewayMarker))||gatewayWritebackLike;
  const persistentMutationKind=remoteWriteCli?"remote_write_cli":httpWriteLike?"http_write":sqlMutationLike&&(remoteSqlClient||gatewayMarker)?"sql_write":gatewayWritebackLike?"gateway_writeback":null;
  return {executable,commandHash:createHash("sha256").update(redacted).digest("hex"),networkLike,packageManager,persistentMutationLike,persistentMutationKind,hosts,redactedCommand:redacted};
}

function providerVisibleTools(tools=[],toolAllowlist=null){
  if(!Array.isArray(toolAllowlist)||!toolAllowlist.length)return tools;
  const visible=[];
  for(const entry of Array.isArray(tools)?tools:[]){
    if(entry?.type==="namespace"&&entry.name&&Array.isArray(entry.tools)){
      const allowed=entry.tools.filter(tool=>platformToolAllowedByAllowlist(entry.name,tool?.name,toolAllowlist));
      if(allowed.length)visible.push({...entry,tools:allowed});
      continue;
    }
    if(entry?.type==="function"){
      const name=entry.function?.name||entry.name;if(name&&platformToolAllowedByAllowlist("",name,toolAllowlist))visible.push(entry);
    }
  }
  return visible;
}

function obviousToolNameCorruption(value){
  const name=String(value||"");
  return /[<>]|arg_(?:key|value)|(?:^|\W)(?:tool|function)_?(?:name|call)(?:\W|$)/i.test(name);
}

function exposedToolPairs(tools=[]){
  const out=[];
  for(const entry of Array.isArray(tools)?tools:[]){
    if(entry?.type==="namespace"&&entry.name&&Array.isArray(entry.tools)){
      for(const tool of entry.tools){
        const name=String(tool?.name||"").trim();if(name)out.push({namespace:String(entry.name),name});
      }
    }else if(entry?.type==="function"){
      const name=String(entry.function?.name||entry.name||"").trim();if(name)out.push({namespace:"",name});
    }
  }
  return out;
}

function protocolAliasMatches(namespace,name,tools=[],exposedPairs=null){
  const rawNamespace=String(namespace||"").trim(),rawName=String(name||"").trim();if(!rawName)return [];
  const pairs=Array.isArray(exposedPairs)?exposedPairs:exposedToolPairs(tools),namespaceExists=rawNamespace&&pairs.some(item=>item.namespace===rawNamespace);
  return pairs.filter(item=>{
    if(namespaceExists&&item.namespace!==rawNamespace)return false;
    const aliases=new Set([
      item.namespace?item.namespace+"__"+item.name:item.name,
      item.namespace?item.namespace+"_"+item.name:item.name,
      item.namespace?item.namespace+"."+item.name:item.name,
      item.namespace?item.namespace+"/"+item.name:item.name,
      ...(item.namespace.startsWith("trebell_")?["trebell_"+item.name]:[]),
    ]);
    return aliases.has(rawName);
  });
}

function misplacedToolMatches(namespace,name,tools=[],exposedPairs=null){
  const rawNamespace=String(namespace||"").trim(),rawName=String(name||"").trim(),pairs=Array.isArray(exposedPairs)?exposedPairs:exposedToolPairs(tools);
  if(!rawNamespace.startsWith("trebell_")||!rawName||!pairs.some(item=>item.namespace===rawNamespace))return [];
  if(pairs.some(item=>item.namespace===rawNamespace&&item.name===rawName))return [];
  return pairs.filter(item=>item.namespace.startsWith("trebell_")&&item.name===rawName);
}

function repairCorruptedToolCall(call,tools=[],exposedPairs=null){
  const namespace=String(call?.namespace||"").trim(),name=String(call?.name||"").trim();
  if(!name)return {call,repaired:false};
  const aliasMatches=protocolAliasMatches(namespace,name,tools,exposedPairs);
  if(aliasMatches.length===1){
    const target=aliasMatches[0];
    if(target.namespace!==namespace||target.name!==name)return {call:{...call,namespace:target.namespace||null,name:target.name},repaired:true,originalName:name,reason:"protocol_alias"};
  }
  const misplacedMatches=misplacedToolMatches(namespace,name,tools,exposedPairs);
  if(misplacedMatches.length===1){
    const target=misplacedMatches[0];
    return {call:{...call,namespace:target.namespace||null,name:target.name},repaired:true,originalName:name,reason:"unique_tool_namespace"};
  }
  if(!namespace||!obviousToolNameCorruption(name))return {call,repaired:false};
  const entry=(Array.isArray(tools)?tools:[]).find(item=>item?.type==="namespace"&&String(item.name||"")===namespace);
  const exposed=(Array.isArray(entry?.tools)?entry.tools:[]).filter(item=>String(item?.name||"").trim());
  if(exposed.some(item=>String(item.name)===name)||exposed.length!==1)return {call,repaired:false};
  return {call:{...call,name:String(exposed[0].name)},repaired:true,originalName:name,reason:"single_tool_corruption"};
}

function sameStringArray(left,right){
  if(!Array.isArray(left)||!Array.isArray(right)||left.length!==right.length)return false;
  return left.every((value,index)=>String(value)===String(right[index]));
}

function repairRepeatedTerminalCommand(call,successfulTerminalRuns=[]){
  if(call?.namespace!=="trebell_terminal"||call?.name!=="run")return {call,repaired:false};
  const args=safeArguments(call?.arguments),command=String(args.command||"").trim();
  if(command||!Array.isArray(args.args)||!args.args.length)return {call,repaired:false};
  const cwd=String(args.cwd??"");
  const commands=[...new Set((Array.isArray(successfulTerminalRuns)?successfulTerminalRuns:[])
    .filter(item=>String(item?.cwd??"")===cwd&&sameStringArray(item?.args,args.args))
    .map(item=>String(item?.command||"").trim()).filter(Boolean))];
  if(commands.length!==1)return {call,repaired:false};
  const repairedArgs={...args,command:commands[0]},serialized=typeof call.arguments==="string"?JSON.stringify(repairedArgs):repairedArgs;
  return {call:{...call,arguments:serialized},repaired:true,command:commands[0],reason:"repeated_terminal_command"};
}

function messageText(message){
  const provenance=message&&typeof message==="object"?message[NATIVE_PROMPT_PROVENANCE]:null;
  if(Array.isArray(provenance?.userParts))return provenance.userParts.map(value=>String(value||"")).filter(Boolean).join("\n");
  const content=message?.content;
  if(typeof content==="string")return content;
  if(!Array.isArray(content))return "";
  return content.map(part=>typeof part==="string"?part:typeof part?.text==="string"?part.text:"").filter(Boolean).join("\n");
}

function lastUserInstructionText(message){
  const provenance=message&&typeof message==="object"?message[NATIVE_PROMPT_PROVENANCE]:null;
  if(Array.isArray(provenance?.userParts)){
    const parts=provenance.userParts.map(value=>String(value||"").trim()).filter(Boolean);
    if(parts.length)return parts.at(-1);
  }
  return messageText(message);
}

function latestUserMessage(messages=[]){
  const source=Array.isArray(messages)?messages:[];
  for(let index=source.length-1;index>=0;index--)if(source[index]?.role==="user")return source[index];
  return null;
}

function requestsTaskMutation(messages=[]){
  const text=lastUserInstructionText(latestUserMessage(messages)).trim();
  if(!text)return false;
  const explicitlyReadOnly=/(?:do\s+not|don't|dont|never)\s+(?:edit|change|modify|write|update)(?=\s*(?:[.!?;\n]|$))/i.test(text)
    ||/(?:do\s+not|don't|dont|never)\s+(?:edit|change|modify|write|update)\s+(?:anything|any\s+(?:files?|code)|(?:all\s+)?files?|code|(?:the|this)\s+(?:workspace|repository|repo|project|codebase))\b/i.test(text)
    ||/without\s+(?:editing|changing|modifying|writing|updating)(?=\s*(?:anything|any\s+(?:files?|code)|(?:the|this)\s+(?:workspace|repository|repo|project|codebase)|[.!?;\n]|$))/i.test(text)
    ||/\b(?:task|request|workspace|repository|repo|project|codebase|work)\s+(?:is\s+|must\s+(?:remain|be)\s+|should\s+(?:remain|be)\s+)?read[- ]only\b/i.test(text)
    ||/\b(?:make|perform|apply)\s+no\s+(?:code\s+)?changes?\b/i.test(text)
    ||/\bno\s+(?:code\s+)?changes?\s+(?:to|in)\s+(?:the\s+)?(?:workspace|repository|repo|project|codebase)\b/i.test(text);
  if(explicitlyReadOnly)return false;
  const mutationPattern=/\b(?:implement|fix|repair|restore|reconstruct|recreate|rebuild|remediate|add|create|update|change|modify|refactor|remove|delete|rename|migrate|write|edit|replace|convert|consolidate|port|upgrade|downgrade)\b/ig;
  for(const match of text.matchAll(mutationPattern)){
    const prefix=text.slice(Math.max(0,Number(match.index||0)-56),Number(match.index||0));
    if(!/(?:do\s+not|don't|dont|never|without)(?:\s+\w+){0,2}\s*$/i.test(prefix))return true;
  }
  const reportArtifact=/\b(?:report|record|return|provide)\b[\s\S]{0,140}\b(?:in|to|as|at)\s+(?:an?\s+)?(?:file|artifact|output)\b/i.test(text)
    ||/\b(?:report|record|return|provide)\b[\s\S]{0,160}\b(?:file\s+named|file\s+at|output\s+path|artifact\s+at)\b/i.test(text);
  if(reportArtifact&&!/(?:do\s+not|don't|dont|never)\s+(?:report|record|return|provide)\b/i.test(text))return true;
  if(/^\s*(?:please\s+)?(?:optimi[sz]e|speed\s+up|accelerate|streamline|harden)\b/i.test(text))return true;
  if(/^\s*(?:please\s+)?improve\b[\s\S]{0,160}\b(?:performance|responsiveness|latency|throughput|efficiency|app|application|service|system|project|repository|repo|codebase|implementation|code)\b/i.test(text))return true;
  const diagnosticOnly=/\b(?:inspect|explain|analy[sz]e|diagnose|investigate|review|report|identify|find)\b[\s\S]{0,120}\b(?:why|cause|root cause|problem|issue|bug|failure|behavior|behaviour)\b/i.test(text)
    ||/\b(?:why|how|what)\b[\s\S]{0,120}\b(?:broken|failing|fails|not working|incorrect|wrong)\b/i.test(text);
  if(diagnosticOnly)return false;
  return /\b(?:not\s+working(?:\s+(?:correctly|properly))?|broken|buggy|malfunction(?:ing|s)?|incorrect(?:ly)?|wrong\s+results?|fails?\b|failing\b|regression\b)\b/i.test(text);
}

function requestsDerivedQuantitativeCalculation(messages=[]){
  const text=lastUserInstructionText(latestUserMessage(messages)).trim();
  if(!text)return false;
  const calculate=/\b(?:determin(?:e|ing)|calculat(?:e|ion|ing)|comput(?:e|ation|ing)|deriv(?:e|ation|ing)|estimat(?:e|ion|ing)|quantif(?:y|ication|ying))\b/i.test(text);
  if(!calculate)return false;
  const evidenceSource=/\b(?:data|measurement(?:s)?|table(?:s)?|spreadsheet|csv|xlsx?|pdf|reference|standard|sample|observ(?:ation|ed)|count(?:s| rate)?|input(?:s)?)\b/i.test(text);
  const numericContract=/\b(?:unit(?:s)?|factor|efficien(?:cy|cies)|limit|concentration|rate|ratio|percentage|percent|uncertaint(?:y|ies)|tolerance|significant\s+figures?|rounded?|numeric(?:al)?|value(?:s)?|metric(?:s)?)\b/i.test(text)
    ||/\b[A-Za-z]+\s*\/\s*[A-Za-z]+\b/.test(text);
  return evidenceSource&&numericContract;
}

function requestsWorkspaceMutation(messages=[]){
  const text=lastUserInstructionText(latestUserMessage(messages)).trim();
  if(!text||!requestsTaskMutation(messages))return false;
  if(requestsExternalStateMutation(messages))return false;
  const workspaceTarget=/\b(?:workspace|repository|repo|codebase|source|code|implementation|project|package|module|library|app(?:lication)?|service|script|file|folder|directory|path|function|class|method|component|frontend|backend|test(?:s| suite)?|config(?:uration)?\s+file)\b/i.test(text);
  const filePattern=/(?:^|[\s\x60"'(])((?:\.?\.?[\\/])?[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*\.[A-Za-z0-9_-]{1,16})(?=$|[\s\x60"'),;:.!?])/ig;
  const fileTarget=[...text.matchAll(filePattern)].some(match=>!String(match[1]||"").replace(/\\/g,"/").startsWith("/"));
  if(workspaceTarget||fileTarget)return true;
  const externalOnly=/\b(?:campaign|live\s+config(?:uration)?|remote\s+(?:state|system|host|service)|runtime\s+state|api\s+(?:endpoint|state|resource)|database\s+(?:row|record|state)|cluster\s+state|account\s+setting)\b/i.test(text);
  return !externalOnly;
}

function requestsExternalStateMutation(messages=[]){
  const text=lastUserInstructionText(latestUserMessage(messages)).trim();
  if(!text||!requestsTaskMutation(messages))return false;
  const externalTarget=/\b(?:campaign|live\s+config(?:uration)?|remote\s+(?:state|system|host|service)|runtime\s+state|api\s+(?:endpoint|state|resource)|database\s+(?:row|record|state)|cluster\s+state|account\s+setting)\b/i.test(text)
    ||/\b(?:through|via|using)\s+(?:its|the|an?)\s+api\b/i.test(text);
  if(!externalTarget)return false;
  const mutationVerb="(?:implement|fix|repair|restore|reconstruct|recreate|rebuild|remediate|add|create|update|change|modify|refactor|remove|delete|rename|migrate|write|edit|replace|convert|consolidate|port|upgrade|downgrade)";
  const workspaceNoun="(?:workspace|repository|repo|codebase|source(?:\\s+code)?|code|implementation|project|package|module|library|script|files?|folders?|director(?:y|ies)|function|class|method|component|frontend|backend|tests?|config(?:uration)?\\s+file)";
  const explicitWorkspaceTarget=new RegExp(
    `\\b${mutationVerb}\\b[\\s\\S]{0,100}\\b${workspaceNoun}\\b|\\b${workspaceNoun}\\b[\\s\\S]{0,100}\\b${mutationVerb}\\b`,
    "i",
  );
  return !explicitWorkspaceTarget.test(text);
}

function requestsConstraintPlanning(messages=[]){
  const text=lastUserInstructionText(latestUserMessage(messages)).trim();
  if(!text)return false;
  const planning=/\b(?:plan(?:ning|ned)?|schedul(?:e|er|ing)|allocat(?:e|ion|or)|dispatch(?:ing)?|assign(?:ment|ing)?|routing|pack(?:ing)?|solver|optimi[sz](?:e|ation))\b/i.test(text);
  const constraints=/\b(?:constraint|feasib(?:le|ility)|capacity|priority|objective|deadline|due\s+date|inventory|resource|shift|downtime|changeover|coverage|quota|minimum|maximum|optimal|best\s+(?:plan|schedule|allocation|assignment)|hard\s+limit)\b/i.test(text);
  return planning&&constraints;
}

function explicitPersistentArtifactTargets(messages=[]){
  const text=lastUserInstructionText(latestUserMessage(messages)).trim();
  if(!text)return [];
  const targets=[];
  for(const match of text.matchAll(/\breport(?:s|ed|ing)?\b[\s\S]{0,140}?\b(?:in|to|into|as)\s+(?:(?:a|the)\s+)?(?:file|artifact)(?:\s+(?:named|called))?\s+[`"']?([A-Za-z0-9_./\\-]+\.[A-Za-z0-9_-]{1,16})[`"']?/ig)){
    const target=String(match[1]||"").trim();
    if(target&&!targets.includes(target))targets.push(target);
  }
  const tokens=text.split(/\s+/).map(value=>value.replace(/^[\x60"'(]+|[\x60"'),;:.!?]+$/g,"")).filter(Boolean);
  for(let index=0;index<tokens.length;index++){
    const token=tokens[index];
    if(!/[.][A-Za-z0-9_-]{1,16}$/.test(token))continue;
    const before=tokens.slice(Math.max(0,index-10),index).join(" "),near=tokens.slice(Math.max(0,index-4),index).join(" "),previous=String(tokens[index-1]||"").toLowerCase();
    const action=/\b(?:creat(?:e|es|ed|ing)|generat(?:e|es|ed|ing)|produc(?:e|es|ed|ing)|render(?:s|ed|ing)?|export(?:s|ed|ing)?|sav(?:e|es|ed|ing)|writ(?:e|es|ten|ing)|output(?:s|ted|ting)?|emit(?:s|ted|ting)?|plac(?:e|es|ed|ing)|deliver(?:s|ed|ing)?|report(?:s|ed|ing)?|build(?:s|ing)?|built|mak(?:e|es|ing)|made|stor(?:e|es|ed|ing)|leav(?:e|es|ing)|left)\b/i;
    const sourceTail=/(?:from|using|via|based\s+on|read|inspect|load|open)\b(?:\s+\w+){0,4}$/i.test(before);
    const outputConnector=/^(?:to|as|at|into|in)$/i.test(previous),outputNoun=/\b(?:output|result|artifact|deliverable|submission|files?|final)\b/i.test(before);
    if(sourceTail||!(action.test(near)||(action.test(before)&&(outputConnector||outputNoun))))continue;
    if(/(?:do\s+not|don't|dont|never|without)\s+(?:create|generate|produce|render|export|save|write|output|emit|place|deliver|report|build|make|store|leave)\b/i.test(before))continue;
    if(!targets.includes(token))targets.push(token);
  }
  return targets;
}

function implementationPressureEditCall(call={}){
  return call?.namespace==="trebell_workspace"&&["write_file","replace_text"].includes(String(call?.name||""));
}

function implementationPressureBatchCall(call={}){
  if(call?.namespace!=="trebell_terminal"||call?.name!=="run")return false;
  const args=safeArguments(call?.arguments),command=String(args.command||"").replace(/^.*[\\/]/,"").toLowerCase(),argv=Array.isArray(args.args)?args.args.map(value=>String(value)):[];
  let script="";
  if(["bash","sh","zsh","fish"].includes(command)){
    const index=argv.findIndex(value=>/^-.*c.*$/.test(value));if(index>=0)script=String(argv[index+1]||"");
  }else if(["python","python3","node"].includes(command)){
    const flag=command.startsWith("python")?"-c":"-e",index=argv.indexOf(flag);if(index>=0)script=String(argv[index+1]||"");
  }else if(["powershell","powershell.exe","pwsh","pwsh.exe"].includes(command)){
    const index=argv.findIndex(value=>/^(?:-command|-c)$/i.test(value));if(index>=0)script=String(argv[index+1]||"");
  }
  if(script.length<40)return false;
  if(/\b(?:for|while|foreach|xargs|parallel|subprocess|promise\.all|forEach)\b/i.test(script))return true;
  const substantive=script.split(/(?:\r?\n|;|&&|\|\|)/).map(value=>value.trim()).filter(Boolean).filter(statement=>
    !/^(?:cd\b|pushd\b|popd\b|export\b|set(?:\s+-[a-z]+)?\b|source\b|\.\s+|[A-Za-z_][A-Za-z0-9_]*\s*=)/i.test(statement)
  );
  return substantive.length>=2;
}

function evidenceProbeCall(call={}){
  const key=String(call?.namespace||"")+"/"+String(call?.name||"");
  if(key==="trebell_terminal/run")return nativeTerminalAuditMetadata(call?.namespace,call?.name,safeArguments(call?.arguments))?.persistentMutationLike!==true;
  return key==="trebell_workspace/read_file"
    ||key==="trebell_workspace/list"
    ||key==="trebell_repo/search_files"
    ||key==="trebell_output/inspect";
}

function externalObservationCall(call={}){
  const key=String(call?.namespace||"")+"/"+String(call?.name||"");
  if(key==="trebell_process/status")return true;
  if(key!=="trebell_terminal/run")return false;
  const audit=nativeTerminalAuditMetadata(call?.namespace,call?.name,safeArguments(call?.arguments));
  return audit?.networkLike===true&&audit?.persistentMutationLike!==true;
}

function consolidatedExternalWaitCall(call={}){
  if(call?.namespace!=="trebell_terminal"||call?.name!=="run")return false;
  const audit=nativeTerminalAuditMetadata(call?.namespace,call?.name,safeArguments(call?.arguments)),command=String(audit?.redactedCommand||"");
  if(!audit?.networkLike||audit?.persistentMutationLike===true||!command)return false;
  return /\b(?:sleep|timeout)\s+\d|\btime\.sleep\s*\(|\bsetTimeout\s*\(|\bwhile\b[\s\S]{0,500}\b(?:sleep|time\.sleep|setTimeout)\b|\bfor\b[\s\S]{0,500}\b(?:sleep|time\.sleep|setTimeout)\b/i.test(command);
}

function escapeRegex(value){return String(value||"").replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}

function explicitlyRequestedTools(messages=[],tools=[]){
  const user=latestUserMessage(messages),text=messageText(user);
  if(!text)return [];
  const requested=[];
  for(const namespace of Array.isArray(tools)?tools:[]){
    const ns=String(namespace?.name||"").trim();if(namespace?.type!=="namespace"||!ns)continue;
    for(const tool of Array.isArray(namespace.tools)?namespace.tools:[]){
      const name=String(tool?.name||"").trim();if(!name)continue;
      const pattern=new RegExp(`\\b(?:call|use|invoke)\\s+(?:the\\s+)?${escapeRegex(ns)}[./]${escapeRegex(name)}\\b`,"ig");
      let match;
      while((match=pattern.exec(text))){
        const prefix=text.slice(Math.max(0,match.index-24),match.index);
        if(/(?:do\s+not|don't|never)\s*$/i.test(prefix))continue;
        requested.push({namespace:ns,name});break;
      }
    }
  }
  return requested;
}

function explicitFinalAnswerAfterVerification(messages=[]){
  const user=latestUserMessage(messages),text=messageText(user);
  if(!text)return null;
  const match=text.match(/\b(?:after|once|when)\b\s*([^.\n]{1,220}?)\s+\b(?:pass(?:es|ed|ing)?|succeed(?:s|ed)?|successful)\b[^.\n]{0,220}\b(?:answer|respond|reply|summari[sz](?:e|ing|ation)?|summary)\b/i);
  if(!match)return null;
  const target=String(match[1]||"").trim();if(!target)return null;
  return {target:/^(?:it|this|that|them|the|a|an)$/i.test(target)?null:target};
}

function explicitSummaryAfterVerification(messages=[]){
  const user=latestUserMessage(messages),text=messageText(user);
  if(!text)return false;
  return /\b(?:after|once|when)\b[^.\n]{0,220}\b(?:pass(?:es|ed|ing)?|succeed(?:s|ed)?|successful)\b[^.\n]{0,220}\b(?:(?:concise|brief|short)\s+summary|summari[sz]e\s+(?:briefly|concisely)|(?:briefly|concisely)\s+summari[sz]e)\b/i.test(text);
}

function explicitLiteralAfterVerification(messages=[]){
  const user=latestUserMessage(messages),text=lastUserInstructionText(user);
  if(!text)return null;
  const prefix="\\b(?:after|once|when)\\b[^.\\n]{0,220}\\b(?:pass(?:es|ed|ing)?|succeed(?:s|ed)?|successful)\\b[^.\\n]{0,220}\\b(?:answer|respond|reply)\\s+(?:with\\s+)?exactly\\s+";
  const quoted=text.match(new RegExp(prefix+"([\\\"'`])([^\\r\\n]{1,160})\\1\\s*[.!]?\\s*$","i"));
  if(quoted)return quoted[2];
  const token=text.match(new RegExp(prefix+"([A-Za-z0-9][A-Za-z0-9_.:/-]{0,79})\\s*[.!]?\\s*$","i"));
  return token?token[1]:null;
}

function explicitVerificationCompletion(messages=[]){
  const user=latestUserMessage(messages),text=lastUserInstructionText(user);
  if(!text)return null;
  const explicit=text.match(/\b(?:re-?run|keep\s+re-?running)\b\s+([^\n]{1,180}?)\s+\buntil\b[^\n]{0,80}\bpass(?:es|ed|ing)?\b\s*[.!]?\s*$/i);
  if(explicit){
    const target=String(explicit[1]||"").trim(),prefix=text.slice(Math.max(0,Number(explicit.index||0)-48),Number(explicit.index||0));
    if(!/^(?:it|this|that|them|again)$/i.test(target)&&!/\b(?:do\s+not|don't|never)(?:\s+\w+){0,2}\s*$/i.test(prefix))return {target,implicit:false};
  }
  const implicit=text.match(/\b(?:re-?run|keep\s+re-?running)(?:\s+(?:it|this|that|them|again))?\s+\buntil\b[^\n]{0,80}\bpass(?:es|ed|ing)?\b\s*[.!]?\s*$/i);
  if(!implicit)return null;
  const prefix=text.slice(Math.max(0,Number(implicit.index||0)-48),Number(implicit.index||0));
  if(/\b(?:do\s+not|don't|never)(?:\s+\w+){0,2}\s*$/i.test(prefix))return null;
  const prior=text.slice(0,Number(implicit.index||0));
  const references=[...prior.matchAll(/\b(?:run|verification|verifier|tests?|checks?|lint|typecheck)\b/ig)],reference=references.at(-1);
  if(!reference||prior.length-Number(reference.index||0)>400)return null;
  const referencePrefix=prior.slice(Math.max(0,Number(reference.index||0)-32),Number(reference.index||0));
  if(/\b(?:do\s+not|don't|never)(?:\s+\w+){0,2}\s*$/i.test(referencePrefix))return null;
  return {target:null,implicit:true};
}

function explicitTerminalStatusRequest(messages=[]){
  const user=latestUserMessage(messages),text=lastUserInstructionText(user);
  if(!text||/\buntil\b[^\n]{0,100}\bpass(?:es|ed|ing)?\b/i.test(text))return false;
  const runs=[...text.matchAll(/\b(?:run|execute)\b/ig)];if(runs.length!==1)return false;
  const beforeRun=text.slice(0,Number(runs[0].index||0));
  if(/\b(?:read|inspect|open|search|list|edit|change|modify|write|create|delete|browse)\b/i.test(beforeRun))return false;
  if(/\b(?:and|then|also|afterward|after\s+that)\s+(?:read|inspect|open|search|list|edit|change|modify|write|create|delete|commit|push|browse)\b/i.test(text))return false;
  const positive=text.split(/[.!?\n]+/).filter(part=>!/\b(?:do\s+not|don't|never)\b/i.test(part)).join(" ");
  if(/\b(?:diagnos(?:e|is)|fix|repair|debug|explain|analy[sz]e|investigate|root\s+cause|recommend|suggest|compare|summari[sz]e|next\s+steps?)\b/i.test(positive))return false;
  if(/\b(?:report|show)\s+(?:me\s+)?(?:the\s+)?(?:result|status|outcome)\b/i.test(text))return true;
  if(/\b(?:tell|let)\s+me\s+(?:know\s+)?(?:whether|if)\b[^\n]{0,100}\b(?:pass|fail|succeed|work)/i.test(text))return true;
  return /\b(?:do\s+not|don't|never)\b[^.\n]{0,120}\b(?:read|edit|change|modify)\b/i.test(text)&&/\b(?:inspect|use)\b[^.\n]{0,140}\b(?:command|terminal)\b[^.\n]{0,80}\b(?:evidence|output|result)\b/i.test(text);
}

const DIRECT_STATUS_NATURAL_COMMANDS=new Set(["a","an","the","it","this","that","test","tests","verification","verifier","check","checks","command","script","project","app","application"]);
const DIRECT_STATUS_SHELLS=new Set(["sh","bash","zsh","fish","cmd","cmd.exe","powershell","powershell.exe","pwsh","pwsh.exe"]);
function explicitDirectStatusCwd(value){
  let cwd=String(value||"").trim();
  const quoted=cwd.match(/^(?:`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)')$/),wasQuoted=Boolean(quoted);if(quoted)cwd=String(quoted[1]||quoted[2]||quoted[3]||"").trim();
  if(!cwd||cwd.length>240||/[\r\n\0]/.test(cwd)||/^[\\/]/.test(cwd)||/^[A-Za-z]:[\\/]/.test(cwd)||/:\/\//.test(cwd))return null;
  const explicitDotRelative=/^\.([\\/])/.test(cwd),explicitTrailingSlash=/[\\/]$/.test(cwd);
  if(/\s/.test(cwd))return null;
  const normalized=cwd.replace(/\\/g,"/").replace(/^\.\/+/,"").replace(/\/+$/,"");if(!normalized)return null;
  if(!wasQuoted&&!explicitDotRelative&&!explicitTrailingSlash&&!normalized.includes("/"))return null;
  const parts=normalized.split("/");
  if(parts.some(part=>!part||part===".."||part==="."))return null;
  if(parts.some(part=>!/^[A-Za-z0-9._@+-]+$/.test(part)))return null;
  return normalized;
}
function directVerifierCommand(value,{cwd=null}={}){
  let raw=String(value||"").trim();
  const quoted=raw.match(/^`([^`\n]{1,300})`$/);if(quoted)raw=String(quoted[1]||"").trim();
  raw=raw.replace(/\s+(?:now|please)\s*$/i,"").trim();if(!raw||raw.length>300)return null;
  if(/\s+(?:in|from|inside|within)\s+/i.test(raw))return null;
  const normalized=normalizeNativeCommandArguments({command:raw,...(cwd?{cwd}:{})});if(nativeCommandSemanticError(normalized))return null;
  const command=String(normalized.command||"").trim(),args=Array.isArray(normalized.args)?normalized.args.map(value=>String(value)):[];if(!command||/\s/.test(command)||args.length>48)return null;
  const executable=command.replace(/^.*[\\/]/,"").toLowerCase();if(DIRECT_STATUS_NATURAL_COMMANDS.has(executable)||DIRECT_STATUS_SHELLS.has(executable))return null;
  if(args.some(arg=>/^(?:-e|-c|--eval|--execute|--command|-command|-encodedcommand)$/i.test(String(arg))))return null;
  const direct={command,args,...(cwd?{cwd}:{})};return terminalRunLooksLikeVerifier(direct)?direct:null;
}
function directVerifierCommandWithOptionalCwd(value){
  let raw=String(value||"").trim(),cwd=null;
  const cwdSuffix=raw.match(/^(.+?)\s+(?:in|from|inside|within)\s+((?:`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+))$/i);
  if(cwdSuffix){cwd=explicitDirectStatusCwd(cwdSuffix[2]);if(!cwd)return null;raw=String(cwdSuffix[1]||"").trim()}
  else if(/\s+(?:in|from|inside|within)\s+/i.test(raw))return null;
  return directVerifierCommand(raw,{cwd});
}
function explicitTerminalStatusCommand(messages=[]){
  if(!explicitTerminalStatusRequest(messages))return null;
  const user=latestUserMessage(messages),text=lastUserInstructionText(user),run=[...text.matchAll(/\b(?:run|execute)\b/ig)][0];
  if(!run)return null;
  const before=text.slice(0,Number(run.index||0)).trim();let cwd=null;
  if(before&&!/^(?:(?:please|kindly)|(?:can|could|would|will)\s+you)[,:]?$/i.test(before)){
    const cwdPrefix=before.match(/^(?:please\s+|kindly\s+)?(?:in|from|inside|within)\s+(.+?)[,:]?$/i);cwd=cwdPrefix?explicitDirectStatusCwd(cwdPrefix[1]):null;if(!cwd)return null;
  }
  let tail=text.slice(Number(run.index||0)+String(run[0]||"").length).trim(),raw="";
  tail=tail.replace(/^(?:the\s+command|command)\s+/i,"");
  const quoted=tail.match(/^`([^`\n]{1,300})`/);
  if(quoted){raw=String(quoted[1]||"").trim();tail=tail.slice(quoted[0].length).trim()}
  else{
    const sentenceEnd=tail.search(/[!?](?=\s|$)|\.(?=\s|$)/),sentence=sentenceEnd>=0?tail.slice(0,sentenceEnd):tail;
    const statusBoundary=sentence.search(/\s+(?:and\s+)?(?:report|show|tell|let)\b/i),nowBoundary=sentence.search(/\s+now\s*$/i),end=[statusBoundary,nowBoundary].filter(index=>index>=0).reduce((min,index)=>Math.min(min,index),sentence.length);
    raw=sentence.slice(0,end).replace(/[,:]\s*$/g,"").trim();tail=sentenceEnd>=0?tail.slice(sentenceEnd+1).trim():sentence.slice(end).trim();
  }
  const remainder=tail.split(/[.!?\n]+/).map(part=>part.trim()).filter(Boolean);
  for(const clause of remainder){
    if(/\b(?:do\s+not|don't|never)\b/i.test(clause))continue;
    if(/^(?:and\s+)?(?:report|show)\b[^\n]{0,160}\b(?:result|status|outcome)\b/i.test(clause))continue;
    if(/^(?:and\s+)?(?:tell|let)\b[^\n]{0,180}\b(?:pass|fail|succeed|work)/i.test(clause))continue;
    if(/^inspect\s+only\b[^\n]{0,180}\b(?:command|terminal)\b[^\n]{0,100}\b(?:evidence|output|result)\b/i.test(clause))continue;
    return null;
  }
  raw=raw.replace(/\s+(?:now|please)\s*$/i,"").trim();if(!raw||raw.length>300)return null;
  const cwdSuffix=raw.match(/^(.+?)\s+(?:in|from|inside|within)\s+((?:`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+))$/i);
  if(cwdSuffix){if(cwd)return null;cwd=explicitDirectStatusCwd(cwdSuffix[2]);if(!cwd)return null;raw=String(cwdSuffix[1]||"").trim()}
  else if(/\s+(?:in|from|inside|within)\s+/i.test(raw))return null;
  return directVerifierCommand(raw,{cwd});
}

function exactReplacementToken(value,{allowEmpty=false}={}){
  const raw=String(value??"").trim();if(!raw)return allowEmpty?"":null;
  const quote=raw[0];
  if(["`","\"","'"].includes(quote)){
    if(raw.length<2||raw.at(-1)!==quote)return null;
    const inner=raw.slice(1,-1);if(/[\r\n]/.test(inner)||(!inner&&!allowEmpty)||inner.length>300)return null;return inner;
  }
  if(/\s/.test(raw)||raw.length>300)return null;
  return raw;
}

function explicitWorkspaceRelativeFile(value){
  const path=exactReplacementToken(value);if(path==null||path.length>300||/[\r\n\0]/.test(path))return null;
  if(/^[\\/]/.test(path)||/^[A-Za-z]:/.test(path)||/:\/\//.test(path))return null;
  const normalized=path.replace(/\\/g,"/"),parts=normalized.split("/");
  if(parts.some(part=>!part||part==="."||part===".."))return null;
  return normalized;
}

function explicitWorkspaceRelativeDirectory(value){
  const path=exactReplacementToken(value);if(path==null||path.length>300||/[\r\n\0]/.test(path))return null;
  if(path===".")return ".";
  if(/^[\\/]/.test(path)||/^[A-Za-z]:/.test(path)||/:\/\//.test(path))return null;
  const normalized=path.replace(/\\/g,"/").replace(/\/+$/g,"");if(!normalized)return null;
  const parts=normalized.split("/");if(parts.some(part=>!part||part==="."||part===".."))return null;
  return normalized;
}

function explicitImmediateWorkspaceListStatus(messages=[]){
  const user=latestUserMessage(messages),text=lastUserInstructionText(user).trim();if(!text||/[\r\n]/.test(text))return null;
  const noun="(?:files?(?:\\s+(?:and|or)\\s+folders?)?|folders?(?:\\s+(?:and|or)\\s+files?)?|entries)",literal="(`[^`\\n]+`|\"[^\"\\n]+\"|'[^'\\n]+'|\\S+?)";
  const root=text.match(new RegExp("^(?:please\\s+)?(?:list|show(?:\\s+me)?)\\s+(?:the\\s+)?(?:top-level|immediate)\\s+"+noun+"\\s+(?:in|inside)\\s+(?:the\\s+)?workspace(?:\\s+root)?\\s*[.!]?$","i"));
  if(root)return {path:"."};
  const prefixed=text.match(new RegExp("^(?:please\\s+)?(?:list|show(?:\\s+me)?)\\s+(?:the\\s+)?(?:top-level|immediate)\\s+"+noun+"\\s+(?:in|inside)\\s+"+literal+"\\s*[.!]?$","i"));
  const direct=prefixed?null:text.match(new RegExp("^(?:please\\s+)?(?:list|show(?:\\s+me)?)\\s+(?:the\\s+)?"+noun+"\\s+directly\\s+(?:in|inside)\\s+"+literal+"\\s*[.!]?$","i"));
  const match=prefixed||direct;if(!match)return null;const path=explicitWorkspaceRelativeDirectory(match[1]);return path?{path}:null;
}

function explicitGitReadRequest(messages=[]){
  const user=latestUserMessage(messages),text=lastUserInstructionText(user).trim();if(!text||/[\r\n]/.test(text))return false;
  if(/^(?:(?:please\s+)?(?:show(?:\s+me)?|report|give\s+me|display)\s+(?:the\s+)?git\s+status|(?:please\s+)?what(?:'s|\s+is)\s+(?:the\s+)?git\s+status|git\s+status)\s*[.!?]?$/i.test(text))return {mode:"status"};
  if(/^(?:(?:please\s+)?(?:show(?:\s+me)?|report|give\s+me|display)\s+(?:the\s+)?(?:current\s+)?git\s+branch|(?:please\s+)?what(?:'s|\s+is)\s+(?:the\s+)?(?:current\s+)?git\s+branch|(?:please\s+)?what\s+branch\s+am\s+i\s+on|(?:current\s+)?git\s+branch)\s*[.!?]?$/i.test(text))return {mode:"branch"};
  return null;
}

function explicitBackgroundProcessRunningRequest(messages=[]){
  const user=latestUserMessage(messages),text=lastUserInstructionText(user).trim();if(!text||/[\r\n]/.test(text))return null;
  const match=text.match(/^(?:please\s+)?(?:is|tell\s+me\s+(?:if|whether))\s+(?:the\s+)?(?:background\s+)?process\s+(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|[A-Za-z0-9._:-]+)\s+(?:is\s+)?(?:still\s+)?running\s*[?!.]?$/i);if(!match)return null;
  let processId=String(match[1]||"").trim();if(["`","\"","'"].includes(processId[0])&&processId.at(-1)===processId[0])processId=processId.slice(1,-1).trim();
  if(processId.length<8||processId.length>128||!/^[A-Za-z0-9._:-]+$/.test(processId))return null;
  return {processId};
}

function explicitBrowserRuntimeHealthRequest(messages=[]){
  const user=latestUserMessage(messages),text=lastUserInstructionText(user).trim();if(!text||/[\r\n]/.test(text))return false;
  return /^(?:(?:please\s+)?(?:check|report)\s+(?:the\s+)?browser\s+runtime\s+(?:for\s+)?(?:console\s+(?:errors?|failures?)\s+(?:and|or)\s+network\s+(?:errors?|failures?)|network\s+(?:errors?|failures?)\s+(?:and|or)\s+console\s+(?:errors?|failures?))|(?:are|is)\s+there\s+(?:any\s+)?(?:browser\s+)?(?:console\s+(?:errors?|failures?)\s+(?:or|and)\s+network\s+(?:errors?|failures?)|network\s+(?:errors?|failures?)\s+(?:or|and)\s+console\s+(?:errors?|failures?)))\s*[?!.]?$/i.test(text);
}

function explicitBrowserScreenshotRequest(messages=[]){
  const user=latestUserMessage(messages),text=lastUserInstructionText(user).trim();if(!text||/[\r\n]/.test(text))return false;
  return /^(?:(?:please\s+)?(?:take|capture)\s+(?:a\s+|the\s+)?(?:current\s+)?browser\s+screenshot|(?:please\s+)?(?:take|capture)\s+(?:a\s+|the\s+)?screenshot\s+of\s+(?:the\s+)?(?:current\s+)?browser)\s*[.!]?$/i.test(text);
}

function explicitExactFileReadStatus(messages=[]){
  const user=latestUserMessage(messages),text=lastUserInstructionText(user).trim();if(!text||/[\r\n]/.test(text))return null;
  const file="(`[^`\\n]+`|\"[^\"\\n]+\"|'[^'\\n]+'|\\S+?)";
  const read=text.match(new RegExp("^(?:please\\s+)?(?:read|open)\\s+(?:the\\s+file\\s+)?"+file+"\\s+(?:and\\s+)?(?:show|return|give)\\s+(?:me\\s+)?(?:its|the)\\s+(?:contents?|text)\\s*[.!]?$","i"));
  const show=read?null:text.match(new RegExp("^(?:please\\s+)?(?:show|return|give)\\s+(?:me\\s+)?(?:the\\s+)?(?:contents?|text)\\s+of\\s+(?:the\\s+file\\s+)?"+file+"\\s*[.!]?$","i"));
  const match=read||show;if(!match)return null;
  const path=explicitWorkspaceRelativeFile(match[1]);return path?{path}:null;
}

function explicitExactFileWriteStatus(messages=[]){
  const user=latestUserMessage(messages),text=lastUserInstructionText(user).trim();if(!text||/[\r\n]/.test(text))return null;
  const literal="(`[^`\\n]*`|\"[^\"\\n]*\"|'[^'\\n]*'|\\S+?)",report="(?:\\s+(?:and\\s+)?(?:report|show)\\s+(?:me\\s+)?(?:the\\s+)?(?:result|status|outcome))?";
  const write=text.match(new RegExp("^(?:please\\s+)?write\\s+exactly\\s+"+literal+"\\s+to\\s+"+literal+report+"\\s*[.!]?$","i"));
  const set=write?null:text.match(new RegExp("^(?:please\\s+)?set\\s+(?:the\\s+)?contents?\\s+of\\s+"+literal+"\\s+exactly\\s+to\\s+"+literal+report+"\\s*[.!]?$","i"));
  const match=write||set;if(!match)return null;
  const content=exactReplacementToken(write?match[1]:match[2],{allowEmpty:true}),path=explicitWorkspaceRelativeFile(write?match[2]:match[1]);
  if(content==null||path==null)return null;
  return {path,content};
}

function explicitExactReplacementStatus(messages=[]){
  const user=latestUserMessage(messages),text=lastUserInstructionText(user).trim();
  if(!text||/[\r\n]/.test(text))return null;
  if(/\b(?:diagnos(?:e|is)|fix|repair|debug|explain|analy[sz]e|investigate|root\s+cause|recommend|suggest|compare|summari[sz]e|read|inspect|search|list|create|delete|write|commit|push|browse)\b/i.test(text))return null;
  const verified=text.match(/^(?:please\s+)?replace\s+(?:(?:exactly|only)\s+|the\s+exact\s+text\s+)(.+?)\s+with\s+(.+?)\s+in\s+(.+?)\s*[,;]?\s*(?:then|and\s+then)\s+(?:run|execute)\s+(.+?)\s+(?:and\s+)?(?:report|show)\s+(?:me\s+)?(?:the\s+)?(?:result|status|outcome)\s*[.!]?$/i);
  const direct=verified?null:text.match(/^(?:please\s+)?replace\s+(?:(?:exactly|only)\s+|the\s+exact\s+text\s+)(.+?)\s+with\s+(.+?)\s+in\s+(.+?)(?:\s*[,;]?\s+(?:and\s+)?(?:report|show)\s+(?:me\s+)?(?:the\s+)?(?:result|status|outcome))?\s*[.!]?$/i);
  const match=verified||direct;if(!match)return null;
  const oldText=exactReplacementToken(match[1]),newText=exactReplacementToken(match[2],{allowEmpty:true}),path=explicitWorkspaceRelativeFile(match[3]),command=verified?directVerifierCommandWithOptionalCwd(match[4]):null;
  if(oldText==null||newText==null||path==null||(verified&&!command))return null;
  if(oldText===newText||oldText.length>200||newText.length>200||path.length>300)return null;
  return {path,oldText,newText,command};
}

const TERMINAL_REPORT_SIGNAL=/\b(?:error|failed|failure|exception|assert(?:ion)?|traceback|panic|fatal|timeout|timed out|cannot|can't|invalid|expected|received|not found|undefined|mismatch)\b/i;
function terminalReportEvidence(output={}){
  const candidates=[output?.stderr,output?.error,output?.message,output?.preview,output?.stdout,output?.content];
  for(const candidate of candidates){
    if(typeof candidate!=="string"||!candidate.trim())continue;
    const lines=candidate.split(/\r?\n/).map(line=>line.trim()).filter(Boolean),line=lines.find(value=>TERMINAL_REPORT_SIGNAL.test(value))||lines[0];
    if(!line)continue;
    const clean=redactSecretText(line.replace(/^line\s+\d+:\s*/i,""),{trim:true}).replace(/\s+/g," ").slice(0,360);
    if(clean)return clean;
  }
  return null;
}

function terminalStatusText(run={}){
  const exitCode=Number(run?.exitCode);if(!Number.isFinite(exitCode))return null;
  const lines=[exitCode===0?"Command completed successfully (exit code 0).":`Command failed (exit code ${exitCode}).`];
  const evidence=String(run?.reportEvidence||"").trim();if(evidence)lines.push((exitCode===0?"Output: ":"Evidence: ")+evidence);
  return lines.join("\n");
}

function terminalRunLooksLikeVerifier(args={}){
  const normalized=normalizeNativeCommandArguments(args),command=String(normalized.command||"").trim(),argv=Array.isArray(normalized.args)?normalized.args.map(value=>String(value)):[];
  const rendered=[command,...argv].filter(Boolean).join(" ").replace(/\s+/g," ").trim().toLowerCase();
  return /(?:^|[\s/\\._:-])(?:verify|verification|verifier|tests?|pytest|jest|vitest|mocha|ava|rspec|checks?|lint|typecheck|tsc)(?:$|[\s/\\._:-])/i.test(rendered);
}

function selfAdmittedVerificationGap(text){
  const value=String(text||"").replace(/[\u2018\u2019\u02bc\uff07]/g,"'").replace(/\*\*/g,"");
  if(!value.trim())return false;
  if(/\brequired\b[^\n.!?]{0,100}\b(?:check|verification|validation|test)\s+(?:has\s+)?failed\b|\b(?:file|artifact|deliverable|result|solution)\s+(?:is|remains?)\s+(?:therefore\s+)?provisional\b|\bnot\s+(?:a\s+)?verified\s+(?:deliverable|artifact|result|solution)\b/i.test(value))return true;
  if(/\b(?:correctness|optimality|feasibility|compliance|acceptance|behavior|behaviour|implementation|solution|result)\b[^\n.!?]{0,80}\b(?:is|remains?)\s+not\s+(?:proven|verified|validated|established|demonstrated|confirmed)\b/i.test(value))return true;
  return /(?:^|\n)\s*unverified\s*:|\b(?:remains?|still|currently)\s+(?:unverified|untested|unconfirmed)\b|\b(?:not|never)\s+(?:(?:fully|completely|exhaustively|thoroughly|end[- ]to[- ]end)\s+)?(?:verified|tested|checked|validated|confirmed)\b|\b(?:unable|cannot|can't|could\s+not|couldn't)\s+to\s+(?:verify|test|check|validate|confirm|certify|prove|demonstrate)\b|\b(?:cannot|can't|unable\s+to|could\s+not|couldn't)\s+(?:certify|prove|demonstrate|confirm)\s+(?:that|whether)\b|\bdid(?:\s+not|n't)\s+(?:establish|determine|confirm|prove|demonstrate)\s+whether\b|\bdid(?:\s+not|n't)\s+(?:run|execute|perform)\s+(?:an?\s+|the\s+)?(?:integration|end[- ]to[- ]end|e2e|smoke|acceptance|timed|performance|benchmark|test)\b|\bdid(?:\s+not|n't)\s+(?:send|make|issue)\s+(?:an?\s+|the\s+)?(?:real|live|actual)\s+(?:http\s+)?(?:request|post|callback)\b|\bdid(?:\s+not|n't)\s+(?:exercise|reproduce)\s+(?:an?\s+|the\s+)?(?:(?:real|live|actual|full|fresh)\s+)?(?:integration|lifecycle|restart|deploy(?:ment)?|behavio(?:u)?r|path)\b/i.test(value);
}

function selfAdmittedFailedAcceptanceGap(text){
  const value=String(text||"").replace(/[\u2018\u2019\u02bc\uff07]/g,"'").replace(/\*\*/g,"");
  return /\brequired\b[^\n.!?]{0,100}\b(?:check|verification|validation|test)\s+(?:has\s+)?failed\b|\b(?:file|artifact|deliverable|result|solution)\s+(?:is|remains?)\s+(?:therefore\s+)?provisional\b|\bnot\s+(?:a\s+)?verified\s+(?:deliverable|artifact|result|solution)\b/i.test(value);
}

function selfAdmittedCompletionGap(text){
  const value=String(text||"").replace(/[\u2018\u2019\u02bc\uff07]/g,"'").replace(/\*\*/g,"");
  if(!value.trim())return false;
  return /(?:^|\n)\s*(?:partial|incomplete)\s+(?:analysis|result|solution|implementation|work|completion)\b|\b(?:unable\s+to|cannot|can't|could\s+not|couldn't|failed\s+to)(?:\s+\w+){0,2}\s+(?:establish|determine|derive|recover|restore|repair|reconstruct|recreate|rebuild|produce|create|generate|write|complete|finish|implement|resolve|fix|decode|decrypt)\b|\b(?:not|never)\s+(?:recovered|restored|repaired|reconstructed|recreated|rebuilt|derived|produced|created|generated|written|completed|finished|implemented|resolved|fixed|decoded|decrypted)\b|\b(?:was|were|is|are)\s+not\s+(?:created|produced|generated|written|recovered|restored|repaired|reconstructed|recreated|rebuilt|derived|completed|finished)\b/i.test(value);
}

function parseCompletionGateVerdict(text){
  const value=String(text||"").trim();if(!value)return null;
  const unfenced=value.replace(/^\s*```(?:json)?\s*/i,"").replace(/\s*```\s*$/,"").trim();
  const candidates=[unfenced],first=unfenced.indexOf("{"),last=unfenced.lastIndexOf("}");
  if(first>=0&&last>first&&!(first===0&&last===unfenced.length-1))candidates.push(unfenced.slice(first,last+1));
  for(const candidate of candidates){
    try{
      const parsed=JSON.parse(candidate),status=String(parsed?.status||"").trim().toLowerCase();
      if(!["complete","incomplete","blocked"].includes(status))continue;
      const rawProgress=String(parsed?.progress||"").trim().toLowerCase(),progress=["improved","unchanged","regressed","uncertain"].includes(rawProgress)?rawProgress:"uncertain";
      const rawEditSupport=String(parsed?.edit_support||"").trim().toLowerCase(),editSupport=["supported","unsupported","uncertain"].includes(rawEditSupport)?rawEditSupport:"uncertain";
      const rawMutationSafety=String(parsed?.mutation_safety||"").trim().toLowerCase(),mutationSafety=["allowed","forbidden","uncertain"].includes(rawMutationSafety)?rawMutationSafety:"uncertain";
      const unresolved=Array.isArray(parsed?.unresolved)?parsed.unresolved.map(item=>String(item||"").trim()).filter(Boolean).slice(0,8):[];
      const reason=String(parsed?.reason||"").trim().slice(0,2000);
      return {status,progress,progressProvided:Boolean(rawProgress),editSupport,editSupportProvided:Boolean(rawEditSupport),mutationSafety,mutationSafetyProvided:Boolean(rawMutationSafety),unresolved,reason};
    }catch{}
  }
  return null;
}

function parseAbstractionRepairVerificationVerdict(text){
  const value=String(text||"").trim();if(!value)return null;
  const unfenced=value.replace(/^\s*```(?:json)?\s*/i,"").replace(/\s*```\s*$/,"").trim();
  const candidates=[unfenced],first=unfenced.indexOf("{"),last=unfenced.lastIndexOf("}");
  if(first>=0&&last>first&&!(first===0&&last===unfenced.length-1))candidates.push(unfenced.slice(first,last+1));
  for(const candidate of candidates){
    try{
      const parsed=JSON.parse(candidate),status=String(parsed?.status||"").trim().toLowerCase();
      if(!["verified","failed","uncertain"].includes(status))continue;
      const reason=String(parsed?.reason||"").trim().slice(0,2000);
      return {status,reason};
    }catch{}
  }
  return null;
}

function verificationCompletionMatchesRun(request,args={},terminalRuns=[],editRevision=0){
  const key=terminalRunKey(args);if(!key)return false;
  const normalized=normalizeNativeCommandArguments(args),command=String(normalized.command||"").trim(),argv=Array.isArray(normalized.args)?normalized.args.map(value=>String(value)):[];
  const rendered=[command,...argv].filter(Boolean).join(" ").replace(/\s+/g," ").trim().toLowerCase();
  const verifierLike=terminalRunLooksLikeVerifier(args);
  if(request?.implicit){
    if(!verifierLike)return false;
    const failedKeys=new Set((Array.isArray(terminalRuns)?terminalRuns:[]).filter(item=>item?.exitCode!==0&&item?.editRevision<editRevision).map(item=>item?.key).filter(Boolean));
    return failedKeys.size===1&&failedKeys.has(key);
  }
  if(!request?.target)return false;
  const target=String(request.target).replace(/[`'\"“”‘’]/g,"").replace(/\s+/g," ").trim().toLowerCase();
  if(!target)return false;
  if(/^(?:(?:the|this|that)\s+)?(?:(?:same|failing|failed|passing|requested)\s+)?(?:verification|verifier|verification command|verifier command|tests?|test suite|test command|checks?|check command)$/i.test(target)){
    return verifierLike;
  }
  return Boolean(rendered)&&target===rendered;
}

function conciseReplacementSummary(oldText,newText){
  const before=String(oldText??""),after=String(newText??"");
  if(!before||!after||before.length>4096||after.length>4096)return null;
  if(redactSecretText(before)!==before||redactSecretText(after)!==after)return null;
  let prefix=0;const prefixLimit=Math.min(before.length,after.length);
  while(prefix<prefixLimit&&before[prefix]===after[prefix])prefix++;
  let beforeEnd=before.length,afterEnd=after.length;
  while(beforeEnd>prefix&&afterEnd>prefix&&before[beforeEnd-1]===after[afterEnd-1]){beforeEnd--;afterEnd--}
  const wordChar=value=>/[A-Za-z0-9_$]/.test(String(value||""));
  if(prefix>0&&prefix<before.length&&prefix<after.length&&wordChar(before[prefix-1])&&(wordChar(before[prefix])||wordChar(after[prefix]))){
    while(prefix>0&&before[prefix-1]===after[prefix-1]&&wordChar(before[prefix-1]))prefix--;
  }
  if(beforeEnd<before.length&&afterEnd<after.length&&beforeEnd>prefix&&afterEnd>prefix&&wordChar(before[beforeEnd-1])&&wordChar(before[beforeEnd])){
    while(beforeEnd<before.length&&afterEnd<after.length&&before[beforeEnd]===after[afterEnd]&&wordChar(before[beforeEnd])){beforeEnd++;afterEnd++}
  }
  const clean=value=>{
    const text=String(value||"").replace(/\s+/g," ").trim();
    if(!text||text.length>80||/^[A-Za-z0-9+/_=.-]{20,}$/.test(text))return null;
    const redacted=redactSecretText(text,{trim:true});return redacted===text&&!/\[(?:redacted|pairing-url)\]/i.test(redacted)?text:null;
  };
  const oldValue=clean(before.slice(prefix,beforeEnd)),newValue=clean(after.slice(prefix,afterEnd));
  return oldValue&&newValue?{oldValue,newValue}:null;
}

function verifiedSummaryText(edits=[]){
  const unique=[],seen=new Set();
  for(const edit of Array.isArray(edits)?edits:[]){
    const path=String(edit?.path||"").replace(/[\r\n\t]+/g," ").trim().slice(0,240);if(!path)continue;
    const kind=edit?.kind==="replace_text"?"replace_text":"write_file",replacements=Math.max(0,Math.trunc(Number(edit?.replacements)||0));
    if(kind!=="replace_text"||!edit?.summary||replacements<1)return null;
    const oldValue=String(edit.summary.oldValue||""),newValue=String(edit.summary.newValue||"");if(!oldValue||!newValue)return null;
    const key=JSON.stringify([path,kind,replacements,oldValue,newValue]);if(seen.has(key))continue;seen.add(key);unique.push({path,kind,replacements,oldValue,newValue});
  }
  if(!unique.length||unique.length>6)return null;
  const lines=["Done.","Changed:"];
  for(const edit of unique){
    const count=edit.replacements>1?` (${edit.replacements} occurrences)`:"";
    lines.push(`- ${edit.path}: replaced ${JSON.stringify(edit.oldValue)} with ${JSON.stringify(edit.newValue)}${count}.`);
  }
  lines.push("Verification: the same verifier command that failed before the edit now passes (exit code 0).");
  return lines.join("\n");
}

function verifiedCompletionText(edits=[]){
  const paths=[...new Set((Array.isArray(edits)?edits:[]).map(edit=>String(edit?.path||"").replace(/[\r\n\t]+/g," ").trim().slice(0,240)).filter(Boolean))];
  const shown=paths.slice(0,6),lines=["Done."];
  if(shown.length)lines.push("Changed: "+shown.join(", ")+(paths.length>shown.length?` (+${paths.length-shown.length} more)`:"")+".");
  lines.push("Verification: the same verifier command that failed before the edit now passes (exit code 0).");
  return lines.join("\n");
}

function terminalRunKey(args={}){
  const normalized=normalizeNativeCommandArguments(args),command=String(normalized.command||"").trim(),argv=Array.isArray(normalized.args)?normalized.args.map(value=>String(value)):[],cwd=String(normalized.cwd??"");
  return command?JSON.stringify([command,argv,cwd]):null;
}

function terminalReplayArguments(args={}){
  const normalized=normalizeNativeCommandArguments(args),command=String(normalized.command||"").trim();if(!command)return null;
  const replay={command,args:Array.isArray(normalized.args)?normalized.args.map(value=>String(value)):[]};
  if(Object.prototype.hasOwnProperty.call(normalized,"cwd"))replay.cwd=String(normalized.cwd??"");
  if(Number.isFinite(Number(normalized.timeout_ms)))replay.timeout_ms=Math.trunc(Number(normalized.timeout_ms));
  if(Number.isFinite(Number(normalized.max_output_bytes)))replay.max_output_bytes=Math.trunc(Number(normalized.max_output_bytes));
  return replay;
}

function priorTerminalEvidence(items=[]){
  const latest=new Map();
  for(const item of (Array.isArray(items)?items:[]).slice(-16)){
    const argumentsForReplay=terminalReplayArguments(item?.arguments||{}),exitCode=Number(item?.exitCode);
    if(!argumentsForReplay||!Number.isFinite(exitCode))continue;
    const key=terminalRunKey(argumentsForReplay);if(!key)continue;
    latest.set(key,{key,exitCode,editRevision:0,arguments:argumentsForReplay,priorTurn:true});
  }
  return [...latest.values()].filter(item=>item.exitCode!==0);
}

function verificationAutoRerunCandidate(request,terminalRuns=[],editRevision=0,currentCalls=[]){
  if(!request||editRevision<1)return null;
  const matching=new Map();
  for(const item of Array.isArray(terminalRuns)?terminalRuns:[]){
    if(!item?.key||item.exitCode===0||item.editRevision>=editRevision||!item.arguments)continue;
    if(!terminalRunLooksLikeVerifier(item.arguments))continue;
    if(!verificationCompletionMatchesRun(request,item.arguments,terminalRuns,editRevision))continue;
    matching.set(item.key,item);
  }
  if(matching.size!==1)return null;
  const candidate=[...matching.values()][0];
  const alreadyScheduled=(Array.isArray(currentCalls)?currentCalls:[]).some(call=>call?.namespace==="trebell_terminal"&&call?.name==="run"&&terminalRunKey(safeArguments(call?.arguments))===candidate.key);
  if(alreadyScheduled)return null;
  const argumentsForReplay=terminalReplayArguments(candidate.arguments);return argumentsForReplay?{...candidate,arguments:argumentsForReplay}:null;
}

function resultContent(value){
  if(typeof value==="string")return value;
  if(value==null)return "";
  if(typeof value?.content==="string")return value.content;
  if(Array.isArray(value?.contentItems)){
    const parts=[];let hasImage=false;
    for(const item of value.contentItems){
      if(typeof item==="string")parts.push({type:"text",text:item});
      else if(["inputText","outputText","text"].includes(item?.type)&&typeof item.text==="string")parts.push({type:"text",text:item.text});
      else if((item?.type==="inputImage"||item?.type==="image")&&(item.imageUrl||item.dataUrl)){
        hasImage=true;parts.push({type:"image_url",image_url:{url:String(item.imageUrl||item.dataUrl)}});
      }
    }
    if(parts.length)return hasImage?parts:parts.map(part=>part.text).join("\n");
  }
  try{return JSON.stringify(value)}catch{return String(value)}
}

function aggregateUsage(total,value={}){
  return {
    inputTokens:total.inputTokens+(Number(value.inputTokens)||0),
    outputTokens:total.outputTokens+(Number(value.outputTokens)||0),
    totalTokens:total.totalTokens+(Number(value.totalTokens)||0),
    cachedInputTokens:total.cachedInputTokens+(Number(value.cachedInputTokens)||0),
    cacheWriteInputTokens:total.cacheWriteInputTokens+(Number(value.cacheWriteInputTokens)||0),
    reasoningOutputTokens:total.reasoningOutputTokens+(Number(value.reasoningOutputTokens)||0),
  };
}

function nowMs(){return performance.now()}
function duration(start){return Number((performance.now()-start).toFixed(3))}

function emit(onEvent,event){
  try{onEvent?.({...event,at:Date.now()})}catch{}
}

function steeringMessages(consumeSteering){
  if(typeof consumeSteering!=="function")return [];
  const value=consumeSteering();return (Array.isArray(value)?value:[]).filter(message=>message&&typeof message==="object"&&message.role);
}

function applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn,toolCalls,stage}={}){
  const messages=steeringMessages(consumeSteering);if(!messages.length)return false;
  conversation.push(...messages);
  emit(onEvent,{name:"native.steering.applied",status:"completed",model:String(model||""),provider:provider||null,data:{stage,messageCount:messages.length,modelTurn,toolCalls}});
  return true;
}

export function nativeProviderRetryable(error){
  if(!error||error?.name==="AbortError")return false;
  if(error?.protocolFailure===true)return false;
  if(error?.transportFailure===true)return true;
  if(typeof error.retryable==="boolean")return error.retryable;
  const status=Number(error.status||error.statusCode||0);
  if(status)return [408,409,425,429].includes(status)||(status>=500&&status<=599);
  const code=String(error.code||"").toUpperCase();
  if(["ETIMEDOUT","ESOCKETTIMEDOUT","ECONNRESET","ECONNREFUSED","EPIPE","EAI_AGAIN","ENETDOWN","ENETUNREACH","EHOSTUNREACH"].includes(code))return true;
  const message=String(error.message||error).toLowerCase();
  return /\b(?:timeout|timed out|fetch failed|network error|socket hang up|connection reset|temporar(?:y|ily) unavailable|rate limit(?:ed)?)\b/.test(message);
}

async function retryDelay(ms,signal){
  if(ms<=0){throwIfAborted(signal);return}
  await new Promise((resolve,reject)=>{
    let settled=false;
    const done=()=>{if(settled)return;settled=true;cleanup();resolve()};
    const aborted=()=>{if(settled)return;settled=true;cleanup();reject(abortError(signal))};
    const timer=setTimeout(done,ms),cleanup=()=>{clearTimeout(timer);signal?.removeEventListener?.("abort",aborted)};
    if(signal?.aborted)return aborted();signal?.addEventListener?.("abort",aborted,{once:true});
  });
}

export function nativeAgentBudget(options={}){
  const wallTime=Number(options.maxWallTimeMs);
  return {
    maxModelTurns:boundedInteger(options.maxModelTurns,24,{min:1,max:500}),
    maxToolCalls:boundedInteger(options.maxToolCalls,100,{min:0,max:5000}),
    maxWallTimeMs:Number.isFinite(wallTime)&&wallTime>0?Math.floor(wallTime):null,
  };
}

export async function runNativeAgentTurn({
  providerTurn,executeTool,executeInternalTool=null,model,messages=[],tools=[],provider=null,toolChoice="auto",
  maxOutputTokens=null,temperature=null,reasoningEffort=null,parallelToolCalls=true,maxModelTurns=24,maxToolCalls=100,maxWallTimeMs=null,
  maxCompletionRecoveryEpochs=4,
  maxProviderAttempts=3,retryBaseDelayMs=250,consumeSteering=null,isToolParallelSafe=null,maxParallelToolCalls=8,toolAllowlist=null,coolReadToolHistory=null,preserveToolSchemasOnFinalization=false,signal=null,onEvent=null,metadata=null,
  autoRerunVerification=false,semanticCompletionGate=false,abstractionRepairVerification=false,priorTerminalRuns=[],synthesizeTerminalReports=false,coolSyntheticTerminalReportOutput=true,directTerminalStatusCommands=false,directExactReplacementStatus=false,directExactWriteStatus=false,directExactReadStatus=false,directExactListStatus=false,directGitStatus=false,directProcessRunningStatus=false,directBrowserRuntimeStatus=false,directBrowserScreenshot=false,prepareProviderMessages=null,
}={}){
  if(typeof providerTurn!=="function")throw new Error("Native agent loop requires a providerTurn function.");
  if(typeof executeTool!=="function")throw new Error("Native agent loop requires an executeTool function.");
  if(!String(model||"").trim())throw new Error("Native agent loop requires a model.");
  const executeControllerTool=typeof executeInternalTool==="function"?executeInternalTool:executeTool;
  const budget=nativeAgentBudget({maxModelTurns,maxToolCalls,maxWallTimeMs}),completionRecoveryEpochLimit=boundedInteger(maxCompletionRecoveryEpochs,4,{min:1,max:16}),strictAbstractionRepairVerification=abstractionRepairVerification===true,conversation=[...(Array.isArray(messages)?messages:[])],visibleTools=providerVisibleTools(tools,toolAllowlist),directVisiblePairs=exposedToolPairs(visibleTools),taskMutationRequested=requestsTaskMutation(conversation),workspaceMutationRequested=requestsWorkspaceMutation(conversation),externalStateMutationRequested=requestsExternalStateMutation(conversation),constraintPlanningRequested=requestsConstraintPlanning(conversation),quantitativeCalculationRequested=requestsDerivedQuantitativeCalculation(conversation),persistentArtifactTargets=explicitPersistentArtifactTargets(conversation),requestMetricsToolCache=new WeakMap(),requestMetricsMessageCache=new WeakMap(),requestMetricsCurrentTurnCache=new WeakMap(),requestMetricsHistoryHashCache={},requestMetricsClassificationCache=typeof coolReadToolHistory==="function"?null:{},openAiContinuationIdentity={};
  const persistentArtifactRequested=persistentArtifactTargets.length>0,artifactTargetSummary=persistentArtifactTargets.slice(0,3).map(value=>`\`${value}\``).join(", ");
  const explicitlyRequired=explicitlyRequestedTools(conversation,visibleTools),executedToolKeys=new Set(),requiredToolRecoveries=new Set();
  const finalAfterVerifiedRequest=explicitFinalAnswerAfterVerification(conversation),finalAfterVerifiedCommand=Boolean(finalAfterVerifiedRequest),summaryAfterVerifiedCommand=explicitSummaryAfterVerification(conversation),literalAfterVerifiedCommand=explicitLiteralAfterVerification(conversation),verificationCompletionRequest=explicitVerificationCompletion(conversation),verificationCompletionRequested=Boolean(verificationCompletionRequest),terminalStatusRequested=explicitTerminalStatusRequest(conversation),directTerminalStatusCommand=directTerminalStatusCommands===true?explicitTerminalStatusCommand(conversation):null,directReplacementStatus=directExactReplacementStatus===true?explicitExactReplacementStatus(conversation):null,directWriteStatus=directExactWriteStatus===true?explicitExactFileWriteStatus(conversation):null,directReadStatus=directExactReadStatus===true?explicitExactFileReadStatus(conversation):null,directListStatus=directExactListStatus===true?explicitImmediateWorkspaceListStatus(conversation):null,directGitStatusRequest=directGitStatus===true?explicitGitReadRequest(conversation):null,directProcessRunningRequest=directProcessRunningStatus===true?explicitBackgroundProcessRunningRequest(conversation):null,directBrowserRuntimeRequest=directBrowserRuntimeStatus===true&&explicitBrowserRuntimeHealthRequest(conversation),directBrowserScreenshotRequest=directBrowserScreenshot===true&&explicitBrowserScreenshotRequest(conversation),terminalRuns=priorTerminalEvidence(priorTerminalRuns),verifiedEdits=[];
  const verificationFinalizationRequest=verificationCompletionRequest||(finalAfterVerifiedRequest?.target?finalAfterVerifiedRequest:null);
  const successfulTerminalRuns=[];
  let modelTurns=0,toolCalls=0,emptyCompletionRecoveries=0,toolBudgetTextRecoveries=0,verifiedFinalizationRecoveries=0,selfAdmittedGapRecoveries=0,selfAdmittedGapRecoveryToolBaseline=0,preEditBlockerChallengeToolAllowance=false,forcedToolChoice=null,lastProviderReadMessageCount=0,toolBudgetFinalizationInjected=false,progressCheckpointInjected=false,constraintPlanningCheckpointInjected=false,constraintCommitCheckpointRevision=-1,constraintCommitValidatedRevision=-1,deliverableCheckpointInjected=false,deliverableEscalationInjected=false,probeBatchingRequired=false,postEditProbeBatchingRequired=false,postEditEvidenceRounds=0,postEditAssumptionAuditRevision=0,postEditAbstractionEscalationRevision=0,pendingAbstractionRepair=false,abstractionRepairRevision=0,abstractionRepairVerificationPending=false,abstractionRepairVerificationPromptRevision=0,abstractionRepairVerificationGateCandidate=null,abstractionRepairVerificationGateInvalidResponses=0,postEditResidualStructureRevision=0,postEditEvidenceCheckpointRevision=0,postEditEvidenceEscalated=false,singletonTerminalProbeStreak=0,implementationPressureEvidenceRounds=0,implementationPressureEscalated=false,externalObservationRounds=0,externalObservationCheckpointRevision=-1,externalObservationEscalated=false,actionOutputCapRelaxOnce=false,turnBudgetCheckpointInjected=false,wallBudgetCheckpointInjected=false,revisionChurnCheckpointInjected=false,revisionChurnCheckpointRevision=0,revisionChurnConvergenceBaseline=0,revisionChurnEscalated=false,revisionChurnGraceEditUsed=false,convergenceCheckpointRevision=0,convergenceCheckpointCount=0,convergenceFinalizationPending=false,convergenceFinalizationRevision=0,completionGateCandidate=null,completionGateInvalidResponses=0,completionGateChecks=0,completionGateRecoveries=0,completionRecoveryEpoch=0,completionRecoveryEvidenceRoundsRemaining=0,completionRecoveryEditResponsesRemaining=0,completionRecoveryEditConsumedEpoch=0,completionRecoveryPostEditEvidenceResponsesRemaining=0,completionRecoveryEditRequired=false,completionRecoveryEditRequiredMisses=0,completionRecoveryMutationForbidden=false,completionRecoverySupportWritesRemaining=0,completionRecoverySupportVerificationRemaining=0,completionRecoveryImplementationPaths=new Set(),completionRecoverySupportPaths=new Set(),completionRecoveryIncumbent=null,completionRecoveryEditTransaction=null,completionRecoveryIncumbentRestores=0,completionRecoveryIncumbentWorkspaceAligned=true,verifiedFinalizationAllowed=finalAfterVerifiedCommand||verificationCompletionRequested,verifiedFinalizationReady=false,verifiedFinalizationInjected=false,editRevision=0,usage={inputTokens:0,outputTokens:0,totalTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0},lastResponse=null;
  const normalizedEditPath=call=>String(safeArguments(call?.arguments).path||"").trim().replace(/\\/g,"/");
  const userRequestedEditPath=path=>{
    const value=String(path||"").trim();if(!value)return false;
    const text=lastUserInstructionText(latestUserMessage(conversation)).replace(/\\/g,"/");
    if(text.includes(value))return true;
    const basename=value.split("/").filter(Boolean).pop()||"";
    return Boolean(basename&&basename.includes(".")&&text.includes(basename));
  };
  const recoveryCorrectiveEditCall=call=>{
    if(implementationPressureEditCall(call)){
      if(externalStateMutationRequested)return false;
    }else{
      if(externalStateMutationRequested){
        if(call?.namespace==="trebell_terminal"&&call?.name==="run")return nativeTerminalAuditMetadata(call.namespace,call.name,safeArguments(call.arguments))?.persistentMutationLike===true;
        if(call?.namespace==="trebell_process"&&call?.name==="start")return nativeTerminalAuditMetadata("trebell_terminal","run",safeArguments(call.arguments))?.persistentMutationLike===true;
      }
      return false;
    }
    if(completionRecoveryEpoch<=0||editRevision<=0)return true;
    const path=normalizedEditPath(call);if(!path)return true;
    if(completionRecoverySupportPaths.has(path))return false;
    if(userRequestedEditPath(path))return true;
    if(call?.name==="replace_text")return true;
    return completionRecoveryImplementationPaths.has(path);
  };
  const recoverySupportWriteCandidate=call=>{
    if(completionRecoverySupportWritesRemaining<=0||call?.namespace!=="trebell_workspace"||call?.name!=="write_file")return false;
    const path=normalizedEditPath(call);if(!path)return false;
    if(completionRecoverySupportPaths.has(path))return true;
    return completionRecoveryImplementationPaths.size>0&&!completionRecoveryImplementationPaths.has(path)&&!userRequestedEditPath(path);
  };
  const startedAt=Date.now(),started=nowMs(),wallController=budget.maxWallTimeMs!=null?new AbortController():null,deadlineAt=budget.maxWallTimeMs==null?null:Date.now()+budget.maxWallTimeMs;
  let wallTimer=null;
  if(terminalRuns.length)emit(onEvent,{name:"native.verification.prior_terminal_evidence",status:"completed",model:String(model),provider:provider||null,data:{count:terminalRuns.length}});
  const armWallTimer=()=>{
    if(!wallController||wallController.signal.aborted||deadlineAt==null)return;
    const remaining=deadlineAt-Date.now();if(remaining<=0){wallController.abort("native-wall-time-budget");return}
    wallTimer=setTimeout(armWallTimer,Math.min(remaining,2_147_000_000));
  };
  armWallTimer();
  const turnSignal=wallController?(signal?AbortSignal.any([signal,wallController.signal]):wallController.signal):signal;
  const parallelLimit=boundedInteger(maxParallelToolCalls,8,{min:1,max:32});
  const canRunParallel=call=>parallelToolCalls===true&&typeof isToolParallelSafe==="function"&&isToolParallelSafe(call)===true;
  const captureRecoveryWorkspaceSnapshot=async(call)=>{
    if(call?.namespace!=="trebell_workspace"||!["write_file","replace_text"].includes(String(call?.name||"")))return null;
    const args=safeArguments(call?.arguments),path=String(args.path||"").trim();if(!path)return null;
    try{
      const output=await executeControllerTool({id:`native-recovery-snapshot-${modelTurns}-${editRevision}`,namespace:"trebell_workspace",name:"read_file",arguments:{path,max_bytes:1024*1024},rawArguments:JSON.stringify({path,max_bytes:1024*1024}),signal:turnSignal,modelTurn:modelTurns,toolCall:toolCalls});
      if(output?.success===false||typeof output?.content!=="string")return {path,restorable:false,reason:"workspace snapshot was unavailable"};
      const content=output.content,kind=String(call?.name||""),beforeSha256=sha256Text(content);
      let candidateContent=null;
      if(kind==="write_file")candidateContent=String(args.content??"");
      else if(kind==="replace_text"){
        const oldText=String(args.old_text??""),newText=String(args.new_text??"");
        if(oldText)candidateContent=content.split(oldText).join(newText);
      }
      return {path,restorable:true,content,beforeSha256,candidateSha256:candidateContent==null?null:sha256Text(candidateContent)};
    }catch(error){return {path,restorable:false,reason:String(error?.message||error||"workspace snapshot failed").slice(0,240)}}
  };
  const restoreRecoveryEditTransaction=async transaction=>{
    const snapshots=Array.isArray(transaction?.snapshots)?transaction.snapshots:[];
    if(!snapshots.length||snapshots.some(item=>!item?.restorable||typeof item?.content!=="string"))return {restored:false,paths:[],reason:"one or more edited files did not have a restorable pre-edit snapshot"};
    const restored=[];
    for(const snapshot of snapshots){
      const path=String(snapshot.path||"").trim();if(!path)return {restored:false,paths:restored,reason:"snapshot path was unavailable"};
      try{
        const current=await executeControllerTool({id:`native-recovery-restore-check-${modelTurns}-${restored.length+1}`,namespace:"trebell_workspace",name:"read_file",arguments:{path,max_bytes:1024*1024},rawArguments:JSON.stringify({path,max_bytes:1024*1024}),signal:turnSignal,modelTurn:modelTurns,toolCall:toolCalls});
        if(current?.success===false||typeof current?.content!=="string")return {restored:false,paths:restored,reason:"current workspace state could not be checked before restore"};
        const currentSha256=sha256Text(current.content);
        if(snapshot.candidateSha256&&currentSha256!==snapshot.candidateSha256)return {restored:false,paths:restored,reason:"workspace changed after the recovery candidate was written"};
        if(current.content===snapshot.content){restored.push(path);continue}
        if(!current.content.length)return {restored:false,paths:restored,reason:"an empty edited file could not be restored fail-closed"};
        const restoreArguments={path,old_text:current.content,new_text:snapshot.content,expected_replacements:1};
        const output=await executeControllerTool({id:`native-recovery-restore-${modelTurns}-${restored.length+1}`,namespace:"trebell_workspace",name:"replace_text",arguments:restoreArguments,rawArguments:JSON.stringify(restoreArguments),signal:turnSignal,modelTurn:modelTurns,toolCall:toolCalls});
        if(output?.success===false||output?.uncertain===true)return {restored:false,paths:restored,reason:String(output?.error||output?.message||"workspace restore failed").slice(0,240)};
        restored.push(path);
      }catch(error){return {restored:false,paths:restored,reason:String(error?.message||error||"workspace restore failed").slice(0,240)}}
    }
    return {restored:true,paths:restored,reason:null};
  };
  const executeOneTool=async(call,toolCallNumber)=>{
    const callId=String(call?.id||("native-tool-"+toolCallNumber)),namespace=call?.namespace?String(call.namespace):null,name=String(call?.name||"tool"),args=safeArguments(call?.arguments);
    if(namespace)executedToolKeys.add(namespace+"/"+name);
    const toolStarted=nowMs();
    const terminalAudit=nativeTerminalAuditMetadata(namespace,name,args),processMutationAudit=namespace==="trebell_process"&&name==="start"?nativeTerminalAuditMetadata("trebell_terminal","run",args):null;
    emit(onEvent,{name:"native.tool.requested",status:"running",model:String(model),provider:provider||null,data:{toolCall:toolCallNumber,callId,namespace,name,...(terminalAudit?{terminalAudit}:{})}});
    let output,success=true,errorMessage=null,uncertain=false,retrySafe=false,terminalTimeoutMs=null,toolController=null,watchdogAbortedTool=false;
    try{
      terminalTimeoutMs=terminalToolTimeoutMs(namespace,name,args);toolController=terminalTimeoutMs==null?null:new AbortController();const toolSignal=toolController?(turnSignal?AbortSignal.any([turnSignal,toolController.signal]):toolController.signal):turnSignal;
      if(terminalTimeoutMs==null){
        output=await executeTool({id:callId,namespace,name,arguments:args,rawArguments:call?.arguments??"{}",signal:toolSignal,modelTurn:modelTurns,toolCall:toolCallNumber});
      }else{
        let abortTimer=null,settleTimer=null;
        const timedOutOutput=error=>({success:false,exitCode:1,timedOut:true,signal:"SIGKILL",stdout:"",stderr:"",error});
        const cancelledOutput=()=>timedOutOutput(`Terminal command exceeded its ${terminalTimeoutMs}ms timeout and was cancelled by Trebell's tool watchdog.`);
        const unsettledOutput=()=>timedOutOutput(`Terminal command exceeded its ${terminalTimeoutMs}ms timeout and did not settle after cancellation.`);
        const execution=Promise.resolve()
          .then(()=>executeTool({id:callId,namespace,name,arguments:args,rawArguments:call?.arguments??"{}",signal:toolSignal,modelTurn:modelTurns,toolCall:toolCallNumber}))
          .catch(error=>{
            if(toolController.signal.aborted&&!turnSignal?.aborted&&error?.name==="AbortError")return cancelledOutput();
            throw error;
          });
        const watchdog=new Promise(resolveWatchdog=>{
          abortTimer=setTimeout(()=>{
            if(!toolController.signal.aborted){
              watchdogAbortedTool=true;
              toolController.abort("native-terminal-tool-timeout");
              emit(onEvent,{name:"native.tool.watchdog_abort",status:"running",model:String(model),provider:provider||null,data:{toolCall:toolCallNumber,callId,namespace,name,timeoutMs:terminalTimeoutMs}});
            }
          },terminalTimeoutMs+TERMINAL_TOOL_WATCHDOG_ABORT_GRACE_MS);
          settleTimer=setTimeout(()=>{
            emit(onEvent,{name:"native.tool.watchdog_timeout",status:"failed",model:String(model),provider:provider||null,data:{toolCall:toolCallNumber,callId,namespace,name,timeoutMs:terminalTimeoutMs,settlementGraceMs:TERMINAL_TOOL_WATCHDOG_SETTLE_GRACE_MS}});
            resolveWatchdog(unsettledOutput());
          },terminalTimeoutMs+TERMINAL_TOOL_WATCHDOG_SETTLE_GRACE_MS);
        });
        try{output=await Promise.race([execution,watchdog])}
        finally{if(abortTimer)clearTimeout(abortTimer);if(settleTimer)clearTimeout(settleTimer)}
      }
      throwIfAborted(turnSignal);
      if(output?.success===false){success=false;errorMessage=String(output.error||output.message||"Tool execution failed.");uncertain=output?.uncertain===true;retrySafe=output?.retrySafe===true}
      if(success&&namespace==="trebell_terminal"&&name==="run"&&output?.timedOut===true){
        success=false;errorMessage="Terminal command timed out.";
      }
    }catch(error){
      if(turnSignal?.aborted)throw abortError(turnSignal);
      if(watchdogAbortedTool&&toolController?.signal.aborted){
        success=false;errorMessage=`Terminal command exceeded its ${terminalTimeoutMs}ms timeout and was cancelled by Trebell's tool watchdog.`;output={success:false,exitCode:1,timedOut:true,signal:"SIGKILL",stdout:"",stderr:"",error:errorMessage};
      }else if(error?.name==="AbortError")throw abortError(turnSignal);
      else{success=false;errorMessage=error?.message||String(error);output={success:false,error:errorMessage}}
    }
    if(success&&output?.success!==false&&output?.timedOut!==true&&output?.signal==null&&namespace==="trebell_terminal"&&name==="run"&&String(args.command||"").trim()&&Array.isArray(args.args)){
      successfulTerminalRuns.push({command:String(args.command).trim(),args:args.args.map(value=>String(value)),cwd:String(args.cwd??"")});
    }
    if(success&&output?.success!==false&&output?.uncertain!==true&&namespace==="trebell_workspace"&&["write_file","replace_text"].includes(name)){
      const path=String(args.path||output?.path||"").trim(),normalizedPath=path.replace(/\\/g,"/"),knownImplementationPath=Boolean(normalizedPath&&completionRecoveryImplementationPaths.has(normalizedPath)),supportOnly=(externalStateMutationRequested&&completionRecoveryEpoch>0&&!userRequestedEditPath(normalizedPath))||(name==="write_file"&&completionRecoveryEpoch>0&&editRevision>0&&completionRecoveryImplementationPaths.size>0&&!knownImplementationPath&&!userRequestedEditPath(normalizedPath)&&output?.existedBefore===false);
      if(completionRecoveryEpoch>0)emit(onEvent,{name:"native.completion.recovery_write_classified",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,recoveryEpoch:completionRecoveryEpoch,kind:name,path:redactSecretText(path,{trim:true}).slice(0,240),existedBefore:typeof output?.existedBefore==="boolean"?output.existedBefore:null,knownImplementationPath,implementationPathCount:completionRecoveryImplementationPaths.size,supportOnly}});
      if(supportOnly){
        completionRecoverySupportPaths.add(normalizedPath);
        const supportAllowanceAvailable=completionRecoverySupportWritesRemaining>0;
        if(supportAllowanceAvailable)completionRecoverySupportWritesRemaining=Math.max(0,completionRecoverySupportWritesRemaining-1);
        if(supportAllowanceAvailable&&completionRecoveryEvidenceRoundsRemaining<=0)completionRecoverySupportVerificationRemaining=Math.max(completionRecoverySupportVerificationRemaining,1);
        if(path)verifiedEdits.push({path,kind:name,replacements:0,summary:null,supportOnly:true,beforeSha256:String(output?.beforeSha256||"")||null,afterSha256:String(output?.afterSha256||"")||null});
        emit(onEvent,{name:"native.completion.recovery_support_write",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,recoveryEpoch:completionRecoveryEpoch,path:redactSecretText(path,{trim:true}).slice(0,240),allowanceUsed:supportAllowanceAvailable,supportVerificationAllowed:supportAllowanceAvailable&&completionRecoverySupportVerificationRemaining>0}});
      }else{
        editRevision++;
        if(pendingAbstractionRepair||abstractionRepairVerificationPending){
          abstractionRepairRevision=editRevision;pendingAbstractionRepair=false;abstractionRepairVerificationPending=true;abstractionRepairVerificationPromptRevision=0;postEditResidualStructureRevision=0;
          emit(onEvent,{name:"native.progress.abstraction_repair_applied",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,path:redactSecretText(path,{trim:true}).slice(0,240),verificationPending:true}});
        }
        if(normalizedPath){completionRecoverySupportPaths.delete(normalizedPath);completionRecoveryImplementationPaths.add(normalizedPath)}if(path)verifiedEdits.push({path,kind:name,replacements:name==="replace_text"?Math.max(0,Math.trunc(Number(output?.replacements)||0)):0,summary:name==="replace_text"?conciseReplacementSummary(args.old_text,args.new_text):null,supportOnly:false,beforeSha256:String(output?.beforeSha256||"")||null,afterSha256:String(output?.afterSha256||"")||null});
      }
    }
    if(success&&output?.success!==false&&output?.uncertain!==true&&namespace==="trebell_terminal"&&name==="run"&&externalStateMutationRequested&&terminalAudit?.persistentMutationLike===true){
      editRevision++;
      emit(onEvent,{name:"native.progress.external_mutation_applied",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,mutationKind:terminalAudit.persistentMutationKind||null}});
    }
    if(success&&output?.success!==false&&output?.uncertain!==true&&namespace==="trebell_process"&&name==="start"&&externalStateMutationRequested&&processMutationAudit?.persistentMutationLike===true){
      editRevision++;
      emit(onEvent,{name:"native.progress.external_mutation_applied",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,mutationKind:processMutationAudit.persistentMutationKind||"background_process_write"}});
    }
    if(success&&output?.success!==false&&output?.timedOut!==true&&output?.signal==null&&namespace==="trebell_terminal"&&name==="run"){
      const key=terminalRunKey(args),exitCode=Number.isFinite(Number(output?.exitCode))?Number(output.exitCode):null;
      if(key&&exitCode!==null){
        const priorFailure=terminalRuns.findLast(item=>item.key===key&&item.exitCode!==0&&item.editRevision<editRevision);
        terminalRuns.push({key,exitCode,editRevision,arguments:terminalReplayArguments(args),currentTurn:true,reportEvidence:terminalReportEvidence(output)});
        const completionTargetMatches=!verificationFinalizationRequest||verificationCompletionMatchesRun(verificationFinalizationRequest,args,terminalRuns,editRevision);
        if(verifiedFinalizationAllowed&&exitCode===0&&priorFailure&&completionTargetMatches){
          verifiedFinalizationReady=true;
          emit(onEvent,{name:"native.verification.finalizing",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision}});
        }
      }
    }
    const content=resultContent(output)||(!success?errorMessage||"Tool execution failed.":"Tool completed without text output.");
    emit(onEvent,{name:"native.tool.completed",status:success?"completed":uncertain?"uncertain":"failed",model:String(model),provider:provider||null,data:{toolCall:toolCallNumber,callId,namespace,name,durationMs:duration(toolStarted),success,uncertain,retrySafe,error:errorMessage}});
    const observation={role:"tool",toolCallId:callId,content};
    try{Object.defineProperty(observation,NATIVE_TOOL_OBSERVATION_OUTPUT,{value:output,enumerable:false,configurable:true})}catch{}
    return observation;
  };
  const coolTerminalReportObservation=call=>{
    if(coolSyntheticTerminalReportOutput===false||!call?.id)return;
    const index=conversation.findLastIndex(message=>message?.role==="tool"&&String(message?.toolCallId||message?.tool_call_id||"")===String(call.id));
    if(index<0||typeof conversation[index]?.content!=="string")return;
    const before=conversation[index].content,after=coolVirtualizedToolContent(before,{maxPreviewChars:600,includePreview:false});
    if(after===before)return;
    conversation[index]={...conversation[index],content:after};emit(onEvent,{name:"native.tool.history_cooled",status:"completed",model:String(lastResponse?.model||model),provider:lastResponse?.provider||provider||null,data:{phase:"terminal_report",count:1,savedChars:Math.max(0,before.length-after.length),toolResultCount:1,toolCallArgumentCount:0,toolResultSavedChars:Math.max(0,before.length-after.length),toolCallArgumentSavedChars:0}});
  };
  const finishTerminalStatus=(call,run,{responseText="",direct=false}={})=>{
    const text=terminalStatusText(run);if(!text)return null;
    coolTerminalReportObservation(call);
    conversation.push({role:"assistant",content:text,toolCalls:[]});
    const result={text,model:String(lastResponse?.model||model),provider:lastResponse?.provider||provider||null,messages:conversation,modelTurns,toolCalls,usage,startedAt,completedAt:Date.now(),durationMs:duration(started),lastResponse:null};
    if(direct)emit(onEvent,{name:"native.terminal.direct_status_executed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,exitCode:run.exitCode}});
    emit(onEvent,{name:"native.terminal.report_synthesized",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,exitCode:run.exitCode,evidence:Boolean(run.reportEvidence),discardedPreToolTextChars:String(responseText||"").length,direct}});
    emit(onEvent,{name:"native.turn.completed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,durationMs:result.durationMs,usage,syntheticTerminalReport:true,directTerminalStatus:direct}});
    return result;
  };
  emit(onEvent,{name:"native.turn.started",status:"running",model:String(model),provider:provider||null,data:{...metadata,maxModelTurns:budget.maxModelTurns,maxToolCalls:budget.maxToolCalls,maxWallTimeMs:budget.maxWallTimeMs}});
  try{
    const directBrowserScreenshotVisible=directBrowserScreenshotRequest&&budget.maxToolCalls>=1&&directVisiblePairs.some(item=>item.namespace==="trebell_browser"&&item.name==="screenshot");
    if(directBrowserScreenshotVisible&&!applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"before_direct_browser_screenshot"})){
      throwIfAborted(turnSignal);
      const call={id:"native-direct-browser-screenshot-1",namespace:"trebell_browser",name:"screenshot",arguments:"{}"};
      conversation.push({role:"assistant",content:"",toolCalls:[call]});toolCalls=1;const observation=await executeOneTool(call,toolCalls);conversation.push(observation);
      const output=observation?.[NATIVE_TOOL_OBSERVATION_OUTPUT],dataUrl=typeof output?.dataUrl==="string"?output.dataUrl:"",missingExplicit=explicitlyRequired.find(item=>!executedToolKeys.has(item.namespace+"/"+item.name));
      const complete=/^data:image\/[A-Za-z0-9.+-]+;base64,/i.test(dataUrl)&&output?.success!==false&&output?.uncertain!==true&&output?.virtualized!==true&&output?.truncated!==true;
      if(complete&&!missingExplicit&&!applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"after_direct_browser_screenshot"})){
        const text="Browser screenshot captured.";conversation.push({role:"assistant",content:text,toolCalls:[]});const result={text,model:String(model),provider:provider||null,messages:conversation,modelTurns,toolCalls,usage,startedAt,completedAt:Date.now(),durationMs:duration(started),lastResponse:null};
        emit(onEvent,{name:"native.browser.direct_screenshot",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,width:Number(output?.width)||null,height:Number(output?.height)||null}});
        emit(onEvent,{name:"native.turn.completed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,durationMs:result.durationMs,usage,directBrowserScreenshot:true}});return result;
      }
    }
    const directBrowserRuntimeVisible=directBrowserRuntimeRequest&&budget.maxToolCalls>=1&&directVisiblePairs.some(item=>item.namespace==="trebell_browser"&&item.name==="runtime");
    if(directBrowserRuntimeVisible&&!applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"before_direct_browser_runtime"})){
      throwIfAborted(turnSignal);
      const call={id:"native-direct-browser-runtime-1",namespace:"trebell_browser",name:"runtime",arguments:"{}"};
      conversation.push({role:"assistant",content:"",toolCalls:[call]});toolCalls=1;const observation=await executeOneTool(call,toolCalls);conversation.push(observation);
      const output=observation?.[NATIVE_TOOL_OBSERVATION_OUTPUT],consoleErrors=Array.isArray(output?.consoleErrors)?output.consoleErrors:null,networkFailures=Array.isArray(output?.networkFailures)?output.networkFailures:null,missingExplicit=explicitlyRequired.find(item=>!executedToolKeys.has(item.namespace+"/"+item.name));
      const complete=consoleErrors!=null&&networkFailures!=null&&consoleErrors.length<=1000&&networkFailures.length<=1000&&output?.success!==false&&output?.uncertain!==true&&output?.virtualized!==true&&output?.truncated!==true;
      if(complete&&!missingExplicit&&!applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"after_direct_browser_runtime"})){
        const consoleCount=consoleErrors.length,networkCount=networkFailures.length,text=`Browser runtime: ${consoleCount} console error${consoleCount===1?"":"s"}, ${networkCount} network failure${networkCount===1?"":"s"}.`;
        conversation.push({role:"assistant",content:text,toolCalls:[]});const result={text,model:String(model),provider:provider||null,messages:conversation,modelTurns,toolCalls,usage,startedAt,completedAt:Date.now(),durationMs:duration(started),lastResponse:null};
        emit(onEvent,{name:"native.browser.direct_runtime_status",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,consoleErrorCount:consoleCount,networkFailureCount:networkCount}});
        emit(onEvent,{name:"native.turn.completed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,durationMs:result.durationMs,usage,directBrowserRuntimeStatus:true}});return result;
      }
    }
    const directProcessRunningVisible=directProcessRunningRequest&&budget.maxToolCalls>=1&&directVisiblePairs.some(item=>item.namespace==="trebell_process"&&item.name==="status");
    if(directProcessRunningVisible&&!applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"before_direct_process_status"})){
      throwIfAborted(turnSignal);
      const call={id:"native-direct-process-status-1",namespace:"trebell_process",name:"status",arguments:JSON.stringify({process_id:directProcessRunningRequest.processId})};
      conversation.push({role:"assistant",content:"",toolCalls:[call]});toolCalls=1;const observation=await executeOneTool(call,toolCalls);conversation.push(observation);
      const output=observation?.[NATIVE_TOOL_OBSERVATION_OUTPUT],processId=String(output?.processId||"").trim(),running=typeof output?.running==="boolean"?output.running:null,missingExplicit=explicitlyRequired.find(item=>!executedToolKeys.has(item.namespace+"/"+item.name));
      const complete=running!=null&&processId===directProcessRunningRequest.processId&&output?.success!==false&&output?.uncertain!==true&&output?.virtualized!==true&&output?.truncated!==true;
      if(complete&&!missingExplicit&&!applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"after_direct_process_status"})){
        const safeId=redactSecretText(processId,{trim:true}).replace(/[\r\n\t]+/g," ").slice(0,128),text=`Background process ${safeId} is ${running?"running":"not running"}.`;
        conversation.push({role:"assistant",content:text,toolCalls:[]});const result={text,model:String(model),provider:provider||null,messages:conversation,modelTurns,toolCalls,usage,startedAt,completedAt:Date.now(),durationMs:duration(started),lastResponse:null};
        emit(onEvent,{name:"native.process.direct_status",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,running}});
        emit(onEvent,{name:"native.turn.completed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,durationMs:result.durationMs,usage,directProcessRunningStatus:true}});return result;
      }
    }
    const directGitStatusVisible=directGitStatusRequest&&budget.maxToolCalls>=1&&directVisiblePairs.some(item=>item.namespace==="trebell_source_control"&&item.name==="status");
    if(directGitStatusVisible&&!applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"before_direct_git_status"})){
      throwIfAborted(turnSignal);
      const call={id:"native-direct-git-status-1",namespace:"trebell_source_control",name:"status",arguments:"{}"};
      conversation.push({role:"assistant",content:"",toolCalls:[call]});toolCalls=1;const observation=await executeOneTool(call,toolCalls);conversation.push(observation);
      const output=observation?.[NATIVE_TOOL_OBSERVATION_OUTPUT],status=Array.isArray(output?.status)?output.status:null;let statusBytes=Infinity;try{if(status)statusBytes=Buffer.byteLength(JSON.stringify({isGit:output?.isGit,branch:output?.branch,upstream:output?.upstream,statusHeader:output?.statusHeader,status}),"utf8")}catch{}
      const branch=String(output?.branch||"").trim(),branchMode=directGitStatusRequest?.mode==="branch",complete=status!=null&&status.length<500&&statusBytes<=DIRECT_GIT_STATUS_MAX_BYTES&&output?.success!==false&&output?.uncertain!==true&&output?.virtualized!==true&&output?.truncated!==true&&(!branchMode||output?.isGit===false||Boolean(branch)),missingExplicit=explicitlyRequired.find(item=>!executedToolKeys.has(item.namespace+"/"+item.name));
      if(complete&&!missingExplicit&&!applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"after_direct_git_status"})){
        const clean=value=>redactSecretText(String(value||""),{trim:true}).replace(/[\r\n\t]+/g," ").slice(0,300);let text;
        if(branchMode)text=output?.isGit===false?"Current Git branch: unavailable because this workspace is not a Git repository.":`Current Git branch: ${clean(branch)}.`;
        else if(output?.isGit===false)text="Git status: this workspace is not a Git repository.";
        else{
          const header=clean(output?.statusHeader),branch=clean(output?.branch),upstream=clean(output?.upstream),lines=["Git status:"];
          if(header)lines.push(header);else if(branch)lines.push(`Branch: ${branch}${upstream?` → ${upstream}`:""}`);
          if(!status.length)lines.push("Working tree clean.");
          else{lines.push("Changes:");for(const item of status){const code=clean(item?.code),path=clean(item?.path);if(path)lines.push(`- ${code||"??"} ${path}`)}}
          text=lines.join("\n");
        }
        conversation.push({role:"assistant",content:text,toolCalls:[]});const result={text,model:String(model),provider:provider||null,messages:conversation,modelTurns,toolCalls,usage,startedAt,completedAt:Date.now(),durationMs:duration(started),lastResponse:null};
        emit(onEvent,{name:"native.source_control.direct_status",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,isGit:output?.isGit!==false,mode:directGitStatusRequest?.mode||"status",changeCount:status.length}});
        emit(onEvent,{name:"native.turn.completed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,durationMs:result.durationMs,usage,directGitStatus:true,directGitReadMode:directGitStatusRequest?.mode||"status"}});return result;
      }
    }
    const directListVisible=directListStatus&&budget.maxToolCalls>=1&&directVisiblePairs.some(item=>item.namespace==="trebell_workspace"&&item.name==="list");
    if(directListVisible&&!applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"before_direct_exact_list"})){
      throwIfAborted(turnSignal);
      const call={id:"native-direct-exact-list-1",namespace:"trebell_workspace",name:"list",arguments:JSON.stringify({path:directListStatus.path,depth:1,limit:1000})};
      conversation.push({role:"assistant",content:"",toolCalls:[call]});toolCalls=1;const observation=await executeOneTool(call,toolCalls);conversation.push(observation);
      const output=observation?.[NATIVE_TOOL_OBSERVATION_OUTPUT],entries=Array.isArray(output?.entries)?output.entries:null;let serializedBytes=Infinity;try{if(entries)serializedBytes=Buffer.byteLength(JSON.stringify(output),"utf8")}catch{}
      const complete=entries!=null&&serializedBytes<=DIRECT_EXACT_LIST_MAX_BYTES&&output?.success!==false&&output?.uncertain!==true&&output?.virtualized!==true&&output?.truncated!==true,missingExplicit=explicitlyRequired.find(item=>!executedToolKeys.has(item.namespace+"/"+item.name));
      if(complete&&!missingExplicit&&!applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"after_direct_exact_list"})){
        const immediate=entries.filter(entry=>Number(entry?.depth)===0),safePath=redactSecretText(String(directListStatus.path||"."),{trim:true}).replace(/[\r\n\t]+/g," ").slice(0,240),shown=[];
        for(const entry of immediate){const raw=String(entry?.name||entry?.relativePath||"").replace(/[\r\n\t]+/g," ").trim();if(!raw)continue;const safe=redactSecretText(raw,{trim:true}).slice(0,240);if(safe)shown.push(`- ${safe}${entry?.isDirectory===true?"/":""}`)}
        const location=safePath==="."?"the workspace root":safePath,text=shown.length?`Immediate entries in ${location}:\n${shown.join("\n")}`:`No immediate files or folders found in ${location}.`;
        conversation.push({role:"assistant",content:text,toolCalls:[]});const result={text,model:String(model),provider:provider||null,messages:conversation,modelTurns,toolCalls,usage,startedAt,completedAt:Date.now(),durationMs:duration(started),lastResponse:null};
        emit(onEvent,{name:"native.workspace.direct_exact_list",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,path:safePath||null,entryCount:shown.length}});
        emit(onEvent,{name:"native.turn.completed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,durationMs:result.durationMs,usage,directExactList:true}});return result;
      }
    }
    const directReadVisible=directReadStatus&&budget.maxToolCalls>=1&&directVisiblePairs.some(item=>item.namespace==="trebell_workspace"&&item.name==="read_file");
    if(directReadVisible&&!applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"before_direct_exact_read"})){
      throwIfAborted(turnSignal);
      const call={id:"native-direct-exact-read-1",namespace:"trebell_workspace",name:"read_file",arguments:JSON.stringify({path:directReadStatus.path})};
      conversation.push({role:"assistant",content:"",toolCalls:[call]});toolCalls=1;const observation=await executeOneTool(call,toolCalls);conversation.push(observation);
      const output=observation?.[NATIVE_TOOL_OBSERVATION_OUTPUT],content=typeof output?.content==="string"?output.content:null,complete=content!=null&&Buffer.byteLength(content,"utf8")<=DIRECT_EXACT_READ_MAX_BYTES&&output?.success!==false&&output?.uncertain!==true&&output?.virtualized!==true&&output?.truncated!==true,missingExplicit=explicitlyRequired.find(item=>!executedToolKeys.has(item.namespace+"/"+item.name));
      if(complete&&!missingExplicit&&!applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"after_direct_exact_read"})){
        const safePath=redactSecretText(String(directReadStatus.path||""),{trim:true}).replace(/[\r\n\t]+/g," ").slice(0,240),text=`Contents of ${safePath||"the requested file"}:\n\n${content}`;
        conversation.push({role:"assistant",content:text,toolCalls:[]});const result={text,model:String(model),provider:provider||null,messages:conversation,modelTurns,toolCalls,usage,startedAt,completedAt:Date.now(),durationMs:duration(started),lastResponse:null};
        emit(onEvent,{name:"native.workspace.direct_exact_read",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,path:safePath||null,chars:content.length}});
        emit(onEvent,{name:"native.turn.completed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,durationMs:result.durationMs,usage,directExactRead:true}});return result;
      }
    }
    const directWriteVisible=directWriteStatus&&budget.maxToolCalls>=1&&directVisiblePairs.some(item=>item.namespace==="trebell_workspace"&&item.name==="write_file");
    if(directWriteVisible&&!applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"before_direct_exact_write"})){
      throwIfAborted(turnSignal);
      const call={id:"native-direct-exact-write-1",namespace:"trebell_workspace",name:"write_file",arguments:JSON.stringify({path:directWriteStatus.path,content:directWriteStatus.content})};
      conversation.push({role:"assistant",content:"",toolCalls:[call]});toolCalls=1;const beforeRevision=editRevision,observation=await executeOneTool(call,toolCalls);conversation.push(observation);
      const exactWrite=editRevision===beforeRevision+1&&verifiedEdits.at(-1)?.kind==="write_file"&&verifiedEdits.at(-1)?.path===directWriteStatus.path,missingExplicit=explicitlyRequired.find(item=>!executedToolKeys.has(item.namespace+"/"+item.name));
      if(exactWrite&&!missingExplicit&&!applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"after_direct_exact_write"})){
        const safePath=redactSecretText(String(directWriteStatus.path||""),{trim:true}).replace(/[\r\n\t]+/g," ").slice(0,240),text=`Exact file write completed${safePath?` in ${safePath}`:""}.`;
        conversation.push({role:"assistant",content:text,toolCalls:[]});const result={text,model:String(model),provider:provider||null,messages:conversation,modelTurns,toolCalls,usage,startedAt,completedAt:Date.now(),durationMs:duration(started),lastResponse:null};
        emit(onEvent,{name:"native.workspace.direct_exact_write",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,path:safePath||null}});
        emit(onEvent,{name:"native.turn.completed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,durationMs:result.durationMs,usage,directExactWrite:true}});return result;
      }
    }
    const directReplacementNeedsVerifier=Boolean(directReplacementStatus?.command),directReplacementVisible=directReplacementStatus&&budget.maxToolCalls>=(directReplacementNeedsVerifier?2:1)&&directVisiblePairs.some(item=>item.namespace==="trebell_workspace"&&item.name==="replace_text")&&(!directReplacementNeedsVerifier||directVisiblePairs.some(item=>item.namespace==="trebell_terminal"&&item.name==="run"));
    if(directReplacementVisible&&!applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"before_direct_exact_replacement"})){
      throwIfAborted(turnSignal);
      const editCall={id:"native-direct-exact-replace-1",namespace:"trebell_workspace",name:"replace_text",arguments:JSON.stringify({path:directReplacementStatus.path,old_text:directReplacementStatus.oldText,new_text:directReplacementStatus.newText,expected_replacements:1})};
      conversation.push({role:"assistant",content:"",toolCalls:[editCall]});toolCalls=1;const beforeRevision=editRevision,editObservation=await executeOneTool(editCall,toolCalls);conversation.push(editObservation);
      const exactEdit=editRevision===beforeRevision+1&&verifiedEdits.at(-1)?.kind==="replace_text"&&verifiedEdits.at(-1)?.path===directReplacementStatus.path&&verifiedEdits.at(-1)?.replacements===1;
      if(exactEdit&&!applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"after_direct_exact_replacement"})){
        if(!directReplacementNeedsVerifier){
          const missingExplicit=explicitlyRequired.find(item=>!executedToolKeys.has(item.namespace+"/"+item.name));
          if(!missingExplicit){
            const safePath=redactSecretText(String(directReplacementStatus.path||""),{trim:true}).replace(/[\r\n\t]+/g," ").slice(0,240),text=`Exact replacement completed${safePath?` in ${safePath}`:""}.`;
            conversation.push({role:"assistant",content:text,toolCalls:[]});const result={text,model:String(model),provider:provider||null,messages:conversation,modelTurns,toolCalls,usage,startedAt,completedAt:Date.now(),durationMs:duration(started),lastResponse:null};
            emit(onEvent,{name:"native.workspace.direct_exact_replacement",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,path:safePath||null}});
            emit(onEvent,{name:"native.turn.completed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,durationMs:result.durationMs,usage,directExactReplacement:true}});return result;
          }
        }
        if(directReplacementNeedsVerifier){
        const verifyCall={id:"native-direct-exact-replace-verify-1",namespace:"trebell_terminal",name:"run",arguments:JSON.stringify(directReplacementStatus.command)};
        conversation.push({role:"assistant",content:"",toolCalls:[verifyCall]});toolCalls=2;const verifyObservation=await executeOneTool(verifyCall,toolCalls);conversation.push(verifyObservation);
        const run=terminalRuns.findLast(item=>item?.currentTurn&&item.key===terminalRunKey(directReplacementStatus.command)),missingExplicit=explicitlyRequired.find(item=>!executedToolKeys.has(item.namespace+"/"+item.name));
        if(run&&!missingExplicit&&!applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"after_direct_exact_replacement_verifier"})){
          const status=terminalStatusText(run);if(status){
            coolTerminalReportObservation(verifyCall);
            const safePath=redactSecretText(String(directReplacementStatus.path||""),{trim:true}).replace(/[\r\n\t]+/g," ").slice(0,240),text=`Exact replacement completed${safePath?` in ${safePath}`:""}.\n${status}`;
            conversation.push({role:"assistant",content:text,toolCalls:[]});const result={text,model:String(model),provider:provider||null,messages:conversation,modelTurns,toolCalls,usage,startedAt,completedAt:Date.now(),durationMs:duration(started),lastResponse:null};
            emit(onEvent,{name:"native.workspace.direct_exact_replacement_status",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,path:safePath||null,exitCode:run.exitCode}});
            emit(onEvent,{name:"native.turn.completed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,durationMs:result.durationMs,usage,directExactReplacementStatus:true}});return result;
          }
        }
        }
      }
    }
    const directTerminalVisible=directTerminalStatusCommand&&budget.maxToolCalls>0&&directVisiblePairs.some(item=>item.namespace==="trebell_terminal"&&item.name==="run");
    if(directTerminalVisible&&!applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"before_direct_terminal_status"})){
      throwIfAborted(turnSignal);
      const call={id:"native-direct-terminal-status-1",namespace:"trebell_terminal",name:"run",arguments:JSON.stringify(directTerminalStatusCommand)};conversation.push({role:"assistant",content:"",toolCalls:[call]});toolCalls=1;
      const observation=await executeOneTool(call,toolCalls);conversation.push(observation);
      const run=terminalRuns.findLast(item=>item?.currentTurn&&item.key===terminalRunKey(directTerminalStatusCommand)),missingExplicit=explicitlyRequired.find(item=>!executedToolKeys.has(item.namespace+"/"+item.name));
      if(run&&!missingExplicit){const result=finishTerminalStatus(call,run,{direct:true});if(result)return result}
    }
    for(;;){
    throwIfAborted(turnSignal);
    if(typeof coolReadToolHistory==="function"&&lastProviderReadMessageCount>0){
      const count=Math.min(lastProviderReadMessageCount,conversation.length),cooled=coolReadToolHistory(conversation.slice(0,count));lastProviderReadMessageCount=0;
      if(Array.isArray(cooled?.messages)&&cooled.messages.length===count){
        conversation.splice(0,count,...cooled.messages);
        if(Number(cooled.count||0)>0)emit(onEvent,{name:"native.tool.history_cooled",status:"completed",model:String(lastResponse?.model||model),provider:lastResponse?.provider||provider||null,data:{phase:"same_turn",count:Number(cooled.count||0),savedChars:Number(cooled.savedChars||0),toolResultCount:Number(cooled.toolResultCount||0),toolCallArgumentCount:Number(cooled.toolCallArgumentCount||0),toolResultSavedChars:Number(cooled.toolResultSavedChars||0),toolCallArgumentSavedChars:Number(cooled.toolCallArgumentSavedChars||0),beforeModelTurn:modelTurns+1}});
      }
    }
    if(workspaceMutationRequested&&!probeBatchingRequired&&editRevision===0&&singletonTerminalProbeStreak>=3){
      conversation.push({role:"developer",content:"Trebell probe-batching checkpoint: the last "+singletonTerminalProbeStreak+" model turns each spent a full inference round trip on one evidence probe (terminal, read, search, list, or output inspection). Continue investigating if needed, but stop serial probing. From now until the first workspace edit, gather any remaining independent evidence in a genuinely batched terminal script or multi-tool response, then synthesize the results. A single evidence probe per model turn will be blocked; an implementation edit or an explicit concrete blocker is also acceptable."});
      probeBatchingRequired=true;
      emit(onEvent,{name:"native.progress.probe_batch_checkpoint",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,singletonTerminalProbeStreak}});
    }
    if(externalStateMutationRequested&&externalObservationCheckpointRevision!==editRevision&&externalObservationRounds>=6){
      conversation.push({role:"developer",content:"Trebell external-state convergence checkpoint: "+externalObservationRounds+" separate quick observation rounds have run since the latest persistent external-state change without another state change. Stop paying one model decision per status/query. Batch related reads into one bounded script. If the task is waiting for a time/state condition, prefer one consolidated wait-and-check command or a background monitor rather than repeated immediate status polls. Continue observation only when it can change the next action; otherwise make the next evidence-supported legal state change, propose completion, or state the concrete blocker."});
      externalObservationCheckpointRevision=editRevision;
      emit(onEvent,{name:"native.progress.external_observation_checkpoint",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,observationRounds:externalObservationRounds}});
    }
    if(externalStateMutationRequested&&externalObservationCheckpointRevision===editRevision&&!externalObservationEscalated&&externalObservationRounds>=8){
      conversation.push({role:"developer",content:"Trebell external-state convergence escalation: the current external-state revision has already consumed the bounded quick-observation allowance. Further immediate API/status polling is blocked until the external state changes or a later bounded recovery window explicitly reopens evidence. A genuinely consolidated wait-and-check command remains available when the only useful action is to wait for an external condition. Otherwise synthesize the evidence and finish or explain the blocker."});
      externalObservationEscalated=true;
      emit(onEvent,{name:"native.progress.external_observation_escalation",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,observationRounds:externalObservationRounds}});
    }
    const implementationCheckpointDue=workspaceMutationRequested&&!progressCheckpointInjected&&!probeBatchingRequired&&editRevision===0&&((toolCalls>=24&&modelTurns>=3)||modelTurns>=4);
    const deliverableCheckpointDue=persistentArtifactRequested&&!deliverableCheckpointInjected&&modelTurns>=4;
    if(implementationCheckpointDue&&deliverableCheckpointDue){
      conversation.push({role:"developer",content:"Trebell progress checkpoint + deliverable checkpoint: enough read-only exploration has elapsed without a workspace edit, and the user requires persistent output at "+artifactTargetSummary+". Begin the smallest evidence-supported implementation and smallest viable generation or production attempt now. Batch only evidence that directly unblocks that action; singleton pre-edit reconnaissance is blocked. Before a hard-to-reverse external write, validate explicit prerequisite constraints/objectives. If implementation is impossible, state the concrete blocker. Do not claim the deliverable exists without tool evidence."});
      progressCheckpointInjected=true;deliverableCheckpointInjected=true;
      emit(onEvent,{name:"native.progress.implementation_checkpoint",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,coalescedWithDeliverable:true}});
      emit(onEvent,{name:"native.progress.deliverable_checkpoint",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,targetCount:persistentArtifactTargets.length,coalescedWithImplementation:true}});
    }else if(implementationCheckpointDue){
      conversation.push({role:"developer",content:"Trebell progress checkpoint: enough read-only exploration has elapsed without a workspace edit. Begin the smallest evidence-supported implementation now. Batch only evidence that directly unblocks it; singleton pre-edit reconnaissance is blocked. Before a hard-to-reverse external write, validate explicit prerequisite constraints/objectives. If implementation is impossible, state the concrete blocker."});
      progressCheckpointInjected=true;
      emit(onEvent,{name:"native.progress.implementation_checkpoint",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision}});
    }
    if(constraintPlanningRequested&&!constraintPlanningCheckpointInjected&&modelTurns>=3){
      conversation.push({role:"developer",content:"Trebell global-constraint planning checkpoint: this task asks for a plan, schedule, allocation, assignment, routing, dispatch, packing, or optimization result whose validity depends on multiple hard constraints or an objective. Do not keep constructing or repairing candidates manually across many model turns. After the minimum source/schema discovery needed to understand the contract, encode the authoritative hard constraints, derived quantities, and objective together in one bounded local solver/search/check script or equivalent batched computation. Validate the complete candidate in memory or scratch state against every explicit acceptance-critical constraint before any persistent writeback or hard-to-reverse side effect. Local row counts, internal consistency, or one-by-one checks are not evidence of global feasibility or optimality. If the task requires the best/priority-optimal feasible result, compare the candidate against that objective rather than merely finding any plausible result. If no valid result exists, establish that with bounded solver/exhaustive evidence instead of repeated manual variants."});
      constraintPlanningCheckpointInjected=true;
      emit(onEvent,{name:"native.progress.global_constraint_planning_checkpoint",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision}});
    }
    if(deliverableCheckpointDue&&!deliverableCheckpointInjected){
        conversation.push({role:"developer",content:"Trebell deliverable checkpoint: the user explicitly requires a persistent output artifact at "+artifactTargetSummary+". Four model turns have already elapsed. Keep investigating when necessary, but make sure the work is converging toward a concrete deliverable rather than spending the entire turn on open-ended analysis. If no provisional artifact exists yet, establish the necessary toolchain and start the smallest viable generation or production attempt now; batch any final independent discovery that directly unblocks that attempt. If an artifact already exists, verify and refine it against the strongest available acceptance evidence. If producing the deliverable also commits non-idempotent or hard-to-reverse external state, validate prerequisite semantic constraints and objective/priority requirements before committing that state whenever a reversible transaction or dry run is unavailable. Do not claim that the artifact exists unless tool evidence establishes it."});
      deliverableCheckpointInjected=true;
      emit(onEvent,{name:"native.progress.deliverable_checkpoint",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,targetCount:persistentArtifactTargets.length}});
    }
    if(persistentArtifactRequested&&deliverableCheckpointInjected&&!deliverableEscalationInjected&&modelTurns>=8){
      conversation.push({role:"developer",content:"Trebell deliverable escalation: eight model turns have elapsed on a task whose required result is a persistent artifact at "+artifactTargetSummary+". If the required artifact still does not exist, stop broad exploratory analysis and take the next concrete production or toolchain action now, unless a specific blocker makes production impossible. A provisional artifact that can be measured and improved is more useful than another round of unbounded reconnaissance. If the artifact exists, switch from discovery to acceptance-focused measurement and refinement. Do not fabricate or silently weaken the requested deliverable."});
      deliverableEscalationInjected=true;
      emit(onEvent,{name:"native.progress.deliverable_escalation",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,targetCount:persistentArtifactTargets.length}});
    }
    if(workspaceMutationRequested&&progressCheckpointInjected&&editRevision===0&&!implementationPressureEscalated&&implementationPressureEvidenceRounds>=2){
      conversation.push({role:"developer",content:"Trebell implementation escalation: "+implementationPressureEvidenceRounds+" additional batched evidence rounds have already executed after the implementation checkpoint without a workspace edit. The evidence-gathering allowance is now exhausted. On the next action, either include the smallest evidence-supported workspace edit or explain a concrete blocker that makes implementation impossible. Further pre-edit reads, searches, and terminal probes without an edit will be blocked; do not repackage the same investigation into another batch."});
      implementationPressureEscalated=true;
      emit(onEvent,{name:"native.progress.implementation_escalation",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,evidenceRounds:implementationPressureEvidenceRounds}});
    }
    if(workspaceMutationRequested&&editRevision>0&&!postEditProbeBatchingRequired&&singletonTerminalProbeStreak>=3){
      conversation.push({role:"developer",content:"Trebell post-edit probe-batching checkpoint: the last "+singletonTerminalProbeStreak+" model turns each spent a full inference round trip on one evidence probe after a successful workspace edit. Keep investigating if a concrete gap remains, but stop serial probing. Until another workspace edit is made, any further independent terminal/read/search/list/output-inspection evidence must be gathered in a genuinely batched multi-tool response or one bounded adaptive shell/script probe. A new evidence-supported workspace edit or a final answer is also acceptable. Do not split a batchable verification sweep into one probe per reasoning turn."});
      postEditProbeBatchingRequired=true;
      emit(onEvent,{name:"native.progress.post_edit_probe_batch_checkpoint",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,singletonTerminalProbeStreak}});
    }
    const verifiedResidualLocalizationActive=workspaceMutationRequested&&editRevision>0&&abstractionRepairRevision>0&&!pendingAbstractionRepair&&!abstractionRepairVerificationPending&&postEditResidualStructureRevision>=abstractionRepairRevision;
    if(workspaceMutationRequested&&editRevision>0&&!verifiedResidualLocalizationActive&&postEditAssumptionAuditRevision!==editRevision&&postEditEvidenceRounds>=4){
      conversation.push({role:"developer",content:"Trebell assumption-audit checkpoint: "+postEditEvidenceRounds+" evidence-only reasoning rounds have executed since the latest workspace edit without resolving the remaining defect. Before spending more inference on variations of the same approach, identify the earliest shared assumption that the recent probes depend on and try to falsify it with evidence that does not itself assume the same thing. The relevant assumption may concern the algorithm or problem family, an input interpretation, an API or file contract, environment behavior, units, state, ordering, or another task-specific premise. Prefer one bounded discriminating check that can explain several observations at once. If the assumption survives an independent check, keep the strongest remaining hypothesis and continue; do not invent an upstream or representation bug merely because this checkpoint fired."});
      postEditAssumptionAuditRevision=editRevision;
      emit(onEvent,{name:"native.progress.assumption_audit_checkpoint",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,evidenceRounds:postEditEvidenceRounds}});
    }
    if(workspaceMutationRequested&&editRevision>0&&!verifiedResidualLocalizationActive&&postEditAssumptionAuditRevision===editRevision&&postEditAbstractionEscalationRevision!==editRevision&&postEditEvidenceRounds>=6){
      conversation.push({role:"developer",content:"Trebell abstraction-boundary escalation: the current revision has continued through at least two additional evidence rounds after its assumption audit. This checkpoint does not prove that an upstream abstraction is wrong. Use the audit evidence to choose between two paths: if an independently observed fact contradicts a shared upstream assumption, repair or re-derive that assumption and verify the motivating contradiction directly; otherwise keep the strongest task-relevant hypothesis and stop forcing the problem into an abstraction/layout explanation. Prefer a single hypothesis that explains several independent observations over a broad permutation search. Do not change layers merely to satisfy this checkpoint."});
      postEditAbstractionEscalationRevision=editRevision;
      if(strictAbstractionRepairVerification)pendingAbstractionRepair=true;
      emit(onEvent,{name:"native.progress.abstraction_boundary_escalation",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,evidenceRounds:postEditEvidenceRounds,verificationLock:strictAbstractionRepairVerification}});
    }
    if(workspaceMutationRequested&&abstractionRepairVerificationPending&&abstractionRepairRevision===editRevision&&abstractionRepairVerificationPromptRevision!==editRevision){
      conversation.push({role:"developer",content:"Trebell abstraction-repair verification checkpoint: the latest implementation edit was made while an upstream abstraction/source interpretation was under challenge. Do not treat that abstraction as repaired merely because an edit was made or because an end-to-end score improved. Before descending into residual/local-layout search, directly re-run the independent source-of-truth invariant that motivated the repair, using evidence that does not reuse the suspect parser/decoder/adapter/mapper to manufacture both sides of the check. If the contradiction remains, stay at the upstream layer: revise the framing/order/mapping/schema/units/state interpretation again and remove downstream compensations such as selecting, averaging, splicing, or permuting contradictory decoded copies. If the invariant now holds, state that evidence explicitly; only then localize any remaining defect to a smaller producer/consumer transform boundary."});
      abstractionRepairVerificationPromptRevision=editRevision;
      emit(onEvent,{name:"native.progress.abstraction_repair_verification_checkpoint",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,abstractionRepairRevision}});
    }
    if(workspaceMutationRequested&&editRevision>0&&abstractionRepairRevision>0&&!pendingAbstractionRepair&&!abstractionRepairVerificationPending&&postEditResidualStructureRevision!==editRevision&&postEditEvidenceRounds>=2){
      conversation.push({role:"developer",content:"Trebell residual-structure checkpoint: an upstream abstraction/source-layout repair has already been positively verified, but the latest revision still has unresolved acceptance evidence. Do not immediately reopen the global framing assumption unless new raw evidence contradicts that verified repair. Localize the residual to the smallest failing output/source family and trace it back across exactly one structural transform boundary. Treat that local residual as a composite contract whose orthogonal dimensions may include axis orientation or transpose, gather/concat dimension, local-versus-global index mapping, within-record packing/interleave/pair order, shard/block order, dtype/unit convention, and specialization-specific layout differences. Test exactly one such dimension at a time: hold every other reconstruction choice fixed, compare the current baseline against one isolated alternative, and measure the incremental effect on the strongest acceptance metric or independent invariant. Do not run a Cartesian product or coupled sweep across two or more transform dimensions in the same discriminator. Preserve an isolated transform only when it materially improves the metric or source invariant; otherwise revert it before testing the next dimension. Combine transforms only after each component has independent support. Do not assume a specialized grouped/fused/kernel representation uses the same convention as a dense or sibling representation merely because their semantic names are analogous. Prefer one bounded raw-slice, round-trip, or acceptance-metric discriminator for that single component, then make one coherent evidence-supported edit."});
      postEditResidualStructureRevision=editRevision;
      emit(onEvent,{name:"native.progress.residual_structure_checkpoint",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,evidenceRounds:postEditEvidenceRounds,abstractionRepairRevision,descendantRevision:editRevision!==abstractionRepairRevision}});
    }
    if(workspaceMutationRequested&&editRevision>0&&postEditEvidenceCheckpointRevision!==editRevision&&postEditEvidenceRounds>=6){
      conversation.push({role:"developer",content:"Trebell post-edit evidence checkpoint: "+postEditEvidenceRounds+" separate tool-bearing reasoning rounds have already executed since the latest successful workspace edit without another edit. Batch-like scripts still cost a full model decision each time, so do not keep repackaging investigation indefinitely. You have at most two more focused evidence rounds for the current edit revision. Use them to resolve the concrete remaining hypothesis or acceptance gap, then either make the next evidence-supported workspace edit, finish the task, or state a concrete blocker."});
      postEditEvidenceCheckpointRevision=editRevision;
      emit(onEvent,{name:"native.progress.post_edit_evidence_checkpoint",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,evidenceRounds:postEditEvidenceRounds}});
    }
    if(workspaceMutationRequested&&editRevision>0&&postEditEvidenceCheckpointRevision===editRevision&&!postEditEvidenceEscalated&&postEditEvidenceRounds>=8){
      conversation.push({role:"developer",content:"Trebell post-edit evidence escalation: this revision's evidence-only allowance is exhausted, so further evidence-only calls are blocked. Next: make one evidence-supported workspace edit, finish from the evidence already collected, or state the concrete blocker."});
      postEditEvidenceEscalated=true;
      emit(onEvent,{name:"native.progress.post_edit_evidence_escalation",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,evidenceRounds:postEditEvidenceRounds}});
    }
    if(workspaceMutationRequested&&editRevision>0&&convergenceCheckpointRevision!==editRevision){
      const revisionRuns=terminalRuns.filter(item=>item?.currentTurn&&item?.editRevision===editRevision),failedRuns=revisionRuns.filter(item=>item?.exitCode!==0),passedRuns=revisionRuns.filter(item=>item?.exitCode===0),distinctPassed=new Set(passedRuns.map(item=>item?.key).filter(Boolean));
      if(failedRuns.length===0&&passedRuns.length>=3&&distinctPassed.size>=2){
        conversation.push({role:"developer",content:`Trebell convergence checkpoint: since the latest successful workspace edit, ${passedRuns.length} terminal checks have passed with no terminal failure (${distinctPassed.size} distinct commands). Command count is not semantic coverage: before stopping, compare those checks against the user's stated acceptance signals and any behavior-driving structured inputs or configured constraints already identified. Explicit quantitative targets still need representative evidence, and a one-shot benchmark/deploy/cutover/release signal should not be triggered before its acceptance-critical preconditions are evidenced. For hidden/randomized/workload-variable performance gates, a narrow proxy that only barely clears the threshold is not strong convergence evidence: use broader varied cases and meaningful headroom when feasible, and make sure invariant preprocessing is not still sitting inside the repeated hot path. If that coverage is complete, stop speculative polishing and answer now. Continue only if you can name a concrete unmet requirement or a focused verification gap; do not invent extra hardening work.`});
        convergenceCheckpointRevision=editRevision;
        convergenceCheckpointCount++;
        if(semanticCompletionGate===true){
          convergenceFinalizationPending=true;
          convergenceFinalizationRevision=editRevision;
          conversation.push({role:"developer",content:"Trebell convergence finalization: the current workspace revision has multiple distinct passing checks and no recorded terminal failure. Tool use is temporarily disabled for one candidate final answer so semantic completion can be audited instead of continuing speculative polishing. Respond now with the best concise final answer supported by the evidence. If a material requirement or verification gap genuinely remains, state it explicitly rather than inventing another edit; Trebell's semantic completion gate will reopen bounded tool work when the gap is real."});
          emit(onEvent,{name:"native.progress.convergence_finalization",status:"running",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,passedRuns:passedRuns.length,distinctPassedRuns:distinctPassed.size}});
        }
        emit(onEvent,{name:"native.progress.convergence_checkpoint",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,passedRuns:passedRuns.length,distinctPassedRuns:distinctPassed.size}});
      }
    }
    if(workspaceMutationRequested&&!revisionChurnCheckpointInjected&&editRevision>=8){
      const currentRevisionRuns=terminalRuns.filter(item=>item?.currentTurn&&item?.editRevision===editRevision),currentFailures=currentRevisionRuns.filter(item=>item?.exitCode!==0).length;
      conversation.push({role:"developer",content:`Trebell revision-churn checkpoint: ${editRevision} successful workspace edits have already been made in this turn. Do not keep making small speculative tweaks merely to polish the current artifact or to escape a convergence checkpoint. Before another edit, name the concrete unmet user requirement, failing check, or acceptance-critical evidence gap it addresses; if several related changes remain, combine them coherently instead of paying one model round trip per micro-edit. If the current implementation already satisfies the user's stated acceptance signals, stop and answer. Large multi-file work may continue when those edits map to distinct required surfaces.`});
      revisionChurnCheckpointInjected=true;
      revisionChurnCheckpointRevision=editRevision;
      revisionChurnConvergenceBaseline=convergenceCheckpointCount;
      emit(onEvent,{name:"native.progress.revision_churn_checkpoint",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,currentRevisionFailures:currentFailures}});
    }
    if(workspaceMutationRequested&&revisionChurnCheckpointInjected&&!revisionChurnEscalated&&editRevision>=revisionChurnCheckpointRevision+4&&convergenceCheckpointCount>=revisionChurnConvergenceBaseline+2){
      conversation.push({role:"developer",content:`Trebell revision-churn escalation: ${editRevision} successful workspace edits have now accumulated after repeated convergence evidence. The next coherent workspace-edit response is the final grace repair batch for any already-known unmet requirement. After that, further workspace edits require fresh failing terminal evidence from the current revision; speculative edits will be blocked instead of resetting convergence budgets again. Batch related changes together. If there is no concrete failing evidence or unmet acceptance signal, finish from the evidence already gathered.`});
      revisionChurnEscalated=true;
      emit(onEvent,{name:"native.progress.revision_churn_escalation",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,checkpointRevision:revisionChurnCheckpointRevision,convergenceCheckpoints:convergenceCheckpointCount}});
    }
    const turnBudgetCheckpointAt=Math.min(36,Math.max(8,Math.ceil(budget.maxModelTurns*.75)));
    if(!turnBudgetCheckpointInjected&&modelTurns>=turnBudgetCheckpointAt&&modelTurns<budget.maxModelTurns){
      const remaining=Math.max(0,budget.maxModelTurns-modelTurns);
      conversation.push({role:"developer",content:`Trebell turn-budget checkpoint: ${modelTurns}/${budget.maxModelTurns} model turns are already used (${remaining} remain). Finish strategically instead of opening new broad investigation. ${workspaceMutationRequested&&editRevision===0?"This task requires workspace changes but none have been made yet: synthesize the evidence into the smallest viable implementation now; if a final evidence gap is essential, batch those probes in one response, then edit.":workspaceMutationRequested?"Focus only on acceptance-critical repair and verification for the current implementation; batch any remaining independent checks and then answer.":"Synthesize the evidence you already have; batch only essential remaining checks and then answer."}`});
      turnBudgetCheckpointInjected=true;
      emit(onEvent,{name:"native.progress.turn_budget_checkpoint",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,maxModelTurns:budget.maxModelTurns,remainingTurns:remaining,toolCalls,editRevision,workspaceMutationRequested}});
    }
    const remainingWallMs=deadlineAt==null?null:Math.max(0,deadlineAt-Date.now()),wallCheckpointAt=budget.maxWallTimeMs==null?null:Math.max(1,Math.floor(budget.maxWallTimeMs*.4));
    if(!wallBudgetCheckpointInjected&&remainingWallMs!=null&&wallCheckpointAt!=null&&remainingWallMs>0&&remainingWallMs<=wallCheckpointAt){
      const remainingSeconds=Math.max(1,Math.ceil(remainingWallMs/1000)),totalSeconds=Math.max(1,Math.ceil(budget.maxWallTimeMs/1000));
      conversation.push({role:"developer",content:`Trebell wall-time checkpoint: about ${remainingSeconds}s of the ${totalSeconds}s execution budget remain. Stop opening broad investigation. If the user explicitly named multiple routes, workflows, components, or acceptance surfaces, cover any still-untouched acceptance-critical surface before refining work that is already covered. ${workspaceMutationRequested&&editRevision===0?"This task requires workspace changes and none are recorded yet: make the smallest evidence-supported implementation now.":workspaceMutationRequested?"Prioritize acceptance-critical edits and one bounded verification sweep; leave a runnable artifact before the deadline.":"Synthesize the evidence already collected and finish with only essential remaining checks."}`});
      wallBudgetCheckpointInjected=true;
      emit(onEvent,{name:"native.progress.wall_budget_checkpoint",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,maxWallTimeMs:budget.maxWallTimeMs,remainingWallTimeMs:remainingWallMs,workspaceMutationRequested}});
    }
    if(applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"before_model"})){verifiedFinalizationAllowed=false;verifiedFinalizationReady=false}
    const missingExplicitTool=explicitlyRequired.find(item=>!executedToolKeys.has(item.namespace+"/"+item.name));
    const synthesizedVerifiedSummary=verifiedFinalizationReady&&verifiedFinalizationAllowed&&summaryAfterVerifiedCommand&&!missingExplicitTool?verifiedSummaryText(verifiedEdits):null;
    const synthesizedVerificationCompletion=verifiedFinalizationReady&&verifiedFinalizationAllowed&&verificationCompletionRequested&&!missingExplicitTool?verifiedCompletionText(verifiedEdits):null;
    const synthesizedVerifiedLiteral=verifiedFinalizationReady&&verifiedFinalizationAllowed&&literalAfterVerifiedCommand!=null&&!missingExplicitTool?literalAfterVerifiedCommand:null;
    const synthesizedVerifiedText=synthesizedVerifiedLiteral??synthesizedVerifiedSummary??synthesizedVerificationCompletion;
    if(synthesizedVerifiedText!=null){
      const exactLiteral=synthesizedVerifiedLiteral!=null,verificationCompletion=!exactLiteral&&synthesizedVerifiedSummary==null,text=synthesizedVerifiedText;conversation.push({role:"assistant",content:text,toolCalls:[]});
      const result={text,model:String(lastResponse?.model||model),provider:lastResponse?.provider||provider||null,messages:conversation,modelTurns,toolCalls,usage,startedAt,completedAt:Date.now(),durationMs:duration(started),lastResponse:null};
      emit(onEvent,{name:exactLiteral?"native.verification.literal_synthesized":verificationCompletion?"native.verification.completion_synthesized":"native.verification.summary_synthesized",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,changedPaths:[...new Set(verifiedEdits.map(edit=>edit.path))].slice(0,20)}});
      emit(onEvent,{name:"native.turn.completed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,durationMs:result.durationMs,usage,syntheticFinalSummary:!exactLiteral&&!verificationCompletion,syntheticFinalLiteral:exactLiteral,syntheticVerificationCompletion:verificationCompletion}});
      return result;
    }
    if(modelTurns>=budget.maxModelTurns){
      const successfulPostEditRun=workspaceMutationRequested&&editRevision>0&&!missingExplicitTool
        ?terminalRuns.findLast(item=>item?.exitCode===0&&item?.editRevision===editRevision)
        :null;
      if(successfulPostEditRun){
        const text="Applied workspace changes and completed a post-edit command successfully. The model-turn budget was reached before a final model wrap-up; broader task verification remains unconfirmed.";
        conversation.push({role:"assistant",content:text,toolCalls:[]});
        const result={text,model:String(lastResponse?.model||model),provider:lastResponse?.provider||provider||null,messages:conversation,modelTurns,toolCalls,usage,startedAt,completedAt:Date.now(),durationMs:duration(started),lastResponse:null};
        emit(onEvent,{name:"native.turn.completed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,durationMs:result.durationMs,usage,budgetFinalized:true,editRevision}});
        return result;
      }
      const error=new Error(`Native agent model-turn budget exhausted (${modelTurns}/${budget.maxModelTurns}).`);error.code="native_model_turn_budget";
      emit(onEvent,{name:"native.turn.blocked",status:"blocked",model:String(model),provider:provider||null,data:{reason:error.code,modelTurns,toolCalls}});throw error;
    }
    const toolBudgetExhausted=visibleTools.length>0&&toolCalls>=budget.maxToolCalls;
    if(toolBudgetExhausted){
      const missingRequired=explicitlyRequired.find(item=>!executedToolKeys.has(item.namespace+"/"+item.name));
      if(missingRequired){
        const error=new Error(`Native agent tool-call budget exhausted (${toolCalls}/${budget.maxToolCalls}) before required tool ${missingRequired.namespace}/${missingRequired.name} could run.`);error.code="native_tool_call_budget";
        emit(onEvent,{name:"native.turn.blocked",status:"blocked",model:String(model),provider:provider||null,data:{reason:error.code,modelTurns,toolCalls,namespace:missingRequired.namespace,name:missingRequired.name}});throw error;
      }
      if(!toolBudgetFinalizationInjected){
        conversation.push({role:"developer",content:"Trebell's tool-call budget for this turn is exhausted. All allowed tool work is finished and tool use is disabled for finalization. Do not request a tool, do not emit tool-call markup or imitate a function call in text, and do not repeat an earlier tool request. Respond only with the best concise user-visible final answer supported by the evidence already collected, clearly stating any remaining uncertainty or unverified work."});
        toolBudgetFinalizationInjected=true;
        emit(onEvent,{name:"native.tool_budget.finalizing",status:"completed",model:String(lastResponse?.model||model),provider:lastResponse?.provider||provider||null,data:{modelTurns,toolCalls,maxToolCalls:budget.maxToolCalls}});
      }
    }
    if(verifiedFinalizationReady&&!verifiedFinalizationInjected){
      conversation.push({role:"developer",content:verificationCompletionRequested?"The user's final requested action was to re-run verification until it passes. Trebell observed the same verifier command fail, then a successful workspace edit, then that exact command pass. That requested verification workflow is complete. Do not call another tool; respond now with the concise user-visible final answer supported by the evidence already collected.":"The user explicitly asked for the final answer after the verifier passes. Trebell observed the same verifier command fail, then a successful workspace edit, then that exact command pass. Verification tool work for that requested workflow is complete. Do not call another tool; respond now with the concise user-visible final answer supported by the evidence already collected."});
      verifiedFinalizationInjected=true;
    }
    modelTurns++;
    const requestStarted=nowMs(),requestMessageCount=conversation.length,forcedAllowlist=forcedToolChoice?[forcedToolChoice.namespace?forcedToolChoice.namespace+"/"+forcedToolChoice.name:forcedToolChoice.name]:null,completionGateMode=Boolean(completionGateCandidate),abstractionRepairVerificationGateMode=Boolean(abstractionRepairVerificationGateCandidate),controlGateMode=completionGateMode||abstractionRepairVerificationGateMode,convergenceFinalizationMode=convergenceFinalizationPending&&!controlGateMode,finalAnswerOnly=toolBudgetExhausted||verifiedFinalizationReady||controlGateMode||convergenceFinalizationMode,recoveryEditMode=completionRecoveryEditRequired&&!controlGateMode&&!finalAnswerOnly,implementationPressure=workspaceMutationRequested&&progressCheckpointInjected&&editRevision===0&&!finalAnswerOnly&&!forcedAllowlist,recoveryEditAllowlist=workspaceMutationRequested?["trebell_workspace/replace_text","trebell_workspace/write_file"]:["trebell_terminal/run","trebell_process/start"],requestTools=controlGateMode?(preserveToolSchemasOnFinalization?visibleTools:[]):finalAnswerOnly&&!preserveToolSchemasOnFinalization?[]:forcedAllowlist?providerVisibleTools(visibleTools,forcedAllowlist):visibleTools,requestToolChoice=finalAnswerOnly?"none":recoveryEditMode?"required":forcedToolChoice||toolChoice;
    const configuredMaxOutputTokens=maxOutputTokens!=null&&Number.isFinite(Number(maxOutputTokens))?Math.max(1,Math.trunc(Number(maxOutputTokens))):null;
    const pressureActionTurn=(implementationPressure||postEditEvidenceEscalated)&&!controlGateMode&&!finalAnswerOnly;
    const relaxActionCap=actionOutputCapRelaxOnce;actionOutputCapRelaxOnce=false;
    const actionOutputCapActive=pressureActionTurn&&!relaxActionCap&&(configuredMaxOutputTokens==null||configuredMaxOutputTokens>ACTION_TURN_MAX_OUTPUT_TOKENS);
    const actionOutputCap=actionOutputCapActive?ACTION_TURN_MAX_OUTPUT_TOKENS:null;
    const requestMaxOutputTokens=controlGateMode?(configuredMaxOutputTokens==null?2048:Math.min(configuredMaxOutputTokens,2048)):actionOutputCapActive?Math.min(configuredMaxOutputTokens??ACTION_TURN_MAX_OUTPUT_TOKENS,ACTION_TURN_MAX_OUTPUT_TOKENS):configuredMaxOutputTokens;
    const requestReasoningEffort=reasoningEffort;
    if(recoveryEditMode)emit(onEvent,{name:"native.completion.recovery_edit_required",status:"running",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,recoveryEpoch:completionRecoveryEpoch,visibleEditToolCount:exposedToolPairs(providerVisibleTools(visibleTools,recoveryEditAllowlist)).length,visibleToolCount:exposedToolPairs(requestTools).length,toolSchemaStable:true}});
    if(implementationPressure)emit(onEvent,{name:"native.progress.implementation_pressure",status:"running",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,visibleToolCount:exposedToolPairs(requestTools).length,blockedUntilFirstEdit:Math.max(0,exposedToolPairs(requestTools).filter(item=>!(item.namespace==="trebell_workspace"&&["write_file","replace_text"].includes(item.name))).length),toolSchemaStable:true}});
    if(actionOutputCapActive)emit(onEvent,{name:"native.model.action_output_cap",status:"running",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,maxOutputTokens:actionOutputCap,reason:implementationPressure?"implementation_pressure":"post_edit_evidence_escalation"}});
    let providerMessages=conversation,providerView=null;
    if(typeof prepareProviderMessages==="function"){
      const prepared=prepareProviderMessages(conversation);
      if(Array.isArray(prepared))providerMessages=prepared;
      else if(Array.isArray(prepared?.messages)){providerMessages=prepared.messages;providerView=prepared}
    }
    const requestMetrics=nativeRequestMetrics(providerMessages,requestTools,{toolSchemaCache:requestMetricsToolCache,messageSerializationCache:requestMetricsMessageCache,currentTurnBreakdownCache:requestMetricsCurrentTurnCache,historyHashCache:requestMetricsHistoryHashCache,messageClassificationCache:requestMetricsClassificationCache});
    const inferenceId=(metadata?.sessionId?String(metadata.sessionId):"native")+":inference:"+modelTurns;
    if(Number(providerView?.count||0)>0)emit(onEvent,{name:"native.context.provider_view_compacted",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,count:Number(providerView.count||0),savedChars:Number(providerView.savedChars||0)}});
    emit(onEvent,{name:"native.model.requested",status:"running",model:String(model),provider:provider||null,data:{inferenceId,modelTurn:modelTurns,messageCount:providerMessages.length,toolCount:Array.isArray(requestTools)?requestTools.length:0,sessionId:metadata?.sessionId||null,compaction:Boolean(metadata?.compaction),completionGate:completionGateMode,abstractionRepairVerificationGate:abstractionRepairVerificationGateMode,requestMetrics}});
    const providerAttempts=boundedInteger(maxProviderAttempts,3,{min:1,max:8});let response=null;
    for(let attempt=1;attempt<=providerAttempts;attempt++){
      try{
        response=await providerTurn({model,provider,messages:providerMessages,tools:requestTools,toolChoice:requestToolChoice,maxOutputTokens:requestMaxOutputTokens,temperature,reasoningEffort:requestReasoningEffort,parallelToolCalls,signal:turnSignal,metadata:controlGateMode?{...(metadata&&typeof metadata==="object"?metadata:{}),completionGate:true,abstractionRepairVerificationGate:abstractionRepairVerificationGateMode}:metadata,[NATIVE_TOOL_SCHEMA_FINGERPRINT]:requestMetrics[NATIVE_TOOL_SCHEMA_FINGERPRINT]||null,[NATIVE_OPENAI_CONTINUATION_IDENTITY]:openAiContinuationIdentity,[NATIVE_CHAT_MESSAGE_CACHE_IDENTITY]:openAiContinuationIdentity});break;
      }catch(error){
        if(error?.nativeSteered){
          if(applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"model_request_interrupted"})){
            modelTurns=Math.max(0,modelTurns-1);
            emit(onEvent,{name:"native.model.interrupted",status:"steered",model:String(model),provider:provider||null,data:{attempt,reason:"steering"}});
            response=null;break;
          }
          throw error;
        }
        if(turnSignal?.aborted||error?.name==="AbortError")throw abortError(turnSignal);
        const retryable=nativeProviderRetryable(error),last=attempt>=providerAttempts;
        if(!retryable||last)throw error;
        const delay=Math.max(0,Math.min(10_000,Math.trunc(Number(retryBaseDelayMs)||0)*2**(attempt-1)));
        emit(onEvent,{name:"native.model.retrying",status:"retrying",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,attempt,nextAttempt:attempt+1,maxAttempts:providerAttempts,delayMs:delay,status:Number(error.status||error.statusCode||0)||null,code:error.code||null,message:String(error.message||error).slice(0,500),providerTelemetry:error?.telemetry||null}});
        await retryDelay(delay,turnSignal);
      }
    }
    if(response==null)continue;
    lastProviderReadMessageCount=requestMessageCount;
    forcedToolChoice=null;
    throwIfAborted(turnSignal);lastResponse=response||{};usage=aggregateUsage(usage,lastResponse.usage||{});
    const rawCalls=Array.isArray(lastResponse.toolCalls)?lastResponse.toolCalls:[],repairPairs=rawCalls.length?exposedToolPairs(requestTools):null,calls=rawCalls.map(call=>{
      const normalized=repairCorruptedToolCall(call,requestTools,repairPairs);
      if(normalized.repaired)emit(onEvent,{name:"native.tool.call_repaired",status:"completed",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{namespace:String(call?.namespace||""),repairedNamespace:String(normalized.call?.namespace||""),malformedNameLength:String(normalized.originalName||"").length,name:String(normalized.call?.name||""),reason:normalized.reason||"corruption"}});
      const repairedArgs=repairRepeatedTerminalCommand(normalized.call,successfulTerminalRuns);
      if(repairedArgs.repaired)emit(onEvent,{name:"native.tool.call_repaired",status:"completed",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{namespace:"trebell_terminal",repairedNamespace:"trebell_terminal",malformedNameLength:0,name:"run",reason:repairedArgs.reason}});
      return repairedArgs.call;
    });
    const providerTelemetry=lastResponse.telemetry||null,turnUsage=lastResponse.usage||{},inputTokens=Number(turnUsage.inputTokens||0),cachedTokens=Number(turnUsage.cachedInputTokens||0),contextWindow=Number(metadata?.contextWindow||0);
    emit(onEvent,{name:"native.model.completed",status:"completed",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{
      inferenceId,modelTurn:modelTurns,durationMs:duration(requestStarted),toolCallCount:calls.length,finishReason:lastResponse.finishReason||null,usage:turnUsage,
      requestMetrics,providerTelemetry,
      cacheHitPercent:inputTokens>0?Number(((cachedTokens/inputTokens)*100).toFixed(2)):0,
      contextWindowUtilizationPercent:contextWindow>0&&inputTokens>0?Number(((inputTokens/contextWindow)*100).toFixed(2)):null,
      sessionId:metadata?.sessionId||null,compaction:Boolean(metadata?.compaction),
    }});
    if(applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"after_model"})){verifiedFinalizationAllowed=false;verifiedFinalizationReady=false;continue}
    const responseText=String(lastResponse.text||"");
    const actionCapLimitReason=actionOutputCapActive&&!calls.length?outputLimitFinishReason(lastResponse):null;
    if(actionCapLimitReason&&modelTurns<budget.maxModelTurns){
      actionOutputCapRelaxOnce=true;
      conversation.push({role:"developer",content:"Trebell's bounded action-turn output allowance was reached before a tool action or complete answer was produced. The next request is allowed the original output budget. Use the evidence already gathered and take the intended concrete action now, or state the specific blocker; do not reopen broad investigation merely because the bounded attempt ended."});
      emit(onEvent,{name:"native.model.action_output_cap_relaxed",status:"retrying",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,maxOutputTokens:actionOutputCap,finishReason:actionCapLimitReason,reason:implementationPressure?"implementation_pressure":"post_edit_evidence_escalation"}});
      continue;
    }
    if(verifiedFinalizationReady&&calls.length){
      if(verifiedFinalizationRecoveries<1&&modelTurns<budget.maxModelTurns){
        verifiedFinalizationRecoveries++;
        conversation.push({role:"developer",content:"Tool use is disabled because the user-requested verifier already passed after the edit. Do not request or imitate a tool call. Respond now with the concise final answer."});
        emit(onEvent,{name:"native.verification.finalization_retry",status:"retrying",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,recoveryAttempt:verifiedFinalizationRecoveries}});
        continue;
      }
      const error=new Error("Native provider requested another tool after explicit verifier completion and no finalization retry remained.");error.code="native_invalid_verified_finalization";
      emit(onEvent,{name:"native.turn.blocked",status:"blocked",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{reason:error.code,modelTurns,toolCalls}});throw error;
    }
    if(toolBudgetExhausted&&!calls.length&&toolCallMarkupOnly(responseText)){
      if(toolBudgetTextRecoveries<1&&modelTurns<budget.maxModelTurns){
        toolBudgetTextRecoveries++;
        conversation.push({role:"assistant",content:responseText,toolCalls:[]});
        conversation.push({role:"developer",content:"The previous response was tool-call markup, but Trebell has no tool budget or tool schemas remaining. Do not imitate a tool call. Respond now with plain user-visible final text based only on the evidence already available."});
        emit(onEvent,{name:"native.tool_budget.finalization_retry",status:"retrying",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,recoveryAttempt:toolBudgetTextRecoveries}});
        continue;
      }
      const error=new Error("Native provider emitted tool-call markup after the tool budget was exhausted and no finalization retry remained.");error.code="native_invalid_tool_budget_finalization";
      emit(onEvent,{name:"native.turn.blocked",status:"blocked",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{reason:error.code,modelTurns,toolCalls}});throw error;
    }
    if(!controlGateMode&&!calls.length&&!responseText.trim()){
      if(emptyCompletionRecoveries<1&&modelTurns<budget.maxModelTurns){
        emptyCompletionRecoveries++;
        conversation.push({role:"developer",content:"The previous provider response contained no tool calls and no user-visible assistant text. Complete the user's task with a concise final answer now. Do not repeat completed tool calls unless they are genuinely needed for accuracy."});
        emit(onEvent,{name:"native.model.empty_completion",status:"retrying",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,recoveryAttempt:emptyCompletionRecoveries}});
        continue;
      }
      const error=new Error("Native provider returned an empty terminal response after the bounded final-answer recovery attempt.");error.code="native_empty_completion";
      emit(onEvent,{name:"native.turn.blocked",status:"blocked",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{reason:error.code,modelTurns,toolCalls}});
      throw error;
    }
    conversation.push({role:"assistant",content:responseText,toolCalls:calls});
    if(!calls.length){
      if(abstractionRepairVerificationGateCandidate){
        const candidate=abstractionRepairVerificationGateCandidate,verdict=parseAbstractionRepairVerificationVerdict(responseText);
        if(!verdict){
          if(abstractionRepairVerificationGateInvalidResponses<1&&modelTurns<budget.maxModelTurns){
            abstractionRepairVerificationGateInvalidResponses++;
            conversation.length=candidate.conversationLength;
            conversation.push({role:"developer",content:"Trebell abstraction-repair verification parser could not read the previous control response. Return only one valid JSON object with exactly these fields: {\"status\":\"verified|failed|uncertain\",\"reason\":\"brief evidence-based rationale\"}. Use verified only when the independent recheck positively establishes that the challenged invariant now holds. Do not call tools and do not address the user."});
            emit(onEvent,{name:"native.progress.abstraction_repair_verification_gate_retry",status:"retrying",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,abstractionRepairRevision,invalidResponses:abstractionRepairVerificationGateInvalidResponses}});
            continue;
          }
          conversation.length=candidate.conversationLength;abstractionRepairVerificationGateCandidate=null;abstractionRepairVerificationGateInvalidResponses=0;
          conversation.push({role:"developer",content:"Trebell could not establish that the challenged upstream abstraction was repaired. Keep the abstraction-repair verification lock active. Do not descend into residual/local-layout search yet. Use the independent recheck evidence already collected to revise the upstream framing/order/mapping/schema/units/state interpretation, or run a materially different independent source-of-truth check if the prior recheck was inconclusive."});
          emit(onEvent,{name:"native.progress.abstraction_repair_verification_gate",status:"blocked",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,abstractionRepairRevision,verdict:"uncertain",reason:"invalid_control_response"}});
          continue;
        }
        conversation.length=candidate.conversationLength;abstractionRepairVerificationGateCandidate=null;abstractionRepairVerificationGateInvalidResponses=0;
        emit(onEvent,{name:"native.progress.abstraction_repair_verification_gate",status:verdict.status==="verified"?"completed":"blocked",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,abstractionRepairRevision,verdict:verdict.status,reason:verdict.reason}});
        if(verdict.status==="verified"){
          abstractionRepairVerificationPending=false;
          emit(onEvent,{name:"native.progress.abstraction_repair_verified",status:"completed",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,abstractionRepairRevision,reason:verdict.reason}});
          continue;
        }
        conversation.push({role:"developer",content:"Trebell's abstraction-repair verification gate did not verify the challenged upstream interpretation. Stay at the upstream abstraction layer. Do not enter residual/local-layout search and do not compensate downstream for a contradiction that still exists. Use the independent recheck evidence to make another upstream repair, or obtain a materially different source-of-truth check that can establish the invariant. Gate verdict: "+verdict.status+(verdict.reason?". "+verdict.reason:"")});
        continue;
      }
      if(completionGateCandidate){
        completionGateChecks++;
        const candidate=completionGateCandidate,verdict=parseCompletionGateVerdict(responseText);
        if(!verdict){
          if(completionGateInvalidResponses<1&&modelTurns<budget.maxModelTurns){
            completionGateInvalidResponses++;
            conversation.length=candidate.conversationLength;
            conversation.push({role:"developer",content:"Trebell completion gate parser could not read the previous control response. Return only one valid JSON object with exactly these fields: {\"status\":\"complete|incomplete|blocked\",\"progress\":\"improved|unchanged|regressed|uncertain\",\"edit_support\":\"supported|unsupported|uncertain\",\"mutation_safety\":\"allowed|forbidden|uncertain\",\"unresolved\":[\"...\"],\"reason\":\"...\"}. Do not call tools and do not address the user."});
            emit(onEvent,{name:"native.completion.gate_retry",status:"retrying",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,invalidResponses:completionGateInvalidResponses}});
            continue;
          }
          conversation.length=candidate.conversationLength;completionGateCandidate=null;completionGateInvalidResponses=0;completionGateRecoveries++;
          conversation.push({role:"developer",content:"Trebell completion gate could not establish that the proposed final answer is complete. Continue the task instead of finalizing. Re-read the user's requirements and the strongest recent evidence, identify the single most important unresolved acceptance condition, and use the available tools to resolve or decisively falsify it. Do not weaken the user's requirement merely because the prior control response was malformed."});
          emit(onEvent,{name:"native.completion.gate",status:"retrying",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,verdict:"invalid",recoveryAttempt:completionGateRecoveries}});
          continue;
        }
        conversation.length=candidate.conversationLength;completionGateCandidate=null;completionGateInvalidResponses=0;
        if(completionRecoveryIncumbent&&completionRecoveryIncumbent.editRevision===editRevision&&["improved","regressed"].includes(verdict.progress)){
          const reportedProgress=verdict.progress;verdict.progress="unchanged";
          emit(onEvent,{name:"native.completion.recovery_progress_normalized",status:"completed",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,recoveryEpoch:completionRecoveryEpoch,reportedProgress,normalizedProgress:"unchanged",incumbentEditRevision:completionRecoveryIncumbent.editRevision}});
        }
        if(verdict.mutationSafety==="forbidden"&&verdict.editSupport==="supported"){
          verdict.editSupport="unsupported";
          emit(onEvent,{name:"native.completion.recovery_mutation_support_normalized",status:"completed",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,recoveryEpoch:completionRecoveryEpoch,reason:"mutation_forbidden"}});
        }
        completionRecoveryMutationForbidden=verdict.mutationSafety==="forbidden";
        emit(onEvent,{name:"native.completion.gate",status:verdict.status==="complete"?"completed":verdict.status==="blocked"?"blocked":"retrying",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,verdict:verdict.status,progress:verdict.progress,editSupport:verdict.editSupport,mutationSafety:verdict.mutationSafety,unresolved:verdict.unresolved,reason:verdict.reason}});
        if(verdict.status==="complete"||verdict.status==="blocked"){
          const result={
            text:candidate.text,model:candidate.model,provider:candidate.provider,
            messages:conversation,modelTurns,toolCalls,usage,startedAt,completedAt:Date.now(),durationMs:duration(started),lastResponse:candidate.lastResponse,
          };
          emit(onEvent,{name:"native.turn.completed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,durationMs:result.durationMs,usage,completionGateVerdict:verdict.status}});
          return result;
        }
        if(!completionRecoveryIncumbent){
          completionRecoveryIncumbent={editRevision,unresolved:[...verdict.unresolved],reason:verdict.reason};
          completionRecoveryIncumbentWorkspaceAligned=true;
          completionRecoveryEditTransaction=null;
          emit(onEvent,{name:"native.completion.recovery_incumbent_established",status:"completed",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,recoveryEpoch:completionRecoveryEpoch}});
        }else if(verdict.progress==="improved"){
          completionRecoveryIncumbent={editRevision,unresolved:[...verdict.unresolved],reason:verdict.reason};
          completionRecoveryIncumbentWorkspaceAligned=true;
          completionRecoveryEditTransaction=null;
          emit(onEvent,{name:"native.completion.recovery_incumbent_advanced",status:"completed",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,recoveryEpoch:completionRecoveryEpoch}});
        }else if(candidate.residualMonotonicRecovery&&candidate.recoveryTransaction&&["unchanged","regressed","uncertain"].includes(verdict.progress)){
          const restore=await restoreRecoveryEditTransaction(candidate.recoveryTransaction);
          if(restore.restored){
            const rejectedRevision=editRevision;editRevision++;
            if(Number.isInteger(candidate.recoveryTransaction?.verifiedEditsLengthBefore))verifiedEdits.length=Math.min(verifiedEdits.length,Math.max(0,candidate.recoveryTransaction.verifiedEditsLengthBefore));
            completionRecoveryIncumbentRestores++;
            completionRecoveryIncumbentWorkspaceAligned=true;
            completionRecoveryEditTransaction=null;
            singletonTerminalProbeStreak=0;postEditProbeBatchingRequired=false;postEditEvidenceRounds=0;postEditAssumptionAuditRevision=0;postEditAbstractionEscalationRevision=0;postEditEvidenceCheckpointRevision=0;postEditEvidenceEscalated=false;
            postEditResidualStructureRevision=editRevision;
            conversation.push({role:"developer",content:`Trebell restored the stronger evidence-backed recovery incumbent because the isolated residual candidate was ${verdict.progress}, not an independently supported improvement. Continue from the restored workspace state. This rollback does not grant extra recovery evidence or edit budget.`});
            emit(onEvent,{name:"native.completion.recovery_incumbent_restored",status:"completed",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,rejectedRevision,recoveryEpoch:completionRecoveryEpoch,progress:verdict.progress,pathCount:restore.paths.length,incumbentEditRevision:completionRecoveryIncumbent?.editRevision??null}});
          }else{
            completionRecoveryIncumbentWorkspaceAligned=false;
            completionRecoveryEditTransaction=null;
            emit(onEvent,{name:"native.completion.recovery_incumbent_restore_failed",status:"uncertain",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,recoveryEpoch:completionRecoveryEpoch,progress:verdict.progress,reason:restore.reason}});
          }
        }else if(candidate.recoveryTransaction){
          completionRecoveryIncumbentWorkspaceAligned=verdict.progress==="unchanged";
          completionRecoveryEditTransaction=null;
        }
        const externalStateRegressed=!workspaceMutationRequested&&taskMutationRequested&&completionRecoveryIncumbent&&verdict.progress==="regressed"&&Number(completionRecoveryIncumbent.editRevision)<editRevision;
        if(externalStateRegressed){
          completionRecoveryIncumbentWorkspaceAligned=false;
          completionRecoveryEditResponsesRemaining=Math.max(1,completionRecoveryEditResponsesRemaining);
          completionRecoveryEditRequired=true;
          completionRecoveryEditRequiredMisses=0;
          conversation.push({role:"developer",content:"Trebell detected that the latest external/runtime state regressed relative to the strongest evidence-backed recovery incumbent. Automatic rollback is not safe for arbitrary external systems. Before exploring another candidate or finalizing, use the available state-changing tool to restore the prior stronger state when reversible, or apply a different evidence-supported correction that is demonstrably no worse. Do not leave a known-regressed external state active merely because the recovery epoch is ending. Re-use the concrete prior state/configuration already present in the conversation/tool history rather than inventing values."});
          emit(onEvent,{name:"native.completion.recovery_external_restore_required",status:"retrying",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,recoveryEpoch:completionRecoveryEpoch,incumbentEditRevision:completionRecoveryIncumbent.editRevision,progress:verdict.progress}});
          continue;
        }
        if(!workspaceMutationRequested&&taskMutationRequested&&completionRecoveryIncumbent&&verdict.progress==="unchanged"&&Number(completionRecoveryIncumbent.editRevision)<editRevision){
          completionRecoveryIncumbentWorkspaceAligned=true;
          emit(onEvent,{name:"native.completion.recovery_external_incumbent_restored",status:"completed",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,recoveryEpoch:completionRecoveryEpoch,incumbentEditRevision:completionRecoveryIncumbent.editRevision}});
        }
        completionGateRecoveries++;
        const unsupportedRecoveryEdit=completionRecoveryEpoch>0&&completionRecoveryEvidenceRoundsRemaining<=0&&completionRecoveryEditResponsesRemaining>0&&completionRecoverySupportVerificationRemaining<=0&&verdict.editSupport==="unsupported";
        if(unsupportedRecoveryEdit){
          completionRecoveryEditResponsesRemaining=0;
          completionRecoveryEditRequired=false;
          completionRecoveryEditRequiredMisses=0;
          completionRecoverySupportWritesRemaining=0;
          conversation.push({role:"developer",content:completionRecoveryMutationForbidden
            ?"Trebell closed the current recovery epoch without forcing another mutation because the semantic gate identified the current phase/state as mutation-forbidden. Preserve the already-satisfied invariant. Do not issue a same-value reassertion or other state-changing call merely to consume recovery allowance; such attempts can themselves violate protected windows or terminal-state rules. Advance only with non-mutating evidence or finalization."
            :"Trebell closed the current recovery epoch without forcing a speculative workspace edit because the semantic gate explicitly found that the exhausted evidence does not support a corrective edit in this hypothesis class. Do not mutate merely to consume an allowance. Advance to the next bounded recovery strategy from the preserved evidence-backed workspace state."});
          emit(onEvent,{name:"native.completion.recovery_edit_skipped",status:"completed",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,recoveryEpoch:completionRecoveryEpoch,reason:completionRecoveryMutationForbidden?"mutation_forbidden":"unsupported_by_evidence",unresolved:verdict.unresolved}});
        }
        const unresolvedRecoveryEdit=completionRecoveryEpoch>0&&completionRecoveryEvidenceRoundsRemaining<=0&&completionRecoveryEditResponsesRemaining>0;
        if(unresolvedRecoveryEdit){
          completionRecoveryEditRequired=true;
          completionRecoveryEditRequiredMisses=0;
          const unresolved=verdict.unresolved.length?verdict.unresolved.map(item=>"- "+item).join("\n"):"- Re-evaluate the user's material acceptance requirements against the evidence.";
          const reason=verdict.reason?"\nGate rationale: "+verdict.reason:"";
          const correctiveDebtText=externalStateMutationRequested
            ?"Trebell semantic completion gate still finds the task incomplete, but the current recovery epoch has already consumed its bounded evidence allowance and still owes one corrective state-changing action. Do not run more probes and do not propose completion again yet. Use the evidence already gathered to make one evidence-supported state-changing action against the actual external/runtime target. Do not substitute a scratch/support file for the required state correction."
            :"Trebell semantic completion gate still finds the task incomplete, but the current recovery epoch has already consumed its bounded evidence allowance and still owes one corrective implementation edit. Do not run more probes and do not propose completion again yet. Use the evidence already gathered to make one evidence-supported change to the actual implementation/deliverable. Trebell will expose only workspace edit tools on the next turn. If a newly-created support file is attempted instead, it will not discharge this edit debt.";
          conversation.push({role:"developer",content:correctiveDebtText+"\nUnresolved requirements:\n"+unresolved+reason});
          emit(onEvent,{name:"native.completion.gate_recovery",status:"retrying",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,recoveryAttempt:completionGateRecoveries,recoveryEpoch:completionRecoveryEpoch,evidenceRoundsAllowed:0,editResponsesAllowed:completionRecoveryEditResponsesRemaining,editRequired:true,unresolved:verdict.unresolved}});
          continue;
        }
        const finalEpochOrdinaryEvidenceRemaining=completionRecoveryEpoch>0&&completionRecoveryEvidenceRoundsRemaining>0&&completionRecoveryEpoch>=completionRecoveryEpochLimit&&completionRecoveryEditResponsesRemaining<=0;
        if(finalEpochOrdinaryEvidenceRemaining){
          conversation.push({role:"developer",content:"The current bounded recovery epoch still has evidence allowance remaining. Continue in this same epoch and use only the remaining focused evidence on the unresolved acceptance condition before proposing completion again."});
          emit(onEvent,{name:"native.completion.gate_recovery",status:"retrying",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,recoveryAttempt:completionGateRecoveries,recoveryEpoch:completionRecoveryEpoch,evidenceRoundsAllowed:completionRecoveryEvidenceRoundsRemaining,postEditEvidenceRoundsAllowed:completionRecoveryPostEditEvidenceResponsesRemaining,supportVerificationAllowed:completionRecoverySupportVerificationRemaining,editResponsesAllowed:completionRecoveryEditResponsesRemaining,sameEpoch:true,unresolved:verdict.unresolved}});
          continue;
        }
        if(completionRecoveryEpoch>=completionRecoveryEpochLimit){
          const unresolved=verdict.unresolved.length?verdict.unresolved:["A material acceptance condition remains unresolved."];
          const stateLabel=workspaceMutationRequested?"workspace state":"task state";
          const preservation=completionRecoveryIncumbentWorkspaceAligned?`The strongest evidence-backed ${stateLabel} has been preserved or restored`:`The current ${stateLabel} could not be proven equivalent to the strongest evidence-backed recovery incumbent`;
          const exhaustionText=`Trebell stopped after ${completionRecoveryEpochLimit} bounded semantic recovery epochs because the completion gate still found the task incomplete. ${preservation}, and completion is not verified. Unresolved: ${unresolved.join("; ")}`;
          conversation.push({role:"developer",content:`Trebell exhausted its bounded semantic completion-recovery budget (${completionRecoveryEpochLimit} epochs). The immediately preceding candidate was not accepted as complete. ${completionRecoveryIncumbentWorkspaceAligned?`The stronger evidence-backed recovery incumbent is the current ${stateLabel}.`:`The current ${stateLabel} may differ from the strongest evidence-backed recovery incumbent because a safe rollback could not be established.`} Do not treat the rejected candidate as verified completion on a later turn unless new evidence resolves the remaining acceptance gap.`});
          const result={
            text:exhaustionText,model:candidate.model,provider:candidate.provider,
            messages:conversation,modelTurns,toolCalls,usage,startedAt,completedAt:Date.now(),durationMs:duration(started),lastResponse:candidate.lastResponse,
          };
          emit(onEvent,{name:"native.completion.recovery_exhausted",status:"blocked",model:result.model,provider:result.provider,data:{modelTurn:modelTurns,toolCalls,editRevision,recoveryAttempt:completionGateRecoveries,recoveryEpoch:completionRecoveryEpoch,maxRecoveryEpochs:completionRecoveryEpochLimit,unresolved:verdict.unresolved,incumbentRestores:completionRecoveryIncumbentRestores,incumbentWorkspaceAligned:completionRecoveryIncumbentWorkspaceAligned}});
          emit(onEvent,{name:"native.turn.completed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,durationMs:result.durationMs,usage,completionGateVerdict:"incomplete",completionRecoveryExhausted:true}});
          return result;
        }
        completionRecoveryEpoch++;
        const immediateSupportedRecoveryEdit=verdict.editSupport==="supported";
        completionRecoveryEvidenceRoundsRemaining=immediateSupportedRecoveryEdit?0:2;
        completionRecoveryEditResponsesRemaining=1;
        completionRecoveryPostEditEvidenceResponsesRemaining=0;
        completionRecoveryEditRequired=immediateSupportedRecoveryEdit;
        if(completionRecoveryMutationForbidden){completionRecoveryEditResponsesRemaining=0;completionRecoveryEditRequired=false}
        completionRecoveryEditRequiredMisses=0;
        completionRecoverySupportWritesRemaining=1;
        completionRecoverySupportVerificationRemaining=0;
        completionRecoveryImplementationPaths=new Set(verifiedEdits.filter(item=>item&&!item.supportOnly).map(item=>String(item.path||"").trim().replace(/\\/g,"/")).filter(Boolean));
        const unresolved=verdict.unresolved.length?verdict.unresolved.map(item=>"- "+item).join("\n"):"- Re-evaluate the user's material acceptance requirements against the evidence.";
        const reason=verdict.reason?"\nGate rationale: "+verdict.reason:"";
        const recoveryStart=externalStateMutationRequested
          ?immediateSupportedRecoveryEdit
            ?"The semantic gate already found concrete corrective support, so do not spend extra model rounds gathering generic evidence before acting. Make one coherent evidence-supported corrective state-changing action against the actual task target now; a single post-action verification response is reserved afterward."
            :"This starts a bounded semantic-recovery window: up to two focused evidence-bearing tool responses and one evidence-supported corrective state-changing action against the actual task target may proceed even if older convergence or evidence guards had already escalated for the current revision. If both ordinary evidence responses are spent before the corrective action, one additional post-action evidence response is reserved only to verify that repair before proposing the next completion candidate."
          :immediateSupportedRecoveryEdit
            ?"The semantic gate already found concrete edit support, so do not spend extra model rounds gathering generic evidence before acting. Make one coherent evidence-supported corrective implementation/deliverable edit now; a single post-edit verification response is reserved afterward."
            :"This starts a bounded semantic-recovery window: up to two focused evidence-bearing tool responses and one evidence-supported corrective implementation edit may proceed even if older convergence, post-edit evidence, or revision-churn guards had already escalated for the current revision. If both ordinary evidence responses are spent before the corrective edit, one additional post-edit evidence response is reserved only to verify that repair before proposing the next completion candidate.";
        conversation.push({role:"developer",content:"Trebell semantic completion gate rejected the proposed final answer as incomplete. Continue working; do not simply restate the candidate answer. Resolve the highest-value unmet requirement using the evidence and tools already available. When one unresolved requirement is a prerequisite semantic validity constraint or objective/priority condition and another is merely downstream persistence, packaging, publication, or application of that candidate, resolve the prerequisite semantic requirement first; do not commit hard-to-reverse state merely to create evidence for a candidate whose acceptance-critical semantics remain unverified. "+recoveryStart+" A newly-created support/scratch/diagnostic workspace file does not consume or reset the corrective implementation edit; prefer inline or batched terminal diagnostics when practical. At most one new support-file write gets a one-shot verification opportunity after the ordinary evidence allowance is exhausted. Use these allowances only on the unresolved acceptance condition, not on broad exploration. If the evidence contradicts a shared premise behind the recent attempts, falsify that premise with an observation that does not depend on the same premise before changing layers or trying more variants. The premise may concern the algorithm or problem family, an input or API contract, environment behavior, state, units, ordering, or another task-specific assumption. If it survives the independent check, keep the strongest remaining hypothesis instead of inventing a new abstraction problem.\nUnresolved requirements:\n"+unresolved+reason});
        if(completionRecoveryEpoch>=3&&completionRecoveryEpoch%3===0){
          const residualFactorizationReady=abstractionRepairRevision>0&&!pendingAbstractionRepair&&!abstractionRepairVerificationPending&&postEditResidualStructureRevision>=abstractionRepairRevision;
          const recoveryStrategy=residualFactorizationReady?"residual_factorization":"abstraction_reset";
          if(residualFactorizationReady){
            conversation.push({role:"developer",content:"Trebell cross-epoch residual factorization reset: the upstream abstraction has already survived an independent repair verification and the remaining defect has already been localized to a smaller specialized producer/consumer family. Do not reopen global framing without new contradictory raw evidence, and do not spend this epoch on another Cartesian product, whole-family permutation sweep, or coupled layout guess. Treat the residual as a composite contract and isolate its orthogonal transform dimensions. Examples include axis orientation or transpose, within-record packing/interleave/pair order, gather/concat dimension, shard or block order, local-versus-global index mapping, dtype/unit convention, and producer-specific specialization. Hold all other dimensions fixed while testing one component at a time against the strongest acceptance metric or independent source invariant. Prefer a bounded discriminator that measures the incremental effect of replacing only that one component. If one isolated transform causes a material improvement, preserve it while testing the next component; combine transforms only after each component is independently supported. A specialized fused/grouped/kernel path may legitimately differ from a dense/shared sibling, so derive each component from its actual producer/consumer path rather than semantic-name analogy. This reset changes the method, not the recovery budget."});
          }else{
            conversation.push({role:"developer",content:"Trebell cross-epoch recovery strategy reset: the task has remained semantically incomplete through "+completionRecoveryEpoch+" bounded recovery epochs. Do not spend this epoch on another parameter sweep, permutation, retry, or minor variant of the same hypothesis class unless new evidence specifically distinguishes it. Re-anchor at the earliest shared premise behind the failed attempts and test that premise independently. It may be the chosen algorithm or problem family, a requirement interpretation, input or API contract, environment or dependency behavior, state transition, units, ordering, or another task-specific assumption. If that premise survives, localize to the smallest failing subproblem and derive its contract from direct evidence. Prefer one hypothesis that explains several discrepancies simultaneously. This reset changes the method, not the recovery budget."});
          }
          emit(onEvent,{name:"native.completion.recovery_strategy_reset",status:"completed",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,recoveryAttempt:completionGateRecoveries,recoveryEpoch:completionRecoveryEpoch,strategy:recoveryStrategy}});
        }
        emit(onEvent,{name:"native.completion.gate_recovery",status:"retrying",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,recoveryAttempt:completionGateRecoveries,recoveryEpoch:completionRecoveryEpoch,evidenceRoundsAllowed:completionRecoveryEvidenceRoundsRemaining,editResponsesAllowed:completionRecoveryEditResponsesRemaining,unresolved:verdict.unresolved}});
        continue;
      }
      const canVerifyLocally=directVisiblePairs.some(item=>item.namespace==="trebell_terminal"&&item.name==="run");
      const hasSelfVerificationGap=selfAdmittedVerificationGap(responseText),hasFailedAcceptanceGap=selfAdmittedFailedAcceptanceGap(responseText);
      const hasSelfCompletionGap=selfAdmittedCompletionGap(responseText),selfAdmittedGapKind=hasSelfCompletionGap?"completion":hasSelfVerificationGap?"verification":null;
      const priorSelfAdmittedGapRecoveryUsedTool=selfAdmittedGapRecoveries>0&&toolCalls>selfAdmittedGapRecoveryToolBaseline;
      const shouldRecoverSelfAdmittedGap=selfAdmittedGapRecoveries===0||priorSelfAdmittedGapRecoveryUsedTool;
      const preEditCompletionBlockerChallenge=hasSelfCompletionGap&&editRevision===0&&selfAdmittedGapRecoveries===0;
      const selfAdmittedGapCanRecover=preEditCompletionBlockerChallenge||editRevision>0;
      const maxSelfAdmittedGapRecoveries=hasFailedAcceptanceGap?3:2;
      if(completionRecoveryEpoch===0&&taskMutationRequested&&selfAdmittedGapCanRecover&&canVerifyLocally&&!toolBudgetExhausted&&(!verifiedFinalizationReady||hasFailedAcceptanceGap)&&selfAdmittedGapRecoveries<maxSelfAdmittedGapRecoveries&&shouldRecoverSelfAdmittedGap&&modelTurns<budget.maxModelTurns&&selfAdmittedGapKind){
        selfAdmittedGapRecoveries++;
        selfAdmittedGapRecoveryToolBaseline=toolCalls;
        const recoveryMessage=preEditCompletionBlockerChallenge
          ? "Your previous draft concludes that a required mutation, restoration, or reconstruction cannot be completed before any confirmed workspace edit. Before accepting that blocker, do one bounded falsification pass. Do not fabricate, approximate, substitute, or weaken an exact-data requirement. Test whether the intended state can be reconstructed from local evidence already present: reversible transforms or mappings, internal redundancy, peer/majority consistency, deterministic encodings, checksums or metadata, logs/history, or other invariants that distinguish the intended state. Prefer one batched script or focused tool response that compares the strongest remaining hypotheses. If exact recovery is supported, implement it and exercise the requested acceptance path; if not, end with the blocker and the decisive negative evidence."
          : selfAdmittedGapKind==="verification"&&hasFailedAcceptanceGap&&selfAdmittedGapRecoveries===1
            ? "Your previous draft says a required acceptance or verification check actually failed, so the task is not complete. Do not merely rerun the same failing check or weaken its acceptance criterion. Treat the failure as diagnostic evidence: identify the earliest or most specific mismatch you can measure, compare the strongest remaining hypotheses in one bounded batched probe, make the evidence-supported repair, and rerun the exact acceptance path. If the failure contradicts a shared premise behind the current approach, challenge that premise with evidence that does not depend on it before spending more work on variants of the same idea. The premise may be algorithmic, contractual, environmental, stateful, representational, or otherwise task-specific. Preserve the user's original exactness requirement."
          : selfAdmittedGapKind==="completion"
          ? selfAdmittedGapRecoveries===1
            ? "Your previous draft explicitly says a required part of the task is still incomplete or missing. Do not end yet. Focus only on that named unresolved requirement. Use the evidence already gathered and the available tools to resolve it; prefer one small executable probe or direct inspection that discriminates between the remaining hypotheses, then produce and verify the missing deliverable. Do not restart broad exploration or repeat already-settled work. If a concrete external blocker truly makes completion impossible, answer again with that blocker explicit."
            : "The same required task gap remains after another tool attempt. Do one final focused recovery pass on only that unresolved requirement. Re-use the strongest evidence already collected and run only the smallest decisive check still needed. If a requested local artifact has already been constructed, or can be emitted from the strongest candidate using only safe and reversible local writes, do not withhold or delete that candidate solely because exact verification remains unresolved. Preserve the strongest candidate at the requested path and make the remaining verification uncertainty explicit in the final answer. Do not fabricate missing bytes or values, weaken the user's acceptance criteria, or claim verification passed when it did not. If no meaningful candidate exists, or writing one would be destructive or unsafe, state the concrete blocker instead."
          : selfAdmittedGapRecoveries===1
            ? "Your previous draft explicitly says part of the edited task remains unverified. Before ending, use one focused local verification step for that named gap if it is reasonably testable with the available terminal. Prefer the repository's existing runnable acceptance surface and already-available local services/process controls over a static proxy: exercise the closest representative lifecycle or integration path the task already exposes. If the acceptance requirement is absolute or quantitative (for example zero failures, zero stale reads, no downtime, a timeout, or a latency/error ceiling), a tiny smoke sample that merely happens to pass is not representative evidence: use the closest sustained/concurrent check feasible under the user's stated timing/load conditions and inspect failures by class. The absence of an ideal build/deploy mechanism is not by itself proof that the changed behavior cannot be tested. Do not broaden back into general exploration. If no representative local path genuinely exists, answer again and keep that limitation explicit."
            : "The same verification gap remains after a local verification attempt. Do one final acceptance-oriented check before ending: re-read the user's stated acceptance signal, then use any already-discovered runnable service, process, restart/scale script, entrypoint, task runner, or live local dependency that can exercise the changed behavior end to end. If the previous check was materially weaker than an absolute or quantitative acceptance condition, strengthen that exact check rather than adding unrelated tests: match the user's timeout/load/concurrency conditions as closely as feasible and inspect any failures instead of relying on a small passing sample. Do not spend this recovery merely proving that an ideal container/build/deploy path is absent when a representative local lifecycle can still be exercised. Keep the check bounded and focused. If no representative path genuinely exists, answer again with the concrete limitation rather than opening broad investigation.";
        conversation.push({role:"developer",content:recoveryMessage});
        if(preEditCompletionBlockerChallenge)preEditBlockerChallengeToolAllowance=true;
        emit(onEvent,{name:selfAdmittedGapKind==="completion"?"native.completion.self_admitted_gap":"native.verification.self_admitted_gap",status:"retrying",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,recoveryAttempt:selfAdmittedGapRecoveries,priorRecoveryUsedTool:priorSelfAdmittedGapRecoveryUsedTool,preEditBlockerChallenge:preEditCompletionBlockerChallenge}});
        continue;
      }
      const missingRequired=explicitlyRequired.find(item=>!executedToolKeys.has(item.namespace+"/"+item.name));
      if(missingRequired){
        const key=missingRequired.namespace+"/"+missingRequired.name;
        if(requiredToolRecoveries.has(key)||modelTurns>=budget.maxModelTurns){
          const error=new Error(`Native model did not perform the explicitly requested tool call ${key}.`);error.code="native_required_tool_not_called";
          emit(onEvent,{name:"native.turn.blocked",status:"blocked",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{reason:error.code,namespace:missingRequired.namespace,name:missingRequired.name,modelTurns,toolCalls}});throw error;
        }
        requiredToolRecoveries.add(key);forcedToolChoice={namespace:missingRequired.namespace,name:missingRequired.name};
        conversation.push({role:"developer",content:`The user explicitly required ${key}, but the previous response did not call it. Call that exact tool now and inspect its result before answering. Do not claim completion without the requested tool evidence.`});
        emit(onEvent,{name:"native.model.required_tool_recovery",status:"retrying",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{namespace:missingRequired.namespace,name:missingRequired.name,modelTurn:modelTurns}});
        continue;
      }
      if(applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"before_completion"})){verifiedFinalizationAllowed=false;verifiedFinalizationReady=false;continue}
      if(completionRecoveryEditRequired&&completionRecoveryEditResponsesRemaining>0){
        if(completionRecoveryEditRequiredMisses<1&&modelTurns<budget.maxModelTurns){
          completionRecoveryEditRequiredMisses++;
          conversation.push({role:"developer",content:externalStateMutationRequested
            ?"Trebell recovery still requires the reserved corrective state-changing action before another completion attempt. Do not answer yet. Change the actual external/runtime task target using the evidence already gathered, then verify the resulting state."
            :"Trebell recovery still requires the reserved corrective implementation edit before another completion attempt. Do not answer yet. On the next turn, call one of the available workspace edit tools and modify the actual implementation/deliverable using the evidence already gathered."});
          emit(onEvent,{name:"native.completion.recovery_edit_retry",status:"retrying",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,recoveryEpoch:completionRecoveryEpoch,misses:completionRecoveryEditRequiredMisses}});
          continue;
        }
        const error=new Error(externalStateMutationRequested?"Native completion recovery failed to perform the required corrective state-changing action.":"Native completion recovery failed to perform the required corrective implementation edit.");error.code="native_recovery_edit_not_called";
        emit(onEvent,{name:"native.turn.blocked",status:"blocked",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{reason:error.code,modelTurns,toolCalls,editRevision,recoveryEpoch:completionRecoveryEpoch}});throw error;
      }
      if(semanticCompletionGate===true&&taskMutationRequested&&modelTurns<budget.maxModelTurns){
        if(convergenceFinalizationPending){
          convergenceFinalizationPending=false;
          emit(onEvent,{name:"native.progress.convergence_finalization_candidate",status:"completed",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,convergenceRevision:convergenceFinalizationRevision}});
        }
        const residualMonotonicRecovery=completionRecoveryEpoch>0&&abstractionRepairRevision>0&&!pendingAbstractionRepair&&!abstractionRepairVerificationPending&&postEditResidualStructureRevision>=abstractionRepairRevision;
        const recoveryTransaction=completionRecoveryEditTransaction?.recoveryEpoch===completionRecoveryEpoch?completionRecoveryEditTransaction:null;
        const incumbent=completionRecoveryIncumbent?{...completionRecoveryIncumbent}:null;
        completionGateCandidate={text:responseText,model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,lastResponse,conversationLength:conversation.length,recoveryTransaction,residualMonotonicRecovery,incumbent};
        completionGateInvalidResponses=0;
        const incumbentComparison=incumbent
          ?`\nRecovery incumbent to compare against: unresolved=${JSON.stringify(incumbent.unresolved||[])}; reason=${JSON.stringify(String(incumbent.reason||"").slice(0,1200))}. Set progress=improved only when the current evidence materially moves the same acceptance condition closer to satisfaction than this incumbent, progress=regressed when it materially moves farther away, progress=unchanged when it is materially equivalent, and progress=uncertain when the evidence is not comparable or does not establish direction. Compare the strongest actual acceptance evidence, not confidence, narration, process exit codes, or amount of work performed. Do not silently drop an incumbent unresolved requirement merely because a newer local defect was discovered: for each incumbent unresolved item, either keep it unresolved or identify concrete evidence in the reason that resolves it. Re-audit earlier hard constraints and objective/priority requirements after any persistence or writeback step; persistence alone is not evidence that those semantic obligations are satisfied.`
          :"\nThere is no prior recovery incumbent yet, so set progress=uncertain.";
        const quantitativeAudit=quantitativeCalculationRequested?" For this derived numerical/scientific task, status=complete additionally requires direct evidence that the final reported quantities were checked against authoritative supplied data or reference material rather than only copied from one working calculation. The evidence should cover units/dimensional consistency, the sign or physical interpretation of quantities where relevant, the chosen formula/convention when multiple plausible conventions exist, and one independent recomputation or equivalent cross-check of the final derived values. Formatting, rounding, internal self-consistency, or a plausible domain convention alone is not sufficient. If that evidence is absent but can be obtained locally, return incomplete so bounded recovery can perform the focused check.":"";
        conversation.push({role:"developer",content:"Trebell semantic completion gate. This is an internal control check, not the user-visible answer. Evaluate the immediately preceding candidate final answer against the user's full request and the evidence in this conversation. Return only one JSON object: {\"status\":\"complete|incomplete|blocked\",\"progress\":\"improved|unchanged|regressed|uncertain\",\"edit_support\":\"supported|unsupported|uncertain\",\"mutation_safety\":\"allowed|forbidden|uncertain\",\"unresolved\":[\"material unmet requirement\"],\"reason\":\"brief evidence-based rationale\"}. Before choosing a verdict, perform a requirement-led audit rather than a recency-led audit: treat explicit hard constraints, quantitative bounds, minimum/maximum coverage, sequencing/order/routing rules, optimization or priority objectives, and required persistent side effects as separate obligations. For a bug fix, repair, or refactor of existing code, also treat unexplained removal, renaming, or signature/shape changes of pre-existing public symbols, imports, CLI contracts, configuration/schema/data formats, or other externally visible behavior as material unresolved compatibility risks unless the requested contract explicitly changed or evidence shows existing consumers remain compatible. A cleaner replacement abstraction is not by itself evidence of compatibility. A newer local defect does not supersede an older unresolved obligation. Use status=complete only when every material requested deliverable and acceptance condition is supported by the available evidence. Use status=incomplete when additional local tool work could still resolve an unmet or uncertain requirement. Use status=blocked only when a material requirement genuinely cannot be completed with the available inputs/tools or depends on an unavailable external condition. Set edit_support=supported only when the evidence available to this gate supports a concrete corrective action now: for workspace tasks that can be an implementation/deliverable edit; for external/runtime tasks it can be a state-changing API/process action against the actual task target. Set edit_support=unsupported only when the bounded evidence actually argues against the tested corrections or otherwise establishes that no evidence-supported corrective action is available in the current hypothesis class; do not use unsupported merely because the answer is incomplete or the exact fix is uncertain. Use edit_support=uncertain when the evidence does not justify either conclusion. Set mutation_safety=forbidden when the user's constraints or the observed current phase make another state-changing action illegal, protected, terminal, freeze-window violating, or likely to trade away an already-satisfied invariant. A no-op or same-value reassertion still counts as a mutation attempt when the external system can record attempts. Set mutation_safety=allowed only when another mutation is presently legal under all known phase/invariant constraints; otherwise use uncertain. A forbidden mutation dominates edit support: do not recommend a corrective edit merely because the primary objective remains unresolved. When semantic validity is a prerequisite to a non-idempotent or hard-to-reverse persistence/application step, do not treat successful persistence as proof that the semantic constraints or objective are satisfied; require direct evidence for those prerequisites. A Trebell-internal convergence, evidence-budget, or revision-churn guard rejecting a recent tool call is not by itself a genuine blocker: if the underlying tool/input still exists and further focused work could resolve the requirement, return incomplete so the recovery controller can reopen a bounded allowance. Do not infer success merely from a process exit code when tool output, measurements, or the candidate answer contradict the actual requirement. Judge semantics and evidence, not wording."+quantitativeAudit+incumbentComparison});
        emit(onEvent,{name:"native.completion.gate_requested",status:"running",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,toolCalls}});
        continue;
      }
      const result={
        text:responseText,model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,
        messages:conversation,modelTurns,toolCalls,usage,startedAt,completedAt:Date.now(),durationMs:duration(started),lastResponse,
      };
      emit(onEvent,{name:"native.turn.completed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,durationMs:result.durationMs,usage}});
      return result;
    }
    const editRevisionBeforeCalls=editRevision,verifiedEditsBeforeCalls=verifiedEdits.length,recoverySnapshots=new Map(),responseHasEditCall=calls.some(recoveryCorrectiveEditCall),preEditBlockerChallengeBypass=preEditBlockerChallengeToolAllowance&&editRevision===0,revisionChurnFailureEvidence=revisionChurnEscalated&&terminalRuns.some(item=>item?.currentTurn&&item?.editRevision===editRevisionBeforeCalls&&item?.exitCode!==0),completionRecoveryEditBypass=completionRecoveryEditResponsesRemaining>0,completionRecoveryEditAllowanceConsumed=completionRecoveryEpoch>0&&completionRecoveryEditConsumedEpoch===completionRecoveryEpoch&&completionRecoveryEditResponsesRemaining<=0;let redirected=false,blockedPreEditCall=false,blockedPostEditProbeCall=false,blockedPostEditEvidenceCall=false,blockedRevisionChurnEdit=false,blockedCompletionRecoveryEdit=false,blockedCompletionRecoveryEvidence=false,blockedExternalObservation=false,executedPreEditEvidence=false,executedPostEditEvidence=false,executedExternalObservation=false,executedSupportVerification=false;
    if(preEditBlockerChallengeBypass){
      preEditBlockerChallengeToolAllowance=false;
      emit(onEvent,{name:"native.completion.blocker_challenge_evidence_allowed",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,callCount:calls.length}});
    }
    for(let callIndex=0;callIndex<calls.length;){
      const call=calls[callIndex];
      const completionRecoveryEvidenceBypass=completionRecoveryEvidenceRoundsRemaining>0||completionRecoveryPostEditEvidenceResponsesRemaining>0||completionRecoverySupportVerificationRemaining>0;
      throwIfAborted(turnSignal);
      const steerNow=steeringMessages(consumeSteering);
      if(steerNow.length){
        verifiedFinalizationAllowed=false;verifiedFinalizationReady=false;
        for(const skipped of calls.slice(callIndex)){
          const skippedId=String(skipped?.id||"");
          conversation.push({role:"tool",toolCallId:skippedId,content:"Tool call cancelled before execution because the user steered the active turn."});
          emit(onEvent,{name:"native.tool.skipped",status:"skipped",model:String(model),provider:provider||null,data:{callId:skippedId,namespace:skipped?.namespace||null,name:skipped?.name||"tool",reason:"steering"}});
        }
        conversation.push(...steerNow);
        emit(onEvent,{name:"native.steering.applied",status:"completed",model:String(model||""),provider:provider||null,data:{stage:"before_tool",messageCount:steerNow.length,modelTurn:modelTurns,toolCalls,skippedToolCalls:calls.length-callIndex}});
        redirected=true;break;
      }
      if(toolCalls>=budget.maxToolCalls){
        const error=new Error(`Native agent tool-call budget exhausted (${toolCalls}/${budget.maxToolCalls}).`);error.code="native_tool_call_budget";
        emit(onEvent,{name:"native.turn.blocked",status:"blocked",model:String(model),provider:provider||null,data:{reason:error.code,modelTurns,toolCalls}});throw error;
      }
      const terminalAuditForGuard=nativeTerminalAuditMetadata(call?.namespace,call?.name,safeArguments(call?.arguments));
      const persistentConstraintCommitCall=constraintPlanningRequested&&terminalAuditForGuard?.persistentMutationLike===true;
      const escalatedPreEditEvidenceBlocked=editRevision===0&&!preEditBlockerChallengeBypass&&!persistentConstraintCommitCall&&implementationPressureEscalated&&!responseHasEditCall&&!implementationPressureEditCall(call);
      const singletonPreEditEvidenceBlocked=editRevision===0&&!preEditBlockerChallengeBypass&&!persistentConstraintCommitCall&&calls.length===1&&!implementationPressureEditCall(call)&&!implementationPressureBatchCall(call)&&(implementationPressure||probeBatchingRequired);
      const escalatedPostEditEvidenceBlocked=editRevision>0&&postEditEvidenceEscalated&&!completionRecoveryEvidenceBypass&&!responseHasEditCall&&!implementationPressureEditCall(call);
      const escalatedRevisionChurnEditBlocked=revisionChurnEscalated&&revisionChurnGraceEditUsed&&!completionRecoveryEditBypass&&!revisionChurnFailureEvidence&&recoveryCorrectiveEditCall(call);
      const singletonPostConvergenceTerminalBlocked=editRevision>0&&!completionRecoveryEvidenceBypass&&convergenceCheckpointRevision===editRevision&&calls.length===1&&call?.namespace==="trebell_terminal"&&call?.name==="run"&&!implementationPressureBatchCall(call);
      if(completionRecoveryMutationForbidden&&completionRecoveryEpoch>0&&recoveryCorrectiveEditCall(call)){
        const callId=String(call?.id||""),toolCallNumber=toolCalls+1;toolCalls=toolCallNumber;
        conversation.push({role:"tool",toolCallId:callId,content:"Trebell protected external-state guard: this state-changing action was not executed because the semantic completion gate established that mutation is currently forbidden by a protected/terminal phase or already-satisfied invariant. A same-value reassertion is still a mutation attempt. Use non-mutating evidence, wait for a genuinely new legal phase if the task permits it, or finish with the best supported result."});
        blockedCompletionRecoveryEdit=true;
        emit(onEvent,{name:"native.completion.recovery_edit_call_blocked",status:"blocked",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCall:toolCallNumber,callId,namespace:call?.namespace||null,name:call?.name||"tool",editRevision,recoveryEpoch:completionRecoveryEpoch,reason:"mutation_forbidden"}});
        callIndex++;continue;
      }
      if(externalStateMutationRequested&&externalObservationEscalated&&!completionRecoveryEvidenceBypass&&externalObservationCall(call)&&!consolidatedExternalWaitCall(call)){
        const callId=String(call?.id||""),toolCallNumber=toolCalls+1;toolCalls=toolCallNumber;
        conversation.push({role:"tool",toolCallId:callId,content:"Trebell external-state convergence guard: this immediate status/API observation was not executed because the current external-state revision already consumed its bounded quick-observation allowance. If the only useful next step is waiting for an external condition, combine the wait and decisive recheck into one bounded terminal command or use a background monitor. Otherwise act on the evidence already gathered or finish."});
        blockedExternalObservation=true;
        emit(onEvent,{name:"native.progress.external_observation_call_blocked",status:"blocked",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCall:toolCallNumber,callId,namespace:call?.namespace||null,name:call?.name||"tool",editRevision,reason:"external_observation_round_budget"}});
        callIndex++;continue;
      }
      if(recoveryEditMode&&!recoveryCorrectiveEditCall(call)){
        const callId=String(call?.id||""),toolCallNumber=toolCalls+1;toolCalls=toolCallNumber;
        conversation.push({role:"tool",toolCallId:callId,content:workspaceMutationRequested
          ?"Trebell semantic recovery: this non-edit tool call was not executed because the current recovery step requires the reserved corrective implementation edit. Use one workspace replace_text or write_file call on the actual implementation/deliverable. Evidence-only tools become available again after the recovery edit is resolved or a later bounded recovery epoch opens."
          :"Trebell semantic recovery: this tool call was not executed because the current recovery step requires a real corrective external/runtime state change. Use a persistent state-changing terminal action or start the long-running process that performs the corrective task; do not substitute a workspace/support-file edit. Evidence-only tools become available again after the corrective action is resolved or a later bounded recovery epoch opens."});
        emit(onEvent,{name:"native.completion.recovery_non_edit_call_blocked",status:"blocked",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCall:toolCallNumber,callId,namespace:call?.namespace||null,name:call?.name||"tool",editRevision,recoveryEpoch:completionRecoveryEpoch,reason:"recovery_edit_required"}});
        callIndex++;continue;
      }
      const recoveryEditAppliedInCurrentResponse=editRevision>editRevisionBeforeCalls&&completionRecoveryEditResponsesRemaining>0;
      const recoveryEvidenceExhausted=completionRecoveryEpoch>0&&completionRecoveryEvidenceRoundsRemaining<=0&&completionRecoveryEditResponsesRemaining>0&&!recoveryEditAppliedInCurrentResponse;
      const reservedSupportVerification=completionRecoverySupportVerificationRemaining>0&&call?.namespace==="trebell_terminal"&&call?.name==="run";
      if(recoveryEvidenceExhausted&&!recoveryCorrectiveEditCall(call)&&!recoverySupportWriteCandidate(call)&&!reservedSupportVerification){
        const callId=String(call?.id||""),toolCallNumber=toolCalls+1;toolCalls=toolCallNumber;
        const editRequiredAfterBlock=completionRecoverySupportVerificationRemaining<=0;
        if(editRequiredAfterBlock){completionRecoveryEditRequired=true;completionRecoveryEditRequiredMisses=0}
        conversation.push({role:"tool",toolCallId:callId,content:workspaceMutationRequested
          ?"Trebell semantic recovery: this evidence tool call was not executed because the current recovery epoch has already consumed its bounded evidence responses. Use the reserved corrective implementation edit if the gathered evidence supports one, or submit the best current completion candidate so the semantic gate can judge it and, if needed, open a new bounded recovery epoch. Do not spend another evidence-only tool call in this epoch."
          :"Trebell semantic recovery: this evidence tool call was not executed because the current recovery epoch has already consumed its bounded evidence responses. Use the reserved corrective state-changing action against the actual external/runtime target if the evidence supports one, or submit the best current completion candidate so the semantic gate can judge it and, if needed, open a new bounded recovery epoch. Do not spend another evidence-only tool call in this epoch."});
        blockedCompletionRecoveryEvidence=true;
        emit(onEvent,{name:"native.completion.recovery_evidence_call_blocked",status:"blocked",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCall:toolCallNumber,callId,namespace:call?.namespace||null,name:call?.name||"tool",editRevision,recoveryEpoch:completionRecoveryEpoch,reason:"recovery_evidence_response_budget",editRequiredAfterBlock}});
        callIndex++;continue;
      }
      const sameResponsePostEditEvidenceAllowance=recoveryEditAppliedInCurrentResponse&&completionRecoveryEvidenceRoundsRemaining<=0&&!executedPostEditEvidence;
      const recoveryPostEditEvidenceExhausted=(completionRecoveryEditAllowanceConsumed||recoveryEditAppliedInCurrentResponse)&&completionRecoveryEvidenceRoundsRemaining<=0&&completionRecoveryPostEditEvidenceResponsesRemaining<=0&&!sameResponsePostEditEvidenceAllowance;
      if(recoveryPostEditEvidenceExhausted&&!recoveryCorrectiveEditCall(call)&&!reservedSupportVerification){
        const callId=String(call?.id||""),toolCallNumber=toolCalls+1;toolCalls=toolCallNumber;
        conversation.push({role:"tool",toolCallId:callId,content:"Trebell semantic recovery: this post-edit evidence tool call was not executed because the current recovery epoch already used its reserved verification response after the corrective edit. Propose the best current completion candidate so the semantic gate can judge the repaired state; if a material requirement remains unresolved, a later bounded recovery epoch can reopen focused evidence."});
        blockedCompletionRecoveryEvidence=true;
        emit(onEvent,{name:"native.completion.recovery_evidence_call_blocked",status:"blocked",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCall:toolCallNumber,callId,namespace:call?.namespace||null,name:call?.name||"tool",editRevision,recoveryEpoch:completionRecoveryEpoch,reason:"recovery_post_edit_evidence_budget"}});
        callIndex++;continue;
      }
      if(completionRecoveryEditAllowanceConsumed&&recoveryCorrectiveEditCall(call)){
        const callId=String(call?.id||""),toolCallNumber=toolCalls+1;toolCalls=toolCallNumber;
        conversation.push({role:"tool",toolCallId:callId,content:workspaceMutationRequested
          ?"Trebell semantic recovery: this implementation edit was not executed because the current recovery epoch already consumed its one corrective-edit response. Do not keep editing in the same recovery epoch. Propose the best current completion candidate so the semantic gate can either accept it or open a new bounded recovery epoch for any still-unresolved requirement."
          :"Trebell semantic recovery: this state-changing action was not executed because the current recovery epoch already consumed its one corrective-action response. Do not keep mutating the external/runtime target in the same recovery epoch. Propose the best current completion candidate so the semantic gate can either accept it or open a new bounded recovery epoch for any still-unresolved requirement."});
        blockedCompletionRecoveryEdit=true;
        emit(onEvent,{name:"native.completion.recovery_edit_call_blocked",status:"blocked",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCall:toolCallNumber,callId,namespace:call?.namespace||null,name:call?.name||"tool",editRevision,recoveryEpoch:completionRecoveryEpoch,reason:"recovery_edit_response_budget"}});
        callIndex++;continue;
      }
      if(escalatedRevisionChurnEditBlocked){
        const callId=String(call?.id||""),toolCallNumber=toolCalls+1;toolCalls=toolCallNumber;
        conversation.push({role:"tool",toolCallId:callId,content:"Trebell revision-churn escalation: this workspace edit was not executed because the high-churn grace repair batch has already been used and the current revision has no fresh failing terminal evidence. Run the focused acceptance check that demonstrates the concrete remaining defect, or finish now if the implementation already satisfies the stated requirements. Further speculative edits cannot reset the convergence budget."});
        blockedRevisionChurnEdit=true;
        emit(onEvent,{name:"native.progress.revision_churn_edit_blocked",status:"blocked",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCall:toolCallNumber,callId,namespace:call?.namespace||null,name:call?.name||"tool",editRevision,reason:"revision_churn_requires_failing_evidence"}});
        callIndex++;continue;
      }
      if(singletonPostConvergenceTerminalBlocked){
        const callId=String(call?.id||""),toolCallNumber=toolCalls+1;toolCalls=toolCallNumber;
        conversation.push({role:"tool",toolCallId:callId,content:"Trebell convergence guard: this singleton terminal check was not executed because the current edit revision already has several distinct passing checks and no terminal failure. If one final verification sweep is genuinely needed, batch the remaining independent checks into one bounded response/script. Otherwise answer now. A new workspace edit remains available if you can name a concrete unmet requirement."});
        emit(onEvent,{name:"native.progress.convergence_call_blocked",status:"blocked",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCall:toolCallNumber,callId,namespace:call?.namespace||null,name:call?.name||"tool",editRevision,reason:"post_edit_converged_singleton_check"}});
        callIndex++;continue;
      }
      const singletonPostEditProbeBlocked=editRevision>0&&!completionRecoveryEvidenceBypass&&postEditProbeBatchingRequired&&calls.length===1&&evidenceProbeCall(call)&&!implementationPressureBatchCall(call);
      if(singletonPostEditProbeBlocked){
        const callId=String(call?.id||""),toolCallNumber=toolCalls+1;toolCalls=toolCallNumber;
        conversation.push({role:"tool",toolCallId:callId,content:"Trebell post-edit probe batching: this singleton evidence probe was not executed because too many recent reasoning turns have each spent one round trip on a single terminal/read/search/list/output-inspection probe after the latest workspace edit. Batch the remaining independent checks into one multi-tool response or one bounded adaptive script, make another evidence-supported workspace edit, or answer now if the task is complete."});
        blockedPostEditProbeCall=true;
        emit(onEvent,{name:"native.progress.post_edit_probe_call_blocked",status:"blocked",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCall:toolCallNumber,callId,namespace:call?.namespace||null,name:call?.name||"tool",editRevision,reason:"repeated_post_edit_singleton_probe"}});
        callIndex++;continue;
      }
      if(escalatedPostEditEvidenceBlocked){
        const callId=String(call?.id||""),toolCallNumber=toolCalls+1;toolCalls=toolCallNumber;
        conversation.push({role:"tool",toolCallId:callId,content:"Trebell post-edit evidence escalation: this evidence-only tool call was not executed because the current workspace revision already consumed the bounded post-edit investigation allowance. Make the next evidence-supported workspace edit, finish from the evidence already gathered, or explain the concrete blocker. Another repackaged read/probe batch will remain blocked."});
        blockedPostEditEvidenceCall=true;
        emit(onEvent,{name:"native.progress.post_edit_evidence_call_blocked",status:"blocked",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCall:toolCallNumber,callId,namespace:call?.namespace||null,name:call?.name||"tool",editRevision,reason:"post_edit_evidence_round_budget"}});
        callIndex++;continue;
      }
      if(escalatedPreEditEvidenceBlocked||singletonPreEditEvidenceBlocked){
        const callId=String(call?.id||""),toolCallNumber=toolCalls+1;toolCalls=toolCallNumber;
        const reason=escalatedPreEditEvidenceBlocked?"pre_edit_evidence_round_budget":probeBatchingRequired?"repeated_singleton_probe":"first_workspace_edit_required";
        conversation.push({role:"tool",toolCallId:callId,content:escalatedPreEditEvidenceBlocked
          ?"Trebell implementation escalation: this pre-edit evidence call was not executed because multiple batched evidence rounds already ran after the implementation checkpoint without an edit. Make the smallest evidence-supported workspace edit now, or explain the concrete blocker that makes implementation impossible. Further repackaged reconnaissance will remain blocked."
          :probeBatchingRequired
          ?"Trebell probe batching: this singleton pre-edit evidence call was not executed because several recent model turns already spent one inference round trip per terminal probe. Keep investigating if necessary, but batch the remaining independent probes/reads into one genuinely multi-probe response or bounded script, or make the smallest evidence-supported workspace edit now."
          :"Trebell implementation pressure: this singleton pre-edit reconnaissance call was not executed because too many model turns have already been spent inspecting without implementing. Either make the smallest evidence-supported workspace edit now, or batch the remaining independent read-only probes/searches into one model response so they do not consume one reasoning round-trip each. Full focused inspection and verification remain available after the first successful edit."});
        blockedPreEditCall=true;
        emit(onEvent,{name:"native.progress.implementation_call_blocked",status:"blocked",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCall:toolCallNumber,callId,namespace:call?.namespace||null,name:call?.name||"tool",reason}});
        callIndex++;continue;
      }
      const constraintCommitBlocked=constraintPlanningRequested&&terminalAuditForGuard?.persistentMutationLike===true&&constraintCommitValidatedRevision!==editRevision;
      if(constraintCommitBlocked){
        const callId=String(call?.id||""),toolCallNumber=toolCalls+1;toolCalls=toolCallNumber;constraintCommitCheckpointRevision=editRevision;
        conversation.push({role:"tool",toolCallId:callId,content:"Trebell global-constraint commit guard: this persistent or hard-to-reverse mutation was not executed yet. Before committing external state, run one bounded non-mutating acceptance audit against the staged candidate using authoritative source data. Re-check every explicit hard constraint, required item, derived quantity, time/duration/capacity rule, referential invariant, and objective/priority condition from the user's request together; do not rely on row counts, internal consistency, or the most recently fixed defect alone. Prefer one batched solver/check script that fails loudly on any unmet condition. If the audit passes, retry the mutation unchanged. If it fails, repair the staged candidate and audit the new revision before committing."});
        emit(onEvent,{name:"native.progress.global_constraint_commit_blocked",status:"blocked",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCall:toolCallNumber,callId,namespace:call?.namespace||null,name:call?.name||"tool",editRevision,mutationKind:terminalAuditForGuard.persistentMutationKind||null,reason:"precommit_full_constraint_audit_required"}});
        callIndex++;continue;
      }
      const remainingBudget=budget.maxToolCalls-toolCalls,batch=[call];
      if(canRunParallel(call)){
        for(let next=callIndex+1;next<calls.length&&batch.length<parallelLimit&&batch.length<remainingBudget;next++){
          if(!canRunParallel(calls[next]))break;
          batch.push(calls[next]);
        }
      }
      const prepared=batch.map((item,index)=>({call:item,toolCallNumber:toolCalls+index+1}));
      const transactionalResidualEdit=completionRecoveryEpoch>0&&completionRecoveryEditResponsesRemaining>0&&abstractionRepairRevision>0&&!pendingAbstractionRepair&&!abstractionRepairVerificationPending&&postEditResidualStructureRevision>=abstractionRepairRevision;
      if(transactionalResidualEdit){
        for(const item of prepared){
          if(!recoveryCorrectiveEditCall(item.call))continue;
          const path=String(safeArguments(item.call?.arguments).path||"").trim().replace(/\\/g,"/");
          if(!path||recoverySnapshots.has(path))continue;
          recoverySnapshots.set(path,await captureRecoveryWorkspaceSnapshot(item.call));
        }
      }
      if(editRevision===0&&implementationPressure&&!responseHasEditCall&&prepared.some(item=>!implementationPressureEditCall(item.call)))executedPreEditEvidence=true;
      if(editRevisionBeforeCalls>0&&(!responseHasEditCall||editRevision>editRevisionBeforeCalls)&&prepared.some(item=>!implementationPressureEditCall(item.call)))executedPostEditEvidence=true;
      if(externalStateMutationRequested&&prepared.some(item=>externalObservationCall(item.call)))executedExternalObservation=true;
      toolCalls+=prepared.length;
      const observations=prepared.length>1
        ?await Promise.all(prepared.map(item=>executeOneTool(item.call,item.toolCallNumber)))
        :[await executeOneTool(prepared[0].call,prepared[0].toolCallNumber)];
      if(constraintPlanningRequested&&constraintCommitCheckpointRevision===editRevision&&constraintCommitValidatedRevision!==editRevision){
        const verified=prepared.some((item,index)=>{
          if(item.call?.namespace!=="trebell_terminal"||item.call?.name!=="run")return false;
          const audit=nativeTerminalAuditMetadata(item.call.namespace,item.call.name,safeArguments(item.call.arguments));if(audit?.persistentMutationLike)return false;
          const output=observations[index]?.[NATIVE_TOOL_OBSERVATION_OUTPUT];
          return output?.success!==false&&output?.uncertain!==true&&output?.timedOut!==true&&output?.signal==null&&(!Number.isFinite(Number(output?.exitCode))||Number(output.exitCode)===0);
        });
        if(verified){
          constraintCommitValidatedRevision=editRevision;
          emit(onEvent,{name:"native.progress.global_constraint_commit_audited",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision}});
        }
      }
      if(completionRecoverySupportVerificationRemaining>0&&prepared.some(item=>item.call?.namespace==="trebell_terminal"&&item.call?.name==="run"))executedSupportVerification=true;
      conversation.push(...observations);
      callIndex+=batch.length;
    }
    if(redirected)continue;
    if(editRevision>editRevisionBeforeCalls&&completionRecoveryEditResponsesRemaining>0){
      const implementationEdits=verifiedEdits.slice(verifiedEditsBeforeCalls).filter(item=>item&&!item.supportOnly),transactionSnapshots=[];
      if(recoverySnapshots.size>0){
        for(const item of implementationEdits){
          const path=String(item?.path||"").trim().replace(/\\/g,"/");if(!path||transactionSnapshots.some(snapshot=>snapshot?.path===path))continue;
          transactionSnapshots.push(recoverySnapshots.get(path)||{path,restorable:false,reason:"pre-edit workspace snapshot was unavailable"});
        }
      }
      completionRecoveryEditTransaction=transactionSnapshots.length?{recoveryEpoch:completionRecoveryEpoch,beforeRevision:editRevisionBeforeCalls,afterRevision:editRevision,verifiedEditsLengthBefore:verifiedEditsBeforeCalls,snapshots:transactionSnapshots}:null;
      if(transactionSnapshots.length){
        const failedSnapshot=transactionSnapshots.find(item=>!item?.restorable);
        emit(onEvent,{name:"native.completion.recovery_candidate_snapshot",status:transactionSnapshots.every(item=>item?.restorable)?"completed":"uncertain",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,editRevision,recoveryEpoch:completionRecoveryEpoch,pathCount:transactionSnapshots.length,restorable:transactionSnapshots.every(item=>item?.restorable),...(failedSnapshot?.reason?{reason:String(failedSnapshot.reason).slice(0,240)}:{})}});
      }
      completionRecoveryEditResponsesRemaining=Math.max(0,completionRecoveryEditResponsesRemaining-1);
      completionRecoveryEditConsumedEpoch=completionRecoveryEpoch;
      completionRecoveryPostEditEvidenceResponsesRemaining=completionRecoveryEvidenceRoundsRemaining<=0?1:0;
      completionRecoveryEditRequired=false;
      completionRecoveryEditRequiredMisses=0;
      emit(onEvent,{name:"native.completion.recovery_allowance_used",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,editRevision,recoveryEpoch:completionRecoveryEpoch,kind:"edit",remaining:completionRecoveryEditResponsesRemaining}});
    }
    if(editRevision>editRevisionBeforeCalls){
      externalObservationRounds=0;
      externalObservationCheckpointRevision=-1;
      externalObservationEscalated=false;
      completionRecoveryMutationForbidden=false;
    }else if(executedExternalObservation&&!blockedExternalObservation){
      externalObservationRounds++;
    }
    if(executedPostEditEvidence&&completionRecoveryEvidenceRoundsRemaining>0){
      completionRecoveryEvidenceRoundsRemaining=Math.max(0,completionRecoveryEvidenceRoundsRemaining-1);
      emit(onEvent,{name:"native.completion.recovery_allowance_used",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,editRevision,recoveryEpoch:completionRecoveryEpoch,kind:"evidence",remaining:completionRecoveryEvidenceRoundsRemaining}});
    }else if(executedPostEditEvidence&&completionRecoveryEditConsumedEpoch===completionRecoveryEpoch&&completionRecoveryPostEditEvidenceResponsesRemaining>0){
      completionRecoveryPostEditEvidenceResponsesRemaining=Math.max(0,completionRecoveryPostEditEvidenceResponsesRemaining-1);
      emit(onEvent,{name:"native.completion.recovery_allowance_used",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,editRevision,recoveryEpoch:completionRecoveryEpoch,kind:"post_edit_verification",remaining:completionRecoveryPostEditEvidenceResponsesRemaining}});
    }
    if(executedSupportVerification&&completionRecoverySupportVerificationRemaining>0){
      completionRecoverySupportVerificationRemaining=Math.max(0,completionRecoverySupportVerificationRemaining-1);
      emit(onEvent,{name:"native.completion.recovery_allowance_used",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,editRevision,recoveryEpoch:completionRecoveryEpoch,kind:"support_verification",remaining:completionRecoverySupportVerificationRemaining}});
    }
    if(editRevision===0&&implementationPressure&&executedPreEditEvidence)implementationPressureEvidenceRounds++;
    if(editRevision>editRevisionBeforeCalls){
      if(revisionChurnEscalated)revisionChurnGraceEditUsed=true;
      singletonTerminalProbeStreak=0;
      postEditProbeBatchingRequired=false;
      postEditEvidenceRounds=0;
      postEditAssumptionAuditRevision=0;
      postEditAbstractionEscalationRevision=0;
      postEditEvidenceCheckpointRevision=0;
      postEditEvidenceEscalated=false;
    }else if(!blockedPreEditCall&&!blockedPostEditProbeCall&&!blockedRevisionChurnEdit&&!blockedCompletionRecoveryEdit&&!blockedCompletionRecoveryEvidence&&calls.length===1&&evidenceProbeCall(calls[0])&&!implementationPressureBatchCall(calls[0])){
      singletonTerminalProbeStreak++;
    }else if(calls.length>0&&!blockedPreEditCall&&!blockedPostEditProbeCall){
      singletonTerminalProbeStreak=0;
    }
    if(abstractionRepairVerificationPending&&editRevision===editRevisionBeforeCalls&&editRevision===abstractionRepairRevision&&executedPostEditEvidence&&!blockedPostEditEvidenceCall&&!blockedCompletionRecoveryEvidence){
      emit(onEvent,{name:"native.progress.abstraction_repair_verification_evidence",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,abstractionRepairRevision}});
      abstractionRepairVerificationGateCandidate={conversationLength:conversation.length,editRevision,abstractionRepairRevision};
      abstractionRepairVerificationGateInvalidResponses=0;
      conversation.push({role:"developer",content:"Trebell abstraction-repair verification gate. This is an internal control check, not a user-visible answer. Evaluate only the immediately preceding independent source-of-truth recheck for the currently challenged upstream abstraction. Return only one JSON object: {\"status\":\"verified|failed|uncertain\",\"reason\":\"brief evidence-based rationale\"}. Use status=verified only if the fresh evidence positively establishes that the invariant which motivated the abstraction repair now holds under the repaired implementation, and the check did not manufacture both observed and expected values from the same suspect parser/decoder/adapter/mapper. Use status=failed when the evidence still contradicts the repaired abstraction. Use status=uncertain when the recheck did not actually test the motivating invariant independently or the evidence is ambiguous. Do not infer verified merely because a command exited zero, an end-to-end metric improved, or a different downstream check passed. Do not call tools and do not address the user."});
      emit(onEvent,{name:"native.progress.abstraction_repair_verification_gate_requested",status:"running",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,abstractionRepairRevision}});
    }
    if(editRevisionBeforeCalls>0&&editRevision===editRevisionBeforeCalls&&executedPostEditEvidence&&!blockedPostEditEvidenceCall)postEditEvidenceRounds++;
    const terminalStatusCall=calls.length===1&&calls[0]?.namespace==="trebell_terminal"&&calls[0]?.name==="run"?calls[0]:null;
    const terminalStatusRun=terminalStatusCall?terminalRuns.findLast(item=>item?.currentTurn&&item.key===terminalRunKey(safeArguments(terminalStatusCall.arguments))):null;
    const missingExplicitAfterTools=explicitlyRequired.find(item=>!executedToolKeys.has(item.namespace+"/"+item.name));
    if(synthesizeTerminalReports===true&&terminalStatusRequested&&toolCalls===1&&terminalStatusRun&&!missingExplicitAfterTools){
      if(applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"before_terminal_report"})){verifiedFinalizationAllowed=false;verifiedFinalizationReady=false;continue}
      const result=finishTerminalStatus(terminalStatusCall,terminalStatusRun,{responseText});if(result)return result;
    }
    const successfulEditOnlyBatch=calls.length>0&&calls.every(call=>call?.namespace==="trebell_workspace"&&["write_file","replace_text"].includes(call?.name))&&editRevision-editRevisionBeforeCalls===calls.length;
    if(autoRerunVerification===true&&successfulEditOnlyBatch&&verificationCompletionRequest&&verifiedFinalizationAllowed&&!verifiedFinalizationReady&&toolCalls<budget.maxToolCalls){
      if(applySteering(conversation,consumeSteering,onEvent,{model,provider,modelTurn:modelTurns,toolCalls,stage:"before_auto_verifier"})){verifiedFinalizationAllowed=false;verifiedFinalizationReady=false;continue}
      const candidate=verificationAutoRerunCandidate(verificationCompletionRequest,terminalRuns,editRevision,calls);
      if(candidate){
        const toolCallNumber=toolCalls+1,callId=`native-auto-verifier-${modelTurns}-${toolCallNumber}`,call={id:callId,namespace:"trebell_terminal",name:"run",arguments:JSON.stringify(candidate.arguments)};
        conversation.push({role:"assistant",content:"",toolCalls:[call]});toolCalls=toolCallNumber;
        const observation=await executeOneTool(call,toolCallNumber);conversation.push(observation);
        emit(onEvent,{name:"native.verification.auto_rerun",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision}});
      }
    }
  }}catch(caught){
    let error=caught;
    if(wallController?.signal.aborted&&!signal?.aborted){
      error=new Error(`Native agent wall-time budget exhausted (${budget.maxWallTimeMs}ms).`);error.code="native_wall_time_budget";
      emit(onEvent,{name:"native.turn.blocked",status:"blocked",model:String(model),provider:provider||null,data:{reason:error.code,modelTurns,toolCalls,maxWallTimeMs:budget.maxWallTimeMs}});
    }
    if(error&&typeof error==="object"){
      error.nativeUsage={...usage};error.nativeModelTurns=modelTurns;error.nativeToolCalls=toolCalls;
    }
    throw error;
  }finally{if(wallTimer)clearTimeout(wallTimer)}
}
