import { performance } from "node:perf_hooks";
import { nativeRequestMetrics, NATIVE_PROMPT_PROVENANCE } from "./native-request-metrics.mjs";
import { platformToolAllowedByAllowlist } from "./shared-tool-gateway.mjs";
import { nativeCommandSemanticError, normalizeNativeCommandArguments } from "./native-command-argv.mjs";
import { redactSecretText } from "./secret-redactor.mjs";
import { coolVirtualizedToolContent } from "./native-tool-history.mjs";

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

function protocolAliasMatches(namespace,name,tools=[]){
  const rawNamespace=String(namespace||"").trim(),rawName=String(name||"").trim();if(!rawName)return [];
  const pairs=exposedToolPairs(tools),namespaceExists=rawNamespace&&pairs.some(item=>item.namespace===rawNamespace);
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

function misplacedToolMatches(namespace,name,tools=[]){
  const rawNamespace=String(namespace||"").trim(),rawName=String(name||"").trim(),pairs=exposedToolPairs(tools);
  if(!rawNamespace.startsWith("trebell_")||!rawName||!pairs.some(item=>item.namespace===rawNamespace))return [];
  if(pairs.some(item=>item.namespace===rawNamespace&&item.name===rawName))return [];
  return pairs.filter(item=>item.namespace.startsWith("trebell_")&&item.name===rawName);
}

function repairCorruptedToolCall(call,tools=[]){
  const namespace=String(call?.namespace||"").trim(),name=String(call?.name||"").trim();
  if(!name)return {call,repaired:false};
  const aliasMatches=protocolAliasMatches(namespace,name,tools);
  if(aliasMatches.length===1){
    const target=aliasMatches[0];
    if(target.namespace!==namespace||target.name!==name)return {call:{...call,namespace:target.namespace||null,name:target.name},repaired:true,originalName:name,reason:"protocol_alias"};
  }
  const misplacedMatches=misplacedToolMatches(namespace,name,tools);
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

function escapeRegex(value){return String(value||"").replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}

function explicitlyRequestedTools(messages=[],tools=[]){
  const user=[...(Array.isArray(messages)?messages:[])].reverse().find(message=>message?.role==="user"),text=messageText(user);
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
  const user=[...(Array.isArray(messages)?messages:[])].reverse().find(message=>message?.role==="user"),text=messageText(user);
  if(!text)return null;
  const match=text.match(/\b(?:after|once|when)\b\s*([^.\n]{1,220}?)\s+\b(?:pass(?:es|ed|ing)?|succeed(?:s|ed)?|successful)\b[^.\n]{0,220}\b(?:answer|respond|reply|summari[sz](?:e|ing|ation)?|summary)\b/i);
  if(!match)return null;
  const target=String(match[1]||"").trim();if(!target)return null;
  return {target:/^(?:it|this|that|them|the|a|an)$/i.test(target)?null:target};
}

function explicitSummaryAfterVerification(messages=[]){
  const user=[...(Array.isArray(messages)?messages:[])].reverse().find(message=>message?.role==="user"),text=messageText(user);
  if(!text)return false;
  return /\b(?:after|once|when)\b[^.\n]{0,220}\b(?:pass(?:es|ed|ing)?|succeed(?:s|ed)?|successful)\b[^.\n]{0,220}\b(?:(?:concise|brief|short)\s+summary|summari[sz]e\s+(?:briefly|concisely)|(?:briefly|concisely)\s+summari[sz]e)\b/i.test(text);
}

function explicitLiteralAfterVerification(messages=[]){
  const user=[...(Array.isArray(messages)?messages:[])].reverse().find(message=>message?.role==="user"),text=lastUserInstructionText(user);
  if(!text)return null;
  const prefix="\\b(?:after|once|when)\\b[^.\\n]{0,220}\\b(?:pass(?:es|ed|ing)?|succeed(?:s|ed)?|successful)\\b[^.\\n]{0,220}\\b(?:answer|respond|reply)\\s+(?:with\\s+)?exactly\\s+";
  const quoted=text.match(new RegExp(prefix+"([\\\"'`])([^\\r\\n]{1,160})\\1\\s*[.!]?\\s*$","i"));
  if(quoted)return quoted[2];
  const token=text.match(new RegExp(prefix+"([A-Za-z0-9][A-Za-z0-9_.:/-]{0,79})\\s*[.!]?\\s*$","i"));
  return token?token[1]:null;
}

function explicitVerificationCompletion(messages=[]){
  const user=[...(Array.isArray(messages)?messages:[])].reverse().find(message=>message?.role==="user"),text=lastUserInstructionText(user);
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
  const user=[...(Array.isArray(messages)?messages:[])].reverse().find(message=>message?.role==="user"),text=lastUserInstructionText(user);
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
  const quoted=cwd.match(/^(?:`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)')$/);if(quoted)cwd=String(quoted[1]||quoted[2]||quoted[3]||"").trim();
  if(!cwd||cwd.length>240||/[\r\n\0]/.test(cwd)||/^[\\/]/.test(cwd)||/^[A-Za-z]:[\\/]/.test(cwd)||/:\/\//.test(cwd))return null;
  if(/\s/.test(cwd)||!/[\\/]/.test(cwd))return null;
  const normalized=cwd.replace(/\\/g,"/"),parts=normalized.split("/");
  if(parts.some(part=>!part||part===".."||part==="."))return null;
  if(parts.some(part=>!/^[A-Za-z0-9._@+-]+$/.test(part)))return null;
  return normalized;
}
function explicitTerminalStatusCommand(messages=[]){
  if(!explicitTerminalStatusRequest(messages))return null;
  const user=[...(Array.isArray(messages)?messages:[])].reverse().find(message=>message?.role==="user"),text=lastUserInstructionText(user),run=[...text.matchAll(/\b(?:run|execute)\b/ig)][0];
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
  const normalized=normalizeNativeCommandArguments({command:raw,...(cwd?{cwd}:{})});if(nativeCommandSemanticError(normalized))return null;
  const command=String(normalized.command||"").trim(),args=Array.isArray(normalized.args)?normalized.args.map(value=>String(value)):[];if(!command||/\s/.test(command)||args.length>48)return null;
  const executable=command.replace(/^.*[\\/]/,"").toLowerCase();if(DIRECT_STATUS_NATURAL_COMMANDS.has(executable)||DIRECT_STATUS_SHELLS.has(executable))return null;
  if(args.some(arg=>/^(?:-e|-c|--eval|--execute|--command|-command|-encodedcommand)$/i.test(String(arg))))return null;
  const direct={command,args,...(cwd?{cwd}:{})};return terminalRunLooksLikeVerifier(direct)?direct:null;
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
  maxOutputTokens=null,temperature=null,parallelToolCalls=true,maxModelTurns=24,maxToolCalls=100,maxWallTimeMs=null,
  maxProviderAttempts=3,retryBaseDelayMs=250,consumeSteering=null,isToolParallelSafe=null,maxParallelToolCalls=8,toolAllowlist=null,coolReadToolHistory=null,preserveToolSchemasOnFinalization=false,signal=null,onEvent=null,metadata=null,
  autoRerunVerification=false,priorTerminalRuns=[],synthesizeTerminalReports=false,coolSyntheticTerminalReportOutput=true,directTerminalStatusCommands=false,
}={}){
  if(typeof providerTurn!=="function")throw new Error("Native agent loop requires a providerTurn function.");
  if(typeof executeTool!=="function")throw new Error("Native agent loop requires an executeTool function.");
  if(!String(model||"").trim())throw new Error("Native agent loop requires a model.");
  const budget=nativeAgentBudget({maxModelTurns,maxToolCalls,maxWallTimeMs}),conversation=[...(Array.isArray(messages)?messages:[])];
  const explicitlyRequired=explicitlyRequestedTools(conversation,providerVisibleTools(tools,toolAllowlist)),executedToolKeys=new Set(),requiredToolRecoveries=new Set();
  const finalAfterVerifiedRequest=explicitFinalAnswerAfterVerification(conversation),finalAfterVerifiedCommand=Boolean(finalAfterVerifiedRequest),summaryAfterVerifiedCommand=explicitSummaryAfterVerification(conversation),literalAfterVerifiedCommand=explicitLiteralAfterVerification(conversation),verificationCompletionRequest=explicitVerificationCompletion(conversation),verificationCompletionRequested=Boolean(verificationCompletionRequest),terminalStatusRequested=explicitTerminalStatusRequest(conversation),directTerminalStatusCommand=directTerminalStatusCommands===true?explicitTerminalStatusCommand(conversation):null,terminalRuns=priorTerminalEvidence(priorTerminalRuns),verifiedEdits=[];
  const verificationFinalizationRequest=verificationCompletionRequest||(finalAfterVerifiedRequest?.target?finalAfterVerifiedRequest:null);
  const successfulTerminalRuns=[];
  let modelTurns=0,toolCalls=0,emptyCompletionRecoveries=0,toolBudgetTextRecoveries=0,verifiedFinalizationRecoveries=0,forcedToolChoice=null,lastProviderReadMessageCount=0,toolBudgetFinalizationInjected=false,verifiedFinalizationAllowed=finalAfterVerifiedCommand||verificationCompletionRequested,verifiedFinalizationReady=false,verifiedFinalizationInjected=false,editRevision=0,usage={inputTokens:0,outputTokens:0,totalTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0},lastResponse=null;
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
    emit(onEvent,{name:"native.tool.requested",status:"running",model:String(model),provider:provider||null,data:{toolCall:toolCallNumber,callId,namespace,name}});
    let output,success=true,errorMessage=null,uncertain=false,retrySafe=false;
    try{
      output=await executeTool({id:callId,namespace,name,arguments:args,rawArguments:call?.arguments??"{}",signal:turnSignal,modelTurn:modelTurns,toolCall:toolCallNumber});
      throwIfAborted(turnSignal);
      if(output?.success===false){success=false;errorMessage=String(output.error||output.message||"Tool execution failed.");uncertain=output?.uncertain===true;retrySafe=output?.retrySafe===true}
    }catch(error){
      if(turnSignal?.aborted||error?.name==="AbortError")throw abortError(turnSignal);
      success=false;errorMessage=error?.message||String(error);output={success:false,error:errorMessage};
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
    return {role:"tool",toolCallId:callId,content};
  };
  const finishTerminalStatus=(call,run,{responseText="",direct=false}={})=>{
    const text=terminalStatusText(run);if(!text)return null;
    if(coolSyntheticTerminalReportOutput!==false&&call?.id){
      const index=conversation.findLastIndex(message=>message?.role==="tool"&&String(message?.toolCallId||message?.tool_call_id||"")===String(call.id));
      if(index>=0&&typeof conversation[index]?.content==="string"){
        const before=conversation[index].content,after=coolVirtualizedToolContent(before,{maxPreviewChars:600,includePreview:false});
        if(after!==before){conversation[index]={...conversation[index],content:after};emit(onEvent,{name:"native.tool.history_cooled",status:"completed",model:String(lastResponse?.model||model),provider:lastResponse?.provider||provider||null,data:{phase:"terminal_report",count:1,savedChars:Math.max(0,before.length-after.length),toolResultCount:1,toolCallArgumentCount:0,toolResultSavedChars:Math.max(0,before.length-after.length),toolCallArgumentSavedChars:0}})}
      }
    }
    conversation.push({role:"assistant",content:text,toolCalls:[]});
    const result={text,model:String(lastResponse?.model||model),provider:lastResponse?.provider||provider||null,messages:conversation,modelTurns,toolCalls,usage,startedAt,completedAt:Date.now(),durationMs:duration(started),lastResponse:null};
    if(direct)emit(onEvent,{name:"native.terminal.direct_status_executed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,exitCode:run.exitCode}});
    emit(onEvent,{name:"native.terminal.report_synthesized",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,exitCode:run.exitCode,evidence:Boolean(run.reportEvidence),discardedPreToolTextChars:String(responseText||"").length,direct}});
    emit(onEvent,{name:"native.turn.completed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,durationMs:result.durationMs,usage,syntheticTerminalReport:true,directTerminalStatus:direct}});
    return result;
  };
  emit(onEvent,{name:"native.turn.started",status:"running",model:String(model),provider:provider||null,data:{...metadata,maxModelTurns:budget.maxModelTurns,maxToolCalls:budget.maxToolCalls,maxWallTimeMs:budget.maxWallTimeMs}});
  try{
    const directTerminalVisible=directTerminalStatusCommand&&budget.maxToolCalls>0&&exposedToolPairs(providerVisibleTools(tools,toolAllowlist)).some(item=>item.namespace==="trebell_terminal"&&item.name==="run");
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
      const error=new Error(`Native agent model-turn budget exhausted (${modelTurns}/${budget.maxModelTurns}).`);error.code="native_model_turn_budget";
      emit(onEvent,{name:"native.turn.blocked",status:"blocked",model:String(model),provider:provider||null,data:{reason:error.code,modelTurns,toolCalls}});throw error;
    }
    const visibleTools=providerVisibleTools(tools,toolAllowlist),toolBudgetExhausted=visibleTools.length>0&&toolCalls>=budget.maxToolCalls;
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
    const requestStarted=nowMs(),requestMessageCount=conversation.length,forcedAllowlist=forcedToolChoice?[forcedToolChoice.namespace?forcedToolChoice.namespace+"/"+forcedToolChoice.name:forcedToolChoice.name]:null,finalAnswerOnly=toolBudgetExhausted||verifiedFinalizationReady,requestTools=finalAnswerOnly&&!preserveToolSchemasOnFinalization?[]:forcedAllowlist?providerVisibleTools(visibleTools,forcedAllowlist):visibleTools,requestToolChoice=finalAnswerOnly?"none":forcedToolChoice||toolChoice;
    const requestMetrics=nativeRequestMetrics(conversation,requestTools);
    const inferenceId=(metadata?.sessionId?String(metadata.sessionId):"native")+":inference:"+modelTurns;
    emit(onEvent,{name:"native.model.requested",status:"running",model:String(model),provider:provider||null,data:{inferenceId,modelTurn:modelTurns,messageCount:conversation.length,toolCount:Array.isArray(requestTools)?requestTools.length:0,sessionId:metadata?.sessionId||null,compaction:Boolean(metadata?.compaction),requestMetrics}});
    const providerAttempts=boundedInteger(maxProviderAttempts,3,{min:1,max:8});let response=null;
    for(let attempt=1;attempt<=providerAttempts;attempt++){
      try{
        response=await providerTurn({model,provider,messages:conversation,tools:requestTools,toolChoice:requestToolChoice,maxOutputTokens,temperature,parallelToolCalls,signal:turnSignal});break;
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
    const rawCalls=Array.isArray(lastResponse.toolCalls)?lastResponse.toolCalls:[],calls=rawCalls.map(call=>{
      const normalized=repairCorruptedToolCall(call,requestTools);
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
      const result={
        text:responseText,model:String(lastResponse.model||model),provider:lastResponse.provider||provider||null,
        messages:conversation,modelTurns,toolCalls,usage,startedAt,completedAt:Date.now(),durationMs:duration(started),lastResponse,
      };
      emit(onEvent,{name:"native.turn.completed",status:"completed",model:result.model,provider:result.provider,data:{modelTurns,toolCalls,durationMs:result.durationMs,usage}});
      return result;
    }
    const editRevisionBeforeCalls=editRevision;let redirected=false;
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
      const remainingBudget=budget.maxToolCalls-toolCalls,batch=[call];
      if(canRunParallel(call)){
        for(let next=callIndex+1;next<calls.length&&batch.length<parallelLimit&&batch.length<remainingBudget;next++){
          if(!canRunParallel(calls[next]))break;
          batch.push(calls[next]);
        }
      }
      const prepared=batch.map((item,index)=>({call:item,toolCallNumber:toolCalls+index+1}));
      toolCalls+=prepared.length;
      const observations=prepared.length>1
        ?await Promise.all(prepared.map(item=>executeOneTool(item.call,item.toolCallNumber)))
        :[await executeOneTool(prepared[0].call,prepared[0].toolCallNumber)];
      conversation.push(...observations);
      callIndex+=batch.length;
    }
    if(redirected)continue;
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
