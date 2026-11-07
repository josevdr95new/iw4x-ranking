@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem ============================================================
rem  IW4x Ranking - detiene lo iniciado por start-all.bat
rem  Estrategia:
rem   1) kill por COMMAND-LINE del "cmd /k ..." exacto de start-all
rem      (seguro con Windows Terminal: NO usar WINDOWTITLE, porque
rem      WT agrupa varias consolas en una ventana y taskkill por
rem      titulo se carga tabs hermanas - verificado en pruebas)
rem   2) fallback por PID del puerto (solo MOD 1624 y Server 28961,
rem      por si iw4x.exe/dotnet quedaron desacoplados de su ventana)
rem  Nunca mata procesos que no calce con esos patrones.
rem  Uso:  stop-all.bat              detiene API+Web+Server+MOD
rem        stop-all.bat mod server   solo esos servicios
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ============================================================
echo    IW4x Ranking - deteniendo servicios...
echo ============================================================

set "STOP_API=0"
set "STOP_WEB=0"
set "STOP_MOD=0"
set "STOP_SRV=0"
if "%~1"=="" (
  set "STOP_API=1"
  set "STOP_WEB=1"
  set "STOP_MOD=1"
  set "STOP_SRV=1"
  goto kills
)
for %%a in (%*) do (
  if /i "%%a"=="api"    set "STOP_API=1"
  if /i "%%a"=="web"    set "STOP_WEB=1"
  if /i "%%a"=="mod"    set "STOP_MOD=1"
  if /i "%%a"=="server" set "STOP_SRV=1"
)

:kills
echo.
if "%STOP_API%"=="1"  call :killcmd "cmd +/k .*npm run dev:api" "API"
if "%STOP_WEB%"=="1"  call :killcmd "cmd +/k .*npm run dev -w apps/web" "Web"
if "%STOP_SRV%"=="1" (
  call :killcmd "cmd +/k .*DedicatedServer" "Server"
  call :kill_port 28961 "Server"
)
if "%STOP_MOD%"=="1" (
  call :killcmd "cmd +/k .*IW4MAdmin\.dll" "Moderacion"
  call :kill_port 1624 "Moderacion"
)

echo.
echo ---- Estado final de puertos ----
call :report 3000  "API"
call :report 5173  "Web"
call :report 1624  "Moderacion"
call :report 28961 "Server-juego"
echo.
echo Si algo sigue vivo y no deberia: mira el PID de netstat de arriba y usa
echo   taskkill /PID ^<pid^> /T /F
echo.
exit /b 0

rem ================== subrutinas ==================

:killcmd   [%1=regex sobre CommandLine de cmd.exe %2=etiqueta]
rem  Mata el cmd /k de start-all y todo su arbol (npm/node/vite/dotnet).
rem  Bajo Windows Terminal el titulo de ventana no es del cmd: matchear
rem  por cmdline es lo unico seguro y preciso. OJO: "cmd +/k" porque la
rem  CommandLine real trae doble espacio entre cmd y /k.
powershell -NoProfile -Command "$m = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -match '%~1' }; if ($m) { $m | ForEach-Object { Write-Host ('[%~2] kill por cmdline: PID ' + $_.ProcessId); taskkill /PID $_.ProcessId /T /F 2>$null } } else { Write-Host '[%~2] sin cmd /k que calce (no estaba corriendo).' }"
exit /b 0

:kill_port   [%1=puerto %2=etiqueta]
call :port_busy %~1
if "%PORT_LIVE%"=="0" (
  echo [%~2] puerto %~1 libre ^(nada que matar por PID^).
  exit /b 0
)
echo [%~2] el puerto %~1 sigue en uso: cerrando por PID ^(solo quien lo escucha^)...
for /f "tokens=4,5" %%p in ('netstat -ano ^| findstr ":%~1 " 2^>nul') do (
  if not "%%p"=="0" taskkill /PID %%p /T /F >nul 2>&1
  if not "%%q"=="" if not "%%q"=="0" taskkill /PID %%q /T /F >nul 2>&1
)
exit /b 0

:report   [%1=puerto %2=etiqueta]
call :port_busy %~1
if "%PORT_LIVE%"=="1" (
  echo [%~2] puerto %~1 SIGUE EN USO:
  netstat -ano | findstr ":%~1 "
) else (
  echo [%~2] puerto %~1 libre ✓
)
exit /b 0

:port_busy   [%1=puerto] -> PORT_LIVE (0/1)
set "PORT_LIVE=0"
netstat -ano 2>nul | findstr ":%~1 " >nul
if not errorlevel 1 set "PORT_LIVE=1"
exit /b 0
