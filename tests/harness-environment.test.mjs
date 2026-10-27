// What an external harness (Claude Code, Codex, Cursor, Grok, OpenCode, Antigravity) starts with, beside the OS baseline and its own
// variables: the person's toolchain locations and proxy, as their terminal gives them, without a value that holds a credential.
// Native's command environment is what it was. Fixture values only: no real environment is read.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { codexAppServerEnvironment } from "../src/gui-server.mjs";
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

test("Native's command environment is what it was, with and without the toolchain: no proxy, no Claude Code switch",()=>{
  const parent=parentWith({CLAUDE_CODE_USE_BEDROCK:"1",AWS_REGION:"us-east-1",VERTEX_REGION_CLAUDE_4_6_SONNET:"europe-west1",http_proxy:"http://proxy:3128"});
  assert.deepEqual(buildRuntimeEnvironment("native",{parent,platform:"linux"}),{PATH:"/usr/local/bin:/usr/bin",HOME:"/home/me",LANG:"en_US.UTF-8"});
  assert.deepEqual(buildRuntimeEnvironment("native",{parent,platform:"linux",toolchain:true}),{PATH:"/usr/local/bin:/usr/bin",HOME:"/home/me",LANG:"en_US.UTF-8",...TOOLCHAIN});
  assert.deepEqual(buildRuntimeEnvironment("native",{parent:{Path:"C:\\Tools",https_proxy:"http://proxy:8080",Java_Home:"C:\\jdk"},platform:"win32",toolchain:true}),{PATH:"C:\\Tools",JAVA_HOME:"C:\\jdk"});
  for(const name of PROXY_NAMES)assert.equal(TOOLCHAIN_ENVIRONMENT_KEYS.includes(name),false,name);
});

test("the harness processes Trebell starts get them: Claude Code's sessions and checks, and the Codex app-server, with their homes from the profile",()=>{
  const env=parentWith({CLAUDE_CONFIG_DIR:"/home/me/.claude-elsewhere",CODEX_HOME:"/home/me/.codex"});
  const manager=new AgentRuntimeManager({state:{settings:()=>({})},platform:"linux",env});
  const claude=manager.childEnv({id:"claude-work",kind:"claude",homePath:"/home/me/.claude-work",approvedEnvironmentKeys:[],environment:{}});
  assert.equal(claude.CLAUDE_CONFIG_DIR,"/home/me/.claude-work","the profile's home, never the parent's");
  assert.equal(claude.JAVA_HOME,TOOLCHAIN.JAVA_HOME);assert.equal(claude.HTTPS_PROXY,PROXY.HTTPS_PROXY);
  assert.equal(claude.GITHUB_TOKEN,undefined);
  assert.equal(manager.childEnv({id:"claude-default",kind:"claude"}).CLAUDE_CONFIG_DIR,undefined,"no profile home: Claude Code's own default, not the parent's");
  const cursor=manager.childEnv({id:"cursor-default",kind:"cursor"});
  assert.equal(cursor.GOPATH,TOOLCHAIN.GOPATH);assert.equal(cursor.NO_PROXY,PROXY.NO_PROXY);assert.equal(cursor.CLAUDE_CONFIG_DIR,undefined);
  const appServer=codexAppServerEnvironment({env,platform:"linux",runtimeInstance:{kind:"codex",approvedEnvironmentKeys:[],environment:{}},runtimeHome:"/home/me/.codex-work"});
  assert.equal(appServer.CODEX_HOME,"/home/me/.codex-work");assert.equal(appServer.VIRTUAL_ENV,TOOLCHAIN.VIRTUAL_ENV);assert.equal(appServer.ALL_PROXY,PROXY.ALL_PROXY);
  assert.equal(appServer.GITHUB_TOKEN,undefined);assert.equal(appServer.CLAUDE_CONFIG_DIR,undefined);
});
