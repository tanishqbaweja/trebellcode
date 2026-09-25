const APPROVAL_KIND_KEY="codex_approval_kind";
const TOOL_APPROVAL_KIND="mcp_tool_call";
const PERSIST_KEY="persist";

function object(value){return value&&typeof value==="object"&&!Array.isArray(value)?value:{}}

export function elicitationMeta(request){
  return object(request?.params?._meta);
}

export function isAcpElicitation(request){
  return elicitationMeta(request).trebell_source==="acp";
}

export function buildElicitationResponse(request,decision,content=null){
  if(!isAcpElicitation(request))return buildMcpApprovalResponse(decision);
  if(decision==="once")return {action:"accept",...(content!=null?{content}:{}),_meta:null};
  if(decision==="decline")return {action:"decline",_meta:null};
  return {action:"cancel",_meta:null};
}

export function isMcpToolApproval(request){
  const params=request?.params||{};
  if(!["form","openai/form","openaiForm"].includes(String(params.mode||"")))return false;
  return elicitationMeta(request)[APPROVAL_KIND_KEY]===TOOL_APPROVAL_KIND;
}

export function elicitationSupportsPersist(request,mode){
  const value=elicitationMeta(request)[PERSIST_KEY];
  if(typeof value==="string")return value===mode;
  return Array.isArray(value)&&value.includes(mode);
}

export function elicitationDisplayParams(request){
  const meta=elicitationMeta(request);
  const display=Array.isArray(meta.tool_params_display)?meta.tool_params_display.flatMap(item=>{
    if(!item||typeof item!=="object")return [];
    const name=String(item.name||"").trim();if(!name)return [];
    const label=String(item.display_name||name).trim()||name;
    return [{name,label,value:item.value}];
  }):[];
  if(display.length)return display;
  return Object.entries(object(meta.tool_params)).sort(([a],[b])=>a.localeCompare(b)).map(([name,value])=>({name,label:name,value}));
}

export function elicitationApprovalDetails(request){
  const params=request?.params||{};
  const meta=elicitationMeta(request);
  const connectorName=String(meta.connector_name||"").trim();
  const connectorId=String(meta.connector_id||"").trim();
  const toolTitle=String(meta.tool_title||"").trim();
  const toolName=String(meta.tool_name||"").trim();
  return {
    connectorName:connectorName||connectorId||String(params.serverName||"App"),
    connectorId:connectorId||null,
    connectorDescription:String(meta.connector_description||"").trim()||null,
    toolTitle:toolTitle||toolName||"App action",
    toolName:toolName||null,
    toolDescription:String(meta.tool_description||"").trim()||null,
    message:String(params.message||"").trim()||null,
    displayParams:elicitationDisplayParams(request),
  };
}

export function buildMcpApprovalResponse(decision){
  if(decision==="session")return {action:"accept",content:null,_meta:{persist:"session"}};
  if(decision==="always")return {action:"accept",content:null,_meta:{persist:"always"}};
  if(decision==="once")return {action:"accept",content:null,_meta:null};
  if(decision==="decline")return {action:"decline",content:null,_meta:null};
  return {action:"cancel",content:null,_meta:null};
}

export function buildUserVerificationResponse(proof){
  const credentialId=String(proof?.credentialId||"").trim();
  const signature=String(proof?.signature||"").trim();
  if(!credentialId||!signature)throw new Error("Codex did not return a valid verification proof");
  return {action:"accept",content:{credentialId,signature},_meta:null};
}

function enumOptions(schema){
  if(Array.isArray(schema?.enum))return schema.enum.map(value=>({value,label:String(value)}));
  for(const key of ["oneOf","anyOf"]){
    const entries=Array.isArray(schema?.[key])?schema[key]:[];
    const values=entries.flatMap(item=>item&&Object.prototype.hasOwnProperty.call(item,"const")?[{value:item.const,label:String(item.title??item.const)}]:[]);
    if(values.length===entries.length&&values.length)return values;
  }
  return [];
}

export function elicitationFormFields(request){
  const params=request?.params||{};
  const schema=object(params.requestedSchema);
  const properties=object(schema.properties);
  const required=new Set(Array.isArray(schema.required)?schema.required:[]);
  return Object.entries(properties).map(([id,raw])=>{
    const item=object(raw);
    const arrayOptions=String(item.type||"")==="array"?enumOptions(object(item.items)):[];
    const options=arrayOptions.length?arrayOptions:enumOptions(item);
    let type=String(item.type||"string");
    if(arrayOptions.length)type="multiselect";
    else if(options.length)type="select";
    else if(type==="integer")type="number";
    return {
      id,
      label:String(item.title||id),
      description:String(item.description||"").trim()||null,
      type,
      options,
      required:required.has(id),
      secret:item.format==="password",
      integer:String(item.type||"")==="integer",
      format:String(item.format||"")||null,
      defaultValue:item.default??(type==="boolean"?false:type==="multiselect"?[]:""),
      minimum:item.minimum,
      maximum:item.maximum,
      minLength:item.minLength,
      maxLength:item.maxLength,
      minItems:item.minItems,
      maxItems:item.maxItems,
    };
  });
}

export function coerceElicitationFormContent(fields,values){
  const content={};
  for(const field of fields){
    const value=values?.[field.id];
    if((value===""||value==null)&&!field.required)continue;
    if(field.required&&(value===""||value==null))throw new Error(`${field.label} is required`);
    if(field.type==="number"){
      const number=Number(value);if(!Number.isFinite(number))throw new Error(`${field.label} must be a number`);
      if(field.integer&&!Number.isInteger(number))throw new Error(`${field.label} must be a whole number`);
      if(field.minimum!=null&&number<Number(field.minimum))throw new Error(`${field.label} must be at least ${field.minimum}`);
      if(field.maximum!=null&&number>Number(field.maximum))throw new Error(`${field.label} must be at most ${field.maximum}`);
      content[field.id]=number;
    }else if(field.type==="boolean")content[field.id]=Boolean(value);
    else if(field.type==="multiselect"){
      const values=Array.isArray(value)?value:[];
      if(field.minItems!=null&&values.length<Number(field.minItems))throw new Error(`${field.label} needs at least ${field.minItems} selection${Number(field.minItems)===1?"":"s"}`);
      if(field.maxItems!=null&&values.length>Number(field.maxItems))throw new Error(`${field.label} allows at most ${field.maxItems} selection${Number(field.maxItems)===1?"":"s"}`);
      if(values.length||field.required)content[field.id]=values;
    }else{
      const text=String(value??"");
      if(field.minLength!=null&&text.length<Number(field.minLength))throw new Error(`${field.label} must be at least ${field.minLength} characters`);
      if(field.maxLength!=null&&text.length>Number(field.maxLength))throw new Error(`${field.label} must be at most ${field.maxLength} characters`);
      content[field.id]=value;
    }
  }
  return content;
}

export function mcpElicitationKind(request){
  const mode=String(request?.params?.mode||"");
  if(isMcpToolApproval(request))return "approval";
  if(["form","openai/form","openaiForm"].includes(mode))return "form";
  if(mode==="url")return "url";
  if(mode==="openai/userVerification")return "verification";
  return "unsupported";
}
