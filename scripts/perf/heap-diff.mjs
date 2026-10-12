#!/usr/bin/env node
// What a server heap keeps: two V8 heap snapshots (run.mjs memory --heap-snapshot writes memory-start and memory-end) compared by
// constructor, and the end snapshot's largest retainers (dominator tree, weak edges left out, as DevTools computes retained size)
// with the path that holds each one.
//
//   node --max-old-space-size=8192 scripts/perf/heap-diff.mjs <start.heapsnapshot> <end.heapsnapshot> [--top 30] [--out <file.json>]
import { readFileSync, writeFileSync } from "node:fs";

const argv=process.argv.slice(2),flag=(name,fallback)=>{const index=argv.indexOf("--"+name);return index>=0?argv[index+1]:fallback};
const [startFile,endFile]=argv.filter((value,index)=>!value.startsWith("--")&&!argv[index-1]?.startsWith("--"));
const top=Number(flag("top",30))||30,outFile=flag("out",null);
const mb=bytes=>Number((bytes/1048576).toFixed(2));

function load(file){
  const raw=JSON.parse(readFileSync(file,"utf8")),meta=raw.snapshot.meta,nodeFields=meta.node_fields.length,edgeFields=meta.edge_fields.length;
  const field=name=>meta.node_fields.indexOf(name),edgeField=name=>meta.edge_fields.indexOf(name);
  const nodes=raw.nodes,edges=raw.edges,strings=raw.strings,count=nodes.length/nodeFields;
  const typeAt=field("type"),nameAt=field("name"),sizeAt=field("self_size"),edgeCountAt=field("edge_count"),idAt=field("id");
  const edgeTypeAt=edgeField("type"),edgeNameAt=edgeField("name_or_index"),toAt=edgeField("to_node");
  const nodeTypes=meta.node_types[0],edgeTypes=meta.edge_types[0],weak=edgeTypes.indexOf("weak"),element=edgeTypes.indexOf("element"),hidden=edgeTypes.indexOf("hidden");
  const firstEdge=new Uint32Array(count+1);for(let n=0,e=0;n<count;n++){firstEdge[n]=e;e+=nodes[n*nodeFields+edgeCountAt]*edgeFields}firstEdge[count]=edges.length;
  const type=n=>nodeTypes[nodes[n*nodeFields+typeAt]],name=n=>strings[nodes[n*nodeFields+nameAt]],size=n=>nodes[n*nodeFields+sizeAt],id=n=>nodes[n*nodeFields+idAt];
  const edgeName=e=>{const kind=edges[e+edgeTypeAt],value=edges[e+edgeNameAt];return kind===element||kind===hidden?"["+value+"]":String(strings[value])};
  return {count,nodes,edges,strings,nodeFields,edgeFields,firstEdge,type,name,size,id,edgeName,isWeak:e=>edges[e+edgeTypeAt]===weak,to:e=>edges[e+toAt]/nodeFields};
}
// A constructor's label: objects by their name, strings and code by their type.
const label=(heap,n)=>{const type=heap.type(n);return type==="object"||type==="closure"||type==="native"||type==="synthetic"||type==="hidden"?type+":"+heap.name(n):type};
function byLabel(heap){
  const rows=new Map();
  for(let n=0;n<heap.count;n++){const key=label(heap,n),row=rows.get(key)||{count:0,bytes:0};row.count++;row.bytes+=heap.size(n);rows.set(key,row)}
  return rows;
}
// Cooper, Harvey and Kennedy's iterative dominators over the strong edges, from the snapshot's root (node 0).
function dominators(heap){
  const {count,firstEdge,edgeFields}=heap,order=new Int32Array(count).fill(-1),post=new Uint32Array(count);let postCount=0;
  const stack=new Uint32Array(count),cursor=new Uint32Array(count),seen=new Uint8Array(count);let depth=0;
  stack[depth++]=0;seen[0]=1;cursor[0]=firstEdge[0];
  while(depth){
    const n=stack[depth-1];let pushed=false;
    while(cursor[n]<firstEdge[n+1]){const e=cursor[n];cursor[n]+=edgeFields;if(heap.isWeak(e))continue;const to=heap.to(e);if(seen[to])continue;seen[to]=1;cursor[to]=firstEdge[to];stack[depth++]=to;pushed=true;break}
    if(!pushed){depth--;order[n]=postCount;post[postCount++]=n}
  }
  // Predecessors of each reachable node, over strong edges.
  const predCount=new Uint32Array(count+1);
  for(let n=0;n<count;n++){if(order[n]<0)continue;for(let e=firstEdge[n];e<firstEdge[n+1];e+=edgeFields){if(heap.isWeak(e))continue;const to=heap.to(e);if(order[to]>=0)predCount[to+1]++}}
  for(let n=0;n<count;n++)predCount[n+1]+=predCount[n];
  const preds=new Uint32Array(predCount[count]),fill=predCount.slice(0,count);
  for(let n=0;n<count;n++){if(order[n]<0)continue;for(let e=firstEdge[n];e<firstEdge[n+1];e+=edgeFields){if(heap.isWeak(e))continue;const to=heap.to(e);if(order[to]>=0)preds[fill[to]++]=n}}
  const idom=new Int32Array(count).fill(-1);idom[0]=0;
  const intersect=(a,b)=>{while(a!==b){while(order[a]<order[b])a=idom[a];while(order[b]<order[a])b=idom[b]}return a};
  for(let changed=true;changed;){
    changed=false;
    for(let i=postCount-2;i>=0;i--){
      const n=post[i];let next=-1;
      for(let p=predCount[n];p<predCount[n+1];p++){const pred=preds[p];if(idom[pred]<0)continue;next=next<0?pred:intersect(pred,next)}
      if(next>=0&&idom[n]!==next){idom[n]=next;changed=true}
    }
  }
  const retained=new Float64Array(count);for(let i=0;i<postCount;i++){const n=post[i];retained[n]+=heap.size(n);if(n!==0)retained[idom[n]]+=retained[n]}
  return {idom,retained,reachable:postCount};
}
// The edge from n's dominator (or the nearest holder on the way to it) that names n.
function holderEdge(heap,from,n){for(let e=heap.firstEdge[from];e<heap.firstEdge[from+1];e+=heap.edgeFields)if(!heap.isWeak(e)&&heap.to(e)===n)return heap.edgeName(e);return "?"}

const start=load(startFile),startRows=byLabel(start),startTotal=[...startRows.values()].reduce((sum,row)=>sum+row.bytes,0);
const end=load(endFile),endRows=byLabel(end),endTotal=[...endRows.values()].reduce((sum,row)=>sum+row.bytes,0);
const growth=[...new Set([...startRows.keys(),...endRows.keys()])].map(key=>{const a=startRows.get(key)||{count:0,bytes:0},b=endRows.get(key)||{count:0,bytes:0};return {label:key,countDelta:b.count-a.count,mbDelta:mb(b.bytes-a.bytes),endMB:mb(b.bytes)}}).sort((x,y)=>y.mbDelta-x.mbDelta);
const {idom,retained}=dominators(end);
const candidates=[];for(let n=1;n<end.count;n++)if(idom[n]>=0&&end.type(n)!=="synthetic")candidates.push(n);
candidates.sort((a,b)=>retained[b]-retained[a]);
// Each step up the dominator tree, with the edge that names the object below it.
const path=n=>{const steps=[];for(let at=n,i=0;at!==0&&i<8;i++){const up=idom[at];steps.push(label(end,up)+" ."+holderEdge(end,up,at));at=up}return steps};
const row=n=>({label:label(end,n),retainedMB:mb(retained[n]),selfKB:Number((end.size(n)/1024).toFixed(1)),heldBy:path(n)});
const holders=candidates.slice(0,top).map(row);
// The suspects by the name that holds them: the store's parsed-thread cache, the journal's recent events, the relay's maps.
const SUSPECTS=/^(#cache|recent|codexThreadModels|liveToolOutput|toolWrites|sessions|socketContexts|threadTelemetry|journal|events)$/;
const suspects={};
for(let n=0;n<end.count;n++){if(idom[n]<0)continue;for(let e=end.firstEdge[n];e<end.firstEdge[n+1];e+=end.edgeFields){if(end.isWeak(e))continue;const name=end.edgeName(e);if(!SUSPECTS.test(name))continue;const to=end.to(e);(suspects[name]||=[]).push({from:label(end,n),to:label(end,to),retainedMB:mb(retained[to])})}}
for(const name of Object.keys(suspects))suspects[name]=suspects[name].sort((a,b)=>b.retainedMB-a.retainedMB).slice(0,5);
const report={start:{file:startFile,nodes:start.count,selfMB:mb(startTotal)},end:{file:endFile,nodes:end.count,selfMB:mb(endTotal),rootRetainedMB:mb(retained[0])},
  growth:growth.slice(0,top),shrink:growth.slice(-10).reverse(),largestRetainers:holders,suspects};
if(outFile)writeFileSync(outFile,JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
