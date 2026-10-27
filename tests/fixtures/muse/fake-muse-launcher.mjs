import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Meta's Windows layout of Muse Code for tests, as its install.ps1 leaves it in %LOCALAPPDATA%\Programs\muse: Meta's own muse.cmd,
// byte for byte, which runs the .muse-launcher.ps1 beside it in Windows PowerShell, and in place of Meta's launcher a stand-in that
// behaves as Meta's does for an update. It runs the Muse Code that .muse-version names (here the stand-in CLI fake-muse.cjs, through
// node, answering --version with that version), and with MUSE_SYNC_UPDATE=1 and MUSE_NO_AUTO_UPDATE other than 1 it first updates it,
// synchronously, to the release its channel names (MUSE_CHANNEL, muse-stable when unset): here the version in release-<channel>.txt
// beside it, when that file is there. Each update it makes is logged in updates.log, with MUSE_UPDATE_INTERVAL_SECONDS. Nothing of
// Meta's is downloaded or run.
const FAKE_MUSE=fileURLToPath(new URL("./fake-muse.cjs",import.meta.url));
// install.ps1's Write-Shim.
export const META_MUSE_CMD=["@echo off","setlocal",'"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0.muse-launcher.ps1" %*',"exit /b %ERRORLEVEL%",""].join("\r\n");
const quoted=text=>"'"+String(text).replaceAll("'","''")+"'";
export const FAKE_META_LAUNCHER=[
  "# A stand-in for Meta's launcher (user agent muse-code/launcher-ps-3) that updates as it does when MUSE_SYNC_UPDATE is 1.",
  "$dir = Split-Path -Parent $PSCommandPath",
  "$channel = if ([string]::IsNullOrWhiteSpace($env:MUSE_CHANNEL)) { 'muse-stable' } else { $env:MUSE_CHANNEL }",
  "if ($env:MUSE_NO_AUTO_UPDATE -ne '1' -and $env:MUSE_SYNC_UPDATE -eq '1') {",
  "  Add-Content -LiteralPath (Join-Path $dir 'updates.log') -Value (\"$channel interval=\" + $env:MUSE_UPDATE_INTERVAL_SECONDS)",
  "  $release = Join-Path $dir \"release-$channel.txt\"",
  "  if (Test-Path -LiteralPath $release -PathType Leaf) { Copy-Item -LiteralPath $release -Destination (Join-Path $dir '.muse-version') -Force }",
  "}",
  "$version = ([IO.File]::ReadAllText((Join-Path $dir '.muse-version'))).Trim()",
  "$env:MUSE_FAKE_VERSION = 'Muse Code ' + ($version -replace '-R.*$', '') + ' (' + $version + ')'",
  `& ${quoted(process.execPath)} ${quoted(FAKE_MUSE)} @args`,
  "exit $LASTEXITCODE",
  "",
].join("\r\n");

// Lays Meta's layout out in folder: muse.cmd, the stand-in .muse-launcher.ps1, .muse-version naming version, and release-<channel>.txt
// for each channel releases names. Returns muse.cmd's path.
export async function fakeMetaMuse(folder,{version="1.4.13-R6996.1",releases={}}={}){
  await mkdir(folder,{recursive:true});
  await writeFile(join(folder,"muse.cmd"),META_MUSE_CMD);
  await writeFile(join(folder,".muse-launcher.ps1"),FAKE_META_LAUNCHER);
  await writeFile(join(folder,".muse-version"),version+"\n");
  for(const [channel,release] of Object.entries(releases))await writeFile(join(folder,`release-${channel}.txt`),release+"\n");
  return join(folder,"muse.cmd");
}
