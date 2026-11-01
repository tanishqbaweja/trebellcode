import { crc32, inflateRawSync } from "node:zlib";
import { BOUNDS, reachLimit, refuseDocument } from "./document-reading.mjs";

// The ZIP archive that Office, OpenDocument and EPUB files are (PKWARE's APPNOTE.TXT), held as the file's bytes. Opening it indexes
// the central directory; a part is unpacked only when a reading asks for it, and what is unpacked counts against BOUNDS.partBytes
// and BOUNDS.packageBytes. Nothing is ever written out, but an archive whose names would climb out of it is malformed and refused.
const RECORD={end:0x06054b50,zip64End:0x06064b50,zip64Locator:0x07064b50,directory:0x02014b50,local:0x04034b50};
const ALL_ONES_16=0xffff,ALL_ONES_32=0xffffffff;
const END_RECORD_BYTES=22,DIRECTORY_ENTRY_BYTES=46,LOCAL_HEADER_BYTES=30;

const fits=(bytes,at,length)=>Number.isSafeInteger(at)&&at>=0&&at+length<=bytes.length;
function wide(bytes,at){
  const value=bytes.readBigUInt64LE(at);
  return value<=BigInt(Number.MAX_SAFE_INTEGER)?Number(value):refuseDocument("Damaged archive: a ZIP64 value is out of range");
}

// The end record is the last 22 bytes, unless the archive has a comment: then it is the record whose comment length reaches the end
// of the file exactly. Returns where the directory starts and how many entries it holds.
function findDirectory(bytes){
  const earliest=Math.max(0,bytes.length-END_RECORD_BYTES-ALL_ONES_16);
  let at=bytes.length-END_RECORD_BYTES;
  for(;at>=earliest;at--){
    if(bytes.readUInt32LE(at)===RECORD.end&&bytes.readUInt16LE(at+20)===bytes.length-at-END_RECORD_BYTES)break;
  }
  if(at<earliest)refuseDocument("Not a ZIP archive");
  const disk=bytes.readUInt16LE(at+4);
  if(disk!==0&&disk!==ALL_ONES_16)refuseDocument("The archive spans several disks");
  let count=bytes.readUInt16LE(at+10),start=bytes.readUInt32LE(at+16);
  if(count===ALL_ONES_16||start===ALL_ONES_32){
    const locator=at-20;
    if(!fits(bytes,locator,20)||bytes.readUInt32LE(locator)!==RECORD.zip64Locator)refuseDocument("Damaged archive: its ZIP64 locator is missing");
    const record=wide(bytes,locator+8);
    if(!fits(bytes,record,56)||bytes.readUInt32LE(record)!==RECORD.zip64End)refuseDocument("Damaged archive: its ZIP64 end record is missing");
    count=wide(bytes,record+32);start=wide(bytes,record+48);
  }
  return {count,start};
}

// The ZIP64 extended information (header 0x0001) of an entry's extra field, which holds, in this order, the sizes and offset its
// directory entry marks as all ones.
function zip64Values(extra){
  for(let at=0;at+4<=extra.length;){
    const id=extra.readUInt16LE(at),length=extra.readUInt16LE(at+2),data=at+4;
    if(data+length>extra.length)break;
    if(id===0x0001)return extra.subarray(data,data+length);
    at=data+length;
  }
  return refuseDocument("Damaged archive: an entry lacks its ZIP64 sizes");
}

// A part name as APPNOTE asks for: relative, forward slashes only, no drive letter and no step out of the archive.
function isSafeName(name){
  return !name.startsWith("/")&&!name.includes("\\")&&name.charAt(1)!==":"&&!name.split("/").includes("..");
}

function indexDirectory(bytes){
  const {count,start}=findDirectory(bytes);
  if(count>BOUNDS.archiveEntries)reachLimit();
  const index=new Map();
  for(let n=0,at=start;n<count;n++){
    if(!fits(bytes,at,DIRECTORY_ENTRY_BYTES)||bytes.readUInt32LE(at)!==RECORD.directory)refuseDocument("Damaged archive: its directory is cut short");
    const nameLength=bytes.readUInt16LE(at+28),extraLength=bytes.readUInt16LE(at+30),commentLength=bytes.readUInt16LE(at+32);
    const nameAt=at+DIRECTORY_ENTRY_BYTES,extraAt=nameAt+nameLength,next=extraAt+extraLength+commentLength;
    if(next>bytes.length)refuseDocument("Damaged archive: its directory is cut short");
    const entry={
      flags:bytes.readUInt16LE(at+8),method:bytes.readUInt16LE(at+10),checksum:bytes.readUInt32LE(at+16),
      packedSize:bytes.readUInt32LE(at+20),size:bytes.readUInt32LE(at+24),headerAt:bytes.readUInt32LE(at+42),
    };
    if(entry.size===ALL_ONES_32||entry.packedSize===ALL_ONES_32||entry.headerAt===ALL_ONES_32){
      const values=zip64Values(bytes.subarray(extraAt,extraAt+extraLength));let read=0;
      const take=()=>read+8<=values.length?wide(values,(read+=8)-8):refuseDocument("Damaged archive: an entry's ZIP64 sizes are cut short");
      if(entry.size===ALL_ONES_32)entry.size=take();
      if(entry.packedSize===ALL_ONES_32)entry.packedSize=take();
      if(entry.headerAt===ALL_ONES_32)entry.headerAt=take();
    }
    // OCF requires UTF-8 names and OPC's part names are ASCII, so every name is read as UTF-8.
    const name=bytes.toString("utf8",nameAt,extraAt);
    if(!isSafeName(name))refuseDocument(`Malformed archive: the entry "${name}" points outside it`);
    if(entry.flags&1)refuseDocument("The document is password-protected");
    index.set(name,entry);
    at=next;
  }
  return index;
}

export class Archive{
  #bytes;
  #entries;
  #unpacked=0;
  constructor(bytes){this.#bytes=bytes;this.#entries=indexDirectory(bytes)}
  has(name){return this.#entries.has(name)}
  // The bytes of the part called name, or null when the archive has none. The part must unpack to the size its directory entry
  // gives and match its CRC-32.
  read(name){
    const entry=this.#entries.get(name);
    if(!entry)return null;
    if(entry.size>BOUNDS.partBytes||this.#unpacked+entry.size>BOUNDS.packageBytes)reachLimit();
    this.#unpacked+=entry.size;
    const bytes=this.#bytes,at=entry.headerAt;
    if(!fits(bytes,at,LOCAL_HEADER_BYTES)||bytes.readUInt32LE(at)!==RECORD.local)refuseDocument("Damaged archive: an entry's header is missing");
    const dataAt=at+LOCAL_HEADER_BYTES+bytes.readUInt16LE(at+26)+bytes.readUInt16LE(at+28);
    if(!fits(bytes,dataAt,entry.packedSize))refuseDocument("Damaged archive: an entry runs past the end of the file");
    const packed=bytes.subarray(dataAt,dataAt+entry.packedSize);
    let data;
    if(entry.method===0){
      if(entry.packedSize!==entry.size)refuseDocument("Damaged archive: a stored entry's two sizes differ");
      data=packed;
    }else if(entry.method===8){
      try{data=inflateRawSync(packed,{maxOutputLength:entry.size+1})}
      catch{refuseDocument("Damaged archive: an entry does not unpack to the size it gives")}
      if(data.length!==entry.size)refuseDocument("Damaged archive: an entry does not unpack to the size it gives");
    }else refuseDocument("The archive uses a compression method other than deflate");
    if(crc32(data)!==entry.checksum)refuseDocument("Damaged archive: an entry's checksum does not match");
    return data;
  }
}
