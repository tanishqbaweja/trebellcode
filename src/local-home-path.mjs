import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { posix, win32 } from "node:path";

// ~name and ~name/... are a path under the home folder of the user name, as a shell spells it (and ~name\... on Windows).
const NAMED_HOME={
  posix:/^~([A-Za-z0-9._][A-Za-z0-9._-]*)(?:\/([\s\S]*))?$/,
  win32:/^~([A-Za-z0-9._][A-Za-z0-9._-]*)(?:[\/\\]([\s\S]*))?$/,
};

function currentUserName(){try{return userInfo().username}catch{return ""}}

// The home folder a user has in the text of /etc/passwd (name:password:uid:gid:gecos:home:shell), or null.
export function homeFromPasswd(text,name){
  for(const line of String(text||"").split("\n")){
    const fields=line.split(":");
    if(fields[0]===name&&fields[5])return fields[5];
  }
  return null;
}
// Read when a path names another user, which is rare: macOS keeps its people elsewhere, so there only the person's own name is found.
function passwdHome(name){
  try{return homeFromPasswd(readFileSync("/etc/passwd","utf8"),name)}catch{return null}
}

// Where a home-relative path on this machine is, as a shell expands it: ~ and ~/... are under the home folder of the person running
// Trebell, and ~name or ~name/... under the home of the user name: the person's own name is their home, and on Linux and other Unix
// systems another user's home is the one /etc/passwd names. A path under a user Trebell cannot find is not taken as a folder named
// ~name where Trebell runs: it comes back as written, with the error that says why it cannot be used. Any other path is as written.
export function localHomePath(value,{platform=process.platform,home=homedir(),userName=currentUserName,lookupHome=passwdHome}={}){
  const raw=String(value||"").trim(),path=platform==="win32"?win32:posix;
  if(raw==="~")return {path:home};
  if(raw.startsWith("~/")||raw.startsWith("~\\"))return {path:path.join(home,raw.slice(2))};
  const named=(platform==="win32"?NAMED_HOME.win32:NAMED_HOME.posix).exec(raw);
  if(!named)return {path:raw};
  const name=named[1],own=String(userName()||"");
  const found=(platform==="win32"?name.toLowerCase()===own.toLowerCase():name===own)?home:platform==="win32"?null:lookupHome(name);
  if(!found)return {path:raw,error:`Trebell could not find the home folder of the user ${name} on this machine, so it cannot use ${raw}.`};
  return {path:named[2]?path.join(found,named[2]):found};
}
