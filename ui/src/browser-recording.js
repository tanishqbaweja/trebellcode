import { useSyncExternalStore } from "react";

// Whether the Browser panel is recording the agent browser's window: PreviewPage sets it with each phase of its recording, which goes
// on while the panel is away (another tab, the panel closed). The panel's Browser tab and the header button that opens the panel read
// it here, as the panel's own part is loaded only once it is shown, and say a recording is on until it stops.
let recording=false;const listeners=new Set();
export function setBrowserRecording(next){if(recording===Boolean(next))return;recording=Boolean(next);for(const listener of listeners)listener()}
function subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener)}
export function useBrowserRecording(){return useSyncExternalStore(subscribe,()=>recording)}
