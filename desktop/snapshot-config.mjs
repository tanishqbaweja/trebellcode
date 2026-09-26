export const SNAPSHOT_SOUNDS=Object.freeze(["soft-pop","camera-shutter"]);
export const DEFAULT_SNAPSHOT_CONFIG=Object.freeze({
  enabled:false,
  shortcut:"CommandOrControl+Shift+S",
  includeText:false,
  playSound:true,
  sound:"soft-pop",
  flash:true,
  animations:true,
});

export function normalizeSnapshotConfig(input={},current=DEFAULT_SNAPSHOT_CONFIG){
  const sound=SNAPSHOT_SOUNDS.includes(input.sound)?input.sound:(SNAPSHOT_SOUNDS.includes(current.sound)?current.sound:DEFAULT_SNAPSHOT_CONFIG.sound);
  return {
    enabled:"enabled" in input?Boolean(input.enabled):Boolean(current.enabled),
    shortcut:String(input.shortcut||current.shortcut||DEFAULT_SNAPSHOT_CONFIG.shortcut).trim().slice(0,120)||DEFAULT_SNAPSHOT_CONFIG.shortcut,
    includeText:"includeText" in input?Boolean(input.includeText):Boolean(current.includeText),
    playSound:"playSound" in input?Boolean(input.playSound):current.playSound!==false,
    sound,
    flash:"flash" in input?Boolean(input.flash):current.flash!==false,
    animations:"animations" in input?Boolean(input.animations):current.animations!==false,
  };
}
