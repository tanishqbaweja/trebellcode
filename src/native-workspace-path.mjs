export function rootRelativeFallback(value){
  const text=String(value??"");
  if(!/^[\\/]/.test(text))return null;
  if(/^[a-zA-Z]:[\\/]/.test(text)||/^\\\\/.test(text))return null;
  const stripped=text.replace(/^[\\/]+/,"");
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
