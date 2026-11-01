import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { askLoginShell, hydrateLoginShellEnvironment, loginShellCommand, mergeShellPath, newShellBoundary, parseLoginShellOutput } from "../src/login-shell-environment.mjs";

// Re-pinned note: the reader was written anew with a capture of Trebell's own (a boundary drawn for each run and a NUL after each
// value, in place of a start and an end line per name), names checked as POSIX's portable names (no leading digit now) and a PATH
// merge that takes entries as written (no trimming). The cases below keep what callers rely on.

// A child process that prints output and ends with code (or on signal), or never ends (hang); it records its spawn and the signals
// sent to it.
function fakeShell({output="",code=0,signal=null,hang=false,fail=null}={}){
  const calls=[],kills=[];
  const spawnFn=(command,args,options)=>{
    calls.push({command,args,options});
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};child.kill=signal=>{kills.push(signal);return true};
    setImmediate(()=>{
      if(fail){child.emit("error",new Error(fail));return}
      if(output)child.stdout.emit("data",output);
      if(!hang)child.emit("close",signal?null:code,signal);
    });
    return child;
  };
  return {spawnFn,calls,kills};
}
// What the command prints for values (a name missing from them is not set), with the names asked for, around the boundary B.
const B="trebell-login-shell-0123456789abcdef",NUL=String.fromCharCode(0),ASKED=["PATH","JAVA_HOME","__MISE_DIFF"];
const printed=(values,names=ASKED,boundary=B)=>boundary+NUL+names.map(name=>(name in values?values[name]+"\n":"")+NUL).join("")+boundary+"\n";

test("the login shell prints a boundary, each name's value ended by a NUL and the boundary again, and a name a shell could read as code is refused",()=>{
  assert.equal(loginShellCommand(["PATH","__MISE_DIFF"],B),"printf '"+B+"\\0'; printenv PATH || true; printf '\\0'; printenv __MISE_DIFF || true; printf '\\0'; printf '"+B+"\\n'");
  assert.match(loginShellCommand(undefined,B),/printenv PATH \|\| true.*printenv JAVA_HOME \|\| true.*printenv __MISE_DIFF \|\| true/);
  for(const name of ["PATH; rm -rf ~","$(id)","path","1PATH"])assert.throws(()=>loginShellCommand([name],B),/only for variable names made of capital letters, digits and _/,name);
  assert.match(newShellBoundary(),/^trebell-login-shell-[0-9a-f]{16}$/);assert.notEqual(newShellBoundary(),newShellBoundary(),"a new one for each run");
});

test("the values are read from inside the boundary whatever the profile prints, multiline and spaced ones whole, empty and unset ones left out",()=>{
  const output="Welcome back!\n\u001b]0;title\u0007"+printed({PATH:"/home/dev/.cargo/bin:/usr/local/bin",JAVA_HOME:"",__MISE_DIFF:"  two spaces before\nand two after  "})+"fortune: a good day\n";
  assert.deepEqual(parseLoginShellOutput(output,ASKED,B),{PATH:"/home/dev/.cargo/bin:/usr/local/bin",__MISE_DIFF:"  two spaces before\nand two after  "});
  assert.deepEqual(parseLoginShellOutput(printed({PATH:"/a:/b"}).replaceAll("\n","\r\n"),ASKED,B),{PATH:"/a:/b"},"CRLF line ends");
  assert.deepEqual(parseLoginShellOutput(B+NUL+"/a:/b\n"+NUL,ASKED,B),{},"no closing boundary: the shell was cut off");
  assert.deepEqual(parseLoginShellOutput(B+"\n"+printed({PATH:"/a:/b"}).slice(B.length+1),ASKED,B),{},"a boundary without its NUL does not open");
  assert.deepEqual(parseLoginShellOutput(printed({PATH:"/a:/b"},["PATH"]),ASKED,B),{},"fewer values than names asked: not this command's output");
  assert.deepEqual(parseLoginShellOutput(printed({PATH:"/a:/b"}),ASKED,"trebell-login-shell-another"),{},"another run's boundary");
  assert.deepEqual(parseLoginShellOutput("",ASKED,B),{});
  assert.deepEqual(parseLoginShellOutput(undefined,ASKED,B),{});assert.deepEqual(parseLoginShellOutput(null,ASKED,B),{});
});

test("only the line break printenv adds goes from a value, so the ones a value starts or ends with stay",()=>{
  assert.deepEqual(parseLoginShellOutput(printed({JAVA_HOME:"/srv/jdk\n"}),ASKED,B),{JAVA_HOME:"/srv/jdk\n"});
  assert.deepEqual(parseLoginShellOutput(printed({PATH:"\r\n/srv/bin\r\n"}).replace("\r\n\n"+NUL,"\r\n\r\n"+NUL),ASKED,B),{PATH:"\r\n/srv/bin\r\n"});
  assert.deepEqual(parseLoginShellOutput(printed({PATH:"\n"}),ASKED,B),{PATH:"\n"},"a value of one line break");
  assert.deepEqual(parseLoginShellOutput(B+NUL+"/srv/bin"+NUL+NUL+NUL+B,ASKED,B),{PATH:"/srv/bin"},"no line breaks at all");
  assert.deepEqual(parseLoginShellOutput(printed({JAVA_HOME:"/srv/jdk"},["JAVA_HOME"]),["JAVA_HOME"],B),{JAVA_HOME:"/srv/jdk"},"only the names asked for");
});

test("the merged PATH has the login shell's entries first, in its order, then the inherited extras, each once and none empty",()=>{
  assert.equal(mergeShellPath("/home/dev/.cargo/bin:/usr/bin","/home/dev/.local/bin:/usr/bin"),"/home/dev/.cargo/bin:/usr/bin:/home/dev/.local/bin");
  assert.equal(mergeShellPath("/a:/b::/a:","/usr/bin:/bin:/b"),"/a:/b:/usr/bin:/bin","an empty entry would search the current folder");
  assert.equal(mergeShellPath("/opt/my tools/bin: /a","/opt/my tools/bin"),"/opt/my tools/bin: /a","entries as written, spaces kept");
  assert.equal(mergeShellPath("","/usr/bin:/bin"),"/usr/bin:/bin");
  assert.equal(mergeShellPath("/a",undefined),"/a");
});

test("the login shell runs interactive and login, in a process group of its own off Windows, with only its output read, and its values come back",async()=>{
  const shell=fakeShell({output:"noise\n"+printed({PATH:"/srv/toolchain/bin:/usr/bin",JAVA_HOME:"/srv/jdk-21"})});
  const env={SHELL:"/bin/zsh",PATH:"/usr/bin",HOME:"/Users/me"};
  assert.deepEqual(await askLoginShell({env,cwd:"/Users/me",spawnFn:shell.spawnFn,boundary:B}),{PATH:"/srv/toolchain/bin:/usr/bin",JAVA_HOME:"/srv/jdk-21"});
  assert.equal(shell.calls.length,1);
  const [{command,args,options}]=shell.calls;
  assert.equal(command,"/bin/zsh");assert.deepEqual(args,["-ilc",loginShellCommand(undefined,B)]);
  assert.deepEqual(options.stdio,["ignore","pipe","ignore"]);assert.equal(options.windowsHide,true);assert.equal(options.env,env);assert.equal(options.cwd,"/Users/me");
  assert.equal(options.detached,process.platform!=="win32","its own process group, except on Windows, where a detached child opens a console");
  const drawn=fakeShell();await askLoginShell({env,spawnFn:drawn.spawnFn});
  assert.match(drawn.calls[0].args[1],/^printf 'trebell-login-shell-[0-9a-f]{16}\\0'; /,"a boundary drawn for the run when none is given");
});

test("a login shell that fails, cannot start or hangs past its bound leaves the inherited PATH and JAVA_HOME as they were",async()=>{
  for(const [name,shell,timeoutMs] of [
    ["exits 1",fakeShell({output:printed({PATH:"/opt/half-read/bin"}),code:1}),2000],
    ["cannot start",fakeShell({fail:"spawn /bin/zsh ENOENT"}),2000],
    ["hangs",fakeShell({output:B+NUL+"/opt/never/bin\n",hang:true}),40],
  ]){
    const env={SHELL:"/bin/zsh",PATH:"/usr/bin:/bin"},logs=[],started=Date.now();
    assert.deepEqual(await hydrateLoginShellEnvironment(env,{platform:"darwin",spawnFn:shell.spawnFn,timeoutMs,boundary:B,log:message=>logs.push(message)}),{},name);
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
  assert.deepEqual(await askLoginShell({env:{},shell:"",spawnFn:none.spawnFn}),{});assert.equal(none.calls.length,0);
});

test("a shell ended by a signal, one that cannot even be spawned and a name that is not plain give nothing, each said once; a clean exit without the boundary says nothing",async()=>{
  const read=async options=>{const logs=[];const values=await askLoginShell({env:{SHELL:"/bin/sh"},boundary:B,log:message=>logs.push(message),...options});return {values,logs}};
  const killed=await read({spawnFn:fakeShell({output:printed({PATH:"/srv/bin"}),signal:"SIGTERM"}).spawnFn});
  assert.deepEqual(killed,{values:{},logs:["Trebell could not read PATH from the login shell (/bin/sh -ilc): it ended on SIGTERM."]});
  const unspawnable=await read({spawnFn:()=>{throw new Error("spawn EACCES")}});
  assert.deepEqual(unspawnable,{values:{},logs:["Trebell could not read PATH from the login shell (/bin/sh -ilc): spawn EACCES"]});
  const unplain=fakeShell(),refused=await read({names:["PATH","not-plain"],spawnFn:unplain.spawnFn});
  assert.deepEqual(refused.values,{});assert.equal(refused.logs.length,1);assert.match(refused.logs[0],/only for variable names made of capital letters, digits and _/);
  assert.equal(unplain.calls.length,0,"no shell runs a command with it");
  const quiet=await read({spawnFn:fakeShell({output:"only a greeting\n"}).spawnFn});
  assert.deepEqual(quiet,{values:{},logs:[]});
});

test("the shell is SHELL without its surrounding spaces, or the one the caller names, as named",async()=>{
  const fromEnv=fakeShell(),named=fakeShell();
  await askLoginShell({env:{SHELL:"  /home/dev/.nix-profile/bin/fish \n"},spawnFn:fromEnv.spawnFn});
  assert.equal(fromEnv.calls[0].command,"/home/dev/.nix-profile/bin/fish");
  await askLoginShell({env:{SHELL:"/bin/zsh"},shell:"/opt/shells/bash",spawnFn:named.spawnFn});
  assert.equal(named.calls[0].command,"/opt/shells/bash");
});

test("only the first mebibyte of what the shell prints is read",async()=>{
  const room=1_048_576,values=printed({PATH:"/srv/bin"});
  const read=output=>askLoginShell({env:{SHELL:"/bin/sh"},boundary:B,spawnFn:fakeShell({output}).spawnFn});
  assert.deepEqual(await read("x".repeat(room-values.length)+values),{PATH:"/srv/bin"},"the boundaries inside the first mebibyte");
  // values ends with the closing boundary and a line break: two more characters before it put the boundary's last one past the
  // mebibyte.
  assert.deepEqual(await read("x".repeat(room-values.length+2)+values),{},"a closing boundary cut by it");
});

test("a shell past its bound is ended with its process group first off Windows, and alone on Windows",async t=>{
  const order=[],shell=fakeShell({hang:true});
  t.mock.method(process,"kill",(pid,signal)=>{order.push(`group ${pid} ${signal}`);return true});
  const spawnFn=(...args)=>{
    const child=shell.spawnFn(...args),kill=child.kill;
    child.pid=4321;child.kill=signal=>{order.push(`shell ${signal}`);return kill(signal)};
    return child;
  };
  assert.deepEqual(await askLoginShell({env:{SHELL:"/bin/zsh"},spawnFn,timeoutMs:30}),{});
  assert.deepEqual(order,process.platform==="win32"?["shell SIGKILL"]:["group -4321 SIGKILL","shell SIGKILL"]);
});

test("the login shell's PATH goes first with mise's record of it, and its JAVA_HOME only where none is set; Windows reads nothing",async()=>{
  const output=printed({PATH:"/Users/me/.local/bin:/mise/installs/claude/latest:/usr/bin",JAVA_HOME:"/usr/lib/jvm/temurin-21",__MISE_DIFF:"mise-record"});
  const missing={SHELL:"/bin/zsh",PATH:"/usr/bin:/bin:/usr/sbin:/sbin"};
  await hydrateLoginShellEnvironment(missing,{platform:"darwin",boundary:B,spawnFn:fakeShell({output}).spawnFn});
  assert.deepEqual(missing,{SHELL:"/bin/zsh",PATH:"/Users/me/.local/bin:/mise/installs/claude/latest:/usr/bin:/bin:/usr/sbin:/sbin",JAVA_HOME:"/usr/lib/jvm/temurin-21",__MISE_DIFF:"mise-record"});
  const explicit={SHELL:"/bin/bash",PATH:"/usr/bin",JAVA_HOME:"/home/dev/.sdkman/candidates/java/current"};
  await hydrateLoginShellEnvironment(explicit,{platform:"linux",boundary:B,spawnFn:fakeShell({output}).spawnFn});
  assert.equal(explicit.JAVA_HOME,"/home/dev/.sdkman/candidates/java/current","a JAVA_HOME already set stays");
  const blank={SHELL:"/bin/bash",PATH:"/usr/bin",JAVA_HOME:"  "};
  await hydrateLoginShellEnvironment(blank,{platform:"linux",boundary:B,spawnFn:fakeShell({output}).spawnFn});
  assert.equal(blank.JAVA_HOME,"/usr/lib/jvm/temurin-21","one of only spaces counts as none");
  // mise's record travels only with the shell's PATH: without one, it is not taken.
  const noPath={SHELL:"/bin/zsh",PATH:"/usr/bin"};
  await hydrateLoginShellEnvironment(noPath,{platform:"darwin",boundary:B,spawnFn:fakeShell({output:printed({__MISE_DIFF:"mise-record"})}).spawnFn});
  assert.deepEqual(noPath,{SHELL:"/bin/zsh",PATH:"/usr/bin"});
  for(const platform of ["win32","freebsd"]){
    const shell=fakeShell({output}),env={Path:"C:\\Windows",SHELL:"/bin/bash"};
    assert.deepEqual(await hydrateLoginShellEnvironment(env,{platform,boundary:B,spawnFn:shell.spawnFn}),{});
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
test("a real login shell's profile gives its PATH and JAVA_HOME, one with errexit on still gives the names after an unset one, and one that fails or hangs gives nothing",{skip:realBash()?false:"no bash to run"},async t=>{
  const shell=realBash(),root=mkdtempSync(join(tmpdir(),"trebell-login-shell-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
  let homes=0;
  const read=async(profile,options={})=>{
    const home=join(root,"home-"+(++homes));mkdirSync(home);
    writeFileSync(join(home,".bash_profile"),profile);
    const env={...(process.platform==="win32"?{SYSTEMROOT:process.env.SYSTEMROOT,WINDIR:process.env.WINDIR}:{}),PATH:"/usr/bin:/bin",HOME:home,USERPROFILE:home,TMPDIR:tmpdir(),TEMP:tmpdir(),TMP:tmpdir()};
    const logs=[],values=await askLoginShell({env,shell,cwd:home,timeoutMs:15_000,log:message=>logs.push(message),...options});
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
  // A profile that turns on errexit: printenv fails for a name that is not set, and the names after it still come.
  const strict=await read('set -e\nexport __MISE_DIFF="after the unset name"\n',{names:["TREBELL_NEVER_SET_NAME","__MISE_DIFF"]});
  assert.deepEqual(strict,{values:{__MISE_DIFF:"after the unset name"},logs:[]});
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
