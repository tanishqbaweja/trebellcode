export function autoCompactionDecision(tokenUsage,{enabled=false,thresholdPercent=85}={}){
  const threshold=Math.max(70,Math.min(95,Number(thresholdPercent)||85));
  const windowSize=Number(tokenUsage?.modelContextWindow);
  const inputTokens=Number(tokenUsage?.last?.inputTokens);
  if(!enabled)return {shouldCompact:false,reason:"disabled",thresholdPercent:threshold,windowSize:null,inputTokens:null,utilizationPercent:null};
  if(!Number.isFinite(windowSize)||windowSize<=0||!Number.isFinite(inputTokens)||inputTokens<0){
    return {shouldCompact:false,reason:"usage-unavailable",thresholdPercent:threshold,windowSize:null,inputTokens:null,utilizationPercent:null};
  }
  const utilizationPercent=Math.max(0,Math.min(100,inputTokens/windowSize*100));
  return {
    shouldCompact:utilizationPercent>=threshold,
    reason:utilizationPercent>=threshold?"threshold-reached":"below-threshold",
    thresholdPercent:threshold,
    windowSize,
    inputTokens,
    utilizationPercent:Number(utilizationPercent.toFixed(2)),
  };
}
