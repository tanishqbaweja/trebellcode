// The models a person added or priced in Settings (settings.customModels) joined to a harness's model catalog: those of the harness,
// and for Trebell Native those saved for the provider the catalog is from. A model the catalog lists stays as it lists it, one entry
// that is not marked custom: a price or setting saved for it adds only a display name the person gave it and the effort and service
// tier set. A model it leaves out is added once, marked custom.
const CUSTOM_MODEL_RUNTIMES=new Set(["native","codex","claude","opencode","cursor","grok","antigravity","muse"]);

export function withCustomModels(catalog,{customModels=[],runtime,provider}={}){
  if(!CUSTOM_MODEL_RUNTIMES.has(runtime))return catalog;
  const custom=(Array.isArray(customModels)?customModels:[]).filter(item=>item&&item.id&&item.runtime===runtime&&(runtime!=="native"||item.provider===provider));
  if(!custom.length)return catalog;
  const models=[...(Array.isArray(catalog.models)?catalog.models:[])],metadataModels=[...(catalog.metadata?.models||[])];
  for(const item of custom){
    if(!models.includes(item.id))models.push(item.id);
    const index=metadataModels.findIndex(model=>model.id===item.id);
    if(index>=0){metadataModels[index]={...metadataModels[index],...(item.name&&item.name!==item.id?{name:item.name}:{}),...(item.effort?{effort:item.effort}:{}),...(item.serviceTier?{serviceTier:item.serviceTier}:{})};continue}
    metadataModels.push({id:item.id,name:item.name||item.id,provider:runtime==="native"?provider:runtime,agent:runtime,custom:true,effort:item.effort||null,serviceTier:item.serviceTier||null});
  }
  return {...catalog,models,metadata:{...(catalog.metadata||{}),models:metadataModels}};
}
