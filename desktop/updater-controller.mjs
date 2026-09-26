const INITIAL_STATE=Object.freeze({supported:false,status:"idle",currentVersion:null,availableVersion:null,percent:null,transferred:null,total:null,error:null,releaseName:null});

function message(error){return error instanceof Error?error.message:String(error||"Unknown updater error")}

export function createUpdaterController({app,autoUpdater,onState=()=>{},beforeInstall=async()=>{},scheduleInstall=fn=>setImmediate(fn),onInstallLaunchFailure=()=>{}}={}){
  if(!app)throw new Error("Updater controller requires app");
  if(!autoUpdater)throw new Error("Updater controller requires autoUpdater");
  let configured=false,state={...INITIAL_STATE};
  const snapshot=()=>({...state});
  const publish=(patch={})=>{state={...state,...patch,currentVersion:app.getVersion?.()||state.currentVersion};const next=snapshot();try{onState(next)}catch{}return next};
  const fail=(error,{status="error"}={})=>publish({supported:Boolean(app.isPackaged),status,error:message(error)});
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
    try{await autoUpdater.checkForUpdates();return snapshot()}catch(error){fail(error);throw error}
  };
  const download=async()=>{
    configure();if(!app.isPackaged)throw new Error("Desktop updates are only available in packaged builds.");
    if(state.status!=="available")throw new Error("No downloadable update is currently available.");
    publish({status:"downloading",error:null,percent:0});
    try{await autoUpdater.downloadUpdate();return snapshot()}catch(error){fail(error);throw error}
  };
  const recoverLaunchFailure=error=>{
    publish({status:"downloaded",error:message(error)});
    try{const recovery=onInstallLaunchFailure(error);if(recovery&&typeof recovery.then==="function")recovery.catch(()=>{})}catch{}
  };
  const install=async()=>{
    configure();if(!app.isPackaged)throw new Error("Desktop updates are only available in packaged builds.");
    if(state.status!=="downloaded")throw new Error("Download the update before installing it.");
    publish({status:"installing",error:null});
    try{await beforeInstall()}catch(error){publish({status:"downloaded",error:message(error)});throw error}
    const launch=()=>{try{autoUpdater.quitAndInstall(false,true)}catch(error){recoverLaunchFailure(error)}};
    try{scheduleInstall(launch)}catch(error){recoverLaunchFailure(error);throw error}
    return {ok:true,state:snapshot()};
  };
  return {configure,check,download,install,getState:snapshot};
}

export { INITIAL_STATE as INITIAL_UPDATER_STATE };
