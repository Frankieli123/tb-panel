param(
  [Parameter(Mandatory = $true)]
  [string]$Domain,

  [ValidateSet('https', 'http')]
  [string]$Scheme = 'https',

  [ValidateSet('win-x64')]
  [string]$Target = 'win-x64',

  [string]$OutDir = 'release',

  [string]$ProductVersion = '',

  [string]$ProductName = 'Taobao Agent',

  [string]$Manufacturer = 'slee.cc'
)

$ErrorActionPreference = 'Stop'

function Get-RepoRoot {
  if (-not $PSScriptRoot) {
    throw 'Cannot determine script directory ($PSScriptRoot is empty)'
  }
  return (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

function Assert-Tool($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Missing required tool: $name"
  }
}

function Normalize-Domain([string]$value) {
  $v = ([string]$value).Trim()
  if (-not $v) { throw 'Domain is required' }
  $v = $v -replace '^https?://', ''
  $v = $v.TrimEnd('/')
  if (-not $v) { throw 'Domain is invalid' }
  return $v
}

function Get-ProductVersion([string]$explicit, [string]$repoRoot) {
  $v = ([string]$explicit).Trim()
  if ($v) {
    if ($v -match '^\d+\.\d+\.\d+\.\d+$') { return $v }
    if ($v -match '^\d+\.\d+\.\d+$') { return "$v.0" }
    throw "Invalid ProductVersion: $v (expected x.y.z or x.y.z.w)"
  }

  $pkgPath = Join-Path $repoRoot 'server/package.json'
  if (Test-Path $pkgPath) {
    $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
    $pv = ([string]$pkg.version).Trim()
    if ($pv -match '^\d+\.\d+\.\d+$') { return "$pv.0" }
  }

  return '1.0.0.0'
}

function Ensure-Wix311([string]$repoRoot) {
  $toolsDir = Join-Path $repoRoot 'tools'
  $wixDir = Join-Path $toolsDir 'wix311'
  $candle = Join-Path $wixDir 'candle.exe'
  $light = Join-Path $wixDir 'light.exe'
  $heat = Join-Path $wixDir 'heat.exe'

  if ((Test-Path $candle) -and (Test-Path $light) -and (Test-Path $heat)) {
    return @{ WixDir = $wixDir; Candle = $candle; Light = $light; Heat = $heat }
  }

  New-Item -ItemType Directory -Force -Path $wixDir | Out-Null

  $zipUrl = 'https://github.com/wixtoolset/wix3/releases/download/wix3112rtm/wix311-binaries.zip'
  $zipPath = Join-Path $wixDir 'wix311-binaries.zip'

  Write-Host ">> Downloading WiX Toolset: $zipUrl"
  Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath

  Expand-Archive -Path $zipPath -DestinationPath $wixDir -Force
  Remove-Item -Force $zipPath

  if (-not (Test-Path $candle)) { throw "WiX download/extract failed: $candle" }
  if (-not (Test-Path $light)) { throw "WiX download/extract failed: $light" }
  if (-not (Test-Path $heat)) { throw "WiX download/extract failed: $heat" }

  return @{ WixDir = $wixDir; Candle = $candle; Light = $light; Heat = $heat }
}

function Invoke-Native([string]$file, [string[]]$arguments) {
  & $file @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed (exit=$LASTEXITCODE): $file $($arguments -join ' ')"
  }
}

Assert-Tool powershell

$repoRoot = Get-RepoRoot
$domain = Normalize-Domain $Domain
$version = Get-ProductVersion $ProductVersion $repoRoot

$packageScript = Join-Path $repoRoot 'scripts/package-agent.ps1'
if (-not (Test-Path $packageScript)) {
  throw "Missing package script: $packageScript"
}

Write-Host ">> Building agent stage (domain=$domain target=$Target)"
& powershell -NoProfile -ExecutionPolicy Bypass -File $packageScript -Domain $domain -Scheme $Scheme -Target $Target -OutDir $OutDir
if ($LASTEXITCODE -ne 0) {
  throw "package-agent.ps1 failed (exit=$LASTEXITCODE)"
}

$safeDomain = $domain -replace '[^a-zA-Z0-9._-]', '_'
$stageRoot = Join-Path $repoRoot (Join-Path $OutDir "taobao-agent_${safeDomain}_${Target}")
if (-not (Test-Path $stageRoot)) {
  throw "Stage directory not found: $stageRoot"
}

$resolvedOutDir = Resolve-Path (Join-Path $repoRoot $OutDir)
$msiPath = Join-Path $resolvedOutDir ("taobao-agent_${safeDomain}_${Target}.msi")

$wxsMain = Join-Path $repoRoot 'installer/agent/TaobaoAgent.wxs'
if (-not (Test-Path $wxsMain)) {
  throw "Missing WiX source: $wxsMain"
}

$wxlZhCn = Join-Path $repoRoot 'installer/agent/zh-cn.wxl'
if (-not (Test-Path $wxlZhCn)) {
  throw "Missing WiX localization: $wxlZhCn"
}

$wix = Ensure-Wix311 $repoRoot

$buildRoot = Join-Path $repoRoot (Join-Path $OutDir '_msi_build')
$objDir = Join-Path $buildRoot 'obj'
New-Item -ItemType Directory -Force -Path $objDir | Out-Null

$harvestWxs = Join-Path $buildRoot 'AppFiles.wxs'

Push-Location $wix.WixDir
try {
  Write-Host ">> Harvesting files: $stageRoot"
  Invoke-Native $wix.Heat @('dir', $stageRoot, '-nologo', '-cg', 'AppFiles', '-dr', 'INSTALLFOLDER', '-srd', '-sreg', '-gg', '-var', 'var.SourceDir', '-out', $harvestWxs)

  $harvestRaw = Get-Content $harvestWxs -Raw
  if ($harvestRaw -notmatch 'Win64=') {
    $harvestRaw = $harvestRaw -replace '<Component Id="', '<Component Win64="yes" Id="'
    Set-Content -Encoding UTF8 -Path $harvestWxs -Value $harvestRaw
  }

  Write-Host '>> Compiling MSI (candle)'
  Invoke-Native $wix.Candle @(
    '-nologo',
    '-arch', 'x64',
    '-ext', 'WixUtilExtension',
    '-out', (Join-Path $objDir ''),
    "-dSourceDir=$stageRoot",
    "-dProductVersion=$version",
    "-dProductName=$ProductName",
    "-dManufacturer=$Manufacturer",
    $wxsMain,
    $harvestWxs
  )

  Write-Host '>> Linking MSI (light)'
  Invoke-Native $wix.Light @(
    '-nologo',
    '-cultures:zh-cn',
    '-ext', 'WixUIExtension',
    '-ext', 'WixUtilExtension',
    '-loc', $wxlZhCn,
    '-out', $msiPath,
    (Join-Path $objDir 'TaobaoAgent.wixobj'),
    (Join-Path $objDir 'AppFiles.wixobj')
  )
} finally {
  Pop-Location
}

if (-not (Test-Path $msiPath)) {
  throw "MSI build failed: $msiPath not found"
}

Write-Host 'OK'
Write-Host "  MSI: $msiPath"
