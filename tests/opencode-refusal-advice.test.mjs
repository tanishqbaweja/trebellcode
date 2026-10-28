import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";

// An OpenCode 1.x server of a profile's own (its server URL) that asks for a password refuses Trebell, which sends a password only to an
// OpenCode 1.x server it starts itself. Settings told the person to start that server without OPENCODE_SERVER_PASSWORD: the only lock
// on a server that runs tools and shell commands for whoever reaches its port, which a person who set one may have opened beyond this
// machine. The advice now leaves the password alone: check the server URL, or leave it empty so Trebell Code starts OpenCode itself.
// The server answers as OpenCode 1.18.32 refuses a wrong or missing password (an empty 401); the status check reads it through the
// real discovery, and only the profile's --version is answered here.
const ADVICE="The configured OpenCode server asks for a password, which Trebell Code sends only to an OpenCode 1.x server it starts itself. Check this profile's server URL, or leave it empty so Trebell Code starts OpenCode itself.";

test("an OpenCode 1.x server of the profile's own that asks for a password is not advised to run without it",async t=>{
  const server=createServer((_req,res)=>{res.writeHead(401);res.end()});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve)}));
  const home=await mkdtemp(join(tmpdir(),"trebell-opencode-refusal-advice-"));t.after(()=>rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const instance={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,binaryPath:join(home,"opencode"),serverUrl:`http://127.0.0.1:${server.address().port}`,environment:{OPENCODE_SERVER_PASSWORD:"the-servers-own-password"}};
  const settings={agentRuntime:"opencode",agentRuntimeInstanceId:"opencode-default",agentRuntimeInstances:[instance]};
  const manager=new AgentRuntimeManager({state:{settings:()=>settings},platform:"linux",env:{PATH:"",HOME:home,TREBELL_HOME:join(home,"trebell")},
    runFn:async(command,args)=>command===instance.binaryPath&&args[0]==="--version"?{ok:true,code:0,error:null,stdout:"1.18.32\n",stderr:""}:{ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""}});
  const status=await manager.probe("opencode",{fresh:true});
  assert.deepEqual([status.available,status.authenticated],[false,false]);
  assert.doesNotMatch(status.message,/without OPENCODE_SERVER_PASSWORD/,"the server's password is left alone");
  assert.equal(status.message,ADVICE);
});
