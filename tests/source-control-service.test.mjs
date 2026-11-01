import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  CAPABILITIES,
  detectSourceControlProvider,
  parsePublishTarget,
  parseRemoteUrl,
  publishRepository,
  repositoryHasCommits,
  fjAccountFor,
  fjKeyStoreFiles,
  teaLoginFor,
  teaRepositoryFor,
  teaHttpStatus,
  createPullRequest,
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
  sourceControlDiagnostics,
  withSourceControlExecutor,
  checkoutPullRequest,
} from "../src/source-control-service.mjs";
import { git } from "../src/git-service.mjs";
import { createNativeSourceControlExecutor } from "../src/native-source-control.mjs";
import { withGermanColoredGit } from "./fixtures/git-catalog.mjs";

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
  // A merged pull request's title and description: GitHub, GitLab and Forgejo still edit them; Bitbucket and Azure DevOps refuse
  // to change one that is merged (completed).
  assert.deepEqual(Object.fromEntries(Object.entries(CAPABILITIES).map(([host,can])=>[host,can.editMerged])),{github:true,gitlab:true,forgejo:true,bitbucket:false,"azure-devops":false});
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

test("source-control diagnostics tolerate Git probe without an auth command",async()=>{
  const executor=sourceFixtureExecutor("https://github.com/acme/widget.git",{
    extraRun:async(command,args)=>{
      if(command==="git"&&args[0]==="--version")return {ok:true,code:0,stdout:"git version 2.51.0.windows.1\n",stderr:""};
      return {ok:false,code:1,stdout:"",stderr:"not installed"};
    },
  });
  executor.secretValues=async()=>({});
  const diagnostics=await withSourceControlExecutor(executor,()=>sourceControlDiagnostics("/srv/app"));
  assert.deepEqual(diagnostics.git,{installed:true,authenticated:true,version:"git version 2.51.0.windows.1",detail:""});
  assert.equal(diagnostics.selectedProvider,"github");
});

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
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});


test("Forgejo fj account resolution matches direct hosts and SSH aliases",()=>{
  const store={
    hosts:{"forge.example:3000":{type:"Application",token:"secret-token"}},
    aliases:{"forge-ssh":"forge.example:3000"},
  };
  assert.deepEqual(fjAccountFor(store,{
    remote:{host:"forge.example:3000",hostname:"forge.example"},
    remoteUrl:"https://forge.example:3000/acme/widget.git",
  }),{server:"forge.example:3000",token:"secret-token",url:"https://forge.example:3000"});
  assert.equal(fjAccountFor(store,{
    remote:{host:"forge-ssh",hostname:"forge-ssh"},
    remoteUrl:"git@forge-ssh:acme/widget.git",
  })?.server,"forge.example:3000");
});

test("Forgejo fj account resolution preserves explicit HTTP remotes",()=>{
  const account=fjAccountFor({hosts:{"forge.local:3000":{type:"Application",token:"x"}},aliases:{}},{
    remote:{host:"forge.local:3000",hostname:"forge.local"},
    remoteUrl:"http://forge.local:3000/acme/widget.git",
  });
  assert.equal(account?.url,"http://forge.local:3000");
});

test("an fj account falls back to the only server on the remote's host name, and needs a token",()=>{
  const oauth={type:"OAuth",token:" oauth-token ",refresh_token:"refresh",expires_at:"2026-01-01T00:00:00Z"};
  const ssh={remote:{host:"forge.example"},remoteUrl:"git@forge.example:acme/widget.git"};
  assert.deepEqual(fjAccountFor({hosts:{"forge.example:3000":oauth},aliases:{}},ssh),{server:"forge.example:3000",token:"oauth-token",url:"https://forge.example:3000"});
  // Two servers on that host name: Trebell does not guess between them.
  assert.equal(fjAccountFor({hosts:{"forge.example:3000":oauth,"forge.example:4000":{type:"Application",token:"t"}},aliases:{}},ssh),null);
  // A blank token, an empty store, or an alias to a server the store does not hold is no account.
  const https={remote:{host:"forge.example",hostname:"forge.example"},remoteUrl:"https://forge.example/acme/widget.git"};
  assert.equal(fjAccountFor({hosts:{"forge.example":{type:"Application",token:"  "}}},https),null);
  assert.equal(fjAccountFor({hosts:{}},ssh),null);
  assert.equal(fjAccountFor(null,ssh),null);
  assert.equal(fjAccountFor({hosts:{"forge.example":{token:"t"}},aliases:{"forge-ssh":"elsewhere.example"}},{remote:{host:"forge-ssh"},remoteUrl:"git@forge-ssh:a/b.git"}),null);
  // Servers compare without regard to case.
  assert.equal(fjAccountFor({hosts:{"Forge.Example":{token:"t"}}},https)?.server,"Forge.Example");
});

test("fj's key store is looked for where fj keeps it on each system, the newer place first",()=>{
  assert.deepEqual(fjKeyStoreFiles({platform:"win32",env:{APPDATA:"D:\\Profiles\\ada\\Roaming"},home:"C:\\Users\\ada",join:win32.join}),[
    "D:\\Profiles\\ada\\Roaming\\forgejo-cli\\forgejo-cli\\data\\keys.json",
    "D:\\Profiles\\ada\\Roaming\\Cyborus\\forgejo-cli\\data\\keys.json",
  ]);
  assert.equal(fjKeyStoreFiles({platform:"win32",env:{},home:"C:\\Users\\ada",join:win32.join})[0],"C:\\Users\\ada\\AppData\\Roaming\\forgejo-cli\\forgejo-cli\\data\\keys.json");
  assert.deepEqual(fjKeyStoreFiles({platform:"darwin",env:{},home:"/Users/ada",join:posix.join}),[
    "/Users/ada/Library/Application Support/forgejo-cli.forgejo-cli/keys.json",
    "/Users/ada/Library/Application Support/Cyborus.forgejo-cli/keys.json",
  ]);
  assert.deepEqual(fjKeyStoreFiles({platform:"linux",env:{XDG_DATA_HOME:"/data/ada"},home:"/home/ada",join:posix.join}),["/data/ada/forgejo-cli/keys.json"]);
  // The XDG rules ignore a data home that is not an absolute path.
  for(const XDG_DATA_HOME of ["data/ada","",undefined]){
    assert.deepEqual(fjKeyStoreFiles({platform:"freebsd",env:{XDG_DATA_HOME},home:"/home/ada",join:posix.join}),["/home/ada/.local/share/forgejo-cli/keys.json"]);
  }
});

test("fj's key store is the first of its files that holds one",async()=>{
  const places=fjKeyStoreFiles(),requests=[],read=[];
  const executor=sourceFixtureExecutor("https://forge.example/acme/widget.git",{
    extraRun:async(command,args)=>command==="fj"&&args[0]==="version"?{ok:true,code:0,stdout:"fj 0.test",stderr:""}:{ok:false,code:1,stdout:"",stderr:"unexpected command"},
  });
  // Every place but the last holds something that is not a store; the last holds the token.
  executor.readFile=async path=>{
    read.push(path);
    if(path===places.at(-1))return JSON.stringify({hosts:{"forge.example":{type:"Application",token:"stored-token"}}});
    if(path===places[0])return "{\"no\":\"hosts\"}";
    throw Object.assign(new Error("ENOENT"),{code:"ENOENT"});
  };
  executor.request=async(url,options)=>{requests.push({url:String(url),options});return {ok:true,status:201,text:""}};
  await withSourceControlExecutor(executor,()=>requestPullRequestReviewer("/srv/app",4,"alice",{provider:"forgejo"}));
  assert.deepEqual(read,places);
  assert.equal(requests.length,1);
  assert.equal(requests[0].options.headers.Authorization,"token stored-token");
});

test("a request with fj's token goes only to the server's API, follows no redirect and has a time limit",async()=>{
  const requests=[];
  const fixture=remote=>{
    const executor=sourceFixtureExecutor(remote,{
      extraRun:async(command,args)=>command==="fj"&&args[0]==="version"?{ok:true,code:0,stdout:"fj 0.test",stderr:""}:{ok:false,code:1,stdout:"",stderr:"unexpected command"},
    });
    executor.readFjKeys=async()=>({hosts:{"forge.example":{type:"Application",token:"fixture-token"}},aliases:{}});
    executor.request=async(url,options)=>{requests.push({url:String(url),options});return {ok:true,status:200,text:"[]"}};
    return executor;
  };
  await withSourceControlExecutor(fixture("git@forge.example:acme/widget.git"),()=>editPullRequest("/srv/app",7,{provider:"forgejo",title:"New title"}));
  assert.equal(requests.length,1);
  const [{url,options}]=requests;
  assert.equal(url,"https://forge.example/api/v1/repos/acme/widget/pulls/7");
  assert.equal(options.method,"PATCH");
  assert.deepEqual(options.headers,{Accept:"application/json",Authorization:"token fixture-token","Content-Type":"application/json"});
  assert.deepEqual(JSON.parse(options.body),{title:"New title"});
  assert.equal(options.redirect,"manual");
  assert.ok(options.signal instanceof AbortSignal);
  // A remote path that climbs out of /api/v1 is refused before anything is sent.
  await assert.rejects(withSourceControlExecutor(fixture("git@forge.example:../.."),()=>requestPullRequestReviewer("/srv/app",4,"alice",{provider:"forgejo"})),/only under https:\/\/forge\.example\/api\/v1\//);
  assert.equal(requests.length,1);
  // The server's refusal is shown with its status and what it said.
  const refusing=fixture("https://forge.example/acme/widget.git");
  refusing.request=async()=>({ok:false,status:403,text:"{\"message\":\"token does not have the scope\"}"});
  await assert.rejects(withSourceControlExecutor(refusing,()=>commentOnPullRequest("/srv/app",7,"Looks good",{provider:"forgejo"})),/HTTP 403: \{"message":"token does not have the scope"\}/);
});

test("tea's login for a remote is the one serving its host, else the default, else the first",()=>{
  const logins=[
    {name:"work",url:"https://git.work.example",ssh_host:"git.work.example",user:"ada",default:"false"},
    {name:"home",url:"https://forge.example:3000",ssh_host:"ssh.forge.example",user:"ada",default:"true"},
    {name:"lab",url:"https://lab.example/gitea",ssh_host:"lab.example",user:"ada",default:"false"},
  ];
  assert.equal(teaLoginFor(logins,{host:"forge.example:3000"})?.name,"home");
  assert.equal(teaLoginFor(logins,{host:"ssh.forge.example"})?.name,"home");
  assert.equal(teaLoginFor(logins,{host:"Git.Work.Example"})?.name,"work");
  assert.equal(teaLoginFor(logins,{host:"other.example"})?.name,"home");
  assert.equal(teaLoginFor(logins.map(login=>({...login,default:"false"})),{host:"other.example"})?.name,"work");
  assert.equal(teaLoginFor([],{host:"forge.example"}),null);
  assert.equal(teaLoginFor(null,{host:"forge.example"}),null);
});

test("tea is asked about owner/repository, without the server's own sub-path",()=>{
  assert.equal(teaRepositoryFor({url:"https://forge.example"},"acme/widget"),"acme/widget");
  assert.equal(teaRepositoryFor({url:"https://lab.example/gitea"},"gitea/acme/widget"),"acme/widget");
  assert.equal(teaRepositoryFor({url:"https://lab.example/gitea/"},"gitea/acme/widget"),"acme/widget");
  assert.equal(teaRepositoryFor({url:"https://forge.example"},"group/acme/widget"),"acme/widget");
  assert.equal(teaRepositoryFor({url:"https://lab.example/gitea"},"gitea"),"gitea");
  assert.equal(teaRepositoryFor({url:"https://forge.example"},""),"");
});

test("tea api's status is read from the lines --include writes to standard error",()=>{
  assert.equal(teaHttpStatus("HTTP/1.1 200 OK\nContent-Type: application/json\n\n"),200);
  assert.equal(teaHttpStatus("HTTP/2.0 404 Not Found\r\nContent-Length: 2\r\n\r\n"),404);
  assert.equal(teaHttpStatus("warning: config file is old\nHTTP/1.1 201 Created\n"),201);
  for(const stderr of ["","Error: login not found",undefined,"HTTP/1.1 OK"])assert.equal(teaHttpStatus(stderr),0);
});

// A repository whose fj is missing, so every call goes through tea with the given logins; tea api answers through answer().
function teaFixture(remoteUrl,logins,answer){
  const calls=[];
  const executor=sourceFixtureExecutor(remoteUrl,{
    extraRun:async(command,args)=>{
      if(command==="tea"&&args.join(" ")==="login list --output json")return {ok:true,code:0,stdout:JSON.stringify(logins),stderr:""};
      if(command==="git"&&args[0]==="symbolic-ref")return {ok:false,code:1,stdout:"",stderr:""};
      return {ok:false,code:1,stdout:"",stderr:"not installed"};
    },
    extraStdin:async(command,args,input)=>{calls.push({command,args,input});return answer(args,input)},
  });
  executor.readFjKeys=async()=>({hosts:{},aliases:{}});
  return {executor,calls};
}
const teaAnswer=(status,body)=>({ok:true,code:0,stdout:typeof body==="string"?body:JSON.stringify(body),stderr:"HTTP/1.1 "+status+"\nContent-Type: application/json\n\n"});

test("without fj, Forgejo calls go through tea api with the login for the remote",async()=>{
  const logins=[{name:"other",url:"https://other.example",ssh_host:"other.example",user:"ada",default:"true"},{name:"forge",url:"https://forge.example",ssh_host:"forge.example",user:"ada",default:"false"}];
  const {executor,calls}=teaFixture("git@forge.example:acme/widget.git",logins,args=>{
    if(args.at(-1).startsWith("/repos/acme/widget/pulls?"))return teaAnswer("200 OK",[{number:3,title:"Fix",state:"open",head:{ref:"fix",sha:"abc"},base:{ref:"main"},user:{login:"ada"},html_url:"https://forge.example/acme/widget/pulls/3"}]);
    return teaAnswer("201 Created",{html_url:"https://forge.example/acme/widget/pulls/4"});
  });
  const listed=await withSourceControlExecutor(executor,()=>listPullRequests("/srv/app",{provider:"forgejo"}));
  assert.equal(listed.ok,true);
  assert.deepEqual(listed.items.map(item=>[item.number,item.title,item.headRefName,item.url]),[[3,"Fix","fix","https://forge.example/acme/widget/pulls/3"]]);
  assert.deepEqual(calls[0].args,["api","--method","GET","--login","forge","--repo","acme/widget","--include","/repos/acme/widget/pulls?state=open&sort=recentupdate&page=1&limit=50"]);
  assert.equal(calls[0].input,"");
  const created=await withSourceControlExecutor(executor,()=>createPullRequest("/srv/app",{provider:"forgejo",title:"Add",body:"Body"}));
  assert.equal(created.url,"https://forge.example/acme/widget/pulls/4");
  assert.deepEqual(calls[1].args,["api","--method","POST","--login","forge","--repo","acme/widget","--data","@-","--include","/repos/acme/widget/pulls"]);
  assert.deepEqual(JSON.parse(calls[1].input),{base:"main",head:"main",title:"Add",body:"Body"});
});

test("a tea api answer of 400 or more, or with no status, is an error even though tea exits 0",async()=>{
  const logins=[{name:"forge",url:"https://forge.example",ssh_host:"forge.example",user:"ada",default:"true"}];
  let answer=teaAnswer("404 Not Found",{message:"The target couldn't be found."});
  const {executor}=teaFixture("https://forge.example/acme/widget.git",logins,()=>answer);
  await assert.rejects(withSourceControlExecutor(executor,()=>mergePullRequest("/srv/app",9,{provider:"forgejo",method:"rebase"})),/HTTP 404: \{"message":"The target couldn't be found\."\}/);
  answer={ok:true,code:0,stdout:"{}",stderr:""};
  await assert.rejects(withSourceControlExecutor(executor,()=>mergePullRequest("/srv/app",9,{provider:"forgejo"})),/no HTTP status/);
  answer={ok:false,code:1,stdout:"",stderr:"Error: login forge not found"};
  await assert.rejects(withSourceControlExecutor(executor,()=>mergePullRequest("/srv/app",9,{provider:"forgejo"})),/login forge not found/);
});

test("Forgejo publishing goes to the default tea login's server, as the signed-in person",async()=>{
  let origin="";const calls=[];
  const logins=[{name:"work",url:"https://git.work.example",ssh_host:"git.work.example",user:"ada",default:"false"},{name:"home",url:"https://forge.example",ssh_host:"forge.example",user:"ada",default:"true"}];
  const executor={
    run:async(command,args)=>{
      if(command==="git"&&args[0]==="rev-parse"&&args[1]==="--show-toplevel")return {ok:true,code:0,stdout:"/srv/app\n",stderr:""};
      if(command==="git"&&args[0]==="branch")return {ok:true,code:0,stdout:"main\n",stderr:""};
      if(command==="git"&&args[0]==="for-each-ref")return {ok:true,code:0,stdout:"main\n",stderr:""};
      if(command==="git"&&args[0]==="status")return {ok:true,code:0,stdout:"## main\n",stderr:""};
      if(command==="git"&&args[0]==="remote"&&args[1]==="-v")return {ok:true,code:0,stdout:origin?"origin\t"+origin+" (fetch)\norigin\t"+origin+" (push)\n":"",stderr:""};
      if(command==="git"&&args[0]==="worktree")return {ok:true,code:0,stdout:"worktree /srv/app\nHEAD abc\nbranch refs/heads/main\n",stderr:""};
      if(command==="git"&&args[0]==="rev-parse"&&args[1]==="--verify")return {ok:false,code:128,stdout:"",stderr:"fatal: unborn"};
      if(command==="git"&&args[0]==="remote"&&args[1]==="add"){origin=args[3];return {ok:true,code:0,stdout:"",stderr:""}}
      if(command==="tea"&&args.join(" ")==="login list --output json")return {ok:true,code:0,stdout:JSON.stringify(logins),stderr:""};
      return {ok:false,code:1,stdout:"",stderr:"not installed"};
    },
    runStdin:async(command,args,input)=>{
      calls.push({args,input});
      if(args.at(-1)==="/user")return teaAnswer("200 OK",{login:"ada"});
      return teaAnswer("201 Created",{clone_url:"https://forge.example/ada/widget.git",html_url:"https://forge.example/ada/widget"});
    },
    readFjKeys:async()=>({hosts:{},aliases:{}}),
  };
  const result=await withSourceControlExecutor(executor,()=>publishRepository("/srv/app",{provider:"forgejo",name:"ada/widget",visibility:"public"}));
  assert.equal(result.ok,true);assert.equal(result.pushed,false);assert.equal(result.url,"https://forge.example/ada/widget");
  assert.equal(origin,"https://forge.example/ada/widget.git");
  assert.deepEqual(calls.map(call=>call.args),[
    ["api","--method","GET","--login","home","--include","/user"],
    ["api","--method","POST","--login","home","--data","@-","--include","/user/repos"],
  ]);
  assert.deepEqual(JSON.parse(calls[1].input),{name:"widget",private:false,auto_init:false});
});

test("Forgejo publishing with fj tokens for several servers and no default tea login asks for one",async()=>{
  const executor={
    run:async(command,args)=>{
      if(command==="git"&&args[0]==="rev-parse"&&args[1]==="--show-toplevel")return {ok:true,code:0,stdout:"/srv/app\n",stderr:""};
      if(command==="git"&&args[0]==="branch")return {ok:true,code:0,stdout:"main\n",stderr:""};
      if(command==="git"&&args[0]==="for-each-ref")return {ok:true,code:0,stdout:"main\n",stderr:""};
      if(command==="git"&&args[0]==="status")return {ok:true,code:0,stdout:"## main\n",stderr:""};
      if(command==="git"&&args[0]==="remote")return {ok:true,code:0,stdout:"",stderr:""};
      if(command==="git"&&args[0]==="worktree")return {ok:true,code:0,stdout:"worktree /srv/app\nHEAD abc\nbranch refs/heads/main\n",stderr:""};
      if(command==="git"&&args[0]==="rev-parse"&&args[1]==="--verify")return {ok:true,code:0,stdout:"abc\n",stderr:""};
      return {ok:false,code:1,stdout:"",stderr:"not installed"};
    },
    readFjKeys:async()=>({hosts:{"forge.example":{type:"Application",token:"a"},"codeberg.org":{type:"Application",token:"b"}},aliases:{}}),
  };
  await assert.rejects(withSourceControlExecutor(executor,()=>publishRepository("/srv/app",{provider:"forgejo",name:"widget"})),/tea login default/);
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

// A GitHub repository at /srv/app, reached through an environment executor, whose tree lists `records` (git ls-tree -z records)
// and whose objects hold `contents` (object id -> text; an id it does not hold cannot be read). reads() lists the ids read, in order.
function templateRepository(records,contents={},{listing=true}={}){
  const calls=[];
  const executor={run:async(command,args,options={})=>{
    calls.push({command,args:[...args],cwd:options.cwd});
    if(command!=="git")return {ok:false,code:1,stdout:"",stderr:"unexpected command"};
    if(args[0]==="rev-parse"&&args[1]==="--show-toplevel")return {ok:true,code:0,stdout:"/srv/app\n",stderr:""};
    if(args[0]==="remote")return {ok:true,code:0,stdout:"origin\thttps://github.com/acme/widget.git (fetch)\norigin\thttps://github.com/acme/widget.git (push)\n",stderr:""};
    if(args[0]==="ls-tree")return listing?{ok:true,code:0,stdout:records.map(record=>record+"\0").join(""),stderr:""}:{ok:false,code:128,stdout:"",stderr:"fatal: Not a valid object name"};
    if(args[0]==="cat-file"){const id=args.at(-1);return Object.hasOwn(contents,id)?{ok:true,code:0,stdout:contents[id],stderr:""}:{ok:false,code:128,stdout:"",stderr:"fatal: Not a valid object name "+id}}
    return {ok:true,code:0,stdout:"",stderr:""};
  }};
  return {
    calls,
    template:options=>withSourceControlExecutor(executor,()=>sourceControlPullRequestTemplate("/srv/app",options)),
    reads:()=>calls.filter(call=>call.args[0]==="cat-file").map(call=>call.args.at(-1)),
  };
}
const blobId=number=>String(number).padStart(40,"0");
const fileRecord=(path,id,mode="100644")=>`${mode} blob ${id}\t${path}`;

test("a pull request template is the first of the six template files that has text, its name matched exactly",async()=>{
  const repo=templateRepository([
    fileRecord(".github/pull_request_template.md",blobId(1)),
    fileRecord(".github/PULL_REQUEST_TEMPLATE.md",blobId(2)),
    fileRecord("Pull_Request_Template.md",blobId(3)),
    fileRecord("PULL_REQUEST_TEMPLATE.md",blobId(4)),
    fileRecord("docs/pull_request_template.md",blobId(5)),
  ],{[blobId(2)]:" \n\t\n",[blobId(3)]:"## Mixed case",[blobId(4)]:"\n## Root template\n\n- [ ] Tested\n\n",[blobId(5)]:"## Docs template"});
  assert.equal(await repo.template(),"## Root template\n\n- [ ] Tested");
  // The first cannot be read and the second holds only white space; a name in other letters is no template, and the docs file
  // after the one found is never read.
  assert.deepEqual(repo.reads(),[blobId(1),blobId(2),blobId(4)]);
  assert.equal(repo.calls.filter(call=>call.args[0]==="cat-file").every(call=>call.cwd==="/srv/app"&&call.args[1]==="blob"),true);
});

test("only regular files git lists with a full object id are pull request templates",async()=>{
  const sha256Id=number=>String(number).padStart(64,"a");
  const repo=templateRepository([
    `120000 blob ${blobId(1)}\t.github/pull_request_template.md`,
    `160000 commit ${blobId(2)}\t.github/PULL_REQUEST_TEMPLATE.md`,
    `040000 tree ${blobId(3)}\tpull_request_template.md`,
    "100644 blob not-an-object-id\tPULL_REQUEST_TEMPLATE.md",
    fileRecord("docs/pull_request_template.md","1".repeat(41)),
    fileRecord("docs/PULL_REQUEST_TEMPLATE.md",sha256Id(6),"100755"),
  ],{[blobId(1)]:"## Link",[blobId(2)]:"## Submodule",[blobId(3)]:"## Folder",["1".repeat(41)]:"## Odd id",[sha256Id(6)]:"## Executable template"});
  assert.equal(await repo.template(),"## Executable template");
  assert.deepEqual(repo.reads(),[sha256Id(6)]);
});

test("a pull request template folder gives its one Markdown file that has text",async()=>{
  const repo=templateRepository([
    fileRecord(".github/PULL_REQUEST_TEMPLATE/blank.md",blobId(1)),
    fileRecord(".github/PULL_REQUEST_TEMPLATE/Feature.MD",blobId(2)),
    fileRecord(".github/PULL_REQUEST_TEMPLATE/nested/deep.md",blobId(3)),
    fileRecord(".github/PULL_REQUEST_TEMPLATE/notes.txt",blobId(4)),
  ],{[blobId(1)]:"\n\n",[blobId(2)]:"## Feature\n",[blobId(3)]:"## Deeper",[blobId(4)]:"Plain notes"});
  assert.equal(await repo.template(),"## Feature");
  assert.deepEqual(repo.reads(),[blobId(1),blobId(2)],"a file in a folder below, or one that is not Markdown, is not read");
  const emptyFirst=templateRepository([
    fileRecord(".github/PULL_REQUEST_TEMPLATE/empty.md",blobId(1)),
    fileRecord("PULL_REQUEST_TEMPLATE/only.md",blobId(2)),
    fileRecord("docs/PULL_REQUEST_TEMPLATE/later.md",blobId(3)),
  ],{[blobId(1)]:"",[blobId(2)]:"## Root folder",[blobId(3)]:"## Docs folder"});
  assert.equal(await emptyFirst.template(),"## Root folder");
  assert.deepEqual(emptyFirst.reads(),[blobId(1),blobId(2)]);
});

test("a pull request template folder that holds several templates gives none, whatever later folders hold",async()=>{
  const repo=templateRepository([
    fileRecord(".github/PULL_REQUEST_TEMPLATE/bug.md",blobId(1)),
    fileRecord(".github/PULL_REQUEST_TEMPLATE/feature.md",blobId(2)),
    fileRecord(".github/PULL_REQUEST_TEMPLATE/release.md",blobId(3)),
    fileRecord("docs/PULL_REQUEST_TEMPLATE/only.md",blobId(4)),
  ],{[blobId(1)]:"## Bug",[blobId(2)]:"## Feature",[blobId(3)]:"## Release",[blobId(4)]:"## Only"});
  assert.equal(await repo.template(),null);
  assert.deepEqual(repo.reads(),[blobId(1),blobId(2)],"reading stops at the second template");
});

test("a single pull request template file comes before every template folder",async()=>{
  const repo=templateRepository([
    fileRecord(".github/PULL_REQUEST_TEMPLATE/change.md",blobId(1)),
    fileRecord("docs/pull_request_template.md",blobId(2)),
  ],{[blobId(1)]:"## Folder",[blobId(2)]:"## Docs file"});
  assert.equal(await repo.template(),"## Docs file");
  assert.deepEqual(repo.reads(),[blobId(2)]);
});

test("a pull request template longer than 8,000 characters keeps its first 8,000",async()=>{
  const exact="x".repeat(8000);
  const whole=templateRepository([fileRecord("pull_request_template.md",blobId(1))],{[blobId(1)]:"\n  "+exact+"\n\n"});
  assert.equal(await whole.template(),exact);
  const cut=templateRepository([fileRecord("pull_request_template.md",blobId(1))],{[blobId(1)]:"y".repeat(7999)+"z and more"});
  assert.equal(await cut.template(),"y".repeat(7999)+"z\n\n[truncated]");
});

test("pull request templates are listed from the tree asked for, and a tree git refuses gives none",async()=>{
  const repo=templateRepository([fileRecord(".github/pull_request_template.md",blobId(1))],{[blobId(1)]:"## Feature branch"});
  assert.equal(await repo.template({treeish:"feature"}),"## Feature branch");
  const listing=repo.calls.find(call=>call.args[0]==="ls-tree");
  assert.equal(listing.cwd,"/srv/app");
  assert.equal(listing.args.includes("-z")&&listing.args.includes("-r"),true);
  assert.equal(listing.args.indexOf("feature")>=0&&listing.args.indexOf("feature")<listing.args.indexOf("--"),true);
  assert.deepEqual(listing.args.slice(listing.args.indexOf("--")+1),[
    ".github/pull_request_template.md",".github/PULL_REQUEST_TEMPLATE.md","pull_request_template.md","PULL_REQUEST_TEMPLATE.md",
    "docs/pull_request_template.md","docs/PULL_REQUEST_TEMPLATE.md",".github/PULL_REQUEST_TEMPLATE","PULL_REQUEST_TEMPLATE","docs/PULL_REQUEST_TEMPLATE",
  ]);
  const unnamed=templateRepository([fileRecord(".github/pull_request_template.md",blobId(1))],{[blobId(1)]:"## Head"});
  assert.equal(await unnamed.template({treeish:""}),"## Head");
  assert.equal(unnamed.calls.find(call=>call.args[0]==="ls-tree").args.includes("HEAD"),true);
  const refused=templateRepository([],{},{listing:false});
  assert.equal(await refused.template({treeish:"missing"}),null);
  assert.equal(refused.reads().length,0,"nothing is read once git refuses the tree");
  const option=templateRepository([fileRecord("pull_request_template.md",blobId(1))],{[blobId(1)]:"## Never"});
  assert.equal(await option.template({treeish:"--output=listing.txt"}),null);
  assert.equal(option.calls.some(call=>call.args[0]==="ls-tree"),false,"a tree name that starts with - never reaches git");
});

test("a GitHub repository's pull request template is read from what it committed",async()=>{
  const githubRemote="https://github.com/acme/widget.git";
  const root=await mkdtemp(join(tmpdir(),"trebell-pr-template-"));
  try{
    await git(root,["init"]);await git(root,["config","user.email","trebell@example.test"]);await git(root,["config","user.name","Trebell Test"]);
    await git(root,["remote","add","origin",githubRemote]);
    await mkdir(join(root,".github","PULL_REQUEST_TEMPLATE"),{recursive:true});
    await writeFile(join(root,".github","PULL_REQUEST_TEMPLATE","change.md"),"## Folder template\n");
    await git(root,["add","."]);await git(root,["commit","-m","Add a template folder"]);
    assert.equal(await sourceControlPullRequestTemplate(root),"## Folder template");
    await writeFile(join(root,"pull_request_template.md"),"## Root template\n");
    assert.equal(await sourceControlPullRequestTemplate(root),"## Folder template","a template not committed yet is not read");
    await git(root,["add","pull_request_template.md"]);await git(root,["commit","-m","Add a root template"]);
    assert.equal(await sourceControlPullRequestTemplate(root),"## Root template");
    assert.equal(await sourceControlPullRequestTemplate(root,{treeish:"HEAD~1"}),"## Folder template");
  }finally{
    await rm(root,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});

test("pull request templates are looked for only in a Git repository, on origin's host or else the first fetch remote's",async()=>{
  // remoteLines: what git remote -v prints, or null for a folder outside any Git repository.
  const lookUp=async remoteLines=>{
    const asked=[];
    const executor={run:async(command,args)=>{
      asked.push(args[0]);
      if(args[0]==="rev-parse")return remoteLines?{ok:true,code:0,stdout:"/srv/app\n",stderr:""}:{ok:false,code:128,stdout:"",stderr:"fatal: not a git repository"};
      if(args[0]==="remote")return {ok:true,code:0,stdout:remoteLines.join("\n")+"\n",stderr:""};
      if(args[0]==="ls-tree")return {ok:true,code:0,stdout:`100644 blob ${"c".repeat(40)}\tPULL_REQUEST_TEMPLATE.md\0`,stderr:""};
      if(args[0]==="cat-file")return {ok:true,code:0,stdout:"## From the tree\n",stderr:""};
      return {ok:true,code:0,stdout:"",stderr:""};
    }};
    const template=await withSourceControlExecutor(executor,()=>sourceControlPullRequestTemplate("/srv/app"));
    return {template,listed:asked.includes("ls-tree")};
  };
  assert.deepEqual(await lookUp(null),{template:null,listed:false});
  assert.deepEqual(await lookUp([
    "upstream\thttps://gitlab.com/acme/widget.git (fetch)","upstream\thttps://gitlab.com/acme/widget.git (push)",
    "origin\tgit@github.com:acme/widget.git (fetch)","origin\tgit@github.com:acme/widget.git (push)",
  ]),{template:"## From the tree",listed:true},"origin counts first, wherever git lists it");
  assert.deepEqual(await lookUp([
    "origin\thttps://gitlab.com/acme/widget.git (push)",
    "fork\thttps://github.com/me/widget.git (fetch)","upstream\thttps://gitlab.com/acme/widget.git (fetch)",
  ]),{template:"## From the tree",listed:true},"with no origin to fetch from, the first fetch remote counts");
  assert.deepEqual(await lookUp([
    "origin\thttps://gitlab.com/acme/widget.git (fetch)","fork\thttps://github.com/me/widget.git (fetch)",
  ]),{template:null,listed:false},"a GitHub remote other than the one that counts gives none");
});

test("git's pull request template listing is read up to 128 KiB and each template up to 64 KiB",async()=>{
  const limits=[];
  const executor={run:async(command,args,options={})=>{
    if(args[0]==="rev-parse")return {ok:true,code:0,stdout:"/srv/app\n",stderr:""};
    if(args[0]==="remote")return {ok:true,code:0,stdout:"origin\thttps://github.com/acme/widget.git (fetch)\n",stderr:""};
    if(args[0]==="ls-tree"||args[0]==="cat-file")limits.push([args[0],options.maxBuffer]);
    if(args[0]==="ls-tree")return {ok:true,code:0,stdout:`100644 blob ${"d".repeat(40)}\tdocs/pull_request_template.md\0`,stderr:""};
    if(args[0]==="cat-file")return {ok:true,code:0,stdout:"## Docs\n",stderr:""};
    return {ok:true,code:0,stdout:"",stderr:""};
  }};
  assert.equal(await withSourceControlExecutor(executor,()=>sourceControlPullRequestTemplate("/srv/app")),"## Docs");
  assert.deepEqual(limits,[["ls-tree",128*1024],["cat-file",64*1024]]);
  // With git on this machine, a template larger than its read gives no text, and the next place is tried.
  const root=await mkdtemp(join(tmpdir(),"trebell-pr-template-size-"));
  try{
    await git(root,["init"]);await git(root,["config","user.email","trebell@example.test"]);await git(root,["config","user.name","Trebell Test"]);
    await git(root,["remote","add","origin","git@github.com:acme/widget.git"]);
    await mkdir(join(root,".github"),{recursive:true});await mkdir(join(root,"docs"),{recursive:true});
    await writeFile(join(root,".github","pull_request_template.md"),"## Too long\n"+"x".repeat(70*1024));
    await writeFile(join(root,"docs","pull_request_template.md"),"## Docs template\n");
    await git(root,["add","."]);await git(root,["commit","-m","Add two templates"]);
    assert.equal(await sourceControlPullRequestTemplate(root),"## Docs template");
  }finally{
    await rm(root,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
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
    if(args[0]==="log"&&args.includes("origin/main..HEAD"))return {ok:true,code:0,stdout:"abc Tidy the importer\n",stderr:""};
    if(args[0]==="diff"&&args.includes("--stat"))return {ok:true,code:0,stdout:" importer.mjs | 1 +\n",stderr:""};
    if(args[0]==="diff"&&args.includes("--patch"))return {ok:true,code:0,stdout:"diff --git a/importer.mjs b/importer.mjs\n",stderr:""};
    return {ok:false,code:1,stdout:"",stderr:"unexpected git "+args.join(" ")};
  }};
  const result=await withSourceControlExecutor(executor,()=>sourceControlReviewRangeContext("/srv/app"));
  assert.equal(result.baseBranch,"main");
  assert.equal(result.baseRef,"origin/main");
  assert.match(result.commitSummary,/Tidy the importer/);
  assert.equal(calls.some(call=>call.args[0]==="log"&&call.args.includes("origin/main..HEAD")),true);
  const diffCalls=calls.filter(call=>call.args[0]==="diff");
  assert.equal(diffCalls.length,2);
  assert.equal(diffCalls.every(call=>call.args.includes("origin/main...HEAD")),true);
});

// A branch whose base moved on after it started. Ana pushes main to a shared remote ("hub") and starts "birds" from it with two
// commits; then Ben, in his own clone, pushes a commit to main that edits a file the branch never touched and adds another; Ana
// fetches. Only her origin/main has Ben's commit: her own main stays where she left it. Each test gets its own folder.
const ANA={name:"Ana Lopez",email:"ana@example.test"},BEN={name:"Ben Okafor",email:"ben@example.test"};
async function commitAs(person,checkout,files,subject){
  for(const [name,text] of Object.entries(files))await writeFile(join(checkout,name),text);
  await git(checkout,["add","--",...Object.keys(files)]);
  await git(checkout,["-c","user.name="+person.name,"-c","user.email="+person.email,"commit","--quiet","-m",subject]);
}
async function branchAfterBaseMovedOn(t){
  const folder=await mkdtemp(join(tmpdir(),"trebell-moved-base-"));
  t.after(()=>rm(folder,{recursive:true,force:true,maxRetries:20,retryDelay:250}));
  const hub=join(folder,"hub.git"),laptop=join(folder,"laptop"),teammate=join(folder,"teammate");
  await git(folder,["init","--quiet","--bare",hub]);
  await git(folder,["init","--quiet",laptop]);
  await git(laptop,["symbolic-ref","HEAD","refs/heads/main"]);
  await commitAs(ANA,laptop,{"guide.md":"# Field guide\n"},"Start the field guide");
  await git(laptop,["remote","add","origin",hub]);
  await git(laptop,["push","--quiet","--set-upstream","origin","main"]);
  await git(laptop,["switch","--quiet","--create","birds"]);
  await commitAs(ANA,laptop,{"birds.md":"Robin\nWren\n"},"Describe garden birds");
  await commitAs(ANA,laptop,{"birds.md":"Robin\nWren: a loud trill\n"},"Add the wren song");
  await git(folder,["clone","--quiet","--branch","main",hub,teammate]);
  await commitAs(BEN,teammate,{"guide.md":"# Field guide\nSee also the trees chapter.\n","trees.md":"Oak\nBirch\n"},"Add a chapter on trees");
  await git(teammate,["push","--quiet","origin","main"]);
  await git(laptop,["fetch","--quiet","origin"]);
  return laptop;
}
// The parts of the context as lists: commit subjects (git log --oneline), the paths of the --stat lines, the paths of the patch's file headers.
const subjectsOf=oneline=>oneline.split(/\r?\n/).filter(Boolean).map(line=>line.replace(/^[0-9a-f]+ /,""));
const statPaths=stat=>stat.split(/\r?\n/).filter(line=>line.includes("|")).map(line=>line.split("|")[0].trim());
const patchPaths=patch=>[...patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map(match=>match[1]);

test("a pull request's commits and diff hold only the branch's own work after the base branch moves on",async t=>{
  const laptop=await branchAfterBaseMovedOn(t);
  // So the test cannot pass for the wrong reason: Ben's commit is on origin/main, not in the branch, and not on Ana's own main.
  const commitOf=async ref=>(await git(laptop,["rev-parse",ref])).stdout.trim();
  assert.deepEqual(subjectsOf((await git(laptop,["log","--oneline","-1","origin/main"])).stdout),["Add a chapter on trees"]);
  assert.equal((await git(laptop,["merge-base","--is-ancestor","origin/main","HEAD"],{allowFailure:true})).code,1);
  assert.notEqual(await commitOf("main"),await commitOf("origin/main"));
  const context=await sourceControlReviewRangeContext(laptop,{base:"main"});
  assert.equal(context.baseBranch,"main");
  assert.equal(context.baseRef,"origin/main");
  // Newest first, and neither Ben's later commit nor the commit the branch started from.
  assert.deepEqual(subjectsOf(context.commitSummary),["Add the wren song","Describe garden birds"]);
  // Neither the guide Ben edited nor the chapter he added, in either direction.
  assert.deepEqual(statPaths(context.diffSummary),["birds.md"]);
  assert.deepEqual(patchPaths(context.diff),["birds.md"]);
  assert.equal(context.cut,false);
});

test("a branch that merged the moved base back in still gets only its own commits and changes as pull request context",async t=>{
  const laptop=await branchAfterBaseMovedOn(t);
  await git(laptop,["-c","user.name="+ANA.name,"-c","user.email="+ANA.email,"merge","--quiet","--no-ff","--no-edit","-m","Merge the latest main into birds","origin/main"]);
  const context=await sourceControlReviewRangeContext(laptop,{base:"main"});
  assert.equal(context.baseRef,"origin/main");
  assert.deepEqual(subjectsOf(context.commitSummary),["Merge the latest main into birds","Add the wren song","Describe garden birds"]);
  assert.deepEqual(statPaths(context.diffSummary),["birds.md"]);
  assert.deepEqual(patchPaths(context.diff),["birds.md"]);
});

test("a branch whose diff outgrows the patch's 4 MB read still gets its pull request context, cut at the read",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-pr-large-"));
  try{
    await git(root,["init"]);await git(root,["config","user.email","trebell@example.test"]);await git(root,["config","user.name","Trebell Test"]);
    await git(root,["checkout","-b","main"]);await writeFile(join(root,"base.txt"),"base\n");await git(root,["add","."]);await git(root,["commit","-m","Base commit"]);
    await git(root,["checkout","-b","feature"]);
    await writeFile(join(root,"generated.txt"),"generated line of a vendored or built file\n".repeat(120_000));
    await git(root,["add","."]);await git(root,["commit","-m","Add the generated file"]);
    const context=await sourceControlReviewRangeContext(root,{base:"main"});
    assert.match(context.commitSummary,/Add the generated file/);
    assert.match(context.diffSummary,/generated\.txt/);
    assert.match(context.diff,/^diff --git a\/generated\.txt/);
    assert.ok(context.diff.length>1024*1024&&context.diff.length<=4*1024*1024,String(context.diff.length));
    assert.equal(context.cut,true);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
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
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

// git follows a refusal with hint: lines for a person at a terminal (the commands to run next, the setting that turns the hint off);
// an environment's Git actions fail with git's reason alone, as the local ones do.
test("a Git action git refuses fails with git's reason, without the hints git adds for a terminal",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-git-hints-"));
  try{
    await git(root,["init","-b","main"]);await git(root,["config","user.email","trebell@example.test"]);await git(root,["config","user.name","Trebell Test"]);
    await writeFile(join(root,"base.txt"),"base\n");await git(root,["add","."]);await git(root,["commit","-m","Base"]);
    await assert.rejects(()=>sourceControlGitAction(root,{action:"branch-create",name:"bad..name"}),{message:"fatal: 'bad..name' is not a valid branch name"});
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
  const diverged="hint: Diverging branches can't be fast-forwarded, you need to either:\nhint:\nhint: \tgit merge --no-ff\nhint:\nhint: or:\nhint:\nhint: \tgit rebase\nhint:\nhint: Disable this message with \"git config set advice.diverging false\"\nfatal: Not possible to fast-forward, aborting.\n";
  const executor={
    run:async(command,args)=>{
      if(command!=="git")return {ok:false,code:1,stdout:"",stderr:"unexpected command"};
      if(args[0]==="rev-parse"&&args[1]==="--show-toplevel")return {ok:true,code:0,stdout:"/srv/app\n",stderr:""};
      if(args[0]==="branch")return {ok:true,code:0,stdout:"main\n",stderr:""};
      if(args[0]==="for-each-ref"&&args.includes("refs/heads"))return {ok:true,code:0,stdout:"main\n",stderr:""};
      if(args[0]==="for-each-ref")return {ok:true,code:0,stdout:"origin/main\n",stderr:""};
      if(args[0]==="status")return {ok:true,code:0,stdout:"## main...origin/main [ahead 1, behind 1]\n",stderr:""};
      if(args[0]==="remote")return {ok:true,code:0,stdout:"origin\thttps://github.com/acme/widget.git (fetch)\norigin\thttps://github.com/acme/widget.git (push)\n",stderr:""};
      if(args[0]==="worktree")return {ok:true,code:0,stdout:"worktree /srv/app\nHEAD abc\nbranch refs/heads/main\n",stderr:""};
      if(args[0]==="pull")return {ok:false,code:128,stdout:"",stderr:diverged};
      return {ok:false,code:1,stdout:"",stderr:"unexpected git "+args.join(" ")};
    },
  };
  await assert.rejects(()=>withSourceControlExecutor(executor,()=>sourceControlGitAction("/srv/app",{action:"pull"})),{message:"This branch and its upstream have diverged, each with commits the other does not have."});
});

// Without an executor too, git answers in English whatever the person's locale (and a hint in color is still a hint).
test("a Git action git refuses says the same under a German locale and with hints in color",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-git-locale-"));const work=join(root,"work");
  try{
    await git(root,["init","-b","main","work"]);await git(work,["config","user.email","trebell@example.test"]);await git(work,["config","user.name","Trebell Test"]);
    await writeFile(join(work,"base.txt"),"base\n");await git(work,["add","."]);await git(work,["commit","-m","Base"]);
    await withGermanColoredGit(join(root,"locale"),async()=>{
      await assert.rejects(()=>sourceControlGitAction(work,{action:"branch-create",name:"bad..name"}),{message:"fatal: 'bad..name' is not a valid branch name"});
      await assert.rejects(()=>sourceControlGitAction(work,{action:"pull"}),{message:"This branch has no upstream yet. Push it first to create one."});
    });
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

// A revert or a stack rebase stops on a conflict in a temporary worktree that is removed before the panel shows why, so the hints'
// commands (git revert --continue, git rebase --continue) cannot be followed: the error is git's reason with the conflicts it
// reported, as every Git refusal in the panel reads. A checkout gh passes git's refusal through reads the same way.
const githubRepository=(answer,head="main")=>({
  run:async(command,args,options={})=>{
    if(command==="git"&&args[0]==="rev-parse"&&args[1]==="--show-toplevel")return {ok:true,code:0,stdout:"/srv/app\n",stderr:""};
    if(command==="git"&&args[0]==="branch"&&args[1]==="--show-current")return {ok:true,code:0,stdout:head+"\n",stderr:""};
    if(command==="git"&&args[0]==="for-each-ref"&&args.includes("refs/heads"))return {ok:true,code:0,stdout:"main\nlayer-one\nlayer-two\n",stderr:""};
    if(command==="git"&&args[0]==="for-each-ref")return {ok:true,code:0,stdout:"origin/"+head+"\n",stderr:""};
    if(command==="git"&&args[0]==="status")return {ok:true,code:0,stdout:"## "+head+"...origin/"+head+"\n",stderr:""};
    if(command==="git"&&args[0]==="remote")return {ok:true,code:0,stdout:"origin\thttps://github.com/acme/widget.git (fetch)\norigin\thttps://github.com/acme/widget.git (push)\n",stderr:""};
    if(command==="git"&&args[0]==="worktree"&&args[1]==="list")return {ok:true,code:0,stdout:"worktree /srv/app\nHEAD abc\nbranch refs/heads/"+head+"\n",stderr:""};
    return answer(command,args,options)||{ok:true,code:0,stdout:"",stderr:""};
  },
});
const hinted=(lines,disable)=>[...lines.map(line=>"hint: "+line),"hint: Disable this message with \"git config set advice."+disable+" false\""].join("\n")+"\n";
test("a revert, a stack rebase or a checkout git refuses fails with git's reason and its conflicts, without the hints for a terminal",async()=>{
  const conflict="Auto-merging src/payments.js\nCONFLICT (content): Merge conflict in src/payments.js\n";
  const revert=githubRepository((command,args)=>{
    if(command==="gh"&&args[0]==="pr"&&args[1]==="view")return {ok:true,code:0,stdout:JSON.stringify({number:7,title:"Feature",state:"MERGED",mergedAt:"2026-09-20T10:00:00Z",mergeCommit:{oid:"merge123"},baseRefName:"main"}),stderr:""};
    if(command==="git"&&args[0]==="rev-list")return {ok:true,code:0,stdout:"merge123 parent1\n",stderr:""};
    if(command==="git"&&args[0]==="revert")return {ok:false,code:1,stdout:conflict,stderr:"error: could not revert merge123... Feature\n"+hinted(["After resolving the conflicts, mark them with","\"git add/rm <pathspec>\", then run","\"git revert --continue\".","You can instead skip this commit with \"git revert --skip\".","To abort and get back to the state before \"git revert\",","run \"git revert --abort\"."],"mergeConflict")};
  });
  await assert.rejects(()=>withSourceControlExecutor(revert,()=>revertPullRequest("/srv/app",7,{provider:"github"})),{message:"error: could not revert merge123... Feature\nCONFLICT (content): Merge conflict in src/payments.js"});
  const stack={id:900,number:42,open:true,base:{ref:"main"},pull_requests:[{number:1,title:"Layer one",state:"open",head:{ref:"layer-one",sha:"old1"},base:{ref:"main",sha:"base0"},html_url:"https://github.com/acme/widget/pull/1"},{number:2,title:"Layer two",state:"open",head:{ref:"layer-two",sha:"old2"},base:{ref:"layer-one",sha:"old1"},html_url:"https://github.com/acme/widget/pull/2"}]};
  const rebase=githubRepository((command,args)=>{
    if(command==="gh"&&args[0]==="api"){
      const path=args.find(value=>String(value).startsWith("repos/acme/widget/"))||"";
      if(path==="repos/acme/widget/pulls/2")return {ok:true,code:0,stdout:JSON.stringify({number:2,state:"open",head:{ref:"layer-two",sha:"old2"},base:{ref:"layer-one",sha:"old1"},stack:{number:42,size:2,position:2,base:{ref:"main",sha:"base0"}}}),stderr:""};
      if(path==="repos/acme/widget/stacks/42")return {ok:true,code:0,stdout:JSON.stringify(stack),stderr:""};
    }
    if(command==="git"&&args[0]==="rev-parse"&&args[1]==="refs/remotes/origin/main")return {ok:true,code:0,stdout:"base-new\n",stderr:""};
    if(command==="git"&&args[0]==="rebase"&&args[1]==="--onto")return {ok:false,code:1,stdout:conflict,stderr:"error: could not apply old1... Layer one\n"+hinted(["Resolve all conflicts manually, mark them as resolved with","\"git add/rm <conflicted_files>\", then run \"git rebase --continue\".","You can instead skip this commit: run \"git rebase --skip\".","To abort and get back to the state before \"git rebase\", run \"git rebase --abort\"."],"mergeConflict")+"Could not apply old1... Layer one\n"};
  },"layer-two");
  // The stack's conflict is said in Trebell's words since 2026-10-31 (it read "Stack rebase stopped at PR #1: <reason>"): the layer, what it
  // conflicts with, what was left alone, then git's reason as before.
  await assert.rejects(()=>withSourceControlExecutor(rebase,()=>rebasePullRequestStack("/srv/app",2,{provider:"github"})),{message:"#1 conflicts with main as it is now, so it and the layers above it were not changed: error: could not apply old1... Layer one\nCould not apply old1... Layer one\nCONFLICT (content): Merge conflict in src/payments.js"});
  const checkout=githubRepository((command,args)=>{
    if(command==="gh"&&args[0]==="pr"&&args[1]==="checkout")return {ok:false,code:1,stdout:"",stderr:"fatal: 'feature/x' is not a valid branch name\n"+hinted(["See `man git check-ref-format`"],"refSyntax")+"failed to run git: exit status 128\n"};
  });
  await assert.rejects(()=>withSourceControlExecutor(checkout,()=>checkoutPullRequest("/srv/app",9,{provider:"github"})),{message:"fatal: 'feature/x' is not a valid branch name\nfailed to run git: exit status 128"});
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

test("Bitbucket prefers the scoped secret broker over generic environment access",async()=>{
  const scopes=[],requests=[];const executor={
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
    secretValues:async scope=>{scopes.push(scope);return {TREBELL_BITBUCKET_ACCESS_TOKEN:"broker-token"}},
    env:async()=>{throw new Error("generic environment reader must not be used when a broker is present")},
    request:async(url,options)=>{requests.push({url:String(url),authorization:options.headers?.Authorization});return {ok:true,status:200,text:JSON.stringify({values:[]})}},
  };
  const result=await withSourceControlExecutor(executor,()=>listPullRequests("/srv/app"));assert.equal(result.provider,"bitbucket");assert.deepEqual(scopes,["source-control.bitbucket"]);assert.equal(requests[0].authorization,"Bearer broker-token");
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
  // A field that is not given is left as the host has it: a new title alone must not rewrite the description, and the reverse.
  const editArgs=()=>calls.filter(call=>call.command==="gh"&&call.args[1]==="edit").at(-1).args;
  await withSourceControlExecutor(executor,()=>editPullRequest("/srv/app",7,{provider:"github",title:"Only the title"}));
  assert.deepEqual(editArgs(),["pr","edit","7","--title","Only the title"]);
  await withSourceControlExecutor(executor,()=>editPullRequest("/srv/app",7,{provider:"github",body:"First line\n\n- second line"}));
  assert.deepEqual(editArgs(),["pr","edit","7","--body","First line\n\n- second line"]);
  await assert.rejects(()=>withSourceControlExecutor(executor,()=>editPullRequest("/srv/app",7,{provider:"github"})),/new title or description/);
  await assert.rejects(()=>withSourceControlExecutor(executor,()=>editPullRequest("/srv/app",7,{provider:"github",title:"  "})),/title is required/);

  await withSourceControlExecutor(executor,()=>editPullRequestComment("/srv/app",7,55,"Edited comment",{provider:"github"}));
  assert.equal(stdinCalls.length,1);
  assert.equal(stdinCalls[0].command,"gh");
  assert.equal(stdinCalls[0].args.includes("repos/acme/widget/issues/comments/55"),true);
  assert.deepEqual(JSON.parse(stdinCalls[0].input),{body:"Edited comment"});

  const detail=await withSourceControlExecutor(executor,()=>pullRequestDetail("/srv/app",7,{provider:"github"}));
  // The detail reads whether auto-merge is on and who was asked to review, so the panel can show both.
  const viewFields=calls.find(call=>call.command==="gh"&&call.args[1]==="view"&&call.args[call.args.indexOf("--json")+1]!=="headRefOid").args;
  assert.deepEqual(viewFields[viewFields.indexOf("--json")+1].split(",").filter(field=>["autoMergeRequest","reviewRequests"].includes(field)),["autoMergeRequest","reviewRequests"]);
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

// git for Windows went into a junction in a worktree it removed and emptied the folder the junction points to. Source control's removes
// whose git runs on this machine (no executor, or a local one: a delegation in a named local environment removes its worktree so) keep
// it, and keep git's refusals. Everything here is in a folder the test makes under the OS temp folder, the junctions' targets too.
async function repositoryWithOutside(name){
  const root=await mkdtemp(join(tmpdir(),`trebell-source-control-${name}-`)),repo=join(root,"repo"),outside=join(root,"outside");
  await git(root,["init","repo"]);await git(repo,["config","user.email","trebell@example.test"]);await git(repo,["config","user.name","Trebell Test"]);
  await writeFile(join(repo,".gitignore"),"node_modules/\n");await writeFile(join(repo,"README.md"),"seed\n");await git(repo,["add","."]);await git(repo,["commit","-m","seed"]);
  await mkdir(outside);await writeFile(join(outside,"keep.txt"),"keep\n");
  return {root,repo,outside,main:(await git(repo,["branch","--show-current"])).stdout.trim()};
}
const outsideWhole=f=>{assert.deepEqual(readdirSync(f.outside),["keep.txt"],"the folder outside the worktree holds what it held");assert.equal(readFileSync(join(f.outside,"keep.txt"),"utf8"),"keep\n")};
test("a worktree remove through source control with git on this machine leaves the folder a junction in the worktree points to",{timeout:300_000},async()=>{
  const f=await repositoryWithOutside("remove");
  try{
    for(const [name,executor] of [["the local executor",createNativeSourceControlExecutor()],["no executor",null]]){
      const tree=join(f.root,"repo-tree"),shared=join(tree,"node_modules","shared");
      await git(f.repo,["worktree","add","-b","tree-"+(executor?"local":"none"),tree]);await mkdir(join(tree,"node_modules"));await symlink(f.outside,shared,"junction");await writeFile(join(tree,"notes.txt"),"draft\n");
      await assert.rejects(withSourceControlExecutor(executor,()=>sourceControlGitAction(f.repo,{action:"worktree-remove",path:tree})),{message:`fatal: '${tree}' contains modified or untracked files, use --force to delete it`},name);
      assert.equal(lstatSync(shared).isSymbolicLink(),true,name+": the junction is still in the worktree");assert.equal(readFileSync(join(shared,"keep.txt"),"utf8"),"keep\n");
      await withSourceControlExecutor(executor,()=>sourceControlGitAction(f.repo,{action:"worktree-remove",path:tree,force:true}));
      assert.equal(existsSync(tree),false,name+": the worktree is gone");outsideWhole(f);
    }
  }finally{await rm(f.root,{recursive:true,force:true,maxRetries:30,retryDelay:100})}
});

// A revert's temporary worktree is checked out with the repository's hooks, and a post-checkout hook may link node_modules in each new
// worktree as a setup does. Here git and the hook are real; only gh answers from the test.
test("a revert's temporary worktree, removed with git on this machine, leaves the folder a junction its checkout made points to",{timeout:300_000},async()=>{
  const f=await repositoryWithOutside("revert"),origin=join(f.root,"origin.git"),hooks=join(f.root,"hooks"),marker=join(f.root,"hook-linked"),slashes=path=>path.replace(/\\/g,"/");
  try{
    await git(f.root,["init","--bare","origin.git"]);await git(f.repo,["remote","add","origin",origin]);
    await git(f.repo,["checkout","-b","feature"]);await writeFile(join(f.repo,"feature.txt"),"feature\n");await git(f.repo,["add","feature.txt"]);await git(f.repo,["commit","-m","Feature"]);
    await git(f.repo,["checkout",f.main]);await git(f.repo,["merge","--no-ff","feature","-m","Merge feature"]);await git(f.repo,["push","origin",f.main]);
    const merge=(await git(f.repo,["rev-parse","HEAD"])).stdout.trim();
    await mkdir(hooks);await writeFile(join(hooks,"post-checkout"),`#!/bin/sh\nmkdir -p node_modules && "${slashes(process.execPath)}" -e "require('fs').symlinkSync(process.argv[1],'node_modules/shared','junction')" "${slashes(f.outside)}" && echo "$PWD" >> "${slashes(marker)}"\n`,{mode:0o755});
    await git(f.repo,["config","core.hooksPath",slashes(hooks)]);
    const local=createNativeSourceControlExecutor(),executor={...local,run:async(command,args,options)=>{
      if(command!=="gh")return local.run(command,args,options);
      if(args[0]==="pr"&&args[1]==="view")return {ok:true,code:0,stdout:JSON.stringify({number:7,title:"Feature",state:"MERGED",mergedAt:"2026-10-20T10:00:00Z",mergeCommit:{oid:merge},baseRefName:f.main}),stderr:""};
      if(args[0]==="pr"&&args[1]==="create")return {ok:true,code:0,stdout:"https://github.com/acme/widget/pull/8\n",stderr:""};
      return {ok:false,code:1,stdout:"",stderr:"unexpected gh "+args.join(" ")};
    }};
    const result=await withSourceControlExecutor(executor,()=>revertPullRequest(f.repo,7,{provider:"github"}));
    assert.equal(result.url,"https://github.com/acme/widget/pull/8");assert.match(readFileSync(marker,"utf8"),/\.trebell-revert-7-/,"the hook linked node_modules in the revert's worktree");
    assert.deepEqual(readdirSync(f.root).filter(name=>name.includes(".trebell-revert-")),[],"the revert's worktree is gone");outsideWhole(f);
  }finally{await rm(f.root,{recursive:true,force:true,maxRetries:30,retryDelay:100})}
});
