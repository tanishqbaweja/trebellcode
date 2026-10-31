import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hydrateLoginShellEnvironment, loginShellCommand, mergePathEntries, parseLoginShellOutput, readLoginShellEnvironment } from "../src/login-shell-environment.mjs";

// A child process that prints output and ends with code, or never ends (hang); it records its spawn and the signals sent to it.
function fakeShell({output="",code=0,hang=false,fail=null}={}){
  const calls=[],kills=[];
  const spawnFn=(command,args,options)=>{
    calls.push({command,args,options});
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};child.kill=signal=>{kills.push(signal);return true};
    setImmediate(()=>{
      if(fail){child.emit("error",new Error(fail));return}
      if(output)child.stdout.emit("data",output);
      if(!hang)child.emit("close",code,null);
    });
    return child;
  };
  return {spawnFn,calls,kills};
}
const marked=values=>Object.entries(values).map(([name,value])=>`__TREBELL_ENV_${name}_START__\n${value}\n__TREBELL_ENV_${name}_END__\n`).join("");

test("the login shell prints each name between its own markers, and a name a shell could read as code is refused",()=>{
  const command=loginShellCommand(["PATH","__MISE_DIFF"]);
  assert.equal(command,"printf '%s\\n' '__TREBELL_ENV_PATH_START__'; printenv PATH || true; printf '%s\\n' '__TREBELL_ENV_PATH_END__'; "
    +"printf '%s\\n' '__TREBELL_ENV___MISE_DIFF_START__'; printenv __MISE_DIFF || true; printf '%s\\n' '__TREBELL_ENV___MISE_DIFF_END__'");
  assert.match(loginShellCommand(),/printenv PATH \|\| true.*printenv JAVA_HOME \|\| true.*printenv __MISE_DIFF \|\| true/);
  for(const name of ["PATH; rm -rf ~","$(id)","path"])assert.throws(()=>loginShellCommand([name]),/reads login shell variables by plain names/);
});

test("the values are read from between their markers whatever the profile prints, multiline and spaced ones whole, empty and missing ones left out",()=>{
  const output="Welcome back!\n\u001b]0;title\u0007"+marked({PATH:"/opt/homebrew/bin:/usr/bin"})
    +"__TREBELL_ENV_JAVA_HOME_START__\n__TREBELL_ENV_JAVA_HOME_END__\n"
    +marked({__MISE_DIFF:"  first\nsecond  "})+"fortune: a good day\n";
  assert.deepEqual(parseLoginShellOutput(output),{PATH:"/opt/homebrew/bin:/usr/bin",__MISE_DIFF:"  first\nsecond  "});
  assert.deepEqual(parseLoginShellOutput("__TREBELL_ENV_PATH_START__\r\n/a:/b\r\n__TREBELL_ENV_PATH_END__\r\n"),{PATH:"/a:/b"},"CRLF line ends");
  assert.deepEqual(parseLoginShellOutput("__TREBELL_ENV_PATH_START__\n/a:/b\n"),{},"no end marker: the shell was cut off");
  assert.deepEqual(parseLoginShellOutput(""),{});
});

test("the merged PATH has the login shell's entries first, in its order, then the inherited extras, each once",()=>{
  assert.equal(mergePathEntries("/opt/homebrew/bin:/usr/bin","/Users/test/.local/bin:/usr/bin"),"/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin");
  assert.equal(mergePathEntries(" /a : /b ::/a","/usr/bin:/bin:/b"),"/a:/b:/usr/bin:/bin");
  assert.equal(mergePathEntries("","/usr/bin:/bin"),"/usr/bin:/bin");
  assert.equal(mergePathEntries("/a",undefined),"/a");
});

test("the login shell runs interactive and login, in a process group of its own off Windows, with only its output read, and its values come back",async()=>{
  const shell=fakeShell({output:"noise\n"+marked({PATH:"/opt/tools/bin:/usr/bin",JAVA_HOME:"/opt/jdk"})});
  const env={SHELL:"/bin/zsh",PATH:"/usr/bin",HOME:"/Users/me"};
  assert.deepEqual(await readLoginShellEnvironment({env,cwd:"/Users/me",spawnFn:shell.spawnFn}),{PATH:"/opt/tools/bin:/usr/bin",JAVA_HOME:"/opt/jdk"});
  assert.equal(shell.calls.length,1);
  const [{command,args,options}]=shell.calls;
  assert.equal(command,"/bin/zsh");assert.deepEqual(args,["-ilc",loginShellCommand()]);
  assert.deepEqual(options.stdio,["ignore","pipe","ignore"]);assert.equal(options.windowsHide,true);assert.equal(options.env,env);assert.equal(options.cwd,"/Users/me");
  assert.equal(options.detached,process.platform!=="win32","its own process group, except on Windows, where a detached child opens a console");
});

test("a login shell that fails, cannot start or hangs past its bound leaves the inherited PATH and JAVA_HOME as they were",async()=>{
  for(const [name,shell,timeoutMs] of [
    ["exits 1",fakeShell({output:marked({PATH:"/opt/half-read/bin"}),code:1}),2000],
    ["cannot start",fakeShell({fail:"spawn /bin/zsh ENOENT"}),2000],
    ["hangs",fakeShell({output:"__TREBELL_ENV_PATH_START__\n/opt/never/bin\n",hang:true}),40],
  ]){
    const env={SHELL:"/bin/zsh",PATH:"/usr/bin:/bin"},logs=[],started=Date.now();
    assert.deepEqual(await hydrateLoginShellEnvironment(env,{platform:"darwin",spawnFn:shell.spawnFn,timeoutMs,log:message=>logs.push(message)}),{},name);
    assert.deepEqual(env,{SHELL:"/bin/zsh",PATH:"/usr/bin:/bin"},name);
    assert.equal(logs.length,1,name);assert.match(logs[0],/^Trebell could not read PATH from the login shell \(\/bin\/zsh -ilc\): /,name);
    if(name==="hangs"){
      assert.ok(Date.now()-started<1500,"the read gives up at its bound");
      assert.deepEqual(shell.kills,["SIGKILL"],"and ends the shell");
      assert.match(logs[0],/it did not finish within 0\.04 seconds\.$/);
    }
  }
  // No shell at all: nothing is run.
  const none=fakeShell();
  assert.deepEqual(await readLoginShellEnvironment({env:{},shell:"",spawnFn:none.spawnFn}),{});assert.equal(none.calls.length,0);
});

test("the login shell's PATH goes first with mise's record of it, and its JAVA_HOME only where none is set; Windows reads nothing",async()=>{
  const output=marked({PATH:"/Users/me/.local/bin:/mise/installs/claude/latest:/usr/bin",JAVA_HOME:"/opt/homebrew/opt/openjdk@17",__MISE_DIFF:"mise-record"});
  const missing={SHELL:"/bin/zsh",PATH:"/usr/bin:/bin:/usr/sbin:/sbin"};
  await hydrateLoginShellEnvironment(missing,{platform:"darwin",spawnFn:fakeShell({output}).spawnFn});
  assert.deepEqual(missing,{SHELL:"/bin/zsh",PATH:"/Users/me/.local/bin:/mise/installs/claude/latest:/usr/bin:/bin:/usr/sbin:/sbin",JAVA_HOME:"/opt/homebrew/opt/openjdk@17",__MISE_DIFF:"mise-record"});
  const explicit={SHELL:"/bin/bash",PATH:"/usr/bin",JAVA_HOME:"/custom/jdk"};
  await hydrateLoginShellEnvironment(explicit,{platform:"linux",spawnFn:fakeShell({output}).spawnFn});
  assert.equal(explicit.JAVA_HOME,"/custom/jdk","a JAVA_HOME already set stays");
  // mise's record travels only with the shell's PATH: without one, it is not taken.
  const noPath={SHELL:"/bin/zsh",PATH:"/usr/bin"};
  await hydrateLoginShellEnvironment(noPath,{platform:"darwin",spawnFn:fakeShell({output:marked({__MISE_DIFF:"mise-record"})}).spawnFn});
  assert.deepEqual(noPath,{SHELL:"/bin/zsh",PATH:"/usr/bin"});
  for(const platform of ["win32","freebsd"]){
    const shell=fakeShell({output}),env={Path:"C:\\Windows",SHELL:"/bin/bash"};
    assert.deepEqual(await hydrateLoginShellEnvironment(env,{platform,spawnFn:shell.spawnFn}),{});
    assert.equal(shell.calls.length,0,platform);assert.deepEqual(env,{Path:"C:\\Windows",SHELL:"/bin/bash"},platform);
  }
});

// A real login shell with a home of its own, so no profile of the machine's user runs: bash here, or Git's bash on Windows (never
// System32's bash.exe, which starts WSL).
function realBash(){
  if(process.platform!=="win32")return ["/bin/bash","/usr/bin/bash"].find(path=>existsSync(path))||null;
  try{
    const core=execFileSync("git",["--exec-path"],{encoding:"utf8",windowsHide:true,timeout:10_000}).trim();
    return [resolve(core,"..","..","..","usr","bin","bash.exe"),resolve(core,"..","..","..","bin","bash.exe")].find(path=>existsSync(path))||null;
  }catch{return null}
}
test("a real login shell's profile gives its PATH and JAVA_HOME, and one that fails or hangs gives nothing",{skip:realBash()?false:"no bash to run"},async t=>{
  const shell=realBash(),root=mkdtempSync(join(tmpdir(),"trebell-login-shell-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
  let homes=0;
  const read=async(profile,options={})=>{
    const home=join(root,"home-"+(++homes));mkdirSync(home);
    writeFileSync(join(home,".bash_profile"),profile);
    const env={...(process.platform==="win32"?{SYSTEMROOT:process.env.SYSTEMROOT,WINDIR:process.env.WINDIR}:{}),PATH:"/usr/bin:/bin",HOME:home,USERPROFILE:home,TMPDIR:tmpdir(),TEMP:tmpdir(),TMP:tmpdir()};
    const logs=[],values=await readLoginShellEnvironment({env,shell,cwd:home,timeoutMs:15_000,log:message=>logs.push(message),...options});
    return {values,logs};
  };
  // These two profiles first wait past the app's own 2 s, as a login start on a loaded machine can (Git Bash's took 0.3-0.5 s on an
  // idle one), so the reads get a limit of the test's own.
  const set=await read('sleep 2.2\necho "profile noise"\nexport PATH="/opt/login-tools/bin:$PATH"\nexport JAVA_HOME="/opt/login jdk"\necho "more noise"\n');
  assert.match(set.values.PATH,/^\/opt\/login-tools\/bin:/);assert.equal(set.values.JAVA_HOME,"/opt/login jdk");assert.equal(set.values.__MISE_DIFF,undefined);assert.deepEqual(set.logs,[]);
  const failed=await read("sleep 2.2\nexit 1\n");
  assert.deepEqual(failed.values,{});assert.match(failed.logs[0],/it exited with code 1\.$/);
  const started=Date.now(),hung=await read("sleep 3\n",{timeoutMs:600});
  assert.deepEqual(hung.values,{});assert.match(hung.logs[0],/it did not finish within 0\.6 seconds\.$/);assert.ok(Date.now()-started<2500);
});

// The wiring runs only in Electron: the desktop app reads the login shell once, as it starts, and the GUI server (which every harness
// starts from) is made only after that read has put its PATH in.
test("the desktop app starts the GUI server only after the login shell's environment is read",async()=>{
  const main=readFileSync(new URL("../desktop/main.mjs",import.meta.url),"utf8");
  assert.match(main,/import \{ hydrateLoginShellEnvironment \} from "\.\.\/src\/login-shell-environment\.mjs";/);
  assert.equal(main.match(/hydrateLoginShellEnvironment\(process\.env/g)?.length,1,"read once");
  const start=main.slice(main.indexOf("async function startGuiServer(){"),main.indexOf("async function recoverAfterFailedUpdateInstall"));
  assert.ok(start.indexOf("await loginShellRead")>0&&start.indexOf("await loginShellRead")<start.indexOf("createGuiServer("),start);
});
