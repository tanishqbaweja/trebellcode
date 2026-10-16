import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { imageDecodeProblem } from "../src/native-image-check.mjs";

// Real 1x1 PNG (its IDAT checksum is wrong, which common decoders ignore) and 2x2 JPEG and WebP made by Chromium's encoders.
const PIXEL_PNG=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+i8XkAAAAASUVORK5CYII=","base64");
const TINY_JPEG=Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABAX/xAAZEQACAwEAAAAAAAAAAAAAAAAAAQIDMnH/2gAMAwEAAhEDEQA/AIAFqGUCs2+n/9k=","base64");
const TINY_WEBP=Buffer.from("UklGRhACAABXRUJQVlA4WAoAAAAgAAAAAQAAAQAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggIgAAAFABAJ0BKgIAAgACwEwlAE6AKAAA/ug4pWispf7pP1P5QAA=","base64");

function chunk(type,data){
  const length=Buffer.alloc(4);length.writeUInt32BE(data.length);
  return Buffer.concat([length,Buffer.from(type,"latin1"),data,Buffer.alloc(4)]);
}
// A PNG written like a hand-made encoder writes one: every scanline uses `filter`; `keepRaw` keeps only that many bytes of
// the scanline data, the way an encoder that slices its pixel buffer wrong leaves the data short. Pixels are pseudo-random,
// so a cut near the end of the file falls inside the compressed pixel data. `raw` replaces the scanline data outright.
function png({width,height,colorType=2,depth=8,interlace=0,filter=0,keepRaw=null,raw=null,palette=colorType===3,idat=true,end=true}={}){
  const channels={0:1,2:3,3:1,4:2,6:4}[colorType],stride=width=>1+Math.ceil(width*channels*depth/8);
  if(!raw){
    const passes=interlace?[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]].map(([x0,y0,dx,dy])=>[width>x0?Math.ceil((width-x0)/dx):0,height>y0?Math.ceil((height-y0)/dy):0]).filter(([w,h])=>w&&h):[[width,height]];
    let seed=12345;const rows=passes.flatMap(([w,h])=>Array.from({length:h},()=>{const row=Buffer.alloc(stride(w));for(let i=1;i<row.length;i++){seed=(seed*1103515245+12345)>>>0;row[i]=seed>>>24}row[0]=filter;return row}));
    raw=Buffer.concat(rows);if(keepRaw!=null)raw=raw.subarray(0,keepRaw);
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=depth;header[9]=colorType;header[12]=interlace;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),...(palette?[chunk("PLTE",Buffer.alloc(6,0x80))]:[]),...(idat?[chunk("IDAT",deflateSync(raw))]:[]),...(end?[chunk("IEND",Buffer.alloc(0))]:[])]);
}

test("Native image check accepts decodable PNG, JPEG and WebP images",()=>{
  assert.equal(imageDecodeProblem(PIXEL_PNG,"image/png"),null);
  assert.equal(imageDecodeProblem(TINY_JPEG,"image/jpeg"),null);
  assert.equal(imageDecodeProblem(TINY_WEBP,"image/webp"),null);
  assert.equal(imageDecodeProblem(png({width:5,height:3}),"image/png"),null);
  assert.equal(imageDecodeProblem(png({width:7,height:2,colorType:0,depth:16}),"image/png"),null);
  assert.equal(imageDecodeProblem(png({width:9,height:4,colorType:3,depth:2}),"image/png"),null);
  assert.equal(imageDecodeProblem(png({width:9,height:9,colorType:6,interlace:1}),"image/png"),null);
  assert.equal(imageDecodeProblem(png({width:1,height:1,colorType:6,interlace:1}),"image/png"),null,"Adam7 passes that hold no pixels have no scanlines");
  // A file cut off after its pixel data still decodes, as does one whose pixel data runs long.
  assert.equal(imageDecodeProblem(png({width:5,height:3,end:false}),"image/png"),null);
  assert.equal(imageDecodeProblem(PIXEL_PNG.subarray(0,PIXEL_PNG.length-14),"image/png"),null);
  // Past the inflate limit the pixel data is left to the provider rather than inflated here.
  assert.equal(imageDecodeProblem(png({width:5000,height:5000,colorType:6,raw:Buffer.alloc(10)}),"image/png"),null);
});

test("Native image check names what keeps a provider from decoding an image",()=>{
  // The music-harmony crash (2026-10-16): a 1836x930 grayscale PNG whose pixel data stops after 232,266 of 1,708,410 bytes.
  assert.match(imageDecodeProblem(png({width:1836,height:930,colorType:0,keepRaw:232266}),"image/png"),/pixel data is short: 232266 of the 1708410 bytes its 1836x930 header needs/);
  assert.match(imageDecodeProblem(png({width:4,height:4,filter:7}),"image/png"),/scanline 0 uses filter type 7/);
  assert.match(imageDecodeProblem(png({width:4,height:4,depth:3}),"image/png"),/bit depth 3 with color type 2/);
  assert.match(imageDecodeProblem(png({width:4,height:4,idat:false}),"image/png"),/no IDAT pixel data/);
  assert.match(imageDecodeProblem(png({width:4,height:4,colorType:3,palette:false}),"image/png"),/palette image without a PLTE chunk/);
  assert.match(imageDecodeProblem(png({width:0,height:4}),"image/png"),/0x4 size/);
  assert.match(imageDecodeProblem(PIXEL_PNG.subarray(0,20),"image/png"),/cut off inside its IHDR chunk/);
  const cutPng=png({width:64,height:64});
  assert.match(imageDecodeProblem(cutPng.subarray(0,cutPng.length-40),"image/png"),/pixel data is short.*cut off/);
  assert.match(imageDecodeProblem(Buffer.from("not an image at all"),"image/png"),/PNG signature/);
  assert.match(imageDecodeProblem(TINY_JPEG.subarray(0,TINY_JPEG.length-2),"image/jpeg"),/end-of-image marker/);
  const sof=TINY_JPEG.indexOf(Buffer.from([0xff,0xc0])),zeroWidth=Buffer.from(TINY_JPEG);zeroWidth.writeUInt16BE(0,sof+7);
  assert.match(imageDecodeProblem(zeroWidth,"image/jpeg"),/frame header gives a 0x2 size/);
  const sos=TINY_JPEG.indexOf(Buffer.from([0xff,0xda]));
  assert.match(imageDecodeProblem(Buffer.concat([TINY_JPEG.subarray(0,sof),TINY_JPEG.subarray(sos)]),"image/jpeg"),/no frame header \(SOF\) before its image scan/);
  assert.match(imageDecodeProblem(TINY_WEBP.subarray(0,TINY_WEBP.length-3),"image/webp"),/shorter than its RIFF size/);
  const wrongChunk=Buffer.from(TINY_WEBP);wrongChunk.write("JUNK",12,"latin1");
  assert.match(imageDecodeProblem(wrongChunk,"image/webp"),/first chunk is not a VP8, VP8L or VP8X image chunk/);
  const noFrame=Buffer.from(TINY_WEBP),vp8=noFrame.indexOf(Buffer.from("VP8 ","latin1"));noFrame[vp8+8+3]=0;
  assert.match(imageDecodeProblem(noFrame,"image/webp"),/VP8 frame header is invalid/);
});
