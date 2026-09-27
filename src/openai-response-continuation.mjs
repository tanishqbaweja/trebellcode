import { createHash } from "node:crypto";

function digest(value){
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function fingerprint(value){
  const serialized=JSON.stringify(value);
  return {digest:createHash("sha256").update(serialized).digest("hex"),bytes:Buffer.byteLength(serialized,"utf8")};
}

function serializedArrayBytes(items=[]){
  if(!items.length)return 2;
  return 2+(items.length-1)+items.reduce((total,item)=>total+Number(item?.bytes||0),0);
}

function continuationSavedRequestBytes(fullBody,fingerprints,prefixLength,parentId){
  if(!Array.isArray(fullBody?.input)||Object.prototype.hasOwnProperty.call(fullBody||{},"previous_response_id")){
    const candidate={...fullBody,input:(Array.isArray(fullBody?.input)?fullBody.input:[]).slice(prefixLength),previous_response_id:parentId};
    return Math.max(0,Buffer.byteLength(JSON.stringify(fullBody),"utf8")-Buffer.byteLength(JSON.stringify(candidate),"utf8"));
  }
  const fullInputBytes=serializedArrayBytes(fingerprints),deltaInputBytes=serializedArrayBytes(fingerprints.slice(prefixLength));
  const parentPropertyBytes=Buffer.byteLength(`,"previous_response_id":${JSON.stringify(parentId)}`,"utf8");
  return Math.max(0,fullInputBytes-deltaInputBytes-parentPropertyBytes);
}

function flatToolName(namespace,name){
  return namespace?String(namespace)+"__"+String(name||"tool"):String(name||"tool");
}

function callArguments(call={}){
  const value=call?.arguments;
  if(typeof value==="string")return value;
  try{return JSON.stringify(value??{})}catch{return "{}"}
}

export function openAiContinuationOutputItems(turn={}){
  const out=[],text=String(turn?.text||"");
  if(text)out.push({type:"message",role:"assistant",content:[{type:"output_text",text}]});
  for(const call of Array.isArray(turn?.toolCalls)?turn.toolCalls:[]){
    const name=String(call?.name||"").trim();if(!name)continue;
    out.push({
      type:"function_call",
      ...(call?.id?{call_id:String(call.id)}:{}),
      name:flatToolName(call?.namespace,name),
      arguments:callArguments(call),
    });
  }
  return out;
}

export class OpenAiResponseContinuationTracker{
  constructor({maxEntries=128}={}){
    const bounded=Math.trunc(Number(maxEntries));
    this.maxEntries=Number.isFinite(bounded)&&bounded>0?Math.min(1024,bounded):128;
    this.entries=new Map();
  }

  clear(){this.entries.clear()}

  prepare(fullBody={},previousResponseId=""){
    const input=Array.isArray(fullBody?.input)?fullBody.input:[],parentId=String(previousResponseId||"").trim(),parent=parentId?this.entries.get(parentId):null;
    const fingerprints=input.map(fingerprint),fullInputDigests=fingerprints.map(item=>item.digest),base={
      body:fullBody,used:false,parentId:null,fullInputDigests,deltaInputCount:input.length,fullInputCount:input.length,savedRequestBytes:0,
    };
    if(!parent||String(parent.model||"")!==String(fullBody?.model||""))return base;
    const prefix=Array.isArray(parent.conversationDigests)?parent.conversationDigests:[];
    if(prefix.length>fullInputDigests.length)return base;
    for(let index=0;index<prefix.length;index++)if(prefix[index]!==fullInputDigests[index])return base;
    const delta=input.slice(prefix.length),candidate={...fullBody,input:delta,previous_response_id:parentId};
    return {
      body:candidate,used:true,parentId,fullInputDigests,deltaInputCount:delta.length,fullInputCount:input.length,
      savedRequestBytes:continuationSavedRequestBytes(fullBody,fingerprints,prefix.length,parentId),
    };
  }

  record(responseId,preparation={},turn={}){
    const id=String(responseId||"").trim();if(!id)return null;
    const requestDigests=Array.isArray(preparation?.fullInputDigests)?preparation.fullInputDigests:[];
    const outputDigests=openAiContinuationOutputItems(turn).map(digest),conversationDigests=[...requestDigests,...outputDigests];
    this.entries.delete(id);
    this.entries.set(id,{model:String(preparation?.body?.model||turn?.model||""),conversationDigests});
    while(this.entries.size>this.maxEntries)this.entries.delete(this.entries.keys().next().value);
    return {responseId:id,inputItems:requestDigests.length,outputItems:outputDigests.length,conversationItems:conversationDigests.length};
  }
}
