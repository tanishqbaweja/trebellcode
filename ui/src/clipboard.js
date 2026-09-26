export async function writeClipboardText(value,{navigatorObj=globalThis.navigator,documentObj=globalThis.document}={}){
  const text=String(value??"");
  if(!text)return false;
  const modern=navigatorObj?.clipboard?.writeText;
  if(typeof modern==="function"){
    try{await modern.call(navigatorObj.clipboard,text);return true}catch{}
  }
  if(!documentObj?.body||typeof documentObj.createElement!=="function"||typeof documentObj.execCommand!=="function")return false;
  const input=documentObj.createElement("textarea");
  input.value=text;input.setAttribute?.("readonly","");
  if(input.style){input.style.position="fixed";input.style.opacity="0";input.style.pointerEvents="none"}
  documentObj.body.appendChild(input);
  try{
    input.focus?.();input.select?.();
    return Boolean(documentObj.execCommand("copy"));
  }catch{return false}
  finally{input.remove?.()}
}
