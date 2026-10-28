import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MODEL_PROVIDERS } from "../src/provider-manager.mjs";

// The browser tests' own mock server (ui/playwright.config.mjs, webServer) starts with every official model provider's key
// variable blank, so a key set in the shell that runs the tests never reaches it: each provider reads as needing a key until a
// spec saves one (ui/e2e/native-xai-meta-providers.spec.js), whatever the machine has set. The config loads in a child process
// as a test worker loads it, with a fixed port, so it builds, starts and removes nothing.
const repoRoot=fileURLToPath(new URL("../",import.meta.url));
const officialKeyNames=Object.values(MODEL_PROVIDERS).filter(provider=>provider.official).flatMap(provider=>provider.envKeys||[provider.envKey]);

test("the browser tests' mock server gets no official model provider's key from the shell that runs them",()=>{
  assert.deepEqual(officialKeyNames,["OPENAI_API_KEY","ANTHROPIC_API_KEY","GEMINI_API_KEY","GOOGLE_API_KEY","XAI_API_KEY","META_API_KEY"]);
  const script=`import {join} from "node:path";import {pathToFileURL} from "node:url";
const config=(await import(pathToFileURL(join(process.cwd(),"ui","playwright.config.mjs")).href)).default;
const env=config.webServer?.env||null,names=${JSON.stringify(officialKeyNames)};
process.stdout.write("RESULT "+JSON.stringify(env?{mock:env.TREBELL_GUI_MOCK,keys:Object.fromEntries(names.map(name=>[name,env[name]??null]))}:null));`;
  const shell=Object.fromEntries(officialKeyNames.map(name=>[name,"shell-"+name.toLowerCase()]));
  const env={...process.env,...shell,TEST_WORKER_INDEX:"0",TREBELL_E2E_BASE_URL:"",TREBELL_E2E_PORT:"3210"};
  const out=execFileSync(process.execPath,["--input-type=module","-e",script],{cwd:repoRoot,env,encoding:"utf8",windowsHide:true});
  const server=JSON.parse(out.slice(out.lastIndexOf("RESULT ")+7));
  assert.ok(server,"the config starts its own mock server");
  assert.equal(server.mock,"1");
  assert.deepEqual(server.keys,Object.fromEntries(officialKeyNames.map(name=>[name,""])));
});
