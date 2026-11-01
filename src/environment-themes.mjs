import { lstat, open, readdir } from "node:fs/promises";
import { join, posix } from "node:path";

// The themes an environment publishes: theme files in a folder on that machine, which Settings offers beside the app's own themes
// and keeps following as the files change there. A folder is read on this machine through the file system, and on a WSL or SSH
// host through short argv commands.

// How much of a theme folder is read. A Trebell theme is well under 1 KiB, and a VS Code color theme with its token colors is often
// 20 to 90 KiB (Settings imports both kinds). The catalog goes to the app whole, and on a WSL or SSH host each file costs two
// commands, so the count stays low.
export const THEME_FOLDER_LIMITS=Object.freeze({files:24,bytesPerFile:96*1024,bytesInAll:512*1024});

// Settings' Mode choices (system, light, dark) and its built-in themes (dark, midnight, black): a file named like one of them would
// hide it.
const APP_THEME_NAMES=new Set(["system","light","dark","midnight","black"]);

// ASCII only: a character is checked as it is, never through a case change (which turns some other letters into ASCII ones).
const LETTERS_AND_DIGITS="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ID_PUNCTUATION="._-";
const HEX_DIGITS="0123456789abcdefABCDEF";

// The id of the theme a file holds, from its name "<id>.json" (".json" in any letter case), or null when the name cannot be one. The
// id is what Settings stores for a theme the person follows: a letter or digit, then letters, digits, dots, underscores or hyphens,
// 80 characters at most.
function themeIdFromFileName(fileName){
  const name=String(fileName??"");
  if(name.length<6||name.slice(-5).toLowerCase()!==".json")return null;
  const id=name.slice(0,-5);
  if(id.length>80||!LETTERS_AND_DIGITS.includes(id[0]))return null;
  for(const character of id)if(!LETTERS_AND_DIGITS.includes(character)&&!ID_PUNCTUATION.includes(character))return null;
  return APP_THEME_NAMES.has(id.toLowerCase())?null:id;
}

// "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa".
function isHexColor(value){
  if(typeof value!=="string"||!value.startsWith("#"))return false;
  const digits=value.slice(1);
  if(![3,4,6,8].includes(digits.length))return false;
  for(const digit of digits)if(!HEX_DIGITS.includes(digit))return false;
  return true;
}

const isRecord=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);

function parsedRecord(text){
  let value=null;
  try{value=JSON.parse(text)}catch{}
  return isRecord(value)?value:null;
}

// The name Settings shows: the file's own name, else its label, else the id, trimmed to 80 characters; the id when that is empty.
function shownName(theme,id){
  const chosen=[theme.name,theme.label].find(Boolean)??id;
  return String(chosen).trim().slice(0,80)||id;
}

// A file's theme as the app gets it, or null when the text is not one: a JSON object naming its canvas color in "canvas", or in
// "colors" as "editor.background" (a VS Code theme) or "canvas". The file's own fields are kept for the app to read.
export function publishedThemeFromText(id,text){
  const theme=parsedRecord(text),palette=isRecord(theme?.colors)?theme.colors:{};
  const named=theme&&[theme.canvas,palette["editor.background"],palette.canvas].some(isHexColor);
  return named?Object.assign({},theme,{id,name:shownName(theme,id),published:true}):null;
}

// Reads a theme folder (one of the two readers below): the files with theme names in name order, the first THEME_FOLDER_LIMITS.files
// of them, skipping any that is not a plain file or is larger than bytesPerFile, and stopping at the first that would take the total
// past bytesInAll. A file that cannot be read or holds no theme is skipped.
export async function readThemeFolder(reader,limits=THEME_FOLDER_LIMITS){
  const files=[];
  for(const entry of await reader.list()){
    const id=themeIdFromFileName(entry.name);
    if(id)files.push({...entry,id});
  }
  files.sort((left,right)=>left.name===right.name?0:left.name<right.name?-1:1);
  const themes=[];
  let room=limits.bytesInAll;
  for(const file of files.slice(0,limits.files)){
    const bytes=await reader.size(file);
    if(bytes==null||bytes>limits.bytesPerFile)continue;
    if(bytes>room)break;
    room-=bytes;
    const text=await reader.read(file,limits.bytesPerFile);
    const theme=text==null?null:publishedThemeFromText(file.id,text);
    if(theme)themes.push(theme);
  }
  return themes;
}

// A folder on this machine. A missing or unreadable folder has no files. Sizes come from lstat, so a symbolic link, a folder or a
// device is not a plain file; a read takes at most one byte more than it may use, so a file that grew since lstat is seen as too big.
export function localThemeReader(folder){
  return {
    async list(){
      let names=[];
      try{names=await readdir(folder)}catch{}
      return names.map(name=>({name,location:join(folder,name)}));
    },
    async size(file){
      try{
        const entry=await lstat(file.location);
        return entry.isFile()?entry.size:null;
      }catch{return null}
    },
    async read(file,most){
      const handle=await open(file.location,"r").catch(()=>null);
      if(!handle)return null;
      try{
        const buffer=Buffer.alloc(most+1);
        let filled=0;
        for(;;){
          const {bytesRead}=await handle.read(buffer,filled,buffer.length-filled,filled);
          if(!bytesRead)break;
          filled+=bytesRead;
          if(filled===buffer.length)return null;
        }
        return buffer.toString("utf8",0,filled);
      }catch{return null}
      finally{await handle.close().catch(()=>{})}
    },
  };
}

// How long each command on a host may take: a host reached over SSH may take its whole 8 s connect timeout before it answers.
const HOST_LISTING_MS=15000,HOST_FILE_MS=10000;

// A folder on a WSL or SSH host, read through run (the environment's argv command runner): test -d (a missing folder has no
// files), one find that lists the plain files directly in it ending in .json in any letter case (find does not follow links), then
// wc -c and cat for each file read. A listing the host refuses is an error, with the host's own message when it gave one.
export function hostThemeReader(run,folder,environmentName){
  const ask=(command,args,timeoutMs,more={})=>run(Object.assign({command,args,timeoutMs},more));
  return {
    async list(){
      if((await ask("test",["-d",folder],HOST_FILE_MS)).exitCode!==0)return [];
      const listing=await ask("find",[folder,"-maxdepth","1","-type","f","-name","*.[jJ][sS][oO][nN]"],HOST_LISTING_MS);
      if(listing.exitCode!==0){
        const said=String(listing.stderr??"").trim();
        throw new Error(said||`Could not list the theme folder on ${environmentName}`);
      }
      const files=[];
      for(const line of String(listing.stdout??"").split(/\r?\n/)){
        const location=line.trim();
        if(location)files.push({name:posix.basename(location),location});
      }
      return files;
    },
    async size(file){
      const counted=await ask("wc",["-c",file.location],HOST_FILE_MS);
      const measured=counted.exitCode===0?/^\s*(\d+)(?:\s|$)/.exec(String(counted.stdout??"")):null;
      return measured?Number(measured[1]):null;
    },
    async read(file,most){
      const shown=await ask("cat",[file.location],HOST_FILE_MS,{maxOutput:most+1});
      const text=shown.exitCode===0?String(shown.stdout??""):null;
      return text!=null&&Buffer.byteLength(text,"utf8")<=most?text:null;
    },
  };
}
