// What a /goal message asks for: only a send reads it (turn-support.js), so it loads with that at idle after the first paint (B11)
// instead of with codex-turn-options.js in the app's first script.
// /goal shows the goal (as does /goal edit), clear, pause and resume control it, and any other
// text becomes the new objective. Returns null for every other message.
export function parseCodexGoalCommand(text){
  const match=/^\/goal(?:\s+([\s\S]*))?$/u.exec(String(text??"").trim());
  if(!match)return null;
  const argument=(match[1]??"").trim();
  switch(argument.toLowerCase()){
    case "":case "edit":return {type:"show"};
    case "clear":return {type:"clear"};
    case "pause":return {type:"pause"};
    case "resume":return {type:"resume"};
    default:return {type:"set",objective:argument};
  }
}
