import test from "node:test";
import assert from "node:assert/strict";
import { win32 } from "node:path";
import { androidCandidates, boundedDeviceLogText, parseAdbEmulators, parseAdbVersion, parseEmulatorVersion, parseIdbScreenSize, parseSdkManagerUpdates, parseSdkManagerVersion, pngSize, safeAppId, safeIosUdid } from "../src/device-service.mjs";

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

test("IDB accessibility frames expose the iOS Simulator input point-space",()=>{
  assert.deepEqual(parseIdbScreenSize(JSON.stringify([{frame:{x:0,y:0,width:393,height:852}}])),{width:393,height:852});
  assert.deepEqual(parseIdbScreenSize("not-json"),{width:null,height:null});
  assert.equal(safeIosUdid("12345678-1234-1234-1234-123456789ABC"),"12345678-1234-1234-1234-123456789ABC");
  assert.throws(()=>safeIosUdid("--help"),/invalid/i);
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

test("simulator app ids are bounded identifiers rather than shell fragments",()=>{
  assert.equal(safeAppId("com.example.demo"),"com.example.demo");assert.equal(safeAppId("com.example-demo.app"),"com.example-demo.app");
  for(const value of ["","../../escape","com.example.app;rm","com.example app","$HOME"])assert.throws(()=>safeAppId(value),/invalid/i);
});

test("Android app validation lists bounded packages and uses argv-safe launch and stop commands",async()=>{
  const calls=[];const {DeviceService}=await import("../src/device-service.mjs");
  const service=new DeviceService({
    platform:"linux",env:{},findCommandFn:async name=>name==="adb"?"/fixture/adb":null,
    runTextFn:async(command,args)=>{calls.push({command,args});if(args.includes("packages"))return {ok:true,stdout:"package:com.example.demo\npackage:com.example.other\n",stderr:""};return {ok:true,stdout:"Events injected: 1\n",stderr:""}},
  });
  const packages=await service.action("android:emulator-5554","packages");assert.deepEqual(packages.packages,["com.example.demo","com.example.other"]);assert.equal(packages.truncated,false);
  await service.action("android:emulator-5554","launch",{app:"com.example.demo"});await service.action("android:emulator-5554","stop",{app:"com.example.demo"});
  assert.deepEqual(calls.at(-2).args,["-s","emulator-5554","shell","monkey","-p","com.example.demo","-c","android.intent.category.LAUNCHER","1"]);
  assert.deepEqual(calls.at(-1).args,["-s","emulator-5554","shell","am","force-stop","com.example.demo"]);
});

test("iOS Simulator app lifecycle uses simctl argv without a shell",async()=>{
  const calls=[];const {DeviceService}=await import("../src/device-service.mjs");
  const service=new DeviceService({platform:"darwin",env:{},findCommandFn:async()=>null,runTextFn:async(command,args)=>{calls.push({command,args});return {ok:true,stdout:"",stderr:""}}});
  const udid="12345678-1234-1234-1234-123456789ABC";
  await service.action("ios:"+udid,"launch",{app:"com.example.demo"});await service.action("ios:"+udid,"stop",{app:"com.example.demo"});
  assert.deepEqual(calls[0],{command:"xcrun",args:["simctl","launch",udid,"com.example.demo"]});
  assert.deepEqual(calls[1],{command:"xcrun",args:["simctl","terminate",udid,"com.example.demo"]});
});

test("iOS Simulator IDB input uses argv-safe point coordinates, text, swipe and supported keys",async()=>{
  const calls=[],udid="12345678-1234-1234-1234-123456789ABC";const {DeviceService}=await import("../src/device-service.mjs");
  const service=new DeviceService({
    platform:"darwin",env:{},findCommandFn:async name=>name==="idb"?"/fixture/idb":null,
    runTextFn:async(command,args)=>{calls.push({command,args});return {ok:true,stdout:"",stderr:""}},
  });
  await service.action("ios:"+udid,"tap",{x:101.4,y:202.6});
  await service.action("ios:"+udid,"swipe",{x1:10,y1:20,x2:30,y2:40,duration:350});
  await service.action("ios:"+udid,"type",{text:"hello --still-one-argv"});
  await service.action("ios:"+udid,"key",{key:"home"});await service.action("ios:"+udid,"key",{key:"enter"});
  assert.deepEqual(calls[0],{command:"/fixture/idb",args:["ui","tap","--json","--udid",udid,"--","101","203"]});
  assert.deepEqual(calls[1],{command:"/fixture/idb",args:["ui","swipe","--duration","0.35","--json","--udid",udid,"--","10","20","30","40"]});
  assert.deepEqual(calls[2],{command:"/fixture/idb",args:["ui","text","--udid",udid,"--","hello --still-one-argv"]});
  assert.deepEqual(calls[3],{command:"/fixture/idb",args:["ui","button","--udid",udid,"--","HOME"]});
  assert.deepEqual(calls[4],{command:"/fixture/idb",args:["ui","key","--udid",udid,"--","40"]});
  await assert.rejects(()=>service.action("ios:"+udid,"key",{key:"back"}),/Home and Enter/i);
});

test("iOS screenshots expose IDB point-space alongside Retina pixel dimensions",async()=>{
  const udid="12345678-1234-1234-1234-123456789ABC",buffer=Buffer.alloc(24);buffer.writeUInt8(0x89,0);buffer.write("PNG",1,"ascii");buffer.writeUInt32BE(1179,16);buffer.writeUInt32BE(2556,20);
  const {DeviceService}=await import("../src/device-service.mjs");
  const service=new DeviceService({
    platform:"darwin",env:{},findCommandFn:async name=>name==="idb"?"/fixture/idb":null,
    runBufferFn:async()=>buffer,
    runTextFn:async(command,args)=>args.includes("describe-all")?{ok:true,stdout:JSON.stringify([{frame:{x:0,y:0,width:393,height:852}}]),stderr:""}:{ok:true,stdout:"",stderr:""},
  });
  const shot=await service.screenshot("ios:"+udid);
  assert.equal(shot.width,1179);assert.equal(shot.height,2556);assert.equal(shot.inputWidth,393);assert.equal(shot.inputHeight,852);assert.equal(shot.inputCoordinateSpace,"points");
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
