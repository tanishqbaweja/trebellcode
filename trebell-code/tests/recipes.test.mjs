import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { normalizeRecipe, normalizeRecipes, recipeGoalPatch, recipeRunContext, recipeTurnInput, resolveRecipeExecution } from "../src/recipes.mjs";

test("recipes normalize slash names, permissions, declared tools, validation and child caps",()=>{
  const recipe=normalizeRecipe({
    name:"Fix CI",title:"Fix CI",description:"Repair the failing CI workflow.",objective:"Find and fix the CI failure.",
    permission:"workspace-write",allowedTools:["repo","terminal","browser"],expectedArtifacts:["Green CI"],validation:["Run affected tests","Inspect CI logs"],context:"Avoid unrelated refactors.",maxChildren:2,
  });
  assert.equal(recipe.name,"/fix-ci");assert.equal(recipe.permission,"workspace-write");assert.deepEqual(recipe.allowedTools,["repo","terminal","browser"]);assert.equal(recipe.maxChildren,2);
  const context=recipeRunContext(recipe,{projectPath:"/repo",input:"The Linux job is failing.",toolPolicyEnforced:true,currentPermission:"supervised"});
  assert.match(context,/Delegation limit: 2 child agents/);assert.match(context,/Avoid unrelated refactors/);assert.match(context,/Linux job is failing/);
  assert.match(context,/Enforced allowed tool namespaces/);assert.match(context,/does not silently elevate/);
  const goal=recipeGoalPatch(recipe,{input:"Linux job"});assert.equal(goal.childAgentBudget,2);assert.deepEqual(goal.validationExpectations,recipe.validation);
  assert.match(recipeTurnInput(recipe,{input:"Linux job"}),/User input for this recipe/);
});

test("recipes default to supervised with zero hidden child agents and deduplicate names",()=>{
  const recipe=normalizeRecipe({name:"security review",objective:"Review the requested scope for security issues."});
  assert.equal(recipe.permission,"supervised");assert.equal(recipe.maxChildren,0);
  assert.match(recipeRunContext(recipe),/Delegation limit: 0 child agents/);
  assert.equal(recipeGoalPatch(recipe).childAgentBudget,0);
  const normalized=normalizeRecipes([{name:"release",objective:"Prepare release."},{name:"release",objective:"Duplicate."},{name:"",objective:"Fallback."},{name:"broken"}]);
  assert.equal(normalized.length,2);assert.equal(normalized[0].name,"/release");
});

test("recipes refuse declared tool allowlists when the runtime cannot prove enforcement",()=>{
  const recipe=normalizeRecipe({name:"security review",objective:"Review auth.",allowedTools:["repo","browser"]});
  assert.throws(()=>recipeRunContext(recipe,{toolPolicyEnforced:false}),/cannot prove recipe tool-policy enforcement/i);
});

test("project state persists recipes separately from direct terminal actions",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-recipes-"));
  try{
    const state=new TrebellStateStore({home}),project=state.touchProject("C:/repo",{scripts:[{name:"Test",command:"npm test"}],recipes:[{name:"add tests",objective:"Add regression coverage.",validation:["Run targeted tests"]}]});
    assert.equal(project.scripts.length,1);assert.equal(project.recipes.length,1);assert.equal(project.recipes[0].name,"/add-tests");assert.ok(project.recipes[0].id);
    const reloaded=new TrebellStateStore({home}).project("C:/repo",null);assert.equal(reloaded.recipes[0].objective,"Add regression coverage.");
  }finally{await rm(home,{recursive:true,force:true})}
});

test("recipe execution never elevates the active permission profile",()=>{
  const readOnly=resolveRecipeExecution({name:"inspect",objective:"Inspect the issue.",permission:"full"},{currentPermission:"read-only",runtime:"codex"});
  assert.equal(readOnly.permissionMode,"read-only");
  const stricter=resolveRecipeExecution({name:"safe-fix",objective:"Fix it.",permission:"workspace-write"},{currentPermission:"full",runtime:"codex"});
  assert.equal(stricter.permissionMode,"edits");
  assert.equal(stricter.goalPatch.childAgentBudget,0);
  assert.match(stricter.context,/does not silently elevate/i);
});

test("recipe execution validates runtime, model, isolation, and enforceable tool constraints",()=>{
  assert.throws(()=>resolveRecipeExecution({name:"claude-only",objective:"Do it.",runtime:"claude"},{runtime:"codex"}),/requires the claude runtime/i);
  assert.throws(()=>resolveRecipeExecution({name:"model-only",objective:"Do it.",model:"missing"},{runtime:"codex",availableModels:["available"]}),/not available/i);
  assert.throws(()=>resolveRecipeExecution({name:"isolated",objective:"Do it.",permission:"isolated"},{runtime:"codex"}),/requires an isolated environment/i);
  assert.throws(()=>resolveRecipeExecution({name:"bounded",objective:"Do it.",allowedTools:["repo"]},{runtime:"codex",toolPolicyEnforced:false}),/cannot prove recipe tool-policy enforcement/i);
});
