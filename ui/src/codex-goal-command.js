// The composer's /goal command, read into what it asks of the thread's goal, as the Codex TUI takes it: "/goal" alone or
// "/goal edit" asks to see the goal, "/goal clear", "/goal pause" and "/goal resume" act on it, and "/goal" with any other text
// sets that text as the new objective. A message that is not this command reads as null.
// Only a send needs it (turn-support.js imports it, and that loads at idle after the first paint), so it is a module of its own
// rather than a part of codex-turn-options.js, which the app's first script carries (bundle budget B11).

// The arguments that are actions of their own, in lower case.
const GOAL_ACTIONS=new Set(["clear","pause","resume"]);

// A trimmed message split at its first whitespace: the command word and what follows it, trimmed.
function commandAndArgument(text){
  const wordEnd=text.search(/\s/);
  return wordEnd<0?[text,""]:[text.slice(0,wordEnd),text.slice(wordEnd).trim()];
}

export function parseCodexGoalCommand(message){
  // The command is the message's first word, as the composer splits a send into its command and the rest: "/goals" and
  // "/goal:x" are other words.
  const [word,argument]=commandAndArgument((message==null?"":String(message)).trim());
  if(word!=="/goal")return null;
  // No argument or "edit" shows the goal, an action word in any case is that action, and any other text is the objective as typed.
  const keyword=argument.toLowerCase();
  if(keyword===""||keyword==="edit")return {type:"show"};
  return GOAL_ACTIONS.has(keyword)?{type:keyword}:{type:"set",objective:argument};
}
