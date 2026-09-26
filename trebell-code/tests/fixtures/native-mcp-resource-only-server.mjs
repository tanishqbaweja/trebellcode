import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server=new Server({name:"trebell-native-resource-only-fixture",version:"1.0.0"},{capabilities:{resources:{}}});
server.setRequestHandler(ListResourcesRequestSchema,async()=>({resources:[{uri:"fixture-only://status",name:"Resource-only status",description:"Status exposed by an MCP server with no tools.",mimeType:"text/plain"}]}));
server.setRequestHandler(ReadResourceRequestSchema,async request=>({contents:[{uri:String(request.params.uri),mimeType:"text/plain",text:"resource-only-ok"}]}));
await server.connect(new StdioServerTransport());
