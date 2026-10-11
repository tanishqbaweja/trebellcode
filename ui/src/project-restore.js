// Undo of a project removal. GET /api/projects lists each project whole (apart from a clone job's temporary folder) and
// POST /api/projects saves every field it lists, so the list's own record, sent back, puts the project back as it was.

// What the server works out for the list or the page adds to a card: the id and times (a restore gets new ones), the
// environment summary, effective settings, Git state and discovered actions. Everything else is what the person saved.
const DERIVED_PROJECT_FIELDS=new Set(["id","createdAt","lastOpenedAt","environment","effectiveSettings","git","remote","suggested"]);

// The POST /api/projects body that puts a removed project back: its path and environment, then each field it had saved.
// Settings overrides go with the model, permission, workspace, submodule and cleanup fields that mirror them; the server
// applies the overrides first and those fields after, so the two come back as they were.
export function projectRestoreBody(project){
  const body={};
  for(const [key,value] of Object.entries(project||{}))if(!DERIVED_PROJECT_FIELDS.has(key)&&value!==undefined)body[key]=value;
  body.path=project?.path;body.environmentId=project?.environmentId||null;
  return body;
}

// Why Undo could not put a project back as it was, or null when it can. While a clone runs, its job keeps writing to the
// record (and its temporary folder is not listed), and the server saves no project to an environment that is switched off
// or no longer saved.
export function projectRestoreBlocker(project){
  if(["running","cancelling"].includes(project?.cloneJob?.status))return "cloning";
  if(project?.environmentId&&project.environment?.type==="unknown")return "environment-gone";
  if(project?.environmentId&&project.environment?.enabled===false)return "environment-off";
  return null;
}

// The question asked before a removal Undo could not put back, saying what goes with it.
export function projectRemovalQuestion(project,blocker=null){
  const name="“"+String(project?.name||project?.path||"this project")+"”";
  const lost="its saved actions, hooks and settings are lost";
  if(blocker==="cloning")return `Remove ${name} while it is still cloning? This cannot be undone: ${lost}. The clone keeps running.`;
  if(blocker==="environment-off")return `Remove ${name}? Its environment is switched off, so this cannot be undone: ${lost}.`;
  if(blocker==="environment-gone")return `Remove ${name}? Its environment is no longer saved, so this cannot be undone: ${lost}.`;
  return `Remove ${name}? This cannot be undone: ${lost}.`;
}
