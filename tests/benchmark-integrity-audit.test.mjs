import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditCodexRolloutText, auditJobIntegrity, auditNativeEventsText, classifyCommandText, compactIntegrity, summarizeIntegrityFindings } from "../scripts/benchmark-integrity-audit.mjs";

const codexCall=(callId,input)=>({type:"response_item",payload:{type:"custom_tool_call",name:"exec",call_id:callId,input}});
const codexOutput=(callId,text)=>({type:"response_item",payload:{type:"custom_tool_call_output",call_id:callId,output:[{type:"input_text",text}]}});
const rollout=rows=>rows.map(row=>JSON.stringify(row)).join("\n");

test("hosted web.run and ChatGPT connector search inside Codex exec make a lane invalid",()=>{
  const findings=auditCodexRolloutText(rollout([
    codexCall("a",'const r = await tools.web__run({search_query:[{q:"SA-CCR alpha"}]});\ntext(r);'),
    codexOutput("a","search results"),
    codexCall("b",'const s = await tools.mcp__codex_apps__search_service_web_run({system2_search_query:[{q:"ticket"}]});'),
  ]));
  const summary=summarizeIntegrityFindings(findings);
  assert.equal(summary.status,"invalid");
  assert.equal(summary.hostedWebCalls,2);
  assert.deepEqual(summary.hostedWebTools.sort(),["mcp__codex_apps__search_service_web_run","web__run"]);
});

test("hosted web_search_call items make a lane invalid",()=>{
  const summary=summarizeIntegrityFindings(auditCodexRolloutText(rollout([{type:"response_item",payload:{type:"web_search_call",action:{type:"search",query:"x"}}}])));
  assert.equal(summary.status,"invalid");
  assert.equal(summary.hostedWebTools[0],"web_search_call");
});

test("Python fetches inside exec_command are flagged with hosts and the paired output",()=>{
  const input='const r = await tools.exec_command({cmd:"python - <<\'PY\'\\nimport json, urllib.request\\nprint(urllib.request.urlopen(\'https://api.github.com/repos/o/r/pulls/1\').read()[:200])\\nPY",workdir:"/testbed"});';
  const findings=auditCodexRolloutText(rollout([codexCall("c",input),codexOutput("c",'{"url":"https://api.github.com/repos/o/r/pulls/1","title":"Fix"}')]));
  const command=findings.find(finding=>finding.kind==="command");
  assert.ok(command.kinds.includes("python-http"));
  assert.deepEqual(command.hosts,["api.github.com"]);
  assert.match(command.output,/"title":"Fix"/);
  assert.equal(command.networkFailureSeen,false);
  const summary=summarizeIntegrityFindings(findings);
  assert.equal(summary.status,"review");
  assert.equal(summary.networkCommands,1);
});

test("failed fetches are marked so reviewers can tell attempts from retrieved content",()=>{
  const findings=auditCodexRolloutText(rollout([codexCall("d",'await tools.exec_command({cmd:"curl -sS https://example.org.invalid/x"});'),codexOutput("d","curl: (6) Could not resolve host: example.org.invalid")]));
  assert.equal(findings[0].networkFailureSeen,true);
});

test("git history beyond HEAD, verifier paths and user-input requests are reported",()=>{
  const findings=auditCodexRolloutText(rollout([
    codexCall("e",'await tools.exec_command({cmd:"git log --all --oneline | head"});'),
    codexCall("f",'await tools.exec_command({cmd:"cat /tests/test_outputs.py"});'),
    {type:"response_item",payload:{type:"function_call",name:"request_user_input_async",call_id:"g",arguments:"{}"}},
  ]));
  const summary=summarizeIntegrityFindings(findings);
  assert.equal(summary.gitHistoryCommands,1);
  assert.equal(summary.verifierPathReads,1);
  assert.equal(summary.userInputRequests,1);
  assert.deepEqual(summary.unknownTools,[]);
  assert.equal(summary.status,"review");
});

test("ordinary local work stays clean",()=>{
  const findings=auditCodexRolloutText(rollout([
    codexCall("h",'const r = await tools.exec_command({cmd:"rg -n SimpleLazyObject django"});'),
    codexCall("i",'await tools.apply_patch("*** Begin Patch\\n*** End Patch");'),
    codexCall("j",'await tools.view_image({path:"/tmp/a.png"});'),
  ]));
  assert.equal(summarizeIntegrityFindings(findings).status,"clean");
  assert.deepEqual(classifyCommandText("git log -5 --oneline"),[]);
});

test("Native terminal commands are audited from the recorded command and unlogged process commands are counted",()=>{
  const events=[
    {name:"native.tool.requested",data:{callId:"n1",namespace:"trebell_terminal",name:"run",terminalAudit:{gateCommand:"curl -fsSL https://raw.githubusercontent.com/o/r/main/x.py",hosts:["raw.githubusercontent.com"],networkLike:true}}},
    {name:"native.tool.completed",data:{callId:"n1",success:true,error:null}},
    {name:"native.tool.requested",data:{callId:"n2",namespace:"trebell_process",name:"start"}},
    {name:"native.tool.requested",data:{callId:"n3",namespace:"trebell_terminal",name:"run",terminalAudit:{gateCommand:"python -m pytest -q tests/test_x.py",hosts:[],networkLike:false}}},
  ].map(row=>JSON.stringify(row)).join("\n");
  const findings=auditNativeEventsText(events);
  const summary=summarizeIntegrityFindings(findings);
  assert.equal(summary.networkCommands,1);
  assert.deepEqual(summary.externalHosts,["raw.githubusercontent.com"]);
  assert.equal(summary.unloggedCommands,1);
  assert.equal(findings.find(finding=>finding.kind==="command").success,true);
  assert.equal(summary.status,"review");
});

test("job audits read every trial's Codex sessions and Native events",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-integrity-"));
  try{
    const sessions=join(root,"job-a","task__abc1234","agent","codex-sessions","2026","10","10");
    await mkdir(sessions,{recursive:true});
    await writeFile(join(sessions,"rollout-1.jsonl"),rollout([codexCall("k",'await tools.web__run({open:[{ref_id:"https://example.net/x"}]});')]));
    await mkdir(join(root,"job-b","task__def5678","agent"),{recursive:true});
    await writeFile(join(root,"job-b","task__def5678","agent","trebell-native-events.jsonl"),JSON.stringify({name:"native.tool.requested",data:{callId:"m",namespace:"trebell_repo",name:"read_source"}}));
    const invalid=await auditJobIntegrity(root,"job-a"),clean=await auditJobIntegrity(root,"job-b");
    assert.equal(invalid.summary.status,"invalid");assert.equal(invalid.logs,1);
    assert.equal(clean.summary.status,"clean");assert.equal(clean.logs,1);
    const compact=compactIntegrity(invalid);
    assert.equal(compact.status,"invalid");assert.equal(compact.evidence[0].tool,"web__run");
    assert.equal(await auditJobIntegrity(root,"missing"),null);
  }finally{await rm(root,{recursive:true,force:true})}
});
