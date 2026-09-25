import {
  normalizeRepositoryKnowledge,
  repositoryKnowledgeContext,
  refreshRepositoryKnowledgeEntry,
  selectRepositoryKnowledge,
  verifyRepositoryKnowledgeEntry,
} from "./repository-knowledge.mjs";

export class RepositoryKnowledgeService{
  constructor({state,ioFactory=null}={}){
    if(!state)throw new Error("RepositoryKnowledgeService requires Trebell state.");
    this.state=state;this.ioFactory=ioFactory;
  }
  async #io(projectPath,environmentId){
    return this.ioFactory?await this.ioFactory({projectPath,environmentId}):null;
  }
  async remember(entry={}){
    const normalized=normalizeRepositoryKnowledge({...entry,status:"unverified"});
    const io=await this.#io(normalized.projectPath,normalized.environmentId);
    const verified=normalized.evidence.length
      ?await verifyRepositoryKnowledgeEntry(normalized,{root:normalized.projectPath,io})
      :normalized;
    return this.state.upsertRepositoryKnowledge(verified);
  }
  list(options={}){
    const all=this.state.repositoryKnowledge(options);
    return selectRepositoryKnowledge(all,{query:options.query||"",limit:options.limit||200,includeUnverified:options.includeUnverified!==false});
  }
  async refresh({projectPath,environmentId=null,ids=null,limit=500}={}){
    if(!projectPath)throw new Error("projectPath is required.");
    const selected=new Set(Array.isArray(ids)?ids.map(String):[]);
    const items=this.state.repositoryKnowledge({projectPath,environmentId,limit}).filter(item=>!selected.size||selected.has(String(item.id)));
    const io=await this.#io(projectPath,environmentId),updated=[];
    for(const item of items){
      if(!item.evidence?.length){updated.push(item);continue}
      const next=await refreshRepositoryKnowledgeEntry(item,{root:projectPath,io});
      const changed=next.status!==item.status||next.staleReason!==item.staleReason||next.lastVerifiedRevision!==item.lastVerifiedRevision;
      updated.push(changed?this.state.upsertRepositoryKnowledge(next):item);
    }
    return updated;
  }
  forget(id){return this.state.removeRepositoryKnowledge(id)}
  async context({projectPath,environmentId=null,query="",limit=20,refresh=true}={}){
    if(refresh){
      const pool=this.state.repositoryKnowledge({projectPath,environmentId,limit:Math.max(100,Math.min(1000,Number(limit||20)*10))});
      const candidates=selectRepositoryKnowledge(pool,{query,limit:Math.max(20,Math.min(100,Number(limit||20)*2)),includeUnverified:true,includeStale:true});
      const ids=candidates.filter(item=>item.evidence?.length).map(item=>item.id).filter(Boolean);
      if(ids.length)await this.refresh({projectPath,environmentId,ids,limit:ids.length});
    }
    const entries=this.list({projectPath,environmentId,query,limit});
    return {entries,context:repositoryKnowledgeContext(entries,{limit})};
  }
}
