export function terminalBenchTaskPackageRef(dataset,task){
  const datasetText=String(dataset||"").trim(),taskText=String(task||"").trim();
  const at=datasetText.lastIndexOf("@"),slash=datasetText.indexOf("/");
  if(at<=slash+1||slash<=0||at>=datasetText.length-1||!taskText)return null;
  const namespace=datasetText.slice(0,slash),ref=datasetText.slice(at+1);
  if(taskText.includes("@"))return null;
  const packageTask=taskText.includes("/")?taskText:namespace+"/"+taskText;
  if(!packageTask.startsWith(namespace+"/"))return null;
  return packageTask+"@"+ref;
}

export async function prewarmTerminalBenchTaskCache({harbor,dataset,task,env,runFn}){
  if(typeof runFn!=="function")throw new TypeError("prewarmTerminalBenchTaskCache requires runFn");
  const packageRef=terminalBenchTaskPackageRef(dataset,task);
  if(!packageRef)throw new Error(`Cannot derive a registry task package ref for parallel Harbor prewarm: dataset=${dataset} task=${task}`);
  await runFn(harbor,["task","download",packageRef,"--cache"],{env});
  return {packageRef,completed:true};
}
