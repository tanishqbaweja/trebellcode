import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bundledCodexCandidates, bundledCodexPath, bundledCodexTarget } from "../desktop/bundled-codex.mjs";

const execFileAsync=promisify(execFile),root=fileURLToPath(new URL("../",import.meta.url));

test("packaged Codex resolver covers supported Windows macOS and Linux architectures",()=>{
  const expected=new Map([
    [["win32","x64"],["codex-win32-x64","x86_64-pc-windows-msvc","codex.exe"]],
    [["win32","arm64"],["codex-win32-arm64","aarch64-pc-windows-msvc","codex.exe"]],
    [["darwin","x64"],["codex-darwin-x64","x86_64-apple-darwin","codex"]],
    [["darwin","arm64"],["codex-darwin-arm64","aarch64-apple-darwin","codex"]],
    [["linux","x64"],["codex-linux-x64","x86_64-unknown-linux-musl","codex"]],
    [["linux","arm64"],["codex-linux-arm64","aarch64-unknown-linux-musl","codex"]],
  ]);
  for(const [[platform,arch],[packageName,triple,binary]] of expected){const target=bundledCodexTarget(platform,arch);assert.deepEqual(target,{packageName,triple,binary});const candidates=bundledCodexCandidates("/resources",{platform,arch});assert.equal(candidates.length,2);assert.match(candidates[0].replace(/\\/g,"/"),new RegExp(`/app\\.asar\\.unpacked/node_modules/@openai/${packageName}/vendor/${triple}/bin/${binary.replace(".","\\.")}$`))}
  assert.equal(bundledCodexTarget("freebsd","x64"),null);assert.throws(()=>bundledCodexPath("/resources",{platform:"freebsd",arch:"x64"}),/Unsupported packaged Codex target/);
  const selected=bundledCodexPath("/resources",{platform:"linux",arch:"x64",exists:path=>path.replace(/\\/g,"/").endsWith("/bin/codex")});assert.match(selected.replace(/\\/g,"/"),/codex-linux-x64\/vendor\/x86_64-unknown-linux-musl\/bin\/codex$/);
});

test("desktop packaging exposes native-host Windows macOS and Linux build targets",async()=>{
  const pkg=JSON.parse(await readFile(new URL("../package.json",import.meta.url),"utf8"));
  assert.equal(pkg.scripts["desktop:dist"],"npm run desktop:dist:windows");assert.match(pkg.scripts["desktop:dist:windows"],/--win nsis --x64/);assert.match(pkg.scripts["desktop:dist:mac"],/--mac dmg zip/);assert.match(pkg.scripts["desktop:dist:linux"],/--linux AppImage deb/);
  assert.deepEqual(pkg.build.mac,{target:["dmg","zip"],icon:"build/icon.icns",category:"public.app-category.developer-tools"});assert.deepEqual(pkg.build.linux,{target:["AppImage","deb"],icon:"build/icon.png",category:"Development"});
  for(const name of ["codex-win32-x64","codex-win32-arm64","codex-darwin-x64","codex-darwin-arm64","codex-linux-x64","codex-linux-arm64"])assert.ok(pkg.build.asarUnpack.includes(`node_modules/@openai/${name}/**/*`),`missing asarUnpack for ${name}`);
});

test("icon materialization emits PNG ICO and a structurally valid 256px ICNS",async()=>{
  await execFileAsync(process.execPath,[fileURLToPath(new URL("../scripts/materialize-icon.mjs",import.meta.url))],{cwd:root,windowsHide:true});
  const [png,ico,icns]=await Promise.all([readFile(new URL("../build/icon.png",import.meta.url)),readFile(new URL("../build/icon.ico",import.meta.url)),readFile(new URL("../build/icon.icns",import.meta.url))]);
  assert.equal(png.subarray(0,8).toString("hex"),"89504e470d0a1a0a");assert.equal(png.readUInt32BE(16),256);assert.equal(png.readUInt32BE(20),256);assert.equal(ico.readUInt16LE(2),1);
  assert.equal(icns.subarray(0,4).toString("ascii"),"icns");assert.equal(icns.readUInt32BE(4),icns.length);assert.equal(icns.subarray(8,12).toString("ascii"),"ic08");assert.equal(icns.readUInt32BE(12),icns.length-8);assert.deepEqual(icns.subarray(16),png);
});
