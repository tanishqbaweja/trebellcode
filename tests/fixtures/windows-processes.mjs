import { execFile } from "node:child_process";
import { constants, setPriority } from "node:os";

// The processes running now on Windows, each as {pid, ppid, created (ms since 1970), name, commandLine}, from Win32_Process in a
// hidden PowerShell (wmic is gone). Its PowerShell runs at normal priority, as the unit runner starts the tests at idle: at idle it
// took up to a minute to answer on a loaded host.
export function windowsProcesses({timeoutMs=90_000}={}){
  return new Promise((resolve,reject)=>{
    const script="Get-CimInstance Win32_Process | ForEach-Object { [string]$_.ProcessId+' '+$_.ParentProcessId+' '+$(if($_.CreationDate){$_.CreationDate.ToFileTimeUtc()}else{0})+' '+$_.Name+' '+($_.CommandLine -replace '\\s+',' ') }";
    const lister=execFile("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{windowsHide:true,timeout:timeoutMs,maxBuffer:64*1024*1024},(error,stdout)=>{
      if(error)return reject(error);
      resolve(stdout.split(/\r?\n/).filter(Boolean).map(line=>{const [pid,ppid,created,name,...rest]=line.split(" ");return {pid:Number(pid),ppid:Number(ppid),created:Number(created)/1e4-11644473600000,name,commandLine:rest.join(" ")}}));
    });
    try{setPriority(lister.pid,constants.priority.PRIORITY_NORMAL)}catch{}
  });
}

// What pick finds in the process list, looked for every half second until it finds none or for at most timeoutMs (a loaded host
// can take seconds to end a process tree): the processes an ended terminal left running.
export async function processesLeft(pick,{timeoutMs=20_000}={}){
  for(const end=Date.now()+timeoutMs;;await new Promise(resolve=>setTimeout(resolve,500))){const found=pick(await windowsProcesses());if(!found.length||Date.now()>end)return found}
}
