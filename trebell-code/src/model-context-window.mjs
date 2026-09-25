const CANDIDATE_PATHS=[
  ["contextWindow"],["context_window"],["contextLength"],["context_length"],["maxContextTokens"],["max_context_tokens"],["maxModelLen"],["max_model_len"],
  ["limits","contextWindow"],["limits","context_window"],["limits","contextLength"],["limits","context_length"],
];

function valueAt(object,path){let current=object;for(const key of path){if(!current||typeof current!=="object")return null;current=current[key]}return current}

export function modelContextWindowFromMetadata(metadata){
  if(!metadata||typeof metadata!=="object")return null;
  for(const path of CANDIDATE_PATHS){
    const number=Number(valueAt(metadata,path));
    if(Number.isFinite(number)&&number>0&&number<=1_000_000_000)return Math.trunc(number);
  }
  return null;
}

export function modelContextWindowKey(provider,model){return String(provider||"").trim().toLowerCase()+"\0"+String(model||"").trim()}
