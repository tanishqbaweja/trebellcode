import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const port=Number(process.env.MCP_HTTP_PORT||0),expected=String(process.env.EXPECTED_BEARER||"");
if(!port)throw new Error("MCP_HTTP_PORT is required");

function mcpServer(){
  const server=new Server({name:"trebell-native-http-fixture",version:"1.0.0"},{capabilities:{tools:{},resources:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:"http-echo",description:"Echo through authenticated Streamable HTTP MCP.",inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"]},annotations:{readOnlyHint:true,idempotentHint:true}}]}));
  server.setRequestHandler(CallToolRequestSchema,async request=>({content:[{type:"text",text:`http:${request.params.arguments?.text||""}`}]}));
  server.setRequestHandler(ListResourcesRequestSchema,async()=>({resources:[{uri:"http-fixture://guide",name:"HTTP fixture guide",mimeType:"text/plain"}]}));
  server.setRequestHandler(ReadResourceRequestSchema,async request=>({contents:[{uri:String(request.params.uri),mimeType:"text/plain",text:"authenticated-http-resource"}]}));
  return server;
}

async function body(req){let text="";for await(const chunk of req){text+=chunk;if(text.length>2*1024*1024)throw new Error("body too large")}return text?JSON.parse(text):undefined}

const http=createServer(async(req,res)=>{
  if(req.url!=="/mcp"){res.writeHead(404).end();return}
  if(expected&&req.headers.authorization!==`Bearer ${expected}`){res.writeHead(401,{"content-type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",error:{code:-32001,message:"unauthorized"},id:null}));return}
  if(req.method!=="POST"){res.writeHead(405,{"content-type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",error:{code:-32000,message:"method not allowed"},id:null}));return}
  const server=mcpServer(),transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
  try{await server.connect(transport);await transport.handleRequest(req,res,await body(req))}
  catch(error){if(!res.headersSent)res.writeHead(500,{"content-type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",error:{code:-32603,message:error?.message||String(error)},id:null}))}
  finally{try{await transport.close()}catch{}try{await server.close()}catch{}}
});

http.listen(port,"127.0.0.1",()=>process.stdout.write("READY\n"));
for(const signal of ["SIGTERM","SIGINT"])process.on(signal,()=>{try{http.close()}catch{}process.exit(0)});
