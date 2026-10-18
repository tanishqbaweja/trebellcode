import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createToolCallLogger } from "../benchmarks/harbor/native-audit-artifacts.mjs";
import { auditCodexExecStreamText, auditCodexRolloutText, auditJobIntegrity, auditNativeEventsText, classifyCommandText, compactIntegrity, externalHosts, mergeIntegritySummaries, summarizeIntegrityFindings, taskContextFromTrialName } from "../scripts/benchmark-integrity-audit.mjs";

const codexCall=(callId,input)=>({type:"response_item",payload:{type:"custom_tool_call",name:"exec",call_id:callId,input}});
const codexOutput=(callId,text)=>({type:"response_item",payload:{type:"custom_tool_call_output",call_id:callId,output:[{type:"input_text",text}]}});
const rollout=rows=>rows.map(row=>JSON.stringify(row)).join("\n");
const event=item=>({type:"event_msg",payload:{type:"item_completed",item}});
const execRollout=(command,output,options)=>auditCodexRolloutText(rollout([codexCall("x",`await tools.exec_command({cmd:${JSON.stringify(command)}});`),codexOutput("x",output)]),options);
const nativeLog=rows=>rows.map(row=>JSON.stringify(row)).join("\n");
const terminalRun=(callId,terminalAudit)=>({name:"native.tool.requested",data:{callId,namespace:"trebell_terminal",name:"run",...(terminalAudit?{terminalAudit}:{})}});
const streamItem=(type,item)=>JSON.stringify({type,item});
async function withJobs(run){const root=await mkdtemp(join(tmpdir(),"trebell-integrity-"));try{await run(root)}finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}}
async function writeTrialFile(root,parts,text){const path=join(root,...parts);await mkdir(join(path,".."),{recursive:true});await writeFile(path,text)}

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
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

// Log discovery.

test("rollouts in the stock agent/sessions layout are audited, and a copy in both layouts counts once",async()=>{
  await withJobs(async root=>{
    const rows=rollout([codexCall("a",'await tools.exec_command({cmd:"pip index versions numpy"});'),codexOutput("a","numpy (2.1.0)\nAvailable versions: 2.1.0, 2.0.2")]);
    await writeTrialFile(root,["job-s","task__abc1234","agent","sessions","2026","09","30","rollout-2026-09-30T08-07-50-a.jsonl"],rows);
    const stock=await auditJobIntegrity(root,"job-s");
    assert.equal(stock.logs,1);
    assert.match(stock.trials[0].logFiles[0],/\/agent\/sessions\/2026\/09\/30\/rollout-/);
    assert.equal(stock.summary.networkCommands,1);
    assert.equal(stock.summary.status,"review");
    await writeTrialFile(root,["job-s","task__abc1234","agent","codex-sessions","2026","09","30","rollout-2026-09-30T08-07-50-a.jsonl"],rows);
    const both=await auditJobIntegrity(root,"job-s");
    assert.equal(both.logs,1);assert.equal(both.summary.networkCommands,1);
  });
});

test("agent/codex.txt is audited when a trial kept no rollout",async()=>{
  await withJobs(async root=>{
    const command='/bin/bash -lc "pip download requests==2.31.0 -d /tmp/w"';
    await writeTrialFile(root,["job-c","task__abc1234","agent","codex.txt"],["Reading prompt from stdin...",
      streamItem("item.started",{id:"item_1",type:"command_execution",command,aggregated_output:"",exit_code:null,status:"in_progress"}),
      streamItem("item.completed",{id:"item_1",type:"command_execution",command,aggregated_output:"Saved /tmp/w/requests-2.31.0-py3-none-any.whl",exit_code:0,status:"completed"}),
    ].join("\n"));
    const audit=await auditJobIntegrity(root,"job-c");
    assert.equal(audit.logs,1);
    assert.match(audit.trials[0].logFiles[0],/\/agent\/codex\.txt$/);
    assert.equal(audit.summary.networkCommands,1);
    assert.equal(audit.summary.auditedCommands,1);
    assert.equal(audit.summary.status,"review");
  });
});

test("with a rollout present, codex.txt only adds hosted calls the rollout did not record",async()=>{
  await withJobs(async root=>{
    await writeTrialFile(root,["job-r","task__abc1234","agent","codex-sessions","rollout-1.jsonl"],rollout([codexCall("a",'await tools.exec_command({cmd:"curl -sS https://api.vendor.io/x"});'),codexOutput("a","{}")]));
    await writeTrialFile(root,["job-r","task__abc1234","agent","codex.txt"],streamItem("item.completed",{id:"item_1",type:"command_execution",command:"curl -sS https://api.vendor.io/x",aggregated_output:"{}"}));
    const duplicate=await auditJobIntegrity(root,"job-r");
    assert.equal(duplicate.summary.networkCommands,1);
    assert.equal(duplicate.summary.status,"review");
    await writeTrialFile(root,["job-r","task__abc1234","agent","codex.txt"],streamItem("item.completed",{id:"item_2",type:"web_search",query:"x"}));
    const missed=await auditJobIntegrity(root,"job-r");
    assert.equal(missed.summary.hostedWebCalls,1);
    assert.equal(missed.summary.status,"invalid");
    assert.equal(missed.trials[0].findings.find(finding=>finding.kind==="hosted-web").note,"recorded in codex.txt but not in the rollout");
  });
});

test("the codex exec stream counts each item once and treats web_search and MCP items as hosted",()=>{
  const findings=auditCodexExecStreamText([
    streamItem("item.started",{id:"item_2",type:"web_search",query:"SA-CCR alpha"}),
    streamItem("item.completed",{id:"item_2",type:"web_search",query:"SA-CCR alpha"}),
    streamItem("item.completed",{id:"item_3",type:"mcp_tool_call",server:"codex_apps",tool:"search_service_web_run",arguments:{q:"x"},result:{content:[{type:"text",text:"hit"}]},status:"completed"}),
    streamItem("item.completed",{id:"item_4",type:"command_execution",command:"/bin/bash -lc 'git branch -a'",aggregated_output:"* main\n  remotes/origin/main",exit_code:0}),
    "not json",
  ].join("\n"));
  const summary=summarizeIntegrityFindings(findings);
  assert.equal(summary.hostedWebCalls,2);
  assert.deepEqual(summary.hostedWebTools.sort(),["mcp__codex_apps__search_service_web_run","web_search"]);
  assert.equal(summary.gitHistoryCommands,1);
  assert.equal(summary.auditedCommands,1);
  assert.equal(summary.status,"invalid");
});

// Command rules.

test("pip index, pip download and other registry queries are package fetches; local pip and npm commands are not",()=>{
  for(const command of ["pip index versions numpy","python3 -m pip download torch==2.4.0 --no-deps -d /tmp/w","pip3 wheel . -w dist","uv pip install httpx","uvx ruff check","poetry add rich","conda create -n x python=3.11","npm ci","pnpm dlx create-vite","apt-get source zlib","go mod tidy","gem fetch rails","cargo update"])
    assert.ok(classifyCommandText(command).includes("package-install"),command);
  for(const command of ["pip list","pip show numpy","pip freeze > req.txt","npm run build","npm test","cargo build --release"])
    assert.deepEqual(classifyCommandText(command),[],command);
});

test("bare npx and builds count as package fetches only when the output shows a download",()=>{
  const status=(command,output)=>summarizeIntegrityFindings(execRollout(command,output)).status;
  assert.equal(status("npx tsc --noEmit","src/a.ts(1,1): error TS2304"),"clean");
  assert.equal(status("npx prettier --check .","npm warn exec The following package was not found and will be installed: prettier@3.3.3"),"review");
  assert.equal(status("npx -y create-vite@5 app","Scaffolding project"),"review");
  assert.equal(status("cargo build --release","   Compiling app v0.1.0\n    Finished release"),"clean");
  assert.equal(status("cargo build --release","    Updating crates.io index\n  Downloaded serde v1.0.210"),"review");
  assert.equal(status("go test ./...","go: downloading github.com/stretchr/testify v1.9.0\nok  pkg 0.01s"),"review");
  const stream=auditCodexExecStreamText(streamItem("item.completed",{id:"i",type:"command_execution",command:"npx vitest run",aggregated_output:"Need to install the following packages:\nvitest@2.1.1"}));
  assert.equal(summarizeIntegrityFindings(stream).networkCommands,1);
});

test("ref, reflog and object-store listings are git history; reads of the current history are not",()=>{
  const flagged=["git tag","git tag -l","git tag --list 'v*'","git -C /testbed tag | tail","git branch -a","git branch -r","git branch -avv","git branch --all --contains HEAD","git reflog","git fsck --lost-found","git fsck --unreachable","git rev-list --all | head","git log --all --oneline","git log -g","git stash list","git show-ref","git for-each-ref refs/","git cat-file --batch-all-objects --batch-check","git count-objects -v","cat .git/packed-refs","git log ORIG_HEAD"];
  for(const command of flagged)assert.ok(classifyCommandText(command).includes("git-history"),command);
  const current=["git log -5 --oneline","git log --oneline -- src/app.py","git diff HEAD~1","git show HEAD:README.md","git show HEAD --stat","git status","git branch","git branch --show-current","git tag v1.0-fix","git blame -L 1,5 a.py"];
  for(const command of current)assert.deepEqual(classifyCommandText(command),[],command);
});

test("verifier, solution, oracle and harness paths are flagged; the agent's own logs and task paths are not",()=>{
  const flagged=["ls /logs","cat /logs/artifacts/report.json","find /logs -type f","cat /logs/verifier/reward.txt","cat /tests/test_outputs.py","ls -la /solution","bash /oracle/solve.sh","sh solution.sh","cd / && ls tests","cd /; cat logs/verifier/ctrf.json","find / -name test_outputs.py","find / -path '*solution*' -name '*.sh'","ls /installed-agent","grep -r x >/logs/out.txt"];
  for(const command of flagged)assert.ok(classifyCommandText(command).includes("verifier-path"),command);
  const local=["ls /logs/agent","tail /logs/agent/codex.txt","pytest /app/tests -q","ls ./tests","python -m pytest tests/test_x.py","cd /app && ls tests","find /app -name 'test_*.py'","find / -name solution.py","cat /app/solution/notes.md"];
  for(const command of local)assert.deepEqual(classifyCommandText(command),[],command);
});

test("listings that show a verifier or solution directory inside the container are flagged as seen",()=>{
  const finding=(command,output)=>execRollout(command,output).find(item=>item.kind==="command");
  const root=finding("ls -la /","drwxr-xr-x 1 root root 4096 Oct 8 13:38 app\ndrwxr-xr-x 2 root root 4096 Oct 8 13:38 tests\ndrwxr-xr-x 1 root root 4096 Oct 8 13:38 usr");
  assert.equal(root.verifierPathSeen,true);assert.ok(root.kinds.includes("verifier-path"));
  assert.equal(finding("find / -maxdepth 2 -name '*.py' 2>/dev/null","/app/main.py\n/tests/test_outputs.py").verifierPathSeen,true);
  assert.equal(finding("ls /app","README.md\nsrc\ntests"),undefined);
});

test("remote shells, other VCS, dataset downloads, skill fetch scripts and hosted endpoints are network kinds",()=>{
  const cases={"ssh deploy@build.vendor.io uptime":"remote-shell","scp out.tgz backup.vendor.io:/srv/":"remote-shell","nc -z db.vendor.io 5432":"remote-shell","exec 3<>/dev/tcp/10.0.0.5/80":"remote-shell","rsync -av mirror.vendor.io::pub/ /tmp/pub":"remote-shell","svn checkout https://svn.vendor.io/repo":"vcs-network","hf download org/model":"data-download","docker pull alpine:3.20":"data-download","python -c \"from datasets import load_dataset; load_dataset('squad')\"":"data-download","node /opt/skills/fetch-codex-manual.mjs":"skill-fetch","gh api repos/o/r/pulls":"cli-fetch","git clone git@github.com:o/r.git":"git-network","git remote update":"git-network","python - <<'PY'\nimport pandas as pd\npd.read_csv('https://data.vendor.io/a.csv')\nPY":"python-http","node -e \"fetch(url).then(r=>r.text())\"":"node-http","codex mcp add docs -- npx docs-mcp":"hosted-endpoint"};
  for(const [command,kind] of Object.entries(cases))assert.ok(classifyCommandText(command).includes(kind),`${command} -> ${kind}`);
  for(const command of ["service ssh start","python -c \"from datasets import load_dataset; load_dataset('csv', data_files='a.csv')\"","node -e \"const http = require('node:http'); http.createServer().listen(3000)\""])
    assert.deepEqual(classifyCommandText(command),[],command);
  assert.deepEqual(externalHosts("git clone git@github.com:o/r.git && pip install git+https://gitlab.com/g/p",{schemeless:true}).sort(),["github.com","gitlab.com"]);
});

test("loopback sockets and single-label service names are local",()=>{
  assert.deepEqual(classifyCommandText("python - <<'PY'\nimport socket\ns = socket.create_connection(('127.0.0.1', 8080))\nPY"),[]);
  assert.deepEqual(classifyCommandText("python - <<'PY'\nimport socket\nHOST = 'localhost'\ns = socket.socket()\ns.connect((HOST, 9000))\nPY"),[]);
  // A C client's connect(fd, ...) in the same command names no host; the Python probe targets loopback.
  assert.deepEqual(classifyCommandText("cat > /tmp/b.c <<'C'\nint main(){int fd=socket(AF_INET,SOCK_STREAM,0);connect(fd,(struct sockaddr*)&a,sizeof a);}\nC\npython3 - <<'PY'\nimport socket\nsocket.create_connection(('127.0.0.1', 9002)).close()\nPY"),[]);
  assert.ok(classifyCommandText("python -c \"import socket; socket.create_connection(('db.vendor.io', 5432))\"").includes("python-http"));
  assert.ok(classifyCommandText("python -c \"import socket; s = socket.socket(); s.connect(addr)\"").includes("python-http"));
  assert.deepEqual(externalHosts("curl http://asset-ledger:8080/x http://localhost:3000 https://api.vendor.io/y"),["api.vendor.io"]);
});

test("HTTP errors, timeouts and missing packages count as network failures",()=>{
  const failure=output=>execRollout("curl -fsS https://api.vendor.io/x",output)[0].networkFailureSeen;
  for(const output of ["urllib.error.HTTPError: HTTP Error 404: Not Found","curl: (22) The requested URL returned error: 403","ERROR: No matching distribution found for nosuchpkg","requests.exceptions.ReadTimeout: HTTPSConnectionPool(host='x', port=443): Read timed out.",'{"message":"API rate limit exceeded for 1.2.3.4."}',"SSLError: certificate verify failed"])
    assert.equal(failure(output),true,output);
  assert.equal(failure('{"rows": 3}'),false);
});

test("network code written through apply_patch is counted apart from commands that ran",()=>{
  const patch='await tools.apply_patch("*** Begin Patch\\n*** Update File: app/client.py\\n+import httpx\\n+r = httpx.get(BASE_URL)\\n*** End Patch");';
  const written=summarizeIntegrityFindings(auditCodexRolloutText(rollout([codexCall("w",patch)])));
  assert.equal(written.writtenNetworkCode,1);assert.equal(written.networkCommands,0);assert.equal(written.status,"review");
  const ran=summarizeIntegrityFindings(auditCodexRolloutText(rollout([codexCall("r",patch+'\nawait tools.exec_command({cmd:"curl -sS https://api.vendor.io/v1"});')])));
  assert.equal(ran.networkCommands,1);assert.equal(ran.writtenNetworkCode,0);
});

// Codex tools and execution events.

test("Codex execution events decide whether a hosted call ran",()=>{
  const aliased=summarizeIntegrityFindings(auditCodexRolloutText(rollout([codexCall("a",'const w = tools.web__run;\nconst r = await w({search_query:[{q:"x"}]});'),event({type:"Extension",kind:"web.search"}),codexOutput("a","results")])));
  assert.equal(aliased.hostedWebCalls,1);assert.equal(aliased.status,"invalid");
  const connector=summarizeIntegrityFindings(auditCodexRolloutText(rollout([codexCall("b",'await tools.mcp__codex_apps__search_service_web_run({q:"x"});'),event({type:"McpToolCall",server:"codex_apps",tool:"search_service_web_run",arguments:{q:"x"},result:{content:[{type:"text",text:"hit"}]}}),codexOutput("b","hit")])));
  assert.equal(connector.hostedWebCalls,1);assert.equal(connector.hostedWebAttempts,0);
  // With events recorded, a hosted call that has none failed or never ran: an attempt for review.
  const failed=summarizeIntegrityFindings(auditCodexRolloutText(rollout([event({type:"Reasoning"}),codexCall("c",'await tools.web__run({open:[{ref_id:"x"}]});'),codexOutput("c","Script failed\nTypeError: tools.web__run is not a function")])));
  assert.equal(failed.hostedWebCalls,0);assert.equal(failed.hostedWebAttempts,1);assert.equal(failed.status,"review");
  const skipped=summarizeIntegrityFindings(auditCodexRolloutText(rollout([event({type:"Reasoning"}),codexCall("s",'if (false) await tools.web__run({q:"x"});\ntext("skipped");'),codexOutput("s","skipped")])));
  assert.equal(skipped.hostedWebCalls,0);assert.equal(skipped.hostedWebAttempts,1);
  assert.equal(summarizeIntegrityFindings(auditCodexRolloutText(rollout([codexCall("d",'await tools.sleep({ms:10});'),event({type:"Extension",kind:"clock.sleep"}),codexOutput("d","")]))).status,"clean");
  const unknown=summarizeIntegrityFindings(auditCodexRolloutText(rollout([event({type:"Extension",kind:"image.generate"})])));
  assert.deepEqual(unknown.unknownTools,["extension:image.generate"]);assert.equal(unknown.status,"review");
});

test("tools chosen at run time or only referenced without an execution event are reported",()=>{
  const dynamic=summarizeIntegrityFindings(auditCodexRolloutText(rollout([codexCall("a",'const name = pick();\nawait tools[name]({});'),codexOutput("a","done")])));
  assert.deepEqual(dynamic.unknownTools,["tools[dynamic]"]);assert.equal(dynamic.status,"review");
  const destructured=summarizeIntegrityFindings(auditCodexRolloutText(rollout([codexCall("b",'const { web__run } = tools;\nawait web__run({q:"x"});'),codexOutput("b","{}")])));
  assert.deepEqual(destructured.unknownTools,["web__run"]);assert.equal(destructured.hostedWebCalls,0);assert.equal(destructured.status,"review");
});

test("commands the exec script builds at run time are audited from CommandExecution events",()=>{
  const findings=auditCodexRolloutText(rollout([
    codexCall("a",'const tool = ["cu","rl"].join("");\nconst r = await tools.exec_command({cmd: tool + " -sS https://" + host + "/v1/x"});\ntext(r.output);'),
    event({type:"CommandExecution",command:["/bin/bash","-lc","curl -sS https://data.vendor.io/v1/x"],aggregated_output:'{"rows": 3}'}),
    codexOutput("a",'{"rows": 3}'),
  ]));
  const command=findings.find(finding=>finding.kind==="command");
  assert.ok(command.kinds.includes("cli-fetch"));assert.deepEqual(command.hosts,["data.vendor.io"]);
  assert.equal(command.callId,"a");assert.equal(command.source,"command-execution");assert.match(command.output,/rows/);
});

test("local_shell_call is audited, mcp_call is hosted and unknown call items are reported",()=>{
  const summary=summarizeIntegrityFindings(auditCodexRolloutText(rollout([
    {type:"response_item",payload:{type:"local_shell_call",call_id:"s",action:{type:"exec",command:["bash","-lc","wget -q https://dl.vendor.io/a.tgz"]}}},
    {type:"response_item",payload:{type:"local_shell_call_output",call_id:"s",output:"saved"}},
    {type:"response_item",payload:{type:"image_generation_call",id:"ig"}},
  ])));
  assert.equal(summary.networkCommands,1);assert.deepEqual(summary.unknownTools,["image_generation_call"]);
  assert.equal(summary.auditedCommands,1);assert.equal(summary.status,"review");
  const mcp=summarizeIntegrityFindings(auditCodexRolloutText(rollout([{type:"response_item",payload:{type:"mcp_call",server_label:"docs",name:"fetch_page",arguments:"{}",output:"page"}}])));
  assert.equal(mcp.status,"invalid");assert.deepEqual(mcp.hostedWebTools,["mcp__docs__fetch_page"]);
});

test("MCP resource tools are hosted; image generation and plugin installs need review; goal tools are local",()=>{
  const call=(name,args)=>({type:"response_item",payload:{type:"function_call",name,call_id:name,arguments:args}});
  assert.equal(summarizeIntegrityFindings(auditCodexRolloutText(rollout([call("read_mcp_resource",'{"server":"codex_apps","uri":"x"}')]))).status,"invalid");
  const review=summarizeIntegrityFindings(auditCodexRolloutText(rollout([codexCall("i",'await tools.image_gen__imagegen({prompt:"x"});\nawait tools.request_plugin_install({id:"y"});')])));
  assert.deepEqual(review.unknownTools.sort(),["image_gen__imagegen","request_plugin_install"]);assert.equal(review.status,"review");
  assert.equal(summarizeIntegrityFindings(auditCodexRolloutText(rollout([codexCall("g",'await tools.create_goal({goal:"x"});\nawait tools.update_goal({status:"done"});')]))).status,"clean");
});

test("a request for user input alone needs review",()=>{
  const summary=summarizeIntegrityFindings(auditCodexRolloutText(rollout([{type:"response_item",payload:{type:"function_call",name:"request_user_input",call_id:"q",arguments:'{"question":"Which reference values does the grader use?"}'}}])));
  assert.equal(summary.userInputRequests,1);assert.equal(summary.status,"review");
});

test("offered hosted tools and plugin recommendations are recorded without changing the status",()=>{
  const summary=summarizeIntegrityFindings(auditCodexRolloutText(rollout([
    {type:"response_item",payload:{type:"message",role:"developer",content:[{type:"input_text",text:"<recommended_plugins>\n- github\n</recommended_plugins>"}]}},
    codexCall("t","text(JSON.stringify(ALL_TOOLS));"),
    codexOutput("t",JSON.stringify([{name:"exec_command"},{name:"mcp__codex_apps__search_service_web_run"},{name:"read_mcp_resource"}])),
  ])));
  assert.deepEqual(summary.hostedToolsOffered,["mcp__codex_apps__search_service_web_run","read_mcp_resource","recommended_plugins"]);
  assert.equal(summary.status,"clean");
});

test("a shell call that gets a response from the OpenAI API is hosted use",()=>{
  const reached=summarizeIntegrityFindings(execRollout('curl -s https://api.openai.com/v1/responses -H "Authorization: Bearer $OPENAI_API_KEY" -d @req.json','{"id":"resp_0123456789abcdef0123","object":"response","output":[]}'));
  assert.equal(reached.status,"invalid");assert.deepEqual(reached.hostedWebTools,["endpoint:api.openai.com"]);
  assert.equal(summarizeIntegrityFindings(execRollout("curl -s https://api.openai.com/v1/models",'{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}')).status,"review");
  const auth=summarizeIntegrityFindings(execRollout("cat ~/.codex/auth.json","{}"));
  assert.equal(auth.hostedWebCalls,0);assert.equal(auth.status,"review");
});

// Upstream project and benchmark leaks.

test("the task and its upstream project come from the trial directory name",()=>{
  assert.deepEqual(taskContextFromTrialName("django__django-12663__AbC1234"),{taskId:"django__django-12663",project:{org:"django",repo:"django"}});
  assert.deepEqual(taskContextFromTrialName("sphinx-doc__sphinx-7590__x9Yz8Wq"),{taskId:"sphinx-doc__sphinx-7590",project:{org:"sphinx-doc",repo:"sphinx"}});
  assert.deepEqual(taskContextFromTrialName("fin-saccr-rwa__a2EDeKE"),{taskId:"fin-saccr-rwa",project:null});
});

test("fetching the task's own upstream project is a leak only when content comes back",()=>{
  const context=taskContextFromTrialName("django__django-12663__AbC1234");
  const fetchUrl=(url,output,options={context})=>summarizeIntegrityFindings(auditCodexRolloutText(rollout([codexCall("u",`await tools.exec_command({cmd:"python - <<'PY'\\nimport urllib.request\\nprint(urllib.request.urlopen('${url}').read()[:4000])\\nPY"});`),codexOutput("u",output)]),options));
  const leak=fetchUrl("https://api.github.com/repos/django/django/pulls/12663",'{"title":"Fixed #31420 -- Fixed crash when using subquery in SimpleLazyObject","body":"..."}');
  assert.equal(leak.upstreamLeaks,1);assert.equal(leak.status,"invalid");
  const blocked=fetchUrl("https://api.github.com/repos/django/django/pulls/12663","urllib.error.HTTPError: HTTP Error 403: rate limit exceeded");
  assert.equal(blocked.upstreamLeaks,0);assert.equal(blocked.status,"review");
  assert.equal(fetchUrl("https://api.github.com/repos/psf/requests/issues/1",'{"title":"An issue in another project, with its full body text"}').upstreamLeaks,0);
  assert.equal(fetchUrl("https://api.github.com/repos/django/django/pulls/12663",'{"title":"Fixed #31420 -- Fixed crash when using subquery"}',{}).upstreamLeaks,0);
  // A pull request's patch, from GitHub's patch host and from the repository page, is the fix itself.
  const patch="From 06ebaa9e287137d4496a2736b055f1c6aed95839 Mon Sep 17 00:00:00 2001\nSubject: [PATCH] Fixed #31420 -- Fixed crash when using subquery in SimpleLazyObject\n\n django/db/models/sql/query.py | 2 +-";
  for(const url of ["https://patch-diff.githubusercontent.com/raw/django/django/pull/12663.patch","https://github.com/django/django/pull/12663.diff"]){
    const fetched=fetchUrl(url,patch);assert.equal(fetched.upstreamLeaks,1,url);assert.equal(fetched.status,"invalid",url);
  }
  assert.equal(fetchUrl("https://patch-diff.githubusercontent.com/raw/psf/requests/pull/1.patch",patch).upstreamLeaks,0);
});

test("project packages, benchmark sources and benchmark text in fetched output are leaks; Native fetches need review",()=>{
  const context=taskContextFromTrialName("django__django-12663__AbC1234");
  assert.equal(summarizeIntegrityFindings(execRollout("pip download django==3.1 --no-deps -d /tmp/up","Collecting django==3.1\n  Downloading Django-3.1-py3-none-any.whl (7.8 MB)\nSaved /tmp/up/Django-3.1-py3-none-any.whl",{context})).upstreamLeaks,1);
  assert.equal(summarizeIntegrityFindings(execRollout("pip install asgiref sqlparse","Successfully installed asgiref-3.2 sqlparse-0.4",{context})).upstreamLeaks,0);
  const solution=summarizeIntegrityFindings(execRollout("curl -sL https://raw.githubusercontent.com/harbor-framework/terminal-bench/main/tasks/x/tests/test_outputs.py","def test_outputs():\n    assert compute_rwa('book.csv') == 1234.5\n"));
  assert.equal(solution.upstreamLeaks,1);assert.equal(solution.status,"invalid");
  const searched=execRollout("curl -s 'https://api.github.com/search/code?q=fin-saccr-rwa'",'{"items":[{"path":"terminal-bench/tasks/fin-saccr-rwa/solution/solve.sh","repository":{"full_name":"harbor-framework/terminal-bench"}}]}');
  assert.deepEqual(searched[0].upstream,{target:"benchmark",via:"output"});
  assert.equal(summarizeIntegrityFindings(searched).status,"invalid");
  const native=summarizeIntegrityFindings(auditNativeEventsText(nativeLog([terminalRun("n",{gateCommand:"curl -sL https://github.com/django/django/pull/12663.diff"})]),{context}));
  assert.equal(native.upstreamLeaks,0);assert.equal(native.status,"review");
});

test("project sites and installed copies of the project are review suspects, not leaks",()=>{
  const context=taskContextFromTrialName("django__django-12663__AbC1234");
  const ticket=execRollout("curl -s https://code.djangoproject.com/ticket/31420","Ticket #31420 Using SimpleLazyObject with a nested subquery annotation fails. Patch attached.",{context});
  assert.equal(ticket[0].upstream.target,"project-site");
  const ticketSummary=summarizeIntegrityFindings(ticket);
  assert.equal(ticketSummary.upstreamLeaks,0);assert.equal(ticketSummary.status,"review");
  const copy=summarizeIntegrityFindings(execRollout("sed -n 1,80p /opt/conda/lib/python3.11/site-packages/django/db/models/query.py","class QuerySet:",{context}));
  assert.equal(copy.projectCopyReads,1);assert.equal(copy.networkCommands,0);assert.equal(copy.status,"review");
});

// What Native calls returned (agent/trebell-native-tool-calls.jsonl).

const PSF_TRIAL="psf__requests-6028__AbC1234";
const upstreamUtils="python - <<'PY'\nimport urllib.request\nurl = 'https://raw.githubusercontent.com/psf/requests/v2.27.1/requests/utils.py'\ntext = urllib.request.urlopen(url, timeout=10).read().decode()\nstart = text.find('def prepend_scheme_if_needed')\nprint(text[start:start + 1200])\nPY";
const fixedSource=[
  "def prepend_scheme_if_needed(url, new_scheme):",'    """Given a URL that may or may not have a scheme, prepend the given scheme.',"    Does not replace a present scheme with the one provided as an argument.",'    """',
  "    parsed = parse_url(url)","    scheme, auth, host, port, path, query, fragment = parsed","    netloc = parsed.netloc","    if not netloc:","        netloc, path = path, netloc",
  "    if auth:","        netloc = '@'.join([auth, netloc])","    if scheme is None:","        scheme = new_scheme","    if path is None:","        path = ''",
  "    return urlunparse((scheme, netloc, path, '', query, fragment))","",
].join("\n");
const traceback=(...lines)=>["Traceback (most recent call last):",'  File "<stdin>", line 4, in <module>',...lines,""].join("\n");
// A Native trial as the Harbor runner leaves it: the events log and, unless toolCalls is false, the tool-calls log beside it,
// written by the runner's own logger. Each call is a terminal run of `command` that returned an envelope with its stdout, stderr
// and exitCode, the gateway's answer for a call that could not run (`failed`), or an error it threw (`threw`).
async function writeNativeTrial(root,parts,calls,{toolCalls=true}={}){
  const agent=join(root,...parts,"agent"),events=[];
  await mkdir(agent,{recursive:true});
  const log=createToolCallLogger({path:join(agent,"trebell-native-tool-calls.jsonl"),environment:{}});
  for(const [index,call] of calls.entries()){
    const toolCall=index+1,callId=`call_${toolCall}`,args=["-lc",call.command],gateCommand=["bash",...args].join(" ");
    events.push({name:"native.tool.requested",data:{toolCall,callId,namespace:"trebell_terminal",name:"run",terminalAudit:{networkLike:true,hosts:externalHosts(gateCommand),redactedCommand:gateCommand.slice(0,1200),gateCommand}}});
    const result=call.failed??{exitCode:call.exitCode??0,signal:null,stdout:call.stdout??"",stderr:call.stderr??"",timedOut:false,truncated:false,durationMs:640,cwd:"/testbed",command:"bash",args};
    if(toolCalls)await log.wrap(async()=>{if(call.threw)throw new Error(call.threw);return result})({toolCall,modelTurn:toolCall,namespace:"trebell_terminal",name:"run",arguments:{command:"bash",args,cwd:"/testbed"}}).catch(()=>{});
    events.push({name:"native.tool.completed",data:{toolCall,callId,namespace:"trebell_terminal",name:"run",success:!call.threw&&!call.failed,error:call.threw??call.failed?.error??null}});
  }
  await log.flush();
  await writeFile(join(agent,"trebell-native-events.jsonl"),nativeLog(events));
}
const commandFindings=audit=>audit.trials.flatMap(trial=>trial.findings).filter(finding=>finding.kind==="command");

test("a Native fetch of the task's upstream whose terminal envelope returned the fixed source is an upstream leak, also when the log's cap cut the envelope",async()=>{
  await withJobs(async root=>{
    await writeNativeTrial(root,["job-n",PSF_TRIAL],[{command:upstreamUtils,stdout:fixedSource}]);
    const audit=await auditJobIntegrity(root,"job-n"),[finding]=commandFindings(audit);
    assert.equal(audit.summary.status,"invalid");assert.equal(audit.summary.upstreamLeaks,1);
    assert.deepEqual(finding.upstream,{target:"project",via:"url"});assert.equal(finding.contentReturned,true);
    assert.match(finding.output,/^def prepend_scheme_if_needed\(url, new_scheme\):\n/,"the finding shows the decoded stdout, not the envelope's JSON");
    assert.match(audit.trials[0].logFiles[1],/\/agent\/trebell-native-tool-calls\.jsonl$/);
    // The whole module: the log keeps the envelope's first 8,000 characters, so its JSON no longer parses; what came back up to the cut still counts.
    await writeNativeTrial(root,["job-cap",PSF_TRIAL],[{command:upstreamUtils.replace("[start:start + 1200]",""),stdout:fixedSource+"\n# utils.py goes on\n".repeat(600)}]);
    const row=JSON.parse(await readFile(join(root,"job-cap",PSF_TRIAL,"agent","trebell-native-tool-calls.jsonl"),"utf8"));
    assert.match(row.output,/\.\.\.\[\d+ more chars\]$/);assert.throws(()=>JSON.parse(row.output));
    const capped=await auditJobIntegrity(root,"job-cap");
    assert.equal(capped.summary.status,"invalid");assert.equal(capped.summary.upstreamLeaks,1);
    assert.match(commandFindings(capped)[0].output,/^def prepend_scheme_if_needed\(/);
  });
});

test("a Native upstream fetch whose envelope holds only an HTTP error or a traceback, or that never ran, returned nothing, however long the envelope's JSON",async()=>{
  await withJobs(async root=>{
    const pull="python - <<'PY'\nimport json, urllib.request\ndata = json.load(urllib.request.urlopen('https://api.github.com/repos/psf/requests/pulls/6028', timeout=10))\nprint(data['content'])\nPY";
    const trials={
      "psf__requests-6028__Http404x":{command:upstreamUtils,exitCode:1,stderr:traceback('  File "/opt/conda/lib/python3.9/urllib/request.py", line 641, in http_error_default',"    raise HTTPError(req.full_url, code, msg, hdrs, fp)","urllib.error.HTTPError: HTTP Error 404: Not Found")},
      // As the envelope's JSON text this would count as content: one long line naming no network failure.
      "psf__requests-6028__KeyErrxx":{command:pull,exitCode:1,stderr:traceback("KeyError: 'content'")},
      "psf__requests-6028__Failedxx":{command:upstreamUtils,failed:{success:false,error:"spawn bash ENOENT",decision:"ALLOW",confirmationRequired:false,uncertain:false,retrySafe:false}},
      "psf__requests-6028__Threwxxx":{command:upstreamUtils,threw:"Terminal command was cancelled because the turn was aborted"},
    };
    for(const [trial,call] of Object.entries(trials))await writeNativeTrial(root,["job-e",trial],[call]);
    const audit=await auditJobIntegrity(root,"job-e");
    assert.equal(audit.summary.upstreamLeaks,0);assert.equal(audit.summary.status,"review");
    assert.equal(audit.trials.length,4);
    for(const trial of audit.trials){
      const [finding]=commandFindings({trials:[trial]});
      assert.equal(finding.upstream?.target,"project",trial.trialDir);
      assert.equal(finding.contentReturned,false,trial.trialDir);
      assert.equal(finding.networkFailureSeen,/Http404x$/.test(trial.trialDir),trial.trialDir);
    }
  });
});

test("a Native command is paired with its own call's row, not with a recovery read the controller logged under the same number",async()=>{
  await withJobs(async root=>{
    const calls=join(root,"job-k",PSF_TRIAL,"agent","trebell-native-tool-calls.jsonl");
    await mkdir(join(calls,".."),{recursive:true});
    await writeFile(calls,JSON.stringify({toolCall:1,modelTurn:1,namespace:"trebell_workspace",name:"read_file",durationMs:2,arguments:'{"path":"requests/utils.py"}',output:fixedSource})+"\n");
    await writeNativeTrial(root,["job-k",PSF_TRIAL],[{command:upstreamUtils,exitCode:1,stderr:traceback("urllib.error.HTTPError: HTTP Error 404: Not Found")}]);
    const audit=await auditJobIntegrity(root,"job-k"),[finding]=commandFindings(audit);
    assert.equal(finding.contentReturned,false);assert.equal(finding.networkFailureSeen,true);
    assert.equal(audit.summary.upstreamLeaks,0);assert.equal(audit.summary.status,"review");
  });
});

test("a Native documentation read that returned content is annotated with what it returned and stays in review, a project docs site too",async()=>{
  await withJobs(async root=>{
    const docs="python - <<'PY'\nimport urllib.request\ntext = urllib.request.urlopen('https://docs.python.org/3.8/whatsnew/3.8.html', timeout=10).read().decode()\nstart = text.find('notable-changes-in-python-3-8-12')\nprint(text[start:start + 2000])\nPY";
    const notes="Notable changes in Python 3.8.12\nStarting with Python 3.8.12 the ipaddress module no longer accepts any leading zeros in IPv4 address strings.\nLeading zeros are ambiguous and interpreted as octal notation by some libraries.\n";
    const proxies="Proxies\nIf you need to use a proxy, you can configure individual requests with the proxies argument to any request method.\n";
    await writeNativeTrial(root,["job-d",PSF_TRIAL],[{command:docs,stdout:notes},{command:"curl -sL https://requests.readthedocs.io/en/latest/user/advanced/",stdout:proxies}]);
    const audit=await auditJobIntegrity(root,"job-d"),[python,site]=commandFindings(audit);
    assert.equal(audit.summary.status,"review");assert.equal(audit.summary.upstreamLeaks,0);assert.equal(audit.summary.networkCommands,2);
    assert.deepEqual(python.hosts,["docs.python.org"]);assert.equal(python.upstream,undefined);
    assert.match(python.output,/^Notable changes in Python 3\.8\.12\n/,"the read is annotated with what it returned");
    assert.deepEqual(site.upstream,{target:"project-site",via:"url"});assert.equal(site.contentReturned,true);
  });
});

test("without a tool-calls log a Native upstream fetch stays unconfirmed (contentReturned null), and the log beside the events log is what confirms it",async()=>{
  await withJobs(async root=>{
    await writeNativeTrial(root,["job-o",PSF_TRIAL],[{command:upstreamUtils,stdout:fixedSource}],{toolCalls:false});
    const before=await auditJobIntegrity(root,"job-o"),[finding]=commandFindings(before);
    assert.equal(before.summary.status,"review");assert.equal(before.summary.upstreamLeaks,0);
    assert.deepEqual(finding.upstream,{target:"project",via:"url"});assert.equal(finding.contentReturned,null);assert.equal(finding.output,undefined);
    assert.equal(before.trials[0].logFiles.length,1);
    await writeNativeTrial(root,["job-o",PSF_TRIAL],[{command:upstreamUtils,stdout:fixedSource}]);
    const after=await auditJobIntegrity(root,"job-o");
    assert.equal(after.summary.status,"invalid","the same trial once its tool-calls log is there");assert.equal(after.summary.upstreamLeaks,1);
  });
});

test("a Native pip install of an unrelated package stays a review network command, while a fetch of the project's own package that downloaded it is a leak",async()=>{
  await withJobs(async root=>{
    await writeNativeTrial(root,["job-p",PSF_TRIAL],[{command:"pip install idna==3.3",stdout:"Collecting idna==3.3\n  Downloading idna-3.3-py3-none-any.whl (61 kB)\nInstalling collected packages: idna\nSuccessfully installed idna-3.3\n"}]);
    const unrelated=await auditJobIntegrity(root,"job-p"),[install]=commandFindings(unrelated);
    assert.equal(unrelated.summary.status,"review");assert.equal(unrelated.summary.networkCommands,1);assert.equal(unrelated.summary.upstreamLeaks,0);
    assert.ok(install.kinds.includes("package-install"));assert.equal(install.upstream,undefined);assert.equal(install.contentReturned,undefined);
    await writeNativeTrial(root,["job-q",PSF_TRIAL],[{command:"pip download requests==2.27.1 --no-deps -d /tmp/up",stdout:"Collecting requests==2.27.1\n  Downloading requests-2.27.1-py2.py3-none-any.whl (63 kB)\nSaved /tmp/up/requests-2.27.1-py2.py3-none-any.whl\nSuccessfully downloaded requests\n"}]);
    const own=await auditJobIntegrity(root,"job-q"),[download]=commandFindings(own);
    assert.deepEqual(download.upstream,{target:"project",via:"package"});
    assert.equal(own.summary.upstreamLeaks,1,"the project's own package came back");assert.equal(own.summary.status,"invalid");
  });
});

test("a Native command whose only network sign is a URL in its text (network-like) stays in review whatever it printed, with the output shown for the reviewer",async()=>{
  await withJobs(async root=>{
    const lanes={
      "job-grep":[PSF_TRIAL,{command:'grep -rn "https://github.com/psf/requests" setup.py docs/conf.py',stdout:'setup.py:99:        "Source": "https://github.com/psf/requests",\ndocs/conf.py:31:github_url = "https://github.com/psf/requests"\n'}],
      "job-comment":[PSF_TRIAL,{command:"# upstream reference: https://github.com/psf/requests/blob/main/requests/utils.py\nsed -n '960,990p' requests/utils.py",stdout:"def prepend_scheme_if_needed(url, new_scheme):\n    scheme, netloc, path, params, query, fragment = urlparse(url, new_scheme)\n"}],
      "job-docstring":["astropy__astropy-12907__AbC1234",{command:"cat >> astropy/modeling/tests/test_separable.py <<'EOF'\n\ndef test_nested_compound_model():\n    \"\"\"Regression test for https://github.com/astropy/astropy/issues/12906.\"\"\"\n    assert separability_matrix(m.Pix2Sky_TAN() & cm).shape == (4, 4)\nEOF\npython -m pytest astropy/modeling/tests/test_separable.py -q -k nested",stdout:"astropy/modeling/tests/test_separable.py ..                             [100%]\n2 passed, 11 deselected in 0.41s\n"}],
      // A fetch through a script the rules here never see: what it printed is there for a human to judge.
      "job-script":[PSF_TRIAL,{command:"python /tmp/get.py https://raw.githubusercontent.com/psf/requests/v2.27.1/requests/utils.py",stdout:fixedSource}],
    };
    for(const [job,[trial,call]] of Object.entries(lanes)){
      await writeNativeTrial(root,[job,trial],[call]);
      const audit=await auditJobIntegrity(root,job),[finding]=commandFindings(audit);
      assert.equal(audit.summary.status,"review",job);assert.equal(audit.summary.upstreamLeaks,0,job);assert.equal(audit.summary.networkCommands,1,job);
      assert.deepEqual(finding.kinds,["network-like"],job);assert.equal(finding.upstream?.target,"project",job);
      assert.equal(finding.contentReturned,null,job);assert.equal(finding.output,call.stdout.slice(0,400),job);
    }
    // Output that names the benchmark is shown as well, not taken for a benchmark fetch: this command parses a workbook whose XML namespaces are URLs.
    await writeNativeTrial(root,["job-xml","fin-saccr-rwa__AbC1234"],[{command:"python3 -c \"import zipfile; ns={'x':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}; print(open('/app/NOTES.md').read())\"",stdout:"Task notes\nThis environment was adapted from laude-institute/terminal-bench for the spreadsheet track.\n"}]);
    const xml=await auditJobIntegrity(root,"job-xml"),[parse]=commandFindings(xml);
    assert.equal(xml.summary.status,"review");assert.equal(xml.summary.upstreamLeaks,0);
    assert.equal(parse.upstream,undefined);assert.deepEqual(parse.outputReference,{target:"benchmark",via:"output"});
  });
});

test("a package install that names the project fetched it only when a download line names the project's own distribution, in Codex lanes too",async()=>{
  await withJobs(async root=>{
    const socks="Requirement already satisfied: requests[socks] in /testbed (2.27.0)\nRequirement already satisfied: urllib3<1.27,>=1.21.1 in /opt/miniconda3/envs/testbed/lib/python3.9/site-packages (from requests[socks]) (1.26.8)\nCollecting PySocks!=1.5.7,>=1.5.6\n  Downloading PySocks-1.7.1-py3-none-any.whl (16 kB)\nInstalling collected packages: PySocks\nSuccessfully installed PySocks-1.7.1\n";
    const lanes={
      "job-extra":[{command:'pip install "requests[socks]"',stdout:socks},false],
      "job-plugin":[{command:"pip install requests pytest-httpbin==1.0.0",stdout:"Requirement already satisfied: requests in /testbed (2.27.0)\nCollecting pytest-httpbin==1.0.0\n  Downloading pytest_httpbin-1.0.0-py2.py3-none-any.whl (9.9 kB)\nInstalling collected packages: pytest-httpbin\nSuccessfully installed pytest-httpbin-1.0.0\n"},false],
      "job-conda-other":[{command:"conda install -y requests pysocks",stdout:"Collecting package metadata (current_repodata.json): done\nSolving environment: done\n\nDownloading and Extracting Packages\npysocks-1.7.1        | 31 KB     | ########## | 100% \nPreparing transaction: done\n"},false],
      // From pip's cache: no Downloading line, but the project's own distribution was installed.
      "job-cached":[{command:"pip install -U requests==2.27.1",stdout:"Collecting requests==2.27.1\n  Using cached requests-2.27.1-py2.py3-none-any.whl (63 kB)\nInstalling collected packages: requests\n  Attempting uninstall: requests\n    Found existing installation: requests 2.27.0\n    Uninstalling requests-2.27.0:\n      Successfully uninstalled requests-2.27.0\nSuccessfully installed requests-2.27.1\n"},true],
      "job-conda":[{command:"conda install -y requests=2.27.1",stdout:"Downloading and Extracting Packages\nrequests-2.27.1      | 54 KB     | ########## | 100% \nPreparing transaction: done\n"},true],
    };
    for(const [job,[call,fetched]] of Object.entries(lanes)){
      await writeNativeTrial(root,[job,PSF_TRIAL],[call]);
      const audit=await auditJobIntegrity(root,job),[finding]=commandFindings(audit);
      assert.deepEqual(finding.upstream,{target:"project",via:"package"},job);assert.equal(finding.contentReturned,fetched,job);
      assert.equal(audit.summary.upstreamLeaks,fetched?1:0,job);assert.equal(audit.summary.status,fetched?"invalid":"review",job);
    }
    const codex=summarizeIntegrityFindings(execRollout('pip install "requests[socks]"',socks,{context:taskContextFromTrialName(PSF_TRIAL)}));
    assert.equal(codex.upstreamLeaks,0);assert.equal(codex.status,"review");
  });
});

test("a model client sent to a local endpoint got its answer from the task's own server: a review network command, not hosted use, in Codex lanes too",async()=>{
  await withJobs(async root=>{
    const chat="ChatCompletion(id='chatcmpl-5f1c2a9e0b7d4c3a', choices=[Choice(finish_reason='stop', index=0, message=ChatCompletionMessage(content='pong', role='assistant'))], created=1760760000, model='local-echo', object='chat.completion')\n";
    const client=base=>`python - <<'PY'\nfrom openai import OpenAI\nclient = OpenAI(${base}api_key='test')\nprint(client.chat.completions.create(model='local-echo', messages=[{'role': 'user', 'content': 'ping'}]))\nPY`;
    const local={
      "job-loopback":client("base_url='http://127.0.0.1:8000/v1', "),
      "job-env":"OPENAI_BASE_URL=http://localhost:8000/v1 OPENAI_API_KEY=test python check_gateway.py",
      "job-service":"curl -s http://gateway:8000/v1/chat/completions -H \"Authorization: Bearer $OPENAI_API_KEY\" -d @req.json",
    };
    for(const [job,command] of Object.entries(local)){
      await writeNativeTrial(root,[job,"llm-gateway__AbC1234"],[{command,stdout:chat}]);
      const audit=await auditJobIntegrity(root,job),[finding]=commandFindings(audit);
      assert.ok(finding.kinds.includes("hosted-endpoint"),job);assert.equal(finding.hostedEndpointReached,undefined,job);
      assert.equal(audit.summary.hostedWebCalls,0,job);assert.equal(audit.summary.status,"review",job);
    }
    // A client left on its default endpoint reached the OpenAI API.
    await writeNativeTrial(root,["job-default","llm-gateway__AbC1234"],[{command:client(""),stdout:chat}]);
    const hosted=await auditJobIntegrity(root,"job-default");
    assert.equal(hosted.summary.status,"invalid");assert.deepEqual(hosted.summary.hostedWebTools,["endpoint:openai-client"]);
    assert.equal(summarizeIntegrityFindings(execRollout(local["job-loopback"],chat)).status,"review");
  });
});

test("Python warnings, the shell's own errors and an HTML error page are not content: an upstream fetch that printed only them returned nothing, in Codex lanes too",async()=>{
  await withJobs(async root=>{
    const sympy="sympy__sympy-13974__AbC1234",raw="https://raw.githubusercontent.com/psf/requests/v2.27.1/requests/utils.py";
    const warnings=["/testbed/sympy/core/basic.py:3: DeprecationWarning: Using or importing the ABCs from 'collections' instead of from 'collections.abc' is deprecated since Python 3.3, and in 3.10 it will stop working","  from collections import Mapping, defaultdict","/testbed/sympy/core/containers.py:271: DeprecationWarning: Using or importing the ABCs from 'collections' instead of from 'collections.abc' is deprecated since Python 3.3, and in 3.10 it will stop working","  class OrderedSet(collections.MutableSet):","/testbed/sympy/plotting/plot.py:28: DeprecationWarning: Using or importing the ABCs from 'collections' instead of from 'collections.abc' is deprecated since Python 3.3, and in 3.10 it will stop working","  from collections import Callable",""].join("\n");
    const dns=traceback('  File "/opt/miniconda3/envs/testbed/lib/python3.9/urllib/request.py", line 214, in urlopen',"    return opener.open(url, data, timeout)","urllib.error.URLError: <urlopen error [Errno -3] Temporary failure in name resolution>");
    const fetchSympy="python - <<'PY'\nimport sympy, urllib.request\nprint(urllib.request.urlopen('https://raw.githubusercontent.com/sympy/sympy/master/sympy/physics/quantum/tensorproduct.py').read()[:4000].decode())\nPY";
    const page=(title,body)=>["<!DOCTYPE html>",'<html lang="en" data-color-mode="auto" data-light-theme="light" data-dark-theme="dark">',"<head>",'  <meta charset="utf-8">','  <link rel="dns-prefetch" href="https://github.githubassets.com">',`  <title>${title}</title>`,'  <meta name="description" content="GitHub is where people build software. More than 100 million people use GitHub to discover, fork, and contribute to over 420 million projects.">',"</head>","<body>",'  <a href="#start-of-content" class="px-2 py-4 color-bg-accent-emphasis color-fg-on-emphasis show-on-focus js-skip-to-content">Skip to content</a>',...body,'  <footer class="footer pt-8 pb-6 f6 color-fg-muted p-responsive" role="contentinfo"><p>&copy; 2026 GitHub, Inc.</p><nav aria-label="Footer"><a href="https://docs.github.com/site-policy/github-terms/github-terms-of-service">Terms</a> <a href="https://docs.github.com/site-policy/privacy-policies/github-privacy-statement">Privacy</a> <a href="https://www.githubstatus.com/">Status</a></nav></footer>',"</body>","</html>",""].join("\n");
    const missing=['  <div class="container-lg p-responsive py-6"><img alt="404 &ldquo;This is not the web page you are looking for&rdquo;" src="/images/modules/404/parallax_bg.jpg"><p>Find code, projects, and people on GitHub:</p><form action="/search"><input type="text" name="q"><button type="submit">Search</button></form><p>Contact Support &mdash; GitHub Status &mdash; @githubstatus</p></div>'];
    const lanes={
      "job-warnings":[sympy,{command:fetchSympy,exitCode:1,stderr:warnings+dns},true],
      "job-404":[PSF_TRIAL,{command:"curl -sL https://github.com/psf/requests/blob/v2.27.9/requests/utils.py",stdout:page("Page not found &middot; GitHub &middot; GitHub",missing)},true],
      // The same page cut by head before its end, its title written with the character itself.
      "job-404-cut":[PSF_TRIAL,{command:"curl -sL https://github.com/psf/requests/blob/v2.27.9/requests/utils.py | head -11",stdout:page("Page not found · GitHub · GitHub",missing).split("\n").slice(0,11).join("\n")},true],
      // curl -s failed silently; the image's login shell printed its own errors.
      "job-shell":[PSF_TRIAL,{command:`curl -s ${raw}`,exitCode:6,stderr:"/usr/local/bin/_activate_current_env.sh: line 8: : command not found\ncritical libmamba Shell not initialized\n"},false],
    };
    for(const [job,[trial,call,failure]] of Object.entries(lanes)){
      await writeNativeTrial(root,[job,trial],[call]);
      const audit=await auditJobIntegrity(root,job),[finding]=commandFindings(audit);
      assert.equal(finding.upstream?.target,"project",job);assert.equal(finding.contentReturned,false,job);assert.equal(finding.networkFailureSeen,failure,job);
      assert.equal(audit.summary.upstreamLeaks,0,job);assert.equal(audit.summary.status,"review",job);
    }
    // Content next to them still came back: the module after the same warnings, a file's page whose embedded data holds the
    // source, and an issue whose title starts with 404.
    const tensor="from sympy import Expr, Add, Mul, Matrix, Pow, sympify\nfrom sympy.core.trace import Tr\n\ndef tensor_product_simp_Mul(e):\n    \"\"\"Simplify a Mul with TensorProducts.\"\"\"\n    if isinstance(e, Pow) and isinstance(e.base, TensorProduct):\n        return TensorProduct(*[x**e.exp for x in e.base.args])\n";
    const contrasts={
      "job-warnings-ok":[sympy,{command:fetchSympy,stdout:tensor,stderr:warnings}],
      "job-blob":[PSF_TRIAL,{command:"curl -sL https://github.com/psf/requests/blob/v2.27.1/requests/utils.py",stdout:page("requests/requests/utils.py at v2.27.1 &middot; psf/requests &middot; GitHub",[`  <script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({payload:{blob:{rawLines:fixedSource.split("\n")}}})}</script>`])}],
      "job-issue":[PSF_TRIAL,{command:"curl -sL https://github.com/psf/requests/issues/6027",stdout:page("404 on redirect with proxy &middot; Issue #6027 &middot; psf/requests &middot; GitHub",['  <h1 class="gh-header-title">404 on redirect with proxy</h1>','  <td class="comment-body">When using proxies in python 3.8.12, prepend_scheme_if_needed drops the auth part; rebuilding the netloc from parse_url keeps the credentials.</td>'])}],
    };
    for(const [job,[trial,call]] of Object.entries(contrasts)){
      await writeNativeTrial(root,[job,trial],[call]);
      const audit=await auditJobIntegrity(root,job);
      assert.equal(audit.summary.upstreamLeaks,1,job);assert.equal(audit.summary.status,"invalid",job);
    }
    const codex=summarizeIntegrityFindings(execRollout(fetchSympy,warnings+dns,{context:taskContextFromTrialName(sympy)}));
    assert.equal(codex.upstreamLeaks,0);assert.equal(codex.status,"review");
  });
});

test("an upstream fetch the command saved to a file printed nothing of it: what came back stays unknown and the finding says it was saved, in Codex lanes too",async()=>{
  await withJobs(async root=>{
    const raw="https://raw.githubusercontent.com/psf/requests/v2.27.1/requests/utils.py";
    const saved={
      "job-curl-o":`curl -sL ${raw} -o /tmp/upstream_utils.py`,
      "job-wget":`wget -q ${raw} -O /tmp/upstream_utils.py`,
      "job-redirect":`curl -fsSL ${raw} > /tmp/upstream_utils.py`,
      "job-urlretrieve":`python - <<'PY'\nimport urllib.request\nurllib.request.urlretrieve('${raw}', '/tmp/upstream_utils.py')\nPY`,
    };
    for(const [job,command] of Object.entries(saved)){
      await writeNativeTrial(root,[job,PSF_TRIAL],[{command}]);
      const audit=await auditJobIntegrity(root,job),[finding]=commandFindings(audit);
      assert.equal(finding.contentReturned,null,job);assert.equal(finding.savedToFile,true,job);
      assert.equal(audit.summary.status,"review",job);assert.equal(audit.summary.upstreamLeaks,0,job);
      assert.equal(compactIntegrity(audit).evidence[0].savedToFile,true,job);
    }
    // Nothing kept: a status probe written to /dev/null, and a saved fetch that failed.
    const unsaved={
      "job-probe":[{command:"curl -s -o /dev/null -w '%{http_code}' https://github.com/psf/requests/pull/6028",stdout:"200"},false],
      "job-failed":[{command:`curl -sSL ${raw} -o /tmp/upstream_utils.py`,exitCode:6,stderr:"curl: (6) Could not resolve host: raw.githubusercontent.com\n"},true],
    };
    for(const [job,[call,failure]] of Object.entries(unsaved)){
      await writeNativeTrial(root,[job,PSF_TRIAL],[call]);
      const [finding]=commandFindings(await auditJobIntegrity(root,job));
      assert.equal(finding.contentReturned,false,job);assert.equal(finding.savedToFile,undefined,job);assert.equal(finding.networkFailureSeen,failure,job);
    }
    // Saved, then printed: content came back.
    await writeNativeTrial(root,["job-printed",PSF_TRIAL],[{command:`curl -sL ${raw} -o /tmp/upstream_utils.py && sed -n '960,990p' /tmp/upstream_utils.py`,stdout:fixedSource}]);
    assert.equal((await auditJobIntegrity(root,"job-printed")).summary.status,"invalid");
    const codex=execRollout(saved["job-curl-o"],"",{context:taskContextFromTrialName(PSF_TRIAL)}).find(finding=>finding.kind==="command");
    assert.equal(codex.contentReturned,null);assert.equal(codex.savedToFile,true);
  });
});

// Native logging gaps.

test("Native commands the event log does not fully record are counted and keep the lane in review",()=>{
  const findings=auditNativeEventsText(nativeLog([
    terminalRun("u1"),
    terminalRun("t1",{gateCommand:"echo "+"x".repeat(23995)}),
    terminalRun("p1",{redactedCommand:"python - <<'PY'\n"+"#".repeat(1184)}),
    terminalRun("h1",{redactedCommand:"cat > /app/a.txt <<'EOF'\n"+"y".repeat(1100)+"\nEOF"}),
    terminalRun("ok",{redactedCommand:"pytest -q",gateCommand:"pytest -q"}),
    terminalRun("e1",{redactedCommand:"",gateCommand:""}),
    {name:"native.tool.requested",data:{callId:"s1",namespace:"trebell_process",name:"start"}},
    {name:"native.background.started",data:{processId:"p",command:"curl -fsS https://files.vendor.io/data.csv -o /tmp/d.csv"}},
    {name:"native.background.started",data:{processId:"q",command:"node server.js "+"y".repeat(985)}},
  ]));
  const summary=summarizeIntegrityFindings(findings);
  assert.equal(summary.unauditedCommands,1);
  assert.equal(summary.truncatedCommands,1);
  assert.equal(summary.partialCommands,2);
  // The start request (s1) is audited through the background event that records its command.
  assert.equal(summary.unloggedCommands,0);
  assert.equal(summary.auditedCommands,6);
  assert.equal(summary.networkCommands,1);
  assert.equal(findings.find(finding=>finding.kind==="command").source,"background");
  assert.equal(summary.status,"review");
  // A partly logged or truncated command alone is enough to keep the lane from reading clean.
  assert.equal(summarizeIntegrityFindings(auditNativeEventsText(nativeLog([terminalRun("p",{redactedCommand:"python - <<'PY'\n"+"#".repeat(1184)})]))).status,"review");
  assert.equal(summarizeIntegrityFindings(auditNativeEventsText(nativeLog([terminalRun("t",{gateCommand:"echo "+"x".repeat(23995)})]))).status,"review");
  assert.equal(summarizeIntegrityFindings(auditNativeEventsText(nativeLog([terminalRun("h",{redactedCommand:"cat > /app/a.txt <<'EOF'\n"+"y".repeat(1100)+"\nEOF"})]))).status,"clean");
});

// B1's wdm-design try 1 (2026-10-14) read "review" only for 17 such starts, all `python -u design_optimize.py ...`, each
// recorded by its native.background.started event.
test("a Native background start is audited through the event that records its command, and one that never started stays unlogged",()=>{
  const start=id=>({name:"native.tool.requested",data:{callId:id,namespace:"trebell_process",name:"start"}});
  const started=(id,command)=>({name:"native.background.started",data:{processId:id,command}});
  const clean=summarizeIntegrityFindings(auditNativeEventsText(nativeLog([start("s1"),started("p1","python -u optimize.py --seed 0"),start("s2"),started("p2","python -u optimize.py --seed 1")])));
  assert.equal(clean.unloggedCommands,0);assert.equal(clean.auditedCommands,2);assert.equal(clean.status,"clean");
  const network=summarizeIntegrityFindings(auditNativeEventsText(nativeLog([start("s1"),started("p1","curl -fsS https://files.vendor.io/data.csv -o /tmp/d.csv")])));
  assert.equal(network.unloggedCommands,0);assert.equal(network.networkCommands,1);assert.equal(network.status,"review","a background command is still classified");
  const neverStarted=summarizeIntegrityFindings(auditNativeEventsText(nativeLog([start("s1"),start("s2"),started("p2","python -u optimize.py")])));
  assert.equal(neverStarted.unloggedCommands,1);assert.equal(neverStarted.auditedCommands,1);assert.equal(neverStarted.status,"review");
  // The legacy start_background name pairs with its own event, so it cannot stand in for a process.start that never started.
  const legacy={name:"native.tool.requested",data:{callId:"t1",namespace:"trebell_terminal",name:"start_background"}};
  const mixed=summarizeIntegrityFindings(auditNativeEventsText(nativeLog([start("s1"),legacy,started("p1","python -u optimize.py")])));
  assert.equal(mixed.unloggedCommands,1);assert.equal(mixed.unauditedCommands,0);assert.equal(mixed.auditedCommands,1);
  const legacyClean=summarizeIntegrityFindings(auditNativeEventsText(nativeLog([legacy,started("p1","python -u optimize.py")])));
  assert.equal(legacyClean.unloggedCommands,0);assert.equal(legacyClean.unauditedCommands,0);assert.equal(legacyClean.status,"clean");
});

test("a Native lane whose commands were never recorded is unaudited, not clean",()=>{
  const unrecorded=summarizeIntegrityFindings(auditNativeEventsText(nativeLog([terminalRun("a"),terminalRun("b"),{name:"native.tool.requested",data:{callId:"c",namespace:"trebell_repo",name:"read_source"}}])));
  assert.equal(unrecorded.unauditedCommands,2);assert.equal(unrecorded.auditedCommands,0);assert.equal(unrecorded.status,"unaudited");
  assert.equal(summarizeIntegrityFindings(auditNativeEventsText(nativeLog([terminalRun("a"),terminalRun("b",{gateCommand:"ls -la",redactedCommand:"ls -la"})]))).status,"review");
});

test("trials that ran Native tools or used model tokens without an agent log are unaudited; setup failures stay no-logs",async()=>{
  await withJobs(async root=>{
    await writeTrialFile(root,["job-old","mips__AbC1234","agent","trebell-native.txt"],"[native] done nativeToolCalls=12 turns=30\n");
    await writeTrialFile(root,["job-ran","task__XyZ9876","result.json"],JSON.stringify({agent_result:{n_input_tokens:5000,n_output_tokens:300}}));
    await mkdir(join(root,"job-ran","task__XyZ9876","agent"),{recursive:true});
    await writeTrialFile(root,["job-setup","task__QwE5678","result.json"],JSON.stringify({agent_result:null,exception_info:{exception_type:"AgentSetupTimeoutError"}}));
    await mkdir(join(root,"job-setup","task__QwE5678","agent","setup"),{recursive:true});
    const old=await auditJobIntegrity(root,"job-old");
    assert.equal(old.summary.status,"unaudited");assert.equal(old.summary.unauditedCommands,12);assert.equal(old.logs,0);
    assert.equal((await auditJobIntegrity(root,"job-ran")).summary.status,"unaudited");
    assert.equal((await auditJobIntegrity(root,"job-setup")).summary.status,"no-logs");
  });
});

test("Native events named like web tools and tools outside Trebell's namespaces need review",()=>{
  const summary=summarizeIntegrityFindings(auditNativeEventsText(nativeLog([
    {name:"native.web.search_completed",data:{query:"x"}},
    {name:"native.tool.requested",data:{callId:"x",namespace:"browser",name:"open"}},
    {name:"native.progress.external_observation_call_blocked",data:{}},
  ])));
  assert.deepEqual(summary.unknownTools.sort(),["browser.open","event:native.web.search_completed"]);
  assert.equal(summary.status,"review");
});

// Job totals.

test("job totals and status use every finding, not only the stored ones",async()=>{
  await withJobs(async root=>{
    const rows=[];
    for(let i=0;i<70;i++)rows.push(codexCall(`c${i}`,`await tools.exec_command({cmd:"curl -sS https://mirror${i}.vendor.io/a"});`),codexOutput(`c${i}`,"ok"));
    rows.push(codexCall("w",'await tools.web__run({search_query:[{q:"answer"}]});'),event({type:"Extension",kind:"web.search"}),codexOutput("w","results"));
    rows.push(codexCall("v",'await tools.exec_command({cmd:"cat /tests/test_outputs.py"});'),codexOutput("v","def test(): ..."));
    await writeTrialFile(root,["job-big","task__abc1234","agent","codex-sessions","rollout-1.jsonl"],rollout(rows));
    const audit=await auditJobIntegrity(root,"job-big");
    assert.equal(audit.summary.networkCommands,70);
    assert.equal(audit.summary.hostedWebCalls,1);
    assert.equal(audit.summary.verifierPathReads,1);
    assert.equal(audit.summary.status,"invalid");
    assert.equal(audit.trials[0].findings.length,60);assert.equal(audit.trials[0].findingsOmitted,12);
    const compact=compactIntegrity(audit);
    assert.equal(compact.networkCommands,70);
    assert.equal(compact.evidence[0].tool,"web__run");assert.equal(compact.evidence[0].executed,true);
    assert.ok(compact.evidence[1].kinds.includes("verifier-path"));
  });
});

test("job summaries add trial counts and keep the strongest status",()=>{
  const hosted=summarizeIntegrityFindings([{kind:"hosted-web",tool:"web__run",executed:true}]);
  const network=summarizeIntegrityFindings([{kind:"command",kinds:["cli-fetch"],hosts:["a.io"]},{kind:"command",kinds:["cli-fetch"],hosts:["b.io"]}],{auditedCommands:2});
  const merged=mergeIntegritySummaries([hosted,network]);
  assert.equal(merged.hostedWebCalls,1);assert.equal(merged.networkCommands,2);assert.equal(merged.auditedCommands,2);
  assert.deepEqual(merged.externalHosts.sort(),["a.io","b.io"]);assert.equal(merged.status,"invalid");
  const unaudited=summarizeIntegrityFindings([{kind:"unaudited-command",count:3}]);
  assert.equal(unaudited.status,"unaudited");
  assert.equal(mergeIntegritySummaries([unaudited,network]).status,"review");
});
