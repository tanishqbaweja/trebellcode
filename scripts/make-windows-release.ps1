param(
  [switch]$Publish,
  [string]$Tag = "",
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# Optional local test credentials. Trebell users configure provider API keys in
# Settings; this .env is only developer/release-test scaffolding and is never
# required by the packaged application.
$RepoEnv = Join-Path $Root ".env"
if (Test-Path $RepoEnv) {
  foreach ($Line in Get-Content $RepoEnv) {
    if ($Line -match '^\s*(TREBELL_TEST_VYCE_API_KEY|VYCEAI_API_KEY|VYCE_API_KEY)\s*=\s*(.*)\s*$') {
      $Name = $Matches[1]
      $Value = $Matches[2].Trim()
      if (($Value.StartsWith('"') -and $Value.EndsWith('"')) -or ($Value.StartsWith("'") -and $Value.EndsWith("'"))) {
        $Value = $Value.Substring(1,$Value.Length-2)
      }
      if (-not [string]::IsNullOrWhiteSpace($Value)) { Set-Item -Path "Env:$Name" -Value $Value }
    }
  }
}

function Require-Command([string]$Name, [string]$Help) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required. $Help"
  }
}

function Invoke-Native([string]$File, [string[]]$Arguments) {
  if ($env:OS -eq "Windows_NT" -and ($File -eq "npm" -or $File -eq "npx")) {
    $File = "$File.cmd"
  }
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$File failed with exit code $LASTEXITCODE."
  }
}

function Get-FreeTcpPort {
  $Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0)
  $Listener.Start()
  try { return ([System.Net.IPEndPoint]$Listener.LocalEndpoint).Port }
  finally { $Listener.Stop() }
}

function Stop-GeneratedDesktopProcesses {
  $UnpackedRoot = Join-Path $Root "desktop-dist\win-unpacked"
  if (-not (Test-Path $UnpackedRoot)) { return }
  $ResolvedRoot = [System.IO.Path]::GetFullPath($UnpackedRoot).TrimEnd([char]'\') + "\"
  $Processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($ResolvedRoot,[System.StringComparison]::OrdinalIgnoreCase)
  })
  if ($Processes.Count -eq 0) { return }
  Write-Host "Stopping $($Processes.Count) stale generated Trebell process(es)..." -ForegroundColor DarkGray
  foreach ($Process in ($Processes | Sort-Object ProcessId -Descending)) {
    Stop-Process -Id $Process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500
}

function Remove-GeneratedPath([string]$Path) {
  if (-not $Path -or -not (Test-Path $Path)) { return }
  for ($Attempt = 1; $Attempt -le 12; $Attempt++) {
    try {
      Remove-Item $Path -Recurse -Force -ErrorAction Stop
      return
    } catch {
      if ($Attempt -eq 12) { throw }
      Start-Sleep -Milliseconds 500
    }
  }
}

function Reset-ReleaseOutput {
  Stop-GeneratedDesktopProcesses
  Remove-GeneratedPath (Join-Path $Root "desktop-dist")
}

function New-IsolatedPackagingOutput([string]$Prefix) {
  $LocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  $Base = if (-not [string]::IsNullOrWhiteSpace($LocalAppData)) { Join-Path $LocalAppData "Temp" } else { [IO.Path]::GetTempPath() }
  New-Item -ItemType Directory -Path $Base -Force | Out-Null
  $Output = Join-Path $Base ($Prefix + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $Output -Force | Out-Null
  return $Output
}

function Invoke-UnpackedWindowsBuild([string]$ElectronDist) {
  Reset-ReleaseOutput
  # Keep the unpacked smoke build in a unique temp directory so it is isolated
  # from workspace cleanup and concurrent builders. Using the already installed
  # Electron distribution avoids archive extraction, while the single bounded
  # retry covers the observed Windows race where a completed builder invocation
  # can transiently miss its just-materialized executable.
  for ($Attempt = 1; $Attempt -le 2; $Attempt++) {
    $Output = New-IsolatedPackagingOutput "trebell-release-unpacked-"
    $UnpackedExe = Join-Path $Output "win-unpacked\Trebell Code.exe"
    try {
      Invoke-Native "npx" @(
        "electron-builder","--dir","--win","--x64",
        "--config.electronDist=$ElectronDist",
        "--config.directories.output=$Output"
      )
      if (-not (Test-Path $UnpackedExe)) { throw "Unpacked desktop build was not produced: $UnpackedExe" }
      return [pscustomobject]@{ Output = $Output; Exe = $UnpackedExe }
    } catch {
      Remove-GeneratedPath $Output
      if ($Attempt -ge 2) { throw }
      Write-Warning "Unpacked Windows packaging attempt $Attempt failed; retrying once in a fresh isolated directory."
      Start-Sleep -Seconds 1
    }
  }
}

function Invoke-WindowsInstallerBuild([string]$ElectronDist) {
  for ($Attempt = 1; $Attempt -le 2; $Attempt++) {
    $Output = New-IsolatedPackagingOutput "trebell-release-installer-"
    try {
      Invoke-Native "npx" @(
        "electron-builder","--win","nsis","--x64",
        "--config.electronDist=$ElectronDist",
        "--config.directories.output=$Output"
      )
      return [pscustomobject]@{ Output = $Output }
    } catch {
      Remove-GeneratedPath $Output
      if ($Attempt -ge 2) { throw }
      Write-Warning "Windows installer packaging attempt $Attempt failed; retrying once in a fresh isolated directory."
      Start-Sleep -Seconds 1
    }
  }
}

Require-Command "node" "Install Node.js 22 or newer."
Require-Command "npm" "Install Node.js 22 or newer."

$NodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
if ($NodeMajor -lt 22) {
  throw "Trebell Code requires Node.js 22+. Found $(node --version)."
}

$Package = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
$Version = [string]$Package.version
if ([string]::IsNullOrWhiteSpace($Tag)) { $Tag = "v$Version" }
$ElectronDist = Join-Path $Root "node_modules\electron\dist"
$ElectronExe = Join-Path $ElectronDist "electron.exe"
if (-not (Test-Path $ElectronExe)) { throw "Installed Electron distribution is unavailable: $ElectronExe" }

Write-Host "== Trebell Code Windows release ==" -ForegroundColor Cyan
Write-Host "Version: $Version"
Write-Host "Tag:     $Tag"

Write-Host "`n[1/8] Installing dependencies..." -ForegroundColor Cyan
Invoke-Native "npm" @("install","--no-audit","--no-fund","--include=optional")

if (-not $SkipTests) {
  Write-Host "`n[2/8] Running unit/integration tests..." -ForegroundColor Cyan
  Invoke-Native "npm" @("test")
} else {
  Write-Host "`n[2/8] Tests skipped by request." -ForegroundColor Yellow
}

Write-Host "`n[3/8] Preparing canonical app icon..." -ForegroundColor Cyan
Invoke-Native "npm" @("run","prepare:icon")

Write-Host "`n[4/8] Building provider bridge and UI..." -ForegroundColor Cyan
Invoke-Native "npm" @("run","bridge:build")
Invoke-Native "npm" @("run","ui:build")

Write-Host "`n[5/8] Building unpacked Windows app for native smoke tests..." -ForegroundColor Cyan
$UnpackedBuild = Invoke-UnpackedWindowsBuild $ElectronDist
$UnpackedExe = $UnpackedBuild.Exe

Write-Host "`n[6/8] Running Windows desktop + bundled Codex smoke tests..." -ForegroundColor Cyan
$GuiPort = Get-FreeTcpPort
$AppPort = Get-FreeTcpPort
$CdpPort = Get-FreeTcpPort
$FixturePort = Get-FreeTcpPort
$OldGuiPort = $env:TREBELL_GUI_PORT
$OldAppPort = $env:TREBELL_APP_SERVER_PORT
$OldCdpUrl = $env:TREBELL_CDP_URL
$OldFixturePort = $env:TREBELL_BROWSER_FIXTURE_PORT
$OldTestHidden = $env:TREBELL_TEST_HIDDEN
$OldTrebellHome = $env:TREBELL_HOME
$SmokeHome = Join-Path ([IO.Path]::GetTempPath()) ("trebell-release-smoke-" + [Guid]::NewGuid().ToString("N"))
$DesktopProcess = $null
try {
  # Packaged validation must not inherit whichever harness/provider the
  # developer happened to select in their normal Trebell profile. Start from a
  # fresh deterministic home so the bundled Codex path is what this release
  # smoke actually validates.
  New-Item -ItemType Directory -Path $SmokeHome -Force | Out-Null
  $SeedState = @{
    version = 2
    settings = @{
      onboardingComplete = $true
      agentRuntime = "codex"
      agentRuntimeInstanceId = "codex-default"
      modelProvider = "freebuff"
    }
  } | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText((Join-Path $SmokeHome "ui-state.json"),$SeedState,[Text.UTF8Encoding]::new($false))
  $env:TREBELL_HOME = $SmokeHome
  $env:TREBELL_GUI_PORT = [string]$GuiPort
  $env:TREBELL_APP_SERVER_PORT = [string]$AppPort
  $env:TREBELL_CDP_URL = "http://127.0.0.1:$CdpPort"
  $env:TREBELL_BROWSER_FIXTURE_PORT = [string]$FixturePort
  $env:TREBELL_TEST_HIDDEN = "1"

  if (-not ($env:TREBELL_TEST_VYCE_API_KEY -or $env:VYCEAI_API_KEY -or $env:VYCE_API_KEY)) {
    Write-Host "No Vyce key is set locally; desktop smoke will test native features and bundled Codex, while Vyce compatibility remains covered by Railway." -ForegroundColor DarkGray
  }

  $DesktopProcess = Start-Process -FilePath $UnpackedExe -ArgumentList "--remote-debugging-port=$CdpPort" -PassThru

  $RuntimeReady = $false
  for ($Attempt = 0; $Attempt -lt 120; $Attempt++) {
    if ($DesktopProcess.HasExited) { throw "Unpacked Trebell Code exited before the smoke test could connect." }
    try {
      $Boot = Invoke-RestMethod -Uri "http://127.0.0.1:$GuiPort/api/bootstrap" -TimeoutSec 1
      if ($Boot.agentRuntime -eq "codex" -and $Boot.appServerReady -eq $true) {
        $RuntimeReady = $true
        break
      }
    } catch {}
    Start-Sleep -Milliseconds 250
  }
  if (-not $RuntimeReady) { throw "Bundled Codex app-server did not become ready for the Windows smoke test." }

  Invoke-Native "node" @("tests/installed-relay-check.mjs","http://127.0.0.1:$GuiPort")
  Invoke-Native "node" @("tests/installed-desktop-check.mjs")
  if ($env:TREBELL_TEST_VYCE_API_KEY -or $env:VYCEAI_API_KEY -or $env:VYCE_API_KEY) {
    # The desktop smoke connects over CDP and closes that remote browser when it
    # disconnects. Relaunch a fresh packaged app so model-driven validation gets
    # an independent runtime/browser session instead of inheriting a dead one.
    if ($DesktopProcess -and -not $DesktopProcess.HasExited) {
      if ($env:OS -eq "Windows_NT") {
        & taskkill.exe /PID $DesktopProcess.Id /T /F *> $null
      } else {
        Stop-Process -Id $DesktopProcess.Id -Force -ErrorAction SilentlyContinue
      }
    }
    Stop-GeneratedDesktopProcesses
    $DesktopProcess = Start-Process -FilePath $UnpackedExe -ArgumentList "--remote-debugging-port=$CdpPort" -PassThru
    $AgentRuntimeReady = $false
    for ($Attempt = 0; $Attempt -lt 120; $Attempt++) {
      if ($DesktopProcess.HasExited) { throw "Fresh packaged Trebell Code exited before model-driven validation could connect." }
      try {
        $Boot = Invoke-RestMethod -Uri "http://127.0.0.1:$GuiPort/api/bootstrap" -TimeoutSec 1
        if ($Boot.appServerReady -eq $true) {
          $AgentRuntimeReady = $true
          break
        }
      } catch {}
      Start-Sleep -Milliseconds 250
    }
    if (-not $AgentRuntimeReady) { throw "Fresh packaged Trebell runtime did not become ready for model-driven validation." }
    Write-Host "Running packaged model-driven harness validation..." -ForegroundColor Cyan
    Invoke-Native "node" @("tests/installed-agent-check.mjs","http://127.0.0.1:$GuiPort")
  }
} finally {
  if ($DesktopProcess -and -not $DesktopProcess.HasExited) {
    if ($env:OS -eq "Windows_NT") {
      & taskkill.exe /PID $DesktopProcess.Id /T /F *> $null
    } else {
      Stop-Process -Id $DesktopProcess.Id -Force -ErrorAction SilentlyContinue
    }
  }
  Stop-GeneratedDesktopProcesses
  $env:TREBELL_GUI_PORT = $OldGuiPort
  $env:TREBELL_APP_SERVER_PORT = $OldAppPort
  $env:TREBELL_CDP_URL = $OldCdpUrl
  $env:TREBELL_BROWSER_FIXTURE_PORT = $OldFixturePort
  $env:TREBELL_TEST_HIDDEN = $OldTestHidden
  $env:TREBELL_HOME = $OldTrebellHome
  if (Test-Path $SmokeHome) {
    Remove-Item $SmokeHome -Recurse -Force -ErrorAction SilentlyContinue
  }
  Remove-GeneratedPath $UnpackedBuild.Output
}

Write-Host "`n[7/8] Building Windows x64 NSIS installer..." -ForegroundColor Cyan
Reset-ReleaseOutput
$InstallerBuild = Invoke-WindowsInstallerBuild $ElectronDist

$InstallerName = "Trebell-Code-Setup-$Version.exe"
$BuiltInstaller = Join-Path $InstallerBuild.Output $InstallerName
if (-not (Test-Path $BuiltInstaller)) { throw "Build completed without producing $BuiltInstaller" }
$AppUpdateYml = Join-Path $InstallerBuild.Output "win-unpacked\resources\app-update.yml"
if (-not (Test-Path $AppUpdateYml)) { throw "NSIS build is missing resources\app-update.yml required by electron-updater." }
$BuiltLatestYml = Join-Path $InstallerBuild.Output "latest.yml"
if (-not (Test-Path $BuiltLatestYml)) { throw "Build completed without producing latest.yml required by the in-app updater." }
$BuiltBlockmap = "$BuiltInstaller.blockmap"

$ReleaseOutput = Join-Path $Root "desktop-dist"
New-Item -ItemType Directory -Path $ReleaseOutput -Force | Out-Null
$Installer = Join-Path $ReleaseOutput $InstallerName
$LatestYml = Join-Path $ReleaseOutput "latest.yml"
$Blockmap = "$Installer.blockmap"
Copy-Item -LiteralPath $BuiltInstaller -Destination $Installer -Force
Copy-Item -LiteralPath $BuiltLatestYml -Destination $LatestYml -Force
if (Test-Path $BuiltBlockmap) { Copy-Item -LiteralPath $BuiltBlockmap -Destination $Blockmap -Force }
Remove-GeneratedPath $InstallerBuild.Output

$Hash = (Get-FileHash -Algorithm SHA256 $Installer).Hash.ToLowerInvariant()
$Size = (Get-Item $Installer).Length
$Meta = [ordered]@{
  name = $InstallerName
  version = $Version
  bytes = $Size
  sha256 = $Hash
  commit = ""
  builtAt = (Get-Date).ToUniversalTime().ToString("o")
}
if (Get-Command git -ErrorAction SilentlyContinue) {
  try { $Meta.commit = (git rev-parse HEAD).Trim() } catch {}
}
$MetaPath = Join-Path $Root "desktop-dist\release.json"
$Meta | ConvertTo-Json | Set-Content -Encoding UTF8 $MetaPath

$ArchiveDir = Join-Path $Root ("release-artifacts\" + $Tag)
New-Item -ItemType Directory -Path $ArchiveDir -Force | Out-Null
Copy-Item -LiteralPath $Installer -Destination (Join-Path $ArchiveDir $InstallerName) -Force
Copy-Item -LiteralPath $MetaPath -Destination (Join-Path $ArchiveDir "release.json") -Force
Copy-Item -LiteralPath $LatestYml -Destination (Join-Path $ArchiveDir "latest.yml") -Force
if (Test-Path $Blockmap) { Copy-Item -LiteralPath $Blockmap -Destination (Join-Path $ArchiveDir ([IO.Path]::GetFileName($Blockmap))) -Force }

Write-Host "`nInstaller ready:" -ForegroundColor Green
Write-Host "  $Installer"
Write-Host "Archived: $ArchiveDir"
Write-Host "SHA256: $Hash"
Write-Host "Bytes:  $Size"

if ($Publish) {
  Write-Host "`n[8/8] Publishing GitHub release..." -ForegroundColor Cyan
  Require-Command "gh" "Install GitHub CLI, then run 'gh auth login'."
  & gh auth status | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "GitHub CLI is not authenticated. Run gh auth login." }
  Push-Location $Root
  try {
    $Existing = $false
    $PreviousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    & gh release view $Tag --repo tanishqbaweja/trebellcode *> $null
    $ReleaseViewExitCode = $LASTEXITCODE
    $ErrorActionPreference = $PreviousErrorActionPreference
    if ($ReleaseViewExitCode -eq 0) { $Existing = $true }
    $Notes = Join-Path $Root "RELEASE_NOTES_v$Version.md"
    if ($Existing) {
      Write-Host "Release $Tag already exists; replacing installer asset."
      $UploadArgs = @("release","upload",$Tag,$Installer,$MetaPath,$LatestYml)
      if (Test-Path $Blockmap) { $UploadArgs += $Blockmap }
      $UploadArgs += @("--repo","tanishqbaweja/trebellcode","--clobber")
      Invoke-Native "gh" $UploadArgs
    } else {
      $Assets = @($Installer,$MetaPath,$LatestYml)
      if (Test-Path $Blockmap) { $Assets += $Blockmap }
      $Args = @("release","create",$Tag) + $Assets + @("--repo","tanishqbaweja/trebellcode","--title","Trebell Code $Version","--target","main")
      if (Test-Path $Notes) { $Args += @("--notes-file",$Notes) } else { $Args += @("--generate-notes") }
      Invoke-Native "gh" $Args
    }
  } finally { Pop-Location }
  Write-Host "Published $Tag." -ForegroundColor Green
} else {
  Write-Host "`n[8/8] Publish skipped." -ForegroundColor DarkGray
  Write-Host "To build and publish in one command:"
  Write-Host "  .\make-exe.cmd publish"
}
