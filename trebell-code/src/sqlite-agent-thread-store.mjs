import { createRequire } from "node:module";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { trebellHome } from "./paths.mjs";
import { redactSecretValue } from "./secret-redactor.mjs";

const require=createRequire(import.meta.url);
function databaseSync(){try{return require("node:sqlite").DatabaseSync}catch{return null}}
function parse(value,fallback=null){try{return JSON.parse(String(value??""))}catch{return fallback}}
function turnFromRow(row){return parse(row?.payload_json,null)}
function visibleSearchText(item){
  if(item?.type==="userMessage"){
    if(typeof item.text==="string")return item.text;
    return (item.content||[]).filter(part=>part?.type==="text"&&typeof part.text==="string").map(part=>part.text).join("");
  }
  if(item?.type==="agentMessage"&&typeof item.text==="string")return item.text.replace(/\s+/g," ").trim();
  return "";
}
function searchItems(turn={}){
  const items=Array.isArray(turn.items)?turn.items:[],finalAgent=[...items].reverse().find(item=>item?.type==="agentMessage")||null,out=[];
  for(let ordinal=0;ordinal<items.length;ordinal++){
    const item=items[ordinal];if(item?.type!=="userMessage"&&item!==finalAgent)continue;
    const text=visibleSearchText(item);if(text)out.push({itemId:String(item.id||ordinal),ordinal,kind:item.type,text});
  }
  return out;
}
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
        "CREATE TABLE IF NOT EXISTS agent_threads (id TEXT PRIMARY KEY,runtime TEXT NOT NULL,provider_session_id TEXT,updated_at INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0,search_title TEXT NOT NULL DEFAULT '',payload_json TEXT NOT NULL);",
        "CREATE INDEX IF NOT EXISTS agent_threads_runtime_updated_idx ON agent_threads(runtime,updated_at DESC);",
        "CREATE INDEX IF NOT EXISTS agent_threads_provider_session_idx ON agent_threads(runtime,provider_session_id);",
        "CREATE TABLE IF NOT EXISTS agent_turns (thread_id TEXT NOT NULL,id TEXT NOT NULL,status TEXT,started_at INTEGER,completed_at INTEGER,payload_json TEXT NOT NULL,PRIMARY KEY(thread_id,id),FOREIGN KEY(thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE);",
        "CREATE INDEX IF NOT EXISTS agent_turns_thread_started_idx ON agent_turns(thread_id,started_at ASC);",
        "CREATE INDEX IF NOT EXISTS agent_turns_status_idx ON agent_turns(status,started_at DESC);",
      ].join("\n"));
      const columns=new Set(db.prepare("PRAGMA table_info(agent_threads)").all().map(row=>String(row.name)));
      if(!columns.has("search_title"))db.exec("ALTER TABLE agent_threads ADD COLUMN search_title TEXT NOT NULL DEFAULT ''");
      try{db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS agent_search_fts USING fts5(thread_id UNINDEXED,turn_id UNINDEXED,item_id UNINDEXED,ordinal UNINDEXED,kind UNINDEXED,text,tokenize='trigram')");this.searchMode="fts"}
      catch{db.exec("CREATE TABLE IF NOT EXISTS agent_search_fts(thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,item_id TEXT NOT NULL,ordinal INTEGER NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL);CREATE INDEX IF NOT EXISTS agent_search_items_thread_idx ON agent_search_fts(thread_id,turn_id,ordinal)");this.searchMode="like"}
    });
    const migration=this.#migrateLegacyOnce();this.#retireLegacy(migration);this.#ensureSearchProjection();
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
    db.prepare("INSERT INTO agent_threads(id,runtime,provider_session_id,updated_at,archived,search_title,payload_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET runtime=excluded.runtime,provider_session_id=excluded.provider_session_id,updated_at=excluded.updated_at,archived=excluded.archived,search_title=excluded.search_title,payload_json=excluded.payload_json")
      .run(String(thread.id),String(thread.runtime||"external"),String(thread.providerSessionId||""),Number(thread.updatedAt)||0,thread.archived?1:0,String(thread.name||thread.preview||""),JSON.stringify(payload));
  }
  #writeTurn(db,threadId,turn){
    db.prepare("INSERT INTO agent_turns(thread_id,id,status,started_at,completed_at,payload_json) VALUES(?,?,?,?,?,?) ON CONFLICT(thread_id,id) DO UPDATE SET status=excluded.status,started_at=excluded.started_at,completed_at=excluded.completed_at,payload_json=excluded.payload_json")
      .run(String(threadId),String(turn.id),turn.status==null?null:String(turn.status),Number(turn.startedAt)||null,Number(turn.completedAt)||null,JSON.stringify(turn));
    db.prepare("DELETE FROM agent_search_fts WHERE thread_id=? AND turn_id=?").run(String(threadId),String(turn.id));
    const insert=db.prepare("INSERT INTO agent_search_fts(thread_id,turn_id,item_id,ordinal,kind,text) VALUES(?,?,?,?,?,?)");
    for(const item of searchItems(turn))insert.run(String(threadId),String(turn.id),item.itemId,item.ordinal,item.kind,item.text);
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
  #ensureSearchProjection(){
    this.#withDb(db=>{
      if(db.prepare("SELECT value FROM agent_store_meta WHERE key='agent_search_projection_v1'").get())return;
      const threadRows=db.prepare("SELECT id,payload_json FROM agent_threads").all();
      const updateTitle=db.prepare("UPDATE agent_threads SET search_title=? WHERE id=?");
      for(const row of threadRows){const thread=parse(row.payload_json,{})||{};updateTitle.run(String(thread.name||thread.preview||""),String(row.id))}
      db.prepare("DELETE FROM agent_search_fts").run();
      const turns=db.prepare("SELECT thread_id,payload_json FROM agent_turns ORDER BY rowid ASC").all();
      const insert=db.prepare("INSERT INTO agent_search_fts(thread_id,turn_id,item_id,ordinal,kind,text) VALUES(?,?,?,?,?,?)");
      for(const row of turns){const turn=parse(row.payload_json,null);if(!turn?.id)continue;for(const item of searchItems(turn))insert.run(String(row.thread_id),String(turn.id),item.itemId,item.ordinal,item.kind,item.text)}
      db.prepare("INSERT INTO agent_store_meta(key,value) VALUES('agent_search_projection_v1',?)").run(JSON.stringify({at:Date.now(),threads:threadRows.length,turns:turns.length,mode:this.searchMode}));
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
  searchCandidates({runtime=null,term="",archived=false}={}){
    const needle=String(term||"").trim();if(!needle)return [];
    return this.#withDb(db=>{
      const matched=new Map(),like="%"+needle.replaceAll("\\","\\\\").replaceAll("%","\\%").replaceAll("_","\\_")+"%";
      let rows=[];
      if(this.searchMode==="fts"&&[...needle].length>=3){
        const query='"'+needle.replaceAll('"','""')+'"';
        try{rows=db.prepare("SELECT s.thread_id,s.turn_id,s.item_id,s.ordinal,s.kind,s.text,t.started_at FROM agent_search_fts s JOIN agent_turns t ON t.thread_id=s.thread_id AND t.id=s.turn_id WHERE agent_search_fts MATCH ? ORDER BY COALESCE(t.started_at,0) ASC,CAST(s.ordinal AS INTEGER) ASC").all(query)}catch{rows=[]}
      }
      if(!rows.length)rows=db.prepare("SELECT s.thread_id,s.turn_id,s.item_id,s.ordinal,s.kind,s.text,t.started_at FROM agent_search_fts s JOIN agent_turns t ON t.thread_id=s.thread_id AND t.id=s.turn_id WHERE s.text LIKE ? ESCAPE '\\' ORDER BY COALESCE(t.started_at,0) ASC,CAST(s.ordinal AS INTEGER) ASC").all(like);
      for(const row of rows)if(!matched.has(String(row.thread_id)))matched.set(String(row.thread_id),row);
      const threadRows=runtime?db.prepare("SELECT * FROM agent_threads WHERE runtime=? AND archived=? ORDER BY updated_at DESC").all(String(runtime),archived?1:0):db.prepare("SELECT * FROM agent_threads WHERE archived=? ORDER BY updated_at DESC").all(archived?1:0);
      const lower=needle.toLowerCase(),out=[];
      for(const row of threadRows){
        const titleMatch=String(row.search_title||"").toLowerCase().includes(lower),match=matched.get(String(row.id));if(!titleMatch&&!match)continue;
        const turns=!titleMatch&&match?[{id:String(match.turn_id),items:[match.kind==="agentMessage"?{type:"agentMessage",id:String(match.item_id),text:String(match.text||"")}:{type:"userMessage",id:String(match.item_id),content:[{type:"text",text:String(match.text||"")}]}]}]:[];
        out.push(threadFromRow(row,turns));
      }
      return out;
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
      if(replaceTurns){db.prepare("DELETE FROM agent_search_fts WHERE thread_id=?").run(String(thread.id));db.prepare("DELETE FROM agent_turns WHERE thread_id=?").run(String(thread.id));for(const turn of Array.isArray(thread.turns)?thread.turns:[])if(turn?.id)this.#writeTurn(db,thread.id,turn)}
    },{write:true});return thread;
  }
  putThreadAndTurn(thread,turn){this.#withDb(db=>{this.#writeThreadMeta(db,thread);this.#writeTurn(db,thread.id,turn)},{write:true});return turn}
  delete(id){return this.#withDb(db=>{db.prepare("DELETE FROM agent_search_fts WHERE thread_id=?").run(String(id));return Number(db.prepare("DELETE FROM agent_threads WHERE id=?").run(String(id))?.changes)||0},{write:true})>0}
}

export function sqliteAgentThreadStoreAvailable(){return Boolean(databaseSync())}
