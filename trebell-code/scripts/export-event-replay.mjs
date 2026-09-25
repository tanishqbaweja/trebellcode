import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { EventJournal } from "../src/event-journal.mjs";

function arg(name){const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]||null:null}
const output=resolve(arg("--out")||"trebell-event-replay.json");
const journal=new EventJournal(process.env);
try{
  const bundle=journal.replayBundle({
    threadId:arg("--thread"),turnId:arg("--turn"),runtime:arg("--runtime"),category:arg("--category"),
    limit:Number(arg("--limit")||1000),
  });
  await writeFile(output,JSON.stringify(bundle,null,2),"utf8");
  console.log(`Wrote ${bundle.events.length} sanitized events to ${output}`);
}finally{await journal.close()}
