// Opens a link that comes from the server or a catalog (a pull request, a release, a preview, a plugin's share or install page)
// in a new browser tab, and only when it is a web or mail link. window.open of a javascript: or data: URL runs it with the app's
// own origin, which can call the app's local API; the desktop shell sends only these schemes to the default browser anyway.
// noopener keeps the opened page from reaching back into the app.
const WEB_SCHEMES=new Set(["http:","https:","mailto:"]);

// The link's address when it may be opened, or null.
export function webLinkHref(value){
  try{const url=new URL(String(value??""));return WEB_SCHEMES.has(url.protocol)?url.href:null}
  catch{return null}
}

// Opens the link in a new tab and returns true, or returns false for a link that is refused.
export function openWebLink(value,{open=(...args)=>window.open(...args)}={}){
  const href=webLinkHref(value);if(!href)return false;
  open(href,"_blank","noopener,noreferrer");return true;
}
