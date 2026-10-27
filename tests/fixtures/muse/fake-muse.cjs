// A stand-in Muse Code CLI for tests: `--version` answers as Muse Code 1.4.13 does, and `serve ...` speaks the Muse Session Protocol
// (NDJSON JSON-RPC over stdio) the way Muse 1.4.13 answers it, with frames shaped like the recorded ones in this folder: initialize,
// model/list, session/start and session/resume, session/setApprovalMode and session/setModel, turn/start (a reply streamed and
// completed), turn/steer and turn/interrupt. Its environment steers it:
//   MUSE_FAKE_LOG          a file each start and each frame received is appended to, as JSON lines
//   MUSE_FAKE_MODELS       a file holding model/list's answer ({"result":...}); without it Muse lists no models, as signed out
//   MUSE_FAKE_VERSION      what --version prints (default "Muse Code 1.4.13 (1.4.13-R6996.1)"); MUSE_FAKE_VERSION_EXIT its exit code
//   MUSE_FAKE_REFUSE       a model id session/setModel refuses, as Muse does a model the account cannot use
//   MUSE_FAKE_HOLD         "1": a turn waits for a turn/steer (or a Stop) before it completes, as does a turn whose message says
//                          "hold until steered"
//   MUSE_FAKE_SERVE_FAIL   a file: while it is there, `serve` exits at once with the exit code it holds, after the line Muse writes
//                          for a malformed settings file (3: Muse could not load its settings)
//   MUSE_FAKE_FORGET       a file: while it is there, session/resume answers that the session was not found, as Muse does for a
//                          session its store no longer has
//   MUSE_FAKE_COMPACT      how session/compact goes: unset, its compaction item ends compacted MUSE_FAKE_COMPACT_MS (50) ms later;
//                          "noop" Muse has nothing to compact (no_compactable_history); "hold" the compaction runs until the host ends.
//                          A session with no turn yet is refused (missing_run) whatever it says
// A turn whose message says one of these runs as T3's recorded sessions (muse_permission) and Muse 1.4.13's schema shape them:
//   "ask approval"      asks to run `touch muse-approved.txt` (approval/request and approval/requested, with Muse's own choices),
//                       settles it with the choice decided, and replies APPROVED, ALWAYS ALLOWED or REJECTED
//   "reviewer decides"  asks the same, and Muse's reviewer allows it MUSE_FAKE_REVIEW_MS (300) ms later (approval/resolved by
//                       llmJudge), or once the file MUSE_FAKE_REVIEW_HOLD names is there
//   "read outside"      asks to read outside-notes.txt beside the workspace folder (a fileAccess read, as Muse asks one outside the
//                       workspace), and replies READ IT or REJECTED
//   "child approval"    a workflow child (subagentOrigin, its own run) asks to run the same command while the turn waits until it
//                       is stopped or the child's approval is settled; the child's approval outlives the turn
//   "protected child"   a workflow child asks to write .muse/settings.json, a protected write that offers Allow once and Reject only
//   "staged approval"   asks to run `touch a.txt && rm b.txt` stage by stage: `touch a.txt` first, and once the file MUSE_FAKE_STAGE_HOLD
//                       names is there (else MUSE_FAKE_STAGE_MS, 300 ms, later) Muse's reviewer moves the approval on to `rm b.txt`
//                       (approval/updated, reviewCompleted) with that stage's own choices, a saved rule keeping it out among them; a
//                       decision for a stage the approval moved past is refused as stale (-32053); replies STAGE DECIDED: <choice>
//   "ask question"      asks which approach to take (userInput/request and userInput/requested), settles it with the answer and
//                       replies ANSWERED with it, or NO ANSWER for a cancel
//   "retry"             schedules a retry of its model request (turn/retryScheduled), then replies MUSE_FAKE_RETRY_MS (400) ms later,
//                       or once the file MUSE_FAKE_RETRY_HOLD names is there
//   "quota"             fails as Meta's quota refusal relayed by Muse does (a 429 naming the quota and its reset)
//   "signed out"        fails as a turn Muse could not run without a sign-in does (authRequired)
//   "exit when idle"    replies, completes, and then the host exits with code 1, as a Muse that crashed between turns
//   "dev server in the background"  runs `npm run dev`, which Muse sends to the background (its tool call goes there, item/updated
//                       with background true, then settles), completes the turn, and MUSE_FAKE_BACKGROUND_MS (1500) ms later tells the
//                       command's end as an item of its own naming the call (backgroundTerminalCompletion, MSP 1.4.13)
// And as T3's recorded subagent_v2 and muse_workflow sessions run them, with the token usage and context those reported:
//   "spawn subagent"    keeps a todo list and runs a subagent (role "hello agent"), whose child session replies on its own turn, and
//                       whose result is ready MUSE_FAKE_SUBAGENT_MS (200) ms later; two model steps report their tokens
//   "run workflow"      launches the ping-pong workflow and completes the turn while it runs; its agents ping and pong run
//                       MUSE_FAKE_WORKFLOW_MS (300) ms apart, pong failing on its budget, and MUSE_FAKE_REPORT_DELAY_MS (0) ms after
//                       the workflow has completed, or once the file MUSE_FAKE_REPORT_START_HOLD names is there, Muse starts a report
//                       turn of its own. With MUSE_FAKE_REPORT_HOLD "1" the report
//                       holds after its first sentence until a message comes, which Muse queues behind it (ifBusy queue): the report
//                       then says the rest of its reply and ends, its turn/completed adding up the report's tokens, and the message's
//                       turn runs, reporting its own
const fs=require("node:fs"),readline=require("node:readline");
const log=entry=>{if(process.env.MUSE_FAKE_LOG)fs.appendFileSync(process.env.MUSE_FAKE_LOG,JSON.stringify(entry)+"\n")};
const argv=process.argv.slice(2);
log({start:argv,pid:process.pid,cwd:process.cwd(),env:{MUSE_NO_AUTO_UPDATE:process.env.MUSE_NO_AUTO_UPDATE??null,META_API_KEY:process.env.META_API_KEY?"set":null,MUSE_CHANNEL:process.env.MUSE_CHANNEL??null}});
if(argv[0]==="--version"){process.stdout.write((process.env.MUSE_FAKE_VERSION??"Muse Code 1.4.13 (1.4.13-R6996.1)")+"\n");process.exit(Number(process.env.MUSE_FAKE_VERSION_EXIT||0))}
if(argv[0]!=="serve"){process.stderr.write("fake muse: unknown command "+argv.join(" ")+"\n");process.exit(2)}
if(process.env.MUSE_FAKE_SERVE_FAIL&&fs.existsSync(process.env.MUSE_FAKE_SERVE_FAIL)){
  process.stderr.write("load settings for serve composition: malformed settings file at ~/.config/muse/settings.json\n");
  process.exit(Number(fs.readFileSync(process.env.MUSE_FAKE_SERVE_FAIL,"utf8").trim())||3);
}

const write=frame=>process.stdout.write(JSON.stringify(frame)+"\n");
// What Muse does after a while: once the file hold names is there (a test releases it when it has seen what it waits for), else ms later.
function later(hold,ms,then){if(!hold)return setTimeout(then,ms);const check=()=>fs.existsSync(hold)?then():setTimeout(check,25);check()}
let cursor=0;
const notify=(method,sessionId,params)=>write({jsonrpc:"2.0",method,params:{sessionId,viewCursor:`v:${sessionId}:${++cursor}`,...params},emittedAtMs:Date.now()});
const catalog=()=>{try{return JSON.parse(fs.readFileSync(process.env.MUSE_FAKE_MODELS,"utf8")).result}catch{return {providerId:"meta",profileId:"tbh",source:"bundledCatalog",models:[]}}};
const sessions=new Map(),running=new Map();
const sessionRecord=(sessionId,state)=>({sessionId,status:"idle",activeTurnId:null,workspaceRoot:state.workspaceRoot,providerId:"meta",modelId:state.modelId,turnCount:0,forkedFrom:null,kind:"root"});

function reply(sessionId,turn,text){
  turn.text+=text;
  notify("item/delta",sessionId,{itemId:turn.itemId,field:"text",delta:text});
}
function complete(sessionId,turnId,terminal="completed",usage=null){
  const turn=running.get(turnId);if(!turn)return;running.delete(turnId);
  notify("item/completed",sessionId,{item:{itemId:turn.itemId,kind:"agentMessage",turnId,revision:2,status:terminal==="completed"?"completed":"interrupted",text:turn.text}});
  notify("turn/completed",sessionId,{turnId,terminal,...(usage?{usage}:{})});
}
// usage: the turn reports a model step's tokens and adds them up on its turn/completed, as a message queued behind a report does.
function startTurn(sessionId,params,{usage=null}={}){
  const state=sessions.get(sessionId),turnId=params.commandId,turn={itemId:turnId+"-reply",text:""};running.set(turnId,turn);
  if(state)state.lastTurnId=turnId;
  const words=(params.input||[]).filter(part=>part.type==="text").map(part=>part.text).at(-1)||"";
  notify("turn/started",sessionId,{turnId,commandId:turnId});
  notify("item/completed",sessionId,{item:{itemId:turnId+"-user",kind:"userMessage",turnId,revision:1,status:"completed",text:words}});
  notify("item/started",sessionId,{item:{itemId:turn.itemId,kind:"agentMessage",turnId,revision:1,status:"inProgress",text:""}});
  if(/spawn subagent/i.test(words))return spawnSubagent(sessionId,turnId,turn);
  if(/run workflow/i.test(words))return runWorkflow(sessionId,turnId,turn);
  if(/ask approval|reviewer decides/i.test(words))return askApproval(sessionId,turnId,/reviewer decides/i.test(words));
  if(/read outside/i.test(words))return askApproval(sessionId,turnId,false,{read:true});
  if(/child approval/i.test(words))return askApproval(sessionId,turnId,false,{child:true});
  if(/protected child/i.test(words))return askApproval(sessionId,turnId,false,{child:true,protectedWrite:true});
  if(/staged approval/i.test(words))return askApproval(sessionId,turnId,false,{staged:true});
  if(/ask question/i.test(words))return askQuestion(sessionId,turnId);
  if(/dev server in the background/i.test(words))return runInBackground(sessionId,turnId,turn);
  if(/quota/i.test(words))return setTimeout(()=>{running.delete(turnId);notify("turn/completed",sessionId,{turnId,terminal:"failed",reason:QUOTA_REFUSAL,error:{kind:"modelError",message:QUOTA_REFUSAL,retryable:true}})},20);
  if(/signed out/i.test(words))return setTimeout(()=>{running.delete(turnId);notify("turn/completed",sessionId,{turnId,terminal:"failed",reason:"not logged in",error:{kind:"authRequired",message:"not logged in: run /login to add an API key",retryable:false}})},20);
  if(/retry/i.test(words)){
    notify("turn/retryScheduled",sessionId,{turnId,attempt:1,nextAttempt:2,maxAttempts:3,reason:"429 Too Many Requests",retryDelayMs:2000,errorKind:"rateLimited",httpStatus:429,system:"meta",sourceRange:{}});
    return later(process.env.MUSE_FAKE_RETRY_HOLD,Number(process.env.MUSE_FAKE_RETRY_MS||400),()=>{reply(sessionId,turn,"Muse fixture reply after a retry.");complete(sessionId,turnId)});
  }
  reply(sessionId,turn,`Muse fixture reply on ${state?.modelId||"Muse's default model"} at ${params.reasoningEffort||"Muse's default"} effort.`);
  if(usage)usageStep(sessionId,turnId,usage);
  const hold=process.env.MUSE_FAKE_HOLD==="1"||(params.input||[]).some(part=>part.type==="text"&&/hold until steered/i.test(part.text));
  if(!hold)setTimeout(()=>complete(sessionId,turnId,"completed",usage?{inputTokens:usage.prompt,outputTokens:usage.output,cachedTokens:0,cacheReadTokens:0,cacheWriteTokens:0,reasoningTokens:0}:null),20);
  if(/exit when idle/i.test(words))setTimeout(()=>{process.stderr.write("panic: the model stream went away\n");process.exit(1)},300);
}
// A model step's tokens and the context they leave, as Muse 1.4.13 reports them (session/tokenUsage, session/contextUsage).
function usageStep(sessionId,turnId,{prompt,output,cacheRead=0,reasoning=0,used=prompt+output}){
  notify("session/tokenUsage",sessionId,{turnId,modelId:"muse-spark-1.3",usage:{inputTokens:prompt,outputTokens:output,cachedTokens:cacheRead,cacheWriteTokens:0,cacheReadTokens:cacheRead,reasoningTokens:reasoning},promptTokens:prompt,totalTokens:prompt+output,sourceRange:{},cumulative:{promptTokens:prompt,outputTokens:output,totalTokens:prompt+output}});
  notify("session/contextUsage",sessionId,{windowTokens:1007997,usedTokens:used,pressure:"normal",sourceRange:{}});
}
function spawnSubagent(sessionId,turnId,turn){
  const agent=(revision,fields)=>({itemId:turnId+"-agent",kind:"subagent",turnId,revision,status:"inProgress",fallbackText:"Subagent: Reply with exactly: Hello",subagentId:"subagent-1",agentPath:"main/hello agent/1",depth:1,role:"hello agent",objective:"Reply with exactly: Hello",...fields});
  const todos=items=>notify("session/todoListChanged",sessionId,{items,revision:1,sourceTool:"write_todos",sourceRange:{}});
  todos([{text:" Spawn the hello agent ",status:"inProgress"},{text:"Read its result",status:"pending"},{text:"Discarded step",status:"cancelled"},{text:"  ",status:"pending"}]);
  usageStep(sessionId,turnId,{prompt:32900,output:129,reasoning:36});
  notify("item/started",sessionId,{item:agent(1,{controlStatus:"accepted"})});
  notify("item/updated",sessionId,{item:agent(2,{controlStatus:"running",childSessionId:turnId+"-child"})});
  // The child session's own reply carries its own turn, and is not the turn's.
  notify("item/started",sessionId,{item:{itemId:turnId+"-child-reply",kind:"agentMessage",turnId:turnId+"-child",revision:1,status:"inProgress",text:"Hello from the child session"}});
  setTimeout(()=>{
    notify("item/updated",sessionId,{item:agent(3,{controlStatus:"resultReady",childSessionId:turnId+"-child",durationMs:1810,result:{summary:"Hello",text:"Hello",evidenceRefs:[],artifactRefs:[]}})});
    todos([{text:"Spawn the hello agent",status:"completed"},{text:"Read its result",status:"completed"}]);
    usageStep(sessionId,turnId,{prompt:33144,output:123,cacheRead:32625,reasoning:7});
    reply(sessionId,turn,"Hello");complete(sessionId,turnId);
  },Number(process.env.MUSE_FAKE_SUBAGENT_MS||200));
}
function runWorkflow(sessionId,turnId,turn){
  const step=Number(process.env.MUSE_FAKE_WORKFLOW_MS||300),itemId=turnId+"-workflow";let revision=0;
  const workflow=(children,fields={})=>({itemId,kind:"workflow",turnId,revision:++revision,status:"inProgress",fallbackText:"Workflow: model-chosen generated workflow",workflowRunId:"workflow-run-"+turnId,entryId:"ping-pong",scriptId:"generated.workflow.ping-pong",triggerSource:"guidanceAuto",children,stopAvailable:true,...fields});
  const launch=(rev,status,extra={})=>({itemId:turnId+"-launch",kind:"toolCall",turnId,revision:rev,status,tool:"workflow",callId:"call_"+turnId,args:"{\"name\":\"ping-pong\"}",...extra});
  usageStep(sessionId,turnId,{prompt:33474,output:1531,reasoning:1333});
  notify("item/started",sessionId,{item:launch(1,"inProgress")});
  notify("item/completed",sessionId,{item:launch(2,"completed",{visibleOutput:"{\"status\":\"launched\",\"entryId\":\"ping-pong\"}"})});
  notify("item/started",sessionId,{item:workflow([])});
  reply(sessionId,turn,"Started the ping-pong workflow.");complete(sessionId,turnId);
  const ping={childId:itemId+"-ping",attempt:1},pong={childId:itemId+"-pong",attempt:1},pingDone={...ping,status:"terminal",terminal:"completed",durationMs:2360};
  const revisions=[[{...ping,status:"scheduled",label:"ping"}],[{...ping,status:"started"}],[{...ping,status:"started"},{...pong,status:"scheduled",label:"pong"}],[pingDone,{...pong,status:"started"}],
    [pingDone,{...pong,status:"terminal",terminal:"completed",failureKind:"budget_exhausted",durationMs:2639}]];
  revisions.forEach((children,index)=>setTimeout(()=>notify("item/updated",sessionId,{item:workflow(children)}),step*(index+1)));
  setTimeout(()=>{
    notify("item/completed",sessionId,{item:workflow(revisions.at(-1),{status:"completed",finalSummary:"{\"status\":\"ok\"}",durationMs:3616,stopAvailable:false})});
    later(process.env.MUSE_FAKE_REPORT_START_HOLD,Number(process.env.MUSE_FAKE_REPORT_DELAY_MS||0),()=>reportTurn(sessionId,turnId+"-report"));
  },step*(revisions.length+1));
}
// A command Muse sends to the background: the call's item goes there (background true) and settles, and the command's end comes
// later as an item of its own that names the call.
function runInBackground(sessionId,turnId,turn){
  const callId="call_"+turnId+"-dev",call=(revision,status,extra={})=>({itemId:turnId+"-dev",kind:"toolCall",turnId,revision,status,tool:"bash",callId,args:JSON.stringify({command:"npm run dev"}),...extra});
  notify("item/started",sessionId,{item:call(1,"inProgress")});
  notify("item/updated",sessionId,{item:call(2,"inProgress",{background:true,backgroundInitiator:"timeout"})});
  notify("item/completed",sessionId,{item:call(3,"completed",{background:true,backgroundInitiator:"timeout",visibleOutput:"Running in the background."})});
  reply(sessionId,turn,"The dev server runs in the background.");complete(sessionId,turnId);
  setTimeout(()=>{
    const finished={itemId:turnId+"-dev-finished",kind:"backgroundTerminalCompletion",turnId,revision:1,status:"completed",backgroundTerminalCompletion:{command:"npm run dev",output:"Dev server stopped.",outputTruncated:false,terminalStatus:"completed",toolCallId:callId}};
    notify("item/started",sessionId,{item:finished});notify("item/completed",sessionId,{item:{...finished,revision:2}});
  },Number(process.env.MUSE_FAKE_BACKGROUND_MS||1500));
}
// The turn Muse starts itself to report on work that finished, with an id of its own.
const heldReports=new Map();
function reportTurn(sessionId,turnId){
  const turn={itemId:turnId+"-reply",text:""};running.set(turnId,turn);
  notify("turn/started",sessionId,{turnId,commandId:turnId});
  notify("item/started",sessionId,{item:{itemId:turn.itemId,kind:"agentMessage",turnId,revision:1,status:"inProgress",text:""}});
  reply(sessionId,turn,"The workflow with ping and pong agents is complete.");
  usageStep(sessionId,turnId,{prompt:36716,output:262,cacheRead:33393,reasoning:238});
  if(process.env.MUSE_FAKE_REPORT_HOLD==="1")return void heldReports.set(sessionId,{turnId,turn});
  setTimeout(()=>complete(sessionId,turnId),20);
}
// A message queued behind the held report: the report says the rest of its reply in the same message and ends, with the tokens of
// both its model steps, and then the message's turn runs.
function releaseReport(sessionId,params){
  const {turnId,turn}=heldReports.get(sessionId);heldReports.delete(sessionId);
  setTimeout(()=>{
    reply(sessionId,turn," The rest of the report.");
    usageStep(sessionId,turnId,{prompt:100,output:10});
    complete(sessionId,turnId,"completed",{inputTokens:36816,outputTokens:272,cachedTokens:33393,cacheReadTokens:33393,cacheWriteTokens:0,reasoningTokens:238});
    setTimeout(()=>startTurn(sessionId,params,{usage:{prompt:500,output:20}}),20);
  },20);
}
const QUOTA_REFUSAL="API error 429: All credentials for model muse-wonder-1.0-contributor are cooling down (last error: rate_limit_exceeded: Subscription quota exhausted. Your usage window resets at 2031-05-04T10:45:52Z.) (after 10 provider attempts)";
// The approval Muse asks before running `touch muse-approved.txt` (T3's recorded muse_permission), and how it settles.
const approvals=new Map(),questions=new Map();
const SHELL_CHOICES=[{choiceId:"allow_once",label:"Allow once",decision:"approved",scope:"once"},{choiceId:"allow_local_prefix",label:"Always allow in this workspace: touch ...",decision:"approvedPolicyAmendment",scope:"localPersistent",rulePreview:"Always allow in this workspace: touch ..."},{choiceId:"abort",label:"Reject",decision:"abort",scope:"once",acceptsFeedback:true}];
// A file read outside the workspace: Muse reads its workspace unasked, and asks with Allow once or Reject for a file beyond it.
const READ_CHOICES=[{choiceId:"allow_once",label:"Allow once",decision:"approved",scope:"once"},{choiceId:"deny",label:"Reject",decision:"denied",scope:"once"}];
// A staged shell command's second stage, `rm b.txt`, with its own rules: one saved to allow it, one saved to keep it out.
const RM_CHOICES=[{choiceId:"allow_once",label:"Allow once",decision:"approved",scope:"once"},{choiceId:"allow_local_prefix_rm",label:"Always allow in this workspace: rm ...",decision:"approvedPolicyAmendment",scope:"localPersistent",rulePreview:"Always allow in this workspace: rm ..."},{choiceId:"deny_once",label:"Reject",decision:"denied",scope:"once"},{choiceId:"deny_local_prefix_rm",label:"Always reject in this workspace: rm ...",decision:"deniedPolicyAmendment",scope:"localPersistent",rulePreview:"Always reject in this workspace: rm ..."}];
let nextRequest=900;
function askApproval(sessionId,parentTurnId,reviewer,{read=false,child=false,protectedWrite=false,staged=false}={}){
  // A workflow child's approval names the child's own run as its turn, and its origin.
  const turnId=child?parentTurnId+"-child-run":parentTurnId,origin=child?{subagentOrigin:{subagentId:"agent-7",childRunId:turnId,childSessionId:parentTurnId+"-child-session"}}:{};
  const approvalId=turnId+"-approval",requirement={approvalId,sourceIndex:0},workspaceRoot=sessions.get(sessionId)?.workspaceRoot||"";
  const outside=read?require("node:path").resolve(workspaceRoot||process.cwd(),"..","outside-notes.txt"):"",choices=read||protectedWrite?READ_CHOICES:SHELL_CHOICES;
  const command=staged?"touch a.txt && rm b.txt":"touch muse-approved.txt",stage=(index,argv)=>({requirementId:{approvalId,sourceIndex:index},position:index+1,totalStages:staged?2:1,argv,argvComplete:true,resolution:{kind:"unresolved"},suggestedPrefix:{argvPrefix:[argv[0]],label:`Always allow in this workspace: ${argv[0]} ...`}});
  const subject=read?{kind:"fileAccess",access:"read",path:outside,toolName:"read_file"}:protectedWrite?{kind:"fileAccess",access:"write",path:".muse/settings.json",toolName:"write_file"}
    :{kind:"shell",command,workspaceRoot,stages:staged?[stage(0,["touch","a.txt"]),stage(1,["rm","b.txt"])]:[stage(0,["touch","muse-approved.txt"])]};
  const params={sessionId,approvalId,turnId,taskId:approvalId,itemId:approvalId,toolCallId:"call_"+approvalId,toolName:read?"read_file":protectedWrite?"write_file":"bash",rawArgs:JSON.stringify(read?{file_path:outside}:protectedWrite?{file_path:".muse/settings.json"}:{command}),viewCursor:`v:${sessionId}:${++cursor}`,sourceRange:{},
    subject,currentRequirementId:requirement,availableChoices:choices,protectedWrite,judgeEscalated:false,...origin};
  approvals.set(approvalId,{sessionId,turnId,parentTurnId,settled:false,choices,requirement,read,staged});
  write({jsonrpc:"2.0",id:++nextRequest,method:"approval/request",params});
  notify("approval/requested",sessionId,{...params,emittedAtMs:Date.now()});
  if(reviewer)later(process.env.MUSE_FAKE_REVIEW_HOLD,Number(process.env.MUSE_FAKE_REVIEW_MS||300),()=>settleApproval(approvalId,{decision:"approved",resolvedBy:"llmJudge"}));
  // Muse's reviewer moves a staged command on to its next stage, with that stage's own choices.
  if(staged)later(process.env.MUSE_FAKE_STAGE_HOLD,Number(process.env.MUSE_FAKE_STAGE_MS||300),()=>{
    const approval=approvals.get(approvalId);if(!approval||approval.settled)return;
    approval.requirement={approvalId,sourceIndex:1};approval.choices=RM_CHOICES;
    notify("approval/updated",sessionId,{approvalId,subject,currentRequirementId:approval.requirement,availableChoices:RM_CHOICES,change:{kind:"reviewCompleted"},sourceRange:{}});
  });
}
function settleApproval(approvalId,{decision,resolvedBy="user",commandId=null,choiceId=null}){
  const approval=approvals.get(approvalId);if(!approval||approval.settled)return false;
  approval.settled=true;
  notify("approval/resolved",approval.sessionId,{approvalId,itemId:approvalId,turnId:approval.turnId,decision,policyResult:decision==="abort"||decision==="denied"||decision==="deniedPolicyAmendment"?"deny":"allow",resolvedBy,...(commandId?{decidedByCommandId:commandId}:{}),stageEvidence:[],sourceRange:{}});
  // A workflow child's approval answers in the turn that waits on the child, while it still runs.
  const turnId=running.has(approval.turnId)?approval.turnId:approval.parentTurnId,turn=running.get(turnId);
  const said=approval.staged?`STAGE DECIDED: ${choiceId}`:resolvedBy==="llmJudge"?"THE REVIEWER ALLOWED IT":decision==="abort"||decision==="denied"?"REJECTED":decision==="approvedPolicyAmendment"?"ALWAYS ALLOWED":approval.read?"READ IT":"APPROVED";
  if(turn)setTimeout(()=>{reply(approval.sessionId,turn,said);complete(approval.sessionId,turnId)},20);
  return true;
}
function askQuestion(sessionId,turnId){
  const userInputId=turnId+"-question";
  const params={sessionId,userInputId,turnId,itemId:userInputId,toolCallId:"call_"+userInputId,toolName:"request_user_input",viewCursor:`v:${sessionId}:${++cursor}`,
    questions:[{id:"approach",header:"Approach",question:"Which approach should I take?",options:[{label:"Small",description:"One file at a time"},{label:"Large",description:"Everything at once"}],selection:{mode:"single"}}]};
  questions.set(userInputId,{sessionId,turnId,settled:false});
  write({jsonrpc:"2.0",id:++nextRequest,method:"userInput/request",params});
  notify("userInput/requested",sessionId,params);
}
function settleQuestion(userInputId,{outcome,answers=[],reason=null,commandId=null}){
  const question=questions.get(userInputId);if(!question||question.settled)return false;
  question.settled=true;
  notify("userInput/settled",question.sessionId,{userInputId,outcome,answers,clarification:null,decidedAt:new Date().toISOString(),decidedByCommandId:commandId,reason,sourceRange:{}});
  const turn=running.get(question.turnId),said=answers.map(answer=>[answer.selectedLabel,...(answer.selectedLabels||[]),answer.freeText,answer.note].filter(Boolean).join(" — ")).join("; ");
  if(turn)setTimeout(()=>{reply(question.sessionId,turn,outcome==="answered"?`ANSWERED: ${said}`:"NO ANSWER");complete(question.sessionId,question.turnId)},20);
  return true;
}
// /compact: the ack admits it, and the compaction runs as an item of its own (kind compaction, trigger manual) of the latest turn,
// as Muse 1.4.13's schema shapes it (SessionCompactResult, Item.outcome). A session with no turn to compact is refused, as Muse
// 1.4.13 refuses one live (commandRejected, reason missing_run); a resumed one has the turns it had.
function compactSession(params){
  const mode=process.env.MUSE_FAKE_COMPACT||"",state=sessions.get(params.sessionId);
  if(!state?.lastTurnId&&!state?.resumed)throw Object.assign(new Error(`session/compact command ${params.commandId} rejected: missing_run`),{code:-32030,kind:"commandRejected",reason:"missing_run"});
  if(mode==="noop")return {commandId:params.commandId,status:"noop",reason:"no_compactable_history"};
  const item=(revision,status,extra={})=>({itemId:params.commandId+"-compaction",kind:"compaction",turnId:state.lastTurnId||null,revision,status,trigger:"manual",fallbackText:"Context compaction",...extra});
  setImmediate(()=>{
    notify("item/started",params.sessionId,{item:item(1,"inProgress")});
    if(mode!=="hold")setTimeout(()=>notify("item/completed",params.sessionId,{item:item(2,"completed",{outcome:"compacted"})}),Number(process.env.MUSE_FAKE_COMPACT_MS||50));
  });
  return {commandId:params.commandId,status:"accepted"};
}

const answers={
  initialize:params=>({serverInfo:{name:"muse",version:"1.4.13"},userAgent:"muse-build/1.4.13 (serve; fake)",museHome:"~/.local/share/muse",platformFamily:process.platform==="win32"?"windows":"unix",platformOs:process.platform==="win32"?"windows":process.platform,schema:{version:1,fingerprint:"sha256:7fddaf646dbc317e5fcac0785e135eb04df14fbb0db1863089dfd6da21730e5b"},grantedCapabilities:[...(params?.capabilities?.requestedCapabilities||[])],experimentalApi:false,sessionDurability:argv.includes("--no-session-log")?"ephemeral":"durable",sandboxAvailability:"unavailable"}),
  "model/list":()=>catalog(),
  "session/start":params=>{const state={modelId:params.modelId||"muse-spark-1.2",workspaceRoot:params.workspaceRoot};sessions.set(params.sessionId,state);return {session:sessionRecord(params.sessionId,state),viewCursor:`v:${params.sessionId}:${++cursor}`}},
  "session/resume":params=>{
    if(process.env.MUSE_FAKE_FORGET&&fs.existsSync(process.env.MUSE_FAKE_FORGET))throw Object.assign(new Error(`session ${params.sessionId} not found`),{code:-32020,kind:"sessionNotFound"});
    const state=sessions.get(params.sessionId)||{modelId:process.env.MUSE_FAKE_RESUMED_MODEL||"muse-spark-1.2",workspaceRoot:null};state.resumed=true;sessions.set(params.sessionId,state);return {session:sessionRecord(params.sessionId,state),history:{mode:"none",items:null},pendingRequests:[],viewCursor:`v:${params.sessionId}:${++cursor}`};
  },
  "session/setApprovalMode":params=>({commandId:params.commandId,applyOutcome:"noop"}),
  "session/setModel":params=>{
    const modelId=params?.model?.modelId;
    if(modelId&&modelId===process.env.MUSE_FAKE_REFUSE)throw Object.assign(new Error(`model ${modelId} does not exist or you lack access`),{code:-32030,kind:"commandRejected"});
    const state=sessions.get(params.sessionId);if(state)state.modelId=modelId;
    return {commandId:params.commandId,status:"accepted"};
  },
  "session/compact":params=>compactSession(params),
  "turn/start":params=>{
    if(heldReports.has(params.sessionId)){releaseReport(params.sessionId,params);return {commandId:params.commandId,status:"accepted",turnId:params.commandId,startedNewTurn:false,disposition:"queued"}}
    setImmediate(()=>startTurn(params.sessionId,params));return {commandId:params.commandId,status:"accepted",turnId:params.commandId,startedNewTurn:true,disposition:"started"};
  },
  "turn/steer":params=>{
    const turn=running.get(params.expectedTurnId);if(!turn)throw Object.assign(new Error("no running turn"),{code:-32030,kind:"commandRejected"});
    const words=(params.input||[]).filter(part=>part.type==="text").map(part=>part.text).join(" ");
    setImmediate(()=>{reply(params.sessionId,turn,` Steered: ${words}.`);complete(params.sessionId,params.expectedTurnId)});
    return {commandId:params.commandId,status:"accepted",turnId:params.expectedTurnId};
  },
  "turn/interrupt":params=>{setImmediate(()=>complete(params.sessionId,params.turnId,"cancelled"));return {commandId:params.commandId,status:"accepted",turnId:params.turnId}},
  "approval/decide":params=>{
    const approval=approvals.get(params.approvalId);
    if(!approval)throw Object.assign(new Error(`approval ${params.approvalId} not found`),{code:-32050,kind:"approvalNotFound"});
    if(approval.settled)throw Object.assign(new Error(`approval ${params.approvalId} is already resolved`),{code:-32051,kind:"approvalAlreadyResolved"});
    // Meta's race guard: a decision names the stage it is for, and one for a stage the approval moved past is stale.
    if(JSON.stringify(params.requirementId)!==JSON.stringify(approval.requirement))throw Object.assign(new Error(`requirement ${JSON.stringify(params.requirementId)} is stale`),{code:-32053,kind:"approvalRequirementStale"});
    const choice=approval.choices.find(item=>item.choiceId===params.choiceId);
    if(!choice)throw Object.assign(new Error(`choice ${params.choiceId} is not offered`),{code:-32052,kind:"approvalChoiceInvalid"});
    setImmediate(()=>settleApproval(params.approvalId,{decision:choice.decision,commandId:params.commandId,choiceId:choice.choiceId}));
    return {commandId:params.commandId,status:"accepted",approvalId:params.approvalId,terminal:true};
  },
  "userInput/answer":params=>{
    if(!questions.has(params.userInputId))throw Object.assign(new Error(`prompt ${params.userInputId} not found`),{code:-32055,kind:"userInputNotFound"});
    setImmediate(()=>settleQuestion(params.userInputId,{outcome:"answered",answers:params.answers||[],commandId:params.commandId}));
    return {commandId:params.commandId,status:"accepted",userInputId:params.userInputId};
  },
  "userInput/cancel":params=>{
    if(!questions.has(params.userInputId))throw Object.assign(new Error(`prompt ${params.userInputId} not found`),{code:-32055,kind:"userInputNotFound"});
    setImmediate(()=>settleQuestion(params.userInputId,{outcome:"cancelled",reason:params.reason||null,commandId:params.commandId}));
    return {commandId:params.commandId,status:"accepted",userInputId:params.userInputId};
  },
};

readline.createInterface({input:process.stdin}).on("line",line=>{
  if(!line.trim())return;
  let frame;try{frame=JSON.parse(line)}catch{return}
  log({frame});
  if(frame.id===undefined||!frame.method)return;
  const answer=answers[frame.method];
  if(!answer)return write({jsonrpc:"2.0",id:frame.id,error:{code:-32601,message:`method not found: ${frame.method}`,data:{kind:"methodNotFound",retryable:false}}});
  try{write({jsonrpc:"2.0",id:frame.id,result:answer(frame.params||{})})}
  catch(error){write({jsonrpc:"2.0",id:frame.id,error:{code:error.code??-32000,message:error.message,data:{kind:error.kind||"internal",retryable:false,...(error.reason?{reason:error.reason}:{})}}})}
}).on("close",()=>process.exit(0));
