import { defineConfig } from "@playwright/test";

const hostedBaseUrl=String(process.env.TREBELL_E2E_BASE_URL||"").trim();

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  expect: { timeout: 5000 },
  use: {
    baseURL: hostedBaseUrl||"http://127.0.0.1:3210",
    viewport: { width: 1600, height: 980 },
    trace: "retain-on-failure",
  },
  webServer: hostedBaseUrl?undefined:{
    command: "TREBELL_GUI_MOCK=1 node src/gui-server.mjs --port 3210",
    cwd: new URL("../", import.meta.url).pathname,
    url: "http://127.0.0.1:3210/api/health",
    reuseExistingServer: false,
    timeout: 20000,
  },
  reporter: [["line"]],
});
