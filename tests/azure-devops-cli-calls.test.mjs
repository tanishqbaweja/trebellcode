import test from "node:test";
import assert from "node:assert/strict";
import {
  createPullRequest,
  editPullRequest,
  mergePullRequest,
  requestPullRequestReviewer,
  reviewPullRequest,
  withSourceControlExecutor,
} from "../src/source-control-service.mjs";

// Every Azure CLI call Trebell makes for an Azure DevOps remote goes through one helper: the command's own words first, then the
// options every call shares (find the organisation and project from the Git remote, keep warnings out of the answer, answer in
// JSON). This pins the words of each pull request and repository command and that the shared options close every call.
const SHARED=["--detect","true","--only-show-errors","--output","json"];
const REMOTE="https://dev.azure.com/acme/project/_git/widget";

function azureFixture(answers={}){
  const calls=[];
  const executor={
    run:async(command,args)=>{
      if(command==="git"&&args[0]==="rev-parse"&&args[1]==="--show-toplevel")return {ok:true,code:0,stdout:"/srv/app\n",stderr:""};
      if(command==="git"&&args[0]==="rev-parse")return {ok:false,code:1,stdout:"",stderr:"no commits"};
      if(command==="git"&&args[0]==="branch")return {ok:true,code:0,stdout:"feature/cart\n",stderr:""};
      if(command==="git"&&args[0]==="for-each-ref")return {ok:true,code:0,stdout:"",stderr:""};
      if(command==="git"&&args[0]==="status")return {ok:true,code:0,stdout:"## feature/cart\n",stderr:""};
      if(command==="git"&&args[0]==="remote"&&args.length===1)return {ok:true,code:0,stdout:"",stderr:""};
      if(command==="git"&&args[0]==="remote"&&args[1]==="add")return {ok:true,code:0,stdout:"",stderr:""};
      if(command==="git"&&args[0]==="remote")return {ok:true,code:0,stdout:`origin\t${REMOTE} (fetch)\norigin\t${REMOTE} (push)\n`,stderr:""};
      if(command==="git"&&args[0]==="worktree")return {ok:true,code:0,stdout:"worktree /srv/app\nHEAD abc\nbranch refs/heads/feature/cart\n",stderr:""};
      if(command==="az"){
        calls.push([...args]);
        const key=args.slice(0,args[1]==="pr"?(args[2]==="reviewer"?4:3):2).join(" ");
        if(key in answers)return {ok:true,code:0,stdout:JSON.stringify(answers[key]),stderr:""};
        return {ok:false,code:1,stdout:"",stderr:"ERROR: az could not reach the organisation"};
      }
      return {ok:false,code:1,stdout:"",stderr:"unexpected command "+command+" "+args.join(" ")};
    },
    runStdin:async()=>({ok:false,code:1,stdout:"",stderr:"unexpected stdin command"}),
    withTempJsonFile:async(_content,callback)=>callback("/tmp/trebell-azure-request.json"),
  };
  return {executor,calls};
}
const withAzure=(fixture,work)=>withSourceControlExecutor(fixture.executor,work);
function assertCall(call,words){
  assert.deepEqual(call.slice(0,words.length),words);
  assert.deepEqual(call.slice(words.length),SHARED);
}

test("an Azure DevOps pull request is opened, changed, reviewed and completed with the command's words first and the shared options last",async()=>{
  const fixture=azureFixture({
    "repos pr create":{pullRequestId:41,repository:{webUrl:"https://dev.azure.com/acme/project/_git/widget"},url:"https://dev.azure.com/acme/_apis/git/pullRequests/41"},
    "repos pr update":{pullRequestId:41,status:"completed"},
    "repos pr reviewer add":[],
    "repos pr set-vote":{vote:10},
  });
  const opened=await withAzure(fixture,()=>createPullRequest("/srv/app",{title:"Add the cart",body:"Line one\nLine two",base:"main"}));
  assert.equal(opened.url,"https://dev.azure.com/acme/project/_git/widget/pullrequest/41","the pull request's own page");
  assertCall(fixture.calls.at(-1),["repos","pr","create","--title","Add the cart","--description","Line one\nLine two","--source-branch","feature/cart","--target-branch","main"]);

  await withAzure(fixture,()=>editPullRequest("/srv/app",41,{title:"Add the shopping cart"}));
  assertCall(fixture.calls.at(-1),["repos","pr","update","--id","41","--title","Add the shopping cart"]);

  await withAzure(fixture,()=>requestPullRequestReviewer("/srv/app",41,"ada@example.com"));
  assertCall(fixture.calls.at(-1),["repos","pr","reviewer","add","--id","41","--reviewers","ada@example.com"]);

  await withAzure(fixture,()=>reviewPullRequest("/srv/app",41,{event:"APPROVE"}));
  assertCall(fixture.calls.at(-1),["repos","pr","set-vote","--id","41","--vote","approve"]);

  const merged=await withAzure(fixture,()=>mergePullRequest("/srv/app",41,{method:"squash"}));
  assert.equal(merged.output,"completed");
  assertCall(fixture.calls.at(-1),["repos","pr","update","--id","41","--status","completed","--delete-source-branch","true","--squash","true"]);

  await withAzure(fixture,()=>mergePullRequest("/srv/app",41,{method:"merge",auto:true}));
  assertCall(fixture.calls.at(-1),["repos","pr","update","--id","41","--auto-complete","true","--delete-source-branch","true"]);
});

test("a refused Azure CLI call fails with what az said, or with Trebell's own sentence when az said nothing",async()=>{
  const fixture=azureFixture();
  await assert.rejects(()=>withAzure(fixture,()=>editPullRequest("/srv/app",7,{body:"New text"})),/az could not reach the organisation/);
  assertCall(fixture.calls.at(-1),["repos","pr","update","--id","7","--description","New text"]);
  const quiet=azureFixture();
  quiet.executor.run=(run=>async(command,args,options)=>command==="az"?(quiet.calls.push([...args]),{ok:false,code:1,stdout:"",stderr:""}):run(command,args,options))(quiet.executor.run);
  await assert.rejects(()=>withAzure(quiet,()=>requestPullRequestReviewer("/srv/app",7,"ada@example.com")),/Azure DevOps did not add ada@example\.com as a reviewer\./);
});
