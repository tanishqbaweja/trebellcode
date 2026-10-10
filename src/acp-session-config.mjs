// ACP agents describe their models, modes and other settings in two shapes: the older
// `models` / `modes` objects and `configOptions` entries (category "model" / "mode"). OpenCode
// only sends configOptions, Grok only models (+ its own options), Cursor and Antigravity send
// both. These helpers read and change either shape the way T3's AcpSessionRuntime does:
// a mode or model is changed through its config option when the agent advertises one, and
// through session/set_mode or session/set_model only when the agent has nothing else.

function text(value){return String(value??"").trim()}

export function acpConfigOption(setup,category){
  const wanted=text(category).toLowerCase();if(!wanted)return null;
  const options=Array.isArray(setup?.configOptions)?setup.configOptions:[];
  return options.find(option=>text(option?.category).toLowerCase()===wanted&&text(option?.id))
    ||options.find(option=>text(option?.id).toLowerCase()===wanted)
    ||null;
}

// Select options may be grouped ({group, options:[...]}); flatten them and keep the first of each value.
export function acpConfigChoices(option){
  if(!option||!Array.isArray(option.options))return [];
  const out=[],seen=new Set();
  for(const entry of option.options){
    const group=entry&&typeof entry==="object"&&Array.isArray(entry.options)?entry.options:[entry];
    for(const item of group){
      const value=text(item?.value);if(!value||seen.has(value))continue;seen.add(value);
      const description=text(item?.description);
      out.push({value,name:text(item?.name)||value,...(description?{description}:{})});
    }
  }
  return out;
}

// The offered values for one category plus the value the agent currently runs with.
// Modes prefer modes.availableModes, models prefer the model config option (it carries the
// display names Antigravity and Cursor use), each falling back to the other shape.
export function acpConfigSelect(setup,category){
  const kind=text(category).toLowerCase(),option=acpConfigOption(setup,kind);
  const fromModes=kind==="mode"&&Array.isArray(setup?.modes?.availableModes)
    ?setup.modes.availableModes.map(mode=>({value:text(mode?.id),name:text(mode?.name)||text(mode?.id),...(text(mode?.description)?{description:text(mode.description)}:{})})).filter(choice=>choice.value)
    :[];
  const fromModels=kind==="model"&&Array.isArray(setup?.models?.availableModels)
    ?setup.models.availableModels.map(model=>({value:text(model?.modelId),name:text(model?.name)||text(model?.modelId),...(model?._meta&&typeof model._meta==="object"?{meta:model._meta}:{})})).filter(choice=>choice.value)
    :[];
  const fromOption=acpConfigChoices(option);
  let choices;
  if(kind==="mode")choices=fromModes.length?fromModes:fromOption;
  else if(kind==="model"){
    const meta=new Map(fromModels.map(choice=>[choice.value,choice.meta]));
    choices=fromOption.length?fromOption.map(choice=>meta.get(choice.value)?{...choice,meta:meta.get(choice.value)}:choice):fromModels;
  }else choices=fromOption;
  const current=text(option?.currentValue)
    ||(kind==="mode"?text(setup?.modes?.currentModeId):kind==="model"?text(setup?.models?.currentModelId):"")
    ||null;
  return {option,choices,current};
}

// The mode a harness offers for read-only work: Cursor's ask mode (its plan mode still proposes
// edits), otherwise the first of ask / read-only / plan the agent offers. Returns the offered id.
export function acpReadOnlyMode(kind,setup){
  const offered=acpConfigSelect(setup,"mode").choices.map(choice=>choice.value);
  const wanted=kind==="cursor"?["ask"]:["ask","read-only","readonly","read_only","plan"];
  return wanted.map(id=>offered.find(item=>item.toLowerCase()===id)).find(Boolean)||null;
}

// Returns a copy of the setup with one category's current value replaced, in both shapes.
export function acpSetupWithValue(setup,category,value){
  const kind=text(category).toLowerCase(),next={...(setup||{})};
  const option=acpConfigOption(setup,kind);
  if(Array.isArray(next.configOptions)&&option)next.configOptions=next.configOptions.map(entry=>entry===option?{...entry,currentValue:value}:entry);
  if(kind==="mode"&&next.modes&&typeof next.modes==="object")next.modes={...next.modes,currentModeId:value};
  if(kind==="model"&&next.models&&typeof next.models==="object")next.models={...next.models,currentModelId:value};
  return next;
}

// session/set_config_option answers with the agent's full option list; keep it as the truth.
export function acpSetupWithConfigOptions(setup,configOptions){
  if(!Array.isArray(configOptions))return setup;
  let next={...(setup||{}),configOptions};
  const mode=acpConfigOption(next,"mode"),model=acpConfigOption(next,"model");
  if(mode&&text(mode.currentValue)&&next.modes&&typeof next.modes==="object")next.modes={...next.modes,currentModeId:text(mode.currentValue)};
  if(model&&text(model.currentValue)&&next.models&&typeof next.models==="object")next.models={...next.models,currentModelId:text(model.currentValue)};
  return next;
}

// Changes a mode or model and returns the updated setup. Uses the category's config option
// when the agent has one (T3 setMode/setModel), otherwise session/set_mode or session/set_model.
export async function acpApplyValue(client,sessionId,setup,category,value,{meta=null}={}){
  const kind=text(category).toLowerCase(),option=acpConfigOption(setup,kind);
  if(option&&option.type!=="boolean"){
    const result=await client.setConfigOption(sessionId,option.id,value);
    // The agent answers with the options it runs with, even when it kept another value.
    return Array.isArray(result?.configOptions)?acpSetupWithConfigOptions(setup,result.configOptions):acpSetupWithValue(setup,kind,value);
  }
  if(kind==="mode"&&Array.isArray(setup?.modes?.availableModes)){await client.setMode(sessionId,value);return acpSetupWithValue(setup,kind,value)}
  if(kind==="model"&&setup?.models&&typeof setup.models==="object"){await client.setModel(sessionId,value,meta);return acpSetupWithValue(setup,kind,value)}
  throw new Error(`the agent does not offer a ${kind} setting`);
}
