import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPABILITIES,
  detectSourceControlProvider,
  parsePublishTarget,
  parseRemoteUrl,
  publishRepository,
  repositoryHasCommits,
  resolveFjAccount,
  listPullRequests,
  pullRequestDetail,
  editPullRequest,
  editPullRequestComment,
  commentOnPullRequest,
  requestPullRequestReviewer,
  approvePullRequestWorkflows,
  revertPullRequest,
  mergePullRequest,
  rebasePullRequestStack,
  sourceControlGitAction,
  sourceControlPullRequestTemplate,
  sourceControlRecentCommitSubjects,
  sourceControlReviewRangeContext,
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
  assert.equal(CAPABILITIES.gitlab.reviewers,true);
  assert.equal(CAPABILITIES.forgejo.reviewers,true);
  assert.equal(CAPABILITIES.forgejo.publish,true);
  assert.equal(CAPABILITIES["azure-devops"].reviewers,true);
  assert.equal(CAPABILITIES.bitbucket.reviewers,true);
  assert.equal(CAPABILITIES.bitbucket.updateBranch,false);
  assert.equal(CAPABILITIES["azure-devops"].comment,true);
  assert.equal(CAPABILITIES["azure-devops"].editComments,true);
});

function sourceFixtureExecutor(remoteUrl,{extraRun=null,extraStdin=null,onTempJson=null}={}){
  const executor={
    run:async(command,args,options={})=>{
      if(command==="git"&&args[0]==="rev-parse"&&args[1]==="--show-toplevel")return {ok:true,code:0,stdout:"/srv/app\n",stderr:""};
      if(command==="git"&&args[0]==="branch")return {ok:true,code:0,stdout:"main\n",stderr:""};
      if(command==="git"&&args[0]==="for-each-ref"&&args.includes("refs/heads"))return {ok:true,code:0,stdout:"main\n",stderr:""};
      if(command==="git"&&args[0]==="for-each-ref")return {ok:true,code:0,stdout:"origin/main\n",stderr:""};
      if(command==="git"&&args[0]==="status")return {ok:true,code:0,stdout:"## main...origin/main\n",stderr:""};
      if(command==="git"&&args[0]==="remote")return {ok:true,code:0,stdout:"origin\t"+remoteUrl+" (fetch)\norigin\t"+remoteUrl+" (push)\n",stderr:""};
      if(command==="git"&&args[0]==="worktree")return {ok:true,code:0,stdout:"worktree /srv/app\nHEAD abc\nbranch refs/heads/main\n",stderr:""};
      return extraRun?extraRun(command,args,options):{ok:false,code:1,stdout:"",stderr:"unexpected command "+command+" "+args.join(" ")};
    },
    runStdin:async(command,args,input,options={})=>extraStdin?extraStdin(command,args,input,options):{ok:false,code:1,stdout:"",stderr:"unexpected stdin command"},
  };
  executor.withTempJsonFile=async(content,callback)=>{
    onTempJson?.(content);
    return callback("/tmp/trebell-azure-request.json");
  };
  return executor;
}

test("GitLab reviewer requests preserve existing reviewers and add the resolved username",async()=>{
  const calls=[];
  const executor=sourceFixtureExecutor("https://gitlab.com/acme/widget.git",{
    extraRun:async(command,args)=>{
      calls.push({command,args:[...args]});
      if(command==="glab"&&args[0]==="api"&&String(args[1]).startsWith("users?username="))return {ok:true,code:0,stdout:JSON.stringify([{id:22,username:"alice"}]),stderr:""};
      if(command==="glab"&&args[0]==="api"&&String(args[1]).includes("/merge_requests/7"))return {ok:true,code:0,stdout:JSON.stringify({reviewers:[{id:11,username:"bob"}]}),stderr:""};
      return {ok:false,code:1,stdout:"",stderr:"unexpected command"};
    },
    extraStdin:async(command,args,input)=>{
      calls.push({command,args:[...args],input});
      return {ok:true,code:0,stdout:JSON.stringify({reviewers:[{id:11},{id:22}]}),stderr:""};
    },
  });
  const result=await withSourceControlExecutor(executor,()=>requestPullRequestReviewer("/srv/app",7,"alice"));
  assert.equal(result.ok,true);assert.equal(result.provider,"gitlab");
  const update=calls.find(call=>call.input);assert.ok(update);
  assert.deepEqual(JSON.parse(update.input).reviewer_ids,[11,22]);
});

test("Azure DevOps reviewer requests use the supported reviewer add command",async()=>{
  const calls=[];
  const executor=sourceFixtureExecutor("https://dev.azure.com/acme/project/_git/widget",{
    extraRun:async(command,args)=>{
      calls.push({command,args:[...args]});
      if(command==="az"&&args.slice(0,4).join(" ")==="repos pr reviewer add")return {ok:true,code:0,stdout:"[]",stderr:""};
      return {ok:false,code:1,stdout:"",stderr:"unexpected command"};
    },
  });
  const result=await withSourceControlExecutor(executor,()=>requestPullRequestReviewer("/srv/app",9,"alice@example.com"));
  assert.equal(result.ok,true);assert.equal(result.provider,"azure-devops");
  const call=calls.find(item=>item.command==="az");assert.ok(call);
  assert.deepEqual(call.args.slice(0,4),["repos","pr","reviewer","add"]);
  assert.ok(call.args.includes("alice@example.com"));
});

test("Azure DevOps pull request detail loads editable user comments through thread APIs",async()=>{
  const calls=[];
  const raw={pullRequestId:9,title:"Azure PR",description:"Body",status:"active",sourceRefName:"refs/heads/feature",targetRefName:"refs/heads/main",repository:{id:"repo-guid",project:{id:"project-guid"},webUrl:"https://dev.azure.com/acme/project/_git/widget"},createdBy:{uniqueName:"author@example.com"}};
  const executor=sourceFixtureExecutor("https://dev.azure.com/acme/project/_git/widget",{
    extraRun:async(command,args)=>{
      calls.push({command,args:[...args]});
      if(command==="az"&&args.slice(0,3).join(" ")==="repos pr show")return {ok:true,code:0,stdout:JSON.stringify(raw),stderr:""};
      if(command==="az"&&args.includes("pullRequestThreads"))return {ok:true,code:0,stdout:JSON.stringify({value:[{id:12,comments:[
        {id:3,content:"Keep this comment",commentType:1,isDeleted:false,author:{uniqueName:"me@example.com",displayName:"Me"}},
        {id:4,content:"System note",commentType:3,isDeleted:false,author:{displayName:"Azure DevOps"}},
      ]}]}),stderr:""};
      if(command==="az"&&args.includes("profiles"))return {ok:true,code:0,stdout:JSON.stringify({id:"me-guid",emailAddress:"me@example.com",displayName:"Me"}),stderr:""};
      return {ok:false,code:1,stdout:"",stderr:"unexpected az command"};
    },
  });
  const result=await withSourceControlExecutor(executor,()=>pullRequestDetail("/srv/app",9));
  assert.equal(result.ok,true);assert.equal(result.provider,"azure-devops");
  assert.equal(result.capabilities.comment,true);assert.equal(result.capabilities.editComments,true);
  assert.deepEqual(result.item.comments,[{id:"12:3",threadId:12,nativeId:3,body:"Keep this comment",author:{login:"me@example.com",name:"Me"},canEdit:true}]);
  const threadCall=calls.find(call=>call.args.includes("pullRequestThreads"));assert.ok(threadCall);
  assert.ok(threadCall.args.includes("project=project-guid"));
  assert.ok(threadCall.args.includes("repositoryId=repo-guid"));
  assert.ok(threadCall.args.includes("pullRequestId=9"));
});

test("Azure DevOps comments create threads and edit the exact thread comment",async()=>{
  const calls=[],payloads=[];
  const raw={pullRequestId:9,repository:{id:"repo-guid",project:{id:"project-guid"}}};
  const executor=sourceFixtureExecutor("https://dev.azure.com/acme/project/_git/widget",{
    onTempJson:content=>payloads.push(JSON.parse(content)),
    extraRun:async(command,args)=>{
      calls.push({command,args:[...args]});
      if(command==="az"&&args.slice(0,3).join(" ")==="repos pr show")return {ok:true,code:0,stdout:JSON.stringify(raw),stderr:""};
      if(command==="az"&&args.includes("pullRequestThreads")&&args.includes("POST"))return {ok:true,code:0,stdout:JSON.stringify({id:21}),stderr:""};
      if(command==="az"&&args.includes("pullRequestThreadComments")&&args.includes("PATCH"))return {ok:true,code:0,stdout:JSON.stringify({id:5,content:"Edited"}),stderr:""};
      return {ok:false,code:1,stdout:"",stderr:"unexpected az command"};
    },
  });
  const created=await withSourceControlExecutor(executor,()=>commentOnPullRequest("/srv/app",9,"New comment"));
  const edited=await withSourceControlExecutor(executor,()=>editPullRequestComment("/srv/app",9,"21:5","Edited"));
  assert.equal(created.ok,true);assert.equal(edited.ok,true);
  assert.deepEqual(payloads[0],{comments:[{parentCommentId:0,content:"New comment",commentType:1}],status:1});
  assert.deepEqual(payloads[1],{content:"Edited"});
  const editCall=calls.find(call=>call.args.includes("pullRequestThreadComments"));assert.ok(editCall);
  assert.ok(editCall.args.includes("threadId=21"));assert.ok(editCall.args.includes("commentId=5"));
});

test("Forgejo reviewer requests use the documented requested_reviewers endpoint",async()=>{
  const requests=[];
  const executor=sourceFixtureExecutor("https://forge.example/acme/widget.git",{
    extraRun:async(command,args)=>{
      if(command==="fj"&&args[0]==="version")return {ok:true,code:0,stdout:"fj 0.test",stderr:""};
      return {ok:false,code:1,stdout:"",stderr:"unexpected command"};
    },
  });
  executor.readFjKeys=async()=>({hosts:{"forge.example":{type:"Application",token:"fixture-token"}},aliases:{}});
  executor.request=async(url,options)=>{requests.push({url:String(url),options});return {ok:true,status:200,text:"{}"}};
  const result=await withSourceControlExecutor(executor,()=>requestPullRequestReviewer("/srv/app",4,"alice",{provider:"forgejo"}));
  assert.equal(result.ok,true);assert.equal(result.provider,"forgejo");
  assert.equal(requests.length,1);
  assert.match(requests[0].url,/\/api\/v1\/repos\/acme\/widget\/pulls\/4\/requested_reviewers$/);
  assert.equal(requests[0].options.method,"POST");
  assert.deepEqual(JSON.parse(requests[0].options.body),{reviewers:["alice"],team_reviewers:[]});
});

test("Bitbucket reviewer requests resolve a user UUID and preserve existing reviewers",async()=>{
  const requests=[];
  const executor=sourceFixtureExecutor("https://bitbucket.org/acme/widget.git");
  executor.env=async()=>({TREBELL_BITBUCKET_ACCESS_TOKEN:"fixture-token"});
  executor.request=async(url,options={})=>{
    const target=String(url);requests.push({url:target,options});
    if(target.endsWith("/users/alice"))return {ok:true,status:200,text:JSON.stringify({uuid:"{alice-uuid}",nickname:"alice"})};
    if(target.endsWith("/repositories/acme/widget/pullrequests/5")&&(!options.method||options.method==="GET"))return {ok:true,status:200,text:JSON.stringify({reviewers:[{uuid:"{bob-uuid}"}]})};
    if(target.endsWith("/repositories/acme/widget/pullrequests/5")&&options.method==="PUT")return {ok:true,status:200,text:JSON.stringify({reviewers:[{uuid:"{bob-uuid}"},{uuid:"{alice-uuid}"}]})};
    return {ok:false,status:404,text:"not found"};
  };
  const result=await withSourceControlExecutor(executor,()=>requestPullRequestReviewer("/srv/app",5,"alice"));
  assert.equal(result.ok,true);assert.equal(result.provider,"bitbucket");
  const update=requests.find(item=>item.options.method==="PUT");assert.ok(update);
  assert.deepEqual(JSON.parse(update.options.body),{reviewers:[{uuid:"{bob-uuid}"},{uuid:"{alice-uuid}"}]});
});

test("publish targets enforce provider-specific repository paths",()=>{
  assert.deepEqual(parsePublishTarget("github","acme/widget"),{provider:"github",name:"acme/widget",path:"acme/widget"});
  assert.deepEqual(parsePublishTarget("gitlab","group/subgroup/widget"),{provider:"gitlab",name:"widget",namespace:"group/subgroup",path:"group/subgroup/widget"});
  assert.deepEqual(parsePublishTarget("forgejo","acme/widget"),{provider:"forgejo",name:"widget",owner:"acme",path:"acme/widget"});
  assert.deepEqual(parsePublishTarget("forgejo","widget"),{provider:"forgejo",name:"widget",owner:null,path:"widget"});
  assert.deepEqual(parsePublishTarget("bitbucket","workspace/widget"),{provider:"bitbucket",workspace:"workspace",name:"widget",path:"workspace/widget"});
  assert.deepEqual(parsePublishTarget("azure-devops","Project One/widget"),{provider:"azure-devops",project:"Project One",name:"widget",path:"Project One/widget"});
  assert.throws(()=>parsePublishTarget("bitbucket","widget"),/workspace\/repository/i);
  assert.throws(()=>parsePublishTarget("azure-devops","widget"),/project\/repository/i);
  assert.throws(()=>parsePublishTarget("forgejo","too/many/parts"),/owner\/repository/i);
});

test("Forgejo publishing reuses the configured account and pushes to the created organization repository",async()=>{
  const requests=[];let origin="";
  const executor={
    run:async(command,args)=>{
      if(command==="git"&&args[0]==="rev-parse"&&args[1]==="--show-toplevel")return {ok:true,code:0,stdout:"/srv/app\n",stderr:""};
      if(command==="git"&&args[0]==="branch")return {ok:true,code:0,stdout:"main\n",stderr:""};
      if(command==="git"&&args[0]==="for-each-ref"&&String(args.at(-1)).startsWith("refs/heads/main"))return {ok:true,code:0,stdout:origin?"origin/main\n":"",stderr:""};
      if(command==="git"&&args[0]==="for-each-ref")return {ok:true,code:0,stdout:"main\n",stderr:""};
      if(command==="git"&&args[0]==="status")return {ok:true,code:0,stdout:origin?"## main...origin/main\n":"## main\n",stderr:""};
      if(command==="git"&&args[0]==="remote"&&args[1]==="-v")return {ok:true,code:0,stdout:origin?"origin\t"+origin+" (fetch)\norigin\t"+origin+" (push)\n":"",stderr:""};
      if(command==="git"&&args[0]==="worktree")return {ok:true,code:0,stdout:"worktree /srv/app\nHEAD abc\nbranch refs/heads/main\n",stderr:""};
      if(command==="git"&&args[0]==="rev-parse"&&args[1]==="--verify")return {ok:true,code:0,stdout:"abc\n",stderr:""};
      if(command==="git"&&args[0]==="remote"&&args[1]==="add"){origin=args[3];return {ok:true,code:0,stdout:"",stderr:""}}
      if(command==="git"&&args[0]==="push")return {ok:true,code:0,stdout:"pushed",stderr:""};
      if(command==="tea"&&args.slice(0,2).join(" ")==="login list")return {ok:false,code:1,stdout:"",stderr:"tea unavailable"};
      if(command==="fj"&&args[0]==="version")return {ok:true,code:0,stdout:"fj test",stderr:""};
      return {ok:false,code:1,stdout:"",stderr:"unexpected command "+command+" "+args.join(" ")};
    },
    readFjKeys:async()=>({hosts:{"forge.example":{type:"Application",token:"fixture-token"}},aliases:{}}),
    request:async(url,options={})=>{
      const target=String(url);requests.push({url:target,options});
      if(target.endsWith("/api/v1/user"))return {ok:true,status:200,text:JSON.stringify({login:"trebell"})};
      if(target.endsWith("/api/v1/orgs/acme/repos"))return {ok:true,status:201,text:JSON.stringify({name:"widget",clone_url:"https://forge.example/acme/widget.git",html_url:"https://forge.example/acme/widget"})};
      return {ok:false,status:404,text:"not found"};
    },
  };
  const result=await withSourceControlExecutor(executor,()=>publishRepository("/srv/app",{provider:"forgejo",name:"acme/widget",visibility:"private"}));
  assert.equal(result.ok,true);assert.equal(result.provider,"forgejo");assert.equal(result.pushed,true);
  assert.equal(result.url,"https://forge.example/acme/widget");
  assert.equal(origin,"https://forge.example/acme/widget.git");
  const create=requests.find(item=>item.url.endsWith("/orgs/acme/repos"));assert.ok(create);
  assert.equal(create.options.method,"POST");
  assert.deepEqual(JSON.parse(create.options.body),{name:"widget",private:true,auto_init:false});
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

test("recent commit subjects are read through the selected environment executor",async()=>{
  const calls=[];
  const executor={run:async(command,args,options={})=>{
    calls.push({command,args:[...args],cwd:options.cwd});
    if(command!=="git")return {ok:false,code:1,stdout:"",stderr:"unexpected command"};
    if(args[0]==="rev-parse"&&args[1]==="--show-toplevel")return {ok:true,code:0,stdout:"/srv/app\n",stderr:""};
    if(args[0]==="branch")return {ok:true,code:0,stdout:"main\n",stderr:""};
    if(args[0]==="for-each-ref"&&args.includes("refs/heads"))return {ok:true,code:0,stdout:"main\n",stderr:""};
    if(args[0]==="for-each-ref")return {ok:true,code:0,stdout:"origin/main\n",stderr:""};
    if(args[0]==="status")return {ok:true,code:0,stdout:"## main...origin/main\n",stderr:""};
    if(args[0]==="remote")return {ok:true,code:0,stdout:"origin\thttps://github.com/acme/widget.git (fetch)\norigin\thttps://github.com/acme/widget.git (push)\n",stderr:""};
    if(args[0]==="worktree")return {ok:true,code:0,stdout:"worktree /srv/app\nHEAD abc\nbranch refs/heads/main\n",stderr:""};
    if(args[0]==="log")return {ok:true,code:0,stdout:"Use conventional subject\nFix checkout race\n",stderr:""};
    return {ok:false,code:1,stdout:"",stderr:"unexpected git "+args.join(" ")};
  }};
  const subjects=await withSourceControlExecutor(executor,()=>sourceControlRecentCommitSubjects("/srv/app",{limit:5}));
  assert.deepEqual(subjects,["Use conventional subject","Fix checkout race"]);
  assert.equal(calls.some(call=>call.args[0]==="log"&&call.cwd==="/srv/app"),true);
});

test("GitHub pull request templates are read from committed blobs through the selected environment executor",async()=>{
  const calls=[];
  const template="## What changed\n\n## Verification";
  const executor={run:async(command,args,options={})=>{
    calls.push({command,args:[...args],cwd:options.cwd});
    if(command!=="git")return {ok:false,code:1,stdout:"",stderr:"unexpected command"};
    if(args[0]==="rev-parse"&&args[1]==="--show-toplevel")return {ok:true,code:0,stdout:"/srv/app\n",stderr:""};
    if(args[0]==="branch")return {ok:true,code:0,stdout:"main\n",stderr:""};
    if(args[0]==="for-each-ref"&&args.includes("refs/heads"))return {ok:true,code:0,stdout:"main\n",stderr:""};
    if(args[0]==="for-each-ref")return {ok:true,code:0,stdout:"origin/main\n",stderr:""};
    if(args[0]==="status")return {ok:true,code:0,stdout:"## main...origin/main\n",stderr:""};
    if(args[0]==="remote")return {ok:true,code:0,stdout:"origin\thttps://github.com/acme/widget.git (fetch)\norigin\thttps://github.com/acme/widget.git (push)\n",stderr:""};
    if(args[0]==="worktree")return {ok:true,code:0,stdout:"worktree /srv/app\nHEAD abc\nbranch refs/heads/main\n",stderr:""};
    if(args[0]==="ls-tree")return {ok:true,code:0,stdout:"100644 blob 0123456789012345678901234567890123456789\t.github/pull_request_template.md\0",stderr:""};
    if(args[0]==="cat-file")return {ok:true,code:0,stdout:template+"\n",stderr:""};
    return {ok:false,code:1,stdout:"",stderr:"unexpected git "+args.join(" ")};
  }};
  const result=await withSourceControlExecutor(executor,()=>sourceControlPullRequestTemplate("/srv/app"));
  assert.equal(result,template);
  assert.equal(calls.some(call=>call.args[0]==="ls-tree"&&call.args.includes("HEAD")),true);
  assert.equal(calls.some(call=>call.args[0]==="cat-file"&&call.cwd==="/srv/app"),true);
});

test("pull request template detection ignores non-GitHub repositories",async()=>{
  const calls=[];
  const executor={run:async(command,args,options={})=>{
    calls.push({command,args:[...args],cwd:options.cwd});
    if(command!=="git")return {ok:false,code:1,stdout:"",stderr:"unexpected command"};
    if(args[0]==="rev-parse"&&args[1]==="--show-toplevel")return {ok:true,code:0,stdout:"/srv/app\n",stderr:""};
    if(args[0]==="branch")return {ok:true,code:0,stdout:"main\n",stderr:""};
    if(args[0]==="for-each-ref"&&args.includes("refs/heads"))return {ok:true,code:0,stdout:"main\n",stderr:""};
    if(args[0]==="for-each-ref")return {ok:true,code:0,stdout:"origin/main\n",stderr:""};
    if(args[0]==="status")return {ok:true,code:0,stdout:"## main...origin/main\n",stderr:""};
    if(args[0]==="remote")return {ok:true,code:0,stdout:"origin\thttps://gitlab.com/acme/widget.git (fetch)\norigin\thttps://gitlab.com/acme/widget.git (push)\n",stderr:""};
    if(args[0]==="worktree")return {ok:true,code:0,stdout:"worktree /srv/app\nHEAD abc\nbranch refs/heads/main\n",stderr:""};
    return {ok:false,code:1,stdout:"",stderr:"unexpected git "+args.join(" ")};
  }};
  assert.equal(await withSourceControlExecutor(executor,()=>sourceControlPullRequestTemplate("/srv/app")),null);
  assert.equal(calls.some(call=>call.args[0]==="ls-tree"),false);
});

test("pull request writing context uses commit range and merge-base diff range against remote base",async()=>{
  const calls=[];
  const executor={run:async(command,args,options={})=>{
    calls.push({command,args:[...args],cwd:options.cwd});
    if(command!=="git")return {ok:false,code:1,stdout:"",stderr:"unexpected command"};
    if(args[0]==="rev-parse"&&args[1]==="--show-toplevel")return {ok:true,code:0,stdout:"/srv/app\n",stderr:""};
    if(args[0]==="branch")return {ok:true,code:0,stdout:"feature\nmain\n",stderr:""};
    if(args[0]==="for-each-ref"&&args.includes("refs/heads"))return {ok:true,code:0,stdout:"feature\nmain\n",stderr:""};
    if(args[0]==="for-each-ref")return {ok:true,code:0,stdout:"origin/feature\norigin/main\n",stderr:""};
    if(args[0]==="status")return {ok:true,code:0,stdout:"## feature...origin/feature\n",stderr:""};
    if(args[0]==="remote")return {ok:true,code:0,stdout:"origin\thttps://github.com/acme/widget.git (fetch)\norigin\thttps://github.com/acme/widget.git (push)\n",stderr:""};
    if(args[0]==="worktree")return {ok:true,code:0,stdout:"worktree /srv/app\nHEAD abc\nbranch refs/heads/feature\n",stderr:""};
    if(args[0]==="symbolic-ref")return {ok:true,code:0,stdout:"origin/main\n",stderr:""};
    if(args[0]==="rev-parse"&&args[1]==="--verify")return {ok:true,code:0,stdout:"deadbeef\n",stderr:""};
    if(args[0]==="log"&&args.includes("origin/main..HEAD"))return {ok:true,code:0,stdout:"abc Feature commit\n",stderr:""};
    if(args[0]==="diff"&&args.includes("--stat"))return {ok:true,code:0,stdout:" feature.txt | 1 +\n",stderr:""};
    if(args[0]==="diff"&&args.includes("--patch"))return {ok:true,code:0,stdout:"diff --git a/feature.txt b/feature.txt\n",stderr:""};
    return {ok:false,code:1,stdout:"",stderr:"unexpected git "+args.join(" ")};
  }};
  const result=await withSourceControlExecutor(executor,()=>sourceControlReviewRangeContext("/srv/app"));
  assert.equal(result.baseBranch,"main");
  assert.equal(result.baseRef,"origin/main");
  assert.match(result.commitSummary,/Feature commit/);
  assert.equal(calls.some(call=>call.args[0]==="log"&&call.args.includes("origin/main..HEAD")),true);
  const diffCalls=calls.filter(call=>call.args[0]==="diff");
  assert.equal(diffCalls.length,2);
  assert.equal(diffCalls.every(call=>call.args.includes("origin/main...HEAD")),true);
});

test("pull request branch context excludes unrelated commits added later to the base branch",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-pr-range-"));
  const remote=join(root,"remote.git"),repo=join(root,"repo"),peer=join(root,"peer");
  try{
    await git(root,["init","--bare",remote]);
    await git(root,["clone",remote,repo]);
    await git(repo,["config","user.email","trebell@example.test"]);await git(repo,["config","user.name","Trebell Test"]);
    await git(repo,["checkout","-b","main"]);await writeFile(join(repo,"base.txt"),"base\n");await git(repo,["add","."]);await git(repo,["commit","-m","Base commit"]);await git(repo,["push","-u","origin","main"]);
    await git(repo,["checkout","-b","feature"]);await writeFile(join(repo,"feature.txt"),"feature\n");await git(repo,["add","."]);await git(repo,["commit","-m","Feature commit"]);
    await git(root,["clone",remote,peer]);await git(peer,["checkout","main"]);await git(peer,["config","user.email","trebell@example.test"]);await git(peer,["config","user.name","Trebell Test"]);
    await writeFile(join(peer,"later-main.txt"),"unrelated\n");await git(peer,["add","."]);await git(peer,["commit","-m","Later main commit"]);await git(peer,["push","origin","main"]);
    await git(repo,["fetch","origin"]);
    const context=await sourceControlReviewRangeContext(repo,{base:"main"});
    assert.match(context.commitSummary,/Feature commit/);
    assert.doesNotMatch(context.commitSummary,/Later main commit/);
    assert.match(context.diffSummary,/feature\.txt/);
    assert.doesNotMatch(context.diffSummary,/later-main\.txt/);
    assert.match(context.diff,/feature\.txt/);
    assert.doesNotMatch(context.diff,/later-main\.txt/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("source-control branch switching rejects a stale branch name without restoring a same-named dirty file",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-stale-branch-"));
  try{
    await git(root,["init"]);await git(root,["config","user.email","trebell@example.test"]);await git(root,["config","user.name","Trebell Test"]);
    await writeFile(join(root,"base.txt"),"base\n");await git(root,["add","."]);await git(root,["commit","-m","Base"]);
    const initial=(await git(root,["branch","--show-current"])).stdout.trim();
    await writeFile(join(root,"obsolete-branch"),"original\n");await git(root,["add","obsolete-branch"]);await git(root,["commit","-m","Tracked file"]);
    await git(root,["branch","obsolete-branch"]);await git(root,["branch","-D","obsolete-branch"]);
    await writeFile(join(root,"obsolete-branch"),"uncommitted work\n");
    await assert.rejects(()=>sourceControlGitAction(root,{action:"branch-switch",name:"obsolete-branch"}),/invalid reference|unknown revision|pathspec|branch/i);
    assert.equal(await readFile(join(root,"obsolete-branch"),"utf8"),"uncommitted work\n");
    assert.equal((await git(root,["branch","--show-current"])).stdout.trim(),initial);
  }finally{await rm(root,{recursive:true,force:true})}
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
