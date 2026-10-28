import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_PROVIDERS, ProviderManager } from "../src/provider-manager.mjs";

// The one way the server reads a model provider's key for another consumer of it (a harness the person put on API key): the
// key saved in Settings, else the environment variable Trebell Native itself reads for that provider, through the code Native
// uses for its own calls. Nothing here touches the network.
function cleanEnv(root,extra={}){
  const env={...process.env,TREBELL_HOME:root};
  for(const provider of Object.values(MODEL_PROVIDERS))for(const name of provider.envKeys||[provider.envKey])delete env[name];
  return {...env,...extra};
}
const noNetwork=async()=>{throw new Error("reading a key must not touch the network")};

test("keyFor reads a provider's key as Native does: the saved key, else the environment variable Native reads, never another provider's",()=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-key-for-"));
  try{
    const env=cleanEnv(root,{XAI_API_KEY:"  Bearer xai-env-key ",GOOGLE_API_KEY:"google-env-key",OPENAI_API_KEY:"sk-env-key",ANTHROPIC_API_KEY:""});
    const manager=new ProviderManager({env,fetchFn:noNetwork});
    assert.deepEqual(manager.keyFor("xai"),{provider:"xai",key:"xai-env-key",source:"environment",variable:"XAI_API_KEY"});
    assert.deepEqual(manager.keyFor("gemini"),{provider:"gemini",key:"google-env-key",source:"environment",variable:"GOOGLE_API_KEY"},"the second name Native reads for Gemini counts");
    assert.equal(manager.keyFor("anthropic"),null,"an empty variable is no key");
    assert.equal(manager.keyFor("meta"),null);
    manager.setKey("xai","xai-saved-key");manager.setKey("meta","Bearer meta-saved-key");
    assert.deepEqual(manager.keyFor("XAI"),{provider:"xai",key:"xai-saved-key",source:"settings",variable:null},"the saved key wins over the environment");
    assert.deepEqual(manager.keyFor(" meta "),{provider:"meta",key:"meta-saved-key",source:"settings",variable:null});
    for(const id of Object.keys(MODEL_PROVIDERS))assert.equal(manager.keyFor(id)?.key||"",manager.key(id),id+": the same key Native uses");
    // An id that is not a model provider is refused, never read as the default provider (OpenAI) or any other.
    for(const id of ["cursor","grok","claude","","retired-provider",null,undefined])assert.throws(()=>manager.keyFor(id),/Unknown model provider/,String(id));
    assert.deepEqual(manager.keysFor(["anthropic","openai","xai","meta","gemini"]).map(found=>[found.provider,found.source,found.variable]),[["openai","environment","OPENAI_API_KEY"],["xai","settings",null],["meta","settings",null],["gemini","environment","GOOGLE_API_KEY"]]);
    assert.deepEqual(manager.keysFor().map(found=>found.provider),["openai","gemini","xai","meta"]);
    assert.throws(()=>manager.keysFor(["openai","cursor"]),/Unknown model provider "cursor"/);
    // A key removed in Settings falls back to the environment; another server run on the same home reads what was saved.
    manager.setKey("xai","");assert.deepEqual(manager.keyFor("xai"),{provider:"xai",key:"xai-env-key",source:"environment",variable:"XAI_API_KEY"});
    const again=new ProviderManager({env:cleanEnv(root),fetchFn:noNetwork});
    assert.deepEqual(again.keyFor("meta"),{provider:"meta",key:"meta-saved-key",source:"settings",variable:null});
    assert.equal(again.keyFor("xai"),null);
    // Nothing that describes the providers carries a key, and keyFor is the one way to read one for a consumer: the environment
    // builder that put a key under the provider's variable for a child process is gone.
    assert.doesNotMatch(JSON.stringify([manager.definitions(),manager.status("xai"),manager.status("meta")]),/saved-key|env-key/);
    assert.equal("childEnv" in manager,false);
  }finally{rmSync(root,{recursive:true,force:true})}
});

test("keyFor answers with the key Native would send after a key changes in Settings, without a new ProviderManager",()=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-key-for-"));
  try{
    const manager=new ProviderManager({env:cleanEnv(root,{ANTHROPIC_API_KEY:"sk-ant-env"}),fetchFn:noNetwork});
    assert.equal(manager.keyFor("anthropic").source,"environment");
    manager.setKey("anthropic","sk-ant-typed");
    assert.deepEqual(manager.keyFor("anthropic"),{provider:"anthropic",key:"sk-ant-typed",source:"settings",variable:null});
    manager.setKey("anthropic","");
    assert.deepEqual(manager.keyFor("anthropic"),{provider:"anthropic",key:"sk-ant-env",source:"environment",variable:"ANTHROPIC_API_KEY"});
  }finally{rmSync(root,{recursive:true,force:true})}
});
