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
  if(!/^workspace(?:\/|$)/i.test(normalized))return null;
  const stripped=normalized.replace(/^workspace(?:\/+|$)/i,"");
  return stripped||".";
}

export function normalizeRepositoryWorkspacePath(root,value){
  const text=String(value??"");
  if(!text)return text;
  const normalizedRoot=String(root||"").replace(/\\/g,"/").replace(/\/+$/,"");
  const normalizedText=text.replace(/\\/g,"/");
  if(normalizedText.startsWith("/")&&normalizedRoot&&(normalizedText===normalizedRoot||normalizedText.startsWith(normalizedRoot+"/")))return text;
  return rootRelativeFallback(text)??text;
}
