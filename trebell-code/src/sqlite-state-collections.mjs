import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname,join } from "node:path";
import { trebellHome } from "./paths.mjs";

const require=createRequire(import.meta.url);
const LIMITS=Object.freeze({checkpoints:200,usage:5000,verification:1000,knowledge:5000});

function databaseSync(){try{return require("node:sqlite").DatabaseSync}catch{return null}}
function payload(row){if(!row)return null;try{return JSON.parse(row.payload_json||"null")}catch{return null}}
function normalizedEnvironment(value){const text=String(value??"").trim();return text||null}
function boundedText(value,max=1000){const text=String(value??"").trim();return text?text.slice(0,max):null}
function compactPullRequest(value){
  if(!value||typeof value!=="object")return null;
  const identity=value.identity&&typeof value.identity==="object"?{
    provider:boundedText(value.identity.provider,80),host:boundedText(value.identity.host,300),repository:boundedText(value.identity.repository,500),
    number:Number.isFinite(Number(value.identity.number))?Number(value.identity.number):null,
  }:null;
  const snapshot=value.snapshot&&typeof value.snapshot==="object"?{title:boundedText(value.snapshot.title,500),state:boundedText(value.snapshot.state,80),url:boundedText(value.snapshot.url,2000)}:null;
  return {
    ...(identity?{identity}:{}),number:Number.isFinite(Number(value.number))?Number(value.number):identity?.number??null,
    title:boundedText(value.title,500),state:boundedText(value.state,80),url:boundedText(value.url,2000),
    headRefName:boundedText(value.headRefName,300),baseRefName:boundedText(value.baseRefName,300),...(snapshot?{snapshot}:{}),
  };
}
function compactThreadSnapshot(value){
  if(!value||typeof value!=="object")return null;
  const section=value.section&&typeof value.section==="object"?{id:boundedText(value.section.id,300),name:boundedText(value.section.name,300)}:null;
  const status=value.status&&typeof value.status==="object"?{type:boundedText(value.status.type,80),activeFlags:Array.isArray(value.status.activeFlags)?value.status.activeFlags.slice(0,20).map(item=>String(item).slice(0,100)):[]}:null;
  return {id:boundedText(value.id,500),name:boundedText(value.name,500),preview:boundedText(value.preview,1000),cwd:boundedText(value.cwd,4000),model:boundedText(value.model,500),updatedAt:Number(value.updatedAt)||0,createdAt:Number(value.createdAt)||0,...(status?{status}:{}),...(section?{section}:{}),projectId:boundedText(value.projectId,500),runtime:boundedText(value.runtime,80),provider:boundedText(value.provider,200)};
}
function compactDelegation(value){
  if(!value||typeof value!=="object")return null;
  return {id:boundedText(value.id,500),parentThreadId:boundedText(value.parentThreadId,500),label:boundedText(value.label,300),task:boundedText(value.task,1000),role:boundedText(value.role,100),status:boundedText(value.status,100),model:boundedText(value.model,500),permissions:boundedText(value.permissions,100),permission:boundedText(value.permission,100),isolation:boundedText(value.isolation,100),branch:boundedText(value.branch,500),ownership:Array.isArray(value.ownership)?value.ownership.slice(0,50).map(item=>String(item).slice(0,500)):[]};
}
export function threadMetaCatalogProjection(item={}){
  if(!item||typeof item!=="object")return {};
  const linked=Array.isArray(item.linkedPullRequests)?item.linkedPullRequests.slice(0,20).map(compactPullRequest).filter(Boolean):[];
  const attachments=Array.isArray(item.attachments)?item.attachments.filter(entry=>entry?.attachmentType==="pull_request").slice(0,20).map(entry=>({attachmentType:"pull_request",identityKey:boundedText(entry.identityKey,1000),payload:compactPullRequest(entry.payload)})).filter(entry=>entry.payload):[];
  const delegation=compactDelegation(item.delegation),snapshot=compactThreadSnapshot(item.threadSnapshot),branchPullRequest=compactPullRequest(item.branchPullRequest);
  return {__catalogOnly:true,runtime:boundedText(item.runtime,80),runtimeInstanceId:boundedText(item.runtimeInstanceId,500),provider:boundedText(item.provider,200),model:boundedText(item.model,500),cwd:boundedText(item.cwd,4000),environmentId:boundedText(item.environmentId,500),branch:boundedText(item.branch,500),parentThreadId:boundedText(item.parentThreadId,500),projectless:Boolean(item.projectless),snoozedUntil:Number(item.snoozedUntil)||null,archived:Boolean(item.archived),deletedAt:Number(item.deletedAt)||null,pinned:Boolean(item.pinned),sectionName:boundedText(item.sectionName,300),updatedAt:Number(item.updatedAt)||0,lastOpenedAt:Number(item.lastOpenedAt)||0,createdAt:Number(item.createdAt)||0,...(snapshot?{threadSnapshot:snapshot}:{}),...(delegation?{delegation}:{}),...(linked.length?{linkedPullRequests:linked}:{}),...(attachments.length?{attachments}:{}),...(branchPullRequest?{branchPullRequest}:{}),};
}

export class SqliteStateCollections{
  constructor(env=process.env){
    const DatabaseSync=databaseSync();if(!DatabaseSync)throw new Error("node:sqlite is unavailable");
    this.DatabaseSync=DatabaseSync;this.path=join(trebellHome(env),"trebell.sqlite");mkdirSync(dirname(this.path),{recursive:true});
    this.#withDb(db=>{
      db.exec("PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS state_thread_meta (
          thread_id TEXT PRIMARY KEY, runtime TEXT, environment_id TEXT, updated_at INTEGER NOT NULL, catalog_json TEXT NOT NULL DEFAULT '{}', payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS state_thread_meta_updated_idx ON state_thread_meta(updated_at DESC);
        CREATE INDEX IF NOT EXISTS state_thread_meta_runtime_idx ON state_thread_meta(runtime,updated_at DESC);
        CREATE INDEX IF NOT EXISTS state_thread_meta_environment_idx ON state_thread_meta(environment_id,updated_at DESC);
        CREATE TABLE IF NOT EXISTS state_checkpoints (
          id TEXT PRIMARY KEY, thread_id TEXT, created_at INTEGER NOT NULL, payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS state_checkpoints_thread_idx ON state_checkpoints(thread_id,created_at DESC);
        CREATE TABLE IF NOT EXISTS state_usage (
          id TEXT PRIMARY KEY, runtime TEXT, provider TEXT, model TEXT, environment_id TEXT, thread_id TEXT, turn_id TEXT,
          at INTEGER NOT NULL, payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS state_usage_at_idx ON state_usage(at DESC);
        CREATE INDEX IF NOT EXISTS state_usage_thread_idx ON state_usage(thread_id,at DESC);
        CREATE INDEX IF NOT EXISTS state_usage_environment_idx ON state_usage(environment_id,at DESC);
        CREATE TABLE IF NOT EXISTS state_verification (
          id TEXT PRIMARY KEY, environment_id TEXT, project_path TEXT, thread_id TEXT, turn_id TEXT, status TEXT, risk TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS state_verification_thread_idx ON state_verification(thread_id,updated_at DESC);
        CREATE INDEX IF NOT EXISTS state_verification_project_idx ON state_verification(project_path,environment_id,updated_at DESC);
        CREATE TABLE IF NOT EXISTS state_knowledge (
          id TEXT PRIMARY KEY, project_path TEXT NOT NULL, environment_id TEXT, status TEXT, category TEXT,
          updated_at INTEGER NOT NULL, payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS state_knowledge_project_idx ON state_knowledge(project_path,environment_id,status,updated_at DESC);
      `);
      const threadColumns=new Set(db.prepare("PRAGMA table_info(state_thread_meta)").all().map(row=>String(row.name)));
      if(!threadColumns.has("catalog_json"))db.exec("ALTER TABLE state_thread_meta ADD COLUMN catalog_json TEXT NOT NULL DEFAULT '{}'");
      const stale=db.prepare("SELECT thread_id,payload_json FROM state_thread_meta WHERE catalog_json IS NULL OR catalog_json='{}'").all();
      if(stale.length){
        const update=db.prepare("UPDATE state_thread_meta SET catalog_json=? WHERE thread_id=?");
        for(const row of stale){let item={};try{item=JSON.parse(row.payload_json||"{}")}catch{}update.run(JSON.stringify(threadMetaCatalogProjection(item)),String(row.thread_id))}
      }
    });
  }
  #withDb(fn,{write=false}={}){
    const db=new this.DatabaseSync(this.path);db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    if(write)db.exec("BEGIN IMMEDIATE");
    try{const value=fn(db);if(write)db.exec("COMMIT");return value}
    catch(error){if(write)try{db.exec("ROLLBACK")}catch{}throw error}
    finally{db.close()}
  }
  #prune(db,table,orderColumn,limit){db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} ORDER BY ${orderColumn} DESC LIMIT -1 OFFSET ?)` ).run(limit)}
  importLegacy({threadMeta={},checkpoints=[],usageRecords=[],verificationRecords=[],repositoryKnowledge=[]}={}){
    const threadEntries=threadMeta&&typeof threadMeta==="object"&&!Array.isArray(threadMeta)?Object.entries(threadMeta):[];
    if(!threadEntries.length&&![checkpoints,usageRecords,verificationRecords,repositoryKnowledge].some(items=>Array.isArray(items)&&items.length))return false;
    this.#withDb(db=>{
      const thread=db.prepare("INSERT OR IGNORE INTO state_thread_meta(thread_id,runtime,environment_id,updated_at,catalog_json,payload_json) VALUES(?,?,?,?,?,?)");
      for(const [threadId,item] of threadEntries)if(threadId&&item&&typeof item==="object")thread.run(String(threadId),item.runtime||null,normalizedEnvironment(item.environmentId),Number(item.updatedAt)||Date.now(),JSON.stringify(threadMetaCatalogProjection(item)),JSON.stringify(item));
      const checkpoint=db.prepare("INSERT OR IGNORE INTO state_checkpoints(id,thread_id,created_at,payload_json) VALUES(?,?,?,?)");
      for(const item of checkpoints||[])if(item?.id)checkpoint.run(String(item.id),item.threadId?String(item.threadId):null,Number(item.createdAt)||Date.now(),JSON.stringify(item));
      const usage=db.prepare("INSERT OR IGNORE INTO state_usage(id,runtime,provider,model,environment_id,thread_id,turn_id,at,payload_json) VALUES(?,?,?,?,?,?,?,?,?)");
      for(const item of usageRecords||[])if(item?.id)usage.run(String(item.id),item.runtime||null,item.provider||null,item.model||null,normalizedEnvironment(item.environmentId),item.threadId||null,item.turnId||null,Number(item.at)||Date.now(),JSON.stringify(item));
      const verification=db.prepare("INSERT OR IGNORE INTO state_verification(id,environment_id,project_path,thread_id,turn_id,status,risk,created_at,updated_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?)");
      for(const item of verificationRecords||[])if(item?.id)verification.run(String(item.id),normalizedEnvironment(item.environmentId),item.projectPath||null,item.threadId||null,item.turnId||null,item.status||null,item.risk||null,Number(item.createdAt)||Date.now(),Number(item.updatedAt)||Number(item.createdAt)||Date.now(),JSON.stringify(item));
      const knowledge=db.prepare("INSERT OR IGNORE INTO state_knowledge(id,project_path,environment_id,status,category,updated_at,payload_json) VALUES(?,?,?,?,?,?,?)");
      for(const item of repositoryKnowledge||[])if(item?.id&&item?.projectPath)knowledge.run(String(item.id),String(item.projectPath),normalizedEnvironment(item.environmentId),item.status||null,item.category||null,Number(item.updatedAt)||Date.now(),JSON.stringify(item));
      this.#prune(db,"state_checkpoints","created_at",LIMITS.checkpoints);this.#prune(db,"state_usage","at",LIMITS.usage);this.#prune(db,"state_verification","updated_at",LIMITS.verification);this.#prune(db,"state_knowledge","updated_at",LIMITS.knowledge);
    },{write:true});return true;
  }
  threadMeta(threadId){return this.#withDb(db=>payload(db.prepare("SELECT payload_json FROM state_thread_meta WHERE thread_id=?").get(String(threadId))))}
  putThreadMeta(threadId,item){return this.#withDb(db=>{db.prepare("INSERT INTO state_thread_meta(thread_id,runtime,environment_id,updated_at,catalog_json,payload_json) VALUES(?,?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET runtime=excluded.runtime,environment_id=excluded.environment_id,updated_at=excluded.updated_at,catalog_json=excluded.catalog_json,payload_json=excluded.payload_json").run(String(threadId),item?.runtime||null,normalizedEnvironment(item?.environmentId),Number(item?.updatedAt)||Date.now(),JSON.stringify(threadMetaCatalogProjection(item||{})),JSON.stringify(item||{}));return item},{write:true})}
  threadMetaMap(){return this.#withDb(db=>Object.fromEntries(db.prepare("SELECT thread_id,payload_json FROM state_thread_meta ORDER BY updated_at DESC").all().map(row=>[String(row.thread_id),payload(row)||{}])))}
  threadMetaCatalogMap(){return this.#withDb(db=>Object.fromEntries(db.prepare("SELECT thread_id,catalog_json FROM state_thread_meta ORDER BY updated_at DESC").all().map(row=>{let item={};try{item=JSON.parse(row.catalog_json||"{}")}catch{}return [String(row.thread_id),item]})))}
  checkpoint(id){return this.#withDb(db=>payload(db.prepare("SELECT payload_json FROM state_checkpoints WHERE id=?").get(String(id))))}
  putCheckpoint(item){return this.#withDb(db=>{db.prepare("INSERT INTO state_checkpoints(id,thread_id,created_at,payload_json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET thread_id=excluded.thread_id,created_at=excluded.created_at,payload_json=excluded.payload_json").run(String(item.id),item.threadId?String(item.threadId):null,Number(item.createdAt)||Date.now(),JSON.stringify(item));this.#prune(db,"state_checkpoints","created_at",LIMITS.checkpoints);return item},{write:true})}
  checkpoints(threadId=null){return this.#withDb(db=>{const rows=threadId?db.prepare("SELECT payload_json FROM state_checkpoints WHERE thread_id=? ORDER BY created_at DESC LIMIT ?").all(String(threadId),LIMITS.checkpoints):db.prepare("SELECT payload_json FROM state_checkpoints ORDER BY created_at DESC LIMIT ?").all(LIMITS.checkpoints);return rows.map(payload).filter(Boolean)})}
  usageRecord(id){return this.#withDb(db=>payload(db.prepare("SELECT payload_json FROM state_usage WHERE id=?").get(String(id))))}
  putUsage(item){return this.#withDb(db=>{db.prepare("INSERT INTO state_usage(id,runtime,provider,model,environment_id,thread_id,turn_id,at,payload_json) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET runtime=excluded.runtime,provider=excluded.provider,model=excluded.model,environment_id=excluded.environment_id,thread_id=excluded.thread_id,turn_id=excluded.turn_id,at=excluded.at,payload_json=excluded.payload_json").run(String(item.id),item.runtime||null,item.provider||null,item.model||null,normalizedEnvironment(item.environmentId),item.threadId||null,item.turnId||null,Number(item.at)||Date.now(),JSON.stringify(item));this.#prune(db,"state_usage","at",LIMITS.usage);return item},{write:true})}
  usage({since=0,limit=1000,environmentIds=undefined,threadId=null}={}){
    return this.#withDb(db=>{
      const where=["at >= ?"],args=[Math.max(0,Number(since)||0)];if(threadId){where.push("thread_id = ?");args.push(String(threadId))}
      if(Array.isArray(environmentIds)){const values=[...new Set(environmentIds.map(normalizedEnvironment))],nonNull=values.filter(Boolean),parts=[];if(values.includes(null))parts.push("environment_id IS NULL");if(nonNull.length){parts.push(`environment_id IN (${nonNull.map(()=>"?").join(",")})`);args.push(...nonNull)}where.push(parts.length?`(${parts.join(" OR ")})`:"0")}
      args.push(Math.max(1,Math.min(LIMITS.usage,Number(limit)||1000)));return db.prepare(`SELECT payload_json FROM state_usage WHERE ${where.join(" AND ")} ORDER BY at DESC LIMIT ?`).all(...args).map(payload).filter(Boolean);
    });
  }
  clearUsage(){return this.#withDb(db=>{const count=Number(db.prepare("SELECT COUNT(*) AS count FROM state_usage").get()?.count)||0;db.exec("DELETE FROM state_usage");return count},{write:true})}
  verificationRecord(id){return this.#withDb(db=>payload(db.prepare("SELECT payload_json FROM state_verification WHERE id=?").get(String(id))))}
  putVerification(item){return this.#withDb(db=>{db.prepare("INSERT INTO state_verification(id,environment_id,project_path,thread_id,turn_id,status,risk,created_at,updated_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET environment_id=excluded.environment_id,project_path=excluded.project_path,thread_id=excluded.thread_id,turn_id=excluded.turn_id,status=excluded.status,risk=excluded.risk,created_at=excluded.created_at,updated_at=excluded.updated_at,payload_json=excluded.payload_json").run(String(item.id),normalizedEnvironment(item.environmentId),item.projectPath||null,item.threadId||null,item.turnId||null,item.status||null,item.risk||null,Number(item.createdAt)||Date.now(),Number(item.updatedAt)||Date.now(),JSON.stringify(item));this.#prune(db,"state_verification","updated_at",LIMITS.verification);return item},{write:true})}
  verificationRecords({threadId=null,projectPath=null,hasEnvironment=false,environmentId=null,limit=100}={}){return this.#withDb(db=>{const where=[],args=[];if(threadId){where.push("thread_id=?");args.push(String(threadId))}if(projectPath){where.push("project_path=?");args.push(String(projectPath))}if(hasEnvironment){if(normalizedEnvironment(environmentId)){where.push("environment_id=?");args.push(normalizedEnvironment(environmentId))}else where.push("environment_id IS NULL")}args.push(Math.max(1,Math.min(LIMITS.verification,Number(limit)||100)));return db.prepare(`SELECT payload_json FROM state_verification ${where.length?"WHERE "+where.join(" AND "):""} ORDER BY updated_at DESC LIMIT ?`).all(...args).map(payload).filter(Boolean)})}
  knowledgeRecord(id){return this.#withDb(db=>payload(db.prepare("SELECT payload_json FROM state_knowledge WHERE id=?").get(String(id))))}
  putKnowledge(item){return this.#withDb(db=>{db.prepare("INSERT INTO state_knowledge(id,project_path,environment_id,status,category,updated_at,payload_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_path=excluded.project_path,environment_id=excluded.environment_id,status=excluded.status,category=excluded.category,updated_at=excluded.updated_at,payload_json=excluded.payload_json").run(String(item.id),String(item.projectPath),normalizedEnvironment(item.environmentId),item.status||null,item.category||null,Number(item.updatedAt)||Date.now(),JSON.stringify(item));this.#prune(db,"state_knowledge","updated_at",LIMITS.knowledge);return item},{write:true})}
  knowledge({projectPath=null,hasEnvironment=false,environmentId=null,status=null,limit=200}={}){return this.#withDb(db=>{const where=[],args=[];if(projectPath){where.push("project_path=?");args.push(String(projectPath))}if(hasEnvironment){if(normalizedEnvironment(environmentId)){where.push("environment_id=?");args.push(normalizedEnvironment(environmentId))}else where.push("environment_id IS NULL")}if(status){where.push("status=?");args.push(String(status))}args.push(Math.max(1,Math.min(LIMITS.knowledge,Number(limit)||200)));return db.prepare(`SELECT payload_json FROM state_knowledge ${where.length?"WHERE "+where.join(" AND "):""} ORDER BY updated_at DESC LIMIT ?`).all(...args).map(payload).filter(Boolean)})}
  removeKnowledge(id){return this.#withDb(db=>Number(db.prepare("DELETE FROM state_knowledge WHERE id=?").run(String(id))?.changes)||0,{write:true})>0}
}

export function sqliteStateCollectionsAvailable(){return Boolean(databaseSync())}
