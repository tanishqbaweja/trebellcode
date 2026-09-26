import { createRequire } from "node:module";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { trebellHome } from "./paths.mjs";
import { redactSecretValue } from "./secret-redactor.mjs";

const require=createRequire(import.meta.url);
function databaseSync(){try{return require("node:sqlite").DatabaseSync}catch{return null}}
function parse(value,fallback=null){try{return JSON.parse(String(value??""))}catch{return fallback}}
function turnFromRow(row){return parse(row?.payload_json,null)}
function threadFromRow(row,turns=[]){
  if(!row)return null;
  const payload=parse(row.payload_json,{})||{};
  return {...payload,id:row.id,runtime:row.runtime||payload.runtime||"external",providerSessionId:row.provider_session_id??payload.providerSessionId??"",updatedAt:Number(row.updated_at)||Number(payload.updatedAt)||0,archived:Boolean(row.archived),turns};
}

export class SqliteAgentThreadStore{
  constructor(env=process.env){
    const DatabaseSync=databaseSync();if(!DatabaseSync)throw new Error("node:sqlite is unavailable");
    this.DatabaseSync=DatabaseSync;this.env=env;this.path=join(trebellHome(env),"trebell.sqlite");this.legacyPath=join(trebellHome(env),"agent-threads.json");
    mkdirSync(dirname(this.path),{recursive:true});
    this.#withDb(db=>{
      db.exec("PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
      db.exec([
        "CREATE TABLE IF NOT EXISTS agent_store_meta (key TEXT PRIMARY KEY,value TEXT);",
        "CREATE TABLE IF NOT EXISTS agent_threads (id TEXT PRIMARY KEY,runtime TEXT NOT NULL,provider_session_id TEXT,updated_at INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0,payload_json TEXT NOT NULL);",
        "CREATE INDEX IF NOT EXISTS agent_threads_runtime_updated_idx ON agent_threads(runtime,updated_at DESC);",
        "CREATE INDEX IF NOT EXISTS agent_threads_provider_session_idx ON agent_threads(runtime,provider_session_id);",
        "CREATE TABLE IF NOT EXISTS agent_turns (thread_id TEXT NOT NULL,id TEXT NOT NULL,status TEXT,started_at INTEGER,completed_at INTEGER,payload_json TEXT NOT NULL,PRIMARY KEY(thread_id,id),FOREIGN KEY(thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE);",
        "CREATE INDEX IF NOT EXISTS agent_turns_thread_started_idx ON agent_turns(thread_id,started_at ASC);",
        "CREATE INDEX IF NOT EXISTS agent_turns_status_idx ON agent_turns(status,started_at DESC);",
      ].join("\n"));
    });
    const migration=this.#migrateLegacyOnce();this.#retireLegacy(migration);
  }
  #withDb(fn,{write=false}={}){
    const db=new this.DatabaseSync(this.path);db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    if(write)db.exec("BEGIN IMMEDIATE");
    try{const value=fn(db);if(write)db.exec("COMMIT");return value}
    catch(error){if(write)try{db.exec("ROLLBACK")}catch{}throw error}
    finally{db.close()}
  }
  #writeThreadMeta(db,thread){
    const payload={...thread};delete payload.turns;
    db.prepare("INSERT INTO agent_threads(id,runtime,provider_session_id,updated_at,archived,payload_json) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET runtime=excluded.runtime,provider_session_id=excluded.provider_session_id,updated_at=excluded.updated_at,archived=excluded.archived,payload_json=excluded.payload_json")
      .run(String(thread.id),String(thread.runtime||"external"),String(thread.providerSessionId||""),Number(thread.updatedAt)||0,thread.archived?1:0,JSON.stringify(payload));
  }
  #writeTurn(db,threadId,turn){
    db.prepare("INSERT INTO agent_turns(thread_id,id,status,started_at,completed_at,payload_json) VALUES(?,?,?,?,?,?) ON CONFLICT(thread_id,id) DO UPDATE SET status=excluded.status,started_at=excluded.started_at,completed_at=excluded.completed_at,payload_json=excluded.payload_json")
      .run(String(threadId),String(turn.id),turn.status==null?null:String(turn.status),Number(turn.startedAt)||null,Number(turn.completedAt)||null,JSON.stringify(turn));
  }
  #migrateLegacyOnce(){
    return this.#withDb(db=>{
      const existing=db.prepare("SELECT value FROM agent_store_meta WHERE key='legacy_agent_threads_imported'").get();
      if(existing)return parse(existing.value,{at:Date.now(),count:0});
      let threads=[];try{const parsed=JSON.parse(readFileSync(this.legacyPath,"utf8"));threads=Array.isArray(parsed?.threads)?parsed.threads:[]}catch{}
      for(const rawThread of threads){
        const thread=redactSecretValue(rawThread,{environment:this.env,maxDepth:20,maxArray:10000,maxFields:5000});
        if(!thread?.id)continue;this.#writeThreadMeta(db,thread);
        for(const turn of Array.isArray(thread.turns)?thread.turns:[])if(turn?.id)this.#writeTurn(db,thread.id,turn);
      }
      const result={at:Date.now(),count:threads.length};db.prepare("INSERT INTO agent_store_meta(key,value) VALUES('legacy_agent_threads_imported',?)").run(JSON.stringify(result));return result;
    },{write:true});
  }
  #retireLegacy(migration={}){
    let parsed;try{parsed=JSON.parse(readFileSync(this.legacyPath,"utf8"))}catch{return}
    if(!Array.isArray(parsed?.threads))return;
    const tmp=this.legacyPath+".tmp";
    try{writeFileSync(tmp,JSON.stringify({version:2,migratedTo:"trebell.sqlite",migratedAt:Number(migration.at)||Date.now(),importedThreads:Number(migration.count)||0},null,2),{encoding:"utf8",mode:0o600});renameSync(tmp,this.legacyPath)}catch{}
  }
  #turnsForDb(db,threadId){
    return db.prepare("SELECT payload_json FROM agent_turns WHERE thread_id=? ORDER BY COALESCE(started_at,0) ASC,rowid ASC").all(String(threadId)).map(turnFromRow).filter(Boolean);
  }
  list(runtime=null){
    return this.#withDb(db=>{
      const rows=runtime?db.prepare("SELECT * FROM agent_threads WHERE runtime=? ORDER BY updated_at DESC").all(String(runtime)):db.prepare("SELECT * FROM agent_threads ORDER BY updated_at DESC").all();
      return rows.map(row=>threadFromRow(row,this.#turnsForDb(db,row.id)));
    });
  }
  get(id){return this.#withDb(db=>{const row=db.prepare("SELECT * FROM agent_threads WHERE id=?").get(String(id));return row?threadFromRow(row,this.#turnsForDb(db,row.id)):null})}
  findProviderSession(runtime,providerSessionId){
    return this.#withDb(db=>{
      const row=db.prepare("SELECT * FROM agent_threads WHERE runtime=? AND provider_session_id=? ORDER BY updated_at DESC LIMIT 1").get(String(runtime),String(providerSessionId));
      return row?threadFromRow(row,this.#turnsForDb(db,row.id)):null;
    });
  }
  putThread(thread,{replaceTurns=false}={}){
    this.#withDb(db=>{
      this.#writeThreadMeta(db,thread);
      if(replaceTurns){db.prepare("DELETE FROM agent_turns WHERE thread_id=?").run(String(thread.id));for(const turn of Array.isArray(thread.turns)?thread.turns:[])if(turn?.id)this.#writeTurn(db,thread.id,turn)}
    },{write:true});return thread;
  }
  putThreadAndTurn(thread,turn){this.#withDb(db=>{this.#writeThreadMeta(db,thread);this.#writeTurn(db,thread.id,turn)},{write:true});return turn}
  delete(id){return this.#withDb(db=>Number(db.prepare("DELETE FROM agent_threads WHERE id=?").run(String(id))?.changes)||0,{write:true})>0}
}

export function sqliteAgentThreadStoreAvailable(){return Boolean(databaseSync())}
