// What an external harness (Claude Code, Codex, Cursor, Grok, OpenCode, Antigravity) starts with, beside the OS baseline and its own
// variables: the person's toolchain locations and proxy, as their terminal gives them, without a value that holds a credential, and
// for Claude Code its cloud-provider switches with their region, profile, project and model names. Native's command environment is
// what it was. Fixture values only: no real environment is read.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { codexAppServerEnvironment } from "../src/gui-server.mjs";
import { remoteEnvironmentCommand } from "../src/environment-manager.mjs";
import { buildRuntimeEnvironment, TOOLCHAIN_ENVIRONMENT_KEYS } from "../src/runtime-environment.mjs";

const PROXY_NAMES=["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY","http_proxy","https_proxy","all_proxy","no_proxy"];

const TOOLCHAIN={JAVA_HOME:"/opt/java/openjdk",GOPATH:"/home/me/go",VIRTUAL_ENV:"/home/me/project/.venv",CARGO_HOME:"/home/me/.cargo",NVM_DIR:"/home/me/.nvm",PNPM_HOME:"/home/me/.local/share/pnpm"};
const PROXY={HTTPS_PROXY:"http://proxy:8080",NO_PROXY:"localhost,127.0.0.1,.corp.example",ALL_PROXY:"socks5://proxy:1080"};
const SECRETS={GITHUB_TOKEN:"ghp_fixture",AWS_SECRET_ACCESS_KEY:"fixture-aws-secret",CI_DEPLOY_TOKEN:"fixture-deploy",TREBELL_INTERNAL_SECRET:"fixture-trebell"};
const parentWith=extra=>({PATH:"/usr/local/bin:/usr/bin",HOME:"/home/me",LANG:"en_US.UTF-8",...TOOLCHAIN,...PROXY,...SECRETS,...extra});
const HARNESSES=["claude","codex","cursor","grok","opencode","antigravity"];

test("Claude Code, Codex, Cursor and the other harnesses start with the person's toolchain and proxy, and no unrelated secret",()=>{
  for(const kind of HARNESSES){
    const env=buildRuntimeEnvironment(kind,{parent:parentWith({}),platform:"linux"});
    assert.equal(env.PATH,"/usr/local/bin:/usr/bin",kind);assert.equal(env.HOME,"/home/me",kind);
    for(const [name,value] of Object.entries({...TOOLCHAIN,...PROXY}))assert.equal(env[name],value,`${kind} ${name}`);
    for(const name of Object.keys(SECRETS))if(!(kind==="opencode"&&name==="AWS_SECRET_ACCESS_KEY"))assert.equal(env[name],undefined,`${kind} ${name}`);
  }
});

test("a proxy that holds a user name or password reaches a harness only when its profile approves that name",()=>{
  const parent=parentWith({HTTPS_PROXY:"http://user:pass@proxy:8080",HTTP_PROXY:"user:pass@proxy:8080",https_proxy:"http://ghp_fixture@proxy:8080",http_proxy:"http://proxy:3128",ALL_PROXY:"socks5://user:pass@proxy:1080"});
  for(const kind of ["claude","codex","cursor"]){
    const env=buildRuntimeEnvironment(kind,{parent,platform:"linux"});
    for(const name of ["HTTPS_PROXY","HTTP_PROXY","https_proxy","ALL_PROXY"])assert.equal(env[name],undefined,`${kind} ${name}`);
    assert.equal(env.http_proxy,"http://proxy:3128",`${kind}: the lower-case spelling is its own variable off Windows`);
    assert.equal(env.NO_PROXY,PROXY.NO_PROXY,kind);
    const approved=buildRuntimeEnvironment(kind,{parent,approved:["HTTPS_PROXY"],platform:"linux"});
    assert.equal(approved.HTTPS_PROXY,"http://user:pass@proxy:8080",`${kind}: approved`);assert.equal(approved.HTTP_PROXY,undefined,kind);
  }
  // A toolchain value with a credential in it stays out of a harness as it does of Native's commands.
  const env=buildRuntimeEnvironment("claude",{parent:parentWith({RUSTUP_DIST_SERVER:"https://user:pass@mirror.example/rustup",GOFLAGS:"-mod=mod"}),platform:"linux"});
  assert.equal(env.RUSTUP_DIST_SERVER,undefined);assert.equal(env.GOFLAGS,"-mod=mod");
});

test("on Windows a harness gets each proxy once, whatever its spelling, and its toolchain whatever the case",()=>{
  const env=buildRuntimeEnvironment("claude",{parent:{Path:"C:\\Tools",USERPROFILE:"C:\\Users\\me",https_proxy:"http://proxy:8080",Http_Proxy:"http://user:pass@proxy:8080",No_Proxy:"localhost",Java_Home:"C:\\jdk-21",GITHUB_TOKEN:"fixture"},platform:"win32"});
  assert.deepEqual(env,{PATH:"C:\\Tools",USERPROFILE:"C:\\Users\\me",JAVA_HOME:"C:\\jdk-21",HTTPS_PROXY:"http://proxy:8080",NO_PROXY:"localhost"});
  const approved=buildRuntimeEnvironment("codex",{parent:{Path:"C:\\Tools",https_proxy:"http://user:pass@proxy:8080"},approved:["https_proxy"],platform:"win32"});
  assert.deepEqual(approved,{PATH:"C:\\Tools",https_proxy:"http://user:pass@proxy:8080"});
});

test("Claude Code gets its cloud-provider switches and their region, profile, project and model names, and not the providers' secrets",()=>{
  const providers={
    CLAUDE_CODE_USE_BEDROCK:"1",CLAUDE_CODE_USE_VERTEX:"1",CLAUDE_CODE_USE_FOUNDRY:"1",CLAUDE_CODE_USE_MANTLE:"1",CLAUDE_CODE_SKIP_BEDROCK_AUTH:"1",
    AWS_REGION:"us-east-1",AWS_PROFILE:"bedrock-dev",ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION:"us-west-2",ANTHROPIC_BEDROCK_BASE_URL:"https://gateway.example/bedrock",
    ANTHROPIC_VERTEX_PROJECT_ID:"vertex-project",CLOUD_ML_REGION:"global",VERTEX_REGION_CLAUDE_4_6_SONNET:"europe-west1",VERTEX_REGION_CLAUDE_5_5_OPUS:"us-east5",
    ANTHROPIC_FOUNDRY_RESOURCE:"my-resource",ANTHROPIC_DEFAULT_OPUS_MODEL:"us.anthropic.claude-opus-4-8",ANTHROPIC_DEFAULT_HAIKU_MODEL:"claude-haiku-4-5",ANTHROPIC_MODEL:"claude-opus-4-8",
  };
  const secrets={AWS_ACCESS_KEY_ID:"AKIAFIXTURE",AWS_SECRET_ACCESS_KEY:"fixture-secret",AWS_SESSION_TOKEN:"fixture-session",AWS_BEARER_TOKEN_BEDROCK:"fixture-bedrock-key",
    ANTHROPIC_FOUNDRY_API_KEY:"fixture-foundry-key",ANTHROPIC_FOUNDRY_AUTH_TOKEN:"fixture-foundry-token",ANTHROPIC_AWS_API_KEY:"fixture-aws-platform",ANTHROPIC_CUSTOM_HEADERS:"Authorization: Bearer fixture"};
  const parent={PATH:"/usr/bin",HOME:"/home/me",...providers,...secrets};
  const claude=buildRuntimeEnvironment("claude",{parent,platform:"linux"});
  for(const [name,value] of Object.entries(providers))assert.equal(claude[name],value,name);
  for(const name of Object.keys(secrets))assert.equal(claude[name],undefined,name);
  // The person can still approve one, as any other name.
  assert.equal(buildRuntimeEnvironment("claude",{parent,approved:["AWS_SECRET_ACCESS_KEY"],platform:"linux"}).AWS_SECRET_ACCESS_KEY,"fixture-secret");
  // They are Claude Code's: Codex and Cursor do not get them.
  for(const kind of ["codex","cursor"]){const env=buildRuntimeEnvironment(kind,{parent,platform:"linux"});for(const name of ["CLAUDE_CODE_USE_BEDROCK","VERTEX_REGION_CLAUDE_4_6_SONNET","ANTHROPIC_VERTEX_PROJECT_ID"])assert.equal(env[name],undefined,`${kind} ${name}`)}
});

// `claude auth status` answers for the provider its switch names: Claude Code 2.1.311 in a home of its own said
// {"loggedIn":true,"authMethod":"third_party","apiProvider":"bedrock"} with CLAUDE_CODE_USE_BEDROCK=1 (and the same for "vertex" and
// "foundry" with their switches), and {"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"} (exit 1) without one
// (live check, 2026-10-27).
test("a Claude Code profile that runs on Amazon Bedrock from the shell reads signed in: its status check gets the switch and the region",async t=>{
  const home=mkdtempSync(join(tmpdir(),"trebell-harness-env-"));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const binary=join(home,"claude");writeFileSync(binary,"claude build 1");
  const calls=[],settings={agentRuntime:"claude",agentRuntimeInstances:[{id:"claude-default",kind:"claude",binaryPath:binary,environment:{}}]};
  const runFn=async(_command,args,options)=>{
    calls.push({args:args.join(" "),env:options.env});
    if(args[0]==="--version")return {ok:true,code:0,error:null,stdout:"2.1.310 (Claude Code)\n",stderr:""};
    return options.env.CLAUDE_CODE_USE_BEDROCK==="1"
      ?{ok:true,code:0,error:null,stdout:JSON.stringify({loggedIn:true,authMethod:"third_party",apiProvider:"bedrock"}),stderr:""}
      :{ok:false,code:1,error:null,stdout:JSON.stringify({loggedIn:false,authMethod:"none",apiProvider:"firstParty"}),stderr:""};
  };
  const manager=new AgentRuntimeManager({state:{settings:()=>settings},platform:"linux",env:{PATH:"/usr/bin",HOME:home,TREBELL_HOME:join(home,"trebell"),CLAUDE_CODE_USE_BEDROCK:"1",AWS_REGION:"us-east-1",AWS_PROFILE:"bedrock-dev",AWS_SECRET_ACCESS_KEY:"fixture-secret"},runFn});
  const status=await manager.probe("claude");
  assert.deepEqual([status.installed,status.available,status.authenticated],[true,true,true],status.message);
  const auth=calls.find(call=>call.args==="auth status");
  assert.deepEqual([auth.env.CLAUDE_CODE_USE_BEDROCK,auth.env.AWS_REGION,auth.env.AWS_PROFILE,auth.env.AWS_SECRET_ACCESS_KEY],["1","us-east-1","bedrock-dev",undefined]);
});

// A host's harness gets its listed names through env -i as NAME="${NAME-}", the host's own value or an empty one where the host sets
// none, so the cloud-provider and model names stay with Claude Code on this machine: on a host, an empty ANTHROPIC_MODEL or
// AWS_PROFILE is not an unset one.
test("a Claude Code on an SSH or WSL host gets the names it always had, not the cloud-provider and model names as empty variables",async()=>{
  const OPTIONAL=["CLAUDE_CODE_USE_BEDROCK","CLAUDE_CODE_SKIP_VERTEX_AUTH","AWS_REGION","AWS_PROFILE","ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION","ANTHROPIC_MODEL","ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES","CLOUD_ML_REGION","GOOGLE_APPLICATION_CREDENTIALS","ANTHROPIC_FOUNDRY_RESOURCE"];
  const profile={id:"ssh-claude",type:"ssh",cwd:"/srv/app"},sent=[];
  const environments={get:id=>id===profile.id?profile:null,spawnArgv:()=>{throw new Error("nothing is started on the host")},
    executeArgv:async(_id,{command,args,environmentNames})=>{sent.push(remoteEnvironmentCommand([command,...args].join(" "),environmentNames));return args[0]==="auth"?{exitCode:0,stdout:JSON.stringify({loggedIn:true}),stderr:""}:{exitCode:0,stdout:"2.1.311 (Claude Code)\n",stderr:""}}};
  const manager=new AgentRuntimeManager({state:{settings:()=>({activeEnvironmentId:profile.id})},environments,platform:"linux",env:{PATH:"/usr/bin",HOME:"/home/me",CLAUDE_CODE_USE_BEDROCK:"1",AWS_PROFILE:"bedrock-dev"}});
  await manager.probe("claude");
  assert.equal(sent.length,2,"its version and sign-in checks");
  for(const command of sent){
    for(const name of OPTIONAL)assert.equal(command.includes(`${name}="\${${name}-}"`),false,`${name} in ${command.slice(0,80)}`);
    for(const name of ["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN","ANTHROPIC_BASE_URL","PATH","HOME"])assert.ok(command.includes(`${name}="\${${name}-}"`),name);
  }
  // Its sessions there get the same names, and a name the profile approves goes as any approved name does.
  const names=manager.childEnvironmentKeys({id:"claude-default",kind:"claude"});
  assert.deepEqual(OPTIONAL.filter(name=>names.includes(name)),[]);
  assert.ok(manager.childEnvironmentKeys({id:"claude-bedrock",kind:"claude",approvedEnvironmentKeys:["AWS_PROFILE"]}).includes("AWS_PROFILE"));
  // On this machine Claude Code still gets the ones Trebell's environment sets, and no empty one.
  const local=buildRuntimeEnvironment("claude",{parent:{PATH:"/usr/bin",CLAUDE_CODE_USE_BEDROCK:"1",AWS_REGION:"us-east-1",ANTHROPIC_MODEL:""},platform:"linux"});
  assert.deepEqual(local,{PATH:"/usr/bin",CLAUDE_CODE_USE_BEDROCK:"1",AWS_REGION:"us-east-1"});
});

test("Native's command environment is what it was, with and without the toolchain: no proxy, no Claude Code switch",()=>{
  const parent=parentWith({CLAUDE_CODE_USE_BEDROCK:"1",AWS_REGION:"us-east-1",VERTEX_REGION_CLAUDE_4_6_SONNET:"europe-west1",http_proxy:"http://proxy:3128"});
  assert.deepEqual(buildRuntimeEnvironment("native",{parent,platform:"linux"}),{PATH:"/usr/local/bin:/usr/bin",HOME:"/home/me",LANG:"en_US.UTF-8"});
  assert.deepEqual(buildRuntimeEnvironment("native",{parent,platform:"linux",toolchain:true}),{PATH:"/usr/local/bin:/usr/bin",HOME:"/home/me",LANG:"en_US.UTF-8",...TOOLCHAIN});
  assert.deepEqual(buildRuntimeEnvironment("native",{parent:{Path:"C:\\Tools",https_proxy:"http://proxy:8080",Java_Home:"C:\\jdk"},platform:"win32",toolchain:true}),{PATH:"C:\\Tools",JAVA_HOME:"C:\\jdk"});
  for(const name of PROXY_NAMES)assert.equal(TOOLCHAIN_ENVIRONMENT_KEYS.includes(name),false,name);
});

test("the harness processes Trebell starts get them: Claude Code's sessions and checks, and the Codex app-server, with their homes from the profile",()=>{
  const env=parentWith({CLAUDE_CONFIG_DIR:"/home/me/.claude-elsewhere",CODEX_HOME:"/home/me/.codex",CLAUDE_CODE_USE_VERTEX:"1",CLOUD_ML_REGION:"global"});
  const manager=new AgentRuntimeManager({state:{settings:()=>({})},platform:"linux",env});
  const claude=manager.childEnv({id:"claude-work",kind:"claude",homePath:"/home/me/.claude-work",approvedEnvironmentKeys:[],environment:{}});
  assert.equal(claude.CLAUDE_CONFIG_DIR,"/home/me/.claude-work","the profile's home, never the parent's");
  assert.equal(claude.JAVA_HOME,TOOLCHAIN.JAVA_HOME);assert.equal(claude.HTTPS_PROXY,PROXY.HTTPS_PROXY);assert.equal(claude.CLAUDE_CODE_USE_VERTEX,"1");assert.equal(claude.CLOUD_ML_REGION,"global");
  assert.equal(claude.GITHUB_TOKEN,undefined);
  assert.equal(manager.childEnv({id:"claude-default",kind:"claude"}).CLAUDE_CONFIG_DIR,undefined,"no profile home: Claude Code's own default, not the parent's");
  const cursor=manager.childEnv({id:"cursor-default",kind:"cursor"});
  assert.equal(cursor.GOPATH,TOOLCHAIN.GOPATH);assert.equal(cursor.NO_PROXY,PROXY.NO_PROXY);assert.equal(cursor.CLAUDE_CONFIG_DIR,undefined);
  const appServer=codexAppServerEnvironment({env,platform:"linux",runtimeInstance:{kind:"codex",approvedEnvironmentKeys:[],environment:{}},runtimeHome:"/home/me/.codex-work"});
  assert.equal(appServer.CODEX_HOME,"/home/me/.codex-work");assert.equal(appServer.VIRTUAL_ENV,TOOLCHAIN.VIRTUAL_ENV);assert.equal(appServer.ALL_PROXY,PROXY.ALL_PROXY);
  assert.equal(appServer.GITHUB_TOKEN,undefined);assert.equal(appServer.CLAUDE_CONFIG_DIR,undefined);
});
