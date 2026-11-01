// Two readings Antigravity's code makes of the machine (antigravity-auth.mjs). The folder "~" stands for when Antigravity's
// bundled Python expands it (os.path.expanduser), which is where the person's own ~/.gemini skills are linked from. On Windows:
// USERPROFILE, else HOMEDRIVE followed by HOMEPATH, in any case of the names. Elsewhere: HOME. Else the system's home for the
// person. And an Antigravity process that exited because the machine gives it no IPv6 sockets, which its log says with AF_INET6
// or enforce_kernel_ipv6_support. Only a process exit counts, found through the failures that wrap it. The same checks through
// a real sign-in, chat, model list and install: antigravity-sign-in, antigravity-api-key, antigravity-model-refresh-notice and
// antigravity-runtime-installer tests.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { ANTIGRAVITY_IPV6_MESSAGE, antigravityIpv6Failure, homeForTilde, prepareAntigravityHome } from "../src/antigravity-auth.mjs";

// [why, platform, environment, the folder ~ stands for (null: the system's home for the person)]
const TILDE_CASES=[
  ["USERPROFILE comes first","win32",{USERPROFILE:"C:\\Users\\me",HOMEDRIVE:"D:",HOMEPATH:"\\Other",HOME:"/home/me"},"C:\\Users\\me"],
  ["then the drive and the path","win32",{HOMEDRIVE:"D:",HOMEPATH:"\\Users\\me",HOME:"/home/me"},"D:\\Users\\me"],
  ["Windows reads a name in any case","win32",{UserProfile:"C:\\Users\\Mixed"},"C:\\Users\\Mixed"],
  ["the drive and the path in any case too","win32",{HomeDrive:"E:",homepath:"\\Users\\me"},"E:\\Users\\me"],
  ["the name as written before another spelling","win32",{userprofile:"C:\\Users\\lower",USERPROFILE:"C:\\Users\\Upper"},"C:\\Users\\Upper"],
  ["an empty USERPROFILE is unset","win32",{USERPROFILE:"",HOMEDRIVE:"D:",HOMEPATH:"\\Users\\me"},"D:\\Users\\me"],
  ["a path without its drive is no home","win32",{HOMEPATH:"\\Users\\me"},null],
  ["Python stopped reading HOME on Windows","win32",{HOME:"/home/me"},null],
  ["HOME elsewhere","linux",{HOME:"/home/me",USERPROFILE:"C:\\Users\\me"},"/home/me"],
  ["HOME on macOS","darwin",{HOME:"/Users/me"},"/Users/me"],
  ["another case is another variable outside Windows","linux",{home:"/home/me"},null],
  ["an empty HOME is unset","linux",{HOME:""},null],
  ["nothing set","linux",{},null],
  ["no environment at all","linux",undefined,null],
];
test("~ is USERPROFILE, else HOMEDRIVE then HOMEPATH on Windows (any case, never HOME), HOME elsewhere, else the system's home",()=>{
  for(const [why,platform,env,folder] of TILDE_CASES)assert.equal(homeForTilde(env,platform),folder??homedir(),why);
});

test("the person's skills are linked from HOMEDRIVE and HOMEPATH when Windows has no USERPROFILE",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-agy-tilde-")),person=join(root,"person"),decoy=join(root,"decoy"),trebell=join(root,"trebell");
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}));
  for(const [folder,name] of [[person,"review"],[decoy,"decoy"]]){
    await mkdir(join(folder,".gemini","config","skills",name),{recursive:true});
    await writeFile(join(folder,".gemini","config","skills",name,"SKILL.md"),`---\nname: ${name}\n---\n`);
  }
  // The person's folder split where Windows splits it: its drive (or first folder) in HOMEDRIVE, the rest in HOMEPATH.
  const cut=person.indexOf(sep,1),env={HOMEDRIVE:person.slice(0,cut),HOMEPATH:person.slice(cut),HOME:decoy,TREBELL_HOME:trebell};
  await prepareAntigravityHome({env,platform:"win32"});
  const skills=join(trebell,"antigravity-home","config","skills");
  assert.equal(await readFile(join(skills,"review","SKILL.md"),"utf8"),"---\nname: review\n---\n");
  await assert.rejects(readFile(join(skills,"decoy","SKILL.md"),"utf8"),{code:"ENOENT"},"HOME is not where Windows' ~ is");
});

// A failure as the ACP client ends a request with when the agent's process exits: its log excerpt on processExit.
const exited=(excerpt,code=1)=>Object.assign(new Error(`ACP runtime exited code=${code} signal=null${excerpt?"\n"+excerpt:""}`),{processExit:{code,signal:null,excerpt}});

test("an Antigravity whose log says it got no IPv6 socket is explained, with the failure as its cause",()=>{
  for(const log of ["OSError: [Errno 97] Address family not supported by protocol: AF_INET6","Traceback (most recent call last):\nsocket.socket(AF_INET6, SOCK_STREAM)\n","E1027 grpc: flag enforce_kernel_ipv6_support is set but this machine has no IPv6"]){
    const failure=exited(log),explained=antigravityIpv6Failure(failure);
    assert.equal(explained?.message,ANTIGRAVITY_IPV6_MESSAGE,log);
    assert.equal(explained.code,"ANTIGRAVITY_IPV6");assert.equal(explained.cause,failure);
  }
});

test("the exit is found through the failures that wrap it, as a chat's or a key sign-in's",()=>{
  const inner=exited("OSError: [Errno 97] Address family not supported by protocol (AF_INET6)");
  const once=Object.assign(new Error("Antigravity could not sign in with 'gemini-api-key': lost"),{code:-32603,cause:inner});
  const twice=new Error("the chat could not start",{cause:once});
  for(const failure of [once,twice]){
    const explained=antigravityIpv6Failure(failure);
    assert.equal(explained?.message,ANTIGRAVITY_IPV6_MESSAGE);assert.equal(explained.cause,failure,"the failure given stays the cause");
  }
});

test("only a process exit whose log names the IPv6 words as whole words counts",()=>{
  for(const log of ["socket family AF_INET64 is unknown","MY_AF_INET6 is off","flag enforce_kernel_ipv6_supported","af_inet6 refused","Address family not supported by protocol","",undefined])
    assert.equal(antigravityIpv6Failure(exited(log)),null,String(log));
  // The words in a message, with no process exit behind it, are not an exit.
  assert.equal(antigravityIpv6Failure(new Error("ACP runtime exited code=1 signal=null\nOSError: AF_INET6")),null);
  assert.equal(antigravityIpv6Failure(Object.assign(new Error("Internal error"),{code:-32603,data:{message:"AF_INET6"}})),null);
  for(const nothing of [null,undefined,"AF_INET6",42])assert.equal(antigravityIpv6Failure(nothing),null,String(nothing));
});
