import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPABILITIES,
  detectSourceControlProvider,
  parsePublishTarget,
  parseRemoteUrl,
  repositoryHasCommits,
  resolveFjAccount,
  listPullRequests,
  pullRequestDetail,
  editPullRequest,
  editPullRequestComment,
  approvePullRequestWorkflows,
  revertPullRequest,
  mergePullRequest,
  rebasePullRequestStack,
  sourceControlGitAction,
  withSourceControlExecutor,
} from "../src/source-control-service.mjs";
import { git } from "../src/git-service.mjs";

test("source control provider detection covers supported forges",()=>{
  assert.equal(detectSourceControlProvider("https://github.com/acme/widget.git"),"github");
  assert.equal(detectSourceControlProvider("git@gitlab.com:acme/widget.git"),"gitlab");
  assert.equal(detectSourceControlProvider("https://bitbucket.org/acme/widget.git"),"bitbucket");
  assert.equal(detectSourceControlProvider("git@ssh.dev.azure.com:v3/acme/project/widget"),"azure-devops");
  assert.equal(detectSourceControlProvider("https://dev.azure.com/acme/project/_git/widget"),"azure-devops");
});

test("unknown self-hosted remotes remain explicit instead of being guessed",()=>{
  assert.equal(detectSourceControlProvider("git@code.example.test:acme/widget.git"),"unknown");
});

test("remote parser handles scp and URL remotes without losing nested paths",()=>{
  assert.deepEqual(parseRemoteUrl("git@gitlab.example.com:group/subgroup/widget.git"),{
    raw:"git@gitlab.example.com:group/subgroup/widget.git",
    host:"gitlab.example.com",
    path:"group/subgroup/widget",
    ssh:true,
  });
  const parsed=parseRemoteUrl("https://gitlab.example.com/group/subgroup/widget.git");
  assert.equal(parsed.host,"gitlab.example.com");
  assert.equal(parsed.path,"group/subgroup/widget");
  assert.equal(parsed.ssh,false);
});

test("provider capabilities reflect known host limitations",()=>{
  assert.equal(CAPABILITIES.github.updateBranch,true);
  assert.equal(CAPABILITIES.github.viewedFiles,"host");
  assert.equal(CAPABILITIES.github.edit,true);
  assert.equal(CAPABILITIES.github.approveWorkflows,true);
  assert.equal(CAPABILITIES.github.revert,true);
  assert.equal(CAPABILITIES.gitlab.viewedFiles,"environment");
  assert.equal(CAPABILITIES.bitbucket.publish,true);
  assert.equal(CAPABILITIES["azure-devops"].publish,true);
  assert.equal(CAPABILITIES.gitlab.requestChanges,false);
  assert.equal(CAPABILITIES.bitbucket.updateBranch,false);
  assert.equal(CAPABILITIES["azure-devops"].comment,false);
});

test("publish targets enforce provider-specific repository paths",()=>{
  assert.deepEqual(parsePublishTarget("github","acme/widget"),{provider:"github",name:"acme/widget",path:"acme/widget"});
  assert.deepEqual(parsePublishTarget("gitlab","group/subgroup/widget"),{provider:"gitlab",name:"widget",namespace:"group/subgroup",path:"group/subgroup/widget"});
  assert.deepEqual(parsePublishTarget("bitbucket","workspace/widget"),{provider:"bitbucket",workspace:"workspace",name:"widget",path:"workspace/widget"});
  assert.deepEqual(parsePublishTarget("azure-devops","Project One/widget"),{provider:"azure-devops",project:"Project One",name:"widget",path:"Project One/widget"});
  assert.throws(()=>parsePublishTarget("bitbucket","widget"),/workspace\/repository/i);
  assert.throws(()=>parsePublishTarget("azure-devops","widget"),/project\/repository/i);
});

test("repository commit detection distinguishes an unborn branch from the first commit",{timeout:20000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-publish-head-"));
  try{
    await git(root,["init"]);assert.equal(await repositoryHasCommits(root),false);
    await git(root,["config","user.email","trebell@example.test"]);await git(root,["config","user.name","Trebell Test"]);await writeFile(join(root,"README.md"),"hello\n");await git(root,["add","README.md"]);await git(root,["commit","-m","first"]);
    assert.equal(await repositoryHasCommits(root),true);
  }finally{await rm(root,{recursive:true,force:true})}
});


test("Forgejo fj account resolution matches direct hosts and SSH aliases",()=>{
  const keys={
    hosts:{
      "forge.example:3000":{type:"Application",token:"secret-token"},
    },
    aliases:{
      "forge-ssh":"forge.example:3000",
    },
  };
  assert.deepEqual(resolveFjAccount({
    remote:{host:"forge.example:3000",hostname:"forge.example"},
    remoteUrl:"https://forge.example:3000/acme/widget.git",
  },keys),{
    host:"forge.example:3000",
    token:"secret-token",
    baseUrl:"https://forge.example:3000",
  });
  assert.equal(resolveFjAccount({
    remote:{host:"forge-ssh",hostname:"forge-ssh"},
    remoteUrl:"git@forge-ssh:acme/widget.git",
  },keys)?.host,"forge.example:3000");
});

test("Forgejo fj account resolution preserves explicit HTTP remotes",()=>{
  const result=resolveFjAccount({
    remote:{host:"forge.local:3000",hostname:"forge.local"},
    remoteUrl:"http://forge.local:3000/acme/widget.git",
  },{hosts:{"forge.local:3000":{type:"Application",token:"x"}},aliases:{}});
  assert.equal(result?.baseUrl,"http://forge.local:3000");
});

test("source control commands stay inside the supplied environment executor",async()=>{
  const calls=[];
  const executor={
    run:async(command,args,options={})=>{
      calls.push({command,args:[...args],cwd:options.cwd});
      if(command==="git"&&args[0]==="rev-parse"&&args[1]==="--show-toplevel")return {ok:true,code:0,stdout:"/srv/app\n",stderr:""};
      if(command==="git"&&args[0]==="branch")return {ok:true,code:0,stdout:"main\n",stderr:""};
      if(command==="git"&&args[0]==="for-each-ref"&&args.includes("refs/heads"))return {ok:true,code:0,stdout:"main\n",stderr:""};
      if(command==="git"&&args[0]==="for-each-ref")return {ok:true,code:0,stdout:"origin/main\n",stderr:""};
      if(command==="git"&&args[0]==="status")return {ok:true,code:0,stdout:"## main...origin/main\n",stderr:""};
      if(command==="git"&&args[0]==="remote")return {ok:true,code:0,stdout:"origin\thttps://github.com/acme/widget.git (fetch)\norigin\thttps://github.com/acme/widget.git (push)\n",stderr:""};
      if(command==="git"&&args[0]==="worktree")return {ok:true,code:0,stdout:"worktree /srv/app\nHEAD abc\nbranch refs/heads/main\n",stderr:""};
      if(command==="gh"&&args[0]==="pr"&&args[1]==="list")return {ok:true,code:0,stdout:JSON.stringify([{number:7,title:"Remote PR",state:"OPEN",isDraft:false,url:"https://github.com/acme/widget/pull/7"}]),stderr:""};
      return {ok:false,code:1,stdout:"",stderr:"unexpected command"};
    },
  };
  const result=await withSourceControlExecutor(executor,()=>listPullRequests("/srv/app"));
  assert.equal(result.ok,true);
  assert.equal(result.provider,"github");
  assert.equal(result.items[0].number,7);
  assert.equal(calls.every(call=>!call.cwd||String(call.cwd).startsWith("/srv/app")),true);
  assert.equal(calls.some(call=>call.command==="gh"&&call.args[0]==="pr"),true);
});

test("remote auto-pull fetches, verifies default branch and fast-forwards inside the environment executor",async()=>{
  const calls=[];
  const executor={
    run:async(command,args,options={})=>{
      calls.push({command,args:[...args],cwd:options.cwd});
      if(command!=="git")return {ok:false,code:1,stdout:"",stderr:"unexpected command"};
      if(args[0]==="rev-parse"&&args[1]==="--show-toplevel")return {ok:true,code:0,stdout:"/srv/app\n",stderr:""};
      if(args[0]==="branch")return {ok:true,code:0,stdout:"main\n",stderr:""};
      if(args[0]==="for-each-ref"&&args.includes("refs/heads"))return {ok:true,code:0,stdout:"main\n",stderr:""};
      if(args[0]==="for-each-ref")return {ok:true,code:0,stdout:"origin/main\n",stderr:""};
      if(args[0]==="status")return {ok:true,code:0,stdout:"## main...origin/main [behind 2]\n",stderr:""};
      if(args[0]==="remote")return {ok:true,code:0,stdout:"origin\thttps://github.com/acme/widget.git (fetch)\norigin\thttps://github.com/acme/widget.git (push)\n",stderr:""};
      if(args[0]==="worktree")return {ok:true,code:0,stdout:"worktree /srv/app\nHEAD abc\nbranch refs/heads/main\n",stderr:""};
      if(args[0]==="fetch")return {ok:true,code:0,stdout:"",stderr:""};
      if(args[0]==="symbolic-ref")return {ok:true,code:0,stdout:"origin/main\n",stderr:""};
      if(args[0]==="rev-list")return {ok:true,code:0,stdout:"2\t0\n",stderr:""};
      if(args[0]==="pull")return {ok:true,code:0,stdout:"Updating abc..def\n",stderr:""};
      return {ok:false,code:1,stdout:"",stderr:"unexpected git "+args.join(" ")};
    },
  };
  const result=await withSourceControlExecutor(executor,()=>sourceControlGitAction("/srv/app",{action:"auto-pull"}));
  assert.equal(result.ok,true);assert.equal(result.changed,true);assert.equal(result.defaultBranch,"main");assert.equal(result.behind,2);
  assert.equal(calls.some(call=>call.args[0]==="fetch"&&call.args[1]==="origin"),true);
  assert.equal(calls.some(call=>call.args[0]==="rev-list"&&call.args.at(-1)==="origin/main...HEAD"),true);
  assert.equal(calls.some(call=>call.args[0]==="pull"&&call.args[1]==="--ff-only"),true);
  assert.equal(calls.every(call=>!call.cwd||String(call.cwd).startsWith("/srv/app")),true);
});

test("Bitbucket REST auth and requests come from the environment executor",async()=>{
  const requests=[];
  const executor={
    run:async(command,args)=>{
      if(command==="git"&&args[0]==="rev-parse"&&args[1]==="--show-toplevel")return {ok:true,code:0,stdout:"/srv/app\n",stderr:""};
      if(command==="git"&&args[0]==="branch")return {ok:true,code:0,stdout:"main\n",stderr:""};
      if(command==="git"&&args[0]==="for-each-ref"&&args.includes("refs/heads"))return {ok:true,code:0,stdout:"main\n",stderr:""};
      if(command==="git"&&args[0]==="for-each-ref")return {ok:true,code:0,stdout:"origin/main\n",stderr:""};
      if(command==="git"&&args[0]==="status")return {ok:true,code:0,stdout:"## main...origin/main\n",stderr:""};
      if(command==="git"&&args[0]==="remote")return {ok:true,code:0,stdout:"origin\thttps://bitbucket.org/acme/widget.git (fetch)\norigin\thttps://bitbucket.org/acme/widget.git (push)\n",stderr:""};
      if(command==="git"&&args[0]==="worktree")return {ok:true,code:0,stdout:"worktree /srv/app\nHEAD abc\nbranch refs/heads/main\n",stderr:""};
      return {ok:false,code:1,stdout:"",stderr:"unexpected command"};
    },
    env:async()=>({TREBELL_BITBUCKET_ACCESS_TOKEN:"remote-token"}),
    request:async(url,options)=>{
      requests.push({url:String(url),authorization:options.headers?.Authorization});
      return {ok:true,status:200,text:JSON.stringify({values:[{id:9,title:"Remote BB PR",state:"OPEN",links:{html:{href:"https://bitbucket.org/acme/widget/pull-requests/9"}},source:{branch:{name:"feature"}},destination:{branch:{name:"main"}},author:{display_name:"Dev"}}]})};
    },
  };
  const result=await withSourceControlExecutor(executor,()=>listPullRequests("/srv/app"));
  assert.equal(result.provider,"bitbucket");
  assert.equal(result.items[0].number,9);
  assert.equal(requests.length,1);
  assert.equal(requests[0].authorization,"Bearer remote-token");
  assert.match(requests[0].url,/api\.bitbucket\.org\/2\.0\/repositories\/acme\/widget\/pullrequests/);
});

test("GitHub PR editing, comment editing and waiting workflow approval use real CLI/API actions",async()=>{
  const calls=[];const stdinCalls=[];
  const gitResult=(args)=>{
    if(args[0]==="rev-parse"&&args[1]==="--show-toplevel")return {ok:true,code:0,stdout:"/srv/app\n",stderr:""};
    if(args[0]==="branch")return {ok:true,code:0,stdout:"main\n",stderr:""};
    if(args[0]==="for-each-ref"&&args.includes("refs/heads"))return {ok:true,code:0,stdout:"main\n",stderr:""};
    if(args[0]==="for-each-ref")return {ok:true,code:0,stdout:"origin/main\n",stderr:""};
    if(args[0]==="status")return {ok:true,code:0,stdout:"## main...origin/main\n",stderr:""};
    if(args[0]==="remote")return {ok:true,code:0,stdout:"origin\thttps://github.com/acme/widget.git (fetch)\norigin\thttps://github.com/acme/widget.git (push)\n",stderr:""};
    if(args[0]==="worktree")return {ok:true,code:0,stdout:"worktree /srv/app\nHEAD abc\nbranch refs/heads/main\n",stderr:""};
    return null;
  };
  const executor={
    run:async(command,args,options={})=>{
      calls.push({command,args:[...args],cwd:options.cwd});
      if(command==="git"){const result=gitResult(args);if(result)return result}
      if(command==="gh"&&args[0]==="pr"&&args[1]==="edit")return {ok:true,code:0,stdout:"",stderr:""};
      if(command==="gh"&&args[0]==="pr"&&args[1]==="view"){
        const fields=args[args.indexOf("--json")+1]||"";
        if(fields==="headRefOid")return {ok:true,code:0,stdout:JSON.stringify({headRefOid:"head123"}),stderr:""};
        return {ok:true,code:0,stdout:JSON.stringify({number:7,title:"Remote PR",body:"Body",state:"OPEN",url:"https://github.com/acme/widget/pull/7",headRefName:"feature",headRefOid:"head123",baseRefName:"main",comments:[{id:"55",body:"Mine",author:{login:"me"}}],reviews:[],files:[],commits:[]}),stderr:""};
      }
      if(command==="gh"&&args[0]==="api"&&args.includes("repos/acme/widget/actions/runs")){
        return {ok:true,code:0,stdout:JSON.stringify({workflow_runs:[
          {id:101,name:"CI",status:"action_required",conclusion:null,html_url:"https://github.com/acme/widget/actions/runs/101"},
          {id:102,name:"Done",status:"completed",conclusion:"success"},
        ]}),stderr:""};
      }
      if(command==="gh"&&args[0]==="api"&&args.includes("repos/acme/widget/pulls/7/files?per_page=100&page=1")){
        return {ok:true,code:0,stdout:JSON.stringify([{filename:"src/payments.js",previous_filename:null,status:"modified",patch:"@@ -1 +1 @@\n-old\n+new",additions:1,deletions:1,changes:2,sha:"blob123",blob_url:"https://github.com/acme/widget/blob/blob123/src/payments.js",raw_url:"https://github.com/acme/widget/raw/blob123/src/payments.js"}]),stderr:""};
      }
      if(command==="gh"&&args[0]==="api"&&args.includes("repos/acme/widget/pulls/7"))return {ok:true,code:0,stdout:JSON.stringify({number:7,state:"open",head:{ref:"feature",sha:"head123"},base:{ref:"main",sha:"base123"}}),stderr:""};
      if(command==="gh"&&args[0]==="api"&&args.includes("user"))return {ok:true,code:0,stdout:"me\n",stderr:""};
      if(command==="gh"&&args[0]==="api"&&args.includes("repos/acme/widget/actions/runs/101/approve"))return {ok:true,code:0,stdout:"",stderr:""};
      return {ok:false,code:1,stdout:"",stderr:"unexpected command "+command+" "+args.join(" ")};
    },
    runStdin:async(command,args,input,options={})=>{
      stdinCalls.push({command,args:[...args],input,cwd:options.cwd});
      return {ok:true,code:0,stdout:"{}",stderr:""};
    },
  };
  await withSourceControlExecutor(executor,()=>editPullRequest("/srv/app",7,{provider:"github",title:"Updated title",body:"Updated body"}));
  assert.equal(calls.some(call=>call.command==="gh"&&call.args.join(" ").includes("pr edit 7 --title Updated title --body Updated body")),true);

  await withSourceControlExecutor(executor,()=>editPullRequestComment("/srv/app",7,55,"Edited comment",{provider:"github"}));
  assert.equal(stdinCalls.length,1);
  assert.equal(stdinCalls[0].command,"gh");
  assert.equal(stdinCalls[0].args.includes("repos/acme/widget/issues/comments/55"),true);
  assert.deepEqual(JSON.parse(stdinCalls[0].input),{body:"Edited comment"});

  const detail=await withSourceControlExecutor(executor,()=>pullRequestDetail("/srv/app",7,{provider:"github"}));
  assert.deepEqual(detail.item.awaitingWorkflowApproval.map(run=>run.id),[101]);
  assert.equal(detail.item.comments[0].canEdit,true);
  assert.equal(detail.item.files[0].path,"src/payments.js");
  assert.match(detail.item.files[0].patch,/\+new/);
  const approval=await withSourceControlExecutor(executor,()=>approvePullRequestWorkflows("/srv/app",7,{provider:"github"}));
  assert.equal(approval.approved,1);
  assert.equal(calls.some(call=>call.args.includes("repos/acme/widget/actions/runs/101/approve")),true);
});

test("GitHub revert PR uses an isolated worktree and cleans it after opening the revert PR",async()=>{
  const calls=[];
  const executor={
    run:async(command,args,options={})=>{
      calls.push({command,args:[...args],cwd:options.cwd});
      if(command==="git"&&args[0]==="rev-parse"&&args[1]==="--show-toplevel")return {ok:true,code:0,stdout:"/srv/app\n",stderr:""};
      if(command==="git"&&args[0]==="branch"&&args[1]==="--show-current")return {ok:true,code:0,stdout:"main\n",stderr:""};
      if(command==="git"&&args[0]==="for-each-ref"&&args.includes("refs/heads"))return {ok:true,code:0,stdout:"main\n",stderr:""};
      if(command==="git"&&args[0]==="for-each-ref")return {ok:true,code:0,stdout:"origin/main\n",stderr:""};
      if(command==="git"&&args[0]==="status")return {ok:true,code:0,stdout:"## main...origin/main\n",stderr:""};
      if(command==="git"&&args[0]==="remote")return {ok:true,code:0,stdout:"origin\thttps://github.com/acme/widget.git (fetch)\norigin\thttps://github.com/acme/widget.git (push)\n",stderr:""};
      if(command==="git"&&args[0]==="worktree"&&args[1]==="list")return {ok:true,code:0,stdout:"worktree /srv/app\nHEAD abc\nbranch refs/heads/main\n",stderr:""};
      if(command==="gh"&&args[0]==="pr"&&args[1]==="view")return {ok:true,code:0,stdout:JSON.stringify({number:7,title:"Feature",state:"MERGED",mergedAt:"2026-09-20T10:00:00Z",mergeCommit:{oid:"merge123"},baseRefName:"main"}),stderr:""};
      if(command==="git"&&args[0]==="fetch")return {ok:true,code:0,stdout:"",stderr:""};
      if(command==="git"&&args[0]==="worktree"&&args[1]==="add")return {ok:true,code:0,stdout:"",stderr:""};
      if(command==="git"&&args[0]==="rev-list")return {ok:true,code:0,stdout:"merge123 parent1 parent2\n",stderr:""};
      if(command==="git"&&args[0]==="revert")return {ok:true,code:0,stdout:"reverted",stderr:""};
      if(command==="git"&&args[0]==="push")return {ok:true,code:0,stdout:"pushed",stderr:""};
      if(command==="gh"&&args[0]==="pr"&&args[1]==="create")return {ok:true,code:0,stdout:"https://github.com/acme/widget/pull/8\n",stderr:""};
      if(command==="git"&&args[0]==="worktree"&&args[1]==="remove")return {ok:true,code:0,stdout:"",stderr:""};
      if(command==="git"&&args[0]==="branch"&&args[1]==="-D")return {ok:true,code:0,stdout:"",stderr:""};
      return {ok:false,code:1,stdout:"",stderr:"unexpected "+command+" "+args.join(" ")};
    },
  };
  const result=await withSourceControlExecutor(executor,()=>revertPullRequest("/srv/app",7,{provider:"github"}));
  assert.equal(result.url,"https://github.com/acme/widget/pull/8");
  const added=calls.find(call=>call.command==="git"&&call.args[0]==="worktree"&&call.args[1]==="add");
  assert.ok(added);
  assert.equal(added.args.includes("origin/main"),true);
  const reverted=calls.find(call=>call.command==="git"&&call.args[0]==="revert");
  assert.deepEqual(reverted.args.slice(0,4),["revert","-m","1","--no-edit"]);
  assert.equal(reverted.args.at(-1),"merge123");
  assert.equal(calls.some(call=>call.command==="git"&&call.args[0]==="worktree"&&call.args[1]==="remove"),true);
  assert.equal(calls.some(call=>call.command==="git"&&call.args[0]==="branch"&&call.args[1]==="-D"),true);
});

test("GitHub native stack details use REST membership and stacked merges use merge-async",async()=>{
  const calls=[];const stdinCalls=[];
  const executor={
    run:async(command,args,options={})=>{
      calls.push({command,args:[...args],cwd:options.cwd});
      if(command==="git"&&args[0]==="rev-parse"&&args[1]==="--show-toplevel")return {ok:true,code:0,stdout:"/srv/app\n",stderr:""};
      if(command==="git"&&args[0]==="branch")return {ok:true,code:0,stdout:"layer-two\n",stderr:""};
      if(command==="git"&&args[0]==="for-each-ref"&&args.includes("refs/heads"))return {ok:true,code:0,stdout:"main\nlayer-one\nlayer-two\n",stderr:""};
      if(command==="git"&&args[0]==="for-each-ref")return {ok:true,code:0,stdout:"origin/layer-two\n",stderr:""};
      if(command==="git"&&args[0]==="status")return {ok:true,code:0,stdout:"## layer-two...origin/layer-two\n",stderr:""};
      if(command==="git"&&args[0]==="remote")return {ok:true,code:0,stdout:"origin\thttps://github.com/acme/widget.git (fetch)\norigin\thttps://github.com/acme/widget.git (push)\n",stderr:""};
      if(command==="git"&&args[0]==="worktree")return {ok:true,code:0,stdout:"worktree /srv/app\nHEAD old2\nbranch refs/heads/layer-two\n",stderr:""};
      if(command==="gh"&&args[0]==="pr"&&args[1]==="view")return {ok:true,code:0,stdout:JSON.stringify({number:2,title:"Layer two",body:"",state:"OPEN",url:"https://github.com/acme/widget/pull/2",headRefName:"layer-two",headRefOid:"old2",baseRefName:"layer-one",comments:[],reviews:[],files:[],commits:[]}),stderr:""};
      if(command==="gh"&&args[0]==="api"){
        const path=args.find(value=>String(value).startsWith("repos/acme/widget/"))||"";
        if(path==="repos/acme/widget/pulls/2")return {ok:true,code:0,stdout:JSON.stringify({number:2,state:"open",head:{ref:"layer-two",sha:"old2"},base:{ref:"layer-one",sha:"old1"},stack:{number:42,size:3,position:2,base:{ref:"main",sha:"base0"}}}),stderr:""};
        if(path==="repos/acme/widget/stacks/42")return {ok:true,code:0,stdout:JSON.stringify({id:900,number:42,open:true,base:{ref:"main"},pull_requests:[
          {number:1,title:"Layer one",state:"open",head:{ref:"layer-one",sha:"old1"},base:{ref:"main",sha:"base0"},html_url:"https://github.com/acme/widget/pull/1"},
          {number:2,title:"Layer two",state:"open",head:{ref:"layer-two",sha:"old2"},base:{ref:"layer-one",sha:"old1"},html_url:"https://github.com/acme/widget/pull/2"},
          {number:3,title:"Layer three",state:"open",head:{ref:"layer-three",sha:"old3"},base:{ref:"layer-two",sha:"old2"},html_url:"https://github.com/acme/widget/pull/3"},
        ]}),stderr:""};
        if(path==="repos/acme/widget/actions/runs")return {ok:true,code:0,stdout:JSON.stringify({workflow_runs:[]}),stderr:""};
      }
      return {ok:false,code:1,stdout:"",stderr:"unexpected "+command+" "+args.join(" ")};
    },
    runStdin:async(command,args,input,options={})=>{
      stdinCalls.push({command,args:[...args],input,cwd:options.cwd});
      if(command==="gh"&&args.includes("repos/acme/widget/pulls/2/merge-async"))return {ok:true,code:0,stdout:JSON.stringify({status:"pending",details:{uuid:"merge-uuid"}}),stderr:""};
      return {ok:false,code:1,stdout:"",stderr:"unexpected stdin"};
    },
  };
  const detail=await withSourceControlExecutor(executor,()=>pullRequestDetail("/srv/app",2,{provider:"github"}));
  assert.equal(detail.item.stack.number,42);assert.equal(detail.item.stack.position,2);assert.equal(detail.item.stack.layers.length,3);
  const merged=await withSourceControlExecutor(executor,()=>mergePullRequest("/srv/app",2,{provider:"github",method:"squash"}));
  assert.equal(merged.stack,true);assert.equal(merged.async,true);assert.equal(merged.request.details.uuid,"merge-uuid");
  assert.equal(stdinCalls.some(call=>call.args.includes("repos/acme/widget/pulls/2/merge-async")),true);
  assert.deepEqual(JSON.parse(stdinCalls.find(call=>call.args.includes("repos/acme/widget/pulls/2/merge-async")).input),{sha:"old2",merge_method:"squash",merge_action:"default"});
});

test("GitHub stack rebase cascades in a temporary worktree with force-with-lease",async()=>{
  const calls=[];let headReads=0;
  const stackResponse={id:900,number:42,open:true,base:{ref:"main"},pull_requests:[
    {number:1,title:"Layer one",state:"open",head:{ref:"layer-one",sha:"old1"},base:{ref:"main",sha:"base0"},html_url:"https://github.com/acme/widget/pull/1"},
    {number:2,title:"Layer two",state:"open",head:{ref:"layer-two",sha:"old2"},base:{ref:"layer-one",sha:"old1"},html_url:"https://github.com/acme/widget/pull/2"},
  ]};
  const executor={
    run:async(command,args,options={})=>{
      calls.push({command,args:[...args],cwd:options.cwd});
      if(command==="git"&&args[0]==="rev-parse"&&args[1]==="--show-toplevel")return {ok:true,code:0,stdout:"/srv/app\n",stderr:""};
      if(command==="git"&&args[0]==="branch")return {ok:true,code:0,stdout:"layer-two\n",stderr:""};
      if(command==="git"&&args[0]==="for-each-ref"&&args.includes("refs/heads"))return {ok:true,code:0,stdout:"main\nlayer-one\nlayer-two\n",stderr:""};
      if(command==="git"&&args[0]==="for-each-ref")return {ok:true,code:0,stdout:"origin/layer-two\n",stderr:""};
      if(command==="git"&&args[0]==="status")return {ok:true,code:0,stdout:"## layer-two...origin/layer-two\n",stderr:""};
      if(command==="git"&&args[0]==="remote")return {ok:true,code:0,stdout:"origin\thttps://github.com/acme/widget.git (fetch)\norigin\thttps://github.com/acme/widget.git (push)\n",stderr:""};
      if(command==="git"&&args[0]==="worktree"&&args[1]==="list")return {ok:true,code:0,stdout:"worktree /srv/app\nHEAD old2\nbranch refs/heads/layer-two\n",stderr:""};
      if(command==="gh"&&args[0]==="api"){
        const path=args.find(value=>String(value).startsWith("repos/acme/widget/"))||"";
        if(path==="repos/acme/widget/pulls/2")return {ok:true,code:0,stdout:JSON.stringify({number:2,state:"open",head:{ref:"layer-two",sha:"old2"},base:{ref:"layer-one",sha:"old1"},stack:{number:42,size:2,position:2,base:{ref:"main",sha:"base0"}}}),stderr:""};
        if(path==="repos/acme/widget/stacks/42")return {ok:true,code:0,stdout:JSON.stringify(stackResponse),stderr:""};
      }
      if(command==="git"&&args[0]==="fetch")return {ok:true,code:0,stdout:"",stderr:""};
      if(command==="git"&&args[0]==="rev-parse"&&args[1]==="refs/remotes/origin/main")return {ok:true,code:0,stdout:"base-new\n",stderr:""};
      if(command==="git"&&args[0]==="worktree"&&args[1]==="add")return {ok:true,code:0,stdout:"",stderr:""};
      if(command==="git"&&args[0]==="checkout")return {ok:true,code:0,stdout:"",stderr:""};
      if(command==="git"&&args[0]==="rebase"&&args[1]==="--onto")return {ok:true,code:0,stdout:"",stderr:""};
      if(command==="git"&&args[0]==="rev-parse"&&args[1]==="HEAD")return {ok:true,code:0,stdout:(++headReads===1?"new1":"new2")+"\n",stderr:""};
      if(command==="git"&&args[0]==="push")return {ok:true,code:0,stdout:"",stderr:""};
      if(command==="git"&&args[0]==="rebase"&&args[1]==="--abort")return {ok:true,code:0,stdout:"",stderr:""};
      if(command==="git"&&args[0]==="worktree"&&args[1]==="remove")return {ok:true,code:0,stdout:"",stderr:""};
      return {ok:false,code:1,stdout:"",stderr:"unexpected "+command+" "+args.join(" ")};
    },
  };
  const result=await withSourceControlExecutor(executor,()=>rebasePullRequestStack("/srv/app",2,{provider:"github"}));
  assert.deepEqual(result.updated.map(item=>item.newHead),["new1","new2"]);
  const checkouts=calls.filter(call=>call.command==="git"&&call.args[0]==="checkout");assert.equal(checkouts.length,2);
  assert.equal(checkouts.every(call=>call.cwd!=="/srv/app"&&String(call.cwd).includes(".trebell-stack-rebase-")),true);
  const rebases=calls.filter(call=>call.command==="git"&&call.args[0]==="rebase"&&call.args[1]==="--onto");
  assert.deepEqual(rebases[0].args,["rebase","--onto","base-new","base0"]);
  assert.deepEqual(rebases[1].args,["rebase","--onto","new1","old1"]);
  assert.equal(calls.some(call=>call.command==="git"&&call.args[0]==="merge-base"),false);
  const pushes=calls.filter(call=>call.command==="git"&&call.args[0]==="push");
  assert.equal(pushes[0].args.includes("--force-with-lease=refs/heads/layer-one:old1"),true);
  assert.equal(pushes[1].args.includes("--force-with-lease=refs/heads/layer-two:old2"),true);
  assert.equal(calls.some(call=>call.command==="git"&&call.args[0]==="worktree"&&call.args[1]==="remove"),true);
});
