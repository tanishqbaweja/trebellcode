export function rootRelativeFallback(value){
  const text=String(value??"");
  if(!/^[\\/]/.test(text))return null;
  if(/^[a-zA-Z]:[\\/]/.test(text)||/^\\\\/.test(text))return null;
  let stripped=text.replace(/^[\\/]+/,"");
  // Models commonly use /workspace as the conventional virtual repository root.
  // Trebell's workspace tools are already root-relative, so accept that spelling
  // instead of wasting a tool round-trip on a literal "workspace" subdirectory.
  if(/^workspace(?:[\\/]|$)/i.test(stripped))stripped=stripped.replace(/^workspace(?:[\\/]+|$)/i,"");
  return stripped||".";
}

export function conventionalWorkspaceFallback(value){
  const text=String(value??"");
  if(!text||/^[\\/]/.test(text)||/^[a-zA-Z]:[\\/]/.test(text)||/^\\\\/.test(text))return null;
  const normalized=text.replace(/\\/g,"/").replace(/^\.\//,"");
  // Some coding models assume a conventional container root such as /workspace
  // or /app. This helper is used only after the literal workspace-relative path
  // failed, so a real top-level workspace/app directory always wins first.
  if(!/^(?:workspace|app)(?:\/|$)/i.test(normalized))return null;
  const stripped=normalized.replace(/^(?:workspace|app)(?:\/+|$)/i,"");
  return stripped||".";
}

export function conventionalWorkspaceAlias(value){
  const text=String(value??"");
  if(!text||/^[a-zA-Z]:[\\/]/.test(text)||/^\\\\/.test(text))return null;
  const normalized=text.replace(/\\/g,"/").replace(/^\/+/,"").replace(/^\.\//,"");
  const match=/^(workspace|app)(?:\/|$)/i.exec(normalized);return match?match[1].toLowerCase():null;
}

export function normalizeRepositoryWorkspacePath(root,value){
  const text=String(value??"");
  if(!text)return text;
  const normalizedRoot=String(root||"").replace(/\\/g,"/").replace(/\/+$/,"");
  const normalizedText=text.replace(/\\/g,"/");
  if(normalizedText.startsWith("/")&&normalizedRoot&&(normalizedText===normalizedRoot||normalizedText.startsWith(normalizedRoot+"/")))return text;
  return rootRelativeFallback(text)??text;
}
