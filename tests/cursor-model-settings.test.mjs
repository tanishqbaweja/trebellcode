// Cursor's per-model settings (effort, Fast switch, other settings) as Trebell reads them from Cursor's model list and sets them
// in a turn, and Cursor's sign-in as `cursor-agent about` reports it.
import test from "node:test";
import assert from "node:assert/strict";
import { AcpAgentSession } from "../src/acp-agent-session.mjs";
import { cursorEffortChange, cursorEffortLevels, cursorEffortOption, cursorFastChange, cursorFastOption, cursorLevelOf, cursorModelCatalog, cursorPickedChange } from "../src/acp-model-catalog.mjs";
import { parseCursorAboutResult } from "../src/agent-runtime-manager.mjs";

const select=(id,category,currentValue,values,name=id)=>({id,name,category,type:"select",currentValue,options:values.map(value=>Array.isArray(value)?{value:value[0],name:value[1]}:{value,name:value})});
const toggle=(id,category,currentValue,name=id)=>({id,name,category,type:"boolean",currentValue});

// Cursor's CLI keeps no list of effort values (they come from Cursor's server per model), so any choice that reads as one of the
// composer's levels is that level. Changed on purpose: None and Minimal now count when Cursor lists them, where the earlier fixed
// list left them out, and a spelling with doubled spaces reads like any other.
test("a Cursor effort value or name is the composer level it spells, in any case and with any separators",()=>{
  const read=list=>list.map(cursorLevelOf);
  assert.deepEqual(read(["None","minimal","LOW"," medium ","High","xhigh","Max"]),["none","minimal","low","medium","high","xhigh","max"]);
  assert.deepEqual(read(["Extra High","extra-high","EXTRA_HIGH","extra  high","X-High","XHigh"]),Array(6).fill("xhigh"));
  for(const unknown of ["ultra","auto","maximum","Low (default)","high-ish","-","",null,undefined,{},7])assert.equal(cursorLevelOf(unknown),null,String(unknown));
});

test("a model's effort option is its effort or reasoning select, model_option first, then the id effort, then thought_level",()=>{
  const thinking=select("thinking","thought_level","true",["false","true"]);
  const thought=select("reasoning","thought_level","high",["low","high"]),named=select("level","other","low",["low","high"],"Effort level");
  const byId=select("effort","other","low",["low","high"]),modelOption=select("reasoning_effort","model_option","low",["low","high"]);
  assert.equal(cursorEffortOption([thinking,thought,byId,modelOption]),modelOption);
  assert.equal(cursorEffortOption([thinking,thought,byId]),byId);
  assert.equal(cursorEffortOption([named,thought]),thought);
  assert.equal(cursorEffortOption([thinking,named]),named,"a select whose name says effort counts");
  assert.equal(cursorEffortOption([thinking,toggle("effort","thought_level",true)]),null,"only a select is an effort option");
  assert.equal(cursorEffortOption({effort:byId}),null);
  // None is a level now that every composer level Cursor lists counts (it was left out before).
  assert.deepEqual(cursorEffortLevels(select("effort","thought_level","medium",[["none","None"],["e1","Low"],["low","Low"],["e3","Extra High"],["max","Max"],["turbo","Turbo"]])),["none","low","xhigh","max"],"a level comes from a choice's value, else its name, each once");
});

test("Cursor's Fast switch is a model_config switch called fast",()=>{
  const fastBoolean=toggle("fast","model_config",false,"");
  const fastMode=select("speed","model_config","FALSE",["True","FALSE","auto"],"Use fast mode");
  assert.equal(cursorFastOption([select("context","model_config","300k",["300k","1m"]),fastBoolean]),fastBoolean);
  assert.equal(cursorFastOption([fastMode]),fastMode,"a select offering true and false is a switch, whatever else it offers");
  assert.equal(cursorFastOption([select("fast","model_config","on",["on","off"])]),null,"on and off are not true and false");
  assert.equal(cursorFastOption([{...fastBoolean,category:"model_option"}]),null);
});

test("Cursor's model list keeps the first row of each model, its effort levels, default level, Fast speed and other settings",()=>{
  const effort=select("effort","thought_level","none",[["none","None"],["low","Low"],["high","High"]],"Effort");
  const fast=select("fast","model_config","false",["false","true"],"Fast"),context=select("context","model_config","1m",[["300k","300K"],["1m","1M"]],"Context");
  const catalog=cursorModelCatalog({models:[
    {value:" gpt-5.6-sol ",name:"GPT-5.6 Sol",configOptions:[effort,fast,context]},
    {value:"gpt-5.6-sol",name:"Again",configOptions:[]},
    {value:"nameless",name:" "},
    {value:"claude-opus-5",name:"Claude Opus 5",configOptions:[{...effort,currentValue:"high"}]},
  ]});
  assert.deepEqual(catalog.models,["gpt-5.6-sol","claude-opus-5"]);
  assert.equal(catalog.preferred,"gpt-5.6-sol","without Auto the first model is preferred");
  // The model is on None, which is now one of its levels and so its default (before, None was no level and the model had
  // no default).
  assert.deepEqual(catalog.metadata[0],{id:"gpt-5.6-sol",name:"GPT-5.6 Sol",provider:"cursor",agent:"Cursor",reasoningEfforts:["none","low","high"],defaultReasoningEffort:"none",serviceTiers:["fast"],modelOptions:[{id:"context",label:"Context",type:"select",choices:[{value:"300k",label:"300K"},{value:"1m",label:"1M"}],defaultValue:"1m"}]});
  assert.equal(cursorModelCatalog({models:[{value:"m",name:"M",configOptions:[{...effort,currentValue:"turbo"}]}]}).metadata[0].defaultReasoningEffort,null,"a current value that is no level gives no default");
  assert.equal(catalog.metadata[1].defaultReasoningEffort,"high");
  assert.equal(catalog.metadata[1].isDefault,undefined);
  assert.deepEqual(cursorModelCatalog({models:"none"}),{models:[],metadata:[],preferred:null});
});

test("a Cursor turn plans its effort, Fast and picked settings from the option list it is given",()=>{
  const effort=select("effort","thought_level","high",[["e1","Low"],["e3","Extra High"]],"Effort");
  const fast=select("fast","model_config","False",["True","False"],"Fast"),thinking=toggle("thinking","model_config",true,"Thinking");
  const context=select("context","model_config","300k",["300k","1m","1M"],"Context"),list=[effort,fast,thinking,context];
  assert.deepEqual(cursorEffortChange(list,"xhigh"),{option:effort,value:"e3",label:"effort"},"the choice whose name reads as the level");
  assert.equal(cursorEffortChange(list,"max"),null);
  const offered=select("reasoning","thought_level","low",[["off","None"],["low","Low"]],"Reasoning");
  assert.equal(cursorEffortChange([offered],"none").value,"off","None is set by its own value like any other level");
  assert.equal(cursorEffortChange([fast],"low"),null);
  assert.deepEqual(cursorFastChange(list,true),{option:fast,value:"True",label:"Fast"},"the switch's own spelling");
  assert.deepEqual(cursorFastChange([toggle("fast","model_config")],false).value,false);
  assert.equal(cursorFastChange([thinking],true),null);
  assert.deepEqual(cursorPickedChange(list,"thinking","FALSE"),{option:thinking,value:false,label:"thinking"});
  assert.equal(cursorPickedChange(list,"thinking","maybe"),null);
  assert.equal(cursorPickedChange(list,"context","1M").value,"1M","an exact value first");
  assert.equal(cursorPickedChange([select("context","model_config","300k",["300k","1m"])],"context","1M").value,"1m","then the value in any case");
  assert.equal(cursorPickedChange(list,"context","2m"),null);
  assert.equal(cursorPickedChange(list,"effort","e1"),null,"the effort has its own picker");
  assert.equal(cursorPickedChange(list,"fast","True"),null,"so does the Fast switch");
  assert.equal(cursorPickedChange(list,"gone","x"),null);
});

// A Cursor session on a stand-in client: each set_config_option is recorded and answered by `answer` (an answer, or an error to throw).
function cursorSession(configOptions,answer=()=>({})){
  const calls=[],session=new AcpAgentSession({runtime:"cursor",command:"fixture",cwd:process.cwd()});
  session.sessionId="cursor-session";
  session.sessionSetup={sessionId:"cursor-session",configOptions:[select("model","model","default",[["default","Auto"],["claude-opus-5","Claude Opus 5"]]),...configOptions]};
  session.client={setConfigOption:async(sessionId,id,value)=>{calls.push([id,value]);const said=answer(id,value);if(said instanceof Error)throw said;return said}};
  return {session,calls};
}
const optionNamed=(session,id)=>session.sessionSetup.configOptions.find(option=>option.id===id);

test("a Cursor session sends each setting that differs, after its model, and keeps its copy current when Cursor answers without a list",async()=>{
  const {session,calls}=cursorSession([
    select("effort","thought_level","medium",["low","medium","high"],"Effort"),select("fast","model_config","false",["false","true"],"Fast"),
    select("context","model_config","300k",["300k","1m"],"Context"),toggle("thinking","model_config",true,"Thinking"),
  ]);
  session.setReasoningEffort("High");session.setServiceTier("fast");session.setModelOptions({context:"1M",thinking:"true",effort:"low"});
  await session.setModel("claude-opus-5");
  assert.deepEqual(calls,[["model","claude-opus-5"],["effort","high"],["fast","true"],["context","1m"]],"thinking is already on, and the effort is not a picked setting");
  assert.deepEqual(["effort","fast","context"].map(id=>optionNamed(session,id).currentValue),["high","true","1m"]);
  await session.setModel("claude-opus-5");
  assert.deepEqual(calls.slice(4),[["model","claude-opus-5"]],"nothing already set is sent again");
});

test("a Cursor session looks each setting up in the list Cursor answered the one before with",async()=>{
  const fast=select("fast","model_config","false",["false","true"],"Fast");
  const {session,calls}=cursorSession([select("effort","thought_level","medium",["low","high"],"Effort"),fast],id=>id==="effort"?{configOptions:[select("model","model","claude-opus-5",["default","claude-opus-5"]),select("effort","thought_level","high",["low","high"],"Effort")]}:{});
  session.setReasoningEffort("high");session.setServiceTier("fast");
  await session.setModel("claude-opus-5");
  assert.deepEqual(calls,[["model","claude-opus-5"],["effort","high"]],"the model Cursor switched to has no Fast switch");
});

test("a refused Cursor setting fails the turn with the setting's name, or what it is when it has none",async()=>{
  const refusal=Object.assign(new Error("Invalid value"),{code:-32602});
  const named=cursorSession([select("effort","thought_level","low",["low","high"],"Effort")],id=>id==="effort"?refusal:{});
  named.session.setReasoningEffort("high");
  await assert.rejects(named.session.setModel("claude-opus-5"),error=>error.message==="Cursor could not set Effort to high: Invalid value"&&error.code===-32602&&error.cause===refusal);
  const unnamed=cursorSession([toggle("fast","model_config",false,"")],id=>id==="fast"?refusal:{});
  unnamed.session.setServiceTier("fast");
  await assert.rejects(unnamed.session.setModel("claude-opus-5"),{message:"Cursor could not set Fast to true: Invalid value"});
  const picked=cursorSession([select("context","model_config","300k",["300k","1m"],"")],id=>id==="context"?refusal:{});
  picked.session.setModelOptions({context:"1m"});
  await assert.rejects(picked.session.setModel("claude-opus-5"),{message:"Cursor could not set context to 1m: Invalid value"});
});

// The CLI's about command puts the account's email address in this field, or null (JSON) or its own words for none (text), so an
// address is the account and other words are a sign-out, whichever words a CLI version uses.
test("cursor-agent about: an email address is the account, null or other words are signed out, and no email is unknown",()=>{
  const json=userEmail=>parseCursorAboutResult({stdout:JSON.stringify({cliVersion:"2026.09",userEmail}),stderr:"",code:0});
  const signedOut={authenticated:false,email:null};
  assert.deepEqual(json("  dev@example.test  "),{authenticated:true,email:"dev@example.test"});
  assert.deepEqual(json(null),signedOut);
  // The CLI's own words, then sample words of Trebell's own: any words but an address are a sign-out.
  for(const words of [" NOT LOGGED IN ","No account yet","Sign in to Cursor first: run cursor-agent login","Signed out","-","dev@","@example.test","a@b@c"])assert.deepEqual(json(words),signedOut,words);
  assert.deepEqual(json("dev@example.test (Pro plan)"),{authenticated:true,email:"dev@example.test"},"the address alone, when other words come with it");
  assert.deepEqual(json("ops@localhost"),{authenticated:true,email:"ops@localhost"});
  assert.deepEqual(json(""),{authenticated:null,email:null});
  assert.deepEqual(json(42),{authenticated:null,email:null});
  assert.deepEqual(parseCursorAboutResult({stdout:JSON.stringify({cliVersion:"2026.09"})}),{authenticated:null,email:null});
  // JSON that does not parse is read as text, stderr included.
  assert.deepEqual(parseCursorAboutResult({stdout:"{not json",stderr:"User Email   dev@example.test\n"}),{authenticated:true,email:"dev@example.test"});
});

test("cursor-agent about in text: the User Email line, without colour codes, in any case and line ending",()=>{
  const ESC=String.fromCharCode(27),text=stdout=>parseCursorAboutResult({stdout,stderr:""});
  assert.deepEqual(text(`CLI Version 2026.03\r\n${ESC}[1mUser Email${ESC}[0m          dev@example.test  \r\n`),{authenticated:true,email:"dev@example.test"});
  assert.deepEqual(text("  user email\tNot Logged In\n"),{authenticated:false,email:null});
  // Sample words of Trebell's own: any words but an address in the email field are a sign-out.
  assert.deepEqual(text("User Email          No account yet\n"),{authenticated:false,email:null});
  // Laid out as the 2026.09.26 CLI prints it: a title, then each label dimmed and padded to 20 characters before its value.
  const about=email=>`${ESC}[1m${ESC}[36mAbout Cursor CLI${ESC}[39m${ESC}[22m\n\n`+[["CLI Version","2026.09.26-dd393fe"],["Model","Auto"],["User Email",email]].map(([label,value])=>`${ESC}[2m${label.padEnd(20)}${ESC}[22m${value}`).join("\n");
  assert.deepEqual(text(about("Not logged in")),{authenticated:false,email:null});
  assert.deepEqual(text(about("dev@example.test")),{authenticated:true,email:"dev@example.test"});
  assert.deepEqual(text(about("No account")),{authenticated:false,email:null},"other words in the email's place are signed out too");
  assert.deepEqual(text("User Email\n      dev@example.test\n"),{authenticated:true,email:"dev@example.test"},"a value on the next line when the label's line has none");
  assert.deepEqual(text("User Email: dev@example.test\n"),{authenticated:null,email:null},"the label is followed by spaces");
  assert.deepEqual(text("The User Email is dev@example.test\n"),{authenticated:null,email:null},"the label starts its line");
  assert.deepEqual(text("User Email   \n"),{authenticated:null,email:null});
  assert.deepEqual(parseCursorAboutResult({}),{authenticated:null,email:null});
});
