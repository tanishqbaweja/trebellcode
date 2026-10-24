import { execFile } from "node:child_process";
import { constants, setPriority } from "node:os";

// A process's creation time as Windows keeps it (a FILETIME: 100 ns steps since 1601), in ms since 1970.
const FILETIME_1970=116444736000000000n;
export const fileTimeMs=created=>Number((BigInt(created)-FILETIME_1970)/10000n);

// The processes running now on Windows, each as {pid, ppid, created}, from one listing (Win32_Process through PowerShell, hidden,
// at normal priority, as the terminal worker can run at idle under a test runner; about 0.4 s on an idle host). created is the
// creation FILETIME as a BigInt, exact, so two rows with the same pid and created are the same process: Windows reuses a pid only
// once its process has gone, and the process that then gets it was created later.
export function listWindowsProcesses({timeoutMs=3000}={}){
  return new Promise((resolve,reject)=>{
    const powershell=process.env.SystemRoot?`${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`:"powershell.exe";
    const script="Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { ''+$_.ProcessId+' '+$_.ParentProcessId+' '+$(if($_.CreationDate){$_.CreationDate.ToFileTimeUtc()}else{0}) }";
    let lister;
    try{
      lister=execFile(powershell,["-NoLogo","-NoProfile","-NonInteractive","-Command",script],{windowsHide:true,timeout:timeoutMs,maxBuffer:16*1024*1024},(error,stdout)=>{
        if(error)return reject(error);
        const rows=[];
        for(const line of String(stdout).split(/\r?\n/)){const [pid,ppid,created]=line.trim().split(" ");if(Number(pid)>0&&/^\d+$/.test(ppid||"")&&/^\d+$/.test(created||""))rows.push({pid:Number(pid),ppid:Number(ppid),created:BigInt(created)})}
        rows.length?resolve(rows):reject(new Error("The process listing was empty"));
      });
    }catch(error){reject(error);return}
    try{setPriority(lister.pid,constants.priority.PRIORITY_NORMAL)}catch{}
  });
}

function byParent(rows){const children=new Map();for(const row of rows){const list=children.get(row.ppid);if(list)list.push(row);else children.set(row.ppid,[row])}return children}

// The process tree of a shell in one listing: the shell (pid, created between from and to, ms since 1970: around the terminal's
// start, so a later process that got the pid of a shell that has gone is not taken for it), then each process whose parent is in
// the tree and that was created after that parent (an older process names a parent whose pid was later reused). Empty when the
// shell is not running.
export function processTree(rows,{pid,from=-Infinity,to=Infinity}){
  const root=rows.find(row=>row.pid===pid&&fileTimeMs(row.created)>=from&&fileTimeMs(row.created)<=to);
  if(!root)return [];
  const children=byParent(rows),tree=[root],seen=new Set([root]);
  for(let index=0;index<tree.length;index++)for(const child of children.get(tree[index].pid)||[])if(!seen.has(child)&&child.created>=tree[index].created){seen.add(child);tree.push(child)}
  return tree;
}

// What of a tree listed before runs in a later listing: each process of the tree that still runs (the same pid and creation time:
// a later process that got the pid of one that has gone is not it), and each process started since by one of the tree's, or by one
// of those: its parent's pid, created after that parent and, when a later process now holds the parent's pid, before that one (it
// can only have been started by the parent while that ran).
export function treeLeft(tree,rows){
  const now=new Map(rows.map(row=>[row.pid,row])),children=byParent(rows),members=[...tree],left=[],seen=new Set(tree.map(row=>row.pid+":"+row.created));
  for(const row of tree)if(now.get(row.pid)?.created===row.created)left.push(row);
  for(let index=0;index<members.length;index++){
    const parent=members[index],holder=now.get(parent.pid),reused=holder&&holder.created!==parent.created?holder.created:null;
    for(const child of children.get(parent.pid)||[]){
      const key=child.pid+":"+child.created;
      if(seen.has(key)||child.created<parent.created||(reused!==null&&child.created>=reused))continue;
      seen.add(key);members.push(child);left.push(child);
    }
  }
  return left;
}
