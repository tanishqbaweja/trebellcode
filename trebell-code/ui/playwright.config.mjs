import { defineConfig } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const hostedBaseUrl=String(process.env.TREBELL_E2E_BASE_URL||"").trim();
const browserChannel=String(process.env.TREBELL_E2E_BROWSER_CHANNEL||"").trim();
const localTestHome=fileURLToPath(new URL("../test-results/e2e-home/",import.meta.url));
if(process.platform==="win32"&&process.env.COMSPEC) process.env.COMSPEC=process.env.COMSPEC.trim();
if(!hostedBaseUrl){
  rmSync(localTestHome,{recursive:true,force:true});
  mkdirSync(localTestHome,{recursive:true});
}

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  expect: { timeout: 5000 },
  use: {
    baseURL: hostedBaseUrl||"http://127.0.0.1:3210",
    viewport: { width: 1600, height: 980 },
    trace: "retain-on-failure",
    ...(browserChannel?{channel:browserChannel}:{}),
  },
  webServer: hostedBaseUrl?undefined:{
    command: "node src/gui-server.mjs --port 3210",
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env:{...process.env,TREBELL_GUI_MOCK:"1",TREBELL_HOME:localTestHome},
    url: "http://127.0.0.1:3210/api/health",
    reuseExistingServer: false,
    timeout: 20000,
  },
  reporter: [["line"]],
});
