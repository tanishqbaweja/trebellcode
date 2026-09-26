import test from "node:test";
import assert from "node:assert/strict";
import { normalizeModelCapabilities, withNormalizedModelCapabilities } from "../src/model-capabilities.mjs";

test("model capabilities normalize explicit provider facts without inventing unknown support",()=>{
  const normalized=normalizeModelCapabilities({
    context_window:128000,max_output_tokens:"8192",supports_vision:true,supports_tools:false,computer_use:true,
    capabilities:{reasoning_controls:true,async_tools:false,prompt_caching:true},supports_streaming:true,status:"available",
    pricing:{input:"1.25",output:5,currency:"USD",note:"tiered"},
  });
  assert.deepEqual(normalized,{contextWindow:128000,maxOutputTokens:8192,vision:true,toolCalling:false,computerUse:true,reasoningControls:true,asyncTools:false,streaming:true,caching:true,availability:"available",pricing:{input:1.25,output:5,currency:"USD"}});
});

test("model capabilities infer vision only from explicit input modalities and keep absent fields unknown",()=>{
  assert.deepEqual(normalizeModelCapabilities({input_modalities:["text","image"]}),{contextWindow:null,maxOutputTokens:null,vision:true,toolCalling:null,computerUse:null,reasoningControls:null,asyncTools:null,streaming:null,caching:null,availability:null,pricing:null});
  assert.equal(normalizeModelCapabilities({input_modalities:["text"]}).vision,false);
  assert.equal(normalizeModelCapabilities({name:"mystery"}).toolCalling,null);
});

test("normalized model metadata preserves provider-specific fields",()=>{
  const row=withNormalizedModelCapabilities({id:"model-a",provider:"fixture",vendor_extra:{alpha:true},limits:{contextWindow:64000,maxOutputTokens:4096}});
  assert.equal(row.id,"model-a");assert.deepEqual(row.vendor_extra,{alpha:true});assert.equal(row.capabilities.contextWindow,64000);assert.equal(row.capabilities.maxOutputTokens,4096);
});
