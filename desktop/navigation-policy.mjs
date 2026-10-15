// What the desktop shell lets the app window open and show. The app window carries the desktop bridge (window.trebellDesktop:
// screenshots, mouse and keyboard control, files), so it only ever shows the app itself, its IPC answers only the app's own
// pages, and a link it opens elsewhere goes to the default browser only when it is a web or mail link: shell.openExternal
// hands any other scheme (file:, a custom protocol handler) to whatever program claims it.
const EXTERNAL_SCHEMES=new Set(["http:","https:","mailto:"]);

// The URL to open in the default browser, or null for a link that must not leave the app.
export function externalUrl(value){
  try{const url=new URL(String(value??""));return EXTERNAL_SCHEMES.has(url.protocol)?url.href:null}
  catch{return null}
}

// True when value is a page of the app served at appUrl (same scheme, host and port).
export function isAppUrl(value,appUrl){
  if(!value||!appUrl)return false;
  try{const origin=new URL(String(value)).origin;return origin!=="null"&&origin===new URL(String(appUrl)).origin}
  catch{return false}
}
