import test from "node:test";
import assert from "node:assert/strict";
import { win32 } from "node:path";
import { androidCandidates, boundedDeviceLogText, parseAdbEmulators, parseAdbVersion, parseEmulatorVersion, parseSdkManagerUpdates, parseSdkManagerVersion, pngSize } from "../src/device-service.mjs";

test("device discovery accepts Android emulators and excludes physical devices",()=>{
  const parsed=parseAdbEmulators(`List of devices attached\nemulator-5554 device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1\nR5CT1234ABC device product:b0qxxx model:SM_S908B device:b0q transport_id:2\nemulator-5556 offline product:sdk_gphone64_arm64 model:Pixel_8_API_35 device:emu64a transport_id:3\n`);
  assert.deepEqual(parsed.map(item=>item.id),["android:emulator-5554","android:emulator-5556"]);
  assert.equal(parsed[0].running,true);
  assert.equal(parsed[1].running,false);
  assert.equal(parsed[0].name,"sdk_gphone64_x86_64");
});

test("device screenshot metadata reads PNG dimensions",()=>{
  const buffer=Buffer.alloc(24);buffer.writeUInt8(0x89,0);buffer.write("PNG",1,"ascii");buffer.writeUInt32BE(1080,16);buffer.writeUInt32BE(2400,20);
  assert.deepEqual(pngSize(buffer),{width:1080,height:2400});
  assert.deepEqual(pngSize(Buffer.from("not-png")),{width:null,height:null});
});

test("device logs stay line and character bounded",()=>{
  const lines=Array.from({length:50},(_,index)=>"line-"+index+"-"+("x".repeat(80))).join("\n");
  const bounded=boundedDeviceLogText(lines,{lines:12,maxChars:1024});
  assert.equal(bounded.lineCount,12);assert.equal(bounded.omittedLines,38);assert.equal(bounded.truncated,true);assert.ok(bounded.text.length<=1024);assert.match(bounded.text,/line-49/);
});

test("Android emulator logs use bounded logcat and redact environment secrets",async()=>{
  const calls=[],secret="device-log-private-token";
  const {DeviceService}=await import("../src/device-service.mjs");
  const service=new DeviceService({
    platform:"linux",env:{DEVICE_LOG_SECRET:secret},
    findCommandFn:async name=>name==="adb"?"/fixture/adb":null,
    runTextFn:async(command,args)=>{calls.push({command,args});return {ok:true,stdout:"first\nsecret="+secret+"\nlast\n",stderr:""}},
  });
  const result=await service.logs("android:emulator-5554",{lines:25});
  assert.deepEqual(calls.at(-1),{command:"/fixture/adb",args:["-s","emulator-5554","logcat","-d","-t","25"]});
  assert.doesNotMatch(result.text,new RegExp(secret));assert.match(result.text,/\[redacted\]/);assert.equal(result.platform,"android");
});

test("Android tool versions are parsed from their native CLI output",()=>{
  assert.deepEqual(parseAdbVersion("Android Debug Bridge version 1.0.41\nVersion 36.0.0-13206524\nInstalled as C:\\Android\\adb.exe\n"),{protocol:"1.0.41",revision:"36.0.0-13206524"});
  assert.equal(parseEmulatorVersion("INFO | Android emulator version 36.2.11.0 (build_id 14183203)"),"36.2.11.0");
  assert.equal(parseSdkManagerVersion("19.0\n"),"19.0");
});

test("sdkmanager update parsing keeps only Trebell-supported Android tools",()=>{
  const parsed=parseSdkManagerUpdates(`Installed packages:
  Path | Version | Description
Available Updates:
  ID | Installed | Available
  ------- | ------- | -------
  build-tools;36.0.0 | 36.0.0 | 36.0.1
  emulator | 36.2.11 | 36.3.2
  platform-tools | 36.0.0 | 36.0.1
`);
  assert.deepEqual(parsed,[
    {id:"emulator",installedVersion:"36.2.11",availableVersion:"36.3.2",label:"Android Emulator"},
    {id:"platform-tools",installedVersion:"36.0.0",availableVersion:"36.0.1",label:"Android Platform-Tools"},
  ]);
});

test("sdkmanager discovery checks latest and versioned command-line tool installs",()=>{
  const root="C:\\Android\\Sdk";
  const paths=androidCandidates("sdkmanager",{platform:"win32",env:{ANDROID_SDK_ROOT:root},readDirectory:()=>[
    {name:"12.0",isDirectory:()=>true},{name:"19.0",isDirectory:()=>true},{name:"latest",isDirectory:()=>true},
  ]});
  assert.equal(paths[0],win32.join(root,"cmdline-tools","latest","bin","sdkmanager.bat"));
  assert.ok(paths.includes(win32.join(root,"cmdline-tools","19.0","bin","sdkmanager.bat")));
});

test("device updates reject arbitrary sdkmanager package names before probing the SDK",async()=>{
  const {DeviceService}=await import("../src/device-service.mjs");
  const service=new DeviceService({platform:"win32",env:{}});
  await assert.rejects(()=>service.updateTool("system-images;android-36;google_apis;x86_64"),/Only Android Platform-Tools and Emulator updates are supported/i);
});

test("iOS simulator lifecycle actions fail honestly off macOS",async()=>{
  const {DeviceService}=await import("../src/device-service.mjs");
  const service=new DeviceService({platform:"win32",env:{}});
  await assert.rejects(()=>service.action("ios:fixture-udid","boot"),/requires macOS/i);
  await assert.rejects(()=>service.action("ios:fixture-udid","poweroff"),/requires macOS/i);
  await assert.rejects(()=>service.logs("ios:fixture-udid"),/logs require macOS/i);
});
