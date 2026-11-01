import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

// Firefox lists its profiles in profiles.ini, in the folder that holds its data. The file is INI text: a [ProfileN] section per
// profile, with Name (what the profile manager shows), Path (the profile's folder) and IsRelative (1: Path is under the folder
// that holds profiles.ini, written with forward slashes; 0: Path is a full path). Other sections ([General], [Install...]) are
// not profiles. A profile folder keeps its cookies in cookies.sqlite.

// The profiles profiles.ini lists, in file order, as {id, name, directory}: id and directory are the folder's full path, name the
// profile's Name (the folder's path when it has none). By default only folders that hold cookies.sqlite count.
export function parseFirefoxProfiles(text,firefoxFolder,options={}){
  const cookiesNeeded=options.requireCookies===undefined?true:Boolean(options.requireCookies);
  const listed=[];
  for(const {header,settings} of iniSections(text)){
    if(!namesProfile(header))continue;
    const folder=profileLocation(firefoxFolder,settings);
    if(folder===null)continue;
    if(cookiesNeeded&&!existsSync(join(folder,"cookies.sqlite")))continue;
    const shown=settings.get("name")||folder;
    listed.push({id:folder,name:shown.trim(),directory:folder});
  }
  return listed;
}

// The text as a list of sections in file order: each keeps its header line as written (trimmed) and its settings, keyed by the
// lower-cased name before the first "=", the last line winning. Lines before the first header and lines with no "=" count for nothing.
function iniSections(text){
  const sections=[];
  for(const rawLine of (text==null?"":String(text)).split("\n")){
    const line=rawLine.trim();
    if(line.startsWith("[")){
      sections.push({header:line,settings:new Map()});
      continue;
    }
    const open=sections.at(-1),equals=line.indexOf("=");
    if(open===undefined||equals===-1)continue;
    open.settings.set(line.slice(0,equals).trim().toLowerCase(),line.slice(equals+1).trim());
  }
  return sections;
}

// "[Profile0]", "[profile12]": the word Profile in any letter case, at least one digit, between brackets, nothing more.
function namesProfile(header){
  if(header.length<10||header.at(-1)!=="]")return false;
  const word=header.slice(1,8),number=header.slice(8,-1);
  if(word.toLowerCase()!=="profile")return false;
  for(const character of number)if(character<"0"||character>"9")return false;
  return true;
}

// True when target is base itself or somewhere below it (by the platform's path rules).
function withinFolder(base,target){
  const route=relative(base,target);
  if(isAbsolute(route))return false;
  return route.split(sep,1)[0]!=="..";
}

// The full path of the folder a profile section names, or null when it names none that may be read: Path missing or empty; a
// relative profile (IsRelative missing or 1) whose Path is a full path or leads out of the Firefox folder; a full-path profile
// (IsRelative 0) whose Path is not a full path; or any other IsRelative.
function profileLocation(firefoxFolder,settings){
  const written=settings.get("path");
  if(!written)return null;
  switch(settings.get("isrelative")){
    case "0":
      return isAbsolute(written)?normalize(written):null;
    case undefined:
    case "1":{
      if(isAbsolute(written))return null;
      const located=resolve(firefoxFolder,written);
      return withinFolder(firefoxFolder,located)?located:null;
    }
    default:
      return null;
  }
}

// ---- Cookies

// A profile's cookies.sqlite is an SQLite store that Firefox keeps in WAL mode, and its user_version is the store's schema version.
// Each cookie is a row of moz_cookies. The import reads host (".example.com" for a domain cookie, "example.com" for a host-only
// one), name, value, path, expiry, isSecure and isHttpOnly (1 or 0), sameSite, rawSameSite and originAttributes ("" for a normal
// window; containers, private windows and partitioning each add a "^..." suffix). The schema versions that matter here:
//   9   sameSite: SAMESITE_NONE 0, SAMESITE_LAX 1, SAMESITE_STRICT 2
//   10  rawSameSite: the attribute as the site sent it, so a Lax that only Firefox's default gave can be told apart
//   15  rows whose Lax came only from the default turn into SAMESITE_UNSET (256), and rawSameSite goes away
//   16  expiry counts milliseconds since the epoch instead of seconds
const SAME_SITE={none:0,lax:1,strict:2,unset:256};
const ELECTRON_SAME_SITE=new Map([[SAME_SITE.none,"no_restriction"],[SAME_SITE.lax,"lax"],[SAME_SITE.strict,"strict"]]);
const EXPIRY_IN_MILLISECONDS_FROM=16;
const MOST_COOKIES=10_000;
// The columns the import fills a cookie from. Every store since version 6 has all but the last two, and has originAttributes,
// which picks the rows; sameSite and rawSameSite read as NULL in a store without them.
const READ_COLUMNS=["host","name","value","path","expiry","isSecure","isHttpOnly","sameSite","rawSameSite"];
const REQUIRED_COLUMNS=[...READ_COLUMNS.slice(0,-2),"originAttributes"];
const UNREADABLE_STORE="This Firefox profile's cookie store is in a format Trebell cannot read. "+
  "Open the profile in a current Firefox once, close Firefox, then import again.";

// Electron's SameSite name for a stored row. A row from a store that still has rawSameSite is first read the way Firefox's own
// upgrade to version 15 reads it: a Lax the site never asked for counts as unset.
export function firefoxSameSite(sameSite,rawSameSite){
  const settled=sameSite===SAME_SITE.lax&&rawSameSite===SAME_SITE.none?SAME_SITE.unset:sameSite;
  return ELECTRON_SAME_SITE.get(settled)??"unspecified";
}

// Seconds since the epoch for a stored expiry, or undefined when there is none to keep (missing, zero, negative or not a number).
// From version 16 on the store counts milliseconds, which become whole seconds, rounded down.
export function firefoxExpirySeconds(stored,schemaVersion){
  const amount=Number(stored);
  if(Number.isNaN(amount)||amount<=0)return undefined;
  const inMilliseconds=Number(schemaVersion)>=EXPIRY_IN_MILLISECONDS_FROM;
  return inMilliseconds?Math.floor(amount/1000):amount;
}

// The cookies of the cookies.sqlite at that path, as Electron's cookies.set takes them: only a normal window's, at most
// MOST_COOKIES of them, in the store's own order.
export async function readFirefoxCookieDatabase(database){
  if(!existsSync(database))throw new Error("Firefox cookies.sqlite was not found for that profile.");
  return readStoreCopy(database,store=>{
    const schemaVersion=Number(store.prepare("PRAGMA user_version").get()?.user_version)||0;
    return store.prepare(cookieSelect(store)).all().map(row=>electronCookie(row,schemaVersion));
  });
}

// Runs read on a private copy of the store, so SQLite never opens or locks the profile's own files. The copy takes the store's
// write-ahead log along when there is one, since the log holds changes not yet written into the store. It leaves the
// shared-memory index (-shm) behind: SQLite builds a new one from the log when it opens the copy. The copy is Trebell's own file,
// so it opens like any other database, and it is deleted afterwards, whether read succeeds or not.
async function readStoreCopy(database,read){
  const {DatabaseSync}=await import("node:sqlite");
  const folder=mkdtempSync(join(tmpdir(),"trebell-firefox-snapshot-"));
  try{
    const copy=join(folder,"cookies.sqlite");
    copyFileSync(database,copy);
    if(existsSync(`${database}-wal`))copyFileSync(`${database}-wal`,`${copy}-wal`);
    const store=new DatabaseSync(copy);
    try{
      return read(store);
    }finally{
      store.close();
    }
  }finally{
    rmSync(folder,{recursive:true,force:true,maxRetries:5});
  }
}

// The SELECT for this store's moz_cookies, built from the columns its table has (SQL names compare without letter case). Each
// column is named with AS, so the row's keys do not depend on how the table spells them. A store without a required column, or
// without the table, cannot be read.
function cookieSelect(store){
  const present=new Set(store.prepare("PRAGMA table_info(moz_cookies)").all().map(column=>String(column.name).toLowerCase()));
  const has=name=>present.has(name.toLowerCase());
  if(!REQUIRED_COLUMNS.every(has))throw new Error(UNREADABLE_STORE);
  const fields=READ_COLUMNS.map(name=>`${has(name)?name:"NULL"} AS ${name}`);
  return `SELECT ${fields.join(", ")} FROM moz_cookies WHERE originAttributes = '' LIMIT ${MOST_COOKIES}`;
}

// One row as Electron's cookie details. A domain cookie names its domain (Electron widens it to subdomains); a host-only cookie
// gives none, so it stays host-only. The URL takes the scheme its Secure flag needs and a path that starts with "/".
function electronCookie(row,schemaVersion){
  const host=storedText(row.host),path=storedText(row.path)||"/",secure=isOne(row.isSecure),domainWide=host.startsWith(".");
  const cookie={
    url:`${secure?"https":"http"}://${domainWide?host.slice(1):host}${path.startsWith("/")?"":"/"}${path}`,
    name:storedText(row.name),
    value:storedText(row.value),
    path,
    secure,
    httpOnly:isOne(row.isHttpOnly),
    sameSite:firefoxSameSite(row.sameSite,row.rawSameSite)
  };
  if(domainWide)cookie.domain=host;
  const expirationDate=firefoxExpirySeconds(row.expiry,schemaVersion);
  if(expirationDate>0)cookie.expirationDate=expirationDate;
  return cookie;
}

const storedText=stored=>stored==null?"":String(stored);
const isOne=stored=>Number(stored)===1;
