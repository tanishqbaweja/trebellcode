import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteAccessSecretStore } from "../src/remote-access-secret-store.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

test("remote access token migrates out of general UI state into a private secret file",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-remote-secret-")),token=["legacy","remote","credential"].join("-");
  const env={...process.env,TREBELL_HOME:home};
  try{
    await writeFile(join(home,"ui-state.json"),JSON.stringify({version:2,projects:[],threadMeta:{},settings:{appearance:"dark",remoteAccessEnabled:true,remoteAccessPort:4321,remoteAccessToken:token}}));
    const secrets=new RemoteAccessSecretStore(env),migration=secrets.migrateLegacyUiState();
    assert.deepEqual(migration,{migrated:true,removed:true});assert.equal(secrets.getToken(),token);
    const uiState=JSON.parse(await readFile(join(home,"ui-state.json"),"utf8"));
    assert.equal(Object.prototype.hasOwnProperty.call(uiState.settings,"remoteAccessToken"),false);
    const state=new TrebellStateStore(env);assert.equal(Object.prototype.hasOwnProperty.call(state.settings(),"remoteAccessToken"),false);assert.equal(state.settings().remoteAccessPort,4321);
    const secretFile=JSON.parse(await readFile(join(home,"remote-access-secret.json"),"utf8"));assert.equal(secretFile.token,token);
    if(process.platform!=="win32")assert.equal((await stat(join(home,"remote-access-secret.json"))).mode&0o777,0o600);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("Trebell state ignores attempts to persist remote access credentials",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-state-secret-boundary-")),env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);state.updateSettings({remoteAccessToken:["do","not","persist"].join("-"),remoteAccessEnabled:true});
    assert.equal(Object.prototype.hasOwnProperty.call(state.settings(),"remoteAccessToken"),false);
    const saved=JSON.parse(await readFile(join(home,"ui-state.json"),"utf8"));assert.equal(Object.prototype.hasOwnProperty.call(saved.settings,"remoteAccessToken"),false);
  }finally{await rm(home,{recursive:true,force:true})}
});
