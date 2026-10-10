// A model's settings beyond its effort and speed, as a harness lists them per model (Cursor's context size and thinking
// switch), in the shape of T3 Code's model option descriptors: a true/false choice is a switch, anything else a list.
// The user's picks are kept per runtime, provider and model in settings.modelOptionValues; a setting the user has not
// picked stays as the harness has it.
const OPTION_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_OPTIONS=16,MAX_CHOICES=64,MAX_VALUE=128;
const SWITCH_CHOICES=Object.freeze([Object.freeze({value:"true",label:"On"}),Object.freeze({value:"false",label:"Off"})]);

function text(value){return String(value??"").trim()}

export function modelOptionKey(runtime,provider,model){
  return [String(runtime||""),String(provider||""),String(model||"")].join(":");
}

// The checked descriptors of a model's metadata.modelOptions: {id,label,type:"boolean"|"select",choices:[{value,label}],
// defaultValue}, where a switch's choices are On ("true") and Off ("false") and defaultValue is the harness's current value.
export function supportedModelOptions(metadata={}){
  const out=[];
  for(const entry of Array.isArray(metadata?.modelOptions)?metadata.modelOptions:[]){
    if(out.length>=MAX_OPTIONS)break;
    const id=text(entry?.id);if(!OPTION_ID.test(id)||out.some(option=>option.id===id))continue;
    const label=text(entry?.label)||id,current=text(entry?.defaultValue);
    if(entry?.type==="boolean"){
      out.push({id,label,type:"boolean",choices:SWITCH_CHOICES.map(choice=>({...choice})),defaultValue:["true","false"].includes(current)?current:null});
      continue;
    }
    if(entry?.type!=="select")continue;
    const choices=[];
    for(const choice of Array.isArray(entry.choices)?entry.choices:[]){
      if(choices.length>=MAX_CHOICES)break;
      const value=text(choice?.value);if(!value||value.length>MAX_VALUE||choices.some(item=>item.value===value))continue;
      choices.push({value,label:text(choice?.label)||value});
    }
    if(choices.length)out.push({id,label,type:"select",choices,defaultValue:choices.some(choice=>choice.value===current)?current:null});
  }
  return out;
}

// One model's saved picks (option id -> value), bounded; a switch is "true" or "false".
export function normalizeModelOptionValues(value){
  const out={};
  if(!value||typeof value!=="object"||Array.isArray(value))return out;
  for(const [id,raw] of Object.entries(value)){
    if(Object.keys(out).length>=MAX_OPTIONS)break;
    const picked=typeof raw==="boolean"?String(raw):typeof raw==="string"?raw.trim():"";
    if(OPTION_ID.test(id)&&picked&&picked.length<=MAX_VALUE)out[id]=picked;
  }
  return out;
}

// settings.modelOptionValues: at most 500 models, each with its normalized picks.
export function normalizeModelOptionSettings(value){
  const source=value&&typeof value==="object"&&!Array.isArray(value)?value:{},out={};
  for(const [key,picks] of Object.entries(source).slice(-500)){
    const k=String(key||"").slice(0,500),v=normalizeModelOptionValues(picks);
    if(k&&k!=="__proto__"&&Object.keys(v).length)out[k]=v;
  }
  return out;
}

// The picks a turn sends: the saved ones the model still offers.
export function configuredModelOptions(settings,runtime,provider,model,metadata={}){
  const saved=normalizeModelOptionValues(settings?.modelOptionValues?.[modelOptionKey(runtime,provider,model)]),out={};
  for(const option of supportedModelOptions(metadata)){
    const value=saved[option.id];
    if(value!==undefined&&option.choices.some(choice=>choice.value===value))out[option.id]=value;
  }
  return out;
}

// The settings value after the user picks a value for one option of a model ("" forgets the pick).
export function modelOptionSettingsWith(settings,runtime,provider,model,id,value){
  const all={...(settings?.modelOptionValues||{})},key=modelOptionKey(runtime,provider,model),picks={...normalizeModelOptionValues(all[key])};
  const picked=text(value);
  if(picked)picks[String(id)]=picked;else delete picks[String(id)];
  if(Object.keys(picks).length)all[key]=picks;else delete all[key];
  return normalizeModelOptionSettings(all);
}
