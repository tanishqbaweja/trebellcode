import { constants as zlibConstants, inflateSync } from "node:zlib";

// Checks that PNG, JPEG and WebP bytes decode before they reach a model provider. A provider rejects an image it cannot
// decode with an HTTP 400 that fails the whole request, so a tool error that names the problem lets the model fix the file
// instead (Codex's view_image decodes its images too). Returns null when the image looks decodable, else a short reason.
// Only what no decoder gets past is checked: cut-off files, short or undecodable pixel data, invalid headers. Chunk
// checksums are not, since common decoders ignore a bad IDAT checksum (PIL skips it, Chromium uses the data anyway).
const PNG_SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);
const PNG_CHANNELS={0:1,2:3,3:1,4:2,6:4},PNG_DEPTHS={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
const ADAM7=[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]];
// Above this many bytes of pixel data the inflate check is skipped (a 4096x4096 RGBA image is 64 MiB).
const PNG_INFLATE_LIMIT=64*1024*1024;
const JPEG_FRAME_MARKERS=new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);

function pngPasses(width,height,interlace){
  if(!interlace)return [[width,height]];
  return ADAM7.map(([x0,y0,dx,dy])=>[width>x0?Math.ceil((width-x0)/dx):0,height>y0?Math.ceil((height-y0)/dy):0]).filter(([w,h])=>w>0&&h>0);
}

function pngProblem(bytes){
  // A file cut off after or inside its pixel data still decodes when the pixel data it keeps is complete, so a cut there is
  // judged by the pixel data check below; a cut before the pixel data is a problem at once.
  let offset=8,header=null,palette=false,ended=false,cut=false;const data=[];
  while(offset<bytes.length){
    if(offset+8>bytes.length){if(!data.length)return "the file is cut off between chunks";cut=true;break}
    const length=bytes.readUInt32BE(offset),type=bytes.toString("latin1",offset+4,offset+8);
    if(length>0x7fffffff||offset+12+length>bytes.length){
      if(type!=="IDAT"&&!data.length)return `the file is cut off inside its ${type} chunk`;
      if(type==="IDAT"&&header)data.push(bytes.subarray(offset+8,Math.min(bytes.length,offset+8+length)));
      cut=true;break;
    }
    const body=bytes.subarray(offset+8,offset+8+length);
    if(!header){
      if(type!=="IHDR"||length!==13)return "it does not start with an IHDR header";
      header={width:body.readUInt32BE(0),height:body.readUInt32BE(4),depth:body[8],colorType:body[9],compression:body[10],filter:body[11],interlace:body[12]};
      if(!header.width||!header.height||header.width>0x7fffffff||header.height>0x7fffffff)return `its header gives a ${header.width}x${header.height} size`;
      if(!PNG_DEPTHS[header.colorType]?.includes(header.depth))return `its header has bit depth ${header.depth} with color type ${header.colorType}, which PNG does not allow`;
      if(header.compression!==0||header.filter!==0||header.interlace>1)return "its header names a compression, filter or interlace method PNG does not define";
    }else if(type==="PLTE")palette=true;
    else if(type==="IDAT"){if(header.colorType===3&&!palette)return "it is a palette image without a PLTE chunk before its pixel data";data.push(body)}
    else if(type==="IEND"){ended=true;break}
    offset+=12+length;
  }
  if(!header)return "it has no IHDR header";
  if(!data.length)return "it has no IDAT pixel data";
  const bitsPerPixel=PNG_CHANNELS[header.colorType]*header.depth;
  const passes=pngPasses(header.width,header.height,header.interlace).map(([width,height])=>({rows:height,stride:1+Math.ceil(width*bitsPerPixel/8)}));
  const expected=passes.reduce((sum,pass)=>sum+pass.rows*pass.stride,0);
  if(expected>PNG_INFLATE_LIMIT)return null;
  let pixels;
  try{pixels=inflateSync(Buffer.concat(data),{finishFlush:zlibConstants.Z_SYNC_FLUSH,maxOutputLength:expected+65536})}
  catch(error){
    if(error?.code==="ERR_BUFFER_TOO_LARGE")return null;
    return `its pixel data does not inflate (${String(error?.message||error).slice(0,120)})`;
  }
  if(pixels.length<expected)return `its pixel data is short: ${pixels.length} of the ${expected} bytes its ${header.width}x${header.height} header needs${cut?" (the file is cut off)":ended?"":" (the file has no IEND, so it may be cut off)"}`;
  let at=0,row=0;
  for(const pass of passes)for(let line=0;line<pass.rows;line++,row++){if(pixels[at]>4)return `scanline ${row} uses filter type ${pixels[at]} (PNG allows 0-4)`;at+=pass.stride}
  return null;
}

function jpegProblem(bytes){
  let offset=2,frame=false;
  while(offset<bytes.length){
    if(bytes[offset]!==0xff)return "its header segments are malformed";
    while(offset<bytes.length&&bytes[offset]===0xff)offset++;
    if(offset>=bytes.length)return "it is cut off inside its header segments";
    const marker=bytes[offset++];
    if(marker===0xd8||marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
    if(marker===0xd9)return "it ends before any image data";
    if(offset+2>bytes.length)return "it is cut off inside its header segments";
    const length=bytes.readUInt16BE(offset);
    if(length<2||offset+length>bytes.length)return "it is cut off inside its header segments";
    if(JPEG_FRAME_MARKERS.has(marker)){
      if(length<8)return "its frame header is too short";
      const height=bytes.readUInt16BE(offset+3),width=bytes.readUInt16BE(offset+5),components=bytes[offset+7];
      if(!width||!height)return `its frame header gives a ${width}x${height} size`;
      if(components<1||components>4||length!==8+3*components)return "its frame header lists an invalid number of components";
      frame=true;
    }
    if(marker===0xda){
      if(!frame)return "it has no frame header (SOF) before its image scan";
      const scan=offset+length;
      if(scan>=bytes.length)return "it has no image data after its scan header";
      for(let end=bytes.length-2;end>=scan;end--)if(bytes[end]===0xff&&bytes[end+1]===0xd9)return null;
      return "it ends without its end-of-image marker, so the file looks cut off";
    }
    offset+=length;
  }
  return "it has no image scan (SOS)";
}

function webpProblem(bytes){
  const size=bytes.readUInt32LE(4);
  if(size<4||size+8>bytes.length)return `the file is shorter than its RIFF size (${bytes.length} of ${size+8} bytes), so it looks cut off`;
  const end=size+8;let offset=12,image=false,extended=false;
  while(offset+8<=end){
    const type=bytes.toString("latin1",offset,offset+4),length=bytes.readUInt32LE(offset+4),body=offset+8;
    if(body+length>end)return `it is cut off inside its ${type.trim()} chunk`;
    if(offset===12){
      if(type==="VP8X")extended=true;
      else if(type!=="VP8 "&&type!=="VP8L")return "its first chunk is not a VP8, VP8L or VP8X image chunk";
    }
    if(type==="VP8 "){
      if(length<10||bytes[body+3]!==0x9d||bytes[body+4]!==0x01||bytes[body+5]!==0x2a)return "its VP8 frame header is invalid";
      if(!(bytes.readUInt16LE(body+6)&0x3fff)||!(bytes.readUInt16LE(body+8)&0x3fff))return "its VP8 frame header gives a zero size";
      image=true;
    }else if(type==="VP8L"){
      if(length<5||bytes[body]!==0x2f||(bytes[body+4]>>5)!==0)return "its VP8L header is invalid";
      image=true;
    }else if(type==="ANMF")image=true;
    offset=body+length+(length&1);
  }
  if(!image)return extended?"its VP8X header is not followed by any image data":"it has no image data";
  return null;
}

export function imageDecodeProblem(bytes,mimeType){
  const value=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes||[]);
  try{
    if(mimeType==="image/png")return value.length>=8&&value.subarray(0,8).equals(PNG_SIGNATURE)?pngProblem(value):"it does not start with the PNG signature";
    if(mimeType==="image/jpeg")return value.length>=4&&value[0]===0xff&&value[1]===0xd8?jpegProblem(value):"it does not start with the JPEG start marker";
    if(mimeType==="image/webp")return value.length>=16&&value.toString("latin1",0,4)==="RIFF"&&value.toString("latin1",8,12)==="WEBP"?webpProblem(value):"it does not start with a RIFF WEBP header";
  }catch(error){return `it could not be read (${String(error?.message||error).slice(0,120)})`}
  return null;
}
