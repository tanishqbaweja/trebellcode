const INITIAL_STATE=Object.freeze({supported:false,status:"idle",currentVersion:null,availableVersion:null,percent:null,transferred:null,total:null,error:null,releaseName:null});

function message(error){return error instanceof Error?error.message:String(error||"Unknown updater error")}

// What a failed check or download says, as the app's other errors do: what could not be done, and why in words. electron-updater's
// own text is a net:: code, or an HttpError's status line with the request and the response's headers, often inside a longer
// message with a stack; it logs that itself.
const LEADS={check:"Could not check for updates",download:"Could not download the update",install:"Could not install the update"};
const HTTP_STATUS={401:"Unauthorized",403:"Forbidden",404:"Not Found",408:"Request Timeout",429:"Too Many Requests",500:"Internal Server Error",502:"Bad Gateway",503:"Service Unavailable",504:"Gateway Timeout"};
function reason(error){
  const text=message(error),net=/\bnet::(ERR_[A-Z0-9_]+)/.exec(text)?.[1];
  if(net)return /^ERR_(CERT|SSL)_/.test(net)?"the release server's certificate was not accepted.":"there is no connection to the release server.";
  const status=Number(error?.statusCode)||Number(/\bHttpError: (\d{3})\b/.exec(text)?.[1])||Number(/\bstatus (\d{3})\b/.exec(text)?.[1]);
  if(status>=400)return `the release server answered ${status}${HTTP_STATUS[status]?" "+HTTP_STATUS[status]:""}.`;
  if(error?.code==="ERR_UPDATER_NO_PUBLISHED_VERSIONS")return "no release has been published yet.";
  if(error?.code==="ENOSPC")return "there is not enough free disk space.";
  if(/sha512 checksum mismatch/i.test(text))return "the downloaded file did not match the release.";
  const line=text.split("\n")[0].trim();
  return !line?"no reason was given.":/[.!?]$/.test(line)?line:line+".";
}
const failureText=(lead,error)=>`${LEADS[lead]||"Could not update Trebell Code"}: ${reason(error)}`;

export function createUpdaterController({app,autoUpdater,onState=()=>{},beforeInstall=async()=>{},scheduleInstall=fn=>setImmediate(fn),onInstallLaunchFailure=()=>{}}={}){
  if(!app)throw new Error("Updater controller requires app");
  if(!autoUpdater)throw new Error("Updater controller requires autoUpdater");
  let configured=false,state={...INITIAL_STATE};
  const snapshot=()=>({...state});
  const publish=(patch={})=>{state={...state,...patch,currentVersion:app.getVersion?.()||state.currentVersion};const next=snapshot();try{onState(next)}catch{}return next};
  // The error event says what failed by the step under way; check and download name theirs, and reject with the same sentence.
  const fail=(error,{status="error",lead={checking:"check",downloading:"download",installing:"install"}[state.status]}={})=>publish({supported:Boolean(app.isPackaged),status,error:failureText(lead,error)});
  const configure=()=>{
    if(configured)return snapshot();configured=true;
    if(!app.isPackaged)return publish({supported:false,status:"development",error:null});
    autoUpdater.autoDownload=false;autoUpdater.autoInstallOnAppQuit=false;autoUpdater.allowPrerelease=false;
    autoUpdater.on("checking-for-update",()=>publish({supported:true,status:"checking",error:null,percent:null,transferred:null,total:null}));
    autoUpdater.on("update-available",info=>publish({supported:true,status:"available",availableVersion:info?.version||null,releaseName:info?.releaseName||null,error:null}));
    autoUpdater.on("update-not-available",info=>publish({supported:true,status:"current",availableVersion:info?.version||app.getVersion(),releaseName:info?.releaseName||null,error:null,percent:null,transferred:null,total:null}));
    autoUpdater.on("download-progress",progress=>publish({supported:true,status:"downloading",percent:Number(progress?.percent)||0,transferred:Number(progress?.transferred)||0,total:Number(progress?.total)||0,error:null}));
    autoUpdater.on("update-downloaded",info=>publish({supported:true,status:"downloaded",availableVersion:info?.version||state.availableVersion,releaseName:info?.releaseName||state.releaseName,percent:100,error:null}));
    autoUpdater.on("error",error=>fail(error));
    return publish({supported:true,status:"idle",error:null});
  };
  const check=async()=>{
    configure();if(!app.isPackaged)return publish({supported:false,status:"development",error:null});
    try{await autoUpdater.checkForUpdates();return snapshot()}catch(error){throw new Error(fail(error,{lead:"check"}).error,{cause:error})}
  };
  const download=async()=>{
    configure();if(!app.isPackaged)throw new Error("Desktop updates are only available in packaged builds.");
    if(state.status!=="available")throw new Error("No downloadable update is currently available.");
    publish({status:"downloading",error:null,percent:0});
    try{await autoUpdater.downloadUpdate();return snapshot()}catch(error){throw new Error(fail(error,{lead:"download"}).error,{cause:error})}
  };
  const recoverLaunchFailure=error=>{
    publish({status:"downloaded",error:"Could not install the update: the installer did not start."});
    try{const recovery=onInstallLaunchFailure(error);if(recovery&&typeof recovery.then==="function")recovery.catch(()=>{})}catch{}
  };
  const install=async()=>{
    configure();if(!app.isPackaged)throw new Error("Desktop updates are only available in packaged builds.");
    if(state.status!=="downloaded")throw new Error("Download the update before installing it.");
    publish({status:"installing",error:null});
    try{await beforeInstall()}catch(error){publish({status:"downloaded",error:message(error)});throw error}
    // electron-updater does not throw for an installer it cannot start: its install() says why through the error event and
    // quitAndInstall returns without quitting. Either way the shell, which closed its server for the install, is brought back.
    const launch=()=>{
      let failure=null;const onError=error=>{failure??=error};autoUpdater.on("error",onError);
      try{autoUpdater.quitAndInstall(false,true)}catch(error){failure=error}finally{autoUpdater.removeListener("error",onError)}
      if(failure)recoverLaunchFailure(failure);
    };
    try{scheduleInstall(launch)}catch(error){recoverLaunchFailure(error);throw error}
    return {ok:true,state:snapshot()};
  };
  return {configure,check,download,install,getState:snapshot};
}

export { INITIAL_STATE as INITIAL_UPDATER_STATE };
