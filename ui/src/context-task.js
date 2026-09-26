const CONTINUATION=/^(?:continue\b.*|keep going\b.*|go on\b.*|carry on\b.*|proceed\b.*|next\b.*|same\b.*|do (?:it|that|this)\b.*|finish (?:it|that|this)\b.*|fix (?:it|that|this)\b.*|try again\b.*|retry\b.*|yes\b.*|yep\b.*|ok\b.*|okay\b.*)$/i;

export function contextTaskText(currentTask,previousTask=""){
  const current=String(currentTask||"").trim(),previous=String(previousTask||"").trim();
  if(!current)return previous;
  if(!previous||!CONTINUATION.test(current))return current;
  return `Previous task: ${previous}\nCurrent follow-up: ${current}`;
}

export function contextTaskAnchor(currentTask,previousTask=""){
  const current=String(currentTask||"").trim(),previous=String(previousTask||"").trim();
  if(!current)return previous;
  return previous&&CONTINUATION.test(current)?previous:current;
}
