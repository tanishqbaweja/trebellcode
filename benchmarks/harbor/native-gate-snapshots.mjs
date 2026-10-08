import { cpSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

// Benchmark measurement only: copy the task's declared deliverables at each main
// completion gate so the official verifier can later grade the exact state each
// gate judged. Reads the workspace; never writes to it.
const DEFAULT_MAX_BYTES_PER_SNAPSHOT=64*1024*1024;

export function parseGateSnapshotArtifacts(value){
  let parsed;try{parsed=JSON.parse(String(value||"[]"))}catch{return []}
  if(!Array.isArray(parsed))return [];
  return parsed
    .map(item=>typeof item==="string"?{source:item,exclude:[]}:{source:String(item?.source||""),exclude:Array.isArray(item?.exclude)?item.exclude.map(String):[]})
    .map(item=>({source:item.source.trim(),exclude:item.exclude}))
    .filter(item=>item.source.startsWith("/")&&!item.source.split("/").includes(".."));
}

export function gateSnapshotRelativePath(source){
  return String(source||"").replace(/^[A-Za-z]:/,"").replace(/^[\\/]+/,"").replace(/[\\/]+$/,"");
}

function wildcardMatch(pattern,value){
  return new RegExp("^"+String(pattern).replace(/[.+^${}()|[\]\\]/g,"\\$&").replace(/\*/g,".*")+"$").test(value);
}

function excluded(rootPath,path,patterns){
  if(!patterns.length||path===rootPath)return false;
  const rel=relative(rootPath,path).replace(/\\/g,"/"),name=basename(path);
  return patterns.some(pattern=>{const value=String(pattern).replace(/^\.\//,"");return wildcardMatch(value,name)||wildcardMatch(value,rel)});
}

function treeBytes(rootPath,patterns,limit){
  let total=0;const stack=[rootPath];
  while(stack.length){
    const path=stack.pop();if(excluded(rootPath,path,patterns))continue;
    const info=lstatSync(path);
    if(info.isDirectory()){for(const name of readdirSync(path))stack.push(join(path,name))}
    else if(info.isFile()){total+=info.size;if(total>limit)return total}
  }
  return total;
}

export function createGateSnapshotter({artifacts=[],directory="/logs/agent/gate-snapshots",maxBytesPerSnapshot=DEFAULT_MAX_BYTES_PER_SNAPSHOT}={}){
  let count=0;
  return {
    get enabled(){return artifacts.length>0},
    get count(){return count},
    snapshot(meta={}){
      if(!artifacts.length)return null;
      count++;
      const target=join(directory,"gate-"+count),entries=[];let remaining=maxBytesPerSnapshot;
      mkdirSync(target,{recursive:true});
      for(const artifact of artifacts){
        const source=artifact.source.length>1?artifact.source.replace(/[\\/]+$/,""):artifact.source,exclude=artifact.exclude||[];
        let info;try{info=lstatSync(source)}catch{entries.push({source:artifact.source,status:"missing"});continue}
        const directoryArtifact=info.isDirectory(),bytes=directoryArtifact?treeBytes(source,exclude,remaining+1):info.size;
        if(bytes>remaining){entries.push({source:artifact.source,status:"too_large",bytes});continue}
        const destination=join(target,"artifacts",gateSnapshotRelativePath(source));
        mkdirSync(dirname(destination),{recursive:true});
        cpSync(source,destination,{recursive:true,filter:path=>!excluded(source,path,exclude)});
        remaining-=bytes;
        entries.push({source:artifact.source,status:"ok",type:directoryArtifact?"directory":"file",bytes});
      }
      const manifest={index:count,...meta,entries};
      writeFileSync(join(target,"snapshot.json"),JSON.stringify(manifest,null,2)+"\n");
      return manifest;
    },
  };
}
