import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { trebellHome } from "./paths.mjs";

// A Codex app-server listening on ws://127.0.0.1:<port> takes any program on this machine that connects, unless it asks for a token
// (OpenAI's app-server docs: --ws-auth capability-token --ws-token-file <absolute path>; a client presents Authorization: Bearer
// <token> in the WebSocket handshake, checked before initialize). Each app-server Trebell starts gets a random token of its own, in an
// owner-only file under Trebell's run folder that Codex reads as it starts; release() removes the file once that app-server has ended.
// quote: the command is started through cmd.exe (a codex.cmd launcher), which gets its arguments as one line, so a path with a space
// or a character cmd.exe reads is passed in quotes.
export async function codexAppServerToken({env=process.env,quote=false}={}){
  const token=randomBytes(32).toString("base64url"),path=join(trebellHome(env),"run",`codex-app-server-${randomUUID()}.token`);
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  await writeFile(path,token,{encoding:"utf8",mode:0o600});
  return {token,path,args:["--ws-auth","capability-token","--ws-token-file",quote&&/[\s&()^|<>]/.test(path)?`"${path}"`:path],release:()=>rm(path,{force:true}).catch(()=>{})};
}

// The token the relay sends to the app-server a connection's route goes to ({key, url}): the pool entry the route names (servers, by
// pool key: a thread's or the catalog's app-server) while it is at the route's address, else the catalog app-server the base route
// points at (base). An app-server that died stays in the pool until its thread is used again, and the OS can give its port to a newer
// one: found by its address alone, it lent that newer one its own token, which was refused with 401.
export function codexUpstreamToken(servers,route,base=null){
  const url=route?.url||null;if(!url)return null;
  const pooled=route.key!=null?servers?.get?.(route.key):null;
  if(pooled?.targetUrl===url)return pooled.wsToken||null;
  return base?.targetUrl===url?base.wsToken||null:null;
}
