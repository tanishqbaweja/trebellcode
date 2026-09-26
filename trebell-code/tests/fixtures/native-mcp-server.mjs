import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourceTemplatesRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server=new Server({name:"trebell-native-mcp-fixture",version:"1.0.0"},{capabilities:{tools:{},resources:{}}});

server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
  {name:"echo-read",description:"Return fixture text without side effects.",inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false},annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:false}},
  {name:"mutate-state",description:"Pretend to mutate external state.",inputSchema:{type:"object",properties:{value:{type:"string"}},required:["value"],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},
  {name:"ask-user",description:"Ask the MCP client for one form field.",inputSchema:{type:"object",properties:{prompt:{type:"string"}},additionalProperties:false},annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:false}},
]}));

server.setRequestHandler(CallToolRequestSchema,async request=>{
  const name=request.params.name,args=request.params.arguments||{};
  if(name==="echo-read")return {content:[{type:"text",text:`echo:${args.text||""}:env=${process.env.FIXTURE_VISIBLE||"missing"}:secret=${process.env.FIXTURE_SECRET||"missing"}`}]};
  if(name==="mutate-state")return {content:[{type:"text",text:`mutated:${args.value||""}`}]};
  if(name==="ask-user"){
    const response=await server.elicitInput({message:String(args.prompt||"Provide the fixture value"),requestedSchema:{type:"object",properties:{answer:{type:"string",title:"Fixture answer"}},required:["answer"]}});
    return {content:[{type:"text",text:`elicited:${response.action}:${response.content?.answer||""}`}]};
  }
  return {isError:true,content:[{type:"text",text:`unknown:${name}`}]};
});

server.setRequestHandler(ListResourcesRequestSchema,async()=>({resources:[
  {uri:"fixture://docs/guide",name:"Fixture guide",description:"Read the fixture architecture guide.",mimeType:"text/plain",size:32},
  {uri:"fixture://images/pixel",name:"Fixture pixel",description:"One tiny PNG resource.",mimeType:"image/png",size:68},
]}));

server.setRequestHandler(ListResourceTemplatesRequestSchema,async()=>({resourceTemplates:[
  {uriTemplate:"fixture://users/{name}",name:"Fixture user profile",description:"Profile data for a named fixture user.",mimeType:"text/plain"},
]}));

server.setRequestHandler(ReadResourceRequestSchema,async request=>{
  const uri=String(request.params.uri||"");
  if(uri==="fixture://docs/guide")return {contents:[{uri,mimeType:"text/plain",text:"Architecture: fixture MCP resources are untrusted external data."}]};
  if(uri==="fixture://images/pixel")return {contents:[{uri,mimeType:"image/png",blob:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="}]};
  if(uri.startsWith("fixture://users/"))return {contents:[{uri,mimeType:"text/plain",text:`profile:${uri.slice("fixture://users/".length)}`}]};
  throw new Error("resource not found");
});

await server.connect(new StdioServerTransport());
