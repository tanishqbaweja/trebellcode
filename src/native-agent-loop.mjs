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

function safeArguments(value){
  if(value&&typeof value==="object"&&!Array.isArray(value))return value;
  try{const parsed=JSON.parse(String(value||"{}"));return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed:{}}
  catch{return {}}
}

function terminalToolTimeoutMs(namespace,name,args={}){
  if(namespace!=="trebell_terminal"||name!=="run")return null;
  return boundedInteger(args.timeout_ms,TERMINAL_TOOL_TIMEOUT_DEFAULT_MS,{min:1000,max:TERMINAL_TOOL_TIMEOUT_MAX_MS});
}

export function nativeTerminalAuditMetadata(namespace,name,args={}){
  if(namespace!=="trebell_terminal"||name!=="run")return null;
  const normalized=normalizeNativeCommandArguments(args),command=String(normalized.command||"").trim(),argv=Array.isArray(normalized.args)?normalized.args.map(value=>String(value)):[];
  const redacted=redactSecretText([command,...argv].join(" "),{redactHomes:true,trim:true}).slice(0,1200);
  const executable=String(command).split(/[\\/]/).pop()?.slice(0,120)||null;
  const urls=[...redacted.matchAll(/https?:\/\/[^\s'"<>]+/gi)].map(match=>match[0].slice(0,300));
  const hosts=[...new Set(urls.map(value=>{try{return new URL(value).hostname.toLowerCase()}catch{return null}}).filter(Boolean))].slice(0,20);
  const networkLike=/(?:^|\s)(?:curl|wget|git\s+(?:clone|fetch|pull)|npm\s+(?:install|i|view|info|pack)|pnpm\s+(?:install|add)|yarn\s+(?:add|install)|pip\d*\s+install|python\s+-m\s+pip\s+install|apt(?:-get)?\s+(?:install|update)|apk\s+add|brew\s+install|invoke-webrequest|irm|iwr)(?:\s|$)/i.test(redacted)||urls.length>0;
  const packageManager=/(?:^|\s)(?:npm|pnpm|yarn|pip\d*|apt|apt-get|apk|brew)(?:\s|$)/i.test(redacted);
  return {executable,commandHash:createHash("sha256").update(redacted).digest("hex"),networkLike,packageManager,hosts,redactedCommand:redacted};
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

function requestsWorkspaceMutation(messages=[]){
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
  if(/^\s*(?:please\s+)?(?:optimi[sz]e|speed\s+up|accelerate|streamline|harden)\b/i.test(text))return true;
  if(/^\s*(?:please\s+)?improve\b[\s\S]{0,160}\b(?:performance|responsiveness|latency|throughput|efficiency|app|application|service|system|project|repository|repo|codebase|implementation|code)\b/i.test(text))return true;
  const diagnosticOnly=/\b(?:inspect|explain|analy[sz]e|diagnose|investigate|review|report|identify|find)\b[\s\S]{0,120}\b(?:why|cause|root cause|problem|issue|bug|failure|behavior|behaviour)\b/i.test(text)
    ||/\b(?:why|how|what)\b[\s\S]{0,120}\b(?:broken|failing|fails|not working|incorrect|wrong)\b/i.test(text);
  if(diagnosticOnly)return false;
  return /\b(?:not\s+working(?:\s+(?:correctly|properly))?|broken|buggy|malfunction(?:ing|s)?|incorrect(?:ly)?|wrong\s+results?|fails?\b|failing\b|regression\b)\b/i.test(text);
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
      const unresolved=Array.isArray(parsed?.unresolved)?parsed.unresolved.map(item=>String(item||"").trim()).filter(Boolean).slice(0,8):[];
      const reason=String(parsed?.reason||"").trim().slice(0,2000);
      return {status,unresolved,reason};
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
  providerTurn,executeTool,model,messages=[],tools=[],provider=null,toolChoice="auto",
  maxOutputTokens=null,temperature=null,reasoningEffort=null,parallelToolCalls=true,maxModelTurns=24,maxToolCalls=100,maxWallTimeMs=null,
  maxProviderAttempts=3,retryBaseDelayMs=250,consumeSteering=null,isToolParallelSafe=null,maxParallelToolCalls=8,toolAllowlist=null,coolReadToolHistory=null,preserveToolSchemasOnFinalization=false,signal=null,onEvent=null,metadata=null,
  autoRerunVerification=false,semanticCompletionGate=false,priorTerminalRuns=[],synthesizeTerminalReports=false,coolSyntheticTerminalReportOutput=true,directTerminalStatusCommands=false,directExactReplacementStatus=false,directExactWriteStatus=false,directExactReadStatus=false,directExactListStatus=false,directGitStatus=false,directProcessRunningStatus=false,directBrowserRuntimeStatus=false,directBrowserScreenshot=false,prepareProviderMessages=null,
}={}){
  if(typeof providerTurn!=="function")throw new Error("Native agent loop requires a providerTurn function.");
  if(typeof executeTool!=="function")throw new Error("Native agent loop requires an executeTool function.");
  if(!String(model||"").trim())throw new Error("Native agent loop requires a model.");
  const budget=nativeAgentBudget({maxModelTurns,maxToolCalls,maxWallTimeMs}),conversation=[...(Array.isArray(messages)?messages:[])],visibleTools=providerVisibleTools(tools,toolAllowlist),directVisiblePairs=exposedToolPairs(visibleTools),workspaceMutationRequested=requestsWorkspaceMutation(conversation),requestMetricsToolCache=new WeakMap(),requestMetricsMessageCache=new WeakMap(),requestMetricsCurrentTurnCache=new WeakMap(),requestMetricsHistoryHashCache={},requestMetricsClassificationCache=typeof coolReadToolHistory==="function"?null:{},openAiContinuationIdentity={};
  const explicitlyRequired=explicitlyRequestedTools(conversation,visibleTools),executedToolKeys=new Set(),requiredToolRecoveries=new Set();
  const finalAfterVerifiedRequest=explicitFinalAnswerAfterVerification(conversation),finalAfterVerifiedCommand=Boolean(finalAfterVerifiedRequest),summaryAfterVerifiedCommand=explicitSummaryAfterVerification(conversation),literalAfterVerifiedCommand=explicitLiteralAfterVerification(conversation),verificationCompletionRequest=explicitVerificationCompletion(conversation),verificationCompletionRequested=Boolean(verificationCompletionRequest),terminalStatusRequested=explicitTerminalStatusRequest(conversation),directTerminalStatusCommand=directTerminalStatusCommands===true?explicitTerminalStatusCommand(conversation):null,directReplacementStatus=directExactReplacementStatus===true?explicitExactReplacementStatus(conversation):null,directWriteStatus=directExactWriteStatus===true?explicitExactFileWriteStatus(conversation):null,directReadStatus=directExactReadStatus===true?explicitExactFileReadStatus(conversation):null,directListStatus=directExactListStatus===true?explicitImmediateWorkspaceListStatus(conversation):null,directGitStatusRequest=directGitStatus===true?explicitGitReadRequest(conversation):null,directProcessRunningRequest=directProcessRunningStatus===true?explicitBackgroundProcessRunningRequest(conversation):null,directBrowserRuntimeRequest=directBrowserRuntimeStatus===true&&explicitBrowserRuntimeHealthRequest(conversation),directBrowserScreenshotRequest=directBrowserScreenshot===true&&explicitBrowserScreenshotRequest(conversation),terminalRuns=priorTerminalEvidence(priorTerminalRuns),verifiedEdits=[];
  const verificationFinalizationRequest=verificationCompletionRequest||(finalAfterVerifiedRequest?.target?finalAfterVerifiedRequest:null);
  const successfulTerminalRuns=[];
  let modelTurns=0,toolCalls=0,emptyCompletionRecoveries=0,toolBudgetTextRecoveries=0,verifiedFinalizationRecoveries=0,selfAdmittedGapRecoveries=0,selfAdmittedGapRecoveryToolBaseline=0,preEditBlockerChallengeToolAllowance=false,forcedToolChoice=null,lastProviderReadMessageCount=0,toolBudgetFinalizationInjected=false,progressCheckpointInjected=false,probeBatchingRequired=false,postEditProbeBatchingRequired=false,postEditEvidenceRounds=0,postEditAssumptionAuditRevision=0,postEditEvidenceCheckpointRevision=0,postEditEvidenceEscalated=false,singletonTerminalProbeStreak=0,implementationPressureEvidenceRounds=0,implementationPressureEscalated=false,turnBudgetCheckpointInjected=false,wallBudgetCheckpointInjected=false,revisionChurnCheckpointInjected=false,revisionChurnCheckpointRevision=0,revisionChurnConvergenceBaseline=0,revisionChurnEscalated=false,revisionChurnGraceEditUsed=false,convergenceCheckpointRevision=0,convergenceCheckpointCount=0,completionGateCandidate=null,completionGateInvalidResponses=0,completionGateChecks=0,completionGateRecoveries=0,verifiedFinalizationAllowed=finalAfterVerifiedCommand||verificationCompletionRequested,verifiedFinalizationReady=false,verifiedFinalizationInjected=false,editRevision=0,usage={inputTokens:0,outputTokens:0,totalTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0},lastResponse=null;
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
  const executeOneTool=async(call,toolCallNumber)=>{
    const callId=String(call?.id||("native-tool-"+toolCallNumber)),namespace=call?.namespace?String(call.namespace):null,name=String(call?.name||"tool"),args=safeArguments(call?.arguments);
    if(namespace)executedToolKeys.add(namespace+"/"+name);
    const toolStarted=nowMs();
    const terminalAudit=nativeTerminalAuditMetadata(namespace,name,args);
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
      editRevision++;const path=String(args.path||output?.path||"").trim();if(path)verifiedEdits.push({path,kind:name,replacements:name==="replace_text"?Math.max(0,Math.trunc(Number(output?.replacements)||0)):0,summary:name==="replace_text"?conciseReplacementSummary(args.old_text,args.new_text):null});
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
      conversation.push({role:"developer",content:"Trebell probe-batching checkpoint: the last "+singletonTerminalProbeStreak+" model turns each spent a full inference round trip on one terminal probe. Continue investigating if needed, but stop serial probing. From now until the first workspace edit, gather any remaining independent evidence in a genuinely batched terminal script or multi-tool response, then synthesize the results. A single terminal/read probe per model turn will be blocked; an implementation edit or an explicit concrete blocker is also acceptable."});
      probeBatchingRequired=true;
      emit(onEvent,{name:"native.progress.probe_batch_checkpoint",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,singletonTerminalProbeStreak}});
    }
    if(workspaceMutationRequested&&!progressCheckpointInjected&&!probeBatchingRequired&&editRevision===0&&((toolCalls>=24&&modelTurns>=3)||modelTurns>=4)){
      conversation.push({role:"developer",content:"Trebell progress checkpoint: substantial read-only exploration has already happened without a workspace edit. If the evidence supports a plausible implementation path, begin the smallest runnable implementation now. If more evidence is genuinely required first, do not continue one inspection or probe per model turn: batch independent read-only searches, reads, or diagnostic probes into one model response (or one bounded shell script when appropriate), then synthesize the result and implement. Singleton pre-edit reconnaissance is now blocked until the first successful workspace edit; batched focused evidence gathering remains available. If implementation is genuinely impossible from the evidence already collected, explain the concrete blocker instead of continuing broad discovery."});
      progressCheckpointInjected=true;
      emit(onEvent,{name:"native.progress.implementation_checkpoint",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision}});
    }
    if(workspaceMutationRequested&&progressCheckpointInjected&&editRevision===0&&!implementationPressureEscalated&&implementationPressureEvidenceRounds>=2){
      conversation.push({role:"developer",content:"Trebell implementation escalation: "+implementationPressureEvidenceRounds+" additional batched evidence rounds have already executed after the implementation checkpoint without a workspace edit. The evidence-gathering allowance is now exhausted. On the next action, either include the smallest evidence-supported workspace edit or explain a concrete blocker that makes implementation impossible. Further pre-edit reads, searches, and terminal probes without an edit will be blocked; do not repackage the same investigation into another batch."});
      implementationPressureEscalated=true;
      emit(onEvent,{name:"native.progress.implementation_escalation",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,evidenceRounds:implementationPressureEvidenceRounds}});
    }
    if(workspaceMutationRequested&&editRevision>0&&!postEditProbeBatchingRequired&&singletonTerminalProbeStreak>=6){
      conversation.push({role:"developer",content:"Trebell post-edit probe-batching checkpoint: the last "+singletonTerminalProbeStreak+" model turns each spent a full inference round trip on one terminal probe after a successful workspace edit. Keep investigating if a concrete gap remains, but stop serial probing. Until another workspace edit is made, any further independent terminal evidence must be gathered in a genuinely batched multi-tool response or one bounded adaptive shell/script probe. A new evidence-supported workspace edit or a final answer is also acceptable. Do not split a batchable verification sweep into one command per reasoning turn."});
      postEditProbeBatchingRequired=true;
      emit(onEvent,{name:"native.progress.post_edit_probe_batch_checkpoint",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,singletonTerminalProbeStreak}});
    }
    if(workspaceMutationRequested&&editRevision>0&&postEditAssumptionAuditRevision!==editRevision&&postEditEvidenceRounds>=4){
      conversation.push({role:"developer",content:"Trebell assumption-audit checkpoint: "+postEditEvidenceRounds+" evidence-only reasoning rounds have executed since the latest workspace edit without resolving the remaining defect. Before spending more inference on downstream permutations, tuning, retries, or alternate outputs, audit the earliest shared assumption that all of those probes depend on. Look for a source-of-truth invariant implied by the repository, format, protocol, schema, units, environment, fixture, or raw input and compare that invariant directly against what the current parser/adapter/interpretation produces. If an observed invariant is impossible under the current interpretation, treat that as evidence the upstream assumption is wrong and repair or re-derive that layer before continuing downstream search. Crucially, cross the abstraction boundary you are testing: if a parser, decoder, adapter, mapper, loader, serializer, generated representation, or measurement layer is suspect, do not use that same abstraction to generate both sides of the falsification check. Inspect the lower-level source independently (for example raw bytes/records, physical offsets/framing/order, original payload text, source quantities, protocol frames, or another independent reconstruction) and derive at least one expected invariant without calling the suspect helper. Prefer one bounded discriminating check that can falsify the assumption over a broad new investigation. If the upstream assumptions survive an independent lower-level check, continue the existing focused hypothesis; do not invent an upstream problem merely to satisfy this checkpoint."});
      postEditAssumptionAuditRevision=editRevision;
      emit(onEvent,{name:"native.progress.assumption_audit_checkpoint",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,evidenceRounds:postEditEvidenceRounds}});
    }
    if(workspaceMutationRequested&&editRevision>0&&postEditEvidenceCheckpointRevision!==editRevision&&postEditEvidenceRounds>=6){
      conversation.push({role:"developer",content:"Trebell post-edit evidence checkpoint: "+postEditEvidenceRounds+" separate tool-bearing reasoning rounds have already executed since the latest successful workspace edit without another edit. Batch-like scripts still cost a full model decision each time, so do not keep repackaging investigation indefinitely. You have at most two more focused evidence rounds for the current edit revision. Use them to resolve the concrete remaining hypothesis or acceptance gap, then either make the next evidence-supported workspace edit, finish the task, or state a concrete blocker."});
      postEditEvidenceCheckpointRevision=editRevision;
      emit(onEvent,{name:"native.progress.post_edit_evidence_checkpoint",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,evidenceRounds:postEditEvidenceRounds}});
    }
    if(workspaceMutationRequested&&editRevision>0&&postEditEvidenceCheckpointRevision===editRevision&&!postEditEvidenceEscalated&&postEditEvidenceRounds>=8){
      conversation.push({role:"developer",content:"Trebell post-edit evidence escalation: the bounded post-edit investigation allowance is exhausted for the current workspace revision. Further evidence-only tool calls will be blocked. On the next action, either include a concrete evidence-supported workspace edit, finish with the result already supported by the evidence, or explain the specific blocker that prevents completion. Do not escape this checkpoint by wrapping the same investigation in another loop or multi-command script."});
      postEditEvidenceEscalated=true;
      emit(onEvent,{name:"native.progress.post_edit_evidence_escalation",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,editRevision,evidenceRounds:postEditEvidenceRounds}});
    }
    if(workspaceMutationRequested&&editRevision>0&&convergenceCheckpointRevision!==editRevision){
      const revisionRuns=terminalRuns.filter(item=>item?.currentTurn&&item?.editRevision===editRevision),failedRuns=revisionRuns.filter(item=>item?.exitCode!==0),passedRuns=revisionRuns.filter(item=>item?.exitCode===0),distinctPassed=new Set(passedRuns.map(item=>item?.key).filter(Boolean));
      if(failedRuns.length===0&&passedRuns.length>=3&&distinctPassed.size>=2){
        conversation.push({role:"developer",content:`Trebell convergence checkpoint: since the latest successful workspace edit, ${passedRuns.length} terminal checks have passed with no terminal failure (${distinctPassed.size} distinct commands). Command count is not semantic coverage: before stopping, compare those checks against the user's stated acceptance signals and any behavior-driving structured inputs or configured constraints already identified. Explicit quantitative targets still need representative evidence, and a one-shot benchmark/deploy/cutover/release signal should not be triggered before its acceptance-critical preconditions are evidenced. For hidden/randomized/workload-variable performance gates, a narrow proxy that only barely clears the threshold is not strong convergence evidence: use broader varied cases and meaningful headroom when feasible, and make sure invariant preprocessing is not still sitting inside the repeated hot path. If that coverage is complete, stop speculative polishing and answer now. Continue only if you can name a concrete unmet requirement or a focused verification gap; do not invent extra hardening work.`});
        convergenceCheckpointRevision=editRevision;
        convergenceCheckpointCount++;
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
    const requestStarted=nowMs(),requestMessageCount=conversation.length,forcedAllowlist=forcedToolChoice?[forcedToolChoice.namespace?forcedToolChoice.namespace+"/"+forcedToolChoice.name:forcedToolChoice.name]:null,completionGateMode=Boolean(completionGateCandidate),finalAnswerOnly=toolBudgetExhausted||verifiedFinalizationReady||completionGateMode,implementationPressure=workspaceMutationRequested&&progressCheckpointInjected&&editRevision===0&&!finalAnswerOnly&&!forcedAllowlist,requestTools=completionGateMode?[]:finalAnswerOnly&&!preserveToolSchemasOnFinalization?[]:forcedAllowlist?providerVisibleTools(visibleTools,forcedAllowlist):visibleTools,requestToolChoice=finalAnswerOnly?"none":forcedToolChoice||toolChoice;
    if(implementationPressure)emit(onEvent,{name:"native.progress.implementation_pressure",status:"running",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,visibleToolCount:exposedToolPairs(requestTools).length,blockedUntilFirstEdit:Math.max(0,exposedToolPairs(requestTools).filter(item=>!(item.namespace==="trebell_workspace"&&["write_file","replace_text"].includes(item.name))).length),toolSchemaStable:true}});
    let providerMessages=conversation,providerView=null;
    if(typeof prepareProviderMessages==="function"){
      const prepared=prepareProviderMessages(conversation);
      if(Array.isArray(prepared))providerMessages=prepared;
      else if(Array.isArray(prepared?.messages)){providerMessages=prepared.messages;providerView=prepared}
    }
    const requestMetrics=nativeRequestMetrics(providerMessages,requestTools,{toolSchemaCache:requestMetricsToolCache,messageSerializationCache:requestMetricsMessageCache,currentTurnBreakdownCache:requestMetricsCurrentTurnCache,historyHashCache:requestMetricsHistoryHashCache,messageClassificationCache:requestMetricsClassificationCache});
    const inferenceId=(metadata?.sessionId?String(metadata.sessionId):"native")+":inference:"+modelTurns;
    if(Number(providerView?.count||0)>0)emit(onEvent,{name:"native.context.provider_view_compacted",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,count:Number(providerView.count||0),savedChars:Number(providerView.savedChars||0)}});
    emit(onEvent,{name:"native.model.requested",status:"running",model:String(model),provider:provider||null,data:{inferenceId,modelTurn:modelTurns,messageCount:providerMessages.length,toolCount:Array.isArray(requestTools)?requestTools.length:0,sessionId:metadata?.sessionId||null,compaction:Boolean(metadata?.compaction),requestMetrics}});
    const providerAttempts=boundedInteger(maxProviderAttempts,3,{min:1,max:8});let response=null;
    for(let attempt=1;attempt<=providerAttempts;attempt++){
      try{
        response=await providerTurn({model,provider,messages:providerMessages,tools:requestTools,toolChoice:requestToolChoice,maxOutputTokens,temperature,reasoningEffort,parallelToolCalls,signal:turnSignal,metadata,[NATIVE_TOOL_SCHEMA_FINGERPRINT]:requestMetrics[NATIVE_TOOL_SCHEMA_FINGERPRINT]||null,[NATIVE_OPENAI_CONTINUATION_IDENTITY]:openAiContinuationIdentity,[NATIVE_CHAT_MESSAGE_CACHE_IDENTITY]:openAiContinuationIdentity});break;
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
    if(!calls.length&&!responseText.trim()){
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
      if(completionGateCandidate){
        completionGateChecks++;
        const candidate=completionGateCandidate,verdict=parseCompletionGateVerdict(responseText);
        if(!verdict){
          if(completionGateInvalidResponses<1&&modelTurns<budget.maxModelTurns){
            completionGateInvalidResponses++;
            conversation.push({role:"developer",content:"Trebell completion gate parser could not read the previous control response. Return only one valid JSON object with exactly these fields: {\"status\":\"complete|incomplete|blocked\",\"unresolved\":[\"...\"],\"reason\":\"...\"}. Do not call tools and do not address the user."});
            emit(onEvent,{name:"native.completion.gate_retry",status:"retrying",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,invalidResponses:completionGateInvalidResponses}});
            continue;
          }
          completionGateCandidate=null;completionGateInvalidResponses=0;completionGateRecoveries++;
          conversation.push({role:"developer",content:"Trebell completion gate could not establish that the proposed final answer is complete. Continue the task instead of finalizing. Re-read the user's requirements and the strongest recent evidence, identify the single most important unresolved acceptance condition, and use the available tools to resolve or decisively falsify it. Do not weaken the user's requirement merely because the prior control response was malformed."});
          emit(onEvent,{name:"native.completion.gate",status:"retrying",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,verdict:"invalid",recoveryAttempt:completionGateRecoveries}});
          continue;
        }
        completionGateCandidate=null;completionGateInvalidResponses=0;
        emit(onEvent,{name:"native.completion.gate",status:verdict.status==="complete"?"completed":verdict.status==="blocked"?"blocked":"retrying",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,verdict:verdict.status,unresolved:verdict.unresolved,reason:verdict.reason}});
        if(verdict.status==="complete"||verdict.status==="blocked"){
          const result={
            text:candidate.text,model:candidate.model,provider:candidate.provider,
            messages:conversation,modelTurns,toolCalls,usage,startedAt,completedAt:Date.now(),durationMs:duration(started),lastResponse,
          };
          emit(onEvent,{name:"native.turn.completed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,durationMs:result.durationMs,usage,completionGateVerdict:verdict.status}});
          return result;
        }
        completionGateRecoveries++;
        const unresolved=verdict.unresolved.length?verdict.unresolved.map(item=>"- "+item).join("\n"):"- Re-evaluate the user's material acceptance requirements against the evidence.";
        const reason=verdict.reason?"\nGate rationale: "+verdict.reason:"";
        conversation.push({role:"developer",content:"Trebell semantic completion gate rejected the proposed final answer as incomplete. Continue working; do not simply restate the candidate answer. Resolve the highest-value unmet requirement using the evidence and tools already available. If current evidence contradicts an upstream parser/decoder/adapter/schema/measurement assumption, validate that assumption from a lower-level independent source rather than permuting outputs produced by the same suspect abstraction.\nUnresolved requirements:\n"+unresolved+reason});
        emit(onEvent,{name:"native.completion.gate_recovery",status:"retrying",model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,data:{modelTurn:modelTurns,editRevision,recoveryAttempt:completionGateRecoveries,unresolved:verdict.unresolved}});
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
      if(workspaceMutationRequested&&selfAdmittedGapCanRecover&&canVerifyLocally&&!toolBudgetExhausted&&(!verifiedFinalizationReady||hasFailedAcceptanceGap)&&selfAdmittedGapRecoveries<maxSelfAdmittedGapRecoveries&&shouldRecoverSelfAdmittedGap&&modelTurns<budget.maxModelTurns&&selfAdmittedGapKind){
        selfAdmittedGapRecoveries++;
        selfAdmittedGapRecoveryToolBaseline=toolCalls;
        const recoveryMessage=preEditCompletionBlockerChallenge
          ? "Your previous draft concludes that a required mutation, restoration, or reconstruction cannot be completed before any confirmed workspace edit. Before accepting that blocker, do one bounded falsification pass. Do not fabricate, approximate, substitute, or weaken an exact-data requirement. Test whether the intended state can be reconstructed from local evidence already present: reversible transforms or mappings, internal redundancy, peer/majority consistency, deterministic encodings, checksums or metadata, logs/history, or other invariants that distinguish the intended state. Prefer one batched script or focused tool response that compares the strongest remaining hypotheses. If exact recovery is supported, implement it and exercise the requested acceptance path; if not, end with the blocker and the decisive negative evidence."
          : selfAdmittedGapKind==="verification"&&hasFailedAcceptanceGap&&selfAdmittedGapRecoveries===1
            ? "Your previous draft says a required acceptance or verification check actually failed, so the task is not complete. Do not merely rerun the same failing check or weaken its acceptance criterion. Treat the failure as diagnostic evidence: identify the earliest or most specific mismatch you can measure, compare the strongest remaining hypotheses in one bounded batched probe, make the evidence-supported repair, and rerun the exact acceptance path. If an observed result contradicts a documented invariant, replication guarantee, identity relation, or format contract, challenge the upstream parsing, decoding, measurement, or ordering assumption before spending more work on downstream permutations of already-derived values. When challenging an upstream abstraction, the falsification must cross that abstraction boundary: do not reuse the suspect parser/decoder/adapter/mapper to produce both the observed and expected values. Inspect the lower-level source independently and re-derive the relevant offsets, framing, ordering, units, or mapping from source-of-truth evidence before deciding the invariant itself is unreliable. Preserve the user's original exactness requirement."
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
      if(semanticCompletionGate===true&&workspaceMutationRequested&&editRevision>0&&modelTurns<budget.maxModelTurns){
        completionGateCandidate={text:responseText,model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null};
        completionGateInvalidResponses=0;
        conversation.push({role:"developer",content:"Trebell semantic completion gate. This is an internal control check, not the user-visible answer. Evaluate the immediately preceding candidate final answer against the user's full request and the evidence in this conversation. Return only one JSON object: {\"status\":\"complete|incomplete|blocked\",\"unresolved\":[\"material unmet requirement\"],\"reason\":\"brief evidence-based rationale\"}. Use status=complete only when every material requested deliverable and acceptance condition is supported by the available evidence. Use status=incomplete when additional local tool work could still resolve an unmet or uncertain requirement. Use status=blocked only when a material requirement genuinely cannot be completed with the available inputs/tools or depends on an unavailable external condition. Do not infer success merely from a process exit code when tool output, measurements, or the candidate answer contradict the actual requirement. Judge semantics and evidence, not wording. Do not call tools and do not address the user."});
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
    const editRevisionBeforeCalls=editRevision,responseHasEditCall=calls.some(implementationPressureEditCall),preEditBlockerChallengeBypass=preEditBlockerChallengeToolAllowance&&editRevision===0,revisionChurnFailureEvidence=revisionChurnEscalated&&terminalRuns.some(item=>item?.currentTurn&&item?.editRevision===editRevisionBeforeCalls&&item?.exitCode!==0);let redirected=false,blockedPreEditCall=false,blockedPostEditProbeCall=false,blockedPostEditEvidenceCall=false,blockedRevisionChurnEdit=false,executedPreEditEvidence=false,executedPostEditEvidence=false;
    if(preEditBlockerChallengeBypass){
      preEditBlockerChallengeToolAllowance=false;
      emit(onEvent,{name:"native.completion.blocker_challenge_evidence_allowed",status:"completed",model:String(model),provider:provider||null,data:{modelTurn:modelTurns,toolCalls,callCount:calls.length}});
    }
    for(let callIndex=0;callIndex<calls.length;){
      const call=calls[callIndex];
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
      const escalatedPreEditEvidenceBlocked=editRevision===0&&!preEditBlockerChallengeBypass&&implementationPressureEscalated&&!responseHasEditCall&&!implementationPressureEditCall(call);
      const singletonPreEditEvidenceBlocked=editRevision===0&&!preEditBlockerChallengeBypass&&calls.length===1&&!implementationPressureEditCall(call)&&!implementationPressureBatchCall(call)&&(implementationPressure||probeBatchingRequired);
      const escalatedPostEditEvidenceBlocked=editRevision>0&&postEditEvidenceEscalated&&!responseHasEditCall&&!implementationPressureEditCall(call);
      const escalatedRevisionChurnEditBlocked=revisionChurnEscalated&&revisionChurnGraceEditUsed&&!revisionChurnFailureEvidence&&implementationPressureEditCall(call);
      const singletonPostConvergenceTerminalBlocked=editRevision>0&&convergenceCheckpointRevision===editRevision&&calls.length===1&&call?.namespace==="trebell_terminal"&&call?.name==="run"&&!implementationPressureBatchCall(call);
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
      const singletonPostEditProbeBlocked=editRevision>0&&postEditProbeBatchingRequired&&calls.length===1&&call?.namespace==="trebell_terminal"&&call?.name==="run"&&!implementationPressureBatchCall(call);
      if(singletonPostEditProbeBlocked){
        const callId=String(call?.id||""),toolCallNumber=toolCalls+1;toolCalls=toolCallNumber;
        conversation.push({role:"tool",toolCallId:callId,content:"Trebell post-edit probe batching: this singleton terminal probe was not executed because too many recent reasoning turns have each spent one round trip on a single probe after the latest workspace edit. Batch the remaining independent checks into one multi-tool response or one bounded adaptive script, make another evidence-supported workspace edit, or answer now if the task is complete."});
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
      const remainingBudget=budget.maxToolCalls-toolCalls,batch=[call];
      if(canRunParallel(call)){
        for(let next=callIndex+1;next<calls.length&&batch.length<parallelLimit&&batch.length<remainingBudget;next++){
          if(!canRunParallel(calls[next]))break;
          batch.push(calls[next]);
        }
      }
      const prepared=batch.map((item,index)=>({call:item,toolCallNumber:toolCalls+index+1}));
      if(editRevision===0&&implementationPressure&&!responseHasEditCall&&prepared.some(item=>!implementationPressureEditCall(item.call)))executedPreEditEvidence=true;
      if(editRevisionBeforeCalls>0&&!responseHasEditCall&&prepared.some(item=>!implementationPressureEditCall(item.call)))executedPostEditEvidence=true;
      toolCalls+=prepared.length;
      const observations=prepared.length>1
        ?await Promise.all(prepared.map(item=>executeOneTool(item.call,item.toolCallNumber)))
        :[await executeOneTool(prepared[0].call,prepared[0].toolCallNumber)];
      conversation.push(...observations);
      callIndex+=batch.length;
    }
    if(redirected)continue;
    if(editRevision===0&&implementationPressure&&executedPreEditEvidence)implementationPressureEvidenceRounds++;
    if(editRevision>editRevisionBeforeCalls){
      if(revisionChurnEscalated)revisionChurnGraceEditUsed=true;
      singletonTerminalProbeStreak=0;
      postEditProbeBatchingRequired=false;
      postEditEvidenceRounds=0;
      postEditAssumptionAuditRevision=0;
      postEditEvidenceCheckpointRevision=0;
      postEditEvidenceEscalated=false;
    }else if(!blockedPreEditCall&&!blockedPostEditProbeCall&&!blockedRevisionChurnEdit&&calls.length===1&&calls[0]?.namespace==="trebell_terminal"&&calls[0]?.name==="run"&&!implementationPressureBatchCall(calls[0])){
      singletonTerminalProbeStreak++;
    }else if(calls.length>0&&!blockedPreEditCall&&!blockedPostEditProbeCall){
      singletonTerminalProbeStreak=0;
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
