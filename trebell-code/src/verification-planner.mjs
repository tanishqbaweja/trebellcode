const FRONTEND_EXTENSIONS=new Set([".html",".css",".scss",".sass",".less",".jsx",".tsx",".vue",".svelte"]);
const JS_TS_EXTENSIONS=new Set([".js",".jsx",".ts",".tsx",".mjs",".cjs"]);
const PYTHON_EXTENSIONS=new Set([".py",".pyi"]);

function slash(value){return String(value||"").replace(/\\/g,"/")}
function extension(path){const match=slash(path).toLowerCase().match(/(\.[a-z0-9]+)$/);return match?.[1]||""}
function commandList(commands){return [...(commands?.declared||[]),...(commands?.conventional||[])]}
function commandFor(commands,kinds){
  const wanted=new Set(Array.isArray(kinds)?kinds:[kinds]),rows=commandList(commands).filter(item=>wanted.has(item.kind));
  return rows.sort((a,b)=>(a.confidence==="declared"?-1:1)-(b.confidence==="declared"?-1:1)||String(a.command).localeCompare(String(b.command)))[0]||null;
}
function includesPath(paths,pattern){return paths.some(path=>pattern.test(path))}
function addStep(steps,step){if(!steps.some(item=>item.id===step.id))steps.push(step)}

export function planVerification({changedPaths=[],projectCommands=null,relatedTests=[],riskHints=[],capabilities={}}={}){
  const paths=[...new Set((changedPaths||[]).map(slash).filter(Boolean))],lower=paths.map(path=>path.toLowerCase()),hints=new Set((riskHints||[]).map(value=>String(value).toLowerCase())),reasons=[],steps=[];
  const frontend=lower.some(path=>FRONTEND_EXTENSIONS.has(extension(path))||/(^|\/)(ui|frontend|web|pages|components)(\/|$)/.test(path));
  const jsTs=lower.some(path=>JS_TS_EXTENSIONS.has(extension(path)));
  const typescript=lower.some(path=>[".ts",".tsx"].includes(extension(path)));
  const python=lower.some(path=>PYTHON_EXTENSIONS.has(extension(path)));
  const rust=lower.some(path=>extension(path)===".rs"||/(^|\/)cargo\.(toml|lock)$/.test(path));
  const auth=includesPath(lower,/(^|\/)(auth|oauth|session|token|identity|permission|permissions)(\/|\.|-|$)/)||hints.has("auth");
  const storage=includesPath(lower,/(^|\/)(db|database|storage|migration|migrations|schema|persistence)(\/|\.|-|$)/)||hints.has("storage");
  const release=includesPath(lower,/(^|\/)(release|deploy|deployment|installer|electron-builder|tauri|dockerfile|docker-compose|\.github\/workflows)(\/|\.|-|$)/)||hints.has("release");
  const docsOnly=paths.length>0&&lower.every(path=>/\.(md|mdx|txt|rst)$/.test(path));
  const testsChanged=includesPath(lower,/(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\./);
  const highRisk=auth||storage||release||hints.has("high");
  const mediumRisk=!highRisk&&(frontend||rust||typescript||python||testsChanged||hints.has("medium"));
  const risk=highRisk?"high":mediumRisk?"medium":"low";

  if(paths.length===0)reasons.push("No changed paths were supplied, so verification scope cannot be narrowed by impact.");
  if(docsOnly)reasons.push("Only documentation-like files changed.");
  if(typescript)reasons.push("TypeScript changes benefit from parser/compiler evidence before broader tests.");
  else if(jsTs)reasons.push("JavaScript changes benefit from syntax diagnostics before broader tests.");
  if(python)reasons.push("Python changes benefit from AST syntax diagnostics before broader tests.");
  if(rust)reasons.push("Rust changes benefit from cargo/rust-analyzer style checks before broader tests.");
  if(frontend)reasons.push("Frontend changes require interaction and visual evidence, not DOM assertions alone.");
  if(auth)reasons.push("Authentication/session/token changes are high-risk and warrant integration coverage.");
  if(storage)reasons.push("Storage/schema/migration changes are high-risk and warrant broader integration coverage.");
  if(release)reasons.push("Release/deployment changes are high-risk and warrant build or packaging evidence.");

  if(docsOnly){
    addStep(steps,{id:"diff_review",kind:"review",scope:"changed",cost:"low",required:true,reason:"Confirm documentation changes match the intended diff."});
    return {risk,categories:{frontend,jsTs,typescript,python,rust,auth,storage,release,docsOnly},reasons,steps,independentReview:false};
  }

  if((jsTs||python)&&capabilities.diagnostics!==false)addStep(steps,{id:"diagnostics",kind:"diagnostics",scope:"changed",cost:"low",required:true,semantic:Boolean((typescript||python)&&capabilities.semanticDiagnostics),reason:typescript?"Catch syntax/type issues close to the edit.":python?"Catch Python syntax issues close to the edit.":"Catch syntax issues close to the edit."});
  if(rust){const check=commandFor(projectCommands,"typecheck")||commandList(projectCommands).find(item=>item.command==="cargo check");addStep(steps,{id:"rust_check",kind:"command",scope:"project",cost:"low",required:true,command:check?.command||"cargo check",source:check?.confidence||"convention",reason:"Catch Rust compile/type errors before tests."})}
  if(typescript){const typecheck=commandFor(projectCommands,"typecheck");if(typecheck)addStep(steps,{id:"typecheck",kind:"command",scope:"project",cost:"low",required:true,command:typecheck.command,source:typecheck.confidence,reason:"Use the repository's typecheck command after diagnostics."})}

  const testCommand=commandFor(projectCommands,"test");
  if(relatedTests?.length)addStep(steps,{id:"targeted_tests",kind:"tests",scope:"targeted",cost:"medium",required:true,command:testCommand?.command||null,source:testCommand?.confidence||null,targets:[...new Set(relatedTests.map(item=>typeof item==="string"?item:item?.path).filter(Boolean))].slice(0,80),reason:"Run tests structurally related to the changed code before broad suites."});
  else if(testCommand&&(jsTs||python||rust||testsChanged||highRisk))addStep(steps,{id:"project_tests",kind:"tests",scope:"project",cost:"medium",required:highRisk||testsChanged,command:testCommand.command,source:testCommand.confidence,reason:"No narrower related-test set was supplied."});

  if(frontend){
    addStep(steps,{id:"browser_interaction",kind:"browser",scope:"changed-flow",cost:"medium",required:true,reason:"Exercise the affected interaction in a real browser."});
    addStep(steps,{id:"browser_runtime",kind:"browser-runtime",scope:"changed-flow",cost:"low",required:true,evidence:["console","network"],reason:"Check console and network failures during the interaction."});
    addStep(steps,{id:"visual",kind:"visual",scope:"changed-flow",cost:"medium",required:true,evidence:["screenshot","responsive-viewport"],reason:"Frontend behavior needs screenshot/visual verification."});
  }

  if(highRisk){
    const build=commandFor(projectCommands,"build");if(build)addStep(steps,{id:"build",kind:"command",scope:"project",cost:"medium",required:true,command:build.command,source:build.confidence,reason:"High-risk changes should prove the project still builds."});
    addStep(steps,{id:"integration",kind:"integration",scope:"affected-system",cost:"high",required:true,reason:"Auth, storage, or release changes need broader integration evidence."});
  }else if(!steps.length){
    const lint=commandFor(projectCommands,["lint","typecheck"]),build=commandFor(projectCommands,"build");
    if(lint)addStep(steps,{id:"static_check",kind:"command",scope:"project",cost:"low",required:true,command:lint.command,source:lint.confidence,reason:"Use the cheapest repository-declared static check."});
    else if(build)addStep(steps,{id:"build",kind:"command",scope:"project",cost:"medium",required:true,command:build.command,source:build.confidence,reason:"Use the repository build as the cheapest available executable evidence."});
    else addStep(steps,{id:"diff_review",kind:"review",scope:"changed",cost:"low",required:true,reason:"No executable project verification command was discovered."});
  }

  return {risk,categories:{frontend,jsTs,typescript,python,rust,auth,storage,release,docsOnly},reasons,steps,independentReview:highRisk};
}
