param(
  [switch]$Publish,
  [string]$Tag = "",
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# Load local Vyce validation credentials from the repository-level .env without
# printing them. The release build inherits these variables so the packaged EXE
# can be validated through the real provider + Codex harness path.
$RepoEnv = Join-Path (Split-Path -Parent $Root) ".env"
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

Require-Command "node" "Install Node.js 22 or newer."
Require-Command "npm" "Install Node.js 22 or newer."

$NodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
if ($NodeMajor -lt 22) {
  throw "Trebell Code requires Node.js 22+. Found $(node --version)."
}

$Package = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
$Version = [string]$Package.version
if ([string]::IsNullOrWhiteSpace($Tag)) { $Tag = "v$Version" }

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
Invoke-Native "npx" @("electron-builder","--dir","--win","--x64")

$UnpackedExe = Join-Path $Root "desktop-dist\win-unpacked\Trebell Code.exe"
if (-not (Test-Path $UnpackedExe)) { throw "Unpacked desktop build was not produced: $UnpackedExe" }

Write-Host "`n[6/8] Running Windows desktop + bundled Codex smoke tests..." -ForegroundColor Cyan
$GuiPort = Get-FreeTcpPort
$AppPort = Get-FreeTcpPort
$CdpPort = Get-FreeTcpPort
$FixturePort = Get-FreeTcpPort
$OldGuiPort = $env:TREBELL_GUI_PORT
$OldAppPort = $env:TREBELL_APP_SERVER_PORT
$OldCdpUrl = $env:TREBELL_CDP_URL
$OldFixturePort = $env:TREBELL_BROWSER_FIXTURE_PORT
$DesktopProcess = $null
try {
  $env:TREBELL_GUI_PORT = [string]$GuiPort
  $env:TREBELL_APP_SERVER_PORT = [string]$AppPort
  $env:TREBELL_CDP_URL = "http://127.0.0.1:$CdpPort"
  $env:TREBELL_BROWSER_FIXTURE_PORT = [string]$FixturePort

  if (-not ($env:TREBELL_TEST_VYCE_API_KEY -or $env:VYCEAI_API_KEY -or $env:VYCE_API_KEY)) {
    Write-Host "No Vyce key is set locally; desktop smoke will test native features and bundled Codex, while Vyce compatibility remains covered by Railway." -ForegroundColor DarkGray
  }

  $DesktopProcess = Start-Process -FilePath $UnpackedExe -ArgumentList "--remote-debugging-port=$CdpPort" -PassThru

  $RuntimeReady = $false
  for ($Attempt = 0; $Attempt -lt 120; $Attempt++) {
    if ($DesktopProcess.HasExited) { throw "Unpacked Trebell Code exited before the smoke test could connect." }
    try {
      $Boot = Invoke-RestMethod -Uri "http://127.0.0.1:$GuiPort/api/bootstrap" -TimeoutSec 1
      if ($Boot.appServerReady -eq $true) {
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
    Write-Host "Running packaged model-driven harness validation..." -ForegroundColor Cyan
    Invoke-Native "node" @("tests/installed-agent-check.mjs","http://127.0.0.1:$GuiPort")
  }
} finally {
  if ($DesktopProcess -and -not $DesktopProcess.HasExited) {
    Stop-Process -Id $DesktopProcess.Id -Force -ErrorAction SilentlyContinue
  }
  $env:TREBELL_GUI_PORT = $OldGuiPort
  $env:TREBELL_APP_SERVER_PORT = $OldAppPort
  $env:TREBELL_CDP_URL = $OldCdpUrl
  $env:TREBELL_BROWSER_FIXTURE_PORT = $OldFixturePort
}

Write-Host "`n[7/8] Building Windows x64 NSIS installer..." -ForegroundColor Cyan
Invoke-Native "npx" @("electron-builder","--win","nsis","--x64")

$InstallerName = "Trebell-Code-Setup-$Version.exe"
$Installer = Join-Path $Root "desktop-dist\$InstallerName"
if (-not (Test-Path $Installer)) { throw "Build completed without producing $Installer" }
$AppUpdateYml = Join-Path $Root "desktop-dist\win-unpacked\resources\app-update.yml"
if (-not (Test-Path $AppUpdateYml)) { throw "NSIS build is missing resources\app-update.yml required by electron-updater." }
$LatestYml = Join-Path $Root "desktop-dist\latest.yml"
if (-not (Test-Path $LatestYml)) { throw "Build completed without producing latest.yml required by the in-app updater." }
$Blockmap = "$Installer.blockmap"

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

Write-Host "`nInstaller ready:" -ForegroundColor Green
Write-Host "  $Installer"
Write-Host "SHA256: $Hash"
Write-Host "Bytes:  $Size"

if ($Publish) {
  Write-Host "`n[8/8] Publishing GitHub release..." -ForegroundColor Cyan
  Require-Command "gh" "Install GitHub CLI, then run 'gh auth login'."
  & gh auth status | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "GitHub CLI is not authenticated. Run gh auth login." }
  $RepoRoot = Resolve-Path (Join-Path $Root "..")
  Push-Location $RepoRoot
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
