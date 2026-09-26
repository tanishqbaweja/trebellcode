const NOTE_FIELDS=["completedWork","unresolvedFailures","importantDecisions","artifactsCreated","pendingNextActions"];

function text(value,max=1600){return String(value??"").trim().slice(0,max)}
function list(value,{limit=30,max=1600}={}){
  const source=Array.isArray(value)?value:typeof value==="string"?value.split(/\r?\n/):[];
  return source.map(item=>text(item,max)).filter(Boolean).slice(0,limit);
}
function unique(values,limit=30){
  const seen=new Set(),out=[];
  for(const value of values||[]){const item=text(value);if(!item||seen.has(item))continue;seen.add(item);out.push(item);if(out.length>=limit)break}
  return out;
}
function queuedText(item){
  return (item?.input||[]).filter(part=>part?.type==="text").map(part=>text(part.text,800)).filter(Boolean).join("\n").slice(0,800);
}
function verificationSummary(value){
  if(value==null)return "";
  if(typeof value==="string"||typeof value==="number"||typeof value==="boolean")return text(value,2000);
  if(typeof value!=="object")return "";
  const required=Math.max(0,Number(value.required)||0),passed=Math.max(0,Number(value.passed)||0),failed=Math.max(0,Number(value.failed)||0),blocked=Math.max(0,Number(value.blocked)||0),missing=Math.max(0,Number(value.missing)||0);
  const parts=[`${passed}/${required} required checks passed`];
  if(failed)parts.push(`${failed} failed`);
  if(blocked)parts.push(`${blocked} blocked`);
  if(missing)parts.push(`${missing} missing`);
  return parts.join(" · ");
}
function verificationIssues(value){
  return (Array.isArray(value)?value:[]).map(item=>{
    if(typeof item==="string")return text(item,1000);
    const id=text(item?.id,200),reason=text(item?.reason,800);
    return [id,reason].filter(Boolean).join(" · ");
  }).filter(Boolean).slice(0,20);
}
function recoveryToolLabel(item={}){
  const tool=[text(item.namespace,200),text(item.tool,300)].filter(Boolean).join("/")||text(item.command,500)||text(item.type,200)||"tool/action";
  const status=text(item.status,120);return status?`${tool} · ${status}`:tool;
}

export function normalizeContinuityNotes(previous=null,patch={},now=Date.now()){
  const prior=previous&&typeof previous==="object"?previous:{},next={updatedAt:now};
  for(const field of NOTE_FIELDS)next[field]=Object.prototype.hasOwnProperty.call(patch,field)?list(patch[field]):list(prior[field]);
  return next;
}

export function continuitySnapshot({
  threadId,thread=null,meta={},goal=null,verificationRecords=[],checkpoints=[],traces=[],
}={}){
  const rawNotes=meta?.continuityNotes&&typeof meta.continuityNotes==="object"?meta.continuityNotes:null;
  const notes=rawNotes
    ?normalizeContinuityNotes(rawNotes,{},Number(rawNotes.updatedAt)||0)
    :{completedWork:[],unresolvedFailures:[],importantDecisions:[],artifactsCreated:[],pendingNextActions:[],updatedAt:0};
  const latestVerification=(verificationRecords||[])[0]||null;
  const queued=(meta?.queuedSubmissions||meta?.trebellQueue||[]).map(queuedText).filter(Boolean).slice(0,10);
  const failedTrace=(traces||[]).filter(item=>{
    const status=String(item?.status||"").toLowerCase(),name=String(item?.name||"").toLowerCase();
    return ["failed","error"].includes(status)||name==="error"||name.endsWith(".failed");
  }).slice(0,10);
  const traceFailures=failedTrace.map(item=>text(item?.data?.message||item?.data?.summary||item?.name,1000));
  const checkpointArtifacts=(checkpoints||[]).slice(0,10).map(item=>{
    const label=text(item?.label,300),commit=text(item?.commit,120),root=text(item?.root,500);
    return [label,commit&&("commit "+commit),root&&("at "+root)].filter(Boolean).join(" · ");
  }).filter(Boolean);
  const completedTurns=(thread?.turns||[]).filter(turn=>turn?.status==="completed").slice(-10).map(turn=>String(turn.id));
  const rawRecovery=thread?.recovery&&typeof thread.recovery==="object"?thread.recovery:null;
  const recovery=rawRecovery?{
    pending:Boolean(rawRecovery.pending),blocked:Boolean(rawRecovery.blocked),turnId:text(rawRecovery.turnId,300)||null,reason:text(rawRecovery.reason,300)||null,message:text(rawRecovery.message,1600)||null,
    uncertainTools:(Array.isArray(rawRecovery.uncertainTools)?rawRecovery.uncertainTools:[]).map(recoveryToolLabel).filter(Boolean).slice(0,20),
  }:null;
  const workspace={
    cwd:text(thread?.cwd||meta?.cwd,1000)||null,
    branch:text(meta?.branch,300)||null,
    environmentId:meta?.environmentId==null?null:String(meta.environmentId),
    runtime:text(thread?.runtime||meta?.runtime,120)||null,
    runtimeInstanceId:text(thread?.runtimeInstanceId||meta?.runtimeInstanceId,200)||null,
  };
  const snapshot={
    threadId:String(threadId||thread?.id||goal?.threadId||""),
    objective:goal?.status==="active"?text(goal.objective,4000)||null:null,
    notes,
    workspace,
    verification:latestVerification?{
      status:text(latestVerification.status,120)||null,risk:text(latestVerification.risk,120)||null,
      verified:Boolean(latestVerification.assessment?.verified),summary:verificationSummary(latestVerification.assessment?.summary)||null,
      missing:verificationIssues(latestVerification.assessment?.missing),
      failures:verificationIssues(latestVerification.assessment?.failures),
      blocked:verificationIssues(latestVerification.assessment?.blocked),
      updatedAt:Number(latestVerification.updatedAt)||null,
    }:null,
    recovery,
    completedTurnIds:completedTurns,
    unresolvedFailures:unique([...notes.unresolvedFailures,...(recovery?.blocked&&recovery.message?[recovery.message]:[])],20),
    recentFailures:unique(traceFailures,20),
    artifactsCreated:unique([...notes.artifactsCreated,...checkpointArtifacts],20),
    pendingNextActions:unique([...notes.pendingNextActions,...queued,...(recovery?.blocked?["Inspect the uncertain restart-time tool/action state before repeating any side effect."]:[])],20),
    completedWork:unique(notes.completedWork,30),
    importantDecisions:unique(notes.importantDecisions,30),
    updatedAt:Math.max(Number(notes.updatedAt)||0,Number(latestVerification?.updatedAt)||0,...failedTrace.map(item=>Number(item.at)||0),...((checkpoints||[]).map(item=>Number(item.createdAt)||0))),
  };
  snapshot.meaningful=Boolean(
    snapshot.objective||snapshot.completedWork.length||snapshot.unresolvedFailures.length||snapshot.recentFailures.length||snapshot.importantDecisions.length||
    snapshot.artifactsCreated.length||snapshot.pendingNextActions.length||snapshot.verification||snapshot.recovery||snapshot.completedTurnIds.length
  );
  return snapshot;
}

function listBlock(label,items=[]){
  if(!items?.length)return "";
  return label+":\n"+items.slice(0,12).map(item=>"- "+text(item,1200)).join("\n");
}

export function continuityContextValue(snapshot){
  if(!snapshot?.meaningful)return "";
  const sections=[
    "Persistent Trebell continuity state",
    "This is durable working state reconstructed from Trebell metadata, explicit notes, verification, checkpoints, queue state, and bounded failure traces. The user's current message has priority over stale continuity.",
    snapshot.objective&&("Active goal: "+snapshot.objective),
    snapshot.workspace?.cwd&&("Workspace: "+snapshot.workspace.cwd+(snapshot.workspace.branch?" · branch "+snapshot.workspace.branch:"")),
    snapshot.verification&&("Latest verification: "+[snapshot.verification.status,snapshot.verification.risk,snapshot.verification.summary].filter(Boolean).join(" · ")),
    snapshot.verification&&listBlock("Verification still required",snapshot.verification.missing),
    snapshot.verification&&listBlock("Verification failures",snapshot.verification.failures),
    snapshot.verification&&listBlock("Verification blockers",snapshot.verification.blocked),
    snapshot.recovery&&("Restart recovery: "+(snapshot.recovery.blocked?"blocked because tool/action state is uncertain":snapshot.recovery.pending?"pending automatic continuation":"recorded")+(snapshot.recovery.message?" · "+snapshot.recovery.message:"")),
    snapshot.recovery&&listBlock("Uncertain restart-time tool/actions",snapshot.recovery.uncertainTools),
    listBlock("Completed work",snapshot.completedWork),
    listBlock("Unresolved failures",snapshot.unresolvedFailures),
    listBlock("Recent failure evidence",snapshot.recentFailures),
    listBlock("Important decisions",snapshot.importantDecisions),
    listBlock("Artifacts created",snapshot.artifactsCreated),
    listBlock("Pending next actions",snapshot.pendingNextActions),
    snapshot.completedTurnIds?.length&&("Recent completed turn ids: "+snapshot.completedTurnIds.slice(-10).join(", ")),
  ].filter(Boolean);
  return sections.join("\n\n").slice(0,16_000);
}

export function continuityAdditionalContext(additionalContext,snapshot){
  const value=continuityContextValue(snapshot);if(!value)return additionalContext;
  const base=additionalContext&&typeof additionalContext==="object"&&!Array.isArray(additionalContext)?additionalContext:{};
  return {...base,"trebell.continuity":{kind:"application",value}};
}
