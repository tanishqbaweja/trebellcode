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
      verified:Boolean(latestVerification.assessment?.verified),summary:text(latestVerification.assessment?.summary,2000)||null,
      updatedAt:Number(latestVerification.updatedAt)||null,
    }:null,
    completedTurnIds:completedTurns,
    unresolvedFailures:unique(notes.unresolvedFailures,20),
    recentFailures:unique(traceFailures,20),
    artifactsCreated:unique([...notes.artifactsCreated,...checkpointArtifacts],20),
    pendingNextActions:unique([...notes.pendingNextActions,...queued],20),
    completedWork:unique(notes.completedWork,30),
    importantDecisions:unique(notes.importantDecisions,30),
    updatedAt:Math.max(Number(notes.updatedAt)||0,Number(latestVerification?.updatedAt)||0,...failedTrace.map(item=>Number(item.at)||0),...((checkpoints||[]).map(item=>Number(item.createdAt)||0))),
  };
  snapshot.meaningful=Boolean(
    snapshot.completedWork.length||snapshot.unresolvedFailures.length||snapshot.recentFailures.length||snapshot.importantDecisions.length||
    snapshot.artifactsCreated.length||snapshot.pendingNextActions.length||snapshot.verification||snapshot.completedTurnIds.length
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
    snapshot.workspace?.cwd&&("Workspace: "+snapshot.workspace.cwd+(snapshot.workspace.branch?" · branch "+snapshot.workspace.branch:"")),
    snapshot.verification&&("Latest verification: "+[snapshot.verification.status,snapshot.verification.risk,snapshot.verification.summary].filter(Boolean).join(" · ")),
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
