export async function sweepAutoPullProjects({state,pullProject,log=()=>{}}={}){
  if(!state||typeof state.projects!=="function"||typeof state.projectSettings!=="function")throw new Error("Auto-pull state is required");
  if(typeof pullProject!=="function")throw new Error("Auto-pull project runner is required");
  const summary={eligible:0,updated:0,skipped:0,failed:0,results:[]};
  for(const project of state.projects()){
    const enabled=Boolean(state.projectSettings(project.path,project.environmentId||null).effective.autoPull);
    if(!enabled)continue;
    summary.eligible++;
    try{
      const result=await pullProject(project);
      summary.results.push({projectId:project.id||null,path:project.path,environmentId:project.environmentId||null,...result});
      if(result?.ok&&result?.changed){summary.updated++;log("Updated "+project.path+" from "+(result.defaultBranch||"default branch"))}
      else{summary.skipped++;if(result?.reason&&["fetch_failed","compare_failed"].includes(result.reason))log("Skipped "+project.path+": "+result.reason+(result.error?": "+result.error:""))}
    }catch(error){
      summary.failed++;summary.results.push({projectId:project.id||null,path:project.path,environmentId:project.environmentId||null,ok:false,reason:"error",error:error.message||String(error)});
      log("Auto-pull failed for "+project.path+": "+(error.message||String(error)));
    }
  }
  return summary;
}
