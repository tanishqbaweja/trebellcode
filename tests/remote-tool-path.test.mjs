import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteToolPathPrelude } from "../src/remote-tool-path.mjs";

// The PATH lines every WSL or SSH command starts with, run where they run: in the POSIX shells a host may log in with, as far as this
// machine has them (on Windows only Git for Windows' sh, since "bash" there may be WSL's), against a made-up home.
const candidates=process.platform==="win32"?["sh"]:["sh","dash","bash","zsh","ksh"];
function run(shell,script,home){
  const env={HOME:home,...Object.fromEntries(Object.entries(process.env).filter(([name])=>["PATH","SYSTEMROOT","WINDIR","TEMP","TMP","TMPDIR"].includes(name.toUpperCase())))};
  return new Promise(resolve=>execFile(shell,["-c",script],{env,windowsHide:true,timeout:20_000},(error,stdout,stderr)=>resolve({code:error?(typeof error.code==="number"?error.code:-1):0,stdout:String(stdout),stderr:String(stderr)})));
}
const shells=[];
for(const shell of candidates)if((await run(shell,"printf ok",tmpdir())).stdout==="ok")shells.push(shell);

// Folders the lines may add that are not under the home: whether a machine has them is its own business.
const MACHINE_FOLDERS=new Set(["/usr/local/share/mise/shims","/opt/homebrew/bin","/home/linuxbrew/.linuxbrew/bin","/usr/local/bin","/usr/bin","/bin"]);

// Runs the lines after setup (shell lines that set the start PATH and any tool variable, relative to $HOME), then reports the home
// as the shell spells it, the PATH entries, and anything the lines left behind.
async function pathAfter(shell,home,setup){
  const script=[setup,remoteToolPathPrelude(),
    'printf "%s\\n" "$HOME"',
    'printf "%s\\n" "$PATH"',
    'command -v trebell_path_front >/dev/null 2>&1 && echo "left: trebell_path_front"',
    'command -v trebell_path_versions >/dev/null 2>&1 && echo "left: trebell_path_versions"',
    '[ -z "${trebell_path_folder+x}${trebell_path_root+x}" ] || echo "left: a trebell_path variable"',
    'exit 0'].join("\n");
  const result=await run(shell,script,home);
  assert.equal(result.code,0,`${shell}: ${result.stderr}`);
  assert.equal(result.stderr,"",shell);
  const [shellHome,path,...rest]=result.stdout.replace(/\r/g,"").split("\n").filter(Boolean);
  const entries=path.split(":");
  return {entries,under:entries.filter(entry=>entry.startsWith(shellHome+"/")).map(entry=>entry.slice(shellHome.length+1)),others:entries.filter(entry=>!entry.startsWith(shellHome+"/")),left:rest};
}
async function makeHome(folders){
  const home=await mkdtemp(join(tmpdir(),"trebell-tool-path-"));
  for(const folder of folders)await mkdir(join(home,...folder.split("/")),{recursive:true});
  return home;
}

test("a remote command's PATH holds every documented tool folder the host has, the version managers' first, each once",{skip:!shells.length&&"no POSIX shell on this machine"},async()=>{
  const home=await makeHome([".volta/bin",".local/share/mise/shims",".asdf/shims",".asdf/bin",".nodenv/shims",".nodenv/bin",".local/share/fnm","Library/Application Support/fnm",".fnm",
    ".nvm/versions/node/v18.20.4/bin",".nvm/versions/node/v22.11.0/bin",".local/bin","bin","not-a-tool/bin"]);
  try{
    for(const shell of shells){
      const after=await pathAfter(shell,home,"PATH=/usr/bin:/bin; unset VOLTA_HOME MISE_DATA_DIR XDG_DATA_HOME ASDF_DATA_DIR ASDF_DIR NODENV_ROOT NVM_DIR XDG_CONFIG_HOME FNM_DIR");
      assert.deepEqual(after.under,[".volta/bin",".local/share/mise/shims",".asdf/shims",".asdf/bin",".nodenv/shims",".nodenv/bin",".local/share/fnm","Library/Application Support/fnm",".fnm",
        ".nvm/versions/node/v22.11.0/bin",".nvm/versions/node/v18.20.4/bin",".local/bin","bin"],shell);
      // The host's own entries stay at the end, in their order, once; whatever else was added is a machine folder from the list.
      assert.deepEqual(after.others.slice(-2),["/usr/bin","/bin"],shell);
      assert.equal(after.entries.filter(entry=>entry==="/usr/bin").length,1,shell);
      for(const entry of after.others)assert.ok(MACHINE_FOLDERS.has(entry),`${shell}: ${entry}`);
      assert.deepEqual(after.left,[],shell);
    }
  }finally{await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("a folder already on a remote PATH keeps its place, a missing one is not added, and an empty PATH gets no empty entry",{skip:!shells.length&&"no POSIX shell on this machine"},async()=>{
  const home=await makeHome([".volta/bin",".local/bin",".nvm/versions/node"]);
  try{
    for(const shell of shells){
      const kept=await pathAfter(shell,home,'PATH="/bin:$HOME/.local/bin:/usr/bin"');
      assert.deepEqual(kept.under,[".volta/bin",".local/bin"],shell);
      assert.equal(kept.entries.indexOf("/bin")<kept.entries.findIndex(entry=>entry.endsWith("/.local/bin")),true,shell);
      assert.equal(kept.entries.filter(entry=>entry.endsWith("/.local/bin")).length,1,shell);
      // An nvm folder with no version in it is no error, in zsh too.
      const empty=await pathAfter(shell,home,"PATH=");
      assert.equal(empty.entries.includes(""),false,`${shell}: ${empty.entries.join(":")}`);
      assert.deepEqual(empty.under,[".volta/bin",".local/bin"],shell);
    }
  }finally{await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("a remote PATH follows the folders the tools' own variables name, and the lines set no tool variable",{skip:!shells.length&&"no POSIX shell on this machine"},async()=>{
  const home=await makeHome(["tools/volta/bin","tools/mise/shims","tools/asdf-data/shims","tools/asdf/bin","tools/nodenv/shims","tools/nodenv/bin","data/fnm","config/nvm/versions/node/v20.18.0/bin",
    "tools/nvm/versions/node/v21.7.3/bin",".volta/bin",".local/share/mise/shims",".asdf/shims",".nodenv/shims",".local/share/fnm",".nvm/versions/node/v16.20.2/bin"]);
  try{
    for(const shell of shells){
      const named=await pathAfter(shell,home,['PATH=/usr/bin:/bin','VOLTA_HOME="$HOME/tools/volta"','MISE_DATA_DIR="$HOME/tools/mise"','ASDF_DATA_DIR="$HOME/tools/asdf-data"','ASDF_DIR="$HOME/tools/asdf"',
        'NODENV_ROOT="$HOME/tools/nodenv"','NVM_DIR="$HOME/tools/nvm"','XDG_DATA_HOME="$HOME/data"','export VOLTA_HOME MISE_DATA_DIR ASDF_DATA_DIR ASDF_DIR NODENV_ROOT NVM_DIR XDG_DATA_HOME'].join("\n"));
      assert.deepEqual(named.under,["tools/volta/bin","tools/mise/shims","tools/asdf-data/shims","tools/asdf/bin","tools/nodenv/shims","tools/nodenv/bin","data/fnm","tools/nvm/versions/node/v21.7.3/bin"],shell);
      // nvm's folder under XDG_CONFIG_HOME when NVM_DIR is not set; nothing sets VOLTA_HOME or FNM_DIR for the command.
      const xdg=await pathAfter(shell,home,'PATH=/usr/bin:/bin; unset VOLTA_HOME NVM_DIR FNM_DIR XDG_DATA_HOME MISE_DATA_DIR ASDF_DATA_DIR ASDF_DIR NODENV_ROOT; XDG_CONFIG_HOME="$HOME/config"; export XDG_CONFIG_HOME');
      assert.deepEqual(xdg.under,[".volta/bin",".local/share/mise/shims",".asdf/shims",".nodenv/shims",".local/share/fnm","config/nvm/versions/node/v20.18.0/bin"],shell);
      const unset=await run(shell,['PATH=/usr/bin:/bin; unset VOLTA_HOME FNM_DIR',remoteToolPathPrelude(),'printf "%s|%s" "${VOLTA_HOME-unset}" "${FNM_DIR-unset}"'].join("\n"),home);
      assert.equal(unset.stdout,"unset|unset",shell);
    }
  }finally{await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});
