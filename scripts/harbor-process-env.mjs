// Harbor's telemetry sender is spawned as a DETACHED_PROCESS on Windows. Its venv launcher then
// starts the interpreter with no console to inherit, so every Harbor command and finished job
// opened a visible console window. Opt out unless the caller chose a setting, keeping runs headless.
export function windowsHarborEnv(env=process.env,platform=process.platform){
  if(platform!=="win32")return {};
  return {PYTHONUTF8:"1",PYTHONIOENCODING:"utf-8",...(env.HARBOR_TELEMETRY===undefined?{HARBOR_TELEMETRY:"0"}:{})};
}
