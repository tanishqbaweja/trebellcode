// What Trebell's first load may apply when the person switched harness while it ran (Settings opens before that load returns, and a
// slow harness can take seconds to list its models). Without a switch it applies everything. With one, the startup model catalog
// belongs to the harness being replaced and is never shown (the switch, or a failed switch's refresh, brings the right one). The
// startup bootstrap and runtime still apply unless a switch has already applied its own runtime: until then they are what the server runs.
// switchSeq counts switches begun; appliedSeq counts switches that set the runtime (one that landed, or failed after the server moved).
export function startupRuntimeOutcome({switchSeqAtStart=0,switchSeq=0,appliedSeqAtStart=0,appliedSeq=0}={}){
  return {applyCatalog:switchSeq===switchSeqAtStart,keepLandedRuntime:appliedSeq!==appliedSeqAtStart};
}
