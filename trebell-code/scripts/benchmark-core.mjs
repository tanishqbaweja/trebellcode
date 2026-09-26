import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCoreBenchmark } from "../src/performance-benchmark.mjs";

function arg(name,fallback){
  const prefix="--"+name+"=",value=process.argv.slice(2).find(item=>item.startsWith(prefix));return value?Number(value.slice(prefix.length)):fallback;
}

const home=await mkdtemp(join(tmpdir(),"trebell-benchmark-"));
try{
  const result=await runCoreBenchmark({
    env:{...process.env,TREBELL_HOME:home},
    threads:arg("threads",1000),eventsPerThread:arg("events-per-thread",20),
    eventCount:arg("store-events",10000),queryCount:arg("queries",200),
    stateRecords:arg("state-records",500),
    repoFiles:arg("repo-files",1000),
    longChatMessages:arg("long-chat-messages",10000),
    streamDeltas:arg("stream-deltas",50000),
  });
  console.log(JSON.stringify(result,null,2));
}finally{await rm(home,{recursive:true,force:true})}
