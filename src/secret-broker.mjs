const SECRET_SCOPES=Object.freeze({
  "source-control.bitbucket":Object.freeze([
    "TREBELL_BITBUCKET_ACCESS_TOKEN","T3CODE_BITBUCKET_ACCESS_TOKEN",
    "TREBELL_BITBUCKET_EMAIL","T3CODE_BITBUCKET_EMAIL",
    "TREBELL_BITBUCKET_API_TOKEN","T3CODE_BITBUCKET_API_TOKEN",
  ]),
});

function parentValue(environment,name,{caseInsensitive=false}={}){
  if(Object.prototype.hasOwnProperty.call(environment||{},name))return environment[name];
  if(!caseInsensitive)return undefined;
  const lower=name.toLowerCase(),match=Object.keys(environment||{}).find(key=>key.toLowerCase()===lower);return match==null?undefined:environment[match];
}

export function secretNamesForScope(scope){return [...(SECRET_SCOPES[String(scope||"")]||[])]}

export class ScopedSecretBroker{
  constructor({environment=process.env,environments=null,environmentId=null,platform=process.platform}={}){this.environment=environment;this.environments=environments;this.environmentId=environmentId;this.platform=platform}
  async values(scope){
    const names=secretNamesForScope(scope);if(!names.length)throw new Error("Unknown secret scope: "+String(scope||""));
    const profile=this.environmentId&&this.environments?this.environments.get(this.environmentId):null;
    if(this.environmentId&&!profile)throw new Error("Secret broker environment is unavailable");
    if(!profile||profile.type==="local"){
      const out={};for(const name of names){const value=parentValue(this.environment,name,{caseInsensitive:this.platform==="win32"});if(value!=null&&String(value)!=="")out[name]=String(value)}return out;
    }
    const out={};
    for(const name of names){
      const result=await this.environments.executeArgv(profile.id,{command:"printenv",args:[name],cwd:"",timeoutMs:8000,maxOutput:64*1024,environmentNames:names});
      if(Number(result?.exitCode)===0&&!result?.timedOut){const value=String(result?.stdout||"").trimEnd();if(value)out[name]=value}
    }
    return out;
  }
}
