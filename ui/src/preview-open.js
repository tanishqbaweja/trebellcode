// An address asked for in the Browser panel (an action's preview) waits here until the panel takes it. The panel's part loads the
// first time the panel shows it, so it is not listening yet when the address is asked for: an event alone was lost then, and the
// panel opened on its default address. A panel already drawn takes it at once, from the event.
let waiting="";

export function requestPreview(url,target=globalThis.window){
  const next=String(url||"").trim();if(!next)return;
  waiting=next;
  target?.dispatchEvent?.(new CustomEvent("trebell:preview-open",{detail:next}));
}

// The address asked for, once: a panel drawn later opens on its own default address again.
export function takeRequestedPreview(){const next=waiting;waiting="";return next}
