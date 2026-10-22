import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { EnvironmentManager, listedWslDistros, remoteEnvironmentCommand, remoteTransportEnvironment } from "../src/environment-manager.mjs";
import * as remotePaths from "../src/environment-manager.mjs";
import { carriesCredentials } from "../src/runtime-environment.mjs";

// A POSIX shell, as a WSL or SSH host has, where this machine has one (Git for Windows' sh, or the system's).
function sh(script){return new Promise(resolve=>execFile("sh",["-c",script],{windowsHide:true,timeout:20_000},(error,stdout,stderr)=>resolve({code:error?(typeof error.code==="number"?error.code:-1):0,stdout:String(stdout),stderr:String(stderr)})))}
const posixShell=(await sh("printf ok")).stdout==="ok";
const bashShell=posixShell&&(await sh("bash -c 'printf ok'")).stdout==="ok";
function finished(child){
  return new Promise(resolve=>{
    let stdout="",stderr="";child.stdout?.on("data",chunk=>{stdout+=chunk});child.stderr?.on("data",chunk=>{stderr+=chunk});
    child.once("error",error=>resolve({code:-1,stdout,stderr:stderr+error.message}));child.once("close",code=>resolve({code,stdout,stderr}));
  });
}

// wsl.exe as a distro showed it (wsl.exe -d docker-desktop -- sh -c 'x=1; echo "[$x]"' printed [], and with --exec [1]): with
// --exec or -e it runs the words it is given; after -- it hands the rest of its command line, as Node quoted it for Windows
// (libuv's quote_cmd_arg), to the distro's default shell, which parses it before the command does. This machine's sh stands in.
function windowsQuoted(word){
  if(word==="")return '""';
  if(!/[ \t"]/.test(word))return word;
  if(!/["\\]/.test(word))return '"'+word+'"';
  const reversed=[];let beforeQuote=true;
  for(let index=word.length-1;index>=0;index--){
    const char=word[index];reversed.push(char);
    if(beforeQuote&&char==="\\")reversed.push("\\");
    else if(char==='"'){beforeQuote=true;reversed.push("\\")}
    else beforeQuote=false;
  }
  return '"'+reversed.reverse().join("")+'"';
}
function asWsl(args){
  const at=args.findIndex(arg=>arg==="--"||arg==="--exec"||arg==="-e");assert.ok(at>=0,"wsl.exe is given a command");
  const words=args.slice(at+1);
  return args[at]==="--"?["sh",["-c",words.map(windowsQuoted).join(" ")]]:[words[0],words.slice(1)];
}

function stateFor(profiles){
  return {
    environments:()=>profiles,
    upsertEnvironment:value=>value,
    setEnvironmentEnabled:(id,enabled)=>{
      const profile=profiles.find(item=>item.id===id);if(!profile)return null;
      profile.enabled=enabled!==false;return {...profile};
    },
    removeEnvironment:()=>true,
  };
}

test("disabled environments remain listed but cannot be used until re-enabled",()=>{
  const profiles=[{id:"ssh",name:"SSH",type:"ssh",cwd:"/srv/app",host:"example.invalid",port:22,enabled:false}];
  const manager=new EnvironmentManager({state:stateFor(profiles)});
  assert.equal(manager.list()[0].enabled,false);
  assert.equal(manager.get("ssh"),null);
  assert.equal(manager.get("ssh",{includeDisabled:true}).name,"SSH");
  assert.equal(manager.setEnabled("ssh",true).enabled,true);
  assert.equal(manager.get("ssh").id,"ssh");
});

test("local environment capabilities report the actual host platform",async()=>{
  const manager=new EnvironmentManager({state:stateFor([]),platform:"linux"});
  const capabilities=await manager.capabilities();
  assert.equal(capabilities.local.available,true);
  assert.equal(capabilities.local.platform,"linux");
});

// `wsl --list --quiet` writes UTF-16, read here as UTF-8 with a NUL after each character. Docker Desktop's own distros run its engine,
// so they are never offered for agents, and a host with only those has no WSL distro to offer.
test("WSL discovery leaves out Docker Desktop's own distros",()=>{
  const utf16=text=>[...text].map(char=>char+"\u0000").join("");
  assert.deepEqual(listedWslDistros(utf16("docker-desktop\r\nUbuntu-24.04\r\ndocker-desktop-data\r\n")),{distros:["Ubuntu-24.04"],dockerOnly:false});
  assert.deepEqual(listedWslDistros(utf16("docker-desktop\r\n")),{distros:[],dockerOnly:true});
  assert.deepEqual(listedWslDistros(""),{distros:[],dockerOnly:false});
  assert.deepEqual(listedWslDistros("Debian\nmy-docker-desktop-tools\n"),{distros:["Debian","my-docker-desktop-tools"],dockerOnly:false});
});

test("remote transport helpers keep OS and SSH-agent essentials without unrelated host secrets",()=>{
  const env=remoteTransportEnvironment({
    PATH:"/usr/bin",HOME:"/home/me",SSH_AUTH_SOCK:"/tmp/ssh-agent.sock",SSH_AGENT_PID:"123",WSLENV:"SAFE_FLAG/u",
    GITHUB_TOKEN:"must-not-reach-transport",TREBELL_PRIVATE_SECRET:"hidden",
  },{platform:"linux"});
  assert.equal(env.PATH,"/usr/bin");assert.equal(env.HOME,"/home/me");
  assert.equal(env.SSH_AUTH_SOCK,"/tmp/ssh-agent.sock");assert.equal(env.SSH_AGENT_PID,"123");assert.equal(env.WSLENV,"SAFE_FLAG/u");
  assert.equal(env.GITHUB_TOKEN,undefined);assert.equal(env.TREBELL_PRIVATE_SECRET,undefined);
});

test("prepareAttachment keeps local files local",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-env-local-"));
  try{
    const file=join(root,"note.txt");await writeFile(file,"LOCAL_OK","utf8");
    const manager=new EnvironmentManager({state:stateFor([{id:"local",name:"Local",type:"local",cwd:root}])});
    const result=await manager.prepareAttachment("local",file);
    assert.equal(result.path,resolve(file));
    assert.equal(result.copied,false);
    assert.equal(result.size,8);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("prepareAttachment streams remote bytes instead of embedding them in the command",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-env-remote-"));
  try{
    const bytes=Buffer.from(Array.from({length:4096},(_,index)=>index%251));
    const file=join(root,"payload.bin");await writeFile(file,bytes);
    const manager=new EnvironmentManager({state:stateFor([{id:"ssh",name:"SSH",type:"ssh",cwd:"/srv/project",host:"example.invalid",port:22}])});
    const chunks=[];let command="";
    manager.spawnSession=(_id,options)=>{
      command=options.command;
      const child=new EventEmitter();child.stderr=new PassThrough();
      child.stdin=new Writable({write(chunk,_encoding,callback){chunks.push(Buffer.from(chunk));callback()}});
      child.stdin.on("finish",()=>setImmediate(()=>child.emit("close",0,null)));
      return child;
    };
    const result=await manager.prepareAttachment("ssh",file);
    assert.equal(result.copied,true);
    assert.match(result.path,/^\/srv\/project\/\.trebell\/attachments\//);
    assert.deepEqual(Buffer.concat(chunks),bytes);
    assert.equal(command.includes(bytes.toString("base64")),false);
    assert.match(command,/cat > /);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("attachment validation enforces the aggregate 80 MiB image ceiling",async()=>{
  const manager=new EnvironmentManager({state:stateFor([{id:"local",name:"Local",type:"local",cwd:""}])});
  manager.attachmentInfo=async(_id,path)=>({path,size:10*1024*1024,image:true,environmentId:"local"});
  const accepted=await manager.validateAttachments("local",Array.from({length:8},(_,index)=>`image-${index}.png`));
  assert.equal(accepted.imageBytes,80*1024*1024);
  await assert.rejects(()=>manager.validateAttachments("local",Array.from({length:9},(_,index)=>`image-${index}.png`)),/80 MiB total/i);
});

test("attachment metadata is read inside remote environments",async()=>{
  const manager=new EnvironmentManager({state:stateFor([{id:"ssh",name:"SSH",type:"ssh",cwd:"/srv/project",host:"example.invalid",port:22}])});
  let command="";
  manager.execute=async(_id,options)=>{command=options.command;return {exitCode:0,stdout:"1234",stderr:"",timedOut:false}};
  const info=await manager.attachmentInfo("ssh","/srv/project/.trebell/attachments/picture.png");
  assert.equal(info.size,1234);assert.equal(info.image,true);assert.equal(info.environmentId,"ssh");
  assert.match(command,/wc -c/);assert.match(command,/picture\.png/);
});

test("local environments publish bounded theme files without shadowing built-ins",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-env-theme-"));
  try{
    const themes=join(root,"themes");await mkdir(themes,{recursive:true});
    await writeFile(join(themes,"nightfall.json"),JSON.stringify({name:"Nightfall",appearance:"dark",canvas:"#111827",accent:"#8b5cf6"}));
    await writeFile(join(themes,"dark.json"),JSON.stringify({name:"Shadow built-in",canvas:"#000000",accent:"#ffffff"}));
    await writeFile(join(themes,"broken.json"),"{not json");
    const manager=new EnvironmentManager({state:stateFor([]),env:{...process.env,TREBELL_HOME:root}});
    const catalog=await manager.themeCatalog();
    assert.equal(catalog.environmentKey,"local");
    assert.equal(catalog.directory,themes);
    assert.deepEqual(catalog.themes.map(theme=>theme.id),["nightfall"]);
    assert.equal(catalog.themes[0].published,true);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("remote environment themes are read through bounded argv commands",async()=>{
  const profile={id:"ssh",name:"Build box",type:"ssh",cwd:"/srv/project",host:"example.invalid",port:22,themeDirectory:"/srv/themes"};
  const manager=new EnvironmentManager({state:stateFor([profile])});
  const calls=[];
  manager.executeArgv=async(_id,options)=>{
    calls.push(options);
    if(options.command==="test")return {exitCode:0,stdout:"",stderr:""};
    if(options.command==="find")return {exitCode:0,stdout:"/srv/themes/nightfall.json\n/srv/themes/not allowed.json",stderr:""};
    if(options.command==="wc")return {exitCode:0,stdout:"82 /srv/themes/nightfall.json",stderr:""};
    if(options.command==="cat")return {exitCode:0,stdout:JSON.stringify({name:"Remote Nightfall",appearance:"dark",canvas:"#10151f",accent:"#5b8cff"}),stderr:""};
    throw new Error("unexpected command");
  };
  const catalog=await manager.themeCatalog("ssh");
  assert.equal(catalog.directory,"/srv/themes");
  assert.deepEqual(catalog.themes.map(theme=>theme.name),["Remote Nightfall"]);
  assert.deepEqual(calls.map(call=>call.command),["test","find","wc","cat"]);
});

test("remote environments without a published theme directory return an empty catalog",async()=>{
  const profile={id:"wsl",name:"Ubuntu",type:"wsl",cwd:"/home/me/project"};
  const manager=new EnvironmentManager({state:stateFor([profile]),platform:"win32"});
  manager.executeArgv=async()=>({exitCode:1,stdout:"",stderr:""});
  const catalog=await manager.themeCatalog("wsl");
  assert.deepEqual(catalog.themes,[]);
  assert.equal(catalog.directory,".trebell/themes");
});

test("terminal specs keep interactive shells inside local, WSL and SSH environments",()=>{
  const profiles=[
    {id:"local-profile",name:"Named local",type:"local",cwd:"C:\\code\\app"},
    {id:"wsl",name:"Ubuntu dev",type:"wsl",cwd:"/home/me/app",distro:"Ubuntu"},
    {id:"ssh",name:"Build box",type:"ssh",cwd:"/srv/app",host:"build.example",user:"dev",port:2222,identityFile:"C:\\keys\\build"},
  ];
  const manager=new EnvironmentManager({state:stateFor(profiles),platform:"win32"});
  const local=manager.terminalSpec("local-profile",{cwd:"C:\\code\\other"});
  assert.equal(local.environmentType,"local");
  assert.equal(local.environmentId,"local-profile");
  assert.equal(local.shell,null);
  assert.equal(local.cwd,"C:\\code\\other");

  const wsl=manager.terminalSpec("wsl",{cwd:"/work/repo"});
  assert.equal(wsl.shell,"wsl.exe");
  assert.deepEqual(wsl.args.slice(0,4),["-d","Ubuntu","--exec","bash"]);
  assert.equal(wsl.args.at(-1).includes("cd '/work/repo'"),true);
  assert.equal(wsl.args.at(-1).includes("/bin/bash"),true);

  const ssh=manager.terminalSpec("ssh",{cwd:"/srv/app"});
  assert.equal(ssh.shell,"ssh.exe");
  assert.equal(ssh.args.includes("-tt"),true);
  assert.equal(ssh.args.includes("2222"),true);
  assert.equal(ssh.args.includes("C:\\keys\\build"),true);
  assert.equal(ssh.args.at(-2),"dev@build.example");
  assert.equal(ssh.args.at(-1).includes("cd '/srv/app'"),true);
});

// The Codex executable saved for a WSL or SSH host is the codex that the harness's checks, its sign-in and its sessions run there;
// other commands, and a host saved without one, are left as they are. One typed under the home folder (~/.local/bin/codex, where
// npm installs it for a user) is expanded by the host's shell.
test("a host's saved Codex executable is the codex its checks, sign-in and sessions run",async()=>{
  const profiles=[
    {id:"ssh",name:"Build box",type:"ssh",host:"build.example.test",port:22,cwd:"/srv/app",codexPath:"/opt/lane/bin/codex",enabled:true},
    {id:"plain",name:"Plain box",type:"ssh",host:"plain.example.test",port:22,cwd:"",enabled:true},
    {id:"home",name:"Home box",type:"ssh",host:"home.example.test",port:22,cwd:"",codexPath:"~/.local/bin/codex",enabled:true},
  ];
  const manager=new EnvironmentManager({state:stateFor(profiles),platform:"linux"}),ran=[];
  manager.execute=async(id,options)=>{ran.push(options.command);return {exitCode:0,stdout:"",stderr:""}};
  manager.spawnSession=(id,options)=>{ran.push(options.command);return null};
  await manager.executeArgv("ssh",{command:"codex",args:["--version"]});
  manager.spawnArgv("ssh",{command:"codex",args:["app-server"]});
  assert.match(ran[0],/'\/opt\/lane\/bin\/codex' '--version'/);
  assert.match(ran[1],/'\/opt\/lane\/bin\/codex' 'app-server'/);
  assert.match(manager.terminalArgvSpec("ssh",{command:"codex",args:["login"]}).args.at(-1),/exec '\/opt\/lane\/bin\/codex' 'login'/);
  assert.match(manager.terminalArgvSpec("ssh",{command:"claude",args:["auth","login"]}).args.at(-1),/exec 'claude' 'auth' 'login'/);
  assert.match(manager.terminalArgvSpec("plain",{command:"codex",args:["login"]}).args.at(-1),/exec 'codex' 'login'/);
  await manager.executeArgv("home",{command:"codex",args:["--version"]});
  assert.match(ran[2],/"\$HOME"\/'\.local\/bin\/codex' '--version'/);
  assert.match(manager.terminalArgvSpec("home",{command:"codex",args:["login"]}).args.at(-1),/exec "\$HOME"\/'\.local\/bin\/codex' 'login'/);
  assert.match(manager.terminalArgvSpec("home",{command:"codex",args:["~/notes"]}).args.at(-1),/ '~\/notes'$/,"an argument is passed as it is");
});

// A path under a named user's home (~bob/.local/bin/codex) is that user's home on the host, as the host's shell expands it typed
// there; a user the host does not know is refused with a clear message instead of a file named ~bob being run or written.
test("a host's Codex executable under a named user's home is expanded by the host, and an unknown user is refused before anything runs",async()=>{
  const profiles=[
    {id:"named",name:"Named box",type:"ssh",host:"named.example.test",port:22,cwd:"",codexPath:"~bob/.local/bin/codex",enabled:true},
    {id:"unknown",name:"Unknown box",type:"ssh",host:"unknown.example.test",port:22,cwd:"",codexPath:"~trebell_no_such_user/.local/bin/codex",enabled:true},
  ];
  const manager=new EnvironmentManager({state:stateFor(profiles),platform:"linux"}),ran=[];
  manager.execute=async(id,options)=>{ran.push(options.command);return {exitCode:0,stdout:"",stderr:""}};
  await manager.executeArgv("named",{command:"codex",args:["--version"]});
  const signIn=manager.terminalArgvSpec("named",{command:"codex",args:["login"]}).args.at(-1);
  for(const command of [ran[0],signIn]){
    assert.doesNotMatch(command,/'~bob\/\.local\/bin\/codex'/,"the named home is not quoted into a file named ~bob");
    assert.match(command,/trebell_command=~bob\//,"the host's shell expands ~bob");
  }
  assert.match(ran[0],/ '--version'$/);assert.match(signIn,/ 'login'$/,"the arguments are passed as they are");
  assert.equal(remotePaths.remotePathExpression("~bob"),"~bob");
  assert.equal(remotePaths.remotePathExpression("~bob/.codex"),"~bob/'.codex'");
  assert.equal(remotePaths.remotePathExpression("~bob;rm -rf ~/x"),"'~bob;rm -rf ~/x'","anything but a user name after the tilde stays quoted");
  assert.equal(remotePaths.remoteHomeGuard("trebell_x","/opt/codex"),"","a path with no named home needs no guard");
  if(!posixShell)return;
  // The host's shell: an unknown user is refused with Trebell's message and nothing is run.
  await manager.executeArgv("unknown",{command:"codex",args:["--version"]});
  const refused=await sh(ran.at(-1));
  assert.equal(refused.code,127);
  assert.match(refused.stderr,/^Trebell could not find the home folder of the user trebell_no_such_user on this host, so it cannot use ~trebell_no_such_user\/\.local\/bin\/codex\.\r?\n?$/);
  // A user the host knows is placed in that user's home.
  const me=userInfo().username;
  if(/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(me)){
    const home=(await sh(`printf '%s' ~${me}`)).stdout;assert.doesNotMatch(home,/^~/);
    const placed=await sh(["trebell_x="+remotePaths.remotePathExpression(`~${me}/.codex-shared`),remotePaths.remoteHomeGuard("trebell_x",`~${me}/.codex-shared`),`printf '%s' "$trebell_x"`].join("\n"));
    assert.equal(placed.code,0,placed.stderr);assert.equal(placed.stdout,home+"/.codex-shared");
  }
});

// What an ssh client says when nothing accepts the connection differs between OpenSSH builds: OpenSSH (Linux, macOS, Git for Windows)
// names the host and port it tried; Windows' own OpenSSH meets the refusal in the banner exchange, when it no longer knows the address;
// and the Windows socket layer has its own words for WSAECONNREFUSED. The environment's check (its Test button, and Use for agent)
// says it one way, naming the host and port, and any other failure keeps the client's own words.
test("an SSH host that refuses the connection is reported the same way whichever OpenSSH client says it",async()=>{
  const profiles=[{id:"dead",name:"Dead host",type:"ssh",host:"127.0.0.1",port:56183,cwd:"",enabled:true}];
  const manager=new EnvironmentManager({state:stateFor(profiles),platform:"win32"});
  const probe=async stderr=>{manager.execute=async()=>({exitCode:255,stdout:"",stderr,timedOut:false});return manager.probe("dead")};
  const refused="ssh could not connect to 127.0.0.1 port 56183: Connection refused.";
  for(const said of [
    "banner exchange: Connection to UNKNOWN port -1: Connection refused\r\n",
    "ssh: connect to host 127.0.0.1 port 56183: Connection refused\r\n",
    "ssh: connect to host 127.0.0.1 port 56183: No connection could be made because the target machine actively refused it.\r\n",
    "banner exchange: Connection to UNKNOWN port -1: No connection could be made because the target machine actively refused it.\r\n",
    "Warning: Permanently added '[127.0.0.1]:56183' (ED25519) to the list of known hosts.\r\nssh: connect to host 127.0.0.1 port 56183: Connection refused\r\n",
  ]){
    const result=await probe(said);
    assert.equal(result.ok,false);assert.equal(result.stderr,refused,"said as: "+JSON.stringify(said));
  }
  assert.equal((await probe("ssh: connect to host ::1 port 2222: Connection refused\n")).stderr,"ssh could not connect to ::1 port 2222: Connection refused.","the client's own host and port, where it named them");
  for(const other of ["dev@127.0.0.1: Permission denied (publickey).\r\n","ssh: connect to host 127.0.0.1 port 56183: Connection timed out\r\n"])assert.equal((await probe(other)).stderr,other,"another failure keeps its own words");
  // A command that ran on the host and printed a refusal of its own is not the ssh client's.
  manager.execute=async()=>({exitCode:7,stdout:"",stderr:"curl: (7) Failed to connect to localhost port 8080: Connection refused\n",timedOut:false});
  assert.match((await manager.probe("dead")).stderr,/^curl:/);
});

test("terminal argv specs launch provider auth commands directly and quote remote arguments",()=>{
  const profiles=[
    {id:"local-profile",name:"Named local",type:"local",cwd:"C:\\code\\app"},
    {id:"wsl",name:"Ubuntu dev",type:"wsl",cwd:"/home/me/app",distro:"Ubuntu"},
    {id:"ssh",name:"Build box",type:"ssh",cwd:"/srv/app",host:"build.example",user:"dev",port:2222},
  ];
  const manager=new EnvironmentManager({state:stateFor(profiles),platform:"win32"});
  const local=manager.terminalArgvSpec("local-profile",{command:"C:\\Program Files\\Claude\\claude.exe",args:["auth","login"],cwd:"C:\\code\\app"});
  assert.equal(local.shell,"C:\\Program Files\\Claude\\claude.exe");
  assert.deepEqual(local.args,["auth","login"]);
  assert.equal(local.cwd,"C:\\code\\app");

  const wsl=manager.terminalArgvSpec("wsl",{command:"claude",args:["auth","login"],cwd:"/work/repo"});
  assert.equal(wsl.shell,"wsl.exe");
  assert.match(wsl.args.at(-1),/exec 'claude' 'auth' 'login'/);
  assert.match(wsl.args.at(-1),/linuxbrew/);

  const ssh=manager.terminalArgvSpec("ssh",{command:"opencode",args:["auth","login"],cwd:"/srv/app"});
  assert.equal(ssh.shell,"ssh.exe");
  assert.equal(ssh.args.includes("-tt"),true);
  assert.equal(ssh.args.at(-2),"dev@build.example");
  assert.match(ssh.args.at(-1),/exec 'opencode' 'auth' 'login'/);
});

test("remote runtime argv can clear the login environment and re-expose only approved names",()=>{
  const profile={id:"ssh",name:"Build box",type:"ssh",cwd:"/srv/app",host:"build.example",user:"dev",port:22};
  const manager=new EnvironmentManager({state:stateFor([profile]),platform:"linux"});
  let launch=null;
  manager.spawnSession=(_id,options)=>{launch=options;return {pid:123}};
  manager.spawnArgv("ssh",{command:"claude",args:["--version"],cwd:"/srv/app",environmentNames:["PATH","HOME","ANTHROPIC_API_KEY","bad-name?"],environment:{LOG_LEVEL:"debug",BROKEN_NAME:null,"bad-key":"nope","QUOTE_TEST":"a'b"}});
  assert.match(launch.command,/^env -i /);
  assert.match(launch.command,/PATH="\$\{PATH-\}"/);
  assert.match(launch.command,/ANTHROPIC_API_KEY="\$\{ANTHROPIC_API_KEY-\}"/);
  assert.match(launch.command,/LOG_LEVEL='debug'/);
  assert.match(launch.command,/QUOTE_TEST='a'\\''b'/);
  assert.doesNotMatch(launch.command,/bad-name/);
  assert.doesNotMatch(launch.command,/bad-key|BROKEN_NAME/);
  assert.match(launch.command,/'claude' '--version'/);
  assert.equal(remoteEnvironmentCommand("'tool'",[]),"'tool'");
  assert.match(remoteEnvironmentCommand("'tool'",[],{FIXTURE:"visible"}),/^env -i FIXTURE='visible' 'tool'$/);
});

// Native's toolchain names reach a remote command from the host's own environment. One the host does not set stays unset there
// (cargo refuses an empty CARGO_TARGET_DIR, make runs an empty CC), and a value that carries credentials is dropped on the host.
test("a remote command forwards guarded names only when the host sets them and their values carry no credentials",{skip:!posixShell&&"no POSIX shell on this machine"},async()=>{
  const profile={id:"ssh",name:"Build box",type:"ssh",cwd:"/srv/app",host:"build.example",user:"dev",port:22};
  const manager=new EnvironmentManager({state:stateFor([profile]),platform:"linux"});
  let launch=null;manager.spawnSession=(_id,options)=>{launch=options;return {pid:123}};
  const shown=["GEM_HOME","BUNDLE_APP_CONFIG","CARGO_TARGET_DIR","RUSTUP_DIST_SERVER","MAVEN_OPTS","GRADLE_OPTS","LOG_LEVEL","OPENAI_API_KEY"];
  const script=`process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(shown)}.map(name=>[name,process.env[name]??null]))))`;
  // SYSTEMROOT, as Git for Windows' sh spells it, lets this machine's Node start when the test runs on Windows.
  manager.spawnArgv("ssh",{command:process.execPath,args:["-e",script],environmentNames:["PATH","HOME","SYSTEMROOT"],environment:{LOG_LEVEL:"debug"},
    guardedEnvironmentNames:["GEM_HOME","BUNDLE_APP_CONFIG","CARGO_TARGET_DIR","RUSTUP_DIST_SERVER","MAVEN_OPTS","GRADLE_OPTS","LOG_LEVEL","not-a-name?"]});
  assert.doesNotMatch(launch.command,/not-a-name/);
  const quote=value=>"'"+String(value).replace(/'/g,"'\\''")+"'";
  const host=Object.entries({
    GEM_HOME:"fixture gems; $(exit 9) 'quoted'",BUNDLE_APP_CONFIG:"",RUSTUP_DIST_SERVER:"https://fixture-user:fixture-pass@mirror.example/rustup",
    MAVEN_OPTS:"-Xmx1g -Dhttps.proxyPassword=fixture-pass",GRADLE_OPTS:"-Xmx2g -Dfile.encoding=UTF-8",LOG_LEVEL:"host-value",OPENAI_API_KEY:"sk-fixture-host",
  }).map(([name,value])=>"export "+name+"="+quote(value)).join("; ");
  const run=await sh("unset CARGO_TARGET_DIR; "+host+"; "+launch.command);
  assert.equal(run.code,0,run.stderr);
  assert.deepEqual(JSON.parse(run.stdout),{
    GEM_HOME:"fixture gems; $(exit 9) 'quoted'",BUNDLE_APP_CONFIG:null,CARGO_TARGET_DIR:null,RUSTUP_DIST_SERVER:null,MAVEN_OPTS:null,
    GRADLE_OPTS:"-Xmx2g -Dfile.encoding=UTF-8",LOG_LEVEL:"debug",OPENAI_API_KEY:null,
  });
});

// A remote host checks its own toolchain values with a function of its sh that decides as carriesCredentials does here: the
// documented credential settings of JVM and build option strings, a connect string's user/password@ and a URL's userinfo are
// dropped there, and the plain settings, paths and package specs beside them reach the command.
test("a remote host drops the toolchain values that carry credentials as this machine does, and keeps the rest",{skip:!posixShell&&"no POSIX shell on this machine"},async()=>{
  const credentials=[
    "-Daws.accessKeyId=AKIAFIXTURE -Daws.secretKey=fixture-secret","-Daws.secretAccessKey=fixture-secret","-Xmx2g -Dnewrelic.config.license_key=fixture-license",
    "-Dsonar.login=fixture-token","-Ddb.url=jdbc:oracle:thin:scott/tiger@//db.example:1521/svc","-Ddb=scott/tiger@orcl","scott/tiger@orcl",
    "-Dotel.exporter.otlp.headers=Authorization=Bearer fixture","-Xmx1g -Dhttps.proxyPassword=fixture-pass","--token=fixture","-DAPI_KEY=fixture",
    "-Durl=jdbc:postgresql://db.example/app?user=app&password=fixture","https://fixture-user:fixture-pass@mirror.example/rustup",
    "-Dx='$(exit 9)' -Dsecret.value=fixture","-Xmx1g\tscott/tiger@db","-Xmx1g\nscott/tiger@db","-Dlist=a,scott/tiger@db",
  ];
  const plain=[
    "-Xmx2g -Dmaven.repo.local=/root/.m2/repository","-XX:MaxRAMPercentage=75 -Dfile.encoding=UTF-8","-Ddb.url=jdbc:oracle:thin:@//db.example:1521/svc",
    "-Djavax.net.ssl.trustStore=/etc/keys/cacerts -Dhttp.keepAlive=false","-L/opt/homebrew/opt/openssl@3/lib -Wl,-rpath,/opt/homebrew/opt/openssl@3/lib",
    "/opt/homebrew/opt/libffi/lib/pkgconfig:/opt/homebrew/opt/openssl@3/lib/pkgconfig","--max-old-space-size=4096 --require /srv/node_modules/@babel/register",
    "-I/go/pkg/mod/github.com/fixture/mod@v1.2.3/include","cpython@3.12","@scope/pkg@1.0.0","git@github.com:fixture/repo.git","github.com/fixture/*",
    "fixture gems; $(exit 9) 'quoted'","INSTALL_BASE=/home/fixture/perl5","-Dsurefire.reportsDirectory=target/reports -Demail=dev@example.com",
  ];
  const values=[...credentials,...plain],names=values.map((_,index)=>"TREBELL_FIXTURE_"+index);
  // Which names reach the command (Git for Windows' sh rewrites a path-like value for a Windows program, never the choice).
  const script=`process.stdout.write(JSON.stringify(${JSON.stringify(names)}.map(name=>name in process.env)))`;
  const command=remoteEnvironmentCommand(remotePaths.remoteCommandWords(process.execPath,["-e",script]),["PATH","HOME","SYSTEMROOT"],{},names);
  const quote=value=>"'"+String(value).replace(/'/g,"'\\''")+"'";
  const run=await sh(names.map((name,index)=>"export "+name+"="+quote(values[index])).join("; ")+"; "+command);
  assert.equal(run.code,0,run.stderr);
  const reached=JSON.parse(run.stdout);
  assert.deepEqual(values.filter((_,index)=>reached[index]),plain,"the host forwards the plain values alone");
  assert.deepEqual(values.filter(value=>!carriesCredentials(value)),plain,"this machine keeps the same ones");
});

// Native's commands reach a WSL host as bash -lc parses them, once, as an SSH host's shell does: the toolchain names guarded there,
// and the command's own $ and backquotes as they are.
test("a WSL host runs Native's commands with their guarded toolchain names as bash parses them once",{skip:!bashShell&&"no POSIX sh and bash on this machine"},async()=>{
  const profile={id:"wsl",name:"Ubuntu dev",type:"wsl",cwd:"",distro:"Ubuntu"},launched=[];
  // The distro's own values: a toolchain variable it sets, and one whose value carries a credential.
  const distro={GEM_HOME:"fixture-gems",MAVEN_OPTS:"-Dhttps.proxyPassword=fixture-pass"};
  const manager=new EnvironmentManager({state:stateFor([profile]),platform:"win32",spawnProcess:(file,args,options)=>{
    launched.push([file,...args]);const [command,words]=asWsl(args);return spawn(command,words,{...options,env:{...options.env,...distro}});
  }});
  const shown=["GEM_HOME","MAVEN_OPTS","CARGO_TARGET_DIR"];
  const script=`process.stdout.write(JSON.stringify({...Object.fromEntries(${JSON.stringify(shown)}.map(name=>[name,process.env[name]??null])),argument:process.argv[1]}))`;
  const child=manager.spawnArgv("wsl",{command:process.execPath,args:["-e",script,"$HOME and `backquotes` stay as they are"],stdio:["ignore","pipe","pipe"],
    environmentNames:["PATH","HOME","SYSTEMROOT"],guardedEnvironmentNames:shown});
  const run=await finished(child);
  assert.equal(run.code,0,run.stderr);
  assert.deepEqual(JSON.parse(run.stdout),{GEM_HOME:"fixture-gems",MAVEN_OPTS:null,CARGO_TARGET_DIR:null,argument:"$HOME and `backquotes` stay as they are"});
  assert.deepEqual(launched[0].slice(0,5),["wsl.exe","-d","Ubuntu","--exec","bash"]);
});

// A project hook or the WSL network check (awk's $3) is the host's bash's to parse, and a sign-in terminal's command gets its
// arguments as they are.
test("a WSL host's commands and sign-in terminals are parsed once there",{skip:!bashShell&&"no POSIX sh and bash on this machine"},async()=>{
  const profile={id:"wsl",name:"Ubuntu dev",type:"wsl",cwd:"",distro:"Ubuntu"};
  const manager=new EnvironmentManager({state:stateFor([profile]),platform:"win32",spawnProcess:(file,args,options)=>{const [command,words]=asWsl(args);return spawn(command,words,options)}});
  const hook=await manager.execute("wsl",{command:"trebell_fixture=parsed-once; printf '%s|%s' \"$trebell_fixture\" '$HOME'; echo 'a b c' | awk '{printf \"|%s\", $3}'",timeoutMs:20_000});
  assert.equal(hook.exitCode,0,hook.stderr);assert.equal(hook.stdout,"parsed-once|$HOME|c");
  const spec=manager.terminalArgvSpec("wsl",{command:process.execPath,args:["-e","process.stdout.write(process.argv[1])","$HOME and `backquotes` stay as they are"]});
  assert.equal(spec.shell,"wsl.exe");
  const [command,words]=asWsl(spec.args),signIn=await finished(spawn(command,words,{windowsHide:true,stdio:["ignore","pipe","pipe"]}));
  assert.equal(signIn.code,0,signIn.stderr);assert.equal(signIn.stdout,"$HOME and `backquotes` stay as they are");
});

test("remote stdin argv forwards its environment allowlist to the spawned session",async()=>{
  const profile={id:"ssh",name:"Build box",type:"ssh",cwd:"/srv/app",host:"build.example",user:"dev",port:22};
  const manager=new EnvironmentManager({state:stateFor([profile]),platform:"linux"});let launch=null;
  manager.spawnArgv=(_id,options)=>{
    launch=options;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new Writable({write(_chunk,_encoding,callback){callback()}});
    queueMicrotask(()=>child.emit("close",0,null));return child;
  };
  const result=await manager.executeArgvInput("ssh",{command:"glab",args:["api","projects"],input:"{}",cwd:"/srv/app",environmentNames:["PATH","HOME","GITLAB_TOKEN"]});
  assert.equal(result.exitCode,0);assert.deepEqual(launch.environmentNames,["PATH","HOME","GITLAB_TOKEN"]);assert.equal(launch.command,"glab");
});

test("bounded local environment command timeout kills descendants that inherit stdio",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-env-tree-")),pidPath=join(root,"descendant.pid");
  try{
    const profile={id:"local",name:"Local",type:"local",cwd:root},manager=new EnvironmentManager({state:stateFor([profile])});
    const childScript="setInterval(()=>{},1000)";
    const parentScript=[
      "const {spawn}=require('node:child_process');",
      "const fs=require('node:fs');",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'inherit'});`,
      `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
      "setInterval(()=>{},1000);",
    ].join("");
    const started=Date.now(),result=await manager.executeArgv("local",{command:process.execPath,args:["-e",parentScript],cwd:root,timeoutMs:1000});
    assert.equal(result.timedOut,true);assert.ok(Date.now()-started<5000);
    const descendantPid=Number(await readFile(pidPath,"utf8"));let alive=true;
    for(let attempt=0;attempt<20&&alive;attempt++){
      try{process.kill(descendantPid,0);await new Promise(resolve=>setTimeout(resolve,50))}
      catch(error){if(error?.code==="ESRCH")alive=false;else throw error}
    }
    assert.equal(alive,false,"timed-out environment command must not leave descendants running");
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("bounded stdin environment command timeout kills descendants that inherit stdio",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-env-stdin-tree-")),pidPath=join(root,"descendant.pid");
  try{
    const profile={id:"local",name:"Local",type:"local",cwd:root},manager=new EnvironmentManager({state:stateFor([profile])});
    const childScript="setInterval(()=>{},1000)";
    const parentScript=[
      "const {spawn}=require('node:child_process');",
      "const fs=require('node:fs');",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'inherit'});`,
      `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
      "process.stdin.resume();setInterval(()=>{},1000);",
    ].join("");
    const started=Date.now(),result=await manager.executeArgvInput("local",{command:process.execPath,args:["-e",parentScript],input:"x",cwd:root,timeoutMs:1000});
    assert.equal(result.timedOut,true);assert.ok(Date.now()-started<5000);
    const descendantPid=Number(await readFile(pidPath,"utf8"));let alive=true;
    for(let attempt=0;attempt<20&&alive;attempt++){
      try{process.kill(descendantPid,0);await new Promise(resolve=>setTimeout(resolve,50))}
      catch(error){if(error?.code==="ESRCH")alive=false;else throw error}
    }
    assert.equal(alive,false,"timed-out stdin environment command must not leave descendants running");
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});
