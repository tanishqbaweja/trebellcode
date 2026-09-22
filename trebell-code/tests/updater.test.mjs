import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root=new URL("../",import.meta.url);

test("packaged desktop updater requires explicit download and install",async()=>{
  const [main,preload,pkg,release]=await Promise.all([
    readFile(new URL("desktop/main.mjs",root),"utf8"),
    readFile(new URL("desktop/preload.cjs",root),"utf8"),
    readFile(new URL("package.json",root),"utf8").then(JSON.parse),
    readFile(new URL("scripts/make-windows-release.ps1",root),"utf8"),
  ]);
  assert.match(main,/autoUpdater\.autoDownload=false/);
  assert.match(main,/autoUpdater\.autoInstallOnAppQuit=false/);
  assert.match(main,/updaterState\.status!=="available"/);
  assert.match(main,/desktop:update:check/);assert.match(main,/desktop:update:download/);assert.match(main,/desktop:update:install/);
  assert.match(preload,/updates:\s*\{/);assert.match(preload,/desktop:update:state/);
  assert.equal(pkg.dependencies?.["electron-updater"],"^6.8.9");
  assert.deepEqual(pkg.build?.publish?.[0],{provider:"github",owner:"tanishqbaweja",repo:"trebellcode"});
  assert.match(release,/latest\.yml required by the in-app updater/);
  assert.match(release,/resources\\app-update\.yml required by electron-updater/);
  assert.match(release,/\$LatestYml/);assert.match(release,/\$Blockmap/);
});
