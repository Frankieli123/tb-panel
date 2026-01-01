param(
  [Parameter(Mandatory = $true)]
  [string]$Domain,

  [ValidateSet('https', 'http')]
  [string]$Scheme = 'https',

  [ValidateSet('win-x64')]
  [string]$Target = 'win-x64',

  [string]$OutDir = 'release',

  [switch]$SkipNodeRuntime,

  [string]$NodeVersion = ''
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

function Invoke-InDir([string]$dir, [string]$command) {
  Push-Location $dir
  try {
    Write-Host ">> $command"
    Invoke-Expression $command
  } finally {
    Pop-Location
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

function Get-WsUrl([string]$scheme, [string]$domain) {
  $proto = if ($scheme -eq 'https') { 'wss' } else { 'ws' }
  return "${proto}://${domain}/ws/agent"
}

function Get-NodeVersion([string]$explicit) {
  $v = ([string]$explicit).Trim()
  if ($v) { return ($v -replace '^v', '') }
  $detected = (node -v).Trim()
  return ($detected -replace '^v', '')
}

function Invoke-CurlDownload([string]$url, [string]$outFile) {
  Assert-Tool curl.exe
  & curl.exe -L --fail --retry 3 --retry-delay 2 -o $outFile $url
  if ($LASTEXITCODE -ne 0) {
    throw "Download failed (curl exit=$LASTEXITCODE): $url"
  }
}

function Ensure-NodeRuntimeCache([string]$repoRoot, [string]$nodeVer) {
  $cacheRoot = Join-Path $repoRoot 'tools\node-runtime'
  $cacheDir = Join-Path $cacheRoot "node-v$nodeVer-win-x64"
  $exe = Join-Path $cacheDir 'node.exe'

  if (Test-Path $exe) {
    return $cacheDir
  }

  New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null

  $tmp = Join-Path $cacheRoot ("_tmp_" + [guid]::NewGuid().ToString('n'))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp "node-v$nodeVer-win-x64.zip"
    $url = "https://nodejs.org/dist/v$nodeVer/node-v$nodeVer-win-x64.zip"
    Write-Host ">> Downloading Node runtime: $url"

    Invoke-CurlDownload $url $zip
    Expand-Archive -Path $zip -DestinationPath $tmp -Force

    $extracted = Join-Path $tmp "node-v$nodeVer-win-x64"
    if (-not (Test-Path $extracted)) {
      throw "Node runtime extraction failed: $extracted"
    }

    if (Test-Path $cacheDir) {
      Remove-Item -Recurse -Force $cacheDir
    }
    Move-Item -Force -Path $extracted -Destination $cacheDir

    if (-not (Test-Path $exe)) {
      throw "Node runtime cache invalid: $exe not found"
    }

    return $cacheDir
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

Assert-Tool node
Assert-Tool npm
Assert-Tool dotnet

$repoRoot = Get-RepoRoot
$domain = Normalize-Domain $Domain
$wsUrl = Get-WsUrl $Scheme $domain

$serverDir = Join-Path $repoRoot 'server'
if (-not (Test-Path $serverDir)) {
  throw "Missing server directory: $serverDir"
}

Invoke-InDir $serverDir 'npm run build'

$resolvedOutDir = Resolve-Path (Join-Path $repoRoot $OutDir) -ErrorAction SilentlyContinue
if (-not $resolvedOutDir) {
  $resolvedOutDir = Join-Path $repoRoot $OutDir
  New-Item -ItemType Directory -Force -Path $resolvedOutDir | Out-Null
  $resolvedOutDir = (Resolve-Path $resolvedOutDir).Path
} else {
  $resolvedOutDir = $resolvedOutDir.Path
}

$safeDomain = $domain -replace '[^a-zA-Z0-9._-]', '_'
$pkgBaseName = "taobao-agent_${safeDomain}_${Target}"
$stageRoot = Join-Path $resolvedOutDir $pkgBaseName
$zipPath = Join-Path $resolvedOutDir "${pkgBaseName}.zip"

if (Test-Path $stageRoot) {
  Remove-Item -Recurse -Force $stageRoot
}
New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null

$appDir = Join-Path $stageRoot 'app'
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

Copy-Item -Recurse -Force (Join-Path $serverDir 'dist') (Join-Path $appDir 'dist')
Copy-Item -Recurse -Force (Join-Path $serverDir 'node_modules') (Join-Path $appDir 'node_modules')
Copy-Item -Force (Join-Path $serverDir 'package.json') (Join-Path $appDir 'package.json')
Copy-Item -Force (Join-Path $serverDir 'package-lock.json') (Join-Path $appDir 'package-lock.json')

# Reduce install size / file count: remove dev-only dependencies from bundled node_modules.
$devOnlyDirs = @(
  (Join-Path $appDir 'node_modules\\@types'),
  (Join-Path $appDir 'node_modules\\prisma'),
  (Join-Path $appDir 'node_modules\\tsx'),
  (Join-Path $appDir 'node_modules\\typescript')
)
foreach ($d in $devOnlyDirs) {
  if (Test-Path $d) {
    Remove-Item -Recurse -Force $d
  }
}

if (Test-Path (Join-Path $appDir 'node_modules\\.bin')) {
  Remove-Item -Recurse -Force (Join-Path $appDir 'node_modules\\.bin')
}

$envFile = Join-Path $stageRoot '.env'
@(
  "AGENT_WS_URL=$wsUrl"
) | Set-Content -Encoding UTF8 -Path $envFile

$pairPromptEncoded = 'QQBkAGQALQBUAHkAcABlACAALQBBAHMAcwBlAG0AYgBsAHkATgBhAG0AZQAgAE0AaQBjAHIAbwBzAG8AZgB0AC4AVgBpAHMAdQBhAGwAQgBhAHMAaQBjAAoAJABjAG8AZABlACAAPQAgAFsATQBpAGMAcgBvAHMAbwBmAHQALgBWAGkAcwB1AGEAbABCAGEAcwBpAGMALgBJAG4AdABlAHIAYQBjAHQAaQBvAG4AXQA6ADoASQBuAHAAdQB0AEIAbwB4ACgAJwD3i5OPZVFNkflbAXgI/1AAQQBJAFIAXwBDAE8ARABFAAn/AjDvUyhXUX91mO96IABBAGcAZQBuAHQAIABil39nH3UQYgIwJwAsACcAVABhAG8AYgBhAG8AIABBAGcAZQBuAHQAIABNkflbJwAsACcAJwApAAoAVwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIAAkAGMAbwBkAGUA'

$runCmd = Join-Path $stageRoot 'start-agent.cmd'
@"
@echo off
setlocal
cd /d "%~dp0"
set "AGENT_WS_URL=$wsUrl"
set "AGENT_NAME=%COMPUTERNAME%"
set "CHROME_AUTO_INSTALL=1"
set "TAOBAO_AGENT_HOME=%ProgramData%\TaobaoAgent"
set "AGENT_UI=1"
set "AGENT_STATUS_PORT=17880"
set "AGENT_PAIR_ONLY="
if not exist "%TAOBAO_AGENT_HOME%" (
  mkdir "%TAOBAO_AGENT_HOME%" >nul 2>nul
)
set "NODE_EXE=%~dp0node\node.exe"
set "AGENT_JS=%~dp0app\dist\agent.js"
if exist "%NODE_EXE%" (
  set "RUN_NODE=%NODE_EXE%"
) else (
  set "RUN_NODE=node"
)

rem If agent status UI is already responding, avoid starting a duplicate process.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "`$ports=17880..17890; foreach(`$p in `$ports){ try { `$r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 -Uri ('http://127.0.0.1:'+`$p+'/api/status'); if(`$r.StatusCode -eq 200){ exit 0 } } catch {} }; exit 1" ^
  >nul 2>nul
if not errorlevel 1 (
  exit /b 0
)

rem Start in background (best effort). If PowerShell is blocked, fall back to foreground.
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ^
  "try { `$ErrorActionPreference='Stop'; `$q=[char]34; `$args=`$q+`$env:AGENT_JS+`$q+' --no-ui-open'; Start-Process -FilePath `$env:RUN_NODE -ArgumentList `$args -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -ErrorAction Stop; exit 0 } catch { exit 1 }" ^
  >nul 2>nul
if errorlevel 1 (
  "%RUN_NODE%" "%AGENT_JS%" --no-ui-open
)
"@ | Set-Content -Encoding ASCII -Path $runCmd

$openStatusCmd = Join-Path $stageRoot 'open-status.cmd'
@'
@echo off
setlocal
cd /d "%~dp0"
call "%~dp0start-agent.cmd" >nul 2>nul

rem Find the real status port (17880..17890) and open it.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ports=17880..17890; $found=$null; foreach($p in $ports){ try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 -Uri ('http://127.0.0.1:'+$p+'/api/status'); if($r.StatusCode -eq 200){ $found=$p; break } } catch {} }; if(-not $found){ $found=17880 }; Start-Process ('http://127.0.0.1:'+$found+'/')" ^
  >nul 2>nul
if errorlevel 1 (
  start "" "http://127.0.0.1:17880/"
)

rem Start tray (single-instance inside tray app).
if exist "%~dp0TaobaoAgentTray.exe" (
  start "" "%~dp0TaobaoAgentTray.exe" >nul 2>nul
)
'@ | Set-Content -Encoding ASCII -Path $openStatusCmd

$pairCmd = Join-Path $stageRoot 'pair-agent.cmd'
@"
@echo off
setlocal
cd /d "%~dp0"
set "AGENT_WS_URL=$wsUrl"
set "AGENT_NAME=%COMPUTERNAME%"
set "CHROME_AUTO_INSTALL=1"
set "TAOBAO_AGENT_HOME=%ProgramData%\TaobaoAgent"
set "AGENT_UI=1"
set "AGENT_STATUS_PORT=17880"
if not exist "%TAOBAO_AGENT_HOME%" (
  mkdir "%TAOBAO_AGENT_HOME%" >nul 2>nul
)

rem Prefer a GUI input box for non-technical users.
if "%~1"=="" (
  for /f "delims=" %%i in ('powershell -NoProfile -STA -ExecutionPolicy Bypass -EncodedCommand $pairPromptEncoded') do set "AGENT_PAIR_CODE=%%i"
) else (
  set "AGENT_PAIR_CODE=%~1"
)
if "%AGENT_PAIR_CODE%"=="" (
  rem User cancelled input: open status page for later pairing.
  call "%~dp0open-status.cmd"
  exit /b 0
)

set "NODE_EXE=%~dp0node\node.exe"
set "AGENT_JS=%~dp0app\dist\agent.js"
if exist "%NODE_EXE%" (
  set "RUN_NODE=%NODE_EXE%"
) else (
  set "RUN_NODE=node"
)

set "AGENT_PAIR_ONLY=1"
"%RUN_NODE%" "%AGENT_JS%"
if errorlevel 1 (
  echo Pair failed. Please verify your PAIR_CODE and network connectivity.
  pause
  exit /b 1
)
set "AGENT_PAIR_ONLY="

rem Pair ok: start agent in background
call "%~dp0open-status.cmd"
"@ | Set-Content -Encoding ASCII -Path $pairCmd

$readmePath = Join-Path $stageRoot 'README.txt'
@"
Taobao Agent (portable)

Server:
  $($Scheme)://$($domain)

WebSocket:
  $wsUrl

Usage:
  1) First time pairing (run on the agent machine):
     pair-agent.cmd <PAIR_CODE>

  2) Next time:
     start-agent.cmd

Notes:
  - If Chrome/Chromium is not installed, Agent will auto-download Chrome for Testing on first run (needs Internet).
  - Agent token + agentId are stored in %ProgramData%\TaobaoAgent\agent.json
"@ | Set-Content -Encoding UTF8 -Path $readmePath

$trayProj = Join-Path $repoRoot 'tray\TaobaoAgentTray\TaobaoAgentTray.csproj'
if (-not (Test-Path $trayProj)) {
  throw "Missing tray project: $trayProj"
}

Write-Host '>> Building tray (self-contained single-file)'
& dotnet publish $trayProj -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:EnableCompressionInSingleFile=true `
  -p:DebugType=None `
  -p:DebugSymbols=false
if ($LASTEXITCODE -ne 0) {
  throw "dotnet publish failed (exit=$LASTEXITCODE)"
}

$trayExe = Join-Path (Split-Path $trayProj -Parent) 'bin\Release\net8.0-windows\win-x64\publish\TaobaoAgentTray.exe'
if (-not (Test-Path $trayExe)) {
  throw "Tray publish output not found: $trayExe"
}
Copy-Item -Force $trayExe (Join-Path $stageRoot 'TaobaoAgentTray.exe')

if (-not $SkipNodeRuntime) {
  if ($Target -ne 'win-x64') {
    throw "Unsupported target for Node runtime: $Target"
  }

  $nodeVer = Get-NodeVersion $NodeVersion
  $cached = Ensure-NodeRuntimeCache $repoRoot $nodeVer

  $nodeDir = Join-Path $stageRoot 'node'
  if (Test-Path $nodeDir) {
    Remove-Item -Recurse -Force $nodeDir
  }
  New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null

  # Only ship node.exe to reduce MSI file count and speed up installation.
  $nodeExe = Join-Path $cached 'node.exe'
  if (-not (Test-Path $nodeExe)) {
    throw "Node runtime cache invalid: $nodeExe not found"
  }
  Copy-Item -Force $nodeExe (Join-Path $nodeDir 'node.exe')
}

if (Test-Path $zipPath) {
  Remove-Item -Force $zipPath
}
Compress-Archive -Path (Join-Path $stageRoot '*') -DestinationPath $zipPath

Write-Host "OK"
Write-Host "  Stage: $stageRoot"
Write-Host "  Zip:   $zipPath"
