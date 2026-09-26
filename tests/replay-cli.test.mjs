import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventJournal } from "../src/event-journal.mjs";

const exec=promisify(execFile);
const root=fileURLToPath(new URL("..",import.meta.url));

test("replay CLI exports a sanitized filtered bundle and replays it",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-replay-cli-")),output=join(home,"bundle.json"),secret=["replay","cli","secret"].join("-");
  try{
    const env={...process.env,TREBELL_HOME:home,CUSTOM_TOKEN:secret};
    const journal=new EventJournal(env,{maxRecords:100,maxBytes:256*1024});
    journal.record({id:"cli-keep",at:100,runtime:"codex",threadId:"cli-thread",turnId:"turn-a",category:"verification",name:"verification.completed",status:"completed",data:{authorization:"Bearer "+secret}});
    journal.record({id:"cli-skip",at:200,runtime:"claude",threadId:"other-thread",turnId:"turn-b",category:"runtime",name:"turn/started"});
    await journal.close();

    const exported=await exec(process.execPath,["scripts/export-event-replay.mjs","--thread","cli-thread","--out",output],{cwd:root,env,windowsHide:true});
    assert.match(exported.stdout,/Wrote 1 sanitized events/);
    const bundleText=await readFile(output,"utf8"),bundle=JSON.parse(bundleText);
    assert.equal(bundle.events.length,1);assert.equal(bundle.events[0].id,"cli-keep");assert.equal(bundle.filters.threadId,"cli-thread");
    assert.doesNotMatch(bundleText,new RegExp(secret));assert.match(bundleText,/\[redacted\]/);

    const replayed=await exec(process.execPath,["scripts/replay-event-bundle.mjs",output],{cwd:root,env,windowsHide:true});
    const result=JSON.parse(replayed.stdout);
    assert.equal(result.eventCount,1);assert.equal(result.threadCount,1);assert.equal(result.categories.verification,1);
    assert.ok(result.threads["cli-thread"]);
  }finally{await rm(home,{recursive:true,force:true})}
});
