import assert from "node:assert/strict";
import { ContextEngine } from "../src/context-engine.mjs";
import { repositoryContextDeliveryPacket, repositoryContextEntries } from "../src/context-provenance.mjs";

const root=process.cwd(),engine=new ContextEngine();
const packet=await engine.buildPacket({
  root,
  task:"Optimize Native context transport and persistence",
  focusPaths:["ui/src/App.jsx","src/gui-server.mjs"],
});
const projected=repositoryContextDeliveryPacket(packet,{seedOnly:true});
const beforeEntries=repositoryContextEntries(packet,{seedOnly:true}),afterEntries=repositoryContextEntries(projected,{seedOnly:true});
assert.deepEqual(afterEntries,beforeEntries);
const fullResponseBytes=Buffer.byteLength(JSON.stringify(packet)),nativeSeedResponseBytes=Buffer.byteLength(JSON.stringify(projected));
console.log(JSON.stringify({
  fullResponseBytes,
  nativeSeedResponseBytes,
  reductionPercent:Number(((fullResponseBytes-nativeSeedResponseBytes)/fullResponseBytes*100).toFixed(2)),
  selectedItems:packet.items.length,
  fullTokenEstimate:packet.tokenEstimate,
  nativeDeliveredTokenEstimate:projected.tokenEstimate,
  modelEntriesPreserved:true,
},null,2));
