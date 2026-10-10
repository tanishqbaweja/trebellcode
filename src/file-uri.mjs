import { fileURLToPath, pathToFileURL } from "node:url";

// File references travel to harnesses as file: URLs, percent-encoded the way T3 Code builds them (pathToFileURL), so
// spaces, '#', '%' and '?' in a path survive. A path keeps its own style: a POSIX path (a remote workspace's) stays
// POSIX even when Trebell itself runs on Windows, and a drive or UNC path stays a Windows path on any host.
const WINDOWS_PATH=/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/])/i;
export function fileUri(path){
  const value=String(path||"");
  return pathToFileURL(value,{windows:WINDOWS_PATH.test(value)}).href;
}

// The path a file: URL names, in the style it was written in (a drive letter or a host means Windows); null for a
// URI that is not a file: URL.
export function fileUriPath(uri){
  let url;try{url=new URL(String(uri||""))}catch{return null}
  if(url.protocol!=="file:")return null;
  try{return fileURLToPath(url,{windows:/^\/[a-z]:\//i.test(url.pathname)||url.host!==""})}catch{return null}
}
