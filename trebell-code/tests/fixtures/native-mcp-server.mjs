import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server=new Server({name:"trebell-native-mcp-fixture",version:"1.0.0"},{capabilities:{tools:{}}});

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

await server.connect(new StdioServerTransport());
