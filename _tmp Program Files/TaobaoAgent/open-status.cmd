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
