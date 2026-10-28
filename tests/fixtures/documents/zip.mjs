import { crc32, deflateRawSync } from "node:zlib";

// A ZIP archive of the given parts ({name: string | Buffer}), as Office, OpenDocument and EPUB files are: each part deflated, or
// stored when stored:true or when its name is in storedNames (an OpenDocument or EPUB file's "mimetype", which goes first and
// unpacked). sizes overrides what an entry's headers say it unpacks to ({name: bytes}), entryCount what the archive says it holds,
// and encrypted marks every entry as encrypted, as a password-protected archive's are.
export function zipArchive(parts,{storedNames=["mimetype"],stored=false,sizes={},entryCount=null,encrypted=false}={}){
  const local=[],central=[];let offset=0;const flags=0x800|(encrypted?1:0);
  for(const [name,content] of Object.entries(parts)){
    const data=Buffer.isBuffer(content)?content:Buffer.from(String(content),"utf8"),store=stored||storedNames.includes(name);
    const packed=store?data:deflateRawSync(data),method=store?0:8,filename=Buffer.from(name,"utf8"),size=sizes[name]??data.length;
    const header=Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(flags,6);header.writeUInt16LE(method,8);
    header.writeUInt32LE(crc32(data),14);header.writeUInt32LE(packed.length,18);header.writeUInt32LE(size,22);header.writeUInt16LE(filename.length,26);
    const directory=Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(flags,8);directory.writeUInt16LE(method,10);
    directory.writeUInt32LE(crc32(data),16);directory.writeUInt32LE(packed.length,20);directory.writeUInt32LE(size,24);directory.writeUInt16LE(filename.length,28);directory.writeUInt32LE(offset,42);
    local.push(header,filename,packed);central.push(directory,filename);
    offset+=header.length+filename.length+packed.length;
  }
  const directoryBytes=Buffer.concat(central),count=entryCount??central.length/2,end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(count,8);end.writeUInt16LE(count,10);end.writeUInt32LE(directoryBytes.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directoryBytes,end]);
}
