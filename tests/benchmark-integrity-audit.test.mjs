import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditCodexExecStreamText, auditCodexRolloutText, auditJobIntegrity, auditNativeEventsText, classifyCommandText, compactIntegrity, externalHosts, mergeIntegritySummaries, summarizeIntegrityFindings, taskContextFromTrialName } from "../scripts/benchmark-integrity-audit.mjs";

const codexCall=(callId,input)=>({type:"response_item",payload:{type:"custom_tool_call",name:"exec",call_id:callId,input}});
const codexOutput=(callId,text)=>({type:"response_item",payload:{type:"custom_tool_call_output",call_id:callId,output:[{type:"input_text",text}]}});
const rollout=rows=>rows.map(row=>JSON.stringify(row)).join("\n");
const event=item=>({type:"event_msg",payload:{type:"item_completed",item}});
const execRollout=(command,output,options)=>auditCodexRolloutText(rollout([codexCall("x",`await tools.exec_command({cmd:${JSON.stringify(command)}});`),codexOutput("x",output)]),options);
const nativeLog=rows=>rows.map(row=>JSON.stringify(row)).join("\n");
const terminalRun=(callId,terminalAudit)=>({name:"native.tool.requested",data:{callId,namespace:"trebell_terminal",name:"run",...(terminalAudit?{terminalAudit}:{})}});
const streamItem=(type,item)=>JSON.stringify({type,item});
async function withJobs(run){const root=await mkdtemp(join(tmpdir(),"trebell-integrity-"));try{await run(root)}finally{await rm(root,{recursive:true,force:true})}}
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
  }finally{await rm(root,{recursive:true,force:true})}
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
  assert.equal(summary.unloggedCommands,1);
  assert.equal(summary.auditedCommands,5);
  assert.equal(summary.networkCommands,1);
  assert.equal(findings.find(finding=>finding.kind==="command").source,"background");
  assert.equal(summary.status,"review");
  // A partly logged or truncated command alone is enough to keep the lane from reading clean.
  assert.equal(summarizeIntegrityFindings(auditNativeEventsText(nativeLog([terminalRun("p",{redactedCommand:"python - <<'PY'\n"+"#".repeat(1184)})]))).status,"review");
  assert.equal(summarizeIntegrityFindings(auditNativeEventsText(nativeLog([terminalRun("t",{gateCommand:"echo "+"x".repeat(23995)})]))).status,"review");
  assert.equal(summarizeIntegrityFindings(auditNativeEventsText(nativeLog([terminalRun("h",{redactedCommand:"cat > /app/a.txt <<'EOF'\n"+"y".repeat(1100)+"\nEOF"})]))).status,"clean");
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
