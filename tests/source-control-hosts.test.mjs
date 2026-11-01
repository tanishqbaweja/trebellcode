import test from "node:test";
import assert from "node:assert/strict";
import { commentOnPullRequest, editPullRequest, listPullRequests, rebasePullRequestStack, reviewPullRequest, sourceControlDiagnostics, withSourceControlExecutor } from "../src/source-control-service.mjs";

// How Trebell reaches Bitbucket (its REST API), GitLab (glab api), Azure DevOps (az) and a GitHub stack's branches (git), as each
// host's documentation describes the request. A repository at /srv/app has the given origin; git's reads of it are answered here,
// every other command by `answer` (and recorded), and an unexpected one fails.
function repositoryAt(remote,answer=()=>null,{head="main",stdin=null,more={}}={}){
  const calls=[];
  const gitRead=args=>{
    if(args[0]==="rev-parse"&&args[1]==="--show-toplevel")return "/srv/app\n";
    if(args[0]==="branch"&&args[1]==="--show-current")return head+"\n";
    if(args[0]==="for-each-ref")return args.includes("refs/heads")?"main\n":"origin/"+head+"\n";
    if(args[0]==="status")return "## "+head+"...origin/"+head+"\n";
    if(args[0]==="remote")return "origin\t"+remote+" (fetch)\norigin\t"+remote+" (push)\n";
    if(args[0]==="worktree"&&args[1]==="list")return "worktree /srv/app\nHEAD abc\nbranch refs/heads/"+head+"\n";
    return null;
  };
  return {
    calls,
    run:async(command,args,options={})=>{
      const read=command==="git"?gitRead(args):null;if(read!=null)return {ok:true,code:0,stdout:read,stderr:""};
      calls.push({command,args:[...args],cwd:options.cwd});
      return answer(command,args,options)||{ok:false,code:1,stdout:"",stderr:"unexpected "+command+" "+args.join(" ")};
    },
    runStdin:async(command,args,input,options={})=>{
      calls.push({command,args:[...args],input,cwd:options.cwd});
      return stdin?.(command,args,input)||{ok:false,code:1,stdout:"",stderr:"unexpected stdin "+command};
    },
    withTempJsonFile:async(content,callback)=>{calls.push({tempJson:JSON.parse(content)});return callback("/tmp/trebell-azure-request.json")},
    ...more,
  };
}
const ok=stdout=>({ok:true,code:0,stdout:typeof stdout==="string"?stdout:JSON.stringify(stdout),stderr:""});
const AZ_EVERY_CALL=["--detect","true","--only-show-errors","--output","json"];

test("Bitbucket signs in with an e-mail address and an API token as HTTP Basic when no access token is set",async()=>{
  const requests=[];
  const executor=repositoryAt("https://bitbucket.org/acme/widget.git",undefined,{more:{
    env:async names=>{assert.deepEqual(names,["TREBELL_BITBUCKET_ACCESS_TOKEN","TREBELL_BITBUCKET_EMAIL","TREBELL_BITBUCKET_API_TOKEN"]);return {TREBELL_BITBUCKET_EMAIL:"dev@example.com",TREBELL_BITBUCKET_API_TOKEN:"api-token",BITBUCKET_TOKEN:"never read"}},
    request:async(url,options)=>{requests.push({url:String(url),options});return {ok:true,status:200,text:JSON.stringify({values:[]})}},
  }});
  const listed=await withSourceControlExecutor(executor,()=>listPullRequests("/srv/app"));
  assert.equal(listed.ok,true);assert.equal(requests.length,1);
  assert.equal(requests[0].url,"https://api.bitbucket.org/2.0/repositories/acme/widget/pullrequests?state=OPEN&pagelen=50&sort=-updated_on");
  assert.deepEqual(requests[0].options.headers,{Accept:"application/json",Authorization:"Basic "+Buffer.from("dev@example.com:api-token").toString("base64")});
  assert.equal(requests[0].options.method,"GET");assert.equal(requests[0].options.body,undefined);
});

test("Bitbucket without credentials sends nothing, names Trebell's variables and shows as not signed in",async()=>{
  const requests=[];
  const executor=repositoryAt("https://bitbucket.org/acme/widget.git",undefined,{more:{env:async()=>({}),request:async url=>{requests.push(url);return {ok:true,status:200,text:"{}"}}}});
  await assert.rejects(()=>withSourceControlExecutor(executor,()=>listPullRequests("/srv/app")),error=>["TREBELL_BITBUCKET_ACCESS_TOKEN","TREBELL_BITBUCKET_EMAIL","TREBELL_BITBUCKET_API_TOKEN"].every(name=>error.message.includes(name)));
  assert.equal(requests.length,0);
  const diagnostics=await withSourceControlExecutor(executor,()=>sourceControlDiagnostics("/srv/app"));
  assert.equal(diagnostics.providers.bitbucket.authenticated,false);
});

test("Bitbucket writes send their JSON, and a refusal says the status and at most 800 characters of the answer",async()=>{
  const requests=[];
  const executor=repositoryAt("https://bitbucket.org/acme/widget.git",undefined,{more:{
    env:async()=>({TREBELL_BITBUCKET_ACCESS_TOKEN:"access"}),
    request:async(url,options)=>{requests.push({url:String(url),options});return options.method==="POST"?{ok:false,status:403,text:"x".repeat(900)}:{ok:true,status:200,text:""}},
  }});
  const edited=await withSourceControlExecutor(executor,()=>editPullRequest("/srv/app",5,{title:"Sharper title"}));
  assert.equal(edited.ok,true);
  assert.equal(requests[0].url,"https://api.bitbucket.org/2.0/repositories/acme/widget/pullrequests/5");
  assert.equal(requests[0].options.method,"PUT");assert.equal(requests[0].options.headers["Content-Type"],"application/json");assert.equal(requests[0].options.headers.Authorization,"Bearer access");
  assert.deepEqual(JSON.parse(requests[0].options.body),{title:"Sharper title"});
  await assert.rejects(()=>withSourceControlExecutor(executor,()=>commentOnPullRequest("/srv/app",5,"Looks good")),error=>error.message.includes("403")&&error.message.endsWith(": "+"x".repeat(800)));
});

test("GitLab requests go through glab api: the endpoint first, the method named, a JSON body on standard input",async()=>{
  const executor=repositoryAt("https://gitlab.com/acme/widget.git",(command,args)=>command==="glab"&&args[0]==="api"?ok({id:1}):null,{
    stdin:(command,args,input)=>command==="glab"?(JSON.parse(input).body==="refused"?{ok:false,code:1,stdout:"",stderr:"glab: 403 Forbidden\n"}:ok({id:2})):null,
  });
  await withSourceControlExecutor(executor,()=>editPullRequest("/srv/app",7,{title:"Sharper title"}));
  const put=executor.calls.find(call=>call.input);
  assert.deepEqual(put.args,["api","projects/acme%2Fwidget/merge_requests/7","-X","PUT","-H","Content-Type: application/json; charset=utf-8","--input","-"]);
  assert.deepEqual(JSON.parse(put.input),{title:"Sharper title"});assert.equal(put.cwd,"/srv/app");
  await withSourceControlExecutor(executor,()=>reviewPullRequest("/srv/app",7,{event:"APPROVE"}));
  assert.deepEqual(executor.calls.at(-1).args,["api","projects/acme%2Fwidget/merge_requests/7/approve","-X","POST"]);
  await assert.rejects(()=>withSourceControlExecutor(executor,()=>commentOnPullRequest("/srv/app",7,"refused")),{message:"glab: 403 Forbidden"});
});

test("Azure DevOps lists the active pull requests through az repos pr list, and says what az refused",async()=>{
  let refuse=false;
  const executor=repositoryAt("https://dev.azure.com/acme/project/_git/widget",(command,args)=>{
    if(command!=="az"||args.slice(0,3).join(" ")!=="repos pr list")return null;
    return refuse?{ok:false,code:1,stdout:"",stderr:"ERROR: TF400813: The user is not authorized to access this resource.\n"}:ok([{pullRequestId:3,title:"Faster cache",status:"active",sourceRefName:"refs/heads/cache",targetRefName:"refs/heads/main"}]);
  });
  const listed=await withSourceControlExecutor(executor,()=>listPullRequests("/srv/app"));
  assert.deepEqual(executor.calls[0].args,["repos","pr","list","--status","active","--top","50",...AZ_EVERY_CALL]);
  assert.equal(listed.ok,true);assert.deepEqual(listed.items.map(item=>[item.number,item.headRefName,item.baseRefName,item.state]),[[3,"cache","main","OPEN"]]);
  refuse=true;
  const refused=await withSourceControlExecutor(executor,()=>listPullRequests("/srv/app"));
  assert.deepEqual({ok:refused.ok,error:refused.error,items:refused.items},{ok:false,error:"ERROR: TF400813: The user is not authorized to access this resource.",items:[]});
});

test("Azure DevOps REST calls go through az devops invoke at API 7.1, with the route from the remote when az names no repository",async()=>{
  const executor=repositoryAt("https://dev.azure.com/acme/project/_git/widget",(command,args)=>{
    if(command==="az"&&args.slice(0,3).join(" ")==="repos pr show")return ok({pullRequestId:9});
    if(command==="az"&&args[0]==="devops"&&args[1]==="invoke")return ok({id:21});
    return null;
  });
  await withSourceControlExecutor(executor,()=>commentOnPullRequest("/srv/app",9,"New comment"));
  const [show,invoke]=executor.calls.filter(call=>call.command==="az");
  assert.deepEqual(show.args,["repos","pr","show","--id","9",...AZ_EVERY_CALL]);
  assert.deepEqual(invoke.args,["devops","invoke","--http-method","POST","--area","git","--resource","pullRequestThreads","--api-version","7.1",
    "--route-parameters","project=project","repositoryId=widget","pullRequestId=9","--in-file","/tmp/trebell-azure-request.json","--encoding","utf-8",...AZ_EVERY_CALL]);
  assert.deepEqual(executor.calls.find(call=>call.tempJson).tempJson,{comments:[{parentCommentId:0,content:"New comment",commentType:1}],status:1});
});

test("source-control diagnostics ask az account show for the signed-in user's name",async()=>{
  const executor=repositoryAt("https://dev.azure.com/acme/project/_git/widget",(command,args)=>{
    if(command==="az"&&args[0]==="--version")return ok("azure-cli 2.79.0\n");
    if(command==="az"&&args[0]==="account")return ok("dev@example.com\n");
    return null;
  },{more:{secretValues:async()=>({})}});
  const diagnostics=await withSourceControlExecutor(executor,()=>sourceControlDiagnostics("/srv/app"));
  assert.deepEqual(executor.calls.find(call=>call.command==="az"&&call.args[0]==="account").args,["account","show","--query","user.name","--output","tsv"]);
  assert.deepEqual([diagnostics.providers["azure-devops"].authenticated,diagnostics.providers["azure-devops"].detail],[true,"dev@example.com"]);
});

// A stack of three: #1 is merged, #2 and #3 are open. Only the open layers are rebased, #2 onto main's new tip and #3 onto #2's new head.
function stackRepository(layerThree,answer){
  const layer=(number,state,head,base,extra={})=>({number,title:"Layer "+number,state,head:{ref:"layer-"+number,sha:head},base:{ref:base[0],sha:base[1]},html_url:"https://github.com/acme/widget/pull/"+number,...extra});
  const stack={id:900,number:42,open:true,base:{ref:"main"},pull_requests:[layer(1,"closed","old1",["main","base0"],{merged_at:"2026-10-30T09:00:00Z"}),layer(2,"open","old2",["layer-1","old1"]),layerThree]};
  return repositoryAt("https://github.com/acme/widget.git",(command,args)=>{
    if(command==="gh"&&args[0]==="api"){
      const path=args.find(value=>String(value).startsWith("repos/acme/widget/"))||"";
      if(path==="repos/acme/widget/pulls/3")return ok({number:3,state:"open",head:{ref:"layer-3",sha:"old3"},base:{ref:"layer-2",sha:"old2"},stack:{number:42,size:3,position:3,base:{ref:"main",sha:"base0"}}});
      if(path==="repos/acme/widget/stacks/42")return ok(stack);
    }
    return command==="git"?answer(args):null;
  },{head:"layer-3"});
}
const stackLayer=(number,state,head,base)=>({number,title:"Layer "+number,state,head:{ref:"layer-"+number,sha:head},base:{ref:"layer-"+(number-1),sha:base},html_url:"https://github.com/acme/widget/pull/"+number});

test("a stack rebase fetches once, rebases only the open layers, and a refused push ends it at that layer with the ones below listed",async()=>{
  let heads=0;
  const executor=stackRepository(stackLayer(3,"open","old3","old2"),args=>{
    if(args[0]==="rev-parse"&&args[1]==="refs/remotes/origin/main")return ok("base-new\n");
    if(args[0]==="rev-parse"&&args[1]==="HEAD")return ok(["new2","new3"][heads++]+"\n");
    if(args[0]==="push"&&args.some(arg=>arg.includes("layer-3")))return {ok:false,code:1,stdout:"",stderr:"To https://github.com/acme/widget.git\n ! [rejected]        new3 -> layer-3 (stale info)\nerror: failed to push some refs to 'https://github.com/acme/widget.git'\n"};
    if(["fetch","worktree","checkout","rebase","push"].includes(args[0]))return ok("");
    return null;
  });
  await assert.rejects(()=>withSourceControlExecutor(executor,()=>rebasePullRequestStack("/srv/app",3,{provider:"github"})),error=>{
    assert.match(error.message,/^#3 could not be pushed, so it and the layers above it were not changed: /);assert.match(error.message,/\(stale info\)/);
    assert.deepEqual(error.updated,[{number:2,headRefName:"layer-2",oldHead:"old2",newHead:"new2"}]);
    return true;
  });
  const git=executor.calls.filter(call=>call.command==="git");
  assert.deepEqual(git.filter(call=>call.args[0]==="fetch").map(call=>call.args),[["fetch","origin","+refs/heads/main:refs/remotes/origin/main","+refs/heads/layer-2:refs/remotes/origin/layer-2","+refs/heads/layer-3:refs/remotes/origin/layer-3"]]);
  assert.deepEqual(git.filter(call=>call.args[0]==="rebase"&&call.args[1]==="--onto").map(call=>call.args.slice(2)),[["base-new","old1"],["new2","old2"]]);
  assert.deepEqual(git.filter(call=>call.args[0]==="push").map(call=>call.args),[["push","--force-with-lease=refs/heads/layer-2:old2","origin","new2:refs/heads/layer-2"],["push","--force-with-lease=refs/heads/layer-3:old3","origin","new3:refs/heads/layer-3"]]);
  assert.equal(git.some(call=>call.args[0]==="worktree"&&call.args[1]==="remove"),true,"the stack's worktree is removed");
});

test("a stack layer GitHub gave no head commit for stops the rebase before anything is fetched or pushed",async()=>{
  const executor=stackRepository(stackLayer(3,"open",null,"old2"),()=>ok(""));
  await assert.rejects(()=>withSourceControlExecutor(executor,()=>rebasePullRequestStack("/srv/app",3,{provider:"github"})),{message:"GitHub did not give its head commit for #3, so no layer of the stack was rebased."});
  assert.deepEqual(executor.calls.filter(call=>call.command==="git").map(call=>call.args[0]),[]);
});
