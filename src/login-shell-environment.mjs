import { spawn } from "node:child_process";
import { homedir, userInfo } from "node:os";

// The desktop app opened from the Dock, Finder or a Linux launcher inherits launchd's or the session's bare PATH
// (/usr/bin:/bin:/usr/sbin:/sbin on macOS), not the one the person's login shell builds, so claude, codex, cursor-agent, grok and
// opencode installed under ~/.local/bin, Homebrew or a version manager read as not installed, and a keg-only JDK has no JAVA_HOME.
// desktop/main.mjs reads PATH, JAVA_HOME and mise's record of the PATH entries it added (__MISE_DIFF) from `$SHELL -ilc` once, before
// the GUI server starts, between markers that tell them from whatever the profile prints, as T3 Code's readEnvironmentFromLoginShell
// does. The read has two seconds: a profile that hangs, fails or prints nothing leaves the environment as it was. Windows is unchanged.
export const LOGIN_SHELL_NAMES=Object.freeze(["PATH","JAVA_HOME","__MISE_DIFF"]);
export const LOGIN_SHELL_TIMEOUT_MS=2000;
const MAX_OUTPUT=1024*1024;
const startMarker=name=>`__TREBELL_ENV_${name}_START__`,endMarker=name=>`__TREBELL_ENV_${name}_END__`;

// One printenv for each name between its markers: an unset name prints nothing, and `|| true` keeps the command's exit code 0.
export function loginShellCommand(names=LOGIN_SHELL_NAMES){
  return names.map(name=>{
    if(!/^[A-Z0-9_]+$/.test(name))throw new Error(`Unsupported environment variable name: ${name}`);
    return `printf '%s\\n' '${startMarker(name)}'; printenv ${name} || true; printf '%s\\n' '${endMarker(name)}'`;
  }).join("; ");
}

// The values between each name's markers, without the line breaks printf and printenv end them with; an empty one is left out.
export function parseLoginShellOutput(output,names=LOGIN_SHELL_NAMES){
  const text=String(output??""),values={};
  for(const name of names){
    const start=text.indexOf(startMarker(name));if(start<0)continue;
    const from=start+startMarker(name).length,end=text.indexOf(endMarker(name),from);if(end<0)continue;
    const value=text.slice(from,end).replace(/^\r?\n/,"").replace(/\r?\n$/,"");
    if(value)values[name]=value;
  }
  return values;
}

// The login shell's entries first, in its order, then the ones only the app inherited, each once (T3 Code's mergePathEntries).
export function mergePathEntries(preferred,inherited){
  const seen=new Set(),merged=[];
  for(const value of [preferred,inherited])for(const entry of String(value||"").split(":")){
    const item=entry.trim();
    if(item&&!seen.has(item)){seen.add(item);merged.push(item)}
  }
  return merged.join(":");
}

// The person's login shell: the SHELL their session set, or their account's.
export function loginShell(env=process.env){
  const named=String(env?.SHELL||"").trim();
  if(named)return named;
  try{return String(userInfo().shell||"").trim()}catch{return ""}
}

// Runs `<shell> -ilc` (interactive and login, so the profile's PATH additions load) with the app's environment, in the home folder,
// and resolves the names it printed, or {} when it fails, prints none or has not finished within timeoutMs. Off Windows the shell
// runs in a process group of its own, so an inherited terminal's job control cannot stop it and a timeout ends what its profile
// started as well; on Windows (tests only) a detached child would open a console window.
export function readLoginShellEnvironment({env=process.env,shell=loginShell(env),names=LOGIN_SHELL_NAMES,timeoutMs=LOGIN_SHELL_TIMEOUT_MS,cwd=homedir(),spawnFn=spawn,log=()=>{}}={}){
  return new Promise(resolve=>{
    let child=null,output="",settled=false,timer=null;
    const settle=(values,failure=null)=>{
      if(settled)return;
      settled=true;clearTimeout(timer);
      if(failure)log(`Trebell could not read PATH from the login shell (${shell} -ilc): ${failure}`);
      resolve(values);
    };
    if(!shell){settle({});return}
    const group=process.platform!=="win32";
    try{child=spawnFn(shell,["-ilc",loginShellCommand(names)],{cwd,env,stdio:["ignore","pipe","ignore"],detached:group,windowsHide:true})}
    catch(error){settle({},error?.message||String(error));return}
    timer=setTimeout(()=>{
      try{if(group&&child.pid)process.kill(-child.pid,"SIGKILL")}catch{}
      try{child.kill("SIGKILL")}catch{}
      settle({},`it did not finish within ${timeoutMs/1000} seconds.`);
    },timeoutMs);
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on("data",chunk=>{if(output.length<MAX_OUTPUT)output+=chunk});
    child.once("error",error=>settle({},error?.message||String(error)));
    child.once("close",(code,signal)=>code===0?settle(parseLoginShellOutput(output,names)):settle({},signal?`it ended on ${signal}.`:`it exited with code ${code}.`));
  });
}

// Puts what the login shell set into env (the desktop app's process.env, which the GUI server starts from, and each harness from the
// names runtime-environment.mjs passes it): its PATH ahead of the inherited one, mise's record along with that PATH, and its JAVA_HOME
// where none is set. mise's record reaches what takes the whole environment (the terminal drawer's shell), and a harness only when its
// profile lists __MISE_DIFF, as it can encode the values of mise's [env], secrets among them; a CLI started through a `mise x` wrapper
// of the same name needs it, or mise rebuilds PATH with that wrapper first and it starts itself again. Resolves what was read.
export async function hydrateLoginShellEnvironment(env=process.env,{platform=process.platform,...options}={}){
  if(platform!=="darwin"&&platform!=="linux")return {};
  const shell=await readLoginShellEnvironment({env,...options});
  if(shell.PATH){
    env.PATH=mergePathEntries(shell.PATH,env.PATH);
    if(shell.__MISE_DIFF)env.__MISE_DIFF=shell.__MISE_DIFF;
  }
  if(!String(env.JAVA_HOME||"").trim()&&shell.JAVA_HOME)env.JAVA_HOME=shell.JAVA_HOME;
  return shell;
}
