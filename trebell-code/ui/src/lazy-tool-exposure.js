function text(value){return String(value||"").toLowerCase()}

const BROWSER_TASK=/\b(browser|website|web\s?page|webpage|playwright|dom|frontend|front-end|css|html|responsive|screenshot|browser console|network (?:request|error)|page load|url)\b/i;
const COMPUTER_TASK=/\b(computer use|desktop control|mouse|keyboard|screen coordinates?|primary display|desktop screenshot|windows desktop)\b/i;
const SOURCE_CONTROL_TASK=/\b(git|github|gitlab|branch|commit|push|pull request|merge request|source control|rebase|cherry-pick|upstream|remote branch|pr)\b/i;
const DELEGATION_TASK=/\b(delegate|delegation|parallel(?:ize|ized|ism)?|multi[- ]agent|fan[- ]out|independent subtasks?|in parallel)\b/i;

export function specializedToolSelection(taskText,{browser=false,computer=false,sourceControl=false,delegation=false}={}){
  const task=text(taskText);
  return {
    browser:Boolean(browser&&BROWSER_TASK.test(task)),
    computer:Boolean(computer&&COMPUTER_TASK.test(task)),
    sourceControl:Boolean(sourceControl&&SOURCE_CONTROL_TASK.test(task)),
    delegation:Boolean(delegation&&DELEGATION_TASK.test(task)),
  };
}

export function specializedToolNamespaceNames(taskText,availability={}){
  const selected=specializedToolSelection(taskText,availability),names=[];
  if(selected.browser)names.push("trebell_browser");
  if(selected.computer)names.push("trebell_computer");
  if(selected.sourceControl)names.push("trebell_source_control");
  if(selected.delegation)names.push("trebell_delegate");
  return names;
}
