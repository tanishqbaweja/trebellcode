// The commit subject in a model's answer to Trebell's commit-message prompt. Models often wrap the subject in a Markdown code
// fence or in quote marks although the prompt asks for the subject alone, so the subject is the first line that still has words
// once each fence marker (three backticks and the language word written right after them) is taken out, without the quote marks
// and backticks at its two ends. An answer with no such line gives "".

const FENCE="```";

// A language word after a fence: letters, digits, "_" and "-", as in ```js or ```commit-msg.
function languageCharacter(character){
  return character==="_"||character==="-"||(character>="0"&&character<="9")||(character>="a"&&character<="z")||(character>="A"&&character<="Z");
}

// What a model wraps a subject in: quote marks and backticks.
const wrapping=character=>character==='"'||character==="'"||character==="`";

function withoutFences(line){
  let kept="",from=0;
  for(let fence=line.indexOf(FENCE);fence>=0;fence=line.indexOf(FENCE,from)){
    kept+=line.slice(from,fence);
    from=fence+FENCE.length;
    while(from<line.length&&languageCharacter(line[from]))from++;
  }
  return kept+line.slice(from);
}

function unwrapped(text){
  let start=0,end=text.length;
  while(start<end&&wrapping(text[start]))start++;
  while(end>start&&wrapping(text[end-1]))end--;
  return text.slice(start,end).trim();
}

export function commitSubjectIn(answer){
  for(const line of String(answer||"").split("\n")){
    const words=withoutFences(line).trim();
    if(words)return unwrapped(words);
  }
  return "";
}
