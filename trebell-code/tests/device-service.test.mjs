import test from "node:test";
import assert from "node:assert/strict";
import { parseAdbEmulators, pngSize } from "../src/device-service.mjs";

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
