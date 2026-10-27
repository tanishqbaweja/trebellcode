import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";

// A profile's own OpenCode server (its serverUrl) that refuses Trebell, answered as the real servers answer a wrong or missing
// password (T3 Code's recorded probe responses): OpenCode 1.18.32 with an empty 401 on every path, OpenCode 2.x with
// {"_tag":"UnauthorizedError","message":"Authentication required"}. Neither says Unauthorized or a status in words, and the SDK clients
// keep the status apart from the message, so only the status or the error's tag tells a refusal. The status check reads the server
// through the real discovery (no stand-in reader); only the profile's --version is answered here.
async function refusingServer(t,{generation}){
  const server=createServer((req,res)=>{
    if(generation===2&&req.url.startsWith("/api/")){res.writeHead(401,{"content-type":"application/json"});res.end(JSON.stringify({_tag:"UnauthorizedError",message:"Authentication required"}));return}
    res.writeHead(401);res.end();
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve)}));
  return `http://127.0.0.1:${server.address().port}`;
}
async function profileOn(t,{version,serverUrl}){
  const home=await mkdtemp(join(tmpdir(),"trebell-opencode-refusal-"));t.after(()=>rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const instance={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,binaryPath:join(home,"opencode"),serverUrl,environment:{OPENCODE_SERVER_PASSWORD:"not-the-password"}};
  const settings={agentRuntime:"opencode",agentRuntimeInstanceId:"opencode-default",agentRuntimeInstances:[instance]};
  return new AgentRuntimeManager({state:{settings:()=>settings},platform:"linux",env:{PATH:"",HOME:home,TREBELL_HOME:join(home,"trebell")},
    runFn:async(command,args)=>command===instance.binaryPath&&args[0]==="--version"?{ok:true,code:0,error:null,stdout:version+"\n",stderr:""}:{ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""}});
}

test("an OpenCode 2 server of the profile's own that refuses the password is said to, from OpenCode's UnauthorizedError",async t=>{
  const manager=await profileOn(t,{version:"2.0.24",serverUrl:await refusingServer(t,{generation:2})});
  const status=await manager.probe("opencode",{fresh:true});
  assert.deepEqual([status.available,status.authenticated,status.message],[false,false,"The configured OpenCode server rejected the password. Check this profile's server URL and the OPENCODE_SERVER_PASSWORD in its environment."]);
});

test("an OpenCode 1.x server of the profile's own that answers with an empty 401 is said to ask for a password Trebell does not send it",async t=>{
  const manager=await profileOn(t,{version:"1.18.32",serverUrl:await refusingServer(t,{generation:1})});
  const status=await manager.probe("opencode",{fresh:true});
  // Trebell sends no password to an OpenCode 1.x server it did not start, so the profile's OPENCODE_SERVER_PASSWORD would not help.
  assert.deepEqual([status.available,status.authenticated,status.message],[false,false,"The configured OpenCode server asks for a password, which Trebell Code sends only to an OpenCode 1.x server it starts itself. Check this profile's server URL, or start that server without OPENCODE_SERVER_PASSWORD."]);
});

test("an OpenCode server of the profile's own that is not there is not taken for a refusal",async t=>{
  const closed=createServer();await new Promise(resolve=>closed.listen(0,"127.0.0.1",resolve));const port=closed.address().port;await new Promise(resolve=>closed.close(resolve));
  for(const version of ["1.18.32","2.0.24"]){
    const status=await (await profileOn(t,{version,serverUrl:`http://127.0.0.1:${port}`})).probe("opencode",{fresh:true});
    assert.equal(status.authenticated,null,version);assert.match(status.message,/^OpenCode could not list its providers: /,version);
  }
});
