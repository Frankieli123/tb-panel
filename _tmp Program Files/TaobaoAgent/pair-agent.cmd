@echo off
setlocal
cd /d "%~dp0"
set "AGENT_WS_URL=wss://tb.slee.cc/ws/agent"
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
  for /f "delims=" %%i in ('powershell -NoProfile -STA -ExecutionPolicy Bypass -EncodedCommand QQBkAGQALQBUAHkAcABlACAALQBBAHMAcwBlAG0AYgBsAHkATgBhAG0AZQAgAE0AaQBjAHIAbwBzAG8AZgB0AC4AVgBpAHMAdQBhAGwAQgBhAHMAaQBjAAoAJABjAG8AZABlACAAPQAgAFsATQBpAGMAcgBvAHMAbwBmAHQALgBWAGkAcwB1AGEAbABCAGEAcwBpAGMALgBJAG4AdABlAHIAYQBjAHQAaQBvAG4AXQA6ADoASQBuAHAAdQB0AEIAbwB4ACgAJwD3i5OPZVFNkflbAXgI/1AAQQBJAFIAXwBDAE8ARABFAAn/AjDvUyhXUX91mO96IABBAGcAZQBuAHQAIABil39nH3UQYgIwJwAsACcAVABhAG8AYgBhAG8AIABBAGcAZQBuAHQAIABNkflbJwAsACcAJwApAAoAVwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIAAkAGMAbwBkAGUA') do set "AGENT_PAIR_CODE=%%i"
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
