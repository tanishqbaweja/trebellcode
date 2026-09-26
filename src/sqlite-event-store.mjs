import { createRequire } from "node:module";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { trebellHome } from "./paths.mjs";

const require=createRequire(import.meta.url);

function databaseSync(){
  try{return require("node:sqlite").DatabaseSync}catch{return null}
}
function rowRecord(row){
  if(!row)return null;
  let data={};try{data=JSON.parse(row.data_json||"{}")}catch{}
  return {
    id:row.id,at:Number(row.at)||0,runtime:row.runtime||null,provider:row.provider||null,
    environmentId:row.environment_id||null,threadId:row.thread_id||null,turnId:row.turn_id||null,
    category:row.category,name:row.name,status:row.status||null,data,
  };
}

export class SqliteEventStore{
  constructor(env=process.env,{maxRecords=5000,maxBytes=8*1024*1024}={}){
    const DatabaseSync=databaseSync();if(!DatabaseSync)throw new Error("node:sqlite is unavailable");
    this.maxRecords=Math.max(100,Math.trunc(Number(maxRecords)||5000));
    this.maxBytes=Math.max(256*1024,Math.trunc(Number(maxBytes)||8*1024*1024));
    this.path=join(trebellHome(env),"trebell.sqlite");mkdirSync(dirname(this.path),{recursive:true});
    this.db=new DatabaseSync(this.path);
    this.db.exec("PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        at INTEGER NOT NULL,
        runtime TEXT,
        provider TEXT,
        environment_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT,
        data_json TEXT NOT NULL,
        byte_size INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_at_idx ON events(at DESC, seq DESC);
      CREATE INDEX IF NOT EXISTS events_thread_at_idx ON events(thread_id, at DESC, seq DESC);
      CREATE INDEX IF NOT EXISTS events_turn_at_idx ON events(turn_id, at DESC, seq DESC);
      CREATE INDEX IF NOT EXISTS events_runtime_category_at_idx ON events(runtime, category, at DESC, seq DESC);
    `);
    this.insertStatement=this.db.prepare(`
      INSERT INTO events(id,at,runtime,provider,environment_id,thread_id,turn_id,category,name,status,data_json,byte_size)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        at=excluded.at,runtime=excluded.runtime,provider=excluded.provider,environment_id=excluded.environment_id,
        thread_id=excluded.thread_id,turn_id=excluded.turn_id,category=excluded.category,name=excluded.name,
        status=excluded.status,data_json=excluded.data_json,byte_size=excluded.byte_size
    `);
    this.countStatement=this.db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(byte_size),0) AS bytes FROM events");
  }
  insert(record){
    const dataJson=JSON.stringify(record.data??{}),byteSize=Buffer.byteLength(JSON.stringify(record))+1;
    this.insertStatement.run(
      record.id,record.at,record.runtime,record.provider,record.environmentId,record.threadId,record.turnId,
      record.category,record.name,record.status,dataJson,byteSize,
    );
    this.#prune();
  }
  import(records=[]){
    if(!Array.isArray(records)||!records.length)return;
    this.db.exec("BEGIN IMMEDIATE");
    try{for(const record of records)this.insert(record);this.db.exec("COMMIT")}
    catch(error){try{this.db.exec("ROLLBACK")}catch{}throw error}
  }
  list({threadId=null,turnId=null,runtime=null,category=null,limit=200,before=null,after=null}={}){
    const max=Math.max(1,Math.min(1000,Math.trunc(Number(limit)||200))),where=[],args=[];
    const beforeValue=before==null?null:Number(before),afterValue=after==null?null:Number(after);
    if(Number.isFinite(beforeValue)){where.push("at < ?");args.push(beforeValue)}
    if(Number.isFinite(afterValue)){where.push("at >= ?");args.push(afterValue)}
    if(threadId){where.push("thread_id = ?");args.push(String(threadId))}
    if(turnId){where.push("turn_id = ?");args.push(String(turnId))}
    if(runtime){where.push("runtime = ?");args.push(String(runtime))}
    if(category){where.push("category = ?");args.push(String(category))}
    const sql=`SELECT id,at,runtime,provider,environment_id,thread_id,turn_id,category,name,status,data_json FROM events ${where.length?"WHERE "+where.join(" AND "):""} ORDER BY at DESC, seq DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args,max).map(rowRecord);
  }
  recent(limit=this.maxRecords){
    const max=Math.max(1,Math.min(this.maxRecords,Math.trunc(Number(limit)||this.maxRecords)));
    return this.db.prepare("SELECT id,at,runtime,provider,environment_id,thread_id,turn_id,category,name,status,data_json FROM events ORDER BY at DESC, seq DESC LIMIT ?").all(max).map(rowRecord).reverse();
  }
  stats(){
    const row=this.countStatement.get()||{},walPath=this.path+"-wal";
    return {records:Number(row.count)||0,logicalBytes:Number(row.bytes)||0,fileBytes:(existsSync(this.path)?statSync(this.path).size:0)+(existsSync(walPath)?statSync(walPath).size:0)};
  }
  close(){this.db.close()}
  #prune(){
    const stats=this.countStatement.get()||{};let count=Number(stats.count)||0,bytes=Number(stats.bytes)||0;
    if(count>this.maxRecords){
      const excess=count-this.maxRecords;
      this.db.prepare("DELETE FROM events WHERE seq IN (SELECT seq FROM events ORDER BY at ASC, seq ASC LIMIT ?)").run(excess);
      const next=this.countStatement.get()||{};count=Number(next.count)||0;bytes=Number(next.bytes)||0;
    }
    while(bytes>this.maxBytes&&count>1){
      const remove=Math.max(1,Math.min(100,Math.ceil(count*0.05)));
      this.db.prepare("DELETE FROM events WHERE seq IN (SELECT seq FROM events ORDER BY at ASC, seq ASC LIMIT ?)").run(remove);
      const next=this.countStatement.get()||{};count=Number(next.count)||0;bytes=Number(next.bytes)||0;
    }
    try{this.db.exec("PRAGMA incremental_vacuum(100);")}catch{}
  }
}

export function sqliteEventStoreAvailable(){return Boolean(databaseSync())}
