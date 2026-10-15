import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// A GNU message catalog (.mo) with a few of git's own German translations: the "hint:" before each hint (advice.c), "fatal: " and
// a refused Pull's reason, for git to find through GIT_TEXTDOMAINDIR. A git built with gettext, as Git for Windows, distributions'
// and Homebrew's are, then writes them that way under a German locale, with or without catalogs of its own installed.
function catalog(pairs){
  const entries=[["","Content-Type: text/plain; charset=UTF-8\n"],...pairs].sort((a,b)=>Buffer.compare(Buffer.from(a[0]),Buffer.from(b[0])));
  const count=entries.length,originals=28,translations=originals+count*8,head=Buffer.alloc(translations+count*8),strings=[];
  let offset=head.length;
  const table=(start,texts)=>texts.forEach((text,index)=>{const bytes=Buffer.from(text,"utf8");head.writeUInt32LE(bytes.length,start+index*8);head.writeUInt32LE(offset,start+index*8+4);strings.push(bytes,Buffer.alloc(1));offset+=bytes.length+1});
  head.writeUInt32LE(0x950412de,0);head.writeUInt32LE(0,4);head.writeUInt32LE(count,8);head.writeUInt32LE(originals,12);head.writeUInt32LE(translations,16);
  table(originals,entries.map(entry=>entry[0]));table(translations,entries.map(entry=>entry[1]));
  head.writeUInt32LE(0,20);head.writeUInt32LE(offset,24);
  return Buffer.concat([head,...strings]);
}

// Runs task with git set to answer in German (LANG, LANGUAGE and LC_ALL say de, the catalog above) and to color its hints
// (color.advice=always), as a person's own environment and config can; process.env is put back after.
export async function withGermanColoredGit(folder,task){
  await mkdir(join(folder,"de","LC_MESSAGES"),{recursive:true});
  await writeFile(join(folder,"de","LC_MESSAGES","git.mo"),catalog([
    ["%shint:%s%.*s%s\n","%sHinweis:%s%.*s%s\n"],["fatal: ","Schwerwiegend: "],
    ["There is no tracking information for the current branch.","Es gibt keine Tracking-Informationen für den aktuellen Branch."],
  ]));
  const values={GIT_TEXTDOMAINDIR:folder,LANG:"de_DE.UTF-8",LANGUAGE:"de",LC_ALL:"de_DE.UTF-8",GIT_CONFIG_COUNT:"1",GIT_CONFIG_KEY_0:"color.advice",GIT_CONFIG_VALUE_0:"always"};
  const saved=Object.fromEntries(Object.keys(values).map(name=>[name,process.env[name]]));
  Object.assign(process.env,values);
  try{return await task()}
  finally{for(const [name,value] of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value}}
}
