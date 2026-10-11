// Machine load and per-process footprint on the host, sampled without windows: os.cpus() deltas for the overall CPU load, and one
// hidden PowerShell CIM query for every process's CPU time, memory and I/O counters (Windows), or ps elsewhere.
import { execFile } from "node:child_process";
import { cpus } from "node:os";

function cpuTotals(){let idle=0,total=0;for(const cpu of cpus()){const t=cpu.times;idle+=t.idle;total+=t.user+t.nice+t.sys+t.idle+t.irq}return {idle,total}}

// A rolling meter of the whole machine's CPU busy share (0-100), sampled every intervalMs. loadBetween(t0,t1) averages the samples
// that overlap a window, so each timing sample can carry the load it ran under.
export function startLoadMeter({intervalMs=500}={}){
  const samples=[];let last={at:Date.now(),...cpuTotals()};
  const timer=setInterval(()=>{
    const now={at:Date.now(),...cpuTotals()},total=now.total-last.total,idle=now.idle-last.idle;
    if(total>0)samples.push({from:last.at,to:now.at,busy:100*(1-idle/total)});
    if(samples.length>20000)samples.splice(0,samples.length-20000);last=now;
  },intervalMs);timer.unref?.();
  return {
    loadBetween(from,to=Date.now()){
      const hits=samples.filter(sample=>sample.to>=from-intervalMs&&sample.from<=to);
      if(!hits.length)return null;return Number((hits.reduce((sum,sample)=>sum+sample.busy,0)/hits.length).toFixed(1));
    },
    stop(){clearInterval(timer)},
  };
}

function run(file,args,{timeoutMs=60_000,maxBuffer=64*1024*1024}={}){
  return new Promise((resolve,reject)=>execFile(file,args,{windowsHide:true,timeout:timeoutMs,maxBuffer,encoding:"utf8"},(error,stdout,stderr)=>error?reject(Object.assign(error,{stderr})):resolve(stdout)));
}
export function powershell(script,options){return run("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-Command",script],options)}

// Every process on the machine: pid, parent, name, CPU seconds (user+kernel), working set and private bytes, and I/O transfer counters.
export async function processTable(){
  if(process.platform!=="win32"){
    const out=await run("ps",["-A","-o","pid=,ppid=,rss=,time=,comm="]);
    return out.trim().split(/\n/).map(line=>{const [pid,ppid,rss,time,...name]=line.trim().split(/\s+/);const parts=time.split(/[:-]/).map(Number);const seconds=parts.reduce((sum,value)=>sum*60+value,0);return {pid:Number(pid),ppid:Number(ppid),name:name.join(" "),cpuSeconds:seconds,workingSet:Number(rss)*1024,privateBytes:null,readBytes:null,writeBytes:null,writeOps:null,commandLine:""}});
  }
  const script="$ErrorActionPreference='SilentlyContinue';Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{p=$_.ProcessId;pp=$_.ParentProcessId;n=$_.Name;u=[string]$_.UserModeTime;k=[string]$_.KernelModeTime;ws=[string]$_.WorkingSetSize;pv=[string]$_.PrivatePageCount;rb=[string]$_.ReadTransferCount;wb=[string]$_.WriteTransferCount;wo=[string]$_.WriteOperationCount;c=$(if($_.CommandLine){$_.CommandLine.Substring(0,[Math]::Min(400,$_.CommandLine.Length))}else{''})} } | ConvertTo-Json -Compress";
  const rows=JSON.parse(await powershell(script));
  return (Array.isArray(rows)?rows:[rows]).map(row=>({pid:Number(row.p),ppid:Number(row.pp),name:String(row.n||""),cpuSeconds:(Number(row.u)+Number(row.k))/1e7,workingSet:Number(row.ws)||0,privateBytes:Number(row.pv)||0,readBytes:Number(row.rb)||0,writeBytes:Number(row.wb)||0,writeOps:Number(row.wo)||0,commandLine:String(row.c||"")}));
}

// The processes under the given roots (the roots included), each with its depth and root.
export function descendants(table,rootPids){
  const children=new Map();for(const row of table){if(!children.has(row.ppid))children.set(row.ppid,[]);children.get(row.ppid).push(row)}
  const byPid=new Map(table.map(row=>[row.pid,row])),out=[],seen=new Set();
  for(const root of rootPids){
    const start=byPid.get(Number(root));if(!start)continue;
    const stack=[{row:start,depth:0}];
    while(stack.length){const {row,depth}=stack.pop();if(seen.has(row.pid))continue;seen.add(row.pid);out.push({...row,depth,root:Number(root)});for(const child of children.get(row.pid)||[])if(child.pid!==row.pid)stack.push({row:child,depth:depth+1})}
  }
  return out;
}

// Chromium's role for a chrome.exe/electron.exe process from its command line; other processes by executable name.
export function processRole(row){
  const line=row.commandLine||"",type=/--type=([a-z-]+)/i.exec(line)?.[1]||"";
  if(type==="gpu-process")return "gpu";
  if(type==="renderer")return "renderer";
  if(type==="utility"){const sub=/--utility-sub-type=([\w.]+)/.exec(line)?.[1]||"";return "utility:"+sub.replace(/^.*\./,"")}
  if(type==="crashpad-handler")return "crashpad";
  if(type)return type;
  if(/^(chrome|electron|headless_shell)\.exe$/i.test(row.name)||/^(chrome|electron|headless_shell)$/i.test(row.name))return "browser";
  return row.name.replace(/\.exe$/i,"");
}

// CPU and memory of a process set between two tables: CPU seconds used per process (matched by pid), the share of one core over the
// window, working set and private bytes at the end, and bytes written (Windows I/O counters: file, pipe and socket writes).
export function footprintDelta(before,after,pids,{seconds}){
  const prior=new Map(before.map(row=>[row.pid,row]));
  return after.filter(row=>pids.has(row.pid)).map(row=>{
    const start=prior.get(row.pid),cpu=start?Math.max(0,row.cpuSeconds-start.cpuSeconds):row.cpuSeconds;
    return {pid:row.pid,ppid:row.ppid,name:row.name,role:processRole(row),cpuSeconds:Number(cpu.toFixed(3)),corePercent:Number((100*cpu/Math.max(0.001,seconds)).toFixed(2)),workingSetMB:Number((row.workingSet/1048576).toFixed(1)),privateMB:Number((row.privateBytes/1048576).toFixed(1)),ioWriteKB:start?Number(((row.writeBytes-start.writeBytes)/1024).toFixed(1)):null,ioWriteOps:start?row.writeOps-start.writeOps:null,newDuringWindow:!start,commandLine:row.commandLine.slice(0,200)};
  });
}
export function groupByRole(rows){
  const out={};for(const row of rows){const key=row.role;out[key]||={count:0,cpuSeconds:0,corePercent:0,workingSetMB:0,privateMB:0};const group=out[key];group.count++;group.cpuSeconds+=row.cpuSeconds;group.corePercent+=row.corePercent;group.workingSetMB+=row.workingSetMB;group.privateMB+=row.privateMB}
  for(const group of Object.values(out))for(const key of ["cpuSeconds","corePercent","workingSetMB","privateMB"])group[key]=Number(group[key].toFixed(2));
  return out;
}

// GPU engine utilization per process over a few one-second samples (Windows GPU performance counters), summed over engines and
// averaged over samples: {pid: percent}.
export async function gpuUtilization(pids,{samples=5}={}){
  if(process.platform!=="win32"||!pids.length)return {};
  const filter=pids.map(pid=>"pid_"+pid+"_").join("|");
  const script="$ErrorActionPreference='SilentlyContinue';$s=Get-Counter -Counter '\\GPU Engine(*)\\Utilization Percentage' -SampleInterval 1 -MaxSamples "+samples+";$out=@{};foreach($set in $s){foreach($c in $set.CounterSamples){if($c.InstanceName -match '("+filter+")'){$id=[regex]::Match($c.InstanceName,'pid_(\\d+)_').Groups[1].Value;if(-not $out.ContainsKey($id)){$out[$id]=0.0};$out[$id]+=$c.CookedValue}}};$out | ConvertTo-Json -Compress";
  try{const raw=(await powershell(script,{timeoutMs:(samples+30)*1000})).trim();if(!raw)return {};const parsed=JSON.parse(raw);return Object.fromEntries(Object.entries(parsed).map(([pid,value])=>[pid,Number((Number(value)/samples).toFixed(2))]))}catch(error){return {error:String(error.message||error).slice(0,200)}}
}
