import { resolve } from "node:path";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema,ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ContextEngine } from "./context-engine.mjs";
import { RepositoryKnowledgeService } from "./repository-knowledge-service.mjs";
import { REPOSITORY_TOOL_DEFINITIONS,REPOSITORY_TOOL_INSTRUCTIONS,invokeRepositoryTool,parseRepositoryToolArguments,repositoryToolHandlers } from "./repository-tool-catalog.mjs";
import { TrebellStateStore } from "./trebell-state.mjs";

const root=resolve(String(process.env.TREBELL_REPOSITORY_ROOT||process.cwd()));
const state=new TrebellStateStore(process.env),contextEngine=new ContextEngine(),knowledgeService=new RepositoryKnowledgeService({state});
const handlers=repositoryToolHandlers({contextEngine,root,knowledgeService,environmentId:null});
const byName=new Map(REPOSITORY_TOOL_DEFINITIONS.map(definition=>[definition.name,definition]));
const server=new Server({name:"trebell_repository",version:"1.0.0"},{capabilities:{tools:{}}});

function inputSchema(definition){const schema=z.toJSONSchema(z.object(definition.inputSchema));delete schema.$schema;return schema}
function bounded(value,max=256*1024){const text=String(value??"");return text.length>max?text.slice(0,max)+"\n[truncated]":text}

server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:REPOSITORY_TOOL_DEFINITIONS.map(definition=>({
  name:definition.name,description:definition.description,inputSchema:inputSchema(definition),annotations:definition.annotations,
}))}));

server.setRequestHandler(CallToolRequestSchema,async request=>{
  const definition=byName.get(String(request.params.name||""));if(!definition)return {isError:true,content:[{type:"text",text:"Unknown Trebell repository tool."}]};
  try{
    const args=parseRepositoryToolArguments(definition,request.params.arguments||{}),result=await invokeRepositoryTool(handlers,definition,args);
    return {content:[{type:"text",text:bounded(JSON.stringify(result))}]};
  }catch(error){return {isError:true,content:[{type:"text",text:bounded(error?.message||String(error),4000)}]}}
});

server.instructions=REPOSITORY_TOOL_INSTRUCTIONS;
await server.connect(new StdioServerTransport());
