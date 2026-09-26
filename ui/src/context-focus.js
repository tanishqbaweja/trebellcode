export function repositoryFocusPaths(paths=[],chips=[]){
  return [...new Set([...(paths||[]),...(chips||[]).map(chip=>chip?.sourcePath).filter(Boolean)])];
}
