import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The browser tests import the server's modules from src/, which Node runs as written. Playwright's Babel transform of them only
// added a transpiled copy under TEMP, and Windows Defender quarantined the one of src/acp-session-config.mjs as
// Trojan:Script/ObfusScript.A!ml on every run that loaded it (from 2026-10-18), so ui/playwright.config.mjs keeps src/ out of
// the transform. Playwright's own file matcher decides here. The config loads in a child process with a hosted base URL, so it
// builds and starts nothing and sets no variable in this process.
const repoRoot=fileURLToPath(new URL("../",import.meta.url));
const expected={
  "src/acp-session-config.mjs":true,
  "src/codex-relay.mjs":true,
  "ui/src/App.jsx":false,
  "ui/e2e/native-background.spec.js":false,
  "ui/e2e/test-home.js":false,
};

test("the browser tests' runner leaves src/ untransformed and still transforms the UI and the specs",()=>{
  const script=`import {createRequire} from "node:module";import {join} from "node:path";import {pathToFileURL} from "node:url";
const {createFileMatcher}=createRequire(join(process.cwd(),"package.json"))("playwright/lib/util");
const config=(await import(pathToFileURL(join(process.cwd(),"ui","playwright.config.mjs")).href)).default;
const external=createFileMatcher(config.build?.external||[]);
const files=${JSON.stringify(Object.keys(expected))};
process.stdout.write("RESULT "+JSON.stringify(Object.fromEntries(files.map(file=>[file,external(join(process.cwd(),...file.split("/")))]))));`;
  const out=execFileSync(process.execPath,["--input-type=module","-e",script],{cwd:repoRoot,env:{...process.env,TREBELL_E2E_BASE_URL:"http://127.0.0.1:9"},encoding:"utf8",windowsHide:true});
  assert.deepEqual(JSON.parse(out.slice(out.lastIndexOf("RESULT ")+7)),expected);
});
