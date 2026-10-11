import test from "node:test";
import assert from "node:assert/strict";
import { highlightSyntax, syntaxLanguage } from "../ui/src/syntax-language.js";

test("code files get their own language's grammar",()=>{
  const expected={
    "app.js":"javascript","view.jsx":"javascript","app.ts":"javascript","view.tsx":"javascript","module.mts":"javascript","legacy.cts":"javascript",
    "data.json":"javascript","tsconfig.jsonc":"javascript","style.css":"css","style.scss":"css","theme.less":"css","theme.sass":"css",
    "index.html":"markup","feed.xml":"markup","icon.svg":"markup","App.vue":"markup","app.csproj":"markup",
    "main.go":"go","Main.java":"java","main.rs":"rust","lib.c":"c","lib.h":"c","lib.cpp":"cpp","lib.hpp":"cpp","Program.cs":"csharp",
    "Main.kt":"kotlin","App.swift":"swift","index.php":"clike","main.dart":"clike","build.gradle":"clike","Jenkinsfile":"clike",
    "tool.py":"python","types.pyi":"python","app.rb":"ruby","Gemfile":"ruby","Rakefile":"ruby",
    "build.sh":"bash",".bashrc":"bash",".env":"bash","setup.ps1":"powershell",
    "config.yaml":"yaml","ci.yml":"yaml","Cargo.toml":"toml","setup.cfg":"ini",".editorconfig":"ini",
    "Dockerfile":"docker","Dockerfile.dev":"docker","Containerfile":"docker","app.dockerfile":"docker","Makefile":"makefile","rules.mk":"makefile",
    "schema.sql":"sql","fix.patch":"diff","change.diff":"diff",
    // Case and folders do not matter.
    "SRC/MAIN.GO":"go","C:\\work\\tool.PY":"python",
  };
  for(const [name,language] of Object.entries(expected))assert.equal(syntaxLanguage(name),language,name);
});

test("prose, logs and unknown types are plain text",()=>{
  for(const name of ["notes.txt","server.log","LICENSE","README","CHANGELOG","data.csv","yarn.lock",".gitignore","image.unknown","",null,undefined])assert.equal(syntaxLanguage(name),"",String(name));
  assert.equal(highlightSyntax("keep this file\nif (this) return <b>x</b>;","notes.txt"),null);
  assert.equal(highlightSyntax(null,"main.go"),null);
});

test("each grammar colours its own syntax",()=>{
  const samples=[
    ["main.go","// entry\nfunc main() { fmt.Println(\"hi\") }",["comment","keyword","string"]],
    ["tool.py","def f(x):\n    # half\n    return x // 2",["keyword","comment","operator"]],
    ["lib.cpp","#include <vector>\nint main() { return 0; } // c++",["macro","keyword","comment"]],
    ["Program.cs","using System; class A { } // c#",["keyword","class-name","comment"]],
    ["build.sh","#!/bin/sh\nif [ -f x ]; then echo hi; fi # done",["shebang","keyword","comment"]],
    ["config.yaml","name: trebell # app",["key","comment"]],
    ["Dockerfile","FROM node:20\nRUN npm ci",["keyword"]],
    ["Cargo.toml","[package]\nname = \"x\"",["table","key","string"]],
    ["schema.sql","SELECT * FROM users; -- all",["keyword","comment"]],
    ["fix.patch","@@ -1 +1 @@\n-old\n+new",["coord","deleted","inserted"]],
    ["theme.less",".a { color: red; }",["selector","property"]],
  ];
  for(const [name,text,kinds] of samples){
    const html=highlightSyntax(text,name);
    assert.equal(typeof html,"string",name);
    for(const kind of kinds)assert.match(html,new RegExp(`class="token [^"]*\\b${kind}\\b`),`${name}: ${kind}`);
  }
  // In Python "//" is floor division, not the comment the JavaScript grammar made of it.
  assert.doesNotMatch(highlightSyntax("return x // 2","tool.py"),/class="token comment"/);
});
