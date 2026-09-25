import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { replayEventFixture } from "../src/event-replay.mjs";

const input=process.argv[2];if(!input)throw new Error("Usage: node scripts/replay-event-bundle.mjs <bundle.json>");
const result=replayEventFixture(JSON.parse(await readFile(resolve(input),"utf8")));
console.log(JSON.stringify(result,null,2));
