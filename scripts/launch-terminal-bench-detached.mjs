import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchDetachedDescriptor, writeDetachedDescriptor } from "./detached-process.mjs";

if(!process.argv.includes("--live"))throw new Error("Refusing to launch paid/live Terminal-Bench without --live.");
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,"..");
const forwarded=process.argv.slice(2),taskArg=forwarded.find(arg=>arg.startsWith("--task="));
const task=String(taskArg?.slice("--task=".length)||"").trim();
if(!task)throw new Error("Detached Terminal-Bench launch requires --task=<task-id>.");
const slug=String(task).replace(/^terminal-bench\//,"").replace(/[^a-z0-9]+/gi,"-").replace(/^-|-$/g,"").toLowerCase().slice(0,80)||"task";
const stamp=new Date().toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z");
const id=`tb4-detached-${slug}-${stamp}`,dir=join(root,".harbor-validation","detached");
await mkdir(dir,{recursive:true});
const descriptorPath=join(dir,`${id}.descriptor.json`),statusPath=join(dir,`${id}.status.json`),stdoutPath=join(dir,`${id}.stdout.log`),stderrPath=join(dir,`${id}.stderr.log`),launchPath=join(dir,`${id}.launch.json`);
await writeDetachedDescriptor(descriptorPath,{
  command:process.execPath,
  args:[join(root,"scripts","live-terminal-bench-harness-comparison.mjs"),...forwarded],
  cwd:root,stdoutPath,stderrPath,statusPath,
});
const launchedAt=new Date().toISOString(),launch=await launchDetachedDescriptor({descriptorPath,cwd:root});
const record={id,task,launchedAt,...launch,descriptorPath,statusPath,stdoutPath,stderrPath};
await writeFile(launchPath,JSON.stringify(record,null,2)+"\n","utf8");
console.log("TREBELL_TERMINAL_BENCH_DETACHED_LAUNCH "+JSON.stringify({...record,launchPath},null,2));
