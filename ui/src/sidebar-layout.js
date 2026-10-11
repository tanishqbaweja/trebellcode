// Below this window width the sidebar starts collapsed (a narrow browser window; the desktop window is at least 1180px wide):
// beside it the main column would be narrower than the conversation and composer need, and the page would scroll sideways.
// It is the narrowest width the shell lays out with the sidebar open.
export const SIDEBAR_AUTO_COLLAPSE_WIDTH=820;

export function sidebarAutoCollapses(width){
  const value=Number(width);
  return Number.isFinite(value)&&value>0&&value<SIDEBAR_AUTO_COLLAPSE_WIDTH;
}
