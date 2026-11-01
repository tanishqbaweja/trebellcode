// The cue a SnapShot shows over the window it captured: a click-through, transparent window over that window's bounds (main.mjs
// showSnapshotFeedback) whose page is one box drawn over the whole of it. The box is position:fixed against the viewport, so the
// page needs no reset of its own and nothing in it can scroll; a transparent window shows the rest of the page as clear.
// flash: a light tint with a 3 px ring, else only a 2 px ring. animations: the box rises in quickly and fades out with the CSS
// ease-out keyword, else it shows as it is for a moment. The ring is the app's accent (ui/src/theme.css --ac, #8b7cff).

const ACCENT="139,124,255";
const RING_FLASH=`background:rgba(255,255,255,.1);box-shadow:inset 0 0 0 3px rgba(${ACCENT},.9)`;
const RING_ONLY=`box-shadow:inset 0 0 0 2px rgba(${ACCENT},.6)`;
// How long the cue's window stays: the fade's length and a little after it, or a moment for a cue that does not move.
export const CAPTURE_CUE_TIMING=Object.freeze({fadeMs:400,afterFadeMs:80,stillMs:160});

export function captureCueLifetime({animations=true}={}){
  return animations?CAPTURE_CUE_TIMING.fadeMs+CAPTURE_CUE_TIMING.afterFadeMs:CAPTURE_CUE_TIMING.stillMs;
}

export function captureCuePage({flash=true,animations=true}={}){
  const box=`#cue{position:fixed;inset:0;pointer-events:none;${flash?RING_FLASH:RING_ONLY}}`;
  const fade=animations
    ?`#cue{animation:cue-fade ${CAPTURE_CUE_TIMING.fadeMs}ms ease-out forwards}@keyframes cue-fade{0%{opacity:.3}20%{opacity:1}100%{opacity:0}}`
    :"";
  return `<!doctype html><meta charset="utf-8"><style>${box}${fade}</style><div id="cue"></div>`;
}
