import test from "node:test";
import assert from "node:assert/strict";
import { win32 } from "node:path";
import { EDITOR_SPECS, discoverEditors, resolveEditorExecutable } from "../desktop/editor-discovery.mjs";

const missingCommand=async()=>null;
const dir=name=>({name,isDirectory:()=>true});

test("editor discovery covers the broader desktop editor set",()=>{
  const ids=new Set(EDITOR_SPECS.map(item=>item.id));
  for(const id of ["cursor","trae","kiro","vscode","vscodium","windsurf","zed","antigravity","idea","aqua","clion","datagrip","dataspell","goland","phpstorm","pycharm","rider","rubymine","rustrover","webstorm"])assert.equal(ids.has(id),true,id);
});

test("Windows editor discovery finds normal GUI installs even when PATH has no launcher",async()=>{
  const env={LOCALAPPDATA:"C:\\Users\\dev\\AppData\\Local",ProgramFiles:"C:\\Program Files"};
  const expected=win32.join(env.LOCALAPPDATA,"Programs","Microsoft VS Code","Code.exe");
  const spec=EDITOR_SPECS.find(item=>item.id==="vscode");
  const resolved=await resolveEditorExecutable(spec,{platform:"win32",env,commandFinder:missingCommand,exists:path=>path===expected,readDirectory:()=>[]});
  assert.equal(resolved,expected);
});

test("Windows JetBrains discovery scans versioned install directories outside PATH",async()=>{
  const env={LOCALAPPDATA:"C:\\Users\\dev\\AppData\\Local",ProgramFiles:"C:\\Program Files"};
  const jetbrains=win32.join(env.ProgramFiles,"JetBrains");
  const expected=win32.join(jetbrains,"IntelliJ IDEA 2026.2","bin","idea64.exe");
  const spec=EDITOR_SPECS.find(item=>item.id==="idea");
  const resolved=await resolveEditorExecutable(spec,{
    platform:"win32",env,commandFinder:missingCommand,
    exists:path=>path===expected,
    readDirectory:path=>path===jetbrains?[dir("IntelliJ IDEA 2026.2")]:[],
  });
  assert.equal(resolved,expected);
});

test("Windows JetBrains discovery reaches bounded Toolbox app installs",async()=>{
  const env={LOCALAPPDATA:"C:\\Users\\dev\\AppData\\Local"};
  const root=win32.join(env.LOCALAPPDATA,"JetBrains","Toolbox","apps");
  const a=win32.join(root,"IDEA-U"),b=win32.join(a,"ch-0"),version=win32.join(b,"262.100"),bin=win32.join(version,"bin");
  const expected=win32.join(bin,"idea64.exe");
  const map=new Map([[root,[dir("IDEA-U")]],[a,[dir("ch-0")]],[b,[dir("262.100")]],[version,[dir("bin")]],[bin,[]]]);
  const spec=EDITOR_SPECS.find(item=>item.id==="idea");
  const resolved=await resolveEditorExecutable(spec,{platform:"win32",env,commandFinder:missingCommand,exists:path=>path===expected,readDirectory:path=>map.get(path)||[]});
  assert.equal(resolved,expected);
});

test("editor discovery still prefers a real PATH launcher when available",async()=>{
  const spec=EDITOR_SPECS.find(item=>item.id==="zed");
  const resolved=await resolveEditorExecutable(spec,{platform:"linux",env:{HOME:"/home/dev"},commandFinder:async command=>command==="zed"?"/opt/bin/zed":null,exists:()=>false,readDirectory:()=>[]});
  assert.equal(resolved,"/opt/bin/zed");
});

test("discoverEditors omits editors that are not actually installed",async()=>{
  const result=await discoverEditors({platform:"linux",env:{HOME:"/home/dev"},commandFinder:missingCommand,exists:()=>false,readDirectory:()=>[]});
  assert.deepEqual(result,[]);
});
