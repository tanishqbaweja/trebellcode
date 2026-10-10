import { execFile } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync=promisify(execFile);
const SECRET_NAME=/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

// Audit-only artifacts for Native benchmark trials: what each tool call asked for and returned, and the
// workspace diff the grader receives. Nothing here feeds back into the model; it only makes a lost task
// explainable afterwards, the way a Codex rollout already is. Secret-looking environment values are redacted.
export function secretRedactor(environment=process.env){
  const values=[...new Set(Object.entries(environment||{})
    .filter(([name,value])=>SECRET_NAME.test(name)&&String(value??"").length>=8)
    .map(([,value])=>String(value)))].sort((a,b)=>b.length-a.length);
  return text=>values.reduce((out,value)=>out.split(value).join("[redacted]"),String(text));
}

export function capText(value,limit){
  let text;
  try{text=typeof value==="string"?value:JSON.stringify(value??null)??String(value)}catch{text=String(value)}
  return text.length>limit?text.slice(0,limit)+`...[${text.length-limit} more chars]`:text;
}

export function createToolCallLogger({path,environment=process.env,now=()=>Date.now()}={}){
  const redact=secretRedactor(environment);
  let writes=Promise.resolve();
  const record=row=>{writes=writes.then(()=>appendFile(path,redact(JSON.stringify(row))+"\n","utf8")).catch(()=>{})};
  return {
    wrap:executor=>async call=>{
      const startedAt=now();
      let output,failure=null;
      try{
        output=await executor(call);
        return output;
      }catch(caught){
        failure=caught;
        throw caught;
      }finally{
        record({
          toolCall:call?.toolCall??null,
          modelTurn:call?.modelTurn??null,
          namespace:call?.namespace??null,
          name:call?.name??null,
          durationMs:now()-startedAt,
          arguments:capText(call?.arguments??call?.rawArguments??null,16_000),
          ...(failure?{error:capText(String(failure?.message??failure),4_000)}:{output:capText(output,8_000)}),
        });
      }
    },
    flush:()=>writes,
  };
}

// Read-only: `git diff HEAD` plus the contents of untracked, non-ignored files. GIT_OPTIONAL_LOCKS=0 keeps git
// from refreshing the index, so the workspace the verifier grades is left exactly as the agent left it.
export async function captureFinalDiff({root,path,environment=process.env,maxUntrackedFiles=40,maxUntrackedChars=64_000}={}){
  const redact=secretRedactor(environment);
  const git=args=>execFileAsync("git",args,{cwd:root,maxBuffer:32*1024*1024,timeout:30_000,windowsHide:true,env:{...environment,GIT_OPTIONAL_LOCKS:"0",GIT_PAGER:"cat"}});
  try{
    // allSettled so neither git process is still running in the workspace when this returns.
    const settled=await Promise.allSettled([
      git(["-c","core.quotepath=off","diff","--no-color","--no-ext-diff","HEAD"]),
      git(["ls-files","--others","--exclude-standard","-z"]),
    ]);
    const failed=settled.find(item=>item.status==="rejected");
    if(failed)throw failed.reason;
    const [{stdout:diff},{stdout:untracked}]=settled.map(item=>item.value);
    const files=untracked.split("\0").filter(Boolean),parts=[diff];
    for(const file of files.slice(0,maxUntrackedFiles)){
      try{
        const content=await readFile(join(root,file));
        parts.push(`\n=== untracked: ${file}\n${content.includes(0)?`[binary, ${content.length} bytes]`:capText(content.toString("utf8"),maxUntrackedChars)}\n`);
      }catch{}
    }
    if(files.length>maxUntrackedFiles)parts.push(`\n=== ${files.length-maxUntrackedFiles} more untracked files not shown\n`);
    await writeFile(path,redact(parts.join("")),"utf8");
    return {captured:true,trackedDiffChars:diff.length,untrackedFiles:files.length};
  }catch(failure){
    await writeFile(path,`[final diff unavailable: ${capText(String(failure?.message??failure),500)}]\n`,"utf8").catch(()=>{});
    return {captured:false,trackedDiffChars:0,untrackedFiles:0};
  }
}
