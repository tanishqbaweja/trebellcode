import assert from "node:assert/strict";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { providerTurnToChat } from "../src/provider-turn.mjs";

const options={repository:true,progressiveRepository:true,workspaceTools:true,terminal:true,browser:false,computer:false,sourceControl:false,delegation:false};
const base=platformDynamicToolNamespaces(options),full=platformDynamicToolNamespaces({...options,output:true});
const terminal=platformDynamicToolNamespaces({repository:false,workspaceTools:false,terminal:true,browser:false,computer:false,sourceControl:false,delegation:false});
const functions=tools=>tools.flatMap(namespace=>(namespace.tools||[]).map(tool=>namespace.name+"/"+tool.name));
const expectedBase=["trebell_repo/search_symbols","trebell_repo/search_files","trebell_repo/search_code","trebell_repo/read_source","trebell_repo/discover","trebell_repo/invoke","trebell_workspace/list","trebell_workspace/read_file","trebell_workspace/write_file","trebell_workspace/replace_text","trebell_terminal/run"];
assert.deepEqual(functions(base),expectedBase);assert.deepEqual(functions(full),[...expectedBase.slice(0,6),"trebell_output/inspect",...expectedBase.slice(6)]);assert.deepEqual(functions(terminal),["trebell_terminal/run"]);
const messages=[{role:"system",content:"system"},{role:"user",content:"Diagnose and fix the repository issue."}],metrics=nativeRequestMetrics(messages,base);
const wireChars=tools=>JSON.stringify(providerTurnToChat({model:"deepseek-v4.1",messages,tools,toolChoice:"auto",parallelToolCalls:true}).tools||[]).length;
const current={
  baseSchemaChars:JSON.stringify(base).length,fullSchemaChars:JSON.stringify(full).length,terminalSchemaChars:JSON.stringify(terminal).length,
  baseWireSchemaChars:wireChars(base),fullWireSchemaChars:wireChars(full),terminalWireSchemaChars:wireChars(terminal),
  baseEstimatedTokens:Number(metrics.totalLogical?.estimatedTokens||0),
};
const baseline={baseSchemaChars:4702,fullSchemaChars:5463,terminalSchemaChars:747,baseWireSchemaChars:4532,fullWireSchemaChars:5188,terminalWireSchemaChars:626,baseEstimatedTokens:1202};
for(const key of ["baseSchemaChars","fullSchemaChars","terminalSchemaChars","baseWireSchemaChars","fullWireSchemaChars","terminalWireSchemaChars","baseEstimatedTokens"])assert.ok(current[key]<baseline[key],key);
console.log(JSON.stringify({ok:true,benchmark:"native-tool-schema-zero-latency",baseline,current,savings:Object.fromEntries(Object.keys(baseline).map(key=>[key,baseline[key]-current[key]]))},null,2));
