param(
  [switch]$Publish,
  [string]$Tag = "",
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Require-Command([string]$Name, [string]$Help) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required. $Help"
  }
}

function Invoke-Native([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$File failed with exit code $LASTEXITCODE."
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

Write-Host "== Trebell Code Windows release ==" -ForegroundColor Cyan
Write-Host "Version: $Version"
Write-Host "Tag:     $Tag"

Write-Host "`n[1/6] Installing dependencies..." -ForegroundColor Cyan
Invoke-Native "npm" @("install","--no-audit","--no-fund","--include=optional")

if (-not $SkipTests) {
  Write-Host "`n[2/6] Running unit/integration tests..." -ForegroundColor Cyan
  Invoke-Native "npm" @("test")
} else {
  Write-Host "`n[2/6] Tests skipped by request." -ForegroundColor Yellow
}

Write-Host "`n[3/6] Preparing canonical app icon..." -ForegroundColor Cyan
Invoke-Native "npm" @("run","prepare:icon")

Write-Host "`n[4/6] Building provider bridge and UI..." -ForegroundColor Cyan
Invoke-Native "npm" @("run","bridge:build")
Invoke-Native "npm" @("run","ui:build")

Write-Host "`n[5/6] Building Windows x64 NSIS installer..." -ForegroundColor Cyan
Invoke-Native "npx" @("electron-builder","--win","nsis","--x64")

$InstallerName = "Trebell-Code-Setup-$Version.exe"
$Installer = Join-Path $Root "desktop-dist\$InstallerName"
if (-not (Test-Path $Installer)) { throw "Build completed without producing $Installer" }

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
  Write-Host "`n[6/6] Publishing GitHub release..." -ForegroundColor Cyan
  Require-Command "gh" "Install GitHub CLI, then run 'gh auth login'."
  & gh auth status | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "GitHub CLI is not authenticated. Run gh auth login." }
  $RepoRoot = Resolve-Path (Join-Path $Root "..")
  Push-Location $RepoRoot
  try {
    $Existing = $false
    gh release view $Tag --repo tanishqbaweja/trebellcode *> $null
    if ($LASTEXITCODE -eq 0) { $Existing = $true }
    $Notes = Join-Path $Root "RELEASE_NOTES_v$Version.md"
    if ($Existing) {
      Write-Host "Release $Tag already exists; replacing installer asset."
      Invoke-Native "gh" @("release","upload",$Tag,$Installer,$MetaPath,"--repo","tanishqbaweja/trebellcode","--clobber")
    } else {
      $Args = @("release","create",$Tag,$Installer,$MetaPath,"--repo","tanishqbaweja/trebellcode","--title","Trebell Code $Version","--target","main")
      if (Test-Path $Notes) { $Args += @("--notes-file",$Notes) } else { $Args += @("--generate-notes") }
      Invoke-Native "gh" $Args
    }
  } finally { Pop-Location }
  Write-Host "Published $Tag." -ForegroundColor Green
} else {
  Write-Host "`n[6/6] Publish skipped." -ForegroundColor DarkGray
  Write-Host "To build and publish in one command:"
  Write-Host "  .\make-exe.cmd publish"
}
