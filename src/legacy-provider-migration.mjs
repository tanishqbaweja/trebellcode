import { lstatSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { trebellHome } from "./paths.mjs";
import { DEFAULT_MODEL_PROVIDER, MODEL_PROVIDERS, normalizeProviderId } from "./provider-manager.mjs";

// Freebuff was a key-less Trebell Native provider served by a local bridge. It has been removed.
// This module is the only place that still knows its id: it migrates settings, projects, Native
// threads and queued follow-ups persisted by older installs, and removes the data it left under the
// Trebell home. History (usage rows, event journal rows, thread catalog labels) is deliberately left as recorded.
export const RETIRED_MODEL_PROVIDERS=Object.freeze(["freebuff"]);
const RETIRED=new Set(RETIRED_MODEL_PROVIDERS);
// What the retired provider left under the Trebell home: its bridge's config directory (account token,
// device fingerprint, pending sign-in) and the instance id it reported upstream.
const RETIRED_PROVIDER_DATA=Object.freeze(["freebuff2api","freebuff-instance-id"]);
const SCOPED_MODEL_KEYS=Object.freeze(["defaultModel","sourceControlTextModel"]);

function plainObject(value){return Boolean(value)&&typeof value==="object"&&!Array.isArray(value)}
function knownProviderId(value){const id=String(value??"").trim().toLowerCase();return Object.prototype.hasOwnProperty.call(MODEL_PROVIDERS,id)?id:null}

export function isRetiredModelProvider(id){return RETIRED.has(String(id??"").trim().toLowerCase())}

// True when a persisted Native provider selection meant the retired provider: its own id, or any value that
// is not a provider id (absent, empty, unknown), which older versions resolved to the retired default.
export function isRetiredProviderSelection(id){return !knownProviderId(id)}

export function isRetiredProviderModel(model){
  const id=String(model??"").trim().toLowerCase();
  return RETIRED_MODEL_PROVIDERS.some(provider=>id.startsWith(provider+"/"));
}

function clearRetiredModels(source,keys=SCOPED_MODEL_KEYS){
  const next={...source};let changed=false;
  for(const key of keys)if(isRetiredProviderModel(next[key])){next[key]=null;changed=true}
  return {value:next,changed};
}

// Preference maps are keyed runtime:provider:model (model ids may contain ":"). Native keys of a retired
// provider can never resolve again. Other runtimes key per-model preferences by the Native provider
// selection: when the retired provider was that selection, its keys hold the values in use, so they move
// to the replacement provider and replace a stale key there (whatever the key order); otherwise they were
// never read and are dropped rather than moved into another provider's namespace.
function migratePreferenceKeys(source,defaultProvider,retiredActive){
  if(!plainObject(source))return {value:source,changed:false};
  const kept={},renamed={};let changed=false;
  for(const [key,value] of Object.entries(source)){
    const first=key.indexOf(":"),second=first<0?-1:key.indexOf(":",first+1);
    if(second<0){kept[key]=value;continue}
    const runtime=key.slice(0,first),provider=key.slice(first+1,second),model=key.slice(second+1);
    if(isRetiredProviderModel(model)){changed=true;continue}
    if(!isRetiredModelProvider(provider)){kept[key]=value;continue}
    changed=true;if(!retiredActive||runtime.trim().toLowerCase()==="native")continue;
    const target=`${runtime}:${defaultProvider}:${model}`;
    if(!Object.prototype.hasOwnProperty.call(renamed,target))renamed[target]=value;
  }
  for(const [target,value] of Object.entries(renamed))kept[target]=value;
  return {value:changed?kept:source,changed};
}

// retiredProviderActive says whether the retired provider was the stored Native provider selection. Pass it
// from the raw persisted value when defaults were merged in first; it defaults to the given settings' value.
export function migrateLegacyProviderSettings(settings,{defaultProvider=DEFAULT_MODEL_PROVIDER,retiredProviderActive}={}){
  if(!plainObject(settings))return {settings,changed:false};
  const retiredActive=retiredProviderActive===undefined?isRetiredProviderSelection(settings.modelProvider):Boolean(retiredProviderActive);
  const target=normalizeProviderId(defaultProvider),cleared=clearRetiredModels(settings),next=cleared.value;let changed=cleared.changed;
  if(Object.prototype.hasOwnProperty.call(next,"modelProvider")){const provider=knownProviderId(next.modelProvider)||target;if(next.modelProvider!==provider){next.modelProvider=provider;changed=true}}
  if(plainObject(next.environmentDefaults)){
    let environmentsChanged=false;const environments={};
    for(const [id,value] of Object.entries(next.environmentDefaults)){
      if(!plainObject(value)){environments[id]=value;continue}
      const scoped=clearRetiredModels(value);environments[id]=scoped.changed?scoped.value:value;if(scoped.changed)environmentsChanged=true;
    }
    if(environmentsChanged){next.environmentDefaults=environments;changed=true}
  }
  if(Array.isArray(next.customModels)){
    const kept=next.customModels.filter(item=>!(plainObject(item)&&(isRetiredModelProvider(item.provider)||isRetiredProviderModel(item.id))));
    if(kept.length!==next.customModels.length){next.customModels=kept;changed=true}
  }
  for(const key of ["modelReasoningEfforts","modelServiceTiers"]){const migrated=migratePreferenceKeys(next[key],target,retiredActive);if(migrated.changed){next[key]=migrated.value;changed=true}}
  return {settings:next,changed};
}

export function migrateLegacyProjectSettings(project){
  if(!plainObject(project))return {project,changed:false};
  const next={...project};let changed=false;
  if(isRetiredProviderModel(next.defaultModel)){next.defaultModel=null;changed=true}
  if(plainObject(next.settingsOverrides)){const overrides=clearRetiredModels(next.settingsOverrides);if(overrides.changed){next.settingsOverrides=overrides.value;changed=true}}
  return {project:next,changed};
}

// A Native thread of a retired provider is re-pointed at the current provider and loses its model:
// any model it picked belonged to the retired catalog. The null model makes the next turn fail fast
// ("Trebell Native requires a model.") before any network call, so an old transcript is never sent
// to a different vendor unattended (restart recovery, queued follow-ups, delegation, verification).
export function migrateLegacyNativeThread(thread,{provider=DEFAULT_MODEL_PROVIDER}={}){
  if(!plainObject(thread)||thread.runtime!=="native")return {thread,changed:false};
  const next={...thread},meta=plainObject(thread.providerMeta)?{...thread.providerMeta}:null,retiredProvider=Boolean(meta&&isRetiredModelProvider(meta.modelProvider));let changed=false;
  if(retiredProvider){meta.modelProvider=normalizeProviderId(provider);changed=true}
  if(meta&&Object.prototype.hasOwnProperty.call(meta,"model")&&meta.model!=null&&(retiredProvider||isRetiredProviderModel(meta.model))){meta.model=null;changed=true}
  if(next.model!=null&&(retiredProvider||isRetiredProviderModel(next.model))){next.model=null;changed=true}
  if(meta)next.providerMeta=meta;
  return {thread:next,changed};
}

// Queued follow-ups (thread metadata trebellQueue) keep their text and attachments but lose a retired model.
export function migrateLegacyQueueItems(items){
  const retired=item=>plainObject(item)&&isRetiredProviderModel(item.model);
  if(!Array.isArray(items)||!items.some(retired))return {items,changed:false};
  return {items:items.map(item=>retired(item)?{...item,model:null}:item),changed:true};
}

export function retiredProviderDataPaths(env=process.env){const home=trebellHome(env);return RETIRED_PROVIDER_DATA.map(name=>join(home,name))}

// Startup cleanup: removes exactly the retired provider's two leftovers under the Trebell home, nothing else.
// Idempotent; a failure is logged without any path and never blocks startup. A link (or Windows junction) in
// their place is unlinked itself, dangling or not, and never followed into its target. The bridge's standalone
// default config location outside the Trebell home is never touched: it may belong to a separate install.
export function removeRetiredProviderData(env=process.env,{log=()=>{}}={}){
  const report=message=>{try{log(message)}catch{}};let removed=0;
  const present=path=>{try{return lstatSync(path)}catch(error){if(error?.code!=="ENOENT"&&error?.code!=="ENOTDIR")throw error;return null}};
  for(const path of retiredProviderDataPaths(env)){
    try{
      const entry=present(path);if(!entry)continue;
      if(entry.isSymbolicLink())unlinkSync(path);else rmSync(path,{recursive:true,force:true,maxRetries:3,retryDelay:100});
      if(present(path)){report("Could not remove data left by a retired model provider.");continue}
      removed++;
    }catch(error){report(`Could not remove data left by a retired model provider (${error?.code||"error"}).`)}
  }
  return {removed};
}
