// Which model a model catalog lands on, and the order Trebell Native offers a provider's models in for the person to pick.

// The model a catalog lands on: the first saved choice it lists (the open thread's own model, the project's default model, a pick
// made earlier in the window), else the catalog's default, else its only model. A catalog of several models that names no default
// lands on none when ask is set, so the composer asks which one (Trebell Native on Meta, xAI, AgentRouter and every other provider
// but OpenAI, whose default is the measured gpt-6-luna); a harness's catalog lands on its first model, as the harness lists them.
export function landingModel(ids,{saved=[],catalogDefault=null,ask=false}={}){
  const listed=Array.isArray(ids)?ids:[];
  for(const id of [...saved,catalogDefault])if(id&&listed.includes(id))return id;
  return listed.length===1||!ask?listed[0]||"":"";
}

// A provider's models, newest first, without reading anything into a name but its numbers: ids that differ only in their numbers
// (muse-spark-1.1 to muse-spark-1.3) are one model's versions, highest first, and those families go by the newest creation time
// the provider gives one of their models, else in the provider's own order (rows: the catalog's metadata, in the order the
// provider listed them; the catalog's ids come sorted). muse-spark-1.3-contributor is a family of its own.
export function newestModelsFirst(ids,rows=[]){
  const listed=Array.isArray(ids)?ids:[],given=new Map();
  for(const row of Array.isArray(rows)?rows:[]){const id=String(row?.id??"");if(id&&!given.has(id))given.set(id,{at:given.size,created:typeof row.created==="number"&&Number.isFinite(row.created)?row.created:-Infinity})}
  const families=new Map();
  listed.forEach((id,index)=>{
    const text=String(id),key=text.toLowerCase().replace(/\d+/g,"#"),row=given.get(text)||{at:given.size+index,created:-Infinity};
    const family=families.get(key)||{created:-Infinity,at:Infinity,members:[]};families.set(key,family);
    family.created=Math.max(family.created,row.created);family.at=Math.min(family.at,row.at);
    family.members.push({id,version:(text.match(/\d+/g)||[]).map(Number),...row});
  });
  const later=(a,b)=>(b.created>a.created?1:b.created<a.created?-1:0)||a.at-b.at;
  const higher=(a,b)=>{for(let index=0;index<a.version.length;index++)if(a.version[index]!==b.version[index])return b.version[index]-a.version[index];return later(a,b)};
  return [...families.values()].sort(later).flatMap(family=>family.members.sort(higher).map(member=>member.id));
}
