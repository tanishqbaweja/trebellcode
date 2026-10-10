// Only absolute web and mail links are links in a reply. A relative or file-path href would load inside the app window (or,
// from the desktop app, reach the system browser as a local server URL), so ChatMarkdown keeps it as text.
const LINK_PROTOCOLS=new Set(["http:","https:","mailto:"]);

export function externalHref(href){
  const value=String(href||"").trim();
  try{const url=new URL(value);return LINK_PROTOCOLS.has(url.protocol)?url.href:null}catch{return null}
}
