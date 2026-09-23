export const DEFAULT_LAYOUT={sidebarWidth:258,rightPanelWidth:460,terminalHeight:330};
export const LAYOUT_LIMITS={
  sidebarWidth:[210,420],
  rightPanelWidth:[340,820],
  terminalHeight:[190,620],
};

export function clampLayoutValue(key,value){
  const [min,max]=LAYOUT_LIMITS[key]||[0,Number.MAX_SAFE_INTEGER];
  const numeric=Number(value);
  if(!Number.isFinite(numeric))return DEFAULT_LAYOUT[key]??min;
  return Math.max(min,Math.min(max,Math.round(numeric)));
}

export function normalizeLayoutPreferences(value={}){
  return {
    sidebarWidth:clampLayoutValue("sidebarWidth",value.sidebarWidth),
    rightPanelWidth:clampLayoutValue("rightPanelWidth",value.rightPanelWidth),
    terminalHeight:clampLayoutValue("terminalHeight",value.terminalHeight),
  };
}

