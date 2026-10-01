import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  cachedTaskPathFromLock,
  composeProjectForTrial,
  dockerResourceIdsForProject,
  ensureRegradableNativeResult,
  nativeArtifactManifest,
  nativeTerminalEvent,
  recoverDroppedNativeTrial,
  regradeSalvagedNativeTrial,
  salvageNativeArtifact,
  waitForNativeTerminalEvent,
} from "../scripts/terminal-bench-native-salvage.mjs";

test("Native salvage recognizes terminal events and derives Harbor cache/project identity",()=>{
  const event=nativeTerminalEvent([JSON.stringify({name:"native.model.completed",atMs:10}),JSON.stringify({name:"native.turn.completed",atMs:20})].join("\n"));
  assert.equal(event?.name,"native.turn.completed");
  assert.equal(composeProjectForTrial("H:/jobs/mp-checkpoint-consolidation__Lc6RhE4"),"mp-checkpoint-consolidation__lc6rhe4__env");
  const taskPath=cachedTaskPathFromLock({task:{name:"terminal-bench/mp-checkpoint-consolidation",digest:"sha256:abc123"}},{home:"C:/Users/example"});
  assert.equal(taskPath,join("C:/Users/example",".cache","harbor","tasks","packages","terminal-bench","mp-checkpoint-consolidation","abc123"));
});
test("Native salvage waits for a terminal event without requiring Harbor to remain alive",async()=>{
  const rows=[JSON.stringify({name:"native.model.completed",atMs:10}),JSON.stringify({name:"native.turn.completed",atMs:20})];
  let reads=0,now=0;
  const event=await waitForNativeTerminalEvent("trial",{timeoutMs:100,pollMs:10,nowFn:()=>now,readFileFn:async()=>rows.slice(0,Math.min(rows.length,++reads)).join("\n"),sleepFn:async ms=>{now+=ms}});
  assert.equal(event?.name,"native.turn.completed");assert.equal(reads,2);
});

test("Native salvage copies the artifact from the exact retained Compose project and writes Harbor manifest",async()=>{
  const captures=[],runs=[],writes=[];
  const captureFn=async(command,args)=>{captures.push([command,args]);if(args[0]==="ps")return "container123\n";return ""};
  const runFn=async(command,args)=>{runs.push([command,args])};
  const trialDir=join("H:/jobs","mp-checkpoint-consolidation__Lc6RhE4");
  const result=await salvageNativeArtifact(trialDir,{captureFn,runFn,mkdirFn:async()=>{},writeFileFn:async(path,content)=>writes.push([path,content])});
  assert.equal(result.ok,true);assert.equal(result.containerId,"container123");
  assert.ok(captures.some(([,args])=>args.includes("label=com.docker.compose.project=mp-checkpoint-consolidation__lc6rhe4__env")));
  assert.deepEqual(runs[0],["docker",["cp","container123:/app/output/model.safetensors",join(trialDir,"artifacts","app","output","model.safetensors")]]);
  assert.equal(basename(writes[0][0]),"manifest.json");assert.deepEqual(JSON.parse(writes[0][1]),nativeArtifactManifest());
});

test("Native salvage resource discovery is scoped to one Compose project",async()=>{
  const seen=[];
  const captureFn=async(_command,args)=>{seen.push(args);if(args[0]==="ps")return "c1\nc2\n";if(args[0]==="network")return "n1\n";if(args[0]==="volume")return "v1\n";return ""};
  const resources=await dockerResourceIdsForProject("trial__env",{captureFn});
  assert.deepEqual(resources,{containers:["c1","c2"],networks:["n1"],volumes:["v1"]});
  assert.ok(seen.every(args=>args.includes("label=com.docker.compose.project=trial__env")));
});

test("Native salvage reconstructs only the missing source result from durable metrics",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-result-"));
  try{
    await mkdir(join(root,"agent"),{recursive:true});
    await writeFile(join(root,"config.json"),JSON.stringify({task:{name:"terminal-bench/example",ref:"sha256:abc",source:"terminal-bench/terminal-bench"},agent:{name:"benchmarks.harbor.trebell_native_agent:TrebellNativeAgent",model_name:"openai/gpt-6-luna"}}));
    await writeFile(join(root,"lock.json"),JSON.stringify({task:{name:"terminal-bench/example",digest:"sha256:abc",source:"terminal-bench/terminal-bench"}}));
    await writeFile(join(root,"agent","trebell-native-metrics.json"),JSON.stringify({version:"trebell-native-harbor/1",model:"gpt-6-luna",reasoningEffort:"max",modelTurns:7,toolCalls:9,providerRequests:7,usage:{inputTokens:100,cachedInputTokens:80,outputTokens:20,reasoningOutputTokens:10,cacheWriteInputTokens:5},strategy:{completionRecoveryExhaustions:1},error:null}));
    const recovered=await ensureRegradableNativeResult(root);
    assert.equal(recovered.created,true);
    assert.equal(recovered.result?.task_name,"terminal-bench/example");
    assert.equal(recovered.result?.agent_result?.n_input_tokens,100);
    assert.equal(recovered.result?.agent_result?.metadata?.trebell_native?.recovered_unsealed_source,true);
    assert.equal(recovered.result?.verifier_result,null);
    assert.match(recovered.result?.task_checksum,/^recovered-unsealed:/);
    const second=await ensureRegradableNativeResult(root);assert.equal(second.created,false);assert.equal(second.result?.id,recovered.result?.id);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Native dropped-run recovery waits for completion, salvages the artifact, and regrades without model inference",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-salvage-")),outputRoot=join(root,"jobs"),validationDir=join(root,"validation"),jobName="job",trialName="mp-checkpoint-consolidation__AbCd123",trialDir=join(outputRoot,jobName,trialName);
  try{
    await mkdir(join(trialDir,"agent"),{recursive:true});
    await writeFile(join(trialDir,"agent","trebell-native-events.jsonl"),JSON.stringify({name:"native.turn.completed",status:"completed",data:{completionGateVerdict:"incomplete"}})+"\n");
    await writeFile(join(trialDir,"config.json"),JSON.stringify({task:{name:"terminal-bench/mp-checkpoint-consolidation",ref:"sha256:abc123",source:"terminal-bench/terminal-bench"},agent:{name:"benchmarks.harbor.trebell_native_agent:TrebellNativeAgent",model_name:"openai/gpt-6-luna"}}));
    await writeFile(join(trialDir,"lock.json"),JSON.stringify({task:{name:"terminal-bench/mp-checkpoint-consolidation",digest:"sha256:abc123"}}));
    await writeFile(join(trialDir,"agent","trebell-native-metrics.json"),JSON.stringify({version:"trebell-native-harbor/1",model:"gpt-6-luna",modelTurns:3,toolCalls:4,providerRequests:3,usage:{inputTokens:123,cachedInputTokens:100,outputTokens:9},error:null}));
    const commands=[];
    const captureFn=async(_command,args)=>args[0]==="ps"?"container42\n":"";
    const runFn=async(command,args)=>{
      commands.push([command,args]);
      if(command==="docker"&&args[0]==="cp"){await mkdir(join(trialDir,"artifacts","app","output"),{recursive:true});await writeFile(args[2],"artifact");return}
      if(command==="harbor"){
        const out=args[args.indexOf("-o")+1],name=args[args.indexOf("--trial-name")+1],target=join(out,name);
        await mkdir(target,{recursive:true});await writeFile(join(target,"result.json"),JSON.stringify({verifier_result:{rewards:{reward:0}},agent_result:{n_input_tokens:123}}));return;
      }
      throw new Error("unexpected command "+command);
    };
    const recovered=await recoverDroppedNativeTrial({outputRoot,jobName,harbor:"harbor",validationDir,home:join(root,"home"),captureFn,runFn,waitTimeoutMs:100});
    assert.equal(recovered.ok,true,JSON.stringify(recovered,null,2));
    assert.equal(recovered.terminalEvent?.name,"native.turn.completed");
    assert.equal(recovered.regrade?.result?.verifier_result?.rewards?.reward,0);
    assert.ok(commands.some(([command,args])=>command==="docker"&&args[0]==="cp"));
    assert.ok(commands.some(([command,args])=>command==="harbor"&&args[0]==="trial"&&args[1]==="regrade"));
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Native salvage does not call an ungraded regrade a recovered benchmark",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-regrade-missing-")),trialDir=join(root,"trial"),validationDir=join(root,"validation");
  try{
    await mkdir(trialDir,{recursive:true});
    await writeFile(join(trialDir,"lock.json"),JSON.stringify({task:{name:"terminal-bench/example",digest:"sha256:abc123"}}));
    const missing=await regradeSalvagedNativeTrial({
      trialDir,harbor:"harbor",validationDir,home:join(root,"home"),
      runFn:async()=>{},
    });
    assert.equal(missing.ok,false);
    assert.match(missing.reason,/did not produce result\.json/);

    const noVerifier=await regradeSalvagedNativeTrial({
      trialDir,harbor:"harbor",validationDir,home:join(root,"home"),
      runFn:async(_command,args)=>{
        const out=args[args.indexOf("-o")+1],name=args[args.indexOf("--trial-name")+1],target=join(out,name);
        await mkdir(target,{recursive:true});
        await writeFile(join(target,"result.json"),JSON.stringify({verifier_result:null,exception_info:{exception_type:"VerifierTimeoutError"}}));
      },
    });
    assert.equal(noVerifier.ok,false);
    assert.match(noVerifier.reason,/did not produce a verifier result/);
  }finally{await rm(root,{recursive:true,force:true})}
});
