// A whole path that is a filesystem root: "/", "\", "C:", "C:\" or "C:/", also behind a "\\?\" or "\\.\" device prefix.
const ROOT=/^(?:[\\/]{2}[?.][\\/])?(?:[a-z]:)?[\\/]*$/i;

// A workspace as a narrow cell names it: its branch, else its folder's own name (what tells checkouts apart). A root has no
// folder name, so it shows as the path itself rather than as missing metadata.
export function workspaceLabel(workspace){
  if(workspace?.branch)return String(workspace.branch);
  const cwd=String(workspace?.cwd||"").trim();
  return (ROOT.test(cwd)?cwd:cwd.split(/[\\/]+/).filter(Boolean).pop())||"No workspace metadata";
}
