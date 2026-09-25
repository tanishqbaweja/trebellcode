const PERMISSIONS=new Set(["read-only","workspace-write","supervised","auto","full","isolated"]);
const RUNTIMES=new Set(["codex","claude","opencode","cursor","grok","antigravity"]);

function text(value,max=4000){return String(value??"").trim().slice(0,max)}
function list(value,{limit=50,max=1000}={}){
  return (Array.isArray(value)?value:[]).map(item=>text(item,max)).filter(Boolean).slice(0,limit);
}
function recipeName(value,index=0){
  let name=text(value,80).toLowerCase().replace(/\s+/g,"-").replace(/[^a-z0-9._/-]/g,"");
  if(!name)name="recipe-"+(index+1);if(!name.startsWith("/"))name="/"+name;
  return name.slice(0,80);
}
function children(value){
  if(value==null||value==="")return 0;
  const number=Math.trunc(Number(value));
  return Number.isFinite(number)?Math.max(0,Math.min(8,number)):0;
}

export function normalizeRecipe(recipe={},index=0){
  const name=recipeName(recipe.name,index),title=text(recipe.title,120)||name.slice(1).replace(/[-_.]+/g," ").replace(/\b\w/g,char=>char.toUpperCase());
  const objective=text(recipe.objective,8000);if(!objective)throw new Error("Recipe objective is required.");
  const permission=PERMISSIONS.has(String(recipe.permission))?String(recipe.permission):"supervised";
  const runtime=RUNTIMES.has(String(recipe.runtime))?String(recipe.runtime):null;
  return {
    id:text(recipe.id,300)||null,
    name,title,
    description:text(recipe.description,1000)||null,
    objective,
    permission,
    allowedTools:list(recipe.allowedTools,{limit:80,max:200}),
    expectedArtifacts:list(recipe.expectedArtifacts,{limit:50,max:1000}),
    validation:list(recipe.validation,{limit:50,max:1000}),
    context:text(recipe.context,8000)||null,
    model:text(recipe.model,300)||null,
    runtime,
    maxChildren:children(recipe.maxChildren),
  };
}

export function normalizeRecipes(recipes=[]){
  const out=[],names=new Set();
  for(let index=0;index<(Array.isArray(recipes)?recipes:[]).length&&out.length<50;index++){
    let recipe;try{recipe=normalizeRecipe(recipes[index],index)}catch{continue}
    if(names.has(recipe.name))continue;names.add(recipe.name);out.push(recipe);
  }
  return out;
}

export function recipeRunContext(recipe,{projectPath=null,input="",toolPolicyEnforced=false,currentPermission=null}={}){
  const normalized=normalizeRecipe(recipe);
  if(normalized.allowedTools.length&&!toolPolicyEnforced)throw new Error(`Recipe ${normalized.name} declares allowedTools, but Trebell cannot prove recipe tool-policy enforcement in this runtime.`);
  const sections=[
    "Trebell project recipe "+normalized.name,
    "Run this as one explicit workflow. Do not create hidden parallel work unless the recipe's child-agent limit allows it.",
    normalized.description,
    "Objective:\n"+normalized.objective,
    projectPath&&("Project: "+text(projectPath,4000)),
    normalized.allowedTools.length&&("Enforced allowed tool namespaces/capabilities:\n"+normalized.allowedTools.map(item=>"- "+item).join("\n")),
    normalized.expectedArtifacts.length&&("Expected artifacts:\n"+normalized.expectedArtifacts.map(item=>"- "+item).join("\n")),
    normalized.validation.length&&("Validation expectations:\n"+normalized.validation.map(item=>"- "+item).join("\n")),
    "Delegation limit: "+normalized.maxChildren+" child agent"+(normalized.maxChildren===1?"":"s")+". Do not exceed this limit.",
    currentPermission&&("Current Trebell permission profile: "+text(currentPermission,120)+". The recipe does not silently elevate it."),
    normalized.context&&("Workflow-specific context:\n"+normalized.context),
    text(input,8000)&&("Invocation input:\n"+text(input,8000)),
  ].filter(Boolean);
  return sections.join("\n\n").slice(0,20_000);
}

export function recipeTurnInput(recipe,{input=""}={}){
  const normalized=normalizeRecipe(recipe),suffix=text(input,8000);
  return normalized.objective+(suffix?"\n\nUser input for this recipe:\n"+suffix:"");
}

export function recipeGoalPatch(recipe,{input=""}={}){
  const normalized=normalizeRecipe(recipe),suffix=text(input,4000);
  return {
    objective:normalized.objective+(suffix?" — "+suffix:""),
    status:"active",
    validationExpectations:normalized.validation,
    childAgentBudget:normalized.maxChildren,
  };
}
