@echo off
setlocal
cd /d "%~dp0"
set "AGENT_WS_URL=wss://tb.slee.cc/ws/agent"
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
  "$ports=17880..17890; foreach($p in $ports){ try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 -Uri ('http://127.0.0.1:'+$p+'/api/status'); if($r.StatusCode -eq 200){ exit 0 } } catch {} }; exit 1" ^
  >nul 2>nul
if not errorlevel 1 (
  exit /b 0
)

rem Start in background (best effort). If PowerShell is blocked, fall back to foreground.
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ^
  "try { $ErrorActionPreference='Stop'; $q=[char]34; $args=$q+$env:AGENT_JS+$q+' --no-ui-open'; Start-Process -FilePath $env:RUN_NODE -ArgumentList $args -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -ErrorAction Stop; exit 0 } catch { exit 1 }" ^
  >nul 2>nul
if errorlevel 1 (
  "%RUN_NODE%" "%AGENT_JS%" --no-ui-open
)
