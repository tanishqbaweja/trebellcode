export const CONVERSATION_VIRTUALIZE_AFTER=160;
export const CONVERSATION_CHUNK_SIZE=32;

function textLength(message){
  return String(message?.text||"").length;
}

export function estimateConversationMessageHeight(message){
  const length=textLength(message);
  if(message?.role==="user")return Math.max(54,Math.min(360,54+Math.ceil(length/90)*18));
  return Math.max(92,Math.min(560,92+Math.ceil(length/88)*20));
}

export function conversationVirtualChunks(messages=[],{chunkSize=CONVERSATION_CHUNK_SIZE}={}){
  const source=Array.isArray(messages)?messages:[],size=Math.max(8,Math.min(100,Math.trunc(Number(chunkSize)||CONVERSATION_CHUNK_SIZE)));
  const chunks=[];let end=source.length;
  while(end>0){
    const start=Math.max(0,end-size),items=source.slice(start,end);
    chunks.unshift({
      key:String(items[0]?.id??start)+"::"+String(items.at(-1)?.id??(end-1)),
      start,end,
      messages:items,
      estimatedHeight:items.reduce((sum,item)=>sum+estimateConversationMessageHeight(item)+7,0),
    });
    end=start;
  }
  return chunks;
}

export function conversationChunkIndexForMessage(chunks=[],messageId){
  const wanted=String(messageId??"");if(!wanted)return -1;
  return (Array.isArray(chunks)?chunks:[]).findIndex(chunk=>chunk.messages.some(message=>String(message?.id)===wanted));
}

export function shouldVirtualizeConversation(messages=[],threshold=CONVERSATION_VIRTUALIZE_AFTER){
  return Array.isArray(messages)&&messages.length>Math.max(20,Number(threshold)||CONVERSATION_VIRTUALIZE_AFTER);
}
