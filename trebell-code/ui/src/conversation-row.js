export function sameConversationMessageRowProps(previous,next){
  const a=previous?.message||{},b=next?.message||{};
  return a.id===b.id
    &&a.role===b.role
    &&a.text===b.text
    &&a.turnId===b.turnId
    &&previous.activeFind===next.activeFind
    &&previous.allowRevert===next.allowRevert
    &&previous.projectPath===next.projectPath
    &&previous.environmentId===next.environmentId
    &&previous.threadId===next.threadId
    &&previous.onEditFromHere===next.onEditFromHere;
}
