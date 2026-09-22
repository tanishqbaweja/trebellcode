import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { packageRoot } from "./paths.mjs";

const NOTICE_FILES=["LICENSE","LICENSE.md","LICENSE.txt","LICENCE","LICENCE.md","COPYING","NOTICE","NOTICE.md"];
let cache=null;

function safeInside(root,path){const rel=relative(resolve(root),resolve(path));return rel===""||(!rel.startsWith(".."+sep)&&rel!==".."&&!rel.startsWith("../")&&!rel.startsWith("..\\"))}
async function readJson(path){try{return JSON.parse(await readFile(path,"utf8"))}catch{return null}}
async function noticeText(dir){
  const parts=[];
  for(const name of NOTICE_FILES){
    try{const text=await readFile(join(dir,name),"utf8");if(text.trim())parts.push(`${name}\n${"=".repeat(name.length)}\n${text.trim()}`)}catch{}
  }
  return parts.join("\n\n");
}
function componentFor(name,rootPackage){
  if(rootPackage.dependencies?.[name])return "Runtime dependency";
  if(rootPackage.optionalDependencies?.[name])return "Optional runtime dependency";
  if(rootPackage.devDependencies?.[name])return "Development dependency";
  return "Transitive dependency";
}
async function collectPackage(dir,rootPackage,records,seen){
  const pkg=await readJson(join(dir,"package.json"));if(!pkg?.name)return;
  const version=String(pkg.version||"");const key=`${pkg.name}@${version}`;if(!seen.has(key)){
    seen.add(key);records.push({id:key,name:String(pkg.name),version,license:typeof pkg.license==="string"?pkg.license:(pkg.license?.type||"Unknown"),component:componentFor(pkg.name,rootPackage),directory:dir,homepage:pkg.homepage||pkg.repository?.url||null});
  }
  const nested=join(dir,"node_modules");try{await scanNodeModules(nested,rootPackage,records,seen)}catch{}
}
async function scanNodeModules(dir,rootPackage,records,seen){
  const entries=await readdir(dir,{withFileTypes:true});
  for(const entry of entries){
    if(!entry.isDirectory()||entry.name.startsWith("."))continue;
    if(entry.name.startsWith("@")){
      let scoped=[];try{scoped=await readdir(join(dir,entry.name),{withFileTypes:true})}catch{}
      for(const child of scoped)if(child.isDirectory())await collectPackage(join(dir,entry.name,child.name),rootPackage,records,seen);
    }else await collectPackage(join(dir,entry.name),rootPackage,records,seen);
  }
}
async function build(){
  const rootPackage=await readJson(join(packageRoot,"package.json"))||{};const records=[],seen=new Set();
  try{await scanNodeModules(join(packageRoot,"node_modules"),rootPackage,records,seen)}catch{}
  const vendor=join(packageRoot,"vendor","freebuff2api");const vendorPkg=await readJson(join(vendor,"package.json"));
  if(vendorPkg?.name){const key=`${vendorPkg.name}@${vendorPkg.version||"vendored"}`;if(!seen.has(key))records.push({id:key,name:vendorPkg.name,version:String(vendorPkg.version||"vendored"),license:typeof vendorPkg.license==="string"?vendorPkg.license:"MIT",component:"Vendored provider bridge",directory:vendor,homepage:vendorPkg.homepage||vendorPkg.repository?.url||null})}
  records.sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version));
  return {records,rootPackage};
}
async function inventory(){if(!cache)cache=await build();return cache}

export async function listLicenses({query=""}={}){
  const {records}=await inventory();const terms=String(query||"").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const items=(terms.length?records.filter(item=>{const haystack=`${item.name} ${item.version} ${item.license} ${item.component}`.toLowerCase();return terms.every(term=>haystack.includes(term))}):records).map(({directory,...item})=>item);
  return {items,total:records.length,filtered:items.length};
}

export async function licenseDetail(id){
  const {records}=await inventory();const item=records.find(record=>record.id===id);if(!item)throw new Error("License entry was not found");
  if(!safeInside(packageRoot,item.directory))throw new Error("License path is outside the Trebell package");
  const text=await noticeText(item.directory);
  const {directory,...publicItem}=item;
  return {...publicItem,text:text||`Declared license: ${item.license}\n\nThis package did not ship a separate LICENSE or NOTICE file in the installed application.`};
}

export function resetLicenseCache(){cache=null}
