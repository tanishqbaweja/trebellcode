import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NO_ACCOUNT_SIGN_IN_MESSAGE, doctor, main, parseRunArgs, printHelp } from "../src/trebell.mjs";
import { codexArgs, codexChildEnvironment } from "../src/codex.mjs";
import { rebrandTerminalChunk } from "../src/branding.mjs";
import { trebellHome, codexHome } from "../src/paths.mjs";
import { MODEL_PROVIDERS } from "../src/provider-manager.mjs";

async function captureConsole(fn){
  const logs=[],errors=[],originalLog=console.log,originalError=console.error,previousExitCode=process.exitCode;
  console.log=(...items)=>{logs.push(items.join(" "))};console.error=(...items)=>{errors.push(items.join(" "))};
  try{return {result:await fn(),logs,errors}}
  finally{console.log=originalLog;console.error=originalError;process.exitCode=previousExitCode}
}

test("Trebell paths are isolated from ~/.codex", t => {
  const root = mkdtempSync(join(tmpdir(), "trebell-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, TREBELL_HOME: root };
  assert.equal(trebellHome(env), root);
  assert.equal(codexHome(env), join(root, "codex"));
});

test("run arg parser keeps runtime arguments while consuming Trebell utility flags", () => {
  assert.deepEqual(
    parseRunArgs(["--model", "gpt-5.6-sol", "--", "exec", "hello"]),
    { model: "gpt-5.6-sol", provider: null, forwarded: ["exec", "hello"] },
  );
  assert.deepEqual(parseRunArgs(["--provider", " AgentRouter "]), { model: null, provider: "agentrouter", forwarded: [] });
  assert.throws(()=>parseRunArgs(["--provider"]),/--provider requires a provider id/);
  assert.throws(()=>parseRunArgs(["--provider","retired-provider"]),/Unknown provider "retired-provider"\. Choose one of: openai, anthropic, gemini, agentrouter, justworker, hcnsec, vyceai\./);
});

test("CLI help lists only the API-key model providers and no account sign-in commands",async()=>{
  const {logs}=await captureConsole(()=>printHelp());
  const help=logs.join("\n");
  assert.match(help,new RegExp(`--provider <id>\\s+${Object.keys(MODEL_PROVIDERS).join("\\|")} \\(default: the selected Native provider, else openai\\)`));
  assert.doesNotMatch(help,/trebell (?:login|signup|logout)|--port|--no-login-check|bridge/i);
});

test("CLI login, signup and logout explain the missing account sign-in without invoking Codex",async()=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-cli-sign-in-")),previousBin=process.env.TREBELL_CODEX_BIN,previousHome=process.env.TREBELL_HOME;
  // A missing Codex binary makes any accidental pass-through reject instead of resolving.
  process.env.TREBELL_CODEX_BIN=join(root,"codex-must-not-run");
  // The CLI cleans the Trebell home on startup: never let a test run touch the real one.
  process.env.TREBELL_HOME=join(root,"home");
  try{
    for(const command of ["login","signup","logout"]){
      const {result,logs,errors}=await captureConsole(()=>main([command,"--force"]));
      assert.equal(result,1,command);
      assert.deepEqual(errors,[NO_ACCOUNT_SIGN_IN_MESSAGE],command);
      assert.equal(logs.some(line=>/harness: Codex/.test(line)),false,command+" must not launch the Codex harness");
    }
    assert.equal(NO_ACCOUNT_SIGN_IN_MESSAGE,'Trebell Code has no account sign-in of its own. Add a model provider API key in Settings → Agents & models (or set OPENAI_API_KEY), or run "codex login" to sign in to the Codex harness.');
  }finally{
    if(previousBin===undefined)delete process.env.TREBELL_CODEX_BIN;else process.env.TREBELL_CODEX_BIN=previousBin;
    if(previousHome===undefined)delete process.env.TREBELL_HOME;else process.env.TREBELL_HOME=previousHome;
    rmSync(root,{recursive:true,force:true});
  }
});

test("doctor checks only the local runtime and treats every check as required",async()=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-doctor-"));
  try{
    const healthy=await captureConsole(()=>doctor({TREBELL_HOME:root,TREBELL_CODEX_BIN:join(root,"codex")}));
    assert.equal(healthy.result,0);
    assert.deepEqual(healthy.logs.map(line=>line.replace(/:.*$/,"")),["✓ Node >= 22","✓ Trebell home","✓ Codex runtime"]);
    const missingHome=await captureConsole(()=>doctor({TREBELL_HOME:join(root,"missing"),TREBELL_CODEX_BIN:join(root,"codex")}));
    assert.equal(missingHome.result,1);
    assert.ok(missingHome.logs.some(line=>line.startsWith("✗ Trebell home")));
  }finally{rmSync(root,{recursive:true,force:true})}
});

test("models command defaults to the OpenAI provider and needs its API key",async()=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-cli-models-")),keys=["TREBELL_HOME",...Object.values(MODEL_PROVIDERS).flatMap(provider=>provider.envKeys||[provider.envKey])],saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  for(const key of keys)delete process.env[key];process.env.TREBELL_HOME=root;
  try{
    await assert.rejects(()=>captureConsole(()=>main(["models"])),/No API key is configured for OpenAI API\. Add one in Settings → Agents & models or set OPENAI_API_KEY\./);
    await assert.rejects(()=>captureConsole(()=>main(["models","--provider","hcnsec"])),/No API key is configured for HCNSec\.cn/);
  }finally{
    for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;
    rmSync(root,{recursive:true,force:true});
  }
});

test("Codex args preserve Codex native provider configuration", () => {
  assert.deepEqual(
    codexArgs({ model: "gpt-5.6-sol", forwarded: ["exec", "hi"] }),
    ["-m", "gpt-5.6-sol", "exec", "hi"],
  );
  assert.throws(()=>codexArgs({provider:"openai"}),/native account\/provider configuration/i);
});

test("standalone Codex inherited process stays hidden on Windows",()=>{
  const source=readFileSync(new URL("../src/codex.mjs",import.meta.url),"utf8");
  assert.match(source,/stdio:\s*"inherit"[\s\S]{0,120}windowsHide:\s*true/);
  assert.doesNotMatch(source,/windowsHide:\s*false/);
});

test("standalone Codex child environment preserves Codex-native credentials without unrelated host secrets",t=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-codex-env-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const env=codexChildEnvironment({
    PATH:process.env.PATH||"/usr/bin",
    HOME:root,
    USERPROFILE:root,
    TREBELL_HOME:root,
    CODEX_HOME:join(root,"native-codex-home"),
    OPENAI_API_KEY:"codex-openai-token",
    CODEX_API_KEY:"codex-native-token",
    GITHUB_TOKEN:"unrelated-secret",
    CUSTOM_PRIVATE_TOKEN:"hidden",
  });
  assert.equal(env.PATH,process.env.PATH||"/usr/bin");
  assert.equal(env.HOME,root);
  assert.equal(env.CODEX_HOME,join(root,"native-codex-home"));
  assert.equal(env.OPENAI_API_KEY,"codex-openai-token");
  assert.equal(env.CODEX_API_KEY,"codex-native-token");
  assert.equal(env.GITHUB_TOKEN,undefined);
  assert.equal(env.CUSTOM_PRIVATE_TOKEN,undefined);
});

test("terminal branding removes upstream product name from visible banner", () => {
  assert.equal(rebrandTerminalChunk(">_ OpenAI Codex\n"), ">_ Trebell Code\n");
  assert.equal(rebrandTerminalChunk("run codex now"), "run trebell now");
});
