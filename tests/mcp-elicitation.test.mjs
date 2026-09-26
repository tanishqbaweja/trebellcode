import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMcpApprovalResponse,
  buildElicitationResponse,
  buildUserVerificationResponse,
  coerceElicitationFormContent,
  elicitationApprovalDetails,
  elicitationFormFields,
  elicitationSupportsPersist,
  isMcpToolApproval,
  isAcpElicitation,
  mcpElicitationKind,
  userVerificationAvailability,
} from "../ui/src/mcp-elicitation.js";

function approvalRequest(){
  return {method:"mcpServer/elicitation/request",params:{
    mode:"form",serverName:"codex_apps",message:"Allow Calendar to create an event?",
    _meta:{
      codex_request_type:"approval_request",
      codex_approval_kind:"mcp_tool_call",
      persist:["session","always"],
      connector_id:"calendar",connector_name:"Calendar",connector_description:"Manage events and schedules.",
      tool_name:"create_event",tool_title:"Create Event",tool_description:"Create a calendar event.",
      tool_params:{calendar_id:"primary",title:"Roadmap review"},
      tool_params_display:[
        {name:"calendar_id",value:"primary",display_name:"Calendar"},
        {name:"title",value:"Roadmap review",display_name:"Title"},
      ],
    },
    requestedSchema:{type:"object",properties:{}},
  }};
}

test("Codex MCP app approvals preserve connector metadata and persistence choices",()=>{
  const request=approvalRequest();
  assert.equal(isMcpToolApproval(request),true);
  assert.equal(mcpElicitationKind(request),"approval");
  assert.equal(elicitationSupportsPersist(request,"session"),true);
  assert.equal(elicitationSupportsPersist(request,"always"),true);
  assert.deepEqual(elicitationApprovalDetails(request),{
    connectorName:"Calendar",
    connectorId:"calendar",
    connectorDescription:"Manage events and schedules.",
    toolTitle:"Create Event",
    toolName:"create_event",
    toolDescription:"Create a calendar event.",
    message:"Allow Calendar to create an event?",
    displayParams:[
      {name:"calendar_id",label:"Calendar",value:"primary"},
      {name:"title",label:"Title",value:"Roadmap review"},
    ],
  });
  assert.deepEqual(buildMcpApprovalResponse("once"),{action:"accept",content:null,_meta:null});
  assert.deepEqual(buildMcpApprovalResponse("session"),{action:"accept",content:null,_meta:{persist:"session"}});
  assert.deepEqual(buildMcpApprovalResponse("always"),{action:"accept",content:null,_meta:{persist:"always"}});
  assert.deepEqual(buildMcpApprovalResponse("decline"),{action:"decline",content:null,_meta:null});
  assert.deepEqual(buildMcpApprovalResponse("cancel"),{action:"cancel",content:null,_meta:null});
});

test("user verification responses require a signed native proof",()=>{
  assert.deepEqual(buildUserVerificationResponse({credentialId:"cred-1",signature:"sig-1"}),{
    action:"accept",content:{credentialId:"cred-1",signature:"sig-1"},_meta:null,
  });
  assert.throws(()=>buildUserVerificationResponse({credentialId:"cred-1"}),/valid verification proof/);
});

test("device-backed user verification is exposed only where the Codex proof protocol is real",()=>{
  assert.deepEqual(userVerificationAvailability({runtime:"codex",remote:false}),{available:true,reason:""});
  assert.match(userVerificationAvailability({runtime:"native",remote:false}).reason,/only through Codex/i);
  assert.equal(userVerificationAvailability({runtime:"native",remote:false}).available,false);
  assert.match(userVerificationAvailability({runtime:"codex",remote:true}).reason,/remote workspaces/i);
  assert.equal(userVerificationAvailability({runtime:"codex",remote:true}).available,false);
});

test("generic MCP form elicitations expose typed fields and validated content",()=>{
  const request={params:{mode:"form",requestedSchema:{
    type:"object",
    required:["email","count"],
    properties:{
      email:{type:"string",title:"Email",format:"email"},
      count:{type:"integer",title:"Count",minimum:1},
      enabled:{type:"boolean",title:"Enabled",default:true},
      mode:{type:"string",title:"Mode",oneOf:[{const:"safe",title:"Safe"},{const:"fast",title:"Fast"}]},
      scopes:{type:"array",title:"Scopes",minItems:1,items:{anyOf:[{const:"read",title:"Read"},{const:"write",title:"Write"}]}},
    },
  }}};
  const fields=elicitationFormFields(request);
  assert.deepEqual(fields.map(field=>[field.id,field.type,field.required]),[
    ["email","string",true],["count","number",true],["enabled","boolean",false],["mode","select",false],["scopes","multiselect",false],
  ]);
  assert.deepEqual(coerceElicitationFormContent(fields,{email:"me@example.test",count:"3",enabled:true,mode:"safe",scopes:["read"]}),{
    email:"me@example.test",count:3,enabled:true,mode:"safe",scopes:["read"],
  });
  assert.throws(()=>coerceElicitationFormContent(fields,{email:"",count:"3"}),/Email is required/);
  assert.throws(()=>coerceElicitationFormContent(fields,{email:"me@example.test",count:"3",scopes:[]}),/Scopes needs at least 1 selection/);
});

test("MCP elicitation kinds keep device verification distinct from ordinary URL handoffs",()=>{
  assert.equal(mcpElicitationKind({params:{mode:"url"}}),"url");
  assert.equal(mcpElicitationKind({params:{mode:"openai/userVerification"}}),"verification");
  assert.equal(mcpElicitationKind({params:{mode:"future"}}),"unsupported");
});

test("ACP elicitations use protocol-shaped accept, decline and cancel responses",()=>{
  const request={params:{mode:"url",url:"https://agent.example/connect",_meta:{trebell_source:"acp"}}};
  assert.equal(isAcpElicitation(request),true);
  assert.deepEqual(buildElicitationResponse(request,"once"),{action:"accept",_meta:null});
  assert.deepEqual(buildElicitationResponse(request,"once",{name:"Ada"}),{action:"accept",content:{name:"Ada"},_meta:null});
  assert.deepEqual(buildElicitationResponse(request,"decline"),{action:"decline",_meta:null});
  assert.deepEqual(buildElicitationResponse(request,"cancel"),{action:"cancel",_meta:null});
});
