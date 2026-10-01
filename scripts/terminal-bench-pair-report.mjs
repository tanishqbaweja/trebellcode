export const SEALED_LIVE_DETAIL="[sealed until comparison completes]";

function sealFreeformDetail(value){
  return value==null?value:SEALED_LIVE_DETAIL;
}

export function jobsForPairReport(jobs,{complete=false}={}){
  const list=Array.isArray(jobs)?jobs:[];
  if(complete)return list;
  return list.map(job=>{
    if(!job||typeof job!=="object")return job;
    return {
      ...job,
      runError:sealFreeformDetail(job.runError),
      runnerError:sealFreeformDetail(job.runnerError),
      drainError:sealFreeformDetail(job.drainError),
      exceptionMessage:sealFreeformDetail(job.exceptionMessage),
    };
  });
}
