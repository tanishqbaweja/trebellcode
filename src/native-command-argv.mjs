const SHELL_META=/[|&;<>]/;

function tokenize(value){
  const text=String(value||"").trim(),tokens=[];let token="",quote=null,escaped=false;
  for(let index=0;index<text.length;index++){
    const char=text[index];
    if(escaped){token+=char;escaped=false;continue}
    if(char==="\\"&&quote==='"'){escaped=true;continue}
    if(quote){if(char===quote){quote=null;continue}token+=char;continue}
    if(char==='"'||char==="'"){quote=char;continue}
    if(/\s/.test(char)){if(token){tokens.push(token);token=""}continue}
    token+=char;
  }
  if(quote)return null;
  if(token)tokens.push(token);
  return tokens;
}

function hasShellSyntax(value){
  const command=String(value||"");
  return SHELL_META.test(command)||command.includes("\n")||command.includes("\r");
}

export function normalizeNativeCommandArguments(value={}){
  const source=value&&typeof value==="object"&&!Array.isArray(value)?value:{},args={...source};
  if(typeof args.args==="string"&&args.args.length)args.args=[args.args];
  const command=String(args.command||"").trim();
  const explicitArgs=Array.isArray(args.args)&&args.args.length>0;
  if(!command||explicitArgs||!/\s/.test(command)||hasShellSyntax(command))return args;
  const tokens=tokenize(command);
  if(!tokens||tokens.length<2)return args;
  return {...args,command:tokens[0],args:tokens.slice(1)};
}

export function nativeCommandSemanticError(value={}){
  const args=value&&typeof value==="object"&&!Array.isArray(value)?value:{},command=String(args.command||"").trim();
  if(command&&hasShellSyntax(command))return "$.command contains shell syntax; invoke an explicit shell executable and put the script in args";
  return null;
}
