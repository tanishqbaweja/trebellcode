const TEST_ENTRY_POINT_PREFIX="Test entry points (detected from repository files; unverified): ";
const TEST_ENTRY_POINT_MAX_BYTES=200;

function utf8ByteLength(value){
  let bytes=0;
  for(const character of String(value||"")){const code=character.codePointAt(0);bytes+=code<0x80?1:code<0x800?2:code<0x10000?3:4}
  return bytes;
}

// One bounded line inside the untrusted seed. Whole commands are kept or dropped so truncation never yields a partial command.
function testEntryPointLine(packet){
  const commands=[...new Set((Array.isArray(packet?.testEntryPoints)?packet.testEntryPoints:[])
    .map(entry=>String(entry?.command||"").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g," ").trim()).filter(Boolean))].slice(0,3);
  let line="";
  for(const command of commands){
    const next=line?line+"; "+command:TEST_ENTRY_POINT_PREFIX+command;
    if(utf8ByteLength(next)>TEST_ENTRY_POINT_MAX_BYTES)break;
    line=next;
  }
  return line;
}

export function repositoryContextSeed(packet={},{currentTask=""}={}){
  const items=(Array.isArray(packet?.items)?packet.items:[]).slice(0,8),entryPoints=testEntryPointLine(packet);
  if(!items.length&&!entryPoints)return "";
  const lines=[
    "Trebell repository seed (untrusted metadata; use repository/workspace tools to inspect exact source before editing).",
  ];
  const task=String(packet?.task||"").trim(),visibleTask=String(currentTask||"").trim();
  if(task&&task!==visibleTask)lines.push("Task: "+task.slice(0,800));
  if(items.length)lines.push("Likely relevant paths:");
  for(const item of items){
    const path=String(item?.path||"").trim();if(!path)continue;
    const reasons=(Array.isArray(item?.reasons)?item.reasons:[]).map(value=>String(value||"").trim()).filter(Boolean).slice(0,2);
    const symbols=(Array.isArray(item?.symbols)?item.symbols:[]).map(symbol=>{
      const name=String(symbol?.name||"").trim(),kind=String(symbol?.kind||"").trim();return name?(kind?kind+" "+name:name):"";
    }).filter(Boolean).slice(0,6);
    let line="- "+path;if(reasons.length)line+=" — "+reasons.join("; ");if(symbols.length)line+=" | symbols: "+symbols.join(", ");
    lines.push(line.slice(0,900));
  }
  const seed=lines.join("\n");
  if(!entryPoints)return seed.slice(0,6000);
  return seed.slice(0,6000-entryPoints.length-1)+"\n"+entryPoints;
}

// The Context Engine's full repository evidence starts with a one-line header, then "Task: <task>" (which may span
// lines), then a fixed selection line. When that task is exactly the request the user is sending, repeating it inside
// untrusted evidence presents the user's own instruction as text embedded in untrusted data, so prompt builders drop
// the task (the seed projection above already omits it). Any other task, such as a continuity anchor, is kept, and
// evidence in another shape is returned unchanged.
const EVIDENCE_SELECTION_LINE="Selection is deterministic and bounded.";
export function repositoryEvidenceWithoutVisibleTask(value="",currentTask=""){
  const text=String(value??""),visible=String(currentTask??"").trim();
  if(!visible)return text;
  const headerEnd=text.indexOf("\n");if(headerEnd<0)return text;
  const taskLine="\nTask: "+visible+"\n",selectionStart=headerEnd+taskLine.length;
  if(!text.startsWith(taskLine,headerEnd)||!text.startsWith(EVIDENCE_SELECTION_LINE,selectionStart))return text;
  return text.slice(0,headerEnd+1)+text.slice(selectionStart);
}

export function repositoryContextDeliveryPacket(packet={},{seedOnly=false,currentTask=""}={}){
  if(!seedOnly||!packet||typeof packet!=="object"||packet.deliveryProjection==="seed")return packet;
  const instructionInjection=String(packet.instructionInjection||"").trim();
  const untrustedInjection=repositoryContextSeed(packet,{currentTask});
  const injection=[instructionInjection,untrustedInjection].filter(Boolean).join("\n\n").trim();
  return {
    ...packet,
    injection,
    instructionInjection,
    untrustedInjection,
    tokenEstimate:Math.ceil(injection.length/4),
    deliveryProjection:"seed",
  };
}

export function repositoryContextEntries(packet={},{seedOnly=false,currentTask=""}={}){
  const instructions=String(packet?.instructionInjection||"").trim();
  const evidence=seedOnly?repositoryContextSeed(packet,{currentTask}):String(packet?.untrustedInjection||"").trim();
  const entries={};
  if(instructions)entries["trebell.repo_instructions"]={kind:"application",value:instructions};
  if(evidence)entries["trebell.repo_evidence"]={kind:"untrusted",value:evidence};
  else if(!instructions){
    const legacy=String(packet?.injection||"").trim();
    if(legacy)entries["trebell.repo_evidence"]={kind:"untrusted",value:legacy};
  }
  return entries;
}
