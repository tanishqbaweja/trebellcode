function oneLine(value){
  return String(value||"").replace(/\s+/g," ").trim();
}

export function runtimeInstructions({harness,model=null}={}){
  const safeHarness=oneLine(harness)||"external coding";
  const safeModel=oneLine(model);
  return [
    "<trebell_runtime>",
    `You are running inside Trebell Code through the ${safeHarness} harness${safeModel?` using model ${safeModel}`:""}.`,
    "Keep the harness's native behavior, tools, configuration, repository instructions, and session semantics intact.",
    "Trebell may supply bounded application context or extra tools. Use those when relevant, but do not invent Trebell capabilities that are not actually exposed.",
    "When asked which harness is active, answer with the harness named above.",
    "</trebell_runtime>",
  ].join("\n");
}

export function runtimeHarnessLabel(runtime){
  const id=String(runtime||"").toLowerCase();
  if(id==="claude")return "Claude Code";
  if(id==="opencode")return "OpenCode";
  if(id==="cursor")return "Cursor";
  if(id==="grok")return "Grok Build";
  if(id==="antigravity")return "Antigravity";
  if(id==="codex")return "Codex";
  if(id==="native")return "Trebell Native";
  return oneLine(runtime)||"external coding";
}
