import test from "node:test";
import assert from "node:assert/strict";
import { apiKeyLabel, formatByteSize, safeAttachmentName } from "../src/gui-server.mjs";
import { EnvironmentManager, validatedSshPort } from "../src/environment-manager.mjs";

test("runtime stats read as GB and TB instead of raw megabytes",()=>{
  assert.equal(formatByteSize(28627*1024*1024),"28.0 GB");
  assert.equal(formatByteSize(2372885*1024*1024),"2.26 TB");
  assert.equal(formatByteSize(512),"512 B");
  assert.equal(formatByteSize(1536),"1.50 KB");
  assert.equal(formatByteSize(150*1024*1024),"150 MB");
  assert.equal(formatByteSize(Number.NaN),"—");
  assert.equal(formatByteSize(-1),"—");
});

test("long upload names keep their start and extension",()=>{
  const long="a-very-long-attachment-file-name-that-keeps-going-and-going-until-it-is-far-past-the-limit.txt";
  const stored=safeAttachmentName(long);
  assert.equal(stored.length,80);
  assert.ok(stored.startsWith("a-very-long-attachment-file-name-"));
  assert.ok(stored.endsWith(".txt"));
  assert.equal(safeAttachmentName("report final (2).pdf"),"report_final__2_.pdf");
  assert.equal(safeAttachmentName("",undefined),"attachment.bin");
  assert.equal(safeAttachmentName(null,"pasted-context.txt"),"pasted-context.txt");
  const noExtension="x".repeat(120);
  assert.equal(safeAttachmentName(noExtension),"x".repeat(80));
  const oddExtension="name-"+"y".repeat(90)+".averyveryverylongextension";
  assert.equal(safeAttachmentName(oddExtension),oddExtension.slice(0,80));
});

test("provider key errors name the key once",()=>{
  assert.equal(apiKeyLabel("OpenAI API"),"OpenAI API key");
  assert.equal(apiKeyLabel("Anthropic"),"Anthropic API key");
  assert.equal(apiKeyLabel(""),"Provider API key");
});

test("SSH profiles reject an invalid port instead of saving 22",()=>{
  assert.equal(validatedSshPort(undefined),22);
  assert.equal(validatedSshPort(""),22);
  assert.equal(validatedSshPort("2222"),2222);
  for(const bad of [0,-1,65536,22.5,"abc"])assert.throws(()=>validatedSshPort(bad),/SSH port must be a whole number from 1 to 65535/);
  const saved=[];
  const manager=new EnvironmentManager({state:{environments:()=>[],upsertEnvironment:value=>{saved.push(value);return value}}});
  assert.throws(()=>manager.upsert({type:"ssh",host:"build.example",port:"70000"}),/SSH port must be a whole number/);
  assert.equal(saved.length,0);
  assert.equal(manager.upsert({type:"ssh",host:"build.example",port:2200}).port,2200);
  assert.equal(manager.upsert({type:"ssh",host:"build.example"}).port,22);
  // Local profiles never had a port to validate.
  assert.equal(manager.upsert({type:"local",port:"not a port"}).port,undefined);
});
