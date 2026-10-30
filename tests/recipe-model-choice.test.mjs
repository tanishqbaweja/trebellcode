import test from "node:test";
import assert from "node:assert/strict";
import { runSlashCommand } from "../ui/src/turn-support.js";

// A project's recipe sent from the composer (turn-support.js runSlashCommand), with App's parts faked: the server resolves the
// recipe to `execution`, and startTurn refuses a model the catalog does not list, as App's assertTurnModel does.
const META=["muse-spark-1.3","muse-spark-1.2","muse-spark-1.1","muse-spark-1.3-contributor","muse-wonder-1.0"];
function recipeWindow({models=META,model="",execution={}}={}){
  const turns=[],asked=[],notes=[],resolves=[];
  const fetch=async(path,init)=>{
    resolves.push({path,body:JSON.parse(init.body)});
    return new Response(JSON.stringify({execution:{turnInput:"Fix the failing CI job.",context:"Recipe context",goalPatch:null,toolAllowlist:null,permissionMode:null,model:null,...execution}}),{status:200,headers:{"content-type":"application/json"}});
  };
  const deps={
    currentProject:{id:"recipe-project",recipes:[{id:"recipe-fix-ci",name:"/fix-ci"}]},projectPath:"/repo",workspaceEnvironmentId:null,permissionMode:"supervised",setPermissionMode:()=>{},
    agentRuntime:"native",agentRuntimeLabel:"Trebell Native",models,model,attachments:[],contextChips:[],runtimeCapabilities:{},rpc:null,activeThread:null,activeThreadRef:{current:null},
    async startTurn(text,paths,modelId){
      if(!models.includes(modelId))throw new Error(`Trebell Native does not list the model ${modelId||"(none selected)"}. Choose one of its models and send again.`);
      turns.push({text,model:modelId});
    },
    setEvents:update=>{notes.push(...update([]).map(item=>item.title))},setComposerAlert:()=>{},
    askForModel:()=>asked.push(true),
  };
  return {deps,turns,asked,notes,resolves,fetch};
}
async function run(window,text){
  const original=globalThis.fetch;globalThis.fetch=window.fetch;
  try{return await runSlashCommand(window.deps,text)}finally{globalThis.fetch=original}
}

test("a project recipe that names no model, sent before a model is picked from a catalog that names no default, asks for one and keeps the command",async()=>{
  const window=recipeWindow();
  assert.equal(await run(window,"/fix-ci Linux runner only"),"kept","the composer keeps /fix-ci and what was typed after it");
  assert.equal(window.asked.length,1,"the composer asks for a model, as a message sent before a pick does");
  assert.deepEqual(window.turns,[],"no turn starts without a model");
  assert.deepEqual(window.notes,[],"no 'Could not run /fix-ci' error stands in for the question");
  assert.equal(window.resolves.length,1);assert.equal(window.resolves[0].body.input,"Linux runner only");
});

test("a project recipe runs on the model picked in the composer, and on its own model without asking",async()=>{
  const picked=recipeWindow({model:"muse-spark-1.3"});
  assert.equal(await run(picked,"/fix-ci"),true);
  assert.deepEqual(picked.turns,[{text:"Fix the failing CI job.",model:"muse-spark-1.3"}]);assert.equal(picked.asked.length,0);
  const own=recipeWindow({execution:{model:"muse-spark-1.2"}});
  assert.equal(await run(own,"/fix-ci"),true);
  assert.deepEqual(own.turns,[{text:"Fix the failing CI job.",model:"muse-spark-1.2"}]);assert.equal(own.asked.length,0);
  // With no catalog at all there is nothing to choose from: the recipe says why it could not run, as before.
  const none=recipeWindow({models:[]});
  assert.equal(await run(none,"/fix-ci"),true);
  assert.equal(none.asked.length,0);assert.match(none.notes[0],/^Could not run \/fix-ci: Trebell Native does not list the model \(none selected\)/);
});
