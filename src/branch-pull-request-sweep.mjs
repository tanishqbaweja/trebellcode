import { isDeepStrictEqual } from "node:util";

// The minute sweep that looks up the pull request of each project thread's branch (the sidebar's review badge). A sweep that learns
// nothing new writes nothing: the times of its checks stay in memory, and a thread's meta is written only when its review, or the
// reason it could not be read, changes. Writing the new times alone wrote each such thread's whole meta to sqlite every minute, for
// ever, with the app idle (21.6 KB a minute in the perf run of 2026-10-20).
// A thread whose repository or pull requests cannot be read (no remote, no provider CLI, no network) is asked again after 1, 2, 4
// and 8 minutes, then every 10, instead of starting git for it every minute. One whose place or branch changes is asked at the
// next sweep, as is every thread after a restart, which starts with no checks in memory.
export const BRANCH_REVIEW_INTERVAL_MS=60_000,BRANCH_REVIEW_MAX_RETRY_MS=10*60_000;

// detectedAt is when a sweep built the snapshot, new at every sweep; it is not part of the review.
const reviewFields=review=>{if(!review||typeof review!=="object")return review??null;const {detectedAt:_detectedAt,...rest}=review;return rest};
const sameReview=(left,right)=>isDeepStrictEqual(reviewFields(left),reviewFields(right));

export function createBranchPullRequestSweep({state,repositoryIdentity,listPullRequests,pullRequestForBranch,inEnvironment=(_environmentId,run)=>run(),now=()=>Date.now(),intervalMs=BRANCH_REVIEW_INTERVAL_MS,maxRetryMs=BRANCH_REVIEW_MAX_RETRY_MS}){
  const checks=new Map();
  const retryAfter=failures=>failures>0?Math.min(maxRetryMs,intervalMs*2**(failures-1)):intervalMs;
  const succeeded=({threadId,meta,place},detected,at)=>{
    checks.set(threadId,{at,failures:0,place});
    if(meta.lastBranchPullRequestSyncAt&&meta.branchPullRequestSyncError==null&&sameReview(meta.branchPullRequest,detected))return 0;
    state.updateThreadMeta(threadId,{branchPullRequest:detected,lastBranchPullRequestSyncAt:at,lastBranchPullRequestAttemptAt:at,branchPullRequestSyncError:null});
    return 1;
  };
  const failed=({threadId,meta,place},error,at)=>{
    const previous=checks.get(threadId);checks.set(threadId,{at,failures:(previous?.place===place?previous.failures:0)+1,place});
    const message=error?.message||String(error);if(meta.branchPullRequestSyncError===message)return 0;
    state.updateThreadMeta(threadId,{branchPullRequestSyncError:message,lastBranchPullRequestAttemptAt:at});
    return 1;
  };
  return async function syncBranchPullRequests({force=false}={}){
    const at=now(),candidates=[],listed=new Set();
    for(const [threadId,meta] of Object.entries(state.listThreadMeta())){
      if(!meta?.cwd||!meta?.branch||meta.deletedAt||meta.archived||meta.sectionName==="Settled")continue;
      listed.add(threadId);
      const place=[meta.environmentId||"local",meta.cwd,meta.branch].join("|"),check=checks.get(threadId);
      if(!force){
        if(check?.place===place){if(at-check.at<retryAfter(check.failures))continue}
        else if(at-Number(meta.lastBranchPullRequestSyncAt||0)<intervalMs)continue;
      }
      candidates.push({threadId,meta,place,environmentId:meta.environmentId||null,cwd:String(meta.cwd)});
    }
    for(const threadId of checks.keys())if(!listed.has(threadId))checks.delete(threadId);
    if(!candidates.length)return {checked:0,repositories:0,written:0};
    const locations=new Map();
    for(const candidate of candidates){
      const key=(candidate.environmentId||"local")+"|"+candidate.cwd;
      if(!locations.has(key))locations.set(key,{environmentId:candidate.environmentId,cwd:candidate.cwd,threads:[]});
      locations.get(key).threads.push(candidate);
    }
    const repositories=new Map();let written=0;
    for(const location of locations.values()){
      try{
        const repo=await inEnvironment(location.environmentId,()=>repositoryIdentity(location.cwd));
        const key=[location.environmentId||"local",repo.provider,repo.host,String(repo.repository||"").toLowerCase()].join("|");
        if(!repositories.has(key))repositories.set(key,{environmentId:location.environmentId,cwd:location.cwd,provider:repo.provider,repo,threads:[]});
        repositories.get(key).threads.push(...location.threads);
      }catch(error){
        for(const candidate of location.threads)written+=failed(candidate,error,at);
      }
    }
    for(const group of repositories.values()){
      try{
        const result=await inEnvironment(group.environmentId,()=>listPullRequests(group.cwd,{provider:group.provider}));
        if(!result?.ok)throw new Error(result?.error||"Could not list pull requests");
        for(const candidate of group.threads)written+=succeeded(candidate,pullRequestForBranch(candidate.meta.branch,result.items||[]),at);
      }catch(error){
        for(const candidate of group.threads)written+=failed(candidate,error,at);
      }
    }
    return {checked:candidates.length,repositories:repositories.size,written};
  };
}
