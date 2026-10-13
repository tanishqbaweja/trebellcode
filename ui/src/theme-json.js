// Reading a theme file is Settings' import work alone, so it lives apart from theme-utils.js: the app shell imports that
// module at startup, and anything in it lands in the initial bundle that the B11 budget holds.

// VS Code writes its color themes as JSONC: // and /* */ comments and trailing commas. Those are dropped outside strings before the
// text is read as JSON, so a theme file VS Code reads imports as it is; anything else that is not JSON is still refused.
export function parseThemeJson(text){
  const source=String(text??"");let clean="",comma=false;
  for(let i=0;i<source.length;i++){
    const ch=source[i],next=source[i+1];
    if(ch==="/"&&next==="/"){const end=source.indexOf("\n",i);i=end<0?source.length:end-1;continue}
    if(ch==="/"&&next==="*"){const end=source.indexOf("*/",i+2);i=end<0?source.length:end+1;continue}
    if(ch===" "||ch==="\n"||ch==="\r"||ch==="\t"){clean+=ch;continue}
    // A comma is written once the next token shows it is not a trailing one.
    if(comma&&ch!=="}"&&ch!=="]")clean+=",";
    comma=ch===",";if(comma)continue;
    if(ch==='"'){let end=i+1;while(end<source.length&&source[end]!=='"')end+=source[end]==="\\"?2:1;clean+=source.slice(i,end+1);i=end;continue}
    clean+=ch;
  }
  return JSON.parse(comma?clean+",":clean);
}
