import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync } from "node:fs";
import { posix, win32 } from "node:path";

const execFileAsync=promisify(execFile);

async function runText(command,args=[],{timeout=20_000,allowFailure=false,env=process.env}={}){
  try{
    const result=await execFileAsync(command,args,{windowsHide:true,timeout,maxBuffer:8*1024*1024,encoding:"utf8",env});
    return {ok:true,stdout:String(result.stdout||""),stderr:String(result.stderr||"")};
  }catch(error){
    if(!allowFailure)throw new Error(String(error.stderr||error.stdout||error.message||error).trim());
    return {ok:false,stdout:String(error.stdout||""),stderr:String(error.stderr||error.message||""),code:error.code??1};
  }
}

async function runSdkManager(command,args=[],{timeout=60_000,allowFailure=false,env=process.env,platform=process.platform}={}){
  if(platform==="win32"&&/\.(?:bat|cmd)$/i.test(String(command||""))){
    const safe=args.map(value=>String(value)).filter(value=>/^[a-z0-9._;:=+-]+$/i.test(value));
    if(safe.length!==args.length)throw new Error("Unsupported sdkmanager argument");
    const comspec=env.ComSpec||env.COMSPEC||"cmd.exe";
    const result=await runText(comspec,["/d","/s","/c",`call "%TREBELL_SDKMANAGER%" ${safe.map(value=>'"'+value+'"').join(" ")}`],{
      timeout,allowFailure,env:{...env,TREBELL_SDKMANAGER:String(command)},
    });
    return result;
  }
  return runText(command,args,{timeout,allowFailure,env});
}

async function runBuffer(command,args=[],{timeout=20_000}={}){
  return await new Promise((resolve,reject)=>{
    execFile(command,args,{windowsHide:true,timeout,maxBuffer:32*1024*1024,encoding:"buffer"},(error,stdout,stderr)=>{
      if(error)return reject(new Error(String(Buffer.isBuffer(stderr)?stderr.toString("utf8"):stderr||error.message).trim()));
      resolve(Buffer.from(stdout||[]));
    });
  });
}

async function findCommand(name,candidates=[],{platform=process.platform,env=process.env}={}){
  const finder=platform==="win32"?"where":"which";
  const found=await runText(finder,[name],{timeout:4000,allowFailure:true,env});
  if(found.ok){const first=found.stdout.split(/\r?\n/).map(value=>value.trim()).find(Boolean);if(first)return first}
  return candidates.find(candidate=>candidate&&existsSync(candidate))||null;
}

function androidCandidates(name,{env=process.env,platform=process.platform,readDirectory=readdirSync}={}){
  const path=platform==="win32"?win32:posix;
  const roots=[env.ANDROID_HOME,env.ANDROID_SDK_ROOT,env.LOCALAPPDATA&&path.join(env.LOCALAPPDATA,"Android","Sdk"),env.HOME&&path.join(env.HOME,"Android","Sdk")].filter(Boolean);
  const executable=platform==="win32"?name+".exe":name;
  if(name!=="sdkmanager")return roots.map(root=>name==="emulator"?path.join(root,"emulator",executable):path.join(root,"platform-tools",executable));
  const script=platform==="win32"?"sdkmanager.bat":"sdkmanager";const candidates=[];
  for(const root of roots){
    candidates.push(path.join(root,"cmdline-tools","latest","bin",script),path.join(root,"tools","bin",script));
    try{
      const versions=readDirectory(path.join(root,"cmdline-tools"),{withFileTypes:true})
        .filter(entry=>entry?.isDirectory?.()&&entry.name!=="latest")
        .map(entry=>entry.name).sort().reverse().slice(0,20);
      for(const version of versions)candidates.push(path.join(root,"cmdline-tools",version,"bin",script));
    }catch{}
  }
  return candidates;
}

function parseAdbEmulators(raw=""){
  return raw.split(/\r?\n/).slice(1).map(line=>line.trim()).filter(Boolean).map(line=>{
    const [serial,state,...rest]=line.split(/\s+/);if(!serial.startsWith("emulator-"))return null;
    const meta=Object.fromEntries(rest.filter(item=>item.includes(":")).map(item=>{const index=item.indexOf(":");return [item.slice(0,index),item.slice(index+1)]}));
    return {id:`android:${serial}`,platform:"android",serial,state,name:meta.model||meta.device||serial,product:meta.product||null,running:state==="device"};
  }).filter(Boolean);
}

function pngSize(buffer){return buffer.length>=24&&buffer.subarray(1,4).toString()==="PNG"?{width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20)}:{width:null,height:null}}
function encodedInput(value){return String(value??"").replace(/%/g,"%25").replace(/ /g,"%s")}
function parseAdbVersion(raw=""){
  const text=String(raw||"");return {
    protocol:text.match(/Android Debug Bridge version\s+([^\s]+)/i)?.[1]||null,
    revision:text.match(/(?:^|\n)Version\s+([^\s]+)/i)?.[1]||null,
  };
}
function parseEmulatorVersion(raw=""){return String(raw||"").match(/Android emulator version\s+([^\s]+)/i)?.[1]||null}
function parseSdkManagerVersion(raw=""){return String(raw||"").match(/(?:^|\n)\s*([0-9]+(?:\.[0-9A-Za-z_-]+)+)\s*(?:\r?\n|$)/)?.[1]||null}
function parseSdkManagerUpdates(raw=""){
  const text=String(raw||"");const marker=text.search(/Available Updates\s*:/i);if(marker<0)return [];
  const lines=text.slice(marker).split(/\r?\n/).slice(1);const updates=[];
  for(const line of lines){
    if(/^\s*(?:Available|Installed)\s+(?:Packages|Updates)\s*:/i.test(line)&&updates.length)break;
    const parts=line.split("|").map(value=>value.trim());if(parts.length<3)continue;
    const id=parts[0];if(!["platform-tools","emulator"].includes(id))continue;
    if(!/\d/.test(parts[1])||!/\d/.test(parts[2]))continue;
    updates.push({id,installedVersion:parts[1],availableVersion:parts[2],label:id==="platform-tools"?"Android Platform-Tools":"Android Emulator"});
  }
  return updates;
}

export class DeviceService{
  constructor({env=process.env,platform=process.platform}={}){this.env=env;this.platform=platform;this.adbPath=null;this.emulatorPath=null;this.sdkManagerPath=null;this.detectedAt=0}
  async #detect(){
    if(Date.now()-this.detectedAt<15_000)return;this.detectedAt=Date.now();
    this.adbPath=await findCommand("adb",androidCandidates("adb",{env:this.env,platform:this.platform}),{platform:this.platform,env:this.env});
    this.emulatorPath=await findCommand("emulator",androidCandidates("emulator",{env:this.env,platform:this.platform}),{platform:this.platform,env:this.env});
    this.sdkManagerPath=await findCommand("sdkmanager",androidCandidates("sdkmanager",{env:this.env,platform:this.platform}),{platform:this.platform,env:this.env});
  }
  async capabilities(){
    await this.#detect();let androidVersion=null,adbRevision=null,emulatorVersion=null,sdkManagerVersion=null;
    if(this.adbPath){const version=await runText(this.adbPath,["version"],{allowFailure:true,env:this.env});const parsed=parseAdbVersion(version.stdout||version.stderr);androidVersion=parsed.protocol;adbRevision=parsed.revision}
    if(this.emulatorPath){const version=await runText(this.emulatorPath,["-version"],{allowFailure:true,env:this.env});emulatorVersion=parseEmulatorVersion(version.stdout||version.stderr)}
    if(this.sdkManagerPath){const version=await runSdkManager(this.sdkManagerPath,["--version"],{allowFailure:true,timeout:15_000,env:this.env,platform:this.platform});sdkManagerVersion=parseSdkManagerVersion(version.stdout||version.stderr)}
    let iosAvailable=false;if(this.platform==="darwin"){iosAvailable=(await runText("xcrun",["simctl","help"],{allowFailure:true,timeout:8000})).ok}
    return {android:{
      available:Boolean(this.adbPath),emulatorAvailable:Boolean(this.emulatorPath),sdkManagerAvailable:Boolean(this.sdkManagerPath),
      version:androidVersion,adbVersion:androidVersion,adbRevision,emulatorVersion,sdkManagerVersion,
      tools:[
        {id:"platform-tools",label:"Android Platform-Tools",installed:Boolean(this.adbPath),version:adbRevision||androidVersion},
        {id:"emulator",label:"Android Emulator",installed:Boolean(this.emulatorPath),version:emulatorVersion},
        {id:"sdkmanager",label:"Android SDK Manager",installed:Boolean(this.sdkManagerPath),version:sdkManagerVersion},
      ],
    },ios:{available:iosAvailable,reason:this.platform!=="darwin"?"iOS Simulator requires macOS with Xcode.":iosAvailable?null:"Xcode simctl was not found."}};
  }
  async updates(){
    await this.#detect();
    if(!this.sdkManagerPath)return {available:false,reason:"Android SDK Manager (sdkmanager) was not found.",updates:[],checkedAt:Date.now()};
    const result=await runSdkManager(this.sdkManagerPath,["--list"],{allowFailure:true,timeout:60_000,env:this.env,platform:this.platform});
    if(!result.ok)return {available:true,error:(result.stderr||result.stdout||"Could not check Android SDK updates").trim().slice(-2000),updates:[],checkedAt:Date.now()};
    return {available:true,updates:parseSdkManagerUpdates(result.stdout),checkedAt:Date.now()};
  }
  async updateTool(tool){
    const id=String(tool||"").trim();if(!["platform-tools","emulator"].includes(id))throw new Error("Only Android Platform-Tools and Emulator updates are supported.");
    await this.#detect();if(!this.sdkManagerPath)throw new Error("Android SDK Manager (sdkmanager) is not installed.");
    const result=await runSdkManager(this.sdkManagerPath,[id],{allowFailure:true,timeout:10*60_000,env:this.env,platform:this.platform});
    if(!result.ok)throw new Error((result.stderr||result.stdout||("Could not update "+id)).trim().slice(-3000));
    this.detectedAt=0;return {ok:true,tool:id,output:(result.stdout||result.stderr||"").trim().slice(-3000),capabilities:await this.capabilities()};
  }
  async list(){
    const capabilities=await this.capabilities();const devices=[];let avds=[];
    if(this.adbPath){const result=await runText(this.adbPath,["devices","-l"],{allowFailure:true,env:this.env});if(result.ok)devices.push(...parseAdbEmulators(result.stdout))}
    if(this.emulatorPath){const result=await runText(this.emulatorPath,["-list-avds"],{allowFailure:true,env:this.env});if(result.ok)avds=result.stdout.split(/\r?\n/).map(value=>value.trim()).filter(Boolean)}
    if(capabilities.ios.available){
      const result=await runText("xcrun",["simctl","list","devices","available","--json"],{allowFailure:true,timeout:15_000});
      if(result.ok)try{const parsed=JSON.parse(result.stdout);for(const [runtime,items] of Object.entries(parsed.devices||{}))for(const item of items||[])devices.push({id:`ios:${item.udid}`,platform:"ios",serial:item.udid,name:item.name,state:item.state,runtime,running:item.state==="Booted"})}catch{}
    }
    return {capabilities,devices,avds};
  }
  #androidSerial(id){const [platform,serial]=String(id||"").split(":",2);if(platform!=="android"||!serial?.startsWith("emulator-"))throw new Error("Only Android emulators are supported by Trebell device control.");return serial}
  async #adb(id,args,{allowFailure=false,timeout=20_000}={}){await this.#detect();if(!this.adbPath)throw new Error("Android Platform-Tools (adb) are not installed. Install them or set ANDROID_HOME.");return runText(this.adbPath,["-s",this.#androidSerial(id),...args],{allowFailure,timeout,env:this.env})}
  async screenshot(id){
    const [platform,serial]=String(id||"").split(":",2);let data;
    if(platform==="android"){await this.#detect();if(!this.adbPath)throw new Error("Android Platform-Tools (adb) are not installed.");this.#androidSerial(id);data=await runBuffer(this.adbPath,["-s",serial,"exec-out","screencap","-p"])}
    else if(platform==="ios"){if(this.platform!=="darwin")throw new Error("iOS Simulator control requires macOS.");data=await runBuffer("xcrun",["simctl","io",serial,"screenshot","-"])}
    else throw new Error("Unsupported simulator platform");
    return {id,platform,dataUrl:"data:image/png;base64,"+data.toString("base64"),...pngSize(data)};
  }
  async action(id,action,args={}){
    const [platform,serial]=String(id||"").split(":",2);
    if(platform==="android"){
      if(action==="tap")await this.#adb(id,["shell","input","tap",String(Math.round(args.x)),String(Math.round(args.y))]);
      else if(action==="swipe")await this.#adb(id,["shell","input","swipe",String(Math.round(args.x1)),String(Math.round(args.y1)),String(Math.round(args.x2)),String(Math.round(args.y2)),String(Math.max(50,Math.round(args.duration||300)))]);
      else if(action==="type")await this.#adb(id,["shell","input","text",encodedInput(args.text)]);
      else if(action==="key"){const keys={home:"KEYCODE_HOME",back:"KEYCODE_BACK",recents:"KEYCODE_APP_SWITCH",enter:"KEYCODE_ENTER"};const key=keys[String(args.key||"").toLowerCase()]||"";if(!key)throw new Error("Unsupported emulator key");await this.#adb(id,["shell","input","keyevent",key])}
      else if(action==="theme")await this.#adb(id,["shell","cmd","uimode","night",args.dark?"yes":"no"]);
      else if(action==="rotate")await this.#adb(id,["shell","settings","put","system","user_rotation",String(((Number(args.rotation)||0)%4+4)%4)]);
      else if(action==="foreground"){const result=await this.#adb(id,["shell","dumpsys","window","windows"],{allowFailure:true});const match=(result.stdout||"").match(/mCurrentFocus=Window\{[^}]*\s([\w.$-]+\/[\w.$-]+)/);return {ok:result.ok,foreground:match?.[1]||null}}
      else throw new Error("Unsupported Android emulator action: "+action);
      return {ok:true,id,action};
    }
    if(platform==="ios"){
      if(this.platform!=="darwin")throw new Error("iOS Simulator control requires macOS.");
      if(action==="boot"){await runText("xcrun",["simctl","boot",serial],{allowFailure:true});return {ok:true,id,action}}
      if(action==="poweroff"){await runText("xcrun",["simctl","shutdown",serial],{allowFailure:true});return {ok:true,id,action}}
      throw new Error("This iOS simulator action requires the dedicated simulator helper: "+action);
    }
    throw new Error("Unsupported simulator platform");
  }
  async startAndroid(avd){await this.#detect();if(!this.emulatorPath)throw new Error("Android Emulator is not installed or not on PATH.");const name=String(avd||"").trim();if(!name)throw new Error("AVD name is required");const child=spawn(this.emulatorPath,["-avd",name],{detached:true,stdio:"ignore",windowsHide:true,env:this.env});child.unref();return {ok:true,avd:name,pid:child.pid}}
}

export { androidCandidates, parseAdbEmulators, parseAdbVersion, parseEmulatorVersion, parseSdkManagerUpdates, parseSdkManagerVersion, pngSize };
