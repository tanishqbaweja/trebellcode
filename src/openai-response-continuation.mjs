import { createHash } from "node:crypto";

export const NATIVE_OPENAI_CONTINUATION_IDENTITY=Symbol.for("trebell.native.openai-continuation-identity");

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

function fingerprintByteSum(items=[],start=0){
  let total=0;for(let index=Math.max(0,Math.trunc(Number(start)||0));index<items.length;index++)total+=Number(items[index]?.bytes||0);return total;
}

function serializedArrayBytesFromSum(count=0,itemBytes=0){
  const length=Math.max(0,Math.trunc(Number(count)||0));return length?2+(length-1)+Number(itemBytes||0):2;
}

function continuationSavedRequestBytes(fullBody,fingerprints,prefixLength,parentId,{fullItemBytes=null,deltaItemBytes=null}={}){
  if(!Array.isArray(fullBody?.input)||Object.prototype.hasOwnProperty.call(fullBody||{},"previous_response_id")){
    const candidate={...fullBody,input:(Array.isArray(fullBody?.input)?fullBody.input:[]).slice(prefixLength),previous_response_id:parentId};
    return Math.max(0,Buffer.byteLength(JSON.stringify(fullBody),"utf8")-Buffer.byteLength(JSON.stringify(candidate),"utf8"));
  }
  const deltaCount=Math.max(0,fingerprints.length-prefixLength),hasFullBytes=fullItemBytes!=null&&Number.isFinite(Number(fullItemBytes)),hasDeltaBytes=deltaItemBytes!=null&&Number.isFinite(Number(deltaItemBytes)),fullInputBytes=hasFullBytes?serializedArrayBytesFromSum(fingerprints.length,fullItemBytes):serializedArrayBytes(fingerprints),deltaInputBytes=hasDeltaBytes?serializedArrayBytesFromSum(deltaCount,deltaItemBytes):serializedArrayBytes(fingerprints.slice(prefixLength));
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
  constructor({maxEntries=128,reuseByteAccounting=true,maxParentAgeMs=240_000,now=Date.now}={}){
    const bounded=Math.trunc(Number(maxEntries));
    this.maxEntries=Number.isFinite(bounded)&&bounded>0?Math.min(1024,bounded):128;
    this.reuseByteAccounting=reuseByteAccounting!==false;
    const parentAge=Number(maxParentAgeMs);this.maxParentAgeMs=Number.isFinite(parentAge)&&parentAge>0?Math.max(1_000,Math.min(86_400_000,Math.trunc(parentAge))):null;
    this.now=typeof now==="function"?now:Date.now;
    this.entries=new Map();
  }

  clear(){this.entries.clear()}

  parentFresh(parent){
    if(!parent)return false;if(this.maxParentAgeMs==null)return true;
    const recordedAtMs=Number(parent.recordedAtMs);if(!Number.isFinite(recordedAtMs))return false;
    return Math.max(0,Number(this.now())-recordedAtMs)<=this.maxParentAgeMs;
  }

  preflight(previousResponseId="",{messageRefs=null,identityToken=null,model=""}={}){
    const parentId=String(previousResponseId||"").trim(),parent=parentId?this.entries.get(parentId):null,refs=Array.isArray(messageRefs)?messageRefs:null;
    if(!parent||!this.parentFresh(parent)||!identityToken||parent.identityToken!==identityToken||!refs||!Array.isArray(parent.messageRefs)||!Array.isArray(parent.requestFingerprints)||!Array.isArray(parent.conversationDigests))return null;
    if(String(parent.model||"")!==String(model||"")||parent.messageRefs.length>refs.length||parent.requestFingerprints.length>parent.conversationDigests.length)return null;
    for(let index=0;index<parent.messageRefs.length;index++)if(parent.messageRefs[index]!==refs[index])return null;
    return {parentId,messageCount:parent.messageRefs.length,requestInputCount:parent.requestFingerprints.length,conversationInputCount:Array.isArray(parent.conversationDigests)?parent.conversationDigests.length:0};
  }

  prepareSuffix(suffixBody={},previousResponseId="",{messageRefs=null,identityToken=null}={}){
    const refs=Array.isArray(messageRefs)?messageRefs:null,proof=this.preflight(previousResponseId,{messageRefs:refs,identityToken,model:suffixBody?.model});
    if(!proof)return null;
    const parent=this.entries.get(proof.parentId),suffixInput=Array.isArray(suffixBody?.input)?suffixBody.input:[],suffixFingerprints=suffixInput.map(fingerprint),requestFingerprints=[...parent.requestFingerprints,...suffixFingerprints];
    const parentByteSum=this.reuseByteAccounting&&parent.requestFingerprintByteSum!=null&&Number.isFinite(Number(parent.requestFingerprintByteSum))?Number(parent.requestFingerprintByteSum):null,suffixByteSum=parentByteSum==null?null:fingerprintByteSum(suffixFingerprints),requestFingerprintByteSum=parentByteSum==null?fingerprintByteSum(requestFingerprints):parentByteSum+suffixByteSum;
    const outputDigests=Array.isArray(parent.conversationDigests)?parent.conversationDigests.slice(parent.requestFingerprints.length):[];
    if(outputDigests.length>suffixFingerprints.length)return null;
    for(let index=0;index<outputDigests.length;index++)if(outputDigests[index]!==suffixFingerprints[index].digest)return null;
    const fullInputDigests=requestFingerprints.map(item=>item.digest),delta=suffixInput.slice(outputDigests.length),candidate={...suffixBody,input:delta,previous_response_id:proof.parentId},deltaByteSum=this.reuseByteAccounting?fingerprintByteSum(suffixFingerprints,outputDigests.length):null;
    return {
      body:candidate,used:true,parentId:proof.parentId,fullInputDigests,requestFingerprints,messageRefs:refs?[...refs]:null,identityToken:identityToken||null,fastPrefixCount:parent.requestFingerprints.length,
      deltaInputCount:delta.length,fullInputCount:requestFingerprints.length,savedRequestBytes:continuationSavedRequestBytes(suffixBody,requestFingerprints,parent.conversationDigests.length,proof.parentId,{fullItemBytes:this.reuseByteAccounting?requestFingerprintByteSum:null,deltaItemBytes:deltaByteSum}),inputBuildReused:true,canonicalPrefixMessageCount:proof.messageCount,requestFingerprintByteSum,
    };
  }

  prepare(fullBody={},previousResponseId="",{messageRefs=null,identityToken=null}={}){
    const input=Array.isArray(fullBody?.input)?fullBody.input:[],parentId=String(previousResponseId||"").trim(),parent=parentId?this.entries.get(parentId):null,parentFresh=this.parentFresh(parent);
    const refs=Array.isArray(messageRefs)?messageRefs:null,refSnapshot=refs?[...refs]:null;
    let fingerprints=null,fastPrefixCount=0,requestFingerprintByteSum=null;
    if(parent&&identityToken&&parent.identityToken===identityToken&&refs&&Array.isArray(parent.messageRefs)&&Array.isArray(parent.requestFingerprints)&&parent.requestFingerprints.length<=input.length&&parent.messageRefs.length<=refs.length){
      let same=true;for(let index=0;index<parent.messageRefs.length;index++)if(parent.messageRefs[index]!==refs[index]){same=false;break}
      if(same){
        fastPrefixCount=parent.requestFingerprints.length;const suffixFingerprints=input.slice(fastPrefixCount).map(fingerprint);fingerprints=[...parent.requestFingerprints,...suffixFingerprints];
        if(this.reuseByteAccounting&&parent.requestFingerprintByteSum!=null&&Number.isFinite(Number(parent.requestFingerprintByteSum)))requestFingerprintByteSum=Number(parent.requestFingerprintByteSum)+fingerprintByteSum(suffixFingerprints);
      }
    }
    if(!fingerprints)fingerprints=input.map(fingerprint);
    if(requestFingerprintByteSum==null)requestFingerprintByteSum=fingerprintByteSum(fingerprints);
    const fullInputDigests=fingerprints.map(item=>item.digest),base={
      body:fullBody,used:false,parentId:null,fullInputDigests,requestFingerprints:fingerprints,messageRefs:refSnapshot,identityToken:identityToken||null,fastPrefixCount,deltaInputCount:input.length,fullInputCount:input.length,savedRequestBytes:0,requestFingerprintByteSum,
      parentExpired:Boolean(parent&&!parentFresh),
    };
    if(!parent||!parentFresh||String(parent.model||"")!==String(fullBody?.model||""))return base;
    const prefix=Array.isArray(parent.conversationDigests)?parent.conversationDigests:[];
    if(prefix.length>fullInputDigests.length)return base;
    for(let index=0;index<prefix.length;index++)if(prefix[index]!==fullInputDigests[index])return base;
    const delta=input.slice(prefix.length),candidate={...fullBody,input:delta,previous_response_id:parentId},deltaByteSum=this.reuseByteAccounting?fingerprintByteSum(fingerprints,prefix.length):null;
    return {
      ...base,body:candidate,used:true,parentId,deltaInputCount:delta.length,
      savedRequestBytes:continuationSavedRequestBytes(fullBody,fingerprints,prefix.length,parentId,{fullItemBytes:this.reuseByteAccounting?requestFingerprintByteSum:null,deltaItemBytes:deltaByteSum}),
    };
  }

  record(responseId,preparation={},turn={}){
    const id=String(responseId||"").trim();if(!id)return null;
    const requestDigests=Array.isArray(preparation?.fullInputDigests)?preparation.fullInputDigests:[];
    const outputDigests=openAiContinuationOutputItems(turn).map(digest),conversationDigests=[...requestDigests,...outputDigests];
    this.entries.delete(id);
    this.entries.set(id,{model:String(preparation?.body?.model||turn?.model||""),conversationDigests,requestFingerprints:Array.isArray(preparation?.requestFingerprints)?preparation.requestFingerprints:[],requestFingerprintByteSum:preparation?.requestFingerprintByteSum!=null&&Number.isFinite(Number(preparation.requestFingerprintByteSum))?Number(preparation.requestFingerprintByteSum):null,messageRefs:Array.isArray(preparation?.messageRefs)?preparation.messageRefs:null,identityToken:preparation?.identityToken||null,recordedAtMs:Number(this.now())});
    while(this.entries.size>this.maxEntries)this.entries.delete(this.entries.keys().next().value);
    return {responseId:id,inputItems:requestDigests.length,outputItems:outputDigests.length,conversationItems:conversationDigests.length};
  }
}
