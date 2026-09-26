function quotePosix(value){
  return "'"+String(value??"").replace(/'/g,"'\\''")+"'";
}

function quoteWindows(value){
  const text=String(value??"");
  if(!/[\s"&|<>^()]/.test(text))return text;
  return `"${text.replace(/"/g,'""')}"`;
}

export function interactiveTerminalCommand(command,args=[],{platform=process.platform}={}){
  const executable=String(command||"").trim();
  if(!executable)throw new Error("command is required");
  const quote=platform==="win32"?quoteWindows:quotePosix;
  return [executable,...(Array.isArray(args)?args:[])].map(quote).join(" ");
}
